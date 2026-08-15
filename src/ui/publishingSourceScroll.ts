import type { MarkdownPostProcessorContext } from 'obsidian';

export interface PublishingEditorScrollPosition {
  filePath: string;
  line: number;
  lineProgress: number;
  lineCount: number;
  sequence: number;
}

export interface PublishingSourceAnchor {
  startLine: number;
  endLine: number;
  top: number;
}

export interface PublishingSourceScrollViewport {
  scrollHeight: number;
  clientHeight: number;
}

type PublishingEditorScrollInput = Omit<PublishingEditorScrollPosition, 'sequence'>;
type PublishingEditorScrollListener = (position: PublishingEditorScrollPosition) => void;

const SOURCE_LINE_START_ATTRIBUTE = 'data-ailu-source-line-start';
const SOURCE_LINE_END_ATTRIBUTE = 'data-ailu-source-line-end';
const SOURCE_LINE_MARKER_ATTRIBUTE = 'data-ailu-source-line-marker';
const SOURCE_LINE_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,table,figure';
const PREVIEW_TOP_INSET = 12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function translatedSourceLine(line: number, sourceLineMap: readonly number[] | undefined): number {
  const normalized = Math.max(0, Math.floor(line));
  if (!sourceLineMap?.length) return normalized;
  const mapped = sourceLineMap[Math.min(normalized, sourceLineMap.length - 1)];
  return Number.isFinite(mapped) ? Math.max(0, mapped) : normalized;
}

function appendPublishingSourceMarker(line: string, sourceLine: number): string {
  const marker = `<span ${SOURCE_LINE_MARKER_ATTRIBUTE}="${sourceLine}"></span>`;
  const hardBreakSpaces = line.match(/ {2,}$/)?.[0];
  if (hardBreakSpaces) {
    return `${line.slice(0, -hardBreakSpaces.length)}${marker}${hardBreakSpaces}`;
  }
  if (line.endsWith('\\')) return `${line.slice(0, -1)}${marker}\\`;
  return `${line}${marker}`;
}

function isUnescapedMarkdownPipe(line: string, index: number): boolean {
  if (line[index] !== '|') return false;
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function isMarkdownTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|')
    && /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(trimmed);
}

function isPotentialMarkdownTableRow(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (isUnescapedMarkdownPipe(line, index)) return true;
  }
  return false;
}

function collectMarkdownTableRows(lines: readonly string[]): Set<number> {
  const rows = new Set<number>();
  for (const [index, line] of lines.entries()) {
    if (!isMarkdownTableDelimiter(line)) continue;
    if (index > 0 && isPotentialMarkdownTableRow(lines[index - 1])) {
      rows.add(index - 1);
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (!isPotentialMarkdownTableRow(lines[cursor])) break;
      rows.add(cursor);
    }
  }
  return rows;
}

function appendPublishingTableSourceMarker(line: string, sourceLine: number): string {
  const marker = `<span ${SOURCE_LINE_MARKER_ATTRIBUTE}="${sourceLine}"></span>`;
  let trailingIndex = line.length - 1;
  while (trailingIndex >= 0 && /[ \t]/.test(line[trailingIndex])) trailingIndex -= 1;
  if (trailingIndex >= 0 && isUnescapedMarkdownPipe(line, trailingIndex)) {
    return `${line.slice(0, trailingIndex)}${marker}${line.slice(trailingIndex)}`;
  }
  return appendPublishingSourceMarker(line, sourceLine);
}

function isMarkdownStructureLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || /^(?:=+|-+)\s*$/.test(trimmed)) return true;
  if (/^(?:\*\s*){3,}$/.test(trimmed) || /^(?:_\s*){3,}$/.test(trimmed)) return true;
  if (/^\[[^\]]+\]:\s*/.test(trimmed)) return true;
  return isMarkdownTableDelimiter(trimmed);
}

/**
 * Adds zero-size inline markers without changing Markdown line counts. Obsidian
 * does not expose section information for every static MarkdownRenderer call,
 * so the publishing previews materialize these markers into durable block
 * anchors immediately after rendering and then remove them.
 */
export function instrumentPublishingMarkdown(
  markdown: string,
  sourceLineMap?: readonly number[],
): string {
  const lines = markdown.split(/\r?\n/);
  const tableRows = collectMarkdownTableRows(lines);
  let fence: { character: '`' | '~'; length: number } | null = null;
  return lines.map((line, index) => {
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
    if (/^(?: {4}|\t)/.test(line) || isMarkdownStructureLine(line)) return line;
    const sourceLine = translatedSourceLine(index, sourceLineMap);
    return tableRows.has(index)
      ? appendPublishingTableSourceMarker(line, sourceLine)
      : appendPublishingSourceMarker(line, sourceLine);
  }).join('\n');
}

/** Converts rendered inline markers into source ranges on their nearest block. */
export function materializePublishingSourceMarkers(article: HTMLElement): number {
  const ranges = new Map<HTMLElement, { startLine: number; endLine: number }>();
  const markers = Array.from(article.querySelectorAll<HTMLElement>(
    `[${SOURCE_LINE_MARKER_ATTRIBUTE}]`,
  ));
  for (const marker of markers) {
    const line = Number(marker.getAttribute(SOURCE_LINE_MARKER_ATTRIBUTE));
    const closest = marker.closest<HTMLElement>(SOURCE_LINE_BLOCK_SELECTOR);
    const target = closest && article.contains(closest)
      ? closest
      : marker.parentElement && marker.parentElement !== article && article.contains(marker.parentElement)
        ? marker.parentElement
        : null;
    if (target && Number.isFinite(line)) {
      const normalized = Math.max(0, Math.floor(line));
      const range = ranges.get(target);
      if (range) {
        range.startLine = Math.min(range.startLine, normalized);
        range.endLine = Math.max(range.endLine, normalized);
      } else {
        ranges.set(target, { startLine: normalized, endLine: normalized });
      }
    }
    marker.remove();
  }
  for (const [target, range] of ranges) {
    target.setAttribute(SOURCE_LINE_START_ATTRIBUTE, String(range.startLine));
    target.setAttribute(SOURCE_LINE_END_ATTRIBUTE, String(range.endLine));
  }
  return ranges.size;
}

