import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  assertManagedFrozenAttachments,
  freezeVerifiedImageAttachment,
  MAX_FROZEN_ATTACHMENT_BYTES,
  MAX_FROZEN_ATTACHMENT_COUNT,
} from '../src/runtime/frozenAttachments';
import type { FileAttachment } from '../src/types';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

describe('managed frozen attachments', () => {
  let fixtureRoot: string;
  let vaultRoot: string;
  let managedHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-frozen-attachments-')));
    vaultRoot = path.join(fixtureRoot, 'vault');
    managedHome = path.join(fixtureRoot, 'home');
    env = { AILU_HOME: managedHome };
    fs.mkdirSync(vaultRoot);
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('reuses an immutable content-addressed copy with private directory and file modes', () => {
    const first = freezeVerifiedImageAttachment({
      vaultPath: 'assets/first.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env,
    });
    const second = freezeVerifiedImageAttachment({
      vaultPath: 'assets/second.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env,
    });

    expect(second.absolutePath).toBe(first.absolutePath);
    expect(first.absolutePath.startsWith(`${managedHome}${path.sep}`)).toBe(true);
    expect(first.absolutePath.startsWith(`${vaultRoot}${path.sep}`)).toBe(false);
    expect(fs.readFileSync(first.absolutePath)).toEqual(PNG_BYTES);
    expect(fs.statSync(managedHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(first.absolutePath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(first.absolutePath).mode & 0o777).toBe(0o600);
    expect(assertManagedFrozenAttachments([first], vaultRoot, env)).toEqual([first]);
  });

  test('fails closed when content, permissions, MIME, or managed path identity do not match', () => {
    const attachment = freezeVerifiedImageAttachment({
      vaultPath: 'assets/image.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env,
    });

    fs.chmodSync(attachment.absolutePath, 0o644);
    expect(() => assertManagedFrozenAttachments([attachment], vaultRoot, env))
      .toThrow('metadata is invalid');
    fs.chmodSync(attachment.absolutePath, 0o600);
    fs.writeFileSync(attachment.absolutePath, Buffer.from(PNG_BYTES.map((byte, index) => (
      index === PNG_BYTES.length - 1 ? byte ^ 0xff : byte
    ))));
    expect(() => assertManagedFrozenAttachments([attachment], vaultRoot, env))
      .toThrow('does not match its frozen identity');

    const unmanaged: FileAttachment = {
      ...attachment,
      absolutePath: path.join(vaultRoot, 'image.png'),
    };
    expect(() => assertManagedFrozenAttachments([unmanaged], vaultRoot, env)).toThrow();
    expect(() => freezeVerifiedImageAttachment({
      vaultPath: 'assets/fake.jpg',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/jpeg',
      env,
    })).toThrow('does not match');
  });

  test('enforces count, item, and aggregate byte budgets before runtime file reads', () => {
    freezeVerifiedImageAttachment({
      vaultPath: 'assets/bootstrap.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env,
    });
    const forged = (index: number, byteLength: number): FileAttachment => {
      const digest = index.toString(16).padStart(64, '0');
      return {
        vaultPath: `assets/${index}.png`,
        absolutePath: path.join(managedHome, 'frozen-attachments', digest.slice(0, 2), `${digest}.png`),
        mimeType: 'image/png',
        contentSha256: digest,
        byteLength,
      };
    };

    expect(() => assertManagedFrozenAttachments(
      Array.from({ length: MAX_FROZEN_ATTACHMENT_COUNT + 1 }, (_, index) => forged(index, 1)),
      vaultRoot,
      env,
    )).toThrow(`at most ${MAX_FROZEN_ATTACHMENT_COUNT}`);
    expect(() => assertManagedFrozenAttachments([forged(1, MAX_FROZEN_ATTACHMENT_BYTES + 1)], vaultRoot, env))
      .toThrow('size is invalid');
    expect(() => assertManagedFrozenAttachments(
      Array.from({ length: 5 }, (_, index) => forged(index + 1, 9 * 1024 * 1024)),
      vaultRoot,
      env,
    )).toThrow('40 MB per-turn limit');
  });

  test('rejects a managed root inside the Vault or reached through a symlink', () => {
    expect(() => freezeVerifiedImageAttachment({
      vaultPath: 'assets/image.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env: { AILU_HOME: path.join(vaultRoot, '.ailu') },
    })).toThrow('outside the current Vault');

    const physicalHome = path.join(fixtureRoot, 'physical-home');
    const linkedHome = path.join(fixtureRoot, 'linked-home');
    fs.mkdirSync(physicalHome);
    fs.symlinkSync(physicalHome, linkedHome, 'dir');
    expect(() => freezeVerifiedImageAttachment({
      vaultPath: 'assets/image.png',
      vaultRoot,
      body: PNG_BYTES,
      mimeType: 'image/png',
      env: { AILU_HOME: linkedHome },
    })).toThrow('symlink');
  });
});
