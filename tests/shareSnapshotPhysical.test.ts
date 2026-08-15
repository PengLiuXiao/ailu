import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  App: class App {},
  FileSystemAdapter: class FileSystemAdapter {},
  TFile: class TFile {},
  normalizePath: (value: string) => value,
}));

import { FileSystemAdapter, TFile, type App } from 'obsidian';

import { buildShareSnapshot, MAX_SHARE_NOTE_BYTES } from '../src/share/snapshot';

function note(vaultPath: string, size: number): TFile {
  return Object.assign(new TFile(), {
    path: vaultPath,
    name: path.posix.basename(vaultPath),
    basename: path.posix.basename(vaultPath, '.md'),
    extension: 'md',
    parent: null,
    stat: { ctime: 0, mtime: 0, size },
  });
}

function localApp(rootPath: string): App {
  const adapter = Object.create(FileSystemAdapter.prototype) as FileSystemAdapter;
  Object.assign(adapter, { getBasePath: () => rootPath });
  return {
    vault: { adapter },
    metadataCache: {
      getFileCache: vi.fn(() => null),
      getFirstLinkpathDest: vi.fn(() => null),
    },
  } as unknown as App;
}

describe('share snapshot physical source boundary', () => {
  const ownedDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(ownedDirectories.splice(0).map(directory => (
      fsp.rm(directory, { recursive: true, force: true })
    )));
  });

  test('reads the source Markdown from the physical local Vault', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-share-vault-'));
    ownedDirectories.push(vault);
    await fsp.mkdir(path.join(vault, 'articles'));
    const source = '# Verified source\n\nBody';
    await fsp.writeFile(path.join(vault, 'articles', 'safe.md'), source);

    const snapshot = await buildShareSnapshot(
      localApp(vault),
      note('articles/safe.md', Buffer.byteLength(source)),
    );

    expect(snapshot.markdown).toContain('Verified source');
    expect(snapshot.markdown).toContain('Body');
  });

  test('rejects a source-note symlink without exposing or changing the outside sentinel', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-share-vault-'));
    ownedDirectories.push(parent);
    const vault = path.join(parent, 'vault');
    await fsp.mkdir(vault);
    const sentinel = path.join(parent, 'outside-secret.md');
    await fsp.writeFile(sentinel, '# Outside sentinel secret');
    await fsp.symlink(sentinel, path.join(vault, 'linked.md'));

    await expect(buildShareSnapshot(
      localApp(vault),
      note('linked.md', 10),
    )).rejects.toThrow('符号链接');
    await expect(fsp.readFile(sentinel, 'utf8')).resolves.toBe('# Outside sentinel secret');
  });

  test('enforces the descriptor byte limit even when TFile metadata is stale', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-share-vault-'));
    ownedDirectories.push(vault);
    await fsp.writeFile(path.join(vault, 'oversized.md'), Buffer.alloc(MAX_SHARE_NOTE_BYTES + 1));

    await expect(buildShareSnapshot(
      localApp(vault),
      note('oversized.md', 1),
    )).rejects.toThrow('超过 8 MB');
  });
});