export class PublishingEditorScrollSync {
  private readonly sources = new Map<number, PublishingEditorScrollPosition>();
  private readonly listeners = new Set<PublishingEditorScrollListener>();
  private nextSourceId = 1;
  private nextSequence = 1;

  registerSource(): number {
    const sourceId = this.nextSourceId;
    this.nextSourceId += 1;
    return sourceId;
  }

  unregisterSource(sourceId: number): void {
    this.sources.delete(sourceId);
  }

  publish(sourceId: number, input: PublishingEditorScrollInput): PublishingEditorScrollPosition {
    const lineCount = Math.max(1, Math.floor(input.lineCount));
    const position: PublishingEditorScrollPosition = {
      filePath: input.filePath,
      line: clamp(Math.floor(input.line), 0, lineCount - 1),
      lineProgress: clamp(input.lineProgress, 0, 1),
      lineCount,
      sequence: this.nextSequence,
    };
    this.nextSequence += 1;
    this.sources.set(sourceId, position);
    for (const listener of this.listeners) listener(position);
    return position;
  }

  latest(filePath: string): PublishingEditorScrollPosition | null {
    let latest: PublishingEditorScrollPosition | null = null;
    for (const position of this.sources.values()) {
      if (position.filePath !== filePath) continue;
      if (!latest || position.sequence > latest.sequence) latest = position;
    }
    return latest;
  }

  subscribe(listener: PublishingEditorScrollListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function annotatePublishingSourceSection(
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
): void {
  if (!element.closest('.ailu-publishing-article')) return;
  const section = context.getSectionInfo(element);
  if (!section) return;
  element.setAttribute(SOURCE_LINE_START_ATTRIBUTE, String(section.lineStart));
  element.setAttribute(SOURCE_LINE_END_ATTRIBUTE, String(section.lineEnd));
}

export function collectPublishingSourceAnchors(
  viewport: HTMLElement,
  article: HTMLElement,
  sourceLineMap?: readonly number[],
): PublishingSourceAnchor[] {
  const viewportBounds = viewport.getBoundingClientRect();
  const anchors: PublishingSourceAnchor[] = [];
  for (const element of Array.from(article.querySelectorAll<HTMLElement>(
    `[${SOURCE_LINE_START_ATTRIBUTE}][${SOURCE_LINE_END_ATTRIBUTE}]`,
  ))) {
    const rawStart = Number(element.getAttribute(SOURCE_LINE_START_ATTRIBUTE));
    const rawEnd = Number(element.getAttribute(SOURCE_LINE_END_ATTRIBUTE));
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.height <= 0) continue;
    anchors.push({
      startLine: translatedSourceLine(rawStart, sourceLineMap),
      endLine: translatedSourceLine(Math.max(rawStart, rawEnd), sourceLineMap),
      top: viewport.scrollTop + bounds.top - viewportBounds.top,
    });
  }
  anchors.sort((left, right) => left.startLine - right.startLine || left.top - right.top);
  const deduplicated: PublishingSourceAnchor[] = [];
  for (const anchor of anchors) {
    const previous = deduplicated.at(-1);
    if (previous?.startLine === anchor.startLine) {
      previous.endLine = Math.max(previous.endLine, anchor.endLine);
      previous.top = Math.min(previous.top, anchor.top);
      continue;
    }
    deduplicated.push({ ...anchor });
  }
  return deduplicated;
}

export function resolvePublishingSourceScrollTop(
  position: Pick<PublishingEditorScrollPosition, 'line' | 'lineProgress' | 'lineCount'>,
  viewport: PublishingSourceScrollViewport,
  anchors: readonly PublishingSourceAnchor[],
): number {
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const maxLine = Math.max(0, position.lineCount - 1);
  if (maxTop <= 0 || maxLine <= 0) return 0;
  const sourcePosition = clamp(position.line + position.lineProgress, 0, maxLine);
  const points: Array<{ line: number; top: number }> = [{ line: 0, top: 0 }];
  for (const anchor of anchors) {
    const line = clamp(anchor.startLine, 0, maxLine);
    if (line <= 0 || line >= maxLine) continue;
    const top = clamp(anchor.top - PREVIEW_TOP_INSET, 0, maxTop);
    const previous = points.at(-1);
    if (!previous) continue;
    if (previous.line === line) {
      previous.top = Math.min(previous.top, top);
      continue;
    }
    points.push({ line, top: Math.max(previous.top, top) });
  }
  points.push({ line: maxLine, top: maxTop });

  for (let index = 1; index < points.length; index += 1) {
    const end = points[index];
    if (sourcePosition > end.line) continue;
    const start = points[index - 1];
    const lineSpan = Math.max(1, end.line - start.line);
    const progress = clamp((sourcePosition - start.line) / lineSpan, 0, 1);
    return start.top + (end.top - start.top) * progress;
  }
  return maxTop;
}
