import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DataAdapter } from 'obsidian';

import { STORAGE_IDS } from '../ids';
import { createId } from '../utils/id';
import {
  PythonFcntlProcessWriteLock,
  type ProcessWriteLock,
} from './processWriteLock';

export const CHAT_STORE_LEASE_PATH = `${STORAGE_IDS.vaultDirectoryName}/conversation-writer.json`;
const CHAT_STORE_LEASE_SEED_PATH = `${STORAGE_IDS.vaultDirectoryName}/conversation-writer.seed.json`;
const DEFAULT_LEASE_TTL_MS = 30_000;
const MAX_PHYSICAL_CAS_ATTEMPTS = 4;

interface ReleasedLeaseRecord {
  version: 1;
  state: 'released';
  releasedAt: number;
}

interface HeldLeaseRecord {
  version: 1;
  state: 'held';
  instanceId: string;
  /** Diagnostic owner process; instanceId + leaseId remain the fencing identity. */
  pid: number;
  leaseId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

type LeaseRecord = ReleasedLeaseRecord | HeldLeaseRecord;

export type ChatStoreLeaseMode = 'writer' | 'readOnly' | 'available';

export interface ChatStoreLeaseStatus {
  mode: ChatStoreLeaseMode;
  instanceId: string;
  leaseId: string | null;
  ownerInstanceId: string | null;
  ownerPid: number | null;
  heartbeatAt: number | null;
  expiresAt: number | null;
}

export interface ChatStoreLeaseOptions {
  instanceId?: string;
  pid?: number;
  ttlMs?: number;
  now?: () => number;
  /** Absolute filesystem root of the vault, used for cross-process OS fencing. */
  vaultBasePath?: string;
  /** Injectable only for deterministic fencing tests and nonstandard hosts. */
  processWriteLock?: ProcessWriteLock;
}

export class ChatStoreLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStoreLeaseError';
  }
}

export class ChatStoreLeaseCorruptError extends ChatStoreLeaseError {
  constructor(message = 'The conversation writer lease is corrupt; write access is disabled.') {
    super(message);
    this.name = 'ChatStoreLeaseCorruptError';
  }
}

export class ChatStoreLeaseLostError extends ChatStoreLeaseError {
  constructor(message = 'This studio instance no longer owns the conversation writer lease.') {
    super(message);
    this.name = 'ChatStoreLeaseLostError';
  }
}

/**
 * A vault-local writer lease. Production uses the long-lived flock helper for
 * physical CAS; injected legacy locks retain the DataAdapter fallback so tests
 * and nonstandard hosts stay compatible.
 */
export class ChatStoreLease {
  readonly instanceId: string;
  readonly pid: number;
  readonly ttlMs: number;

