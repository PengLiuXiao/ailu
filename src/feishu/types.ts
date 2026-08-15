export type FeishuCapabilityId = 'im' | 'docs' | 'base' | 'calendar' | 'drive';

export type FeishuCliStatus = 'missing' | 'ready';

export type FeishuAuthorizationMode = 'publishing' | 'all';

export interface LarkAuthorizationRecord {
  authorizationMode: FeishuAuthorizationMode;
  scopeVersion: number;
  cliVersion: string | null;
  authorizedAt: string;
}

export interface FeishuCapabilityState {
  id: FeishuCapabilityId;
  label: string;
  description: string;
  granted: boolean;
  verified: boolean;
  error?: string;
}

export type FeishuConnectionStatus =
  | 'missing-cli'
  | 'needs-config'
  | 'needs-auth'
  | 'admin-action-required'
  | 'connected'
  | 'error';

export interface FeishuConnectionState {
  status: FeishuConnectionStatus;
  cliPath: string | null;
  cliVersion: string | null;
  cliStatus: FeishuCliStatus;
  configured: boolean;
  connected: boolean;
  authorizationMode: FeishuAuthorizationMode | null;
  permissionsComplete: boolean;
  authorizedAt: string | null;
  accountName: string | null;
  accountOpenId: string | null;
  tenantName: string | null;
  capabilities: Record<FeishuCapabilityId, FeishuCapabilityState>;
  consoleUrl: string | null;
  message: string | null;
}

export interface FeishuAssetDraft {
  placeholder: string;
  vaultPath: string;
  fileName: string;
  mimeType: string;
  contentHash: string;
  alt: string;
  /** Frozen local bytes used only for the network-isolated Studio preview. */
  body?: ArrayBuffer;
}

export interface FeishuSnapshot {
  title: string;
  markdown: string;
  /** Local-only provenance used by the Studio preview. Never sent to Feishu. */
  sourceLineMap?: number[];
  /** Local-only source identity used by the Studio preview. Never sent to Feishu. */
  sourcePath?: string;
  contentHash: string;
  assets: FeishuAssetDraft[];
  warnings: string[];
  vaultBasePath: string;
}

export interface FeishuPublishState {
  documentId: string;
  url: string;
  contentHash: string;
  updatedAt: string;
  title: string;
  associationVersion?: number;
  associationSignature?: string;
}

export type FeishuAuthPhase =
  | 'idle'
  | 'detecting'
  | 'configuring'
  | 'waiting-auth'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface FeishuAuthProgress {
  attemptId?: string;
  phase: FeishuAuthPhase;
  message: string;
  detail?: string;
  verificationUrl?: string;
  qrCodeDataUrl?: string;
  expiresAt?: string;
  consoleUrl?: string;
}

export interface FeishuDocumentResult {
  documentId: string;
  url: string;
}

export interface FeishuFolderResult {
  folderToken: string;
  url: string | null;
}

export interface FeishuDriveFolder {
  token: string;
  name: string;
  url: string;
}

export interface FeishuWikiSpace {
  spaceId: string;
  name: string;
}

export interface FeishuWikiNode {
  spaceId: string;
  nodeToken: string;
  parentNodeToken: string;
  title: string;
  hasChild: boolean;
}
