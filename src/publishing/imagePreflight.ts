import { createHash } from 'crypto';

import {
  PREPARED_IMAGE_SCHEME,
  type ImageCompressionAdapter,
  type ImageCompressionResult,
  type PreparedCoverImage,
  type PreparedPublishingImage,
  type PublishingImageInput,
} from './types';

export const MAX_WECHAT_COVER_BYTES = 10 * 1024 * 1024;
export const MAX_WECHAT_CONTENT_IMAGE_BYTES = 1024 * 1024;

const CONTENT_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const COVER_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/bmp']);

function hashBody(body: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

function normalizedMimeType(input: PublishingImageInput): string {
  const bytes = new Uint8Array(input.body);
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === 'GIF') return 'image/gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const declared = input.mimeType.trim().toLowerCase();
  return declared === 'image/jpg' ? 'image/jpeg' : declared;
}

function jpegFileName(fileName: string): string {
  return /\.[a-z0-9]+$/i.test(fileName)
    ? fileName.replace(/\.[a-z0-9]+$/i, '.jpg')
    : `${fileName || 'image'}.jpg`;
}

function cloneBody(body: ArrayBuffer): ArrayBuffer {
  return body.slice(0);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function hasCompletePngStructure(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let sawHeader = false;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (next > bytes.length) return false;
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      sawHeader = true;
    }
    if (type === 'IEND') return length === 0;
    offset = next;
  }
  return false;
}

function hasCompleteJpegStructure(bytes: Uint8Array): boolean {
  if (
    bytes.length < 32
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[bytes.length - 2] !== 0xff
    || bytes[bytes.length - 1] !== 0xd9
  ) return false;
  let sawFrame = false;
  let sawScan = false;
  for (let index = 2; index + 1 < bytes.length; index += 1) {
    if (bytes[index] !== 0xff) continue;
    const marker = bytes[index + 1];
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) sawFrame = true;
    if (marker === 0xda) sawScan = true;
  }
  return sawFrame && sawScan;
}

function hasCompleteGifStructure(bytes: Uint8Array): boolean {
  return bytes.length >= 14
    && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))
    && bytes[bytes.length - 1] === 0x3b;
}

function hasCompleteBmpStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 54 || ascii(bytes, 0, 2) !== 'BM') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredSize = view.getUint32(2, true);
  const pixelOffset = view.getUint32(10, true);
  return declaredSize <= bytes.length && pixelOffset >= 14 && pixelOffset < bytes.length;
}

function assertCompleteImageStructure(input: PublishingImageInput, mimeType: string): void {
  const bytes = new Uint8Array(input.body);
  const valid = mimeType === 'image/png'
    ? hasCompletePngStructure(bytes)
    : mimeType === 'image/jpeg'
      ? hasCompleteJpegStructure(bytes)
      : mimeType === 'image/gif'
        ? hasCompleteGifStructure(bytes)
        : mimeType === 'image/bmp'
          ? hasCompleteBmpStructure(bytes)
          : false;
  if (!valid) throw new Error(`图片“${input.fileName}”文件不完整或格式损坏`);
}

async function assertImageDecodes(input: PublishingImageInput, mimeType: string): Promise<void> {
  assertCompleteImageStructure(input, mimeType);
  if (
    typeof Image === 'undefined'
    || typeof URL === 'undefined'
    || typeof URL.createObjectURL !== 'function'
    || typeof Blob === 'undefined'
  ) return;
  try {
    await loadBrowserImage(new Blob([input.body], { type: mimeType }));
  } catch {
    throw new Error(`图片“${input.fileName}”无法在本机解码，文件可能已损坏`);
  }
}

function loadBrowserImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const image = new Image();
    const release = (): void => URL.revokeObjectURL(url);
    image.onload = () => {
      release();
      resolve(image);
    };
    image.onerror = () => {
      release();
      reject(new Error('图片解码失败'));
    };
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('图片压缩失败')),
      'image/jpeg',
      quality,
    );
  });
}

