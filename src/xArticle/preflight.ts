import path from 'path';

import {
  consumeXArticleMarkdownFence,
  xArticleMarkdownFenceState,
} from './markdownFence';
import {
  scanXArticleMarkdownImageTokens,
} from './preview';

import {
  X_ARTICLE_CONTENT_LENGTH_UNIT,
  X_ARTICLE_COVER_RATIO,
  X_ARTICLE_MAX_BODY_MEDIA,
  type XArticleMediaPlacement,
  type XArticlePreflight,
  type XArticlePreflightAnchor,
  type XArticlePreflightIssue,
  type XArticlePreflightTable,
} from './types';

export class XArticlePreflightValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XArticlePreflightValidationError';
  }
}

export interface XArticleUnsupportedDivider {
  line: number;
  text: string;
}

export interface XArticleUnsupportedRawHtml {
  line: number;
  tag: string;
  text: string;
}

export interface XArticleUnsupportedReferenceImage {
  line: number;
  label: string;
  text: string;
}

export function findUnsupportedXArticleReferenceImages(
  markdown: string,
): XArticleUnsupportedReferenceImage[] {
  const source = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const frontmatterEnd = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)$/.test(line.trim()))
    : -1;
  const fence = xArticleMarkdownFenceState();
  const maskedLines: string[] = [];
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    const inFrontmatter = frontmatterEnd >= 0 && offset <= frontmatterEnd;
    const delimiter = !inFrontmatter && consumeXArticleMarkdownFence(line, fence);
    maskedLines.push(inFrontmatter || delimiter || fence.character ? ' '.repeat(line.length) : line);
  }

  const masked = maskedLines.join('\n');
  const found: XArticleUnsupportedReferenceImage[] = [];
  let currentLine = 1;
  let previousIndex = 0;
  for (const token of scanXArticleMarkdownImageTokens(masked)) {
    currentLine += (masked.slice(previousIndex, token.start).match(/\n/g) ?? []).length;
    previousIndex = token.start;
    if (token.kind === 'inline' || token.kind === 'wiki') continue;
    found.push({
      line: currentLine,
      label: token.referenceLabel,
      text: source.slice(token.start, token.end + 1),
    });
  }
  return found;
}

export function findUnsupportedXArticleDividers(markdown: string): XArticleUnsupportedDivider[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const found: XArticleUnsupportedDivider[] = [];
  const frontmatterEnd = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)$/.test(line.trim()))
    : -1;
  const fence = xArticleMarkdownFenceState();
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    const trimmed = line.trim();
    if (frontmatterEnd >= 0 && offset <= frontmatterEnd) continue;
    if (consumeXArticleMarkdownFence(line, fence)) continue;
    if (fence.character || line.includes('|')) continue;
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})\s*$/.test(line)) {
      found.push({ line: offset + 1, text: trimmed });
    }
  }
  return found;
}

export function findUnsupportedXArticleRawHtml(markdown: string): XArticleUnsupportedRawHtml[] {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const frontmatterEnd = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)$/.test(line.trim()))
    : -1;
  const fence = xArticleMarkdownFenceState();
  const maskedLines: string[] = [];
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    const inFrontmatter = frontmatterEnd >= 0 && offset <= frontmatterEnd;
    const fenceDelimiter = !inFrontmatter && consumeXArticleMarkdownFence(line, fence);
    const masked = inFrontmatter || fenceDelimiter || fence.character;
    maskedLines.push(masked ? ' '.repeat(line.length) : line);
  }

  const masked = maskedLines.join('\n');
  const found: XArticleUnsupportedRawHtml[] = [];
  const rawHtmlPattern = /<!--[\s\S]*?(?:-->|$)|<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g;
  let currentLine = 1;
  let previousIndex = 0;
  for (const match of masked.matchAll(rawHtmlPattern)) {
    const index = match.index ?? 0;
    currentLine += (masked.slice(previousIndex, index).match(/\n/g) ?? []).length;
    previousIndex = index;
    const raw = match[0];
    const isUriAutolink = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>$/u.test(raw);
    const isEmailAutolink = /^<[^\s<>]+@[^\s<>]+>$/.test(raw) && !raw.startsWith('</');
    if (isUriAutolink || isEmailAutolink) continue;
    const tag = raw.startsWith('<!--') ? 'comment' : (match[1]?.toLowerCase() ?? 'html');
    found.push({
      line: currentLine,
      tag,
      text: raw.trim().replace(/\s+/g, ' ').slice(0, 180),
    });
  }
  return found;
}

