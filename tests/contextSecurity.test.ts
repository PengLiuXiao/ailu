import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  FileSystemAdapter: class FileSystemAdapter {},
  TFile: class TFile {},
}));

import { FileSystemAdapter, TFile, type App } from 'obsidian';

import { resolveMentions } from '../src/utils/context';

function file(vaultPath: string, extension: string): TFile {
  return Object.assign(new TFile(), { path: vaultPath, extension });
}

function localApp(rootPath: string, target: TFile): {
  app: App;
  cachedRead: ReturnType<typeof vi.fn>;
} {
  const adapter = Object.create(FileSystemAdapter.prototype) as FileSystemAdapter;
  Object.assign(adapter, { getBasePath: () => rootPath });
  const cachedRead = vi.fn(async () => 'unsafe-cache-content');
  return {
    app: {
      vault: {
        adapter,
        cachedRead,
        getAbstractFileByPath: vi.fn((vaultPath: string) => (
          vaultPath === target.path ? target : null
        )),
      },
    } as unknown as App,
    cachedRead,
  };
}

describe('chat context physical Vault boundary', () => {
  const ownedDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(ownedDirectories.splice(0).map(directory => (
      fsp.rm(directory, { recursive: true, force: true })
    )));
  });

  test('reads mentioned text through the no-follow physical file instead of Vault cache', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-context-vault-'));
    ownedDirectories.push(vault);
    await fsp.mkdir(path.join(vault, 'notes'));
    await fsp.writeFile(path.join(vault, 'notes', 'safe.md'), 'verified disk content');
    const target = file('notes/safe.md', 'md');
    const fixture = localApp(vault, target);

    const result = await resolveMentions(fixture.app, '@"notes/safe.md"', 1_000);

    expect(result.prompt).toContain('verified disk content');
    expect(result.prompt).not.toContain('unsafe-cache-content');
    expect(result.attachments).toEqual([]);
    expect(fixture.cachedRead).not.toHaveBeenCalled();
  });

  test('freezes verified image bytes outside the Vault before the child attachment boundary', async () => {
    const parent = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-context-vault-')));
    ownedDirectories.push(parent);
    const vault = path.join(parent, 'vault');
    const home = path.join(parent, 'home');
    await fsp.mkdir(vault);
    await fsp.mkdir(path.join(vault, 'assets'));
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const imagePath = path.join(vault, 'assets', 'image.png');
    await fsp.writeFile(imagePath, imageBytes);
    const target = file('assets/image.png', 'png');
    const fixture = localApp(vault, target);
    vi.stubEnv('AILU_HOME', home);

    const result = await resolveMentions(fixture.app, '@"assets/image.png"', 1_000);

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      vaultPath: 'assets/image.png',
      mimeType: 'image/png',
      byteLength: imageBytes.byteLength,
    });
    expect(result.attachments[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    const frozenPath = result.attachments[0]?.absolutePath ?? '';
    expect(frozenPath.startsWith(`${home}${path.sep}`)).toBe(true);
    expect(frozenPath.startsWith(`${vault}${path.sep}`)).toBe(false);
    await expect(fsp.readFile(frozenPath)).resolves.toEqual(imageBytes);
    expect((await fsp.stat(path.dirname(frozenPath))).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(frozenPath)).mode & 0o777).toBe(0o600);

    const outside = path.join(parent, 'outside.png');
    await fsp.writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]));
    await fsp.rename(imagePath, `${imagePath}.replaced`);
    await fsp.symlink(outside, imagePath);
    await expect(fsp.readFile(frozenPath)).resolves.toEqual(imageBytes);
  });

  test('rejects a mentioned symlink without exposing the outside sentinel', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-context-vault-'));
    ownedDirectories.push(parent);
    const vault = path.join(parent, 'vault');
    await fsp.mkdir(vault);
    const sentinel = path.join(parent, 'outside-secret.md');
    await fsp.writeFile(sentinel, 'outside sentinel secret');
    await fsp.symlink(sentinel, path.join(vault, 'linked.md'));
    const target = file('linked.md', 'md');
    const fixture = localApp(vault, target);

    const result = await resolveMentions(fixture.app, '@"linked.md"', 1_000);

    expect(result.prompt).toContain('[Could not read file]');
    expect(result.prompt).not.toContain('outside sentinel secret');
    expect(result.attachments).toEqual([]);
    await expect(fsp.readFile(sentinel, 'utf8')).resolves.toBe('outside sentinel secret');
  });

  test('fails closed for a non-filesystem Vault adapter', async () => {
    const target = file('notes/remote.md', 'md');
    const app = {
      vault: {
        adapter: {},
        getAbstractFileByPath: vi.fn(() => target),
      },
    } as unknown as App;

    const result = await resolveMentions(app, '@"notes/remote.md"', 1_000);

    expect(result.prompt).toContain('[Could not read file]');
    expect(result.attachments).toEqual([]);
  });
});
