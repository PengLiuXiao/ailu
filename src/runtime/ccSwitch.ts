import { createHash } from 'crypto';
import fs from 'fs';
import { request as httpRequest } from 'http';
import os from 'os';
import path from 'path';

import {
  CLAUDE_MODEL_ROUTE_ENV_KEYS,
  resolveClaudeCcSwitchSessionConfig,
  resolveClaudeRoutedModelLabel,
  type ClaudeModelRouteEnvironment,
} from './localModels';

export const CC_SWITCH_BASE_URL = 'http://127.0.0.1:15721' as const;
export const CC_SWITCH_DEFAULT_TIMEOUT_MS = 1_500;
export const CC_SWITCH_MAX_RESPONSE_BYTES = 64 * 1024;

const CC_SWITCH_ENDPOINTS = new Set(['/health', '/status']);

export type CcSwitchState = 'idle' | 'ready' | 'error';

export interface CcSwitchSnapshot {
  state: CcSwitchState;
  currentProvider: string | null;
  currentProviderId: string | null;
  currentCliModel: string | null;
  currentModel: string | null;
  routeEnvironment: ClaudeModelRouteEnvironment;
  /** Absolute global Claude config directory selected by CC Switch. */
  claudeConfigDir: string | null;
  routeFingerprint: string | null;
  selectionSource: 'liveConfig' | null;
  proxyStatusStale: boolean;
  error: string | null;
  checkedAt: number | null;
  baseUrl: string;
}

export interface CcSwitchCurrentSelection {
  currentProviderId: string | null;
  currentCliModel: string | null;
  currentModel: string | null;
  routeEnvironment: ClaudeModelRouteEnvironment;
  /** Absolute global Claude config directory selected by CC Switch. */
  claudeConfigDir: string | null;
  /** Whether CC Switch's device-level settings file was present and usable. */
  sourceAvailable: boolean;
  /** Non-secret global config/model-route fingerprint used for switch-stability checks. */
  routeFingerprint: string;
}

export type CcSwitchSelectionReader = () => CcSwitchCurrentSelection;

export interface CcSwitchTransportRequest {
  url: string;
  method: 'GET';
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface CcSwitchTransportResponse {
  status: number;
  body: string | Uint8Array;
}

export type CcSwitchTransport = (
  request: CcSwitchTransportRequest,
) => Promise<CcSwitchTransportResponse>;

export interface CcSwitchClientOptions {
  transport?: CcSwitchTransport;
  selectionReader?: CcSwitchSelectionReader;
  selectionStabilityDelayMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => number;
}

type JsonObject = Record<string, unknown>;

const CC_SWITCH_SETTINGS_MAX_BYTES = 64 * 1024;
const CC_SWITCH_CLAUDE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_MODEL_ROUTE_ENV_KEYS,
] as const;
class CcSwitchProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CcSwitchProbeError';
  }
}

function safeEndpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CcSwitchProbeError('CC Switch request URL is invalid.');
  }
  if (
    parsed.origin !== CC_SWITCH_BASE_URL
    || !CC_SWITCH_ENDPOINTS.has(parsed.pathname)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new CcSwitchProbeError('CC Switch requests are restricted to the fixed loopback endpoint.');
  }
  return parsed;
}

function transportError(message: string): Error {
  const error = new Error(message);
  error.name = 'CcSwitchTransportError';
  return error;
}

/**
 * Minimal read-only transport for CC Switch. It accepts only the two fixed
 * loopback status endpoints and stops reading as soon as the byte cap is hit.
 */
