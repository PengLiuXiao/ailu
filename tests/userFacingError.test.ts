import { describe, expect, test } from 'vitest';
import {
  rawErrorMessage,
  userFacingErrorMessage,
  userFacingErrorText,
} from '../src/utils/userFacingError';

describe('user-facing error localization', () => {
  test('translates the X Article anchor validation error from the real UI failure', () => {
    expect(userFacingErrorMessage(new Error(
      'X Article preflight output was invalid: anchors[0].anchor must be a non-empty string.',
    ), 'X 草稿预检失败。')).toBe(
      'X Article 上传前检查失败：第 1 个图片定位点不能为空。请检查该图片前后是否有可用的正文。',
    );
  });

  test('translates technical details nested inside an otherwise Chinese failure', () => {
    expect(userFacingErrorText(
      'X Article 已创建草稿，但校验失败：RuntimeError: Image 23 could not be bound to exactly one hosted media signature.',
      'X Article 校验失败。',
    )).toBe(
      'X Article 图片校验失败：第 23 张图片无法唯一匹配到 X 托管媒体。草稿线索已保留，请先人工核对。',
    );
  });

  test('translates the mixed-language hosted-media anchor failure from the real UI', () => {
    expect(userFacingErrorText(
      'X Article 上传未完整成功；已保留草稿链接。原因：image 22/24 anchor=Cookie 在 Chrome 保存的路径 media=2',
      'X Article 草稿操作未完成，请查看本地诊断日志。',
    )).toBe(
      'X Article 图片校验失败：第 22/24 张图片与 2 个已上传媒体的对应关系不唯一。草稿线索已保留，请先人工核对。',
    );
  });

  test.each([
    ['TypeError: Failed to fetch', '网络请求失败，请检查网络或本地代理后重试。'],
    ['spawn ENOENT', '所需文件不存在或已被移动。'],
    ['EACCES: permission denied', '没有访问所需文件或目录的权限。'],
    ['request timed out', '操作超时，请稍后重试。'],
    ['HTTP 429 Too Many Requests', '请求过于频繁，请稍后重试。'],
  ])('translates common technical failure %s', (input, expected) => {
    expect(userFacingErrorText(input)).toBe(expected);
  });

  test('keeps an existing Chinese explanation intact', () => {
    expect(userFacingErrorText('当前文章已经发生变化，请重新检查。'))
      .toBe('当前文章已经发生变化，请重新检查。');
  });

  test('never exposes an unknown English-only technical message', () => {
    expect(userFacingErrorText(
      'Unexpected upstream protocol transition in provider worker',
      '供应商请求失败，请稍后重试。',
    )).toBe('供应商请求失败，请稍后重试。');
  });

  test('never exposes unknown technical English embedded in Chinese copy', () => {
    expect(userFacingErrorText(
      '同步失败：Unexpected provider worker transition 后操作已停止',
      '同步失败，请查看本地诊断日志。',
    )).toBe('同步失败，请查看本地诊断日志。');
  });

  test('extracts raw details for diagnostics without changing them', () => {
    expect(rawErrorMessage(new Error('diagnostic detail'))).toBe('diagnostic detail');
  });
});
