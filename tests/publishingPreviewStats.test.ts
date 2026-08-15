import {
  buildPublishingPreviewStats,
  publishingImageTargetsMatch,
} from '../src/publishing/previewStats';

describe('publishing preview statistics', () => {
  test('counts visible Unicode text and image occurrences without Markdown syntax or frontmatter', () => {
    const stats = buildPublishingPreviewStats([
      '---',
      'title: Hidden metadata',
      'cover: assets/cover.png',
      '---',
      '# Article title',
      '',
      '正文 **加粗** 🐼 [链接](https://example.com)',
      '![first](assets/cover.png)',
      '![again](assets/cover.png)',
      '![body](assets/body.png)',
    ].join('\n'), {
      bodyCoverTarget: 'assets/cover.png',
      hasCover: true,
      title: 'Article title',
    });

    expect(stats).toEqual({
      bodyImageCount: 2,
      coverImageCount: 1,
      visibleTextLength: Array.from('正文加粗🐼链接').length,
    });
  });

  test('does not count images inside code fences and keeps visible code text', () => {
    const stats = buildPublishingPreviewStats([
      '```md',
      '![example](not-an-image.png)',
      '```',
      '',
      '![[real image.png|320]]',
    ].join('\n'));

    expect(stats.bodyImageCount).toBe(1);
    expect(stats.visibleTextLength).toBe(Array.from('![example](not-an-image.png)').length);
  });

  test('counts repeated references as repeated body images but removes only one cover occurrence', () => {
    const stats = buildPublishingPreviewStats([
      '![](ailu-wechat-asset://same)',
      '![](ailu-wechat-asset://same)',
      '![](ailu-wechat-asset://same)',
    ].join('\n'), {
      bodyCoverTarget: 'ailu-wechat-asset://same',
      hasCover: true,
    });

    expect(stats.bodyImageCount).toBe(2);
    expect(stats.coverImageCount).toBe(1);
  });

  test('counts preview-compatible whitespace before an image destination', () => {
    const stats = buildPublishingPreviewStats('![CDN image] (https://cdn.example.com/image.png)');

    expect(stats.bodyImageCount).toBe(1);
    expect(stats.visibleTextLength).toBe(0);
  });

  test('normalizes equivalent local image targets', () => {
    expect(publishingImageTargetsMatch('./assets/%E5%B0%81%E9%9D%A2.png', 'assets/封面.png')).toBe(true);
  });
});