export const defaultCcSwitchTransport: CcSwitchTransport = request => new Promise((resolve, reject) => {
  let endpoint: URL;
  try {
    if (request.method !== 'GET') {
      throw new CcSwitchProbeError('CC Switch status transport only supports GET.');
    }
    endpoint = safeEndpoint(request.url);
  } catch (error) {
    reject(error instanceof Error ? error : new Error('CC Switch request validation failed.'));
    return;
  }

  if (request.signal.aborted) {
    reject(transportError('CC Switch request was aborted.'));
    return;
  }

  let settled = false;
  const finish = (
    result: { response: CcSwitchTransportResponse } | { error: Error },
  ): void => {
    if (settled) return;
    settled = true;
    request.signal.removeEventListener('abort', abortRequest);
    if ('error' in result) reject(result.error);
    else resolve(result.response);
  };

  const nodeRequest = httpRequest(endpoint, {
    method: 'GET',
    agent: false,
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      Connection: 'close',
    },
  }, response => {
    const declaredLength = Number(response.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > request.maxResponseBytes) {
      response.destroy();
      finish({ error: new CcSwitchProbeError('CC Switch response exceeded the maximum size.') });
      return;
    }

    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    response.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      receivedBytes += bytes.byteLength;
      if (receivedBytes > request.maxResponseBytes) {
        response.destroy();
        finish({ error: new CcSwitchProbeError('CC Switch response exceeded the maximum size.') });
        return;
      }
      chunks.push(bytes);
    });
    response.once('end', () => {
      finish({
        response: {
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks, receivedBytes),
        },
      });
    });
    response.once('aborted', () => {
      finish({ error: transportError('CC Switch closed the response early.') });
    });
    response.once('error', error => finish({ error }));
  });

  function abortRequest(): void {
    nodeRequest.destroy(transportError('CC Switch request was aborted.'));
  }

  request.signal.addEventListener('abort', abortRequest, { once: true });
  nodeRequest.setTimeout(request.timeoutMs, () => {
    nodeRequest.destroy(transportError('CC Switch request timed out.'));
  });
  nodeRequest.once('error', error => finish({ error }));
  nodeRequest.end();
});

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readBoundedJsonObject(filePath: string, label: string): JsonObject | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > CC_SWITCH_SETTINGS_MAX_BYTES) {
      throw new CcSwitchProbeError(`${label} could not be read.`);
    }
    const parsed = jsonObject(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
    if (!parsed) throw new CcSwitchProbeError(`${label} is invalid.`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    if (error instanceof CcSwitchProbeError) throw error;
    throw new CcSwitchProbeError(`${label} could not be read.`);
  }
}

function decodeBody(body: string | Uint8Array, maxResponseBytes: number): string {
  if (typeof body === 'string') {
    if (new TextEncoder().encode(body).byteLength > maxResponseBytes) {
      throw new CcSwitchProbeError('CC Switch response exceeded the maximum size.');
    }
    return body;
  }
  if (!(body instanceof Uint8Array)) {
    throw new CcSwitchProbeError('CC Switch returned an unsupported response body.');
  }
  if (body.byteLength > maxResponseBytes) {
    throw new CcSwitchProbeError('CC Switch response exceeded the maximum size.');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new CcSwitchProbeError('CC Switch returned invalid UTF-8.');
  }
}

function parseObject(text: string, path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new CcSwitchProbeError(`CC Switch ${path} returned malformed JSON.`);
  }
  const object = jsonObject(parsed);
  if (!object) {
    throw new CcSwitchProbeError(`CC Switch ${path} returned an invalid schema.`);
  }
  return object;
}

