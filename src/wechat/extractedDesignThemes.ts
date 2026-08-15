// Substantially modified from the Open Design templates identified in
// THIRD_PARTY_NOTICES.md; this implementation is deterministic and local-only.
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

export const EXTRACTED_DESIGN_TEMPLATE_IDS = [
  'open-design-archive',
  'vellum-indigo',
  'editorial-tri-tone',
  'pink-script',
  'playful-peach',
  'capsule-color',
] as const;

export type ExtractedDesignTemplateId = typeof EXTRACTED_DESIGN_TEMPLATE_IDS[number];

type ThemeFamily = 'archive' | 'vellum' | 'tri-tone' | 'script' | 'playful' | 'capsule';

interface ExtractedDesignTheme {
  id: ExtractedDesignTemplateId;
  label: string;
  source: string;
  family: ThemeFamily;
  palette: {
    background: string;
    surface: string;
    ink: string;
    muted: string;
    accent: string;
    accent2: string;
    line: string;
  };
  fonts: {
    display: string;
    body: string;
    mono: string;
  };
}

const DISPLAY_SERIF = "'Bodoni 72','Didot','Songti SC','STSong','Times New Roman',serif";
const BODY_SANS = "'Avenir Next','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif";
const CONDENSED_SANS = "'Arial Narrow','Avenir Next Condensed','PingFang SC',sans-serif";
const MONO = "'SFMono-Regular','JetBrains Mono','Courier New',monospace";

export const EXTRACTED_DESIGN_THEMES: readonly ExtractedDesignTheme[] = [
  {
    id: 'open-design-archive',
    label: '开放设计档案',
    source: 'open-design-landing',
    family: 'archive',
    palette: {
      background: '#EFE7D2',
      surface: '#F7F1DE',
      ink: '#15140F',
      muted: '#5A5448',
      accent: '#ED6F5C',
      accent2: '#E9B94A',
      line: '#C7BDA4',
    },
    fonts: { display: DISPLAY_SERIF, body: BODY_SANS, mono: MONO },
  },
  {
    id: 'vellum-indigo',
    label: '靛蓝羊皮纸',
    source: 'html-ppt-zhangzara-vellum',
    family: 'vellum',
    palette: {
      background: '#F4F0E6',
      surface: '#E7EBF4',
      ink: '#25345F',
      muted: '#5D667D',
      accent: '#3F5EA8',
      accent2: '#D4B84F',
      line: '#C6CDDC',
    },
    fonts: { display: DISPLAY_SERIF, body: BODY_SANS, mono: MONO },
  },
  {
    id: 'editorial-tri-tone',
    label: '三色编辑部',
    source: 'html-ppt-zhangzara-editorial-tri-tone',
    family: 'tri-tone',
    palette: {
      background: '#F7F1E4',
      surface: '#F3CDD8',
      ink: '#70253A',
      muted: '#6C555D',
      accent: '#E5C85A',
      accent2: '#D78FA6',
      line: '#D9C4BE',
    },
    fonts: { display: DISPLAY_SERIF, body: CONDENSED_SANS, mono: MONO },
  },
  {
    id: 'pink-script',
    label: '黑粉手写体',
    source: 'html-ppt-zhangzara-pink-script',
    family: 'script',
    palette: {
      background: '#F7F0F3',
      surface: '#FFF9FB',
      ink: '#31252B',
      muted: '#78656F',
      accent: '#C92B70',
      accent2: '#E68AAF',
      line: '#E2C5D1',
    },
    fonts: { display: DISPLAY_SERIF, body: BODY_SANS, mono: MONO },
  },
  {
    id: 'playful-peach',
    label: '蜜桃玩字',
    source: 'html-ppt-zhangzara-playful',
    family: 'playful',
    palette: {
      background: '#F0C8A0',
      surface: '#F7DEC6',
      ink: '#1A1A1A',
      muted: '#514337',
      accent: '#1A1A1A',
      accent2: '#E8B88E',
      line: '#1A1A1A',
    },
    fonts: { display: "'Avenir Next Heavy','Arial Black','PingFang SC',sans-serif", body: BODY_SANS, mono: MONO },
  },
  {
    id: 'capsule-color',
    label: '彩色胶囊',
    source: 'html-ppt-zhangzara-capsule',
    family: 'capsule',
    palette: {
      background: '#F5F5F0',
      surface: '#FFFFFF',
      ink: '#1A1A1A',
      muted: '#6A6963',
      accent: '#F2D160',
      accent2: '#A06CE8',
      line: '#1E1E1E',
    },
    fonts: { display: DISPLAY_SERIF, body: BODY_SANS, mono: MONO },
  },
] as const;

