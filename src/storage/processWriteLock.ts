import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from 'timers';
import { TextDecoder } from 'util';

import { STORAGE_IDS } from '../ids';

const LOCK_FILENAME = 'conversation-writer.lock';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RELEASE_TIMEOUT_MS = 1_500;
const KILL_TIMEOUT_MS = 1_000;
const MAX_DIAGNOSTIC_BYTES = 16 * 1_024;
const MAX_PROTOCOL_TEXT_BYTES = 64 * 1_024 * 1_024;
// Each request or response carries at most one text value. Base64 makes the
// encoded upper bound independent of JSON escaping density; the remaining
// allowance covers the request id, path, hashes and byte counts.
const MAX_PROTOCOL_BASE64_BYTES = 4 * Math.ceil(MAX_PROTOCOL_TEXT_BYTES / 3);
const MAX_PROTOCOL_METADATA_BYTES = 64 * 1_024;
const MAX_PROTOCOL_LINE_BYTES = MAX_PROTOCOL_BASE64_BYTES + MAX_PROTOCOL_METADATA_BYTES;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const PYTHON_FCNTL_HELPER = String.raw`
import base64
import fcntl
import hashlib
import json
import os
import stat
import sys
import uuid

MAX_TEXT_BYTES = ${MAX_PROTOCOL_TEXT_BYTES}

vault_root = os.path.realpath(sys.argv[1])
lock_path = sys.argv[2]
lock_parent = os.path.dirname(lock_path)
if os.path.realpath(lock_parent) != lock_parent:
    raise RuntimeError("lock directory symlinks are forbidden")
if os.path.commonpath([vault_root, lock_parent]) != vault_root:
    raise RuntimeError("lock directory escapes the fenced authority")
directory_flags = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"):
    directory_flags |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    directory_flags |= os.O_NOFOLLOW
lock_directory_fd = os.open(lock_parent, directory_flags)
if not stat.S_ISDIR(os.fstat(lock_directory_fd).st_mode):
    os.close(lock_directory_fd)
    raise RuntimeError("lock directory must be a real directory")
lock_flags = os.O_CREAT | os.O_RDWR
if hasattr(os, "O_NOFOLLOW"):
    lock_flags |= os.O_NOFOLLOW
elif os.path.lexists(lock_path) and os.path.islink(lock_path):
    raise RuntimeError("lock file symlinks are forbidden")
fd = os.open(os.path.basename(lock_path), lock_flags, 0o600, dir_fd=lock_directory_fd)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    os.close(fd)
    os.close(lock_directory_fd)
    raise RuntimeError("lock path must be a regular file")
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print(json.dumps({"type": "BUSY"}, separators=(",", ":")), flush=True)
    os.close(fd)
    os.close(lock_directory_fd)
    raise SystemExit(73)

def respond(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)

def text_payload(value):
    payload = value.encode("utf-8")
    if len(payload) > MAX_TEXT_BYTES:
        raise ValueError("text value exceeds the protocol value limit")
    return payload

def text_evidence(value):
    if value is None:
        return None, None
    payload = text_payload(value)
    return hashlib.sha256(payload).hexdigest(), len(payload)

def encoded_text(value):
    if value is None:
        return None, None, None
    payload = text_payload(value)
    return (
        base64.b64encode(payload).decode("ascii"),
        hashlib.sha256(payload).hexdigest(),
        len(payload),
    )

def require_evidence(sha256_value, byte_length, label):
    if (
        not isinstance(sha256_value, str)
        or len(sha256_value) != 64
        or any(character not in "0123456789abcdef" for character in sha256_value)
    ):
        raise ValueError(label + " SHA-256 is invalid")
    if (
        not isinstance(byte_length, int)
        or isinstance(byte_length, bool)
        or byte_length < 0
        or byte_length > MAX_TEXT_BYTES
    ):
        raise ValueError(label + " byte length is invalid")

def decode_request_text(request, prefix):
    encoded = request.get(prefix + "Base64")
    sha256_value = request.get(prefix + "Sha256")
    byte_length = request.get(prefix + "Bytes")
    if not isinstance(encoded, str):
        raise ValueError(prefix + " Base64 must be a string")
    require_evidence(sha256_value, byte_length, prefix)
    try:
        payload = base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise ValueError(prefix + " Base64 is invalid") from error
    if len(payload) != byte_length:
        raise ValueError(prefix + " byte length does not match")
    if hashlib.sha256(payload).hexdigest() != sha256_value:
        raise ValueError(prefix + " SHA-256 does not match")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError(prefix + " is not valid UTF-8") from error

def expected_matches(current, request):
    expected_present = request.get("expectedPresent")
    expected_sha256 = request.get("expectedSha256")
    expected_bytes = request.get("expectedBytes")
    if not isinstance(expected_present, bool):
        raise ValueError("CAS expected presence is invalid")
    if not expected_present:
        if expected_sha256 is not None or expected_bytes is not None:
            raise ValueError("absent CAS expectation carried text evidence")
        return current is None
    require_evidence(expected_sha256, expected_bytes, "expected")
    current_sha256, current_bytes = text_evidence(current)
    return current_sha256 == expected_sha256 and current_bytes == expected_bytes

def open_target_parent(relative_path):
    if not isinstance(relative_path, str) or not relative_path or "\x00" in relative_path:
        raise ValueError("invalid vault-relative path")
    if os.path.isabs(relative_path):
        raise ValueError("absolute paths are forbidden")
    normalized = os.path.normpath(relative_path)
    if normalized in ("", ".", "..") or normalized.startswith(".." + os.sep):
        raise ValueError("path escapes the vault")
    target = os.path.abspath(os.path.join(vault_root, normalized))
    parent_path = os.path.dirname(target)
    if not os.path.isdir(parent_path):
        raise ValueError("target parent does not exist")
    parent = os.path.realpath(parent_path)
    if parent != parent_path or os.path.commonpath([vault_root, parent]) != vault_root:
        raise ValueError("path parent escapes the vault")
    target_name = os.path.basename(target)
    if os.path.lexists(os.path.join(parent, target_name)) and os.path.islink(os.path.join(parent, target_name)):
        raise ValueError("symlink targets are forbidden")
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    return os.open(parent, flags), target_name

def read_text(directory_fd, target_name):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        target_fd = os.open(target_name, flags, dir_fd=directory_fd)
        target_stat = os.fstat(target_fd)
        if not stat.S_ISREG(target_stat.st_mode):
            os.close(target_fd)
            raise ValueError("CAS target must be a regular file")
        if target_stat.st_size > MAX_TEXT_BYTES:
            os.close(target_fd)
            raise ValueError("text value exceeds the protocol value limit")
        with os.fdopen(target_fd, "r", encoding="utf-8", newline="") as handle:
            value = handle.read()
        text_payload(value)
        return value
    except FileNotFoundError:
        return None

def atomic_write(directory_fd, target_name, value):
    temp_name = target_name + ".tmp." + str(os.getpid()) + "." + uuid.uuid4().hex
    payload = value.encode("utf-8")
    temp_fd = os.open(
        temp_name,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY,
        0o600,
        dir_fd=directory_fd,
    )
    replaced = False
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(temp_fd, payload[offset:])
        os.fsync(temp_fd)
    finally:
        os.close(temp_fd)
    try:
        os.replace(
            temp_name,
            target_name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
        )
        replaced = True
        os.fsync(directory_fd)
    finally:
        if not replaced:
            # Retain the private 0600 recovery sidecar. Ailu never deletes
            # failed-write evidence automatically; an operator can inspect it
            # after the helper has failed closed.
            pass

respond({"type": "READY"})
for raw_line in sys.stdin:
    request_id = None
    try:
        request = json.loads(raw_line)
        request_id = request.get("id")
        operation = request.get("op")
        if operation == "release":
            respond({"id": request_id, "ok": True})
            break
        directory_fd, target_name = open_target_parent(request.get("path"))
        try:
            current = read_text(directory_fd, target_name)
            if operation == "read":
                value_base64, value_sha256, value_bytes = encoded_text(current)
                respond({
                    "id": request_id,
                    "ok": True,
                    "valueBase64": value_base64,
                    "valueSha256": value_sha256,
                    "valueBytes": value_bytes,
                })
                continue
            if operation == "cas":
                replacement = decode_request_text(request, "replacement")
                replacement_sha256 = request.get("replacementSha256")
                replacement_bytes = request.get("replacementBytes")
                if expected_matches(current, request):
                    atomic_write(directory_fd, target_name, replacement)
                    written = read_text(directory_fd, target_name)
                    written_sha256, written_bytes = text_evidence(written)
                    if written_sha256 != replacement_sha256 or written_bytes != replacement_bytes:
                        raise RuntimeError("CAS write verification failed")
                    respond({
                        "id": request_id,
                        "ok": True,
                        "swapped": True,
                        "valueSha256": written_sha256,
                        "valueBytes": written_bytes,
                    })
                else:
                    current_base64, current_sha256, current_bytes = encoded_text(current)
                    respond({
                        "id": request_id,
                        "ok": True,
                        "swapped": False,
                        "valueBase64": current_base64,
                        "valueSha256": current_sha256,
                        "valueBytes": current_bytes,
                    })
                continue
        finally:
            os.close(directory_fd)
        raise ValueError("unsupported operation")
    except Exception as error:
        respond({"id": request_id, "ok": False, "error": str(error)[:512]})

try:
    fcntl.flock(fd, fcntl.LOCK_UN)
finally:
    os.close(fd)
    os.close(lock_directory_fd)
`;

