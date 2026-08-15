import { applyPaperInkWechatStyles, PAPER_INK_ENDING } from './paperInkTheme';
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

export const SOFT_PASTEL_THEME_ID = 'soft-pastel' as const;

export const SOFT_PASTEL_PALETTE = {
  background: '#FDF9F5',
  paper: '#FFFFFF',
  paperTint: '#FAF5EF',
  line: '#ECE2D5',
  lineStrong: '#D8C8B3',
  ink: '#2A2520',
  inkSoft: '#4D433B',
  muted: '#8A7E72',
  peach: '#F5B885',
  peachSoft: '#FCE4CF',
  sage: '#9EC79E',
  sageSoft: '#E0EDDC',
  lavender: '#C5B8E0',
  lavenderSoft: '#E8E1F5',
  sky: '#B3D4E8',
  skySoft: '#DEF0FA',
  rose: '#E8B3C2',
  roseSoft: '#FADFE6',
} as const;

const BODY_FONT = [
  '-apple-system',
  "'BlinkMacSystemFont'",
  "'PingFang SC'",
  "'Hiragino Sans GB'",
  "'Microsoft YaHei'",
  'sans-serif',
].join(',');

const DISPLAY_FONT = [
  "'Songti SC'",
  "'STSong'",
  "'Noto Serif SC'",
  "'Times New Roman'",
  'serif',
].join(',');

export const SOFT_PASTEL_PARAGRAPH_STYLE = `margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} 20px;padding:0;font-family:${BODY_FONT};font-size:16px;line-height:1.85;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:${SOFT_PASTEL_PALETTE.inkSoft};font-weight:400;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`;

export const SOFT_PASTEL_CONTAINER_STYLE = `display:block;background-color:${SOFT_PASTEL_PALETTE.background};color:${SOFT_PASTEL_PALETTE.inkSoft};padding:28px ${WECHAT_ARTICLE_HORIZONTAL_PADDING} 40px;box-sizing:border-box;font-family:${BODY_FONT};font-size:16px;line-height:1.85;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`;

function setStyle(element: HTMLElement, value: string): void {
  element.style.cssText = value;
}

function styleHeadings(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach(heading => {
    const content = heading.querySelector<HTMLElement>('[data-ailu-paper-heading-content="true"]')
      ?? heading;
    if (heading.tagName === 'H1') {
      setStyle(
        heading,
        `margin:30px 0 28px;padding:24px 20px;background-color:${SOFT_PASTEL_PALETTE.paper};border:1px solid ${SOFT_PASTEL_PALETTE.line};border-radius:16px;text-align:center;font-family:${DISPLAY_FONT};font-size:26px;line-height:1.35;box-shadow:0 2px 0 rgba(60,40,20,0.02);`,
      );
      setStyle(content, `display:block;color:${SOFT_PASTEL_PALETTE.ink};font-weight:500;`);
      return;
    }
    if (heading.tagName === 'H2') {
      setStyle(
        heading,
        `margin:40px 0 20px;padding:0 0 12px;border-bottom:1px solid ${SOFT_PASTEL_PALETTE.line};font-family:${DISPLAY_FONT};font-size:23px;line-height:1.4;`,
      );
      setStyle(
        content,
        `display:block;padding-left:12px;border-left:3px solid ${SOFT_PASTEL_PALETTE.peach};color:${SOFT_PASTEL_PALETTE.ink};font-weight:500;`,
      );
      return;
    }
    if (heading.tagName === 'H3') {
      setStyle(
        heading,
        `margin:30px 0 16px;padding:0;font-family:${DISPLAY_FONT};font-size:20px;line-height:1.45;`,
      );
      setStyle(content, `color:${SOFT_PASTEL_PALETTE.ink};font-weight:600;`);
      return;
    }
    setStyle(
      heading,
      `margin:24px 0 14px;padding:0;font-family:${BODY_FONT};font-size:18px;line-height:1.5;`,
    );
    setStyle(content, `color:${SOFT_PASTEL_PALETTE.ink};font-weight:600;`);
  });
}

