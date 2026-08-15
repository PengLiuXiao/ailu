import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import type { SecretStorage } from 'obsidian';

import { SECRET_IDS } from '../ids';
import { providersPath } from '../paths';
import type { ProcessWriteLock } from './processWriteLock';
import type {
  AgentId,
  AnthropicAuthMode,
  ExportedProviderProfile,
  ProviderProfile,
  ProviderWireApi,
} from '../types';
import { createId } from '../utils/id';
import { inferAnthropicAuthMode, normalizeProviderBaseUrl } from '../utils/providerAuth';
import { recordFromUnknown } from '../utils/records';

interface StoredProviderProfile extends ProviderProfile {
  /** Pointer to an immutable versioned SecretStorage entry; omitted for v1 data. */
  secretRef?: string | null;
}

interface ProviderStoreFile {
  version: 1;
  profiles: StoredProviderProfile[];
}

export interface ProviderProfileInput {
  agentId: AgentId;
  id?: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  models?: string[];
  wireApi?: ProviderWireApi;
  anthropicAuthMode?: AnthropicAuthMode;
  isDefault?: boolean;
}

export interface ProviderStoreOptions {
  canWrite?: () => boolean;
  /** The single long-lived ~/.ailu Home owner; all mutations fail without it. */
  processWriteLock?: ProcessWriteLock;
}

interface ProviderWriteSnapshot {
  raw: string | null;
  store: ProviderStoreFile;
  secretValues: Map<string, string>;
  profileSecretIds: Map<string, string>;
  journalRaw: string | null;
}

const PROVIDERS_RELATIVE_PATH = 'providers.json';
const PROVIDER_TRANSACTION_RELATIVE_PATH = 'provider-transaction.json';

function normalizeModels(models: unknown, activeModel: string): string[] {
  const list = Array.isArray(models)
    ? models.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : [];
  if (activeModel && !list.includes(activeModel)) {
    list.unshift(activeModel);
  }
  return [...new Set(list)];
}

function inferWireApi(baseUrl: string, explicit?: unknown): ProviderWireApi {
  if (explicit === 'responses' || explicit === 'chat') {
    return explicit;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com' ? 'responses' : 'chat';
  } catch {
    return 'chat';
  }
}

function normalizeProfile(profile: ProviderProfile): ProviderProfile {
  const defaultModel = (profile.defaultModel ?? profile.model ?? '').trim();
  const baseUrl = normalizeProviderBaseUrl(profile.baseUrl ?? '');
  return {
    id: profile.id,
    agentId: profile.agentId,
    name: profile.name,
    apiKey: profile.apiKey ?? '',
    baseUrl,
    model: defaultModel,
    defaultModel,
    models: normalizeModels(profile.models, defaultModel),
    wireApi: inferWireApi(baseUrl, profile.wireApi),
    anthropicAuthMode: inferAnthropicAuthMode(
      profile.agentId,
      profile.name,
      baseUrl,
      profile.anthropicAuthMode,
    ),
    isDefault: Boolean(profile.isDefault),
    createdAt: Number(profile.createdAt) || Date.now(),
    updatedAt: Number(profile.updatedAt) || Date.now(),
  };
}

/**
 * Keeps a legacy unsafe endpoint visible in Settings so the owner can repair
 * or replace it, while every executable lookup continues to fail closed.
 * Never use this helper at a network/process boundary.
 */
function normalizeProfileForRepair(profile: ProviderProfile): ProviderProfile {
  try {
    return normalizeProfile(profile);
  } catch (error) {
    const defaultModel = (profile.defaultModel ?? profile.model ?? '').trim();
    const baseUrl = typeof profile.baseUrl === 'string' ? profile.baseUrl.trim() : '';
    return {
      id: profile.id,
      agentId: profile.agentId,
      name: typeof profile.name === 'string' ? profile.name : '',
      apiKey: profile.apiKey ?? '',
      baseUrl,
      model: defaultModel,
      defaultModel,
      models: normalizeModels(profile.models, defaultModel),
      wireApi: profile.wireApi === 'responses' ? 'responses' : 'chat',
      anthropicAuthMode: profile.anthropicAuthMode === 'apiKey' ? 'apiKey' : 'authToken',
      isDefault: Boolean(profile.isDefault),
      createdAt: Number(profile.createdAt) || Date.now(),
      updatedAt: Number(profile.updatedAt) || Date.now(),
      configurationError: errorMessage(error),
    };
  }
}

