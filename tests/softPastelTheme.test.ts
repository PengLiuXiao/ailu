import {
  SOFT_PASTEL_CONTAINER_STYLE,
  SOFT_PASTEL_PARAGRAPH_STYLE,
  SOFT_PASTEL_PALETTE,
  SOFT_PASTEL_THEME_ID,
} from '../src/wechat/softPastelTheme';

describe('Soft Pastel WeChat theme', () => {
  test('keeps the warm quiet-panel palette contract', () => {
    expect(SOFT_PASTEL_THEME_ID).toBe('soft-pastel');
    expect(SOFT_PASTEL_PALETTE).toMatchObject({
      background: '#FDF9F5',
      paper: '#FFFFFF',
      ink: '#2A2520',
      peach: '#F5B885',
      sage: '#9EC79E',
      lavender: '#C5B8E0',
      sky: '#B3D4E8',
      rose: '#E8B3C2',
    });
  });

  test('keeps long paths readable without stretching Chinese spacing', () => {
    expect(SOFT_PASTEL_CONTAINER_STYLE).toContain('padding:28px 8px 40px');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).toContain('margin:0 0 20px');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).toContain('letter-spacing:0.6px');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).toContain('text-align:left');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).toContain('overflow-wrap:anywhere');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).toContain('word-break:break-word');
    expect(SOFT_PASTEL_PARAGRAPH_STYLE).not.toContain('text-align:justify');
  });
});