export interface ProcessWriteLockCasResult {
  swapped: boolean;
  /** The caller's replacement on success; the bounded verified current value on conflict. */
  value: string | null;
}

export interface PythonFcntlProcessWriteLockOptions {
  pythonPath?: string;
  helperSource?: string;
  /** Vault-relative namespace containing the retained lock file. */
  lockDirectoryName?: string;
  lockFilename?: string;
  handshakeTimeoutMs?: number;
  releaseTimeoutMs?: number;
  killTimeoutMs?: number;
}

export interface ProcessWriteLock {
  /** Returns false when another process currently owns the advisory lock. */
  acquire(): Promise<boolean>;
  /** Throws when the helper exited and this process is no longer fenced as writer. */
  assertHeld(): Promise<void>;
  /** Optional physical-file operations supplied by the real process helper. */
  readTextFile?(vaultRelativePath: string): Promise<string | null>;
  compareAndSwapTextFile?(
    vaultRelativePath: string,
    expected: string | null,
    replacement: string,
  ): Promise<ProcessWriteLockCasResult>;
  /** Releases the OS lock and waits until the helper process has exited. */
  release(): Promise<void>;
}

/**
 * Holds a POSIX advisory lock in a tiny, long-lived system Python process.
 * The helper lifetime is the fencing lifetime: a plugin/process crash closes
 * its descriptor and the OS releases the lock automatically. The lock file is
 * intentionally retained forever; correctness never depends on unlinking it.
 */
