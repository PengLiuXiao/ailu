import { createHash } from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { publishFeishuSnapshot, type FeishuPublishingClient } from '../src/feishu/publisher';
import type { FeishuAssetDraft, FeishuPublishState, FeishuSnapshot } from '../src/feishu/types';

const snapshot: FeishuSnapshot = {
  title: '同步标题',
  markdown: '# 同步标题\n\n正文内容\n',
  contentHash: 'new-content-hash',
  assets: [],
  warnings: [],
  vaultBasePath: '/vault',
};

function remoteXml(body = '正文内容'): string {
  return `<title id="title">同步标题</title><p id="body">${body}</p>`;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function imageRemoteXml(count: number): string {
  return `<title id="title">同步标题</title><p>正文前</p>${'<img />'.repeat(count)}<p>正文后</p>`;
}

async function imageSnapshot(
  vaultBasePath: string,
  count: number,
): Promise<{ snapshot: FeishuSnapshot; originalBytes: Buffer[]; absolutePaths: string[] }> {
  const assets: FeishuAssetDraft[] = [];
  const originalBytes: Buffer[] = [];
  const absolutePaths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = Buffer.from(`confirmed-image-${index}`);
    const fileName = `image-${index}.png`;
    const vaultPath = `images/${fileName}`;
    const absolutePath = path.join(vaultBasePath, vaultPath);
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, bytes);
    originalBytes.push(bytes);
    absolutePaths.push(absolutePath);
    assets.push({
      placeholder: `AILU_FEISHU_IMAGE_${String(index + 1).padStart(4, '0')}_${sha256(bytes).slice(0, 12)}`,
      vaultPath,
      fileName,
      mimeType: 'image/png',
      contentHash: sha256(bytes),
      alt: `图片 ${index + 1}`,
    });
  }
  return {
    snapshot: {
      title: '同步标题',
      markdown: `# 同步标题\n\n正文前\n\n${assets.map(asset => asset.placeholder).join('\n\n')}\n\n正文后\n`,
      contentHash: 'snapshot-with-images',
      assets,
      warnings: [],
      vaultBasePath,
    },
    originalBytes,
    absolutePaths,
  };
}

function createClient(overrides: Partial<FeishuPublishingClient> = {}): FeishuPublishingClient {
  return {
    runPublishingOperation: operation => operation(),
    createDocument: vi.fn(async () => ({
      documentId: 'doxcn-new',
      url: 'https://example.feishu.cn/docx/doxcn-new',
    })),
    updateDocument: vi.fn(async () => undefined),
    insertAssets: vi.fn(async () => undefined),
    fetchDocumentContent: vi.fn(async () => remoteXml()),
    ...overrides,
  };
}

