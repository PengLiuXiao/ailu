import {
  collapseMermaidSourceLineMap,
  createBodySourceLineMap,
  reconcileSourceLineMap,
} from '../src/share/sourceLineMap';

describe('publishing source line map', () => {
  test('keeps body lines aligned when no frontmatter is present', () => {
    const source = ['# 标题', '', '正文'].join('\n');

    expect(createBodySourceLineMap(source, source)).toEqual([0, 1, 2]);
  });

  test('offsets preview lines past stripped frontmatter', () => {
    const source = ['---', 'title: 教程', '---', '# 标题', '正文'].join('\n');
    const body = ['# 标题', '正文'].join('\n');

    expect(createBodySourceLineMap(source, body)).toEqual([3, 4]);
  });

  test('maps a collapsed Mermaid placeholder to the original fence line', () => {
    const markdown = [
      'Before',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      'After',
    ].join('\n');

    expect(collapseMermaidSourceLineMap(markdown, [10, 11, 12, 13, 14, 15, 16]))
      .toEqual([10, 11, 12, 15, 16]);
  });

  test('reconciles an unexpected line-count change without losing endpoints', () => {
    expect(reconcileSourceLineMap('a\nb\nc\nd', [7, 8])).toEqual([7, 7, 8, 8]);
  });
});
