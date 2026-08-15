import {
  WECHAT_ARTICLE_HORIZONTAL_PADDING,
  WECHAT_BODY_HORIZONTAL_MARGIN,
  WECHAT_BODY_LETTER_SPACING,
} from './layout';
import {
  applyWeChatTextFlowGuards,
  WECHAT_TEXT_FLOW_RESET_STYLE,
  WECHAT_TEXT_WRAP_GUARD_STYLE,
} from './textFlowGuards';

export const PAPER_INK_THEME_ID = 'paper-ink' as const;

export const PAPER_INK_FONT_FAMILY = [
  "'STKaiti'",
  "'KaiTi'",
  "'FangSong'",
  "'Songti SC'",
  "'Noto Serif SC'",
  'serif',
].join(',');

export const PAPER_INK_EMPHASIS_FONT_FAMILY = [
  "'Songti SC'",
  "'STSong'",
  "'Noto Serif SC'",
  'serif',
].join(',');

export const PAPER_INK_THEME = {
  container: `display:block;background-color:#F5F4ED;color:#3D3D3A;padding:26px ${WECHAT_ARTICLE_HORIZONTAL_PADDING} 36px;box-sizing:border-box;line-height:1.8;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`,
  heading: {
    h1: {
      base: 'margin:32px 0 20px;padding:13px 16px;background-color:#FAF9F5;border:1px solid #E8E6DC;border-radius:4px;text-align:center;font-size:20px;line-height:1.35;',
      content: 'display:block;font-weight:500;color:#141413;',
    },
    h2: {
      base: 'margin:40px 0 22px;padding:0;font-size:20px;line-height:1.35;',
      content: 'display:block;font-weight:500;color:#141413;',
    },
    h3: {
      base: 'margin:28px 0 16px;padding:0;font-size:20px;line-height:1.5;',
      content: 'font-weight:700;color:#141413;',
    },
    base: {
      base: 'margin:24px 0 14px;padding:0;font-size:18px;line-height:1.5;',
      content: 'font-weight:700;color:#141413;',
    },
  },
  paragraph: `margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} 20px;padding:0;line-height:1.8;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:#3D3D3A;font-weight:400;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`,
  list: {
    container: 'margin:16px 0 20px;padding-left:30px;color:#3D3D3A;',
    item: `margin:0 0 8px;padding:0;line-height:1.75;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:#3D3D3A;font-weight:400;`,
    task: `list-style:none;margin:0 0 8px;padding:0;line-height:1.75;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:#3D3D3A;font-weight:400;`,
  },
  quote: 'margin:24px 0;padding:18px 20px;background-color:#FAF9F5;border:0;border-radius:0;color:#504E49;font-style:normal;line-height:1.75;word-wrap:break-word;',
  codeBlock: 'margin:24px 0;padding:18px;background-color:#EEF2F7;border:1px solid #DCE2E8;border-radius:6px;box-shadow:none;color:#1B365D;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;',
  inlineCode: "font-family:'SFMono-Regular',Consolas,'STKaiti',monospace;font-size:14px;color:#1B365D;background:transparent;border:0;border-radius:0;padding:0;font-weight:400;",
  image: 'max-width:100%;height:auto;margin:28px auto;display:block;border-radius:4px;',
  link: 'color:#1B365D;text-decoration:none;border:0;',
  strong: `font-family:${PAPER_INK_EMPHASIS_FONT_FAMILY};font-weight:700;color:#1B365D;letter-spacing:${WECHAT_BODY_LETTER_SPACING};background:transparent;border:0;text-decoration:none;`,
  headingStrong: 'font-family:inherit;font-size:inherit;font-weight:inherit;line-height:inherit;color:inherit;letter-spacing:inherit;background:transparent;border:0;text-decoration:none;',
  emphasis: 'font-style:italic;color:#3D3D3A;',
  deleted: 'text-decoration:line-through;color:#6B6A64;',
  table: 'width:100%;margin:24px 0;border-collapse:collapse;border-spacing:0;table-layout:fixed;color:#3D3D3A;line-height:1.65;',
  tableHeader: 'padding:12px 14px;background-color:#EEF2F7;border:1px solid #DCE2E8;text-align:left;color:#1B365D;font-weight:700;line-height:1.65;',
  tableCell: 'padding:12px 14px;background-color:#FAF9F5;border:1px solid #DCE2E8;vertical-align:top;color:#3D3D3A;font-weight:400;line-height:1.65;',
  horizontalRule: 'display:none;',
  footnote: 'color:#1B365D;text-decoration:none;font-size:13px;',
} as const;

export const PAPER_INK_ENDING = {
  heading: '谢谢你读到这里',
  body: '如果你觉得今天这篇有收获，欢迎点赞、推荐、转发，我们下篇见。',
  items: [
    { icon: '👍', label: '点赞' },
    { icon: '♡', label: '推荐' },
    { icon: '↗', label: '转发' },
  ],
} as const;

function appendFont(style: string, fontSize?: number): string {
  return `${style};font-family:${PAPER_INK_FONT_FAMILY};${fontSize ? `font-size:${fontSize}px;` : ''}`;
}

