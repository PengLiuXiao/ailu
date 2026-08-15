import { promises as dns } from 'node:dns';
import fsp from 'node:fs/promises';
import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  clearInterval as cancelInterval,
  clearTimeout as cancelTimeout,
  setInterval as scheduleInterval,
  setTimeout as scheduleTimeout,
} from 'node:timers';

import {
  consumeAssetBudget,
  fetchRemoteImageBytes,
  isPublicNetworkAddress,
  readRegularFileBeneath,
  verifyNewRegularFileTargetBeneath,
  validateRemoteImageUrl,
} from '../src/utils/secureAssets';

describe('secure asset boundaries', () => {
  const ownedDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(ownedDirectories.splice(0).map(directory => (
      fsp.rm(directory, { recursive: true, force: true })
    )));
  });

  test.each([
    '127.0.0.1',
    '10.0.0.8',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  test.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicNetworkAddress(address)).toBe(true);
    },
  );

  test('allows only credential-free public HTTPS image URLs on port 443', () => {
    expect(validateRemoteImageUrl('https://cdn.example.com/path/image.png').hostname)
      .toBe('cdn.example.com');
    for (const source of [
      'http://cdn.example.com/image.png',
      'https://127.0.0.1/image.png',
      'https://metadata.internal/image.png',
      'https://user:secret@cdn.example.com/image.png',
      'https://cdn.example.com:8443/image.png',
    ]) {
      expect(() => validateRemoteImageUrl(source)).toThrow();
    }
    expect(validateRemoteImageUrl('https://cdn.example.com/image.png?width=1200#preview').toString())
      .toBe('https://cdn.example.com/image.png?width=1200');
  });

  test('reads a regular file beneath the physical Vault root', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-secure-vault-'));
    ownedDirectories.push(vault);
    await fsp.mkdir(path.join(vault, 'assets'));
    await fsp.writeFile(path.join(vault, 'assets', 'image.png'), 'safe-image');

    await expect(readRegularFileBeneath(vault, 'assets/image.png'))
      .resolves.toEqual(Buffer.from('safe-image'));
  });

  test('rejects lexical escape, symlink files, and oversized files', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-secure-vault-'));
    ownedDirectories.push(parent);
    const vault = path.join(parent, 'vault');
    await fsp.mkdir(vault);
    const outside = path.join(parent, 'outside.png');
    await fsp.writeFile(outside, 'outside-secret');
    await fsp.symlink(outside, path.join(vault, 'linked.png'));
    await fsp.writeFile(path.join(vault, 'large.png'), Buffer.alloc(9));

    await expect(readRegularFileBeneath(vault, '../outside.png')).rejects.toThrow('超出');
    await expect(readRegularFileBeneath(vault, 'linked.png')).rejects.toThrow('符号链接');
    await expect(readRegularFileBeneath(vault, 'large.png', 8)).rejects.toThrow('超过');
  });

  test('rejects a symlinked ancestor without touching the outside sentinel', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-secure-vault-'));
    ownedDirectories.push(parent);
    const vault = path.join(parent, 'vault');
    const outside = path.join(parent, 'outside');
    await fsp.mkdir(vault);
    await fsp.mkdir(outside);
    const sentinel = path.join(outside, 'sentinel.png');
    await fsp.writeFile(sentinel, 'outside-sentinel');
    await fsp.symlink(outside, path.join(vault, 'assets'));

    await expect(readRegularFileBeneath(vault, 'assets/sentinel.png'))
      .rejects.toThrow('符号链接');
    await expect(verifyNewRegularFileTargetBeneath(vault, 'assets/new.png'))
      .rejects.toThrow('符号链接');
    await expect(fsp.readFile(sentinel, 'utf8')).resolves.toBe('outside-sentinel');
  });

  test('accepts only a new-file target under real Vault directories', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-secure-vault-'));
    ownedDirectories.push(vault);
    await fsp.mkdir(path.join(vault, 'assets'));
    const physicalVault = await fsp.realpath(vault);

    await expect(verifyNewRegularFileTargetBeneath(vault, 'assets/new.png'))
      .resolves.toEqual({ physicalPath: path.join(physicalVault, 'assets', 'new.png') });
    await fsp.writeFile(path.join(vault, 'assets', 'existing.png'), 'existing');
    await expect(verifyNewRegularFileTargetBeneath(vault, 'assets/existing.png'))
      .rejects.toThrow('已存在');
  });

  test('rejects a target replaced after the no-follow descriptor was read', async () => {
    const vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'ailu-secure-vault-'));
    ownedDirectories.push(vault);
    const target = path.join(vault, 'note.md');
    const original = path.join(vault, 'note-original.md');
    await fsp.writeFile(target, 'verified-original');
    const originalOpen = fsp.open.bind(fsp);
    let replaced = false;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      return {
        stat: handle.stat.bind(handle),
        readFile: async (...readArgs: Parameters<typeof handle.readFile>) => {
          const body = await handle.readFile(...readArgs);
          if (!replaced) {
            replaced = true;
            await fsp.rename(target, original);
            await fsp.writeFile(target, 'replacement');
          }
          return body;
        },
        close: handle.close.bind(handle),
      } as typeof handle;
    });

    try {
      await expect(readRegularFileBeneath(vault, 'note.md')).rejects.toThrow('发生了变化');
    } finally {
      openSpy.mockRestore();
    }
    await expect(fsp.readFile(original, 'utf8')).resolves.toBe('verified-original');
    await expect(fsp.readFile(target, 'utf8')).resolves.toBe('replacement');
  });

  test('enforces image count and aggregate byte budgets before mutation', () => {
    const countBudget = { count: 1, bytes: 1, maxCount: 1, maxBytes: 10 };
    expect(() => consumeAssetBudget(countBudget, 1)).toThrow('图片超过');
    expect(countBudget).toEqual({ count: 1, bytes: 1, maxCount: 1, maxBytes: 10 });

    const byteBudget = { count: 0, bytes: 9, maxCount: 2, maxBytes: 10 };
    expect(() => consumeAssetBudget(byteBudget, 2)).toThrow('总大小');
    expect(byteBudget).toEqual({ count: 0, bytes: 9, maxCount: 2, maxBytes: 10 });
  });

  test('applies one absolute deadline across a redirect and slow-drip body, then closes the stream', async () => {
    let responseClosed = false;
    const server = http.createServer((request, response) => {
      if (request.url === '/start.png') {
        const redirectTimer = scheduleTimeout(() => {
          response.writeHead(302, { Location: 'https://cdn.example.com/slow.png' });
          response.end();
        }, 60);
        response.once('close', () => cancelTimeout(redirectTimer));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Transfer-Encoding': 'chunked',
      });
      let sent = 0;
      const pngPrefix = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const interval = scheduleInterval(() => {
        if (response.destroyed) {
          cancelInterval(interval);
          return;
        }
        response.write(sent < pngPrefix.length ? pngPrefix.subarray(sent, sent + 1) : Buffer.from([0]));
        sent += 1;
        if (sent >= 40) {
          cancelInterval(interval);
          response.end();
        }
      }, 20);
      response.once('close', () => {
        responseClosed = true;
        cancelInterval(interval);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const lookupSpy = vi.spyOn(dns, 'lookup').mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    const requestSpy = vi.spyOn(https, 'request').mockImplementation((
      (url: URL, options: RequestOptions, callback: (response: http.IncomingMessage) => void) => {
        const localUrl = new URL(url.toString());
        localUrl.protocol = 'http:';
        localUrl.hostname = '127.0.0.1';
        localUrl.port = String(address.port);
        return http.request(localUrl, {
          method: options.method,
          headers: options.headers,
          signal: options.signal,
        }, callback);
      }
    ) as typeof https.request);

    try {
      const startedAt = Date.now();
      await expect(fetchRemoteImageBytes('https://cdn.example.com/start.png', {
        maxBytes: 1024,
        timeoutMs: 180,
      })).rejects.toThrow('远程图片请求超时。');
      expect(Date.now() - startedAt).toBeLessThan(500);
      await vi.waitFor(() => expect(responseClosed).toBe(true), { timeout: 500 });
      expect(lookupSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenCalledTimes(2);
    } finally {
      requestSpy.mockRestore();
      lookupSpy.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => (
        error ? reject(error) : resolve()
      )));
    }
  });

  test('includes DNS resolution in the absolute deadline', async () => {
    const lookupSpy = vi.spyOn(dns, 'lookup').mockReturnValue(new Promise(() => undefined) as never);
    try {
      await expect(fetchRemoteImageBytes('https://cdn.example.com/image.png', {
        timeoutMs: 25,
      })).rejects.toThrow('远程图片请求超时。');
    } finally {
      lookupSpy.mockRestore();
    }
  });
});
