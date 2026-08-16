vi.mock('obsidian', () => ({
  FileSystemAdapter: class FileSystemAdapter {},
  TFile: class TFile {},
}));

vi.mock('../src/share/snapshot', () => ({
  buildShareSnapshot: vi.fn(),
}));

vi.mock('../src/utils/secureAssets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/secureAssets')>();
  return { ...actual, fetchRemoteImageBytes: vi.fn() };
});

import type { App } from 'obsidian';
import { TFile } from 'obsidian';

import { buildShareSnapshot } from '../src/share/snapshot';
import { fetchRemoteImageBytes } from '../src/utils/secureAssets';
import { buildWeChatSnapshot } from '../src/wechat/snapshot';

const CDN_IMAGE_URL = 'https://cdn.example.test/assets/sample-image.png';
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer;

describe('WeChat snapshot remote images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('uses the Markdown filename ahead of frontmatter and shared snapshot titles', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: 'Shared snapshot title',
      markdown: 'Body.',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: { title: 'Frontmatter title', '标题': '中文前置标题' },
        }),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/文件名标题.md';

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(snapshot.title).toBe('文件名标题');
  });

  test('captures CDN images when whitespace appears before the URL parentheses', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: 'CDN 图片测试',
      markdown: [
        `![](${CDN_IMAGE_URL})`,
        `![] (${CDN_IMAGE_URL})`,
        `![CDN 图片] (${CDN_IMAGE_URL} "说明")`,
      ].join('\n'),
      sourceLineMap: [4, 5, 6],
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
      body: Buffer.from(PNG_BYTES),
      finalUrl: CDN_IMAGE_URL,
    });

    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(undefined),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/CDN 图片测试.md';

    const snapshot = await buildWeChatSnapshot(app, file);
    const asset = snapshot.assets[0];

    expect(fetchRemoteImageBytes).toHaveBeenCalledOnce();
    expect(fetchRemoteImageBytes).toHaveBeenCalledWith(CDN_IMAGE_URL, { maxBytes: 10 * 1024 * 1024 });
    expect(asset).toMatchObject({
      source: CDN_IMAGE_URL,
      fileName: 'sample-image.png',
      mimeType: 'image/png',
      previewUrl: '',
    });
    expect(snapshot.markdown).toBe([
      `![](${asset.token})`,
      `![](${asset.token})`,
      `![CDN 图片](${asset.token})`,
    ].join('\n'));
    expect(snapshot.sourceLineMap).toEqual([4, 5, 6]);
    expect(snapshot.warnings).toEqual([]);
  });

  test('uses the real image type when a CDN labels PNG content as JPEG', async () => {
    const mismatchedImageUrl = 'https://cdn.example.test/assets/mislabeled-image.jpg';
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: 'CDN 图片类型测试',
      markdown: `![](${mismatchedImageUrl})`,
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
      body: Buffer.from(PNG_BYTES),
      finalUrl: mismatchedImageUrl,
    });

    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue(undefined),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/CDN 图片类型测试.md';

    const snapshot = await buildWeChatSnapshot(app, file);
    const asset = snapshot.assets[0];

    expect(asset).toMatchObject({
      source: mismatchedImageUrl,
      fileName: 'mislabeled-image.png',
      mimeType: 'image/png',
      body: PNG_BYTES,
    });
    expect(snapshot.markdown).toBe(`![](${asset.token})`);
    expect(snapshot.warnings).toEqual([]);
  });

  test.each([
    'cover',
    'cover_image',
    'coverImage',
    'wechat_cover',
    'wechatCover',
    '公众号封面',
    '封面',
  ])('keeps the legacy MP Preview cover key %s', async coverKey => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '封面兼容测试',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
      body: Buffer.from(PNG_BYTES),
      finalUrl: CDN_IMAGE_URL,
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: { [coverKey]: CDN_IMAGE_URL },
        }),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = `文章/${coverKey}.md`;

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(snapshot.coverAssetToken).toBe(snapshot.assets[0]?.token);
    expect(snapshot.warnings).toEqual([]);
  });

  test('uses wechat_cover ahead of a conflicting generic cover', async () => {
    const explicitCover = 'https://cdn.example.com/wechat-cover.png';
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '独立封面优先级',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
      body: Buffer.from(PNG_BYTES),
      finalUrl: explicitCover,
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: {
            wechat_cover: explicitCover,
            cover: CDN_IMAGE_URL,
          },
        }),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/独立封面优先级.md';

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(fetchRemoteImageBytes).toHaveBeenCalledOnce();
    expect(fetchRemoteImageBytes).toHaveBeenCalledWith(explicitCover, { maxBytes: 10 * 1024 * 1024 });
    expect(snapshot.coverAssetToken).toBe(snapshot.assets[0]?.token);
  });

  test('uses the next configured cover when the preferred wechat_cover path is stale', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '封面备用属性',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    vi.mocked(fetchRemoteImageBytes).mockResolvedValue({
      body: Buffer.from(PNG_BYTES),
      finalUrl: CDN_IMAGE_URL,
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: {
            wechat_cover: 'assets/旧标题/已移动.png',
            cover: CDN_IMAGE_URL,
          },
        }),
        getFirstLinkpathDest: vi.fn().mockReturnValue(null),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/封面备用属性.md';

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(fetchRemoteImageBytes).toHaveBeenCalledOnce();
    expect(snapshot.coverAssetToken).toBe(snapshot.assets[0]?.token);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatchObject({
      code: 'cover-fallback',
      blocking: false,
    });
    expect(snapshot.warnings[0]?.message).toContain('备用属性 cover');
  });

  test('falls back to the first body image when the explicit cover moved', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '正文首图备用封面',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [{
        token: 'share-body',
        vaultPath: '文章/assets/body.png',
        fileName: 'body.png',
        mimeType: 'image/png',
        contentHash: 'body-hash',
        body: PNG_BYTES,
      }],
      warnings: [],
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: { wechat_cover: '文章/assets/旧标题/cover.png' },
        }),
        getFirstLinkpathDest: vi.fn().mockReturnValue(null),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/正文首图备用封面.md';

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(snapshot.coverAssetToken).toBeNull();
    expect(snapshot.assets[0]).toMatchObject({ source: '文章/assets/body.png' });
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatchObject({
      code: 'cover-fallback',
      blocking: false,
    });
    expect(snapshot.warnings[0]?.message).toContain('已自动改用正文首图');
  });

  test('keeps a clickable hard error when neither configured nor body cover exists', async () => {
    vi.mocked(buildShareSnapshot).mockResolvedValue({
      title: '没有备用封面',
      markdown: '正文',
      contentHash: 'share-hash',
      assets: [],
      warnings: [],
    });
    const app = {
      metadataCache: {
        getFileCache: vi.fn().mockReturnValue({
          frontmatter: { wechat_cover: '文章/assets/旧标题/cover.png' },
        }),
        getFirstLinkpathDest: vi.fn().mockReturnValue(null),
      },
    } as unknown as App;
    const file = new TFile();
    file.path = '文章/没有备用封面.md';

    const snapshot = await buildWeChatSnapshot(app, file);

    expect(snapshot.coverAssetToken).toBeNull();
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatchObject({
      code: 'cover',
      blocking: true,
    });
    expect(snapshot.warnings[0]?.message).toContain('正文没有可用图片');
  });
});
