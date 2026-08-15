import {
  ImagePreflight,
  MAX_WECHAT_CONTENT_IMAGE_BYTES,
  MAX_WECHAT_COVER_BYTES,
} from '../src/publishing/imagePreflight';
import type { ImageCompressionAdapter, PublishingImageInput } from '../src/publishing/types';
import { onePixelGif, onePixelJpeg, onePixelPng } from './fixtures/imageBytes';

function asset(overrides: Partial<PublishingImageInput> = {}): PublishingImageInput {
  return {
    id: 'asset-1',
    fileName: 'source.png',
    mimeType: 'image/png',
    body: onePixelPng(),
    references: ['blob:source'],
    ...overrides,
  };
}

describe('ImagePreflight', () => {
  test('keeps a compliant PNG byte-for-byte', async () => {
    const result = await new ImagePreflight().prepareContent(asset());
    expect(result).toMatchObject({
      mimeType: 'image/png',
      compressed: false,
      originalBytes: onePixelPng().byteLength,
      outputBytes: onePixelPng().byteLength,
      placeholder: 'ailu-prepared-image://asset-1',
    });
    expect([...new Uint8Array(result.body)]).toEqual([...new Uint8Array(onePixelPng())]);
  });

  test('fully compresses an oversized image during local preflight', async () => {
    const compressToJpeg: ImageCompressionAdapter['compressToJpeg'] = vi.fn(async () => ({
      body: onePixelJpeg(),
      mimeType: 'image/jpeg' as const,
      extension: 'jpg' as const,
    }));
    const compression: ImageCompressionAdapter = {
      compressToJpeg,
    };
    const oversized = new Uint8Array(MAX_WECHAT_CONTENT_IMAGE_BYTES + 1);
    oversized.set(new Uint8Array(onePixelPng()));
    const input = asset({ body: oversized.buffer });
    const result = await new ImagePreflight(compression).prepareContent(input);
    expect(compressToJpeg).toHaveBeenCalledWith(input, MAX_WECHAT_CONTENT_IMAGE_BYTES);
    expect(result).toMatchObject({
      fileName: 'source.jpg',
      mimeType: 'image/jpeg',
      compressed: true,
      outputBytes: onePixelJpeg().byteLength,
    });
  });

  test('rejects a compressor that still returns more than 1MB', async () => {
    const compressToJpeg: ImageCompressionAdapter['compressToJpeg'] = vi.fn(async () => ({
      body: new Uint8Array(MAX_WECHAT_CONTENT_IMAGE_BYTES + 1).buffer,
      mimeType: 'image/jpeg' as const,
      extension: 'jpg' as const,
    }));
    const compression: ImageCompressionAdapter = {
      compressToJpeg,
    };
    await expect(new ImagePreflight(compression).prepareContent(asset({
      mimeType: 'image/gif',
      body: onePixelGif(),
    }))).rejects.toThrow('压缩后仍超过 1MB');
  });

  test('rejects an oversized cover locally', async () => {
    const preflight = new ImagePreflight();
    await expect(preflight.prepareCover(asset({
      body: new Uint8Array(MAX_WECHAT_COVER_BYTES + 1).buffer,
    }))).rejects.toThrow('超过 10MB');
  });

  test('rejects truncated images before any relay request can begin', async () => {
    const preflight = new ImagePreflight();
    await expect(preflight.prepareContent(asset({ body: onePixelPng().slice(0, 24) })))
      .rejects.toThrow('文件不完整或格式损坏');
    await expect(preflight.prepareCover(asset({
      fileName: 'cover.jpg',
      mimeType: 'image/jpeg',
      body: onePixelJpeg().slice(0, 48),
    }))).rejects.toThrow('文件不完整或格式损坏');
  });

  test('requires the local browser decoder to accept structurally complete images', async () => {
    class RejectingImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', RejectingImage);
    try {
      await expect(new ImagePreflight().prepareContent(asset()))
        .rejects.toThrow('无法在本机解码');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
