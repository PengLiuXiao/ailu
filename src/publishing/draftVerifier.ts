import { normalizePreparedArticleTitle } from './preparedArticleBuilder';
import { PROTOCOL_IDS } from '../ids';
import type {
  DraftVerificationStats,
  PreparedArticle,
  WeChatRelayDraftArticle,
} from './types';

type JsonObject = Record<string, unknown>;

const SEMANTIC_STRUCTURE_TAGS = new Set([
  'blockquote', 'ol', 'ul', 'li',
  'table', 'tr', 'th', 'td',
  'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr',
]);

const NON_VISIBLE_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript']);

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function draftNewsItem(readback: unknown): JsonObject {
  const root = object(readback);
  const newsItems = root?.news_item;
  const first = Array.isArray(newsItems) ? object(newsItems[0]) : null;
  if (!first) throw new Error('公众号草稿回读缺少 news_item');
  return first;
}

function imageSources(html: string): string[] {
  const sources: string[] = [];
  const imagePattern = /<img\b[^>]*>/gi;
  for (const match of html.matchAll(imagePattern)) {
    const tag = match[0];
    const source = tag.match(/(?:^|\s)src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const directSource = source?.[1] ?? source?.[2] ?? source?.[3] ?? '';
    if (directSource.trim()) {
      sources.push(directSource);
      continue;
    }
    const lazySource = tag.match(
      /(?:^|\s)data-src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
    );
    sources.push(lazySource?.[1] ?? lazySource?.[2] ?? lazySource?.[3] ?? '');
  }
  return sources;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith('#x')) {
      const point = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    if (normalized.startsWith('#')) {
      const point = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return named[normalized] ?? match;
  });
}

function canonicalRemoteImageSource(value: string): string | null {
  const decoded = decodeEntities(value).trim();
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'http:') {
    if (url.hostname.toLowerCase() !== 'mmbiz.qpic.cn') return null;
    url.protocol = 'https:';
  } else if (url.protocol !== 'https:') {
    return null;
  }
  if (url.hostname.toLowerCase() === 'mmbiz.qpic.cn') {
    if (url.port) return null;
    const segments = url.pathname.split('/');
    if (/^\d+$/.test(segments.at(-1) ?? '')) segments[segments.length - 1] = '0';
    url.pathname = segments.join('/');
    url.search = '';
    url.hash = '';
  }
  return url.href;
}

function tokenizeHtml(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      const end = next === -1 ? source.length : next;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    let quote = '';
    let cursor = index + 1;
    for (; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (cursor >= source.length) {
      tokens.push(source.slice(index));
      break;
    }
    tokens.push(source.slice(index, cursor + 1));
    index = cursor + 1;
  }
  return tokens;
}

function normalizedReadableCharacters(value: string): string {
  return decodeEntities(value)
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/\s+/gu, '');
}

function readableCharacterSequence(html: string): string {
  const text: string[] = [];
  const hiddenStack: string[] = [];
  for (const token of tokenizeHtml(html)) {
    if (!token.startsWith('<')) {
      if (!hiddenStack.length) text.push(token);
      continue;
    }
    const close = token.match(/^<\s*\/\s*([\w:-]+)/);
    const open = close ? null : token.match(/^<\s*([\w:-]+)/);
    const tagName = (close?.[1] ?? open?.[1] ?? '').toLowerCase();
    if (!NON_VISIBLE_CONTENT_TAGS.has(tagName)) continue;
    if (close) {
      const lastIndex = hiddenStack.lastIndexOf(tagName);
      if (lastIndex >= 0) hiddenStack.splice(lastIndex, 1);
    } else if (!/\/\s*>$/.test(token)) {
      hiddenStack.push(tagName);
    }
  }
  return normalizedReadableCharacters(text.join(''));
}

/**
 * Compare the exact sequence of non-whitespace characters together with the
 * structures that carry publishing meaning. WeChat may split a sentence into
 * many spans, add or remove paragraph/section wrappers, and rewrite line-break
 * nodes while storing a draft. Those serialization changes must not make an
 * otherwise identical draft fail verification.
 *
 * Images and native-list counts are verified separately before this signature
 * is used. Headings, quotes, list nesting, tables and code remain structural
 * boundaries so visible content cannot silently move between those roles.
 */
function contentSignature(html: string): string {
  const signature: string[] = [];
  const textBuffer: string[] = [];
  const hiddenStack: string[] = [];
  const flushText = (): void => {
    const text = normalizedReadableCharacters(textBuffer.join(''));
    textBuffer.length = 0;
    if (text) signature.push(`text:${text}`);
  };
  for (const token of tokenizeHtml(html)) {
    if (!token.startsWith('<')) {
      if (!hiddenStack.length) textBuffer.push(token);
      continue;
    }
    const close = token.match(/^<\s*\/\s*([\w:-]+)/);
    const open = close ? null : token.match(/^<\s*([\w:-]+)/);
    const tagName = (close?.[1] ?? open?.[1] ?? '').toLowerCase();
    if (NON_VISIBLE_CONTENT_TAGS.has(tagName)) {
      if (close) {
        const lastIndex = hiddenStack.lastIndexOf(tagName);
        if (lastIndex >= 0) hiddenStack.splice(lastIndex, 1);
      } else if (!/\/\s*>$/.test(token)) {
        hiddenStack.push(tagName);
      }
      continue;
    }
    if (hiddenStack.length || !SEMANTIC_STRUCTURE_TAGS.has(tagName)) continue;
    flushText();
    signature.push(`${close ? 'close' : 'open'}:${tagName}`);
  }
  flushText();
  return signature.join('\u001f');
}

