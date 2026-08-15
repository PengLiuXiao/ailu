import { createHash } from 'node:crypto';

import { describe, expect, test, vi } from 'vitest';

import {
  ManagedPreviewUrlStore,
  sanitizeManagedPreviewMarkdown,
  sanitizeUntrustedMarkdownMedia,
  type PreviewObjectUrlApi,
} from '../src/utils/previewSecurity';

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function objectUrlFixture(): {
  api: PreviewObjectUrlApi;
  createObjectURL: ReturnType<typeof vi.fn>;
  revokeObjectURL: ReturnType<typeof vi.fn>;
} {
  let sequence = 0;
  const createObjectURL = vi.fn(() => `blob:ailu-preview/${++sequence}`);
  const revokeObjectURL = vi.fn();
  return {
    api: { createObjectURL, revokeObjectURL },
    createObjectURL,
    revokeObjectURL,
  };
}

describe('untrusted Markdown preview security', () => {
  test('removes SSRF-capable media before rendering and preserves inert code and links', () => {
    const managedUrl = 'blob:ailu-preview/managed';
    const source = [
      '![public](https://images.example.test/a.png)',
      '![loopback](http://127.0.0.1/admin)',
      '![data](data:image/svg+xml,<svg></svg>)',
      '![foreign blob](blob:attacker-controlled)',
      '![entity scheme](&#x68;ttps://images.example.test/entity.png)',
      '![percent scheme](h%74tps://images.example.test/percent.png)',
      '![reference][remote image]',
      '[remote image]: https://images.example.test/reference.png',
      '<img src="https://images.example.test/raw.png" onerror="fetch(\'/secret\')">',
      '<style>body{background:url(http://127.0.0.1/private)}</style>',
      '![local](assets/safe.png)',
      '![local svg](assets/network-capable.svg)',
      `![managed](${managedUrl})`,
      '[ordinary link](https://links.example.test/article)',
      '```html',
      '<img src="https://code.example.test/not-rendered.png">',
      '```',
    ].join('\n');

    const sanitized = sanitizeUntrustedMarkdownMedia(source, new Set([managedUrl]));
    const renderedPart = sanitized.split('```html', 1)[0];
    expect(renderedPart).not.toMatch(/(?:127\.0\.0\.1|data:image|blob:attacker)/i);
    expect(renderedPart).not.toMatch(/!\[(?:public|loopback|data|foreign blob|entity scheme|percent scheme|reference)\]/i);
    expect(renderedPart).not.toContain('<img');
    expect(renderedPart).not.toContain('<style>');
    expect(sanitized).toContain('![local](assets/safe.png)');
    expect(sanitized).not.toContain('network-capable.svg');
    expect(sanitized).toContain(`![managed](${managedUrl})`);
    expect(sanitized).toContain('[ordinary link](https://links.example.test/article)');
    expect(sanitized).toContain('<img src="https://code.example.test/not-rendered.png">');
  });

  test('does not allow an arbitrary blob URL through another preview allowlist', () => {
    const sanitized = sanitizeUntrustedMarkdownMedia(
      '![owned](blob:owned)\n![foreign](blob:foreign)',
      new Set(['blob:owned']),
    );

    expect(sanitized).toContain('![owned](blob:owned)');
    expect(sanitized).not.toContain('blob:foreign');
  });

  test('managed-only mode blocks every unowned Markdown and wiki image', () => {
    const managedUrl = 'blob:ailu-preview/managed-only';
    const source = [
      '![relative](assets/local.png)',
      '![app](app://obsidian.md/vault/local.png)',
      '![custom](plugin-resource://vault/local.png)',
      '![data](data:image/png;base64,AAAA)',
      '![remote](https://images.example.test/remote.png)',
      '![foreign blob](blob:foreign)',
      '![[assets/wiki-local.png]]',
      `![managed](${managedUrl})`,
      '<img src="assets/raw-local.png">',
      '[ordinary local link](assets/document.png)',
      '```markdown',
      '![inert example](https://code.example.test/example.png)',
      '```',
    ].join('\n');

    const sanitized = sanitizeManagedPreviewMarkdown(source, new Set([managedUrl]));
    const renderedPart = sanitized.split('```markdown', 1)[0];
    expect(renderedPart).not.toMatch(/!\[(?:relative|app|custom|data|remote|foreign blob)\]/i);
    expect(renderedPart).not.toContain('![[assets/wiki-local.png]]');
    expect(renderedPart).not.toContain('<img');
    expect(renderedPart).toContain(`![managed](${managedUrl})`);
    expect(renderedPart).toContain('[ordinary local link](assets/document.png)');
    expect(sanitized).toContain('![inert example](https://code.example.test/example.png)');
    expect(sanitized.split('\n')).toHaveLength(source.split('\n').length);
  });
});

describe('managed preview object URL lifecycle', () => {
  test('pins bytes to their hash and revokes replaced, removed, and closed URLs', () => {
    const fixture = objectUrlFixture();
    const store = new ManagedPreviewUrlStore(fixture.api);
    const first = store.setVerifiedImage('first', PNG_BYTES, 'image/png', hash(PNG_BYTES));
    expect(store.setVerifiedImage('first', PNG_BYTES, 'image/png', hash(PNG_BYTES))).toBe(first);
    expect(fixture.createObjectURL).toHaveBeenCalledTimes(1);

    const secondBytes = Uint8Array.from([...PNG_BYTES, 0x01]);
    const second = store.setVerifiedImage('first', secondBytes, 'image/png', hash(secondBytes));
    expect(second).not.toBe(first);
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith(first);

    const retained = store.setVerifiedImage('retained', PNG_BYTES, 'image/png', hash(PNG_BYTES));
    store.revokeExcept(new Set(['retained']));
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith(second);
    expect(store.allowedObjectUrls()).toEqual(new Set([retained]));

    store.revokeAll();
    expect(fixture.revokeObjectURL).toHaveBeenCalledWith(retained);
    expect(store.allowedObjectUrls()).toEqual(new Set());
  });

  test('fails before creating an URL for hash or magic-byte drift', () => {
    const fixture = objectUrlFixture();
    const store = new ManagedPreviewUrlStore(fixture.api);

    expect(() => store.setVerifiedImage('hash-drift', PNG_BYTES, 'image/png', '0'.repeat(64)))
      .toThrow('冻结快照');
    expect(() => store.setVerifiedImage(
      'mime-drift',
      Uint8Array.from([0xff, 0xd8, 0xff]),
      'image/png',
    )).toThrow('声明格式');
    expect(fixture.createObjectURL).not.toHaveBeenCalled();
  });
});