function styleFlatLists(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-ailu-paper-flat-list]').forEach(list => {
    setStyle(list, 'margin:18px 0 22px;padding:0;');
    const ordered = list.dataset.ailuPaperFlatList === 'ordered';
    Array.from(list.children).forEach((child, index) => {
      const row = child as HTMLElement;
      setStyle(
        row,
        `display:flex;align-items:flex-start;margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} ${index === list.children.length - 1 ? '0' : '10px'};padding:0;font-family:${BODY_FONT};font-size:16px;line-height:1.8;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:${SOFT_PASTEL_PALETTE.inkSoft};font-weight:400;`,
      );
      const marker = row.firstElementChild as HTMLElement | null;
      if (!marker) return;
      if (ordered) {
        setStyle(
          marker,
          `display:inline-block;flex:0 0 28px;width:28px;height:28px;margin:1px 10px 0 0;background-color:${SOFT_PASTEL_PALETTE.peachSoft};border-radius:999px;color:#8A5A2A;font-family:${DISPLAY_FONT};font-size:12px;line-height:28px;text-align:center;letter-spacing:0;`,
        );
      } else {
        setStyle(
          marker,
          `display:inline-block;flex:0 0 8px;width:8px;height:8px;margin:11px 12px 0 2px;background-color:${SOFT_PASTEL_PALETTE.sage};border-radius:999px;font-size:0;line-height:0;`,
        );
      }
    });
  });
}

function appendEnding(root: HTMLElement): void {
  root.querySelectorAll('[data-ailu-paper-ending="true"],[data-ailu-soft-ending="true"]')
    .forEach(element => element.remove());
  const document = root.ownerDocument;
  const ending = document.createElement('section');
  ending.dataset.ailuSoftEnding = 'true';
  setStyle(
    ending,
    `margin:38px 0 0;padding:28px 20px 24px;background-color:${SOFT_PASTEL_PALETTE.paper};border:1px solid ${SOFT_PASTEL_PALETTE.line};border-radius:16px;text-align:center;font-family:${BODY_FONT};box-shadow:0 2px 0 rgba(60,40,20,0.02);`,
  );

  const accent = document.createElement('p');
  accent.textContent = '●  ●  ●';
  setStyle(accent, `margin:0 0 12px;color:${SOFT_PASTEL_PALETTE.peach};font-size:10px;line-height:1;letter-spacing:8px;`);
  const heading = document.createElement('p');
  heading.textContent = PAPER_INK_ENDING.heading;
  setStyle(heading, `margin:0 0 9px;font-family:${DISPLAY_FONT};font-size:19px;line-height:1.5;color:${SOFT_PASTEL_PALETTE.ink};font-weight:600;`);
  const body = document.createElement('p');
  body.textContent = PAPER_INK_ENDING.body;
  setStyle(body, `margin:0 0 20px;font-size:14px;line-height:1.8;color:${SOFT_PASTEL_PALETTE.muted};font-weight:400;`);
  const actions = document.createElement('section');
  setStyle(actions, 'display:flex;justify-content:center;gap:38px;');
  const colors = [SOFT_PASTEL_PALETTE.peachSoft, SOFT_PASTEL_PALETTE.lavenderSoft, SOFT_PASTEL_PALETTE.sageSoft];
  PAPER_INK_ENDING.items.forEach((item, index) => {
    const action = document.createElement('section');
    setStyle(action, 'text-align:center;');
    const icon = document.createElement('p');
    icon.textContent = item.icon;
    setStyle(icon, `width:38px;height:38px;margin:0 auto 6px;background-color:${colors[index]};border-radius:999px;font-size:19px;line-height:38px;color:${SOFT_PASTEL_PALETTE.inkSoft};`);
    const label = document.createElement('p');
    label.textContent = item.label;
    setStyle(label, `margin:0;font-size:12px;line-height:1.5;color:${SOFT_PASTEL_PALETTE.inkSoft};`);
    action.append(icon, label);
    actions.appendChild(action);
  });
  ending.append(accent, heading, body, actions);
  root.appendChild(ending);
}

