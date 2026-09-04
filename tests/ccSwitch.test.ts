import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CC_SWITCH_BASE_URL,
  CcSwitchClient,
  ccSwitchGlobalSnapshot,
  ccSwitchRouteSummary,
  ccSwitchSnapshotLabel,
  ccSwitchSnapshotModelName,
  readCcSwitchCurrentSelection,
  type CcSwitchClientOptions,
  type CcSwitchCurrentSelection,
  type CcSwitchSnapshot,
  type CcSwitchTransport,
  type CcSwitchTransportResponse,
} from '../src/runtime/ccSwitch';
import { resolveClaudeCcSwitchSessionConfig } from '../src/runtime/localModels';
import {
  buildClaudeSessionConfigKey,
  shouldResumeClaudeSession,
} from '../src/ui/chatAgentSelection';

function selection(
  overrides: Partial<CcSwitchCurrentSelection> = {},
): CcSwitchCurrentSelection {
  return {
    currentProviderId: 'provider-id',
    currentCliModel: 'sonnet',
    currentModel: 'qwen3.8-max-preview',
    claudeConfigDir: '/mock-home/.claude',
    routeEnvironment: {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
    },
    sourceAvailable: true,
    routeFingerprint: 'route:provider-id',
    ...overrides,
  };
}

class TestCcSwitchClient extends CcSwitchClient {
  constructor(options: CcSwitchClientOptions = {}) {
    super({
      selectionReader: () => selection(),
      selectionStabilityDelayMs: 0,
      ...options,
    });
  }
}

const healthy: CcSwitchTransportResponse = {
  status: 200,
  body: JSON.stringify({
    status: 'healthy',
    timestamp: '2026-08-06T00:00:00Z',
  }),
};

function status(overrides: Record<string, unknown> = {}): CcSwitchTransportResponse {
  return {
    status: 200,
    body: JSON.stringify({
      running: true,
      address: '127.0.0.1',
      port: 15721,
      current_provider: 'qwen3.8-max',
      current_provider_id: 'provider-id',
      ...overrides,
    }),
  };
}

function sequenceTransport(...responses: CcSwitchTransportResponse[]): CcSwitchTransport {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[index++];
    if (!response) throw new Error('unexpected request');
    return response;
  });
}

describe('ccSwitchSnapshotLabel', () => {
  test('shows the configured CLI model when the upstream family mapping is unresolved', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: null,
      currentProviderId: '3cd6dac4-2b1d-4ed7-b2c6-74837d002cc1',
      currentCliModel: 'deepseek-v4-flash',
      currentModel: null,
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4-pro',
      },
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: true,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchRouteSummary(snapshot)).toBe('deepseek-v4-flash / deepseek-v4-pro');
    expect(ccSwitchSnapshotLabel(snapshot))
      .toBe('deepseek-v4-flash（按 CC Switch 配置） · 3cd6dac4');
  });

  test('reports a genuinely missing model as not configured', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: 'DeepSeek',
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: null,
      currentModel: null,
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {},
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: false,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchSnapshotLabel(snapshot)).toBe('模型未配置 · DeepSeek');
  });

  test('keeps a confirmed routed model free of the configured-model qualifier', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: 'DeepSeek',
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: 'sonnet',
      currentModel: 'deepseek-v4-flash',
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-flash',
      },
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: false,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchSnapshotLabel(snapshot)).toBe('deepseek-v4-flash · DeepSeek');
  });
});