function cloneProfile(profile: ProviderProfile): ProviderProfile {
  return { ...profile, models: [...profile.models] };
}

interface ProviderReadCache {
  mtimeMs: number;
  size: number;
  profiles: ProviderProfile[];
}

export class ProviderStore {
  // list()/find() are called several times per UI render and each read hits the
  // disk synchronously, so cache the parsed file keyed on its stat signature.
  private readCache: ProviderReadCache | null = null;

  constructor(
    private readonly secrets: Pick<SecretStorage, 'getSecret' | 'setSecret'>,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly options: ProviderStoreOptions = {},
  ) {}

  get path(): string {
    return providersPath(this.env);
  }

  /** Resolves a crash-left provider journal while the global Home fence is held. */
  async recoverInterruptedTransaction(): Promise<void> {
    const lock = this.requirePhysicalWriteLock();
    await lock.assertHeld();
    const raw = await lock.readTextFile(PROVIDER_TRANSACTION_RELATIVE_PATH);
    if (!raw?.trim()) return;
    const journal = parseProviderTransaction(raw);
    const metadataRaw = await lock.readTextFile(PROVIDERS_RELATIVE_PATH);
    const metadataHash = nullableTextHash(metadataRaw);
    if (journal.state === 'committed') {
      if (metadataHash !== journal.metadata_after_sha256) {
        throw new Error('Ailu committed provider journal does not match the current metadata generation.');
      }
      this.assertJournalSecrets(journal, 'after');
      this.assertCanonicalSecretPointers(metadataRaw);
      return;
    }
    if (journal.state === 'aborted') {
      if (metadataHash !== journal.metadata_before_sha256) {
        throw new Error('Ailu aborted provider journal does not match the preserved metadata generation.');
      }
      this.assertJournalSecrets(journal, 'before-or-after');
      return;
    }
    if (journal.state !== 'prepared') {
      throw new Error('Ailu provider transaction requires operator recovery.');
    }
    let nextState: 'committed' | 'aborted';
    if (metadataHash === journal.metadata_before_sha256) {
      nextState = 'aborted';
    } else if (metadataHash === journal.metadata_after_sha256) {
      for (const update of journal.secret_updates) {
        if (nullableTextHash(this.readSecretStrict(update.id)) !== update.after_sha256) {
          throw new Error('Ailu provider transaction metadata committed with an unverifiable secret.');
        }
      }
      nextState = 'committed';
    } else {
      throw new Error('Ailu provider transaction metadata has an unknown generation.');
    }
    const replacement = `${JSON.stringify({ ...journal, state: nextState }, null, 2)}\n`;
    const swapped = await lock.compareAndSwapTextFile(
      PROVIDER_TRANSACTION_RELATIVE_PATH,
      raw,
      replacement,
    );
    if (!swapped.swapped) {
      throw new Error('Ailu provider transaction changed during recovery.');
    }
  }

  /**
   * Upgrades the pre-secretRef provider schema while the physical Home fence is
   * held. The legacy canonical secret is copied into a new immutable
   * generation through the same journaled metadata/SecretStorage transaction;
   * the old generation remains untouched as recovery evidence.
   */
  async migrateLegacySecretPointers(): Promise<void> {
    const lock = this.requirePhysicalWriteLock();
    await lock.assertHeld();
    const journalRaw = await lock.readTextFile(PROVIDER_TRANSACTION_RELATIVE_PATH);
    assertNoPreparedProviderTransaction(journalRaw);
    const raw = await lock.readTextFile(PROVIDERS_RELATIVE_PATH);
    const diskStore = parseProviderStore(raw);
    if (!diskStore.profiles.some(profile => !Object.hasOwn(profile, 'secretRef'))) return;

    const secretValues = new Map<string, string>();
    const profileSecretIds = new Map<string, string>();
    const profiles = diskStore.profiles.map((stored) => {
      let secretId: string | null = null;
      if (validProviderSecretRef(stored.secretRef)) {
        secretId = stored.secretRef;
      } else if (!Object.hasOwn(stored, 'secretRef')) {
        secretId = this.apiKeySecretId(stored.id);
      }
      const apiKey = secretId ? this.readSecretStrict(secretId) : '';
      if (secretId) {
        secretValues.set(secretId, apiKey);
        profileSecretIds.set(stored.id, secretId);
      }
      return { ...normalizeProfileForRepair(stored), apiKey };
    });
    const snapshot: ProviderWriteSnapshot = {
      raw,
      journalRaw,
      secretValues,
      profileSecretIds,
      store: { version: 1, profiles },
    };
    await this.write(snapshot, snapshot.store, [], { requireUiWritePermission: false });
  }

