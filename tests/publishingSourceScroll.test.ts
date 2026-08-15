import {
  annotatePublishingSourceSection,
  collectPublishingSourceAnchors,
  instrumentPublishingMarkdown,
  materializePublishingSourceMarkers,
  PublishingEditorScrollSync,
  resolvePublishingSourceScrollTop,
} from '../src/ui/publishingSourceScroll';

const viewport = (scrollHeight = 2400, clientHeight = 600) => ({
  scrollHeight,
  clientHeight,
});

const position = (line: number, lineCount = 101, lineProgress = 0) => ({
  line,
  lineCount,
  lineProgress,
});

describe('publishing source scroll resolution', () => {
  test('round-trips Ailu source attributes from annotation into measured anchors', () => {
    const attributes = new Map<string, string>();
    const element = {
      closest: (selector: string) => selector === '.ailu-publishing-article' ? {} : null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      getBoundingClientRect: () => ({ top: 220, height: 48 }),
    } as unknown as HTMLElement;
    const context = {
      getSectionInfo: () => ({ lineStart: 12, lineEnd: 15 }),
    };

    annotatePublishingSourceSection(element, context as never);

    expect(attributes.get('data-ailu-source-line-start')).toBe('12');
    expect(attributes.get('data-ailu-source-line-end')).toBe('15');
    const article = {
      querySelectorAll: (selector: string) => {
        const names = Array.from(selector.matchAll(/\[([^\]]+)\]/g), match => match[1]);
        return names.length === 2 && names.every(name => attributes.has(name)) ? [element] : [];
      },
    } as unknown as HTMLElement;
    const measured = collectPublishingSourceAnchors({
      scrollTop: 100,
      getBoundingClientRect: () => ({ top: 20 }),
    } as unknown as HTMLElement, article);

    expect(measured).toEqual([{ startLine: 12, endLine: 15, top: 300 }]);
  });

  test('uses proportional scrolling when rendered source anchors are unavailable', () => {
    expect(resolvePublishingSourceScrollTop(position(50), viewport(), [])).toBe(900);
  });

  test('instruments rendered blocks with original source lines without changing line counts', () => {
    const markdown = [
      '# 标题',
      '',
      '正文  ',
      '```ts',
      'const untouched = true;',
      '```',
      '结尾',
    ].join('\n');
    const instrumented = instrumentPublishingMarkdown(markdown, [7, 8, 9, 10, 11, 12, 13]);

    expect(instrumented.split('\n')).toEqual([
      '# 标题<span data-ailu-source-line-marker="7"></span>',
      '',
      '正文<span data-ailu-source-line-marker="9"></span>  ',
      '```ts',
      'const untouched = true;',
      '```',
      '结尾<span data-ailu-source-line-marker="13"></span>',
    ]);
  });

  test('keeps table header and data markers inside the final cell', () => {
    const markdown = [
      '| 名称 | 数量 |',
      '| --- | ---: |',
      '| A | 1 |',
      '| B\\|C | 2 |   ',
      '',
      '结尾',
    ].join('\n');
    const instrumented = instrumentPublishingMarkdown(markdown, [20, 21, 22, 23, 24, 25]);
    const lines = instrumented.split('\n');

    expect(lines).toEqual([
      '| 名称 | 数量 <span data-ailu-source-line-marker="20"></span>|',
      '| --- | ---: |',
      '| A | 1 <span data-ailu-source-line-marker="22"></span>|',
      '| B\\|C | 2 <span data-ailu-source-line-marker="23"></span>|   ',
      '',
      '结尾<span data-ailu-source-line-marker="25"></span>',
    ]);
    expect(lines[0].trimEnd().endsWith('|')).toBe(true);
    expect(lines[2].trimEnd().endsWith('|')).toBe(true);
    expect(lines[3].trimEnd().endsWith('|')).toBe(true);
    expect(lines[1]).toBe('| --- | ---: |');
  });

  test('keeps a table without outer pipes valid while instrumenting its final cell', () => {
    const markdown = [
      '名称 | 数量',
      '--- | ---:',
      'A | 1',
    ].join('\n');

    expect(instrumentPublishingMarkdown(markdown, [30, 31, 32]).split('\n')).toEqual([
      '名称 | 数量<span data-ailu-source-line-marker="30"></span>',
      '--- | ---:',
      'A | 1<span data-ailu-source-line-marker="32"></span>',
    ]);
  });

  test('keeps a single-column table marker before its closing pipe', () => {
    const markdown = [
      '| 标题 |',
      '| --- |',
      '| 内容 |',
    ].join('\n');

    expect(instrumentPublishingMarkdown(markdown, [40, 41, 42]).split('\n')).toEqual([
      '| 标题 <span data-ailu-source-line-marker="40"></span>|',
      '| --- |',
      '| 内容 <span data-ailu-source-line-marker="42"></span>|',
    ]);
  });

  test('materializes multiple inline markers into one bounded block range', () => {
    const attributes = new Map<string, string>();
    const target = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    } as unknown as HTMLElement;
    const removeMocks: Array<ReturnType<typeof vi.fn>> = [];
    const marker = (line: number) => {
      const remove = vi.fn();
      removeMocks.push(remove);
      return {
        getAttribute: () => String(line),
        closest: () => target,
        parentElement: target,
        remove,
      } as unknown as HTMLElement;
    };
    const markers = [marker(18), marker(20)];
    const article = {
      querySelectorAll: () => markers,
      contains: (element: HTMLElement) => element === target,
    } as unknown as HTMLElement;

    expect(materializePublishingSourceMarkers(article)).toBe(1);
    expect(attributes.get('data-ailu-source-line-start')).toBe('18');
    expect(attributes.get('data-ailu-source-line-end')).toBe('20');
    expect(removeMocks.every(remove => remove.mock.calls.length === 1)).toBe(true);
  });

  test('aligns an exact source line to its rendered content block', () => {
    expect(resolvePublishingSourceScrollTop(position(50), viewport(), [
      { startLine: 50, endLine: 54, top: 1100 },
    ])).toBe(1088);
  });

  test('interpolates smoothly between rendered content blocks', () => {
    expect(resolvePublishingSourceScrollTop(position(30), viewport(), [
      { startLine: 20, endLine: 22, top: 400 },
      { startLine: 40, endLine: 42, top: 1000 },
    ])).toBe(688);
  });

  test('maps the final source line to the bottom of the preview', () => {
    expect(resolvePublishingSourceScrollTop(position(100), viewport(), [
      { startLine: 90, endLine: 95, top: 1900 },
    ])).toBe(1800);
  });
});

describe('publishing editor scroll bus', () => {
  test('keeps the most recently moving editor for a duplicated file', () => {
    const sync = new PublishingEditorScrollSync();
    const first = sync.registerSource();
    const second = sync.registerSource();
    sync.publish(first, {
      filePath: '文章.md',
      line: 10,
      lineProgress: 0,
      lineCount: 100,
    });
    sync.publish(second, {
      filePath: '文章.md',
      line: 30,
      lineProgress: 0.5,
      lineCount: 100,
    });

    expect(sync.latest('文章.md')).toMatchObject({ line: 30, lineProgress: 0.5 });
    sync.unregisterSource(second);
    expect(sync.latest('文章.md')).toMatchObject({ line: 10 });
  });

  test('notifies subscribers with normalized line values', () => {
    const sync = new PublishingEditorScrollSync();
    const source = sync.registerSource();
    const listener = vi.fn();
    sync.subscribe(listener);

    sync.publish(source, {
      filePath: '文章.md',
      line: 500,
      lineProgress: 3,
      lineCount: 10,
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      line: 9,
      lineProgress: 1,
      lineCount: 10,
    }));
  });
});
