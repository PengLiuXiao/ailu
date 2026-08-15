import {
  FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY,
  FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY,
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
  parseFeishuPublishState,
  reconcileCompletedFeishuPublishState,
  sameFeishuPublishState,
} from '../src/feishu/frontmatter';

describe('Feishu frontmatter', () => {
  test('compares the complete persisted state for guarded transitions', () => {
    const state = {
      documentId: 'doc-1',
      url: 'https://example.feishu.cn/docx/doc-1',
      contentHash: 'hash',
      updatedAt: '2026-08-13T00:00:00.000Z',
      title: '标题',
    };
    expect(sameFeishuPublishState(state, { ...state })).toBe(true);
    expect(sameFeishuPublishState(state, { ...state, contentHash: '' })).toBe(false);
    expect(sameFeishuPublishState(state, {
      ...state,
      associationVersion: 1,
      associationSignature: 'signature',
    })).toBe(false);
    expect(sameFeishuPublishState(null, null)).toBe(true);
    expect(sameFeishuPublishState(null, state)).toBe(false);
  });

  test('reads the authenticated association fields without trusting legacy state implicitly', () => {
    expect(parseFeishuPublishState({
      [FEISHU_DOC_ID_FRONTMATTER_KEY]: 'doxcn123',
      [FEISHU_DOC_URL_FRONTMATTER_KEY]: 'https://example.feishu.cn/docx/doxcn123',
      [FEISHU_CONTENT_HASH_FRONTMATTER_KEY]: 'sha256',
      [FEISHU_PUBLISHED_AT_FRONTMATTER_KEY]: '2026-07-30T01:00:00.000Z',
      [FEISHU_TITLE_FRONTMATTER_KEY]: 'Shared note',
      [FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY]: 1,
      [FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY]: 'signed-binding',
    })).toEqual({
      documentId: 'doxcn123',
      url: 'https://example.feishu.cn/docx/doxcn123',
      contentHash: 'sha256',
      updatedAt: '2026-07-30T01:00:00.000Z',
      title: 'Shared note',
      associationVersion: 1,
      associationSignature: 'signed-binding',
    });
  });
  test('reads the linked document state', () => {
    expect(parseFeishuPublishState({
      [FEISHU_DOC_ID_FRONTMATTER_KEY]: 'doxcn123',
      [FEISHU_DOC_URL_FRONTMATTER_KEY]: 'https://example.feishu.cn/docx/doxcn123',
      [FEISHU_CONTENT_HASH_FRONTMATTER_KEY]: 'sha256',
      [FEISHU_PUBLISHED_AT_FRONTMATTER_KEY]: '2026-07-30T01:00:00.000Z',
      [FEISHU_TITLE_FRONTMATTER_KEY]: 'Shared note',
    })).toEqual({
      documentId: 'doxcn123',
      url: 'https://example.feishu.cn/docx/doxcn123',
      contentHash: 'sha256',
      updatedAt: '2026-07-30T01:00:00.000Z',
      title: 'Shared note',
    });
  });

  test('ignores incomplete state without a document id', () => {
    expect(parseFeishuPublishState({
      [FEISHU_DOC_URL_FRONTMATTER_KEY]: 'https://example.feishu.cn/docx/doxcn123',
    })).toBeNull();
  });

  test('does not accept pre-Ailu document linkage fields', () => {
    expect(parseFeishuPublishState({
      'retired-feishu-doc-id': 'doxcn123',
      'retired-feishu-doc-url': 'https://example.feishu.cn/docx/doxcn123',
      'retired-feishu-content-hash': 'sha256',
      'retired-feishu-published-at': '2026-07-30T01:00:00.000Z',
      'retired-feishu-title': 'Shared note',
    })).toBeNull();
  });

  test('keeps the completed write when metadata cache still exposes the pending state', () => {
    const completed = {
      documentId: 'doxcn123',
      url: 'https://example.feishu.cn/docx/doxcn123',
      contentHash: 'new-hash',
      updatedAt: '2026-08-07T03:34:29.999Z',
      title: 'Shared note',
    };

    expect(reconcileCompletedFeishuPublishState({
      ...completed,
      contentHash: '',
    }, completed)).toEqual(completed);
    expect(reconcileCompletedFeishuPublishState(null, completed)).toEqual(completed);
  });

  test('does not overwrite a genuinely newer or different cached association', () => {
    const completed = {
      documentId: 'doxcn123',
      url: 'https://example.feishu.cn/docx/doxcn123',
      contentHash: 'completed-hash',
      updatedAt: '2026-08-07T03:34:29.999Z',
      title: 'Shared note',
    };
    const newer = {
      ...completed,
      contentHash: 'newer-hash',
      updatedAt: '2026-08-07T03:35:00.000Z',
    };
    const different = {
      ...newer,
      documentId: 'doxcn456',
    };

    expect(reconcileCompletedFeishuPublishState(newer, completed)).toEqual(newer);
    expect(reconcileCompletedFeishuPublishState(different, completed)).toEqual(different);
  });
});
