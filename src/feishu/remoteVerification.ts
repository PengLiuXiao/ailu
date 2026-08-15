import type { FeishuSnapshot } from './types';
import { PROTOCOL_IDS } from '../ids';

export interface FeishuRemoteVerificationResult {
  ok: boolean;
  message: string;
}

interface XmlTextNode {
  type: 'text';
  value: string;
}

interface XmlElementNode {
  type: 'element';
  name: string;
  children: XmlNode[];
}

type XmlNode = XmlTextNode | XmlElementNode;

interface ParsedCodeBlock {
  content: string;
  startLine: number;
  endLine: number;
}

interface ComparableTable {
  head: string[][];
  body: string[][];
}

const PLACEHOLDER_PREFIX = PROTOCOL_IDS.feishuImagePlaceholderPrefix;
const XML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const MAX_XML_NODES = 500_000;
const MAX_XML_DEPTH = 512;

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal ? 10 : 16);
        try {
          return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
        } catch {
          return entity;
        }
      }
      return name ? named[name.toLowerCase()] ?? entity : entity;
    },
  );
}

function findMarkupEnd(value: string, start: number): number {
  let quote = '';
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/** Parses the CLI XML fragment without evaluating declarations or external entities. */
function parseXmlFragment(value: string): XmlElementNode | null {
  const root: XmlElementNode = { type: 'element', name: '#document', children: [] };
  const stack: XmlElementNode[] = [root];
  let cursor = 0;
  let nodeCount = 1;

  const append = (node: XmlNode): boolean => {
    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) return false;
    stack[stack.length - 1].children.push(node);
    return true;
  };

  while (cursor < value.length) {
    const markupStart = value.indexOf('<', cursor);
    if (markupStart < 0) {
      if (cursor < value.length && !append({ type: 'text', value: value.slice(cursor) })) return null;
      cursor = value.length;
      break;
    }
    if (markupStart > cursor && !append({ type: 'text', value: value.slice(cursor, markupStart) })) {
      return null;
    }

    if (value.startsWith('<!--', markupStart)) {
      const end = value.indexOf('-->', markupStart + 4);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (value.startsWith('<![CDATA[', markupStart)) {
      const end = value.indexOf(']]>', markupStart + 9);
      if (end < 0) return null;
      if (!append({ type: 'text', value: value.slice(markupStart + 9, end) })) return null;
      cursor = end + 3;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(value.slice(markupStart, markupStart + 16))
      || /^<!ENTITY\b/i.test(value.slice(markupStart, markupStart + 16))) {
      return null;
    }
    if (value.startsWith('<?', markupStart)) {
      const end = value.indexOf('?>', markupStart + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }

    const markupEnd = findMarkupEnd(value, markupStart + 1);
    if (markupEnd < 0) return null;
    const markup = value.slice(markupStart + 1, markupEnd);
    const closingMatch = /^\s*\/\s*([A-Za-z][\w:.-]*)\s*$/.exec(markup);
    if (closingMatch) {
      if (XML_VOID_ELEMENTS.has(closingMatch[1].toLowerCase())
        && stack[stack.length - 1].name !== closingMatch[1].toLowerCase()) {
        cursor = markupEnd + 1;
        continue;
      }
      if (stack.length === 1 || stack[stack.length - 1].name !== closingMatch[1].toLowerCase()) {
        return null;
      }
      stack.pop();
      cursor = markupEnd + 1;
      continue;
    }

    const openingMatch = /^\s*([A-Za-z][\w:.-]*)\b/.exec(markup);
    if (!openingMatch) return null;
    const name = openingMatch[1].toLowerCase();
    const element: XmlElementNode = { type: 'element', name, children: [] };
    if (!append(element)) return null;

    const selfClosing = /\/\s*$/.test(markup) || XML_VOID_ELEMENTS.has(name);
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > MAX_XML_DEPTH) return null;
    }
    cursor = markupEnd + 1;
  }

  return stack.length === 1 ? root : null;
}

