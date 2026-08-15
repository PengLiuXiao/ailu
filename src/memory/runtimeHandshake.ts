import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';

export const AILU_MEMORY_RUNTIME_API_VERSION = 2;
export const AILU_MEMORY_WRITER_PROTOCOL_VERSION = 2;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1_024;
const DEFAULT_CACHE_TTL_MS = 5_000;

export interface AiluMemoryRuntimeHandshakeResult {
  schemaVersion: 2;
  runtimeApiVersion: 2;
  writerProtocolVersion: 2;
  canonicalActors: string[];
  executableRealpath: string;
  manifestRealpath: string;
  manifestMtimeNs: string;
  transitionMarkerFingerprint: string;
  runtimeIntegritySha256: string;
  manifestSha256: string;
}

export interface AiluMemoryRuntimeHandshakeTransportRequest {
  executablePath: string;
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface AiluMemoryRuntimeHandshakeTransportResponse {
  exitCode: number;
  stdout: string;
}

export interface AiluMemoryRuntimeIdentity {
  executableRealpath: string;
  manifestRealpath: string;
  manifestMtimeNs: string;
  transitionMarkerFingerprint: string;
}

export interface AiluMemoryRuntimeGateLike {
  assertReady(): Promise<AiluMemoryRuntimeHandshakeResult>;
}

export interface AiluMemoryRuntimeGateOptions {
  executablePath: string;
  manifestPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cacheTtlMs?: number;
  now?: () => number;
  transport?: (
    request: AiluMemoryRuntimeHandshakeTransportRequest,
  ) => Promise<AiluMemoryRuntimeHandshakeTransportResponse>;
  resolveIdentity?: () => Promise<AiluMemoryRuntimeIdentity>;
}

export class AiluMemoryRuntimeHandshakeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AiluMemoryRuntimeHandshakeError';
  }
}

const successfulHandshakes = new Map<string, {
  promise: Promise<AiluMemoryRuntimeHandshakeResult>;
  expiresAt: number;
}>();
const defaultGates = new Map<string, AiluMemoryRuntimeGate>();

export class AiluMemoryRuntimeGate implements AiluMemoryRuntimeGateLike {
  private readonly executablePath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly transport: NonNullable<AiluMemoryRuntimeGateOptions['transport']>;
  private readonly resolveIdentity: NonNullable<AiluMemoryRuntimeGateOptions['resolveIdentity']>;

