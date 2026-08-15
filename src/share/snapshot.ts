import { createHash } from 'crypto';
import path from 'path';
import { App, normalizePath, TFile } from 'obsidian';
import { PROTOCOL_IDS } from '../ids';
import {
  consumeAssetBudget,
  exactArrayBuffer,
  MAX_IMAGE_BYTES,
  readRegularFileBeneath,
} from '../utils/secureAssets';
import { getVaultBasePath, readVerifiedVaultFile } from '../utils/vault';

import type { ShareAssetDraft, ShareSnapshot } from './types';
import {
  omitMermaidBlocks,
  stripShareFrontmatter,
  transformWikiLinks,
} from './markdownTransforms';
import {
  collapseMermaidSourceLineMap,
  createBodySourceLineMap,
  reconcileSourceLineMap,
} from './sourceLineMap';

export const MAX_SHARE_NOTE_BYTES = 8 * 1024 * 1024;

export {
  omitMermaidBlocks,
  SHARE_ID_FRONTMATTER_KEY,
  stripShareFrontmatter,
  transformWikiLinks,
} from './markdownTransforms';

const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};


function hashBytes(value: ArrayBuffer | string): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : Buffer.from(value))
    .digest('hex');
}

function imageMimeType(file: TFile): string | null {
  return IMAGE_EXTENSION_TO_MIME[file.extension.toLowerCase()] ?? null;
}

function encodedToken(contentHash: string): string {
  return `${PROTOCOL_IDS.shareAssetScheme}${contentHash}`;
}

const ASSET_SCHEME_PATTERN = new RegExp(
  `^${escapeRegExp(PROTOCOL_IDS.shareAssetScheme)}`,
  'i',
);

function resolveImage(app: App, sourcePath: string, linkPath: string): TFile | null {
  const cleanPath = decodeURIComponent(linkPath)
    .replace(/^<|>$/g, '')
    .split('#', 1)[0]
    .trim();
  if (!cleanPath || /^(?:https?:|data:)/i.test(cleanPath) || ASSET_SCHEME_PATTERN.test(cleanPath)) return null;
  const resolved = app.metadataCache.getFirstLinkpathDest(cleanPath, sourcePath);
  return resolved instanceof TFile && imageMimeType(resolved) ? resolved : null;
}

async function replaceAsync(
  source: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  const matches = Array.from(source.matchAll(pattern));
  if (!matches.length) return source;
  const replacements: string[] = [];
  for (const match of matches) replacements.push(await replacer(match));
  let result = '';
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    result += source.slice(cursor, match.index);
    result += replacements[index];
    cursor = (match.index ?? 0) + match[0].length;
  }
  return result + source.slice(cursor);
}

export async function buildShareSnapshot(app: App, file: TFile): Promise<ShareSnapshot> {
  if (file.stat.size > MAX_SHARE_NOTE_BYTES) {
    throw new Error(`笔记“${file.path}”超过 8 MB，未生成分享快照。`);
  }
  const source = (await readVerifiedVaultFile(app, file, MAX_SHARE_NOTE_BYTES, true))
    .body.toString('utf8');
  const { markdown: withoutShareId } = stripShareFrontmatter(source);
  let sourceLineMap = createBodySourceLineMap(source, withoutShareId);
  const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
  const title = typeof frontmatter?.title === 'string' && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : file.basename;
  const warnings = new Set<string>();
  const assetsByPath = new Map<string, ShareAssetDraft>();
  const assetBudget = { count: 0, bytes: 0 };

  const addAsset = async (image: TFile): Promise<ShareAssetDraft> => {
    const existing = assetsByPath.get(image.path);
    if (existing) return existing;
    if (image.stat.size <= 0 || image.stat.size > MAX_IMAGE_BYTES) {
      throw new Error(`图片“${image.path}”为空或超过 10 MB。`);
    }
    const basePath = getVaultBasePath(app);
    if (!basePath) throw new Error('本地图片校验仅支持桌面文件系统 Vault。');
    const bytes = await readRegularFileBeneath(basePath, image.path, MAX_IMAGE_BYTES);
    consumeAssetBudget(assetBudget, bytes.byteLength);
    const body = exactArrayBuffer(bytes);
    const contentHash = hashBytes(body);
    const asset: ShareAssetDraft = {
      token: encodedToken(contentHash),
      vaultPath: image.path,
      fileName: path.posix.basename(image.path),
      mimeType: imageMimeType(image) ?? 'application/octet-stream',
      contentHash,
      body,
    };
    assetsByPath.set(image.path, asset);
    return asset;
  };

  let markdown = await replaceAsync(
    withoutShareId,
    /!\[\[([^\]]+)\]\]/g,
    async (match) => {
      const rawTarget = match[1].split('|', 1)[0].trim();
      const image = resolveImage(app, file.path, rawTarget);
      if (image) {
        const asset = await addAsset(image);
        return `![${image.basename}](${asset.token})`;
      }
      warnings.add(`嵌入笔记“${rawTarget}”未随分享发布`);
      return `> 嵌入内容“${rawTarget}”未随分享发布。`;
    },
  );

  markdown = await replaceAsync(
    markdown,
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    async (match) => {
      const target = match[2];
      if (/^(?:https?:|data:)/i.test(target) || ASSET_SCHEME_PATTERN.test(target)) return match[0];
      const image = resolveImage(app, file.path, target);
      if (!image) {
        warnings.add(`图片“${target}”无法解析，线上文章将保留原始链接`);
        return match[0];
      }
      const asset = await addAsset(image);
      return `![${match[1] || image.basename}](${asset.token})`;
    },
  );

  markdown = transformWikiLinks(markdown);
  sourceLineMap = reconcileSourceLineMap(markdown, sourceLineMap);
  const mermaidSourceLineMap = collapseMermaidSourceLineMap(markdown, sourceLineMap);
  const mermaid = omitMermaidBlocks(markdown);
  markdown = mermaid.markdown;
  sourceLineMap = reconcileSourceLineMap(markdown, mermaidSourceLineMap);
  if (mermaid.found) {
    warnings.add('Mermaid 图表不会随分享发布');
  }

  const assets = Array.from(assetsByPath.values());
  const contentHash = hashBytes(JSON.stringify({
    title,
    markdown,
    assets: assets
      .map((asset) => asset.contentHash)
      .sort(),
  }));

  return {
    title,
    markdown,
    sourceLineMap,
    contentHash,
    assets,
    warnings: Array.from(warnings),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function resolveRelativeVaultPath(sourcePath: string, targetPath: string): string {
  return normalizePath(path.posix.join(path.posix.dirname(sourcePath), targetPath));
}
