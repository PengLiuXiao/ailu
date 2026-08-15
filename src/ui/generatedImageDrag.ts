import path from 'node:path';

import type {
  App,
  Editor,
  EditorPosition,
  MarkdownFileInfo,
  TFile,
} from 'obsidian';

import { STORAGE_IDS } from '../ids';
import type { ChatImageArtifact } from '../types';
import { exactArrayBuffer } from '../utils/secureAssets';
import { userFacingErrorMessage } from '../utils/userFacingError';
import { readVerifiedVaultFile, verifyVaultNewFileTarget } from '../utils/vault';

export const AILU_GENERATED_IMAGE_DRAG_TYPE = 'application/x-ailu-generated-image+json';

const MAX_DRAG_PAYLOAD_CHARS = 4_096;
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_GENERATED_IMAGE_TARGET_NOTE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const GENERATED_IMAGE_ROOT = STORAGE_IDS.generatedImagesPath;

export interface GeneratedImageDragPayload {
  version: 1;
  vaultPath: string;
  mimeType: string;
}

export interface GeneratedImageDropResult {
  attachmentPath: string;
  markdown: string;
}

export type GeneratedImageCoverKind = 'wechat' | 'x';

export interface GeneratedImageCoverResult {
  attachmentPath: string;
  notePath: string;
  property: 'wechat_cover' | 'x_cover';
}

export interface GeneratedImageBytes {
  bytes: ArrayBuffer;
  mimeType: string;
}

export class GeneratedImageDropError extends Error {
  constructor(message: string, readonly attachmentPath: string | null = null) {
    super(message);
    this.name = 'GeneratedImageDropError';
  }
}

interface GeneratedImageDropControllerOptions {
  app: App;
  onSuccess?: (result: GeneratedImageDropResult) => void;
  onError?: (error: unknown) => void;
}

let generatedImageMutationTail: Promise<void> = Promise.resolve();

function serializeGeneratedImageMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = generatedImageMutationTail.then(operation, operation);
  generatedImageMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Serializes generated-image imports so two fast drops can never choose the
 * same attachment path before either file has been created.
 */
export class GeneratedImageDropController {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  constructor(private readonly options: GeneratedImageDropControllerOptions) {}

  handleEditorDrop(
    event: DragEvent,
    editor: Editor,
    info: MarkdownFileInfo,
  ): boolean {
    if (!this.accepting || event.defaultPrevented) return false;
    const payload = readGeneratedImageDragPayload(event.dataTransfer);
    if (!payload) return false;

    event.preventDefault();
    const note = info.file;
    if (!note || note.extension !== 'md') {
      this.options.onError?.(new GeneratedImageDropError('请把图片拖到已保存的 Markdown 笔记中。'));
      return true;
    }
    const cursor = editor.getCursor();
    const operation = this.tail.then(async () => {
      const result = await importGeneratedImageIntoNote(
        this.options.app,
        editor,
        note,
        cursor,
        payload,
      );
      this.options.onSuccess?.(result);
    });
    this.tail = operation.catch(error => {
      this.options.onError?.(error);
    });
    return true;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }
}

export function writeGeneratedImageDragPayload(
  dataTransfer: DataTransfer,
  artifact: ChatImageArtifact,
): boolean {
  const payload = generatedImageDragPayload(artifact);
  if (!payload) return false;
  dataTransfer.effectAllowed = 'copy';
  dataTransfer.setData(AILU_GENERATED_IMAGE_DRAG_TYPE, JSON.stringify(payload));
  return true;
}

export function generatedImageDragPayload(
  artifact: ChatImageArtifact,
): GeneratedImageDragPayload | null {
  return normalizeGeneratedImagePayload({
    version: 1,
    vaultPath: artifact.vaultPath,
    mimeType: artifact.mimeType,
  });
}

