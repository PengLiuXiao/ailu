import { createHash } from 'crypto';
import { App, Component, MarkdownRenderer, sanitizeHTMLToDom } from 'obsidian';
import { PROTOCOL_IDS } from '../ids';
import {
  ManagedPreviewUrlStore,
  sanitizeManagedPreviewMarkdown,
} from '../utils/previewSecurity';

import type { WeChatAssetDraft, WeChatPreviewSnapshot } from './types';
import {
  instrumentPublishingMarkdown,
  materializePublishingSourceMarkers,
} from '../ui/publishingSourceScroll';
import {
  applyExtractedDesignWechatStyles,
  isExtractedDesignTemplateId,
} from './extractedDesignThemes';
import { applyPaperInkWechatStyles, PAPER_INK_THEME_ID } from './paperInkTheme';
import { applySoftPastelWechatStyles, SOFT_PASTEL_THEME_ID } from './softPastelTheme';
import type { WeChatThemeDocument } from './themes';
import {
  applyWeChatTypography,
  type WeChatTypographyPreferences,
} from './typography';
import {
  buildStreamingThemePreviewDocument,
  sanitizeStreamingThemeHtml,
} from './streamingPreview';

const ATOM_ONE_DARK: Record<string, string> = {
  'hljs-comment': '#5c6370',
  'hljs-quote': '#5c6370',
  'hljs-doctag': '#c678dd',
  'hljs-keyword': '#c678dd',
  'hljs-formula': '#c678dd',
  'hljs-section': '#e06c75',
  'hljs-name': '#e06c75',
  'hljs-selector-tag': '#e06c75',
  'hljs-deletion': '#e06c75',
  'hljs-subst': '#e06c75',
  'hljs-literal': '#56b6c2',
  'hljs-string': '#98c379',
  'hljs-regexp': '#98c379',
  'hljs-addition': '#98c379',
  'hljs-attribute': '#98c379',
  'hljs-meta-string': '#98c379',
  'hljs-built_in': '#e6c07b',
  'hljs-class': '#e6c07b',
  'hljs-title': '#61aeee',
  'hljs-attr': '#d19a66',
  'hljs-variable': '#d19a66',
  'hljs-template-variable': '#d19a66',
  'hljs-type': '#e6c07b',
  'hljs-number': '#d19a66',
  'hljs-symbol': '#61aeee',
  'hljs-bullet': '#61aeee',
  'hljs-link': '#61aeee',
  'hljs-meta': '#61aeee',
  'hljs-selector-id': '#61aeee',
  'hljs-selector-class': '#61aeee',
  'hljs-emphasis': '#c9d1d9',
  'hljs-strong': '#c9d1d9',
};

const BASE_FONT_FAMILY = 'Optima-Regular, PingFangSC-light';
const STREAMING_IMAGE_RESIZE_BOUND = new WeakSet<HTMLImageElement>();
const STREAMING_INTERACTION_BOUND = new WeakSet<Document>();
const STREAMING_INTERACTION_OPTIONS = new WeakMap<Document, StreamingPreviewRenderOptions>();
const STREAMING_TOUCH_Y = new WeakMap<Document, number>();
const WECHAT_PREVIEW_URLS = new WeakMap<Component, { store: ManagedPreviewUrlStore }>();
const STREAMING_PREVIEW_URLS = new WeakMap<HTMLIFrameElement, StreamingPreviewUrlState>();

interface StreamingPreviewUrlState {
  observer: MutationObserver | null;
  releaseTimer: number | null;
  store: ManagedPreviewUrlStore;
}

interface StreamingPreviewRenderOptions {
  onResize?: () => void;
  onUserScrollUp?: () => void;
  onUserWheel?: (deltaY: number) => void;
}

function styles(element: HTMLElement, values: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, values);
}

