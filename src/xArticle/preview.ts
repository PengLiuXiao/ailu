import { markdownFilenameTitle } from '../publishing/sourceTitle';
import {
  consumeXArticleMarkdownFence,
  xArticleMarkdownFenceState,
} from './markdownFence';

export interface XArticlePreviewMarkdownOptions {
  filename?: string | null;
  stripFrontmatter?: boolean;
  useFilenameAsTitle?: boolean;
}

export interface XArticlePreviewDocument {
  markdown: string;
  /** Maps each preview Markdown line back to the zero-based source line. */
  sourceLineMap: number[];
}

export interface XArticleFrontmatterSplit {
  body: string;
  bodyStartLine: number;
  hadFrontmatter: boolean;
  rawFrontmatter: string | null;
}

export interface XArticleMarkdownImage {
  alt: string;
  src: string;
}

export interface XArticleHeroOptions {
  fallbackSummary?: string;
  filename?: string | null;
  frontmatter?: Record<string, unknown> | null;
  summaryTargetLength?: number;
}

export interface XArticleHero {
  cover: string | null;
  summary: string;
  title: string;
}

const DEFAULT_SUMMARY_TARGET_LENGTH = 260;
const REMOTE_MEDIA_PLACEHOLDER = '【远程媒体未加载】';
const RAW_HTML_PLACEHOLDER = '【原始 HTML 未渲染】';
const X_POST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/[^/\s]+\/status\/\d+(?:[/?#][^\s]*)?$/i;

function normalizeLineEndings(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function splitXArticleFrontmatter(source: string): XArticleFrontmatterSplit {
  const normalized = normalizeLineEndings(source);
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') {
    return {
      body: normalized,
      bodyStartLine: 0,
      hadFrontmatter: false,
      rawFrontmatter: null,
    };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line),
  );
  if (closingIndex < 0) {
    return {
      body: normalized,
      bodyStartLine: 0,
      hadFrontmatter: false,
      rawFrontmatter: null,
    };
  }

  return {
    body: lines.slice(closingIndex + 1).join('\n'),
    bodyStartLine: closingIndex + 1,
    hadFrontmatter: true,
    rawFrontmatter: lines.slice(1, closingIndex).join('\n'),
  };
}

export function stripXArticleFrontmatter(source: string): string {
  return splitXArticleFrontmatter(source).body;
}

function replacePreservingLineCount(value: string, replacement: string): string {
  const lineBreakCount = (value.match(/\n/g) ?? []).length;
  return `${replacement}${'\n'.repeat(lineBreakCount)}`;
}

function decodeXArticleHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    bsol: '\\',
    colon: ':',
    emsp: '\u2003',
    emsp13: '\u2004',
    emsp14: '\u2005',
    ensp: '\u2002',
    gt: '>',
    hairsp: '\u200A',
    lt: '<',
    mediumspace: '\u205F',
    nbsp: '\u00A0',
    negativemediumspace: '\u200B',
    negativethickspace: '\u200B',
    negativethinspace: '\u200B',
    negativeverythinspace: '\u200B',
    newline: '\n',
    numsp: '\u2007',
    period: '.',
    puncsp: '\u2008',
    quot: '"',
    sol: '/',
    tab: '\t',
    thickspace: '\u205F\u200A',
    thinsp: '\u2009',
    verythinspace: '\u200A',
    zerowidthspace: '\u200B',
  };
  return value.replace(
    /&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
        if (Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          && !(codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return String.fromCodePoint(codePoint);
        }
        return '\uFFFD';
      }
      return name ? (named[name.toLowerCase()] ?? entity) : entity;
    },
  );
}

function isRemoteXArticleMediaUrl(value: string): boolean {
  const decoded = decodeXArticleHtmlEntities(value).replace(/^[\s\u200b\ufeff]+/u, '');
  // Fail closed when Markdown's full HTML-entity table knows a leading entity
  // that this deliberately small decoder does not. Such entities can become
  // whitespace before a network scheme (for example NonBreakingSpace).
  if (/^&(?:#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.test(decoded)) {
    return true;
  }
  return /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]{2})/.test(decoded);
}