function setStyle(element: HTMLElement, value: string): void {
  element.style.cssText = value;
}

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1;
}

const SOURCE_LINE_ATTRIBUTE_PREFIX = 'data-ailu-source-line-';

export function copyPaperInkSourceLineAttributes(
  source: Element,
  target: HTMLElement,
): void {
  for (const attribute of Array.from(source.attributes)) {
    if (attribute.name.startsWith(SOURCE_LINE_ATTRIBUTE_PREFIX)) {
      target.setAttribute(attribute.name, attribute.value);
    }
  }
}

function copyNearestSourceLineAttributes(
  source: Element,
  target: HTMLElement,
): void {
  copyPaperInkSourceLineAttributes(source, target);
  const nested = source.querySelector<HTMLElement>(
    '[data-ailu-source-line-start][data-ailu-source-line-end]',
  );
  if (nested) copyPaperInkSourceLineAttributes(nested, target);
}

function replaceTaskCheckbox(input: HTMLInputElement): void {
  const mark = input.ownerDocument.createElement('span');
  mark.textContent = input.checked ? '☑' : '☐';
  setStyle(mark, 'display:inline-block;margin-right:6px;color:#1B365D;font-size:16px;');
  input.replaceWith(mark);
}

export function formatPaperInkListMarker(ordered: boolean, value: number): string {
  return ordered ? String(value).padStart(2, '0') : ' ';
}

function flattenLists(root: HTMLElement): void {
  const document = root.ownerDocument;
  const lists = Array.from(root.querySelectorAll<HTMLElement>('ol,ul')).reverse();
  for (const list of lists) {
    const ordered = list.tagName === 'OL';
    const start = ordered ? Number.parseInt(list.getAttribute('start') || '1', 10) || 1 : 0;
    const items = Array.from(list.children).filter(child => child.tagName === 'LI') as HTMLElement[];
    const wrapper = document.createElement('section');
    wrapper.dataset.ailuPaperFlatList = ordered ? 'ordered' : 'unordered';
    copyNearestSourceLineAttributes(list, wrapper);
    setStyle(wrapper, 'margin:16px 0 20px;padding:0;');

    items.forEach((item, index) => {
      const directSection = item.children.length === 1 && item.firstElementChild?.tagName === 'SECTION'
        ? item.firstElementChild as HTMLElement
        : null;
      const source = directSection ?? item;
      const nodes = Array.from(source.childNodes);
      const hasBlockContent = nodes.some(node => isElement(node)
        && /^(P|SECTION|UL|OL|PRE|BLOCKQUOTE|TABLE|FIGURE)$/.test(node.tagName));
      const row = document.createElement(hasBlockContent ? 'section' : 'p');
      row.dataset.ailuPaperFlatListItem = 'true';
      copyNearestSourceLineAttributes(source, row);
      if (source !== item) copyNearestSourceLineAttributes(item, row);
      setStyle(
        row,
        `display:flex;align-items:flex-start;margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} ${index === items.length - 1 ? '0' : '8px'};padding:0;font-family:${PAPER_INK_FONT_FAMILY};font-size:17px;line-height:1.75;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:#3D3D3A;font-weight:400;`,
      );

      const marker = document.createElement('span');
      if (ordered) {
        setStyle(marker, 'display:inline-block;flex:0 0 auto;min-width:28px;margin-right:8px;color:#1B365D;font-size:12px;line-height:2.48;letter-spacing:1px;');
      } else {
        setStyle(marker, 'display:inline-block;flex:0 0 auto;width:12px;height:2px;margin:14px 9px 0 0;background-color:#1B365D;font-size:0;line-height:0;');
      }
      marker.textContent = formatPaperInkListMarker(ordered, start + index);

      const content = document.createElement(hasBlockContent ? 'section' : 'span');
      setStyle(
        content,
        `flex:1 1 auto;min-width:0;max-width:100%;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`,
      );
      while (source.firstChild) content.appendChild(source.firstChild);
      row.append(marker, content);
      wrapper.appendChild(row);
    });
    list.replaceWith(wrapper);
  }
}

function styleHeading(heading: HTMLElement): void {
  const key = heading.tagName === 'H1'
    ? 'h1'
    : heading.tagName === 'H2'
      ? 'h2'
      : heading.tagName === 'H3'
        ? 'h3'
        : 'base';
  const headingStyle = PAPER_INK_THEME.heading[key];
  let content = Array.from(heading.children).find(
    child => (child as HTMLElement).dataset.ailuPaperHeadingContent === 'true',
  ) as HTMLElement | undefined;
  if (!content) {
    content = heading.ownerDocument.createElement('span');
    content.dataset.ailuPaperHeadingContent = 'true';
    while (heading.firstChild) content.appendChild(heading.firstChild);
    heading.appendChild(content);
    const after = heading.ownerDocument.createElement('span');
    after.dataset.ailuPaperHeadingAfter = 'true';
    setStyle(after, 'display:none;');
    heading.appendChild(after);
  }
  setStyle(heading, appendFont(headingStyle.base));
  setStyle(content, headingStyle.content);
}

