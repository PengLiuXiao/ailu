import { createHash } from 'crypto';

import { ImagePreflight } from './imagePreflight';
import {
  PREPARED_ARTICLE_SCHEMA_VERSION,
  PREPARED_IMAGE_SCHEME,
  type PreparedArticle,
  type PreparedArticleBuildInput,
  type PreparedPublishingImage,
  type PublishingImageInput,
} from './types';
import {
  WECHAT_TEXT_FLOW_RESET_STYLE,
  WECHAT_TEXT_WRAP_GUARD_STYLE,
} from '../wechat/textFlowGuards';

type HtmlParent = HtmlRootNode | HtmlElementNode;

interface HtmlRootNode {
  type: 'root';
  children: HtmlNode[];
}

interface HtmlElementNode {
  type: 'element';
  tagName: string;
  attributes: Map<string, string>;
  children: HtmlNode[];
  parent: HtmlParent;
}

interface HtmlTextNode {
  type: 'text';
  value: string;
  parent: HtmlParent;
}

type HtmlNode = HtmlElementNode | HtmlTextNode;

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source',
  'track', 'wbr',
]);
const FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'select',
  'option', 'link', 'meta',
]);
const SAFE_ATTRIBUTES = new Set([
  'href', 'src', 'alt', 'title', 'style', 'width', 'height', 'start', 'colspan', 'rowspan', 'align',
]);
const FINAL_TEXT_FLOW_BLOCK_TAGS = new Set([
  'p', 'ul', 'ol', 'li', 'blockquote', 'figcaption', 'th', 'td',
]);
const FINAL_TEXT_FLOW_WRAP_TAGS = new Set([
  'p', 'li', 'blockquote', 'figcaption', 'th', 'td', 'a',
]);
const FINAL_TEXT_FLOW_DECORATIVE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code',
]);
const FINAL_TEXT_FLOW_DECORATIVE_ATTRIBUTES = [
  'data-ailu-paper-ending',
  'data-ailu-soft-ending',
  'data-ailu-extracted-ending',
] as const;

function sha256(value: string | ArrayBuffer): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else hash.update(Buffer.from(value));
  return hash.digest('hex');
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

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (/\s/.test(source[index] || '')) index += 1;
    if (index >= source.length || source[index] === '/') break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    const name = source.slice(nameStart, index).toLowerCase();
    if (!name) break;
    while (/\s/.test(source[index] || '')) index += 1;
    let value = '';
    if (source[index] === '=') {
      index += 1;
      while (/\s/.test(source[index] || '')) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index] : '';
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    attributes.set(name, value);
  }
  return attributes;
}

