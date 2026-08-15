import { copyXArticleSourceLineAttributes } from '../src/xArticle/domMapper';
import {
  isXArticleExternalUrl,
  parseXPostUrl,
} from '../src/xArticle/enhancements';
import {
  buildXArticleHero,
  buildXArticlePreviewDocument,
  buildXArticlePreviewMarkdown,
  extractFirstXArticleImage,
  extractXArticleHeroSummary,
  hasXArticleH1,
  normalizeXArticleCoverValue,
  sanitizeXArticlePreviewRemoteMedia,
  splitXArticleFrontmatter,
} from '../src/xArticle/preview';

describe('X Article preview Markdown', () => {
  test('uses the Markdown filename ahead of frontmatter and body headings', () => {
    expect(buildXArticleHero('# Body heading', {
      filename: 'notes/File title.md',
      frontmatter: { title: 'Frontmatter title' },
    }).title).toBe('File title');
  });

  test('normalizes line endings, strips frontmatter, and optionally inserts a filename H1', () => {
    const source = [
      '\uFEFF---',
      'title: Frontmatter title',
      '---',
      'First paragraph.',
      '',
    ].join('\r\n');

    expect(buildXArticlePreviewMarkdown(source, {
      filename: 'notes/Local title.md',
      stripFrontmatter: true,
      useFilenameAsTitle: true,
    })).toBe('# Local title\n\nFirst paragraph.');
    expect(buildXArticlePreviewDocument(source, {
      filename: 'notes/Local title.md',
      stripFrontmatter: true,
      useFilenameAsTitle: true,
    }).sourceLineMap).toEqual([3, 3, 3]);
  });

  test('maps stripped preview lines back to their original source lines', () => {
    const source = ['---', 'tag: x', '---', '', '', 'Paragraph one.', '', 'Paragraph two.'].join('\n');
    expect(buildXArticlePreviewDocument(source, { stripFrontmatter: true })).toEqual({
      markdown: 'Paragraph one.\n\nParagraph two.',
      sourceLineMap: [5, 6, 7],
    });
  });

  test('does not mistake a fenced-code comment for an article H1', () => {
    const markdown = ['```sh', '# not a title', '```', '', 'Body'].join('\n');
    expect(hasXArticleH1(markdown)).toBe(false);
    expect(buildXArticlePreviewMarkdown(markdown, {
      filename: 'Real title.md',
      useFilenameAsTitle: true,
    })).toBe(`# Real title\n\n${markdown}`);
  });

  test('keeps a malformed opening delimiter as body text', () => {
    expect(splitXArticleFrontmatter('---\ntitle: Unclosed\nBody')).toEqual({
      body: '---\ntitle: Unclosed\nBody',
      bodyStartLine: 0,
      hadFrontmatter: false,
      rawFrontmatter: null,
    });
  });

  test('replaces remote media before rendering while preserving source-line mappings', () => {
    const source = [
      '# Remote media boundary',
      '',
      '![standard](https://media.example/standard.png "title")',
      '![entity first](&#x68;ttps://media.example/entity-first.png)',
      '![entity middle](h&#x74;tps://media.example/entity-middle.png)',
      '![numeric entity whitespace](&#9;https://media.example/entity-tab.png)',
      '![hex entity whitespace](&#x20;https://media.example/entity-space.png)',
      '![named entity whitespace](&Tab;https://media.example/entity-named-tab.png)',
      '![nbsp entity whitespace](&nbsp;https://media.example/entity-nbsp.png)',
      '![nbsp alias entity whitespace](&NonBreakingSpace;https://media.example/entity-nbsp-alias.png)',
      '![medium entity whitespace](&MediumSpace;https://media.example/entity-medium-space.png)',
      '![zero entity whitespace](&ZeroWidthSpace;https://media.example/entity-zero-space.png)',
      '![carriage entity whitespace](&#13;https://media.example/entity-carriage.png)',
      '![ftp media](ftp://media.example/file.png)',
      '![custom media](ipfs://media.example/custom.png)',
      '![blob media](blob:https://media.example/blob-id)',
      '![data media](data:image/png;base64,AAAA)',
      '![[standard alt.png]](https://media.example/wiki-shaped-inline.png)',
      '![[standard alt.png]][wiki shaped ref]',
      '![encoded local](images/a&amp;b.png)',
      '![escaped \\] alt](https://media.example/escaped-alt.png)',
      '![nested [alt]](https://media.example/nested-alt.png)',
      '![cross-line',
      'alt](https://media.example/cross-line-alt.png)',
      '![destination newline](',
      'https://media.example/destination-newline.png)',
      '![nested destination](https://media.example/a_(nested).png)',
      '![angle space](<https://media.example/angle space.png>)',
      '- list item',
      '    ![list image](https://media.example/list-image.png)',
      'paragraph continuation',
      '    ![continued image](https://media.example/continued-image.png)',
      '```invalid`info',
      '![after invalid opener](https://media.example/invalid-opener.png)',
      '```',
      'inside real fence',
      '```not-a-close',
      '```',
      '![after valid close](https://media.example/valid-close.png)',
      '![[//media.example/wiki.png|Wiki image]]',
      '![[&#x68;ttps://media.example/wiki-entity.png|Wiki entity]]',
      '<img',
      '  src="https://media.example/raw.png"',
      '  alt="raw">',
      '<video poster="//media.example/poster.jpg" src="local.mp4"></video>',
      '<audio src=https://media.example/audio.mp3></audio>',
      '<source srcset="local.webm 1x, //media.example/movie.webm 2x">',
      '<iframe src="https://media.example/embed"></iframe>',
      '<embed src="https://media.example/plugin">',
      '<object data="//media.example/object"></object>',
      '<svg><image href="https://media.example/vector.png"></image></svg>',
      '<svg><image xlink:href="//media.example/vector-legacy.png"></image></svg>',
      '<img src="&#x68;ttps://media.example/entity.png">',
      '<svg><use href="https://media.example/sprite.svg#icon"></use></svg>',
      '<video><track src="//media.example/captions.vtt"></video>',
      '<br>',
      '<div style="background-image: url(https://media.example/background.png)">local</div>',
      '[ordinary remote link](https://links.example/article)',
      '<https://links.example/autolink>',
      '<reader@example.com>',
      '',
      '```html',
      '<img src="https://code.example/example.png">',
      '```',
    ].join('\n');

    const sanitized = sanitizeXArticlePreviewRemoteMedia(source);
    const preview = buildXArticlePreviewDocument(source);

    expect(sanitized.split('\n')).toHaveLength(source.split('\n').length);
    expect(preview.markdown.split('\n')).toHaveLength(source.split('\n').length);
    expect(preview.sourceLineMap).toEqual(source.split('\n').map((_, index) => index));
    expect(preview.markdown).not.toContain('https://media.example');
    expect(preview.markdown).not.toContain('//media.example');
    expect(preview.markdown).not.toContain('&#x68;ttps://media.example');
    expect(preview.markdown).not.toContain('h&#x74;tps://media.example');
    expect(preview.markdown).toContain('![encoded local](images/a&amp;b.png)');
    expect(preview.markdown).not.toMatch(/<(?:svg|use|track|br)\b/i);
    expect(preview.markdown).toContain('【远程媒体未加载】');
    expect(preview.markdown).toContain('【原始 HTML 未渲染】');
    expect(preview.markdown).toContain('[ordinary remote link](https://links.example/article)');
    expect(preview.markdown).toContain('<https://links.example/autolink>');
    expect(preview.markdown).toContain('<reader@example.com>');
    expect(preview.markdown).toContain('<img src="https://code.example/example.png">');
  });

  test('blocks remote full, collapsed, and shortcut reference images without changing links', () => {
    const source = [
      '![Full image][Shared Remote]',
      '![Collapsed Remote][]',
      '![Shortcut Remote]',
      '![Entity Remote][entity remote]',
      '![Quoted container][quoted container]',
      '![List container][list container]',
      '![Ordered container][ordered container]',
      '> - ![Nested container][nested container]',
      '![Local image][local]',
      '[ordinary remote link][shared remote]',
      '',
      '[shared   remote]: https://references.example/full.png',
      '[collapsed remote]: //references.example/collapsed.png',
      '[shortcut remote]: <http://references.example/shortcut.png> "title"',
      '[entity remote]: &#x68;ttps://references.example/entity.png',
      '> [quoted container]: https://references.example/quoted.png',
      '- [list container]: https://references.example/list.png',
      '1. [ordered container]: https://references.example/ordered.png',
      '> - [nested container]: https://references.example/nested.png',
      '[local]: images/local.png',
      '[wiki shaped ref]: https://media.example/wiki-shaped-reference.png',
    ].join('\n');

    const preview = buildXArticlePreviewDocument(source);

    expect(preview.markdown.split('\n')).toHaveLength(source.split('\n').length);
    expect(preview.sourceLineMap).toEqual(source.split('\n').map((_, index) => index));
    expect(preview.markdown).not.toContain('![Full image][Shared Remote]');
    expect(preview.markdown).not.toContain('![Collapsed Remote][]');
    expect(preview.markdown).not.toContain('![Shortcut Remote]');
    expect(preview.markdown).not.toContain('![Entity Remote][entity remote]');
    expect(preview.markdown).not.toContain('![Quoted container][quoted container]');
    expect(preview.markdown).not.toContain('![List container][list container]');
    expect(preview.markdown).not.toContain('![Ordered container][ordered container]');
    expect(preview.markdown).not.toContain('![Nested container][nested container]');
    expect(preview.markdown).not.toContain('![Local image][local]');
    expect(preview.markdown).toContain('[ordinary remote link][shared remote]');
    expect(preview.markdown).toContain('[shared   remote]: https://references.example/full.png');
  });

  test('makes note transclusions inert while preserving links and known local image embeds', () => {
    const source = [
      '![[Other note]]',
      '![[Other note#Remote section|Embedded note]]',
      '[[Other note]]',
      '![[images/local-cover.webp|Local cover]]',
      '![[images/vector.svg|SVG is not trusted media]]',
      '```md',
      '![[Code example]]',
      '```',
    ].join('\n');

    const preview = buildXArticlePreviewDocument(source);

    expect(preview.markdown.split('\n')).toHaveLength(source.split('\n').length);
    expect(preview.sourceLineMap).toEqual(source.split('\n').map((_, index) => index));
    expect(preview.markdown).not.toContain('![[Other note]]');
    expect(preview.markdown).not.toContain('![[Other note#Remote section|Embedded note]]');
    expect(preview.markdown).toContain('[[Other note]]');
    expect(preview.markdown).toContain('![[images/local-cover.webp|Local cover]]');
    expect(preview.markdown).not.toContain('![[images/vector.svg|SVG is not trusted media]]');
    expect(preview.markdown).toContain('![[Code example]]');
  });
});