export class PythonFcntlProcessWriteLock implements ProcessWriteLock {
  readonly vaultBasePath: string;
  readonly lockPath: string;

  private readonly pythonPath: string;
  private readonly helperSource: string;
  private readonly handshakeTimeoutMs: number;
  private readonly releaseTimeoutMs: number;
  private readonly killTimeoutMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private held = false;
  private acquirePromise: Promise<boolean> | null = null;
  private activeVaultBasePath: string | null = null;
  private stdout = '';
  private stderr = '';
  private requestSequence = 0;
  private readonly pendingRequests = new Map<string, {
    resolve: (response: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    vaultBasePath: string,
    options: PythonFcntlProcessWriteLockOptions = {},
  ) {
    const normalized = vaultBasePath.trim();
    if (!normalized || !path.isAbsolute(normalized)) {
      throw new Error('Conversation process lock requires an absolute vault base path.');
    }
    this.vaultBasePath = path.resolve(normalized);
    const lockDirectoryName = normalizeLockDirectoryName(
      options.lockDirectoryName ?? STORAGE_IDS.vaultDirectoryName,
    );
    const lockFilename = options.lockFilename ?? LOCK_FILENAME;
    if (!/^[A-Za-z0-9._-]+$/.test(lockFilename)) {
      throw new Error('Conversation process lock filename is invalid.');
    }
    this.lockPath = path.join(this.vaultBasePath, lockDirectoryName, lockFilename);
    this.pythonPath = options.pythonPath?.trim() || '/usr/bin/python3';
    this.helperSource = options.helperSource ?? PYTHON_FCNTL_HELPER;
    this.handshakeTimeoutMs = normalizeTimeout(
      options.handshakeTimeoutMs,
      HANDSHAKE_TIMEOUT_MS,
      'handshake',
    );
    this.releaseTimeoutMs = normalizeTimeout(
      options.releaseTimeoutMs,
      RELEASE_TIMEOUT_MS,
      'release',
    );
    this.killTimeoutMs = normalizeTimeout(options.killTimeoutMs, KILL_TIMEOUT_MS, 'kill');
  }

  static forPrivateDirectory(
    directoryPath: string,
    lockFilename: string,
    options: Omit<PythonFcntlProcessWriteLockOptions, 'lockDirectoryName' | 'lockFilename'> = {},
  ): PythonFcntlProcessWriteLock {
    const normalized = directoryPath.trim();
    if (!normalized || !path.isAbsolute(normalized) || !/^[A-Za-z0-9._-]+$/.test(lockFilename)) {
      throw new Error('Private process lock requires an absolute directory and safe filename.');
    }
    return new PythonFcntlProcessWriteLock(path.resolve(normalized), {
      ...options,
      lockDirectoryName: '.',
      lockFilename,
    });
  }

  get helperPid(): number | null {
    return this.child?.pid ?? null;
  }

  acquire(): Promise<boolean> {
    if (this.held) return Promise.resolve(true);
    if (this.acquirePromise) return this.acquirePromise;
    this.acquirePromise = this.startHelper().finally(() => {
      this.acquirePromise = null;
    });
    return this.acquirePromise;
  }

  async assertHeld(): Promise<void> {
    const child = this.child;
    if (!this.held || !child || child.exitCode !== null || child.signalCode !== null || child.killed) {
      this.held = false;
      throw new Error('Conversation writer process lock is no longer held.');
    }
  }

  async readTextFile(vaultRelativePath: string): Promise<string | null> {
    const response = await this.sendRequest({
      op: 'read',
      path: normalizeVaultRelativePath(this.vaultBasePath, vaultRelativePath),
    });
    return decodeProtocolText(response);
  }

  async compareAndSwapTextFile(
    vaultRelativePath: string,
    expected: string | null,
    replacement: string,
  ): Promise<ProcessWriteLockCasResult> {
    if (typeof replacement !== 'string') {
      throw new Error('Conversation writer CAS replacement must be text.');
    }
    const expectedEvidence = expected === null
      ? null
      : protocolTextEvidence(expected, 'CAS expected value');
    const encodedReplacement = encodeProtocolText(replacement, 'CAS replacement');
    const response = await this.sendRequest({
      op: 'cas',
      path: normalizeVaultRelativePath(this.vaultBasePath, vaultRelativePath),
      expectedPresent: expected !== null,
      expectedSha256: expectedEvidence?.sha256 ?? null,
      expectedBytes: expectedEvidence?.bytes ?? null,
      replacementBase64: encodedReplacement.base64,
      replacementSha256: encodedReplacement.sha256,
      replacementBytes: encodedReplacement.bytes,
    });
    if (typeof response.swapped !== 'boolean') {
      throw new Error('Conversation writer helper returned an invalid CAS response.');
    }
    const resultEvidence = protocolResponseEvidence(response, 'CAS response');
    if (response.swapped) {
      if (!sameEvidence(resultEvidence, encodedReplacement)) {
        throw new Error('Conversation writer helper returned mismatched CAS write evidence.');
      }
      await this.hardenCanonicalFile(vaultRelativePath);
      return { swapped: true, value: replacement };
    }
    if (sameEvidence(resultEvidence, expectedEvidence)) {
      throw new Error('Conversation writer helper returned contradictory CAS conflict evidence.');
    }
    return { swapped: false, value: decodeProtocolText(response) };
  }

  async release(): Promise<void> {
    if (this.acquirePromise) {
      await this.acquirePromise.catch(() => false);
    }
    const child = this.child;
    this.held = false;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    try {
      child.stdin.write(`${JSON.stringify({ id: 'release', op: 'release' })}\n`);
      child.stdin.end();
    } catch {
      // A concurrently exiting helper is already releasing its OS descriptor.
    }
    if (!(await waitForClose(child, this.releaseTimeoutMs))) {
      await terminateHelper(child, this.killTimeoutMs);
    }
    if (this.child === child) this.child = null;
  }

  protected async startHelper(): Promise<boolean> {
    const configuredLockDirectory = path.dirname(this.lockPath);
    const canCreateAuthority = configuredLockDirectory === this.vaultBasePath;
    const authorityPath = await this.prepareAuthorityPath(canCreateAuthority);
    const lockDirectoryRelativePath = path.relative(
      this.vaultBasePath,
      configuredLockDirectory,
    );
    const lockDirectory = path.resolve(authorityPath, lockDirectoryRelativePath);
    const physicalLockPath = path.join(lockDirectory, path.basename(this.lockPath));
    this.activeVaultBasePath = authorityPath;

    if (lockDirectory !== authorityPath) {
      try {
        await fs.mkdir(lockDirectory, { mode: 0o700 });
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) throw error;
      }
    }
    const lockDirectoryStat = await fs.lstat(lockDirectory);
    if (!lockDirectoryStat.isDirectory() || lockDirectoryStat.isSymbolicLink()
      || await fs.realpath(lockDirectory) !== path.resolve(lockDirectory)) {
      throw new Error('Ailu lock directory has an unsafe type.');
    }
    // The lock inode is intentionally retained across helper lifetimes. Create
    // it once in the host before competing helpers start; some macOS system
    // Python builds can sporadically surface ENOENT when two processes both
    // combine O_CREAT, O_NOFOLLOW and dir_fd for the same missing name.
    try {
      const lockFile = await fs.open(physicalLockPath, 'ax+', 0o600);
      try {
        await lockFile.chmod(0o600);
        await lockFile.sync();
      } finally {
        await lockFile.close();
      }
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
    const lockFileStat = await fs.lstat(physicalLockPath);
    if (!lockFileStat.isFile() || lockFileStat.isSymbolicLink()
      || await fs.realpath(physicalLockPath) !== path.resolve(physicalLockPath)) {
      throw new Error('Ailu lock file has an unsafe type.');
    }
    this.stdout = '';
    this.stderr = '';
    const child = spawn(this.pythonPath, [
      '-u',
      '-c',
      this.helperSource,
      authorityPath,
      physicalLockPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const acquired = await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let stdoutRemainder = '';
      const timeout = setNodeTimeout(() => {
        if (settled) return;
        settled = true;
        clearNodeTimeout(timeout);
        this.held = false;
        void terminateHelper(child, this.killTimeoutMs).then(() => {
          if (this.child === child) this.child = null;
          reject(new Error(
            `Conversation process lock helper did not become ready.${this.diagnostics()}`,
          ));
        }, terminationError => {
          if (this.child === child) this.child = null;
          reject(new Error(
            `Conversation process lock helper did not become ready and could not be terminated: ${errorMessage(terminationError)}.${this.diagnostics()}`,
          ));
        });
      }, this.handshakeTimeoutMs);

      const finish = (result: boolean, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearNodeTimeout(timeout);
        if (!result) {
          this.held = false;
        }
        if (error) reject(error);
        else resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer | string) => {
        const text = String(chunk);
        stdoutRemainder += text;
        if (Buffer.byteLength(stdoutRemainder, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
          this.stderr = appendBounded(this.stderr, ' helper emitted an oversized protocol line');
          child.kill('SIGTERM');
          return;
        }
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? '';
        for (const line of lines) {
          const message = parseProtocolLine(line);
          if (message?.type === 'READY') {
            this.stdout = appendBounded(this.stdout, ' READY');
            this.held = true;
            finish(true);
          } else if (message?.type === 'BUSY') {
            this.stdout = appendBounded(this.stdout, ' BUSY');
            finish(false);
          } else if (message) {
            this.resolvePendingRequest(message);
          } else if (line.trim()) {
            this.stdout = appendBounded(this.stdout, ' invalid-protocol-line');
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.stderr = appendBounded(this.stderr, String(chunk));
      });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearNodeTimeout(timeout);
        this.held = false;
        void terminateHelper(child, this.killTimeoutMs).then(() => {
          if (this.child === child) this.child = null;
          reject(new Error(`Conversation process lock helper failed: ${error.message}`));
        }, terminationError => {
          if (this.child === child) this.child = null;
          reject(new Error(
            `Conversation process lock helper failed (${error.message}) and could not be terminated: ${errorMessage(terminationError)}.`,
          ));
        });
      });
      child.once('close', code => {
        this.rejectPendingRequests(new Error(
          `Conversation process lock helper exited (code ${String(code)}).`,
        ));
        if (this.child === child) {
          this.child = null;
          this.held = false;
        }
        if (!settled) {
          if (code === 73) finish(false);
          else finish(false, new Error(
            `Conversation process lock helper exited before READY (code ${String(code)}).${this.diagnostics()}`,
          ));
        }
      });
    });
    if (acquired) {
      const heldDirectoryStat = await fs.lstat(lockDirectory);
      if (!heldDirectoryStat.isDirectory() || heldDirectoryStat.isSymbolicLink()
        || await fs.realpath(lockDirectory) !== path.resolve(lockDirectory)) {
        await this.release().catch(() => {});
        throw new Error('Ailu lock directory changed to an unsafe type.');
      }
      // The canonical namespace can contain private staged data. Harden it only
      // after the writer fence is held so another process cannot race the mode change.
      await fs.chmod(lockDirectory, 0o700);
    }
    return acquired;
  }

  private async prepareAuthorityPath(canCreate: boolean): Promise<string> {
    let authorityState: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      authorityState = await fs.lstat(this.vaultBasePath);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT') || !canCreate) throw error;
      const parent = path.dirname(this.vaultBasePath);
      const parentState = await fs.lstat(parent);
      if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
        throw new Error('Ailu private lock parent traverses an unsafe path.');
      }
      const physicalParent = await fs.realpath(parent);
      const physicalAuthorityPath = path.join(physicalParent, path.basename(this.vaultBasePath));
      try {
        await fs.mkdir(physicalAuthorityPath, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isErrorCode(mkdirError, 'EEXIST')) throw mkdirError;
      }
      authorityState = await fs.lstat(physicalAuthorityPath);
      if (!authorityState.isDirectory() || authorityState.isSymbolicLink()
        || await fs.realpath(physicalAuthorityPath) !== physicalAuthorityPath) {
        throw new Error('Ailu lock authority root traverses an unsafe path.');
      }
      return physicalAuthorityPath;
    }
    if (!authorityState.isDirectory() || authorityState.isSymbolicLink()) {
      throw new Error('Ailu lock authority root traverses an unsafe path.');
    }
    return fs.realpath(this.vaultBasePath);
  }

  private async sendRequest(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.assertHeld();
    const child = this.child;
    if (!child) throw new Error('Conversation writer process lock is no longer held.');
    const id = `request-${++this.requestSequence}`;
    const line = JSON.stringify({ id, ...payload });
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      throw new Error('Conversation writer helper request exceeds the protocol size limit.');
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      child.stdin.write(`${line}\n`, error => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        this.held = false;
        pending.reject(new Error(`Conversation writer helper request failed: ${error.message}`));
      });
    });
  }

  private async hardenCanonicalFile(vaultRelativePath: string): Promise<void> {
    const authorityPath = this.activeVaultBasePath ?? this.vaultBasePath;
    const canonicalRoot = path.join(authorityPath, STORAGE_IDS.vaultDirectoryName);
    const target = path.resolve(authorityPath, vaultRelativePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) return;
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Canonical Ailu writer target has an unsafe type.');
    }
    await fs.chmod(target, 0o600);
    let parent = path.dirname(target);
    while (parent === canonicalRoot || parent.startsWith(`${canonicalRoot}${path.sep}`)) {
      const parentStat = await fs.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error('Canonical Ailu writer parent has an unsafe type.');
      }
      await fs.chmod(parent, 0o700);
      if (parent === canonicalRoot) break;
      parent = path.dirname(parent);
    }
  }

  private resolvePendingRequest(message: Record<string, unknown>): void {
    const id = typeof message.id === 'string' ? message.id : null;
    if (!id) return;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    if (message.ok === true) {
      pending.resolve(message);
      return;
    }
    pending.reject(new Error(
      typeof message.error === 'string'
        ? `Conversation writer helper rejected the request: ${message.error}`
        : 'Conversation writer helper returned an invalid error response.',
    ));
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private diagnostics(): string {
    const stdout = this.stdout.trim();
    const stderr = this.stderr.trim();
    return [stdout && ` stdout=${stdout}`, stderr && ` stderr=${stderr}`].filter(Boolean).join('');
  }
}

