import {
  PAPER_INK_EMPHASIS_FONT_FAMILY,
  PAPER_INK_FONT_FAMILY,
} from './paperInkTheme';
import { WECHAT_BODY_LETTER_SPACING } from './layout';

export type WeChatBodyFontId =
  | 'paper-kaiti'
  | 'wechat-sans'
  | 'classic-song'
  | 'source-serif'
  | 'source-sans'
  | 'classic-kai'
  | 'fangsong'
  | 'lxgw-wenkai'
  | 'theme';

export interface WeChatBodyFontDefinition {
  id: WeChatBodyFontId;
  label: string;
  fontFamily: string | null;
  emphasisFontFamily?: string | null;
}

export interface WeChatTypographyPreferences {
  bodyFontId: WeChatBodyFontId;
  /** 0 means that the template keeps its original body size. */
  bodyFontSize: number;
}

export interface ResolvedWeChatTypography {
  fontFamily: string | null;
  emphasisFontFamily: string | null;
  bodyFontSize: number | null;
  tableFontSize: number | null;
}

export const DEFAULT_WECHAT_BODY_FONT_ID: WeChatBodyFontId = 'paper-kaiti';
export const DEFAULT_WECHAT_BODY_FONT_SIZE = 17;

export const WECHAT_BODY_FONT_DEFINITIONS: readonly WeChatBodyFontDefinition[] = [
  {
    id: 'paper-kaiti',
    label: '纸墨楷宋（推荐）',
    fontFamily: PAPER_INK_FONT_FAMILY,
    emphasisFontFamily: PAPER_INK_EMPHASIS_FONT_FAMILY,
  },
  {
    id: 'wechat-sans',
    label: '苹方雅黑',
    fontFamily: "-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif",
  },
  {
    id: 'classic-song',
    label: '经典宋体',
    fontFamily: "'Songti SC','STSong','SimSun','Noto Serif CJK SC','Noto Serif SC',serif",
  },
  {
    id: 'source-serif',
    label: '思源宋体',
    fontFamily: "'Source Han Serif SC','Noto Serif CJK SC','Noto Serif SC','Songti SC','STSong',serif",
  },
  {
    id: 'source-sans',
    label: '思源黑体',
    fontFamily: "'Source Han Sans SC','Noto Sans CJK SC','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif",
  },
  {
    id: 'classic-kai',
    label: '经典楷体',
    fontFamily: "'STKaiti','Kaiti SC','KaiTi','楷体','FangSong',serif",
  },
  {
    id: 'fangsong',
    label: '仿宋',
    fontFamily: "'STFangsong','FangSong','FangSong_GB2312','仿宋',serif",
  },
  {
    id: 'lxgw-wenkai',
    label: '霞鹜文楷',
    fontFamily: "'LXGW WenKai','霞鹜文楷','STKaiti','KaiTi',serif",
  },
  {
    id: 'theme',
    label: '跟随模板原字体',
    fontFamily: null,
  },
] as const;

/** Common WeChat body sizes first; 0 keeps the template's original size. */
export const WECHAT_BODY_FONT_SIZE_OPTIONS = [17, 16, 15, 18, 14, 19, 20, 0] as const;

const FONT_BY_ID = new Map(WECHAT_BODY_FONT_DEFINITIONS.map(font => [font.id, font]));
const BODY_ELEMENT_SELECTOR = [
  'p',
  'li',
  'blockquote',
  'figcaption',
  'th',
  'td',
  '[data-ailu-paper-flat-list-item="true"]',
].join(',');
const DECORATIVE_ELEMENT_SELECTOR = [
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

export function isWeChatBodyFontId(value: unknown): value is WeChatBodyFontId {
  return typeof value === 'string' && FONT_BY_ID.has(value as WeChatBodyFontId);
}

export function normalizeWeChatBodyFontId(value: unknown): WeChatBodyFontId {
  return isWeChatBodyFontId(value) ? value : DEFAULT_WECHAT_BODY_FONT_ID;
}

export function normalizeWeChatBodyFontSize(value: unknown): number {
  const number = Number(value);
  if (number === 0) return 0;
  return Number.isFinite(number)
    ? Math.min(20, Math.max(14, Math.round(number)))
    : DEFAULT_WECHAT_BODY_FONT_SIZE;
}

export function resolveWeChatTypography(
  preferences: WeChatTypographyPreferences,
): ResolvedWeChatTypography {
  const font = FONT_BY_ID.get(normalizeWeChatBodyFontId(preferences.bodyFontId));
  const bodyFontSize = normalizeWeChatBodyFontSize(preferences.bodyFontSize);
  return {
    fontFamily: font?.fontFamily ?? null,
    emphasisFontFamily: font?.emphasisFontFamily ?? font?.fontFamily ?? null,
    bodyFontSize: bodyFontSize || null,
    tableFontSize: bodyFontSize ? Math.max(12, bodyFontSize - 2) : null,
  };
}

/**
 * Applies one final inline body typography layer after the selected template.
 * Headings, code and ending decorations deliberately keep their template styles.
 */
export function applyWeChatTypography(
  root: HTMLElement,
  preferences: WeChatTypographyPreferences,
): void {
  const typography = resolveWeChatTypography(preferences);
  if (typography.fontFamily) root.style.fontFamily = typography.fontFamily;
  if (typography.bodyFontSize) root.style.fontSize = `${typography.bodyFontSize}px`;

  root.querySelectorAll<HTMLElement>(BODY_ELEMENT_SELECTOR).forEach(element => {
    if (element.closest(DECORATIVE_ELEMENT_SELECTOR)) return;
    element.style.letterSpacing = WECHAT_BODY_LETTER_SPACING;
    if (typography.fontFamily) {
      element.style.fontFamily = typography.fontFamily;
      element.querySelectorAll<HTMLElement>('strong,em,a').forEach(inline => {
        if (!inline.closest(DECORATIVE_ELEMENT_SELECTOR)) {
          inline.style.letterSpacing = WECHAT_BODY_LETTER_SPACING;
          inline.style.fontFamily = inline.tagName === 'STRONG' && typography.emphasisFontFamily
            ? typography.emphasisFontFamily
            : typography.fontFamily!;
        }
      });
    }
    const fontSize = element.matches('th,td') || element.closest('th,td')
      ? typography.tableFontSize
      : typography.bodyFontSize;
    if (fontSize) element.style.fontSize = `${fontSize}px`;
  });
}

export function inferLegacyWeChatBodyFontId(value: unknown): WeChatBodyFontId {
  if (typeof value !== 'string') return DEFAULT_WECHAT_BODY_FONT_ID;
  const normalized = value.toLowerCase();
  if (normalized.includes('simhei') || normalized.includes('黑体') || normalized.includes('yahei')) {
    return 'wechat-sans';
  }
  if (normalized.includes('simsun') || normalized.includes('宋体')) return 'classic-song';
  if (normalized.includes('kaiti') || normalized.includes('楷体')) return 'classic-kai';
  if (normalized.includes('fangsong') || normalized.includes('仿宋')) return 'fangsong';
  return DEFAULT_WECHAT_BODY_FONT_ID;
}
