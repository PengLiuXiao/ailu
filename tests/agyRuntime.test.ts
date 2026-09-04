import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';
import {
  AgyRuntime,
  buildAgyTurnArgs,
  composeAgyUserMessage,
  parseAgyModelsOutput,
} from '../src/runtime/agyRuntime';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

interface FakeAgyOptions {
  behavior: 'stream' | 'hold' | 'exit' | 'error-result' | 'no-deltas';
  conversationId?: string;
  stdinLogPath?: string;
  cwdLogPath?: string;
}

/** A node script that speaks the observed headless `agy` NDJSON protocol. */
function writeFakeAgy(executablePath: string, options: FakeAgyOptions): void {
  fs.writeFileSync(executablePath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "if (process.argv.includes('models')) {",
    "  console.error('Fetching available models...');",
    "  process.stdout.write('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n');",
    "  process.stdout.write('claude-sonnet-4-6\\tClaude Sonnet 4.6 (Thinking)\\n');",
    "  process.exit(0);",
    '}',
    "const writeEvent = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    `writeEvent({ event: 'init', conversation_id: ${JSON.stringify(options.conversationId ?? 'conv-1')}, init: { cwd: process.cwd(), tools: ['run_command'], permission_mode: 'always-proceed' } });`,
    ...(options.cwdLogPath
      ? [`fs.writeFileSync(${JSON.stringify(options.cwdLogPath)}, process.cwd());`]
      : []),
    "const behavior = " + JSON.stringify(options.behavior) + ';',
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline >= 0) {",
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (!line) continue;",
    ...(options.stdinLogPath
      ? [`    fs.appendFileSync(${JSON.stringify(options.stdinLogPath)}, line + '\\n');`]
      : []),
    "    const message = JSON.parse(line);",
    "    if (behavior === 'stream') {",
    "      writeEvent({ event: 'step_update', step_update: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '你好' } });",
    "      writeEvent({ event: 'step_update', step_update: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: '，Agy' } });",
    "      writeEvent({ event: 'step_update', step_update: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' } } } });",
    "      writeEvent({ event: 'step_update', step_update: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo ok' }, output: 'ok\\n' } } });",
    "      writeEvent({ event: 'step_update', step_update: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\\n' } });",
    "      writeEvent({ event: 'result', result: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', status: 'SUCCESS', response: '你好，Agy\\n', duration_seconds: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } });",
    "      process.exit(0);",
    "    } else if (behavior === 'no-deltas') {",
    "      writeEvent({ event: 'result', result: { conversation_id: '" + (options.conversationId ?? 'conv-1') + "', status: 'SUCCESS', response: '直接回答\\n', duration_seconds: 1, num_turns: 1 } });",
    "      process.exit(0);",
    "    } else if (behavior === 'error-result') {",
    "      writeEvent({ event: 'result', result: { conversation_id: '', status: 'ERROR', response: '', error: 'invalid model selection', duration_seconds: 0, num_turns: 0 } });",
    "      process.exit(1);",
    "    } else if (behavior === 'exit') {",
    "      process.exit(1);",
    "    } else if (behavior === 'hold') {",
    "      process.on('SIGTERM', () => process.exit(0));",
    "      setInterval(() => {}, 1000);",
    "    }",
    "  }",
    "});",
  ].join('\n'));
  fs.chmodSync(executablePath, 0o755);
}

function makeConnection(binaryPath: string) {
  return {
    binaryPath,
    binarySource: 'configured' as const,
    version: '1.1.26',
    env: process.env,
  };
}

function makeRequest(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
  return {
    conversationId: 'c1',
    agentId: 'antigravity',
    prompt: '打招呼',
    cwd: os.tmpdir(),
    configSource: 'localCli',
    ...overrides,
  };
}

async function collectEvents(
  runtime: AgyRuntime,
  request: ChatTurnRequest,
  binaryPath: string,
): Promise<RuntimeTurnEvent[]> {
  const events: RuntimeTurnEvent[] = [];
  await runtime.runTurn(request, makeConnection(binaryPath), event => events.push(event));
  return events;
}

