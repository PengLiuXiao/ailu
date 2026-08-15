import {
  buildExtractedDesignContainerStyle,
  buildExtractedDesignParagraphStyle,
  EXTRACTED_DESIGN_TEMPLATE_IDS,
  EXTRACTED_DESIGN_THEMES,
  getExtractedDesignTheme,
  isExtractedDesignTemplateId,
} from '../src/wechat/extractedDesignThemes';

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map(channel => Number.parseInt(channel, 16) / 255) ?? [];
  const [red, green, blue] = channels.map(channel => channel <= 0.03928
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('extracted Open Design templates', () => {
  test('keeps six distinct local sources and palette contracts', () => {
    expect(EXTRACTED_DESIGN_TEMPLATE_IDS).toEqual([
      'open-design-archive',
      'vellum-indigo',
      'editorial-tri-tone',
      'pink-script',
      'playful-peach',
      'capsule-color',
    ]);
    expect(EXTRACTED_DESIGN_THEMES.map(theme => theme.source)).toEqual([
      'open-design-landing',
      'html-ppt-zhangzara-vellum',
      'html-ppt-zhangzara-editorial-tri-tone',
      'html-ppt-zhangzara-pink-script',
      'html-ppt-zhangzara-playful',
      'html-ppt-zhangzara-capsule',
    ]);
    expect(getExtractedDesignTheme('open-design-archive').palette).toMatchObject({
      background: '#EFE7D2',
      ink: '#15140F',
      accent: '#ED6F5C',
    });
    expect(getExtractedDesignTheme('vellum-indigo').palette).toMatchObject({
      background: '#F4F0E6',
      surface: '#E7EBF4',
      ink: '#25345F',
      accent: '#3F5EA8',
    });
    expect(getExtractedDesignTheme('editorial-tri-tone').palette).toMatchObject({
      background: '#F7F1E4',
      surface: '#F3CDD8',
      ink: '#70253A',
      accent: '#E5C85A',
    });
    expect(getExtractedDesignTheme('pink-script').palette).toMatchObject({
      background: '#F7F0F3',
      surface: '#FFF9FB',
      ink: '#31252B',
      accent: '#C92B70',
    });
    expect(getExtractedDesignTheme('playful-peach').palette).toMatchObject({
      background: '#F0C8A0',
      surface: '#F7DEC6',
      ink: '#1A1A1A',
    });
    expect(getExtractedDesignTheme('capsule-color').palette).toMatchObject({
      background: '#F5F5F0',
      accent: '#F2D160',
      accent2: '#A06CE8',
    });
  });

  test('recognizes only extracted deterministic ids', () => {
    for (const themeId of EXTRACTED_DESIGN_TEMPLATE_IDS) {
      expect(isExtractedDesignTemplateId(themeId)).toBe(true);
    }
    expect(isExtractedDesignTemplateId('paper-ink')).toBe(false);
    expect(isExtractedDesignTemplateId('unknown')).toBe(false);
  });

  test('keeps every extracted template left-aligned and safely wraps long paths', () => {
    for (const themeId of EXTRACTED_DESIGN_TEMPLATE_IDS) {
      const containerStyle = buildExtractedDesignContainerStyle(themeId);
      const style = buildExtractedDesignParagraphStyle(themeId);
      expect(containerStyle).toContain('padding:30px 8px 44px');
      expect(style).toContain('margin:0 0 20px');
      expect(style).toContain('letter-spacing:0.6px');
      expect(style).toContain('text-align:left');
      expect(style).toContain('overflow-wrap:anywhere');
      expect(style).toContain('word-break:break-word');
      expect(style).not.toContain('text-align:justify');
    }
  });

  test('keeps the revised indigo, tri-tone, and pink-script canvases light and readable', () => {
    const vellum = getExtractedDesignTheme('vellum-indigo').palette;
    const triTone = getExtractedDesignTheme('editorial-tri-tone').palette;
    const pinkScript = getExtractedDesignTheme('pink-script').palette;

    for (const palette of [vellum, triTone, pinkScript]) {
      expect(relativeLuminance(palette.background)).toBeGreaterThan(0.8);
      expect(contrastRatio(palette.ink, palette.background)).toBeGreaterThan(7);
    }
    expect(contrastRatio(vellum.accent, vellum.background)).toBeGreaterThan(4.5);
    expect(contrastRatio(triTone.ink, triTone.accent)).toBeGreaterThan(4.5);
    expect(contrastRatio(pinkScript.accent, pinkScript.background)).toBeGreaterThan(4.5);
  });
});
