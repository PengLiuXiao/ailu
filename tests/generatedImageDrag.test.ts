import { describe, expect, test, vi, type Mock } from 'vitest';

vi.mock('../src/utils/vault', () => ({
  readVerifiedVaultFile: vi.fn(),
  verifyVaultNewFileTarget: vi.fn(),
}));

import type { App, Editor, EditorPosition, MarkdownFileInfo, TFile } from 'obsidian';
import type { ChatImageArtifact } from '../src/types';
import { readVerifiedVaultFile, verifyVaultNewFileTarget } from '../src/utils/vault';
import {
  AILU_GENERATED_IMAGE_DRAG_TYPE,
  GeneratedImageDropController,
  GeneratedImageDropError,
  assignGeneratedImageAsCover,
  importGeneratedImageIntoNote,
  readGeneratedImageDragPayload,
  writeGeneratedImageDragPayload,
} from '../src/ui/generatedImageDrag';

const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]).buffer;

function artifact(overrides: Partial<ChatImageArtifact> = {}): ChatImageArtifact {
  return {
    id: 'image-1',
    type: 'image',
    vaultPath: '.ailu/generated-images/conversation/image.png',
    mimeType: 'image/png',
    createdAt: 1,
    revisedPrompt: 'internal revised prompt',
    ...overrides,
  };
}

function dragTransfer(initial = ''): {
  transfer: DataTransfer;
  getData: Mock<() => string>;
  setData: Mock<(type: string, value: string) => void>;
} {
  let value = initial;
  const getData = vi.fn(() => value);
  const setData = vi.fn((_type: string, next: string) => {
    value = next;
  });
  return {
    transfer: {
      effectAllowed: 'uninitialized',
      getData,
      setData,
    } as unknown as DataTransfer,
    getData,
    setData,
  };
}