/** Creates the single canonical Ailu Vault writer fence. */
export function createAiluProcessWriteLock(
  vaultBasePath: string,
  options: Omit<PythonFcntlProcessWriteLockOptions, 'lockDirectoryName' | 'lockFilename'> = {},
): PythonFcntlProcessWriteLock {
  return new PythonFcntlProcessWriteLock(vaultBasePath, {
    ...options,
    lockDirectoryName: STORAGE_IDS.vaultDirectoryName,
  });
}

function normalizeLockDirectoryName(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/');
  if (normalized === '.') return normalized;
  if (!normalized
    || normalized.startsWith('/')
    || normalized.includes('/')
    || normalized === '.'
    || normalized === '..') {
    throw new Error('Conversation process lock directory must be one Vault-relative segment.');
  }
  return normalized;
}

function isErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function appendBounded(existing: string, addition: string): string {
  const combined = `${existing}${addition}`;
  if (Buffer.byteLength(combined, 'utf8') <= MAX_DIAGNOSTIC_BYTES) return combined;
  return Buffer.from(combined, 'utf8').subarray(-MAX_DIAGNOSTIC_BYTES).toString('utf8');
}

interface ProtocolTextEvidence {
  sha256: string;
  bytes: number;
}

interface EncodedProtocolText extends ProtocolTextEvidence {
  base64: string;
}