const THEME_BY_ID = new Map(EXTRACTED_DESIGN_THEMES.map(theme => [theme.id, theme]));

export function isExtractedDesignTemplateId(value: unknown): value is ExtractedDesignTemplateId {
  return typeof value === 'string' && THEME_BY_ID.has(value as ExtractedDesignTemplateId);
}

export function getExtractedDesignTheme(themeId: ExtractedDesignTemplateId): ExtractedDesignTheme {
  return THEME_BY_ID.get(themeId)!;
}

export function buildExtractedDesignParagraphStyle(
  themeId: ExtractedDesignTemplateId,
): string {
  const { palette: color, fonts } = getExtractedDesignTheme(themeId);
  return `margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} 20px;padding:0;font-family:${fonts.body};font-size:16px;line-height:1.82;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:${color.ink};font-weight:450;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`;
}

export function buildExtractedDesignContainerStyle(
  themeId: ExtractedDesignTemplateId,
): string {
  const { palette: color, fonts } = getExtractedDesignTheme(themeId);
  return `display:block;background-color:${color.background};color:${color.ink};padding:30px ${WECHAT_ARTICLE_HORIZONTAL_PADDING} 44px;box-sizing:border-box;font-family:${fonts.body};font-size:16px;line-height:1.82;${WECHAT_TEXT_FLOW_RESET_STYLE}${WECHAT_TEXT_WRAP_GUARD_STYLE}`;
}

function setStyle(element: HTMLElement, value: string): void {
  element.style.cssText = value;
}

function headingContent(heading: HTMLElement): HTMLElement {
  return heading.querySelector<HTMLElement>('[data-ailu-paper-heading-content="true"]') ?? heading;
}

