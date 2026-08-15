import { createHash } from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import type { FeishuAssetDraft, FeishuSnapshot } from './types';
import { MAX_IMAGE_BYTES, readRegularFileBeneath } from '../utils/secureAssets';

const STAGING_PREFIX = 'ailu-feishu-assets-';

export interface StagedFeishuAssets {
  vaultBasePath: string;
  assets: FeishuAssetDraft[];
  cleanup: () => Promise<void>;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stagedFileName(asset: FeishuAssetDraft, index: number): string {
  const extension = path.extname(path.basename(asset.fileName));
  const safeExtension = /^\.[a-z\d]{1,10}$/i.test(extension) ? extension.toLowerCase() : '';
  return `${String(index + 1).padStart(4, '0')}-${asset.contentHash.slice(0, 16)}${safeExtension}`;
}

function assertOwnedStagingDirectory(directory: string): void {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    !relative
    || relative.includes(path.sep)
    || !relative.startsWith(STAGING_PREFIX)
    || path.dirname(resolved) !== temporaryRoot
  ) {
    throw new Error('拒绝清理非 Ailu 创建的飞书临时目录。');
  }
}

async function removeOwnedStagingDirectory(directory: string): Promise<void> {
  assertOwnedStagingDirectory(directory);
  await fsp.rm(directory, { recursive: true, force: true });
}

/**
 * Freeze every image used by a confirmed Feishu snapshot before the first
 * remote write. Later changes to the Vault files cannot alter a multi-image
 * upload already in progress.
 */
export async function stageFeishuSnapshotAssets(
  snapshot: FeishuSnapshot,
): Promise<StagedFeishuAssets> {
  if (!snapshot.assets.length) {
    return {
      vaultBasePath: snapshot.vaultBasePath,
      assets: [],
      cleanup: async () => undefined,
    };
  }

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), STAGING_PREFIX));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await removeOwnedStagingDirectory(directory);
    cleaned = true;
  };

  try {
    await fsp.chmod(directory, 0o700);
    const stagedAssets: FeishuAssetDraft[] = [];
    for (const [index, asset] of snapshot.assets.entries()) {
      let bytes: Buffer;
      try {
        bytes = await readRegularFileBeneath(
          snapshot.vaultBasePath,
          asset.vaultPath,
          MAX_IMAGE_BYTES,
        );
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('图片路径')) {
          throw new Error(`飞书${error.message}已停止同步。`, { cause: error });
        }
        throw new Error(`无法读取图片“${asset.fileName}”，已停止飞书同步。`, { cause: error });
      }
      if (sha256(bytes) !== asset.contentHash.toLowerCase()) {
        throw new Error(`图片“${asset.fileName}”在确认后发生了变化，已停止飞书同步；请重新检查后再试。`);
      }

      const fileName = stagedFileName(asset, index);
      await fsp.writeFile(path.join(directory, fileName), bytes, {
        flag: 'wx',
        mode: 0o400,
      });
      stagedAssets.push({ ...asset, vaultPath: fileName });
    }

    return {
      vaultBasePath: directory,
      assets: stagedAssets,
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '飞书图片校验失败，且临时目录未能清理。');
    }
    throw error;
  }
}
