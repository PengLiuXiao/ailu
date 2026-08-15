import { createHash, randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { markdownFilenameTitle } from '../publishing/sourceTitle';
import {
  consumeXArticleMarkdownFence,
  xArticleMarkdownFenceState,
} from './markdownFence';

import type {
  PrepareXArticleMarkdownOptions,
  PreparedXArticleMarkdown,
  XArticleFormatterMetadata,
  XArticleImageReference,
  XArticleOmittedImage,
  XArticleResolvedImage,
} from './types';

interface FrontmatterRange {
  bodyStart: number;
  text: string;
}

interface ImageToken {
  start: number;
  end: number;
  alt: string;
  target: string;
  kind: 'markdown' | 'wikilink';
}

export interface XArticleCoverSources {
  configuredTarget: string | null;
  leadingTarget: string | null;
}

const defaultFileSystem = {
  mkdir: (target: string, options: { recursive: true; mode: number }) => fs.mkdir(target, options).then(() => undefined),
  writeFile: (
    target: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number },
  ) => fs.writeFile(target, data, options).then(() => undefined),
  chmod: (target: string, mode: number) => fs.chmod(target, mode),
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function frontmatterRange(markdown: string): FrontmatterRange {
  const bomOffset = markdown.startsWith('\uFEFF') ? 1 : 0;
  const opening = markdown.slice(bomOffset).match(/^---[ \t]*\r?\n/);
  if (!opening) return { bodyStart: 0, text: '' };
  const contentStart = bomOffset + opening[0].length;
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(markdown.slice(contentStart));
  if (!closing) return { bodyStart: 0, text: '' };
  return {
    bodyStart: contentStart + closing.index + closing[0].length,
    text: markdown.slice(contentStart, contentStart + closing.index),
  };
}

function yamlScalar(raw: string): string | null {
  let value = raw.trim();
  if (!value || value === 'null' || value === '~') return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'string' ? parsed.trim() || null : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'").trim() || null;
  }
  value = value.replace(/\s+#.*$/, '').trim();
  return value || null;
}

export function parseXArticleFormatter(markdown: string): XArticleFormatterMetadata {
  const { text } = frontmatterRange(markdown);
  if (!text) return { title: null, cover: null };
  const result: XArticleFormatterMetadata = { title: null, cover: null };
  let xCover: string | null = null;
  const lines = text.split(/\r?\n/);
  let formatterIndent: number | null = null;
  for (const line of lines) {
    const match = /^(\s*)([^:#]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '  ').length;
    const key = match[2].trim();
    const raw = match[3];
    if (indent === 0 && key === 'formatter') {
      formatterIndent = raw.trim() ? null : indent;
      continue;
    }
    if (indent === 0 && key === 'x_cover') {
      xCover = yamlScalar(raw);
      continue;
    }
    if (indent === 0 && (key === 'formatter.title' || key === 'formatter.cover')) {
      result[key.endsWith('title') ? 'title' : 'cover'] = yamlScalar(raw);
      continue;
    }
    if (formatterIndent !== null) {
      if (indent <= formatterIndent) {
        formatterIndent = null;
      } else if (key === 'title' || key === 'cover') {
        result[key] = yamlScalar(raw);
      }
    }
  }
  if (xCover) result.cover = xCover;
  return result;
}

function isRemoteTarget(target: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target.trim());
}

function decodeTarget(target: string): string {
  let value = target.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  const titleSuffix = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(value);
  if (titleSuffix) value = value.slice(0, titleSuffix.index);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeLocalPath(target: string): string {
  return encodeURI(target).replace(/[()?#]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function findImageTokens(line: string): ImageToken[] {
  const tokens: ImageToken[] = [];
  for (let index = 0; index < line.length - 2; index += 1) {
    if (line[index] !== '!' || line[index + 1] !== '[') continue;
    if (line[index + 2] === '[') {
      const close = line.indexOf(']]', index + 3);
      if (close < 0) continue;
      const immediateSuffix = line[close + 2] ?? '';
      if (immediateSuffix !== '(' && immediateSuffix !== '[') {
        const inner = line.slice(index + 3, close);
        const pipe = inner.indexOf('|');
        const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
        const alias = pipe < 0 ? '' : inner.slice(pipe + 1).trim();
        tokens.push({
          start: index,
          end: close + 2,
          alt: /^\d+(?:x\d+)?$/i.test(alias) ? '' : alias,
          target,
          kind: 'wikilink',
        });
        index = close + 1;
        continue;
      }
    }
    const altClose = line.indexOf('](', index + 2);
    if (altClose < 0) continue;
    let depth = 1;
    let escaped = false;
    let cursor = altClose + 2;
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
    tokens.push({
      start: index,
      end: cursor + 1,
      alt: line.slice(index + 2, altClose),
      target: decodeTarget(line.slice(altClose + 2, cursor)),
      kind: 'markdown',
    });
    index = cursor;
  }
  return tokens;
}

function coverReference(raw: string, sourcePath: string): XArticleImageReference {
  let value = raw.trim();
  if (value.startsWith('!')) value = value.slice(1);
  const wiki = /^\[\[([^\]]+)\]\]$/.exec(value);
  if (wiki) value = wiki[1].split('|', 1)[0].trim();
  const markdown = /^\[[^\]]*\]\((.*)\)$/.exec(value);
  if (markdown) value = decodeTarget(markdown[1]);
  return {
    sourcePath,
    target: value,
    alt: 'cover',
    kind: 'formatter-cover',
    remote: isRemoteTarget(value),
  };
}

export function inspectXArticleCoverSources(markdown: string): XArticleCoverSources {
  const formatter = parseXArticleFormatter(markdown);
  const range = frontmatterRange(markdown);
  const bodyStart = range.bodyStart || (markdown.startsWith('\uFEFF') ? 1 : 0);
  const firstContentLine = markdown.slice(bodyStart).split(/\r?\n/).find(line => line.trim());
  const leadingToken = firstContentLine
    ? findImageTokens(firstContentLine.trim())[0]
    : undefined;
  return {
    configuredTarget: formatter.cover ? coverReference(formatter.cover, '').target : null,
    leadingTarget: leadingToken?.kind === 'markdown' && leadingToken.start === 0
      ? decodeTarget(leadingToken.target)
      : null,
  };
}

function fallbackBodyTitle(markdown: string): string {
  const { bodyStart } = frontmatterRange(markdown);
  const fence = xArticleMarkdownFenceState();
  for (const line of markdown.slice(bodyStart).split(/\r?\n/)) {
    if (consumeXArticleMarkdownFence(line, fence)) continue;
    if (fence.character) continue;
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) return h1[1].trim();
  }
  return 'Untitled';
}

function leadingImagePath(markdown: string, bodyStart: number, images: XArticleResolvedImage[]): string | null {
  const first = markdown.slice(bodyStart).split(/\r?\n/).find(line => line.trim());
  if (!first) return null;
  const token = findImageTokens(first.trim())[0];
  // The uploader's leading-cover policy treats a standard inline image that
  // opens the first content line as the cover, even when text follows it on
  // the same line (e.g. `![](cover.png)正文...`). Only require it to start at
  // column 0 so the preflight agrees with the Skill's inspect_leading_cover.
  if (!token || token.kind !== 'markdown' || token.start !== 0) return null;
  const decoded = decodeTarget(token.target);
  return images.find(image => encodeLocalPath(image.absolutePath) === token.target || image.absolutePath === decoded)
    ?.absolutePath ?? null;
}

export async function prepareXArticleMarkdown(
  options: PrepareXArticleMarkdownOptions,
): Promise<PreparedXArticleMarkdown> {
  if (!path.isAbsolute(options.sourcePath)) {
    throw new Error('X Article sourcePath must be absolute.');
  }
  const formatter = parseXArticleFormatter(options.markdown);
  const range = frontmatterRange(options.markdown);
  // The Skill receives a disposable publishing copy, not the source note.
  // Strip both the UTF-8 BOM and Obsidian frontmatter after extracting the
  // formatter metadata so YAML can never be pasted into the X editor.
  const bodyStart = range.bodyStart || (options.markdown.startsWith('\uFEFF') ? 1 : 0);
  const bodyLines = options.markdown.slice(bodyStart).split(/\r?\n/);
  const resolvedImages: XArticleResolvedImage[] = [];
  const omittedRemoteImages: XArticleOmittedImage[] = [];
  const fence = xArticleMarkdownFenceState();

  for (let lineIndex = 0; lineIndex < bodyLines.length; lineIndex += 1) {
    const line = bodyLines[lineIndex];
    if (consumeXArticleMarkdownFence(line, fence)) continue;
    if (fence.character) continue;
    const tokens = findImageTokens(line);
    if (!tokens.length) continue;
    let rewritten = '';
    let cursor = 0;
    for (const token of tokens) {
      rewritten += line.slice(cursor, token.start);
      const reference: XArticleImageReference = {
        sourcePath: options.sourcePath,
        target: decodeTarget(token.target),
        alt: token.alt,
        kind: token.kind,
        remote: isRemoteTarget(token.target),
      };
      const resolved = await options.resolveImage(reference);
      if (!resolved) {
        if (reference.remote && options.remoteImagePolicy === 'omit') {
          omittedRemoteImages.push({ ...reference, reason: 'remote-image' });
          cursor = token.end;
          continue;
        }
        throw new Error(`X Article image could not be resolved locally: ${reference.target}`);
      }
      if (!path.isAbsolute(resolved)) {
        throw new Error('X Article image resolver must return an absolute local path.');
      }
      resolvedImages.push({ ...reference, absolutePath: path.normalize(resolved), cover: false });
      rewritten += `![${token.alt.replace(/]/g, '\\]')}](${encodeLocalPath(path.normalize(resolved))})`;
      cursor = token.end;
    }
    bodyLines[lineIndex] = rewritten + line.slice(cursor);
  }

  let body = bodyLines.join('\n');
  let formatterCoverPath: string | null = null;
  if (formatter.cover) {
    const reference = coverReference(formatter.cover, options.sourcePath);
    const resolved = await options.resolveImage(reference);
    if (!resolved) {
      if (reference.remote && options.remoteImagePolicy === 'omit') {
        omittedRemoteImages.push({ ...reference, reason: 'remote-image' });
      } else {
        throw new Error(`X Article cover could not be resolved locally: ${reference.target}`);
      }
    } else {
      if (!path.isAbsolute(resolved)) {
        throw new Error('X Article image resolver must return an absolute local path.');
      }
      formatterCoverPath = path.normalize(resolved);
      const existingLeadingCover = leadingImagePath(body, 0, resolvedImages);
      if (existingLeadingCover === formatterCoverPath) {
        const match = resolvedImages.find(image => image.absolutePath === formatterCoverPath);
        if (match) match.cover = true;
      } else {
        resolvedImages.unshift({ ...reference, absolutePath: formatterCoverPath, cover: true });
        body = `![cover](${encodeLocalPath(formatterCoverPath)})\n\n${body.replace(/^\s+/, '')}`;
      }
    }
  }

  let rewrittenMarkdown = body;
  const coverPath = formatterCoverPath ?? leadingImagePath(
    rewrittenMarkdown,
    0,
    resolvedImages,
  );
  if (coverPath) {
    const match = resolvedImages.find(image => image.absolutePath === coverPath);
    if (match) match.cover = true;
  }
  const title = markdownFilenameTitle(options.sourcePath)
    || formatter.title
    || fallbackBodyTitle(rewrittenMarkdown);
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const directory = options.tempDirectory
    ?? path.join(os.tmpdir(), 'ailu-x-article');
  await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(directory, 0o700);
  const id = (options.randomId ?? randomUUID)();
  const safeTitle = title.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60)
    || 'article';
  const outputPath = path.join(directory, `${safeTitle}-${id}.md`);
  rewrittenMarkdown = rewrittenMarkdown.endsWith('\n') ? rewrittenMarkdown : `${rewrittenMarkdown}\n`;
  await fileSystem.writeFile(outputPath, rewrittenMarkdown, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await fileSystem.chmod(outputPath, 0o600);

  return {
    sourcePath: options.sourcePath,
    sourceContentHash: sha256(options.markdown),
    contentHash: sha256(rewrittenMarkdown),
    path: outputPath,
    title,
    coverPath,
    formatter,
    rewrittenMarkdown,
    resolvedImages,
    assetDigests: [],
    omittedRemoteImages,
  };
}
