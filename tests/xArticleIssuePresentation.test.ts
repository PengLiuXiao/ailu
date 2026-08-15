import { presentXArticlePreflightIssue } from '../src/xArticle/issuePresentation';

describe('X Article preflight issue presentation', () => {
  test('explains the exact body image excess and keeps the cover separate', () => {
    const result = presentXArticlePreflightIssue(
      { expectedBodyImages: 33 },
      {
        type: 'body_media_limit_exceeded',
        message: 'opaque internal message',
        details: { maximum: 25, cover_separate: true },
      },
    );

    expect(result.title).toBe('正文图片太多：33 张，需要减少 8 张');
    expect(result.message).toContain('图片文件本身没有损坏');
    expect(result.message).toContain('封面单独上传，不占正文名额');
  });

  test('turns a missing image index into an actionable title', () => {
    const result = presentXArticlePreflightIssue(
      { expectedBodyImages: 3 },
      {
        type: 'missing_body_image',
        message: 'missing',
        details: { index: 2 },
      },
    );

    expect(result.title).toBe('第 2 张正文图片文件找不到');
    expect(result.message).toContain('本地路径');
  });

  test('preserves an unknown issue message without using opaque blocking language', () => {
    const result = presentXArticlePreflightIssue(
      { expectedBodyImages: 0 },
      { type: 'future_issue', message: '具体错误内容', details: {} },
    );

    expect(result).toEqual({
      title: '检查发现一个需要处理的问题',
      message: '具体错误内容',
    });
  });

  test('never exposes an unknown English-only preflight message', () => {
    const result = presentXArticlePreflightIssue(
      { expectedBodyImages: 1 },
      {
        type: 'future_validator_error',
        message: 'Unexpected validator contract failure',
        details: {},
      },
    );

    expect(result.title).toBe('检查发现一个需要处理的问题');
    expect(result.message).toBe('请根据检查结果修正文章后重新检查。');
  });
});
