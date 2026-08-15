import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentId } from '../types';

export interface LocalModelOption {
  /** Value passed to the CLI (`claude --model <id>`). Empty string = CLI default. */
  id: string;
  label: string;
  note?: string;
}

export interface ClaudeResolvedLocalModel extends LocalModelOption {
  /** Exact alias/id passed to `claude --model` when explicitly selected. */
  cliModel: string;
  /** Upstream model label exposed by a local gateway such as CC Switch. */
  routedModel?: string;
  /** Non-secret routing fingerprint used to avoid resuming with a stale model route. */
  routeFingerprint: string;
}

export interface ClaudeCcSwitchSessionConfig {
  /** Exact top-level model selected by CC Switch's global Claude config. */
  cliModel: string;
  /** Upstream family route derived from that exact CLI model, when knowable. */
  routedModel: string | null;
  /** Non-secret fingerprint of the complete global snapshot and effective model map. */
  routeFingerprint: string;
}

/** Model aliases the Claude Code CLI resolves on its own. */
const CLAUDE_MODEL_ALIASES: LocalModelOption[] = [
  { id: '', label: 'CLI default', note: 'uses local Claude settings' },
  { id: 'sonnet', label: 'Sonnet', note: 'alias' },
  { id: 'opus', label: 'Opus', note: 'alias' },
  { id: 'haiku', label: 'Haiku', note: 'alias' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M', note: 'alias' },
];

const CLAUDE_ROUTE_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_REASONING_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const;

export const CLAUDE_MODEL_ROUTE_ENV_KEYS = CLAUDE_ROUTE_ENV_KEYS.filter(
  key => key !== 'ANTHROPIC_BASE_URL',
);

type ClaudeRouteEnvKey = typeof CLAUDE_ROUTE_ENV_KEYS[number];

export type ClaudeModelRouteEnvironment = Partial<Record<ClaudeRouteEnvKey, string>>;

interface ClaudeSettingsSnapshot {
  model: string;
  env: Partial<Record<ClaudeRouteEnvKey, string>>;
}

interface ClaudeSettingsLayer {
  snapshot: ClaudeSettingsSnapshot;
  note: string;
}

interface MergedClaudeSettings extends ClaudeSettingsSnapshot {
  modelNote: string;
  envModelNote: string;
}

function readClaudeSettings(filePath: string): ClaudeSettingsSnapshot {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const settings = parsed as Record<string, unknown>;
      const snapshot: ClaudeSettingsSnapshot = {
        model: typeof settings.model === 'string' ? settings.model.trim() : '',
        env: {},
      };
      if (settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)) {
        const settingsEnv = settings.env as Record<string, unknown>;
        for (const key of CLAUDE_ROUTE_ENV_KEYS) {
          const value = settingsEnv[key];
          if (typeof value === 'string') snapshot.env[key] = value.trim();
        }
      }
      return snapshot;
    }
  } catch {
    // Missing or malformed local config is not an error; we just skip it.
  }
  return { model: '', env: {} };
}

function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function pushUnique(options: LocalModelOption[], seen: Set<string>, option: LocalModelOption): void {
  if (seen.has(option.id)) return;
  seen.add(option.id);
  options.push(option);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function claudeSettingsLayers(cwd?: string): ClaudeSettingsLayer[] {
  const layers: ClaudeSettingsLayer[] = [{
    snapshot: readClaudeSettings(path.join(os.homedir(), '.claude', 'settings.json')),
    note: '~/.claude/settings.json',
  }];
  if (cwd?.trim()) {
    const projectRoot = path.resolve(cwd);
    layers.push({
      snapshot: readClaudeSettings(path.join(projectRoot, '.claude', 'settings.json')),
      note: `${projectRoot}/.claude/settings.json`,
    });
    layers.push({
      snapshot: readClaudeSettings(path.join(projectRoot, '.claude', 'settings.local.json')),
      note: `${projectRoot}/.claude/settings.local.json`,
    });
  }
  return layers;
}

function mergeClaudeSettings(cwd?: string): MergedClaudeSettings {
  const merged: MergedClaudeSettings = {
    model: '',
    modelNote: '',
    env: {},
    envModelNote: '',
  };
  for (const layer of claudeSettingsLayers(cwd)) {
    if (layer.snapshot.model) {
      merged.model = layer.snapshot.model;
      merged.modelNote = `model in ${layer.note}`;
    }
    for (const key of CLAUDE_ROUTE_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(layer.snapshot.env, key)) {
        merged.env[key] = layer.snapshot.env[key] ?? '';
        if (key === 'ANTHROPIC_MODEL') {
          merged.envModelNote = `env.ANTHROPIC_MODEL in ${layer.note}`;
        }
      }
    }
  }
  return merged;
}