  private readonly now: () => number;
  private readonly processWriteLock: ProcessWriteLock | null;
  private readonly vaultBasePath: string | null;
  private leaseId: string | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    options: ChatStoreLeaseOptions = {},
  ) {
    this.instanceId = options.instanceId?.trim() || createId('ailu');
    this.pid = normalizePid(options.pid);
    this.ttlMs = normalizeTtl(options.ttlMs);
    this.now = options.now ?? Date.now;
    this.vaultBasePath = options.vaultBasePath ? path.resolve(options.vaultBasePath) : null;
    this.processWriteLock = options.processWriteLock
      ?? (options.vaultBasePath ? new PythonFcntlProcessWriteLock(options.vaultBasePath) : null);
  }

  async acquire(): Promise<ChatStoreLeaseStatus> {
    if (this.processWriteLock && !(await this.processWriteLock.acquire())) {
      this.leaseId = null;
      const status = await this.inspectPersistedLease();
      return { ...status, mode: 'readOnly', leaseId: null };
    }
    try {
      return await this.acquirePersistedLease();
    } catch (error) {
      await this.processWriteLock?.release();
      throw error;
    }
  }

  private async acquirePersistedLease(): Promise<ChatStoreLeaseStatus> {
    const now = this.now();
    const candidateLeaseId = createId('lease');
    const currentLeaseId = this.leaseId;
    const record = await this.mutatePersistedLease(existing => {
      const ownsExisting = existing.state === 'held'
        && existing.instanceId === this.instanceId
        && existing.leaseId === currentLeaseId
        && existing.expiresAt > now;
      if (existing.state === 'held' && existing.expiresAt > now && !ownsExisting) {
        return serializeLeaseRecord(existing);
      }
      const leaseId = ownsExisting ? existing.leaseId : candidateLeaseId;
      const acquiredAt = ownsExisting ? existing.acquiredAt : now;
      return serializeLeaseRecord({
        version: 1,
        state: 'held',
        instanceId: this.instanceId,
        pid: this.pid,
        leaseId,
        acquiredAt,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      });
    });
    if (record.state === 'held'
      && record.instanceId === this.instanceId
      && (record.leaseId === currentLeaseId || record.leaseId === candidateLeaseId)
      && record.expiresAt > now) {
      this.leaseId = record.leaseId;
    } else {
      this.leaseId = null;
    }
    const status = statusFromRecord(record, this.instanceId, this.leaseId, now);
    if (status.mode !== 'writer') await this.processWriteLock?.release();
    return status;
  }

  async renew(): Promise<ChatStoreLeaseStatus> {
    const leaseId = this.leaseId;
    if (!leaseId) {
      return this.inspect();
    }
    let processFenceHeld = false;
    try {
      await this.processWriteLock?.assertHeld();
      processFenceHeld = this.processWriteLock !== null;
    } catch {
      this.leaseId = null;
      throw new ChatStoreLeaseLostError('Conversation writer process lock was lost.');
    }
    const now = this.now();
    const record = await this.mutatePersistedLease(existing => {
      if (existing.state !== 'held'
        || existing.instanceId !== this.instanceId
        || existing.leaseId !== leaseId
        || (!processFenceHeld && existing.expiresAt <= now)) {
        return serializeLeaseRecord(existing);
      }
      return serializeLeaseRecord({
        ...existing,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      });
    });
    if (record.state !== 'held'
      || record.instanceId !== this.instanceId
      || record.leaseId !== leaseId
      || (!processFenceHeld && record.expiresAt <= now)) {
      this.leaseId = null;
    }
    const status = statusFromRecord(
      record,
      this.instanceId,
      this.leaseId,
      now,
      processFenceHeld,
    );
    if (status.mode !== 'writer') await this.processWriteLock?.release();
    return status;
  }

  async release(): Promise<ChatStoreLeaseStatus> {
    const leaseId = this.leaseId;
    this.leaseId = null;
    if (!leaseId) {
      try {
        return await this.inspectPersistedLease();
      } finally {
        await this.processWriteLock?.release();
      }
    }
    try {
      const now = this.now();
      const record = await this.mutatePersistedLease(existing => {
        if (existing.state === 'held'
          && existing.instanceId === this.instanceId
          && existing.leaseId === leaseId) {
          return serializeLeaseRecord({ version: 1, state: 'released', releasedAt: now });
        }
        return serializeLeaseRecord(existing);
      });
      return statusFromRecord(record, this.instanceId, null, now);
    } finally {
      await this.processWriteLock?.release();
    }
  }

  async inspect(): Promise<ChatStoreLeaseStatus> {
    const hadLease = this.leaseId !== null;
    let processFenceHeld = false;
    if (this.leaseId && this.processWriteLock) {
      try {
        await this.processWriteLock.assertHeld();
        processFenceHeld = true;
      } catch {
        this.leaseId = null;
      }
    }
    const status = await this.inspectPersistedLease(processFenceHeld);
    if (hadLease && status.mode !== 'writer') await this.processWriteLock?.release();
    return status;
  }

  private async inspectPersistedLease(processFenceHeld = false): Promise<ChatStoreLeaseStatus> {
    if (!(await this.adapter.exists(CHAT_STORE_LEASE_PATH))) {
      return availableStatus(this.instanceId);
    }
    const now = this.now();
    const record = parseLeaseRecord(await this.adapter.read(CHAT_STORE_LEASE_PATH));
    if (record.state !== 'held'
      || record.instanceId !== this.instanceId
      || record.leaseId !== this.leaseId
      || (!processFenceHeld && record.expiresAt <= now)) {
      this.leaseId = null;
    }
    return statusFromRecord(
      record,
      this.instanceId,
      this.leaseId,
      now,
      processFenceHeld,
    );
  }

  /** Re-reads the persisted lease immediately before a protected write. */
  async assertOwned(): Promise<void> {
    const leaseId = this.leaseId;
    if (!leaseId) throw new ChatStoreLeaseLostError();
    let processFenceHeld = false;
    try {
      await this.processWriteLock?.assertHeld();
      processFenceHeld = this.processWriteLock !== null;
    } catch {
      this.leaseId = null;
      throw new ChatStoreLeaseLostError('Conversation writer process lock was lost.');
    }
    const now = this.now();
    const raw = await this.readPersistedLeaseThroughFence();
    if (raw === null) {
      this.leaseId = null;
      await this.processWriteLock?.release();
      throw new ChatStoreLeaseLostError();
    }
    const record = parseLeaseRecord(raw);
    if (record.state !== 'held'
      || record.instanceId !== this.instanceId
      || record.leaseId !== leaseId
      || (!processFenceHeld && record.expiresAt <= now)) {
      this.leaseId = null;
      await this.processWriteLock?.release();
      throw new ChatStoreLeaseLostError();
    }
  }

  /**
   * Performs a text-file CAS while this exact lease and process fence are held.
   * Production callers use the Python helper so lease validation and the final
   * filesystem replacement cannot be separated by another plugin writer.
   */
  async compareAndSwapTextFile(
    vaultRelativePath: string,
    expectedRaw: string | null,
    nextRaw: string,
  ): Promise<boolean> {
    assertAdapterRelativePath(vaultRelativePath);
    await this.assertOwned();
    const physicalLock = asPhysicalCasLock(this.processWriteLock);
    if (physicalLock) {
      const result = await physicalLock.compareAndSwapTextFile(
        vaultRelativePath,
        expectedRaw,
        nextRaw,
      );
      return result.swapped;
    }

    // Compatibility path for deterministic tests and hosts that inject the
    // legacy ProcessWriteLock shape. Production vaults always use the helper.
    await ensureDirectory(this.adapter, adapterParentPath(vaultRelativePath));
    if (expectedRaw === null) {
      if (await this.adapter.exists(vaultRelativePath)) return false;
      const stagingPath = `${vaultRelativePath}.${this.instanceId}.${createId('cas')}.tmp`;
      // Keep each uniquely named sidecar as recovery evidence. This fallback
      // deliberately never calls a destructive adapter API.
      await this.adapter.write(stagingPath, nextRaw);
      await this.hardenFallbackTempFile(stagingPath);
      await this.assertOwned();
      try {
        await this.adapter.copy(stagingPath, vaultRelativePath);
        return true;
      } catch (error) {
        if (await this.adapter.exists(vaultRelativePath)) return false;
        throw error;
      }
    }
    if (!(await this.adapter.exists(vaultRelativePath))) return false;
    await this.assertOwned();
    try {
      await this.adapter.process(vaultRelativePath, currentRaw => {
        if (currentRaw !== expectedRaw) throw new AdapterCasMismatchError();
        return nextRaw;
      });
      return true;
    } catch (error) {
      if (error instanceof AdapterCasMismatchError) return false;
      throw error;
    }
  }

  /** Reads a target through the same physical fence used by CAS when available. */
  async readTextFile(vaultRelativePath: string): Promise<string | null> {
    assertAdapterRelativePath(vaultRelativePath);
    await this.assertOwned();
    const physicalLock = asPhysicalCasLock(this.processWriteLock);
    if (physicalLock) return physicalLock.readTextFile(vaultRelativePath);
    if (!(await this.adapter.exists(vaultRelativePath))) return null;
    return this.adapter.read(vaultRelativePath);
  }

  private async hardenFallbackTempFile(vaultRelativePath: string): Promise<void> {
    if (!this.vaultBasePath || process.platform === 'win32') return;
    const canonicalRoot = path.resolve(this.vaultBasePath, STORAGE_IDS.vaultDirectoryName);
    const target = path.resolve(this.vaultBasePath, vaultRelativePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new ChatStoreLeaseError('Conversation CAS temp path escaped Ailu storage.');
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ChatStoreLeaseError('Conversation CAS temp path has an unsafe type.');
    }
    await fs.chmod(target, 0o600);
  }

  private async mutatePersistedLease(
    update: (existing: LeaseRecord) => string,
  ): Promise<LeaseRecord> {
    const physicalLock = asPhysicalCasLock(this.processWriteLock);
    if (!physicalLock) {
      await this.ensureLeaseFile();
      const raw = await this.adapter.process(CHAT_STORE_LEASE_PATH, existingRaw => (
        update(parseLeaseRecord(existingRaw))
      ));
      return parseLeaseRecord(raw);
    }
    for (let attempt = 0; attempt < MAX_PHYSICAL_CAS_ATTEMPTS; attempt += 1) {
      await physicalLock.assertHeld();
      const existingRaw = await physicalLock.readTextFile(CHAT_STORE_LEASE_PATH);
      const existing = existingRaw === null
        ? { version: 1, state: 'released', releasedAt: 0 } as const
        : parseLeaseRecord(existingRaw);
      const replacement = update(existing);
      if (existingRaw === replacement) return existing;
      const result = await physicalLock.compareAndSwapTextFile(
        CHAT_STORE_LEASE_PATH,
        existingRaw,
        replacement,
      );
      if (result.swapped) return parseLeaseRecord(replacement);
    }
    this.leaseId = null;
    throw new ChatStoreLeaseLostError(
      'Conversation writer lease changed repeatedly during fenced physical CAS.',
    );
  }

  private async readPersistedLeaseThroughFence(): Promise<string | null> {
    const physicalLock = asPhysicalCasLock(this.processWriteLock);
    if (physicalLock) return physicalLock.readTextFile(CHAT_STORE_LEASE_PATH);
    if (!(await this.adapter.exists(CHAT_STORE_LEASE_PATH))) return null;
    return this.adapter.read(CHAT_STORE_LEASE_PATH);
  }

  private async ensureLeaseFile(): Promise<void> {
    await ensureDirectory(this.adapter, STORAGE_IDS.vaultDirectoryName);
    if (await this.adapter.exists(CHAT_STORE_LEASE_PATH)) return;

    // Every contender writes the same inert seed. `copy` is the exclusive
    // creation primitive because DataAdapter guarantees it fails if the
    // destination already exists.
    const seed = serializeLeaseRecord({ version: 1, state: 'released', releasedAt: 0 });
    await this.adapter.write(CHAT_STORE_LEASE_SEED_PATH, seed);
    try {
      await this.adapter.copy(CHAT_STORE_LEASE_SEED_PATH, CHAT_STORE_LEASE_PATH);
    } catch (error) {
      if (!(await this.adapter.exists(CHAT_STORE_LEASE_PATH))) throw error;
    }
  }
}

