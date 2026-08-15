import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DraftCreatedVerificationError,
  LocalRelayTransport,
} from '../src/publishing/localRelayTransport';
import { PreparedArticleBuilder } from '../src/publishing/preparedArticleBuilder';
import type {
  PreparedArticle,
  PublishingHttpClient,
  PublishingHttpRequest,
  PublishingImageInput,
  WeChatRelayDraftArticle,
} from '../src/publishing/types';
import { onePixelPng } from './fixtures/imageBytes';

const RELAY_TOKEN = 'r'.repeat(48);
const settingsTabSource = fs.readFileSync(
  fileURLToPath(new URL('../src/ui/settingsTab.ts', import.meta.url)),
  'utf8',
);
const readme = fs.readFileSync(
  fileURLToPath(new URL('../README.md', import.meta.url)),
  'utf8',
);

function image(id: string, reference: string, fileName = `${id}.png`): PublishingImageInput {
  return {
    id,
    fileName,
    mimeType: 'image/png',
    body: onePixelPng(),
    references: [reference],
  };
}

function requestBodyText(body: PublishingHttpRequest['body']): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

async function preparedWithOneImage(): Promise<PreparedArticle> {
  return new PreparedArticleBuilder().build({
    sourceHash: 'source-hash',
    title: '**中转测试**',
    author: '作者',
    digest: '摘要',
    html: [
      '<p><img src="blob:cover"></p>',
      '<h1>中转测试</h1>',
      '<p>正文<img src="blob:content"></p>',
    ].join(''),
    containerStyle: 'display:block;background-color:#F7F0F3;padding:30px 20px 44px;',
    cover: image('cover', 'blob:cover', 'cover"\r\nX-Evil: yes.png'),
    images: [image('content', 'blob:content')],
  });
}

