import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

import { invalidateRuntimeDiscoveryCache } from '../src/runtime/discovery';
import { RuntimeManager } from '../src/runtime/runtimeManager';
import type { CodexAppServerRuntime } from '../src/runtime/codexRuntime';
import { CcSwitchClient, type CcSwitchTransport } from '../src/runtime/ccSwitch';
import { resolveClaudeCcSwitchSessionConfig } from '../src/runtime/localModels';
import type { ProviderStore } from '../src/storage/providerStore';
import {
  DEFAULT_SETTINGS,
  type AgentId,
  type ChatTurnRequest,
  type ProviderProfile,
  type RuntimeTurnEvent,
  type AiluSettings,
} from '../src/types';

function makeProfile(apiKey: string): ProviderProfile {
  return {
    id: 'moonshot-profile',
    agentId: 'claude',
    name: 'Moonshot',
    apiKey,
    baseUrl: 'https://api.moonshot.cn/anthropic',
    model: 'kimi-k3',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3'],
    wireApi: 'chat',
    anthropicAuthMode: 'authToken',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSettings(binaryPath: string): AiluSettings {
  return {
    ...DEFAULT_SETTINGS,
    configSources: { ...DEFAULT_SETTINGS.configSources, claude: 'providerProfile' },
    configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths, claude: binaryPath },
    providerProfileByAgent: { ...DEFAULT_SETTINGS.providerProfileByAgent, claude: 'moonshot-profile' },
    localModelByAgent: { ...DEFAULT_SETTINGS.localModelByAgent },
  };
}

function makeCcSwitchSettings(binaryPath: string): AiluSettings {
  return {
    ...DEFAULT_SETTINGS,
    configSources: { ...DEFAULT_SETTINGS.configSources, claude: 'ccSwitchCurrent' },
    configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths, claude: binaryPath },
    providerProfileByAgent: { ...DEFAULT_SETTINGS.providerProfileByAgent },
    localModelByAgent: { ...DEFAULT_SETTINGS.localModelByAgent },
  };
}

function makeLocalSettings(
  agentId: AgentId,
  binaryPath: string,
): AiluSettings {
  return {
    ...DEFAULT_SETTINGS,
    configSources: { ...DEFAULT_SETTINGS.configSources, [agentId]: 'localCli' },
    configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths, [agentId]: binaryPath },
    providerProfileByAgent: { ...DEFAULT_SETTINGS.providerProfileByAgent },
    localModelByAgent: { ...DEFAULT_SETTINGS.localModelByAgent },
  };
}

function ccSwitchClient(
  providerId = 'provider-current',
  routeFingerprint = `route:${providerId}`,
  routedModel = 'qwen3.8-max-preview',
  selectionOptions: {
    currentCliModel?: string | null;
    currentModel?: string | null;
    claudeConfigDir?: string | null;
  } = {},
): CcSwitchClient {
  const currentCliModel = selectionOptions.currentCliModel === undefined
    ? 'sonnet'
    : selectionOptions.currentCliModel;
  const claudeConfigDir = selectionOptions.claudeConfigDir === undefined
    ? '/mock-home/.claude'
    : selectionOptions.claudeConfigDir;
  const transport: CcSwitchTransport = async request => request.url.endsWith('/health')
    ? { status: 200, body: JSON.stringify({ status: 'healthy' }) }
    : {
      status: 200,
      body: JSON.stringify({
        running: true,
        address: '127.0.0.1',
        port: 15721,
        current_provider: 'qwen3.8-max',
        current_provider_id: providerId,
      }),
    };
  return new CcSwitchClient({
    transport,
    selectionReader: () => ({
      currentProviderId: providerId,
      currentCliModel,
      currentModel: selectionOptions.currentModel === undefined
        ? currentCliModel ? routedModel : null
        : selectionOptions.currentModel,
      claudeConfigDir,
      routeEnvironment: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: routedModel,
      },
      sourceAvailable: true,
      routeFingerprint,
    }),
    selectionStabilityDelayMs: 0,
  });
}

