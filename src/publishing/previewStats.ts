import {
  markdownInlineToPlainText,
  splitXArticleFrontmatter,
} from '../xArticle/preview';
import {
  consumeXArticleMarkdownFence,
  xArticleMarkdownFenceState,
} from '../xArticle/markdownFence';

export interface PublishingPreviewStats {
  bodyImageCount: number;
  coverImageCount: 0 | 1;
  visibleTextLength: number;
}

export interface PublishingPreviewStatsOptions {
  bodyCoverTarget?: string | null;
  hasCover?: boolean;
  title?: string | null;
}

interface MarkdownImageToken {
  end: number;
  start: number;
  target: string;
}

function decodeImageTarget(value: string): string {
  let target = value.trim();
  if (target.startsWith('<')) {
    const close = target.indexOf('>');
    if (close > 0) target = target.slice(1, close);
  } else {
    const title = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(target);
    if (title) target = target.slice(0, title.index);
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function markdownImageTokens(line: string): MarkdownImageToken[] {
  const tokens: MarkdownImageToken[] = [];
  for (let index = 0; index < line.length - 2; index += 1) {
    if (line[index] !== '!' || line[index + 1] !== '[') continue;
    if (line[index + 2] === '[') {
      const close = line.indexOf(']]', index + 3);
      if (close < 0) continue;
      const immediateSuffix = line[close + 2] ?? '';
      if (immediateSuffix !== '(' && immediateSuffix !== '[') {
        const target = line.slice(index + 3, close).split('|', 1)[0].trim();
        if (target) tokens.push({ start: index, end: close + 2, target });
        index = close + 1;
        continue;
      }
    }
    let altClose = -1;
    let destinationOpen = -1;
    let searchFrom = index + 2;
    while (searchFrom < line.length) {
      const candidate = line.indexOf(']', searchFrom);
      if (candidate < 0) break;
      let open = candidate + 1;
      while (/[ \t]/.test(line[open] ?? '')) open += 1;
      if (line[open] === '(') {
        altClose = candidate;
        destinationOpen = open;
        break;
      }
      searchFrom = candidate + 1;
    }
    if (altClose < 0 || destinationOpen < 0) continue;
    let cursor = destinationOpen + 1;
    let depth = 1;
    let escaped = false;
    for (; cursor < line.length; cursor += 1) {
      const character = line[cursor];
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    const target = decodeImageTarget(line.slice(destinationOpen + 1, cursor));
    if (target) tokens.push({ start: index, end: cursor + 1, target });
    index = cursor;
  }
  return tokens;
}

export function normalizePublishingImageTarget(value: string): string {
  const decoded = decodeImageTarget(value)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
  return decoded.normalize('NFC');
}

export function publishingImageTargetsMatch(left: string, right: string): boolean {
  return normalizePublishingImageTarget(left) === normalizePublishingImageTarget(right);
}

function normalizedVisibleText(value: string): string {
  return value.replace(/[\s\u200b\ufeff]+/gu, ' ').trim();
}

function stripVisibleBlockMarkers(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}[ \t]+/, '')
    .replace(/^\s{0,3}>[ \t]?/, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])[ \t]+/, '')
    .replace(/^\[[ xX]\][ \t]+/, '')
    .replace(/\|/g, ' ');
}

function visibleLineText(line: string, tokens: readonly MarkdownImageToken[]): string {
  let withoutImages = line;
  for (const token of [...tokens].reverse()) {
    withoutImages = withoutImages.slice(0, token.start) + withoutImages.slice(token.end);
  }
  withoutImages = withoutImages
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
  return normalizedVisibleText(markdownInlineToPlainText(stripVisibleBlockMarkers(withoutImages)));
}

/**
 * Produces the compact counters shown by every local publishing preview.
 * The calculation is deliberately platform-neutral: frontmatter, Markdown
 * syntax, image paths and formatting whitespace do not count as article text.
 */
export function buildPublishingPreviewStats(
  markdown: string,
  options: PublishingPreviewStatsOptions = {},
): PublishingPreviewStats {
  const body = splitXArticleFrontmatter(markdown).body
    .replace(/<!--[\s\S]*?-->/g, '');
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const fence = xArticleMarkdownFenceState();
  const imageTargets: string[] = [];
  const visibleSegments: string[] = [];
  const normalizedTitle = normalizedVisibleText(options.title ?? '');
  let skipSetextUnderline = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (consumeXArticleMarkdownFence(line, fence)) continue;
    if (skipSetextUnderline) {
      skipSetextUnderline = false;
      continue;
    }
    if (fence.character) {
      const code = normalizedVisibleText(line);
      if (code) visibleSegments.push(code);
      continue;
    }
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue;
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line)) continue;
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) continue;

    const tokens = markdownImageTokens(line);
    imageTargets.push(...tokens.map(token => token.target));
    imageTargets.push(...Array.from(line.matchAll(/<img\b[^>]*>/gi), match => {
      const source = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
      return source?.[1] ?? source?.[2] ?? source?.[3] ?? '';
    }).filter(Boolean));

    const text = visibleLineText(line, tokens);
    const isHeading = /^\s{0,3}#{1,3}[ \t]+/.test(line);
    const isSetextTitle = Boolean(text)
      && /^\s{0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1] ?? '');
    if (normalizedTitle && text === normalizedTitle && (isHeading || isSetextTitle)) {
      skipSetextUnderline = isSetextTitle;
      continue;
    }
    if (text) visibleSegments.push(text);
  }

  const bodyCoverTarget = options.bodyCoverTarget?.trim() ?? '';
  const coverIndex = bodyCoverTarget
    ? imageTargets.findIndex(target => publishingImageTargetsMatch(target, bodyCoverTarget))
    : -1;
  const compactVisibleText = normalizedVisibleText(visibleSegments.join(' ')).replace(/\s/gu, '');
  return {
    bodyImageCount: Math.max(0, imageTargets.length - (coverIndex >= 0 ? 1 : 0)),
    coverImageCount: options.hasCover ? 1 : 0,
    visibleTextLength: Array.from(compactVisibleText).length,
  };
}
