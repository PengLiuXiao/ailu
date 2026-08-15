import { PROTOCOL_IDS } from '../ids';

export const PREPARED_ARTICLE_SCHEMA_VERSION = 1 as const;
export const PREPARED_IMAGE_SCHEME = PROTOCOL_IDS.preparedImageScheme;

export interface PublishingImageInput {
  id: string;
  fileName: string;
  mimeType: string;
  body: ArrayBuffer;
  /** Every URL or token by which the rendered HTML may refer to this image. */
  references: readonly string[];
}

export interface PreparedPublishingImage {
  id: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png';
  body: ArrayBuffer;
  contentHash: string;
  placeholder: string;
  originalBytes: number;
  outputBytes: number;
  compressed: boolean;
}

export interface PreparedCoverImage {
  id: string;
  fileName: string;
  mimeType: string;
  body: ArrayBuffer;
  contentHash: string;
  originalBytes: number;
}

export interface PreparedArticleStats {
  removedCover: boolean;
  removedCoverReason: 'matched-cover' | 'first-image-before-heading' | 'not-present';
  removedTitle: boolean;
  imageCount: number;
  uniqueImageCount: number;
  compressedImageCount: number;
  headingCount: number;
  paragraphCount: number;
  nativeListCount: number;
  nativeListItemCount: number;
  dangerousListSectionCount: number;
  dangerousListParagraphCount: number;
  dangerousListBlockCount: number;
  textLength: number;
}

export interface PreparedArticlePreflight {
  passed: true;
  completedAt: string;
  integrityHash: string;
  checkedImageCount: number;
  compressedImageCount: number;
}

export interface PreparedArticle {
  schemaVersion: typeof PREPARED_ARTICLE_SCHEMA_VERSION;
  sourceHash: string;
  contentHash: string;
  title: string;
  author: string;
  digest: string;
  contentSourceUrl: string;
  needOpenComment: boolean;
  onlyFansCanComment: boolean;
  /** Sanitized body HTML containing only HTTPS image URLs or prepared-image placeholders. */
  html: string;
  cover: PreparedCoverImage;
  images: PreparedPublishingImage[];
  stats: PreparedArticleStats;
  preflight: PreparedArticlePreflight;
}

export interface PreparedArticleBuildInput {
  sourceHash: string;
  title: string;
  author?: string;
  digest?: string;
  contentSourceUrl?: string;
  needOpenComment?: boolean;
  onlyFansCanComment?: boolean;
  /** Inline styles from the rendered template root, preserved on the uploaded article wrapper. */
  containerStyle?: string;
  html: string;
  cover: PublishingImageInput;
  images: readonly PublishingImageInput[];
  now?: () => Date;
}

export interface ImageCompressionResult {
  body: ArrayBuffer;
  mimeType: 'image/jpeg';
  extension: 'jpg';
}

export interface ImageCompressionAdapter {
  compressToJpeg(input: PublishingImageInput, maximumBytes: number): Promise<ImageCompressionResult>;
}

export interface PublishingHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: ArrayBuffer | string;
}

export interface PublishingHttpResponse {
  status: number;
  json?: unknown;
  text?: string;
}

export type PublishingHttpClient = (
  request: PublishingHttpRequest,
) => Promise<PublishingHttpResponse>;

export interface LocalRelayTransportConfig {
  relayUrl: string;
  relayToken: string;
  request: PublishingHttpClient;
}

export interface WeChatRelayDraftArticle {
  title: string;
  author: string;
  digest: string;
  content: string;
  content_source_url: string;
  thumb_media_id: string;
  show_cover_pic: number;
  need_open_comment: number;
  only_fans_can_comment: number;
}

export interface DraftVerificationStats {
  title: string;
  contentLength: number;
  imageCount: number;
  nativeListCount: number;
  nativeListItemCount: number;
  dangerousListSectionCount: number;
  dangerousListParagraphCount: number;
  dangerousListBlockCount: number;
  localImageSourceCount: number;
}

export interface LocalRelayPublishOptions {
  idempotencyKey?: string;
}

export interface LocalRelayPublishResult {
  draftMediaId: string;
  coverMediaId: string;
  uploadedImageCount: number;
  verification: DraftVerificationStats;
}
