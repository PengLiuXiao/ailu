import { copyXArticleSourceLineAttributes } from './domMapper';

export interface XPostReference {
  handle: string;
  statusId: string;
  url: string;
}

export interface XArticleEnhancementOptions {
  copiedCodeLabel?: string;
  copyCodeFailedLabel?: string;
  copyCodeLabel?: string;
  copyText?: (text: string) => Promise<void> | void;
  postBodyLabel?: string;
  postLinkLabel?: string;
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && typeof (node as Element).tagName === 'string';
}

function copyTextFunction(
  documentRef: Document,
  provided: XArticleEnhancementOptions['copyText'],
): XArticleEnhancementOptions['copyText'] {
  if (provided) return provided;
  const clipboard = documentRef.defaultView?.navigator.clipboard;
  if (!clipboard?.writeText) return undefined;
  return value => clipboard.writeText(value);
}

export function parseXPostUrl(value: string): XPostReference | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'x.com' && hostname !== 'twitter.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 3 || segments[1]?.toLowerCase() !== 'status') return null;
    if (!/^\d+$/.test(segments[2] ?? '')) return null;
    return {
      handle: decodeURIComponent(segments[0]),
      statusId: segments[2],
      url: value,
    };
  } catch {
    return null;
  }
}

export function isXArticleExternalUrl(value: string, currentHref?: string | null): boolean {
  try {
    const url = currentHref ? new URL(value, currentHref) : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!currentHref) return true;
    const current = new URL(currentHref);
    return url.origin !== current.origin;
  } catch {
    return false;
  }
}

function meaningfulNodes(element: HTMLElement): Node[] {
  return Array.from(element.childNodes).filter(node => {
    if (node.nodeType === 3) return Boolean(node.textContent?.trim());
    if (!isElement(node)) return false;
    return node.tagName !== 'BR' || Boolean(node.textContent?.trim());
  });
}

function createCopyIcon(documentRef: Document): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = documentRef.createElementNS(namespace, 'svg');
  svg.classList.add('ailu-x-code-copy-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = documentRef.createElementNS(namespace, 'path');
  path.setAttribute(
    'd',
    'M19.5 2A2.5 2.5 0 0 1 22 4.5v11a2.5 2.5 0 0 1-2 2.45V4.5a.5.5 0 0 0-.5-.5H6.05A2.5 2.5 0 0 1 8.5 2h11Zm-4 4A2.5 2.5 0 0 1 18 8.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 2 19.5v-11A2.5 2.5 0 0 1 4.5 6h11ZM4 19.5a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11a.5.5 0 0 0-.5.5v11Z',
  );
  svg.appendChild(path);
  return svg;
}

function enhanceCodeBlocks(
  container: HTMLElement,
  options: XArticleEnhancementOptions,
): void {
  const copyText = copyTextFunction(container.ownerDocument, options.copyText);
  for (const code of Array.from(container.querySelectorAll<HTMLElement>('pre > code'))) {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('ailu-x-code-frame')) continue;
    const documentRef = pre.ownerDocument;
    const languageClass = Array.from(code.classList).find(name => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length).toLowerCase() || 'text';

    const frame = documentRef.createElement('div');
    frame.className = 'ailu-x-code-frame';
    frame.dataset.ailuXLanguage = language;
    copyXArticleSourceLineAttributes(pre, frame);

    const toolbar = documentRef.createElement('div');
    toolbar.className = 'ailu-x-code-toolbar';
    const languageLabel = documentRef.createElement('span');
    languageLabel.className = 'ailu-x-code-language';
    languageLabel.textContent = language;
    toolbar.appendChild(languageLabel);

    const copyButton = documentRef.createElement('button');
    copyButton.className = 'ailu-x-code-copy';
    copyButton.type = 'button';
    copyButton.title = options.copyCodeLabel ?? '复制代码';
    copyButton.setAttribute('aria-label', copyButton.title);
    copyButton.dataset.ailuXCopyState = 'idle';
    copyButton.appendChild(createCopyIcon(documentRef));
    if (!copyText) copyButton.disabled = true;
    copyButton.addEventListener('click', () => {
      if (!copyText) return;
      void Promise.resolve(copyText(code.textContent ?? '')).then(
        () => {
          copyButton.dataset.ailuXCopyState = 'success';
          copyButton.title = options.copiedCodeLabel ?? '已复制';
          documentRef.defaultView?.setTimeout(() => {
            copyButton.dataset.ailuXCopyState = 'idle';
            copyButton.title = options.copyCodeLabel ?? '复制代码';
          }, 1200);
        },
        () => {
          copyButton.dataset.ailuXCopyState = 'error';
          copyButton.title = options.copyCodeFailedLabel ?? '复制失败';
          documentRef.defaultView?.setTimeout(() => {
            copyButton.dataset.ailuXCopyState = 'idle';
            copyButton.title = options.copyCodeLabel ?? '复制代码';
          }, 1200);
        },
      );
    });
    toolbar.appendChild(copyButton);

    pre.classList.add('ailu-x-code-block');
    pre.replaceWith(frame);
    frame.append(toolbar, pre);
  }
}

