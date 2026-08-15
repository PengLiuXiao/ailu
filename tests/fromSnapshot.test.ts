import { prepareSnapshotForPublishing } from '../src/publishing/fromSnapshot';
import type { WeChatAssetDraft, WeChatPreviewSnapshot } from '../src/wechat/types';
import { WECHAT_RENDERER_VERSION } from '../src/wechat/types';
import { onePixelJpeg, onePixelPng } from './fixtures/imageBytes';

function asset(
  token: string,
  contentHash: string,
  source: string,
  fileName: string,
  mimeType: string,
  body: ArrayBuffer,
): WeChatAssetDraft {
  return {
    token,
    source,
    fileName,
    mimeType,
    contentHash,
    body,
    previewUrl: `app://local/${fileName}`,
  };
}

function snapshot(assets: WeChatAssetDraft[], coverAssetToken: string): WeChatPreviewSnapshot {
  return {
    sourcePath: '文章/重复图片.md',
    title: '重复图片测试',
    author: '',
    digest: '',
    contentSourceUrl: '',
    markdown: '正文',
    contentHash: 'snapshot-hash',
    assets,
    warnings: [],
    thumbMediaId: '',
    coverAssetToken,
    rendererVersion: WECHAT_RENDERER_VERSION,
  };
}

describe('prepareSnapshotForPublishing', () => {
  test('uploads byte-identical files once while preserving every body occurrence', async () => {
    const coverHash = 'c'.repeat(64);
    const duplicateHash = 'd'.repeat(64);
    const coverToken = `ailu-wechat-asset://${coverHash}`;
    const duplicateToken = `ailu-wechat-asset://${duplicateHash}`;
    const assets = [
      asset(coverToken, coverHash, 'assets/cover.jpg', 'cover.jpg', 'image/jpeg', onePixelJpeg()),
      asset(
        duplicateToken,
        duplicateHash,
        'assets/12-obsidian-download-page.png',
        '12-obsidian-download-page.png',
        'image/png',
        onePixelPng(),
      ),
      asset(
        duplicateToken,
        duplicateHash,
        'assets/12-obsidian-download-page-install-step.png',
        '12-obsidian-download-page-install-step.png',
        'image/png',
        onePixelPng(),
      ),
    ];

    const article = await prepareSnapshotForPublishing(
      snapshot(assets, coverToken),
      [
        `<p><img src="${coverToken}"></p>`,
        '<h1>重复图片测试</h1>',
        `<p><img src="${duplicateToken}" alt="第一次出现"></p>`,
        `<p><img src="${duplicateToken}" alt="第二次出现"></p>`,
      ].join(''),
      {
        containerStyle: 'display:block;background-color:#F7F0F3;padding:30px 20px 44px;',
      },
    );

    expect(article.images).toHaveLength(1);
    expect(article.images[0].id).toBe(duplicateToken);
    expect(article.stats).toMatchObject({
      imageCount: 2,
      uniqueImageCount: 1,
      removedCover: true,
    });
    expect(article.html.match(/ailu-prepared-image:\/\//g)).toHaveLength(2);
    expect(article.html).toMatch(
      /^<section style="display:block;background-color:#F7F0F3;padding:30px 20px 44px;text-align:left!important;text-align-last:left!important;text-indent:0!important;/,
    );
    expect(article.html).toMatch(/<\/section>$/);
    expect(article.preflight.checkedImageCount).toBe(2);
  });

  test('rejects unsafe template wrapper styles before producing a prepared article', async () => {
    const coverHash = 'c'.repeat(64);
    const coverToken = `ailu-wechat-asset://${coverHash}`;
    const assets = [
      asset(coverToken, coverHash, 'assets/cover.jpg', 'cover.jpg', 'image/jpeg', onePixelJpeg()),
    ];

    await expect(prepareSnapshotForPublishing(
      snapshot(assets, coverToken),
      '<h1>重复图片测试</h1><p>正文</p>',
      { containerStyle: 'background-image:url(javascript:alert(1))' },
    )).rejects.toThrow('公众号模板外层样式包含不安全内容');
  });

  test('still rejects one image ID that points to different bytes', async () => {
    const coverHash = 'c'.repeat(64);
    const duplicateHash = 'd'.repeat(64);
    const coverToken = `ailu-wechat-asset://${coverHash}`;
    const duplicateToken = `ailu-wechat-asset://${duplicateHash}`;
    const assets = [
      asset(coverToken, coverHash, 'assets/cover.jpg', 'cover.jpg', 'image/jpeg', onePixelJpeg()),
      asset(duplicateToken, duplicateHash, 'assets/a.png', 'a.png', 'image/png', onePixelPng()),
      asset(duplicateToken, duplicateHash, 'assets/b.jpg', 'b.jpg', 'image/jpeg', onePixelJpeg()),
    ];

    await expect(prepareSnapshotForPublishing(
      snapshot(assets, coverToken),
      `<h1>重复图片测试</h1><p><img src="${duplicateToken}"></p>`,
    )).rejects.toThrow(`正文图片 ID 对应内容不一致：${duplicateToken}`);
  });
});