  /** Completed-identity audit: metadata pointers and referenced secrets agree. */
  async auditCanonicalSecretPointers(): Promise<void> {
    const lock = this.requirePhysicalWriteLock();
    await lock.assertHeld();
    const raw = await lock.readTextFile(PROVIDERS_RELATIVE_PATH);
    this.assertCanonicalSecretPointers(raw);
  }

  list(agentId?: AgentId): ProviderProfile[] {
    const profiles = this.read().profiles.map(normalizeProfileForRepair);
    return agentId ? profiles.filter(profile => profile.agentId === agentId) : profiles;
  }

  find(agentId: AgentId, idOrName?: string): ProviderProfile | null {
    const profiles = this.list(agentId);
    if (idOrName?.trim()) {
      const needle = idOrName.trim();
      return profiles.find(profile => !profile.configurationError
        && (profile.id === needle || profile.name === needle)) ?? null;
    }
    const executable = profiles.filter(profile => !profile.configurationError);
    return executable.find(profile => profile.isDefault) ?? executable[0] ?? null;
  }

  async save(input: ProviderProfileInput): Promise<ProviderProfile> {
    const snapshot = await this.readForWrite();
    const store = snapshot.store;
    const profile = this.applyProfileInput(store, input);
    await this.write(snapshot, store);
    return profile;
  }

  async remove(id: string): Promise<ProviderProfile | null> {
    const snapshot = await this.readForWrite();
    const store = snapshot.store;
    const index = store.profiles.findIndex(profile => profile.id === id);
    if (index < 0) return null;
    const [removed] = store.profiles.splice(index, 1);
    const siblings = store.profiles.filter(profile => profile.agentId === removed.agentId);
    if (removed.isDefault && siblings.length > 0 && !siblings.some(profile => profile.isDefault)) {
      siblings[0].isDefault = true;
    }
    await this.write(snapshot, store, [removed.id]);
    return removed;
  }

  async setActiveModel(id: string, model: string): Promise<ProviderProfile> {
    const snapshot = await this.readForWrite();
    const store = snapshot.store;
    const target = store.profiles.find(profile => profile.id === id);
    if (!target) {
      throw new Error(`Provider profile not found: ${id}`);
    }
    if (target.configurationError) {
      throw new Error('Unsafe legacy provider URL must be repaired before this profile can be activated.');
    }
    target.model = model.trim();
    target.defaultModel = target.model;
    target.models = normalizeModels(target.models, target.defaultModel);
    target.updatedAt = Date.now();
    await this.write(snapshot, store);
    return normalizeProfile(target);
  }

  async setDefault(agentId: AgentId, id: string): Promise<ProviderProfile> {
    const snapshot = await this.readForWrite();
    const store = snapshot.store;
    const target = store.profiles.find(profile => profile.agentId === agentId && profile.id === id);
    if (!target) {
      throw new Error(`Provider profile not found: ${id}`);
    }
    if (target.configurationError) {
      throw new Error('Unsafe legacy provider URL must be repaired before this profile can be activated.');
    }
    for (const profile of store.profiles) {
      if (profile.agentId === agentId) {
        profile.isDefault = profile.id === id;
        profile.updatedAt = Date.now();
      }
    }
    await this.write(snapshot, store);
    return target;
  }

