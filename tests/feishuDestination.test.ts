import {
  applyFeishuDestination,
  defaultFeishuDestination,
  feishuDestinationIdentity,
  feishuDestinationLabel,
  readFeishuDestination,
  type FeishuDestinationSelection,
} from '../src/feishu/destination';

describe('Feishu destination settings', () => {
  test('defaults to the personal document library root', () => {
    expect(readFeishuDestination(null)).toEqual(defaultFeishuDestination());
    expect(feishuDestinationLabel(defaultFeishuDestination())).toBe('个人文档库');
  });

  test('keeps a folder-link-era token as a backward-compatible Drive destination', () => {
    expect(readFeishuDestination({
      feishuFolderToken: 'legacyFolderToken',
      feishuFolderUrl: 'https://example.feishu.cn/drive/folder/legacyFolderToken',
    })).toEqual({
      kind: 'drive-folder',
      token: 'legacyFolderToken',
      name: '自选文件夹',
      path: '云盘 / 自选文件夹',
      url: 'https://example.feishu.cn/drive/folder/legacyFolderToken',
      spaceId: '',
    });
  });

  test('round-trips a selected Wiki node without keeping a Drive URL', () => {
    const destination: FeishuDestinationSelection = {
      kind: 'wiki-node',
      token: 'wikcnNode',
      name: '项目资料',
      path: '知识库 / 团队空间 / 项目资料',
      url: 'https://example.feishu.cn/wiki/wikcnNode',
      spaceId: '123456',
    };
    const settings = {
      feishuFolderToken: 'old',
      feishuFolderUrl: 'https://old.example',
      feishuDestinationKind: 'drive-folder' as const,
      feishuDestinationName: '旧位置',
      feishuDestinationPath: '云盘 / 旧位置',
      feishuDestinationSpaceId: '',
    };

    applyFeishuDestination(settings, destination);

    expect(settings).toEqual({
      feishuFolderToken: 'wikcnNode',
      feishuFolderUrl: '',
      feishuDestinationKind: 'wiki-node',
      feishuDestinationName: '项目资料',
      feishuDestinationPath: '知识库 / 团队空间 / 项目资料',
      feishuDestinationSpaceId: '123456',
    });
    expect(readFeishuDestination(settings)).toEqual({
      ...destination,
      url: '',
    });
  });

  test('uses the full typed path in confirmation identity', () => {
    const first: FeishuDestinationSelection = {
      kind: 'drive-folder',
      token: 'sameToken',
      name: '文章',
      path: '云盘 / 客户甲 / 文章',
      url: '',
      spaceId: '',
    };
    const renamed = { ...first, path: '云盘 / 客户乙 / 文章' };
    expect(feishuDestinationIdentity(first)).not.toBe(feishuDestinationIdentity(renamed));
  });
});
