import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { ailuHome } from '../paths';
import type { FileAttachment } from '../types';

export const MAX_FROZEN_ATTACHMENT_COUNT = 8;
export const MAX_FROZEN_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES = 40 * 1024 * 1024;

const FROZEN_ATTACHMENTS_DIRECTORY = 'frozen-attachments';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIME_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
] as const);

interface FreezeVerifiedImageInput {
  vaultPath: string;
  vaultRoot: string;
  body: Uint8Array;
  mimeType: string;
  env?: NodeJS.ProcessEnv;
}

function isSameOrDescendantPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (!value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function assertExistingPathComponentsSymlinkFree(target: string): void {
  const parsed = path.parse(target);
  let cursor = parsed.root;
  for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error('Managed attachment path may not traverse a symlink.');
  }
}

function ensurePrivateDirectory(directory: string): void {
  assertExistingPathComponentsSymlinkFree(directory);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = fs.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Managed attachment directory is not a physical directory.');
  }
  fs.chmodSync(directory, 0o700);
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw new Error('Managed attachment directory is not symlink-free.');
  }
}

function managedRoot(env: NodeJS.ProcessEnv, physicalVault: string): string {
  const home = requireAbsolutePath(ailuHome(env), 'AILU_HOME');
  const parent = path.dirname(home);
  if (parent === home) throw new Error('AILU_HOME may not be a filesystem root.');
  assertExistingPathComponentsSymlinkFree(parent);
  const parentMetadata = fs.lstatSync(parent);
  if (!parentMetadata.isDirectory()) throw new Error('AILU_HOME parent must be a physical directory.');
  const physicalParent = fs.realpathSync.native(parent);
  if (physicalParent !== path.resolve(parent)) {
    throw new Error('AILU_HOME parent may not traverse a symlink.');
  }
  const prospectiveRoot = path.join(physicalParent, path.basename(home), FROZEN_ATTACHMENTS_DIRECTORY);
  if (isSameOrDescendantPath(prospectiveRoot, physicalVault)) {
    throw new Error('Managed attachments must remain outside the current Vault.');
  }
  ensurePrivateDirectory(home);
  const root = path.join(home, FROZEN_ATTACHMENTS_DIRECTORY);
  ensurePrivateDirectory(root);
  return root;
}

function existingManagedRoot(env: NodeJS.ProcessEnv): string {
  const home = requireAbsolutePath(ailuHome(env), 'AILU_HOME');
  assertExistingPathComponentsSymlinkFree(home);
  const homeMetadata = fs.lstatSync(home);
  if (homeMetadata.isSymbolicLink() || !homeMetadata.isDirectory() || (homeMetadata.mode & 0o077) !== 0) {
    throw new Error('AILU_HOME must be a private physical directory.');
  }
  const root = path.join(home, FROZEN_ATTACHMENTS_DIRECTORY);
  assertExistingPathComponentsSymlinkFree(root);
  const metadata = fs.lstatSync(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error('Managed attachment directory is unavailable.');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Managed attachment directory permissions are not private.');
  }
  if (fs.realpathSync.native(root) !== path.resolve(root)) {
    throw new Error('Managed attachment directory is not symlink-free.');
  }
  return root;
}

function extensionForMimeType(mimeType: string): string {
  const extension = MIME_EXTENSIONS.get(mimeType);
  if (!extension) throw new Error('Only PNG, JPEG, GIF, and WebP attachments are supported.');
  return extension;
}

