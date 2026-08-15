/** Canonical product identity. New writes must use only these values. */
export const AILU_IDS = {
  pluginId: 'ailu',
  pluginName: 'Ailu',
  homeEnvironmentVariable: 'AILU_HOME',
  codexDesktopRootsEnvironmentVariable: 'AILU_CODEX_DESKTOP_ROOTS',
  homeDirectoryName: '.ailu',
  vaultDirectoryName: '.ailu',
  memoryActor: 'ailu',
  memoryAppId: 'ailu',
  memoryProjectId: 'ailu',
  memoryProjectPath: '项目/Ailu.md',
  shutdownHandoff: 'ailu.shutdown-handoff',
} as const;

export const PLUGIN_ID = AILU_IDS.pluginId;
export const PLUGIN_NAME = AILU_IDS.pluginName;

export const DEFAULT_CONVERSATION_TITLE = '新建内容工作台会话';

export const VIEW_IDS = {
  chat: 'ailu-chat',
  publishing: 'ailu-publishing',
} as const;

export const COMMAND_IDS = {
  openChat: 'open-chat',
  openPublishing: 'open-publishing-workbench',
  inlineEdit: 'inline-edit',
  stopAgent: 'stop-agent',
} as const;

export const PROTOCOL_IDS = {
  codexClientName: 'ailu',
  codexServiceName: 'ailu',
  shareAssetScheme: 'ailu-asset://',
  preparedImageScheme: 'ailu-prepared-image://',
  wechatAssetScheme: 'ailu-wechat-asset://',
  wechatFormulaScheme: 'ailu-wechat-formula://',
  feishuImagePlaceholderPrefix: 'AILU_FEISHU_IMAGE_',
} as const;

export const FRONTMATTER_IDS = {
  feishu: {
    documentId: 'ailu-feishu-doc-id',
    documentUrl: 'ailu-feishu-doc-url',
    contentHash: 'ailu-feishu-content-hash',
    publishedAt: 'ailu-feishu-published-at',
    title: 'ailu-feishu-title',
    associationVersion: 'ailu-feishu-association-version',
    associationSignature: 'ailu-feishu-association-signature',
  },
  wechat: {
    draftId: 'ailu-wechat-draft-id',
    contentHash: 'ailu-wechat-content-hash',
    publishedAt: 'ailu-wechat-published-at',
    articleUrl: 'ailu-wechat-article-url',
  },
} as const;

const STORAGE_DIRECTORY_NAME = AILU_IDS.vaultDirectoryName;

export const STORAGE_IDS = {
  homeEnvironmentVariable: AILU_IDS.homeEnvironmentVariable,
  homeDirectoryName: AILU_IDS.homeDirectoryName,
  vaultDirectoryName: STORAGE_DIRECTORY_NAME,
  conversationsPath: `${STORAGE_DIRECTORY_NAME}/conversations.json`,
  commandsPath: `${STORAGE_DIRECTORY_NAME}/commands.json`,
  mentionCachePath: `${STORAGE_DIRECTORY_NAME}/mention-cache.json`,
  generatedImagesPath: `${STORAGE_DIRECTORY_NAME}/generated-images`,
} as const;

const PROVIDER_API_KEY_SECRET_PREFIX = 'ailu-provider-api-key-';

function providerApiKeySecretId(profileId: string): string {
  const normalizedProfileId = profileId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'profile';
  return `${PROVIDER_API_KEY_SECRET_PREFIX}${normalizedProfileId}`.slice(0, 64);
}

export const SECRET_IDS = {
  wechatRelayToken: 'ailu-wechat-relay-token',
  feishuAssociationKey: 'ailu-feishu-association-key-v1',
  providerApiKey: providerApiKeySecretId,
} as const;

export type StudioViewId = typeof VIEW_IDS[keyof typeof VIEW_IDS];
export type StudioCommandId = typeof COMMAND_IDS[keyof typeof COMMAND_IDS];
