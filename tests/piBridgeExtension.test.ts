import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

import {
  AILU_BRIDGE_ACTIVE_NOTIFY,
  AILU_PERMISSION_TITLE_PREFIX,
  ensurePiBridgeExtension,
  parseAiluPermissionRequest,
  piBridgeExtensionSource,
} from '../src/runtime/piBridgeExtension';

interface CapturedHandler {
  event: string;
  handler: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;
}

interface FakeUi {
  selectCalls: Array<{ title: string; options: string[] }>;
  notifyCalls: Array<{ message: string; type: string }>;
  nextChoice: string | undefined | Error;
}

function makeCtx(ui: FakeUi): { ui: Record<string, unknown> } {
  return {
    ui: {
      select: async (title: string, options: string[]) => {
        ui.selectCalls.push({ title, options });
        if (ui.nextChoice instanceof Error) throw ui.nextChoice;
        return ui.nextChoice;
      },
      notify: async (message: string, type: string) => {
        ui.notifyCalls.push({ message, type });
      },
    },
  };
}

async function loadBridge(config: { fullAccess?: boolean; planMode?: boolean }): Promise<{
  handlers: Map<string, CapturedHandler['handler']>;
  ui: FakeUi;
}> {
  const source = piBridgeExtensionSource({
    fullAccess: config.fullAccess === true,
    planMode: config.planMode === true,
  });
  const file = path.join(os.tmpdir(), `ailu-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, source, { mode: 0o600 });
  const handlers = new Map<string, CapturedHandler['handler']>();
  const ui: FakeUi = { selectCalls: [], notifyCalls: [], nextChoice: undefined };
  try {
    // The generated bridge is exercised as a real module on purpose.
    // eslint-disable-next-line no-unsanitized/method -- the fixture path is written by this test
    const module_ = (await import(file)) as {
      default: (pi: { on: (name: string, handler: CapturedHandler['handler']) => void }) => void;
    };
    module_.default({
      on: (name: string, handler: CapturedHandler['handler']) => {
        handlers.set(name, handler);
      },
    });
    return { handlers, ui };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

describe('pi permission bridge extension', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('read-only tools pass without prompting', async () => {
    const { handlers, ui } = await loadBridge({});
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const result = await handler({ toolName: 'read', input: { path: '/tmp/a.md' } }, makeCtx(ui));
    expect(result).toBeUndefined();
    expect(ui.selectCalls).toHaveLength(0);
  });

  test('deny blocks the call with a reason Pi can report', async () => {
    const { handlers, ui } = await loadBridge({});
    ui.nextChoice = 'deny';
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const ctx = makeCtx(ui);
    const result = await handler({ toolName: 'bash', input: { command: 'rm -rf /tmp/x' } }, ctx) as { block: boolean; reason: string };
    expect(result.block).toBe(true);
    expect(result.reason).toContain('拒绝');
    expect(ui.selectCalls).toHaveLength(1);
    const title = ui.selectCalls[0].title;
    expect(title.startsWith(AILU_PERMISSION_TITLE_PREFIX)).toBe(true);
    const parsed = parseAiluPermissionRequest(title);
    expect(parsed).toMatchObject({ tool: 'bash', category: 'bash', detail: 'rm -rf /tmp/x' });
    expect(ui.selectCalls[0].options).toEqual(['allow-once', 'allow-turn', 'deny']);
  });

  test('dismissal and select failures deny deterministically', async () => {
    const { handlers, ui } = await loadBridge({});
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const ctx = makeCtx(ui);
    ui.nextChoice = undefined;
    const dismissed = await handler({ toolName: 'write', input: { path: '/tmp/b.md' } }, ctx) as { block: boolean };
    expect(dismissed.block).toBe(true);
    ui.nextChoice = new Error('dialog failed');
    const failed = await handler({ toolName: 'write', input: { path: '/tmp/c.md' } }, ctx) as { block: boolean };
    expect(failed.block).toBe(true);
  });

  test('allow-once prompts again; allow-turn covers the category for the process', async () => {
    const { handlers, ui } = await loadBridge({});
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const ctx = makeCtx(ui);
    ui.nextChoice = 'allow-once';
    expect(await handler({ toolName: 'bash', input: { command: 'ls' } }, ctx)).toBeUndefined();
    ui.nextChoice = 'allow-once';
    expect(await handler({ toolName: 'bash', input: { command: 'pwd' } }, ctx)).toBeUndefined();
    expect(ui.selectCalls).toHaveLength(2);
    ui.nextChoice = 'allow-turn';
    expect(await handler({ toolName: 'bash', input: { command: 'date' } }, ctx)).toBeUndefined();
    expect(await handler({ toolName: 'bash', input: { command: 'whoami' } }, ctx)).toBeUndefined();
    expect(ui.selectCalls).toHaveLength(3);
    // A different category still prompts.
    ui.nextChoice = 'deny';
    const blocked = await handler({ toolName: 'edit', input: { path: '/tmp/d.md' } }, ctx) as { block: boolean };
    expect(blocked.block).toBe(true);
    expect(ui.selectCalls).toHaveLength(4);
  });

  test('unknown and custom tools prompt instead of passing silently', async () => {
    const { handlers, ui } = await loadBridge({});
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const ctx = makeCtx(ui);
    ui.nextChoice = 'deny';
    const result = await handler({ toolName: 'mcp_server_tool', input: { query: 'x' } }, ctx) as { block: boolean };
    expect(result.block).toBe(true);
    const parsed = parseAiluPermissionRequest(ui.selectCalls[0].title);
    expect(parsed?.category).toBe('custom');
  });

  test('full access skips prompts entirely', async () => {
    const { handlers, ui } = await loadBridge({ fullAccess: true });
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    expect(await handler({ toolName: 'bash', input: { command: 'rm -rf /' } }, makeCtx(ui))).toBeUndefined();
    expect(ui.selectCalls).toHaveLength(0);
  });

  test('plan mode blocks mutations without prompting and passes reads', async () => {
    const { handlers, ui } = await loadBridge({ planMode: true });
    const handler = handlers.get('tool_call') as NonNullable<CapturedHandler['handler']>;
    const ctx = makeCtx(ui);
    const blocked = await handler({ toolName: 'write', input: { path: '/tmp/e.md' } }, ctx) as { block: boolean; reason: string };
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain('Plan');
    expect(await handler({ toolName: 'grep', input: { pattern: 'x' } }, ctx)).toBeUndefined();
    expect(ui.selectCalls).toHaveLength(0);
  });

  test('session_start announces the bridge so the runtime can verify loading', async () => {
    const { handlers, ui } = await loadBridge({});
    const handler = handlers.get('session_start') as NonNullable<CapturedHandler['handler']>;
    await handler({ reason: 'startup' }, makeCtx(ui));
    expect(ui.notifyCalls).toContainEqual({
      message: AILU_BRIDGE_ACTIVE_NOTIFY,
      type: 'info',
    });
  });
});

describe('ensurePiBridgeExtension', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-bridge-file-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes a private file keyed by config hash and reuses it', () => {
    const first = ensurePiBridgeExtension({ fullAccess: false, planMode: false }, { AILU_HOME: tempDir, PATH: '' });
    const second = ensurePiBridgeExtension({ fullAccess: false, planMode: false }, { AILU_HOME: tempDir, PATH: '' });
    const fullAccess = ensurePiBridgeExtension({ fullAccess: true, planMode: false }, { AILU_HOME: tempDir, PATH: '' });
    expect(first).toBe(second);
    expect(fullAccess).not.toBe(first);
    expect(fs.statSync(first).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(first, 'utf8')).toContain('fullAccess: false');
    expect(fs.readFileSync(fullAccess, 'utf8')).toContain('fullAccess: true');
  });
});
