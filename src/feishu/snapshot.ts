import { createHash } from 'crypto';
import { App, FileSystemAdapter, getFrontMatterInfo, parseYaml, TFile } from 'obsidian';

import { buildShareSnapshot } from '../share/snapshot';
import { buildFeishuMarkdown, hashFeishuSnapshot } from './markdown';
import { FEISHU_MANAGED_FRONTMATTER_KEYS } from './frontmatter';
import type { FeishuSnapshot } from './types';

export { withFeishuSnapshotTitle } from './markdown';

function frontmatterRecord(source: string): Record<string, unknown> {
  const info = getFrontMatterInfo(source);
  if (!info.exists || !info.frontmatter.trim()) return {};
  const parsed: unknown = parseYaml(info.frontmatter);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
}

function sourceTitle(source: string, fallback: string): string {
  const value = frontmatterRecord(source).title;
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Fingerprint user-controlled publishing input while ignoring only the Ailu
 * Feishu receipt and authenticated-association fields this transaction owns.
 */
export function hashFeishuSourceIntent(source: string): string {
  const info = getFrontMatterInfo(source);
  const frontmatter = frontmatterRecord(source);
  for (const key of FEISHU_MANAGED_FRONTMATTER_KEYS) delete frontmatter[key];
  const body = info.exists ? source.slice(info.contentStart) : source;
  return createHash('sha256')
    .update(stableJson(frontmatter))
    .update('\0')
    .update(body)
    .digest('hex');
}

function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  const compatible = adapter as typeof adapter & { getBasePath?: () => string };
  if (typeof compatible.getBasePath === 'function') return compatible.getBasePath();
  throw new Error('飞书发布仅支持本地文件系统 Vault。');
}

export async function buildFeishuSnapshot(app: App, file: TFile): Promise<FeishuSnapshot> {
  const source = await app.vault.read(file);
  const shareSnapshot = await buildShareSnapshot(app, file);
  const title = sourceTitle(source, file.basename);
  const prepared = buildFeishuMarkdown(title, shareSnapshot);
  return {
    title,
    markdown: prepared.markdown,
    sourceLineMap: prepared.sourceLineMap,
    sourcePath: file.path,
    contentHash: hashFeishuSnapshot(title, prepared.markdown, prepared.assets),
    assets: prepared.assets,
    warnings: shareSnapshot.warnings,
    vaultBasePath: vaultBasePath(app),
  };
}
