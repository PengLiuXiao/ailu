import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import type { AiluSettings, ChatTurnRequest, RuntimeTurnEvent } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/types';
import { invalidateRuntimeDiscoveryCache } from '../src/runtime/discovery';
import { RuntimeManager } from '../src/runtime/runtimeManager';
import { CodexAppServerRuntime } from '../src/runtime/codexRuntime';
import {
  buildPiTurnArgs,
  composePiPrompt,
  PiRpcRuntime,
  PI_MAX_RUNTIME_EVENT_BYTES,
} from '../src/runtime/piRuntime';
import { freezeVerifiedImageAttachment } from '../src/runtime/frozenAttachments';
import { ProviderStore } from '../src/storage/providerStore';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface FakePiOptions {
  markerPath: string;
  stdinLogPath: string;
  pidPath: string;
  behavior: 'stream' | 'hold' | 'exit' | 'agent-error' | 'oversize' | 'dialog' | 'corrupt' | 'permission';
  /** Emit the Ailu bridge activation notify at startup (default true). */
  bridgeActive?: boolean;
  /** Session id base; each spawn appends its index (pi-session-1, pi-session-2). */
  sessionId?: string;
  /** get_state messageCount; 0 simulates a session Pi had to recreate. */
  messageCount?: number;
  spawnDescendant?: boolean;
}

function writeFakePi(executablePath: string, options: FakePiOptions): void {
  fs.writeFileSync(executablePath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    "let spawnCount = 0;",
    "try { spawnCount = fs.readFileSync(" + JSON.stringify(options.markerPath) + ", 'utf8').trim().split('\\n').filter(Boolean).length; } catch {}",
    "spawnCount += 1;",
    `fs.appendFileSync(${JSON.stringify(options.markerPath)}, JSON.stringify(process.argv) + '\\n');`,
    "    if (" + JSON.stringify(options.behavior) + " === 'corrupt' && process.argv.includes('--session-id')) {",
    "      console.error('failed to parse session file: unexpected token');",
    "      process.exit(1);",
    "    }",
    `fs.writeFileSync(${JSON.stringify(options.pidPath)}, String(process.pid));`,
    options.spawnDescendant
      ? `const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });`
      + `fs.appendFileSync(${JSON.stringify(options.pidPath)}, '\\n' + descendant.pid);`
      : '',
    "const writeEvent = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    `    if (${JSON.stringify(options.bridgeActive !== false)}) {`,
    "      writeEvent({ type: 'extension_ui_request', id: 'bridge-notify-1', method: 'notify', message: 'AILU_BRIDGE_ACTIVE', notifyType: 'info' });",
    "    }",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline >= 0) {",
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (line) {",
    `      fs.appendFileSync(${JSON.stringify(options.stdinLogPath)}, line + '\\n');`,
    "      const message = JSON.parse(line);",
    "      if (message.type === 'get_state') {",
    "        writeEvent({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: '"
      + (options.sessionId ?? 'pi-session') + "-' + spawnCount, messageCount: "
      + String(options.messageCount ?? 3)
      + ", model: { id: 'deepseek-v4-flash', provider: 'deepseek' } } });",
    "      } else if (message.type === 'get_available_models') {",
    "        writeEvent({ id: message.id, type: 'response', command: 'get_available_models', success: true, data: { models: [",
    "          { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', provider: 'deepseek', reasoning: true, input: ['text'], thinkingLevelMap: { minimal: null, low: 'low', high: 'high' } },",
    "          { id: 'flash-vision', name: 'Flash Vision', provider: 'deepseek', reasoning: true, input: ['text', 'image'], thinkingLevelMap: { low: 'low' } },",
    "        ] } });",
    "      } else if (message.type === 'prompt') {",
    "        writeEvent({ id: message.id, type: 'response', command: 'prompt', success: true });",
    `        const behavior = ${JSON.stringify(options.behavior)};`,
    "        if (behavior === 'stream') {",
    "          writeEvent({ type: 'agent_start' });",
    "          writeEvent({ type: 'message_start' });",
    "          writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } });",
    "          writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，Pi' } });",
    "          writeEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好，Pi' }], stopReason: 'stop' } });",
    "          writeEvent({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });",
    "          writeEvent({ type: 'agent_settled' });",
    "        } else if (behavior === 'agent-error') {",
    "          writeEvent({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [{ type: 'text', text: 'provider quota exceeded' }] }] });",
    "          writeEvent({ type: 'agent_settled' });",
    "        } else if (behavior === 'oversize') {",
    "          writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(" + String(PI_MAX_RUNTIME_EVENT_BYTES + 1024) + ") } });",
    "        } else if (behavior === 'permission') {",
    "          writeEvent({ type: 'extension_ui_request', id: 'perm-1', method: 'select', title: 'AILU_PERMISSION::' + JSON.stringify({ tool: 'bash', category: 'bash', detail: 'rm -rf /tmp/x' }), options: ['allow-once', 'allow-turn', 'deny'] });",
    "        } else if (behavior === 'dialog') {",
    "          writeEvent({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Some extension dialog' });",
    "        } else if (behavior === 'exit') {",
    "          process.exit(1);",
    "        } else if (behavior === 'corrupt') {",
    "          writeEvent({ type: 'agent_start' });",
    "          writeEvent({ type: 'message_start' });",
    "          writeEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '重建成功' } });",
    "          writeEvent({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });",
    "          writeEvent({ type: 'agent_settled' });",
    "        }",
    "      } else if (message.type === 'extension_ui_response' && message.id === 'perm-1') {",
    "        writeEvent({ type: 'tool_execution_start', toolCallId: 't-1', toolName: 'bash', args: { command: 'rm -rf /tmp/x' } });",
    "        writeEvent({ type: 'tool_execution_end', toolCallId: 't-1', toolName: 'bash', result: message.value === 'deny' || message.cancelled ? 'blocked by user' : 'done', isError: message.value === 'deny' || message.cancelled === true });",
    "        writeEvent({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop' }] });",
    "        writeEvent({ type: 'agent_settled' });",
    "      } else if (message.type === 'abort') {",
    "        writeEvent({ id: message.id, type: 'response', command: 'abort', success: true });",
    "        writeEvent({ type: 'agent_settled' });",
    "      }",
    "    }",
    "    newline = buffer.indexOf('\\n');",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join('\n'), { mode: 0o755 });
}

function waitForEvent(
  events: RuntimeTurnEvent[],
  type: string,
  timeoutMs = 10_000,
): Promise<RuntimeTurnEvent> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      const found = events.find(event => event.type === type);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`waitForEvent(${type}) timed out`));
        return;
      }
      window.setTimeout(poll, 25);
    };
    poll();
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