function appendEndingInteraction(root: HTMLElement): void {
  root.querySelectorAll('[data-ailu-paper-ending="true"]').forEach(element => element.remove());
  const document = root.ownerDocument;
  const ending = document.createElement('section');
  ending.dataset.ailuPaperEnding = 'true';
  setStyle(ending, `margin:36px 0 0;padding:28px 18px 24px;background-color:#FAF9F5;text-align:center;font-family:${PAPER_INK_FONT_FAMILY};`);

  const heading = document.createElement('p');
  heading.textContent = PAPER_INK_ENDING.heading;
  setStyle(heading, 'margin:0 0 9px;font-size:17px;line-height:1.6;color:#141413;font-weight:700;');
  const body = document.createElement('p');
  body.textContent = PAPER_INK_ENDING.body;
  setStyle(body, 'margin:0 0 20px;font-size:15px;line-height:1.8;color:#6B6A64;font-weight:400;');
  const actions = document.createElement('section');
  setStyle(actions, 'display:flex;justify-content:center;gap:44px;');

  for (const item of PAPER_INK_ENDING.items) {
    const action = document.createElement('section');
    setStyle(action, 'text-align:center;');
    const icon = document.createElement('p');
    icon.textContent = item.icon;
    setStyle(icon, 'margin:0 0 5px;font-size:24px;line-height:1;color:#1B365D;');
    const label = document.createElement('p');
    label.textContent = item.label;
    setStyle(label, 'margin:0;font-size:13px;line-height:1.5;color:#141413;');
    action.append(icon, label);
    actions.appendChild(action);
  }
  ending.append(heading, body, actions);
  root.appendChild(ending);
}

/** Applies the fixed MP Preview paper-and-ink template using inline WeChat-safe styles. */
export function applyPaperInkWechatStyles(root: HTMLElement): void {
  root.querySelectorAll(
    'script,style,iframe,object,embed,form,button,select,option,textarea,link,meta',
  ).forEach(element => element.remove());
  root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(replaceTaskCheckbox);
  root.querySelectorAll('input').forEach(element => element.remove());

  setStyle(root, PAPER_INK_THEME.container);
  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach(styleHeading);
  root.querySelectorAll<HTMLElement>('p').forEach(element => {
    if (
      element.dataset.ailuPaperFlatListItem !== 'true'
      && !element.parentElement?.closest('p')
      && !element.parentElement?.closest('blockquote')
    ) {
      setStyle(element, appendFont(PAPER_INK_THEME.paragraph, 17));
    }
  });
  root.querySelectorAll<HTMLElement>('ul,ol').forEach(element => {
    setStyle(element, PAPER_INK_THEME.list.container);
  });
  root.querySelectorAll<HTMLElement>('li').forEach(element => {
    setStyle(element, appendFont(PAPER_INK_THEME.list.item, 17));
  });
  root.querySelectorAll<HTMLElement>('.task-list-item').forEach(element => {
    setStyle(element, appendFont(PAPER_INK_THEME.list.task, 17));
  });
  flattenLists(root);

  root.querySelectorAll<HTMLElement>('blockquote').forEach(element => {
    setStyle(element, appendFont(PAPER_INK_THEME.quote, 17));
  });
  root.querySelectorAll<HTMLElement>('pre').forEach(element => {
    setStyle(element, PAPER_INK_THEME.codeBlock);
  });
  root.querySelectorAll<HTMLElement>('code:not(pre code)').forEach(element => {
    setStyle(element, PAPER_INK_THEME.inlineCode);
  });
  root.querySelectorAll<HTMLElement>('a').forEach(element => setStyle(element, PAPER_INK_THEME.link));
  root.querySelectorAll<HTMLElement>('strong').forEach(element => {
    setStyle(element, element.closest('h1,h2,h3,h4,h5,h6')
      ? PAPER_INK_THEME.headingStrong
      : PAPER_INK_THEME.strong);
  });
  root.querySelectorAll<HTMLElement>('em').forEach(element => setStyle(element, PAPER_INK_THEME.emphasis));
  root.querySelectorAll<HTMLElement>('del').forEach(element => setStyle(element, PAPER_INK_THEME.deleted));
  root.querySelectorAll<HTMLElement>('table').forEach(element => setStyle(element, PAPER_INK_THEME.table));
  root.querySelectorAll<HTMLElement>('th').forEach(element => {
    setStyle(element, appendFont(PAPER_INK_THEME.tableHeader, 15));
  });
  root.querySelectorAll<HTMLElement>('td').forEach(element => {
    setStyle(element, appendFont(PAPER_INK_THEME.tableCell, 15));
  });
  root.querySelectorAll<HTMLElement>('hr').forEach(element => setStyle(element, PAPER_INK_THEME.horizontalRule));
  root.querySelectorAll<HTMLElement>('.footnote-ref,.footnote-backref').forEach(element => {
    setStyle(element, PAPER_INK_THEME.footnote);
  });
  root.querySelectorAll<HTMLElement>('img').forEach(element => setStyle(element, PAPER_INK_THEME.image));
  appendEndingInteraction(root);
  applyWeChatTextFlowGuards(root);
}