function decorateCode(pre: HTMLElement): void {
  if (pre.parentElement?.classList.contains('ailu-wechat-code-section')) return;
  const source = pre.querySelector<HTMLElement>(':scope > code');
  const lines = source
    ? source.innerHTML.replace(/\n$/, '').split('\n')
    : [];
  source?.remove();
  for (const lineHtml of lines) {
    const line = createEl('code');
    if (lineHtml) line.appendChild(sanitizeHTMLToDom(lineHtml));
    else line.createEl('br');
    pre.appendChild(line);
  }
  const wrapper = createEl('section');
  wrapper.className = 'ailu-wechat-code-section';
  styles(wrapper, {
    display: 'flex',
    border: '1px solid rgb(60, 66, 84)',
    backgroundColor: 'rgb(39, 44, 54)',
    borderRadius: '8px',
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.1)',
  });
  const header = createEl('section');
  header.setAttribute('aria-hidden', 'true');
  styles(header, {
    display: 'block',
    height: '30px',
    paddingLeft: '12px',
    lineHeight: '30px',
    letterSpacing: '0',
    backgroundColor: '#282c34',
    borderRadius: '5px 5px 0 0',
    marginBottom: '-7px',
  });
  for (const color of ['#ff5f56', '#ffbd2e', '#27c93f']) {
    const dot = createSpan();
    dot.textContent = '●';
    styles(dot, {
      display: 'inline-block',
      marginRight: '7px',
      color,
      fontSize: '13px',
      lineHeight: '30px',
      letterSpacing: '0',
    });
    header.appendChild(dot);
  }
  pre.replaceWith(wrapper);
  wrapper.appendChild(pre);
  pre.prepend(header);
}

function decorateHeading(heading: HTMLElement): void {
  if (heading.tagName !== 'H2' || heading.querySelector(':scope > .ailu-wechat-h2-tail')) {
    return;
  }
  const tail = createSpan();
  tail.className = 'ailu-wechat-h2-tail';
  tail.setAttribute('aria-hidden', 'true');
  styles(tail, {
    position: 'absolute',
    right: '0',
    bottom: '0',
    width: '20px',
    height: '10px',
    borderTopLeftRadius: '20px',
    borderTopRightRadius: '20px',
    backgroundColor: 'rgba(46, 167, 101, 0.5)',
  });
  heading.appendChild(tail);
}

function replaceTaskCheckbox(input: HTMLInputElement): void {
  const mark = createSpan();
  mark.textContent = input.checked ? '☑' : '☐';
  styles(mark, {
    display: 'inline-block',
    marginRight: '6px',
    color: input.checked ? '#2ea765' : '#595959',
    fontSize: '16px',
  });
  input.replaceWith(mark);
}

function wrapTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('ailu-wechat-table-wrap')) continue;
    const wrapper = createEl('section');
    wrapper.className = 'ailu-wechat-table-wrap';
    styles(wrapper, {
      display: 'block',
      width: '100%',
      margin: '20px 0',
      overflowX: 'auto',
    });
    table.replaceWith(wrapper);
    wrapper.appendChild(table);
  }
}