function styleHeading(heading: HTMLElement, theme: ExtractedDesignTheme, index: number): void {
  const { palette: color, fonts, family } = theme;
  const content = headingContent(heading);
  const tag = heading.tagName;

  if (family === 'archive') {
    if (tag === 'H1') {
      setStyle(heading, `margin:28px 0 26px;padding:24px 0 22px;border-top:1px solid ${color.line};border-bottom:1px solid ${color.line};font-family:${fonts.body};font-size:34px;line-height:1.12;text-align:left;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:800;letter-spacing:-1px;`);
    } else if (tag === 'H2') {
      setStyle(heading, `margin:42px 0 20px;padding:12px 0 0;border-top:4px solid ${color.accent};font-family:${fonts.body};font-size:23px;line-height:1.35;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:750;`);
    } else {
      setStyle(heading, `margin:28px 0 14px;padding:0;font-family:${fonts.display};font-size:${tag === 'H3' ? '21px' : '18px'};line-height:1.45;`);
      setStyle(content, `color:${color.ink};font-style:${tag === 'H3' ? 'italic' : 'normal'};font-weight:600;`);
    }
    return;
  }

  if (family === 'vellum') {
    if (tag === 'H1') {
      setStyle(heading, `margin:34px 0 30px;padding:24px 6px 26px;border-bottom:1px solid ${color.line};font-family:${fonts.display};font-size:42px;line-height:1.08;text-align:center;`);
      setStyle(content, `display:block;color:${color.accent};font-weight:500;letter-spacing:-0.8px;`);
    } else if (tag === 'H2') {
      setStyle(heading, `margin:40px 0 20px;padding:0 0 12px;border-bottom:1px solid ${color.line};font-family:${fonts.display};font-size:28px;line-height:1.3;text-align:left;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:500;`);
    } else {
      setStyle(heading, `margin:28px 0 14px;padding:0;font-family:${tag === 'H3' ? fonts.mono : fonts.body};font-size:${tag === 'H3' ? '16px' : '18px'};line-height:1.5;letter-spacing:${tag === 'H3' ? '1.4px' : '0'};`);
      setStyle(content, `color:${tag === 'H3' ? color.accent : color.ink};font-weight:600;`);
    }
    return;
  }

  if (family === 'tri-tone') {
    if (tag === 'H1') {
      setStyle(heading, `margin:26px 0 30px;padding:20px 0 18px;font-family:${fonts.body};font-size:42px;line-height:1.05;text-align:left;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:850;letter-spacing:-1.6px;`);
    } else if (tag === 'H2') {
      setStyle(heading, `margin:38px 0 22px;padding:13px 20px;background-color:${color.surface};border:1px solid ${color.accent2};border-radius:999px;font-family:${fonts.body};font-size:22px;line-height:1.35;text-align:center;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:750;`);
    } else {
      setStyle(heading, `margin:26px 0 14px;padding:8px 14px;background-color:${color.accent};border:1px solid ${color.line};border-radius:999px;font-family:${fonts.mono};font-size:${tag === 'H3' ? '16px' : '14px'};line-height:1.45;`);
      setStyle(content, `color:${color.ink};font-weight:700;letter-spacing:0.5px;`);
    }
    return;
  }

  if (family === 'script') {
    if (tag === 'H1') {
      setStyle(heading, `margin:30px 0 34px;padding:30px 12px;background-color:${color.surface};border:1px solid ${color.line};font-family:${fonts.display};font-size:48px;line-height:1.05;text-align:center;`);
      setStyle(content, `display:block;color:${color.accent};font-style:italic;font-weight:500;letter-spacing:-1px;`);
    } else if (tag === 'H2') {
      setStyle(heading, `margin:42px 0 20px;padding:0 0 12px;border-bottom:1px solid ${color.line};font-family:${fonts.display};font-size:31px;line-height:1.2;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:500;`);
    } else {
      setStyle(heading, `margin:28px 0 14px;padding:0;font-family:${tag === 'H3' ? fonts.mono : fonts.body};font-size:${tag === 'H3' ? '15px' : '18px'};line-height:1.5;letter-spacing:${tag === 'H3' ? '2px' : '0'};text-transform:${tag === 'H3' ? 'uppercase' : 'none'};`);
      setStyle(content, `color:${tag === 'H3' ? color.accent : color.ink};font-weight:650;`);
    }
    return;
  }

  if (family === 'playful') {
    if (tag === 'H1') {
      setStyle(heading, `margin:24px 0 30px;padding:10px 0 18px;font-family:${fonts.display};font-size:42px;line-height:1.02;text-align:left;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:900;letter-spacing:-2px;`);
    } else if (tag === 'H2') {
      setStyle(heading, `margin:42px 5px 24px;padding:15px 18px;background-color:${color.surface};border:2px solid ${color.line};border-radius:24px 8px 22px 10px;box-shadow:5px 5px 0 ${color.ink};font-family:${fonts.display};font-size:25px;line-height:1.2;`);
      setStyle(content, `display:block;color:${color.ink};font-weight:800;`);
    } else {
      setStyle(heading, `margin:28px 0 14px;padding:0;font-family:${fonts.body};font-size:${tag === 'H3' ? '20px' : '18px'};line-height:1.45;`);
      setStyle(content, `color:${color.ink};font-weight:800;`);
    }
    return;
  }

  const capsuleColors = ['#F2D160', '#F5B895', '#C5B5E0', '#8BB4F7', '#C4D94E', '#A06CE8'];
  if (tag === 'H1') {
    setStyle(heading, `margin:28px 0 30px;padding:24px 8px 20px;border-top:2px solid ${color.line};border-bottom:2px solid ${color.line};font-family:${fonts.display};font-size:41px;line-height:1.08;text-align:center;`);
    setStyle(content, `display:block;color:${color.ink};font-weight:500;letter-spacing:-1px;`);
  } else if (tag === 'H2') {
    setStyle(heading, `margin:40px 0 22px;padding:13px 20px;background-color:${capsuleColors[index % capsuleColors.length]};border:2px solid ${color.line};border-radius:999px;font-family:${fonts.body};font-size:21px;line-height:1.35;text-align:center;`);
    setStyle(content, `display:block;color:${color.ink};font-weight:750;`);
  } else {
    setStyle(heading, `margin:27px 0 14px;padding:8px 15px;background-color:${color.surface};border:1px solid ${color.line};border-radius:999px;font-family:${fonts.body};font-size:${tag === 'H3' ? '17px' : '15px'};line-height:1.45;`);
    setStyle(content, `color:${color.ink};font-weight:700;`);
  }
}

