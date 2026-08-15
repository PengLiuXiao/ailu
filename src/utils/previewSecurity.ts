import { createHash } from 'node:crypto';

import {
  consumeXArticleMarkdownFence,
  xArticleMarkdownFenceState,
} from '../xArticle/markdownFence';
import {
  sanitizeXArticlePreviewRemoteMedia,
  scanXArticleMarkdownImageTokens,
} from '../xArticle/preview';

const ALLOWED_PREVIEW_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export interface PreviewObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

interface ManagedPreviewUrlRecord {
  contentHash: string;
  mimeType: string;
  url: string;
}

function exactBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function detectedImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61
  ) return 'image/gif';
  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) return 'image/webp';
  return null;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeLocalPreviewImage(destination: string): boolean {
  let decoded = destination.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return false;
  }
  decoded = decoded.replace(/^[\s\u200b\ufeff]+/u, '');
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]{2})/.test(decoded)) return false;
  const pathOnly = decoded.split(/[?#]/, 1)[0];
  return /\.(?:gif|jpe?g|png|webp)$/i.test(pathOnly);
}

function sanitizeLocalPreviewImageBlock(
  markdown: string,
  managedDestinations: ReadonlySet<string>,
  managedOnly: boolean,
): string {
  const replacements = scanXArticleMarkdownImageTokens(markdown)
    .filter((token) => {
      if (token.kind === 'inline' && managedDestinations.has(token.destination)) return false;
      if (managedOnly) return true;
      return token.kind === 'inline' && !safeLocalPreviewImage(token.destination);
    });
  let result = markdown;
  for (const token of replacements.reverse()) {
    const source = result.slice(token.start, token.end + 1);
    result = `${result.slice(0, token.start)}【媒体未加载】${'\n'.repeat(
      (source.match(/\n/g) ?? []).length,
    )}${result.slice(token.end + 1)}`;
  }
  return result;
}

function sanitizeLocalPreviewImages(
  markdown: string,
  managedDestinations: ReadonlySet<string>,
  managedOnly: boolean,
): string {
  const lines = markdown.split('\n');
  const output: string[] = [];
  const fence = xArticleMarkdownFenceState();
  let text: string[] = [];
  const flush = (): void => {
    if (!text.length) return;
    output.push(...sanitizeLocalPreviewImageBlock(
      text.join('\n'),
      managedDestinations,
      managedOnly,
    ).split('\n'));
    text = [];
  };
  for (const line of lines) {
    if (consumeXArticleMarkdownFence(line, fence)) {
      flush();
      output.push(line);
    } else if (fence.character) {
      flush();
      output.push(line);
    } else {
      text.push(line);
    }
  }
  flush();
  return output.join('\n');
}

/**
 * Owns every object URL used by a preview. Only image bytes whose magic bytes
 * agree with the declared MIME type can enter the store. A caller can also pin
 * the bytes to a previously frozen snapshot hash.
 */
export class ManagedPreviewUrlStore {
  private readonly records = new Map<string, ManagedPreviewUrlRecord>();

  constructor(private readonly objectUrls: PreviewObjectUrlApi = URL) {}

  setVerifiedImage(
    key: string,
    value: ArrayBuffer | Uint8Array,
    mimeType: string,
    expectedSha256?: string,
  ): string {
    if (!key.trim()) throw new Error('预览图片标识无效。');
    const normalizedMimeType = mimeType.trim().toLowerCase();
    if (!ALLOWED_PREVIEW_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
      throw new Error('预览图片类型不受支持。');
    }
    const bytes = exactBytes(value);
    if (!bytes.byteLength || detectedImageMimeType(bytes) !== normalizedMimeType) {
      throw new Error('预览图片内容与声明格式不一致。');
    }
    const contentHash = sha256(bytes);
    if (expectedSha256 !== undefined) {
      const normalizedExpectedHash = expectedSha256.trim().toLowerCase();
      if (!/^[a-f\d]{64}$/.test(normalizedExpectedHash) || normalizedExpectedHash !== contentHash) {
        throw new Error('预览图片内容与冻结快照不一致。');
      }
    }
    const current = this.records.get(key);
    if (current?.contentHash === contentHash && current.mimeType === normalizedMimeType) {
      return current.url;
    }
    if (current) this.revokeRecord(current);
    const url = this.objectUrls.createObjectURL(new Blob(
      [bytes.buffer as ArrayBuffer],
      { type: normalizedMimeType },
    ));
    if (!url.startsWith('blob:')) {
      this.objectUrls.revokeObjectURL(url);
      throw new Error('预览图片未获得受管对象 URL。');
    }
    this.records.set(key, { contentHash, mimeType: normalizedMimeType, url });
    return url;
  }

  get(key: string): string | null {
    return this.records.get(key)?.url ?? null;
  }

  revoke(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    this.revokeRecord(record);
  }

  allowedObjectUrls(): ReadonlySet<string> {
    return new Set(Array.from(this.records.values(), record => record.url));
  }

  revokeExcept(activeKeys: ReadonlySet<string>): void {
    for (const [key, record] of this.records) {
      if (activeKeys.has(key)) continue;
      this.records.delete(key);
      this.revokeRecord(record);
    }
  }

  revokeAll(): void {
    for (const record of this.records.values()) this.revokeRecord(record);
    this.records.clear();
  }

  private revokeRecord(record: ManagedPreviewUrlRecord): void {
    try {
      this.objectUrls.revokeObjectURL(record.url);
    } catch {
      // Cleanup must continue even if an embedded browser rejects one stale URL.
    }
  }
}

/**
 * Removes network/data/custom-scheme Markdown images and all raw HTML before
 * MarkdownRenderer sees untrusted content. Exact object URLs owned by the
 * current preview are protected while the shared X sanitizer runs; arbitrary
 * blob URLs remain blocked.
 */
export function sanitizeUntrustedMarkdownMedia(
  markdown: string,
  allowedObjectUrls: ReadonlySet<string> = new Set(),
): string {
  return sanitizePreviewMarkdown(markdown, allowedObjectUrls, false);
}

/**
 * Strict boundary for MarkdownRenderer previews backed by frozen image bytes.
 * Only exact blob URLs owned by the supplied preview store survive; every
 * other Markdown or wiki image becomes an inert placeholder.
 */
export function sanitizeManagedPreviewMarkdown(
  markdown: string,
  allowedObjectUrls: ReadonlySet<string>,
): string {
  return sanitizePreviewMarkdown(markdown, allowedObjectUrls, true);
}

function sanitizePreviewMarkdown(
  markdown: string,
  allowedObjectUrls: ReadonlySet<string>,
  managedOnly: boolean,
): string {
  let protectedMarkdown = markdown;
  const replacements: Array<{ token: string; url: string }> = [];
  for (const url of allowedObjectUrls) {
    if (!url.startsWith('blob:') || !protectedMarkdown.includes(url)) continue;
    let token = `.ailu-managed-preview-${replacements.length}.png`;
    while (protectedMarkdown.includes(token)) token = `_${token}`;
    protectedMarkdown = protectedMarkdown.split(url).join(token);
    replacements.push({ token, url });
  }
  let sanitized = sanitizeLocalPreviewImages(
    sanitizeXArticlePreviewRemoteMedia(protectedMarkdown),
    new Set(replacements.map(replacement => replacement.token)),
    managedOnly,
  );
  for (const replacement of replacements) {
    sanitized = sanitized.split(replacement.token).join(replacement.url);
  }
  return sanitized;
}
