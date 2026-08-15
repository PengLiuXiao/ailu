import { DraftVerifier } from '../src/publishing/draftVerifier';
import { PreparedArticleBuilder } from '../src/publishing/preparedArticleBuilder';
import type {
  PreparedArticle,
  PublishingImageInput,
  WeChatRelayDraftArticle,
} from '../src/publishing/types';
import { onePixelPng } from './fixtures/imageBytes';

function image(id: string, reference: string): PublishingImageInput {
  return {
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    body: onePixelPng(),
    references: [reference],
  };
}

async function prepared(imageCount = 0): Promise<PreparedArticle> {
  const withImage = imageCount
    ? '<p><img src="blob:cover"></p><h1>回读测试</h1><p><img src="blob:content"></p>'
    : '<p>正文</p>';
  return new PreparedArticleBuilder().build({
    sourceHash: 'source-hash',
    title: '回读测试',
    html: withImage,
    cover: image('cover', 'blob:cover'),
    images: imageCount ? [image('content', 'blob:content')] : [],
  });
}

async function preparedHtml(html: string): Promise<PreparedArticle> {
  return new PreparedArticleBuilder().build({
    sourceHash: 'source-hash',
    title: '回读测试',
    html,
    cover: image('cover', 'blob:cover'),
    images: [],
  });
}

function sentArticle(article: PreparedArticle, content: string): WeChatRelayDraftArticle {
  return {
    title: article.title,
    author: article.author,
    digest: article.digest,
    content,
    content_source_url: article.contentSourceUrl,
    thumb_media_id: 'cover-media-id',
    show_cover_pic: 0,
    need_open_comment: 0,
    only_fans_can_comment: 0,
  };
}