function readClaudeConfiguredModels(
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Array<{ model: string; note: string }> {
  const envModel = env.ANTHROPIC_MODEL?.trim();
  const models = envModel ? [{ model: envModel, note: 'ANTHROPIC_MODEL' }] : [];
  for (const layer of claudeSettingsLayers(cwd).reverse()) {
    if (layer.snapshot.env.ANTHROPIC_MODEL) {
      models.push({
        model: layer.snapshot.env.ANTHROPIC_MODEL,
        note: `env.ANTHROPIC_MODEL in ${layer.note}`,
      });
    }
    if (layer.snapshot.model) {
      models.push({ model: layer.snapshot.model, note: `model in ${layer.note}` });
    }
  }
  return models;
}

function mergeClaudeRouteEnvironment(
  settingsEnv: ClaudeSettingsSnapshot['env'],
  processEnvironment: NodeJS.ProcessEnv,
): Partial<Record<ClaudeRouteEnvKey, string>> {
  const merged = { ...settingsEnv };
  for (const key of CLAUDE_ROUTE_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(processEnvironment, key)) {
      merged[key] = processEnvironment[key]?.trim() ?? '';
    }
  }
  return merged;
}

/**
 * Resolve only non-secret Claude model-routing fields. CC Switch mode uses
 * this to preserve its current family/subagent mapping without ever reading
 * or copying authentication fields.
 */
export function resolveClaudeModelRouteEnvironment(
  env: NodeJS.ProcessEnv = {},
  cwd?: string,
): ClaudeModelRouteEnvironment {
  const settings = mergeClaudeSettings(cwd);
  const routeEnvironment = mergeClaudeRouteEnvironment(settings.env, env);
  return Object.fromEntries(
    CLAUDE_MODEL_ROUTE_ENV_KEYS.flatMap(key => {
      const value = routeEnvironment[key]?.trim();
      return value ? [[key, value]] : [];
    }),
  );
}

/**
 * Resolve one CC Switch session exclusively from the already-validated global
 * snapshot. Vault-level Claude settings intentionally never participate in
 * this mode; they remain available only through the local CLI source.
 */
export function resolveClaudeCcSwitchSessionConfig(
  routeSnapshot: ClaudeModelRouteEnvironment = {},
  globalCliModelSnapshot?: string | null,
  globalSnapshotFingerprint?: string | null,
): ClaudeCcSwitchSessionConfig {
  const routeEnvironment = routeSnapshot;
  const cliModel = routeEnvironment.ANTHROPIC_MODEL?.trim()
    || globalCliModelSnapshot?.trim()
    || '';
  return {
    cliModel,
    routedModel: resolveClaudeRoutedModelLabel(cliModel, routeEnvironment),
    routeFingerprint: JSON.stringify({
      version: 2,
      globalSnapshotFingerprint: globalSnapshotFingerprint?.trim() ?? '',
      cliModel,
      ...Object.fromEntries(CLAUDE_MODEL_ROUTE_ENV_KEYS.map(key => [key, routeEnvironment[key] ?? ''])),
    }),
  };
}

function claudeModelFamily(
  cliModel: string,
  routeEnv: ClaudeModelRouteEnvironment,
): 'HAIKU' | 'SONNET' | 'OPUS' | null {
  const normalized = cliModel.toLowerCase();
  const matches = new Set<'HAIKU' | 'SONNET' | 'OPUS'>();
  const alias = normalized.match(/^(haiku|sonnet|opus)(?:\[1m\])?$/)?.[1];
  const fullModel = normalized.match(/^claude-(haiku|sonnet|opus)(?:-|\[|$)/)?.[1];
  const namedFamily = alias || fullModel;
  if (namedFamily === 'haiku') matches.add('HAIKU');
  if (namedFamily === 'sonnet') matches.add('SONNET');
  if (namedFamily === 'opus') matches.add('OPUS');
  if (cliModel === routeEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL) matches.add('HAIKU');
  if (cliModel === routeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL) matches.add('SONNET');
  if (cliModel === routeEnv.ANTHROPIC_DEFAULT_OPUS_MODEL) matches.add('OPUS');
  return matches.size === 1 ? [...matches][0] ?? null : null;
}

/**
 * Resolve the upstream label for one concrete Claude CLI model. When the CLI
 * model does not identify a family, a routed label is only safe if every
 * configured family points to the same upstream model.
 */
export function resolveClaudeRoutedModelLabel(
  cliModel: string,
  routeEnv: ClaudeModelRouteEnvironment,
): string | null {
  const normalizedCliModel = cliModel.trim();
  const family = claudeModelFamily(normalizedCliModel, routeEnv);
  if (family) {
    return routeEnv[`ANTHROPIC_DEFAULT_${family}_MODEL_NAME`]?.trim()
      || null;
  }
  return null;
}

function gatewayLabel(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (loopback && url.port === '15721') return 'CC Switch';
    if (loopback) return '本地网关';
  } catch {
    // Keep a generic label for malformed/custom endpoints.
  }
  return '自定义网关';
}

