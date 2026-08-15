import path from 'node:path';

import {
  createAiluProcessWriteLock,
  PythonFcntlProcessWriteLock,
} from '../src/storage/processWriteLock';

describe('Ailu process fence', () => {
  test('creates exactly one canonical Vault writer lock', () => {
    const lock = createAiluProcessWriteLock('/vault');

    expect(lock).toBeInstanceOf(PythonFcntlProcessWriteLock);
    expect(lock.vaultBasePath).toBe('/vault');
    expect(lock.lockPath).toBe(path.join('/vault', '.ailu', 'conversation-writer.lock'));
  });

  test('does not allow callers to override the canonical lock namespace', () => {
    const lock = createAiluProcessWriteLock('/vault', {
      pythonPath: '/usr/bin/python3',
    });

    expect(lock.lockPath).toBe(path.join('/vault', '.ailu', 'conversation-writer.lock'));
  });
});