describe('ccSwitchSnapshotModelName', () => {
  test('prefers the confirmed routed model for the composer chip', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: 'DeepSeek',
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: 'sonnet',
      currentModel: 'deepseek-v4-flash',
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-flash',
      },
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: false,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchSnapshotModelName(snapshot)).toBe('deepseek-v4-flash');
  });

  test('falls back to the configured CLI model without markers or qualifiers', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: null,
      currentProviderId: '3cd6dac4-2b1d-4ed7-b2c6-74837d002cc1',
      currentCliModel: 'deepseek-v4-flash',
      currentModel: null,
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {},
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: true,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchSnapshotModelName(snapshot)).toBe('deepseek-v4-flash');
  });

  test('reports a missing model instead of an empty chip', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'error',
      currentProvider: null,
      currentProviderId: null,
      currentCliModel: null,
      currentModel: null,
      claudeConfigDir: null,
      routeEnvironment: {},
      routeFingerprint: null,
      selectionSource: null,
      proxyStatusStale: false,
      error: 'CC Switch is offline or unavailable.',
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchSnapshotModelName(snapshot)).toBe('模型未配置');
  });
});

describe('ccSwitchGlobalSnapshot', () => {
  test('resolves the current model only from the global CC Switch snapshot', () => {
    const snapshot: CcSwitchSnapshot = {
      state: 'ready',
      currentProvider: 'DeepSeek',
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: 'sonnet[1m]',
      currentModel: 'deepseek-v4-pro',
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'deepseek-v4-pro',
      },
      routeFingerprint: 'route:deepseek',
      selectionSource: 'liveConfig',
      proxyStatusStale: false,
      error: null,
      checkedAt: 1,
      baseUrl: CC_SWITCH_BASE_URL,
    };

    expect(ccSwitchGlobalSnapshot(snapshot)).toMatchObject({
      currentCliModel: 'sonnet[1m]',
      currentModel: 'deepseek-v4-pro',
      routeFingerprint: 'route:deepseek',
    });
  });
});

