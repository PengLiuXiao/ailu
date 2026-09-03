import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  AGENT_DESCRIPTORS,
  SELECTABLE_AGENT_IDS,
  getAgentDescriptor,
  normalizeSelectableAgentId,
} from '../src/agents';
import { invalidateRuntimeDiscoveryCache, RuntimeDiscovery } from '../src/runtime/discovery';
import {
  buildPiRpcProbeArgs,
  PiRpcClient,
  probePiRpcCapability,
} from '../src/runtime/piRpc';
import {
  canonicalizeStoredAgentSettings,
  normalizeAgentSettings,
} from '../src/settings/agentSettings';

function makeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('Pi Agent roster and settings migration', () => {
  test('exposes Pi as a first-class selectable Agent', () => {
    expect(SELECTABLE_AGENT_IDS).toContain('pi');
    expect(AGENT_DESCRIPTORS.pi.binaryName).toBe('pi');
    expect(AGENT_DESCRIPTORS.pi.supportsProviderProfiles).toBe(false);
    expect(AGENT_DESCRIPTORS.pi.docsUrl).toMatch(/^https:\/\//);
    expect(normalizeSelectableAgentId('pi')).toBe('pi');
    expect(getAgentDescriptor('pi').displayName).toBe('Pi');
  });

  test('normalizes stored settings without Pi keys to safe Pi defaults', () => {
    // Legacy stored settings predate the Pi key, so the inner records are
    // intentionally incomplete at the type level.
    const legacyStored = {
      defaultAgentId: 'claude',
      configSources: { claude: 'localCli', codex: 'localCli' },
      configuredPaths: { claude: '/old/claude', codex: '' },
      fullAccessByAgent: { claude: true, codex: false },
    } as unknown as Parameters<typeof normalizeAgentSettings>[0];
    const normalized = normalizeAgentSettings(legacyStored);
    expect(normalized.configSources.pi).toBe('localCli');
    expect(normalized.configuredPaths.pi).toBe('');
    expect(normalized.providerProfileByAgent.pi).toBe('');
    expect(normalized.localModelByAgent.pi).toBe('');
    expect(normalized.reasoningEffortByAgent.pi).toBe('');
    expect(normalized.fullAccessByAgent.pi).toBe(false);
    // Existing Claude/Codex selections survive untouched.
    expect(normalized.configuredPaths.claude).toBe('/old/claude');
    expect(normalized.fullAccessByAgent.claude).toBe(true);
  });

  test('rejects unsupported Pi config sources back to localCli', () => {
    const normalized = normalizeAgentSettings({
      configSources: { claude: 'localCli', codex: 'localCli', pi: 'providerProfile' },
    });
    expect(normalized.configSources.pi).toBe('localCli');
  });

  test('canonical stored settings persist Pi keys and drop retired fields', () => {
    const normalized = normalizeAgentSettings({ defaultAgentId: 'codex' });
    const canonical = canonicalizeStoredAgentSettings(
      { sharedEnvironmentVariables: { SECRET: 'x' }, defaultAgentId: 'codex' },
      normalized,
    );
    expect(canonical.configSources).toEqual({ claude: 'localCli', codex: 'localCli', pi: 'localCli' });
    expect(canonical.defaultAgentId).toBe('codex');
    expect(canonical.sharedEnvironmentVariables).toBeUndefined();
  });
});

describe('Pi runtime discovery', () => {
  let tempDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-discovery-'));
    previousHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    invalidateRuntimeDiscoveryCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  test('resolves the configured Pi binary and reports its version', () => {
    const configured = path.join(tempDir, 'custom-pi');
    makeExecutable(configured, '#!/bin/sh\nprintf "pi 0.84.4\\n"\n');
    invalidateRuntimeDiscoveryCache();
    const discovery = new RuntimeDiscovery({
      env: { HOME: tempDir, AILU_HOME: tempDir, PATH: '' },
      configuredPaths: { pi: configured },
    });
    const status = discovery.resolve('pi', { withVersion: true });
    expect(status.found).toBe(true);
    expect(status.source).toBe('configured');
    expect(status.version).toBe('pi 0.84.4');
    expect(status.descriptor.id).toBe('pi');
  });

  test('detects the local Pi agent configuration directory', () => {
    const configured = path.join(tempDir, 'custom-pi');
    makeExecutable(configured, '#!/bin/sh\nprintf "pi 0.84.4\\n"\n');
    fs.mkdirSync(path.join(tempDir, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.pi', 'agent', 'settings.json'), '{}');
    invalidateRuntimeDiscoveryCache();
    const discovery = new RuntimeDiscovery({
      env: { HOME: tempDir, AILU_HOME: tempDir, PATH: '' },
      configuredPaths: { pi: configured },
    });
    expect(discovery.resolve('pi').localConfigFound).toBe(true);
  });

  test('reports a missing Pi binary with an actionable error', () => {
    invalidateRuntimeDiscoveryCache();
    const discovery = new RuntimeDiscovery({
      env: { HOME: tempDir, AILU_HOME: path.join(tempDir, 'ailu-home'), PATH: '' },
    });
    const status = discovery.resolve('pi');
    expect(status.found).toBe(false);
    expect(status.state).toBe('missing');
    expect(status.error).toBe('pi was not found.');
  });
});

function writeFakePiServer(executablePath: string, options: { uiRequestsPath?: string } = {}): void {
  const uiCapture = options.uiRequestsPath
    ? `fs.appendFileSync(${JSON.stringify(options.uiRequestsPath)}, line + '\\n');`
    : '';
  makeExecutable(executablePath, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline >= 0) {",
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (!line) continue;",
    `    ${uiCapture}`,
    "    const message = JSON.parse(line);",
    "    if (message.type === 'get_state') {",
    "      process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', model: null, thinkingLevel: 'medium' } }) + '\\n');",
    "    } else if (message.type === 'prompt') {",
    "      process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'prompt', success: true }) + '\\n');",
    "      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');",
    "      process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } }) + '\\n');",
    "      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'AILU_PERMISSION' }) + '\\n');",
    "    } else if (message.type === 'extension_ui_response') {",
    "      process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\\n');",
    "    }",
    "    newline = buffer.indexOf('\\n');",
    "  }",
    "});",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join('\n'));
}

describe('PiRpcClient transport', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-rpc-'));
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('correlates responses by id, streams events, and relays UI requests', async () => {
    const serverPath = path.join(tempDir, 'pi');
    const uiLog = path.join(tempDir, 'ui-requests.log');
    writeFakePiServer(serverPath, { uiRequestsPath: uiLog });

    const client = new PiRpcClient();
    const events: Array<Record<string, unknown>> = [];
    const uiRequests: Array<Record<string, unknown>> = [];
    client.on('piEvent', (event: Record<string, unknown>) => events.push(event));
    client.on('uiRequest', (request: Record<string, unknown>) => uiRequests.push(request));

    await client.connect({ executablePath: serverPath, args: buildPiRpcProbeArgs() });
    expect(client.isReady).toBe(true);

    await client.request({ type: 'prompt', message: 'hello' });
    client.respondUiRequest('ui-1', { value: 'allow-once' });

    await new Promise(resolve => { window.setTimeout(resolve, 150); });
    const uiLines = fs.readFileSync(uiLog, 'utf8').trim().split('\n');
    const response = JSON.parse(uiLines[uiLines.length - 1]) as {
      type: string;
      id: string;
      value?: string;
    };
    expect(response.type).toBe('extension_ui_response');
    expect(response.id).toBe('ui-1');
    expect(response.value).toBe('allow-once');

    expect(events.some(event => event.type === 'agent_start')).toBe(true);
    expect(events.some(event => event.type === 'agent_end')).toBe(true);
    expect(uiRequests).toHaveLength(1);
    expect(uiRequests[0].method).toBe('select');

    await client.disconnect();
    expect(client.isRunning).toBe(false);
  });

  test('reports request failures through rejected promises', async () => {
    const serverPath = path.join(tempDir, 'pi');
    makeExecutable(serverPath, [
      '#!/usr/bin/env node',
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  let newline = buffer.indexOf('\\n');",
      "  while (newline >= 0) {",
      "    const line = buffer.slice(0, newline).trim();",
      "    buffer = buffer.slice(newline + 1);",
      "    if (line) {",
      "      const message = JSON.parse(line);",
      "      if (message.type === 'get_state') {",
      "        process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'get_state', success: true, data: {} }) + '\\n');",
      "      } else if (message.type === 'failing') {",
      "        process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'failing', success: false, error: { message: 'boom' } }) + '\\n');",
      "      }",
      "    }",
      "    newline = buffer.indexOf('\\n');",
      "  }",
      "});",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join('\n'));

    const client = new PiRpcClient();
    await client.connect({ executablePath: serverPath });
    await expect(client.request({ type: 'failing' })).rejects.toThrow('boom');
    await client.disconnect();
  });

  test('splits frames on LF only and tolerates U+2028 inside JSON strings', async () => {
    const serverPath = path.join(tempDir, 'pi');
    makeExecutable(serverPath, [
      '#!/usr/bin/env node',
      "let buffer = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => {",
      "  buffer += chunk;",
      "  let newline = buffer.indexOf('\\n');",
      "  while (newline >= 0) {",
      "    const line = buffer.slice(0, newline).trim();",
      "    buffer = buffer.slice(newline + 1);",
      "    if (line) {",
      "      const message = JSON.parse(line);",
      "      if (message.type === 'get_state') {",
      "        process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'get_state', success: true, data: {} }) + '\\n');",
      "      } else if (message.type === 'u2028') {",
      "        process.stdout.write(JSON.stringify({ id: message.id, type: 'response', command: 'u2028', success: true, data: { text: 'lineand line' } }) + '\\n');",
      "      }",
      "    }",
      "    newline = buffer.indexOf('\\n');",
      "  }",
      "});",
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);",
    ].join('\n'));

    const client = new PiRpcClient();
    await client.connect({ executablePath: serverPath });
    const data = await client.request<{ text: string }>({ type: 'u2028' });
    expect(data.text).toBe('lineand line');
    await client.disconnect();
  });
});

describe('probePiRpcCapability', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-pi-probe-'));
    vi.stubGlobal('window', { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('reports ready when the Pi binary answers a get_state round trip', async () => {
    const serverPath = path.join(tempDir, 'pi');
    writeFakePiServer(serverPath);
    const result = await probePiRpcCapability({ executablePath: serverPath });
    expect(result.state).toBe('ready');
  });

  test('reports unsupported with an upgrade path when the Pi binary rejects RPC flags', async () => {
    const serverPath = path.join(tempDir, 'pi');
    makeExecutable(serverPath, '#!/bin/sh\necho "unknown option --mode" >&2\nexit 1\n');
    const result = await probePiRpcCapability({ executablePath: serverPath });
    expect(result.state).toBe('unsupported');
    expect(result.message).toContain('升级');
  });

  test('reports unavailable when the executable cannot start', async () => {
    const result = await probePiRpcCapability({ executablePath: path.join(tempDir, 'missing-pi') });
    expect(result.state === 'unavailable' || result.state === 'unsupported').toBe(true);
  });
});