function baseRequest(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return {
    conversationId: 'conversation-1',
    agentId: 'pi',
    prompt: 'hello',
    cwd: process.cwd(),
    configSource: 'localCli',
    ...overrides,
  };
}

describe('PiRpcRuntime turn flags', () => {
  test('normal turns use the private session directory and resume by id', () => {
    const args = buildPiTurnArgs(baseRequest({ sessionId: 'stored-session' }), '/ailu-home/pi-sessions');
    expect(args).toEqual(['--session-dir', '/ailu-home/pi-sessions', '--session-id', 'stored-session']);
  });

  test('model and thinking overrides become CLI flags', () => {
    const args = buildPiTurnArgs(
      baseRequest({ model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'high' }),
      '/ailu-home/pi-sessions',
    );
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek/deepseek-v4-flash');
    expect(args).toContain('--thinking');
    expect(args[args.indexOf('--thinking') + 1]).toBe('high');
  });

  test('text-only turns disable sessions, tools, and every discovery source', () => {
    const args = buildPiTurnArgs(baseRequest({ textOnly: true, sessionId: 'ignored' }), '/ailu-home/pi-sessions');
    expect(args).toContain('--no-session');
    expect(args).toContain('--no-tools');
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-skills');
    expect(args).not.toContain('--session-dir');
    expect(args).not.toContain('--session-id');
  });

  test('the system prompt is embedded ahead of the user prompt', () => {
    expect(composePiPrompt(baseRequest({ systemPrompt: 'Be terse.' }))).toBe('Be terse.\n\nhello');
    expect(composePiPrompt(baseRequest())).toBe('hello');
  });
});