describe('agy build helpers', () => {
  test('builds headless flags with permission skipping always on', () => {
    expect(buildAgyTurnArgs(makeRequest())).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ]);
  });

  test('resumes conversations and pins model and effort', () => {
    expect(buildAgyTurnArgs(makeRequest({
      sessionId: 'conv-9',
      model: 'gemini-3.8-flash-high',
      reasoningEffort: 'low',
    }))).toEqual([
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--conversation', 'conv-9',
      '--model', 'gemini-3.8-flash-high',
      '--effort', 'low',
    ]);
  });

  test('composes a text-only user message with the system prompt folded in', () => {
    const message = JSON.parse(composeAgyUserMessage(makeRequest({
      prompt: '你好',
      systemPrompt: '你是助手',
    }))) as {
      event: string;
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(message.event).toBe('user');
    expect(message.message.content).toEqual([{ type: 'text', text: '你是助手\n\n你好' }]);
  });

  test('parses the models TSV output', () => {
    expect(parseAgyModelsOutput(
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n\nnot-a-model-line\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
    )).toEqual([
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });
});

describe('AgyRuntime', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-runtime-'));
  const binaryPath = path.join(tempRoot, 'agy');

  beforeAll(() => {
    vi.stubGlobal('window', { setTimeout });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('refreshes the model catalog from `agy models`', async () => {
    writeFakeAgy(binaryPath, { behavior: 'stream' });
    const runtime = new AgyRuntime();
    const status = await runtime.refreshStatus(makeConnection(binaryPath));
    expect(status.state).toBe('ready');
    expect(status.models).toEqual([
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  test('streams text deltas, tool events, and the session id', async () => {
    const stdinLog = path.join(tempRoot, 'stdin.log');
    const cwdLog = path.join(tempRoot, 'cwd.log');
    fs.mkdirSync(path.join(tempRoot, 'vault'), { recursive: true });
    writeFakeAgy(binaryPath, { behavior: 'stream', stdinLogPath: stdinLog, cwdLogPath: cwdLog });
    const runtime = new AgyRuntime();
    const events = await collectEvents(runtime, makeRequest({
      cwd: path.join(tempRoot, 'vault'),
      sessionId: 'conv-1',
      model: 'gemini-3.8-flash-high',
    }), binaryPath);
    const texts = events
      .filter(event => event.type === 'text')
      .map(event => (event as { content: string }).content);
    expect(texts).toEqual(['你好', '，Agy', '\n']);
    const tools = events.filter(event => event.type === 'tool');
    expect(tools).toHaveLength(2);
    const started = tools[0];
    if (started.type !== 'tool') throw new Error('expected tool event');
    expect(started.toolCall).toMatchObject({
      name: 'run_command',
      status: 'started',
      input: { CommandLine: 'echo ok' },
    });
    const completed = tools[1];
    if (completed.type !== 'tool') throw new Error('expected tool event');
    expect(completed.toolCall).toMatchObject({
      name: 'run_command',
      status: 'completed',
      output: 'ok\n',
    });
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'conv-1' });
    const stdinLines = fs.readFileSync(stdinLog, 'utf8').trim().split('\n');
    expect(stdinLines).toHaveLength(1);
    const userMessage = JSON.parse(stdinLines[0]) as {
      event: string;
      message: { content: Array<{ type: string; text: string }> };
    };
    expect(userMessage.event).toBe('user');
    expect(userMessage.message.content[0].text).toBe('打招呼');
    expect(fs.realpathSync(fs.readFileSync(cwdLog, 'utf8'))).toBe(fs.realpathSync(path.join(tempRoot, 'vault')));
  });

  test('renders the final response when no deltas were streamed', async () => {
    writeFakeAgy(binaryPath, { behavior: 'no-deltas' });
    const runtime = new AgyRuntime();
    const events = await collectEvents(runtime, makeRequest(), binaryPath);
    const texts = events
      .filter(event => event.type === 'text')
      .map(event => (event as { content: string }).content);
    expect(texts).toEqual(['直接回答\n']);
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'conv-1' });
  });

  test('reports a result error event', async () => {
    writeFakeAgy(binaryPath, { behavior: 'error-result' });
    const runtime = new AgyRuntime();
    const events = await collectEvents(runtime, makeRequest(), binaryPath);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'agy_result_error',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('reports an unexpected exit as an error', async () => {
    writeFakeAgy(binaryPath, { behavior: 'exit' });
    const runtime = new AgyRuntime();
    const events = await collectEvents(runtime, makeRequest(), binaryPath);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'agy_unexpected_exit',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('rejects image attachments before spawning', async () => {
    const runtime = new AgyRuntime();
    const events = await collectEvents(runtime, makeRequest({
      attachments: [{
        vaultPath: 'a.png',
        absolutePath: '/tmp/a.png',
        mimeType: 'image/png',
      }],
    }), binaryPath);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'agy_attachments_unsupported',
    }));
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('abort tears down a held process and settles the turn', async () => {
    writeFakeAgy(binaryPath, { behavior: 'hold' });
    const runtime = new AgyRuntime();
    const controller = new AbortController();
    const events: RuntimeTurnEvent[] = [];
    const run = runtime.runTurn(
      makeRequest({ signal: controller.signal }),
      makeConnection(binaryPath),
      event => events.push(event),
    );
    await sleep(50);
    controller.abort();
    await run;
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