export function addPreparedMarkdownPreflightErrors(
  preflight: XArticlePreflight,
  markdown: string,
): XArticlePreflight {
  const dividers = findUnsupportedXArticleDividers(markdown);
  const rawHtml = findUnsupportedXArticleRawHtml(markdown);
  const referenceImages = findUnsupportedXArticleReferenceImages(markdown);
  const additions: XArticlePreflightIssue[] = [];
  if (dividers.length && !preflight.errors.some(error => error.type === 'unsupported_divider')) {
    additions.push({
      type: 'unsupported_divider',
      message: 'X Article uploader does not currently reinsert Markdown thematic breaks.',
      details: { dividers },
    });
  }
  if (rawHtml.length && !preflight.errors.some(error => error.type === 'unsupported_raw_html')) {
    additions.push({
      type: 'unsupported_raw_html',
      message: 'X Article upload blocks raw HTML; convert it to Markdown before opening X.',
      details: { elements: rawHtml },
    });
  }
  if (referenceImages.length
    && !preflight.errors.some(error => error.type === 'unsupported_reference_image')) {
    additions.push({
      type: 'unsupported_reference_image',
      message: 'X Article upload does not support reference-style images; convert them to inline image syntax.',
      details: { images: referenceImages },
    });
  }
  if (!additions.length) return preflight;
  return {
    ...preflight,
    errors: [...preflight.errors, ...additions],
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new XArticlePreflightValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new XArticlePreflightValidationError(`${label} must be a non-empty string.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new XArticlePreflightValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new XArticlePreflightValidationError(`${label} must be an integer >= ${minimum}.`);
  }
  return value as number;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new XArticlePreflightValidationError(`${label} must be an array.`);
  }
  return value;
}

function contentCheckpoints(value: unknown): string[] {
  const parsed = array(value, 'content_checkpoints').map((item, index) => {
    const checkpoint = string(item, `content_checkpoints[${index}]`);
    const invisibleCharacters = ['\u200b', '\u200c', '\u200d', '\ufeff'];
    if (Array.from(checkpoint).length > 32 || /\s/u.test(checkpoint)
      || invisibleCharacters.some(character => checkpoint.includes(character))) {
      throw new XArticlePreflightValidationError(
        `content_checkpoints[${index}] must be compact and at most 32 characters.`,
      );
    }
    return checkpoint;
  });
  if (parsed.length < 3 || parsed.length > 5) {
    throw new XArticlePreflightValidationError(
      'content_checkpoints must contain between three and five checkpoints.',
    );
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new XArticlePreflightValidationError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return parsed;
}

function issues(value: unknown, label: string): XArticlePreflightIssue[] {
  return array(value, label).map((item, index) => {
    const source = record(item, `${label}[${index}]`);
    const type = string(source.type, `${label}[${index}].type`);
    const message = source.message === undefined
      ? ''
      : string(source.message, `${label}[${index}].message`, true);
    return { type, message, details: { ...source } };
  });
}

function anchors(value: unknown, expected: number): XArticlePreflightAnchor[] {
  let afterAnchorSeen = false;
  const parsed = array(value, 'anchors').map((item, offset) => {
    const source = record(item, `anchors[${offset}]`);
    const index = integer(source.index, `anchors[${offset}].index`, 1);
    const file = string(source.file, `anchors[${offset}].file`);
    const placement: XArticleMediaPlacement = source.placement === undefined
      ? 'after-anchor'
      : source.placement as XArticleMediaPlacement;
    if (placement !== 'after-anchor' && placement !== 'composer-start') {
      throw new XArticlePreflightValidationError(`anchors[${offset}].placement is invalid.`);
    }
    const anchor = string(
      source.anchor,
      `anchors[${offset}].anchor`,
      placement === 'composer-start',
    ).trim();
    if (index !== offset + 1) {
      throw new XArticlePreflightValidationError('anchors must have contiguous one-based indexes.');
    }
    if (placement === 'composer-start' && (afterAnchorSeen || anchor)) {
      throw new XArticlePreflightValidationError(
        'composer-start placement is only valid in the leading image run with an empty anchor.',
      );
    }
    if (placement === 'after-anchor') afterAnchorSeen = true;
    if (placement === 'after-anchor'
      && (anchor.length < 4 || /^[-|`~\d.)、\s]+$/.test(anchor))) {
      throw new XArticlePreflightValidationError(`anchors[${offset}].anchor is too weak.`);
    }
    return { index, file, anchor, placement };
  });
  if (parsed.length !== expected) {
    throw new XArticlePreflightValidationError('anchors length does not match expected_body_images.');
  }
  return parsed;
}

