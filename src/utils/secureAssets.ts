import { promises as dns } from 'node:dns';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import net, { type LookupFunction } from 'node:net';
import path from 'node:path';
import {
  clearTimeout as cancelTimeout,
  setTimeout as scheduleTimeout,
} from 'node:timers';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ARTICLE_IMAGES = 25;
export const MAX_ARTICLE_IMAGE_BYTES = 100 * 1024 * 1024;

export interface AssetBudget {
  count: number;
  bytes: number;
  maxCount?: number;
  maxBytes?: number;
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function consumeAssetBudget(budget: AssetBudget, byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('图片内容为空或长度无效。');
  }
  const nextCount = budget.count + 1;
  const nextBytes = budget.bytes + byteLength;
  if (nextCount > (budget.maxCount ?? MAX_ARTICLE_IMAGES)) {
    throw new Error(`正文图片超过 ${budget.maxCount ?? MAX_ARTICLE_IMAGES} 张限制。`);
  }
  if (nextBytes > (budget.maxBytes ?? MAX_ARTICLE_IMAGE_BYTES)) {
    throw new Error('正文图片总大小超过 100 MB 限制。');
  }
  budget.count = nextCount;
  budget.bytes = nextBytes;
}

function insideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export interface VerifiedRegularFileRead {
  body: Buffer;
  physicalPath: string;
}

function validateRelativePath(
  rootPath: string,
  relativePath: string,
  label: string,
): { lexicalRoot: string; lexicalTarget: string; relative: string } {
  if (!relativePath.trim() || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error(`${label}路径无效。`);
  }
  const lexicalRoot = path.resolve(rootPath);
  const lexicalTarget = path.resolve(lexicalRoot, relativePath);
  if (!insideRoot(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label}路径超出当前 Vault。`);
  }
  return {
    lexicalRoot,
    lexicalTarget,
    relative: path.relative(lexicalRoot, lexicalTarget),
  };
}

async function assertNoSymlinkComponents(
  physicalRoot: string,
  relativePath: string,
  label: string,
  includeFinal: boolean,
): Promise<void> {
  const components = relativePath.split(path.sep);
  const checked = includeFinal ? components : components.slice(0, -1);
  let cursor = physicalRoot;
  for (const component of checked) {
    cursor = path.join(cursor, component);
    const stat = await fsp.lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label}路径不得经过符号链接。`);
    }
    if (!includeFinal && !stat.isDirectory()) {
      throw new Error(`${label}的父路径不是目录。`);
    }
  }
}

/**
 * Resolves a new-file target beneath the physical Vault root. Every existing
 * parent component must be a real directory, never a symlink, and the final
 * target must not exist. Callers still use the Vault API for the actual write
 * so Obsidian can update its file index.
 */