export class BrowserJpegCompressionAdapter implements ImageCompressionAdapter {
  async compressToJpeg(
    input: PublishingImageInput,
    maximumBytes: number,
  ): Promise<ImageCompressionResult> {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
      throw new Error('当前环境无法在本地压缩图片');
    }
    const image = await loadBrowserImage(new Blob([input.body], { type: normalizedMimeType(input) }));
    let width = image.naturalWidth || image.width;
    let height = image.naturalHeight || image.height;
    const initialScale = Math.min(1, 1600 / Math.max(width, height));
    width = Math.max(1, Math.round(width * initialScale));
    height = Math.max(1, Math.round(height * initialScale));
    let quality = 0.88;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('图片压缩失败');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const compressed = await canvasToJpeg(canvas, quality);
      if (compressed.size <= maximumBytes) {
        return {
          body: await compressed.arrayBuffer(),
          mimeType: 'image/jpeg',
          extension: 'jpg',
        };
      }
      if (quality > 0.56) quality -= 0.08;
      else {
        width = Math.max(1, Math.round(width * 0.85));
        height = Math.max(1, Math.round(height * 0.85));
      }
    }
    throw new Error('图片压缩后仍超过 1MB');
  }
}

export class ImagePreflight {
  constructor(
    private readonly compression: ImageCompressionAdapter = new BrowserJpegCompressionAdapter(),
  ) {}

  async prepareCover(input: PublishingImageInput): Promise<PreparedCoverImage> {
    if (!input.body.byteLength) throw new Error(`封面图片“${input.fileName}”为空`);
    const mimeType = normalizedMimeType(input);
    if (!COVER_MIME_TYPES.has(mimeType)) {
      throw new Error(`封面图片“${input.fileName}”仅支持 JPG、PNG、GIF、BMP`);
    }
    if (input.body.byteLength > MAX_WECHAT_COVER_BYTES) {
      throw new Error(`封面图片“${input.fileName}”超过 10MB`);
    }
    await assertImageDecodes(input, mimeType);
    const body = cloneBody(input.body);
    return {
      id: input.id,
      fileName: input.fileName,
      mimeType,
      body,
      contentHash: hashBody(body),
      originalBytes: input.body.byteLength,
    };
  }

  async prepareContent(input: PublishingImageInput): Promise<PreparedPublishingImage> {
    if (!input.body.byteLength) throw new Error(`正文图片“${input.fileName}”为空`);
    const mimeType = normalizedMimeType(input);
    let body: ArrayBuffer;
    let outputMimeType: 'image/jpeg' | 'image/png';
    let outputName = input.fileName;
    let compressed = false;

    if (!CONTENT_MIME_TYPES.has(mimeType) && !COVER_MIME_TYPES.has(mimeType)) {
      throw new Error(`正文图片“${input.fileName}”格式不受支持`);
    }
    await assertImageDecodes(input, mimeType);

    if (CONTENT_MIME_TYPES.has(mimeType) && input.body.byteLength <= MAX_WECHAT_CONTENT_IMAGE_BYTES) {
      body = cloneBody(input.body);
      outputMimeType = mimeType as 'image/jpeg' | 'image/png';
    } else {
      const result = await this.compression.compressToJpeg(input, MAX_WECHAT_CONTENT_IMAGE_BYTES);
      if (!result.body.byteLength || result.body.byteLength > MAX_WECHAT_CONTENT_IMAGE_BYTES) {
        throw new Error(`正文图片“${input.fileName}”压缩后仍超过 1MB`);
      }
      body = cloneBody(result.body);
      outputMimeType = result.mimeType;
      outputName = jpegFileName(input.fileName);
      compressed = true;
      await assertImageDecodes({
        ...input,
        fileName: outputName,
        mimeType: result.mimeType,
        body: result.body,
      }, result.mimeType);
    }

    return {
      id: input.id,
      fileName: outputName,
      mimeType: outputMimeType,
      body,
      contentHash: hashBody(body),
      placeholder: `${PREPARED_IMAGE_SCHEME}${encodeURIComponent(input.id)}`,
      originalBytes: input.body.byteLength,
      outputBytes: body.byteLength,
      compressed,
    };
  }
}
