import type { FeishuPublishState } from './types';
import { FRONTMATTER_IDS } from '../ids';

export const FEISHU_DOC_ID_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.documentId;
export const FEISHU_DOC_URL_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.documentUrl;
export const FEISHU_CONTENT_HASH_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.contentHash;
export const FEISHU_PUBLISHED_AT_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.publishedAt;
export const FEISHU_TITLE_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.title;
export const FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.associationVersion;
export const FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY = FRONTMATTER_IDS.feishu.associationSignature;

export const FEISHU_FRONTMATTER_KEYS = [
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
  FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY,
  FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY,
] as const;

export const FEISHU_MANAGED_FRONTMATTER_KEYS = [
  ...FEISHU_FRONTMATTER_KEYS,
] as const;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function associationVersion(value: unknown): number | undefined {
  return value === 1 ? 1 : undefined;
}

export function parseFeishuPublishState(
  frontmatter: Record<string, unknown> | null | undefined,
): FeishuPublishState | null {
  if (!frontmatter) return null;
  const documentId = stringValue(frontmatter[FEISHU_DOC_ID_FRONTMATTER_KEY]);
  if (!documentId) return null;
  return {
    documentId,
    url: stringValue(frontmatter[FEISHU_DOC_URL_FRONTMATTER_KEY]),
    contentHash: stringValue(frontmatter[FEISHU_CONTENT_HASH_FRONTMATTER_KEY]),
    updatedAt: stringValue(frontmatter[FEISHU_PUBLISHED_AT_FRONTMATTER_KEY]),
    title: stringValue(frontmatter[FEISHU_TITLE_FRONTMATTER_KEY]),
    ...(associationVersion(frontmatter[FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY]) === undefined
      ? {}
      : { associationVersion: 1 }),
    ...(stringValue(frontmatter[FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY])
      ? { associationSignature: stringValue(frontmatter[FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY]) }
      : {}),
  };
}

export function sameFeishuPublishState(
  left: FeishuPublishState | null,
  right: FeishuPublishState | null,
): boolean {
  if (!left || !right) return left === right;
  return left.documentId === right.documentId
    && left.url === right.url
    && left.contentHash === right.contentHash
    && left.updatedAt === right.updatedAt
    && left.title === right.title
    && left.associationVersion === right.associationVersion
    && left.associationSignature === right.associationSignature;
}

/**
 * Keep the state written by a completed publish when Obsidian's metadata cache
 * briefly returns the earlier pending state after processFrontMatter(). A
 * genuinely newer cache entry or a different document association still wins.
 */
export function reconcileCompletedFeishuPublishState(
  loaded: FeishuPublishState | null,
  completed: FeishuPublishState | null,
): FeishuPublishState | null {
  if (!completed?.contentHash) return loaded;
  if (!loaded) return completed;
  if (loaded.documentId !== completed.documentId) return loaded;

  const loadedAt = Date.parse(loaded.updatedAt);
  const completedAt = Date.parse(completed.updatedAt);
  if (
    Number.isFinite(loadedAt)
    && Number.isFinite(completedAt)
    && loadedAt > completedAt
  ) {
    return loaded;
  }
  return completed;
}