  constructor(options: AiluMemoryRuntimeGateOptions) {
    this.executablePath = options.executablePath;
    this.timeoutMs = boundedPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.maxOutputBytes = boundedPositiveInteger(
      options.maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.cacheTtlMs = boundedPositiveInteger(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? runAiluMemoryRuntimeHandshakeProcess;
    this.resolveIdentity = options.resolveIdentity ?? (() => resolveRuntimeIdentity(
      this.executablePath,
      options.manifestPath,
    ));
  }

  async assertReady(): Promise<AiluMemoryRuntimeHandshakeResult> {
    const identity = await this.resolveIdentity().catch(error => {
      throw normalizeHandshakeError(
        error,
        'RUNTIME_IDENTITY_UNAVAILABLE',
        'Agent Memory runtime 或 runtime-manifest.json 不可读。',
      );
    });
    const key = runtimeIdentityKey(identity);
    const cached = successfulHandshakes.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.promise;
    if (cached) successfulHandshakes.delete(key);
    const pending = this.performHandshake(identity);
    const entry = { promise: pending, expiresAt: Number.POSITIVE_INFINITY };
    successfulHandshakes.set(key, entry);
    try {
      const result = await pending;
      if (successfulHandshakes.get(key) === entry) {
        entry.expiresAt = this.now() + this.cacheTtlMs;
      }
      return result;
    } catch (error) {
      if (successfulHandshakes.get(key) === entry) successfulHandshakes.delete(key);
      throw error;
    }
  }

  private async performHandshake(
    identity: AiluMemoryRuntimeIdentity,
  ): Promise<AiluMemoryRuntimeHandshakeResult> {
    let response: AiluMemoryRuntimeHandshakeTransportResponse;
    try {
      response = await this.transport({
        executablePath: identity.executableRealpath,
        args: ['--actor', 'ailu', 'version', '--json'],
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
    } catch (error) {
      throw normalizeHandshakeError(
        error,
        'RUNTIME_HANDSHAKE_UNAVAILABLE',
        'Agent Memory runtime v2 握手失败。',
      );
    }
    if (response.exitCode !== 0) {
      throw new AiluMemoryRuntimeHandshakeError(
        'RUNTIME_HANDSHAKE_EXITED',
        'Agent Memory runtime v2 握手未正常完成。',
      );
    }
    const parsed = parseHandshakeResponse(response.stdout);
    const after = await this.resolveIdentity().catch(error => {
      throw normalizeHandshakeError(
        error,
        'RUNTIME_IDENTITY_CHANGED',
        'Agent Memory runtime 在握手期间发生了变化。',
      );
    });
    if (runtimeIdentityKey(after) !== runtimeIdentityKey(identity)) {
      throw new AiluMemoryRuntimeHandshakeError(
        'RUNTIME_IDENTITY_CHANGED',
        'Agent Memory runtime 在握手期间发生了变化，已拒绝使用本次结果。',
      );
    }
    return {
      ...parsed,
      ...after,
    };
  }
}

export function ailuMemoryRuntimeGateFor(executablePath: string): AiluMemoryRuntimeGate {
  const key = path.resolve(executablePath);
  const existing = defaultGates.get(key);
  if (existing) return existing;
  const gate = new AiluMemoryRuntimeGate({ executablePath });
  defaultGates.set(key, gate);
  return gate;
}

export function invalidateAiluMemoryRuntimeHandshakeCache(): void {
  successfulHandshakes.clear();
  defaultGates.clear();
}

async function resolveRuntimeIdentity(
  executablePath: string,
  configuredManifestPath?: string,
): Promise<AiluMemoryRuntimeIdentity> {
  await access(executablePath, fsConstants.X_OK);
  const executableRealpath = await realpath(executablePath);
  const manifestCandidate = configuredManifestPath
    ?? path.resolve(path.dirname(executableRealpath), '..', 'config', 'runtime-manifest.json');
  const manifestRealpath = await realpath(manifestCandidate);
  const manifestStat = await stat(manifestRealpath, { bigint: true });
  if (!manifestStat.isFile()) {
    throw new Error('runtime manifest is not a regular file');
  }
  const transitionMarkerPath = path.join(path.dirname(manifestRealpath), 'runtime-transition.json');
  let transitionMarkerFingerprint = 'missing';
  try {
    const transitionMarkerRealpath = await realpath(transitionMarkerPath);
    const markerBytes = await readFile(transitionMarkerRealpath);
    transitionMarkerFingerprint = createHash('sha256')
      .update(transitionMarkerRealpath)
      .update('\0')
      .update(markerBytes)
      .digest('hex');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return {
    executableRealpath,
    manifestRealpath,
    manifestMtimeNs: manifestStat.mtimeNs.toString(),
    transitionMarkerFingerprint,
  };
}

function parseHandshakeResponse(output: string): Pick<
  AiluMemoryRuntimeHandshakeResult,
  | 'schemaVersion'
  | 'runtimeApiVersion'
  | 'writerProtocolVersion'
  | 'canonicalActors'
  | 'runtimeIntegritySha256'
  | 'manifestSha256'
> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new AiluMemoryRuntimeHandshakeError(
      'RUNTIME_HANDSHAKE_INVALID',
      'Agent Memory runtime 握手返回了无效 JSON。',
    );
  }
  if (!isRecord(value)
    || value.schema_version !== AILU_MEMORY_RUNTIME_API_VERSION
    || value.runtime_api_version !== AILU_MEMORY_RUNTIME_API_VERSION
    || value.writer_protocol_version !== AILU_MEMORY_WRITER_PROTOCOL_VERSION
    || value.ok !== true
    || value.ready !== true
    || !Array.isArray(value.canonical_actors)
    || !value.canonical_actors.every(actor => typeof actor === 'string')
    || !value.canonical_actors.includes('ailu')
    || !isSha256(value.runtime_integrity_sha256)
    || !isSha256(value.manifest_sha256)
    || !isReadyRuntimeTransition(
      value.runtime_transition,
      value.runtime_integrity_sha256,
      value.manifest_sha256,
    )) {
    throw new AiluMemoryRuntimeHandshakeError(
      'RUNTIME_HANDSHAKE_INCOMPATIBLE',
      'Agent Memory runtime 不兼容：需要 runtime API v2、writer protocol v2 和 ailu actor。',
    );
  }
  return {
    schemaVersion: 2,
    runtimeApiVersion: 2,
    writerProtocolVersion: 2,
    canonicalActors: [...value.canonical_actors],
    runtimeIntegritySha256: value.runtime_integrity_sha256,
    manifestSha256: value.manifest_sha256,
  };
}

function runAiluMemoryRuntimeHandshakeProcess(
  request: AiluMemoryRuntimeHandshakeTransportRequest,
): Promise<AiluMemoryRuntimeHandshakeTransportResponse> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(request.executablePath, request.args, {
      detached,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    let childClosed = false;
    let terminationError: Error | null = null;
    let timeoutTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    let groupPollTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    const finish = (
      response?: AiluMemoryRuntimeHandshakeTransportResponse,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) nodeClearTimeout(timeoutTimer);
      if (forceKillTimer) nodeClearTimeout(forceKillTimer);
      if (groupPollTimer) nodeClearTimeout(groupPollTimer);
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error('Agent Memory runtime handshake ended unexpectedly.'));
    };
    const processGroupAlive = (): boolean => {
      if (!detached || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signalProcess = (signal: NodeJS.Signals): void => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child if the group already exited.
        }
      }
      child.kill(signal);
    };
    const finishAfterGroupExit = (): void => {
      if (!terminationError || !childClosed || settled) return;
      if (!processGroupAlive()) {
        finish(undefined, terminationError);
        return;
      }
      groupPollTimer = nodeSetTimeout(finishAfterGroupExit, 25);
    };
    const terminate = (error: Error): void => {
      if (terminationError || settled) return;
      terminationError = error;
      if (timeoutTimer) nodeClearTimeout(timeoutTimer);
      signalProcess('SIGTERM');
      forceKillTimer = nodeSetTimeout(() => {
        signalProcess('SIGKILL');
        finishAfterGroupExit();
      }, 1_000);
      if (childClosed) finishAfterGroupExit();
    };
    timeoutTimer = nodeSetTimeout(() => terminate(new Error(
      'Agent Memory runtime handshake timed out.',
    )), request.timeoutMs);
    timeoutTimer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (terminationError) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, 'utf8') > request.maxOutputBytes) {
        stdout = '';
        terminate(new Error('Agent Memory runtime handshake response is too large.'));
      }
    });
    child.stderr?.resume();
    child.on('error', () => finish(undefined, new Error(
      'Agent Memory runtime handshake could not start.',
    )));
    child.on('close', code => {
      if (settled) return;
      childClosed = true;
      if (terminationError) {
        finishAfterGroupExit();
        return;
      }
      if (processGroupAlive()) {
        terminate(new Error('Agent Memory runtime handshake left a background process.'));
        return;
      }
      finish({ exitCode: code ?? 2, stdout });
    });
  });
}