  exportProfiles(): ExportedProviderProfile[] {
    return this.list().map(profile => {
      return {
        id: profile.id,
        agentId: profile.agentId,
        name: profile.name,
        // A quarantined legacy URL may itself contain userinfo or query-owned
        // credentials. Keep it local for repair, never place it on clipboard.
        baseUrl: profile.configurationError ? '' : profile.baseUrl,
        model: profile.model,
        defaultModel: profile.defaultModel,
        models: profile.models,
        wireApi: profile.wireApi,
        anthropicAuthMode: profile.anthropicAuthMode,
        isDefault: profile.isDefault,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        apiKey: '',
        apiKeyRedacted: Boolean(profile.apiKey),
      };
    });
  }

  async importProfiles(value: unknown): Promise<ProviderProfile[]> {
    if (!Array.isArray(value)) {
      throw new Error('Provider profile import must be a JSON array.');
    }
    const inputs: ProviderProfileInput[] = [];
    for (const [index, valueEntry] of value.entries()) {
      const profile = recordFromUnknown(valueEntry);
      if (!profile) {
        throw new Error(`Provider profile ${index + 1} must be a JSON object.`);
      }
      const agentId = profile.agentId;
      if (agentId !== 'claude' && agentId !== 'codex') {
        throw new Error(`Provider profile ${index + 1} has an invalid agentId.`);
      }
      if (typeof profile.name !== 'string' || !profile.name.trim()) {
        throw new Error(`Provider profile ${index + 1} requires a name.`);
      }
      const wireApi = profile.wireApi === 'responses' || profile.wireApi === 'chat'
        ? profile.wireApi
        : undefined;
      const anthropicAuthMode = profile.anthropicAuthMode === 'apiKey' || profile.anthropicAuthMode === 'authToken'
        ? profile.anthropicAuthMode
        : undefined;
      const models = Array.isArray(profile.models)
        ? profile.models.filter((model): model is string => typeof model === 'string')
        : undefined;
      inputs.push({
        agentId,
        id: typeof profile.id === 'string' ? profile.id : undefined,
        name: profile.name,
        apiKey: profile.apiKeyRedacted === true
          ? ''
          : typeof profile.apiKey === 'string' ? profile.apiKey : '',
        baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : '',
        model: typeof profile.model === 'string' ? profile.model : '',
        defaultModel: typeof profile.defaultModel === 'string' ? profile.defaultModel : '',
        models,
        wireApi,
        anthropicAuthMode,
        isDefault: profile.isDefault === true,
      });
    }
    const snapshot = await this.readForWrite();
    const store = snapshot.store;
    const imported: ProviderProfile[] = [];
    for (const input of inputs) {
      imported.push(this.applyProfileInput(store, input));
    }
    await this.write(snapshot, store);
    return imported;
  }

  private applyProfileInput(store: ProviderStoreFile, input: ProviderProfileInput): ProviderProfile {
    const now = Date.now();
    const id = input.id?.trim() || createId('profile');
    const existingIndex = store.profiles.findIndex(item => item.id === id);
    const existing = existingIndex >= 0 ? store.profiles[existingIndex] : undefined;
    const defaultModel = (input.defaultModel ?? input.model ?? '').trim();
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl ?? '');
    const profile: ProviderProfile = {
      id,
      agentId: input.agentId,
      name: input.name.trim(),
      apiKey: input.apiKey ?? existing?.apiKey ?? '',
      baseUrl,
      model: defaultModel,
      defaultModel,
      models: normalizeModels(input.models, defaultModel),
      wireApi: inferWireApi(baseUrl, input.wireApi),
      anthropicAuthMode: inferAnthropicAuthMode(
        input.agentId,
        input.name,
        baseUrl,
        input.anthropicAuthMode,
      ),
      isDefault: Boolean(input.isDefault),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (!profile.name) throw new Error('Provider profile name is required.');
    if (store.profiles.every(item => item.agentId !== profile.agentId || item.id === profile.id)) {
      profile.isDefault = true;
    }
    if (existingIndex >= 0) store.profiles[existingIndex] = profile;
    else store.profiles.push(profile);
    if (profile.isDefault) {
      for (const item of store.profiles) {
        if (item.agentId === profile.agentId && item.id !== profile.id) item.isDefault = false;
      }
    }
    assertUniqueProviderSecretIds(store.profiles);
    return profile;
  }

