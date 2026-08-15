function getFrontMatterInfoMock(source: string): {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  const frontmatterStart = source.indexOf(match[1]);
  return {
    exists: true,
    frontmatter: match[1],
    from: frontmatterStart,
    to: frontmatterStart + match[1].length,
    contentStart: match[0].length,
  };
}

function parseYamlMock(value: string): Record<string, unknown> {
  return Object.fromEntries(value.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf(':');
    if (separator < 0) return [];
    return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]];
  }));
}

vi.mock('obsidian', () => ({
  App: class App {},
  FileSystemAdapter: class FileSystemAdapter {
    getBasePath(): string { return '/vault'; }
  },
  TFile: class TFile {},
  getFrontMatterInfo: getFrontMatterInfoMock,
  parseYaml: parseYamlMock,
}));

vi.mock('../src/share/snapshot', () => ({
  buildShareSnapshot: vi.fn(async () => ({
    title: '缓存中的旧标题',
    markdown: '正文',
    sourceLineMap: [1],
    contentHash: 'share-hash',
    assets: [],
    warnings: [],
  })),
}));

import { type App, TFile } from 'obsidian';

import {
  buildFeishuSnapshot,
  hashFeishuSourceIntent,
} from '../src/feishu/snapshot';

describe('Feishu source snapshot', () => {
  test('ignores only managed receipt fields in the local intent fingerprint', () => {
    const before = [
      '---',
      'title: 当前标题',
      'category: tutorial',
      'ailu-feishu-doc-id: doc-a',
      'ailu-feishu-content-hash: old',
      '---',
      '正文',
    ].join('\n');
    const afterReceipt = before
      .replace('doc-a', 'doc-b')
      .replace('old', 'new');
    const changedTitle = afterReceipt.replace('title: 当前标题', 'title: 新标题');

    expect(hashFeishuSourceIntent(afterReceipt)).toBe(hashFeishuSourceIntent(before));
    expect(hashFeishuSourceIntent(changedTitle)).not.toBe(hashFeishuSourceIntent(before));
    expect(hashFeishuSourceIntent(afterReceipt.replace('正文', '修改正文')))
      .not.toBe(hashFeishuSourceIntent(before));
  });

  test('uses the title from the same raw Markdown instead of stale metadata cache', async () => {
    const source = '---\ntitle: 文件里的新标题\n---\n正文';
    const app = {
      vault: {
        adapter: { getBasePath: () => '/vault' },
        read: vi.fn(async () => source),
      },
    } as unknown as App;
    const file = Object.assign(new TFile(), { basename: '文件名', path: '文章.md' });

    const snapshot = await buildFeishuSnapshot(app, file);

    expect(snapshot.title).toBe('文件里的新标题');
  });
});