function tables(value: unknown, expected: number): XArticlePreflightTable[] {
  const markers = new Set<string>();
  const parsed = array(value, 'tables').map((item, offset) => {
    const source = record(item, `tables[${offset}]`);
    const index = integer(source.index, `tables[${offset}].index`, 1);
    const rows = integer(source.rows, `tables[${offset}].rows`, 1);
    const columns = integer(source.columns, `tables[${offset}].columns`, 2);
    const marker = string(source.marker, `tables[${offset}].marker`);
    const normalizedMatrix = array(
      source.normalized_matrix,
      `tables[${offset}].normalized_matrix`,
    ).map((row, rowOffset) => array(
      row,
      `tables[${offset}].normalized_matrix[${rowOffset}]`,
    ).map((cell, cellOffset) => string(
      cell,
      `tables[${offset}].normalized_matrix[${rowOffset}][${cellOffset}]`,
      true,
    )));
    if (index !== offset + 1 || !/^X_TABLE_MARKER_\d{3}_DO_NOT_EDIT$/.test(marker)) {
      throw new XArticlePreflightValidationError('tables contain invalid indexes or markers.');
    }
    if (markers.has(marker)) {
      throw new XArticlePreflightValidationError('tables contain duplicate markers.');
    }
    if (normalizedMatrix.length !== rows
      || normalizedMatrix.some(row => row.length !== columns)
      || !normalizedMatrix.flat().some(cell => cell.trim())) {
      throw new XArticlePreflightValidationError('tables contain invalid or empty normalized matrices.');
    }
    markers.add(marker);
    return { index, rows, columns, marker, normalizedMatrix };
  });
  if (parsed.length !== expected) {
    throw new XArticlePreflightValidationError('tables length does not match expected_tables.');
  }
  return parsed;
}

export function parseXArticlePreflightJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new XArticlePreflightValidationError('Dry-run stdout was not one complete JSON object.');
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new XArticlePreflightValidationError('Dry-run stdout contained malformed JSON.');
  }
}