describe('Feishu publisher transaction', () => {
  const ownedFixtureDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(ownedFixtureDirectories.splice(0).map(directory => (
      fsp.rm(directory, { recursive: true, force: true })
    )));
  });

  async function createFixtureVault(): Promise<string> {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-feishu-publisher-test-'));
    ownedFixtureDirectories.push(directory);
    return directory;
  }

  test('marks an existing association pending before overwrite and finalizes after verification', async () => {
    const order: string[] = [];
    const persisted: FeishuPublishState[] = [];
    const cli = createClient({
      updateDocument: vi.fn(async () => { order.push('update'); }),
    });
    const existing: FeishuPublishState = {
      documentId: 'doxcn-existing',
      url: 'https://example.feishu.cn/docx/doxcn-existing',
      contentHash: 'old-content-hash',
      updatedAt: 'old-time',
      title: '同步标题',
    };

    const result = await publishFeishuSnapshot({
      cli,
      snapshot,
      existing,
      now: () => '2026-08-06T12:00:00.000Z',
      persistState: async (state) => {
        order.push(`persist:${state.contentHash || 'pending'}`);
        persisted.push({ ...state });
      },
    });

    expect(order).toEqual(['persist:pending', 'update', 'persist:new-content-hash']);
    expect(persisted[0]).toMatchObject({
      documentId: existing.documentId,
      contentHash: '',
    });
    expect(result.contentHash).toBe(snapshot.contentHash);
  });

  test('revalidates an existing source after persisting pending and before remote overwrite', async () => {
    const hookCalls: string[] = [];
    const updateDocument = vi.fn(async () => undefined);
    const existing: FeishuPublishState = {
      documentId: 'doxcn-existing',
      url: 'https://example.feishu.cn/docx/doxcn-existing',
      contentHash: 'old-content-hash',
      updatedAt: 'old-time',
      title: snapshot.title,
    };
    let sourceChanged = false;

    await expect(publishFeishuSnapshot({
      cli: createClient({ updateDocument }),
      snapshot,
      existing,
      persistState: async (state) => {
        if (!state.contentHash) sourceChanged = true;
      },
      beforeRemoteWrite: async () => {
        hookCalls.push(sourceChanged ? 'after-pending' : 'before-pending');
        if (sourceChanged) throw new Error('笔记在等待持久化期间发生了变化');
      },
    })).rejects.toThrow('笔记在等待持久化期间发生了变化');

    expect(hookCalls).toEqual(['before-pending', 'after-pending']);
    expect(updateDocument).not.toHaveBeenCalled();
  });

  test('keeps an existing association pending when overwrite succeeds but a later step fails', async () => {
    const persisted: FeishuPublishState[] = [];
    const cli = createClient({
      insertAssets: vi.fn(async () => {
        throw new Error('image upload failed');
      }),
    });

    await expect(publishFeishuSnapshot({
      cli,
      snapshot,
      existing: {
        documentId: 'doxcn-existing',
        url: 'https://example.feishu.cn/docx/doxcn-existing',
        contentHash: snapshot.contentHash,
        updatedAt: 'old-time',
        title: snapshot.title,
      },
      persistState: async state => { persisted.push({ ...state }); },
    })).rejects.toThrow('image upload failed');

    expect(persisted).toHaveLength(1);
    expect(persisted[0].contentHash).toBe('');
  });

  test('preserves a newly created document association when verification fails', async () => {
    const persisted: FeishuPublishState[] = [];
    const cli = createClient({
      fetchDocumentContent: vi.fn(async () => remoteXml('旧正文')),
    });

    await expect(publishFeishuSnapshot({
      cli,
      snapshot,
      existing: null,
      persistState: async state => { persisted.push({ ...state }); },
    })).rejects.toThrow('关联已保留');

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      documentId: 'doxcn-new',
      contentHash: '',
    });
  });

  test('creates a new document in the selected folder', async () => {
    const createDocument = vi.fn(async () => ({
      documentId: 'doxcn-new',
      url: 'https://example.feishu.cn/docx/doxcn-new',
    }));
    const cli = createClient({ createDocument });

    await publishFeishuSnapshot({
      cli,
      snapshot,
      existing: null,
      parentToken: 'fldcnSelectedFolder',
      persistState: async () => undefined,
    });

    expect(createDocument).toHaveBeenCalledWith(
      snapshot.markdown,
      'fldcnSelectedFolder',
      snapshot.title,
    );
  });

  test('reports durable diagnostic stages without changing the transaction', async () => {
    const stages: string[] = [];

    await publishFeishuSnapshot({
      cli: createClient(),
      snapshot,
      existing: null,
      persistState: async () => undefined,
      onStage: event => stages.push(`${event.stage}:${event.status}`),
    });

    expect(stages).toEqual([
      'create_document:started',
      'create_document:succeeded',
      'persist_pending:started',
      'persist_pending:succeeded',
      'insert_assets:started',
      'insert_assets:succeeded',
      'fetch_remote:started',
      'fetch_remote:succeeded',
      'verify_remote:started',
      'verify_remote:succeeded',
      'persist_complete:started',
      'persist_complete:succeeded',
    ]);
  });

  test('rejects changed image bytes before any pending state or remote write', async () => {
    const vaultBasePath = await createFixtureVault();
    const fixture = await imageSnapshot(vaultBasePath, 1);
    await fsp.writeFile(fixture.absolutePaths[0], 'changed-after-confirmation');
    const remoteWrites = {
      createDocument: vi.fn(async () => ({ documentId: 'unused', url: 'https://unused' })),
      updateDocument: vi.fn(async () => undefined),
      insertAssets: vi.fn(async () => undefined),
      fetchDocumentContent: vi.fn(async () => remoteXml()),
    };
    const cli = createClient(remoteWrites);
    const persistState = vi.fn(async () => undefined);

    await expect(publishFeishuSnapshot({
      cli,
      snapshot: fixture.snapshot,
      existing: null,
      persistState,
    })).rejects.toThrow('在确认后发生了变化');

    expect(remoteWrites.createDocument).not.toHaveBeenCalled();
    expect(remoteWrites.updateDocument).not.toHaveBeenCalled();
    expect(remoteWrites.insertAssets).not.toHaveBeenCalled();
    expect(remoteWrites.fetchDocumentContent).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
  });

  test('rejects a Vault image symlink before any remote write', async () => {
    const parent = await createFixtureVault();
    const outside = path.join(path.dirname(parent), `outside-${path.basename(parent)}.png`);
    ownedFixtureDirectories.push(outside);
    await fsp.writeFile(outside, 'outside-image');
    await fsp.mkdir(path.join(parent, 'images'));
    const linkedPath = path.join(parent, 'images', 'linked.png');
    await fsp.symlink(outside, linkedPath);
    const outsideBytes = await fsp.readFile(outside);
    const linkedSnapshot: FeishuSnapshot = {
      title: '符号链接校验',
      markdown: '# 符号链接校验\n\nAILU_FEISHU_IMAGE_0001_test\n',
      contentHash: 'symlink-snapshot',
      warnings: [],
      vaultBasePath: parent,
      assets: [{
        placeholder: 'AILU_FEISHU_IMAGE_0001_test',
        vaultPath: 'images/linked.png',
        fileName: 'linked.png',
        mimeType: 'image/png',
        contentHash: sha256(outsideBytes),
        alt: '链接图片',
      }],
    };
    const remoteWrite = vi.fn(async () => ({
      documentId: 'must-not-run',
      url: 'https://example.feishu.cn/docx/must-not-run',
    }));

    await expect(publishFeishuSnapshot({
      cli: createClient({ createDocument: remoteWrite }),
      snapshot: linkedSnapshot,
      existing: null,
      persistState: async () => undefined,
    })).rejects.toThrow('符号链接');
    expect(remoteWrite).not.toHaveBeenCalled();
  });

  test('uploads 12 immutable staged images when Vault files change during the upload', async () => {
    const vaultBasePath = await createFixtureVault();
    const fixture = await imageSnapshot(vaultBasePath, 12);
    let stagedDirectory = '';
    const insertAssets = vi.fn(async (
      _documentId: string,
      uploadBasePath: string,
      assets: FeishuAssetDraft[],
    ) => {
      stagedDirectory = uploadBasePath;
      expect(uploadBasePath).not.toBe(vaultBasePath);
      expect(assets).toHaveLength(12);
      for (const [index, asset] of assets.entries()) {
        const uploadedBytes = await fsp.readFile(path.join(uploadBasePath, asset.vaultPath));
        expect(uploadedBytes.equals(fixture.originalBytes[index])).toBe(true);
        expect(sha256(uploadedBytes)).toBe(fixture.snapshot.assets[index].contentHash);
        if (index === 0) {
          await Promise.all(fixture.absolutePaths.slice(1).map((absolutePath, remainingIndex) => (
            fsp.writeFile(absolutePath, `changed-during-upload-${remainingIndex}`)
          )));
        }
      }
    });
    const cli = createClient({
      insertAssets,
      fetchDocumentContent: vi.fn(async () => imageRemoteXml(12)),
    });

    await publishFeishuSnapshot({
      cli,
      snapshot: fixture.snapshot,
      existing: null,
      persistState: async () => undefined,
    });

    expect(insertAssets).toHaveBeenCalledOnce();
    expect(stagedDirectory).toContain(`${path.sep}ailu-feishu-assets-`);
    await expect(fsp.stat(stagedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('cleans the owned staging directory when an image upload fails', async () => {
    const vaultBasePath = await createFixtureVault();
    const fixture = await imageSnapshot(vaultBasePath, 1);
    let stagedDirectory = '';
    const cli = createClient({
      insertAssets: vi.fn(async (
        _documentId: string,
        uploadBasePath: string,
        _assets: FeishuAssetDraft[],
      ) => {
        stagedDirectory = uploadBasePath;
        throw new Error('simulated image upload failure');
      }),
    });

    await expect(publishFeishuSnapshot({
      cli,
      snapshot: fixture.snapshot,
      existing: null,
      persistState: async () => undefined,
    })).rejects.toThrow('simulated image upload failure');

    expect(stagedDirectory).toContain(`${path.sep}ailu-feishu-assets-`);
    await expect(fsp.stat(stagedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('waits for the final local hook and performs zero writes when it fails', async () => {
    let rejectHook!: (reason: Error) => void;
    const hookGate = new Promise<void>((_resolve, reject) => { rejectHook = reject; });
    const remoteWrites = {
      createDocument: vi.fn(async () => ({ documentId: 'unused', url: 'https://unused' })),
      updateDocument: vi.fn(async () => undefined),
      insertAssets: vi.fn(async () => undefined),
      fetchDocumentContent: vi.fn(async () => remoteXml()),
    };
    const cli = createClient(remoteWrites);
    const persistState = vi.fn(async () => undefined);
    const beforeRemoteWrite = vi.fn(() => hookGate);
    const publishing = publishFeishuSnapshot({
      cli,
      snapshot,
      existing: null,
      persistState,
      beforeRemoteWrite,
    });
    const rejected = expect(publishing).rejects.toThrow('文章在确认后发生了变化');

    await vi.waitFor(() => expect(beforeRemoteWrite).toHaveBeenCalledOnce());
    expect(remoteWrites.createDocument).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
    rejectHook(new Error('文章在确认后发生了变化'));
    await rejected;

    expect(remoteWrites.createDocument).not.toHaveBeenCalled();
    expect(remoteWrites.updateDocument).not.toHaveBeenCalled();
    expect(remoteWrites.insertAssets).not.toHaveBeenCalled();
    expect(remoteWrites.fetchDocumentContent).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
  });
});
