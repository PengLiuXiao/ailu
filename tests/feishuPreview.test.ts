import { buildFeishuPreviewMarkdown } from '../src/feishu/preview';
import type { FeishuAssetDraft, FeishuSnapshot } from '../src/feishu/types';

function asset(index: number): FeishuAssetDraft {
  return {
    placeholder: `AILU_FEISHU_IMAGE_${String(index).padStart(4, '0')}_hash`,
    vaultPath: `assets/image ${index}.png`,
    fileName: `image ${index}.png`,
    mimeType: 'image/png',
    contentHash: `hash-${index}`,
    alt: index === 1 ? 'A [safe] \\ label' : `图片 ${index}`,
  };
}

describe('Feishu local preview Markdown', () => {
  test('replaces 10+ standalone image placeholders without mutating publish Markdown', () => {
    const assets = Array.from({ length: 12 }, (_, index) => asset(index + 1));
    const markdown = [
      '# 飞书预览',
      '',
      '## 表格',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      ...assets.flatMap(item => [item.placeholder, '']),
      '```text',
      assets[0].placeholder,
      '```',
      '',
    ].join('\n');
    const snapshot: Pick<FeishuSnapshot, 'markdown' | 'assets'> = { markdown, assets };

    const preview = buildFeishuPreviewMarkdown(
      snapshot,
      item => `app://obsidian.md/vault/${item.vaultPath.replace(' ', '%20')}`,
    );

    expect(snapshot.markdown).toBe(markdown);
    expect(preview).toContain('| A | B |\n| - | - |\n| 1 | 2 |');
    expect(preview.match(/!\[/g)).toHaveLength(12);
    expect(preview).toContain('![A \\[safe\\] \\\\ label](<app://obsidian.md/vault/assets/image%201.png>)');
    expect(preview).not.toContain('%2520');
    expect(preview).toContain(`\`\`\`text\n${assets[0].placeholder}\n\`\`\``);
  });

  test('renders a clear local fallback while keeping line count stable', () => {
    const missing = asset(1);
    const markdown = `# Title\n\n${missing.placeholder}\n\nBody\n`;
    const preview = buildFeishuPreviewMarkdown(
      { markdown, assets: [missing] },
      () => null,
    );

    expect(preview).toContain('> 图片无法预览：A \\[safe\\] \\\\ label');
    expect(preview.split('\n')).toHaveLength(markdown.split('\n').length);
  });
});
