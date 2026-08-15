export const X_ARTICLE_MAX_BODY_MEDIA = 25;
export const X_ARTICLE_COVER_RATIO = '5:2';
export const X_ARTICLE_CONTENT_LENGTH_UNIT = 'unicode_code_points';

export type XArticleRemoteImagePolicy = 'reject' | 'omit';

export interface XArticleImageReference {
  sourcePath: string;
  target: string;
  alt: string;
  kind: 'markdown' | 'wikilink' | 'formatter-cover';
  remote: boolean;
}

export type XArticleImageResolver = (
  reference: XArticleImageReference,
) => string | null | Promise<string | null>;

export interface XArticleResolvedImage extends XArticleImageReference {
  absolutePath: string;
  cover: boolean;
}

export interface XArticlePreparedAssetDigest {
  path: string;
  sha256: string;
  size: number;
}

export interface XArticleOmittedImage extends XArticleImageReference {
  reason: 'remote-image';
}

export interface XArticleFormatterMetadata {
  title: string | null;
  cover: string | null;
}

export interface XArticlePrepareFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<void>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag: 'wx'; mode: number },
  ): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface PrepareXArticleMarkdownOptions {
  sourcePath: string;
  markdown: string;
  resolveImage: XArticleImageResolver;
  remoteImagePolicy?: XArticleRemoteImagePolicy;
  tempDirectory?: string;
  randomId?: () => string;
  fileSystem?: XArticlePrepareFileSystem;
}

export interface PreparedXArticleMarkdown {
  sourcePath: string;
  sourceContentHash: string;
  contentHash: string;
  path: string;
  title: string;
  coverPath: string | null;
  formatter: XArticleFormatterMetadata;
  rewrittenMarkdown: string;
  resolvedImages: XArticleResolvedImage[];
  assetDigests: XArticlePreparedAssetDigest[];
  omittedRemoteImages: XArticleOmittedImage[];
}

export interface XArticlePreflightIssue {
  type: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

export type XArticleMediaPlacement = 'after-anchor' | 'composer-start';

export interface XArticlePreflightAnchor {
  index: number;
  file: string;
  anchor: string;
  placement: XArticleMediaPlacement;
}

export interface XArticlePreflightTable {
  index: number;
  rows: number;
  columns: number;
  marker: string;
  normalizedMatrix: string[][];
}

export interface XArticleCoverPolicy {
  startsWithImage: boolean;
  firstContentLine: number | null;
  firstContentPreview: string;
}

export interface XArticlePreflight {
  title: string;
  coverImage: string | null;
  coverUpload: boolean;
  coverMissing: boolean;
  recommendedCoverRatio: typeof X_ARTICLE_COVER_RATIO;
  coverPolicy: XArticleCoverPolicy;
  postUploadCoverReminder: string;
  expectedBodyImages: number;
  expectedTables: number;
  totalMedia: number;
  endCheckText: string;
  contentCheckpoints: string[];
  expectedCompactLength: number;
  compactLengthUnit: typeof X_ARTICLE_CONTENT_LENGTH_UNIT;
  checkpointPositionUnit: typeof X_ARTICLE_CONTENT_LENGTH_UNIT;
  expectedCompactSha256: string;
  anchors: XArticlePreflightAnchor[];
  tables: XArticlePreflightTable[];
  warnings: XArticlePreflightIssue[];
  errors: XArticlePreflightIssue[];
  preparedContentHash: string | null;
}

export interface XArticleSkillRuntime {
  scriptsDirectory: string;
  uploadScript: string;
  parseScript: string;
  cookieExportScript: string;
  source: 'configured' | 'agents-skill' | 'codex-skill';
}

export type XArticleProgressStage = 'preflight' | 'cookies' | 'upload';

export interface XArticleProgress {
  stage: XArticleProgressStage;
  message: string;
}

export type XArticleProgressCallback = (progress: XArticleProgress) => void;

export interface XArticleUploadArtifacts {
  directory: string;
  resultJson: string;
  url: string;
  screenshot: string;
  log: string;
}

export interface XArticleUploadResult {
  verificationContract: 'x-article-persistence-v1';
  title: string;
  draftUrl: string;
  mediaCount: number;
  bodyMediaCount: number;
  expectedBodyMediaCount: number;
  expectedTotalMedia: number;
  tableCount: number;
  expectedTableCount: number;
  contentCheckpoints: string[];
  matchedCheckpoints: string[];
  checkpointPositions: number[];
  expectedCompactLength: number;
  compactTextLength: number;
  compactLengthUnit: typeof X_ARTICLE_CONTENT_LENGTH_UNIT;
  checkpointPositionUnit: typeof X_ARTICLE_CONTENT_LENGTH_UNIT;
  expectedCompactSha256: string;
  contentCompactSha256: string;
  coverUploaded: boolean;
  coverMissing: boolean;
  coverPersisted: true;
  /**
   * Whether X's transient save-status UI produced a complete mutation-epoch
   * proof. A false value is non-fatal only after the reloaded draft itself has
   * passed the strict content and media persistence contract.
   */
  autosaveVerified: boolean;
  persistenceVerified: true;
  saveText: string;
  verificationWarnings: readonly string[];
  raw: Readonly<Record<string, unknown>>;
}

export type XArticleUploadFailureKind = 'failed' | 'cancelled' | 'timed-out';

interface XArticleUploadOutcomeBase {
  message: string;
  draftUrl: string | null;
  artifacts: XArticleUploadArtifacts | null;
  preflight: XArticlePreflight;
}

export interface XArticleUploadSuccess extends XArticleUploadOutcomeBase {
  status: 'success';
  draftUrl: string;
  artifacts: XArticleUploadArtifacts;
  result: XArticleUploadResult;
}

export interface XArticlePartialDraft extends XArticleUploadOutcomeBase {
  status: 'partial-draft';
  draftUrl: string;
  artifacts: XArticleUploadArtifacts;
  failureKind: XArticleUploadFailureKind;
  result: null;
}

export interface XArticleUploadFailure extends XArticleUploadOutcomeBase {
  status: XArticleUploadFailureKind;
  draftUrl: null;
  result: null;
}

export type XArticleUploadOutcome =
  | XArticleUploadSuccess
  | XArticlePartialDraft
  | XArticleUploadFailure;

export interface XArticleRunOptions {
  signal?: AbortSignal;
  onProgress?: XArticleProgressCallback;
}

export interface XArticleUploadOptions extends XArticleRunOptions {
  preflight?: XArticlePreflight;
}

export interface XArticleCookieStatus {
  path: string;
  cookieCount: number;
  requiredNamesPresent: true;
}