function editor(): Editor & {
  replaceRange: ReturnType<typeof vi.fn>;
  setCursor: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
} {
  return {
    getCursor: vi.fn(() => ({ line: 2, ch: 4 })),
    replaceRange: vi.fn(),
    posToOffset: vi.fn((position: EditorPosition) => position.line * 100 + position.ch),
    offsetToPos: vi.fn((offset: number) => ({ line: Math.floor(offset / 100), ch: offset % 100 })),
    setCursor: vi.fn(),
    focus: vi.fn(),
  } as unknown as Editor & {
    replaceRange: ReturnType<typeof vi.fn>;
    setCursor: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
}

function appFixture(options: {
  bytes?: ArrayBuffer;
  attachmentPath?: string;
  link?: string;
  processFrontMatterError?: Error;
  frontmatter?: Record<string, unknown>;
} = {}): {
  app: App;
  secureRead: ReturnType<typeof vi.mocked<typeof readVerifiedVaultFile>>;
  verifyTarget: ReturnType<typeof vi.mocked<typeof verifyVaultNewFileTarget>>;
  getAvailablePathForAttachment: ReturnType<typeof vi.fn>;
  createBinary: ReturnType<typeof vi.fn>;
  generateMarkdownLink: ReturnType<typeof vi.fn>;
  processFrontMatter: ReturnType<typeof vi.fn>;
  frontmatter: Record<string, unknown>;
} {
  const bytes = options.bytes ?? pngBytes;
  const attachmentPath = options.attachmentPath ?? 'assets/image.png';
  const created = { path: attachmentPath, extension: 'png' } as TFile;
  const secureRead = vi.mocked(readVerifiedVaultFile);
  secureRead.mockReset();
  secureRead.mockResolvedValue({
    body: Buffer.from(bytes),
    physicalPath: '/physical-vault/.ailu/generated-images/conversation/image.png',
  });
  const verifyTarget = vi.mocked(verifyVaultNewFileTarget);
  verifyTarget.mockReset();
  verifyTarget.mockResolvedValue({ physicalPath: `/physical-vault/${attachmentPath}` });
  const getAvailablePathForAttachment = vi.fn(async () => attachmentPath);
  const createBinary = vi.fn(async () => created);
  const generateMarkdownLink = vi.fn(() => options.link ?? '[[assets/image.png]]');
  const frontmatter: Record<string, unknown> = { ...options.frontmatter };
  const processFrontMatter = vi.fn(async (
    _note: TFile,
    update: (value: Record<string, unknown>) => void,
  ) => {
    if (options.processFrontMatterError) throw options.processFrontMatterError;
    update(frontmatter);
  });
  return {
    app: {
      vault: { adapter: {}, createBinary },
      fileManager: { getAvailablePathForAttachment, generateMarkdownLink, processFrontMatter },
    } as unknown as App,
    secureRead,
    verifyTarget,
    getAvailablePathForAttachment,
    createBinary,
    generateMarkdownLink,
    processFrontMatter,
    frontmatter,
  };
}

describe('Ailu generated image drag payload', () => {
  test('writes only the internal artifact reference and never includes the revised prompt', () => {
    const { transfer, setData } = dragTransfer();

    expect(writeGeneratedImageDragPayload(transfer, artifact())).toBe(true);
    expect(transfer.effectAllowed).toBe('copy');
    const raw = setData.mock.calls[0]?.[1] ?? '';
    expect(setData.mock.calls[0]?.[0]).toBe(AILU_GENERATED_IMAGE_DRAG_TYPE);
    expect(raw).not.toContain('internal revised prompt');
    expect(readGeneratedImageDragPayload(transfer)).toEqual({
      version: 1,
      vaultPath: '.ailu/generated-images/conversation/image.png',
      mimeType: 'image/png',
    });
  });

  test.each([
    '../image.png',
    '.ailu/generated-images/../secret.png',
    'attachments/user.png',
    '/.ailu/generated-images/conversation/image.png',
  ])('rejects an unsafe or non-generated source path: %s', vaultPath => {
    const { transfer } = dragTransfer();
    expect(writeGeneratedImageDragPayload(transfer, artifact({ vaultPath }))).toBe(false);
  });

  test('rejects pre-Ailu generated-image paths', () => {
    const { transfer } = dragTransfer();
    expect(writeGeneratedImageDragPayload(transfer, artifact({
      vaultPath: '.retired-plugin/generated-images/conversation/image.png',
    }))).toBe(false);
  });
});

describe('Ailu generated image note import', () => {
  test('uses Obsidian attachment and link preferences, then inserts an image embed at the drop cursor', async () => {
    const fixture = appFixture({
      attachmentPath: '示例项目/知识库/附件/image.png',
      link: '[[附件/image.png]]',
    });
    const targetEditor = editor();
    const note = {
      path: '示例项目/知识库/Ailu.md',
      extension: 'md',
    } as TFile;
    const cursor = { line: 2, ch: 4 };

    const result = await importGeneratedImageIntoNote(
      fixture.app,
      targetEditor,
      note,
      cursor,
      { version: 1, vaultPath: artifact().vaultPath, mimeType: 'image/png' },
    );

    expect(fixture.getAvailablePathForAttachment).toHaveBeenCalledWith('image.png', note.path);
    expect(fixture.verifyTarget).toHaveBeenCalledWith(fixture.app, result.attachmentPath);
    expect(fixture.createBinary).toHaveBeenCalledWith(result.attachmentPath, pngBytes);
    expect(fixture.generateMarkdownLink).toHaveBeenCalledWith(
      expect.objectContaining({ path: result.attachmentPath }),
      note.path,
    );
    expect(targetEditor.replaceRange).toHaveBeenCalledWith('![[附件/image.png]]', cursor);
    expect(targetEditor.setCursor).toHaveBeenCalled();
    expect(targetEditor.focus).toHaveBeenCalled();
    expect(result.markdown).toBe('![[附件/image.png]]');
  });

  test('fails closed before creating an attachment when the bytes do not match the declared image type', async () => {
    const fixture = appFixture({ bytes: Uint8Array.from([1, 2, 3, 4]).buffer });

    await expect(importGeneratedImageIntoNote(
      fixture.app,
      editor(),
      { path: 'note.md', extension: 'md' } as TFile,
      { line: 0, ch: 0 },
      { version: 1, vaultPath: artifact().vaultPath, mimeType: 'image/png' },
    )).rejects.toThrow('格式校验失败');
    expect(fixture.createBinary).not.toHaveBeenCalled();
  });

  test('fails closed when the generated source crosses a symlink boundary', async () => {
    const fixture = appFixture();
    fixture.secureRead
      .mockResolvedValueOnce({ body: Buffer.from('target note'), physicalPath: '/physical-vault/note.md' })
      .mockRejectedValueOnce(new Error('文件路径不得经过符号链接。'));

    await expect(importGeneratedImageIntoNote(
      fixture.app,
      editor(),
      { path: 'note.md', extension: 'md' } as TFile,
      { line: 0, ch: 0 },
      { version: 1, vaultPath: artifact().vaultPath, mimeType: 'image/png' },
    )).rejects.toThrow('符号链接');
    expect(fixture.createBinary).not.toHaveBeenCalled();
  });

  test('fails closed when the target note crosses a symlink boundary', async () => {
    const fixture = appFixture();
    fixture.secureRead.mockRejectedValueOnce(new Error('文件路径不得经过符号链接。'));

    await expect(importGeneratedImageIntoNote(
      fixture.app,
      editor(),
      { path: 'linked-note.md', extension: 'md' } as TFile,
      { line: 0, ch: 0 },
      { version: 1, vaultPath: artifact().vaultPath, mimeType: 'image/png' },
    )).rejects.toThrow('目标笔记');
    expect(fixture.createBinary).not.toHaveBeenCalled();
  });

  test('verifies the physical attachment parent before staging bytes', async () => {
    const fixture = appFixture();
    fixture.verifyTarget.mockRejectedValue(new Error('附件路径不得经过符号链接。'));

    await expect(importGeneratedImageIntoNote(
      fixture.app,
      editor(),
      { path: 'note.md', extension: 'md' } as TFile,
      { line: 0, ch: 0 },
      { version: 1, vaultPath: artifact().vaultPath, mimeType: 'image/png' },
    )).rejects.toThrow('附件保存失败');
    expect(fixture.createBinary).not.toHaveBeenCalled();
  });

  test('serializes fast drops so attachment-path allocation cannot race', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>(resolve => {
      releaseFirstRead = resolve;
    });
    const fixture = appFixture();
    fixture.secureRead.mockImplementation(async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (fixture.secureRead.mock.calls.length === 1) await firstReadGate;
      activeReads -= 1;
      return {
        body: Buffer.from(pngBytes),
        physicalPath: '/physical-vault/.ailu/generated-images/conversation/image.png',
      };
    });
    const successes = vi.fn();
    const failures = vi.fn();
    const controller = new GeneratedImageDropController({
      app: fixture.app,
      onSuccess: successes,
      onError: failures,
    });
    const { transfer } = dragTransfer();
    writeGeneratedImageDragPayload(transfer, artifact());
    const note = { path: 'note.md', extension: 'md' } as TFile;
    const info = { file: note } as MarkdownFileInfo;
    const makeEvent = () => ({
      defaultPrevented: false,
      dataTransfer: transfer,
      preventDefault: vi.fn(),
    }) as unknown as DragEvent;

    expect(controller.handleEditorDrop(makeEvent(), editor(), info)).toBe(true);
    expect(controller.handleEditorDrop(makeEvent(), editor(), info)).toBe(true);
    await vi.waitFor(() => expect(fixture.secureRead).toHaveBeenCalledTimes(1));
    releaseFirstRead();
    await controller.shutdown();

    expect(maxActiveReads).toBe(1);
    expect(successes).toHaveBeenCalledTimes(2);
    expect(failures).not.toHaveBeenCalled();
  });
});

