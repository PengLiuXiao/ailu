import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { executableSearchPath, runtimeEnvironment } from '../src/utils/env';

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
    }
  });

  it('enriches the inherited PATH without accepting persisted overrides', () => {
    const configured = path.join(os.tmpdir(), 'ailu-inherited-bin');
    const env = runtimeEnvironment({ PATH: configured, AILU_TEST: 'inherited' });
    const entries = env.PATH?.split(path.delimiter) ?? [];

    expect(entries[0]).toBe(configured);
    expect(env.AILU_TEST).toBe('inherited');
  });
});
