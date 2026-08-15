import type { WeChatPreviewSnapshot } from './types';
import { EXTRACTED_DESIGN_THEMES } from './extractedDesignThemes';

export type WeChatThemeId =
  | 'paper-ink'
  | 'soft-pastel'
  | 'open-design-archive'
  | 'vellum-indigo'
  | 'editorial-tri-tone'
  | 'pink-script'
  | 'playful-peach'
  | 'capsule-color';

export type WeChatThemeKind = 'template';

export type WeChatTemplateThemeId = Extract<
  WeChatThemeId,
  | 'paper-ink'
  | 'soft-pastel'
  | 'open-design-archive'
  | 'vellum-indigo'
  | 'editorial-tri-tone'
  | 'pink-script'
  | 'playful-peach'
  | 'capsule-color'
>;

export interface WeChatThemeDefinition {
  id: WeChatThemeId;
  label: string;
  kind: WeChatThemeKind;
  color: string;
}

export interface WeChatThemeDocument {
  themeId: WeChatThemeId;
  sourceHash: string;
  contentHash: string;
  html: string | null;
  generatedAt: string | null;
  generatorSignature: string;
}

export const DEFAULT_WECHAT_THEME_ID: WeChatTemplateThemeId = 'paper-ink';

export const WECHAT_THEME_DEFINITIONS: readonly WeChatThemeDefinition[] = [
  {
    id: 'paper-ink',
    label: '纸墨编辑风',
    kind: 'template',
    color: '#1b365d',
  },
  {
    id: 'soft-pastel',
    label: '柔彩手记',
    kind: 'template',
    color: '#f5b885',
  },
  ...EXTRACTED_DESIGN_THEMES.map(theme => ({
    id: theme.id,
    label: theme.label,
    kind: 'template' as const,
    color: theme.palette.accent,
  })),
] as const;

export const SELECTABLE_WECHAT_THEME_DEFINITIONS: readonly WeChatThemeDefinition[] =
  WECHAT_THEME_DEFINITIONS;

const THEME_BY_ID = new Map(WECHAT_THEME_DEFINITIONS.map(theme => [theme.id, theme]));

export function isWeChatThemeId(value: unknown): value is WeChatThemeId {
  return typeof value === 'string' && THEME_BY_ID.has(value as WeChatThemeId);
}

export function getWeChatTheme(themeId: WeChatThemeId): WeChatThemeDefinition {
  return THEME_BY_ID.get(themeId) ?? THEME_BY_ID.get(DEFAULT_WECHAT_THEME_ID)!;
}

export function listWeChatThemes(_kind: WeChatThemeKind): WeChatThemeDefinition[] {
  return [...SELECTABLE_WECHAT_THEME_DEFINITIONS];
}

export function createTemplateThemeDocument(
  snapshot: WeChatPreviewSnapshot,
  themeId: WeChatTemplateThemeId = DEFAULT_WECHAT_THEME_ID,
): WeChatThemeDocument {
  return {
    themeId,
    sourceHash: snapshot.contentHash,
    contentHash: snapshot.contentHash,
    html: null,
    generatedAt: null,
    generatorSignature: snapshot.rendererVersion,
  };
}
