import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ailuHome, xCookiesPath } from '../paths';

export const MAX_X_COOKIE_FILE_BYTES = 5 * 1024 * 1024;

type XCookieRecord = Record<string, unknown>;

const ALLOWED_X_COOKIE_DOMAINS = new Set([
  'x.com',
  '.x.com',
  'twitter.com',
  '.twitter.com',
]);
const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface NormalizedXCookies {
  json: string;
  cookieCount: number;
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function cookieList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value as unknown[];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && Array.isArray(record.cookies)) return record.cookies as unknown[];
  }
  return null;
}

function sanitizeCookie(value: unknown): XCookieRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cookie = value as XCookieRecord;
  if (typeof cookie.name !== 'string'
    || typeof cookie.value !== 'string'
    || typeof cookie.domain !== 'string') return null;
  const name = cookie.name;
  const cookieValue = cookie.value;
  const domain = cookie.domain;
  const normalizedDomain = domain.toLowerCase();
  if (!name || name !== name.trim() || !COOKIE_NAME_PATTERN.test(name)
    || !cookieValue || hasControlCharacters(cookieValue)
    || domain !== domain.trim() || !ALLOWED_X_COOKIE_DOMAINS.has(normalizedDomain)) return null;
  if (cookie.path !== undefined
    && (typeof cookie.path !== 'string' || !cookie.path.startsWith('/')
      || hasControlCharacters(cookie.path))) return null;
  if (cookie.expires !== undefined
    && (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires))) return null;
  if (cookie.httpOnly !== undefined && typeof cookie.httpOnly !== 'boolean') return null;
  if (cookie.secure !== undefined && typeof cookie.secure !== 'boolean') return null;
  if (cookie.sameSite !== undefined
    && (typeof cookie.sameSite !== 'string'
      || !['Strict', 'Lax', 'None'].includes(cookie.sameSite))) return null;
  return {
    name,
    value: cookieValue,
    domain: normalizedDomain,
    path: cookie.path ?? '/',
    ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
    ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
  };
}

export function normalizeXCookieJsonText(
  text: string,
  options: { filterInvalid?: boolean; nowEpochSeconds?: number } = {},
): NormalizedXCookies {
  if (Buffer.byteLength(text, 'utf8') > MAX_X_COOKIE_FILE_BYTES) {
    throw new Error('X Cookie JSON 超过 5 MB 上限。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('X Cookie 内容不是有效 JSON。');
  }
  const source = cookieList(parsed);
  if (!source) throw new Error('X Cookie JSON 必须是 Cookie 数组。');
  const nowEpochSeconds = options.nowEpochSeconds ?? Date.now() / 1_000;
  let invalidCookiePresent = false;
  const normalized = source.map(value => {
    const cookie = sanitizeCookie(value);
    if (!cookie) {
      invalidCookiePresent = true;
      return null;
    }
    const expires = cookie.expires;
    if (typeof expires === 'number' && expires > 0 && expires <= nowEpochSeconds) return null;
    return cookie;
  });
  if (!options.filterInvalid && invalidCookiePresent) {
    throw new Error('X Cookie JSON 包含非白名单域名或格式无效的 Cookie。');
  }
  const cookies = normalized.filter((cookie): cookie is XCookieRecord => cookie !== null);
  const xCookieNames = new Set(cookies
    .filter(cookie => cookie.domain === 'x.com' || cookie.domain === '.x.com')
    .map(cookie => cookie.name));
  if (!xCookieNames.has('auth_token') || !xCookieNames.has('ct0')) {
    throw new Error('X Cookie 缺少 auth_token 或 ct0。');
  }
  return {
    json: `${JSON.stringify(cookies, null, 2)}\n`,
    cookieCount: cookies.length,
  };
}

async function ensureManagedDirectory(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  if (parent !== directory && !fs.existsSync(parent)) await ensureManagedDirectory(parent);
  try {
    const before = await fsp.lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error('Ailu 私密目录不能是符号链接或非目录。');
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await fsp.mkdir(directory, { mode: 0o700 });
  }
  const after = await fsp.lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory()) {
    throw new Error('Ailu 私密目录校验失败。');
  }
  await fsp.chmod(directory, 0o700);
}