function xArticleMarkdownDestination(body: string): string {
  const trimmed = body.trimStart();
  if (!trimmed) return '';
  if (trimmed.startsWith('<')) {
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
      const character = trimmed[index];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '>') {
        return trimmed.slice(1, index);
      }
    }
    return trimmed.slice(1);
  }
  let destination = '';
  let nestedParentheses = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (/\s/u.test(character) && nestedParentheses === 0) break;
    if (character === '\\' && index + 1 < trimmed.length) {
      destination += trimmed[index + 1];
      index += 1;
      continue;
    }
    if (character === '(') nestedParentheses += 1;
    if (character === ')') {
      if (nestedParentheses === 0) break;
      nestedParentheses -= 1;
    }
    destination += character;
  }
  return destination;
}

interface XArticleBracketSpan {
  content: string;
  end: number;
}

function xArticleBracketSpan(value: string, start: number): XArticleBracketSpan | null {
  if (value[start] !== '[') return null;
  let depth = 1;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return { content: value.slice(start + 1, index), end: index };
    }
  }
  return null;
}

interface XArticleInlineDestination {
  destination: string;
  end: number;
}

function xArticleInlineDestination(value: string, start: number): XArticleInlineDestination | null {
  if (value[start] !== '(') return null;
  let depth = 1;
  let angleDestination = false;
  let quote: '"' | "'" | null = null;
  let seenNonWhitespace = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\' && index + 1 < value.length) {
      index += 1;
      seenNonWhitespace = true;
      continue;
    }
    if (!seenNonWhitespace && /\s/u.test(character)) continue;
    if (!seenNonWhitespace) {
      seenNonWhitespace = true;
      angleDestination = character === '<';
    }
    if (angleDestination) {
      if (character === '>') angleDestination = false;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          destination: xArticleMarkdownDestination(value.slice(start + 1, index)),
          end: index,
        };
      }
    }
  }
  return null;
}

function isEscapedXArticleMarkdownCharacter(value: string, index: number): boolean {
  let backslashes = 0;
  for (let offset = index - 1; offset >= 0 && value[offset] === '\\'; offset -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function unescapeXArticleMarkdownLabel(value: string): string {
  return decodeXArticleHtmlEntities(
    value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1'),
  );
}

function isXArticleMarkdownAutolink(value: string): boolean {
  const uriAutolink = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>$/u;
  const emailAutolink =
    /^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/;
  return uriAutolink.test(value) || emailAutolink.test(value);
}

function sanitizeXArticleRawHtml(markdown: string): string {
  const replaceRawHtml = (value: string): string =>
    replacePreservingLineCount(value, RAW_HTML_PLACEHOLDER);
  return markdown
    .replace(/<!--[\s\S]*?-->/g, replaceRawHtml)
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, replaceRawHtml)
    .replace(/<\?[\s\S]*?\?>/g, replaceRawHtml)
    .replace(/<![A-Z][^>]*>/gi, replaceRawHtml)
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g, value =>
      isXArticleMarkdownAutolink(value) ? value : replaceRawHtml(value));
}