function styleLists(root: HTMLElement, theme: ExtractedDesignTheme): void {
  const { palette: color, fonts, family } = theme;
  const capsuleColors = ['#F2D160', '#F5B895', '#C5B5E0', '#8BB4F7', '#C4D94E'];
  root.querySelectorAll<HTMLElement>('[data-ailu-paper-flat-list]').forEach(list => {
    setStyle(list, 'margin:20px 0 24px;padding:0;');
    const ordered = list.dataset.ailuPaperFlatList === 'ordered';
    Array.from(list.children).forEach((child, index) => {
      const row = child as HTMLElement;
      setStyle(row, `display:flex;align-items:flex-start;margin:0 ${WECHAT_BODY_HORIZONTAL_MARGIN} ${index === list.children.length - 1 ? '0' : '11px'};padding:${family === 'tri-tone' ? '8px 12px' : '0'};background-color:${family === 'tri-tone' ? (index % 2 === 0 ? color.surface : color.accent) : 'transparent'};border:${family === 'tri-tone' || family === 'playful' ? `1px solid ${color.line}` : '0'};border-radius:${family === 'tri-tone' ? '999px' : family === 'playful' ? '18px 7px 16px 9px' : '0'};font-family:${fonts.body};font-size:16px;line-height:1.75;letter-spacing:${WECHAT_BODY_LETTER_SPACING};color:${color.ink};font-weight:500;`);
      const marker = row.firstElementChild as HTMLElement | null;
      if (!marker) return;
      if (family === 'archive') {
        setStyle(marker, `display:inline-block;flex:0 0 34px;margin:0 9px 0 0;color:${ordered ? color.accent : color.accent2};font-family:${fonts.mono};font-size:${ordered ? '12px' : '0'};line-height:28px;border-top:1px solid ${color.ink};`);
      } else if (family === 'vellum') {
        setStyle(marker, `display:inline-block;flex:0 0 34px;margin:0 9px 0 0;color:${ordered ? color.accent : color.accent2};font-family:${fonts.mono};font-size:${ordered ? '12px' : '0'};line-height:28px;border-bottom:1px solid ${color.line};`);
      } else if (family === 'tri-tone') {
        setStyle(marker, `display:inline-block;flex:0 0 30px;margin:0 8px 0 0;color:${color.ink};font-family:${fonts.mono};font-size:${ordered ? '12px' : '0'};line-height:28px;`);
      } else if (family === 'script') {
        setStyle(marker, `display:inline-block;flex:0 0 28px;margin:0 8px 0 0;color:${color.accent};font-family:${fonts.display};font-size:${ordered ? '14px' : '0'};font-style:italic;line-height:28px;border-bottom:1px solid ${color.accent};`);
      } else if (family === 'playful') {
        setStyle(marker, `display:inline-block;flex:0 0 28px;width:28px;height:28px;margin:0 10px 0 0;background-color:${color.ink};border-radius:50%;color:${color.background};font-family:${fonts.mono};font-size:${ordered ? '11px' : '0'};line-height:28px;text-align:center;`);
      } else {
        setStyle(marker, `display:inline-block;flex:0 0 34px;min-width:34px;margin:0 10px 0 0;padding:0 5px;background-color:${capsuleColors[index % capsuleColors.length]};border:1px solid ${color.line};border-radius:999px;color:${color.ink};font-family:${fonts.mono};font-size:${ordered ? '11px' : '0'};line-height:26px;text-align:center;`);
      }
    });
  });
}