export async function verifyNewRegularFileTargetBeneath(
  rootPath: string,
  relativePath: string,
): Promise<{ physicalPath: string }> {
  const { lexicalRoot, relative } = validateRelativePath(rootPath, relativePath, '附件');
  const physicalRoot = await fsp.realpath(lexicalRoot);
  await assertNoSymlinkComponents(physicalRoot, relative, '附件', false);
  const target = path.join(physicalRoot, relative);
  try {
    await fsp.lstat(target);
    throw new Error('附件目标路径已存在。');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { physicalPath: target };
}

/**
 * Reads a regular Vault file through a no-follow final descriptor and rejects
 * any physical path that escapes the pinned Vault root. The post-open
 * realpath/inode checks ensure a directory swap cannot turn the returned bytes
 * into an out-of-Vault file.
 */
export async function readRegularFileBeneath(
  rootPath: string,
  relativePath: string,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<Buffer> {
  return (await readVerifiedRegularFileBeneath(rootPath, relativePath, maxBytes, '图片')).body;
}

export async function readVerifiedRegularFileBeneath(
  rootPath: string,
  relativePath: string,
  maxBytes: number,
  label = '文件',
  allowEmpty = false,
): Promise<VerifiedRegularFileRead> {
  const { lexicalRoot, relative } = validateRelativePath(rootPath, relativePath, label);
  const physicalRoot = await fsp.realpath(lexicalRoot);
  const target = path.join(physicalRoot, relative);
  await assertNoSymlinkComponents(physicalRoot, relative, label, true);

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fsp.open(target, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label}路径不是普通文件。`);
    if ((!allowEmpty && opened.size === 0) || opened.size > maxBytes) {
      throw new Error(`${label}为空或超过 ${Math.floor(maxBytes / 1024 / 1024)} MB。`);
    }
    const body = await handle.readFile();
    const currentPath = await fsp.realpath(target);
    if (!insideRoot(physicalRoot, currentPath)) {
      throw new Error(`${label}的物理路径超出当前 Vault。`);
    }
    const current = await fsp.lstat(target);
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error(`${label}路径在读取期间发生了变化。`);
    }
    if (body.byteLength !== opened.size) {
      throw new Error(`${label}在读取期间发生了变化。`);
    }
    return { body, physicalPath: currentPath };
  } finally {
    await handle.close();
  }
}

function ipv4Octets(address: string): number[] | null {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(value => Number(value));
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)
    ? octets
    : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function expandIpv6(address: string): number[] | null {
  const clean = address.toLowerCase().split('%', 1)[0];
  if (net.isIP(clean) !== 6) return null;
  const [headSource, tailSource = ''] = clean.split('::');
  if (clean.split('::').length > 2) return null;
  const parseSide = (source: string): number[] | null => {
    if (!source) return [];
    const pieces = source.split(':');
    const result: number[] = [];
    for (const piece of pieces) {
      if (net.isIP(piece) === 4) {
        const octets = ipv4Octets(piece);
        if (!octets) return null;
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[a-f\d]{1,4}$/.test(piece)) return null;
      result.push(Number.parseInt(piece, 16));
    }
    return result;
  };
  const head = parseSide(headSource);
  const tail = parseSide(tailSource);
  if (!head || !tail) return null;
  if (!clean.includes('::')) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) return null;
  return [...head, ...Array<number>(zeros).fill(0), ...tail];
}

export function isPublicNetworkAddress(address: string): boolean {
  if (net.isIP(address) === 4) return isPublicIpv4(address);
  const groups = expandIpv6(address);
  if (!groups) return false;
  const mappedIpv4 = groups.slice(0, 5).every(value => value === 0) && groups[5] === 0xffff;
  if (mappedIpv4) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return isPublicIpv4(ipv4);
  }
  // Public global-unicast IPv6 currently lives in 2000::/3. Keep the allowlist
  // narrow and explicitly reject the documentation prefix.
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false;
  return true;
}

export function validateRemoteImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('远程图片 URL 格式无效。');
  }
  if (url.protocol !== 'https:') throw new Error('远程图片必须使用 HTTPS。');
  if (url.username || url.password) throw new Error('远程图片 URL 不得包含账号或密码。');
  // URL fragments are never part of the HTTP request. Drop them so redirect
  // and final-URL comparisons operate on the actual network destination while
  // preserving legitimate signed/resizing query parameters used by CDNs.
  url.hash = '';
  if (url.port && url.port !== '443') throw new Error('远程图片只允许 HTTPS 443 端口。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.home.arpa')
  ) {
    throw new Error('远程图片不得访问本机或内部网络。');
  }
  if (net.isIP(hostname) && !isPublicNetworkAddress(hostname)) {
    throw new Error('远程图片不得访问本机或内部网络。');
  }
  return url;
}

const REMOTE_IMAGE_TIMEOUT_MESSAGE = '远程图片请求超时。';

function remoteImageAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(REMOTE_IMAGE_TIMEOUT_MESSAGE);
}

function remoteImageError(error: unknown): Error {
  return error instanceof Error ? error : new Error('远程图片下载失败。');
}

function throwIfRemoteImageRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) throw remoteImageAbortError(signal);
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfRemoteImageRequestAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(remoteImageAbortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(remoteImageError(error))),
    );
    // Close the race between the initial check and listener registration.
    if (signal.aborted) onAbort();
  });
}

async function publicAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly { address: string; family: number }[]> {
  throwIfRemoteImageRequestAborted(signal);
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (!isPublicNetworkAddress(literal)) throw new Error('远程图片地址不是公网地址。');
    return [{ address: literal, family: net.isIP(literal) }];
  }
  const addresses = await awaitWithAbort(
    dns.lookup(literal, { all: true, verbatim: true }),
    signal,
  );
  if (!addresses.length || addresses.length > 16 || addresses.some(entry => !isPublicNetworkAddress(entry.address))) {
    throw new Error('远程图片域名解析到非公网地址。');
  }
  return addresses;
}

async function downloadOnce(url: URL, maxBytes: number, signal: AbortSignal): Promise<{
  body?: Buffer;
  redirect?: string;
}> {
  const addresses = await publicAddresses(url.hostname, signal);
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses.map(entry => ({ address: entry.address, family: entry.family })));
      return;
    }
    const selected = addresses[0];
    callback(null, selected.address, selected.family);
  };

  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;

    const destroyTransport = () => {
      if (response && !response.destroyed) response.destroy();
      if (request && !request.destroyed) request.destroy();
    };
    const resolveOnce = (result: { body?: Buffer; redirect?: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const rejectOnce = (error: Error, destroy = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (destroy) destroyTransport();
      reject(error);
    };
    const onAbort = () => rejectOnce(remoteImageAbortError(signal), true);

    const request = https.request(url, {
      method: 'GET',
      lookup,
      signal,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        'User-Agent': 'Ailu/remote-image-fetch',
      },
    }, (incoming) => {
      // The absolute deadline can win immediately before the response callback.
      // Keep a listener attached while destroying so no late stream error is
      // emitted without a consumer.
      if (settled) {
        incoming.on('error', () => undefined);
        incoming.destroy();
        return;
      }
      response = incoming;
      incoming.on('error', error => rejectOnce(
        signal.aborted ? remoteImageAbortError(signal) : error,
        true,
      ));
      incoming.once('aborted', () => rejectOnce(new Error('远程图片响应意外中断。'), true));

      const status = incoming.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = incoming.headers.location;
        if (!location) {
          rejectOnce(new Error('远程图片重定向缺少目标地址。'), true);
          return;
        }
        let redirect: string;
        try {
          redirect = new URL(location, url).toString();
        } catch {
          rejectOnce(new Error('远程图片重定向目标无效。'), true);
          return;
        }
        resolveOnce({ redirect });
        incoming.destroy();
        return;
      }
      if (status < 200 || status >= 300) {
        rejectOnce(new Error(`HTTP ${status}`), true);
        return;
      }
      const declaredLength = Number(incoming.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        rejectOnce(new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB。`), true);
        return;
      }
      const chunks: Buffer[] = [];
      let byteLength = 0;
      incoming.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        if (byteLength > maxBytes) {
          rejectOnce(new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB。`), true);
          return;
        }
        chunks.push(bytes);
      });
      incoming.once('end', () => {
        if (!byteLength) rejectOnce(new Error('远程图片为空。'));
        else resolveOnce({ body: Buffer.concat(chunks, byteLength) });
      });
    });
    request.on('error', error => rejectOnce(
      signal.aborted ? remoteImageAbortError(signal) : error,
      true,
    ));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    request.end();
  });
}

export async function fetchRemoteImageBytes(
  source: string,
  options: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number } = {},
): Promise<{ body: Buffer; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRedirects = options.maxRedirects ?? 3;
  let url = validateRemoteImageUrl(source);
  const controller = new AbortController();
  const timeout = scheduleTimeout(() => {
    controller.abort(new Error(REMOTE_IMAGE_TIMEOUT_MESSAGE));
  }, timeoutMs);
  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const result = await downloadOnce(url, maxBytes, controller.signal);
      if (result.body) return { body: result.body, finalUrl: url.toString() };
      if (!result.redirect || redirectCount === maxRedirects) {
        throw new Error('远程图片重定向次数过多。');
      }
      url = validateRemoteImageUrl(result.redirect);
    }
    throw new Error('远程图片下载失败。');
  } catch (error) {
    if (controller.signal.aborted) throw remoteImageAbortError(controller.signal);
    throw error;
  } finally {
    cancelTimeout(timeout);
  }
}