function normalizeXArticleReferenceLabel(value: string): string {
  return unescapeXArticleMarkdownLabel(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

export type XArticleMarkdownImageTokenKind =
  | 'inline'
  | 'full-reference'
  | 'collapsed-reference'
  | 'shortcut-reference'
  | 'wiki';

export interface XArticleMarkdownImageToken {
  alt: string;
  destination: string;
  end: number;
  kind: XArticleMarkdownImageTokenKind;
  referenceLabel: string;
  start: number;
}

export function scanXArticleMarkdownImageTokens(markdown: string): XArticleMarkdownImageToken[] {
  const tokens: XArticleMarkdownImageToken[] = [];
  let index = 0;
  while (index < markdown.length - 1) {
    if (markdown[index] !== '!' || markdown[index + 1] !== '['
      || isEscapedXArticleMarkdownCharacter(markdown, index)) {
      index += 1;
      continue;
    }
    const alt = xArticleBracketSpan(markdown, index + 1);
    if (!alt) {
      index += 2;
      continue;
    }
    const immediateSuffix = markdown[alt.end + 1] ?? '';
    if (markdown[index + 2] === '[' && alt.content.startsWith('[') && alt.content.endsWith(']')
      && immediateSuffix !== '(' && immediateSuffix !== '[') {
      tokens.push({
        alt: alt.content,
        destination: '',
        end: alt.end,
        kind: 'wiki',
        referenceLabel: '',
        start: index,
      });
      index = alt.end + 1;
      continue;
    }
    let next = alt.end + 1;
    while (next < markdown.length && /\s/u.test(markdown[next])) next += 1;
    let token: XArticleMarkdownImageToken = {
      alt: alt.content,
      destination: '',
      end: alt.end,
      kind: 'shortcut-reference',
      referenceLabel: normalizeXArticleReferenceLabel(alt.content),
      start: index,
    };
    if (markdown[next] === '(') {
      const inline = xArticleInlineDestination(markdown, next);
      if (inline) {
        token = {
          alt: alt.content,
          destination: inline.destination,
          end: inline.end,
          kind: 'inline',
          referenceLabel: '',
          start: index,
        };
      }
    } else if (markdown[next] === '[') {
      const reference = xArticleBracketSpan(markdown, next);
      if (reference) {
        const label = reference.content || alt.content;
        token = {
          alt: alt.content,
          destination: '',
          end: reference.end,
          kind: reference.content ? 'full-reference' : 'collapsed-reference',
          referenceLabel: normalizeXArticleReferenceLabel(label),
          start: index,
        };
      }
    }
    tokens.push(token);
    index = Math.max(index + 2, token.end + 1);
  }
  return tokens;
}

function sanitizeXArticleRemoteMarkdownImages(markdown: string): string {
  const output: string[] = [];
  let copiedUntil = 0;
  for (const token of scanXArticleMarkdownImageTokens(markdown)) {
    const remote = token.kind === 'inline'
      ? isRemoteXArticleMediaUrl(token.destination)
      : token.kind !== 'wiki';
    if (!remote) continue;
    const raw = markdown.slice(token.start, token.end + 1);
    output.push(markdown.slice(copiedUntil, token.start));
    output.push(replacePreservingLineCount(raw, REMOTE_MEDIA_PLACEHOLDER));
    copiedUntil = token.end + 1;
  }
  output.push(markdown.slice(copiedUntil));
  return output.join('');
}

function sanitizeXArticleWikiTransclusions(markdown: string): string {
  return markdown.replace(/!\[\[([^\]\n]+)\]\]/g, (embed, value: string) => {
    const target = value.split('|', 1)[0].split('#', 1)[0].trim();
    // Keep the preview allowlist identical to the upload allowlist. In
    // particular, SVG is excluded because an otherwise local SVG can contain
    // external resource references.
    const isKnownImage = /\.(?:gif|jpe?g|png|webp)$/i.test(target);
    return isKnownImage && !isRemoteXArticleMediaUrl(target)
      ? embed
      : REMOTE_MEDIA_PLACEHOLDER;
  });
}

function sanitizeXArticlePreviewRemoteMediaBlock(markdown: string): string {
  const remoteWikiImagePattern = /!\[\[\s*(?:https?:\/\/|\/\/)[^\]\n]*\]\]/gi;
  const remoteCssUrlPattern =
    /url\(\s*(?:"\s*(?:https?:\/\/|\/\/)[^"]*"|'\s*(?:https?:\/\/|\/\/)[^']*'|(?:https?:\/\/|\/\/)[^)\s]+)\s*\)/gi;

  const sanitized = sanitizeXArticleRemoteMarkdownImages(sanitizeXArticleRawHtml(markdown))
    .replace(remoteWikiImagePattern, image =>
      replacePreservingLineCount(image, REMOTE_MEDIA_PLACEHOLDER))
    .replace(remoteCssUrlPattern, value => replacePreservingLineCount(value, 'none'));
  return sanitizeXArticleWikiTransclusions(
    sanitized,
  );
}

/**
 * Removes network-capable remote media references before MarkdownRenderer sees them.
 * Fenced code is left intact and every replacement preserves the original line count
 * so editor-to-preview source mappings remain stable.
 */
export function sanitizeXArticlePreviewRemoteMedia(markdown: string): string {
  const lines = normalizeLineEndings(markdown).split('\n');
  const output: string[] = [];
  let textBuffer: string[] = [];
  const fence = xArticleMarkdownFenceState();
  const flushText = (): void => {
    if (!textBuffer.length) return;
    output.push(...sanitizeXArticlePreviewRemoteMediaBlock(textBuffer.join('\n')).split('\n'));
    textBuffer = [];
  };

  for (const line of lines) {
    if (consumeXArticleMarkdownFence(line, fence)) {
      flushText();
      output.push(line);
      continue;
    }
    if (fence.character) {
      flushText();
      output.push(line);
    } else {
      textBuffer.push(line);
    }
  }
  flushText();
  return output.join('\n');
}

function forEachMarkdownTextLine(
  markdown: string,
  callback: (line: string, index: number, lines: readonly string[]) => boolean | void,
): void {
  const lines = normalizeLineEndings(markdown).split('\n');
  const fence = xArticleMarkdownFenceState();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (consumeXArticleMarkdownFence(line, fence)) continue;
    if (fence.character) continue;
    if (callback(line, index, lines) === false) return;
  }
}

