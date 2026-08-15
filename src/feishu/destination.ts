export type FeishuDestinationKind =
  | 'my-library-root'
  | 'drive-folder'
  | 'wiki-node';

export interface FeishuDestinationSelection {
  kind: FeishuDestinationKind;
  token: string;
  name: string;
  path: string;
  url: string;
  spaceId: string;
}

interface FeishuDestinationSettingsValue {
  feishuFolderToken?: unknown;
  feishuFolderUrl?: unknown;
  feishuDestinationKind?: unknown;
  feishuDestinationName?: unknown;
  feishuDestinationPath?: unknown;
  feishuDestinationSpaceId?: unknown;
}

interface MutableFeishuDestinationSettings {
  feishuFolderToken: string;
  feishuFolderUrl: string;
  feishuDestinationKind: FeishuDestinationKind;
  feishuDestinationName: string;
  feishuDestinationPath: string;
  feishuDestinationSpaceId: string;
}

const MY_LIBRARY_NAME = '个人文档库';

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isFeishuDestinationKind(value: unknown): value is FeishuDestinationKind {
  return value === 'my-library-root'
    || value === 'drive-folder'
    || value === 'wiki-node';
}

export function defaultFeishuDestination(): FeishuDestinationSelection {
  return {
    kind: 'my-library-root',
    token: '',
    name: MY_LIBRARY_NAME,
    path: MY_LIBRARY_NAME,
    url: '',
    spaceId: 'my_library',
  };
}

/**
 * Read the current destination while preserving settings written by the
 * earlier folder-link selector. Legacy tokens are treated as Drive folders
 * until the user chooses a named location from the live tree.
 */
export function readFeishuDestination(
  value: FeishuDestinationSettingsValue | null | undefined,
): FeishuDestinationSelection {
  const token = trimmedString(value?.feishuFolderToken);
  const explicitKind = isFeishuDestinationKind(value?.feishuDestinationKind)
    ? value.feishuDestinationKind
    : null;
  const kind = explicitKind ?? (token ? 'drive-folder' : 'my-library-root');
  if (kind === 'my-library-root' || !token) return defaultFeishuDestination();

  const fallbackName = kind === 'wiki-node' ? '知识库节点' : '自选文件夹';
  const name = trimmedString(value?.feishuDestinationName) || fallbackName;
  const pathPrefix = kind === 'wiki-node' ? '知识库' : '云盘';
  return {
    kind,
    token,
    name,
    path: trimmedString(value?.feishuDestinationPath) || `${pathPrefix} / ${name}`,
    url: kind === 'drive-folder' ? trimmedString(value?.feishuFolderUrl) : '',
    spaceId: kind === 'wiki-node'
      ? trimmedString(value?.feishuDestinationSpaceId)
      : '',
  };
}

export function applyFeishuDestination(
  settings: MutableFeishuDestinationSettings,
  destination: FeishuDestinationSelection,
): void {
  const normalized = destination.kind === 'my-library-root'
    ? defaultFeishuDestination()
    : {
      ...destination,
      token: destination.token.trim(),
      name: destination.name.trim(),
      path: destination.path.trim(),
      url: destination.kind === 'drive-folder' ? destination.url.trim() : '',
      spaceId: destination.kind === 'wiki-node' ? destination.spaceId.trim() : '',
    };
  settings.feishuFolderToken = normalized.token;
  settings.feishuFolderUrl = normalized.url;
  settings.feishuDestinationKind = normalized.kind;
  settings.feishuDestinationName = normalized.name;
  settings.feishuDestinationPath = normalized.path;
  settings.feishuDestinationSpaceId = normalized.spaceId;
}

export function feishuDestinationIdentity(destination: FeishuDestinationSelection): string {
  return JSON.stringify([
    destination.kind,
    destination.token,
    destination.spaceId,
    destination.path,
  ]);
}

export function feishuDestinationLabel(destination: FeishuDestinationSelection): string {
  return destination.path || destination.name || MY_LIBRARY_NAME;
}