/** Applies a WeChat-safe warm pastel editorial theme inspired by the Open Design quiet panel. */
export function applySoftPastelWechatStyles(root: HTMLElement): void {
  // Reuse Paper Ink's sanitization and defensive list flattening, then replace every visible style.
  applyPaperInkWechatStyles(root);
  setStyle(
    root,
    SOFT_PASTEL_CONTAINER_STYLE,
  );
  styleHeadings(root);
  root.querySelectorAll<HTMLElement>('p').forEach(element => {
    if (
      element.dataset.ailuPaperFlatListItem !== 'true'
      && !element.closest('[data-ailu-paper-ending="true"]')
      && !element.parentElement?.closest('p,blockquote')
    ) {
      setStyle(element, SOFT_PASTEL_PARAGRAPH_STYLE);
    }
  });
  styleFlatLists(root);
  root.querySelectorAll<HTMLElement>('blockquote').forEach(element => {
    setStyle(element, `margin:24px 0;padding:18px 20px;background-color:${SOFT_PASTEL_PALETTE.lavenderSoft};border:0;border-left:3px solid ${SOFT_PASTEL_PALETTE.lavender};border-radius:12px;font-family:${DISPLAY_FONT};font-size:16px;font-style:italic;line-height:1.75;color:#5E4D6E;word-wrap:break-word;`);
  });
  root.querySelectorAll<HTMLElement>('pre').forEach(element => {
    setStyle(element, `margin:24px 0;padding:18px;background-color:${SOFT_PASTEL_PALETTE.skySoft};border:1px solid ${SOFT_PASTEL_PALETTE.sky};border-radius:12px;box-shadow:none;color:#2A5E7A;font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-all;`);
  });
  root.querySelectorAll<HTMLElement>('code:not(pre code)').forEach(element => {
    setStyle(element, `font-family:'SFMono-Regular',Consolas,monospace;font-size:14px;color:#7B4C5D;background-color:${SOFT_PASTEL_PALETTE.roseSoft};border:0;border-radius:4px;padding:1px 4px;font-weight:400;`);
  });
  root.querySelectorAll<HTMLElement>('a').forEach(element => {
    setStyle(element, 'color:#765C91;text-decoration:none;border-bottom:1px solid #C5B8E0;');
  });
  root.querySelectorAll<HTMLElement>('strong').forEach(element => {
    setStyle(element, element.closest('h1,h2,h3,h4,h5,h6')
      ? 'font-family:inherit;font-size:inherit;font-weight:inherit;line-height:inherit;color:inherit;letter-spacing:inherit;background:transparent;border:0;text-decoration:none;'
      : `font-family:${BODY_FONT};font-weight:600;color:#9A5A32;letter-spacing:${WECHAT_BODY_LETTER_SPACING};background:transparent;border:0;text-decoration:none;`);
  });
  root.querySelectorAll<HTMLElement>('em').forEach(element => {
    setStyle(element, `font-family:${DISPLAY_FONT};font-style:italic;color:#765C91;`);
  });
  root.querySelectorAll<HTMLElement>('table').forEach(element => {
    setStyle(element, `width:100%;margin:24px 0;border-collapse:separate;border-spacing:0;table-layout:fixed;color:${SOFT_PASTEL_PALETTE.inkSoft};line-height:1.65;`);
  });
  root.querySelectorAll<HTMLElement>('th').forEach(element => {
    setStyle(element, `padding:12px 14px;background-color:${SOFT_PASTEL_PALETTE.sageSoft};border:1px solid #C9DDC4;text-align:left;color:#4A6E4A;font-family:${BODY_FONT};font-size:14px;font-weight:600;line-height:1.65;`);
  });
  root.querySelectorAll<HTMLElement>('td').forEach(element => {
    setStyle(element, `padding:12px 14px;background-color:${SOFT_PASTEL_PALETTE.paper};border:1px solid ${SOFT_PASTEL_PALETTE.line};vertical-align:top;color:${SOFT_PASTEL_PALETTE.inkSoft};font-family:${BODY_FONT};font-size:14px;font-weight:400;line-height:1.65;`);
  });
  root.querySelectorAll<HTMLElement>('img').forEach(element => {
    setStyle(element, `max-width:100%;height:auto;margin:28px auto;display:block;border:1px solid ${SOFT_PASTEL_PALETTE.line};border-radius:14px;`);
  });
  appendEnding(root);
  applyWeChatTextFlowGuards(root);
}