export function applyBaseWechatStyles(root: HTMLElement): void {
  for (const forbidden of Array.from(
    root.querySelectorAll('script,style,iframe,object,embed,form,button'),
  )) {
    forbidden.remove();
  }
  for (const input of Array.from(root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))) {
    replaceTaskCheckbox(input);
  }
  wrapTables(root);
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) decorateCode(pre);
  for (const heading of Array.from(root.querySelectorAll<HTMLElement>('h2'))) decorateHeading(heading);

  styles(root, {
    display: 'block',
    boxSizing: 'border-box',
    padding: '8px 8px',
    color: '#333333',
    fontFamily: BASE_FONT_FAMILY,
    fontSize: '16px',
    letterSpacing: '1.5px',
    overflowWrap: 'break-word',
    backgroundColor: '#ffffff',
  });

  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const tag = element.tagName.toLowerCase();
    if (tag === 'p') {
      styles(element, {
        margin: element.closest('blockquote') ? '0' : '30px 8px',
        fontFamily: BASE_FONT_FAMILY,
        fontSize: '16px',
        lineHeight: '32px',
        letterSpacing: '2px',
        wordSpacing: '2px',
      });
    } else if (tag === 'h1') {
      styles(element, {
        position: 'relative',
        zIndex: '0',
        display: 'inline-block',
        height: '40px',
        maxWidth: '100%',
        margin: '10px 0',
        paddingRight: '30px',
        paddingLeft: '30px',
        color: '#ffffff',
        backgroundColor: '#2ea765',
        borderBottomRightRadius: '100px',
        fontSize: '19px',
        fontWeight: '700',
        lineHeight: '40px',
        overflow: 'visible',
        boxShadow: '100vw 0 0 100vw rgb(251, 251, 251)',
        clipPath: 'inset(0 -100vw 0 0)',
        boxSizing: 'border-box',
      });
    } else if (tag === 'h2') {
      styles(element, {
        position: 'relative',
        display: 'block',
        margin: '16px auto 8px',
        paddingBottom: '6px',
        color: '#2ea765',
        borderBottom: '4px solid #2ea765',
        fontSize: '18px',
        fontWeight: '700',
        lineHeight: '1.3',
      });
    } else if (tag === 'h3') {
      styles(element, {
        margin: '17px auto 5px',
        paddingTop: '6px',
        paddingRight: '25px',
        paddingLeft: '5px',
        color: '#2ea765',
        borderBottom: '1px solid #dddddd',
        fontSize: '17px',
        fontWeight: '700',
        lineHeight: '1.1',
        textDecoration: 'underline 3px #2ea765',
        textUnderlineOffset: '6px',
      });
    } else if (tag === 'h4') {
      styles(element, {
        margin: '16px auto 5px',
        paddingTop: '6px',
        paddingRight: '5px',
        paddingLeft: '5px',
        color: '#2ea765',
        borderBottom: '1px solid #dddddd',
        fontSize: '16px',
        fontWeight: '700',
        lineHeight: '1.1',
        textDecoration: 'underline 2px #2ea765',
        textUnderlineOffset: '5px',
      });
    } else if (tag === 'ul') {
      styles(element, {
        marginBottom: '8px',
        color: '#595959',
        fontSize: '15px',
        listStyleType: 'circle',
      });
    } else if (tag === 'ol') {
      styles(element, {
        padding: '8px 8px',
        color: '#595959',
        fontSize: '15px',
        fontFamily: BASE_FONT_FAMILY,
        fontWeight: '400',
        letterSpacing: '1.5px',
      });
    } else if (tag === 'li') {
      styles(element, {
        marginBottom: '8px',
        ...(element.closest('ol') ? { fontSize: '16px' } : {}),
      });
    } else if (tag === 'blockquote') {
      styles(element, {
        margin: '20px 0',
        padding: '10px 20px',
        color: '#2c3e50',
        backgroundColor: '#f0fdf4',
        borderLeft: '4px solid #42b983',
        borderRadius: '4px',
        fontSize: '16px',
        lineHeight: '1.6',
      });
      for (const paragraph of Array.from(element.querySelectorAll<HTMLElement>(':scope > p'))) {
        styles(paragraph, { margin: '0', padding: '0' });
      }
    } else if (tag === 'a') {
      styles(element, {
        color: '#399003',
        fontWeight: '400',
        borderBottom: '1px solid #42b983',
        overflowWrap: 'anywhere',
      });
    } else if (tag === 'strong') {
      styles(element, { color: '#2ea765', fontWeight: '700' });
    } else if (tag === 'em') {
      styles(element, { color: '#2ea765', fontStyle: 'italic', fontWeight: '700' });
    } else if (tag === 'del') {
      styles(element, { color: '#2ea765' });
    } else if (tag === 'hr') {
      styles(element, {
        height: '1px',
        padding: '0',
        border: '0',
        borderTop: '2px solid #2ea765',
      });
    } else if (tag === 'img') {
      styles(element, {
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        margin: '20px auto 30px',
        borderRadius: '6px',
        objectFit: 'contain',
        boxShadow: '2px 4px 7px #999999',
      });
    } else if (tag === 'table') {
      styles(element, {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'auto',
        border: '1px solid #42b983',
        borderRadius: '8px',
        overflow: 'hidden',
        fontSize: '16px',
        overflowWrap: 'break-word',
      });
    } else if (tag === 'th') {
      styles(element, {
        padding: '12px 8px',
        color: '#ffffff',
        backgroundColor: '#42b983',
        borderBottom: '2px solid #dddddd',
        fontWeight: '700',
        textAlign: 'center',
        width: 'auto',
        maxWidth: '300px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      });
    } else if (tag === 'td') {
      styles(element, {
        maxWidth: '300px',
        padding: '12px 8px',
        backgroundColor: element.parentElement instanceof HTMLTableRowElement
          && element.parentElement.rowIndex % 2
          ? '#f9f9f9'
          : '#ffffff',
        borderBottom: '1px solid #dddddd',
        textAlign: 'left',
        verticalAlign: 'top',
        width: 'auto',
        overflow: 'hidden',
        overflowWrap: 'break-word',
        textOverflow: 'ellipsis',
      });
    } else if (tag === 'pre') {
      styles(element, {
        display: 'block',
        margin: '0',
        padding: '0',
        position: 'relative',
        color: '#abb2bf',
        backgroundColor: '#282c34',
        borderRadius: '5px',
        overflowX: 'auto',
        whiteSpace: 'pre',
      });
    } else if (tag === 'code') {
      const inBlock = Boolean(element.closest('pre'));
      styles(element, inBlock ? {
        display: 'block',
        padding: '0.9em',
        color: '#abb2bf',
        backgroundColor: 'transparent',
        fontFamily: 'Menlo, Monaco, Consolas, Courier New, monospace',
        fontSize: '0.8em',
        lineHeight: '1.6em',
        letterSpacing: '1.5px',
        whiteSpace: 'pre',
        textWrap: 'nowrap',
      } : {
        display: 'inline',
        color: 'rgb(207, 208, 203)',
      });
    } else if (element.classList.contains('footnote-word')
      || element.classList.contains('footnote-ref')) {
      styles(element, { color: '#595959', fontWeight: '400' });
    } else if (element.classList.contains('footnotes')) {
      styles(element, {
        padding: '20px',
        color: '#595959',
        backgroundColor: '#ffffff',
        border: '1px solid #4caf50',
        borderRadius: '6px',
        fontSize: '16px',
      });
    }
    for (const className of Array.from(element.classList)) {
      const color = ATOM_ONE_DARK[className];
      if (color) element.style.color = color;
    }
  }
}