class AdapterCasMismatchError extends Error {}

type PhysicalCasProcessWriteLock = ProcessWriteLock & {
  readTextFile(vaultRelativePath: string): Promise<string | null>;
  compareAndSwapTextFile(
    vaultRelativePath: string,
    expected: string | null,
    replacement: string,
  ): Promise<{ swapped: boolean; value: string | null }>;
};

function asPhysicalCasLock(
  lock: ProcessWriteLock | null,
): PhysicalCasProcessWriteLock | null {
  return lock
    && typeof lock.readTextFile === 'function'
    && typeof lock.compareAndSwapTextFile === 'function'
    ? lock as PhysicalCasProcessWriteLock
    : null;
}

function assertAdapterRelativePath(value: string): void {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (!normalized
    || normalized.startsWith('/')
    || normalized.includes('\0')
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ChatStoreLeaseError('Conversation fenced CAS requires a vault-relative path.');
  }
}

function adapterParentPath(value: string): string {
  const index = value.lastIndexOf('/');
  return index < 0 ? STORAGE_IDS.vaultDirectoryName : value.slice(0, index);
}

function normalizeTtl(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  if (!Number.isFinite(value) || value < 1_000) {
    throw new ChatStoreLeaseError('Conversation writer lease TTL must be at least 1000 ms.');
  }
  return Math.floor(value);
}