describe('readCcSwitchCurrentSelection', () => {
  let tempDir: string;
  let ccSettingsPath: string;
  let claudeDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-ccswitch-selection-'));
    ccSettingsPath = path.join(tempDir, 'cc-switch-settings.json');
    claudeDir = path.join(tempDir, 'claude');
    fs.mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCcSettings(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(ccSettingsPath, JSON.stringify({
      currentProviderClaude: 'deepseek-provider-id',
      claudeConfigDir: claudeDir,
      webdavPassword: 'cc-switch-secret-sentinel',
      ...overrides,
    }));
  }

  test('reads the configured Claude directory and returns only whitelisted non-secret routing', () => {
    writeCcSettings();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'opus[1m]',
      apiKey: 'top-level-key-sentinel',
      env: {
        ANTHROPIC_BASE_URL: CC_SWITCH_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: 'auth-token-sentinel',
        ANTHROPIC_API_KEY: 'api-key-sentinel',
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
      },
    }));

    const result = readCcSwitchCurrentSelection(ccSettingsPath);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: 'opus[1m]',
      currentModel: 'opus-upstream',
      claudeConfigDir: claudeDir,
      sourceAvailable: true,
      routeEnvironment: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku-upstream',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet-upstream',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus-upstream',
      },
    });
    expect(result.routeFingerprint).toContain('opus[1m]');
    expect(serialized).not.toContain('sentinel');
    expect(serialized).not.toContain('ANTHROPIC_BASE_URL');
    expect(serialized).not.toContain('webdavPassword');
  });

  test('resolves the Sonnet-family default when only family mappings are configured', () => {
    writeCcSettings();
    // Real-world CC Switch shape: no `model`, no ANTHROPIC_MODEL — the CLI runs
    // its built-in default (Sonnet family) through the mapped upstream models.
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: CC_SWITCH_BASE_URL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'glm-5.3-flash',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'glm-5.3-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'glm-5.3',
        ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: 'glm-5.3',
      },
    }));

    const result = readCcSwitchCurrentSelection(ccSettingsPath);

    expect(result).toMatchObject({
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: null,
      currentModel: 'glm-5.3-flash',
    });
  });

  test('stays ready without an explicit CLI model and follows mapping-only switches', async () => {
    writeCcSettings({ currentProviderClaude: 'glm-provider-id' });
    const writeFamilyMappings = (upstream: string): void => {
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: CC_SWITCH_BASE_URL,
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: upstream,
        },
      }));
    };
    writeFamilyMappings('glm-5.3-flash');
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(
        healthy,
        status({ current_provider: 'GLM', current_provider_id: 'glm-provider-id' }),
        healthy,
        status({ current_provider: 'GLM', current_provider_id: 'glm-provider-id' }),
        healthy,
        status({ current_provider: 'GLM', current_provider_id: 'glm-provider-id' }),
        healthy,
        status({ current_provider: 'GLM', current_provider_id: 'glm-provider-id' }),
      ),
      selectionReader: () => readCcSwitchCurrentSelection(ccSettingsPath),
      selectionStabilityDelayMs: 0,
    });

    const before = await client.refresh();
    expect(before).toMatchObject({
      state: 'ready',
      currentCliModel: null,
      currentModel: 'glm-5.3-flash',
    });
    expect(ccSwitchSnapshotLabel(before)).toBe('glm-5.3-flash · GLM');
    expect(ccSwitchSnapshotModelName(before)).toBe('glm-5.3-flash');

    writeFamilyMappings('deepseek-v4-pro');
    const after = await client.refresh();
    expect(after).toMatchObject({
      state: 'ready',
      currentModel: 'deepseek-v4-pro',
    });
    expect(after.routeFingerprint).not.toBe(before.routeFingerprint);
  });

  test('normalizes a custom Claude directory into snapshots and invalidates its route session', async () => {
    const configuredDir = `${claudeDir}${path.sep}..${path.sep}${path.basename(claudeDir)}`;
    const alternateDir = path.join(tempDir, 'alternate-claude');
    const writeClaudeSettings = (targetDir: string): void => {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, 'settings.json'), JSON.stringify({
        model: 'sonnet',
        env: {
          ANTHROPIC_BASE_URL: CC_SWITCH_BASE_URL,
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
        },
      }));
    };
    writeClaudeSettings(claudeDir);
    writeClaudeSettings(alternateDir);
    writeCcSettings({ claudeConfigDir: configuredDir });
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(
        healthy,
        status({ current_provider: 'DeepSeek', current_provider_id: 'deepseek-provider-id' }),
        healthy,
        status({ current_provider: 'DeepSeek', current_provider_id: 'deepseek-provider-id' }),
      ),
      selectionReader: () => readCcSwitchCurrentSelection(ccSettingsPath),
      selectionStabilityDelayMs: 0,
    });

    const before = await client.refresh();
    const beforeSessionConfig = resolveClaudeCcSwitchSessionConfig(
      before.routeEnvironment,
      before.currentCliModel,
      before.routeFingerprint,
    );
    const beforeSessionKey = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: before.currentCliModel ?? '',
      localRouteFingerprint: beforeSessionConfig.routeFingerprint,
      ccSwitchProviderId: before.currentProviderId ?? '',
    });
    writeCcSettings({ claudeConfigDir: alternateDir });
    const after = await client.refresh();
    const afterSessionConfig = resolveClaudeCcSwitchSessionConfig(
      after.routeEnvironment,
      after.currentCliModel,
      after.routeFingerprint,
    );
    const afterSessionKey = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: after.currentCliModel ?? '',
      localRouteFingerprint: afterSessionConfig.routeFingerprint,
      ccSwitchProviderId: after.currentProviderId ?? '',
    });

    expect(before).toMatchObject({
      state: 'ready',
      currentProviderId: 'deepseek-provider-id',
      currentCliModel: 'sonnet',
      currentModel: 'deepseek-v4-pro',
      claudeConfigDir: path.resolve(configuredDir),
    });
    expect(after).toMatchObject({
      currentProviderId: before.currentProviderId,
      currentCliModel: before.currentCliModel,
      currentModel: before.currentModel,
      claudeConfigDir: path.resolve(alternateDir),
      routeEnvironment: before.routeEnvironment,
    });
    expect(after.routeFingerprint).not.toBe(before.routeFingerprint);
    expect(afterSessionConfig.routeFingerprint).not.toBe(beforeSessionConfig.routeFingerprint);
    expect(before.routeFingerprint).not.toContain(tempDir);
    expect(after.routeFingerprint).not.toContain(tempDir);
    expect(shouldResumeClaudeSession('session-1', beforeSessionKey, afterSessionKey)).toBe(false);
  });

  test('does not invent an upstream model for an unknown CLI model', () => {
    writeCcSettings();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'glm-4.7',
      env: {
        ANTHROPIC_BASE_URL: CC_SWITCH_BASE_URL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'same-upstream',
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'same-upstream',
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'same-upstream',
      },
    }));

    const result = readCcSwitchCurrentSelection(ccSettingsPath);

    expect(result.currentCliModel).toBe('glm-4.7');
    expect(result.currentModel).toBeNull();
  });

  test('reports a missing device-level settings file as unavailable', () => {
    expect(readCcSwitchCurrentSelection(ccSettingsPath)).toMatchObject({
      currentProviderId: null,
      currentCliModel: null,
      currentModel: null,
      claudeConfigDir: null,
      routeEnvironment: {},
      sourceAvailable: false,
    });
  });

  test('fails generically for malformed, oversized, or credential-bearing routing files', () => {
    fs.writeFileSync(ccSettingsPath, '{"secret":"malformed-sentinel"');
    expect(() => readCcSwitchCurrentSelection(ccSettingsPath))
      .toThrow('CC Switch current configuration could not be read.');

    fs.writeFileSync(ccSettingsPath, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
    expect(() => readCcSwitchCurrentSelection(ccSettingsPath))
      .toThrow('CC Switch current configuration could not be read.');

    writeCcSettings();
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      model: 'sonnet',
      env: {
        ANTHROPIC_BASE_URL: 'http://user:base-url-secret@127.0.0.1:15721',
      },
    }));
    let message = '';
    try {
      readCcSwitchCurrentSelection(ccSettingsPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('CC Switch Claude routing is not using the local proxy.');
    expect(message).not.toContain('base-url-secret');
  });
});