function protocolTextEvidence(value: string, label: string): ProtocolTextEvidence {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_PROTOCOL_TEXT_BYTES) {
    throw new Error(`Conversation writer ${label} exceeds the protocol value limit.`);
  }
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    bytes,
  };
}

function encodeProtocolText(value: string, label: string): EncodedProtocolText {
  const payload = Buffer.from(value, 'utf8');
  if (payload.byteLength > MAX_PROTOCOL_TEXT_BYTES) {
    throw new Error(`Conversation writer ${label} exceeds the protocol value limit.`);
  }
  return {
    base64: payload.toString('base64'),
    sha256: createHash('sha256').update(payload).digest('hex'),
    bytes: payload.byteLength,
  };
}

function protocolResponseEvidence(
  response: Record<string, unknown>,
  label: string,
): ProtocolTextEvidence | null {
  const sha256 = response.valueSha256;
  const bytes = response.valueBytes;
  if (sha256 === null && bytes === null) return null;
  if (typeof sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(sha256)
    || typeof bytes !== 'number'
    || !Number.isSafeInteger(bytes)
    || bytes < 0
    || bytes > MAX_PROTOCOL_TEXT_BYTES) {
    throw new Error(`Conversation writer helper returned invalid ${label} evidence.`);
  }
  return { sha256, bytes };
}

