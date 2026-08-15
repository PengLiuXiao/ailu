import fs from 'fs';
import path from 'path';

import { AILU_IDS } from '../ids';
import { tmpDir } from '../paths';
import type { AgentId, ProviderProfile } from '../types';
import { ensureDir, safeRemoveDir, writeJsonFile } from '../utils/fs';
import { normalizeProviderBaseUrl, resolveAnthropicAuthMode } from '../utils/providerAuth';
import { CC_SWITCH_BASE_URL } from './ccSwitch';
import {
  CLAUDE_MODEL_ROUTE_ENV_KEYS,
} from './localModels';

export interface ProviderProjection {
  env: NodeJS.ProcessEnv;
  args: string[];
  cleanup: () => void;
}

function sanitizeProviderKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'custom';
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function makeTurnTmpDir(agentId: AgentId, env: NodeJS.ProcessEnv): string {
  return path.join(tmpDir(env), `${agentId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function profileModel(profile: ProviderProfile): string {
  return (profile.defaultModel || profile.model || '').trim();
}

const CC_SWITCH_CONFIG_DIRECTORY_ERROR =
  'CC Switch global Claude configuration directory must be an existing symlink-free directory outside the current Vault.';

function clearInheritedClaudeConfigDirectory(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...env };
  delete isolated.CLAUDE_CONFIG_DIR;
  return isolated;
}

function isSameOrDescendantPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Resolve an existing directory without following any caller-controlled path
 * component. The resulting canonical path is what reaches Claude Code.
 */
function resolvePhysicalCcSwitchConfigDirectory(
  claudeConfigDir: string,
  requestCwd: string,
): string {
  const normalizedConfigDir = claudeConfigDir.trim();
  const hasControlCharacter = [...normalizedConfigDir].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    !normalizedConfigDir
    || normalizedConfigDir.length > 4_096
    || hasControlCharacter
    || !path.isAbsolute(normalizedConfigDir)
  ) {
    throw new Error(CC_SWITCH_CONFIG_DIRECTORY_ERROR);
  }

  try {
    const absoluteConfigDir = path.resolve(normalizedConfigDir);
    const parsed = path.parse(absoluteConfigDir);
    let cursor = parsed.root;
    for (const component of absoluteConfigDir.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const metadata = fs.lstatSync(cursor);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(CC_SWITCH_CONFIG_DIRECTORY_ERROR);
      }
    }

    const physicalConfigDir = fs.realpathSync.native(absoluteConfigDir);
    const physicalCwd = fs.realpathSync.native(path.resolve(requestCwd));
    if (!fs.statSync(physicalCwd).isDirectory()) {
      throw new Error(CC_SWITCH_CONFIG_DIRECTORY_ERROR);
    }
    if (isSameOrDescendantPath(physicalConfigDir, physicalCwd)) {
      throw new Error(CC_SWITCH_CONFIG_DIRECTORY_ERROR);
    }
    return physicalConfigDir;
  } catch {
    throw new Error(CC_SWITCH_CONFIG_DIRECTORY_ERROR);
  }
}

const CLAUDE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  ...CLAUDE_MODEL_ROUTE_ENV_KEYS,
] as const;

// Prevent Claude Code from falling back to the user's first-party OAuth token
// when a deliberately keyless loopback provider profile is selected.
const KEYLESS_CLAUDE_PROVIDER_TOKEN = `${AILU_IDS.pluginId}-keyless-provider`;

function prepareClaudeSettingsFile(
  env: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv,
): ProviderProjection {
  const claudeTmpDir = makeTurnTmpDir('claude', baseEnv);
  ensureDir(claudeTmpDir);
  try {
    fs.chmodSync(claudeTmpDir, 0o700);
  } catch {
    // Best-effort hardening for filesystems that support POSIX modes.
  }
  const settingsPath = path.join(claudeTmpDir, 'provider-settings.json');
  const projectedEnv = Object.fromEntries(
    CLAUDE_PROVIDER_ENV_KEYS.map(key => [key, env[key] ? String(env[key]) : '']),
  );
  try {
    writeJsonFile(settingsPath, { env: projectedEnv }, 0o600);
  } catch (error) {
    safeRemoveDir(claudeTmpDir);
    throw error;
  }
  return {
    env,
    args: ['--settings', settingsPath],
    cleanup: () => safeRemoveDir(claudeTmpDir),
  };
}

/**
 * Project CC Switch without touching its credentials or flattening its model
 * family map. Only the non-secret routing fields from Claude's current global
 * settings are copied into the per-turn, permission-restricted settings file.
 */
export function prepareCcSwitchProjection(
  baseEnv: NodeJS.ProcessEnv,
  routeEnvironment: NodeJS.ProcessEnv,
  claudeConfigDir: string,
  requestCwd: string,
): ProviderProjection {
  const physicalConfigDir = resolvePhysicalCcSwitchConfigDirectory(claudeConfigDir, requestCwd);
  const env = { ...baseEnv };
  for (const key of CLAUDE_PROVIDER_ENV_KEYS) delete env[key];
  delete env.CLAUDE_CONFIG_DIR;
  for (const [key, value] of Object.entries(routeEnvironment)) {
    if (!CLAUDE_MODEL_ROUTE_ENV_KEYS.includes(key as typeof CLAUDE_MODEL_ROUTE_ENV_KEYS[number])) continue;
    if (!value?.trim()) continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = physicalConfigDir;
  env.ANTHROPIC_AUTH_TOKEN = KEYLESS_CLAUDE_PROVIDER_TOKEN;
  env.ANTHROPIC_BASE_URL = CC_SWITCH_BASE_URL;
  return prepareClaudeSettingsFile(env, baseEnv);
}

export function buildCodexOverrideArgs(profile: ProviderProfile): string[] {
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl);
  const providerKey = sanitizeProviderKey(profile.name || profile.id);
  const model = profileModel(profile);
  const wireApi = profile.wireApi ?? 'chat';
  const args = [
    '-c',
    `model_provider=${tomlString(providerKey)}`,
    '-c',
    `model_providers.${providerKey}.name=${tomlString(profile.name)}`,
    '-c',
    `model_providers.${providerKey}.wire_api=${tomlString(wireApi)}`,
    '-c',
    `model_providers.${providerKey}.requires_openai_auth=true`,
  ];
  if (model) {
    args.push('-c', `model=${tomlString(model)}`);
  }
  if (baseUrl) {
    args.push('-c', `model_providers.${providerKey}.base_url=${tomlString(baseUrl)}`);
  }
  return args;
}

export function prepareProviderProjection(
  agentId: AgentId,
  profile: ProviderProfile | null,
  baseEnv: NodeJS.ProcessEnv,
): ProviderProjection {
  if (agentId !== 'claude' && agentId !== 'codex') {
    throw new Error('Unsupported agent provider projection.');
  }
  if (!profile) {
    return {
      env: agentId === 'claude'
        ? clearInheritedClaudeConfigDirectory(baseEnv)
        : { ...baseEnv },
      args: [],
      cleanup: () => undefined,
    };
  }

  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl);

  if (agentId === 'claude') {
    const env = clearInheritedClaudeConfigDirectory(baseEnv);
    const model = profileModel(profile);
    for (const key of CLAUDE_PROVIDER_ENV_KEYS) delete env[key];
    const projectedCredential = profile.apiKey || KEYLESS_CLAUDE_PROVIDER_TOKEN;
    if (resolveAnthropicAuthMode(profile) === 'apiKey') {
      env.ANTHROPIC_API_KEY = projectedCredential;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = projectedCredential;
    }
    if (baseUrl) {
      env.ANTHROPIC_BASE_URL = baseUrl;
    }
    if (model) {
      for (const key of CLAUDE_MODEL_ROUTE_ENV_KEYS) env[key] = model;
    }
    // Claude user settings can contain CC Switch or another global gateway.
    // A command-line settings file has higher precedence while keeping the
    // user's hooks, skills and project settings available to the session.
    return prepareClaudeSettingsFile(env, baseEnv);
  }

  const codexHome = makeTurnTmpDir('codex', baseEnv);
  ensureDir(codexHome);
  const providerKey = sanitizeProviderKey(profile.name || profile.id);
  const model = profileModel(profile);
  const wireApi = profile.wireApi ?? 'chat';
  const configLines = [
    `model_provider = ${tomlString(providerKey)}`,
    model ? `model = ${tomlString(model)}` : '',
    '',
    `[model_providers.${providerKey}]`,
    `name = ${tomlString(profile.name)}`,
    baseUrl ? `base_url = ${tomlString(baseUrl)}` : '',
    `wire_api = ${tomlString(wireApi)}`,
    'requires_openai_auth = true',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `${configLines}\n`, { mode: 0o600 });
  writeJsonFile(path.join(codexHome, 'auth.json'), { OPENAI_API_KEY: profile.apiKey }, 0o600);
  return {
    env: {
      ...baseEnv,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: profile.apiKey,
    },
    args: buildCodexOverrideArgs(profile),
    cleanup: () => safeRemoveDir(codexHome),
  };
}
