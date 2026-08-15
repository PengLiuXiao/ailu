import type { WeChatAssetDraft, WeChatPreviewSnapshot } from '../wechat/types';
import { PreparedArticleBuilder } from './preparedArticleBuilder';
import type { PreparedArticle, PublishingImageInput } from './types';

export interface PrepareSnapshotForPublishingOptions {
  containerStyle?: string;
  builder?: PreparedArticleBuilder;
}

export async function prepareSnapshotForPublishing(
  snapshot: WeChatPreviewSnapshot,
  renderedHtml: string,
  options: PrepareSnapshotForPublishingOptions = {},
): Promise<PreparedArticle> {
  const coverAsset = selectCoverAsset(snapshot);
  if (!coverAsset) {
    throw new Error('没有可用封面：请在 Frontmatter 指定 cover，或把封面放在正文首图');
  }
  return (options.builder ?? new PreparedArticleBuilder()).build({
    sourceHash: snapshot.contentHash,
    title: snapshot.title,
    author: snapshot.author,
    digest: snapshot.digest,
    contentSourceUrl: snapshot.contentSourceUrl,
    needOpenComment: snapshot.needOpenComment,
    onlyFansCanComment: snapshot.onlyFansCanComment,
    containerStyle: options.containerStyle,
    html: renderedHtml,
    cover: publishingImage(coverAsset),
    images: mergePublishingImages(snapshot.assets),
  });
}

export function selectCoverAsset(snapshot: WeChatPreviewSnapshot): WeChatAssetDraft | null {
  if (snapshot.coverAssetToken) {
    const selected = snapshot.assets.find(asset => asset.token === snapshot.coverAssetToken);
    if (selected) return selected;
  }
  return snapshot.assets[0] ?? null;
}

function publishingImage(asset: WeChatAssetDraft): PublishingImageInput {
  return {
    id: asset.token,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    body: asset.body,
    references: [asset.token, asset.source, asset.previewUrl, asset.fileName].filter(Boolean),
  };
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function mergePublishingImages(
  assets: readonly WeChatAssetDraft[],
): PublishingImageInput[] {
  const merged = new Map<string, {
    asset: WeChatAssetDraft;
    input: PublishingImageInput;
  }>();
  for (const asset of assets) {
    const input = publishingImage(asset);
    const existing = merged.get(input.id);
    if (!existing) {
      merged.set(input.id, { asset, input });
      continue;
    }
    if (
      existing.asset.contentHash !== asset.contentHash
      || existing.input.mimeType !== input.mimeType
      || !sameBytes(existing.input.body, input.body)
    ) {
      throw new Error(`正文图片 ID 对应内容不一致：${input.id}`);
    }
    existing.input = {
      ...existing.input,
      references: [...new Set([...existing.input.references, ...input.references])],
    };
  }
  return [...merged.values()].map(({ input }) => input);
}