function snapshotAssetMap(
  snapshot: WeChatPreviewSnapshot,
  store: ManagedPreviewUrlStore,
): Map<string, string> {
  return new Map(snapshot.assets.map(asset => [
    asset.token,
    store.setVerifiedImage(asset.token, asset.body, asset.mimeType, asset.contentHash),
  ]));
}

function beginWeChatPreviewUrls(component: Component): ManagedPreviewUrlStore {
  let state = WECHAT_PREVIEW_URLS.get(component);
  if (!state) {
    state = { store: new ManagedPreviewUrlStore() };
    WECHAT_PREVIEW_URLS.set(component, state);
    component.register(() => {
      state?.store.revokeAll();
      WECHAT_PREVIEW_URLS.delete(component);
    });
    return state.store;
  }
  state.store.revokeAll();
  state.store = new ManagedPreviewUrlStore();
  return state.store;
}

function releaseStreamingPreviewUrls(
  iframe: HTMLIFrameElement,
  state: StreamingPreviewUrlState,
): void {
  if (state.releaseTimer !== null) window.clearTimeout(state.releaseTimer);
  state.releaseTimer = null;
  state.observer?.disconnect();
  state.observer = null;
  state.store.revokeAll();
  if (STREAMING_PREVIEW_URLS.get(iframe) === state) STREAMING_PREVIEW_URLS.delete(iframe);
}