describe('Ailu generated image cover assignment', () => {
  test.each([
    ['wechat', 'wechat_cover', 'x_cover'],
    ['x', 'x_cover', 'wechat_cover'],
  ] as const)('copies through Obsidian attachment rules and writes only the %s cover property', async (
    kind,
    property,
    otherProperty,
  ) => {
    const fixture = appFixture({
      attachmentPath: '附件/generated-cover.png',
      frontmatter: {
        [property]: '附件/old-cover.png',
        [otherProperty]: '附件/other-platform-cover.png',
      },
    });
    const note = {
      path: '文章/目标文章.md',
      extension: 'md',
    } as TFile;

    const result = await assignGeneratedImageAsCover(fixture.app, note, artifact(), kind);

    expect(fixture.getAvailablePathForAttachment).toHaveBeenCalledWith('image.png', note.path);
    expect(fixture.createBinary).toHaveBeenCalledWith('附件/generated-cover.png', pngBytes);
    expect(fixture.processFrontMatter).toHaveBeenCalledWith(note, expect.any(Function));
    expect(fixture.frontmatter).toEqual({
      [property]: '附件/generated-cover.png',
      [otherProperty]: '附件/other-platform-cover.png',
    });
    expect(fixture.generateMarkdownLink).not.toHaveBeenCalled();
    expect(result).toEqual({
      attachmentPath: '附件/generated-cover.png',
      notePath: note.path,
      property,
    });
  });

  test('keeps the copied attachment and reports its path when frontmatter writing fails', async () => {
    const fixture = appFixture({
      attachmentPath: '附件/orphaned-cover.png',
      processFrontMatterError: new Error('frontmatter unavailable'),
    });
    const note = { path: '文章/目标文章.md', extension: 'md' } as TFile;

    let failure: unknown;
    try {
      await assignGeneratedImageAsCover(fixture.app, note, artifact(), 'wechat');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GeneratedImageDropError);
    if (!(failure instanceof GeneratedImageDropError)) throw failure;
    expect(failure.message).toContain('封面属性写入失败');
    expect(failure.attachmentPath).toBe('附件/orphaned-cover.png');
    expect(fixture.createBinary).toHaveBeenCalledOnce();
  });
});