function detectedMimeType(body: Uint8Array): string | null {
  if (
    body.length >= 8
    && body[0] === 0x89
    && body[1] === 0x50
    && body[2] === 0x4e
    && body[3] === 0x47
    && body[4] === 0x0d
    && body[5] === 0x0a
    && body[6] === 0x1a
    && body[7] === 0x0a
  ) return 'image/png';
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  const ascii = (start: number, end: number): string => Buffer.from(body.subarray(start, end)).toString('ascii');
  if (body.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (body.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function noFollowFlag(): number {
  const value = fs.constants.O_NOFOLLOW;
  if (typeof value !== 'number' || value === 0) {
    throw new Error('This platform cannot safely open managed attachments without following symlinks.');
  }
  return value;
}

function frozenPath(root: string, digest: string, mimeType: string): string {
  if (!SHA256_PATTERN.test(digest)) throw new Error('Managed attachment hash is invalid.');
  return path.join(root, digest.slice(0, 2), `${digest}${extensionForMimeType(mimeType)}`);
}

function readVerifiedManagedFile(filePath: string, expectedBytes: number, expectedHash: string): Buffer {
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size !== expectedBytes || (metadata.mode & 0o077) !== 0) {
      throw new Error('Managed attachment file metadata is invalid.');
    }
    const body = fs.readFileSync(descriptor);
    if (body.byteLength !== expectedBytes || sha256(body) !== expectedHash) {
      throw new Error('Managed attachment content does not match its frozen identity.');
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeContentAddressedFile(filePath: string, body: Uint8Array, digest: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag(),
      0o600,
    );
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    readVerifiedManagedFile(filePath, body.byteLength, digest);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

export function freezeVerifiedImageAttachment(input: FreezeVerifiedImageInput): FileAttachment {
  if (process.platform === 'win32') {
    throw new Error('Managed attachment freezing is unavailable on Windows.');
  }
  if (!input.vaultPath.trim()) throw new Error('Attachment Vault path is required.');
  if (input.body.byteLength <= 0 || input.body.byteLength > MAX_FROZEN_ATTACHMENT_BYTES) {
    throw new Error('Attachment is empty or exceeds 10 MB.');
  }
  if (detectedMimeType(input.body) !== input.mimeType) {
    throw new Error('Attachment type does not match its file contents.');
  }
  const env = input.env ?? process.env;
  const physicalVault = fs.realpathSync.native(requireAbsolutePath(input.vaultRoot, 'Vault root'));
  const root = managedRoot(env, physicalVault);
  const physicalRoot = fs.realpathSync.native(root);
  if (isSameOrDescendantPath(physicalRoot, physicalVault)) {
    throw new Error('Managed attachments must remain outside the current Vault.');
  }
  const digest = sha256(input.body);
  const shard = path.join(root, digest.slice(0, 2));
  ensurePrivateDirectory(shard);
  const filePath = frozenPath(root, digest, input.mimeType);
  writeContentAddressedFile(filePath, input.body, digest);
  readVerifiedManagedFile(filePath, input.body.byteLength, digest);
  return {
    vaultPath: input.vaultPath,
    absolutePath: filePath,
    mimeType: input.mimeType,
    contentSha256: digest,
    byteLength: input.body.byteLength,
  };
}

export function assertManagedFrozenAttachments(
  attachments: readonly FileAttachment[],
  requestCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): FileAttachment[] {
  if (attachments.length > MAX_FROZEN_ATTACHMENT_COUNT) {
    throw new Error(`A turn may include at most ${MAX_FROZEN_ATTACHMENT_COUNT} image attachments.`);
  }
  if (attachments.length === 0) return [];
  if (process.platform === 'win32') throw new Error('Managed attachments are unavailable on Windows.');
  const root = existingManagedRoot(env);
  const physicalRoot = fs.realpathSync.native(root);
  const physicalCwd = fs.realpathSync.native(requireAbsolutePath(requestCwd, 'Runtime cwd'));
  if (isSameOrDescendantPath(physicalRoot, physicalCwd)) {
    throw new Error('Managed attachments must remain outside the runtime workspace.');
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const normalized = attachments.map(attachment => {
    const digest = attachment.contentSha256?.trim() ?? '';
    const byteLength = attachment.byteLength;
    const mimeType = attachment.mimeType?.trim() ?? '';
    if (!SHA256_PATTERN.test(digest) || !Number.isSafeInteger(byteLength)) {
      throw new Error('Attachment is not a frozen managed copy.');
    }
    const verifiedByteLength = byteLength as number;
    if (verifiedByteLength <= 0 || verifiedByteLength > MAX_FROZEN_ATTACHMENT_BYTES) {
      throw new Error('Managed attachment size is invalid.');
    }
    totalBytes += verifiedByteLength;
    if (totalBytes > MAX_FROZEN_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error('Image attachments exceed the 40 MB per-turn limit.');
    }
    // Validate the MIME allowlist before touching a caller-selected path.
    extensionForMimeType(mimeType);
    return { attachment, digest, mimeType, byteLength: verifiedByteLength };
  });

  return normalized.map(({ attachment, digest, mimeType, byteLength }) => {
    const expectedPath = frozenPath(root, digest, mimeType);
    if (attachment.absolutePath !== expectedPath || seen.has(expectedPath)) {
      throw new Error('Managed attachment path is invalid or duplicated.');
    }
    seen.add(expectedPath);
    const shard = path.dirname(expectedPath);
    assertExistingPathComponentsSymlinkFree(shard);
    const shardMetadata = fs.lstatSync(shard);
    if (
      shardMetadata.isSymbolicLink()
      || !shardMetadata.isDirectory()
      || (shardMetadata.mode & 0o077) !== 0
      || fs.realpathSync.native(shard) !== path.resolve(shard)
    ) {
      throw new Error('Managed attachment shard is not a private physical directory.');
    }
    const body = readVerifiedManagedFile(expectedPath, byteLength, digest);
    if (detectedMimeType(body) !== mimeType) {
      throw new Error('Managed attachment type no longer matches its contents.');
    }
    return {
      ...attachment,
      absolutePath: expectedPath,
      mimeType,
      contentSha256: digest,
      byteLength,
    };
  });
}