export function readGeneratedImageDragPayload(
  dataTransfer: Pick<DataTransfer, 'getData'> | null,
): GeneratedImageDragPayload | null {
  if (!dataTransfer) return null;
  let raw = '';
  try {
    raw = dataTransfer.getData(AILU_GENERATED_IMAGE_DRAG_TYPE);
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_DRAG_PAYLOAD_CHARS) return null;
  try {
    return normalizeGeneratedImagePayload(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export async function importGeneratedImageIntoNote(
  app: App,
  editor: Editor,
  note: TFile,
  cursor: EditorPosition,
  payload: GeneratedImageDragPayload,
): Promise<GeneratedImageDropResult> {
  return serializeGeneratedImageMutation(async () => {
    const attachment = await createGeneratedImageAttachment(app, note, payload);
    try {
      const link = app.fileManager.generateMarkdownLink(attachment, note.path);
      if (!link.trim()) throw new Error('Obsidian 未生成附件链接。');
      const markdown = link.startsWith('!') ? link : `!${link}`;
      editor.replaceRange(markdown, cursor);
      const insertedAt = editor.posToOffset(cursor);
      editor.setCursor(editor.offsetToPos(insertedAt + markdown.length));
      editor.focus();
      return { attachmentPath: attachment.path, markdown };
    } catch (error) {
      throw new GeneratedImageDropError(
        `图片已保存到 ${attachment.path}，但链接插入失败：${errorMessage(error)}`,
        attachment.path,
      );
    }
  });
}

export async function assignGeneratedImageAsCover(
  app: App,
  note: TFile,
  artifact: ChatImageArtifact,
  kind: GeneratedImageCoverKind,
): Promise<GeneratedImageCoverResult> {
  if (note.extension !== 'md') {
    throw new GeneratedImageDropError('请先打开要设置封面的 Markdown 文章。');
  }
  const payload = generatedImageDragPayload(artifact);
  if (!payload) throw new GeneratedImageDropError('这张图片的来源信息无效，未设置封面。');
  const property = kind === 'wechat' ? 'wechat_cover' : 'x_cover';
  return serializeGeneratedImageMutation(async () => {
    const attachment = await createGeneratedImageAttachment(app, note, payload);
    try {
      await app.fileManager.processFrontMatter(note, frontmatter => {
        const metadata = frontmatter as Record<string, unknown>;
        metadata[property] = attachment.path;
      });
    } catch (error) {
      throw new GeneratedImageDropError(
        `图片已保存到 ${attachment.path}，但封面属性写入失败：${errorMessage(error)}`,
        attachment.path,
      );
    }
    return {
      attachmentPath: attachment.path,
      notePath: note.path,
      property,
    };
  });
}

export async function readGeneratedImageArtifact(
  app: App,
  artifact: ChatImageArtifact,
): Promise<GeneratedImageBytes> {
  const payload = generatedImageDragPayload(artifact);
  if (!payload) throw new GeneratedImageDropError('这张图片的来源信息无效，无法复制。');
  return readValidatedGeneratedImage(app, payload);
}

async function createGeneratedImageAttachment(
  app: App,
  note: TFile,
  payload: GeneratedImageDragPayload,
): Promise<TFile> {
  try {
    await readVerifiedVaultFile(app, note, MAX_GENERATED_IMAGE_TARGET_NOTE_BYTES, true);
  } catch (error) {
    throw new GeneratedImageDropError(
      `无法安全验证目标笔记：${errorMessage(error)}`,
    );
  }
  const image = await readValidatedGeneratedImage(app, payload);
  const normalized = normalizeGeneratedImagePayload(payload);
  if (!normalized) throw new GeneratedImageDropError('这张图片的来源信息无效，无法使用。');
  const filename = attachmentFilename(normalized.vaultPath, image.mimeType);
  const attachmentPath = await app.fileManager.getAvailablePathForAttachment(filename, note.path);
  try {
    await verifyVaultNewFileTarget(app, attachmentPath);
    return await app.vault.createBinary(attachmentPath, image.bytes);
  } catch (error) {
    throw new GeneratedImageDropError(
      `图片附件保存失败：${errorMessage(error)}`,
      null,
    );
  }
}

async function readValidatedGeneratedImage(
  app: App,
  payload: GeneratedImageDragPayload,
): Promise<GeneratedImageBytes> {
  const normalized = normalizeGeneratedImagePayload(payload);
  if (!normalized) throw new GeneratedImageDropError('这张图片的来源信息无效，未写入笔记。');

  let bytes: ArrayBuffer;
  try {
    const verified = await readVerifiedVaultFile(
      app,
      { path: normalized.vaultPath },
      MAX_GENERATED_IMAGE_BYTES,
    );
    bytes = exactArrayBuffer(verified.body);
  } catch (error) {
    throw new GeneratedImageDropError(
      `无法安全读取这张生成图片：${errorMessage(error)}`,
    );
  }
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new GeneratedImageDropError('生成图片为空或超过 25 MB，无法使用。');
  }
  const detectedMimeType = detectImageMimeType(new Uint8Array(bytes));
  if (!detectedMimeType || detectedMimeType !== normalized.mimeType) {
    throw new GeneratedImageDropError('生成图片的格式校验失败，无法使用。');
  }
  return { bytes, mimeType: detectedMimeType };
}

function normalizeGeneratedImagePayload(value: unknown): GeneratedImageDragPayload | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (typeof value.vaultPath !== 'string' || typeof value.mimeType !== 'string') return null;
  const vaultPath = value.vaultPath;
  const mimeType = value.mimeType.toLowerCase();
  if (!isAllowedGeneratedImagePath(vaultPath) || !ALLOWED_MIME_TYPES.has(mimeType)) return null;
  if (!extensionMatchesMimeType(vaultPath, mimeType)) return null;
  return { version: 1, vaultPath, mimeType };
}

function isAllowedGeneratedImagePath(vaultPath: string): boolean {
  if (!vaultPath || vaultPath.length > 1_024 || vaultPath.includes('\\') || vaultPath.includes('\0')) {
    return false;
  }
  if (vaultPath.startsWith('/') || path.posix.normalize(vaultPath) !== vaultPath) return false;
  const segments = vaultPath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  return vaultPath.startsWith(`${GENERATED_IMAGE_ROOT}/`);
}

function extensionMatchesMimeType(vaultPath: string, mimeType: string): boolean {
  const extension = path.posix.extname(vaultPath).toLowerCase();
  if (mimeType === 'image/png') return extension === '.png';
  if (mimeType === 'image/jpeg') return extension === '.jpg' || extension === '.jpeg';
  if (mimeType === 'image/webp') return extension === '.webp';
  return false;
}

function attachmentFilename(vaultPath: string, mimeType: string): string {
  const basename = path.posix.basename(vaultPath);
  const currentExtension = path.posix.extname(basename);
  const stem = basename.slice(0, Math.max(0, basename.length - currentExtension.length)).trim()
    || 'Ailu-image';
  const extension = mimeType === 'image/png' ? '.png'
    : mimeType === 'image/jpeg' ? '.jpg'
      : '.webp';
  return `${stem}${extension}`;
}

function detectImageMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return userFacingErrorMessage(error, '图片操作失败，请稍后重试。');
}