describe('X Article hero helpers', () => {
  const markdown = [
    '# Markdown title',
    '',
    '![Cover](<assets/hero cover.png>)',
    '',
    'https://x.com/example/status/123456',
    '',
    '```ts',
    'const hidden = true;',
    '```',
    '',
    '| A | B |',
    '| --- | --- |',
    '| hidden | table |',
    '',
    '> First **useful** paragraph.',
    '',
    '- Second useful point.',
  ].join('\n');

  test('uses the filename first while retaining formatter cover metadata and the derived summary', () => {
    expect(buildXArticleHero(markdown, {
      filename: 'Fallback.md',
      frontmatter: {
        title: 'Top-level title',
        cover: 'top.png',
        formatter: {
          title: 'Formatter title',
          cover: '![[assets/frontmatter.png|1200]]',
        },
      },
      summaryTargetLength: 200,
    })).toEqual({
      title: 'Fallback',
      cover: 'assets/frontmatter.png',
      summary: 'First useful paragraph.\n\nSecond useful point.',
    });
  });

  test('uses x_cover ahead of formatter.cover and the first body image', () => {
    expect(buildXArticleHero('![Body opening](assets/body-opening.png)', {
      filename: 'Article.md',
      frontmatter: {
        x_cover: 'assets/x-cover.png',
        formatter: { cover: 'assets/legacy-cover.png' },
      },
    }).cover).toBe('assets/x-cover.png');
  });

  test('extracts the first non-code Markdown image and normalizes cover syntax', () => {
    expect(extractFirstXArticleImage([
      '```md',
      '![Ignored](ignored.png)',
      '```',
      '![Hero](<assets/hero cover.png> "title")',
    ].join('\n'))).toEqual({ alt: 'Hero', src: 'assets/hero cover.png' });
    expect(normalizeXArticleCoverValue('![[images/cover.png|1200]]')).toBe('images/cover.png');
    expect(normalizeXArticleCoverValue('![cover](images/hero cover.png "wide")'))
      .toBe('images/hero cover.png');
  });

  test('omits headings, media, post-only links, code, and tables from summaries', () => {
    const summary = extractXArticleHeroSummary(markdown, 200);
    expect(summary).toContain('First useful paragraph.');
    expect(summary).toContain('Second useful point.');
    expect(summary).not.toMatch(/Markdown title|Cover|123456|hidden|table/);
  });
});