function standaloneParagraphTarget(paragraph: HTMLElement): HTMLElement | null {
  if (paragraph.tagName === 'P') return paragraph;
  if (!paragraph.classList.contains('ailu-x-block-content')) return null;
  const shell = paragraph.parentElement;
  return shell?.classList.contains('ailu-x-paragraph') ? shell : null;
}

function enhanceStandaloneImages(container: HTMLElement): void {
  const paragraphs = Array.from(
    container.querySelectorAll<HTMLElement>('p, .ailu-x-paragraph > .ailu-x-block-content'),
  );
  for (const paragraph of paragraphs) {
    const nodes = meaningfulNodes(paragraph);
    if (nodes.length !== 1 || !isElement(nodes[0]) || nodes[0].tagName !== 'IMG') continue;
    const image = nodes[0] as HTMLImageElement;
    const target = standaloneParagraphTarget(paragraph);
    if (!target) continue;

    const figure = paragraph.ownerDocument.createElement('figure');
    figure.className = 'ailu-x-figure';
    copyXArticleSourceLineAttributes(target, figure);
    copyXArticleSourceLineAttributes(paragraph, figure);
    target.replaceWith(figure);
    figure.appendChild(image);
    const caption = image.alt.trim();
    if (caption) {
      const figcaption = paragraph.ownerDocument.createElement('figcaption');
      figcaption.className = 'ailu-x-figcaption';
      figcaption.textContent = caption;
      figure.appendChild(figcaption);
    }
  }
}

export function createLocalXPostCard(
  documentRef: Document,
  post: XPostReference,
  options: Pick<XArticleEnhancementOptions, 'postBodyLabel' | 'postLinkLabel'> = {},
): HTMLElement {
  const card = documentRef.createElement('article');
  card.className = 'ailu-x-post-card';
  card.dataset.ailuXPostUrl = post.url;
  card.dataset.ailuXPostId = post.statusId;

  const header = documentRef.createElement('header');
  header.className = 'ailu-x-post-card-header';
  const avatar = documentRef.createElement('span');
  avatar.className = 'ailu-x-post-card-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = post.handle.slice(0, 1).toUpperCase();
  const identity = documentRef.createElement('span');
  identity.className = 'ailu-x-post-card-identity';
  const name = documentRef.createElement('strong');
  name.className = 'ailu-x-post-card-name';
  name.textContent = post.handle;
  const handle = documentRef.createElement('span');
  handle.className = 'ailu-x-post-card-handle';
  handle.textContent = `@${post.handle}`;
  identity.append(name, handle);
  header.append(avatar, identity);
  card.appendChild(header);

  const body = documentRef.createElement('p');
  body.className = 'ailu-x-post-card-body';
  body.textContent = options.postBodyLabel ?? `X Post · ${post.statusId}`;
  card.appendChild(body);

  const link = documentRef.createElement('a');
  link.className = 'ailu-x-post-card-link';
  link.href = post.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = options.postLinkLabel ?? '在 X 上查看';
  card.appendChild(link);
  return card;
}

function enhanceXPostLinks(
  container: HTMLElement,
  options: XArticleEnhancementOptions,
): void {
  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const post = parseXPostUrl(anchor.href);
    if (!post) continue;
    const paragraph = anchor.closest<HTMLElement>(
      '.ailu-x-paragraph > .ailu-x-block-content, p',
    );
    if (!paragraph) continue;
    const nodes = meaningfulNodes(paragraph);
    if (nodes.length !== 1 || nodes[0] !== anchor) continue;
    const target = standaloneParagraphTarget(paragraph);
    if (!target) continue;
    const card = createLocalXPostCard(paragraph.ownerDocument, post, options);
    copyXArticleSourceLineAttributes(target, card);
    copyXArticleSourceLineAttributes(paragraph, card);
    target.replaceWith(card);
  }
}

function enhanceExternalLinks(container: HTMLElement): void {
  const currentHref = (() => {
    try {
      return container.ownerDocument.location?.href ?? null;
    } catch {
      return null;
    }
  })();
  for (const anchor of Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (!isXArticleExternalUrl(anchor.href, currentHref)) continue;
    anchor.classList.add('ailu-x-external-link');
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
}

/**
 * Applies local-only preview enhancements. This function never injects scripts,
 * calls fetch, or invokes X/Twitter widget APIs; standalone post URLs always
 * become deterministic fallback cards built from the URL itself.
 */
export function enhanceXArticlePreview(
  container: HTMLElement,
  options: XArticleEnhancementOptions = {},
): void {
  enhanceCodeBlocks(container, options);
  enhanceStandaloneImages(container);
  enhanceXPostLinks(container, options);
  enhanceExternalLinks(container);
}

export const enhanceArticlePreview = enhanceXArticlePreview;
