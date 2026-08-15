const SOURCE_LINE_ATTRIBUTE_PREFIX = 'data-ailu-source-line-';

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && typeof (node as Element).tagName === 'string';
}

function hasClass(element: Element, className: string): boolean {
  return element.classList.contains(className);
}

export function copyXArticleSourceLineAttributes(
  source: Element,
  target: HTMLElement,
): void {
  for (const attribute of Array.from(source.attributes)) {
    if (attribute.name.startsWith(SOURCE_LINE_ATTRIBUTE_PREFIX)) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

function copyNestedSourceLineAttributes(source: Element, target: HTMLElement): void {
  copyXArticleSourceLineAttributes(source, target);
  const nested = source.querySelector<HTMLElement>(
    '[data-ailu-source-line-start][data-ailu-source-line-end]',
  );
  if (nested) copyXArticleSourceLineAttributes(nested, target);
}

function createBlockShell(
  documentRef: Document,
  modifierClass: string,
): { content: HTMLDivElement; shell: HTMLDivElement } {
  const shell = documentRef.createElement('div');
  shell.className = `ailu-x-block ${modifierClass}`;
  const content = documentRef.createElement('div');
  content.className = 'ailu-x-block-content';
  shell.appendChild(content);
  return { content, shell };
}

function moveChildren(source: Node, target: Node): void {
  while (source.firstChild) target.appendChild(source.firstChild);
}

function mapParagraph(documentRef: Document, paragraph: HTMLElement): HTMLElement {
  const { content, shell } = createBlockShell(documentRef, 'ailu-x-paragraph');
  copyXArticleSourceLineAttributes(paragraph, shell);
  moveChildren(paragraph, content);
  return shell;
}

function mapHeading(documentRef: Document, heading: HTMLElement): HTMLElement {
  const level = Math.min(6, Math.max(1, Number(heading.tagName.slice(1)) || 2));
  const { content, shell } = createBlockShell(
    documentRef,
    `ailu-x-heading ailu-x-heading--${level}`,
  );
  shell.dataset.ailuXHeadingLevel = String(level);
  copyXArticleSourceLineAttributes(heading, shell);
  moveChildren(heading, content);
  return shell;
}

function mapBlockquote(documentRef: Document, blockquote: HTMLElement): HTMLElement {
  const { content, shell } = createBlockShell(documentRef, 'ailu-x-blockquote');
  copyXArticleSourceLineAttributes(blockquote, shell);
  moveChildren(blockquote, content);
  return shell;
}

function mapSeparator(documentRef: Document, separator: HTMLElement): HTMLElement {
  const mapped = documentRef.createElement('div');
  mapped.className = 'ailu-x-separator';
  mapped.setAttribute('role', 'separator');
  copyXArticleSourceLineAttributes(separator, mapped);
  return mapped;
}

function directListItems(list: HTMLElement): HTMLElement[] {
  return Array.from(list.children).filter(child => child.tagName === 'LI') as HTMLElement[];
}

function mapListItems(documentRef: Document, list: HTMLElement): void {
  const ordered = list.tagName === 'OL';
  list.classList.add('ailu-x-list', ordered ? 'ailu-x-list--ordered' : 'ailu-x-list--unordered');

  for (const item of directListItems(list)) {
    item.classList.add('ailu-x-list-item');
    const nestedLists = Array.from(item.children)
      .filter(child => child.tagName === 'OL' || child.tagName === 'UL') as HTMLElement[];
    const inlineNodes = Array.from(item.childNodes).filter(node => {
      if (!isElement(node)) return node.nodeType === 3 && Boolean(node.textContent?.trim());
      return node.tagName !== 'OL' && node.tagName !== 'UL';
    });

    if (inlineNodes.length) {
      const content = documentRef.createElement('div');
      content.className = 'ailu-x-block-content ailu-x-list-item-content';
      for (const node of inlineNodes) {
        if (isElement(node) && (node.tagName === 'P' || node.tagName === 'SECTION')) {
          copyNestedSourceLineAttributes(node, content);
          moveChildren(node, content);
          node.remove();
        } else {
          content.appendChild(node);
        }
      }
      item.insertBefore(content, item.firstChild);
    }

    for (const nested of nestedLists) mapListItems(documentRef, nested);
  }
}

function mapList(documentRef: Document, list: HTMLElement): HTMLElement {
  mapListItems(documentRef, list);
  list.classList.add('ailu-x-block');
  return list;
}

function wrapStandalone(documentRef: Document, element: HTMLElement): HTMLElement {
  const { content, shell } = createBlockShell(documentRef, 'ailu-x-standalone');
  copyXArticleSourceLineAttributes(element, shell);
  content.appendChild(element);
  return shell;
}

function mapElement(documentRef: Document, element: HTMLElement): HTMLElement {
  const tagName = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) return mapHeading(documentRef, element);
  if (tagName === 'p') return mapParagraph(documentRef, element);
  if (tagName === 'blockquote') return mapBlockquote(documentRef, element);
  if (tagName === 'ol' || tagName === 'ul') return mapList(documentRef, element);
  if (tagName === 'hr') return mapSeparator(documentRef, element);
  if (tagName === 'pre') {
    element.classList.add('ailu-x-code-block');
    return element;
  }
  return wrapStandalone(documentRef, element);
}

function existingMappedContent(container: HTMLElement): HTMLElement | null {
  if (container.children.length !== 1) return null;
  const template = container.firstElementChild;
  if (!template || !hasClass(template, 'ailu-x-template')) return null;
  return template.querySelector<HTMLElement>('.ailu-x-content');
}

/**
 * Rebuilds Markdown-renderer output into a local X Article-like block tree.
 * The mapper only creates `ailu-x-*` classes and copies Studio source-line
 * annotations to replacement shells so editor/preview scroll sync can survive.
 */
export function remapXArticleDom(container: HTMLElement): HTMLElement {
  const existing = existingMappedContent(container);
  if (existing) return existing;

  const documentRef = container.ownerDocument;
  const mappedNodes: Node[] = [];
  for (const child of Array.from(container.childNodes)) {
    if (isElement(child)) {
      mappedNodes.push(mapElement(documentRef, child));
    } else if (child.nodeType === 3 && child.textContent?.trim()) {
      const { content, shell } = createBlockShell(documentRef, 'ailu-x-paragraph');
      content.appendChild(child);
      mappedNodes.push(shell);
    }
  }

  const template = documentRef.createElement('div');
  template.className = 'ailu-x-template';
  const editor = documentRef.createElement('div');
  editor.className = 'ailu-x-editor';
  const content = documentRef.createElement('div');
  content.className = 'ailu-x-content';
  content.append(...mappedNodes);
  editor.appendChild(content);
  template.appendChild(editor);
  container.replaceChildren(template);
  return content;
}

export const remapArticleDom = remapXArticleDom;