export function validateXArticlePreflight(
  value: unknown,
  preparedContentHash: string | null = null,
): XArticlePreflight {
  const source = record(value, 'preflight');
  const title = string(source.title, 'title').trim();
  const coverUpload = boolean(source.cover_upload, 'cover_upload');
  const coverMissing = boolean(source.cover_missing, 'cover_missing');
  if (coverUpload === coverMissing) {
    throw new XArticlePreflightValidationError('cover_upload and cover_missing are inconsistent.');
  }
  if (source.recommended_cover_ratio !== X_ARTICLE_COVER_RATIO) {
    throw new XArticlePreflightValidationError('recommended_cover_ratio must be 5:2.');
  }
  const coverImage = source.cover_image === null
    ? null
    : string(source.cover_image, 'cover_image');
  if ((coverUpload && (!coverImage || !path.isAbsolute(coverImage))) || (coverMissing && coverImage !== null)) {
    throw new XArticlePreflightValidationError('cover_image is inconsistent with the cover policy.');
  }
  const rawCoverPolicy = record(source.cover_policy, 'cover_policy');
  const startsWithImage = boolean(rawCoverPolicy.starts_with_image, 'cover_policy.starts_with_image');
  const firstContentLine = rawCoverPolicy.first_content_line === null
    ? null
    : integer(rawCoverPolicy.first_content_line, 'cover_policy.first_content_line', 1);
  const firstContentPreview = string(
    rawCoverPolicy.first_content_preview,
    'cover_policy.first_content_preview',
    true,
  );
  if (coverUpload && !startsWithImage) {
    throw new XArticlePreflightValidationError('cover_policy contradicts cover_upload.');
  }
  const postUploadCoverReminder = string(
    source.post_upload_cover_reminder,
    'post_upload_cover_reminder',
    coverUpload,
  );
  if (coverMissing && !postUploadCoverReminder.trim()) {
    throw new XArticlePreflightValidationError('A missing cover requires a post-upload reminder.');
  }
  const expectedBodyImages = integer(source.expected_body_images, 'expected_body_images');
  const expectedTables = integer(source.expected_tables, 'expected_tables');
  const parsedContentCheckpoints = contentCheckpoints(source.content_checkpoints);
  const expectedCompactLength = integer(
    source.expected_compact_length,
    'expected_compact_length',
    1,
  );
  if (source.compact_length_unit !== X_ARTICLE_CONTENT_LENGTH_UNIT
    || source.checkpoint_position_unit !== X_ARTICLE_CONTENT_LENGTH_UNIT) {
    throw new XArticlePreflightValidationError(
      'compact length and checkpoint positions must use unicode_code_points.',
    );
  }
  const expectedCompactSha256 = sha256(
    source.expected_compact_sha256,
    'expected_compact_sha256',
  );
  const parsedAnchors = anchors(source.anchors, expectedBodyImages);
  const parsedTables = tables(source.tables, expectedTables);
  const preflightBlock = record(source.preflight, 'preflight.preflight');
  const parsedWarnings = issues(preflightBlock.warnings, 'preflight.warnings');
  const parsedErrors = issues(preflightBlock.errors, 'preflight.errors');
  for (const table of parsedTables) {
    if (table.rows > 10 || table.columns > 10) {
      parsedErrors.push({
        type: 'table_too_large',
        message: 'X Article tables are limited to 10 x 10.',
        details: { index: table.index, rows: table.rows, columns: table.columns },
      });
    }
  }
  const totalMedia = expectedBodyImages + (coverUpload ? 1 : 0);
  if (expectedBodyImages > X_ARTICLE_MAX_BODY_MEDIA
    && !parsedErrors.some(error => error.type === 'body_media_limit_exceeded')) {
    parsedErrors.push({
      type: 'body_media_limit_exceeded',
      message: `X Article supports at most ${X_ARTICLE_MAX_BODY_MEDIA} body media items; the cover is separate.`,
      details: {
        bodyMedia: expectedBodyImages,
        maximum: X_ARTICLE_MAX_BODY_MEDIA,
        coverSeparate: true,
        totalMedia,
      },
    });
  }
  return {
    title,
    coverImage,
    coverUpload,
    coverMissing,
    recommendedCoverRatio: X_ARTICLE_COVER_RATIO,
    coverPolicy: { startsWithImage, firstContentLine, firstContentPreview },
    postUploadCoverReminder,
    expectedBodyImages,
    expectedTables,
    totalMedia,
    endCheckText: string(source.end_check_text, 'end_check_text'),
    contentCheckpoints: parsedContentCheckpoints,
    expectedCompactLength,
    compactLengthUnit: X_ARTICLE_CONTENT_LENGTH_UNIT,
    checkpointPositionUnit: X_ARTICLE_CONTENT_LENGTH_UNIT,
    expectedCompactSha256,
    anchors: parsedAnchors,
    tables: parsedTables,
    warnings: parsedWarnings,
    errors: parsedErrors,
    preparedContentHash,
  };
}
