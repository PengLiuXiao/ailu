import path from 'path';

const mockFiles = vi.hoisted(() => ({
  home: '/mock-home',
  contents: new Map<string, string>(),
  reads: [] as string[],
}));

vi.mock('fs', () => ({
  default: {
    readFileSync(filePath: string | Buffer | URL | number): string {
      const normalizedPath = String(filePath);
      mockFiles.reads.push(normalizedPath);
      const content = mockFiles.contents.get(normalizedPath);
      if (content === undefined) throw new Error(`ENOENT: ${normalizedPath}`);
      return content;
    },
  },
}));

vi.mock('os', () => ({
  default: {
    homedir: (): string => mockFiles.home,
  },
}));

import {
  getClaudeDetectedLocalModel,
  listClaudeLocalModels,
  resolveClaudeCcSwitchSessionConfig,
  resolveClaudeLocalModel,
  resolveClaudeRoutedModelLabel,
} from '../src/runtime/localModels';
import {
  buildClaudeSessionConfigKey,
  shouldResumeClaudeSession,
} from '../src/ui/chatAgentSelection';

const settingsPath = path.join(mockFiles.home, '.claude', 'settings.json');
const localSettingsPath = path.join(mockFiles.home, '.claude', 'settings.local.json');
const projectRoot = '/mock-vault';
const projectSettingsPath = path.join(projectRoot, '.claude', 'settings.json');
const projectLocalSettingsPath = path.join(projectRoot, '.claude', 'settings.local.json');