function isExplicitLoopback(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function safeStatusLabel(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  const hasControlCharacter = [...normalized].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (normalized.length > 256 || hasControlCharacter) {
    throw new CcSwitchProbeError(`CC Switch reported an invalid ${label}.`);
  }
  return normalized;
}

function resolveClaudeConfigDirectory(value: unknown): string {
  const configuredDir = typeof value === 'string' ? value.trim() : '';
  const hasUnsafePath = [...configuredDir].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (configuredDir.length > 4_096 || hasUnsafePath) {
    throw new CcSwitchProbeError('CC Switch reported an invalid Claude configuration directory.');
  }
  const expandedDir = configuredDir === '~'
    ? os.homedir()
    : configuredDir.startsWith('~/')
      ? path.join(os.homedir(), configuredDir.slice(2))
      : configuredDir || path.join(os.homedir(), '.claude');
  if (!path.isAbsolute(expandedDir)) {
    throw new CcSwitchProbeError('CC Switch reported an invalid Claude configuration directory.');
  }
  return path.normalize(expandedDir);
}

function configDirectoryFingerprint(configDir: string): string {
  return createHash('sha256').update(configDir).digest('hex');
}

/**
 * Read only CC Switch's non-secret current Claude selection plus Claude's
 * already-live model route labels. The proxy `/status` endpoint reports the
 * provider used by the last request, so it can remain stale after a UI switch.
 */
export function readCcSwitchCurrentSelection(
  settingsPath = path.join(os.homedir(), '.cc-switch', 'settings.json'),
  routeEnvironment?: Record<string, string | undefined>,
): CcSwitchCurrentSelection {
  const settings = readBoundedJsonObject(settingsPath, 'CC Switch current configuration');
  const currentProviderId = safeStatusLabel(settings?.currentProviderClaude, 'provider id') || null;
  let effectiveRoute = routeEnvironment ?? {};
  let topLevelModel = '';
  const claudeConfigDir = settings
    ? resolveClaudeConfigDirectory(settings.claudeConfigDir)
    : null;
  if (settings && claudeConfigDir) {
    const claudeSettings = readBoundedJsonObject(
      path.join(claudeConfigDir, 'settings.json'),
      'CC Switch Claude model routing',
    );
    if (!claudeSettings) {
      throw new CcSwitchProbeError('CC Switch Claude model routing could not be read.');
    }
    topLevelModel = safeStatusLabel(claudeSettings.model, 'Claude model');
    if (!routeEnvironment) {
      const settingsEnv = jsonObject(claudeSettings.env);
      effectiveRoute = Object.fromEntries(CC_SWITCH_CLAUDE_ENV_KEYS.map(key => [
        key,
        safeStatusLabel(settingsEnv?.[key], 'model route'),
      ]));
    }
  }
  const normalizedRoute = Object.fromEntries(CC_SWITCH_CLAUDE_ENV_KEYS.map(key => [
    key,
    safeStatusLabel(effectiveRoute[key], key === 'ANTHROPIC_BASE_URL' ? 'base URL' : 'model name'),
  ]));
  const configuredBaseUrl = normalizedRoute.ANTHROPIC_BASE_URL;
  if (settings && configuredBaseUrl && configuredBaseUrl !== CC_SWITCH_BASE_URL) {
    throw new CcSwitchProbeError('CC Switch Claude routing is not using the local proxy.');
  }
  const safeRouteEnvironment = Object.fromEntries(
    CLAUDE_MODEL_ROUTE_ENV_KEYS.flatMap(key => {
      const value = normalizedRoute[key];
      return value ? [[key, value]] : [];
    }),
  ) as ClaudeModelRouteEnvironment;
  const currentCliModel = normalizedRoute.ANTHROPIC_MODEL || topLevelModel || null;
  const currentModel = resolveClaudeRoutedModelLabel(
    currentCliModel ?? '',
    safeRouteEnvironment,
  );
  const routeFingerprint = JSON.stringify({
    version: 2,
    configDirectory: claudeConfigDir ? configDirectoryFingerprint(claudeConfigDir) : '',
    currentCliModel: currentCliModel ?? '',
    ...Object.fromEntries(CLAUDE_MODEL_ROUTE_ENV_KEYS.map(key => [
      key,
      safeRouteEnvironment[key] ?? '',
    ])),
  });
  return {
    currentProviderId,
    currentCliModel,
    currentModel,
    routeEnvironment: safeRouteEnvironment,
    claudeConfigDir,
    sourceAvailable: Boolean(settings),
    routeFingerprint,
  };
}

export function ccSwitchSnapshotLabel(snapshot: CcSwitchSnapshot): string {
  const providerMarker = snapshot.currentProvider?.trim()
    || snapshot.currentProviderId?.trim().slice(0, 8)
    || '';
  const currentModel = snapshot.currentModel?.trim() ?? '';
  if (!currentModel) {
    const configuredModel = snapshot.currentCliModel?.trim() ?? '';
    const modelLabel = configuredModel
      ? `${configuredModel}（按 CC Switch 配置）`
      : '模型未配置';
    return providerMarker ? `${providerMarker} · ${modelLabel}` : modelLabel;
  }
  return providerMarker && currentModel !== providerMarker && !currentModel.includes(providerMarker)
    ? `${currentModel} · ${providerMarker}`
    : currentModel;
}

export function ccSwitchRouteSummary(snapshot: CcSwitchSnapshot): string {
  const models = [
    snapshot.routeEnvironment.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME,
    snapshot.routeEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME,
    snapshot.routeEnvironment.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME,
  ].map(value => value?.trim() ?? '').filter(Boolean);
  return [...new Set(models)].join(' / ');
}

export function ccSwitchGlobalSnapshot(snapshot: CcSwitchSnapshot): CcSwitchSnapshot {
  if (snapshot.state !== 'ready') return snapshot;
  const session = resolveClaudeCcSwitchSessionConfig(
    snapshot.routeEnvironment,
    snapshot.currentCliModel,
    snapshot.routeFingerprint,
  );
  return {
    ...snapshot,
    currentCliModel: session.cliModel || null,
    currentModel: session.routedModel,
  };
}

function checkedNumber(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return normalized;
}

export class CcSwitchClient {
  private readonly transport: CcSwitchTransport;
  private readonly selectionReader: CcSwitchSelectionReader;
  private readonly selectionStabilityDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly now: () => number;
  private refreshGeneration = 0;
  private cached: CcSwitchSnapshot = {
    state: 'idle',
    currentProvider: null,
    currentProviderId: null,
    currentCliModel: null,
    currentModel: null,
    routeEnvironment: {},
    claudeConfigDir: null,
    routeFingerprint: null,
    selectionSource: null,
    proxyStatusStale: false,
    error: null,
    checkedAt: null,
    baseUrl: CC_SWITCH_BASE_URL,
  };

  constructor(options: CcSwitchClientOptions = {}) {
    this.transport = options.transport ?? defaultCcSwitchTransport;
    this.selectionReader = options.selectionReader ?? readCcSwitchCurrentSelection;
    this.selectionStabilityDelayMs = options.selectionStabilityDelayMs ?? 50;
    if (!Number.isSafeInteger(this.selectionStabilityDelayMs) || this.selectionStabilityDelayMs < 0) {
      throw new RangeError('selectionStabilityDelayMs must be a non-negative safe integer.');
    }
    this.timeoutMs = checkedNumber(options.timeoutMs, CC_SWITCH_DEFAULT_TIMEOUT_MS, 'timeoutMs');
    this.maxResponseBytes = checkedNumber(
      options.maxResponseBytes,
      CC_SWITCH_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
    );
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): CcSwitchSnapshot {
    return {
      ...this.cached,
      routeEnvironment: { ...this.cached.routeEnvironment },
    };
  }

  getCached(): CcSwitchSnapshot {
    return this.getSnapshot();
  }

  async refresh(): Promise<CcSwitchSnapshot> {
    const generation = ++this.refreshGeneration;
    let nextSnapshot: CcSwitchSnapshot;
    try {
      const health = await this.requestJson('/health');
      if (health.status !== 'healthy') {
        throw new CcSwitchProbeError('CC Switch health response is not healthy.');
      }
      if (
        health.timestamp !== undefined
        && (typeof health.timestamp !== 'string' || !health.timestamp.trim())
      ) {
        throw new CcSwitchProbeError('CC Switch /health returned an invalid schema.');
      }

      const status = await this.requestJson('/status');
      if (
        typeof status.running !== 'boolean'
        || typeof status.address !== 'string'
        || typeof status.port !== 'number'
        || !Number.isSafeInteger(status.port)
      ) {
        throw new CcSwitchProbeError('CC Switch /status returned an invalid schema.');
      }
      if (!isExplicitLoopback(status.address)) {
        throw new CcSwitchProbeError('CC Switch reported a non-loopback address.');
      }
      if (!status.running) {
        throw new CcSwitchProbeError('CC Switch proxy is not running.');
      }
      if (status.port !== 15721) {
        throw new CcSwitchProbeError('CC Switch reported an unexpected proxy port.');
      }
      const proxyProvider = safeStatusLabel(status.current_provider, 'provider name');
      const proxyProviderId = safeStatusLabel(status.current_provider_id, 'provider id');
      const liveSelection = await this.readStableSelection();
      if (!liveSelection?.sourceAvailable) {
        throw new CcSwitchProbeError('CC Switch current configuration could not be read.');
      }
      const liveProviderId = safeStatusLabel(liveSelection?.currentProviderId, 'provider id');
      const currentCliModel = safeStatusLabel(liveSelection?.currentCliModel, 'Claude model');
      const currentModel = safeStatusLabel(liveSelection?.currentModel, 'model name');
      const claudeConfigDir = liveSelection?.claudeConfigDir
        ? resolveClaudeConfigDirectory(liveSelection.claudeConfigDir)
        : null;
      if (!liveProviderId) {
        throw new CcSwitchProbeError('CC Switch has no current Claude provider selected.');
      }
      if (!currentCliModel) {
        throw new CcSwitchProbeError('CC Switch global Claude model is not configured.');
      }
      if (!claudeConfigDir) {
        throw new CcSwitchProbeError('CC Switch global Claude configuration directory is unavailable.');
      }
      const proxyStatusStale = Boolean(
        liveProviderId
        && proxyProviderId
        && liveProviderId !== proxyProviderId,
      );
      const currentProvider = liveProviderId === proxyProviderId
        ? proxyProvider || null
        : null;

      nextSnapshot = {
        state: 'ready',
        currentProvider,
        currentProviderId: liveProviderId,
        currentCliModel: currentCliModel || null,
        currentModel: currentModel || null,
        routeEnvironment: { ...liveSelection.routeEnvironment },
        claudeConfigDir,
        routeFingerprint: liveSelection.routeFingerprint,
        selectionSource: 'liveConfig',
        proxyStatusStale,
        error: null,
        checkedAt: this.now(),
        baseUrl: CC_SWITCH_BASE_URL,
      };
    } catch (error) {
      nextSnapshot = {
        state: 'error',
        currentProvider: null,
        currentProviderId: null,
        currentCliModel: null,
        currentModel: null,
        routeEnvironment: {},
        claudeConfigDir: null,
        routeFingerprint: null,
        selectionSource: null,
        proxyStatusStale: false,
        error: error instanceof CcSwitchProbeError
          ? error.message
          : 'CC Switch is offline or unavailable.',
        checkedAt: this.now(),
        baseUrl: CC_SWITCH_BASE_URL,
      };
    }
    if (generation === this.refreshGeneration) this.cached = nextSnapshot;
    return {
      ...nextSnapshot,
      routeEnvironment: { ...nextSnapshot.routeEnvironment },
    };
  }

  private async readStableSelection(): Promise<CcSwitchCurrentSelection | null> {
    let previous: CcSwitchCurrentSelection | null = null;
    let previousKey = '';
    let lastReadFailed = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current: CcSwitchCurrentSelection | null = null;
      try {
        current = this.selectionReader();
        lastReadFailed = false;
      } catch {
        lastReadFailed = true;
      }
      const currentKey = current
        ? JSON.stringify({
          currentProviderId: current.currentProviderId ?? '',
          currentCliModel: current.currentCliModel ?? '',
          currentModel: current.currentModel ?? '',
          claudeConfigDir: current.claudeConfigDir ?? '',
          routeFingerprint: current.routeFingerprint,
          sourceAvailable: current.sourceAvailable,
        })
        : '';
      if (current && previous && currentKey === previousKey) return current;
      previous = current;
      previousKey = currentKey;
      if (attempt < 2 && this.selectionStabilityDelayMs > 0) {
        await new Promise<void>(resolve => {
          globalThis.setTimeout(resolve, this.selectionStabilityDelayMs);
        });
      }
    }
    if (lastReadFailed || !previous) {
      throw new CcSwitchProbeError('CC Switch current configuration could not be read.');
    }
    throw new CcSwitchProbeError('CC Switch is still synchronizing its current configuration.');
  }

  private async requestJson(path: '/health' | '/status'): Promise<JsonObject> {
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = globalThis.setTimeout(() => {
        timedOut = true;
        reject(new CcSwitchProbeError(`CC Switch ${path} request timed out.`));
        controller.abort();
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.transport({
          url: `${CC_SWITCH_BASE_URL}${path}`,
          method: 'GET',
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
        }),
        timeoutPromise,
      ]);
      if (response.status !== 200) {
        throw new CcSwitchProbeError(`CC Switch ${path} returned HTTP ${response.status}.`);
      }
      return parseObject(decodeBody(response.body, this.maxResponseBytes), path);
    } catch (error) {
      if (timedOut) {
        throw new CcSwitchProbeError(`CC Switch ${path} request timed out.`);
      }
      throw error;
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    }
  }
}
