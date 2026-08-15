import {
  DEFAULT_WECHAT_THEME_ID,
  WECHAT_THEME_DEFINITIONS,
  createTemplateThemeDocument,
  getWeChatTheme,
  isWeChatThemeId,
  listWeChatThemes,
} from '../src/wechat/themes';
import { WECHAT_RENDERER_VERSION, type WeChatPreviewSnapshot } from '../src/wechat/types';

function snapshot(contentHash = 'source-hash'): WeChatPreviewSnapshot {
  return {
    sourcePath: '公众号/测试.md',
    title: '主题测试',
    author: '示例作者',
    digest: '验证主题注册和哈希。',
    contentSourceUrl: '',
    markdown: '正文',
    contentHash,
    assets: [],
    warnings: [],
    thumbMediaId: '',
    coverAssetToken: null,
    rendererVersion: WECHAT_RENDERER_VERSION,
  };
}

describe('WeChat themes', () => {
  test('exposes only the deterministic local template catalog', () => {
    expect(DEFAULT_WECHAT_THEME_ID).toBe('paper-ink');
    expect(WECHAT_THEME_DEFINITIONS.map(theme => theme.id)).toEqual([
      'paper-ink',
      'soft-pastel',
      'open-design-archive',
      'vellum-indigo',
      'editorial-tri-tone',
      'pink-script',
      'playful-peach',
      'capsule-color',
    ]);
    expect(listWeChatThemes('template').map(theme => theme.label)).toEqual([
      '纸墨编辑风',
      '柔彩手记',
      '开放设计档案',
      '靛蓝羊皮纸',
      '三色编辑部',
      '黑粉手写体',
      '蜜桃玩字',
      '彩色胶囊',
    ]);
  });

  test('recognizes local template ids and falls back to Paper Ink', () => {
    expect(isWeChatThemeId('soft-pastel')).toBe(true);
    expect(isWeChatThemeId('capsule-color')).toBe(true);
    expect(isWeChatThemeId('unknown')).toBe(false);
    expect(getWeChatTheme('unknown' as never).id).toBe(DEFAULT_WECHAT_THEME_ID);
  });

  test('uses the source hash for every local template document', () => {
    expect(createTemplateThemeDocument(snapshot())).toMatchObject({
      themeId: 'paper-ink',
      sourceHash: 'source-hash',
      contentHash: 'source-hash',
      html: null,
    });
    expect(createTemplateThemeDocument(snapshot(), 'paper-ink')).toMatchObject({
      themeId: 'paper-ink',
      sourceHash: 'source-hash',
      contentHash: 'source-hash',
      html: null,
    });
    expect(createTemplateThemeDocument(snapshot(), 'soft-pastel')).toMatchObject({
      themeId: 'soft-pastel',
      sourceHash: 'source-hash',
      contentHash: 'source-hash',
      html: null,
    });
    for (const themeId of [
      'open-design-archive',
      'vellum-indigo',
      'editorial-tri-tone',
      'pink-script',
      'playful-peach',
      'capsule-color',
    ] as const) {
      expect(createTemplateThemeDocument(snapshot(), themeId)).toMatchObject({
        themeId,
        sourceHash: 'source-hash',
        contentHash: 'source-hash',
        html: null,
      });
    }
  });
});
