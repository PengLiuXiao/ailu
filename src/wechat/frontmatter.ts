import type { WeChatPublishState } from './types';
import { FRONTMATTER_IDS } from '../ids';

export const WECHAT_DRAFT_ID_FRONTMATTER_KEY = FRONTMATTER_IDS.wechat.draftId;
export const WECHAT_CONTENT_HASH_FRONTMATTER_KEY = FRONTMATTER_IDS.wechat.contentHash;
export const WECHAT_PUBLISHED_AT_FRONTMATTER_KEY = FRONTMATTER_IDS.wechat.publishedAt;
export const WECHAT_ARTICLE_URL_FRONTMATTER_KEY = FRONTMATTER_IDS.wechat.articleUrl;

export const WECHAT_FRONTMATTER_KEYS = [
  WECHAT_DRAFT_ID_FRONTMATTER_KEY,
  WECHAT_CONTENT_HASH_FRONTMATTER_KEY,
  WECHAT_PUBLISHED_AT_FRONTMATTER_KEY,
  WECHAT_ARTICLE_URL_FRONTMATTER_KEY,
] as const;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeWeChatArticleUrl(value: unknown): string | null {
  const candidate = stringValue(value);
  if (!candidate) return null;
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  try {
    const url = new URL(withProtocol);
    const hasArticlePath = (
      (url.pathname.startsWith('/s/') && url.pathname.length > 3)
      || (url.pathname === '/s' && url.search.length > 1)
    );
    if (
      url.hostname.toLowerCase() !== 'mp.weixin.qq.com'
      || !hasArticlePath
      || url.username
      || url.password
      || url.port
    ) {
      return null;
    }
    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function parseWeChatPublishState(
  frontmatter: Record<string, unknown> | null | undefined,
): WeChatPublishState | null {
  if (!frontmatter) return null;
  const draftId = stringValue(frontmatter[WECHAT_DRAFT_ID_FRONTMATTER_KEY]);
  if (!draftId) return null;
  return {
    draftId,
    contentHash: stringValue(frontmatter[WECHAT_CONTENT_HASH_FRONTMATTER_KEY]),
    updatedAt: stringValue(frontmatter[WECHAT_PUBLISHED_AT_FRONTMATTER_KEY]),
    articleUrl: normalizeWeChatArticleUrl(frontmatter[WECHAT_ARTICLE_URL_FRONTMATTER_KEY]) ?? '',
  };
}

export function writeWeChatDraftFrontmatter(
  frontmatter: Record<string, unknown>,
  state: Pick<WeChatPublishState, 'draftId' | 'contentHash' | 'updatedAt'>,
): void {
  const previousDraftId = stringValue(frontmatter[WECHAT_DRAFT_ID_FRONTMATTER_KEY]);
  if (previousDraftId !== state.draftId) {
    delete frontmatter[WECHAT_ARTICLE_URL_FRONTMATTER_KEY];
  }
  frontmatter[WECHAT_DRAFT_ID_FRONTMATTER_KEY] = state.draftId;
  frontmatter[WECHAT_CONTENT_HASH_FRONTMATTER_KEY] = state.contentHash;
  frontmatter[WECHAT_PUBLISHED_AT_FRONTMATTER_KEY] = state.updatedAt;
}
