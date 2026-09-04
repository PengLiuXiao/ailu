import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCodexAppServerArgs,
  CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES,
  CodexAppServerClient,
  CodexJsonRpcError,
} from '../src/runtime/codexAppServer';

function writeProcessTreeServer(executablePath: string, descendantPidPath: string): void {
  fs.writeFileSync(executablePath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "process.on('SIGTERM', () => {});",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline >= 0) {",
    "    const line = buffer.slice(0, newline);",
    "    buffer = buffer.slice(newline + 1);",
    "    if (line.trim()) {",
    "      const message = JSON.parse(line);",
    "      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');",
    "    }",
    "    newline = buffer.indexOf('\\n');",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join('\n'), { mode: 0o755 });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Codex App Server arguments', () => {
  test('overrides legacy service-tier values with a current CLI value', () => {
    expect(buildCodexAppServerArgs()).toEqual([
      'app-server',
      '-c',
      'service_tier="fast"',
      '--listen',
      'stdio://',
    ]);
  });
});

describe('CodexAppServerClient', () => {
  let tempDir: string;
  let executablePath: string;

  beforeEach(() => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-app-server-'));
    executablePath = path.join(tempDir, 'fake-codex');
    fs.writeFileSync(executablePath, [
      '#!/usr/bin/env node',
      "let buffer = '';",
      'let initialized = false;',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      '  buffer += chunk;',
      "  let newline = buffer.indexOf('\\n');",
      '  while (newline >= 0) {',
      '    const line = buffer.slice(0, newline);',
      '    buffer = buffer.slice(newline + 1);',
      '    if (line.trim()) handle(JSON.parse(line));',
      "    newline = buffer.indexOf('\\n');",
      '  }',
      '});',
      'function send(value, split = false) {',
      "  const text = JSON.stringify(value) + '\\n';",
      '  if (!split) return process.stdout.write(text);',
      '  const middle = Math.floor(text.length / 2);',
      '  process.stdout.write(text.slice(0, middle));',
      '  setTimeout(() => process.stdout.write(text.slice(middle)), 5);',
      '}',
      'function handle(message) {',
      "  if (message.method === 'initialize') {",
      "    const info = message.params && message.params.clientInfo;",
      "    if (!info || info.name !== 'ailu' || info.title !== 'Ailu' || info.version !== '0.3.1') return send({ id: message.id, error: { code: -32001, message: 'wrong client identity' } });",
      "    return send({ id: message.id, result: { ok: true } }, true);",
      "  }",
      "  if (message.method === 'initialized') { initialized = true; return; }",
      "  if (!initialized) return send({ id: message.id, error: { code: -32000, message: 'initialized notification missing' } });",
      "  if (message.method === 'fast') return send({ id: message.id, result: 'fast' });",
      "  if (message.method === 'slow') return setTimeout(() => send({ id: message.id, result: 'slow' }), 20);",
      "  if (message.method === 'malformed') { process.stdout.write('not-json\\n'); return send({ id: message.id, result: 'ok' }); }",
      "  if (message.method === 'rpc-error') return send({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id missing', data: { kind: 'no_rollout' } } });",
      `  if (message.method === 'oversized-no-newline') return process.stdout.write('x'.repeat(${CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES + 1}));`,
      "  if (message.method === 'crash') return process.exit(7);",
      "  if (message.method === 'never') return;",
      '}',
    ].join('\n'), { mode: 0o755 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed on Windows before spawning an App Server process', async () => {
    const marker = path.join(tempDir, 'windows-codex-started');
    fs.writeFileSync(executablePath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    const client = new CodexAppServerClient();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await expect(client.connect({ executablePath })).rejects.toThrow('disabled on Windows');
    } finally {
      platform.mockRestore();
    }

    expect(fs.existsSync(marker)).toBe(false);
    expect(client.isReady).toBe(false);
  });

  test('handshakes over split JSONL and routes out-of-order responses by id', async () => {
    const client = new CodexAppServerClient();
    await client.connect({ executablePath });

    const [slow, fast] = await Promise.all([
      client.request('slow'),
      client.request('fast'),
    ]);

    expect(slow).toBe('slow');
    expect(fast).toBe('fast');
    expect(client.isReady).toBe(true);
    await client.disconnect();
    expect(client.isRunning).toBe(false);
  });

  test('isolates malformed stdout and enforces request timeouts', async () => {
    const client = new CodexAppServerClient();
    const logs: string[] = [];
    client.on('log', (_level: string, message: string) => logs.push(message));
    await client.connect({ executablePath });

    await expect(client.request('malformed')).resolves.toBe('ok');
    await expect(client.request('never', {}, 20)).rejects.toThrow('timed out');
    expect(logs.some(message => message.includes('non-JSON'))).toBe(true);
    await client.disconnect();
  });

  test('rejects pending requests when the process crashes', async () => {
    const client = new CodexAppServerClient();
    await client.connect({ executablePath });

    await expect(client.request('crash')).rejects.toThrow('exited with exit code 7');
    expect(client.isReady).toBe(false);
    await client.connect({ executablePath });
    await expect(client.request('fast')).resolves.toBe('fast');
    await client.disconnect();
  });

  test('preserves JSON-RPC code, data, and request method on failures', async () => {
    const client = new CodexAppServerClient();
    await client.connect({ executablePath });

    let failure: unknown;
    try {
      await client.request('rpc-error');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(CodexJsonRpcError);
    expect(failure).toMatchObject({
      name: 'CodexJsonRpcError',
      method: 'rpc-error',
      code: -32600,
      data: { kind: 'no_rollout' },
      message: 'no rollout found for thread id missing',
    });
    await client.disconnect();
  });

  test('disconnects once when stdout exceeds the JSONL frame bound without a newline', async () => {
    const client = new CodexAppServerClient();
    const closes: string[] = [];
    client.on('close', (reason: string) => closes.push(reason));
    await client.connect({ executablePath });

    await expect(client.request('oversized-no-newline')).rejects.toThrow('stdout frame exceeded');
    await vi.waitFor(() => expect(client.isRunning).toBe(false));

    expect(closes).toHaveLength(1);
    expect(closes[0]).toContain('stdout frame exceeded');
  });

  test('terminates the detached process group and waits for an ignoring descendant to exit', async () => {
    const descendantPidPath = path.join(tempDir, 'descendant.pid');
    writeProcessTreeServer(executablePath, descendantPidPath);
    const client = new CodexAppServerClient({ termGraceMs: 40, killWaitMs: 1_000 });
    await client.connect({ executablePath });
    const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    expect(processExists(descendantPid)).toBe(true);

    await client.disconnect();

    expect(client.isRunning).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
  });

  test('rejects a teardown timeout while the tree is alive and allows a later retry', async () => {
    const descendantPidPath = path.join(tempDir, 'timeout-descendant.pid');
    writeProcessTreeServer(executablePath, descendantPidPath);
    const client = new CodexAppServerClient({ termGraceMs: 40, killWaitMs: 40 });
    await client.connect({ executablePath });
    const descendantPid = Number(fs.readFileSync(descendantPidPath, 'utf8'));
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (typeof pid === 'number' && pid < 0 && signal !== 0) return true;
      return originalKill(pid, signal);
    });

    try {
      await expect(client.disconnect()).rejects.toThrow('did not exit after SIGKILL');
      expect(client.isRunning).toBe(true);
      expect(processExists(descendantPid)).toBe(true);
    } finally {
      killSpy.mockRestore();
      await client.disconnect();
    }
    expect(client.isRunning).toBe(false);
    expect(processExists(descendantPid)).toBe(false);
  });
});
