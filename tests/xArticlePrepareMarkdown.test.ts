import path from 'path';

import {
  inspectXArticleCoverSources,
  prepareXArticleMarkdown,
} from '../src/xArticle/prepareMarkdown';
import type { XArticlePrepareFileSystem } from '../src/xArticle/types';

function memoryFileSystem(writes: Map<string, string>, chmods: Array<[string, number]>): XArticlePrepareFileSystem {
  return {
    mkdir: async () => undefined,
    writeFile: async (filePath, data) => {
      if (writes.has(filePath)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      writes.set(filePath, data);
    },
    chmod: async (filePath, mode) => {
      chmods.push([filePath, mode]);
    },
  };
}

describe('prepareXArticleMarkdown', () => {
  test('reports configured and upload-eligible leading cover sources without resolving files', () => {
    expect(inspectXArticleCoverSources([
      '---',
      'formatter:',
      '  cover: "[[assets/cover.png]]"',
      '---',
      '![Cover](assets/cover.png)Body starts here.',
    ].join('\n'))).toEqual({
      configuredTarget: 'assets/cover.png',
      leadingTarget: 'assets/cover.png',
    });

    expect(inspectXArticleCoverSources('![[wiki image.png]]\n\nBody.')).toEqual({
      configuredTarget: null,
      leadingTarget: null,
    });
  });

  test('uses x_cover ahead of legacy formatter.cover without removing the first body image', async () => {
    const writes = new Map<string, string>();
    const markdown = [
      '---',
      'x_cover: "[[assets/x-cover.png]]"',
      'formatter:',
      '  cover: "[[assets/legacy-cover.png]]"',
      '---',
      '![First body image](assets/body-opening.png)',
      '',
      'Body.',
    ].join('\n');
    const resolved = new Map([
      ['assets/x-cover.png', '/vault/assets/x-cover.png'],
      ['assets/legacy-cover.png', '/vault/assets/legacy-cover.png'],
      ['assets/body-opening.png', '/vault/assets/body-opening.png'],
    ]);

    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/article.md',
      markdown,
      resolveImage: reference => resolved.get(reference.target) ?? null,
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'x-cover-priority',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.formatter.cover).toBe('[[assets/x-cover.png]]');
    expect(prepared.coverPath).toBe('/vault/assets/x-cover.png');
    expect(prepared.rewrittenMarkdown).toMatch(/^!\[cover\]\(\/vault\/assets\/x-cover\.png\)/);
    expect(prepared.rewrittenMarkdown).toContain('![First body image](/vault/assets/body-opening.png)');
    expect(prepared.resolvedImages.some(image => image.absolutePath.endsWith('legacy-cover.png'))).toBe(false);
  });

  test('uses the filename ahead of formatter metadata, rewrites images, and avoids a duplicate cover', async () => {
    const writes = new Map<string, string>();
    const chmods: Array<[string, number]> = [];
    const markdown = [
      '---',
      'formatter:',
      '  title: "Stable title"',
      '  cover: "[[assets/cover (1).png]]"',
      '---',
      '![[assets/cover (1).png|Cover]]',
      '',
      '# Ignored heading title',
      '',
      'A stable image anchor.',
      '![Body](assets/body image.png)',
      '',
      '```md',
      '![[assets/example.png]]',
      '```',
    ].join('\n');
    const resolved = new Map([
      ['assets/cover (1).png', '/vault/assets/cover (1).png'],
      ['assets/body image.png', '/vault/assets/body image.png'],
    ]);

    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/article.md',
      markdown,
      resolveImage: reference => resolved.get(reference.target) ?? null,
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'unique-id',
      fileSystem: memoryFileSystem(writes, chmods),
    });

    expect(prepared.title).toBe('article');
    expect(prepared.coverPath).toBe('/vault/assets/cover (1).png');
    expect(prepared.resolvedImages).toHaveLength(2);
    expect(prepared.resolvedImages.filter(image => image.cover)).toHaveLength(1);
    expect(prepared.rewrittenMarkdown.match(/cover%20%281%29\.png/g)).toHaveLength(1);
    expect(prepared.rewrittenMarkdown).toContain('/vault/assets/body%20image.png');
    expect(prepared.rewrittenMarkdown).toContain('![[assets/example.png]]');
    expect(prepared.rewrittenMarkdown).not.toContain('formatter:');
    expect(prepared.rewrittenMarkdown).not.toMatch(/^---/);
    expect(prepared.path).toBe(path.join('/private/tmp/x-prepare', 'article-unique-id.md'));
    expect(writes.get(prepared.path)).toBe(prepared.rewrittenMarkdown);
    expect(prepared.sourceContentHash).not.toBe(prepared.contentHash);
    expect(chmods).toContainEqual(['/private/tmp/x-prepare', 0o700]);
    expect(chmods).toContainEqual([prepared.path, 0o600]);
  });

  test('treats an inline image opening the first content line as cover even when text follows it', async () => {
    const writes = new Map<string, string>();
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/Leading article.md',
      markdown: '![Cover](assets/leading.png)Leading paragraph text.\n\n# Real heading\n\nBody.',
      resolveImage: reference => (reference.target === 'assets/leading.png'
        ? '/vault/assets/leading.png'
        : null),
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'leading-cover',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.title).toBe('Leading article');
    expect(prepared.coverPath).toBe('/vault/assets/leading.png');
    expect(prepared.resolvedImages.filter(image => image.cover).map(image => image.absolutePath))
      .toEqual(['/vault/assets/leading.png']);
    expect(prepared.rewrittenMarkdown).toMatch(/^!\[Cover\]\(\/vault\/assets\/leading\.png\)/);
  });

  test('strips BOM and the complete frontmatter block from the publishing copy', async () => {
    const writes = new Map<string, string>();
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/BOM article.md',
      markdown: [
        '\uFEFF---',
        'formatter:',
        '  title: "BOM title"',
        'description: "an inline --- value is not a closing fence"',
        '---',
        '# Body heading',
        '',
        'Body stays intact.',
      ].join('\n'),
      resolveImage: () => null,
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'bom-frontmatter',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.title).toBe('BOM article');
    expect(prepared.rewrittenMarkdown).toBe('# Body heading\n\nBody stays intact.\n');
    expect(prepared.rewrittenMarkdown).not.toContain('\uFEFF');
    expect(prepared.rewrittenMarkdown).not.toContain('description:');
    expect(writes.get(prepared.path)).toBe(prepared.rewrittenMarkdown);
  });

  test('can omit remote images without performing network access and records the omission', async () => {
    const writes = new Map<string, string>();
    const calls: string[] = [];
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/article.md',
      markdown: '# Title\n\nRemote image:\n![Remote](https://example.com/image.png)',
      resolveImage: reference => {
        calls.push(reference.target);
        return null;
      },
      remoteImagePolicy: 'omit',
      randomId: () => 'remote-id',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(calls).toEqual(['https://example.com/image.png']);
    expect(prepared.omittedRemoteImages).toHaveLength(1);
    expect(prepared.rewrittenMarkdown).not.toContain('https://example.com');
    expect(prepared.resolvedImages).toHaveLength(0);
  });

  test('does not confuse wiki-shaped Markdown alt text with an Obsidian image embed', async () => {
    const writes = new Map<string, string>();
    const calls: Array<{ kind: string; target: string }> = [];
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/article.md',
      markdown: [
        '# Title',
        '![[standard alt.png]](https://example.com/remote.png)',
        '![[standard alt.png]][reference]',
        '[reference]: images/local.png',
      ].join('\n'),
      resolveImage: reference => {
        calls.push({ kind: reference.kind, target: reference.target });
        return null;
      },
      remoteImagePolicy: 'omit',
      randomId: () => 'wiki-shaped-alt',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(calls).toEqual([{ kind: 'markdown', target: 'https://example.com/remote.png' }]);
    expect(prepared.omittedRemoteImages).toHaveLength(1);
    expect(prepared.rewrittenMarkdown).not.toContain('https://example.com/remote.png');
    expect(prepared.rewrittenMarkdown).toContain('![[standard alt.png]][reference]');
  });

  test('fails closed for unresolved images and non-absolute resolver output', async () => {
    const base = {
      sourcePath: '/vault/article.md',
      markdown: '# Title\n\nAnchor text.\n![[image.png]]',
      randomId: () => 'never-written',
      fileSystem: memoryFileSystem(new Map(), []),
    };
    await expect(prepareXArticleMarkdown({ ...base, resolveImage: () => null }))
      .rejects.toThrow('could not be resolved locally');
    await expect(prepareXArticleMarkdown({ ...base, resolveImage: () => 'relative/image.png' }))
      .rejects.toThrow('absolute local path');
  });

  test('does not mistake a fenced-code heading for the article title', async () => {
    const writes = new Map<string, string>();
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/Fallback filename.md',
      markdown: [
        '```md',
        '# Example inside code',
        '```',
        '',
        'Ordinary body without a heading.',
      ].join('\n'),
      resolveImage: () => null,
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'fenced-title',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.title).toBe('Fallback filename');
  });

  test('uses the note filename as the title when the first H1 is a chapter heading', async () => {
    const writes = new Map<string, string>();
    const prepared = await prepareXArticleMarkdown({
      sourcePath: '/vault/网络基础知识.md',
      markdown: '# 一、IP是什么\n\nBody paragraph.\n\n# 二、下一页',
      resolveImage: () => null,
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'filename-title',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.title).toBe('网络基础知识');
  });

  test('uses one CommonMark fence state for fallback titles and image rewriting', async () => {
    const writes = new Map<string, string>();
    const calls: string[] = [];
    const prepared = await prepareXArticleMarkdown({
      // A path without a file leaf exercises the body-heading fallback while
      // image rewriting uses the same CommonMark fence state.
      sourcePath: '/',
      markdown: [
        '````md',
        '# Code heading',
        '![Code](code.png)',
        '```',
        '![Still code](still-code.png)',
        '````',
        '# Real heading',
        '```invalid`info',
        '![Body one](body-one.png)',
        '~~~md',
        '![Tilde code](tilde-code.png)',
        '~~~not-a-close',
        '![Still tilde code](still-tilde.png)',
        '~~~~',
        '![Body two](body-two.png)',
      ].join('\n'),
      resolveImage: reference => {
        calls.push(reference.target);
        return `/vault/assets/${reference.target}`;
      },
      tempDirectory: '/private/tmp/x-prepare',
      randomId: () => 'fence-states',
      fileSystem: memoryFileSystem(writes, []),
    });

    expect(prepared.title).toBe('Real heading');
    expect(calls).toEqual(['body-one.png', 'body-two.png']);
    expect(prepared.rewrittenMarkdown).toContain('![Code](code.png)');
    expect(prepared.rewrittenMarkdown).toContain('![Still code](still-code.png)');
    expect(prepared.rewrittenMarkdown).toContain('![Tilde code](tilde-code.png)');
    expect(prepared.rewrittenMarkdown).toContain('![Still tilde code](still-tilde.png)');
    expect(prepared.rewrittenMarkdown).toContain('/vault/assets/body-one.png');
    expect(prepared.rewrittenMarkdown).toContain('/vault/assets/body-two.png');
  });
});