function elementChildren(node: XmlElementNode, name: string): XmlElementNode[] {
  return node.children.filter(
    (child): child is XmlElementNode => child.type === 'element' && child.name === name,
  );
}

function descendants(node: XmlElementNode, name: string): XmlElementNode[] {
  const matches: XmlElementNode[] = [];
  const visit = (current: XmlElementNode): void => {
    for (const child of current.children) {
      if (child.type !== 'element') continue;
      if (child.name === name) matches.push(child);
      visit(child);
    }
  };
  visit(node);
  return matches;
}

function xmlLiteralText(node: XmlElementNode): string {
  let result = '';
  const visit = (current: XmlNode): void => {
    if (current.type === 'text') {
      result += decodeXmlEntities(current.value);
      return;
    }
    if (current.name === 'br') {
      result += '\n';
      return;
    }
    current.children.forEach(visit);
  };
  node.children.forEach(visit);
  return result;
}

function normalizeVisibleText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizeTitleText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

function excerpt(value: string, maxLength = 32): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}…` : compact;
}

function failure(message: string): FeishuRemoteVerificationResult {
  return { ok: false, message };
}

function expectedBody(snapshot: FeishuSnapshot): string {
  return snapshot.markdown.replace(/^\uFEFF?\s*#\s+[^\r\n]*(?:\r?\n|$)/, '');
}

function splitExpectedText(snapshot: FeishuSnapshot): string[] | null {
  let remaining = expectedBody(snapshot);
  const segments: string[] = [];

  for (const asset of snapshot.assets) {
    const markerOffset = remaining.indexOf(asset.placeholder);
    if (markerOffset < 0) return null;
    segments.push(remaining.slice(0, markerOffset));
    remaining = remaining.slice(markerOffset + asset.placeholder.length);
  }
  segments.push(remaining);
  return segments;
}

function describeImageBoundedSegment(index: number, imageCount: number): string {
  if (imageCount === 0) return '正文';
  if (index === 0) return '首张图片前';
  if (index === imageCount) return `第 ${imageCount} 张图片后`;
  return `第 ${index} 张与第 ${index + 1} 张图片之间`;
}

const XML_PROSE_BLOCK_ELEMENTS = new Set([
  'blockquote',
  'checkbox',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'heading7',
  'heading8',
  'heading9',
  'li',
  'ol',
  'p',
  'section',
  'ul',
]);

function remoteProseSegments(root: XmlElementNode, title: XmlElementNode): string[] {
  const segments: string[] = [''];
  const visit = (node: XmlNode): void => {
    if (node === title) return;
    if (node.type === 'text') {
      segments[segments.length - 1] += decodeXmlEntities(node.value);
      return;
    }
    if (node.name === 'img') {
      segments.push('');
      return;
    }
    if (node.name === 'pre' || node.name === 'table') return;
    if (node.name === 'br') {
      segments[segments.length - 1] += ' ';
      return;
    }
    node.children.forEach(visit);
    if (XML_PROSE_BLOCK_ELEMENTS.has(node.name)) segments[segments.length - 1] += ' ';
  };
  root.children.forEach(visit);
  return segments.map(normalizeVisibleText);
}

function fenceClosingLine(line: string, marker: string): boolean {
  const indentLength = line.length - line.trimStart().length;
  if (indentLength > 3) return false;
  const trimmed = line.slice(indentLength);
  let markerLength = 0;
  while (trimmed[markerLength] === marker[0]) markerLength += 1;
  return markerLength >= marker.length && trimmed.slice(markerLength).trim().length === 0;
}

function parseFencedCodeBlocks(markdown: string): ParsedCodeBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ParsedCodeBlock[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[lineIndex]);
    if (!opening || (opening[2][0] === '`' && opening[3].includes('`'))) continue;

    let closingLine = lineIndex + 1;
    while (closingLine < lines.length && !fenceClosingLine(lines[closingLine], opening[2])) {
      closingLine += 1;
    }
    const hasClosingFence = closingLine < lines.length;
    const contentEnd = hasClosingFence ? closingLine : lines.length;
    const fenceIndent = opening[1].length;
    const contentLines = lines.slice(lineIndex + 1, contentEnd).map((line) => {
      let removed = 0;
      while (removed < fenceIndent && line[removed] === ' ') removed += 1;
      return line.slice(removed);
    });
    blocks.push({
      content: contentLines.join('\n'),
      startLine: lineIndex,
      endLine: hasClosingFence ? closingLine : lines.length - 1,
    });
    lineIndex = hasClosingFence ? closingLine : lines.length;
  }
  return blocks;
}

function parseMarkdownCodeBlocks(markdown: string): ParsedCodeBlock[] {
  const source = markdown.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const fenced = parseFencedCodeBlocks(source);
  const occupied = new Set<number>();
  for (const block of fenced) {
    for (let line = block.startLine; line <= block.endLine; line += 1) occupied.add(line);
  }
  const indented: ParsedCodeBlock[] = [];
  const removeIndent = (line: string): string | null => {
    let columns = 0;
    let index = 0;
    while (index < line.length && columns < 4) {
      if (line[index] === ' ') columns += 1;
      else if (line[index] === '\t') columns += 4 - (columns % 4);
      else break;
      index += 1;
    }
    return columns >= 4 ? line.slice(index) : null;
  };
  const precedingLineEndsBlock = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line)
      || /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)
      || /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(line);
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (occupied.has(lineIndex) || removeIndent(lines[lineIndex]) === null) continue;
    if (lineIndex > 0 && !occupied.has(lineIndex - 1)
      && !precedingLineEndsBlock(lines[lineIndex - 1])) continue;

    const startLine = lineIndex;
    const content: string[] = [];
    let lastIndentedLine = lineIndex;
    while (lineIndex < lines.length && !occupied.has(lineIndex)) {
      const line = lines[lineIndex];
      const dedented = removeIndent(line);
      if (dedented !== null) {
        content.push(dedented);
        lastIndentedLine = lineIndex;
        lineIndex += 1;
        continue;
      }
      if (!line.trim()) {
        content.push('');
        lineIndex += 1;
        continue;
      }
      break;
    }
    content.splice(lastIndentedLine - startLine + 1);
    indented.push({
      content: content.join('\n'),
      startLine,
      endLine: lastIndentedLine,
    });
    lineIndex = Math.max(lastIndentedLine, lineIndex - 1);
  }
  return [...fenced, ...indented].sort((left, right) => left.startLine - right.startLine);
}

function normalizeRemoteCode(value: string): string {
  let normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.startsWith('\n')) normalized = normalized.slice(1);
  if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
  return normalized;
}

function verifyCodeBlocks(markdown: string, root: XmlElementNode): FeishuRemoteVerificationResult | null {
  const expected = parseMarkdownCodeBlocks(markdown);
  const remotePreBlocks = descendants(root, 'pre');
  if (remotePreBlocks.length !== expected.length) {
    return failure(`飞书回读代码块数量不一致：期望 ${expected.length} 个，实际 ${remotePreBlocks.length} 个。`);
  }
  const actual: string[] = [];
  for (const pre of remotePreBlocks) {
    const code = elementChildren(pre, 'code');
    if (code.length !== 1
      || pre.children.some(child => child.type === 'element' && child.name !== 'code')) {
      return failure('飞书回读代码块结构不一致：预格式化内容缺少唯一的 code 节点。');
    }
    actual.push(normalizeRemoteCode(xmlLiteralText(code[0])));
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index].content) {
      return failure(`飞书回读第 ${index + 1} 个代码块不一致：代码中的空格、缩进或标点发生变化。`);
    }
  }
  return null;
}

function hasUnescapedPipe(value: string): boolean {
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      return true;
    }
  }
  return false;
}

function splitGfmRow(value: string): string[] {
  const trimmed = value.trim();
  const cells: string[] = [];
  let cell = '';
  let codeMarkerLength = 0;
  let index = 0;

  while (index < trimmed.length) {
    const character = trimmed[index];
    if (character === '\\') {
      let runLength = 1;
      while (trimmed[index + runLength] === '\\') runLength += 1;
      if (trimmed[index + runLength] === '|' && runLength % 2 === 1) {
        cell += '\\'.repeat(runLength);
        cell += '|';
        index += runLength + 1;
        continue;
      }
      cell += '\\'.repeat(runLength);
      index += runLength;
      continue;
    }
    if (character === '`') {
      let runLength = 1;
      while (trimmed[index + runLength] === '`') runLength += 1;
      if (codeMarkerLength === 0) codeMarkerLength = runLength;
      else if (codeMarkerLength === runLength) codeMarkerLength = 0;
      cell += trimmed.slice(index, index + runLength);
      index += runLength;
      continue;
    }
    if (character === '|' && codeMarkerLength === 0) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
    index += 1;
  }
  cells.push(cell);
  if (trimmed.startsWith('|')) cells.shift();
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) cells.pop();
  return cells.map(item => item.trim());
}