function appendEnding(root: HTMLElement, theme: ExtractedDesignTheme): void {
  root.querySelectorAll('[data-ailu-paper-ending="true"],[data-ailu-soft-ending="true"],[data-ailu-extracted-ending="true"]')
    .forEach(element => element.remove());
  const { palette: color, fonts, family } = theme;
  const document = root.ownerDocument;
  const ending = document.createElement('section');
  ending.dataset.ailuExtractedEnding = 'true';
  const endingBackground = family === 'tri-tone'
    ? color.surface
    : family === 'playful'
      ? color.surface
      : family === 'capsule'
        ? '#C5B5E0'
        : color.surface;
  setStyle(ending, `margin:42px 0 0;padding:28px 18px 24px;background-color:${endingBackground};border:${family === 'vellum' || family === 'script' ? `1px solid ${color.line}` : family === 'playful' || family === 'capsule' ? `2px solid ${color.line}` : `1px solid ${color.line}`};border-radius:${family === 'tri-tone' || family === 'capsule' ? '26px' : family === 'playful' ? '28px 10px 24px 12px' : '0'};text-align:center;font-family:${fonts.body};`);
  const heading = document.createElement('p');
  heading.textContent = PAPER_INK_ENDING.heading;
  setStyle(heading, `margin:0 0 9px;color:${family === 'tri-tone' ? color.ink : color.ink};font-family:${fonts.display};font-size:21px;line-height:1.45;font-style:${family === 'script' ? 'italic' : 'normal'};font-weight:650;`);
  const body = document.createElement('p');
  body.textContent = PAPER_INK_ENDING.body;
  const endingBodyColor = family === 'tri-tone' || family === 'capsule' ? color.ink : color.muted;
  setStyle(body, `margin:0 0 22px;color:${endingBodyColor};font-size:14px;line-height:1.75;`);
  const actions = document.createElement('section');
  setStyle(actions, 'display:flex;justify-content:center;gap:40px;');
  const actionAccent = family === 'tri-tone' || family === 'playful' || family === 'capsule'
    ? color.ink
    : color.accent;
  for (const item of PAPER_INK_ENDING.items) {
    const action = document.createElement('section');
    setStyle(action, 'width:58px;text-align:center;');
    const icon = document.createElement('p');
    icon.textContent = item.icon;
    const isEmoji = item.icon === '👍';
    const iconSize = item.icon === '♡' ? '34px' : item.icon === '↗' ? '32px' : '28px';
    setStyle(icon, `height:36px;margin:0 0 7px;color:${actionAccent};font-family:${isEmoji ? "'Apple Color Emoji','Segoe UI Emoji',sans-serif" : fonts.body};font-size:${iconSize};line-height:36px;font-style:normal;font-weight:400;`);
    const label = document.createElement('p');
    label.textContent = item.label;
    setStyle(label, `margin:0;color:${color.ink};font-family:${fonts.body};font-size:13px;line-height:1.5;font-weight:600;`);
    action.append(icon, label);
    actions.appendChild(action);
  }
  ending.append(heading, body, actions);
  root.appendChild(ending);
}