describe('PiRpcRuntime turns', () => {
  let tempDir: string;
  let runtime: PiRpcRuntime;

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-runtime-')));
    runtime = new PiRpcRuntime();
  });

  afterEach(async () => {
    await runtime.shutdown().catch(() => undefined);
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function fakePiPaths(behavior: FakePiOptions['behavior'], extra: Partial<FakePiOptions> = {}) {
    const binaryPath = path.join(tempDir, `pi-${behavior}-${Math.random().toString(36).slice(2, 8)}`);
    const options: FakePiOptions = {
      markerPath: path.join(tempDir, `${path.basename(binaryPath)}.argv`),
      stdinLogPath: path.join(tempDir, `${path.basename(binaryPath)}.stdin`),
      pidPath: path.join(tempDir, `${path.basename(binaryPath)}.pid`),
      behavior,
      ...extra,
    };
    writeFakePi(binaryPath, options);
    return { binaryPath, options };
  }

  test('refreshStatus discovers models and the local default without writes', async () => {
    const { binaryPath } = fakePiPaths('stream');
    const before = await runtime.refreshStatus({
      binaryPath,
      binarySource: 'path',
      version: 'pi 0.84.4',
      env: { AILU_HOME: tempDir, PATH: process.env.PATH ?? '' },
    });
    expect(before.state).toBe('ready');
    expect(before.models).toHaveLength(2);
    expect(before.models[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      provider: 'deepseek',
      inputModalities: ['text'],
      thinkingLevels: ['low', 'high'],
    });
    expect(before.models[1].inputModalities).toContain('image');
    expect(before.currentModelId).toBe('deepseek/deepseek-v4-flash');
  });

  test('markUnavailable reports an error status', async () => {
    const status = await runtime.markUnavailable('pi was not found.');
    expect(status.state).toBe('error');
    expect(status.error).toBe('pi was not found.');
    expect(status.models).toEqual([]);
  });

  test('streams a text response and reports the native session', async () => {
    const { binaryPath } = fakePiPaths('stream');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const text = events
      .filter((event): event is { type: 'text'; content: string } => event.type === 'text')
      .map(event => event.content)
      .join('');
    expect(text).toBe('你好，Pi');
    expect(events).toContainEqual({ type: 'session', sessionId: 'pi-session-1' });
    const done = events.find(event => event.type === 'done') as { type: 'done'; sessionId?: string | null };
    expect(done?.sessionId).toBe('pi-session-1');
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  test('passes the stored session id to the resumed process', async () => {
    const { binaryPath, options } = fakePiPaths('stream');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest({ sessionId: 'pi-session-1' }), connectionFor(binaryPath), event => events.push(event));
    const argv = JSON.parse(
      fs.readFileSync(options.markerPath, 'utf8').trim().split('\n')[0],
    ) as string[];
    expect(argv).toContain('--session-id');
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('pi-session-1');
    expect(argv).toContain('--session-dir');
    expect(argv[argv.indexOf('--session-dir') + 1]).toBe(path.join(tempDir, 'pi-sessions'));
  });

  test('restarts on a fresh private session when the stored session is missing', async () => {
    const { binaryPath, options } = fakePiPaths('stream', { messageCount: 0 });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({
        sessionId: 'pi-session-1',
        freshSessionPrompt: 'AILU_HANDOFF: 记住文章标题。\n\n当前回合输入：\n继续写正文。',
        allowFreshSessionFallback: true,
      }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    const spawns = fs.readFileSync(options.markerPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as string[]);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toContain('--session-id');
    expect(spawns[1]).not.toContain('--session-id');
    const diagnostics = events.filter(event => event.type === 'diagnostic') as Array<{ code: string }>;
    expect(diagnostics.some(diagnostic => diagnostic.code === 'pi_session_rebuilt')).toBe(true);
    expect(events).toContainEqual({ type: 'session', sessionId: 'pi-session-2' });
    const done = events.find(event => event.type === 'done') as { sessionId?: string | null };
    expect(done.sessionId).toBe('pi-session-2');
    const promptLine = fs.readFileSync(options.stdinLogPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; message?: string })
      .find(message => message.type === 'prompt');
    expect(promptLine?.message).toContain('AILU_HANDOFF');
  });

  test('continues on the recreated session when no verified fallback is available', async () => {
    const { binaryPath, options } = fakePiPaths('stream', { messageCount: 0 });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({ sessionId: 'pi-session-1' }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    const spawns = fs.readFileSync(options.markerPath, 'utf8').trim().split('\n');
    expect(spawns).toHaveLength(1);
    const diagnostics = events.filter(event => event.type === 'diagnostic') as Array<{ code: string }>;
    expect(diagnostics.some(diagnostic => diagnostic.code === 'pi_session_rebuilt')).toBe(true);
    const done = events.find(event => event.type === 'done') as { sessionId?: string | null };
    expect(done.sessionId).toBe('pi-session-1');
  });

  test('rebuilds instead of failing when the stored session file is corrupt', async () => {
    const { binaryPath } = fakePiPaths('corrupt');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({
        sessionId: 'pi-session-1',
        freshSessionPrompt: 'AILU_HANDOFF: 上下文。\n\n当前回合输入：\n继续。',
        allowFreshSessionFallback: true,
      }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    const diagnostics = events.filter(event => event.type === 'diagnostic') as Array<{ code: string; message: string }>;
    const rebuilt = diagnostics.find(diagnostic => diagnostic.code === 'pi_session_rebuilt');
    expect(rebuilt?.message).toContain('损坏');
    const text = events
      .filter((event): event is { type: 'text'; content: string } => event.type === 'text')
      .map(event => event.content)
      .join('');
    expect(text).toBe('重建成功');
    const done = events.find(event => event.type === 'done') as { sessionId?: string | null };
    expect(done.sessionId).toBe('pi-session-2');
  });

  test('relays a bridge permission prompt and forwards the user decision', async () => {
    const { binaryPath, options } = fakePiPaths('permission');
    const events: RuntimeTurnEvent[] = [];
    const turn = runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const permissionEvent = await new Promise<RuntimeTurnEvent>(resolve => {
      const poll = (): void => {
        const found = events.find(event => event.type === 'permission');
        if (found) resolve(found);
        else window.setTimeout(poll, 25);
      };
      poll();
    });
    if (permissionEvent.type !== 'permission') throw new Error('expected a permission event');
    expect(permissionEvent.permission.toolName).toBe('bash');
    expect(permissionEvent.permission.category).toBe('bash');
    expect(permissionEvent.permission.detail).toBe('rm -rf /tmp/x');
    permissionEvent.permission.respond('allow-turn');
    await turn;
    const responses = fs.readFileSync(options.stdinLogPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', id: 'perm-1', value: 'allow-turn' }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  }, 15_000);

  test('deny and dismissal each settle the prompt deterministically', async () => {
    const denyCase = fakePiPaths('permission');
    const denyEvents: RuntimeTurnEvent[] = [];
    const denyTurn = runtime.runTurn(baseRequest(), connectionFor(denyCase.binaryPath), event => denyEvents.push(event));
    const denyPermission = await waitForEvent(denyEvents, 'permission');
    if (denyPermission.type !== 'permission') throw new Error('expected permission');
    denyPermission.permission.respond('deny');
    await denyTurn;
    const denyResponses = fs.readFileSync(denyCase.options.stdinLogPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(denyResponses).toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', id: 'perm-1', value: 'deny' }),
    );

    const dismissCase = fakePiPaths('permission');
    const dismissEvents: RuntimeTurnEvent[] = [];
    const dismissTurn = runtime.runTurn(baseRequest(), connectionFor(dismissCase.binaryPath), event => dismissEvents.push(event));
    const dismissPermission = await waitForEvent(dismissEvents, 'permission');
    if (dismissPermission.type !== 'permission') throw new Error('expected permission');
    dismissPermission.permission.respond('dismissed');
    await dismissTurn;
    const dismissResponses = fs.readFileSync(dismissCase.options.stdinLogPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(dismissResponses).toContainEqual(
      expect.objectContaining({ type: 'extension_ui_response', id: 'perm-1', cancelled: true }),
    );
  }, 15_000);

  test('fails closed before the prompt when the permission bridge never loads', async () => {
    const { binaryPath, options } = fakePiPaths('stream', { bridgeActive: false });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const error = events.find(event => event.type === 'error') as { diagnostic?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_permission_bridge_missing');
    const stdin = fs.readFileSync(options.stdinLogPath, 'utf8');
    expect(stdin).not.toContain('"prompt"');
  }, 15_000);

  test('stopping a turn aborts only that process tree', async () => {
    const { binaryPath, options } = fakePiPaths('hold', { spawnDescendant: true });
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    const turn = runtime.runTurn(
      baseRequest({ signal: controller.signal }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    await waitFor(() => fs.existsSync(options.stdinLogPath));
    await waitFor(() => fs.readFileSync(options.stdinLogPath, 'utf8').includes('"prompt"'));
    controller.abort();
    await turn;
    expect(events).toContainEqual(expect.objectContaining({ type: 'done' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    const [parentPid, descendantPid] = fs.readFileSync(options.pidPath, 'utf8').trim().split('\n').map(Number);
    await waitFor(() => !processExists(parentPid));
    if (descendantPid) await waitFor(() => !processExists(descendantPid));
  }, 15_000);

  test('an unexpected process exit preserves a retryable error', async () => {
    const { binaryPath } = fakePiPaths('exit');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const error = events.find(event => event.type === 'error') as { diagnostic?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_runtime_unexpected_exit');
    expect(events.some(event => event.type === 'done')).toBe(true);
  });

  test('an incompatible Pi binary fails closed with an upgrade path', async () => {
    const binaryPath = path.join(tempDir, 'pi-old');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "unknown option --mode" >&2\nexit 1\n', { mode: 0o755 });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const error = events.find(event => event.type === 'error') as { diagnostic?: string; message?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_rpc_unsupported');
    expect(error?.message).toContain('升级');
  });

  test('a provider failure inside the agent surfaces as an error event', async () => {
    const { binaryPath } = fakePiPaths('agent-error');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const error = events.find(event => event.type === 'error') as { diagnostic?: string; detail?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_agent_error');
    expect(error?.detail).toContain('provider quota exceeded');
  });

  test('output above the safe byte limit stops the turn', async () => {
    const { binaryPath } = fakePiPaths('oversize');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(baseRequest(), connectionFor(binaryPath), event => events.push(event));
    const error = events.find(event => event.type === 'error') as { diagnostic?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_output_limit_exceeded');
  });

  test('sends a managed frozen image as base64 Pi image content', async () => {
    const { binaryPath, options } = fakePiPaths('stream');
    const vaultDir = path.join(tempDir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const frozen = freezeVerifiedImageAttachment({
      vaultPath: 'shot.png',
      vaultRoot: vaultDir,
      body: png,
      mimeType: 'image/png',
      env: { AILU_HOME: tempDir, PATH: process.env.PATH ?? '' },
    });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({ attachments: [frozen] }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
    const promptLine = fs.readFileSync(options.stdinLogPath, 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as {
        type: string;
        message?: string;
        images?: Array<{ data: string; mimeType: string }>;
      })
      .find(message => message.type === 'prompt');
    expect(promptLine?.images).toHaveLength(1);
    expect(promptLine?.images?.[0].mimeType).toBe('image/png');
    expect(promptLine?.images?.[0].data).toBe(png.toString('base64'));
  });

  test('an unmanaged attachment fails closed before any process spawn', async () => {
    const { binaryPath, options } = fakePiPaths('stream');
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({ attachments: [{ vaultPath: 'a.png', absolutePath: '/tmp/a.png', mimeType: 'image/png' }] }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    const error = events.find(event => event.type === 'error') as { diagnostic?: string; message?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_attachments_invalid');
    expect(error?.message).toContain('附件');
    expect(fs.existsSync(options.markerPath)).toBe(false);
  });

  test('a stale frozen attachment (file deleted) fails closed before spawn', async () => {
    const { binaryPath, options } = fakePiPaths('stream');
    const vaultDir = path.join(tempDir, 'vault-stale');
    fs.mkdirSync(vaultDir, { recursive: true });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const frozen = freezeVerifiedImageAttachment({
      vaultPath: 'shot.png',
      vaultRoot: vaultDir,
      body: png,
      mimeType: 'image/png',
      env: { AILU_HOME: tempDir, PATH: process.env.PATH ?? '' },
    });
    fs.rmSync(frozen.absolutePath, { force: true });
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(
      baseRequest({ attachments: [frozen] }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    const error = events.find(event => event.type === 'error') as { diagnostic?: string } | undefined;
    expect(error?.diagnostic).toBe('pi_attachments_invalid');
    expect(fs.existsSync(options.markerPath)).toBe(false);
  });

  test('extension dialogs the host cannot render are auto-cancelled', async () => {
    const { binaryPath, options } = fakePiPaths('dialog');
    const events: RuntimeTurnEvent[] = [];
    // The dialog blocks the fake server; finish the turn from the test side by
    // aborting once the cancellation response is recorded.
    const controller = new AbortController();
    const turn = runtime.runTurn(
      baseRequest({ signal: controller.signal }),
      connectionFor(binaryPath),
      event => events.push(event),
    );
    await waitFor(() => fs.existsSync(options.stdinLogPath)
      && fs.readFileSync(options.stdinLogPath, 'utf8').includes('extension_ui_response'));
    controller.abort();
    await turn;
    const responses = fs.readFileSync(options.stdinLogPath, 'utf8').trim().split('\n');
    const cancelled = responses.map(line => JSON.parse(line) as Record<string, unknown>)
      .find(message => message.type === 'extension_ui_response');
    expect(cancelled).toMatchObject({ id: 'ui-1', cancelled: true });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'diagnostic',
      code: 'pi_extension_dialog_cancelled',
    }));
  }, 15_000);

  function connectionFor(binaryPath: string) {
    return {
      binaryPath,
      binarySource: null,
      version: null,
      env: { AILU_HOME: tempDir, PATH: process.env.PATH ?? '' },
    };
  }
});

describe('RuntimeManager Pi dispatch', () => {
  let tempDir: string;
  let previousAiluHome: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-manager-')));
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

  function makePiSettings(binaryPath: string): AiluSettings {
    return {
      ...DEFAULT_SETTINGS,
      configSources: { ...DEFAULT_SETTINGS.configSources, pi: 'localCli' },
      configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths, pi: binaryPath },
    };
  }

  test('routes a localCli Pi turn to the Pi runtime with the resolved binary', async () => {
    const binaryPath = path.join(tempDir, 'pi');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "pi 0.84.4"\n');
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const piRunTurn = vi.fn(async (
      _request: ChatTurnRequest,
      _connection: { binaryPath: string },
      _listener: (event: RuntimeTurnEvent) => void,
    ) => undefined);
    const piRuntime = {
      runTurn: piRunTurn,
      cancelAll: async () => undefined,
      shutdown: async () => undefined,
    } as unknown as PiRpcRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => makePiSettings(binaryPath),
      undefined,
      { getStatus: () => ({}) } as unknown as CodexAppServerRuntime,
      piRuntime,
    );
    const events: RuntimeTurnEvent[] = [];
    await manager.runTurn(baseRequest(), event => events.push(event));
    expect(piRunTurn).toHaveBeenCalledTimes(1);
    const [request, connection] = piRunTurn.mock.calls[0];
    expect(request.agentId).toBe('pi');
    expect(connection.binaryPath).toBe(binaryPath);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  test('rejects a Pi turn that requests a provider profile', async () => {
    const binaryPath = path.join(tempDir, 'pi');
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho "pi 0.84.4"\n');
    fs.chmodSync(binaryPath, 0o755);
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const piRunTurn = vi.fn(async (
      _request: ChatTurnRequest,
      _connection: { binaryPath: string },
      _listener: (event: RuntimeTurnEvent) => void,
    ) => undefined);
    const piRuntime = { runTurn: piRunTurn } as unknown as PiRpcRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => makePiSettings(binaryPath),
      undefined,
      { getStatus: () => ({}) } as unknown as CodexAppServerRuntime,
      piRuntime,
    );
    const events: RuntimeTurnEvent[] = [];
    await manager.runTurn(baseRequest({ configSource: 'providerProfile' }), event => events.push(event));
    expect(piRunTurn).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Pi 仅支持本机 Pi 配置。',
    }));
  });

  test('fails a Pi turn with an actionable error when the binary is missing', async () => {
    // Keep the host's real pi off the augmented PATH so "missing" is genuine.
    const previousPath = process.env.PATH;
    const previousHome = process.env.HOME;
    process.env.PATH = '';
    process.env.HOME = tempDir;
    try {
    const providerStore = { find: () => null } as unknown as ProviderStore;
    const piRunTurn = vi.fn(async (
      _request: ChatTurnRequest,
      _connection: { binaryPath: string },
      _listener: (event: RuntimeTurnEvent) => void,
    ) => undefined);
    const piRuntime = {
      runTurn: piRunTurn,
      cancelAll: async () => undefined,
      shutdown: async () => undefined,
    } as unknown as PiRpcRuntime;
    const manager = new RuntimeManager(
      providerStore,
      () => makePiSettings(''),
      undefined,
      { getStatus: () => ({}) } as unknown as CodexAppServerRuntime,
      piRuntime,
    );
    const events: RuntimeTurnEvent[] = [];
    await manager.runTurn(baseRequest(), event => events.push(event));
    expect(piRunTurn).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      message: 'Pi is not installed.',
    }));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      invalidateRuntimeDiscoveryCache();
    }
  });
});