function beginStreamingPreviewUrls(
  iframe: HTMLIFrameElement,
  snapshot: WeChatPreviewSnapshot,
): { replacements: Map<string, string>; state: StreamingPreviewUrlState } {
  const previous = STREAMING_PREVIEW_URLS.get(iframe);
  if (previous) releaseStreamingPreviewUrls(iframe, previous);
  const state: StreamingPreviewUrlState = {
    observer: null,
    releaseTimer: null,
    store: new ManagedPreviewUrlStore(),
  };
  STREAMING_PREVIEW_URLS.set(iframe, state);
  try {
    const replacements = snapshotAssetMap(snapshot, state.store);
    if (typeof MutationObserver !== 'undefined' && iframe.ownerDocument.documentElement) {
      state.observer = new MutationObserver(() => {
        if (!iframe.isConnected) releaseStreamingPreviewUrls(iframe, state);
      });
      state.observer.observe(iframe.ownerDocument.documentElement, { childList: true, subtree: true });
    }
    return { replacements, state };
  } catch (error) {
    releaseStreamingPreviewUrls(iframe, state);
    throw error;
  }
}

function sanitizeStreamingHtmlMedia(
  html: string,
  allowedObjectUrls: ReadonlySet<string>,
): string {
  const allowed = new Set(Array.from(allowedObjectUrls).filter(url => url.startsWith('blob:')));
  const safeImages: string[] = [];
  let source = html.replace(
    /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    (tag) => {
      const match = tag.match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
      if (!allowed.has(url)) return '【媒体未加载】';
      const token = `AILU_SAFE_STREAMING_IMAGE_${safeImages.length}_`;
      safeImages.push(`<img src="${url}">`);
      return token;
    },
  );
  source = source.replace(
    /<\/?(?:img|picture|source|track|video|audio|iframe|object|embed|svg|style|link|base|meta)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    '【媒体未加载】',
  );
  source = source.replace(
    /<\s*\/?\s*(?:img|picture|source|track|video|audio|iframe|object|embed|svg|style|link|base|meta)\b/gi,
    '&lt;blocked-media',
  );
  for (let index = 0; index < safeImages.length; index += 1) {
    source = source.split(`AILU_SAFE_STREAMING_IMAGE_${index}_`).join(safeImages[index]);
  }
  const wrapper = createDiv();
  wrapper.appendChild(sanitizeHTMLToDom(source));
  for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>(
    'style,link,base,meta[http-equiv],video,audio,source,track,iframe,object,embed,svg',
  ))) {
    element.replaceWith(document.createTextNode('【媒体未加载】'));
  }
  for (const image of Array.from(wrapper.querySelectorAll<HTMLImageElement>('img'))) {
    const source = image.getAttribute('src')?.trim() ?? '';
    if (!allowed.has(source)) {
      image.replaceWith(document.createTextNode('【媒体未加载】'));
      continue;
    }
    image.removeAttribute('srcset');
    image.removeAttribute('crossorigin');
    image.removeAttribute('referrerpolicy');
  }
  for (const element of Array.from(wrapper.querySelectorAll<HTMLElement>('*'))) {
    element.removeAttribute('background');
    element.removeAttribute('poster');
    element.removeAttribute('srcset');
    const style = element.getAttribute('style');
    if (style && /(?:url\s*\(|@import)/i.test(style)) element.removeAttribute('style');
    if (element.tagName === 'INPUT' && element.getAttribute('type')?.toLowerCase() === 'image') {
      element.removeAttribute('src');
    }
  }
  return wrapper.innerHTML;
}

function releaseStreamingPreviewUrlsWhenSettled(
  iframe: HTMLIFrameElement,
  state: StreamingPreviewUrlState,
): void {
  if (STREAMING_PREVIEW_URLS.get(iframe) !== state) return;
  const images = Array.from(iframe.contentDocument?.images ?? []);
  const pending = images.filter(image => !image.complete);
  if (!pending.length) {
    window.queueMicrotask(() => releaseStreamingPreviewUrls(iframe, state));
    return;
  }
  let remaining = pending.length;
  const settled = (): void => {
    remaining -= 1;
    if (remaining === 0) releaseStreamingPreviewUrls(iframe, state);
  };
  for (const image of pending) {
    image.addEventListener('load', settled, { once: true });
    image.addEventListener('error', settled, { once: true });
  }
  state.releaseTimer = window.setTimeout(
    () => releaseStreamingPreviewUrls(iframe, state),
    30_000,
  );
}