describe('Claude local model detection', () => {
  beforeEach(() => {
    mockFiles.contents.clear();
    mockFiles.reads.length = 0;
  });

  test('reads nested env.ANTHROPIC_MODEL before the top-level settings model', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      env: { ANTHROPIC_MODEL: '  nested-model  ' },
      model: 'top-level-model',
    }));

    expect(getClaudeDetectedLocalModel({})).toMatchObject({
      id: 'nested-model',
      cliModel: 'nested-model',
      label: 'nested-model',
      note: 'env.ANTHROPIC_MODEL in ~/.claude/settings.json',
    });

    const configuredModels = listClaudeLocalModels({})
      .filter(option => option.id === 'nested-model' || option.id === 'top-level-model');
    expect(configuredModels).toEqual([
      {
        id: 'nested-model',
        label: 'nested-model',
        note: 'env.ANTHROPIC_MODEL in ~/.claude/settings.json',
      },
      {
        id: 'top-level-model',
        label: 'top-level-model',
        note: 'model in ~/.claude/settings.json',
      },
    ]);
  });

  test('prefers the process environment over nested and top-level settings models', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      env: { ANTHROPIC_MODEL: 'nested-model' },
      model: 'top-level-model',
    }));

    expect(getClaudeDetectedLocalModel({ ANTHROPIC_MODEL: '  process-model  ' })).toMatchObject({
      id: 'process-model',
      cliModel: 'process-model',
      label: 'process-model',
      note: 'ANTHROPIC_MODEL',
    });

    const configuredIds = listClaudeLocalModels({ ANTHROPIC_MODEL: 'process-model' })
      .map(option => option.id)
      .filter(id => id.endsWith('-model'));
    expect(configuredIds).toEqual(['process-model', 'nested-model', 'top-level-model']);
  });

  test('falls back to the top-level model and never reads settings.local.json', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({ model: 'top-level-model' }));
    mockFiles.contents.set(localSettingsPath, JSON.stringify({ model: 'local-model' }));

    expect(getClaudeDetectedLocalModel({})?.id).toBe('top-level-model');
    expect(mockFiles.reads).not.toContain(localSettingsPath);

    mockFiles.contents.delete(settingsPath);
    mockFiles.reads.length = 0;
    expect(getClaudeDetectedLocalModel({})).toBeNull();
    expect(mockFiles.reads).not.toContain(localSettingsPath);
  });

  test('shows the CC Switch upstream model without changing the CLI model id', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      model: 'sonnet[1m]',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-7',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'qwen3.8-max-preview',
      },
    }));

    const detected = getClaudeDetectedLocalModel({});
    expect(detected).toMatchObject({
      id: 'sonnet[1m]',
      cliModel: 'sonnet[1m]',
      label: 'qwen3.8-max-preview',
      routedModel: 'qwen3.8-max-preview',
      note: '经 CC Switch；CLI 模型 sonnet[1m]',
    });
    expect(detected?.routeFingerprint).toContain('http://127.0.0.1:15721');
    expect(detected?.routeFingerprint).toContain('qwen3.8-max-preview');
    expect(detected?.routeFingerprint).not.toContain('AUTH_TOKEN');

    expect(resolveClaudeLocalModel('opus', {})).toMatchObject({
      id: 'opus',
      cliModel: 'opus',
      label: 'qwen3.8-max-preview',
      note: '经 CC Switch；CLI 模型 opus',
    });
  });

  test('applies project and project-local model precedence for the active Vault', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      model: 'sonnet[1m]',
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'qwen3.8-max-preview',
      },
    }));
    mockFiles.contents.set(projectSettingsPath, JSON.stringify({ model: 'glm-4.7' }));
    mockFiles.contents.set(projectLocalSettingsPath, JSON.stringify({ model: 'vault-local-model' }));

    expect(getClaudeDetectedLocalModel({}, projectRoot)).toMatchObject({
      id: 'vault-local-model',
      cliModel: 'vault-local-model',
      label: 'vault-local-model',
      note: `model in ${projectLocalSettingsPath}`,
    });
    expect(resolveClaudeLocalModel('opus', {}, projectRoot)).toMatchObject({
      id: 'opus',
      cliModel: 'opus',
      label: 'qwen3.8-max-preview',
    });
    expect(listClaudeLocalModels({}, projectRoot).map(option => option.id)).toEqual(
      expect.arrayContaining(['vault-local-model', 'glm-4.7', 'sonnet[1m]']),
    );
  });

  test('keeps a CC Switch session stable when Vault model settings change', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      model: 'sonnet[1m]',
      env: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
      },
    }));
    mockFiles.contents.set(projectSettingsPath, JSON.stringify({ model: 'glm-4.7' }));
    mockFiles.contents.set(projectLocalSettingsPath, JSON.stringify({ model: 'vault-local-model' }));
    const globalRoute = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
    };
    const beforeConfig = resolveClaudeCcSwitchSessionConfig(globalRoute, 'sonnet[1m]');
    const beforeKey = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: beforeConfig.cliModel,
      localRouteFingerprint: beforeConfig.routeFingerprint,
      ccSwitchProviderId: 'provider-current',
    });

    mockFiles.contents.set(projectSettingsPath, JSON.stringify({ model: 'opus' }));
    mockFiles.contents.set(projectLocalSettingsPath, JSON.stringify({ model: 'haiku' }));
    const afterConfig = resolveClaudeCcSwitchSessionConfig(globalRoute, 'sonnet[1m]');
    const afterKey = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: afterConfig.cliModel,
      localRouteFingerprint: afterConfig.routeFingerprint,
      ccSwitchProviderId: 'provider-current',
    });

    expect(beforeConfig.cliModel).toBe('sonnet[1m]');
    expect(afterConfig.cliModel).toBe('sonnet[1m]');
    expect(beforeConfig.routeFingerprint).toContain('haiku-upstream');
    expect(afterConfig.routeFingerprint).toBe(beforeConfig.routeFingerprint);
    expect(shouldResumeClaudeSession('session-1', beforeKey, afterKey)).toBe(true);
    expect(mockFiles.reads).toEqual([]);
  });

  test('uses one injected global CC Switch snapshot and ignores Vault model layers', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      model: 'stale-global-model',
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'stale-global-route',
      },
    }));
    mockFiles.contents.set(projectSettingsPath, JSON.stringify({ model: 'opus[1m]' }));
    mockFiles.contents.set(projectLocalSettingsPath, JSON.stringify({ model: 'haiku' }));
    const injectedRoute = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-pro',
    };

    const config = resolveClaudeCcSwitchSessionConfig(
      injectedRoute,
      'sonnet',
    );

    expect(config.cliModel).toBe('sonnet');
    expect(config.routedModel).toBe('deepseek-pro');
    expect(config.routeFingerprint).toContain('deepseek-flash');
    expect(config.routeFingerprint).not.toContain('stale-global-route');
    expect(mockFiles.reads).toEqual([]);
  });

  test('never invents a family route for unknown or ambiguous model names', () => {
    const sameFamilyRoutes = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'same-upstream',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'same-upstream',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'same-upstream',
    };

    expect(resolveClaudeRoutedModelLabel('glm-4.7', sameFamilyRoutes)).toBeNull();
    expect(resolveClaudeRoutedModelLabel('default', sameFamilyRoutes)).toBeNull();
    expect(resolveClaudeRoutedModelLabel('opusplan', sameFamilyRoutes)).toBeNull();
    expect(resolveClaudeRoutedModelLabel('sonnet[1m]', sameFamilyRoutes)).toBe('same-upstream');
    expect(resolveClaudeRoutedModelLabel('shared-role', {
      ...sameFamilyRoutes,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'shared-role',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'shared-role',
    })).toBeNull();
  });

  test('treats an empty CLI model as the Sonnet-family default', () => {
    const routes = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'glm-5.3',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'glm-5.3',
    };

    expect(resolveClaudeRoutedModelLabel('', routes)).toBe('glm-5.3-flash');
    expect(resolveClaudeRoutedModelLabel('', {
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'glm-5.3',
    })).toBeNull();
  });

  test('resolves the Fable family through aliases and explicit mappings', () => {
    const routes = {
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'claude-fable-5[1M]',
      ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'glm-5.3',
    };

    expect(resolveClaudeRoutedModelLabel('fable', routes)).toBe('glm-5.3');
    expect(resolveClaudeRoutedModelLabel('fable[1m]', routes)).toBe('glm-5.3');
    expect(resolveClaudeRoutedModelLabel('claude-fable-5[1M]', routes)).toBe('glm-5.3');
  });

  test('does not persist URL credentials in the route fingerprint', () => {
    mockFiles.contents.set(settingsPath, JSON.stringify({
      model: 'sonnet',
      env: {
        ANTHROPIC_BASE_URL: 'https://user:secret@example.com/anthropic?token=private',
      },
    }));

    const fingerprint = getClaudeDetectedLocalModel({})?.routeFingerprint ?? '';
    expect(fingerprint).toContain('https://example.com');
    expect(fingerprint).not.toContain('anthropic');
    expect(fingerprint).not.toContain('secret');
    expect(fingerprint).not.toContain('private');
  });
});