function runtimeIdentityKey(identity: AiluMemoryRuntimeIdentity): string {
  return [
    identity.executableRealpath,
    identity.manifestRealpath,
    identity.manifestMtimeNs,
    identity.transitionMarkerFingerprint,
  ].join('\u0000');
}

function isReadyRuntimeTransition(
  value: unknown,
  runtimeIntegritySha256: string,
  manifestSha256: string,
): boolean {
  if (!isRecord(value) || value.ready !== true || !isRecord(value.state)) return false;
  const state = value.state;
  return state.ok === true
    && String(state.state_schema_version) === '3'
    && String(state.writer_protocol_version) === '2'
    && Array.isArray(state.missing_tables)
    && state.missing_tables.length === 0
    && (state.missing_incident_columns === undefined
      || (Array.isArray(state.missing_incident_columns)
        && state.missing_incident_columns.length === 0))
    && state.quick_check === 'ok'
    && value.runtime_integrity_sha256 === runtimeIntegritySha256
    && isRecord(value.runtime_integrity)
    && value.runtime_integrity.ok === true
    && value.runtime_integrity.bundle_sha256 !== ''
    && isSha256(value.runtime_integrity.bundle_sha256)
    && value.runtime_integrity.manifest_sha256 === manifestSha256
    // The transition-level digest covers the complete ready boundary
    // (runtime, config, hooks and state).  The nested digest covers the
    // installed runtime files only, so it must be well formed but is not
    // expected to equal the transition-level digest.
    && isSha256(value.runtime_integrity.runtime_integrity_sha256)
    && Number.isSafeInteger(value.runtime_integrity.file_count)
    && Number(value.runtime_integrity.file_count) > 0
    && value.runtime_integrity.mismatched_count === 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeHandshakeError(
  error: unknown,
  code: string,
  fallbackMessage: string,
): AiluMemoryRuntimeHandshakeError {
  if (error instanceof AiluMemoryRuntimeHandshakeError) return error;
  return new AiluMemoryRuntimeHandshakeError(
    code,
    error instanceof Error && error.message ? `${fallbackMessage} ${error.message}` : fallbackMessage,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
