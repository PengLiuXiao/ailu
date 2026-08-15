import { randomBytes } from 'node:crypto';

import {
  canonicalizeFeishuDocumentUrl,
  signFeishuPublishState,
  validateFeishuAssociationKey,
  verifyFeishuPublishState,
} from '../src/feishu/association';
import type { FeishuPublishState } from '../src/feishu/types';

const key = randomBytes(32).toString('base64url');
const state: FeishuPublishState = {
  documentId: 'doxcn12345678',
  url: 'https://example.feishu.cn/docx/doxcn12345678',
  contentHash: 'sha256',
  updatedAt: '2026-08-15T00:00:00.000Z',
  title: 'Shared note',
};
const context = {
  vaultBasePath: '/vault',
  sourcePath: 'notes/shared.md',
  accountOpenId: 'ou_current_account',
};

describe('Feishu document association', () => {
  test('signs and verifies the exact vault, note, account, document and URL', () => {
    const signed = signFeishuPublishState(state, key, context);
    expect(signed.associationVersion).toBe(1);
    expect(signed.associationSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyFeishuPublishState(signed, key, context)).toBe(true);

    expect(verifyFeishuPublishState(signed, key, {
      ...context,
      vaultBasePath: '/other-vault',
    })).toBe(false);
    expect(verifyFeishuPublishState(signed, key, {
      ...context,
      sourcePath: 'notes/other.md',
    })).toBe(false);
    expect(verifyFeishuPublishState(signed, key, {
      ...context,
      accountOpenId: 'ou_other_account',
    })).toBe(false);
    expect(verifyFeishuPublishState({
      ...signed,
      documentId: 'doxcn87654321',
    }, key, context)).toBe(false);
    expect(verifyFeishuPublishState({
      ...signed,
      url: 'https://example.feishu.cn/docx/doxcn87654321',
    }, key, context)).toBe(false);
  });

  test.each([
    'http://example.feishu.cn/docx/doxcn12345678',
    'https://evilfeishu.cn/docx/doxcn12345678',
    'https://feishu.cn.evil.example/docx/doxcn12345678',
    'https://user:password@example.feishu.cn/docx/doxcn12345678',
    'https://example.feishu.cn/docx/doxcn12345678?token=secret',
    'https://example.feishu.cn/docx/doxcn12345678#fragment',
    'https://example.feishu.cn/docx/doxcn87654321',
    'https://example.feishu.cn/docx/doxcn12345678/extra',
  ])('rejects a non-canonical or mismatched target URL: %s', (url) => {
    expect(() => canonicalizeFeishuDocumentUrl(url, state.documentId)).toThrow();
  });

  test('canonicalizes a valid target and enforces a strong secret key', () => {
    expect(canonicalizeFeishuDocumentUrl(
      'https://EXAMPLE.FEISHU.CN:443/docx/doxcn12345678',
      state.documentId,
    )).toBe('https://example.feishu.cn/docx/doxcn12345678');
    expect(validateFeishuAssociationKey(key)).toBe(key);
    expect(() => validateFeishuAssociationKey('short')).toThrow('格式无效');
    expect(() => validateFeishuAssociationKey(randomBytes(16).toString('base64url')))
      .toThrow('强度不足');
  });

  test('does not treat unsigned legacy frontmatter as overwrite authorization', () => {
    expect(verifyFeishuPublishState(state, key, context)).toBe(false);
    expect(verifyFeishuPublishState({
      ...state,
      associationVersion: 1,
      associationSignature: 'A'.repeat(43),
    }, key, context)).toBe(false);
  });
});
