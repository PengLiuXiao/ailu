import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

import {
  AgentAdapter,
  CLAUDE_MAX_RUNTIME_EVENT_BYTES,
  CLAUDE_MAX_STDOUT_FRAME_BYTES,
  CLAUDE_MAX_TURN_OUTPUT_BYTES,
} from '../src/runtime/adapter';
import type { ChatTurnRequest, ProviderProfile, RuntimeTurnEvent } from '../src/types';

const profile: ProviderProfile = {
  id: 'moonshot-profile',
  agentId: 'claude',
  name: 'Moonshot',
  apiKey: 'sk-test',
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

const request: ChatTurnRequest = {
  conversationId: 'conversation-1',
  agentId: 'claude',
  prompt: 'hello',
  cwd: process.cwd(),
  configSource: 'providerProfile',
  providerProfileId: profile.id,
};

describe('AgentAdapter Claude provider failures', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-adapter-')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed on Windows before spawning Claude because tree teardown is unverifiable', async () => {
    const marker = path.join(tempDir, 'windows-claude-started');
    const binaryPath = path.join(tempDir, 'windows-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const adapter = new AgentAdapter({
        agentId: 'claude',
        binaryPath,
        providerProfile: null,
      });
      adapter.onRuntimeEvent(event => events.push(event));

      await adapter.run({ ...request, configSource: 'localCli', providerProfileId: undefined });
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
  });

  test('rejects an unmanaged image path before spawning Claude', async () => {
    const marker = path.join(tempDir, 'unsafe-attachment-started');
    const binaryPath = path.join(tempDir, 'unsafe-attachment-claude');
    const managedHome = path.join(tempDir, 'home');
    fs.mkdirSync(path.join(managedHome, 'frozen-attachments'), { recursive: true, mode: 0o700 });
    fs.chmodSync(managedHome, 0o700);
    fs.chmodSync(path.join(managedHome, 'frozen-attachments'), 0o700);
    vi.stubEnv('AILU_HOME', managedHome);
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
    });
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run({
      ...request,
      configSource: 'localCli',
      providerProfileId: undefined,
      attachments: [{
        vaultPath: 'assets/image.png',
        absolutePath: path.join(tempDir, 'unmanaged.png'),
        mimeType: 'image/png',
        contentSha256: 'a'.repeat(64),
        byteLength: 1,
      }],
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        diagnostic: 'runtime_attachment_isolation_failed',
      }),
      { type: 'done' },
    ]);
  });

  test('ignores retired plaintext shared environment settings at the child-process boundary', async () => {
    const capturedPath = path.join(tempDir, 'captured-environment.txt');
    const binaryPath = path.join(tempDir, 'fake-environment-claude.mjs');
    const legacyEnvironmentKey = `AILU_RETIRED_SHARED_SECRET_${process.pid}_${Date.now()}`;
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(capturedPath)}, process.env[${JSON.stringify(legacyEnvironmentKey)}] ?? 'unset');`,
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\\n');",
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      sharedEnvironmentVariables: `${legacyEnvironmentKey}=must-not-reach-child`,
    } as unknown as ConstructorParameters<typeof AgentAdapter>[0]);

    await adapter.run({
      ...request,
      configSource: 'localCli',
      providerProfileId: undefined,
    });

    expect(fs.readFileSync(capturedPath, 'utf8')).toBe('unset');
  });

  test('emits one structured 429 error and stops a waiting Claude process', async () => {
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      'echo "API Error: Request rejected (429)·您多次使用无效令牌，请等待 120 秒后再试" >&2',
      'echo "(request id: request-123)" >&2',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
    });

    const startedAt = Date.now();
    adapter.onRuntimeEvent(event => events.push(event));
    await adapter.run(request);

    // Full-suite workers can be CPU-starved; this still proves we terminated
    // the fake five-second process instead of waiting for its natural exit.
    expect(Date.now() - startedAt).toBeLessThan(4_500);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      statusCode: 429,
      retryAfterSeconds: 120,
      requestId: 'request-123',
      providerProfileId: profile.id,
    });
  });

  test('terminates an exact-once error on a no-newline stdout frame over the hard limit', async () => {
    const binaryPath = path.join(tempDir, 'fake-oversized-frame-claude.mjs');
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      `process.stdout.write('x'.repeat(${CLAUDE_MAX_STDOUT_FRAME_BYTES + 1}));`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      terminationGraceMs: 100,
    });
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run({ ...request, configSource: 'localCli', providerProfileId: undefined });

    expect(events.filter(event => event.type === 'error')).toEqual([
      expect.objectContaining({ diagnostic: 'claude_output_limit_exceeded' }),
    ]);
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  test('rejects one oversized parsed event before delivering attacker-controlled content', async () => {
    const binaryPath = path.join(tempDir, 'fake-oversized-event-claude.mjs');
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      `process.stdout.write(JSON.stringify({ type: 'text', text: 'x'.repeat(${CLAUDE_MAX_RUNTIME_EVENT_BYTES}) }) + '\\n');`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      terminationGraceMs: 100,
    });
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run({ ...request, configSource: 'localCli', providerProfileId: undefined });

    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'claude_output_limit_exceeded',
    }));
    expect(events.some(event => event.type === 'text')).toBe(false);
  });

  test('bounds a turn made of many individually small stdout frames', async () => {
    const binaryPath = path.join(tempDir, 'fake-many-frame-claude.mjs');
    const lineBytes = 64 * 1_024;
    const lineCount = Math.ceil(CLAUDE_MAX_TURN_OUTPUT_BYTES / lineBytes) + 2;
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      `const line = JSON.stringify({ type: 'text', text: 'x'.repeat(${lineBytes}) }) + '\\n';`,
      `for (let index = 0; index < ${lineCount}; index += 1) process.stdout.write(line);`,
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      terminationGraceMs: 100,
    });
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run({ ...request, configSource: 'localCli', providerProfileId: undefined });

    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ diagnostic: 'claude_output_limit_exceeded' });
  });

  test('cancels a running Claude process without an exit-code error', async () => {
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
    });

    adapter.onRuntimeEvent(event => events.push(event));
    const run = adapter.run(request);
    await delay(50);
    const cancellation = adapter.cancel();
    await Promise.all([run, cancellation]);

    expect(events).toContainEqual({ type: 'done' });
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  test('sends TERM once and keeps cancellation pending until an ignoring descendant is killed', async () => {
    if (process.platform === 'win32') return;
    const readyPath = path.join(tempDir, 'tree-ready');
    const parentTermPath = path.join(tempDir, 'parent-term');
    const descendantTermPath = path.join(tempDir, 'descendant-term');
    const descendantPidPath = path.join(tempDir, 'descendant-pid');
    const binaryPath = path.join(tempDir, 'fake-process-tree-claude.mjs');
    const descendantSource = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
      `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(descendantTermPath)}, 'TERM\\n'));`,
      'setInterval(() => undefined, 1_000);',
    ].join('\n');
    fs.writeFileSync(binaryPath, [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      // The descendant deliberately closes the adapter's stdio pipes. This
      // makes the direct parent emit `close` before the process group is gone,
      // which is the regression that used to cancel the SIGKILL timer.
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
      `process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(parentTermPath)}, 'TERM\\n'); process.exit(0); });`,
      `const readyTimer = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantPidPath)})) { clearInterval(readyTimer); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); } }, 5);`,
      'setInterval(() => undefined, 1_000);',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
      terminationGraceMs: 180,
    });

    let settled = false;
    const run = adapter.run(request).then(() => {
      settled = true;
    });
    await waitForFile(readyPath);
    const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    expect(descendantPid).toBeGreaterThan(0);

    const cancelledAt = Date.now();
    const cancellation = adapter.cancel();
    const repeatedCancellation = adapter.cancel();
    await Promise.all([waitForFile(parentTermPath), waitForFile(descendantTermPath)]);
    await delay(50);
    expect(settled).toBe(false);
    expect(isProcessAlive(descendantPid)).toBe(true);

    await Promise.all([run, cancellation, repeatedCancellation]);
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(140);
    expect(fs.readFileSync(parentTermPath, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.readFileSync(descendantTermPath, 'utf8').trim().split('\n')).toHaveLength(1);
    for (let attempt = 0; attempt < 50 && isProcessAlive(descendantPid); attempt += 1) await delay(10);
    expect(isProcessAlive(descendantPid)).toBe(false);
    expect(settled).toBe(true);
  });

  test.each([
    ['zero', 0, 'ignore'],
    ['non-zero', 7, 'ignore'],
    ['zero with inherited stdio', 0, 'inherit'],
    ['non-zero with inherited stdio', 7, 'inherit'],
  ] as const)(
    'cleans an orphaned process group after a %s parent exit',
    async (_label, exitCode, descendantStdio) => {
      if (process.platform === 'win32') return;
      const fixtureId = `${exitCode}-${descendantStdio}`;
      const readyPath = path.join(tempDir, `orphan-ready-${fixtureId}`);
      const descendantTermPath = path.join(tempDir, `orphan-term-${fixtureId}`);
      const descendantPidPath = path.join(tempDir, `orphan-pid-${fixtureId}`);
      const binaryPath = path.join(tempDir, `fake-orphan-parent-${fixtureId}.mjs`);
      const descendantSource = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(process.pid));`,
        `process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(descendantTermPath)}, 'TERM\\n'));`,
        'setInterval(() => undefined, 1_000);',
      ].join('\n');
      fs.writeFileSync(binaryPath, [
        '#!/usr/bin/env node',
        "import fs from 'node:fs';",
        "import { spawn } from 'node:child_process';",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: '${descendantStdio}' });`,
        `const readyTimer = setInterval(() => { if (fs.existsSync(${JSON.stringify(descendantPidPath)})) { clearInterval(readyTimer); fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready'); process.exit(${exitCode}); } }, 5);`,
      ].join('\n'));
      fs.chmodSync(binaryPath, 0o755);
      const events: RuntimeTurnEvent[] = [];
      const adapter = new AgentAdapter({
        agentId: 'claude',
        binaryPath,
        providerProfile: profile,
        terminationGraceMs: 180,
      });
      adapter.onRuntimeEvent(event => events.push(event));

      let settled = false;
      const run = adapter.run(request).then(() => {
        settled = true;
      });
      await waitForFile(readyPath);
      const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
      try {
        for (let attempt = 0; attempt < 100 && !fs.existsSync(descendantTermPath); attempt += 1) {
          await delay(10);
        }
        const termObserved = fs.existsSync(descendantTermPath);
        await delay(50);
        const settledBeforeEscalation = settled;
        const descendantAliveBeforeEscalation = isProcessAlive(descendantPid);

        await run;
        expect(termObserved).toBe(true);
        expect(settledBeforeEscalation).toBe(false);
        expect(descendantAliveBeforeEscalation).toBe(true);
        expect(fs.readFileSync(descendantTermPath, 'utf8').trim().split('\n')).toHaveLength(1);
        for (let attempt = 0; attempt < 50 && isProcessAlive(descendantPid); attempt += 1) await delay(10);
        expect(isProcessAlive(descendantPid)).toBe(false);
        if (exitCode === 0) {
          expect(events).toContainEqual({ type: 'done' });
          expect(events.some(event => event.type === 'error')).toBe(false);
        } else {
          const error = events.find((event): event is Extract<RuntimeTurnEvent, { type: 'error' }> => (
            event.type === 'error'
          ));
          expect(error?.message).toContain(`exited with code ${exitCode}`);
        }
      } finally {
        if (isProcessAlive(descendantPid)) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // The process may exit between the liveness check and cleanup.
          }
        }
      }
    },
  );

  test('starts context compression without tools, customizations, or session persistence', async () => {
    const argsPath = path.join(tempDir, 'args.json');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
    });

    await adapter.run({
      ...request,
      purpose: 'contextCompression',
      fullAccess: true,
      planMode: true,
      sessionId: 'must-not-resume',
      attachments: [{
        vaultPath: 'secret.png',
        absolutePath: '/tmp/must-not-attach.png',
        mimeType: 'image/png',
      }],
      allowFreshSessionFallback: true,
    });

    const args = fs.readFileSync(argsPath, 'utf8').split('\n');
    expect(args).not.toContain('--safe-mode');
    expect(args).not.toContain('--prompt-suggestions');
    expectClaudeUserSettingsOnly(args);
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--tools');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--effort');
    expect(args).toContain('low');
    expect(args.filter(arg => arg === '--effort')).toHaveLength(1);
    expect(args).toContain('--system-prompt');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('must-not-resume');
    expect(args).not.toContain('/tmp/must-not-attach.png');
  });

  test('bypasses Claude permission prompts only for ordinary full-access turns', async () => {
    const argsPath = path.join(tempDir, 'full-access-args.json');
    const binaryPath = path.join(tempDir, 'fake-full-access-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
    });

    await adapter.run({ ...request, fullAccess: true });
    const fullAccessArgs = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expectClaudeUserSettingsOnly(fullAccessArgs);
    expect(fullAccessArgs).toContain('--dangerously-skip-permissions');
    expect(fullAccessArgs).not.toContain('--permission-mode');

    await adapter.run({ ...request, fullAccess: true, planMode: true });
    const planArgs = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expectClaudeUserSettingsOnly(planArgs);
    expect(planArgs).not.toContain('--dangerously-skip-permissions');
    const permissionModeIndex = planArgs.indexOf('--permission-mode');
    expect(permissionModeIndex).toBeGreaterThanOrEqual(0);
    expect(planArgs[permissionModeIndex + 1]).toBe('plan');

    await adapter.run({
      ...request,
      fullAccess: 'true' as unknown as boolean,
    });
    const malformedArgs = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expect(malformedArgs).not.toContain('--dangerously-skip-permissions');
  });

  test('passes an explicit reasoning effort to local Claude Code', async () => {
    const argsPath = path.join(tempDir, 'local-args.json');
    const binaryPath = path.join(tempDir, 'fake-local-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
    });

    await adapter.run({
      ...request,
      configSource: 'localCli',
      providerProfileId: undefined,
      model: 'opus',
      reasoningEffort: 'max',
      sessionId: 'local-resume-session',
    });

    const args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expectClaudeUserSettingsOnly(args);
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2))
      .toEqual(['--resume', 'local-resume-session']);
    const effortIndex = args.indexOf('--effort');
    expect(effortIndex).toBeGreaterThanOrEqual(0);
    expect(args[effortIndex + 1]).toBe('max');
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe('opus');
  });

  test('limits CC Switch turns to global Claude settings', async () => {
    const argsPath = path.join(tempDir, 'ccswitch-global-args.json');
    const binaryPath = path.join(tempDir, 'fake-ccswitch-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const globalClaudeConfigDir = path.join(tempDir, 'global-claude-config');
    fs.mkdirSync(globalClaudeConfigDir);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      ccSwitchRouteEnvironment: {
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'deepseek-v4-pro',
      },
      ccSwitchClaudeConfigDir: globalClaudeConfigDir,
    });

    await adapter.run({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      model: 'sonnet[1m]',
      reasoningEffort: 'max',
    });

    const args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expectClaudeUserSettingsOnly(args);
    const modelIndex = args.indexOf('--model');
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe('sonnet[1m]');
    const effortIndex = args.indexOf('--effort');
    expect(effortIndex).toBeGreaterThanOrEqual(0);
    expect(args[effortIndex + 1]).toBe('max');
  });

  test.each(['symlink', 'vault'] as const)(
    'fails closed before spawn for a CC Switch %s config directory',
    async invalidKind => {
      const marker = path.join(tempDir, `ccswitch-${invalidKind}-started`);
      const binaryPath = path.join(tempDir, `fake-ccswitch-${invalidKind}-claude`);
      const vaultDir = path.join(tempDir, `vault-${invalidKind}`);
      fs.mkdirSync(vaultDir);
      fs.writeFileSync(binaryPath, [
        '#!/bin/sh',
        `touch ${JSON.stringify(marker)}`,
      ].join('\n'));
      fs.chmodSync(binaryPath, 0o755);

      let claudeConfigDir: string;
      if (invalidKind === 'symlink') {
        const physicalConfigDir = path.join(tempDir, 'physical-ccswitch-config');
        claudeConfigDir = path.join(tempDir, 'linked-ccswitch-config');
        fs.mkdirSync(physicalConfigDir);
        fs.symlinkSync(
          physicalConfigDir,
          claudeConfigDir,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } else {
        claudeConfigDir = path.join(vaultDir, '.claude');
        fs.mkdirSync(claudeConfigDir);
      }

      const events: RuntimeTurnEvent[] = [];
      const adapter = new AgentAdapter({
        agentId: 'claude',
        binaryPath,
        providerProfile: null,
        ccSwitchRouteEnvironment: {},
        ccSwitchClaudeConfigDir: claudeConfigDir,
      });
      adapter.onRuntimeEvent(event => events.push(event));

      await adapter.run({
        ...request,
        cwd: vaultDir,
        configSource: 'ccSwitchCurrent',
        providerProfileId: undefined,
        model: 'sonnet',
      });

      expect(fs.existsSync(marker)).toBe(false);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'error',
          diagnostic: 'claude_config_isolation_failed',
        }),
        { type: 'done' },
      ]);
    },
  );

  test('passes only model-supported effort levels to a known provider profile', async () => {
    const argsPath = path.join(tempDir, 'deepseek-provider-args.json');
    const binaryPath = path.join(tempDir, 'fake-deepseek-provider-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const deepSeekProfile: ProviderProfile = {
      ...profile,
      id: 'deepseek-profile',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-flash',
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash'],
    };
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: deepSeekProfile,
    });

    await adapter.run({
      ...request,
      providerProfileId: deepSeekProfile.id,
      reasoningEffort: 'high',
    });
    let args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);

    await adapter.run({
      ...request,
      providerProfileId: deepSeekProfile.id,
      reasoningEffort: 'medium',
    });
    args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expect(args).not.toContain('--effort');
  });

  test.each([
    ['model', { model: undefined, configDir: path.join(os.tmpdir(), 'ccswitch-global') }],
    ['config directory', { model: 'sonnet', configDir: undefined }],
  ])('does not start CC Switch when the global %s is missing', async (_name, input) => {
    const marker = path.join(tempDir, 'incomplete-ccswitch-started');
    const binaryPath = path.join(tempDir, 'fake-incomplete-ccswitch-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const events: RuntimeTurnEvent[] = [];
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
      ccSwitchRouteEnvironment: {},
      ccSwitchClaudeConfigDir: input.configDir,
    });
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run({
      ...request,
      configSource: 'ccSwitchCurrent',
      providerProfileId: undefined,
      model: input.model,
    });

    expect(fs.existsSync(marker)).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events).toContainEqual({ type: 'done' });
  });

  test('does not force local Claude effort flags onto provider profiles', async () => {
    const argsPath = path.join(tempDir, 'provider-args.json');
    const binaryPath = path.join(tempDir, 'fake-provider-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      'cat >/dev/null',
      'echo \'{"type":"result","subtype":"success","result":"done"}\'',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: profile,
    });

    await adapter.run({ ...request, reasoningEffort: 'high' });

    const args = fs.readFileSync(argsPath, 'utf8').trim().split('\n');
    expectClaudeUserSettingsOnly(args);
    expect(args).not.toContain('--effort');
    const settingsIndex = args.indexOf('--settings');
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(args[settingsIndex + 1]).toMatch(/provider-settings\.json$/);
    expect(args.join(' ')).not.toContain(profile.apiKey);
    expect(args).toContain('--model');
    expect(args).toContain(profile.defaultModel);
  });
});

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !fs.existsSync(filePath)) await delay(10);
  expect(fs.existsSync(filePath)).toBe(true);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function expectClaudeUserSettingsOnly(args: string[]): void {
  const sourcesIndexes = args.flatMap((arg, index) => arg === '--setting-sources' ? [index] : []);
  expect(sourcesIndexes).toHaveLength(1);
  expect(args[sourcesIndexes[0] + 1]).toBe('user');
}