function serializeLeaseRecord(record: LeaseRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function parseLeaseRecord(raw: string): LeaseRecord {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1) throw new Error('invalid lease envelope');
    if (value.state === 'released' && isFiniteTimestamp(value.releasedAt)) {
      return { version: 1, state: 'released', releasedAt: value.releasedAt };
    }
    if (value.state === 'held'
      && isNonEmptyString(value.instanceId)
      && isNonNegativeInteger(value.pid)
      && isNonEmptyString(value.leaseId)
      && isFiniteTimestamp(value.acquiredAt)
      && isFiniteTimestamp(value.heartbeatAt)
      && isFiniteTimestamp(value.expiresAt)
      && value.acquiredAt <= value.heartbeatAt
      && value.heartbeatAt < value.expiresAt) {
      return {
        version: 1,
        state: 'held',
        instanceId: value.instanceId,
        pid: value.pid,
        leaseId: value.leaseId,
        acquiredAt: value.acquiredAt,
        heartbeatAt: value.heartbeatAt,
        expiresAt: value.expiresAt,
      };
    }
  } catch (error) {
    if (error instanceof ChatStoreLeaseCorruptError) throw error;
  }
  throw new ChatStoreLeaseCorruptError();
}

function statusFromRecord(
  record: LeaseRecord,
  instanceId: string,
  localLeaseId: string | null,
  now: number,
  processFenceHeld = false,
): ChatStoreLeaseStatus {
  if (record.state === 'released') {
    return availableStatus(instanceId);
  }
  const isWriter = record.instanceId === instanceId && record.leaseId === localLeaseId;
  // Date.now() advances while macOS is asleep, but the fcntl helper keeps its
  // descriptor and exclusive lock. In that case the physical fence—not the
  // missed wall-clock heartbeat—is the authoritative ownership signal.
  if (record.expiresAt <= now && !(processFenceHeld && isWriter)) {
    return availableStatus(instanceId);
  }
  return {
    mode: isWriter ? 'writer' : 'readOnly',
    instanceId,
    leaseId: isWriter ? record.leaseId : null,
    ownerInstanceId: record.instanceId,
    ownerPid: record.pid,
    heartbeatAt: record.heartbeatAt,
    expiresAt: record.expiresAt,
  };
}

function availableStatus(instanceId: string): ChatStoreLeaseStatus {
  return {
    mode: 'available',
    instanceId,
    leaseId: null,
    ownerInstanceId: null,
    ownerPid: null,
    heartbeatAt: null,
    expiresAt: null,
  };
}

async function ensureDirectory(adapter: DataAdapter, directory: string): Promise<void> {
  if (await adapter.exists(directory)) return;
  try {
    await adapter.mkdir(directory);
  } catch (error) {
    if (!(await adapter.exists(directory))) throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function normalizePid(value: number | undefined): number {
  const fallback = typeof process === 'undefined' ? 0 : process.pid;
  const pid = value ?? fallback;
  if (!isNonNegativeInteger(pid)) {
    throw new ChatStoreLeaseError('Conversation writer lease PID must be a non-negative integer.');
  }
  return pid;
}