  private read(): ProviderStoreFile {
    this.assertNoPreparedTransaction();
    const stat = this.statStore();
    if (!stat) {
      this.readCache = null;
      return { version: 1, profiles: [] };
    }
    if (this.readCache && this.readCache.mtimeMs === stat.mtimeMs && this.readCache.size === stat.size) {
      return { version: 1, profiles: this.readCache.profiles.map(cloneProfile) };
    }
    const store = parseProviderStore(this.readRawStore());
    const profiles = store.profiles.map((stored) => {
      const profile = normalizeProfileForRepair(stored);
      const secretId = validProviderSecretRef(stored.secretRef)
        ? stored.secretRef
        : !Object.hasOwn(stored, 'secretRef')
          ? this.apiKeySecretId(stored.id)
          : null;
      const existingSecret = secretId ? this.readSecretForDisplay(secretId) : '';
      return { ...profile, apiKey: existingSecret };
    });
    assertUniqueProviderSecretIds(profiles);
    this.readCache = { mtimeMs: stat.mtimeMs, size: stat.size, profiles: profiles.map(cloneProfile) };
    return { version: 1, profiles };
  }

  private async readForWrite(): Promise<ProviderWriteSnapshot> {
    this.assertWritable();
    const lock = this.requirePhysicalWriteLock();
    await lock.assertHeld();
    const journalRaw = await lock.readTextFile(PROVIDER_TRANSACTION_RELATIVE_PATH);
    assertNoPreparedProviderTransaction(journalRaw);
    const raw = await lock.readTextFile(PROVIDERS_RELATIVE_PATH);
    const diskStore = parseProviderStore(raw);
    assertUniqueProviderSecretIds(diskStore.profiles);
    const secretValues = new Map<string, string>();
    const profileSecretIds = new Map<string, string>();
    const profiles = diskStore.profiles.map((stored) => {
      if (stored.secretRef === null) {
        return { ...normalizeProfileForRepair(stored), apiKey: '' };
      }
      if (!validProviderSecretRef(stored.secretRef)) {
        throw new Error(`AILU_PROVIDER_SECRET_POINTER_MISSING: ${stored.id} has no canonical credential pointer.`);
      }
      const secretId = stored.secretRef;
      const current = this.readSecretStrict(secretId);
      secretValues.set(secretId, current);
      profileSecretIds.set(stored.id, secretId);
      return {
        ...normalizeProfileForRepair(stored),
        apiKey: current,
      };
    });
    return { raw, journalRaw, secretValues, profileSecretIds, store: { version: 1, profiles } };
  }