describe('DraftVerifier', () => {
  test('accepts a matching readback with HTTPS images', async () => {
    const article = await prepared(1);
    const content = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/content.png',
    );
    expect(new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toMatchObject({
      title: '回读测试',
      imageCount: 1,
      dangerousListSectionCount: 0,
      dangerousListParagraphCount: 0,
      dangerousListBlockCount: 0,
      localImageSourceCount: 0,
    });
  });

  test('accepts WeChat draft readback normalizing its official image CDN to HTTP', async () => {
    const article = await prepared(1);
    const sentContent = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/content.png',
    );
    const readbackContent = sentContent.replace(
      'https://mmbiz.qpic.cn/content.png',
      'http://mmbiz.qpic.cn/content.png',
    );
    expect(new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).toMatchObject({
      imageCount: 1,
      localImageSourceCount: 0,
    });
  });

  test('accepts a trusted data-src when WeChat removes the direct src during readback', async () => {
    const article = await prepared(1);
    const sentContent = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/content.png',
    );
    const readbackContent = sentContent.replace(
      'src="https://mmbiz.qpic.cn/content.png"',
      'data-src="http://mmbiz.qpic.cn/content.png?wx_fmt=png&amp;from=appmsg"',
    );
    expect(new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).toMatchObject({
      imageCount: 1,
      localImageSourceCount: 0,
    });
  });

  test('accepts WeChat display-size and query normalization for the same CDN asset', async () => {
    const article = await prepared(1);
    const sentContent = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/sz_mmbiz_png/stable-asset-id/0?from=appmsg',
    );
    const readbackContent = sentContent.replace(
      'src="https://mmbiz.qpic.cn/sz_mmbiz_png/stable-asset-id/0?from=appmsg"',
      'data-src="https://mmbiz.qpic.cn/sz_mmbiz_png/stable-asset-id/640?wx_fmt=png&amp;from=appmsg"',
    );
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).not.toThrow();
  });

  test('accepts a trusted data-src when WeChat leaves an empty direct src', async () => {
    const article = await prepared(1);
    const sentContent = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/content.png',
    );
    const readbackContent = sentContent.replace(
      'src="https://mmbiz.qpic.cn/content.png"',
      'src="" data-src="https://mmbiz.qpic.cn/content.png"',
    );
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).not.toThrow();
  });

  test('rejects a mismatched title', async () => {
    const article = await prepared();
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: '其他标题', content: article.html }] },
      article,
      sentArticle(article, article.html),
    )).toThrow('回读标题不一致');
  });

  test('rejects li > section after draft readback', async () => {
    const article = await prepared();
    const content = '<ol><li><section><p>第一步</p></section></li></ol>';
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toThrow('li 块级子节点');
  });

  test('rejects li > p after draft readback', async () => {
    const article = await prepared();
    const content = '<ol><li><p>第一步</p></li></ol>';
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toThrow('li 块级子节点');
  });

  test('rejects local or non-HTTPS image sources after draft readback', async () => {
    const article = await prepared(1);
    const content = article.html.replace(
      'ailu-prepared-image://content',
      'file:///private/content.png',
    );
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toThrow('本地或非 HTTPS 图片');
  });

  test('rejects HTTP image sources outside the exact official WeChat CDN host', async () => {
    const article = await prepared(1);
    const content = article.html.replace(
      'ailu-prepared-image://content',
      'http://mmbiz.qpic.cn.example.test/content.png',
    );
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toThrow('本地或非 HTTPS 图片');
  });

  test('does not mistake data-src for the real src attribute', async () => {
    const article = await prepared(1);
    const content = article.html.replace(
      `src="ailu-prepared-image://content"`,
      'data-src="https://mmbiz.qpic.cn/content.png" src="file:///private/content.png"',
    );
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content }] },
      article,
      sentArticle(article, content),
    )).toThrow('本地或非 HTTPS 图片');
  });

  test('rejects a changed image count after draft readback', async () => {
    const article = await prepared(1);
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: '<p>图片丢失</p>' }] },
      article,
      sentArticle(article, '<p>图片丢失</p>'),
    )).toThrow('回读图片数不一致');
  });

  test('requires the exact native list and list-item counts when lists are expected', async () => {
    const article = await preparedHtml('<ol><li>第一步</li><li>第二步</li></ol>');
    const sent = sentArticle(article, article.html);
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: '<ol><li>第一步 第二步</li></ol>' }] },
      article,
      sent,
    )).toThrow('回读原生列表项数不一致');
  });

  test('rejects changed readable body text even when counts still match', async () => {
    const article = await preparedHtml('<section><p>原始正文</p></section>');
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: '<section><p>被替换的正文</p></section>' }] },
      article,
      sentArticle(article, article.html),
    )).toThrow('回读正文可见文字与发送内容不一致');
  });

  test('rejects changed key block structure even when text is unchanged', async () => {
    const article = await preparedHtml('<section><p>正文</p></section>');
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: '<blockquote><p>正文</p></blockquote>' }] },
      article,
      sentArticle(article, article.html),
    )).toThrow('回读关键语义结构与发送内容不一致');
  });

  test('rejects a changed HTTPS image address even when image count matches', async () => {
    const article = await prepared(1);
    const sentContent = article.html.replace(
      'ailu-prepared-image://content',
      'https://mmbiz.qpic.cn/original.png',
    );
    const readbackContent = sentContent.replace('original.png', 'other.png');
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).toThrow('图片地址与发送内容不一致');
  });

  test('allows harmless inline wrappers added during draft storage', async () => {
    const article = await preparedHtml('<section><p>正文</p></section>');
    const readback = '<section><p><span style="color:red">正文</span></p></section>';
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readback }] },
      article,
      sentArticle(article, article.html),
    )).not.toThrow();
  });

  test('accepts WeChat splitting one sentence across many harmless inline wrappers', async () => {
    const article = await preparedHtml(
      '<section><p>合成配置保存在 ~/Library/Application Support/Example/App/state.db 这个测试路径中。</p></section>',
    );
    const readback = [
      '<section><p>',
      '<span>合成</span><span>配置</span><span> 保</span><span>存</span><span>在 </span>',
      '<span>~/Library/Application Support/Example/App/state.db</span>',
      '<span> 这个测试路径中。</span>',
      '</p></section>',
    ].join('');
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readback }] },
      article,
      sentArticle(article, article.html),
    )).not.toThrow();
  });

  test('accepts harmless paragraph, section and line-break serialization changes', async () => {
    const article = await preparedHtml(
      '<section><p>第一段</p><p><strong>第二段</strong></p><p><br></p></section>',
    );
    const readback = '<section><section><span>第一</span>段<br><span>第二段</span></section></section>';
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readback }] },
      article,
      sentArticle(article, article.html),
    )).not.toThrow();
  });

  test('accepts a full WeChat-shaped 23-image readback without weakening asset identity', async () => {
    const images = Array.from({ length: 23 }, (_, index) => (
      `<img src="https://mmbiz.qpic.cn/sz_mmbiz_png/asset-${index + 1}/0?from=appmsg">`
    ));
    const sentContent = [
      '<section><h2>公众号回读</h2>',
      '<p>Cookie 在 Chrome 保存的路径。</p>',
      ...images.map(imageHtml => `<p>${imageHtml}</p>`),
      '<blockquote><p>核对完成</p></blockquote></section>',
    ].join('');
    const article = await preparedHtml(sentContent);
    const readbackImages = images.map((_, index) => (
      `<img data-src="http://mmbiz.qpic.cn/sz_mmbiz_png/asset-${index + 1}/640?wx_fmt=png&amp;from=appmsg">`
    ));
    const readbackContent = [
      '<section><h2><span>公众号</span><span>回读</span></h2>',
      '<section><span>Cookie</span><span> 在 </span><span>Chrome</span><span> 保存的路径。</span></section>',
      ...readbackImages.map(imageHtml => `<section>${imageHtml}<br></section>`),
      '<blockquote><span>核对</span><span>完成</span></blockquote></section>',
    ].join('');
    expect(new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readbackContent }] },
      article,
      sentArticle(article, sentContent),
    )).toMatchObject({
      imageCount: 23,
      localImageSourceCount: 0,
    });
  });

  test('still rejects text moved into a different semantic structure', async () => {
    const article = await preparedHtml('<h2>标题</h2><p>正文</p>');
    const readback = '<p>标题</p><h2>正文</h2>';
    expect(() => new DraftVerifier().verify(
      { news_item: [{ title: article.title, content: readback }] },
      article,
      sentArticle(article, article.html),
    )).toThrow('回读关键语义结构与发送内容不一致');
  });
});
