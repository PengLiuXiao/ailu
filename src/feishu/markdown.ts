import { createHash } from 'crypto';
import path from 'path';

import type { ShareSnapshot } from '../share/types';
import { reconcileSourceLineMap } from '../share/sourceLineMap';
import { PROTOCOL_IDS } from '../ids';
import type { FeishuAssetDraft, FeishuSnapshot } from './types';

const SHARE_ASSET_SCHEME = escapeRegExp(PROTOCOL_IDS.shareAssetScheme);
const SHARE_ASSET_IMAGE_PATTERN = new RegExp(
  String.raw`!\[([^\]]*)\]\((${SHARE_ASSET_SCHEME}[a-f0-9]+)\)`,
  'gi',
);

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const MARKDOWN_TITLE_ESCAPE_PATTERN = /[\\`*_[\]<>#]/g;

function normalizeFeishuTitle(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function escapeFeishuPreviewTitle(value: string): string {
  return value.replace(MARKDOWN_TITLE_ESCAPE_PATTERN, character => `\\${character}`);
}

function unescapeFeishuPreviewTitle(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '\\' && index + 1 < value.length) {
      output += value[index + 1];
      index += 1;
    } else {
      output += value[index];
    }
  }
  return output;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function containsUnescapedTitleTag(line: string): boolean {
  for (const match of line.matchAll(/<\/?(?:title|h1)\b/gi)) {
    let backslashes = 0;
    for (let index = (match.index ?? 0) - 1; index >= 0 && line[index] === '\\'; index -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return true;
  }
  return false;
}

function assertFeishuBodyHasNoDocumentTitle(bodyMarkdown: string): void {
  let fence: { character: '`' | '~'; length: number } | null = null;
  let previousLine = '';
  for (const line of bodyMarkdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMatch
        && fenceMatch[1][0] === fence.character
        && fenceMatch[1].length >= fence.length
        && !fenceMatch[2].trim()
      ) fence = null;
      previousLine = line;
      continue;
    }
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
      };
      previousLine = line;
      continue;
    }
    if (/^ {0,3}#(?:[ \t]+|$)/.test(line)
      || (/^ {0,3}=+[ \t]*$/.test(line) && previousLine.trim())
      || containsUnescapedTitleTag(line)) {
      throw new Error('飞书发布正文不能包含第二个文档大标题。');
    }
    previousLine = line;
  }
}

export interface FeishuDocumentMarkdownPayload {
  title: string;
  bodyMarkdown: string;
}

/**
 * Split the local-only preview document into its plain title and remote body.
 * The preview contract is deliberately canonical so a malformed or injected
 * title can never silently become a different Feishu write payload.
 */
export function splitFeishuPreviewMarkdown(markdown: string): FeishuDocumentMarkdownPayload {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const firstNewline = normalized.indexOf('\n');
  const titleLine = firstNewline >= 0 ? normalized.slice(0, firstNewline) : normalized;
  const encodedTitle = titleLine.startsWith('# ') ? titleLine.slice(2) : '';
  const title = normalizeFeishuTitle(unescapeFeishuPreviewTitle(encodedTitle));
  if (!title || titleLine !== `# ${escapeFeishuPreviewTitle(title)}`) {
    throw new Error('飞书发布内容缺少唯一、可验证的文档标题。');
  }

  let bodyStart = firstNewline >= 0 ? firstNewline + 1 : normalized.length;
  if (normalized[bodyStart] === '\n') bodyStart += 1;
  const bodyMarkdown = normalized.slice(bodyStart);
  assertFeishuBodyHasNoDocumentTitle(bodyMarkdown);
  return { title, bodyMarkdown };
}

export function buildFeishuCreatePayload(
  previewMarkdown: string,
  explicitTitle: string,
): FeishuDocumentMarkdownPayload {
  const payload = splitFeishuPreviewMarkdown(previewMarkdown);
  const title = normalizeFeishuTitle(explicitTitle);
  if (!title || title !== payload.title) {
    throw new Error('飞书文档标题与已确认的预览不一致，已停止发布。');
  }
  return payload;
}

/**
 * lark-cli 1.0.72 has no update --title flag. Its version-matched Markdown
 * contract explicitly supports XML blocks, so one overwrite request carries
 * exactly one escaped <title> plus the title-free Markdown body.
 */
export function buildFeishuUpdatePayload(previewMarkdown: string): string {
  const payload = splitFeishuPreviewMarkdown(previewMarkdown);
  return `<title>${escapeXmlText(payload.title)}</title>\n${payload.bodyMarkdown}`;
}

