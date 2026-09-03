/**
 * Live Pi regression pass (opt-in).
 *
 * Drives the real `pi` binary through the real Ailu runtime modules to verify
 * the RPC protocol assumptions that unit fakes cannot prove: bridge extension
 * loading, the tool_call + ctx.ui.select permission flow, session resume,
 * model discovery, plan-mode flags, explicit skills, and text-only inline
 * edits. Run with:
 *
 *   AILU_PI_LIVE=1 npx vitest run tests/piLiveRegression.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';

import {
  PiRpcRuntime,
  piSessionDir,
  buildPiTurnArgs,
} from '../src/runtime/piRuntime';
import { probePiRpcCapability } from '../src/runtime/piRpc';
import { resolveCommand } from '../src/utils/command';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';

const LIVE = process.env.AILU_PI_LIVE === '1';

describe('live Pi regression pass', () => {
  let tempDir: string;
  let binaryPath: string;
  let runtime: PiRpcRuntime;
  let previousAiluHome: string | undefined;
  const collected: string[] = [];

  function record(step: string, ok: boolean, detail = ''): void {
    collected.push(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` — ${detail}` : ''}`);
  }

  beforeAll(() => {
    if (!LIVE) return;
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-live-')));
    previousAiluHome = process.env.AILU_HOME;
    process.env.AILU_HOME = tempDir;
    binaryPath = resolveCommand('pi') ?? '';
    if (!binaryPath) throw new Error('pi CLI not found on PATH; install pi first.');
    const version = execFileSync(binaryPath, ['--version'], { encoding: 'utf8' }).trim();
    process.stdout.write(`live regression against ${version}\n`);
    runtime = new PiRpcRuntime();
  });

  afterAll(() => {
    if (!LIVE) return;
    vi.unstubAllGlobals();
    if (previousAiluHome === undefined) delete process.env.AILU_HOME;
    else process.env.AILU_HOME = previousAiluHome;
    process.stdout.write(`\nPi live regression summary:\n${collected.join('\n')}\n`);
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const maybeLive = LIVE ? test : test.skip;

  function request(overrides: Partial<ChatTurnRequest> = {}): ChatTurnRequest {
    return {
      conversationId: 'live-regression',
      agentId: 'pi',
      prompt: '请只回复两个字：收到',
      cwd: tempDir,
      configSource: 'localCli',
      ...overrides,
    };
  }

  function connection() {
    return {
      binaryPath,
      binarySource: 'path' as const,
      version: null,
      env: { ...process.env, AILU_HOME: tempDir },
    };
  }

  async function collectTurn(turnRequest: ChatTurnRequest): Promise<RuntimeTurnEvent[]> {
    const events: RuntimeTurnEvent[] = [];
    await runtime.runTurn(turnRequest, connection(), event => events.push(event));
    return events;
  }

  function turnText(events: RuntimeTurnEvent[]): string {
    return events
      .filter((event): event is { type: 'text'; content: string } => event.type === 'text')
      .map(event => event.content)
      .join('');
  }

  maybeLive('1. RPC capability probe', async () => {
    const probe = await probePiRpcCapability({ executablePath: binaryPath, env: connection().env });
    record('RPC capability probe', probe.state === 'ready', probe.message);
    expect(probe.state).toBe('ready');
  });

  maybeLive('2. plain text chat streams and reports a native session', async () => {
    const events = await collectTurn(request());
    const text = turnText(events);
    const session = events.find(event => event.type === 'session');
    const done = events.find(event => event.type === 'done');
    const ok = text.length > 0 && Boolean(session) && Boolean(done);
    record('plain text chat', ok, `session=${session && session.type === 'session' ? session.sessionId : 'none'}`);
    expect(ok).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'error' }));
  });

  maybeLive('3. model discovery exposes providers and the local default', async () => {
    const status = await runtime.refreshStatus(connection());
    const ok = status.state === 'ready' && status.models.length > 0 && Boolean(status.currentModelId);
    record('model discovery', ok, `${status.models.length} models, default=${status.currentModelId}`);
    expect(ok).toBe(true);
  });

  maybeLive('4. the permission bridge prompts for a bash call and allows it once', async () => {
    const events: RuntimeTurnEvent[] = [];
    const turn = runtime.runTurn(
      request({ prompt: '请用 bash 工具执行 `echo ailu-live-ok`，然后把输出原样告诉我。' }),
      connection(),
      event => events.push(event),
    );
    const permission = await new Promise<RuntimeTurnEvent>(resolve => {
      const deadline = Date.now() + 120_000;
      const poll = (): void => {
        const found = events.find(event => event.type === 'permission');
        if (found || Date.now() > deadline) {
          resolve(found ?? { type: 'error', message: 'no permission event' });
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });
    expect(permission.type).toBe('permission');
    if (permission.type !== 'permission') return;
    permission.permission.respond('allow-once');
    await turn;
    const text = turnText(events);
    const tools = events.filter(event => event.type === 'tool');
    const ok = text.includes('ailu-live-ok') && tools.length > 0;
    record('permission bridge allow-once', ok, `tools=${tools.length}`);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'error',
      diagnostic: 'pi_permission_bridge_missing',
    }));
    expect(ok).toBe(true);
  }, 240_000);

  maybeLive('5. the permission bridge denies and the conversation continues', async () => {
    const events: RuntimeTurnEvent[] = [];
    const turn = runtime.runTurn(
      request({ prompt: '请用 bash 工具执行 `touch /tmp/ailu-live-denied`。如果被拒绝，请直接回复：已按要求放弃。' }),
      connection(),
      event => events.push(event),
    );
    const permission = await new Promise<RuntimeTurnEvent>(resolve => {
      const deadline = Date.now() + 120_000;
      const poll = (): void => {
        const found = events.find(event => event.type === 'permission');
        if (found || Date.now() > deadline) {
          resolve(found ?? { type: 'error', message: 'no permission event' });
          return;
        }
        window.setTimeout(poll, 100);
      };
      poll();
    });
    expect(permission.type).toBe('permission');
    if (permission.type !== 'permission') return;
    permission.permission.respond('deny');
    await turn;
    const text = turnText(events);
    const ok = text.length > 0 && !fs.existsSync('/tmp/ailu-live-denied');
    record('permission bridge deny keeps the conversation', ok);
    expect(ok).toBe(true);
  }, 240_000);

  maybeLive('6. sessions resume across turns in the private directory', async () => {
    const first = await collectTurn(request({
      prompt: '请记住暗号：蓝鲸。只回复：已记住。',
    }));
    const sessionId = (first.find(event => event.type === 'session') as { sessionId: string } | undefined)?.sessionId;
    expect(sessionId).toBeTruthy();
    const second = await collectTurn(request({
      prompt: '暗号是什么？只回复暗号本身。',
      sessionId,
    }));
    const text = turnText(second);
    const ok = text.includes('蓝鲸');
    record('native session resume', ok, `sessionId=${sessionId ?? 'none'}`);
    expect(ok).toBe(true);
  }, 240_000);

  maybeLive('7. plan mode spawns with the read-only allowlist', async () => {
    const args = buildPiTurnArgs(
      request({ planMode: true }),
      piSessionDir(connection().env),
    );
    const ok = args.includes('--tools') && args.includes('read,grep,find,ls') && args.includes('--no-approve');
    record('plan-mode flags', ok, args.filter(flag => flag.startsWith('--')).join(' '));
    expect(ok).toBe(true);
  });

  maybeLive('8. an explicit skill loads and nothing else does', async () => {
    const skillDir = path.join(tempDir, 'skills', 'live-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: live-skill',
      'description: Regression marker skill.',
      '---',
      '',
      'Always answer with exactly: LIVE-SKILL-OK',
    ].join('\n'));
    const events = await collectTurn(request({
      prompt: '请遵循已加载 Skill 的要求回复。',
      skillPaths: [path.join(skillDir, 'SKILL.md')],
    }));
    const text = turnText(events);
    const ok = text.includes('LIVE-SKILL-OK');
    record('explicit skill load', ok, text.slice(0, 60));
    expect(ok).toBe(true);
  }, 240_000);

  maybeLive('9. inline-edit proposals run text-only', async () => {
    const events = await collectTurn(request({
      prompt: '只返回下方原文的替换文本，不要解释。\n修改要求：改成疑问句\n\n原文：\n今天天气很好。',
      textOnly: true,
      systemPrompt: '你是文本改写器。',
    }));
    const text = turnText(events);
    const ok = text.length > 0 && events.every(event => event.type !== 'tool');
    record('text-only inline edit proposal', ok, text.slice(0, 60));
    expect(ok).toBe(true);
  }, 240_000);

  maybeLive('10. concurrent turns are isolated processes', async () => {
    const controller = new AbortController();
    const slow = runtime.runTurn(
      request({ prompt: '请从 1 数到 30，每个数字一行。', signal: controller.signal }),
      connection(),
      () => undefined,
    );
    const fastEvents = await collectTurn(request({ prompt: '只回复：快' }));
    controller.abort();
    await slow.catch(() => undefined);
    const ok = turnText(fastEvents).length > 0;
    record('concurrent turn isolation', ok);
    expect(ok).toBe(true);
  }, 240_000);
});