  private async write(
    snapshot: ProviderWriteSnapshot,
    store: ProviderStoreFile,
    removedProfileIds: readonly string[] = [],
    options: { requireUiWritePermission?: boolean } = {},
  ): Promise<void> {
    if (options.requireUiWritePermission !== false) this.assertWritable();
    assertUniqueProviderSecretIds(store.profiles);
    const lock = this.requirePhysicalWriteLock();
    await lock.assertHeld();
    const currentJournal = await lock.readTextFile(PROVIDER_TRANSACTION_RELATIVE_PATH);
    if (currentJournal !== snapshot.journalRaw) {
      throw new Error('Ailu provider transaction journal changed concurrently; no data was written.');
    }
    assertNoPreparedProviderTransaction(currentJournal);
    const transactionId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const secretUpdates = new Map<string, { expected: string; replacement: string }>();
    const nextSecretRefs = new Map<string, string | null>();
    for (const profile of store.profiles) {
      const currentId = snapshot.profileSecretIds.get(profile.id) ?? this.apiKeySecretId(profile.id);
      const currentValue = snapshot.secretValues.has(currentId)
        ? snapshot.secretValues.get(currentId)!
        : this.readSecretStrict(currentId);
      if (!profile.apiKey) {
        // Clearing a credential only removes the metadata pointer. Old secret
        // generations are retained as recovery evidence and are never erased.
        nextSecretRefs.set(profile.id, null);
        continue;
      }
      if (profile.apiKey === currentValue
        && snapshot.profileSecretIds.has(profile.id)
        && validProviderSecretRef(currentId)) {
        nextSecretRefs.set(profile.id, currentId);
        continue;
      }
      const stagedId = providerVersionedSecretId(profile.id, transactionId);
      nextSecretRefs.set(profile.id, stagedId);
      secretUpdates.set(stagedId, { expected: this.readSecretStrict(stagedId), replacement: profile.apiKey });
    }
    // Removed profiles deliberately retain their unreferenced SecretStorage
    // value. Ailu never destroys credentials automatically; the metadata
    // pointer removal is the only authoritative state change.
    void removedProfileIds;
    for (const [id, update] of secretUpdates) {
      if (this.readSecretStrict(id) !== update.expected) {
        throw new Error('Ailu provider SecretStorage changed concurrently; no data was written.');
      }
    }
    const diskStore: ProviderStoreFile = {
      version: 1,
      profiles: store.profiles.map((profile) => {
        const secretRef = nextSecretRefs.get(profile.id);
        const storableProfile = { ...profile };
        delete storableProfile.configurationError;
        return {
          ...storableProfile,
          apiKey: '',
          secretRef: secretRef ?? null,
        };
      }),
    };
    const replacement = `${JSON.stringify(diskStore, null, 2)}\n`;
    const prepared = providerTransactionRecord({
      transactionId,
      state: 'prepared',
      expectedRaw: snapshot.raw,
      replacementRaw: replacement,
      updates: secretUpdates,
    });
    const preparedSwap = await lock.compareAndSwapTextFile(
      PROVIDER_TRANSACTION_RELATIVE_PATH,
      snapshot.journalRaw,
      prepared,
    );
    if (!preparedSwap.swapped) {
      throw new Error('Ailu provider transaction journal changed concurrently; no data was written.');
    }
    let metadataCommitted = false;
    try {
      for (const [id, update] of secretUpdates) {
        if (update.expected === update.replacement) continue;
        this.secrets.setSecret(id, update.replacement);
        if (this.readSecretStrict(id) !== update.replacement) {
          throw new Error('Ailu provider SecretStorage did not verify the requested update.');
        }
      }
      const swap = await lock.compareAndSwapTextFile(
        PROVIDERS_RELATIVE_PATH,
        snapshot.raw,
        replacement,
      );
      if (!swap.swapped) {
        throw new Error('Ailu provider store changed concurrently; no metadata was written.');
      }
      metadataCommitted = true;
      const committed = providerTransactionRecord({
        transactionId,
        state: 'committed',
        expectedRaw: snapshot.raw,
        replacementRaw: replacement,
        updates: secretUpdates,
      });
      const journalCommit = await lock.compareAndSwapTextFile(
        PROVIDER_TRANSACTION_RELATIVE_PATH,
        prepared,
        committed,
      );
      if (!journalCommit.swapped) {
        throw new Error(
          'Ailu provider metadata and secrets committed, but its journal could not be finalized; restart is blocked for recovery.',
        );
      }
    } catch (error) {
      if (!metadataCommitted) {
        const aborted = providerTransactionRecord({
          transactionId,
          state: 'aborted',
          expectedRaw: snapshot.raw,
          replacementRaw: replacement,
          updates: secretUpdates,
        });
        const journalAbort = await lock.compareAndSwapTextFile(
          PROVIDER_TRANSACTION_RELATIVE_PATH,
          prepared,
          aborted,
        ).catch(() => ({ swapped: false, value: prepared }));
        if (!journalAbort.swapped) {
          throw new Error(
            `Ailu provider transaction failed and requires operator recovery: ${errorMessage(error)}`,
          );
        }
      }
      throw error;
    }
    fs.chmodSync(path.dirname(this.path), 0o700);
    fs.chmodSync(this.path, 0o600);
    fs.chmodSync(path.join(path.dirname(this.path), PROVIDER_TRANSACTION_RELATIVE_PATH), 0o600);
    const stat = this.statStore();
    this.readCache = stat
      ? {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        profiles: store.profiles.map(profile => cloneProfile(normalizeProfileForRepair(profile))),
      }
      : null;
  }

