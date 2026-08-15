import fs from 'fs';
import os from 'os';
import path from 'path';

import { RuntimeDiscovery } from '../src/runtime/discovery';

function makeExecutable(filePath: string, content = '#!/bin/sh\necho test\n'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

describe('RuntimeDiscovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-discovery-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('prefers configured paths', () => {
    const configured = path.join(tempDir, 'custom-claude');
    makeExecutable(configured, '#!/bin/sh\necho claude 1.0\n');
    const discovery = new RuntimeDiscovery({
      env: { AILU_HOME: tempDir, PATH: '' },
      configuredPaths: { claude: configured },
    });
    const status = discovery.resolve('claude');
    expect(status.found).toBe(true);
    expect(status.source).toBe('configured');
    expect(status.binaryPath).toBe(configured);
  });

  test('falls back to managed runtime before PATH', () => {
    const managed = path.join(tempDir, 'runtimes/codex/node_modules/.bin/codex');
    const pathBin = path.join(tempDir, 'bin/codex');
    makeExecutable(managed);
    makeExecutable(pathBin);
    const discovery = new RuntimeDiscovery({
      // Disable desktop-app discovery so the managed fallback is exercised.
      env: { AILU_HOME: tempDir, PATH: path.dirname(pathBin), AILU_CODEX_DESKTOP_ROOTS: '' },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('managed');
    expect(status.binaryPath).toBe(managed);
  });

  test('does not discover a predecessor managed runtime after Ailu cutover', () => {
    const legacyHome = path.join(tempDir, 'legacy-home');
    const canonicalHome = path.join(tempDir, 'canonical-home');
    const legacyManaged = path.join(
      legacyHome,
      'runtimes/claude/node_modules/.bin/claude',
    );
    makeExecutable(legacyManaged);
    const discovery = new RuntimeDiscovery({
      env: {
        AILU_HOME: canonicalHome,
        OTHER_PRODUCT_HOME: legacyHome,
        RETIRED_PRODUCT_HOME: path.join(tempDir, 'older-home'),
        RETIRED_HOME: path.join(tempDir, 'oldest-home'),
        PATH: '',
      },
    });

    const status = discovery.resolve('claude');

    expect(status.source).not.toBe('legacyManaged');
    expect(status.binaryPath).not.toBe(legacyManaged);
    expect(fs.existsSync(path.join(canonicalHome, 'runtimes'))).toBe(false);
  });

  test('prefers the local PATH Codex CLI before the desktop-app CLI', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const bundled = process.platform === 'darwin'
      ? path.join(appRoot, 'Contents/Resources/codex')
      : process.platform === 'win32'
        ? path.join(appRoot, 'resources/codex.exe')
        : path.join(appRoot, 'resources/codex');
    const pathBin = path.join(tempDir, 'bin/codex');
    makeExecutable(bundled);
    makeExecutable(pathBin);
    const discovery = new RuntimeDiscovery({
      env: {
        AILU_HOME: tempDir,
        PATH: path.dirname(pathBin),
        AILU_CODEX_DESKTOP_ROOTS: appRoot,
      },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('path');
    expect(status.binaryPath).toBe(pathBin);
  });

  test('configured path still overrides the desktop-app Codex CLI', () => {
    const appRoot = path.join(tempDir, 'ChatGPT.app');
    const bundled = process.platform === 'darwin'
      ? path.join(appRoot, 'Contents/Resources/codex')
      : process.platform === 'win32'
        ? path.join(appRoot, 'resources/codex.exe')
        : path.join(appRoot, 'resources/codex');
    const configured = path.join(tempDir, 'custom-codex');
    makeExecutable(bundled);
    makeExecutable(configured);
    const discovery = new RuntimeDiscovery({
      env: { AILU_HOME: tempDir, PATH: '', AILU_CODEX_DESKTOP_ROOTS: appRoot },
      configuredPaths: { codex: configured },
    });
    const status = discovery.resolve('codex');
    expect(status.source).toBe('configured');
    expect(status.binaryPath).toBe(configured);
  });

  test('rejects unsupported agents without creating managed runtime directories', () => {
    const discovery = new RuntimeDiscovery({
      env: { AILU_HOME: tempDir, PATH: '' },
    });
    expect(() => discovery.resolve('retired-agent' as never)).toThrow('Unsupported agent runtime.');
    expect(fs.existsSync(path.join(tempDir, 'runtimes'))).toBe(false);
  });
});