function safeBaseUrlFingerprint(baseUrl: string): string {
  if (!baseUrl) return '';
  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return `invalid-url-length:${baseUrl.length}`;
  }
}

export function resolveClaudeLocalModel(
  modelOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): ClaudeResolvedLocalModel | null {
  const settings = mergeClaudeSettings(cwd);
  const routeEnv = mergeClaudeRouteEnvironment(settings.env, env);
  const explicitModel = modelOverride?.trim() ?? '';
  const cliModel = explicitModel || routeEnv.ANTHROPIC_MODEL || settings.model;
  if (!cliModel) return null;

  const routedModel = resolveClaudeRoutedModelLabel(cliModel, routeEnv);
  const baseUrl = routeEnv.ANTHROPIC_BASE_URL?.trim() ?? '';
  const hasDistinctRoute = Boolean(routedModel && routedModel !== cliModel && baseUrl);
  const processEnvironmentModel = Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_MODEL')
    ? env.ANTHROPIC_MODEL?.trim() ?? ''
    : '';
  const sourceNote = explicitModel
    ? '插件模型覆盖'
    : processEnvironmentModel
      ? 'ANTHROPIC_MODEL'
      : routeEnv.ANTHROPIC_MODEL && settings.envModelNote
        ? settings.envModelNote
        : settings.modelNote || 'Claude Code default';
  const routeFingerprint = JSON.stringify({
    version: 1,
    cliModel,
    ...Object.fromEntries(CLAUDE_ROUTE_ENV_KEYS.map(key => [
      key,
      key === 'ANTHROPIC_BASE_URL'
        ? safeBaseUrlFingerprint(routeEnv[key] ?? '')
        : routeEnv[key] ?? '',
    ])),
  });

  return {
    id: cliModel,
    cliModel,
    label: hasDistinctRoute ? routedModel || cliModel : cliModel,
    note: hasDistinctRoute
      ? `经 ${gatewayLabel(baseUrl)}；CLI 模型 ${cliModel}`
      : sourceNote,
    routedModel: hasDistinctRoute ? routedModel || undefined : undefined,
    routeFingerprint,
  };
}

export function getClaudeDetectedLocalModel(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): ClaudeResolvedLocalModel | null {
  return resolveClaudeLocalModel(undefined, env, cwd);
}

/**
 * Models the local Claude Code CLI can run with, combining built-in aliases
 * with whatever the user's local config (~/.claude/settings.json) selects.
 */
export function listClaudeLocalModels(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): LocalModelOption[] {
  const options = [...CLAUDE_MODEL_ALIASES];
  const seen = new Set(options.map(option => option.id));
  for (const { model, note } of readClaudeConfiguredModels(env, cwd)) {
    if (model && !seen.has(model)) {
      seen.add(model);
      options.push({ id: model, label: model, note });
    }
  }
  return options;
}

export function listCodexLocalModels(): LocalModelOption[] {
  const options: LocalModelOption[] = [
    { id: '', label: 'CLI default', note: 'uses local Codex config' },
  ];
  const seen = new Set(options.map(option => option.id));
  const config = readTextFile(path.join(os.homedir(), '.codex', 'config.toml'));
  if (!config) return options;

  const model = config.match(/^\s*model\s*=\s*(['"][^'"]+['"]|[^\s#]+)/m)?.[1];
  const provider = config.match(/^\s*model_provider\s*=\s*(['"][^'"]+['"]|[^\s#]+)/m)?.[1];
  const cleanModel = model ? unquote(model) : '';
  const cleanProvider = provider ? unquote(provider) : '';
  if (cleanModel) {
    pushUnique(options, seen, {
      id: cleanProvider ? `${cleanProvider}/${cleanModel}` : cleanModel,
      label: cleanModel,
      note: cleanProvider ? `${cleanProvider} in ~/.codex/config.toml` : '~/.codex/config.toml',
    });
  }

  for (const match of config.matchAll(/^\s*\[model_providers\.([^\]]+)]/gm)) {
    const providerName = unquote(match[1] ?? '');
    if (providerName && cleanModel) {
      pushUnique(options, seen, {
        id: `${providerName}/${cleanModel}`,
        label: providerName,
        note: cleanModel,
      });
    }
  }
  return options;
}

export function listLocalModels(
  agentId: AgentId,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): LocalModelOption[] {
  if (agentId === 'claude') return listClaudeLocalModels(env, cwd);
  if (agentId === 'codex') return listCodexLocalModels();
  return [];
}
