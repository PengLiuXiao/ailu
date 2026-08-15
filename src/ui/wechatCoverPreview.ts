import { selectCoverAsset } from '../publishing/fromSnapshot';
import type { WeChatAssetDraft, WeChatPreviewSnapshot } from '../wechat/types';

export const WECHAT_COVER_PREVIEW_RATIO = '2.35:1';

export type WeChatCoverPreviewSource = 'explicit' | 'body-first' | 'missing';

export interface WeChatCoverPreviewModel {
  asset: WeChatAssetDraft | null;
  source: WeChatCoverPreviewSource;
  badge: string;
  title: string;
  summary: string;
  alt: string;
}

export function buildWeChatCoverPreviewModel(
  snapshot: WeChatPreviewSnapshot,
): WeChatCoverPreviewModel {
  const asset = selectCoverAsset(snapshot);
  const title = snapshot.title.trim() || '未命名文章';
  const digest = snapshot.digest.trim();
  const explicit = Boolean(
    asset
    && snapshot.coverAssetToken
    && asset.token === snapshot.coverAssetToken,
  );
  const source: WeChatCoverPreviewSource = !asset
    ? 'missing'
    : explicit
      ? 'explicit'
      : 'body-first';
  const sourceLabel = source === 'explicit'
    ? '独立封面'
    : source === 'body-first'
      ? '使用正文首图作为封面'
      : '尚未设置封面';
  const summary = digest
    ? `${sourceLabel} · ${digest}`
    : source === 'missing'
      ? '请设置 wechat_cover，或在正文中加入一张图片。'
      : sourceLabel;

  return {
    asset,
    source,
    badge: `公众号封面 · ${WECHAT_COVER_PREVIEW_RATIO}`,
    title,
    summary,
    alt: asset ? `公众号封面预览：${title}` : '未设置公众号封面',
  };
}
