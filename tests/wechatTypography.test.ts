import {
  DEFAULT_WECHAT_BODY_FONT_ID,
  DEFAULT_WECHAT_BODY_FONT_SIZE,
  WECHAT_BODY_FONT_DEFINITIONS,
  WECHAT_BODY_FONT_SIZE_OPTIONS,
  inferLegacyWeChatBodyFontId,
  normalizeWeChatBodyFontId,
  normalizeWeChatBodyFontSize,
  resolveWeChatTypography,
} from '../src/wechat/typography';
import {
  WECHAT_ARTICLE_HORIZONTAL_PADDING,
  WECHAT_BODY_HORIZONTAL_MARGIN,
  WECHAT_BODY_LETTER_SPACING,
} from '../src/wechat/layout';

describe('WeChat body typography', () => {
  test('keeps the shared mobile reading geometry compact across templates', () => {
    expect(WECHAT_ARTICLE_HORIZONTAL_PADDING).toBe('8px');
    expect(WECHAT_BODY_HORIZONTAL_MARGIN).toBe('0');
    expect(WECHAT_BODY_LETTER_SPACING).toBe('0.6px');
  });

  test('puts the most useful body choices first and keeps a template fallback', () => {
    expect(DEFAULT_WECHAT_BODY_FONT_ID).toBe('paper-kaiti');
    expect(DEFAULT_WECHAT_BODY_FONT_SIZE).toBe(17);
    expect(WECHAT_BODY_FONT_DEFINITIONS.slice(0, 3).map(font => font.id)).toEqual([
      'paper-kaiti',
      'wechat-sans',
      'classic-song',
    ]);
    expect(WECHAT_BODY_FONT_DEFINITIONS.at(-1)).toMatchObject({
      id: 'theme',
      fontFamily: null,
    });
    expect(WECHAT_BODY_FONT_SIZE_OPTIONS).toEqual([17, 16, 15, 18, 14, 19, 20, 0]);
  });

  test('normalizes persisted values without allowing unsafe CSS input', () => {
    expect(normalizeWeChatBodyFontId('source-serif')).toBe('source-serif');
    expect(normalizeWeChatBodyFontId("serif; background:url('bad')")).toBe('paper-kaiti');
    expect(normalizeWeChatBodyFontSize(13)).toBe(14);
    expect(normalizeWeChatBodyFontSize(21)).toBe(20);
    expect(normalizeWeChatBodyFontSize('16')).toBe(16);
    expect(normalizeWeChatBodyFontSize(0)).toBe(0);
    expect(normalizeWeChatBodyFontSize('bad')).toBe(17);
  });

  test('keeps tables compact and supports fully following a template', () => {
    const paperTypography = resolveWeChatTypography({
      bodyFontId: 'paper-kaiti',
      bodyFontSize: 17,
    });
    expect(paperTypography.emphasisFontFamily).toContain('Songti SC');
    expect(paperTypography).toMatchObject({
      bodyFontSize: 17,
      tableFontSize: 15,
    });
    expect(resolveWeChatTypography({
      bodyFontId: 'theme',
      bodyFontSize: 0,
    })).toEqual({
      fontFamily: null,
      emphasisFontFamily: null,
      bodyFontSize: null,
      tableFontSize: null,
    });
  });

  test('maps legacy MP Preview font stacks to curated presets', () => {
    expect(inferLegacyWeChatBodyFontId('SimHei, 黑体, sans-serif')).toBe('wechat-sans');
    expect(inferLegacyWeChatBodyFontId('SimSun, 宋体, serif')).toBe('classic-song');
    expect(inferLegacyWeChatBodyFontId('KaiTi, 楷体, serif')).toBe('classic-kai');
    expect(inferLegacyWeChatBodyFontId('unknown')).toBe('paper-kaiti');
  });
});