function sameEvidence(
  left: ProtocolTextEvidence | null,
  right: ProtocolTextEvidence | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function decodeProtocolText(response: Record<string, unknown>): string | null {
  const encoded = response.valueBase64;
  const evidence = protocolResponseEvidence(response, 'read response');
  if (encoded === null) {
    if (evidence !== null) {
      throw new Error('Conversation writer helper returned contradictory read evidence.');
    }
    return null;
  }
  if (typeof encoded !== 'string' || evidence === null) {
    throw new Error('Conversation writer helper returned an invalid read response.');
  }
  const payload = Buffer.from(encoded, 'base64');
  if (payload.byteLength !== evidence.bytes
    || createHash('sha256').update(payload).digest('hex') !== evidence.sha256) {
    throw new Error('Conversation writer helper returned mismatched read evidence.');
  }
  try {
    return UTF8_DECODER.decode(payload);
  } catch {
    throw new Error('Conversation writer helper returned invalid UTF-8 text.');
  }
}

function normalizeTimeout(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error(`Conversation process lock ${label} timeout must be positive.`);
  }
  return Math.floor(normalized);
}

function normalizeVaultRelativePath(vaultBasePath: string, input: string): string {
  const value = input.trim();
  if (!value || value.includes('\0') || path.isAbsolute(value)) {
    throw new Error('Conversation writer helper requires a vault-relative path.');
  }
  const normalized = path.normalize(value);
  const resolved = path.resolve(vaultBasePath, normalized);
  const relative = path.relative(vaultBasePath, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Conversation writer helper path escapes the vault.');
  }
  return relative;
}

function parseProtocolLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function terminateHelper(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await waitForClose(child, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForClose(child, timeoutMs))) {
    throw new Error('Conversation process lock helper did not exit after SIGKILL.');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearNodeTimeout(timer);
      child.off('close', onClose);
      resolve(value);
    };
    const onClose = (): void => settle(true);
    const timer = setNodeTimeout(() => settle(false), timeoutMs);
    child.once('close', onClose);
  });
}
