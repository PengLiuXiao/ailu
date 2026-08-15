import { DraftVerifier } from './draftVerifier';
import { normalizeSecureRelayToken, normalizeSecureRelayUrl } from './publicationGuard';
import { assertPreparedArticleReady } from './preparedArticleBuilder';
import { PROTOCOL_IDS } from '../ids';
import type {
  LocalRelayPublishOptions,
  LocalRelayPublishResult,
  LocalRelayTransportConfig,
  DraftVerificationStats,
  PreparedArticle,
  PreparedCoverImage,
  PreparedPublishingImage,
  PublishingHttpRequest,
  WeChatRelayDraftArticle,
} from './types';

type JsonObject = Record<string, unknown>;

export class DraftCreatedVerificationError extends Error {
  constructor(
    readonly draftMediaId: string,
    readonly verificationMessage: string,
  ) {
    super(`草稿可能已创建（media_id: ${draftMediaId}），但回读验证失败：${verificationMessage}。请先在公众号草稿箱核对，不要直接重试`);
    this.name = 'DraftCreatedVerificationError';
  }
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function responseMessage(data: JsonObject | null, fallback: string): string {
  const message = data?.errmsg ?? data?.message ?? data?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

function multipartBody(
  fileName: string,
  mimeType: string,
  file: ArrayBuffer,
): { boundary: string; body: ArrayBuffer } {
  const boundary = `----Ailu${Date.now()}${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const safeName = [...String(fileName || 'image.jpg')]
    .map(character => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || ['"', '\\', '/'].includes(character)
        ? '_'
        : character;
    })
    .join('')
    .slice(0, 180) || 'image.jpg';
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const payload = new Uint8Array(file);
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.length + payload.length + suffix.length);
  body.set(prefix);
  body.set(payload, prefix.length);
  body.set(suffix, prefix.length + payload.length);
  return { boundary, body: body.buffer };
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*>/gi)].map(match => {
    const source = match[0].match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    return source?.[1] ?? source?.[2] ?? source?.[3] ?? '';
  });
}

function assertFinalHtml(html: string, expectedImageCount: number): void {
  if (!html.trim()) throw new Error('发布正文为空');
  if (html.includes(PROTOCOL_IDS.preparedImageScheme)) {
    throw new Error('发布正文仍含本地图片占位符');
  }
  if (/<li\b[^>]*>\s*<(?:section|p)\b/i.test(html)) {
    throw new Error('发布正文仍包含会导致空序号的 li 块级子节点');
  }
  const sources = imageSources(html);
  if (sources.length !== expectedImageCount) {
    throw new Error(`发布前图片数不一致：预期 ${expectedImageCount}，实际 ${sources.length}`);
  }
  const localSources = sources.filter(source => !/^https:\/\//i.test(source));
  if (localSources.length) {
    throw new Error(`发布前仍有 ${localSources.length} 张本地或非 HTTPS 图片`);
  }
}

export class LocalRelayTransport {
  private readonly relayUrl: string;
  private readonly relayToken: string;

  constructor(
    config: LocalRelayTransportConfig,
    private readonly verifier = new DraftVerifier(),
  ) {
    const relayUrl = normalizeSecureRelayUrl(config.relayUrl).relayUrl;
    const relayToken = normalizeSecureRelayToken(config.relayToken);
    if (typeof config.request !== 'function') throw new Error('未提供公众号中转请求器');
    this.relayUrl = relayUrl;
    this.relayToken = relayToken;
    this.request = config.request;
  }

  private readonly request: LocalRelayTransportConfig['request'];

  private endpoint(path: string): string {
    return `${this.relayUrl}${path}`;
  }

  private headers(contentType: string, additional: Record<string, string> = {}): Record<string, string> {
    return {
      'Content-Type': contentType,
      Authorization: `Bearer ${this.relayToken}`,
      ...additional,
    };
  }

  private async requestJson(
    request: PublishingHttpRequest,
    fallbackMessage: string,
  ): Promise<JsonObject> {
    let response;
    try {
      response = await this.request(request);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : fallbackMessage);
    }
    let data = jsonObject(response.json);
    if (!data && response.text) {
      try {
        data = jsonObject(JSON.parse(response.text));
      } catch {
        data = null;
      }
    }
    const errcode = Number(data?.errcode || 0);
    if (response.status < 200 || response.status >= 300 || errcode !== 0) {
      throw new Error(responseMessage(data, fallbackMessage));
    }
    return data ?? {};
  }

  private async uploadCover(cover: PreparedCoverImage): Promise<string> {
    const multipart = multipartBody(cover.fileName, cover.mimeType, cover.body);
    const data = await this.requestJson({
      url: this.endpoint('/wechat/material/add_material?type=image'),
      method: 'POST',
      headers: this.headers(`multipart/form-data; boundary=${multipart.boundary}`),
      body: multipart.body,
    }, '上传微信封面素材失败');
    const mediaId = typeof data.media_id === 'string' ? data.media_id : '';
    if (!mediaId) throw new Error('上传微信封面素材后未返回 media_id');
    return mediaId;
  }

  private async uploadContentImage(image: PreparedPublishingImage): Promise<string> {
    const multipart = multipartBody(image.fileName, image.mimeType, image.body);
    const data = await this.requestJson({
      url: this.endpoint('/wechat/media/uploadimg'),
      method: 'POST',
      headers: this.headers(`multipart/form-data; boundary=${multipart.boundary}`),
      body: multipart.body,
    }, `上传正文图片“${image.fileName}”失败`);
    const rawUrl = typeof data.url === 'string' ? data.url : '';
    const url = rawUrl.replace(/^http:\/\/mmbiz\.qpic\.cn\//i, 'https://mmbiz.qpic.cn/');
    if (!/^https:\/\//i.test(url)) {
      throw new Error(`上传正文图片“${image.fileName}”后未返回 HTTPS 地址`);
    }
    return url;
  }

  private async createDraft(
    article: WeChatRelayDraftArticle,
    idempotencyKey?: string,
  ): Promise<string> {
    const data = await this.requestJson({
      url: this.endpoint('/wechat/draft/add'),
      method: 'POST',
      headers: this.headers('application/json', idempotencyKey
        ? { 'Idempotency-Key': idempotencyKey }
        : {}),
      body: JSON.stringify({ articles: [article] }),
    }, '创建公众号草稿失败');
    const mediaId = typeof data.media_id === 'string' ? data.media_id : '';
    if (!mediaId) throw new Error('创建公众号草稿后未返回 media_id');
    return mediaId;
  }

  private getDraft(mediaId: string): Promise<JsonObject> {
    return this.requestJson({
      url: this.endpoint('/wechat/draft/get'),
      method: 'POST',
      headers: this.headers('application/json'),
      body: JSON.stringify({ media_id: mediaId }),
    }, '回读公众号草稿失败');
  }

  async publish(
    prepared: PreparedArticle,
    options: LocalRelayPublishOptions = {},
  ): Promise<LocalRelayPublishResult> {
    // This assertion must run before the first transport request. It verifies both that the
    // complete local image preflight passed and that nothing changed afterwards.
    assertPreparedArticleReady(prepared);

    const coverMediaId = await this.uploadCover(prepared.cover);
    let content = prepared.html;
    for (const image of prepared.images) {
      const url = await this.uploadContentImage(image);
      content = content.split(image.placeholder).join(url);
    }
    assertFinalHtml(content, prepared.stats.imageCount);

    const relayArticle: WeChatRelayDraftArticle = {
      title: prepared.title,
      author: prepared.author,
      digest: prepared.digest,
      content,
      content_source_url: prepared.contentSourceUrl,
      thumb_media_id: coverMediaId,
      show_cover_pic: 0,
      need_open_comment: prepared.needOpenComment ? 1 : 0,
      only_fans_can_comment: prepared.onlyFansCanComment ? 1 : 0,
    };
    const draftMediaId = await this.createDraft(relayArticle, options.idempotencyKey);
    let verification: DraftVerificationStats;
    try {
      verification = this.verifier.verify(
        await this.getDraft(draftMediaId),
        prepared,
        relayArticle,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DraftCreatedVerificationError(draftMediaId, message);
    }
    return {
      draftMediaId,
      coverMediaId,
      uploadedImageCount: prepared.images.length,
      verification,
    };
  }
}
