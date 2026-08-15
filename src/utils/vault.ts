import { App, FileSystemAdapter, TFile } from 'obsidian';

import {
  readVerifiedRegularFileBeneath,
  verifyNewRegularFileTargetBeneath,
  type VerifiedRegularFileRead,
} from './secureAssets';

export function getVaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    return adapter.getBasePath();
  }
  return null;
}

/**
 * Reads through the physical local Vault root and returns only the path tied to
 * the verified no-follow descriptor. Remote/non-filesystem adapters fail closed.
 */
export async function readVerifiedVaultFile(
  app: App,
  file: Pick<TFile, 'path'>,
  maxBytes: number,
  allowEmpty = false,
): Promise<VerifiedRegularFileRead> {
  const basePath = getVaultBasePath(app);
  if (!basePath) throw new Error('安全文件读取仅支持桌面文件系统 Vault。');
  return readVerifiedRegularFileBeneath(basePath, file.path, maxBytes, '文件', allowEmpty);
}

/**
 * Pins an Obsidian attachment destination to a symlink-free physical parent
 * immediately before the Vault API creates it.
 */
export async function verifyVaultNewFileTarget(
  app: App,
  vaultPath: string,
): Promise<{ physicalPath: string }> {
  const basePath = getVaultBasePath(app);
  if (!basePath) throw new Error('安全附件写入仅支持桌面文件系统 Vault。');
  return verifyNewRegularFileTargetBeneath(basePath, vaultPath);
}

export function getActiveMarkdownFile(app: App): TFile | null {
  const file = app.workspace.getActiveFile();
  return file?.extension === 'md' ? file : null;
}

export function guessMimeType(file: TFile): string | undefined {
  const ext = file.extension.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  }
  if (ext === 'md') return 'text/markdown';
  if (ext === 'txt') return 'text/plain';
  return undefined;
}
