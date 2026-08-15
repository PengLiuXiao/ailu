import {
  ImagePreflight,
  MAX_WECHAT_CONTENT_IMAGE_BYTES,
} from '../src/publishing/imagePreflight';
import {
  PreparedArticleBuilder,
  assertPreparedArticleReady,
  buildPreparedArticleClipboardPayload,
} from '../src/publishing/preparedArticleBuilder';
import type { ImageCompressionAdapter, PublishingImageInput } from '../src/publishing/types';
import {
  WECHAT_TEXT_FLOW_RESET_STYLE,
  WECHAT_TEXT_WRAP_GUARD_STYLE,
} from '../src/wechat/textFlowGuards';
import { onePixelJpeg, onePixelPng } from './fixtures/imageBytes';

function image(
  id: string,
  fileName: string,
  references: string[],
): PublishingImageInput {
  return {
    id,
    fileName,
    mimeType: 'image/png',
    body: onePixelPng(),
    references,
  };
}

describe('PreparedArticleBuilder', () => {
  test('removes the duplicated cover and title, cleans HTML, and preflights every local image', async () => {
    const cover = image('cover', 'cover.png', ['blob:cover']);
    const content = image('content', 'content.png', ['blob:content']);
    const builder = new PreparedArticleBuilder(new ImagePreflight());
    const article = await builder.build({
      sourceHash: 'source-hash',
      title: '**测试标题**',
      html: [
        '<p class="cover"><img src="blob:cover" alt="cover"></p>',
        '<h1 id="title"><strong>测试标题</strong></h1>',
        '<h2 data-heading="true">章节</h2>',
        '<ol><li><section><p>第一步</p></section></li></ol>',
        '<p><img src="blob:content"><img src="blob:content"></p>',
        '<script>alert(1)</script>',
      ].join(''),
      cover,
      images: [content],
      now: () => new Date('2026-08-05T00:00:00.000Z'),
    });

    expect(article.title).toBe('测试标题');
    expect(article.html).not.toMatch(/blob:cover|<h1|<h2|<script|\sclass=|\sid=|data-heading/);
    expect(article.html).toContain('<p>章节</p>');
    expect(article.html).toMatch(/<li[^>]*>第一步<\/li>/);
    expect(article.html.match(/ailu-prepared-image:\/\/content/g)).toHaveLength(2);
    expect(article.stats).toMatchObject({
      removedCover: true,
      removedCoverReason: 'matched-cover',
      removedTitle: true,
      imageCount: 2,
      uniqueImageCount: 1,
      dangerousListSectionCount: 0,
      dangerousListParagraphCount: 0,
      dangerousListBlockCount: 0,
    });
    expect(article.preflight).toMatchObject({
      passed: true,
      completedAt: '2026-08-05T00:00:00.000Z',
      checkedImageCount: 2,
    });
    expect(() => assertPreparedArticleReady(article)).not.toThrow();
  });

  test('blocks unresolved image sources before any transport can receive an article', async () => {
    const builder = new PreparedArticleBuilder();
    await expect(builder.build({
      sourceHash: 'source-hash',
      title: '缺图测试',
      html: '<h2>章节</h2><p><img src="file:///private/missing.png"></p>',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    })).rejects.toThrow('正文图片未通过本地预检');
  });

  test('builds clipboard HTML from the same sanitized article used for draft publishing', async () => {
    const article = await new PreparedArticleBuilder().build({
      sourceHash: 'source-hash',
      title: '复制净化测试',
      html: [
        '<h1 class="local-title">复制净化测试</h1>',
        '<ol class="local-list"><li><section><p>第一步</p></section></li></ol>',
        '<h2 data-local="heading">正文</h2>',
      ].join(''),
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    });

    const clipboard = buildPreparedArticleClipboardPayload(article);
    expect(clipboard.html).toBe(article.html);
    expect(clipboard.html).not.toMatch(/<h1|<h2|\sclass=|data-local|<li>\s*<(?:section|p)/);
    expect(clipboard.html).toMatch(/<li[^>]*>第一步<\/li>/);
    expect(clipboard.html).toContain('<p>正文</p>');
    expect(clipboard.plain).toContain('第一步正文');
  });

  test('preserves host-resistant text-flow guards through prepared and clipboard HTML', async () => {
    const guardedStyle = `${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`;
    const article = await new PreparedArticleBuilder().build({
      sourceHash: 'source-hash',
      title: '样式防护测试',
      html: [
        '<h1>样式防护测试</h1>',
        `<p style="${guardedStyle}">阅读示例文档，访问&nbsp;https://example.test/docs/</p>`,
        `<ol><li style="${guardedStyle}">列表正文</li></ol>`,
      ].join(''),
      containerStyle: guardedStyle,
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    });

    for (const html of [article.html, buildPreparedArticleClipboardPayload(article).html]) {
      expect(html.match(/text-align:left!important/g)).toHaveLength(4);
      expect(html.match(/text-align-last:left!important/g)).toHaveLength(4);
      expect(html.match(/text-indent:0!important/g)).toHaveLength(4);
      expect(html.match(/overflow-wrap:anywhere!important/g)).toHaveLength(3);
      expect(html).not.toContain('text-align:justify');
    }
  });

  test('reasserts prose and inner flat-list guards at the final publishing boundary', async () => {
    const article = await new PreparedArticleBuilder().build({
      sourceHash: 'source-hash',
      title: '最终文字流防护',
      html: [
        '<h1 style="text-align:center">最终文字流防护</h1>',
        '<h2 style="text-align:center">三、示例工具安装教程</h2>',
        '<p style="text-align:justify!important;text-indent:2em!important">合成资料保存在示例设备中。</p>',
        '<section data-ailu-paper-flat-list="ordered">',
        '<p data-ailu-paper-flat-list-item="true" style="display:flex;text-align:justify!important;text-indent:2em!important">',
        '<span>01</span>',
        '<span style="flex:1;text-align:justify!important;text-indent:2em!important">打开示例文档，访问&nbsp;<a href="https://example.test/docs/">https://example.test/docs/</a></span>',
        '</p>',
        '</section>',
        '<section data-ailu-paper-ending="true"><p style="text-align:center">合成样稿到此结束</p></section>',
      ].join(''),
      containerStyle: 'text-align:justify!important;text-indent:2em!important',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    });

    const html = article.html;
    const prose = html.match(/<p style="([^"]*)">合成资料保存/);
    const row = html.match(/<p style="([^"]*)"><span>01<\/span>/);
    const content = html.match(/<span style="([^"]*)">打开示例文档/);
    expect(prose?.[1]).toMatch(/text-align:left!important.*text-indent:0!important/);
    expect(row?.[1]).toMatch(/text-align:left!important.*text-indent:0!important/);
    expect(content?.[1]).toMatch(/text-align:left!important.*text-indent:0!important/);
    expect(content?.[1]).toContain('min-width:0!important;max-width:100%!important');
    expect(html).toContain('<p style="text-align:center">三、示例工具安装教程</p>');
    expect(html).toContain('<p style="text-align:center">合成样稿到此结束</p>');
    expect(html).not.toContain('data-ailu-paper-flat-list');
    expect(html).not.toContain('data-ailu-paper-ending');
  });

  test('embeds every prepared image occurrence in clipboard HTML without mutating the article', async () => {
    const content = image('content image', 'content.png', ['blob:content']);
    const article = await new PreparedArticleBuilder().build({
      sourceHash: 'source-hash',
      title: '复制图片测试',
      html: [
        '<h1>复制图片测试</h1>',
        '<p><img src="blob:content" alt="第一张"></p>',
        '<p><img src="blob:content" alt="重复引用"></p>',
      ].join(''),
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [content],
    });
    const preparedHtml = article.html;

    const clipboard = buildPreparedArticleClipboardPayload(article);
    const dataUrl = `data:image/png;base64,${Buffer.from(onePixelPng()).toString('base64')}`;

    expect(clipboard.html).not.toContain('ailu-prepared-image://');
    expect(clipboard.html.split(dataUrl)).toHaveLength(3);
    expect(clipboard.html).toContain(`src="${dataUrl}"`);
    expect(article.html).toBe(preparedHtml);
    expect(article.html.match(/ailu-prepared-image:\/\//g)).toHaveLength(2);
  });

  test('embeds the compressed preflight output instead of oversized source bytes', async () => {
    const compression: ImageCompressionAdapter = {
      compressToJpeg: vi.fn(async () => ({
        body: onePixelJpeg(),
        mimeType: 'image/jpeg' as const,
        extension: 'jpg' as const,
      })),
    };
    const oversized = new Uint8Array(MAX_WECHAT_CONTENT_IMAGE_BYTES + 1);
    oversized.set(new Uint8Array(onePixelPng()));
    const article = await new PreparedArticleBuilder(new ImagePreflight(compression)).build({
      sourceHash: 'source-hash',
      title: '压缩图片复制测试',
      html: '<h2>正文图片</h2><p><img src="blob:oversized"></p>',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [{
        ...image('oversized', 'oversized.png', ['blob:oversized']),
        body: oversized.buffer,
      }],
    });

    const clipboard = buildPreparedArticleClipboardPayload(article);
    const compressedDataUrl = `data:image/jpeg;base64,${Buffer.from(onePixelJpeg()).toString('base64')}`;

    expect(article.images[0]).toMatchObject({ compressed: true, mimeType: 'image/jpeg' });
    expect(clipboard.html).toContain(`src="${compressedDataUrl}"`);
    expect(clipboard.html).not.toContain(Buffer.from(oversized.buffer).toString('base64'));
  });

  test('explicitly blocks raw SVG or MathJax markup that was not converted before preflight', async () => {
    const builder = new PreparedArticleBuilder();
    await expect(builder.build({
      sourceHash: 'source-hash',
      title: '公式阻断测试',
      html: '<p><mjx-container><svg viewBox="0 0 20 10"><path d="M0 0"></path></svg></mjx-container></p>',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    })).rejects.toThrow('请先将公式转换为 PNG');
  });

  test('accepts a locally converted formula PNG as a normal preflighted content image', async () => {
    const token = 'ailu-wechat-formula://formula-hash';
    const article = await new PreparedArticleBuilder().build({
      sourceHash: 'source-hash',
      title: '公式图片测试',
      html: `<h2>公式</h2><p><img src="${token}" alt="公式"></p>`,
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [image(token, 'formula-formula-hash.png', [token])],
    });

    expect(article.html).not.toMatch(/<svg|<mjx-/i);
    expect(article.html).toContain(
      `ailu-prepared-image://${encodeURIComponent(token)}`,
    );
    expect(article.images).toHaveLength(1);
    expect(article.images[0].fileName).toBe('formula-formula-hash.png');
    expect(buildPreparedArticleClipboardPayload(article).html).toContain('src="data:image/png;base64,');
    expect(() => assertPreparedArticleReady(article)).not.toThrow();
  });

  test('does not mistake a cover id substring for the actual cover image', async () => {
    const builder = new PreparedArticleBuilder();
    const article = await builder.build({
      sourceHash: 'source-hash',
      title: '封面精确匹配',
      html: '<h2>章节</h2><p><img src="blob:content?note=cover"></p>',
      cover: image('cover', 'cover.png', ['blob:actual-cover']),
      images: [image('content', 'content.png', ['blob:content?note=cover'])],
    });
    expect(article.stats.removedCover).toBe(false);
    expect(article.stats.imageCount).toBe(1);
    expect(article.html).toContain('ailu-prepared-image://content');
  });

  test('invalidates a prepared article if its HTML changes after preflight', async () => {
    const builder = new PreparedArticleBuilder();
    const article = await builder.build({
      sourceHash: 'source-hash',
      title: '完整性测试',
      html: '<p>正文</p>',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [],
    });
    article.html = '<p>被篡改</p>';
    expect(() => assertPreparedArticleReady(article)).toThrow('预检后的文章内容已变化');
  });

  test('invalidates a prepared article if image bytes change after preflight', async () => {
    const builder = new PreparedArticleBuilder();
    const article = await builder.build({
      sourceHash: 'source-hash',
      title: '图片完整性测试',
      html: '<h2>章节</h2><p><img src="blob:content"></p>',
      cover: image('cover', 'cover.png', ['blob:cover']),
      images: [image('content', 'content.png', ['blob:content'])],
    });
    new Uint8Array(article.images[0].body)[0] = 0;
    expect(() => assertPreparedArticleReady(article)).toThrow('正文图片');
  });
});
