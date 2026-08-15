import {
  buildFeishuCreatePayload,
  buildFeishuMarkdown,
  buildFeishuUpdatePayload,
  demoteMarkdownHeadings,
  hashFeishuSnapshot,
  splitFeishuPreviewMarkdown,
  withFeishuSnapshotTitle,
} from '../src/feishu/markdown';
import type { FeishuAssetDraft, FeishuSnapshot } from '../src/feishu/types';
import type { ShareAssetDraft } from '../src/share/types';

const asset: FeishuAssetDraft = {
  placeholder: 'AILU_FEISHU_IMAGE_0001_abc',
  vaultPath: 'assets/demo.png',
  fileName: 'demo.png',
  mimeType: 'image/png',
  contentHash: 'abc',
  alt: 'demo',
};

function shareAsset(index: number): ShareAssetDraft {
  return {
    token: `ailu-asset://${index.toString(16).padStart(6, '0')}`,
    vaultPath: `assets/image-${index}.png`,
    fileName: `image-${index}.png`,
    mimeType: 'image/png',
    contentHash: `content-hash-${index}`,
    body: new ArrayBuffer(0),
  };
}

describe('Feishu markdown transforms', () => {
  test('demotes headings while preserving fenced code', () => {
    const source = [
      '# Section',
      '## Detail',
      '',
      '```markdown',
      '# code heading',
      '```',
      '###### Stays at level six',
    ].join('\n');
    expect(demoteMarkdownHeadings(source)).toBe([
      '## Section',
      '### Detail',
      '',
      '```markdown',
      '# code heading',
      '```',
      '###### Stays at level six',
    ].join('\n'));
  });

  test('keeps longer backtick and tilde fences intact when they contain shorter fences', () => {
    const source = [
      '````markdown',
      '```',
      '# literal',
      '````',
      '# Outside',
      '~~~~text',
      '~~~',
      '# literal tilde',
      '~~~~',
      '# End',
    ].join('\n');
    expect(demoteMarkdownHeadings(source)).toBe([
      '````markdown',
      '```',
      '# literal',
      '````',
      '## Outside',
      '~~~~text',
      '~~~',
      '# literal tilde',
      '~~~~',
      '## End',
    ].join('\n'));
  });

  test('preserves leading indented code and trailing hard-break spaces', () => {
    const prepared = buildFeishuMarkdown('Whitespace', {
      title: 'Whitespace',
      markdown: '    const value = 1;\n\tsecond code line\n正文结尾  ',
      sourceLineMap: [1, 2, 3],
      contentHash: 'source',
      warnings: [],
      assets: [],
    });
    expect(prepared.markdown).toBe([
      '# Whitespace',
      '',
      '    const value = 1;',
      '\tsecond code line',
      '正文结尾  ',
      '',
    ].join('\n'));
  });

  test('keeps one escaped local H1 while producing title-free create and update bodies', () => {
    const title = 'A <tag> & [x] *literal* #1';
    const prepared = buildFeishuMarkdown(title, {
      title,
      markdown: '# Section\n\nBody',
      contentHash: 'source',
      warnings: [],
      assets: [],
    });

    expect(prepared.markdown).toBe([
      '# A \\<tag\\> & \\[x\\] \\*literal\\* \\#1',
      '',
      '## Section',
      '',
      'Body',
      '',
    ].join('\n'));
    expect(splitFeishuPreviewMarkdown(prepared.markdown)).toEqual({
      title,
      bodyMarkdown: '## Section\n\nBody\n',
    });
    expect(buildFeishuCreatePayload(prepared.markdown, title)).toEqual({
      title,
      bodyMarkdown: '## Section\n\nBody\n',
    });
    expect(buildFeishuUpdatePayload(prepared.markdown)).toBe(
      '<title>A &lt;tag&gt; &amp; [x] *literal* #1</title>\n## Section\n\nBody\n',
    );
  });

  test('fails closed when the remote body can introduce another document title', () => {
    expect(() => splitFeishuPreviewMarkdown('# Title\n\n# Duplicate\n'))
      .toThrow('第二个文档大标题');
    expect(() => splitFeishuPreviewMarkdown('# Title\n\nDuplicate\n===\n'))
      .toThrow('第二个文档大标题');
    expect(() => splitFeishuPreviewMarkdown('# Title\n\n<title>Injected</title>\n'))
      .toThrow('第二个文档大标题');
    expect(() => buildFeishuCreatePayload('# Title\n\nBody\n', 'Different'))
      .toThrow('标题与已确认的预览不一致');
  });

  test('allows title-like literals inside code fences and escaped Markdown text', () => {
    const markdown = [
      '# Title',
      '',
      '\\<h1>literal\\</h1>',
      '',
      '```html',
      '<title>code sample</title>',
      '# code heading',
      '```',
      '',
    ].join('\n');
    expect(splitFeishuPreviewMarkdown(markdown).bodyMarkdown).toContain('<title>code sample</title>');
  });

  test('demotes Setext H1 headings in the source body', () => {
    expect(demoteMarkdownHeadings('Section\n=======\nBody')).toBe('Section\n-------\nBody');
  });

  test('changes the hash when the title or attachment digest changes', () => {
    const markdown = '# Title\n\nBody\n';
    const first = hashFeishuSnapshot('Title', markdown, [asset]);
    expect(hashFeishuSnapshot('Renamed', '# Renamed\n\nBody\n', [asset])).not.toBe(first);
    expect(hashFeishuSnapshot('Title', markdown, [{ ...asset, contentHash: 'def' }]))
      .not.toBe(first);
  });

  test('updates the single document title and recalculates the hash', () => {
    const snapshot: FeishuSnapshot = {
      title: 'Old',
      markdown: '# Old\n\n## Body\n',
      contentHash: 'old-hash',
      assets: [asset],
      warnings: [],
      vaultBasePath: '/vault',
    };
    const updated = withFeishuSnapshotTitle(snapshot, 'New title');
    expect(updated.title).toBe('New title');
    expect(updated.markdown).toBe('# New title\n\n## Body\n');
    expect(updated.contentHash).not.toBe(snapshot.contentHash);
  });

  test('places an inline image marker in a standalone Markdown block', () => {
    const frozenBody = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    const prepared = buildFeishuMarkdown('Inline image', {
      title: 'Inline image',
      markdown: '文字前 ![示意图](ailu-asset://abc123) 文字后',
      contentHash: 'source',
      warnings: [],
      assets: [{
        token: 'ailu-asset://abc123',
        vaultPath: 'assets/demo.png',
        fileName: 'demo.png',
        mimeType: 'image/png',
        contentHash: 'abcdef1234567890',
        body: frozenBody,
      }],
    });

    expect(prepared.assets).toHaveLength(1);
    expect(prepared.assets[0].body).toBe(frozenBody);
    const placeholder = prepared.assets[0].placeholder;
    expect(prepared.markdown).toContain(`文字前 \n\n${placeholder}\n\n 文字后`);
    const lines = prepared.markdown.split('\n');
    const markerLine = lines.indexOf(placeholder);
    expect(lines[markerLine - 1]).toBe('');
    expect(lines[markerLine + 1]).toBe('');
  });

  test('loads only the Ailu asset scheme without an invalid regex', () => {
    const build = (scheme: string) => buildFeishuMarkdown('Image', {
      title: 'Image',
      markdown: `![示意图](${scheme}abc123)`,
      contentHash: 'source',
      warnings: [],
      assets: [{
        token: `${scheme}abc123`,
        vaultPath: 'assets/demo.png',
        fileName: 'demo.png',
        mimeType: 'image/png',
        contentHash: 'abcdef1234567890',
        body: new ArrayBuffer(0),
      }],
    });

    expect(build('ailu-asset://').assets).toHaveLength(1);
    const preAilu = build('retired-asset://');
    expect(preAilu.assets).toHaveLength(0);
    expect(preAilu.markdown).toContain('retired-asset://abc123');
  });

  test('keeps a line-for-line source map for local preview scroll sync', () => {
    const prepared = buildFeishuMarkdown('Preview title', {
      title: 'Preview title',
      markdown: '# Section\n\nBody',
      sourceLineMap: [8, 9, 10],
      contentHash: 'source',
      warnings: [],
      assets: [],
    });

    expect(prepared.sourceLineMap).toHaveLength(prepared.markdown.split('\n').length);
    expect(prepared.sourceLineMap[0]).toBe(0);
    expect(prepared.sourceLineMap.at(-1)).toBe(10);
  });

  test('maps every line inserted for an inline image to that image source line', () => {
    const image = shareAsset(1);
    const prepared = buildFeishuMarkdown('Inline mapping', {
      title: 'Inline mapping',
      markdown: `前文 ![图](${image.token}) 后文\n结尾`,
      sourceLineMap: [31, 32],
      contentHash: 'source',
      warnings: [],
      assets: [image],
    });

    expect(prepared.markdown.split('\n')).toEqual([
      '# Inline mapping',
      '',
      '前文 ',
      '',
      prepared.assets[0].placeholder,
      '',
      ' 后文',
      '结尾',
      '',
    ]);
    expect(prepared.sourceLineMap).toEqual([0, 0, 31, 31, 31, 31, 31, 32, 32]);
  });

  test('keeps a standalone image and all of its surrounding inserted lines on one source line', () => {
    const image = shareAsset(2);
    const prepared = buildFeishuMarkdown('Standalone mapping', {
      title: 'Standalone mapping',
      markdown: `开头\n\n![图](${image.token})\n\n结尾`,
      sourceLineMap: [40, 41, 42, 43, 44],
      contentHash: 'source',
      warnings: [],
      assets: [image],
    });
    const lines = prepared.markdown.split('\n');
    const placeholderLine = lines.indexOf(prepared.assets[0].placeholder);

    expect(prepared.sourceLineMap).toHaveLength(lines.length);
    expect(prepared.sourceLineMap.slice(placeholderLine - 2, placeholderLine + 3))
      .toEqual([42, 42, 42, 42, 42]);
    expect(prepared.sourceLineMap[lines.indexOf('开头')]).toBe(40);
    expect(prepared.sourceLineMap[lines.indexOf('结尾')]).toBe(44);
  });

  test('does not interpolate later source lines across 10+ expanded image placeholders', () => {
    const images = Array.from({ length: 12 }, (_, index) => shareAsset(index + 10));
    const markdownLines = [
      '开头',
      ...images.map(image => `![${image.fileName}](${image.token})`),
      '结尾',
    ];
    const inputMap = markdownLines.map((_, index) => 100 + index);
    const prepared = buildFeishuMarkdown('Many images', {
      title: 'Many images',
      markdown: markdownLines.join('\n'),
      sourceLineMap: inputMap,
      contentHash: 'source',
      warnings: [],
      assets: images,
    });
    const outputLines = prepared.markdown.split('\n');

    expect(prepared.sourceLineMap).toHaveLength(outputLines.length);
    for (const [index, preparedAsset] of prepared.assets.entries()) {
      const placeholderLine = outputLines.indexOf(preparedAsset.placeholder);
      expect(placeholderLine).toBeGreaterThan(0);
      expect(prepared.sourceLineMap.slice(placeholderLine - 2, placeholderLine + 3))
        .toEqual(Array.from({ length: 5 }, () => 101 + index));
    }
    expect(prepared.sourceLineMap[outputLines.indexOf('结尾')]).toBe(113);
  });
});