  private statStore(): fs.Stats | null {
    try {
      return fs.statSync(this.path);
    } catch {
      return null;
    }
  }

  private readRawStore(): string | null {
    try {
      return fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.options.canWrite && !this.options.canWrite()) {
      throw new Error('Ailu provider settings are read-only because this instance does not own the writer fence.');
    }
  }

  private requirePhysicalWriteLock(): Required<Pick<
  ProcessWriteLock,
  'assertHeld' | 'readTextFile' | 'compareAndSwapTextFile'
  >> {
    const lock = this.options.processWriteLock;
    if (!lock?.readTextFile || !lock.compareAndSwapTextFile) {
      throw new Error('Ailu provider settings require the physical Home writer lock.');
    }
    return lock as Required<Pick<
    ProcessWriteLock,
    'assertHeld' | 'readTextFile' | 'compareAndSwapTextFile'
    >>;
  }

  private assertNoPreparedTransaction(): void {
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(path.join(path.dirname(this.path), PROVIDER_TRANSACTION_RELATIVE_PATH), 'utf8');
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    assertNoPreparedProviderTransaction(raw);
  }

  private apiKeySecretId(profileId: string): string {
    return SECRET_IDS.providerApiKey(profileId);
  }

  private readSecretStrict(id: string): string {
    return this.secrets.getSecret(id)?.trim() || '';
  }

  private readSecretForDisplay(id: string): string {
    try {
      return this.readSecretStrict(id);
    } catch {
      return '';
    }
  }

  private assertJournalSecrets(
    journal: ParsedProviderTransaction,
    expected: 'after' | 'before-or-after',
  ): void {
    for (const update of journal.secret_updates) {
      const currentHash = nullableTextHash(this.readSecretStrict(update.id));
      const valid = expected === 'after'
        ? currentHash === update.after_sha256
        : currentHash === update.before_sha256 || currentHash === update.after_sha256;
      if (!valid) {
        throw new Error('Ailu provider transaction journal references an unverifiable secret generation.');
      }
    }
  }

  private assertCanonicalSecretPointers(raw: string | null): void {
    const store = parseProviderStore(raw);
    const owners = new Map<string, string>();
    for (const profile of store.profiles) {
      if (profile.secretRef === null) continue;
      if (!profile.secretRef) {
        throw new Error(
          `AILU_PROVIDER_SECRET_POINTER_MISSING: ${profile.id} has no canonical credential pointer.`,
        );
      }
      const owner = owners.get(profile.secretRef);
      if (owner && owner !== profile.id) {
        throw new Error('AILU_PROVIDER_SECRET_POINTER_CONFLICT: profiles share one secret generation.');
      }
      owners.set(profile.secretRef, profile.id);
      if (!this.readSecretStrict(profile.secretRef)) {
        throw new Error(`AILU_PROVIDER_SECRET_MISSING: ${profile.id} points to an absent credential.`);
      }
    }
  }
}

function parseProviderStore(raw: string | null): ProviderStoreFile {
  if (raw === null || !raw.trim()) return { version: 1, profiles: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Ailu provider store is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value as { version?: unknown }).version !== 1
    || !Array.isArray((value as { profiles?: unknown }).profiles)) {
    throw new Error('Ailu provider store has an unsupported schema.');
  }
  const profiles = (value as { profiles: unknown[] }).profiles;
  for (const candidate of profiles) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof (candidate as { id?: unknown }).id !== 'string'
      || !(candidate as { id: string }).id.trim()
      || ((candidate as { agentId?: unknown }).agentId !== 'claude'
        && (candidate as { agentId?: unknown }).agentId !== 'codex')) {
      throw new Error('Ailu provider store contains an invalid profile.');
    }
  }
  return {
    version: 1,
    profiles: profiles.map((profile) => {
      const candidate = profile as ProviderProfile & { secretRef?: unknown };
      const normalized: StoredProviderProfile = normalizeProfileForRepair(candidate);
      if (Object.hasOwn(candidate, 'secretRef')) {
        if (candidate.secretRef === null) {
          normalized.secretRef = null;
        } else if (!validProviderSecretRef(candidate.secretRef)) {
          throw new Error('Ailu provider store contains an invalid secretRef.');
        } else {
          normalized.secretRef = candidate.secretRef;
        }
      }
      return normalized;
    }),
  };
}

