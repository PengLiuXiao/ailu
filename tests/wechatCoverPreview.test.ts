import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  buildWeChatCoverPreviewModel,
  WECHAT_COVER_PREVIEW_RATIO,
} from '../src/ui/wechatCoverPreview';
import type { WeChatAssetDraft, WeChatPreviewSnapshot } from '../src/wechat/types';

const publishingStudioSource = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/publishingStudioView.ts', import.meta.url)),
  'utf8',
);
const stylesheet = fs.readFileSync(
  fileURLToPath(new URL('../styles.css', import.meta.url)),
  'utf8',
);

function asset(token: string, fileName: string): WeChatAssetDraft {
  return {
    token,
    source: `assets/${fileName}`,
    fileName,
    mimeType: 'image/png',
    contentHash: token,
    body: new Uint8Array([1, 2, 3]).buffer,
    previewUrl: `app://vault/${fileName}`,
  };
}

function snapshot(
  assets: WeChatAssetDraft[],
  coverAssetToken: string | null,
  overrides: Partial<WeChatPreviewSnapshot> = {},
): WeChatPreviewSnapshot {
  return {
    sourcePath: '文章/示例.md',
    title: '示例文章',
    author: '',
    digest: '',
    contentSourceUrl: '',
    markdown: '# 示例文章',
    contentHash: 'snapshot',
    assets,
    warnings: [],
    thumbMediaId: '',
    coverAssetToken,
    rendererVersion: 'ailu-wechat-v2',
    ...overrides,
  };
}

describe('WeChat cover preview model', () => {
  test('previews the same explicit cover selected for publishing', () => {
    const body = asset('body', 'body.png');
    const cover = asset('cover', 'cover.png');

    const model = buildWeChatCoverPreviewModel(snapshot(
      [body, cover],
      cover.token,
      { title: '  独立封面文章  ', digest: '  一段摘要  ' },
    ));

    expect(model.asset).toBe(cover);
    expect(model.source).toBe('explicit');
    expect(model.title).toBe('独立封面文章');
    expect(model.summary).toBe('独立封面 · 一段摘要');
    expect(model.badge).toBe(`公众号封面 · ${WECHAT_COVER_PREVIEW_RATIO}`);
    expect(model.alt).toBe('公众号封面预览：独立封面文章');
  });

  test('labels the first body image when it is the publishing fallback', () => {
    const first = asset('first', 'first.png');
    const model = buildWeChatCoverPreviewModel(snapshot([first], null));

    expect(model.asset).toBe(first);
    expect(model.source).toBe('body-first');
    expect(model.summary).toBe('使用正文首图作为封面');
  });

  test('does not claim a dangling token is an explicit cover', () => {
    const first = asset('first', 'first.png');
    const model = buildWeChatCoverPreviewModel(snapshot([first], 'missing-token'));

    expect(model.asset).toBe(first);
    expect(model.source).toBe('body-first');
  });

  test('teaches how to add a cover when the article has no images', () => {
    const model = buildWeChatCoverPreviewModel(snapshot([], null, { title: '  ' }));

    expect(model.asset).toBeNull();
    expect(model.source).toBe('missing');
    expect(model.title).toBe('未命名文章');
    expect(model.summary).toContain('wechat_cover');
    expect(model.alt).toBe('未设置公众号封面');
  });
});

describe('WeChat cover preview UI contract', () => {
  test('renders the cover beside rather than inside the publishable article', () => {
    const renderBody = publishingStudioSource.match(
      /const surface = scroll\.createDiv[\s\S]*?this\.renderActions\(shell\);/,
    )?.[0] ?? '';

    expect(renderBody.indexOf('this.renderWeChatCoverPreview(surface')).toBeGreaterThan(-1);
    expect(renderBody.indexOf('this.renderWeChatCoverPreview(surface')).toBeLessThan(
      renderBody.indexOf("const canvas = surface.createDiv"),
    );
    expect(renderBody).not.toContain('this.renderWeChatCoverPreview(article');
  });

  test('keeps a fixed WeChat cover ratio and releases frozen preview URLs', () => {
    expect(stylesheet).toMatch(
      /\.ailu-wechat-cover-media\s*\{[\s\S]*?aspect-ratio:\s*2\.35\s*\/\s*1;/,
    );
    expect(publishingStudioSource).toContain('override async onClose(): Promise<void>');
    expect(publishingStudioSource).toMatch(
      /override async onClose[\s\S]*?this\.releaseWeChatCoverObjectUrl\(\);/,
    );
    expect(publishingStudioSource).toMatch(
      /if \(this\.target !== 'wechat'\) \{[\s\S]*?this\.releaseWeChatCoverObjectUrl\(\);/,
    );
    expect(publishingStudioSource).toMatch(
      /if \(nextTarget !== this\.target\) \{[\s\S]*?if \(nextTarget !== 'wechat'\) this\.releaseWeChatCoverObjectUrl\(\);/,
    );
  });

  test('keeps all primary WeChat actions clickable and guards concurrent work in the handler', () => {
    const renderActions = publishingStudioSource.match(
      /private renderActions\([\s\S]*?\n {2}private renderState\(/,
    )?.[0] ?? '';

    expect(renderActions).toContain("'上传到草稿箱'");
    expect(renderActions).not.toContain('.disabled =');
    expect(publishingStudioSource).toContain(
      'private reserveWeChatOperation(operation: Exclude<Operation, null>)',
    );
    expect(publishingStudioSource).toMatch(
      /private async publishDraft\(\)[\s\S]*?reserveWeChatOperation\('preflight'\)/,
    );
  });
});
