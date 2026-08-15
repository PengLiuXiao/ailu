import type { FeishuAssetDraft, FeishuSnapshot } from './types';

export type FeishuPreviewAssetResolver = (asset: FeishuAssetDraft) => string | null;

function escapeMarkdownAlt(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
}

function escapeMarkdownDestination(value: string): string {
  return value
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

/**
 * Builds a local-only preview from the exact Markdown sent to Feishu.
 *
 * Image placeholders are replaced only when they occupy their own Markdown
 * line outside fenced code. The source snapshot remains unchanged, so preview
 * resource URLs can never leak into publishing or its content hash.
 */
export function buildFeishuPreviewMarkdown(
  snapshot: Pick<FeishuSnapshot, 'markdown' | 'assets'>,
  resolveAsset: FeishuPreviewAssetResolver,
): string {
  const assets = new Map(snapshot.assets.map(asset => [asset.placeholder, asset]));
  let fence: { character: '`' | '~'; length: number } | null = null;

  return snapshot.markdown.split(/\r?\n/).map((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        fenceMatch
        && fenceMatch[1][0] === fence.character
        && fenceMatch[1].length >= fence.length
        && !fenceMatch[2].trim()
      ) fence = null;
      return line;
    }
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
      };
      return line;
    }

    const asset = assets.get(line);
    if (!asset) return line;
    const resourceUrl = resolveAsset(asset);
    if (!resourceUrl) return `> 图片无法预览：${escapeMarkdownAlt(asset.alt || asset.fileName)}`;
    return `![${escapeMarkdownAlt(asset.alt || asset.fileName)}](<${escapeMarkdownDestination(resourceUrl)}>)`;
  }).join('\n');
}
