/**
 * Inline, high-priority prose guards for the HTML accepted by WeChat.
 *
 * WeChat can wrap article HTML in containers that inherit `text-align: justify`,
 * `text-align-last: justify`, or `text-indent`. A normal inline declaration is
 * not enough when the host rule is also `!important`, so selectable templates
 * apply this reset to every prose block after their decorative styling.
 */
export const WECHAT_TEXT_FLOW_RESET_STYLE = [
  'text-align:left!important',
  'text-align-last:left!important',
  'text-indent:0!important',
  'text-justify:none!important',
  'word-spacing:normal!important',
].join(';') + ';';

export const WECHAT_TEXT_WRAP_GUARD_STYLE = [
  'overflow-wrap:anywhere!important',
  'word-break:break-word!important',
].join(';') + ';';

export const WECHAT_TEXT_FLOW_BLOCK_SELECTOR = [
  'p',
  'ul',
  'ol',
  'li',
  'blockquote',
  'figcaption',
  'th',
  'td',
  '[data-ailu-paper-flat-list]',
  '[data-ailu-paper-flat-list-item="true"]',
  '[data-ailu-paper-flat-list-item="true"] > :last-child',
].join(',');

export const WECHAT_TEXT_FLOW_WRAP_SELECTOR = [
  'p',
  'li',
  'blockquote',
  'figcaption',
  'th',
  'td',
  'a',
  '[data-ailu-paper-flat-list-item="true"]',
  '[data-ailu-paper-flat-list-item="true"] > :last-child',
].join(',');

const DECORATIVE_TEXT_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'code',
  '[data-ailu-paper-ending="true"]',
  '[data-ailu-soft-ending="true"]',
  '[data-ailu-extracted-ending="true"]',
].join(',');

function isDecorativeText(element: HTMLElement): boolean {
  return Boolean(element.closest(DECORATIVE_TEXT_SELECTOR));
}

function forceProperty(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  element.style.setProperty(property, value, 'important');
}

function applyTextFlowReset(element: HTMLElement): void {
  forceProperty(element, 'text-align', 'left');
  forceProperty(element, 'text-align-last', 'left');
  forceProperty(element, 'text-indent', '0');
  forceProperty(element, 'text-justify', 'none');
  forceProperty(element, 'word-spacing', 'normal');
}

function applyWrappingGuard(element: HTMLElement): void {
  forceProperty(element, 'overflow-wrap', 'anywhere');
  forceProperty(element, 'word-break', 'break-word');
}

/**
 * Prevents prose and list content from inheriting host alignment or indentation.
 * Decorative headings and ending cards retain the selected template's design.
 */
export function applyWeChatTextFlowGuards(root: HTMLElement): void {
  applyTextFlowReset(root);
  applyWrappingGuard(root);

  root.querySelectorAll<HTMLElement>(WECHAT_TEXT_FLOW_BLOCK_SELECTOR).forEach(element => {
    if (!isDecorativeText(element)) applyTextFlowReset(element);
  });
  root.querySelectorAll<HTMLElement>(WECHAT_TEXT_FLOW_WRAP_SELECTOR).forEach(element => {
    if (!isDecorativeText(element)) applyWrappingGuard(element);
  });

  root.querySelectorAll<HTMLElement>(
    '[data-ailu-paper-flat-list-item="true"] > :last-child',
  ).forEach(content => {
    if (isDecorativeText(content)) return;
    forceProperty(content, 'min-width', '0');
    forceProperty(content, 'max-width', '100%');
  });
}
