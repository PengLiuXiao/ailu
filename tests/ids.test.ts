import {
  AILU_IDS,
  COMMAND_IDS,
  DEFAULT_CONVERSATION_TITLE,
  PLUGIN_ID,
  PLUGIN_NAME,
  PROTOCOL_IDS,
  SECRET_IDS,
  STORAGE_IDS,
  VIEW_IDS,
} from '../src/ids';

describe('plugin identity', () => {
  test('uses the canonical Ailu product identity', () => {
    expect(PLUGIN_ID).toBe('ailu');
    expect(PLUGIN_NAME).toBe('Ailu');
    expect(AILU_IDS).toMatchObject({
      pluginId: 'ailu',
      pluginName: 'Ailu',
      homeEnvironmentVariable: 'AILU_HOME',
      homeDirectoryName: '.ailu',
      vaultDirectoryName: '.ailu',
      memoryActor: 'ailu',
      memoryAppId: 'ailu',
      memoryProjectId: 'ailu',
      shutdownHandoff: 'ailu.shutdown-handoff',
    });
    expect(DEFAULT_CONVERSATION_TITLE).toBe('新建内容工作台会话');
  });

  test('uses canonical view and protocol ids while keeping commands unique', () => {
    expect(VIEW_IDS).toEqual({
      chat: 'ailu-chat',
      publishing: 'ailu-publishing',
    });
    expect(PROTOCOL_IDS).toEqual({
      codexClientName: 'ailu',
      codexServiceName: 'ailu',
      shareAssetScheme: 'ailu-asset://',
      preparedImageScheme: 'ailu-prepared-image://',
      wechatAssetScheme: 'ailu-wechat-asset://',
      wechatFormulaScheme: 'ailu-wechat-formula://',
      feishuImagePlaceholderPrefix: 'AILU_FEISHU_IMAGE_',
    });
    expect(new Set(Object.values(VIEW_IDS)).size).toBe(Object.values(VIEW_IDS).length);
    expect(new Set(Object.values(COMMAND_IDS)).size).toBe(Object.values(COMMAND_IDS).length);
  });

  test('uses one isolated storage namespace for vault and home data', () => {
    expect(STORAGE_IDS.homeDirectoryName).toBe('.ailu');
    expect(STORAGE_IDS.vaultDirectoryName).toBe('.ailu');
    expect(STORAGE_IDS.conversationsPath)
      .toBe('.ailu/conversations.json');
    expect(STORAGE_IDS.generatedImagesPath)
      .toBe('.ailu/generated-images');
    expect(new Set(Object.values(STORAGE_IDS))).toContain('.ailu');
  });

  test('creates valid, namespaced SecretStorage ids', () => {
    expect(SECRET_IDS.wechatRelayToken).toBe('ailu-wechat-relay-token');
    expect(SECRET_IDS.feishuAssociationKey).toBe('ailu-feishu-association-key-v1');
    const providerId = SECRET_IDS.providerApiKey('Profile:_With unsafe/characters');
    expect(providerId).toMatch(/^[a-z0-9-]+$/);
    expect(providerId).toMatch(/^ailu-provider-api-key-/);
    expect(providerId.length).toBeLessThanOrEqual(64);
  });
});