describe('CcSwitchClient', () => {
  test('reads health before status and caches only validated provider metadata', async () => {
    const transport = sequenceTransport(healthy, status());
    const client = new TestCcSwitchClient({ transport, now: () => 123_456 });

    expect(client.getSnapshot()).toEqual({
      state: 'idle',
      currentProvider: null,
      currentProviderId: null,
      currentCliModel: null,
      currentModel: null,
      claudeConfigDir: null,
      routeEnvironment: {},
      routeFingerprint: null,
      selectionSource: null,
      proxyStatusStale: false,
      error: null,
      checkedAt: null,
      baseUrl: CC_SWITCH_BASE_URL,
    });

    const snapshot = await client.refresh();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(1, expect.objectContaining({
      url: `${CC_SWITCH_BASE_URL}/health`,
      method: 'GET',
    }));
    expect(transport).toHaveBeenNthCalledWith(2, expect.objectContaining({
      url: `${CC_SWITCH_BASE_URL}/status`,
      method: 'GET',
    }));
    expect(snapshot).toEqual({
      state: 'ready',
      currentProvider: 'qwen3.8-max',
      currentProviderId: 'provider-id',
      currentCliModel: 'sonnet',
      currentModel: 'qwen3.8-max-preview',
      claudeConfigDir: '/mock-home/.claude',
      routeEnvironment: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
      },
      routeFingerprint: 'route:provider-id',
      selectionSource: 'liveConfig',
      proxyStatusStale: false,
      error: null,
      checkedAt: 123_456,
      baseUrl: CC_SWITCH_BASE_URL,
    });
    expect(client.getCached()).toEqual(snapshot);
  });

  test('reports an offline transport without requesting status or exposing its raw error', async () => {
    const transport = vi.fn<CcSwitchTransport>(async () => {
      throw new Error('secret-bearing transport detail');
    });
    const snapshot = await new TestCcSwitchClient({ transport, now: () => 10 }).refresh();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      state: 'error',
      currentProvider: null,
      currentProviderId: null,
      error: 'CC Switch is offline or unavailable.',
      checkedAt: 10,
    });
    expect(snapshot.error).not.toContain('secret-bearing');
  });

  test('reports non-success HTTP responses as errors', async () => {
    const transport = sequenceTransport({ status: 503, body: '{}' });
    const snapshot = await new TestCcSwitchClient({ transport }).refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch /health returned HTTP 503.');
  });

  test('enforces a total request timeout even when an injected transport never settles', async () => {
    const transport = vi.fn<CcSwitchTransport>(() => new Promise(() => undefined));
    const client = new TestCcSwitchClient({ transport, timeoutMs: 10 });

    const snapshot = await client.refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch /health request timed out.');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });

  test('rejects malformed JSON before using status fields', async () => {
    const transport = sequenceTransport(healthy, { status: 200, body: '{not-json' });
    const snapshot = await new TestCcSwitchClient({ transport }).refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch /status returned malformed JSON.');
  });

  test('rejects an oversized response supplied by an injected transport', async () => {
    const transport = sequenceTransport({
      status: 200,
      body: JSON.stringify({ status: 'healthy', padding: 'x'.repeat(128) }),
    });
    const snapshot = await new TestCcSwitchClient({
      transport,
      maxResponseBytes: 64,
    }).refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch response exceeded the maximum size.');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each(['0.0.0.0', '192.168.1.10', 'localhost', 'example.test'])(
    'rejects a non-loopback reported address: %s',
    async address => {
      const client = new TestCcSwitchClient({
        transport: sequenceTransport(healthy, status({ address })),
      });

      const snapshot = await client.refresh();

      expect(snapshot.state).toBe('error');
      expect(snapshot.error).toBe('CC Switch reported a non-loopback address.');
    },
  );

  test.each([
    { current_provider: 'qwen3.8-max', current_provider_id: ' ' },
    { current_provider: 'qwen3.8-max', current_provider_id: null },
  ])('does not treat missing last-request metadata as the current selection: %j', async override => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status(override)),
    });

    const snapshot = await client.refresh();

    expect(snapshot.state).toBe('ready');
    expect(snapshot.currentProvider).toBeNull();
    expect(snapshot.currentProviderId).toBe('provider-id');
    expect(snapshot.selectionSource).toBe('liveConfig');
  });

  test('fails closed instead of falling back to the last request when live config is unavailable', async () => {
    const snapshot = await new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status()),
      selectionReader: () => selection({
        currentProviderId: null,
        currentCliModel: null,
        currentModel: null,
        claudeConfigDir: null,
        routeEnvironment: {},
        sourceAvailable: false,
        routeFingerprint: 'missing',
      }),
    }).refresh();

    expect(snapshot).toMatchObject({
      state: 'error',
      currentProvider: null,
      currentProviderId: null,
      currentModel: null,
      selectionSource: null,
      error: 'CC Switch current configuration could not be read.',
    });
  });

  test('prefers the stable live CC Switch selection over stale last-request status', async () => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status()),
      selectionReader: () => selection({
        currentProviderId: 'deepseek-provider-id',
        currentCliModel: 'sonnet',
        currentModel: 'deepseek-v4-pro',
        routeEnvironment: {
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
        },
        routeFingerprint: 'deepseek-routes',
      }),
      selectionStabilityDelayMs: 0,
    });

    const snapshot = await client.refresh();

    expect(snapshot).toMatchObject({
      state: 'ready',
      currentProvider: null,
      currentProviderId: 'deepseek-provider-id',
      currentModel: 'deepseek-v4-pro',
      selectionSource: 'liveConfig',
      proxyStatusStale: true,
    });
  });

  test('waits for a stable provider and model route while CC Switch is synchronizing files', async () => {
    const selections = [
      selection({
        currentProviderId: 'deepseek-provider-id',
        currentCliModel: 'sonnet',
        currentModel: 'qwen3.8-max-preview',
        routeEnvironment: {
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
        },
        routeFingerprint: 'old-routes',
      }),
      selection({
        currentProviderId: 'deepseek-provider-id',
        currentCliModel: 'sonnet',
        currentModel: 'deepseek-v4-pro',
        routeEnvironment: {
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
        },
        routeFingerprint: 'new-routes',
      }),
      selection({
        currentProviderId: 'deepseek-provider-id',
        currentCliModel: 'sonnet',
        currentModel: 'deepseek-v4-pro',
        routeEnvironment: {
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
        },
        routeFingerprint: 'new-routes',
      }),
    ];
    const selectionReader = vi.fn(() => selections.shift() ?? selections[0]);
    const snapshot = await new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status()),
      selectionReader,
      selectionStabilityDelayMs: 0,
    }).refresh();

    expect(selectionReader).toHaveBeenCalledTimes(3);
    expect(snapshot.currentProviderId).toBe('deepseek-provider-id');
    expect(snapshot.currentModel).toBe('deepseek-v4-pro');
  });

  test('requires the proxy to report running true', async () => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status({ running: false })),
    });

    const snapshot = await client.refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch proxy is not running.');
  });

  test('requires status to report the fixed proxy port', async () => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status({ port: 9000 })),
    });

    const snapshot = await client.refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.error).toBe('CC Switch reported an unexpected proxy port.');
  });

  test.each([
    { current_provider: 'bad\nname' },
    { current_provider_id: 'x'.repeat(257) },
  ])('rejects unsafe provider metadata: %j', async override => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status(override)),
    });

    const snapshot = await client.refresh();

    expect(snapshot.state).toBe('error');
    expect(snapshot.currentProvider).toBeNull();
    expect(snapshot.currentProviderId).toBeNull();
  });

  test('returns defensive copies of cached state', async () => {
    const client = new TestCcSwitchClient({
      transport: sequenceTransport(healthy, status()),
    });
    const snapshot = await client.refresh();
    snapshot.currentProvider = 'mutated';
    snapshot.routeEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = 'mutated-route';

    expect(client.getSnapshot().currentProvider).toBe('qwen3.8-max');
    expect(client.getSnapshot().routeEnvironment.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME)
      .toBe('qwen3.8-max-preview');
  });

  test('does not let an older slow refresh overwrite a newer result', async () => {
    const firstHealthGate: {
      release?: (response: CcSwitchTransportResponse) => void;
    } = {};
    let call = 0;
    let liveProviderId = 'provider-id';
    const transport = vi.fn<CcSwitchTransport>(async () => {
      call += 1;
      if (call === 1) {
        return new Promise<CcSwitchTransportResponse>(resolve => {
          firstHealthGate.release = resolve;
        });
      }
      if (call === 2) return healthy;
      if (call === 3) {
        liveProviderId = 'new-id';
        return status({ current_provider: 'new', current_provider_id: 'new-id' });
      }
      if (call === 4) {
        liveProviderId = 'old-id';
        return status({ current_provider: 'old', current_provider_id: 'old-id' });
      }
      throw new Error('unexpected request');
    });
    const client = new TestCcSwitchClient({
      transport,
      selectionReader: () => selection({
        currentProviderId: liveProviderId,
        currentModel: `${liveProviderId}-model`,
        routeFingerprint: `route:${liveProviderId}`,
      }),
    });

    const older = client.refresh();
    const newer = client.refresh();
    const newerSnapshot = await newer;
    firstHealthGate.release?.(healthy);
    const olderSnapshot = await older;

    expect(newerSnapshot.currentProviderId).toBe('new-id');
    expect(olderSnapshot.currentProviderId).toBe('old-id');
    expect(client.getSnapshot().currentProviderId).toBe('new-id');
  });
});