export function filenameToXArticleTitle(filename: string | null | undefined): string {
  return markdownFilenameTitle(filename);
}

export function hasXArticleH1(markdown: string): boolean {
  let found = false;
  forEachMarkdownTextLine(markdown, (line, index, lines) => {
    if (/^ {0,3}#(?!#)[ \t]+\S/.test(line)) {
      found = true;
      return false;
    }
    if (line.trim() && /^ {0,3}=+[ \t]*$/.test(lines[index + 1] ?? '')) {
      found = true;
      return false;
    }
  });
  return found;
}

export function buildXArticlePreviewMarkdown(
  source: string,
  options: XArticlePreviewMarkdownOptions = {},
): string {
  return buildXArticlePreviewDocument(source, options).markdown;
}

export function buildXArticlePreviewDocument(
  source: string,
  options: XArticlePreviewMarkdownOptions = {},
): XArticlePreviewDocument {
  const normalized = normalizeLineEndings(source);
  const split = splitXArticleFrontmatter(normalized);
  const stripFrontmatter = options.stripFrontmatter !== false;
  const base = stripFrontmatter ? split.body : normalized;
  const baseStartLine = stripFrontmatter && split.hadFrontmatter ? split.bodyStartLine : 0;
  const leadingLength = base.length - base.trimStart().length;
  const leadingLineCount = (base.slice(0, leadingLength).match(/\n/g) ?? []).length;
  let markdown = sanitizeXArticlePreviewRemoteMedia(base.trim());
  let sourceLineMap = markdown
    ? markdown.split('\n').map((_, index) => baseStartLine + leadingLineCount + index)
    : [];

  const filenameTitle = filenameToXArticleTitle(options.filename);
  if (options.useFilenameAsTitle && filenameTitle && !hasXArticleH1(markdown)) {
    markdown = markdown ? `# ${filenameTitle}\n\n${markdown}` : `# ${filenameTitle}`;
    const firstSourceLine = sourceLineMap[0] ?? baseStartLine;
    sourceLineMap = markdown.includes('\n')
      ? [firstSourceLine, firstSourceLine, ...sourceLineMap]
      : [firstSourceLine];
  }
  return { markdown, sourceLineMap };
}

export const normalizeXArticleMarkdown = buildXArticlePreviewMarkdown;

function decodeCommonHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
}