function markdownCellText(value: string): string {
  const literals: string[] = [];
  const reserveLiteral = (literal: string): string => {
    const token = `\uE000${literals.length}\uE001`;
    literals.push(literal);
    return token;
  };
  let visible = value
    .replace(/\\\\/g, () => reserveLiteral('\\'))
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, (_match, literal: string) => (
      reserveLiteral(literal)
    ))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(`+)([\s\S]*?)\1/g, (_match, _marker: string, literal: string) => (
      reserveLiteral(literal)
    ));
  for (const marker of ['**', '__', '~~', '*', '_']) {
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    visible = visible.replace(
      new RegExp(`${escapedMarker}(?=\\S)([\\s\\S]*?\\S)${escapedMarker}`, 'g'),
      '$1',
    );
  }
  visible = visible.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => (
    literals[Number.parseInt(index, 10)] ?? ''
  ));
  return normalizeVisibleText(decodeXmlEntities(visible));
}

function isGfmDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function parseGfmTables(markdown: string): ComparableTable[] {
  const source = markdown.replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const codeLines = new Set<number>();
  for (const block of parseMarkdownCodeBlocks(source)) {
    for (let line = block.startLine; line <= block.endLine; line += 1) codeLines.add(line);
  }

  const tables: ComparableTable[] = [];
  for (let lineIndex = 0; lineIndex + 1 < lines.length; lineIndex += 1) {
    if (codeLines.has(lineIndex) || codeLines.has(lineIndex + 1)) continue;
    if (!hasUnescapedPipe(lines[lineIndex]) || !hasUnescapedPipe(lines[lineIndex + 1])) continue;
    const header = splitGfmRow(lines[lineIndex]);
    const delimiter = splitGfmRow(lines[lineIndex + 1]);
    if (header.length !== delimiter.length || !isGfmDelimiterRow(delimiter)) continue;

    const body: string[][] = [];
    let nextLine = lineIndex + 2;
    while (nextLine < lines.length && !codeLines.has(nextLine) && hasUnescapedPipe(lines[nextLine])) {
      const row = splitGfmRow(lines[nextLine]).slice(0, header.length);
      while (row.length < header.length) row.push('');
      body.push(row.map(markdownCellText));
      nextLine += 1;
    }
    tables.push({ head: [header.map(markdownCellText)], body });
    lineIndex = nextLine - 1;
  }
  return tables;
}

function parseXmlTable(table: XmlElementNode): ComparableTable | null {
  const heads = elementChildren(table, 'thead');
  const bodies = elementChildren(table, 'tbody');
  if (heads.length !== 1 || bodies.length !== 1) return null;
  const sectionOrder = table.children
    .filter((child): child is XmlElementNode => (
      child.type === 'element' && (child.name === 'thead' || child.name === 'tbody')
    ))
    .map(child => child.name);
  if (sectionOrder.join(',') !== 'thead,tbody') return null;

  const parseRows = (section: XmlElementNode, cellTag: 'th' | 'td'): string[][] | null => {
    if (section.children.some(child => child.type === 'element' && child.name !== 'tr')) return null;
    const rows: string[][] = [];
    for (const row of elementChildren(section, 'tr')) {
      const cells = row.children.filter((child): child is XmlElementNode => child.type === 'element');
      if (cells.some(cell => cell.name !== cellTag)) return null;
      rows.push(cells.map(cell => normalizeVisibleText(xmlLiteralText(cell))));
    }
    return rows;
  };

  const head = parseRows(heads[0], 'th');
  const body = parseRows(bodies[0], 'td');
  return head && body ? { head, body } : null;
}

function sameRows(expected: string[][], actual: string[][]): boolean {
  return expected.length === actual.length
    && expected.every((row, rowIndex) => (
      row.length === actual[rowIndex].length
      && row.every((cell, cellIndex) => cell === actual[rowIndex][cellIndex])
    ));
}

function verifyTables(markdown: string, root: XmlElementNode): FeishuRemoteVerificationResult | null {
  const expected = parseGfmTables(markdown);
  const remoteElements = descendants(root, 'table');
  if (remoteElements.length !== expected.length) {
    return failure(`飞书回读表格数量不一致：期望 ${expected.length} 个，实际 ${remoteElements.length} 个。`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    const actual = parseXmlTable(remoteElements[index]);
    if (!actual) {
      return failure(`飞书回读第 ${index + 1} 个表格结构不一致：缺少标准表头或表体。`);
    }
    if (!sameRows(expected[index].head, actual.head) || !sameRows(expected[index].body, actual.body)) {
      return failure(`飞书回读第 ${index + 1} 个表格不一致：行列或单元格内容发生变化。`);
    }
  }
  return null;
}

function markdownProseText(value: string): string {
  const source = value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const excluded = new Set<number>();
  for (const block of parseMarkdownCodeBlocks(source)) {
    for (let line = block.startLine; line <= block.endLine; line += 1) excluded.add(line);
  }

  for (let lineIndex = 0; lineIndex + 1 < lines.length; lineIndex += 1) {
    if (excluded.has(lineIndex) || excluded.has(lineIndex + 1)) continue;
    if (!hasUnescapedPipe(lines[lineIndex]) || !hasUnescapedPipe(lines[lineIndex + 1])) continue;
    const header = splitGfmRow(lines[lineIndex]);
    const delimiter = splitGfmRow(lines[lineIndex + 1]);
    if (header.length !== delimiter.length || !isGfmDelimiterRow(delimiter)) continue;
    excluded.add(lineIndex);
    excluded.add(lineIndex + 1);
    let nextLine = lineIndex + 2;
    while (nextLine < lines.length && hasUnescapedPipe(lines[nextLine])) {
      excluded.add(nextLine);
      nextLine += 1;
    }
    lineIndex = nextLine - 1;
  }

  const prose = lines.flatMap((line, index) => {
    if (excluded.has(index)) return [];
    let visible = line;
    while (/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/.test(visible)) {
      visible = visible.replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, '');
    }
    visible = visible.replace(/^\s*\[[ xX]\]\s+/, '');
    if (/^\s*(?:[-*_]\s*){3,}$/.test(visible)) return [];
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(visible)) return [];
    return [markdownCellText(visible)];
  }).join(' ');
  return normalizeVisibleText(prose);
}

function stripAllowedImageCaption(value: string, asset: FeishuSnapshot['assets'][number], index: number): string {
  const labels = new Set([asset.alt, asset.fileName].map(normalizeVisibleText).filter(Boolean));
  let result = value;
  for (const label of labels) {
    for (const candidate of [`图 ${index + 1}：${label}`, `图${index + 1}：${label}`, `图 ${index + 1}: ${label}`, `图${index + 1}: ${label}`]) {
      const normalizedCandidate = normalizeVisibleText(candidate);
      if (result === normalizedCandidate) return '';
      if (result.startsWith(`${normalizedCandidate} `)) {
        result = result.slice(normalizedCandidate.length).trimStart();
        return result;
      }
    }
  }
  return result;
}

/**
 * Verifies the stable parts of a Feishu CLI XML read-back against the published
 * snapshot: title, image count/order, visible text order, code and table content.
 */
export function verifyFeishuRemoteContent(
  snapshot: FeishuSnapshot,
  remoteContent: string,
): FeishuRemoteVerificationResult {
  if (!remoteContent.trim()) {
    return failure('飞书回读内容为空，无法确认文档已写入。');
  }

  if (remoteContent.toUpperCase().includes(PLACEHOLDER_PREFIX)) {
    return failure('飞书回读仍含图片占位符，图片替换尚未完成。');
  }

  const root = parseXmlFragment(remoteContent);
  if (!root) {
    return failure('飞书回读内容不是可验证的文档结构。');
  }
  const titles = descendants(root, 'title');
  if (titles.length !== 1) {
    if (titles.length > 1) {
      return failure(`飞书回读文档标题数量不一致：期望 1 个，实际 ${titles.length} 个。`);
    }
    return failure('飞书回读缺少可验证的文档标题。');
  }

  const expectedTitle = normalizeTitleText(snapshot.title);
  const actualTitleText = xmlLiteralText(titles[0]);
  const actualTitle = normalizeTitleText(actualTitleText);
  if (!expectedTitle || actualTitle !== expectedTitle) {
    return failure(
      `飞书回读标题不一致：期望“${excerpt(snapshot.title)}”，实际“${excerpt(actualTitleText) || '空标题'}”。`,
    );
  }

  const remoteImageCount = descendants(root, 'img').length;
  if (remoteImageCount !== snapshot.assets.length) {
    return failure(
      `飞书回读图片数量不一致：期望 ${snapshot.assets.length} 张，实际 ${remoteImageCount} 张。`,
    );
  }

  const codeFailure = verifyCodeBlocks(expectedBody(snapshot), root);
  if (codeFailure) return codeFailure;
  const tableFailure = verifyTables(expectedBody(snapshot), root);
  if (tableFailure) return tableFailure;

  const rawSegments = splitExpectedText(snapshot);
  if (!rawSegments) {
    return failure('本地飞书快照缺少图片占位符，无法进行回读验证。');
  }
  const segments = rawSegments.map((segment, index) => ({
    index,
    display: excerpt(markdownProseText(segment)),
    normalized: markdownProseText(segment),
  }));
  const hasStructuredContent = parseMarkdownCodeBlocks(expectedBody(snapshot)).length > 0
    || parseGfmTables(expectedBody(snapshot)).length > 0;
  if (!segments.some(segment => segment.normalized.length > 0) && !hasStructuredContent) {
    return failure('本地正文缺少可供回读比对的文字，无法确认写入结果。');
  }

  const actualSegments = remoteProseSegments(root, titles[0]).map((segment, index) => (
    index > 0 && snapshot.assets[index - 1]
      ? stripAllowedImageCaption(segment, snapshot.assets[index - 1], index - 1)
      : segment
  ));
  for (const segment of segments) {
    const actualSegment = actualSegments[segment.index];
    if (
      actualSegment === undefined
      || actualSegment !== segment.normalized
    ) {
      const mismatch = snapshot.assets.length
        ? '飞书回读正文与图片顺序不一致'
        : '飞书回读正文不一致';
      return failure(
        `${mismatch}：未在${describeImageBoundedSegment(segment.index, snapshot.assets.length)}找到“${segment.display || '正文'}”。`,
      );
    }
  }

  return { ok: true, message: '' };
}