async function validateManagedDirectory(directory: string): Promise<void> {
  const stat = await fsp.lstat(directory).catch(error => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('Ailu X Cookie 私密目录权限或类型不安全。');
  }
}

export async function ensureCanonicalXCookieDirectories(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const home = ailuHome(env);
  const target = xCookiesPath(env);
  await ensureManagedDirectory(home);
  await ensureManagedDirectory(path.join(home, 'secrets'));
  await ensureManagedDirectory(path.dirname(target));
}

async function assertSafeExistingTarget(target: string): Promise<'missing' | 'file'> {
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('X Cookie 目标不能是符号链接或非普通文件。');
    }
    if (stat.size > MAX_X_COOKIE_FILE_BYTES) throw new Error('X Cookie 文件超过 5 MB 上限。');
    return 'file';
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeCanonicalXCookies(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; cookieCount: number }> {
  const normalized = normalizeXCookieJsonText(text);
  const target = xCookiesPath(env);
  const home = ailuHome(env);
  const directory = path.dirname(target);
  if (path.relative(home, target).startsWith('..') || path.isAbsolute(path.relative(home, target))) {
    throw new Error('X Cookie 目标超出 Ailu 私密目录。');
  }
  await ensureManagedDirectory(home);
  await ensureManagedDirectory(path.join(home, 'secrets'));
  await ensureManagedDirectory(directory);
  await assertSafeExistingTarget(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(normalized.json, { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    // Preserve the private sidecar as recovery evidence; Ailu never deletes
    // files automatically.
    throw error;
  }
  await handle.close();
  await assertSafeExistingTarget(target);
  await fsp.rename(temporary, target);
  await fsp.chmod(target, 0o600);
  await fsyncDirectory(directory);
  const finalStat = await fsp.lstat(target);
  if (finalStat.isSymbolicLink() || !finalStat.isFile() || (finalStat.mode & 0o077) !== 0) {
    throw new Error('X Cookie 私密文件写入后校验失败。');
  }
  return { path: target, cookieCount: normalized.cookieCount };
}

export async function validateCanonicalXCookies(
  env: NodeJS.ProcessEnv = process.env,
  options: { repairPermissions?: boolean } = {},
): Promise<{ path: string; cookieCount: number }> {
  const target = xCookiesPath(env);
  const home = ailuHome(env);
  if (options.repairPermissions) {
    await ensureCanonicalXCookieDirectories(env);
  } else {
    await validateManagedDirectory(home);
    await validateManagedDirectory(path.join(home, 'secrets'));
    await validateManagedDirectory(path.dirname(target));
  }
  const stat = await fsp.lstat(target).catch(error => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()
    || stat.size <= 0 || stat.size > MAX_X_COOKIE_FILE_BYTES) {
    throw new Error('Ailu 私密目录中没有可验证的 X Cookie 文件。');
  }
  if (options.repairPermissions) await fsp.chmod(target, 0o600);
  const verified = await fsp.lstat(target);
  if (verified.isSymbolicLink() || !verified.isFile() || (verified.mode & 0o077) !== 0) {
    throw new Error('Ailu X Cookie 文件权限或类型不安全。');
  }
  const normalized = normalizeXCookieJsonText(await fsp.readFile(target, 'utf8'));
  return { path: target, cookieCount: normalized.cookieCount };
}

export async function ensureCanonicalXCookieOutput(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const target = xCookiesPath(env);
  await ensureCanonicalXCookieDirectories(env);
  const state = await assertSafeExistingTarget(target);
  if (state === 'file') {
    await fsp.chmod(target, 0o600);
    return target;
  }
  const handle = await fsp.open(target, 'wx', 0o600);
  try {
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(target));
  return target;
}

export async function migrateLegacyXCookies(
  sourcePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const source = sourcePath.trim();
  if (!source || !path.isAbsolute(source) || path.resolve(source) === path.resolve(xCookiesPath(env))) return false;
  await ensureCanonicalXCookieDirectories(env);
  if (await assertSafeExistingTarget(xCookiesPath(env)) === 'file') return false;
  const stat = await fsp.lstat(source).catch(error => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_X_COOKIE_FILE_BYTES) {
    throw new Error('旧 X Cookie 路径不是可安全迁移的普通文件。');
  }
  const text = await fsp.readFile(source, 'utf8');
  await writeCanonicalXCookies(text, env);
  return true;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
