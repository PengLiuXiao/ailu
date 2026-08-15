import { verifyFeishuRemoteContent } from '../src/feishu/remoteVerification';
import type { FeishuAssetDraft, FeishuSnapshot } from '../src/feishu/types';
import { PROTOCOL_IDS } from '../src/ids';

function asset(index: number): FeishuAssetDraft {
  return {
    placeholder: `${PROTOCOL_IDS.feishuImagePlaceholderPrefix}${String(index).padStart(4, '0')}_abc${index}`,
    vaultPath: `images/${index}.png`,
    fileName: `${index}.png`,
    mimeType: 'image/png',
    contentHash: `abc${index}`,
    alt: `图片 ${index}`,
  };
}

function snapshot(markdown: string, assets: FeishuAssetDraft[] = []): FeishuSnapshot {
  return {
    title: '示例 & 标题',
    markdown,
    contentHash: 'snapshot-hash',
    assets,
    warnings: [],
    vaultBasePath: '/vault',
  };
}

describe('Feishu remote verification', () => {
  test('rejects arbitrary old body for a snapshot without images', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n这是本次发布的完整正文。\n'),
      '<title id="doc">示例 &amp; 标题</title><p id="old">这是任意旧正文。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('正文不一致');
  });

  test('accepts the complete expected body when there are no images', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n## 第一节\n\n正文有 **重点** 与数字 １２３。\n'),
      [
        '<title id="doc"><span>示例</span> &amp; 标题</title>',
        '<heading2 id="one">第一节</heading2>',
        '<p>正文有 <strong>重点</strong> 与数字 123。</p>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('rejects extra prose wrapped around the expected body', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n这是本次发布的完整正文。\n'),
      '<title>示例 &amp; 标题</title><p>遗留开头。</p><p>这是本次发布的完整正文。</p><p>遗留结尾。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('正文不一致');
  });

  test.each([
    ['标题', '# 示例 & 标题\n\n正文。\n', '<title>示例 标题</title><p>正文。</p>', '标题不一致'],
    ['正文', '# 示例 & 标题\n\nA+B=100%。\n', '<title>示例 &amp; 标题</title><p>AB100。</p>', '正文不一致'],
  ])('rejects punctuation removed from %s', (_label, markdown, remote, message) => {
    const result = verifyFeishuRemoteContent(snapshot(markdown), remote);

    expect(result.ok).toBe(false);
    expect(result.message).toContain(message);
  });

  test('rejects a wrong title even when the body matches', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n正文相同。\n'),
      '<title>另一篇文章</title><p>正文相同。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('标题不一致');
    expect(result.message).toContain('另一篇文章');
  });

  test('rejects wrong or reordered body text', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n第一段。\n\n第二段。\n'),
      '<title>示例 &amp; 标题</title><p>第二段。</p><p>第一段。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('正文不一致');
  });

  test('does not treat compatibility-equivalent title characters as identical', () => {
    const special = snapshot('# A①\n\n正文。\n');
    special.title = 'A①';
    const result = verifyFeishuRemoteContent(
      special,
      '<title>A1</title><p>正文。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('标题不一致');
  });

  test('accepts XML markup, entities and an inserted image caption between text segments', () => {
    const image = asset(1);
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '开场 **重点** & 说明。',
        image.placeholder,
        '收尾 [链接](https://example.com)。',
      ].join('\n'), [image]),
      [
        '<title id="doc"><span>示例</span> &amp; 标题</title>',
        '<p id="before">开场 <strong>重点</strong> &amp; 说明。</p>',
        '<img id="image" src="https://example.test/image.png" />',
        '<p class="caption">图 1：图片 1</p>',
        '<p id="after">收尾 <a href="https://example.com">链接</a>。</p>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('accepts indented code immediately after an ATX heading', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n## Section\n    const answer = 42;\n'),
      [
        '<title>示例 &amp; 标题</title>',
        '<heading2>Section</heading2>',
        '<pre><code>\nconst answer = 42;\n</code></pre>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('does not misclassify four-space continuation text that follows a paragraph', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n正文\n    continuation\n'),
      '<title>示例 &amp; 标题</title><p>正文 continuation</p>',
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('does not misclassify lazy indented continuation text inside a blockquote', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n> quote\n    continuation\n'),
      '<title>示例 &amp; 标题</title><blockquote><p>quote continuation</p></blockquote>',
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('rejects arbitrary extra prose after an image', () => {
    const image = asset(1);
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '开场。',
        image.placeholder,
        '收尾。',
      ].join('\n'), [image]),
      [
        '<title>示例 &amp; 标题</title>',
        '<p>开场。</p>',
        '<img src="https://example.test/image.png">',
        '<p>任意旧文字。</p>',
        '<p>收尾。</p>',
      ].join(''),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('正文与图片顺序不一致');
  });

  test('rejects an image moved after the text that should follow it', () => {
    const image = asset(1);
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '前文',
        image.placeholder,
        '后文',
      ].join('\n'), [image]),
      [
        '<title>示例 &amp; 标题</title>',
        '<p>前文</p>',
        '<p>后文</p>',
        '<img src="https://example.test/image.png">',
      ].join(''),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('正文与图片顺序不一致');
  });

  test('rejects a residual image placeholder', () => {
    const image = asset(1);
    const result = verifyFeishuRemoteContent(
      snapshot(`# 示例 & 标题\n\n前文\n${image.placeholder}\n后文\n`, [image]),
      `<title>示例 &amp; 标题</title><p>前文</p><p>${image.placeholder}</p><p>后文</p>`,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('仍含图片占位符');
  });

  test('rejects fewer images than the snapshot expects', () => {
    const first = asset(1);
    const second = asset(2);
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '前文',
        first.placeholder,
        '中段',
        second.placeholder,
        '后文',
      ].join('\n'), [first, second]),
      '<title>示例 &amp; 标题</title><p>前文</p><img src="one"><p>中段</p><p>后文</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe('飞书回读图片数量不一致：期望 2 张，实际 1 张。');
  });

  test('rejects extra remote images', () => {
    const image = asset(1);
    const result = verifyFeishuRemoteContent(
      snapshot(`# 示例 & 标题\n\n前文\n${image.placeholder}\n后文\n`, [image]),
      [
        '<title>示例 &amp; 标题</title>',
        '<p>前文</p>',
        '<img src="one">',
        '<p>后文</p>',
        '<img src="unexpected">',
      ].join(''),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe('飞书回读图片数量不一致：期望 1 张，实际 2 张。');
  });

  test.each([
    ['等号', 'const answer = "yes";', 'const answer "yes";'],
    ['引号', 'const answer = "yes";', 'const answer = yes;'],
    ['缩进', 'if (ready) {\n  run();\n}', 'if (ready) {\n run();\n}'],
  ])('rejects code that loses %s', (_label, localCode, remoteCode) => {
    const result = verifyFeishuRemoteContent(
      snapshot(`# 示例 & 标题\n\n正文。\n\n\`\`\`ts\n${localCode}\n\`\`\`\n`),
      [
        '<title>示例 &amp; 标题</title>',
        '<p>正文。</p>',
        `<pre><code>\n${remoteCode}\n</code></pre>`,
      ].join(''),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('代码块不一致');
  });

  test('accepts code with exact punctuation and indentation after fixed CLI wrapper newlines', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '正文。',
        '',
        '```ts',
        'if (ready) {',
        '  run("a=b");',
        '}',
        '```',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<p>正文。</p>',
        '<pre><code>\r\nif (ready) {\r\n  run(&quot;a=b&quot;);\r\n}\r\n</code></pre>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test.each([
    ['four spaces', '    const answer = "yes";'],
    ['one tab', '\tconst answer = "yes";'],
    ['space plus tab tab-stop', ' \tconst answer = "yes";'],
  ])('accepts an exact %s indented code block', (_label, localLine) => {
    const result = verifyFeishuRemoteContent(
      snapshot(`# 示例 & 标题\n\n${localLine}\n`),
      [
        '<title>示例 &amp; 标题</title>',
        '<pre><code>\nconst answer = &quot;yes&quot;;\n</code></pre>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('treats title text literally instead of parsing Markdown or HTML', () => {
    const special = snapshot('# ignored\n\n正文。\n');
    special.title = 'A <tag> & [x] *literal*';
    const result = verifyFeishuRemoteContent(
      special,
      '<title>A &lt;tag&gt; &amp; [x] *literal*</title><p>正文。</p>',
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('dedents content by the indentation of a CommonMark opening fence', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '  ```ts',
        '  if (ready) {',
        '    run();',
        '  }',
        '  ```',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<pre><code>\nif (ready) {\n  run();\n}\n</code></pre>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('rejects a remote pre block that is not a pre-code block', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n正文。\n'),
      '<title>示例 &amp; 标题</title><p>正文。</p><pre>遗留内容</pre>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('代码块数量不一致');
  });

  test('normalizes sparse and overflowing GFM rows to the rendered header width', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| A | B |',
        '| --- | --- |',
        '| one |',
        '| two | kept | ignored |',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<table><thead><tr><th>A</th><th>B</th></tr></thead>',
        '<tbody><tr><td>one</td><td></td></tr><tr><td>two</td><td>kept</td></tr></tbody></table>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('treats a pipe after an even backslash run as a table separator', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| Path | Value |',
        '| --- | --- |',
        String.raw`| C:\\ | D |`,
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<table><thead><tr><th>Path</th><th>Value</th></tr></thead>',
        '<tbody><tr><td>C:\\</td><td>D</td></tr></tbody></table>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('rejects duplicate title elements', () => {
    const result = verifyFeishuRemoteContent(
      snapshot('# 示例 & 标题\n\n正文。\n'),
      '<title>示例 &amp; 标题</title><title>示例 &amp; 标题</title><p>正文。</p>',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('标题数量不一致');
  });

  test.each([
    [
      'moves the same text to a different cell',
      '<table><thead><tr><th>姓名</th><th>状态</th></tr></thead><tbody><tr><td>完成</td><td>小林</td></tr></tbody></table>',
    ],
    [
      'drops a column',
      '<table><thead><tr><th>姓名</th><th>状态</th></tr></thead><tbody><tr><td>小林</td></tr></tbody></table>',
    ],
  ])('rejects a table that %s', (_label, remoteTable) => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| 姓名 | 状态 |',
        '| --- | --- |',
        '| 小林 | 完成 |',
      ].join('\n')),
      `<title>示例 &amp; 标题</title>${remoteTable}`,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('表格不一致');
  });

  test('accepts inline XML tags in table cells while preserving punctuation', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| 姓名 | 说明 |',
        '| --- | --- |',
        '| **小林** | 状态：A+B（100%） |',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<table>',
        '<thead><tr><th><strong>姓名</strong></th><th>说明</th></tr></thead>',
        '<tbody><tr><td><span>小</span><strong>林</strong></td><td>状态：<em>A+B</em>（100%）</td></tr></tbody>',
        '</table>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });

  test('rejects punctuation removed from a table cell', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| 项目 | 值 |',
        '| --- | --- |',
        '| 算式 | A+B=100% |',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<table>',
        '<thead><tr><th>项目</th><th>值</th></tr></thead>',
        '<tbody><tr><td>算式</td><td>AB100</td></tr></tbody>',
        '</table>',
      ].join(''),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('表格不一致');
  });

  test('preserves escaped and inline-code punctuation in table cells', () => {
    const result = verifyFeishuRemoteContent(
      snapshot([
        '# 示例 & 标题',
        '',
        '| 类型 | 内容 |',
        '| --- | --- |',
        '| 字面量 | \\*重点\\* 与 `a*b` |',
      ].join('\n')),
      [
        '<title>示例 &amp; 标题</title>',
        '<table>',
        '<thead><tr><th>类型</th><th>内容</th></tr></thead>',
        '<tbody><tr><td>字面量</td><td>*重点* 与 <code>a*b</code></td></tr></tbody>',
        '</table>',
      ].join(''),
    );

    expect(result).toEqual({ ok: true, message: '' });
  });
});