describe('LocalRelayTransport', () => {
  test('documents only the two supported HTTPS relay routes and their root URL contract', () => {
    expect(settingsTabSource).toContain(
      'Tailscale Serve 填 HTTPS MagicDNS 地址；域名路线填 Caddy HTTPS 地址。只填服务根地址，不加 /v1。',
    );
    expect(settingsTabSource).not.toContain('Tailscale/SSH');
    expect(readme).toContain('固定 IPv4 VPS + 自有域名 + Caddy HTTPS');
    expect(readme).toContain('固定 IPv4 VPS + Tailscale Serve');
    expect(readme).toContain('HTTPS MagicDNS 服务根地址');
    expect(readme).toContain('不在末尾加 `/v1`');
    expect(readme).not.toContain('Tailscale Serve 或 SSH');
    expect(readme).not.toContain('SSH 路线让 Ailu 连接');
  });

  test('uploads locally-preflighted assets, creates a draft, and always verifies the readback', async () => {
    const article = await preparedWithOneImage();
    const requests: PublishingHttpRequest[] = [];
    let sentContent = '';
    const request = vi.fn<PublishingHttpClient>(async (current: PublishingHttpRequest) => {
      requests.push(current);
      if (current.url.endsWith('/wechat/material/add_material?type=image')) {
        return { status: 200, json: { media_id: 'cover-media-id' } };
      }
      if (current.url.endsWith('/wechat/media/uploadimg')) {
        return { status: 200, json: { url: 'http://mmbiz.qpic.cn/content.png' } };
      }
      if (current.url.endsWith('/wechat/draft/add')) {
        const payload = JSON.parse(requestBodyText(current.body)) as {
          articles: WeChatRelayDraftArticle[];
        };
        sentContent = payload.articles[0]?.content ?? '';
        return { status: 200, json: { media_id: 'draft-media-id' } };
      }
      if (current.url.endsWith('/wechat/draft/get')) {
        return {
          status: 200,
          json: {
            news_item: [{
              title: '中转测试',
              content: sentContent,
            }],
          },
        };
      }
      return { status: 404, json: { errmsg: 'unexpected endpoint' } };
    });

    const result = await new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787/',
      relayToken: RELAY_TOKEN,
      request,
    }).publish(article, { idempotencyKey: 'publish-once' });

    expect(requests.map(current => new URL(current.url).pathname)).toEqual([
      '/wechat/material/add_material',
      '/wechat/media/uploadimg',
      '/wechat/draft/add',
      '/wechat/draft/get',
    ]);
    expect(requests.every(current => current.headers.Authorization === `Bearer ${RELAY_TOKEN}`)).toBe(true);
    expect(requests[2].headers['Idempotency-Key']).toBe('publish-once');
    expect(requests[0].headers['Idempotency-Key']).toBeUndefined();
    expect(requests[3].headers['Idempotency-Key']).toBeUndefined();
    expect(requestBodyText(requests[0].body)).not.toContain('\r\nX-Evil:');
    const sentArticle = (
      JSON.parse(requestBodyText(requests[2].body)) as { articles: WeChatRelayDraftArticle[] }
    ).articles[0];
    expect(sentArticle).toMatchObject({
      title: '中转测试',
      author: '作者',
      digest: '摘要',
      thumb_media_id: 'cover-media-id',
    });
    expect(sentArticle.content).toContain('https://mmbiz.qpic.cn/content.png');
    expect(sentArticle.content).toMatch(
      /^<section style="display:block;background-color:#F7F0F3;padding:30px 20px 44px;text-align:left!important;text-align-last:left!important;text-indent:0!important;/,
    );
    expect(sentArticle.content).not.toContain('ailu-prepared-image://');
    expect(result).toMatchObject({
      draftMediaId: 'draft-media-id',
      coverMediaId: 'cover-media-id',
      uploadedImageCount: 1,
      verification: {
        title: '中转测试',
        imageCount: 1,
        dangerousListSectionCount: 0,
        dangerousListParagraphCount: 0,
        dangerousListBlockCount: 0,
        localImageSourceCount: 0,
      },
    });
  });

  test('makes zero requests when the prepared article changed after local preflight', async () => {
    const article = await preparedWithOneImage();
    article.digest = '预检后被修改';
    const request = vi.fn<PublishingHttpClient>();
    const transport = new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787',
      relayToken: RELAY_TOKEN,
      request,
    });

    await expect(transport.publish(article)).rejects.toThrow('预检后的文章内容已变化');
    expect(request).not.toHaveBeenCalled();
  });

  test('preserves the draft media ID when post-create readback verification fails', async () => {
    const article = await preparedWithOneImage();
    let sentContent = '';
    const request = vi.fn<PublishingHttpClient>(async current => {
      if (current.url.includes('/material/add_material')) {
        return { status: 200, json: { media_id: 'cover-media-id' } };
      }
      if (current.url.endsWith('/wechat/media/uploadimg')) {
        return { status: 200, json: { url: 'https://mmbiz.qpic.cn/content.png' } };
      }
      if (current.url.endsWith('/wechat/draft/add')) {
        const payload = JSON.parse(requestBodyText(current.body)) as {
          articles: WeChatRelayDraftArticle[];
        };
        sentContent = payload.articles[0]?.content ?? '';
        return { status: 200, json: { media_id: 'draft-needs-manual-check' } };
      }
      if (current.url.endsWith('/wechat/draft/get')) {
        return {
          status: 200,
          json: { news_item: [{ title: '错误标题', content: sentContent }] },
        };
      }
      return { status: 404, json: { errmsg: 'unexpected endpoint' } };
    });

    const transport = new LocalRelayTransport({
      relayUrl: 'https://relay.example.test',
      relayToken: RELAY_TOKEN,
      request,
    });
    const failure = await transport.publish(article).catch(error => error as unknown);
    expect(failure).toBeInstanceOf(DraftCreatedVerificationError);
    expect(failure).toMatchObject({ draftMediaId: 'draft-needs-manual-check' });
    expect((failure as Error).message).toContain('不要直接重试');
  });

  test('requires an explicitly injected relay URL, token, and request function', () => {
    expect(() => new LocalRelayTransport({
      relayUrl: 'file:///tmp/relay',
      relayToken: RELAY_TOKEN,
      request: vi.fn(),
    })).toThrow('仅支持 HTTP 或 HTTPS');
    expect(() => new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787',
      relayToken: ' ',
      request: vi.fn(),
    })).toThrow('填写中转 Token');
    expect(() => new LocalRelayTransport({
      relayUrl: 'http://127.0.0.1:8787',
      relayToken: 'memorable-password',
      request: vi.fn(),
    })).toThrow('至少 32 个随机字节');
  });

  test('never sends a bearer token to a non-loopback plain HTTP relay', () => {
    for (const relayUrl of [
      'http://relay.example.test',
      'http://192.168.1.8:8787',
      'http://localhost.example.test:8787',
    ]) {
      expect(() => new LocalRelayTransport({
        relayUrl,
        relayToken: RELAY_TOKEN,
        request: vi.fn(),
      })).toThrow('公网公众号中转地址必须使用 HTTPS');
    }
    expect(() => new LocalRelayTransport({
      relayUrl: 'https://relay.example.test',
      relayToken: RELAY_TOKEN,
      request: vi.fn(),
    })).not.toThrow();
    expect(() => new LocalRelayTransport({
      relayUrl: 'http://[::1]:8787',
      relayToken: RELAY_TOKEN,
      request: vi.fn(),
    })).not.toThrow();
  });

  test('rejects ambiguous relay URLs before a bearer token can be sent', () => {
    for (const relayUrl of [
      'https://user:password@relay.example.test',
      'https://relay.example.test?forward=elsewhere',
      'https://relay.example.test/#fragment',
    ]) {
      expect(() => new LocalRelayTransport({
        relayUrl,
        relayToken: RELAY_TOKEN,
        request: vi.fn(),
      })).toThrow('不能包含账号密码、查询参数或片段');
    }
  });
});