/** Applies one of the six local Open Design-derived templates using WeChat-safe inline styles. */
export function applyExtractedDesignWechatStyles(
  root: HTMLElement,
  themeId: ExtractedDesignTemplateId,
): void {
  const theme = getExtractedDesignTheme(themeId);
  const { palette: color, fonts, family } = theme;
  applyPaperInkWechatStyles(root);
  root.querySelectorAll('[data-ailu-paper-ending="true"],[data-ailu-soft-ending="true"],[data-ailu-extracted-ending="true"]')
    .forEach(element => element.remove());
  setStyle(root, buildExtractedDesignContainerStyle(themeId));

  root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach((heading, index) => {
    styleHeading(heading, theme, index);
  });
  root.querySelectorAll<HTMLElement>('p').forEach(element => {
    if (element.dataset.ailuPaperFlatListItem === 'true' || element.parentElement?.closest('p,blockquote')) return;
    setStyle(element, buildExtractedDesignParagraphStyle(themeId));
  });
  styleLists(root, theme);
  root.querySelectorAll<HTMLElement>('blockquote').forEach(element => {
    setStyle(element, `margin:26px 0;padding:${family === 'script' ? '22px 22px' : '18px 20px'};background-color:${color.surface};border:${family === 'archive' ? `0;border-left:4px solid ${color.accent}` : family === 'vellum' || family === 'tri-tone' ? `1px solid ${color.line};border-left:4px solid ${color.accent}` : family === 'script' ? `1px solid ${color.line}` : family === 'playful' || family === 'capsule' ? `2px solid ${color.line}` : `1px solid ${color.line}`};border-radius:${family === 'tri-tone' || family === 'capsule' ? '22px' : family === 'playful' ? '24px 8px 20px 10px' : '0'};font-family:${fonts.display};font-size:${family === 'archive' || family === 'vellum' || family === 'script' ? '18px' : '16px'};font-style:${family === 'playful' ? 'normal' : 'italic'};line-height:1.72;color:${color.ink};word-wrap:break-word;`);
  });
  root.querySelectorAll<HTMLElement>('pre').forEach(element => {
    const codeBackground = family === 'capsule' ? '#DDE8FB' : color.surface;
    setStyle(element, `margin:25px 0;padding:18px;background-color:${codeBackground};border:${family === 'playful' || family === 'capsule' ? '2px' : '1px'} solid ${color.line};border-radius:${family === 'capsule' ? '20px' : family === 'playful' ? '18px 7px 16px 9px' : family === 'tri-tone' ? '18px' : family === 'script' ? '10px' : '0'};box-shadow:none;color:${color.ink};font-family:${fonts.mono};font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-all;`);
  });
  root.querySelectorAll<HTMLElement>('code:not(pre code)').forEach(element => {
    const codeBackground = family === 'tri-tone' ? color.accent : family === 'script' ? '#F3DCE6' : family === 'playful' ? color.surface : family === 'capsule' ? '#F5B895' : color.surface;
    setStyle(element, `font-family:${fonts.mono};font-size:13px;color:${color.ink};background-color:${codeBackground};border:${family === 'playful' || family === 'capsule' ? `1px solid ${color.line}` : '0'};border-radius:${family === 'tri-tone' || family === 'capsule' ? '999px' : '3px'};padding:2px 5px;font-weight:500;`);
  });
  root.querySelectorAll<HTMLElement>('a').forEach(element => {
    setStyle(element, `color:${family === 'vellum' ? color.accent : color.accent};text-decoration:none;border-bottom:1px solid ${color.accent};`);
  });
  root.querySelectorAll<HTMLElement>('strong').forEach(element => {
    setStyle(element, element.closest('h1,h2,h3,h4,h5,h6')
      ? 'font-family:inherit;font-size:inherit;font-weight:inherit;line-height:inherit;color:inherit;letter-spacing:inherit;background:transparent;border:0;text-decoration:none;'
      : `font-family:${fonts.body};font-weight:800;color:${family === 'vellum' || family === 'script' ? color.accent : color.ink};background:transparent;border:0;text-decoration:none;`);
  });
  root.querySelectorAll<HTMLElement>('em').forEach(element => {
    setStyle(element, `font-family:${fonts.display};font-style:italic;color:${family === 'archive' || family === 'script' ? color.accent : color.ink};background-color:${family === 'tri-tone' ? color.accent : 'transparent'};padding:${family === 'tri-tone' ? '0 3px' : '0'};`);
  });
  root.querySelectorAll<HTMLElement>('table').forEach(element => {
    setStyle(element, `width:100%;margin:26px 0;border-collapse:${family === 'capsule' ? 'separate' : 'collapse'};border-spacing:${family === 'capsule' ? '0 6px' : '0'};table-layout:fixed;color:${color.ink};line-height:1.6;`);
  });
  root.querySelectorAll<HTMLElement>('th').forEach(element => {
    const headerBackground = family === 'vellum' ? color.surface : family === 'tri-tone' ? color.accent : family === 'script' ? color.accent : family === 'playful' ? color.ink : family === 'capsule' ? '#C4D94E' : color.surface;
    const headerColor = family === 'script' ? color.surface : family === 'playful' ? color.background : color.ink;
    setStyle(element, `padding:12px 13px;background-color:${headerBackground};border:${family === 'playful' || family === 'capsule' ? '2px' : '1px'} solid ${color.line};text-align:left;color:${headerColor};font-family:${fonts.body};font-size:14px;font-weight:750;line-height:1.6;`);
  });
  root.querySelectorAll<HTMLElement>('td').forEach(element => {
    setStyle(element, `padding:12px 13px;background-color:${color.surface};border:${family === 'playful' || family === 'capsule' ? '2px' : '1px'} solid ${color.line};vertical-align:top;color:${color.ink};font-family:${fonts.body};font-size:14px;font-weight:450;line-height:1.6;`);
  });
  root.querySelectorAll<HTMLElement>('img').forEach(element => {
    setStyle(element, `max-width:100%;height:auto;margin:28px auto;display:block;border:${family === 'playful' ? '3px' : family === 'capsule' ? '2px' : '1px'} solid ${color.line};border-radius:${family === 'capsule' ? '24px' : family === 'playful' ? '18px 7px 16px 9px' : '0'};`);
  });
  root.querySelectorAll<HTMLElement>('hr').forEach(element => {
    setStyle(element, `display:block;margin:32px 0;border:0;border-top:${family === 'playful' || family === 'capsule' ? '2px' : '1px'} solid ${color.line};`);
  });
  appendEnding(root, theme);
  applyWeChatTextFlowGuards(root);
}
