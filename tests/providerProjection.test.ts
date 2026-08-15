import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodexOverrideArgs,
  prepareCcSwitchProjection,
  prepareProviderProjection,
} from '../src/runtime/providerProjection';
import type { ProviderProfile } from '../src/types';

const profile: ProviderProfile = {
  id: 'profile_1',
  agentId: 'codex',
  name: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-5.4',
  defaultModel: 'gpt-5.4',
  models: ['gpt-5.4'],
  wireApi: 'chat',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('provider projection', () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-projection-')));
    env = { AILU_HOME: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('builds codex -c override args', () => {
    expect(buildCodexOverrideArgs(profile)).toContain('model="gpt-5.4"');
    expect(buildCodexOverrideArgs(profile)).toContain('model_providers.openai.wire_api="chat"');
  });

  test('writes temporary Codex config and cleans it up', () => {
    const projection = prepareProviderProjection('codex', profile, env);
    const codexHome = String(projection.env.CODEX_HOME);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'auth.json'))).toBe(true);
    projection.cleanup();
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  test('maps compatible Claude providers to auth token and clears inherited API keys', () => {
    const projection = prepareProviderProjection('claude', {
      ...profile,
      agentId: 'claude',
      name: 'Moonshot',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      anthropicAuthMode: 'authToken',
    }, {
      ...env,
      ANTHROPIC_API_KEY: 'inherited-key',
      ANTHROPIC_AUTH_TOKEN: 'inherited-token',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_MODEL: 'inherited-model',
      CLAUDE_CONFIG_DIR: '/tmp/inherited-claude-config',
    });
    expect(projection.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(projection.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    expect(projection.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
    expect(projection.env.ANTHROPIC_MODEL).toBe('gpt-5.4');
    expect(projection.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    const settingsIndex = projection.args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settingsPath = projection.args[settingsIndex + 1] ?? '';
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    }
    const projectedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(projectedSettings.env).toMatchObject({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://api.moonshot.cn/anthropic',
      ANTHROPIC_MODEL: 'gpt-5.4',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.4',
    });
    expect(projection.args.join(' ')).not.toContain('sk-test');
    projection.cleanup();
    expect(fs.existsSync(path.dirname(settingsPath))).toBe(false);
  });

  test('clears inherited Claude config directories for local CLI turns', () => {
    const projection = prepareProviderProjection('claude', null, {
      ...env,
      CLAUDE_CONFIG_DIR: '/tmp/inherited-claude-config',
    });

    expect(projection.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(projection.args).toEqual([]);
  });

  test('maps the official Anthropic provider to API key and clears inherited auth tokens', () => {
    const projection = prepareProviderProjection('claude', {
      ...profile,
      agentId: 'claude',
      name: 'Claude',
      baseUrl: 'https://api.anthropic.com',
      anthropicAuthMode: 'apiKey',
    }, {
      ...env,
      ANTHROPIC_AUTH_TOKEN: 'inherited-token',
    });
    expect(projection.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(projection.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    const settingsIndex = projection.args.indexOf('--settings');
    const settingsPath = projection.args[settingsIndex + 1] ?? '';
    const projectedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };

    if (process.platform !== 'win32') {
      expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600);
    }
    expect(projectedSettings.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(projectedSettings.env.ANTHROPIC_AUTH_TOKEN).toBe('');
    projection.cleanup();
  });

  test('blocks OAuth fallback for a keyless loopback Claude provider', () => {
    const projection = prepareProviderProjection('claude', {
      ...profile,
      agentId: 'claude',
      name: 'Local gateway',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:9000',
      anthropicAuthMode: 'authToken',
    }, env);
    const settingsIndex = projection.args.indexOf('--settings');
    const settingsPath = projection.args[settingsIndex + 1] ?? '';
    const projectedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };

    expect(projection.env.ANTHROPIC_AUTH_TOKEN).toBe('ailu-keyless-provider');
    expect(projectedSettings.env.ANTHROPIC_AUTH_TOKEN).toBe('ailu-keyless-provider');
    expect(projectedSettings.env.ANTHROPIC_API_KEY).toBe('');
    projection.cleanup();
  });

  test('refuses to project credentials to a plaintext remote provider', () => {
    expect(() => prepareProviderProjection('claude', {
      ...profile,
      agentId: 'claude',
      baseUrl: 'http://api.example.com/anthropic',
    }, env)).toThrow('必须使用 HTTPS');
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });

  test('preserves distinct CC Switch family routes while clearing inherited credentials', () => {
    const globalClaudeConfigDir = path.join(tempDir, 'cc-switch-global-claude');
    const vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(globalClaudeConfigDir);
    fs.mkdirSync(vaultDir);
    const projection = prepareCcSwitchProjection({
      ...env,
      ANTHROPIC_API_KEY: 'api-key-sentinel',
      ANTHROPIC_AUTH_TOKEN: 'oauth-token-sentinel',
      ANTHROPIC_BASE_URL: 'https://should-not-survive.example',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'stale-haiku',
      CLAUDE_CONFIG_DIR: '/tmp/stale-claude-config',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
    }, {
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      ANTHROPIC_REASONING_MODEL: 'reasoning-route',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-route',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-route',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-route',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
      ANTHROPIC_SMALL_FAST_MODEL: 'small-fast-route',
      CLAUDE_CODE_SUBAGENT_MODEL: 'subagent-route',
    }, globalClaudeConfigDir, vaultDir);
    const settingsIndex = projection.args.indexOf('--settings');
    const settingsPath = projection.args[settingsIndex + 1] ?? '';
    const projectedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };

    expect(projectedSettings.env).toMatchObject({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'ailu-keyless-provider',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
      ANTHROPIC_REASONING_MODEL: 'reasoning-route',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-route',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-route',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-route',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
      CLAUDE_CODE_SUBAGENT_MODEL: 'subagent-route',
    });
    expect(projectedSettings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      .not.toBe(projectedSettings.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    expect(JSON.stringify(projectedSettings)).not.toContain('sentinel');
    expect(projection.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(projection.env.CLAUDE_CONFIG_DIR).toBe(globalClaudeConfigDir);
    expect(projection.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(projection.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(projection.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(projectedSettings.env.CLAUDE_CODE_USE_BEDROCK).toBe('');
    expect(projectedSettings.env.CLAUDE_CODE_USE_VERTEX).toBe('');
    expect(projectedSettings.env.CLAUDE_CODE_USE_FOUNDRY).toBe('');
    expect(projection.args.join(' ')).not.toContain('sentinel');
    projection.cleanup();
  });

  test('rejects a CC Switch config directory with a symlink path component', () => {
    const physicalParent = path.join(tempDir, 'physical-parent');
    const physicalConfig = path.join(physicalParent, 'claude');
    const linkedParent = path.join(tempDir, 'linked-parent');
    const vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(physicalConfig, { recursive: true });
    fs.mkdirSync(vaultDir);
    fs.symlinkSync(physicalParent, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => prepareCcSwitchProjection(
      env,
      {},
      path.join(linkedParent, 'claude'),
      vaultDir,
    )).toThrow('symlink-free directory outside the current Vault');
  });

  test('rejects a physical CC Switch config directory inside the request Vault', () => {
    const vaultDir = path.join(tempDir, 'vault');
    const vaultClaudeDir = path.join(vaultDir, '.claude');
    fs.mkdirSync(vaultClaudeDir, { recursive: true });

    expect(() => prepareCcSwitchProjection(
      env,
      {},
      vaultClaudeDir,
      vaultDir,
    )).toThrow('symlink-free directory outside the current Vault');
  });
});
