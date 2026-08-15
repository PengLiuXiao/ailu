import { type App, TFile } from 'obsidian';

vi.mock('obsidian', () => ({
  App: class {},
  TFile: class {},
  normalizePath: (value: string) => value,
}));

vi.mock('../src/utils/vault', () => ({
  getVaultBasePath: vi.fn(),
  readVerifiedVaultFile: vi.fn(),
}));

import { buildShareSnapshot, MAX_SHARE_NOTE_BYTES } from '../src/share/snapshot';
import { readVerifiedVaultFile } from '../src/utils/vault';

function note(size: number): TFile {
  const file = new TFile();
  file.path = 'articles/large-note.md';
  file.name = 'large-note.md';
  file.basename = 'large-note';
  file.extension = 'md';
  file.parent = null;
  file.stat = { ctime: 0, mtime: 0, size };
  return file;
}

function appWithSource(source: string): { app: App } {
  vi.mocked(readVerifiedVaultFile).mockReset();
  vi.mocked(readVerifiedVaultFile).mockResolvedValue({
    body: Buffer.from(source),
    physicalPath: '/physical-vault/articles/large-note.md',
  });
  const app = {
    vault: {},
    metadataCache: {
      getFileCache: vi.fn(() => null),
      getFirstLinkpathDest: vi.fn(() => null),
    },
  } as unknown as App;
  return { app };
}

describe('share snapshot note budget', () => {
  test('rejects an oversized note from stat before reading it', async () => {
    const fixture = appWithSource('must not be read');

    await expect(buildShareSnapshot(fixture.app, note(MAX_SHARE_NOTE_BYTES + 1)))
      .rejects.toThrow('超过 8 MB');
    expect(readVerifiedVaultFile).not.toHaveBeenCalled();
  });

  test('checks actual UTF-8 bytes after read and never truncates the note', async () => {
    const fixture = appWithSource('stale metadata');
    vi.mocked(readVerifiedVaultFile).mockRejectedValueOnce(new Error('文件为空或超过 8 MB。'));

    await expect(buildShareSnapshot(fixture.app, note(1)))
      .rejects.toThrow('超过 8 MB');
    expect(readVerifiedVaultFile).toHaveBeenCalledWith(
      fixture.app,
      expect.objectContaining({ path: 'articles/large-note.md' }),
      MAX_SHARE_NOTE_BYTES,
      true,
    );
  });
});
