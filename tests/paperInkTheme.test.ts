import {
  PAPER_INK_ENDING,
  PAPER_INK_THEME,
  PAPER_INK_THEME_ID,
  copyPaperInkSourceLineAttributes,
  formatPaperInkListMarker,
} from '../src/wechat/paperInkTheme';

describe('Paper Ink WeChat theme', () => {
  test('keeps the fixed MP Preview visual contract', () => {
    expect(PAPER_INK_THEME_ID).toBe('paper-ink');
    expect(PAPER_INK_THEME.container).toContain('background-color:#F5F4ED');
    expect(PAPER_INK_THEME.container).toContain('padding:26px 8px 36px');
    expect(PAPER_INK_THEME.paragraph).toContain('margin:0 0 20px');
    expect(PAPER_INK_THEME.paragraph).toContain('letter-spacing:0.6px');
    expect(PAPER_INK_THEME.paragraph).toContain('line-height:1.8');
    expect(PAPER_INK_THEME.paragraph).toContain('text-align:left');
    expect(PAPER_INK_THEME.paragraph).toContain('overflow-wrap:anywhere');
    expect(PAPER_INK_THEME.paragraph).toContain('word-break:break-word');
    expect(PAPER_INK_THEME.paragraph).not.toContain('text-align:justify');
    expect(PAPER_INK_THEME.heading.h1.base).toContain('text-align:center');
    expect(PAPER_INK_THEME.heading.h1.base).toContain('font-size:20px');
    expect(PAPER_INK_THEME.heading.h1.content).toContain('font-weight:500');
    expect(PAPER_INK_THEME.strong).toContain("font-family:'Songti SC'");
    expect(PAPER_INK_THEME.strong).toContain('font-weight:700');
    expect(PAPER_INK_THEME.strong).toContain('color:#1B365D');
    expect(PAPER_INK_THEME.headingStrong).toContain('font-weight:inherit');
    expect(PAPER_INK_THEME.codeBlock).toContain('background-color:#EEF2F7');
    expect(PAPER_INK_THEME.codeBlock).toContain('color:#1B365D');
    expect(PAPER_INK_THEME.tableHeader).toContain('line-height:1.65');
    expect(PAPER_INK_THEME.tableCell).toContain('line-height:1.65');
  });

  test('uses flat-list markers and the exact ending interaction labels', () => {
    expect(formatPaperInkListMarker(true, 1)).toBe('01');
    expect(formatPaperInkListMarker(true, 12)).toBe('12');
    expect(formatPaperInkListMarker(false, 1)).toBe(' ');
    expect(PAPER_INK_ENDING.heading).toBe('谢谢你读到这里');
    expect(PAPER_INK_ENDING.body).toBe('如果你觉得今天这篇有收获，欢迎点赞、推荐、转发，我们下篇见。');
    expect(PAPER_INK_ENDING.items.map(item => item.label)).toEqual(['点赞', '推荐', '转发']);
  });

  test('copies only source-line anchors to replacement list rows', () => {
    const source = {
      attributes: [
        { name: 'data-ailu-source-line-start', value: '18' },
        { name: 'data-ailu-source-line-end', value: '22' },
        { name: 'class', value: 'original-list-item' },
      ],
    } as unknown as Element;
    const copied: Array<[string, string]> = [];
    const target = {
      setAttribute(name: string, value: string) {
        copied.push([name, value]);
      },
    } as unknown as HTMLElement;

    copyPaperInkSourceLineAttributes(source, target);

    expect(copied).toEqual([
      ['data-ailu-source-line-start', '18'],
      ['data-ailu-source-line-end', '22'],
    ]);
  });
});