function assertUniqueProviderSecretIds(profiles: readonly ProviderProfile[]): void {
  const owners = new Map<string, string>();
  for (const profile of profiles) {
    const secretId = SECRET_IDS.providerApiKey(profile.id);
    const owner = owners.get(secretId);
    if (owner && owner !== profile.id) {
      throw new Error(
        `PROVIDER_SECRET_ID_CONFLICT: provider IDs ${owner} and ${profile.id} map to the same canonical secret.`,
      );
    }
    owners.set(secretId, profile.id);
  }
}

function validProviderSecretRef(value: unknown): value is string {
  return typeof value === 'string'
    && /^ailu-provider-secret-v2-[a-f0-9]{32,64}$/.test(value);
}

function providerVersionedSecretId(profileId: string, transactionId: string): string {
  const digest = createHash('sha256')
    .update(profileId)
    .update('\0')
    .update(transactionId)
    .digest('hex');
  return `ailu-provider-secret-v2-${digest}`.slice(0, 64);
}

function providerTransactionRecord(options: {
  transactionId: string;
  state: 'prepared' | 'committed' | 'aborted' | 'recovery_required';
  expectedRaw: string | null;
  replacementRaw: string;
  updates: ReadonlyMap<string, { expected: string; replacement: string }>;
}): string {
  return `${JSON.stringify({
    schema_version: 1,
    transaction_id: options.transactionId,
    state: options.state,
    metadata_before_sha256: nullableTextHash(options.expectedRaw),
    metadata_after_sha256: nullableTextHash(options.replacementRaw),
    secret_updates: [...options.updates.entries()].map(([id, update]) => ({
      id,
      before_sha256: nullableTextHash(update.expected),
      after_sha256: nullableTextHash(update.replacement),
    })),
    contains_secret_values: false,
  }, null, 2)}\n`;
}

interface ParsedProviderTransaction {
  schema_version: 1;
  transaction_id: string;
  state: 'prepared' | 'committed' | 'aborted' | 'recovery_required';
  metadata_before_sha256: string;
  metadata_after_sha256: string;
  secret_updates: Array<{ id: string; before_sha256: string; after_sha256: string }>;
  contains_secret_values: false;
}

function parseProviderTransaction(raw: string): ParsedProviderTransaction {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Ailu provider transaction journal is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ailu provider transaction journal is invalid.');
  }
  const record = value as Partial<ParsedProviderTransaction>;
  if (record.schema_version !== 1
    || typeof record.transaction_id !== 'string'
    || !['prepared', 'committed', 'aborted', 'recovery_required'].includes(String(record.state))
    || !isSha256(record.metadata_before_sha256)
    || !isSha256(record.metadata_after_sha256)
    || record.contains_secret_values !== false
    || !Array.isArray(record.secret_updates)) {
    throw new Error('Ailu provider transaction journal is invalid.');
  }
  for (const update of record.secret_updates) {
    if (!update || typeof update !== 'object'
      || typeof update.id !== 'string'
      || !validProviderSecretRef(update.id)
      || !isSha256(update.before_sha256)
      || !isSha256(update.after_sha256)) {
      throw new Error('Ailu provider transaction journal is invalid.');
    }
  }
  return record as ParsedProviderTransaction;
}

function nullableTextHash(value: string | null): string {
  return createHash('sha256')
    .update(value === null ? 'absent\0' : `value\0${value}`)
    .digest('hex');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function assertNoPreparedProviderTransaction(raw: string | null): void {
  if (!raw?.trim()) return;
  const state = parseProviderTransaction(raw).state;
  if (state !== 'committed' && state !== 'aborted') {
    throw new Error('Ailu provider transaction requires recovery; provider access is disabled.');
  }
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