function replaceAssetTokens(
  markdown: string,
  replacements: Map<string, string>,
): string {
  let result = markdown;
  for (const [token, url] of replacements) result = result.split(token).join(url);
  return result;
}

function canMorphStreamingNode(current: Node, next: Node): boolean {
  if (current.nodeType !== next.nodeType) return false;
  if (current.nodeType === Node.ELEMENT_NODE) {
    return (current as Element).tagName === (next as Element).tagName;
  }
  return true;
}

function syncStreamingAttributes(current: Element, next: Element): void {
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
}

function morphStreamingChildren(current: Node & ParentNode, next: ParentNode): void {
  const currentChildren = Array.from(current.childNodes);
  const nextChildren = Array.from(next.childNodes);
  const sharedLength = Math.min(currentChildren.length, nextChildren.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const currentChild = currentChildren[index];
    const nextChild = nextChildren[index];
    if (!canMorphStreamingNode(currentChild, nextChild)) {
      currentChild.replaceWith(nextChild);
      continue;
    }
    if (currentChild.nodeType === Node.TEXT_NODE || currentChild.nodeType === Node.COMMENT_NODE) {
      if (currentChild.nodeValue !== nextChild.nodeValue) currentChild.nodeValue = nextChild.nodeValue;
      continue;
    }
    if (currentChild.nodeType === Node.ELEMENT_NODE) {
      const currentElement = currentChild as Element;
      const nextElement = nextChild as Element;
      syncStreamingAttributes(currentElement, nextElement);
      morphStreamingChildren(currentElement, nextElement);
    }
  }

  for (const child of currentChildren.slice(nextChildren.length)) child.remove();
  for (const child of nextChildren.slice(currentChildren.length)) current.appendChild(child);
}

function resizeStreamingIframe(
  iframe: HTMLIFrameElement,
  onResize?: () => void,
): void {
  const document = iframe.contentDocument;
  if (!document) return;
  const height = Math.max(
    240,
    document.documentElement?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0,
  );
  iframe.style.height = `${height}px`;
  onResize?.();
  for (const image of Array.from(document.images)) {
    if (image.complete || STREAMING_IMAGE_RESIZE_BOUND.has(image)) continue;
    STREAMING_IMAGE_RESIZE_BOUND.add(image);
    const settled = (): void => {
      image.removeEventListener('load', settled);
      image.removeEventListener('error', settled);
      resizeStreamingIframe(iframe, onResize);
    };
    image.addEventListener('load', settled);
    image.addEventListener('error', settled);
  }
}

function bindStreamingPreviewInteraction(
  document: Document,
  options: StreamingPreviewRenderOptions,
): void {
  STREAMING_INTERACTION_OPTIONS.set(document, options);
  if (STREAMING_INTERACTION_BOUND.has(document)) return;
  STREAMING_INTERACTION_BOUND.add(document);
  document.addEventListener('wheel', (event) => {
    const currentOptions = STREAMING_INTERACTION_OPTIONS.get(document);
    if (event.deltaY < 0) currentOptions?.onUserScrollUp?.();
    currentOptions?.onUserWheel?.(event.deltaY);
  }, { passive: true });
  document.addEventListener('touchstart', (event) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined) STREAMING_TOUCH_Y.set(document, y);
  }, { passive: true });
  document.addEventListener('touchmove', (event) => {
    const previousY = STREAMING_TOUCH_Y.get(document);
    const currentY = event.touches[0]?.clientY;
    if (previousY === undefined || currentY === undefined) return;
    if (currentY - previousY > 6) {
      STREAMING_INTERACTION_OPTIONS.get(document)?.onUserScrollUp?.();
    }
    STREAMING_TOUCH_Y.set(document, currentY);
  }, { passive: true });
}