export function demoteMarkdownHeadings(source: string): string {
  let fence: { character: '`' | '~'; length: number } | null = null;
  return source
    .split(/\r?\n/)
    .map((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          fenceMatch
          && fenceMatch[1][0] === fence.character
          && fenceMatch[1].length >= fence.length
          && !fenceMatch[2].trim()
        ) fence = null;
        return line;
      }
      if (fenceMatch) {
        fence = {
          character: fenceMatch[1][0] as '`' | '~',
          length: fenceMatch[1].length,
        };
        return line;
      }
      const atxDemoted = line.replace(/^(#{1,5})(\s+)/, (_match, hashes: string, spacing: string) => (
        `${hashes}#${spacing}`
      ));
      return /^ {0,3}=+[ \t]*$/.test(atxDemoted)
        ? atxDemoted.replace(/=/g, '-')
        : atxDemoted;
    })
    .join('\n');
}

/**
 * Convert the shared snapshot to Feishu Markdown. Every image marker is placed
 * in its own paragraph because the CLI later replaces that whole block with an
 * uploaded image.
 */
export function buildFeishuMarkdown(
  title: string,
  shareSnapshot: ShareSnapshot,
): { markdown: string; assets: FeishuAssetDraft[]; sourceLineMap: number[] } {
  const normalizedTitle = normalizeFeishuTitle(title);
  if (!normalizedTitle) throw new Error('飞书文档标题不能为空。');
  const draftsByToken = new Map(shareSnapshot.assets.map(asset => [asset.token, asset]));
  const assets: FeishuAssetDraft[] = [];
  const inputLines = shareSnapshot.markdown.split(/\r?\n/);
  const inputSourceLineMap = reconcileSourceLineMap(
    shareSnapshot.markdown,
    shareSnapshot.sourceLineMap ?? [],
  );
  const bodyLines: string[] = [];
  const expandedSourceLineMap: number[] = [];
  for (const [lineIndex, line] of inputLines.entries()) {
    const sourceLine = inputSourceLineMap[lineIndex] ?? lineIndex;
    const replaced = line.replace(
      SHARE_ASSET_IMAGE_PATTERN,
      (match, rawAlt: string, token: string) => {
        const draft = draftsByToken.get(token);
        if (!draft) return match;
        const index = assets.length + 1;
        const placeholder = `${PROTOCOL_IDS.feishuImagePlaceholderPrefix}${String(index).padStart(4, '0')}_${draft.contentHash.slice(0, 12)}`;
        assets.push({
          placeholder,
          vaultPath: draft.vaultPath,
          fileName: draft.fileName,
          mimeType: draft.mimeType,
          contentHash: draft.contentHash,
          alt: rawAlt.trim() || path.posix.basename(draft.vaultPath),
          body: draft.body,
        });
        return `\n\n${placeholder}\n\n`;
      },
    );
    const replacedLines = replaced.split('\n');
    bodyLines.push(...replacedLines);
    expandedSourceLineMap.push(...replacedLines.map(() => sourceLine));
  }

  const demotedLines = demoteMarkdownHeadings(bodyLines.join('\n')).split('\n');
  let firstBodyLine = demotedLines.findIndex(line => line.trim().length > 0);
  if (firstBodyLine < 0) firstBodyLine = 0;
  let lastBodyLine = demotedLines.length - 1;
  while (lastBodyLine > firstBodyLine && !demotedLines[lastBodyLine].trim()) {
    lastBodyLine -= 1;
  }
  const bodyMarkdown = demotedLines.slice(firstBodyLine, lastBodyLine + 1).join('\n');
  const bodySourceLineMap = bodyMarkdown
    ? expandedSourceLineMap.slice(firstBodyLine, lastBodyLine + 1)
    : [expandedSourceLineMap[firstBodyLine] ?? 0];
  const previewTitle = `# ${escapeFeishuPreviewTitle(normalizedTitle)}`;
  const markdown = `${previewTitle}\n\n${bodyMarkdown}\n`;
  const titlePrefixLineCount = (`${previewTitle}\n\n`.match(/\n/g) ?? []).length;
  const finalSourceLine = bodySourceLineMap.at(-1) ?? 0;
  return {
    markdown,
    assets,
    sourceLineMap: [
      ...Array.from({ length: titlePrefixLineCount }, () => 0),
      ...bodySourceLineMap,
      finalSourceLine,
    ],
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hashFeishuSnapshot(
  title: string,
  markdown: string,
  assets: FeishuAssetDraft[],
): string {
  return hashValue(JSON.stringify({
    title,
    markdown,
    assets: assets.map((asset) => ({
      placeholder: asset.placeholder,
      contentHash: asset.contentHash,
    })),
  }));
}

export function withFeishuSnapshotTitle(
  snapshot: FeishuSnapshot,
  rawTitle: string,
): FeishuSnapshot {
  const title = normalizeFeishuTitle(rawTitle) || snapshot.title;
  const current = splitFeishuPreviewMarkdown(snapshot.markdown);
  const markdown = `# ${escapeFeishuPreviewTitle(title)}\n\n${current.bodyMarkdown}`;
  return {
    ...snapshot,
    title,
    markdown,
    contentHash: hashFeishuSnapshot(title, markdown, snapshot.assets),
  };
}
