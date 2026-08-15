import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { xCookiesPath } from '../src/paths';
import {
  MAX_X_COOKIE_FILE_BYTES,
  migrateLegacyXCookies,
  normalizeXCookieJsonText,
  validateCanonicalXCookies,
  writeCanonicalXCookies,
} from '../src/xArticle/cookieStore';

function cookieJson(extra: unknown[] = []): string {
  return JSON.stringify([
    { name: 'auth_token', value: 'auth-secret', domain: '.x.com', path: '/' },
    { name: 'ct0', value: 'csrf-secret', domain: 'x.com', secure: true },
    ...extra,
  ]);
}

describe('X Cookie private store', () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-x-cookie-'));
    env = { AILU_HOME: path.join(tempDir, 'home') };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('normalizes only X cookies and requires the two login cookies', () => {
    const normalized = normalizeXCookieJsonText(cookieJson(), { nowEpochSeconds: 1_700_000_000 });
    expect(normalized.cookieCount).toBe(2);
    expect(JSON.parse(normalized.json)).toEqual([
      expect.objectContaining({ name: 'auth_token', domain: '.x.com' }),
      expect.objectContaining({ name: 'ct0', domain: 'x.com' }),
    ]);
    expect(() => normalizeXCookieJsonText(JSON.stringify([
      { name: 'auth_token', value: 'secret', domain: 'x.com.evil.example' },
      { name: 'ct0', value: 'secret', domain: 'x.com' },
    ]))).toThrow('非白名单域名');
    expect(() => normalizeXCookieJsonText(JSON.stringify([
      { name: 'auth_token', value: 'secret', domain: 'x.com' },
    ]))).toThrow('ct0');
    expect(() => normalizeXCookieJsonText(`"${'x'.repeat(MAX_X_COOKIE_FILE_BYTES)}"`))
      .toThrow('5 MB');
    expect(() => normalizeXCookieJsonText(JSON.stringify([
      { name: 'auth_token', value: 'secret', domain: '.twitter.com' },
      { name: 'ct0', value: 'secret', domain: 'twitter.com' },
    ]))).toThrow('auth_token');
    expect(() => normalizeXCookieJsonText(JSON.stringify([
      { name: 'auth_token', value: 'expired', domain: '.x.com', expires: 1_600_000_000 },
      { name: 'ct0', value: 'current', domain: 'x.com' },
    ]), { nowEpochSeconds: 1_700_000_000 })).toThrow('auth_token');
  });

  test('atomically stores only the normalized bytes with private permissions', async () => {
    const result = await writeCanonicalXCookies(cookieJson(), env);
    expect(result.path).toBe(xCookiesPath(env));
    expect(result.cookieCount).toBe(2);
    const file = fs.lstatSync(result.path);
    const directory = fs.lstatSync(path.dirname(result.path));
    expect(file.isFile()).toBe(true);
    expect(file.isSymbolicLink()).toBe(false);
    expect(file.mode & 0o077).toBe(0);
    expect(directory.mode & 0o077).toBe(0);
    expect(fs.readFileSync(result.path, 'utf8')).not.toContain('evil.example');
  });

  test('rejects a symlink target without modifying its destination', async () => {
    const target = xCookiesPath(env);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const sentinel = path.join(tempDir, 'sentinel.json');
    fs.writeFileSync(sentinel, 'sentinel', { mode: 0o600 });
    fs.symlinkSync(sentinel, target);

    await expect(writeCanonicalXCookies(cookieJson(), env)).rejects.toThrow('符号链接');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('sentinel');
  });

  test('rejects a symlinked secrets ancestor without writing outside Ailu Home', async () => {
    const home = path.join(tempDir, 'home');
    const external = path.join(tempDir, 'external');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    fs.symlinkSync(external, path.join(home, 'secrets'));

    await expect(writeCanonicalXCookies(cookieJson(), env)).rejects.toThrow('符号链接');
    expect(fs.readdirSync(external)).toEqual([]);
  });

  test('copies a valid legacy file once and never removes the source', async () => {
    const legacy = path.join(tempDir, 'legacy-cookies.json');
    fs.writeFileSync(legacy, cookieJson(), { mode: 0o600 });

    await expect(migrateLegacyXCookies(legacy, env)).resolves.toBe(true);
    expect(fs.existsSync(legacy)).toBe(true);
    expect(fs.readFileSync(xCookiesPath(env), 'utf8')).toContain('auth_token');
    await expect(migrateLegacyXCookies(legacy, env)).resolves.toBe(false);
  });

  test('rejects unsafe permissions unless the fenced caller explicitly repairs them', async () => {
    const stored = await writeCanonicalXCookies(cookieJson(), env);
    fs.chmodSync(stored.path, 0o640);

    await expect(validateCanonicalXCookies(env)).rejects.toThrow('权限');
    await expect(validateCanonicalXCookies(env, { repairPermissions: true }))
      .resolves.toMatchObject({ cookieCount: 2 });
    expect(fs.lstatSync(stored.path).mode & 0o077).toBe(0);
  });

  test('rejects an overly broad private directory mode unless fenced repair is requested', async () => {
    const stored = await writeCanonicalXCookies(cookieJson(), env);
    fs.chmodSync(path.dirname(stored.path), 0o755);

    await expect(validateCanonicalXCookies(env)).rejects.toThrow('目录权限');
    await expect(validateCanonicalXCookies(env, { repairPermissions: true }))
      .resolves.toMatchObject({ cookieCount: 2 });
    expect(fs.lstatSync(path.dirname(stored.path)).mode & 0o077).toBe(0);
  });

  test('keeps failed legacy migration retryable when the canonical file is absent', async () => {
    await expect(migrateLegacyXCookies(path.join(tempDir, 'missing.json'), env)).resolves.toBe(false);
    await expect(validateCanonicalXCookies(env)).rejects.toThrow('没有可验证');
  });
});