function assertEqual(actual: string | number, expected: string | number, message: string): void {
  if (actual !== expected) throw new Error(`${message}：预期 ${expected}，实际 ${actual}`);
}

export class DraftVerifier {
  verify(
    readback: unknown,
    expected: PreparedArticle,
    sentArticle: WeChatRelayDraftArticle,
  ): DraftVerificationStats {
    const item = draftNewsItem(readback);
    const title = normalizePreparedArticleTitle(typeof item.title === 'string' ? item.title : '');
    const content = typeof item.content === 'string' ? item.content : '';
    if (!content.trim()) throw new Error('公众号草稿已创建，但回读正文为空');
    if (content.includes(PROTOCOL_IDS.preparedImageScheme)) {
      throw new Error('公众号草稿回读仍含本地图片占位符');
    }

    const sources = imageSources(content);
    const nativeListCount = (content.match(/<(?:ol|ul)\b/gi) || []).length;
    const nativeListItemCount = (content.match(/<li\b/gi) || []).length;
    const dangerousListSectionCount = (
      content.match(/<li\b[^>]*>\s*(?:<!--[^]*?-->\s*)*<section\b/gi) || []
    ).length;
    const dangerousListParagraphCount = (
      content.match(/<li\b[^>]*>\s*(?:<!--[^]*?-->\s*)*<p\b/gi) || []
    ).length;
    const dangerousListBlockCount = dangerousListSectionCount + dangerousListParagraphCount;
    const canonicalSources = sources.map(canonicalRemoteImageSource);
    const localImageSourceCount = canonicalSources.filter(source => source === null).length;
    const stats: DraftVerificationStats = {
      title,
      contentLength: content.length,
      imageCount: sources.length,
      nativeListCount,
      nativeListItemCount,
      dangerousListSectionCount,
      dangerousListParagraphCount,
      dangerousListBlockCount,
      localImageSourceCount,
    };

    assertEqual(title, expected.title, '公众号草稿回读标题不一致');
    assertEqual(title, normalizePreparedArticleTitle(sentArticle.title), '回读标题与发送内容不一致');
    assertEqual(stats.imageCount, expected.stats.imageCount, '公众号草稿回读图片数不一致');
    if (dangerousListBlockCount) {
      throw new Error(`公众号草稿回读仍存在 ${dangerousListBlockCount} 个 li 块级子节点，列表可能出现空序号`);
    }
    if (localImageSourceCount) {
      throw new Error(`公众号草稿回读仍有 ${localImageSourceCount} 张本地或非 HTTPS 图片`);
    }
    const sentSources = imageSources(sentArticle.content);
    const sentNativeListCount = (sentArticle.content.match(/<(?:ol|ul)\b/gi) || []).length;
    const sentNativeListItemCount = (sentArticle.content.match(/<li\b/gi) || []).length;
    assertEqual(sentSources.length, expected.stats.imageCount, '发送正文图片数与预检不一致');
    assertEqual(stats.imageCount, sentSources.length, '公众号草稿回读图片数不一致');
    assertEqual(sentNativeListCount, expected.stats.nativeListCount, '发送正文原生列表数与预检不一致');
    assertEqual(
      sentNativeListItemCount,
      expected.stats.nativeListItemCount,
      '发送正文原生列表项数与预检不一致',
    );
    assertEqual(nativeListCount, sentNativeListCount, '公众号草稿回读原生列表数不一致');
    assertEqual(
      nativeListItemCount,
      sentNativeListItemCount,
      '公众号草稿回读原生列表项数不一致',
    );
    const canonicalSentSources = sentSources.map(canonicalRemoteImageSource);
    for (let index = 0; index < sources.length; index += 1) {
      if (canonicalSources[index] !== canonicalSentSources[index]) {
        throw new Error(`公众号草稿回读第 ${index + 1} 张图片地址与发送内容不一致`);
      }
    }
    if (contentSignature(content) !== contentSignature(sentArticle.content)) {
      const sentCharacters = readableCharacterSequence(sentArticle.content);
      const readbackCharacters = readableCharacterSequence(content);
      if (readbackCharacters !== sentCharacters) {
        throw new Error(
          '公众号草稿回读正文可见文字与发送内容不一致'
          + `（去除空白后发送 ${sentCharacters.length} 字符，回读 ${readbackCharacters.length} 字符）`,
        );
      }
      throw new Error('公众号草稿回读关键语义结构与发送内容不一致');
    }
    return stats;
  }
}