export function renderStreamingWeChatThemePreview(
  snapshot: WeChatPreviewSnapshot,
  iframe: HTMLIFrameElement,
  html: string,
  options: StreamingPreviewRenderOptions = {},
): void {
  const preview = beginStreamingPreviewUrls(iframe, snapshot);
  const replaced = replaceAssetTokens(html, preview.replacements);
  const safeHtml = sanitizeStreamingHtmlMedia(
    sanitizeStreamingThemeHtml(replaced),
    preview.state.store.allowedObjectUrls(),
  );
  if (iframe.dataset.ailuStreamingReady !== 'true') {
    iframe.dataset.ailuStreamingReady = 'true';
    iframe.onload = () => {
      if (iframe.contentDocument) bindStreamingPreviewInteraction(iframe.contentDocument, options);
      resizeStreamingIframe(iframe, options.onResize);
      const current = STREAMING_PREVIEW_URLS.get(iframe);
      if (current) releaseStreamingPreviewUrlsWhenSettled(iframe, current);
    };
    iframe.srcdoc = buildStreamingThemePreviewDocument(safeHtml);
    return;
  }
  const document = iframe.contentDocument;
  if (document?.body) {
    bindStreamingPreviewInteraction(document, options);
    const nextBody = sanitizeHTMLToDom(
      safeHtml
        || '<p style="margin:24px 0;text-align:center;color:#8b949e;font-size:13px;">正在读取主题并生成排版…</p>',
    );
    morphStreamingChildren(document.body, nextBody);
    window.requestAnimationFrame(() => {
      resizeStreamingIframe(iframe, options.onResize);
      releaseStreamingPreviewUrlsWhenSettled(iframe, preview.state);
    });
    return;
  }
  iframe.srcdoc = buildStreamingThemePreviewDocument(safeHtml);
}

export async function renderWeChatArticle(
  app: App,
  component: Component,
  snapshot: WeChatPreviewSnapshot,
  container: HTMLElement,
  options: {
    uploadedUrls?: Map<string, string>;
    themeDocument?: WeChatThemeDocument | null;
    typography?: WeChatTypographyPreferences;
  } = {},
): Promise<void> {
  container.empty();
  const previewUrls = beginWeChatPreviewUrls(component);
  container.classList.remove(
    'ailu-wechat-article',
    'ailu-wechat-paper-ink-article',
    'ailu-wechat-soft-pastel-article',
    'ailu-wechat-extracted-design-article',
    'ailu-wechat-skill-article',
  );
  delete container.dataset.ailuWechatTheme;
  const themeDocument = options.themeDocument;
  const templateThemeId = themeDocument?.themeId === PAPER_INK_THEME_ID
    ? PAPER_INK_THEME_ID
    : themeDocument?.themeId === SOFT_PASTEL_THEME_ID
      ? SOFT_PASTEL_THEME_ID
      : isExtractedDesignTemplateId(themeDocument?.themeId)
        ? themeDocument.themeId
        : PAPER_INK_THEME_ID;
  container.dataset.ailuWechatTheme = templateThemeId;
  container.classList.add(
    templateThemeId === PAPER_INK_THEME_ID
      ? 'ailu-wechat-paper-ink-article'
      : templateThemeId === SOFT_PASTEL_THEME_ID
        ? 'ailu-wechat-soft-pastel-article'
        : isExtractedDesignTemplateId(templateThemeId)
          ? 'ailu-wechat-extracted-design-article'
          : 'ailu-wechat-paper-ink-article',
  );
  try {
    const markdown = replaceAssetTokens(snapshot.markdown, snapshotAssetMap(snapshot, previewUrls));
    await MarkdownRenderer.render(
      app,
      instrumentPublishingMarkdown(
        sanitizeManagedPreviewMarkdown(markdown, previewUrls.allowedObjectUrls()),
        snapshot.sourceLineMap,
      ),
      container,
      snapshot.sourcePath,
      component,
    );
  } catch (error) {
    if (WECHAT_PREVIEW_URLS.get(component)?.store === previewUrls) previewUrls.revokeAll();
    throw error;
  }
  materializePublishingSourceMarkers(container);
  if (templateThemeId === PAPER_INK_THEME_ID) applyPaperInkWechatStyles(container);
  else if (templateThemeId === SOFT_PASTEL_THEME_ID) applySoftPastelWechatStyles(container);
  else if (isExtractedDesignTemplateId(templateThemeId)) {
    applyExtractedDesignWechatStyles(container, templateThemeId);
  } else applyPaperInkWechatStyles(container);
  if (options.typography) applyWeChatTypography(container, options.typography);
}

function imageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('公式图片渲染失败'));
    image.src = url;
  });
}

async function svgToPng(svg: SVGElement): Promise<ArrayBuffer> {
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const viewBox = clone.getAttribute('viewBox')?.split(/\s+/).map(Number);
  const width = Math.max(1, Number(clone.getAttribute('width')) || viewBox?.[2] || 800);
  const height = Math.max(1, Number(clone.getAttribute('height')) || viewBox?.[3] || 80);
  const source = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  try {
    const image = await imageFromUrl(url);
    const scale = Math.min(3, Math.max(1, 1200 / width));
    const canvas = createEl('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建公式画布');
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('公式图片生成失败')), 'image/png');
    });
    return blob.arrayBuffer();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function replaceFormulaSvgs(
  root: HTMLElement,
  upload: (asset: WeChatAssetDraft) => Promise<string>,
  applyThemeStyles = true,
): Promise<void> {
  const formulas = Array.from(root.querySelectorAll<SVGElement>('mjx-container svg, .math svg'));
  for (let index = 0; index < formulas.length; index += 1) {
    const svg = formulas[index];
    // Publishing prepares a detached clone so the visible preview never mutates.
    // `contains` also skips a formula that was already replaced by an earlier pass.
    if (!root.contains(svg)) continue;
    const body = await svgToPng(svg);
    const contentHash = createHash('sha256').update(Buffer.from(body)).digest('hex');
    const asset: WeChatAssetDraft = {
      token: `${PROTOCOL_IDS.wechatFormulaScheme}${contentHash}`,
      source: `formula-${index + 1}`,
      fileName: `formula-${contentHash.slice(0, 12)}.png`,
      mimeType: 'image/png',
      contentHash,
      body,
      previewUrl: '',
    };
    const url = await upload(asset);
    const image = createEl('img');
    image.src = url;
    image.alt = '公式';
    const target = svg.closest('mjx-container, .math') ?? svg;
    target.replaceWith(image);
  }
  if (applyThemeStyles) {
    if (root.dataset.ailuWechatTheme === PAPER_INK_THEME_ID) {
      applyPaperInkWechatStyles(root);
    } else if (root.dataset.ailuWechatTheme === SOFT_PASTEL_THEME_ID) {
      applySoftPastelWechatStyles(root);
    } else if (isExtractedDesignTemplateId(root.dataset.ailuWechatTheme)) {
      applyExtractedDesignWechatStyles(root, root.dataset.ailuWechatTheme);
    } else {
      applyPaperInkWechatStyles(root);
    }
  }
}

export function serializeWeChatArticle(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const elements = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (!['href', 'src', 'alt', 'title', 'style', 'width', 'height'].includes(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.instanceOf(HTMLAnchorElement)) {
      const href = element.getAttribute('href') || '';
      if (!/^(?:https?:|mailto:)/i.test(href)) element.removeAttribute('href');
    }
    if (element.instanceOf(HTMLImageElement)) {
      const src = element.getAttribute('src') || '';
      if (!/^https:\/\//i.test(src)) {
        const notice = createSpan();
        notice.textContent = element.alt ? `图片：${element.alt}` : '图片无法随文章发布';
        styles(notice, {
          display: 'block',
          margin: '20px 0',
          color: '#888888',
          fontSize: '13px',
          textAlign: 'center',
        });
        element.replaceWith(notice);
      }
    }
  }
  const serializer = new XMLSerializer();
  return serializer.serializeToString(clone);
}