function parseHtml(source: string): HtmlRootNode {
  const root: HtmlRootNode = { type: 'root', children: [] };
  const stack: HtmlParent[] = [root];
  for (const token of tokenizeHtml(source)) {
    const parent = stack[stack.length - 1];
    if (!token.startsWith('<')) {
      parent.children.push({ type: 'text', value: token, parent });
      continue;
    }
    if (/^<!/i.test(token)) continue;
    const close = token.match(/^<\s*\/\s*([\w:-]+)/);
    if (close) {
      const tagName = close[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        const candidate = stack[index];
        if (candidate.type === 'element' && candidate.tagName === tagName) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const open = token.match(/^<\s*([\w:-]+)/);
    if (!open) {
      parent.children.push({ type: 'text', value: token, parent });
      continue;
    }
    const tagName = open[1].toLowerCase();
    const attributeSource = token.slice(open[0].length, token.length - 1);
    const element: HtmlElementNode = {
      type: 'element',
      tagName,
      attributes: parseAttributes(attributeSource),
      children: [],
      parent,
    };
    parent.children.push(element);
    if (!VOID_TAGS.has(tagName) && !/\/\s*>$/.test(token)) stack.push(element);
  }
  return root;
}

function elements(root: HtmlParent, tagNames?: ReadonlySet<string>): HtmlElementNode[] {
  const result: HtmlElementNode[] = [];
  const visit = (parent: HtmlParent): void => {
    for (const child of parent.children) {
      if (child.type !== 'element') continue;
      if (!tagNames || tagNames.has(child.tagName)) result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
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

function textContent(node: HtmlParent): string {
  return node.children.map(child => child.type === 'text'
    ? decodeEntities(child.value)
    : textContent(child)).join('');
}

function normalizedText(value: string): string {
  return decodeEntities(value).replace(/\s+/g, '').trim();
}

function detach(node: HtmlNode): void {
  const index = node.parent.children.indexOf(node);
  if (index >= 0) node.parent.children.splice(index, 1);
}

function replaceNode(node: HtmlNode, replacements: HtmlNode[]): void {
  const parent = node.parent;
  const index = parent.children.indexOf(node);
  if (index < 0) return;
  replacements.forEach(replacement => { replacement.parent = parent; });
  parent.children.splice(index, 1, ...replacements);
}

function removeForbiddenElements(root: HtmlRootNode): void {
  for (const element of elements(root).reverse()) {
    if (FORBIDDEN_TAGS.has(element.tagName)) detach(element);
  }
}

function normalizeReference(value: string): string {
  let normalized = decodeEntities(String(value || '').trim());
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original value when a URL contains a malformed escape sequence.
  }
  return normalized;
}

function imageMatches(image: HtmlElementNode, asset: PublishingImageInput): boolean {
  const source = normalizeReference(image.attributes.get('src') || '');
  if (!source) return false;
  const candidates = [
    asset.id,
    asset.fileName,
    ...asset.references,
  ].map(normalizeReference).filter(Boolean);
  const withoutQuery = (value: string): string => value.split(/[?#]/, 1)[0];
  if (candidates.some(candidate => (
    source === candidate
    || withoutQuery(source) === withoutQuery(candidate)
  ))) return true;
  const sourceFileName = withoutQuery(source).split('/').pop() || '';
  const coverFileName = withoutQuery(normalizeReference(asset.fileName)).split('/').pop() || '';
  return Boolean(sourceFileName && coverFileName && sourceFileName === coverFileName);
}

function topLevelChild(node: HtmlNode, root: HtmlRootNode): HtmlNode {
  let current = node;
  while (current.parent !== root) current = current.parent as HtmlElementNode;
  return current;
}

function removeImage(image: HtmlElementNode): void {
  const wrapper = image.parent.type === 'element' && ['p', 'figure'].includes(image.parent.tagName)
    ? image.parent
    : null;
  if (wrapper) {
    const mediaCount = elements(wrapper, new Set(['img', 'video', 'audio'])).length;
    if (!normalizedText(textContent(wrapper)) && mediaCount <= 1) {
      let current: HtmlElementNode | null = wrapper;
      while (current) {
        const parent: HtmlParent = current.parent;
        detach(current);
        current = parent.type === 'element'
          && parent.tagName === 'section'
          && !normalizedText(textContent(parent))
          && elements(parent, new Set(['img', 'video', 'audio', 'svg'])).length === 0
          ? parent
          : null;
      }
      return;
    }
  }
  detach(image);
}

function removeCover(
  root: HtmlRootNode,
  cover: PublishingImageInput,
): { removed: boolean; reason: 'matched-cover' | 'first-image-before-heading' | 'not-present' } {
  const images = elements(root, new Set(['img']));
  const matched = images.find(image => imageMatches(image, cover));
  if (matched) {
    removeImage(matched);
    return { removed: true, reason: 'matched-cover' };
  }
  const firstImage = images[0];
  if (!firstImage) return { removed: false, reason: 'not-present' };
  const firstHeading = elements(root, new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']))[0];
  const imageBlock = topLevelChild(firstImage, root);
  const headingBlock = firstHeading ? topLevelChild(firstHeading, root) : null;
  const imageIndex = root.children.indexOf(imageBlock);
  const headingIndex = headingBlock ? root.children.indexOf(headingBlock) : -1;
  if (imageIndex >= 0 && (headingIndex < 0 || imageIndex < headingIndex)) {
    removeImage(firstImage);
    return { removed: true, reason: 'first-image-before-heading' };
  }
  return { removed: false, reason: 'not-present' };
}

function removeTitle(root: HtmlRootNode, title: string): boolean {
  const normalizedTitle = normalizedText(title);
  const heading = elements(root, new Set(['h1', 'h2', 'h3']))
    .find(candidate => normalizedText(textContent(candidate)) === normalizedTitle);
  if (!heading) return false;
  detach(heading);
  return true;
}

function unwrapListItemBlocks(root: HtmlRootNode): void {
  for (const item of elements(root, new Set(['li']))) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of [...item.children]) {
        if (child.type === 'element' && ['section', 'p'].includes(child.tagName)) {
          const index = item.children.indexOf(child);
          const replacements = [...child.children];
          if (index > 0) {
            replacements.unshift({
              type: 'element',
              tagName: 'br',
              attributes: new Map(),
              children: [],
              parent: item,
            });
          }
          replaceNode(child, replacements);
          changed = true;
        }
      }
    }
  }
}

function flattenSemanticHeadings(root: HtmlRootNode): void {
  for (const heading of elements(root, new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']))) {
    heading.tagName = 'p';
  }
}

function appendInlineStyle(existing: string | undefined, declarations: string): string {
  const prefix = existing?.trim() ?? '';
  return `${prefix}${prefix && !prefix.endsWith(';') ? ';' : ''}${declarations}`;
}

function forceInlineStyleProperties(
  existing: string | undefined,
  declarations: string,
  properties: readonly string[],
): string {
  let retained = existing?.trim() ?? '';
  for (const property of properties) {
    retained = retained.replace(
      new RegExp(`(^|;)\\s*${property}\\s*:[^;]*(?=;|$)`, 'gi'),
      '$1',
    );
  }
  retained = retained.replace(/;{2,}/g, ';').replace(/^;|;$/g, '').trim();
  return appendInlineStyle(retained, declarations);
}

function isFinalTextFlowDecorative(element: HtmlElementNode): boolean {
  let current: HtmlParent = element;
  while (current.type === 'element') {
    const candidate: HtmlElementNode = current;
    if (
      FINAL_TEXT_FLOW_DECORATIVE_TAGS.has(candidate.tagName)
      || FINAL_TEXT_FLOW_DECORATIVE_ATTRIBUTES.some(attribute => (
        candidate.attributes.get(attribute)?.toLowerCase() === 'true'
      ))
    ) return true;
    current = candidate.parent;
  }
  return false;
}

function isFlatListRow(element: HtmlElementNode): boolean {
  return element.attributes.get('data-ailu-paper-flat-list-item')?.toLowerCase() === 'true';
}

function isFlatListContent(element: HtmlElementNode): boolean {
  const parent = element.parent;
  if (parent.type !== 'element' || !isFlatListRow(parent)) return false;
  const elementChildren = parent.children.filter(
    (child): child is HtmlElementNode => child.type === 'element',
  );
  return elementChildren.at(-1) === element;
}

/**
 * Reassert the publishing text-flow invariant at the final serialization edge.
 * Theme rendering remains responsible for visual design, while this pass makes
 * prose alignment independent of missed theme selectors or inherited host CSS.
 */
function applyFinalPublishingTextFlowGuards(root: HtmlRootNode): void {
  for (const element of elements(root)) {
    if (isFinalTextFlowDecorative(element)) continue;
    const reset = FINAL_TEXT_FLOW_BLOCK_TAGS.has(element.tagName)
      || isFlatListRow(element)
      || isFlatListContent(element);
    const wrap = FINAL_TEXT_FLOW_WRAP_TAGS.has(element.tagName)
      || isFlatListRow(element)
      || isFlatListContent(element);
    if (!reset && !wrap) continue;
    const declarations = `${reset ? WECHAT_TEXT_FLOW_RESET_STYLE : ''}${wrap ? WECHAT_TEXT_WRAP_GUARD_STYLE : ''}`;
    const properties = [
      ...(reset ? ['text-align', 'text-align-last', 'text-indent', 'text-justify', 'word-spacing'] : []),
      ...(wrap ? ['overflow-wrap', 'word-break'] : []),
    ];
    element.attributes.set(
      'style',
      forceInlineStyleProperties(element.attributes.get('style'), declarations, properties),
    );
    if (isFlatListContent(element)) {
      element.attributes.set(
        'style',
        forceInlineStyleProperties(
          element.attributes.get('style'),
          'min-width:0!important;max-width:100%!important;',
          ['min-width', 'max-width'],
        ),
      );
    }
  }
}

function sanitizeAttributes(root: HtmlRootNode): void {
  for (const element of elements(root)) {
    for (const [name, value] of [...element.attributes]) {
      if (!SAFE_ATTRIBUTES.has(name) || name.startsWith('on') || name === 'srcdoc') {
        element.attributes.delete(name);
        continue;
      }
      const normalized = value.trim().toLowerCase();
      if (name === 'href' && !/^(?:https?:|mailto:)/i.test(normalized)) {
        element.attributes.delete(name);
      }
      if (name === 'src' && /^(?:javascript|vbscript):/i.test(normalized)) {
        element.attributes.delete(name);
      }
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function serializeNode(node: HtmlNode): string {
  if (node.type === 'text') return node.value;
  const attributes = [...node.attributes]
    .map(([name, value]) => value ? ` ${name}="${escapeAttribute(value)}"` : ` ${name}`)
    .join('');
  if (VOID_TAGS.has(node.tagName)) return `<${node.tagName}${attributes}>`;
  return `<${node.tagName}${attributes}>${node.children.map(serializeNode).join('')}</${node.tagName}>`;
}

function serializeRoot(root: HtmlRootNode): string {
  return root.children.map(serializeNode).join('').trim();
}

function wrapPublishingContainer(html: string, styleValue: string | undefined): string {
  const rawStyle = styleValue?.trim() ?? '';
  if (!rawStyle) return html;
  const style = forceInlineStyleProperties(
    rawStyle,
    `${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`,
    [
      'text-align', 'text-align-last', 'text-indent', 'text-justify', 'word-spacing',
      'overflow-wrap', 'word-break',
    ],
  );
  if (
    /[<>{}]/.test(style)
    || /(?:expression|url)\s*\(|@import|(?:java|vb)script:|-moz-binding|behavior\s*:/i.test(style)
  ) {
    throw new Error('公众号模板外层样式包含不安全内容');
  }
  return `<section style="${escapeAttribute(style)}">${html}</section>`;
}

function createAssetLookup(assets: readonly PublishingImageInput[]): Map<string, PublishingImageInput> {
  const lookup = new Map<string, PublishingImageInput>();
  const ids = new Set<string>();
  for (const asset of assets) {
    if (!asset.id.trim()) throw new Error('正文图片缺少 ID');
    if (ids.has(asset.id)) throw new Error(`正文图片 ID 重复：${asset.id}`);
    ids.add(asset.id);
    for (const reference of [asset.id, asset.fileName, ...asset.references]) {
      const key = normalizeReference(reference);
      if (!key) continue;
      const existing = lookup.get(key);
      if (existing && existing.id !== asset.id) {
        throw new Error(`图片引用冲突：${reference}`);
      }
      lookup.set(key, asset);
    }
  }
  return lookup;
}

function resolveImageAsset(
  source: string,
  lookup: Map<string, PublishingImageInput>,
): PublishingImageInput | null {
  const normalized = normalizeReference(source);
  const exact = lookup.get(normalized);
  if (exact) return exact;
  const fileName = normalized.split(/[?#]/)[0].split('/').pop() || '';
  return lookup.get(fileName) ?? null;
}

function bindPreparedImagePlaceholders(
  root: HtmlRootNode,
  inputs: readonly PublishingImageInput[],
): { referenced: PublishingImageInput[]; imageCount: number } {
  const lookup = createAssetLookup(inputs);
  const referenced = new Map<string, PublishingImageInput>();
  const images = elements(root, new Set(['img']));
  for (const image of images) {
    const source = image.attributes.get('src') || '';
    if (/^https?:\/\/mmbiz\.qpic\.cn\//i.test(source)) {
      image.attributes.set('src', source.replace(/^http:/i, 'https:'));
      continue;
    }
    const asset = resolveImageAsset(source, lookup);
    if (!asset) throw new Error(`正文图片未通过本地预检：${source || '无地址'}`);
    referenced.set(asset.id, asset);
    image.attributes.set('src', `${PREPARED_IMAGE_SCHEME}${encodeURIComponent(asset.id)}`);
    image.attributes.delete('srcset');
  }
  return { referenced: [...referenced.values()], imageCount: images.length };
}

function assertNoUnsupportedFormulaGraphics(root: HtmlRootNode): void {
  const unsupported = elements(root).find(element => (
    element.tagName === 'svg'
    || element.tagName.endsWith(':svg')
    || element.tagName.startsWith('mjx-')
  ));
  if (unsupported) {
    throw new Error('草稿正文仍含 SVG 或 MathJax 公式；请先将公式转换为 PNG 后重试');
  }
}

function validatePreparedHtml(html: string): void {
  if (!html.trim()) throw new Error('草稿正文为空');
  const forbidden = [
    { pattern: /<script[\s>]/i, message: '草稿正文包含 script' },
    { pattern: /<iframe[\s>]/i, message: '草稿正文包含 iframe' },
    {
      pattern: /<(?:svg|mjx-[\w:-]+)[\s>]/i,
      message: '草稿正文仍含 SVG 或 MathJax 公式；请先将公式转换为 PNG 后重试',
    },
    { pattern: /\s(?:class|id|data-[\w-]+)\s*=/i, message: '草稿正文仍含本地属性' },
    { pattern: /\son[a-z]+\s*=/i, message: '草稿正文包含事件属性' },
    { pattern: /(?:javascript|vbscript):/i, message: '草稿正文包含危险链接' },
    {
      pattern: /<li\b[^>]*>\s*<(?:section|p)\b/i,
      message: '草稿列表仍包含会导致空序号的块级子节点',
    },
  ];
  const match = forbidden.find(rule => rule.pattern.test(html));
  if (match) throw new Error(match.message);
}

export function normalizePreparedArticleTitle(title: string): string {
  return title
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

function createDigest(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function computePreparedArticleIntegrity(
  article: Omit<PreparedArticle, 'preflight'>,
): string {
  return sha256(JSON.stringify({
    schemaVersion: article.schemaVersion,
    sourceHash: article.sourceHash,
    contentHash: article.contentHash,
    title: article.title,
    author: article.author,
    digest: article.digest,
    contentSourceUrl: article.contentSourceUrl,
    needOpenComment: article.needOpenComment,
    onlyFansCanComment: article.onlyFansCanComment,
    html: article.html,
    cover: [
      article.cover.id,
      article.cover.fileName,
      article.cover.mimeType,
      article.cover.contentHash,
      article.cover.originalBytes,
    ],
    images: article.images.map(image => [
      image.id,
      image.fileName,
      image.mimeType,
      image.contentHash,
      image.placeholder,
      image.originalBytes,
      image.outputBytes,
      image.compressed,
    ]),
    stats: article.stats,
  }));
}

function assertPreparedBinaryIntegrity(article: PreparedArticle): void {
  if (
    article.cover.body.byteLength !== article.cover.originalBytes
    || sha256(article.cover.body) !== article.cover.contentHash
  ) {
    throw new Error('预检后的封面图片已变化，请重新预检');
  }
  for (const image of article.images) {
    if (
      image.body.byteLength !== image.outputBytes
      || sha256(image.body) !== image.contentHash
    ) {
      throw new Error(`预检后的正文图片“${image.fileName}”已变化，请重新预检`);
    }
  }
}

function assertPreparedImageBindings(article: PreparedArticle): void {
  const imagesByPlaceholder = new Map<string, PreparedPublishingImage>();
  for (const image of article.images) {
    if (imagesByPlaceholder.has(image.placeholder)) {
      throw new Error(`本地图片占位符重复：${image.placeholder}`);
    }
    imagesByPlaceholder.set(image.placeholder, image);
  }
  const preparedScheme = escapeRegExp(PREPARED_IMAGE_SCHEME);
  const boundSourcePattern = new RegExp(
    `<img\\b[^>]*\\bsrc\\s*=\\s*(?:"(${preparedScheme}[^"\\s>]*)"|'(${preparedScheme}[^'\\s>]*)'|(${preparedScheme}[^\\s>]+))`,
    'gi',
  );
  const boundSources = [...article.html.matchAll(boundSourcePattern)]
    .map(match => match[1] ?? match[2] ?? match[3] ?? '');
  for (const source of boundSources) {
    if (!imagesByPlaceholder.has(source)) {
      throw new Error(`正文包含未预检的本地图片占位符：${source}`);
    }
  }
  for (const image of article.images) {
    if (!boundSources.includes(image.placeholder)) {
      throw new Error(`预检图片“${image.fileName}”未被正文引用`);
    }
  }
  const allPlaceholderCount = (
    article.html.match(new RegExp(preparedScheme, 'gi')) || []
  ).length;
  if (allPlaceholderCount !== boundSources.length) {
    throw new Error('正文包含未绑定到图片 src 的本地占位符');
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertPreparedArticleReady(article: PreparedArticle): void {
  if (article.schemaVersion !== PREPARED_ARTICLE_SCHEMA_VERSION || article.preflight.passed !== true) {
    throw new Error('发布前必须先完成本地预检');
  }
  if (computePreparedArticleIntegrity(article) !== article.preflight.integrityHash) {
    throw new Error('预检后的文章内容已变化，请重新预检');
  }
  if (article.preflight.checkedImageCount !== article.images.length + 1) {
    throw new Error('本地图片预检不完整');
  }
  if (article.preflight.compressedImageCount !== article.images.filter(image => image.compressed).length) {
    throw new Error('本地图片压缩预检记录不一致');
  }
  assertPreparedBinaryIntegrity(article);
  assertPreparedImageBindings(article);
  validatePreparedHtml(article.html);
}

export interface PreparedArticleClipboardPayload {
  html: string;
  plain: string;
}

function preparedImageDataUrl(image: PreparedPublishingImage): string {
  return `data:${image.mimeType};base64,${Buffer.from(image.body).toString('base64')}`;
}

/**
 * Builds clipboard content exclusively from the immutable, preflighted article.
 * Local images are embedded only in the clipboard copy; relay drafts keep their
 * verified placeholders until the transport replaces them with uploaded URLs.
 */
export function buildPreparedArticleClipboardPayload(
  article: PreparedArticle,
): PreparedArticleClipboardPayload {
  assertPreparedArticleReady(article);
  let html = article.html;
  for (const image of article.images) {
    html = html.split(image.placeholder).join(preparedImageDataUrl(image));
  }
  if (html.includes(PREPARED_IMAGE_SCHEME)) {
    throw new Error('复制内容仍包含未嵌入的本地图片');
  }
  return {
    html,
    plain: textContent(parseHtml(article.html)).replace(/\s+/g, ' ').trim(),
  };
}

export class PreparedArticleBuilder {
  constructor(private readonly imagePreflight = new ImagePreflight()) {}

  async build(input: PreparedArticleBuildInput): Promise<PreparedArticle> {
    const title = normalizePreparedArticleTitle(input.title);
    if (!title) throw new Error('请填写文章标题');
    if (!input.sourceHash.trim()) throw new Error('文章缺少源内容哈希');
    const root = parseHtml(input.html);
    assertNoUnsupportedFormulaGraphics(root);
    removeForbiddenElements(root);
    const coverRemoval = removeCover(root, input.cover);
    const removedTitle = removeTitle(root, title);
    unwrapListItemBlocks(root);
    applyFinalPublishingTextFlowGuards(root);
    flattenSemanticHeadings(root);
    sanitizeAttributes(root);
    const boundImages = bindPreparedImagePlaceholders(root, input.images);
    const html = wrapPublishingContainer(serializeRoot(root), input.containerStyle);
    validatePreparedHtml(html);

    const [cover, ...preparedImages] = await Promise.all([
      Promise.resolve(this.imagePreflight.prepareCover(input.cover)),
      ...boundImages.referenced.map(image => this.imagePreflight.prepareContent(image)),
    ]);
    const images = preparedImages;
    const parsedPrepared = parseHtml(html);
    const text = textContent(parsedPrepared).replace(/\s+/g, ' ').trim();
    const nativeLists = elements(parsedPrepared, new Set(['ol', 'ul']));
    const nativeListItems = elements(parsedPrepared, new Set(['li']));
    const dangerousListSectionCount = nativeListItems.reduce((count, item) => count
      + item.children.filter(child => child.type === 'element' && child.tagName === 'section').length, 0);
    const dangerousListParagraphCount = nativeListItems.reduce((count, item) => count
      + item.children.filter(child => child.type === 'element' && child.tagName === 'p').length, 0);
    const dangerousListBlockCount = dangerousListSectionCount + dangerousListParagraphCount;
    if (dangerousListBlockCount) throw new Error('草稿列表仍包含会导致空序号的块级子节点');
    const compressedImageCount = images.filter(image => image.compressed).length;
    const contentHash = sha256(JSON.stringify({
      sourceHash: input.sourceHash,
      title,
      html,
      coverHash: cover.contentHash,
      imageHashes: images.map(image => image.contentHash),
    }));
    const articleWithoutPreflight: Omit<PreparedArticle, 'preflight'> = {
      schemaVersion: PREPARED_ARTICLE_SCHEMA_VERSION,
      sourceHash: input.sourceHash,
      contentHash,
      title,
      author: input.author?.trim() || '',
      digest: input.digest?.trim() || createDigest(text),
      contentSourceUrl: input.contentSourceUrl?.trim() || '',
      needOpenComment: Boolean(input.needOpenComment),
      onlyFansCanComment: Boolean(input.onlyFansCanComment),
      html,
      cover,
      images,
      stats: {
        removedCover: coverRemoval.removed,
        removedCoverReason: coverRemoval.reason,
        removedTitle,
        imageCount: boundImages.imageCount,
        uniqueImageCount: images.length,
        compressedImageCount,
        headingCount: elements(parsedPrepared, new Set(['h1', 'h2', 'h3'])).length,
        paragraphCount: elements(parsedPrepared, new Set(['p'])).length,
        nativeListCount: nativeLists.length,
        nativeListItemCount: nativeListItems.length,
        dangerousListSectionCount,
        dangerousListParagraphCount,
        dangerousListBlockCount,
        textLength: text.length,
      },
    };
    return {
      ...articleWithoutPreflight,
      preflight: {
        passed: true,
        completedAt: (input.now?.() ?? new Date()).toISOString(),
        integrityHash: computePreparedArticleIntegrity(articleWithoutPreflight),
        checkedImageCount: images.length + 1,
        compressedImageCount,
      },
    };
  }
}