export function markdownInlineToPlainText(source: string): string {
  return decodeCommonHtmlEntities(source)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, '$2')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias ?? target)
    .replace(/<https?:\/\/[^>]+>/gi, match => match.slice(1, -1))
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/(^|[^\\])[*_](?!\s)(.*?)(?<!\s)[*_]/g, '$1$2')
    .replace(/\\([^\w\s])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function headingText(markdown: string, targetLevel: number): string | null {
  let result: string | null = null;
  forEachMarkdownTextLine(markdown, (line, index, lines) => {
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (atx?.[1].length === targetLevel) {
      result = markdownInlineToPlainText(atx[2]);
      return false;
    }
    const setext = lines[index + 1] ?? '';
    const isTarget = targetLevel === 1
      ? /^ {0,3}=+[ \t]*$/.test(setext)
      : targetLevel === 2 && /^ {0,3}-+[ \t]*$/.test(setext);
    if (line.trim() && isTarget) {
      result = markdownInlineToPlainText(line.trim());
      return false;
    }
  });
  return result || null;
}

function frontmatterString(
  frontmatter: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!frontmatter) return null;
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export function getXArticleFrontmatterString(
  frontmatter: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | null {
  const formatter = frontmatter?.formatter;
  if (formatter && typeof formatter === 'object' && !Array.isArray(formatter)) {
    const formatterValue = frontmatterString(formatter as Record<string, unknown>, keys);
    if (formatterValue) return formatterValue;
  }
  return frontmatterString(frontmatter, keys);
}

export function extractXArticleTitle(
  markdown: string,
  options: Pick<XArticleHeroOptions, 'filename' | 'frontmatter'> = {},
): string {
  return filenameToXArticleTitle(options.filename)
    || getXArticleFrontmatterString(options.frontmatter, ['title', 'Title'])
    || headingText(markdown, 1)
    || headingText(markdown, 2)
    || '';
}

function normalizeImageDestination(value: string): string {
  const trimmed = value.trim();
  const angleMatch = /^<([^>]+)>$/.exec(trimmed);
  return (angleMatch?.[1] ?? trimmed).trim();
}

export function normalizeXArticleCoverValue(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const trimmed = value.trim();
  const wikiImage = /^!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(trimmed);
  if (wikiImage) return wikiImage[1].trim() || null;
  const markdownImage = /^!\[[^\]]*\]\(([\s\S]+)\)$/.exec(trimmed);
  if (markdownImage) {
    const target = markdownImage[1].trim();
    const angleTarget = /^<([^>]+)>(?:\s+.*)?$/.exec(target)?.[1];
    const withoutTitle = target.replace(/\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/, '');
    return normalizeImageDestination(angleTarget ?? withoutTitle) || null;
  }
  return normalizeImageDestination(trimmed) || null;
}

export function extractFirstXArticleImage(markdown: string): XArticleMarkdownImage | null {
  let image: XArticleMarkdownImage | null = null;
  forEachMarkdownTextLine(markdown, line => {
    const wiki = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(line);
    if (wiki) {
      image = { alt: (wiki[2] ?? '').trim(), src: wiki[1].trim() };
      return false;
    }
    const standard = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/.exec(line);
    if (standard) {
      image = {
        alt: standard[1].trim(),
        src: normalizeImageDestination(standard[2] ?? standard[3]),
      };
      return false;
    }
  });
  return image;
}

export function extractXArticleCover(
  markdown: string,
  frontmatter?: Record<string, unknown> | null,
): string | null {
  const explicitXCover = frontmatterString(frontmatter, ['x_cover']);
  const configured = explicitXCover
    ?? getXArticleFrontmatterString(frontmatter, ['cover', 'Cover']);
  return normalizeXArticleCoverValue(configured) ?? extractFirstXArticleImage(markdown)?.src ?? null;
}

function isStandaloneMarkdownImage(line: string): boolean {
  return /^\s*(?:!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\])\s*$/.test(line);
}

function isStandaloneXPostLine(line: string): boolean {
  const trimmed = line.trim();
  if (X_POST_URL_PATTERN.test(trimmed)) return true;
  const link = /^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/.exec(trimmed);
  return Boolean(link && X_POST_URL_PATTERN.test(link[1]));
}

export function extractXArticleHeroSummary(
  markdown: string,
  targetLength = DEFAULT_SUMMARY_TARGET_LENGTH,
): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inTable = false;

  const flush = (): boolean => {
    const text = markdownInlineToPlainText(current.join(' '));
    current = [];
    if (!text) return false;
    paragraphs.push(text);
    return paragraphs.join('\n\n').length >= Math.max(1, targetLength);
  };

  forEachMarkdownTextLine(stripXArticleFrontmatter(markdown), (rawLine, index, lines) => {
    const line = rawLine.trim();
    if (!line) {
      inTable = false;
      return flush() ? false : undefined;
    }
    if (/^ {0,3}(?:#{1,6})[ \t]+/.test(rawLine)) return;
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(rawLine)) {
      current = [];
      return;
    }
    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(rawLine)) return;
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1] ?? '')) {
      inTable = true;
      current = [];
      return;
    }
    if (inTable || /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+/.test(rawLine)) return;
    if (isStandaloneMarkdownImage(line) || isStandaloneXPostLine(line)) return;
    if (/^\s*<(?:img|iframe|table)\b/i.test(rawLine)) return;

    const content = rawLine
      .replace(/^\s{0,3}>[ \t]?/, '')
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])[ \t]+/, '')
      .replace(/^\[[ xX]\][ \t]+/, '');
    current.push(content);
  });
  flush();

  const selected: string[] = [];
  for (const paragraph of paragraphs) {
    selected.push(paragraph);
    if (selected.join('\n\n').length >= Math.max(1, targetLength)) break;
  }
  return selected.join('\n\n').trim();
}

export function buildXArticleHero(
  markdown: string,
  options: XArticleHeroOptions = {},
): XArticleHero {
  return {
    title: extractXArticleTitle(markdown, options),
    cover: extractXArticleCover(markdown, options.frontmatter),
    summary: extractXArticleHeroSummary(markdown, options.summaryTargetLength)
      || options.fallbackSummary?.trim()
      || '',
  };
}