describe('X Article local DOM helpers', () => {
  test('parses only real X/Twitter status URLs without requesting them', () => {
    expect(parseXPostUrl('https://x.com/example_user/status/12345?s=20')).toEqual({
      handle: 'example_user',
      statusId: '12345',
      url: 'https://x.com/example_user/status/12345?s=20',
    });
    expect(parseXPostUrl('https://twitter.com/user/status/not-a-number')).toBeNull();
    expect(parseXPostUrl('https://example.com/user/status/12345')).toBeNull();
  });

  test('classifies external HTTP links relative to the preview document', () => {
    expect(isXArticleExternalUrl('https://example.com/a', 'https://studio.local/note')).toBe(true);
    expect(isXArticleExternalUrl('/same-origin', 'https://studio.local/note')).toBe(false);
    expect(isXArticleExternalUrl('mailto:test@example.com', 'https://studio.local/note')).toBe(false);
  });

  test('copies only Studio source-line data attributes to replacement shells', () => {
    const source = {
      attributes: [
        { name: 'data-ailu-source-line-start', value: '8' },
        { name: 'data-ailu-source-line-end', value: '10' },
        { name: 'class', value: 'markdown-rendered' },
      ],
    } as unknown as Element;
    const setAttribute = vi.fn();
    const target = { setAttribute } as unknown as HTMLElement;

    copyXArticleSourceLineAttributes(source, target);

    expect(setAttribute.mock.calls).toEqual([
      ['data-ailu-source-line-start', '8'],
      ['data-ailu-source-line-end', '10'],
    ]);
  });
});
