import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  executableSearchPath,
  nvmVersionBinPaths,
  runtimeEnvironment,
} from '../src/utils/env';

describe('runtime environment', () => {
  it('keeps configured PATH entries first and adds common executable folders', () => {
    const configured = path.join(os.tmpdir(), 'ailu-custom-bin');
    const entries = executableSearchPath(configured).split(path.delimiter);

    expect(entries[0]).toBe(configured);
    if (process.platform === 'win32') {
      expect(entries).toContain(path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'npm'));
    } else {
      expect(entries).toContain('/usr/local/bin');
      expect(entries).toContain(path.join(os.homedir(), '.npm-global', 'bin'));
      expect(entries).toContain(path.join(os.homedir(), '.nvm', 'current', 'bin'));
      expect(entries).toContain(path.join(os.homedir(), '.asdf', 'bin'));
      expect(entries).toContain(path.join(os.homedir(), '.asdf', 'shims'));
      expect(entries).toContain(path.join(os.homedir(), '.local', 'share', 'mise', 'shims'));
    }
  });

  it('enriches the inherited PATH without accepting persisted overrides', () => {
    const configured = path.join(os.tmpdir(), 'ailu-inherited-bin');
    const env = runtimeEnvironment({ PATH: configured, AILU_TEST: 'inherited' });
    const entries = env.PATH?.split(path.delimiter) ?? [];

    expect(entries[0]).toBe(configured);
    expect(env.AILU_TEST).toBe('inherited');
  });

  it('puts the resolved CLI directory first so env-node shims can find their sibling Node', () => {
    const configured = path.join(os.tmpdir(), 'ailu-inherited-bin');
    const executable = path.join(os.tmpdir(), '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'claude');
    const env = runtimeEnvironment({ PATH: configured }, executable);
    const entries = env.PATH?.split(path.delimiter) ?? [];

    expect(entries[0]).toBe(path.dirname(executable));
    expect(entries[1]).toBe(configured);
  });

  it('discovers standard nvm version bins newest first', () => {
    const home = path.join(os.tmpdir(), 'ailu-fake-home');
    const entries = nvmVersionBinPaths(home, () => ['v20.19.0', 'v22.14.0', 'not-a-version']);

    expect(entries.slice(0, 2)).toEqual([
      path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'),
      path.join(home, '.nvm', 'versions', 'node', 'v20.19.0', 'bin'),
    ]);
  });
});