const request: ChatTurnRequest = {
  conversationId: 'conversation-1',
  agentId: 'claude',
  prompt: 'Reply with OK.',
  cwd: process.cwd(),
  configSource: 'providerProfile',
  providerProfileId: 'moonshot-profile',
};

describe('RuntimeManager provider safeguards', () => {
  let tempDir: string;
  let previousAiluHome: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-runtime-manager-')));
    previousAiluHome = process.env.AILU_HOME;
    process.env.AILU_HOME = tempDir;
    invalidateRuntimeDiscoveryCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousAiluHome === undefined) delete process.env.AILU_HOME;
    else process.env.AILU_HOME = previousAiluHome;
    invalidateRuntimeDiscoveryCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects an unsupported persisted agent before runtime discovery or spawn', async () => {
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings('/unused/claude'));
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      agentId: 'retired-agent' as AgentId,
    }, event => events.push(event));

    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        diagnostic: 'unsupported_agent_runtime',
      }),
      { type: 'done' },
    ]);
  });

  test.each(['claude', 'codex'] as const)(
    'fails closed before spawning the %s runtime on Windows',
    async agentId => {
      const marker = path.join(tempDir, `windows-${agentId}-started`);
      const binaryPath = path.join(tempDir, `windows-${agentId}`);
      fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      fs.chmodSync(binaryPath, 0o755);
      const providerStore = { find: () => makeProfile('sk-safe') } as unknown as ProviderStore;
      const manager = new RuntimeManager(
        providerStore,
        () => agentId === 'claude' ? makeSettings(binaryPath) : makeLocalSettings('codex', binaryPath),
      );
      const events: RuntimeTurnEvent[] = [];
      const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        await manager.runTurn({
          ...request,
          agentId,
          configSource: agentId === 'claude' ? 'providerProfile' : 'localCli',
          providerProfileId: agentId === 'claude' ? 'moonshot-profile' : undefined,
        }, event => events.push(event));
      } finally {
        platform.mockRestore();
      }

      expect(fs.existsSync(marker)).toBe(false);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'error',
          diagnostic: 'windows_runtime_process_tree_unsupported',
        }),
        { type: 'done' },
      ]);
      await manager.shutdown();
    },
  );

  test('blocks a remote provider with an empty key before Claude starts', async () => {
    const marker = path.join(tempDir, 'started');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn(request, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].message).toContain('API Key 缺失');
      expect(events[0].providerProfileId).toBe(profile.id);
    }
  });

  test('captures a process-local opaque execution fingerprint without exposing provider secrets', () => {
    const binaryPath = path.join(tempDir, 'fingerprint-claude');
    fs.writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-fingerprint-secret');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const first = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const second = new RuntimeManager(providerStore, () => makeSettings(binaryPath));

    const firstStamp = first.captureExecutionFingerprint(request);
    const secondStamp = second.captureExecutionFingerprint(request);

    expect(firstStamp.providerProfileUpdatedAt).toBe(profile.updatedAt);
    expect(firstStamp.executionFingerprint).toMatch(/^v1:/);
    expect(firstStamp.executionFingerprint).not.toContain(profile.apiKey);
    expect(firstStamp.executionFingerprint).not.toBe(secondStamp.executionFingerprint);
  });

  test('fails a queued provider request before spawn when the provider revision changed', async () => {
    const marker = path.join(tempDir, 'provider-drift-started');
    const binaryPath = path.join(tempDir, 'provider-drift-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    let profile = makeProfile('sk-before');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const settings = makeSettings(binaryPath);
    const manager = new RuntimeManager(providerStore, () => settings);
    const stamp = manager.captureExecutionFingerprint(request);
    profile = {
      ...profile,
      apiKey: 'sk-after',
      defaultModel: 'changed-model',
      model: 'changed-model',
      models: ['changed-model'],
      updatedAt: profile.updatedAt + 1,
    };
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...request, ...stamp }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('runs a queued provider request when its opaque execution fingerprint is unchanged', async () => {
    const marker = path.join(tempDir, 'provider-fingerprint-accepted');
    const binaryPath = path.join(tempDir, 'provider-fingerprint-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `touch ${JSON.stringify(marker)}`,
      'cat >/dev/null',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-stable');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const settings = makeSettings(binaryPath);
    const manager = new RuntimeManager(providerStore, () => settings);
    const stamp = manager.captureExecutionFingerprint(request);
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...request, ...stamp }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(true);
    expect(events).toContainEqual({ type: 'text', content: 'OK' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('revokes a queued full-access request when the live permission switch is turned off', async () => {
    const marker = path.join(tempDir, 'revoked-full-access-started');
    const binaryPath = path.join(tempDir, 'revoked-full-access-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-stable');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    let settings: AiluSettings = {
      ...makeSettings(binaryPath),
      fullAccessByAgent: { claude: true, codex: false, pi: false },
    };
    const manager = new RuntimeManager(providerStore, () => settings);
    const queuedRequest: ChatTurnRequest = { ...request, fullAccess: true };
    const stamp = manager.captureExecutionFingerprint(queuedRequest);
    settings = {
      ...settings,
      fullAccessByAgent: { ...settings.fullAccessByAgent, claude: false },
    };
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...queuedRequest, ...stamp }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('never starts an unstamped full-access request when live permission is off', async () => {
    const marker = path.join(tempDir, 'unstamped-full-access-started');
    const binaryPath = path.join(tempDir, 'unstamped-full-access-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-stable');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const settings: AiluSettings = {
      ...makeSettings(binaryPath),
      fullAccessByAgent: { claude: false, codex: false, pi: false },
    };
    const manager = new RuntimeManager(providerStore, () => settings);
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...request, fullAccess: true }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('accepts a Codex resume fingerprint captured with its verified fresh-session fallback', async () => {
    const binaryPath = path.join(tempDir, 'codex-fallback-fingerprint');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "codex-cli 1.0.0"\n');
    fs.chmodSync(binaryPath, 0o755);
    const settings = makeLocalSettings('codex', binaryPath);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const codexRunTurn = vi.fn(async () => undefined);
    const codexRuntime = {
      getStatus: () => ({ currentModelId: null }),
      runTurn: codexRunTurn,
    } as unknown as CodexAppServerRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => settings,
      ccSwitchClient(),
      codexRuntime,
    );
    const queuedRequest: ChatTurnRequest = {
      ...request,
      agentId: 'codex',
      configSource: 'localCli',
      providerProfileId: undefined,
      purpose: 'chat',
      sessionId: 'persisted-thread',
      freshSessionPrompt: 'canonical handoff plus current input',
      allowFreshSessionFallback: true,
    };
    const stamp = manager.captureExecutionFingerprint(queuedRequest);
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...queuedRequest, ...stamp }, event => events.push(event));

    expect(codexRunTurn).toHaveBeenCalledTimes(1);
    expect(events).not.toContainEqual(expect.objectContaining({
      diagnostic: 'runtime_execution_config_changed',
    }));
  });

  test('fails a queued Codex request before App Server run when its binary configuration changed', async () => {
    const firstBinary = path.join(tempDir, 'codex-before');
    const secondBinary = path.join(tempDir, 'codex-after');
    for (const binaryPath of [firstBinary, secondBinary]) {
      fs.writeFileSync(binaryPath, '#!/bin/sh\necho "codex-cli 1.0.0"\n');
      fs.chmodSync(binaryPath, 0o755);
    }
    let settings = makeLocalSettings('codex', firstBinary);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const codexRunTurn = vi.fn(async () => undefined);
    const codexRuntime = {
      getStatus: () => ({ currentModelId: null }),
      runTurn: codexRunTurn,
    } as unknown as CodexAppServerRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => settings,
      ccSwitchClient(),
      codexRuntime,
    );
    const queuedRequest: ChatTurnRequest = {
      ...request,
      agentId: 'codex',
      configSource: 'localCli',
      providerProfileId: undefined,
    };
    const stamp = manager.captureExecutionFingerprint(queuedRequest);
    settings = makeLocalSettings('codex', secondBinary);
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({ ...queuedRequest, ...stamp }, event => events.push(event));

    expect(codexRunTurn).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_execution_config_changed',
    }));
  });

  test('rejects Codex context compression before App Server can expose built-in tools', async () => {
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const codexRunTurn = vi.fn(async () => undefined);
    const codexRuntime = {
      getStatus: () => ({ currentModelId: null }),
      runTurn: codexRunTurn,
    } as unknown as CodexAppServerRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => ({
        ...makeLocalSettings('codex', '/unused/codex'),
        fullAccessByAgent: { claude: false, codex: true, pi: false },
      }),
      ccSwitchClient(),
      codexRuntime,
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      agentId: 'codex',
      configSource: 'localCli',
      providerProfileId: undefined,
      purpose: 'contextCompression',
      sessionId: 'must-not-resume',
      fullAccess: true,
      planMode: true,
      attachments: [{
        vaultPath: 'secret.png',
        absolutePath: '/tmp/must-not-attach.png',
        mimeType: 'image/png',
      }],
    }, event => events.push(event));

    expect(codexRunTurn).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        diagnostic: 'context_compression_local_fallback_required',
      }),
      { type: 'done' },
    ]);
  });

  test('uses the global CC Switch route and CLI model despite Vault overrides', async () => {
    const marker = path.join(tempDir, 'ccswitch-started');
    const argsMarker = path.join(tempDir, 'ccswitch-args');
    const binaryPath = path.join(tempDir, 'fake-claude');
    const vaultDir = path.join(tempDir, 'vault');
    const vaultClaudeDir = path.join(vaultDir, '.claude');
    const globalClaudeDir = path.join(tempDir, 'ccswitch-global-claude');
    fs.mkdirSync(vaultClaudeDir, { recursive: true });
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.writeFileSync(path.join(globalClaudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    fs.writeFileSync(path.join(vaultClaudeDir, 'settings.json'), JSON.stringify({ model: 'glm-4.7' }));
    fs.writeFileSync(path.join(vaultClaudeDir, 'settings.local.json'), JSON.stringify({
      model: 'vault-local-model',
    }));
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s|%s|%s|%s|%s|%s|%s|%s' "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_API_KEY" "$ANTHROPIC_DEFAULT_SONNET_MODEL_NAME" "$CLAUDE_CONFIG_DIR" "$CLAUDE_CODE_USE_BEDROCK" "$CLAUDE_CODE_USE_VERTEX" "$CLAUDE_CODE_USE_FOUNDRY" > ${JSON.stringify(marker)}`,
      `printf '%s\n' "$@" > ${JSON.stringify(argsMarker)}`,
      'cat >/dev/null',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-current', 'route:provider-current', 'qwen3.8-max-preview', {
        claudeConfigDir: globalClaudeDir,
      }),
    );
    const inheritedEnvironmentKeys = [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ] as const;
    const previousEnvironment = new Map(
      inheritedEnvironmentKeys.map(key => [key, process.env[key]]),
    );
    for (const key of inheritedEnvironmentKeys) {
      process.env[key] = `${key.toLowerCase()}-sentinel-must-be-cleared`;
    }
    const events: RuntimeTurnEvent[] = [];
    try {
      await manager.runTurn({
        ...request,
        cwd: vaultDir,
        configSource: 'ccSwitchCurrent',
        providerProfileId: undefined,
        ccSwitchProviderId: 'provider-current',
        ccSwitchRouteFingerprint: 'route:provider-current',
      }, event => events.push(event));
    } finally {
      for (const key of inheritedEnvironmentKeys) {
        const previous = previousEnvironment.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }

    const projected = fs.readFileSync(marker, 'utf8');
    expect(projected).toBe(
      `http://127.0.0.1:15721|ailu-keyless-provider||qwen3.8-max-preview|${globalClaudeDir}|||`,
    );
    expect(projected).not.toContain('sentinel');
    const args = fs.readFileSync(argsMarker, 'utf8').trimEnd().split('\n');
    const modelArgIndex = args.indexOf('--model');
    expect(modelArgIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelArgIndex + 1]).toBe('sonnet');
    const settingSourcesArgIndex = args.indexOf('--setting-sources');
    expect(settingSourcesArgIndex).toBeGreaterThanOrEqual(0);
    expect(args[settingSourcesArgIndex + 1]).toBe('user');
    expect(args).not.toContain('glm-4.7');
    expect(args).not.toContain('vault-local-model');
    expect(events).toContainEqual({ type: 'text', content: 'OK' });
    expect(events).toContainEqual({ type: 'done' });
  });

  test('fails closed without a global CC Switch CLI model and never spawns or resumes Claude', async () => {    const marker = path.join(tempDir, 'ccswitch-missing-model-started');
    const argsMarker = path.join(tempDir, 'ccswitch-missing-model-args');
    const binaryPath = path.join(tempDir, 'fake-claude');
    const globalClaudeDir = path.join(tempDir, 'ccswitch-global-claude');
    fs.mkdirSync(globalClaudeDir, { recursive: true });
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `touch ${JSON.stringify(marker)}`,
      `printf '%s\n' "$@" > ${JSON.stringify(argsMarker)}`,
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const routeFingerprint = 'route:missing-global-model';
    const routeEnvironment = {
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
    };
    const sessionFingerprint = resolveClaudeCcSwitchSessionConfig(
      routeEnvironment,
      null,
      routeFingerprint,
    ).routeFingerprint;
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-current', routeFingerprint, 'deepseek-v4-pro', {
        currentCliModel: null,
        claudeConfigDir: globalClaudeDir,
      }),
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      sessionId: 'session-that-must-not-resume',
      ccSwitchProviderId: 'provider-current',
      ccSwitchRouteFingerprint: routeFingerprint,
      ccSwitchSessionFingerprint: sessionFingerprint,
    }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(argsMarker)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(`${events[0].message}\n${events[0].detail ?? ''}`).toMatch(/model|模型/i);
    }
  });

  test.each([
    ['omitted', {}],
    ['blank', {
      ccSwitchProviderId: ' ',
      ccSwitchRouteFingerprint: '',
      ccSwitchSessionFingerprint: '\t',
    }],
  ])('starts a new session when CC Switch resume fingerprints are %s', async (_name, fingerprints) => {
    const argsMarker = path.join(tempDir, 'ccswitch-resume-args');
    const binaryPath = path.join(tempDir, 'fake-claude');
    const globalClaudeDir = path.join(tempDir, 'ccswitch-resume-global-claude');
    fs.mkdirSync(globalClaudeDir);
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\n' "$@" > ${JSON.stringify(argsMarker)}`,
      'cat >/dev/null',
      'echo \'{"type":"system","subtype":"init","session_id":"fresh-ccswitch-session"}\'',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-current', 'route:provider-current', 'qwen3.8-max-preview', {
        claudeConfigDir: globalClaudeDir,
      }),
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      sessionId: 'session-from-an-unverified-route',
      ...fingerprints,
    }, event => events.push(event));

    const args = fs.readFileSync(argsMarker, 'utf8');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('session-from-an-unverified-route');
    expect(events).toContainEqual({ type: 'session', sessionId: 'fresh-ccswitch-session' });
    expect(events).toContainEqual({ type: 'text', content: 'OK' });
    expect(events).toContainEqual({ type: 'done' });
  });

  test('spawns with family mappings only when no explicit CC Switch CLI model is set', async () => {
    const argsMarker = path.join(tempDir, 'ccswitch-default-family-args');
    const binaryPath = path.join(tempDir, 'fake-claude');
    const globalClaudeDir = path.join(tempDir, 'ccswitch-default-family-claude');
    fs.mkdirSync(globalClaudeDir);
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\n' "$@" > ${JSON.stringify(argsMarker)}`,
      'cat >/dev/null',
      'echo \'{"type":"system","subtype":"init","session_id":"mapping-only-session"}\'',
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-current', 'route:provider-current', 'glm-5.3-flash', {
        currentCliModel: null,
        currentModel: 'glm-5.3-flash',
        claudeConfigDir: globalClaudeDir,
      }),
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
    }, event => events.push(event));

    const args = fs.readFileSync(argsMarker, 'utf8');
    expect(args).not.toContain('--model');
    expect(events).toContainEqual({ type: 'session', sessionId: 'mapping-only-session' });
    expect(events).toContainEqual({ type: 'text', content: 'OK' });
    expect(events).toContainEqual({ type: 'done' });
  });

  test('notifies open views after a shared CC Switch refresh and supports unsubscribe', async () => {
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings('/usr/bin/false'),
      ccSwitchClient(),
    );
    const listener = vi.fn();
    const unsubscribe = manager.onCcSwitchStatusChange(listener);

    const first = await manager.refreshCcSwitchStatus();
    unsubscribe();
    await manager.refreshCcSwitchStatus();

    expect(first.currentModel).toBe('qwen3.8-max-preview');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      state: 'ready',
      currentProviderId: 'provider-current',
    }));
  });

  test('skips repeat notifications until the CC Switch selection actually changes', async () => {
    const selection = {
      providerId: 'provider-current',
      routeFingerprint: 'route:provider-current',
      currentCliModel: 'sonnet',
    };
    const client = new CcSwitchClient({
      transport: async request => request.url.endsWith('/health')
        ? { status: 200, body: JSON.stringify({ status: 'healthy' }) }
        : {
          status: 200,
          body: JSON.stringify({
            running: true,
            address: '127.0.0.1',
            port: 15721,
            current_provider: 'qwen3.8-max',
            current_provider_id: selection.providerId,
          }),
        },
      selectionReader: () => ({
        currentProviderId: selection.providerId,
        currentCliModel: selection.currentCliModel,
        currentModel: 'qwen3.8-max-preview',
        claudeConfigDir: '/mock-home/.claude',
        routeEnvironment: {
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'qwen3.8-max-preview',
        },
        sourceAvailable: true,
        routeFingerprint: selection.routeFingerprint,
      }),
      selectionStabilityDelayMs: 0,
    });
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings('/usr/bin/false'),
      client,
    );
    const listener = vi.fn();
    const unsubscribe = manager.onCcSwitchStatusChange(listener);

    await manager.refreshCcSwitchStatus();
    await manager.refreshCcSwitchStatus();
    expect(listener).toHaveBeenCalledTimes(1);

    selection.currentCliModel = 'opus';
    selection.routeFingerprint = 'route:provider-next';
    await manager.refreshCcSwitchStatus();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      currentCliModel: 'opus',
      routeFingerprint: 'route:provider-next',
    }));
    unsubscribe();
  });

  test('fails closed before spawn when CC Switch changed after the UI preflight', async () => {
    const marker = path.join(tempDir, 'ccswitch-should-not-start');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-new'),
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      ccSwitchProviderId: 'provider-old',
    }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') expect(events[0].message).toContain('已改变');
  });

  test('fails closed before spawn when the same CC Switch provider changed model routes', async () => {
    const marker = path.join(tempDir, 'ccswitch-route-should-not-start');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      ccSwitchClient('provider-current', 'route:new', 'deepseek-v4-pro'),
    );
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      ccSwitchProviderId: 'provider-current',
      ccSwitchRouteFingerprint: 'route:old',
    }, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') expect(events[0].message).toContain('模型路由已改变');
  });

  test('prevents a second request during the provider cooldown', async () => {
    const marker = path.join(tempDir, 'starts');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf 'started\\n' >> ${JSON.stringify(marker)}`,
      'echo "API Error: rate limit exceeded (429); wait 60 seconds" >&2',
      'echo "(request id: request-429)" >&2',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-test');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const firstEvents: RuntimeTurnEvent[] = [];
    const secondEvents: RuntimeTurnEvent[] = [];

    await manager.runTurn(request, event => firstEvents.push(event));
    await manager.runTurn(request, event => secondEvents.push(event));

    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.type).toBe('error');
    if (firstEvents[0]?.type === 'error') {
      expect(firstEvents[0].statusCode).toBe(429);
      expect(firstEvents[0].retryAfterSeconds).toBe(60);
      expect(firstEvents[0].requestId).toBe('request-429');
    }
    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0]?.type).toBe('error');
    if (secondEvents[0]?.type === 'error') {
      expect(secondEvents[0].statusCode).toBe(429);
      expect(secondEvents[0].retryAfterSeconds).toBeGreaterThan(0);
      expect(secondEvents[0].message).toContain('仍在冷却中');
    }
  });

  test('aborts only the runtime turn associated with one signal', async () => {
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      'payload=$(cat)',
      'case "$payload" in',
      '  *SLOW*) exec sleep 5 ;;',
      '  *) sleep 0.2; echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"FAST"}]}}\' ;;',
      'esac',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-test');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const controller = new AbortController();
    const slowEvents: RuntimeTurnEvent[] = [];
    const fastEvents: RuntimeTurnEvent[] = [];

    const slowRun = manager.runTurn({
      ...request,
      conversationId: 'slow-turn',
      prompt: 'SLOW',
      signal: controller.signal,
    }, event => slowEvents.push(event));
    await delay(50);
    const fastRun = manager.runTurn({
      ...request,
      conversationId: 'fast-turn',
      prompt: 'FAST',
    }, event => fastEvents.push(event));
    await delay(50);
    controller.abort();
    await Promise.all([slowRun, fastRun]);

    expect(slowEvents).toContainEqual({ type: 'done' });
    expect(slowEvents.some(event => event.type === 'error')).toBe(false);
    expect(fastEvents).toContainEqual({ type: 'text', content: 'FAST' });
    expect(fastEvents).toContainEqual({ type: 'done' });
  });

  test('shutdown gates a slow CC Switch preflight and never spawns afterward', async () => {
    const marker = path.join(tempDir, 'must-not-spawn-after-shutdown');
    const binaryPath = path.join(tempDir, 'slow-preflight-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);

    let releasePreflight!: () => void;
    const preflightGate = new Promise<void>(resolve => {
      releasePreflight = resolve;
    });
    let markPreflightEntered!: () => void;
    const preflightEntered = new Promise<void>(resolve => {
      markPreflightEntered = resolve;
    });
    let marked = false;
    const transport: CcSwitchTransport = async transportRequest => {
      if (!marked) {
        marked = true;
        markPreflightEntered();
      }
      await preflightGate;
      return transportRequest.url.endsWith('/health')
        ? { status: 200, body: JSON.stringify({ status: 'healthy' }) }
        : {
          status: 200,
          body: JSON.stringify({
            running: true,
            address: '127.0.0.1',
            port: 15721,
            current_provider: 'slow-provider',
            current_provider_id: 'slow-provider',
          }),
        };
    };
    const slowClient = new CcSwitchClient({
      transport,
      selectionReader: () => ({
        currentProviderId: 'slow-provider',
        currentCliModel: 'sonnet',
        currentModel: 'sonnet',
        claudeConfigDir: '/mock-home/.claude',
        routeEnvironment: {},
        sourceAvailable: true,
        routeFingerprint: 'route:slow-provider',
      }),
      selectionStabilityDelayMs: 0,
    });
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const manager = new RuntimeManager(
      providerStore,
      () => makeCcSwitchSettings(binaryPath),
      slowClient,
    );
    const events: RuntimeTurnEvent[] = [];
    const run = manager.runTurn({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
    }, event => events.push(event));

    await preflightEntered;
    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    const duplicateShutdown = manager.shutdown();
    await delay(30);
    expect(shutdownSettled).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);

    releasePreflight();
    await Promise.all([run, shutdown, duplicateShutdown]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toContainEqual({ type: 'done' });

    const afterClose: RuntimeTurnEvent[] = [];
    await manager.runTurn({ ...request, configSource: 'localCli' }, event => afterClose.push(event));
    expect(afterClose).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'runtime_manager_closed',
    }));
    expect(afterClose.at(-1)).toEqual({ type: 'done' });
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('shutdown waits for every CLI child teardown instead of only sending SIGTERM', async () => {
    const readyPath = path.join(tempDir, 'shutdown-ready');
    const termPath = path.join(tempDir, 'shutdown-term');
    const closingPath = path.join(tempDir, 'shutdown-closing');
    const binaryPath = path.join(tempDir, 'fake-shutdown-claude.mjs');
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(termPath)}, 'term'); setTimeout(() => { fs.writeFileSync(${JSON.stringify(closingPath)}, 'closed'); process.exit(0); }, 250); });`,
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      'setInterval(() => undefined, 1_000);',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-test');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const events: RuntimeTurnEvent[] = [];
    const run = manager.runTurn({ ...request, prompt: 'WAIT FOR SHUTDOWN' }, event => events.push(event));

    await waitForFile(readyPath);

    let shutdownSettled = false;
    const shutdown = manager.shutdown().then(() => {
      shutdownSettled = true;
    });
    await waitForFile(termPath);
    await delay(50);
    expect(shutdownSettled).toBe(false);
    expect(fs.existsSync(closingPath)).toBe(false);

    await Promise.all([run, shutdown]);
    expect(fs.existsSync(closingPath)).toBe(true);
    expect(events).toContainEqual({ type: 'done' });
  });

  test('does not deadlock manager cancellation on an unconfirmed Codex stop and retries in shutdown', async () => {
    const binaryPath = path.join(tempDir, 'codex-cancel-retry');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "codex-cli 1.0.0"\n');
    fs.chmodSync(binaryPath, 0o755);
    const settings = makeLocalSettings('codex', binaryPath);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const runEntered = deferred<void>();
    const runRelease = deferred<void>();
    const codexShutdown = vi.fn(async () => {
      runRelease.resolve();
    });
    const codexRuntime = {
      getStatus: () => ({ currentModelId: null }),
      runTurn: vi.fn(async () => {
        runEntered.resolve();
        await runRelease.promise;
      }),
      cancelAll: vi.fn(async () => {
        throw new Error('physical disconnect not confirmed');
      }),
      shutdown: codexShutdown,
    } as unknown as CodexAppServerRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => settings,
      ccSwitchClient(),
      codexRuntime,
    );
    let runSettled = false;
    const run = manager.runTurn({
      ...request,
      agentId: 'codex',
      configSource: 'localCli',
      providerProfileId: undefined,
    }, () => undefined).then(() => {
      runSettled = true;
    });
    await runEntered.promise;

    await expect(manager.cancelAll()).rejects.toThrow('could not confirm every runtime stopped');
    expect(runSettled).toBe(false);

    await Promise.all([manager.shutdown(), run]);
    expect(codexShutdown).toHaveBeenCalledTimes(1);
    expect(runSettled).toBe(true);
  });
});

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !fs.existsSync(filePath)) await delay(10);
  expect(fs.existsSync(filePath)).toBe(true);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}
