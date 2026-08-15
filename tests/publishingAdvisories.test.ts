import { describe, expect, test } from 'vitest';

import { getWeChatPublishingAdvisories } from '../src/publishing/advisories';

describe('WeChat publishing advisory policy', () => {
  test('does not apply the X body-media cap to 32 WeChat body images', () => {
    expect(getWeChatPublishingAdvisories(32)).toEqual([]);
  });

  test('does not invent a WeChat article count limit for larger image sets', () => {
    expect(getWeChatPublishingAdvisories(100)).toEqual([]);
  });
});
