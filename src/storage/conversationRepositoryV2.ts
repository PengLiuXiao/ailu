import { createHash } from 'crypto';

import type { DataAdapter } from 'obsidian';

import { DEFAULT_CONVERSATION_TITLE, STORAGE_IDS } from '../ids';
import type {
  AgentId,
  ChatArtifact,
  ChatMessage,
  ChatMessageMetadata,
  ChatToolLifecycleContentMetadata,
  ConversationContextCheckpoint,
  ConversationContextCheckpointDraft,
  MemorySnapshotReference,
  MessageRole,
  StoredConversation,
} from '../types';
import { createId } from '../utils/id';
import {
  ConversationRevisionConflictError,
  ConversationSessionConflictError,
  ConversationStoreAtomicWriteError,
  ConversationStoreCorruptError,
  ConversationStoreMigrationError,
  ConversationTurnStateError,
  type ConversationSessionOwner,
} from './conversationStoreErrors';
import type {
  BeginTurnInput,
  CancelTurnInput,
  ChatMessagePatch,
  CommitContextCheckpointInput,
  ContextCheckpointMutationResult,
  ConversationSessionClaimInput,
  ConversationRuntimeSnapshot,
  ConversationArchiveMutationResult,
  ConversationMutationInput,
  ConversationRecoveryResult,
  FinalizeTurnInput,
  MessageMutationResult,
  PatchMessageInput,
  PatchSessionInput,
  PendingConversationTurn,
  SessionMutationResult,
  StoredConversationTurn,
  TurnMutationResult,
  VersionedStoredConversation,
} from './vaultStore';

export const CHAT_STORE_POINTER_PATH = `${STORAGE_IDS.vaultDirectoryName}/chat-store.json`;
export const CHAT_V2_FORMAT_VERSION = 2;
export const CHAT_V2_MESSAGE_CHUNK_SIZE = 100;
export const CHAT_V2_MAX_MESSAGE_CONTENT_BYTES = 4 * 1024 * 1024;
export const CHAT_V2_MAX_MESSAGE_METADATA_BYTES = 512 * 1024;
export const CHAT_V2_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const CHAT_V2_MAX_MESSAGE_CHUNK_BYTES = 64 * 1024 * 1024;
export const CHAT_V2_MAX_MESSAGE_WINDOW_BYTES = 64 * 1024 * 1024;
export const CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES = 128 * 1024 * 1024;

const CATALOG_PATH = 'catalog.json';
const MANIFEST_PATH = 'manifest.json';
const ROLLBACK_V1_PATH = 'rollback/conversations.v1.json';
const CONVERSATIONS_DIRECTORY = 'conversations';
const META_PATH = 'meta.json';
const RUN_STATE_PATH = 'run-state.json';
const DRAFT_PATH = 'draft.json';
const SNAPSHOT_PATH = 'snapshot.json';
const JOURNALS_DIRECTORY = 'journals';
const MESSAGES_DIRECTORY = 'messages';
const SESSION_OWNER_INDEX_PATH = 'session-owner-index.json';
const SESSION_OWNER_INDEXES_DIRECTORY = 'session-owner-indexes';
const SESSION_OWNER_BUCKETS_DIRECTORY = 'buckets';
const SESSION_OWNER_BUCKET_COUNT = 256;
const MAX_PAGE_SIZE = 500;
const MAX_SEARCH_TEXT_CHARS = 16_384;
const MAX_CATALOG_READ_EPOCH_ATTEMPTS = 4;
const MAX_METADATA_ARTIFACTS = 64;
const MAX_METADATA_MEMORY_REFERENCES = 64;
const MAX_METADATA_POLICY_WARNINGS = 128;
const MAX_TOOL_LIFECYCLE_SPANS = 4_096;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_JSON_METADATA_DEPTH = 32;
const MAX_JSON_METADATA_NODES = 20_000;
const MAX_JSON_METADATA_ARRAY_ITEMS = 4_096;
const MAX_JSON_METADATA_OBJECT_KEYS = 1_024;
const MAX_JSON_METADATA_STRING_BYTES = 256 * 1024;
const TOOL_LIFECYCLE_CONTENT_METADATA_KEY = 'ailuToolLifecycleContentV1';
const ALLOWED_CHAT_ARTIFACT_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type ConversationArchiveFilter = 'active' | 'archived' | 'all';

export interface ConversationSummary {
  id: string;
  title: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  revision: number;
  messageCount: number;
  turnCount: number;
  archivedAt: number | null;
  lastMessagePreview: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function withChecksum<T extends object>(value: T): Checksummed<T> {
  return { ...value, checksum: sha256(canonicalJson(value)) };
}

function parseChecksummed<T extends ChecksummedBase>(raw: string, source: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConversationStoreCorruptError(`${source} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || !isSha256(value.checksum)) {
    throw new ConversationStoreCorruptError(`${source} has no valid checksum.`);
  }
  const { checksum, ...unsigned } = value;
  if (sha256(canonicalJson(unsigned)) !== checksum) {
    throw new ConversationStoreCorruptError(`${source} checksum mismatch.`);
  }
  return value as T;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function generationId(sourceHash: string | null): string {
  return sourceHash === null ? 'empty-v2' : `v1-${sourceHash.slice(0, 24)}`;
}

function generationRootPath(generation: string): string {
  return `${STORAGE_IDS.vaultDirectoryName}/chat-v2-${generation}`;
}

function conversationDirectoryName(conversationId: string): string {
  return `conversation-${sha256(conversationId).slice(0, 32)}`;
}

function conversationFilePath(
  generationRoot: string,
  conversationId: string,
  relativePath: string,
): string {
  return joinPath(
    generationRoot,
    CONVERSATIONS_DIRECTORY,
    conversationDirectoryName(conversationId),
    relativePath,
  );
}

function joinPath(...parts: string[]): string {
  return parts.map((part, index) => (
    index === 0 ? part.replace(/\/+$/g, '') : part.replace(/^\/+|\/+$/g, '')
  )).filter(Boolean).join('/');
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'writer';
}

function isSafeGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function isSafeDirectoryName(value: string): boolean {
  return /^conversation-[a-f0-9]{32}$/.test(value);
}

function isSafeRelativeJournalPath(value: string): boolean {
  return /^journals\/[a-zA-Z0-9_-]+\.jsonl$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

async function ensureDirectory(adapter: DataAdapter, directory: string): Promise<void> {
  if (!directory) return;
  const parts = directory.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (!(await adapter.exists(current))) throw error;
    }
  }
}

async function readOptional(
  adapter: DataAdapter,
  path: string,
  maximumBytes?: number,
  source = 'persisted v2 file',
): Promise<string | null> {
  if (!(await adapter.exists(path))) return null;
  try {
    if (maximumBytes !== undefined && typeof adapter.stat === 'function') {
      const stat = await adapter.stat(path);
      if (stat && stat.size > maximumBytes) {
        throw new ConversationStoreCorruptError(
          `${source} exceeds the ${maximumBytes}-byte read budget: ${path}.`,
        );
      }
    }
    const raw = await adapter.read(path);
    if (maximumBytes !== undefined && Buffer.byteLength(raw, 'utf8') > maximumBytes) {
      throw new ConversationStoreCorruptError(
        `${source} exceeds the ${maximumBytes}-byte read budget: ${path}.`,
      );
    }
    return raw;
  } catch (error) {
    if (error instanceof ConversationStoreCorruptError) throw error;
    throw new ConversationStoreCorruptError(`Persisted v2 file ${path} could not be read: ${errorMessage(error)}`);
  }
}

async function readRequired(
  adapter: DataAdapter,
  path: string,
  source: string,
  maximumBytes?: number,
): Promise<string> {
  const raw = await readOptional(adapter, path, maximumBytes, source);
  if (raw === null) throw new ConversationStoreCorruptError(`Missing ${source}: ${path}.`);
  return raw;
}

async function listFolders(adapter: DataAdapter, root: string): Promise<string[]> {
  let listed: Awaited<ReturnType<DataAdapter['list']>>;
  try {
    listed = await adapter.list(root);
  } catch (error) {
    throw new ConversationStoreCorruptError(`Could not scan ${root}: ${errorMessage(error)}`);
  }
  return listed.folders.map(path => path.split('/').filter(Boolean).at(-1) ?? path);
}

function catalogEntryFromConversation(
  conversation: VersionedStoredConversation,
  archivedAt: number | null,
): CatalogEntry {
  const lastMessage = conversation.messages.at(-1);
  const searchable = buildSearchText(
    conversation.title,
    conversation.messages.map(message => message.content),
  );
  return {
    id: conversation.id,
    title: conversation.title,
    agentId: conversation.agentId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    revision: conversation.revision,
    messageCount: conversation.messages.length,
    turnCount: conversation.turns.length,
    archivedAt,
    lastMessagePreview: lastMessage?.content.replace(/\s+/g, ' ').trim().slice(0, 240) ?? '',
    searchText: searchable,
    sessions: cloneJson(conversation.sessionIds ?? {}),
    sessionOwnerships: cloneJson(conversation.sessionOwnerships ?? {}),
  };
}

function buildSearchText(title: string, bodyParts: readonly string[]): string {
  const normalizedTitle = title.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const normalizedBody = bodyParts.join('\n').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  if (!normalizedTitle) return normalizedBody.slice(-MAX_SEARCH_TEXT_CHARS);
  if (normalizedTitle.length >= MAX_SEARCH_TEXT_CHARS) {
    return normalizedTitle.slice(0, MAX_SEARCH_TEXT_CHARS);
  }
  const bodyBudget = MAX_SEARCH_TEXT_CHARS - normalizedTitle.length - 1;
  const bodyTail = normalizedBody.slice(-Math.max(0, bodyBudget));
  return bodyTail ? `${normalizedTitle}\n${bodyTail}` : normalizedTitle;
}

function catalogEntryAfterEvent(
  previous: CatalogEntry,
  conversation: VersionedStoredConversation,
  archivedAt: number | null,
  event: JournalEvent,
): CatalogEntry {
  if (event.type === 'replaceConversation' || event.type === 'recovery') {
    return catalogEntryFromConversation(conversation, archivedAt);
  }
  let messageCount = previous.messageCount;
  let lastMessagePreview = previous.lastMessagePreview;
  const searchableAdditions: string[] = [previous.searchText];
  if (event.type === 'beginTurn') {
    messageCount += 2;
    lastMessagePreview = previewMessage(event.assistantMessage);
    searchableAdditions.push(event.userMessage.content, event.assistantMessage.content);
  } else if (event.type === 'appendMessage') {
    messageCount += 1;
    lastMessagePreview = previewMessage(event.message);
    searchableAdditions.push(event.message.content);
  } else if (event.type === 'patchMessage') {
    lastMessagePreview = previewMessage(event.message);
    searchableAdditions.push(event.message.content);
  } else if (event.type === 'turnUpdate' && event.assistantMessage) {
    lastMessagePreview = previewMessage(event.assistantMessage);
    searchableAdditions.push(event.assistantMessage.content);
  }
  return {
    id: conversation.id,
    title: conversation.title,
    agentId: conversation.agentId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    revision: conversation.revision,
    messageCount,
    turnCount: conversation.turns.length,
    archivedAt,
    lastMessagePreview,
    searchText: buildSearchText(conversation.title, searchableAdditions),
    sessions: cloneJson(conversation.sessionIds ?? {}),
    sessionOwnerships: cloneJson(conversation.sessionOwnerships ?? {}),
  };
}

function previewMessage(message: ChatMessage): string {
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseConversationMeta(
  raw: string,
  generation: string,
  directoryName: string,
): ConversationMeta {
  const meta = parseChecksummed<ConversationMeta>(raw, 'conversation meta');
  validateCatalogEntry(meta);
  if (meta.version !== 2 || meta.generation !== generation
    || meta.directoryName !== directoryName
    || conversationDirectoryName(meta.id) !== directoryName) {
    throw new ConversationStoreCorruptError('Conversation meta identity is invalid.');
  }
  return meta;
}

function catalogEntryFromMeta(meta: ConversationMeta): CatalogEntry {
  return {
    id: meta.id,
    title: meta.title,
    agentId: meta.agentId,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    revision: meta.revision,
    messageCount: meta.messageCount,
    turnCount: meta.turnCount,
    archivedAt: meta.archivedAt,
    lastMessagePreview: meta.lastMessagePreview,
    searchText: meta.searchText,
    sessions: cloneJson(meta.sessions),
    sessionOwnerships: cloneJson(meta.sessionOwnerships),
  };
}

function compareCatalogEntries(left: CatalogEntry, right: CatalogEntry): number {
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function sortCatalogEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort(compareCatalogEntries).map(entry => cloneJson(entry));
}

function paginateCatalogEntries(
  entries: CatalogEntry[],
  cursor: string | null,
  pageSize: number,
  archiveFilter: ConversationArchiveFilter,
): ConversationSummaryPage {
  if (archiveFilter !== 'active' && archiveFilter !== 'archived' && archiveFilter !== 'all') {
    throw new ConversationTurnStateError(`Invalid archive filter ${String(archiveFilter)}.`);
  }
  const boundedSize = normalizeLimit(pageSize, 50, MAX_PAGE_SIZE);
  const filtered = sortCatalogEntries(entries).filter(entry => (
    archiveFilter === 'all'
      || (archiveFilter === 'active' ? entry.archivedAt === null : entry.archivedAt !== null)
  ));
  const decoded = cursor ? decodeCursor(cursor) : null;
  const afterCursor = decoded === null ? filtered : filtered.filter(entry => (
    entry.updatedAt < decoded.updatedAt
      || (entry.updatedAt === decoded.updatedAt && entry.id > decoded.id)
  ));
  const page = afterCursor.slice(0, boundedSize);
  return {
    items: page.map(({
      searchText: _searchText,
      sessions: _sessions,
      sessionOwnerships: _sessionOwnerships,
      ...summary
    }) => cloneJson(summary)),
    nextCursor: afterCursor.length > boundedSize && page.length > 0
      ? encodeCursor(page.at(-1)!)
      : null,
  };
}

function encodeCursor(entry: Pick<CatalogEntry, 'updatedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: entry.updatedAt, id: entry.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: number; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(value) || !Number.isFinite(value.updatedAt)
      || typeof value.id !== 'string' || !value.id) throw new Error('invalid cursor');
    return { updatedAt: Number(value.updatedAt), id: value.id };
  } catch {
    throw new ConversationTurnStateError('Conversation cursor is invalid.');
  }
}

function normalizeLimit(value: number, fallback: number, maximum = MAX_PAGE_SIZE): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function normalizeBeforeSequence(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConversationTurnStateError('beforeSequence must be a positive integer.');
  }
  return value;
}

function parseDraft<T>(raw: string, conversationId: string): ConversationDraft<T> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConversationStoreCorruptError(`Conversation draft is invalid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.version !== 1 || value.conversationId !== conversationId
    || !isFiniteTimestamp(value.updatedAt) || !Object.hasOwn(value, 'value')) {
    throw new ConversationStoreCorruptError(`Conversation draft ${conversationId} is invalid.`);
  }
  return cloneJson(value) as unknown as ConversationDraft<T>;
}

function isMeaningfulDraftValue(value: unknown): boolean {
  if (typeof value === 'string') return Boolean(value.trim());
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(isMeaningfulDraftValue);
  if (isRecord(value)) return Object.values(value).some(isMeaningfulDraftValue);
  return true;
}

function countConversations(conversations: VersionedStoredConversation[]): {
  conversationCount: number;
  messageCount: number;
  sessionCount: number;
} {
  return {
    conversationCount: conversations.length,
    messageCount: conversations.reduce((total, item) => total + item.messages.length, 0),
    sessionCount: conversations.reduce(
      (total, item) => total + Object.keys(item.sessionIds ?? {}).length,
      0,
    ),
  };
}

function hashConversationSet(conversations: VersionedStoredConversation[]): string {
  return sha256(canonicalJson([...conversations].sort((a, b) => a.id.localeCompare(b.id))));
}

function snapshotConversationFrom(conversation: VersionedStoredConversation): SnapshotConversation {
  return {
    id: conversation.id,
    title: conversation.title,
    agentId: conversation.agentId,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    revision: conversation.revision,
    turns: cloneJson(conversation.turns),
    ...(conversation.sessionIds === undefined ? {} : { sessionIds: cloneJson(conversation.sessionIds) }),
    ...(conversation.sessionConfigKeys === undefined
      ? {}
      : { sessionConfigKeys: cloneJson(conversation.sessionConfigKeys) }),
    ...(conversation.sessionOwnerships === undefined
      ? {}
      : { sessionOwnerships: cloneJson(conversation.sessionOwnerships) }),
    ...(conversation.contextCheckpoint === undefined
      ? {}
      : { contextCheckpoint: cloneJson(conversation.contextCheckpoint) }),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConversationSummaryPage {
  items: ConversationSummary[];
  nextCursor: string | null;
}

export interface SequencedChatMessage {
  sequence: number;
  message: ChatMessage;
}

export interface ConversationMessagePage {
  messages: SequencedChatMessage[];
  nextBeforeSequence: number | null;
}

export interface ConversationWindow {
  conversation: VersionedStoredConversation;
  /** Sequence immediately before the loaded window, or null when the first message is present. */
  nextBeforeSequence: number | null;
  totalMessageCount: number;
}

export interface ConversationSearchOptions {
  cursor?: string | null;
  pageSize?: number;
  archiveFilter?: ConversationArchiveFilter;
}

export interface ConversationDraft<T = unknown> {
  version: 1;
  conversationId: string;
  updatedAt: number;
  value: T;
}

export interface ConversationSessionOwnership {
  sessionId: string;
  conversationId: string;
  agentId: AgentId;
  updatedAt: number;
  runId: string;
  claimedAt: number;
}

export interface CatalogRebuildReport {
  generation: string;
  conversationCount: number;
  sessionCount: number;
  revision: number;
}

export type ConversationStoreBackend = 'v1' | 'v2' | 'uninitialized' | 'invalid';

export interface ConversationStoreStatus {
  backend: ConversationStoreBackend;
  pointerPath: string;
  activeGeneration: string | null;
  generationPath: string | null;
  formatVersion: number | null;
  conversationCount: number | null;
  error: string | null;
}

export type V2MigrationCrashPoint =
  | 'after-generation-created'
  | 'after-rollback-export'
  | 'after-conversations'
  | 'after-catalog'
  | 'after-manifest'
  | 'before-pointer-switch'
  | 'after-pointer-switch';

export interface EnsureV2StoreOptions {
  quiescenceBarrier?: () => Promise<void | { activeRuns: number }>;
  faultInjector?: (point: V2MigrationCrashPoint) => void | Promise<void>;
}

export interface V2MigrationReport {
  status: 'already-v2' | 'created-empty' | 'migrated-v1';
  generation: string;
  conversationCount: number;
  messageCount: number;
  sessionCount: number;
  sourceHash: string | null;
  pointerSwitched: boolean;
}

export interface V1MigrationSource {
  raw: string | null;
  revision: number;
  nextQueueSequence: number;
  conversations: VersionedStoredConversation[];
}

export interface ConversationRepositoryV2Options {
  adapter: DataAdapter;
  instanceId: string;
  now: () => number;
  assertWrite: (refreshLease?: boolean) => Promise<void>;
  /**
   * Optional physical-filesystem CAS executed by the long-lived flock helper.
   * When present it is the final write primitive, so losing the helper cannot
   * leave a stale writer in the assertWrite -> adapter.process window.
   */
  fencedCompareAndSwap?: (
    path: string,
    expectedRaw: string | null,
    nextRaw: string,
  ) => Promise<boolean | null>;
  readV1Source: () => Promise<V1MigrationSource>;
  normalizeConversation: (value: unknown, source: string) => VersionedStoredConversation;
}

interface ChatStorePointerUnsigned {
  version: 2;
  activeGeneration: string;
  manifestHash: string;
  switchedAt: number;
}

type ChatStorePointer = Checksummed<ChatStorePointerUnsigned>;

interface GenerationManifestUnsigned {
  version: 2;
  generation: string;
  createdAt: number;
  source: 'empty' | 'v1';
  sourceHash: string | null;
  conversationCount: number;
  messageCount: number;
  sessionCount: number;
  contentHash: string;
  rollbackExportPath: string | null;
  rollbackExportHash: string | null;
}

type GenerationManifest = Checksummed<GenerationManifestUnsigned>;

interface CatalogEntry extends ConversationSummary {
  searchText: string;
  sessions: Partial<Record<AgentId, string>>;
  sessionOwnerships: Partial<Record<AgentId, ConversationSessionOwner>>;
}

interface CatalogPendingMutation {
  conversationId: string;
  revision: number;
  /** Whether this conversation was visible before the pending revision. */
  wasCataloged: boolean;
  writerInstanceId: string;
}

interface CatalogUnsigned {
  version: 2;
  generation: string;
  revision: number;
  nextQueueSequence: number;
  entries: CatalogEntry[];
  /** Optional for backward compatibility with v2 stores created before fencing markers. */
  pendingMutations?: CatalogPendingMutation[];
}

type Catalog = Checksummed<CatalogUnsigned>;

interface SessionOwnerIndexPointerUnsigned {
  /** Version 2 can atomically switch only the changed immutable shard files. */
  version: 1 | 2;
  generation: string;
  /** Legacy/default generation; v2 resolves each shard through bucketGenerations. */
  indexGeneration: string;
  bucketGenerations?: Record<string, string>;
  bucketCount: number;
  ownerCount: number;
  builtAt: number;
}

type SessionOwnerIndexPointer = Checksummed<SessionOwnerIndexPointerUnsigned>;

interface SessionOwnerIndexEntry extends ConversationSessionOwnership {
  sessionHash: string;
}

interface SessionOwnerBucketUnsigned {
  version: 1;
  generation: string;
  indexGeneration: string;
  shard: string;
  owners: SessionOwnerIndexEntry[];
}

type SessionOwnerBucket = Checksummed<SessionOwnerBucketUnsigned>;

interface SessionOwnerLookup {
  pointer: SessionOwnerIndexPointer;
  pointerRaw: string;
  bucket: SessionOwnerBucket;
  bucketRaw: string;
  bucketPath: string;
  sessionHash: string;
  owner: ConversationSessionOwnership | null;
}

interface ConversationMetaUnsigned extends CatalogEntry {
  version: 2;
  generation: string;
  directoryName: string;
}

type ConversationMeta = Checksummed<ConversationMetaUnsigned>;

interface RunStateUnsigned {
  version: 2;
  generation: string;
  conversationId: string;
  revision: number;
  /** Missing means legacy v2 files where turns contains the full history. */
  turnsMode?: 'all' | 'tail';
  turns: StoredConversationTurn[];
  sessionIds: Partial<Record<AgentId, string>>;
  sessionConfigKeys: Partial<Record<AgentId, string>>;
  sessionOwnerships: Partial<Record<AgentId, ConversationSessionOwner>>;
  headSequence: number;
  headChecksum: string | null;
  journalSegments: string[];
  pendingJournalRecord: JournalRecord | null;
  pendingJournalPath: string | null;
  retiredTruncatedSegments: string[];
}

type RunState = Checksummed<RunStateUnsigned>;

interface MessageChunkDescriptor {
  path: string;
  startSequence: number;
  endSequence: number;
  count: number;
  hash: string;
}

interface SnapshotConversation {
  id: string;
  title: string;
  agentId: AgentId;
  createdAt: number;
  updatedAt: number;
  revision: number;
  turns: StoredConversationTurn[];
  sessionIds?: Partial<Record<AgentId, string>>;
  sessionConfigKeys?: Partial<Record<AgentId, string>>;
  sessionOwnerships?: Partial<Record<AgentId, ConversationSessionOwner>>;
  contextCheckpoint?: ConversationContextCheckpoint;
}

interface ConversationSnapshotUnsigned {
  version: 2;
  generation: string;
  conversationId: string;
  revision: number;
  archivedAt: number | null;
  journalSequence: number;
  journalChecksum: string | null;
  messageCount: number;
  chunks: MessageChunkDescriptor[];
  conversation: SnapshotConversation;
}

type ConversationSnapshot = Checksummed<ConversationSnapshotUnsigned>;

interface MessageChunkUnsigned {
  version: 2;
  generation: string;
  conversationId: string;
  revision: number;
  messages: SequencedChatMessage[];
}

type MessageChunk = Checksummed<MessageChunkUnsigned>;

interface SerializedMessageChunk {
  values: SequencedChatMessage[];
  serialized: string;
}

function buildSerializedMessageChunk(
  generation: string,
  conversationId: string,
  revision: number,
  messages: readonly ChatMessage[],
  offset: number,
  firstSequence: number,
): SerializedMessageChunk {
  const values: SequencedChatMessage[] = [];
  let estimatedBytes = 0;
  const payloadBudget = CHAT_V2_MAX_MESSAGE_CHUNK_BYTES - (1024 * 1024);
  while (offset + values.length < messages.length && values.length < CHAT_V2_MESSAGE_CHUNK_SIZE) {
    const index = offset + values.length;
    const value: SequencedChatMessage = {
      sequence: firstSequence + index,
      message: normalizeMessage(messages[index], `message ${firstSequence + index}`),
    };
    const valueBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (values.length > 0 && estimatedBytes + valueBytes > payloadBudget) break;
    values.push(value);
    estimatedBytes += valueBytes;
  }
  while (values.length > 0) {
    const chunk = withChecksum<MessageChunkUnsigned>({
      version: 2,
      generation,
      conversationId,
      revision,
      messages: values,
    });
    const serialized = serializeJson(chunk);
    if (Buffer.byteLength(serialized, 'utf8') <= CHAT_V2_MAX_MESSAGE_CHUNK_BYTES) {
      return { values, serialized };
    }
    values.pop();
  }
  throw corrupt(`Message ${firstSequence + offset} cannot fit the persisted chunk budget.`);
}

type JournalEvent =
  | {
    type: 'beginTurn';
    title: string;
    agentId: AgentId;
    createdAt: number;
    updatedAt: number;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    turn: StoredConversationTurn;
    /** Present only when checkpoint creation and turn admission were atomic. */
    contextCheckpoint?: ConversationContextCheckpoint;
  }
  | { type: 'appendMessage'; message: ChatMessage; title: string; updatedAt: number }
  | { type: 'patchMessage'; message: ChatMessage; updatedAt: number }
  | {
    type: 'patchSession';
    agentId: AgentId;
    sessionId: string | null | undefined;
    configKey: string | null | undefined;
    ownership?: ConversationSessionOwner | null;
    updatedAt: number;
  }
  | {
    type: 'setContextCheckpoint';
    checkpoint: ConversationContextCheckpoint;
    updatedAt: number;
  }
  | { type: 'replaceConversation'; conversation: VersionedStoredConversation; updatedAt: number }
  | { type: 'turnUpdate'; turn: StoredConversationTurn; assistantMessage?: ChatMessage; updatedAt: number }
  | { type: 'archive'; archivedAt: number; updatedAt: number }
  | { type: 'restore'; updatedAt: number }
  | { type: 'recovery'; conversation: VersionedStoredConversation; updatedAt: number };

interface JournalRecordUnsigned {
  version: 2;
  generation: string;
  conversationId: string;
  turnId: string;
  sequence: number;
  revision: number;
  previousChecksum: string | null;
  event: JournalEvent;
}

type JournalRecord = Checksummed<JournalRecordUnsigned>;

interface LoadedConversationState {
  context: ActiveGenerationContext;
  directoryName: string;
  conversation: VersionedStoredConversation;
  archivedAt: number | null;
  lastSequence: number;
  lastChecksum: string | null;
  runState: RunState;
  runStateRaw: string | null;
  snapshotRaw: string;
  segmentRaws: Map<string, string>;
  truncatedSegments: string[];
  /** Parsed immutable base used to reuse old content-addressed chunks. */
  snapshot: ConversationSnapshot;
  /** Exact catalog/meta projection at the loaded revision. */
  catalogEntry: CatalogEntry;
  /** True when messages contains only post-snapshot active-tail messages. */
  partial: boolean;
}

interface SelectiveConversationSlice {
  conversation: VersionedStoredConversation;
  messages: SequencedChatMessage[];
  nextBeforeSequence: number | null;
  totalMessageCount: number;
}

interface ActiveGenerationContext {
  pointer: ChatStorePointer;
  pointerRaw: string;
  generation: string;
  generationRoot: string;
  manifest: GenerationManifest;
  manifestRaw: string;
}

interface Allocation {
  revision: number;
  queueSequence?: number;
}

interface ChecksummedBase {
  checksum: string;
}

type Checksummed<T> = T & ChecksummedBase;

interface ParsedJournalSegment {
  records: JournalRecord[];
  truncatedTail: boolean;
}

class RevisionCasMismatchError extends Error {}
class CatalogReadEpochChangedError extends Error {
  constructor() {
    super('The conversation body or session owner did not match its catalog epoch.');
    this.name = 'CatalogReadEpochChangedError';
  }
}

export class ConversationRepositoryV2 {
  private readonly adapter: DataAdapter;
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly assertWrite: (refreshLease?: boolean) => Promise<void>;
  private readonly fencedCompareAndSwap?: (
    path: string,
    expectedRaw: string | null,
    nextRaw: string,
  ) => Promise<boolean | null>;
  private readonly readV1Source: () => Promise<V1MigrationSource>;
  private readonly normalizeConversation: (
    value: unknown,
    source: string,
  ) => VersionedStoredConversation;
  private readonly conversationTails = new Map<string, Promise<void>>();
  private readonly localPendingMutations = new Map<string, Set<number>>();
  private catalogTail: Promise<void> = Promise.resolve();

  constructor(options: ConversationRepositoryV2Options) {
    this.adapter = options.adapter;
    this.instanceId = sanitizePathSegment(options.instanceId);
    this.now = options.now;
    this.assertWrite = options.assertWrite;
    this.fencedCompareAndSwap = options.fencedCompareAndSwap;
    this.readV1Source = options.readV1Source;
    this.normalizeConversation = (value, source) => {
      const conversation = options.normalizeConversation(value, source);
      return {
        ...conversation,
        messages: conversation.messages.map((message, index) => (
          normalizeMessage(message, `${source} message ${index + 1}`)
        )),
      };
    };
  }

  async isActive(): Promise<boolean> {
    return this.adapter.exists(CHAT_STORE_POINTER_PATH);
  }

  async getStatus(): Promise<ConversationStoreStatus> {
    if (!(await this.adapter.exists(CHAT_STORE_POINTER_PATH))) {
      try {
        const v1 = await this.readV1Source();
        return {
          backend: v1.raw === null ? 'uninitialized' : 'v1',
          pointerPath: CHAT_STORE_POINTER_PATH,
          activeGeneration: null,
          generationPath: null,
          formatVersion: v1.raw === null ? null : 1,
          conversationCount: v1.conversations.length,
          error: null,
        };
      } catch (error) {
        return {
          backend: 'invalid',
          pointerPath: CHAT_STORE_POINTER_PATH,
          activeGeneration: null,
          generationPath: null,
          formatVersion: 1,
          conversationCount: null,
          error: errorMessage(error),
        };
      }
    }
    try {
      const context = await this.readActiveContext();
      const catalog = await this.readCatalogWithRepair(context);
      return {
        backend: 'v2',
        pointerPath: CHAT_STORE_POINTER_PATH,
        activeGeneration: context.generation,
        generationPath: context.generationRoot,
        formatVersion: 2,
        conversationCount: catalog.entries.length,
        error: null,
      };
    } catch (error) {
      return {
        backend: 'invalid',
        pointerPath: CHAT_STORE_POINTER_PATH,
        activeGeneration: null,
        generationPath: null,
        formatVersion: null,
        conversationCount: null,
        error: errorMessage(error),
      };
    }
  }

  async ensureV2Store(options: EnsureV2StoreOptions = {}): Promise<V2MigrationReport> {
    await this.assertWrite(true);
    if (await this.adapter.exists(CHAT_STORE_POINTER_PATH)) {
      const context = await this.readActiveContext();
      const catalog = await this.readCatalogWithRepair(context);
      if (context.manifest.conversationCount === 0
        && context.manifest.messageCount === 0
        && context.manifest.sessionCount === 0
        && catalog.entries.length === 0) {
        // The first v2 empty-store writer switched the pointer without
        // materializing this directory. Desktop DataAdapter.list() rejects a
        // missing path, so repair that valid empty skeleton while the writer
        // lease is held before startup recovery scans it.
        await ensureDirectory(
          this.adapter,
          joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY),
        );
      }
      await this.enqueueCatalog(async () => {
        try {
          await this.readSessionOwnerIndexPointer(context);
        } catch (error) {
          if (!(error instanceof ConversationStoreCorruptError)) throw error;
          // Stores created by the first v2 implementation have no owner
          // index. Only the current durable writer may derive and install it.
          // Duplicate canonical sessions abort the rebuild instead of being
          // silently assigned to whichever conversation was scanned first.
          const ownerships = await this.scanSessionOwnerships(context);
          await this.rebuildSessionOwnerIndex(context, ownerships);
        }
      });
      return {
        status: 'already-v2',
        generation: context.generation,
        conversationCount: context.manifest.conversationCount,
        messageCount: context.manifest.messageCount,
        sessionCount: context.manifest.sessionCount,
        sourceHash: context.manifest.sourceHash,
        pointerSwitched: true,
      };
    }

    const sourceBeforeBarrier = await this.readV1Source();
    if (sourceBeforeBarrier.raw !== null) {
      if (!options.quiescenceBarrier) {
        throw new ConversationStoreMigrationError(
          'A quiescence barrier is required before migrating an existing v1 store.',
        );
      }
      const result = await options.quiescenceBarrier();
      if (result && result.activeRuns !== 0) {
        throw new ConversationStoreMigrationError(
          `The migration barrier returned ${result.activeRuns} active runs.`,
        );
      }
    }
    const unnormalizedSource = await this.readV1Source();
    if (sourceBeforeBarrier.raw !== unnormalizedSource.raw) {
      throw new ConversationStoreMigrationError('The v1 store changed while migration was quiescing.');
    }
    // Preflight every legacy message before creating or switching a v2
    // generation. Safe normalization may discard only invalid UI lifecycle
    // spans; malformed durable artifacts/references abort with the v1 source
    // and active pointer untouched.
    const source: V1MigrationSource = {
      ...unnormalizedSource,
      conversations: unnormalizedSource.conversations.map((conversation, index) => (
        this.normalizeConversation(conversation, `v1 conversation ${index + 1}`)
      )),
    };
    const sourceHash = source.raw === null ? null : sha256(source.raw);
    const generation = generationId(sourceHash);
    const generationRoot = generationRootPath(generation);
    await ensureDirectory(this.adapter, generationRoot);
    await ensureDirectory(this.adapter, joinPath(generationRoot, CONVERSATIONS_DIRECTORY));
    await options.faultInjector?.('after-generation-created');

    let rollbackExportHash: string | null = null;
    if (source.raw !== null) {
      const rollbackPath = joinPath(generationRoot, ROLLBACK_V1_PATH);
      await this.writeImmutableText(rollbackPath, source.raw);
      const rollbackRaw = await this.adapter.read(rollbackPath);
      rollbackExportHash = sha256(rollbackRaw);
      if (rollbackRaw !== source.raw || rollbackExportHash !== sourceHash) {
        throw new ConversationStoreMigrationError('The v1 rollback export failed byte-for-byte verification.');
      }
    }
    await options.faultInjector?.('after-rollback-export');

    const migrationContext = { generation, generationRoot };
    const entries: CatalogEntry[] = [];
    for (let offset = 0; offset < source.conversations.length; offset += 32) {
      const batch = source.conversations.slice(offset, offset + 32);
      const batchEntries = await Promise.all(batch.map(async conversation => {
        await this.writeInitialConversation(migrationContext, conversation, null);
        return catalogEntryFromConversation(conversation, null);
      }));
      entries.push(...batchEntries);
    }
    await options.faultInjector?.('after-conversations');

    const migratedOwnerships = sessionOwnershipsFromConversations(source.conversations);
    await this.rebuildSessionOwnerIndex(migrationContext, migratedOwnerships);

    const catalog = withChecksum<CatalogUnsigned>({
      version: 2,
      generation,
      revision: source.revision,
      nextQueueSequence: source.nextQueueSequence,
      entries: sortCatalogEntries(entries),
      pendingMutations: [],
    });
    await this.atomicWriteChecksummed(joinPath(generationRoot, CATALOG_PATH), catalog);
    await options.faultInjector?.('after-catalog');

    const counts = countConversations(source.conversations);
    const contentHash = hashConversationSet(source.conversations);
    const manifest = withChecksum<GenerationManifestUnsigned>({
      version: 2,
      generation,
      // Generation files must be byte-stable so an interrupted migration can
      // safely reuse and verify the same deterministic generation directory.
      createdAt: source.conversations.reduce((oldest, item) => (
        oldest === 0 ? item.createdAt : Math.min(oldest, item.createdAt)
      ), 0),
      source: source.raw === null ? 'empty' : 'v1',
      sourceHash,
      conversationCount: counts.conversationCount,
      messageCount: counts.messageCount,
      sessionCount: counts.sessionCount,
      contentHash,
      rollbackExportPath: source.raw === null ? null : ROLLBACK_V1_PATH,
      rollbackExportHash,
    });
    const manifestPath = joinPath(generationRoot, MANIFEST_PATH);
    await this.atomicWriteChecksummed(manifestPath, manifest);
    const manifestRaw = await this.adapter.read(manifestPath);
    const verifiedManifest = parseChecksummed<GenerationManifest>(manifestRaw, 'v2 manifest');
    validateManifest(verifiedManifest, generation);
    await this.verifyMigratedGeneration(migrationContext, source, manifest);
    await options.faultInjector?.('after-manifest');

    const sourceImmediatelyBeforePointer = await this.readV1Source();
    if (sourceImmediatelyBeforePointer.raw !== source.raw) {
      throw new ConversationStoreMigrationError('The v1 store changed before the pointer switch.');
    }
    await options.faultInjector?.('before-pointer-switch');
    const pointer = withChecksum<ChatStorePointerUnsigned>({
      version: 2,
      activeGeneration: generation,
      manifestHash: sha256(manifestRaw),
      switchedAt: this.now(),
    });
    await this.installInitialPointer(pointer);
    await this.readActiveContext();
    await options.faultInjector?.('after-pointer-switch');
    return {
      status: source.raw === null ? 'created-empty' : 'migrated-v1',
      generation,
      conversationCount: counts.conversationCount,
      messageCount: counts.messageCount,
      sessionCount: counts.sessionCount,
      sourceHash,
      pointerSwitched: true,
    };
  }

  async listConversations(): Promise<VersionedStoredConversation[]> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const entries = catalog.entries
        .filter(entry => entry.archivedAt === null)
        .sort(compareCatalogEntries);
      const conversations = await Promise.all(entries.map(async entry => {
        const state = await this.loadConversationState(context, entry.id);
        this.assertConversationMatchesCatalog(state.conversation, entry);
        return state;
      }));
      return conversations.map(state => cloneJson(state.conversation));
    });
  }

  async getConversation(conversationId: string): Promise<VersionedStoredConversation | null> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const entry = catalog.entries.find(item => item.id === conversationId);
      if (!entry || entry.archivedAt !== null) return null;
      const conversation = (await this.loadConversationState(context, conversationId)).conversation;
      this.assertConversationMatchesCatalog(conversation, entry);
      return cloneJson(conversation);
    });
  }

  async loadConversationWindow(
    conversationId: string,
    limit = 100,
  ): Promise<ConversationWindow | null> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const entry = catalog.entries.find(item => item.id === conversationId);
      if (!entry || entry.archivedAt !== null) return null;
      const slice = await this.loadConversationSlice(context, conversationId, null, limit);
      this.assertConversationMatchesCatalog(slice.conversation, entry);
      return {
        conversation: {
          ...cloneJson(slice.conversation),
          messages: slice.messages.map(item => cloneJson(item.message)),
        },
        nextBeforeSequence: slice.nextBeforeSequence,
        totalMessageCount: slice.totalMessageCount,
      };
    });
  }

  async listPendingTurns(): Promise<PendingConversationTurn[]> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const activeEntries = catalog.entries.filter(entry => (
        entry.archivedAt === null && entry.turnCount > 0
      ));
      const runStates = await Promise.all(activeEntries.map(async entry => {
        const runState = parseRunState(
          await readRequired(
            this.adapter,
            conversationFilePath(context.generationRoot, entry.id, RUN_STATE_PATH),
            'conversation run-state',
          ),
          context.generation,
          entry.id,
        );
        if (runState.revision !== entry.revision) throw new CatalogReadEpochChangedError();
        return runState;
      }));
      return runStates.flatMap(runState => runState.turns
        .filter(turn => !isTerminalTurnState(turn.state))
        .map(turn => ({
          conversationId: runState.conversationId,
          conversationRevision: runState.revision,
          turn: cloneJson(turn),
        })))
        .sort((left, right) => left.turn.queueSequence - right.turn.queueSequence);
    });
  }

  async listConversationSummaries(
    cursor: string | null = null,
    pageSize = 50,
    archiveFilter: ConversationArchiveFilter = 'active',
  ): Promise<ConversationSummaryPage> {
    const context = await this.readActiveContext();
    const catalog = await this.readCatalogWithRepair(context);
    return paginateCatalogEntries(catalog.entries, cursor, pageSize, archiveFilter);
  }

  async searchConversations(
    query: string,
    options: ConversationSearchOptions = {},
  ): Promise<ConversationSummaryPage> {
    const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const context = await this.readActiveContext();
    const catalog = await this.readCatalogWithRepair(context);
    const matches = normalizedQuery
      ? catalog.entries.filter(entry => entry.searchText.includes(normalizedQuery))
      : catalog.entries;
    return paginateCatalogEntries(
      matches,
      options.cursor ?? null,
      options.pageSize ?? 50,
      options.archiveFilter ?? 'active',
    );
  }

  async loadMessages(
    conversationId: string,
    beforeSequence: number | null = null,
    limit = 100,
  ): Promise<ConversationMessagePage> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const entry = catalog.entries.find(item => item.id === conversationId);
      if (!entry) throw new CatalogReadEpochChangedError();
      const slice = await this.loadConversationSlice(context, conversationId, beforeSequence, limit);
      this.assertConversationMatchesCatalog(slice.conversation, entry);
      return { messages: slice.messages, nextBeforeSequence: slice.nextBeforeSequence };
    });
  }

  async listSessionOwnerships(): Promise<ConversationSessionOwnership[]> {
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const owners = await this.readAllSessionOwnersFromIndex(context);
      for (const owner of owners) this.assertSessionOwnerMatchesCatalog(owner, catalog);
      return owners.sort((left, right) => right.updatedAt - left.updatedAt);
    });
  }

  /** Constant-file-count durable lookup used by the runtime admission gate. */
  async loadSessionOwner(sessionId: string): Promise<ConversationSessionOwnership | null> {
    const normalizedSessionId = requireNonEmptyString(sessionId, 'runtime session id');
    const context = await this.readActiveContext();
    return this.readConsistentCatalogView(context, async catalog => {
      const owner = await this.readSessionOwnerFromIndex(context, normalizedSessionId);
      if (owner) this.assertSessionOwnerMatchesCatalog(owner, catalog);
      return owner;
    });
  }

  async saveDraft<T>(conversationId: string, value: T): Promise<ConversationDraft<T>> {
    requireNonEmptyString(conversationId, 'conversation id');
    const draft: ConversationDraft<T> = {
      version: 1,
      conversationId,
      updatedAt: this.now(),
      value: cloneJson(value),
    };
    // A blank, never-persisted editor must not create a history/catalog item or
    // even a draft-only directory. Existing draft files are retained as a
    // reversible empty checkpoint because this repository never deletes data.
    const context = await this.readActiveContext();
    const path = conversationFilePath(context.generationRoot, conversationId, DRAFT_PATH);
    if (!isMeaningfulDraftValue(value) && !(await this.adapter.exists(path))) return draft;
    await this.assertWrite(true);
    await ensureDirectory(this.adapter, parentPath(path));
    await this.atomicCasText(path, serializeJson(draft), await readOptional(this.adapter, path));
    return cloneJson(draft);
  }

  async loadDraft<T = unknown>(conversationId: string): Promise<ConversationDraft<T> | null> {
    requireNonEmptyString(conversationId, 'conversation id');
    const context = await this.readActiveContext();
    const path = conversationFilePath(context.generationRoot, conversationId, DRAFT_PATH);
    const raw = await readOptional(this.adapter, path);
    if (raw === null) return null;
    return parseDraft<T>(raw, conversationId);
  }

  async commitContextCheckpoint(
    input: CommitContextCheckpointInput,
  ): Promise<ContextCheckpointMutationResult> {
    const conversationId = requireNonEmptyString(input.conversationId, 'conversation id');
    const draft = normalizeContextCheckpointDraft(input.checkpoint, 'context checkpoint draft');
    return this.enqueueConversation(conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      const state = await this.loadConversationState(context, conversationId);
      const prefixSha256 = hashMessagePrefix(
        state.conversation.messages,
        draft.throughMessageSequence,
        draft.throughMessageId,
      );
      const checkpoint: ConversationContextCheckpoint = {
        ...cloneJson(draft),
        prefixSha256,
      };
      const existing = state.conversation.contextCheckpoint;
      if (existing?.id === checkpoint.id) {
        if (!jsonEqual(existing, checkpoint)) {
          throw new ConversationTurnStateError(
            `Context checkpoint id ${checkpoint.id} is already in use by different content.`,
          );
        }
        return {
          applied: false,
          revision: state.conversation.revision,
          checkpoint: cloneJson(existing),
        };
      }
      if (state.conversation.turns.some(turn => !isTerminalTurnState(turn.state))) {
        throw new ConversationTurnStateError(
          `Conversation ${conversationId} cannot checkpoint while a turn is unfinished.`,
        );
      }
      if (draft.sourceRevision !== state.conversation.revision) {
        throw new ConversationRevisionConflictError(
          conversationId,
          draft.sourceRevision,
          state.conversation.revision,
        );
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      assertContextCheckpointBoundary(state.conversation, checkpoint);
      if (existing) {
        if (checkpoint.previousCheckpointId !== existing.id) {
          throw new ConversationTurnStateError(
            `Context checkpoint ${checkpoint.id} does not extend ${existing.id}.`,
          );
        }
        if (checkpoint.throughMessageSequence <= existing.throughMessageSequence) {
          throw new ConversationTurnStateError(
            'A context checkpoint must advance beyond the previous message boundary.',
          );
        }
      } else if (checkpoint.previousCheckpointId !== undefined) {
        throw new ConversationTurnStateError(
          'The first context checkpoint cannot reference a previous checkpoint.',
        );
      }
      const allocation = await this.allocateGlobal(context, conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      next.contextCheckpoint = cloneJson(checkpoint);
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, '_context', {
        type: 'setContextCheckpoint',
        checkpoint: cloneJson(checkpoint),
        updatedAt: now,
      });
      await this.compactConversation(context, conversationId);
      return {
        applied: true,
        revision: next.revision,
        checkpoint: cloneJson(checkpoint),
      };
    });
  }

  async rebuildCatalog(): Promise<CatalogRebuildReport> {
    await this.assertWrite(true);
    const context = await this.readActiveContext();
    return this.enqueueCatalog(() => this.rebuildCatalogUnlocked(context));
  }

  async appendMessage(
    conversationId: string,
    message: ChatMessage,
  ): Promise<VersionedStoredConversation> {
    requireNonEmptyString(conversationId, 'conversation id');
    const normalizedMessage = normalizeMessage(message, 'message');
    return this.enqueueConversation(conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      let state = await this.loadConversationStateOrNull(context, conversationId);
      let preallocated: Allocation | null = null;
      if (!state) {
        preallocated = await this.allocateGlobal(context, conversationId, false);
        const now = this.now();
        const conversation: VersionedStoredConversation = {
          id: conversationId,
          title: titleFromMessage(normalizedMessage),
          agentId: normalizedMessage.agentId ?? 'claude',
          createdAt: now,
          updatedAt: now,
          messages: [],
          revision: 0,
          turns: [],
        };
        await this.writeInitialConversation(context, conversation, null);
        state = await this.loadConversationState(context, conversationId);
      }
      const duplicate = state.conversation.messages.find(item => item.id === normalizedMessage.id);
      if (duplicate) {
        if (!jsonEqual(duplicate, normalizedMessage)) {
          throw new ConversationTurnStateError(`Message id ${normalizedMessage.id} is already in use.`);
        }
        return cloneJson(state.conversation);
      }
      const allocation = preallocated
        ?? await this.allocateGlobal(context, conversationId, false);
      const next = cloneJson(state.conversation);
      next.messages.push(normalizedMessage);
      next.updatedAt = this.now();
      next.revision = allocation.revision;
      if (!next.title || next.title === DEFAULT_CONVERSATION_TITLE) {
        next.title = titleFromMessage(normalizedMessage, next.title);
      }
      const event: JournalEvent = {
        type: 'appendMessage',
        message: cloneJson(normalizedMessage),
        title: next.title,
        updatedAt: next.updatedAt,
      };
      await this.commitConversationEvent(state, next, state.archivedAt, '_conversation', event);
      return cloneJson(next);
    });
  }

  async replaceConversation(conversation: StoredConversation): Promise<void> {
    requireNonEmptyString(conversation.id, 'conversation id');
    await this.enqueueConversation(conversation.id, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      let state = await this.loadConversationStateOrNull(context, conversation.id);
      let preallocated: Allocation | null = null;
      const incoming = conversation as StoredConversation & Partial<VersionedStoredConversation>;
      if (state && incoming.revision !== undefined
        && incoming.revision !== state.conversation.revision) {
        throw new ConversationRevisionConflictError(
          conversation.id,
          incoming.revision,
          state.conversation.revision,
        );
      }
      if (incoming.contextCheckpoint !== undefined
        && (!state?.conversation.contextCheckpoint
          || !jsonEqual(incoming.contextCheckpoint, state.conversation.contextCheckpoint))) {
        throw new ConversationTurnStateError(
          'Context checkpoints may only be created by commitContextCheckpoint().',
        );
      }
      if (state?.conversation.contextCheckpoint) {
        const candidateMessages = incoming.messages ?? state.conversation.messages;
        const covered = state.conversation.contextCheckpoint.throughMessageSequence;
        if (candidateMessages.length < covered
          || !jsonEqual(
            candidateMessages.slice(0, covered),
            state.conversation.messages.slice(0, covered),
          )) {
          throw new ConversationTurnStateError(
            'replaceConversation() cannot alter messages covered by a context checkpoint.',
          );
        }
      }
      if (!state) {
        preallocated = await this.allocateGlobal(context, conversation.id, false);
        const seed = this.normalizeConversation({
          ...cloneJson(conversation),
          revision: 0,
          turns: incoming.turns ?? [],
        }, `conversation ${conversation.id}`);
        await this.writeInitialConversation(context, seed, null);
        state = await this.loadConversationState(context, conversation.id);
      }
      const allocation = preallocated
        ?? await this.allocateGlobal(context, conversation.id, false);
      const next = this.normalizeConversation({
        ...state.conversation,
        ...cloneJson(conversation),
        revision: allocation.revision,
        turns: incoming.turns === undefined ? state.conversation.turns : cloneJson(incoming.turns),
        updatedAt: this.now(),
      }, `conversation ${conversation.id}`);
      await this.commitConversationEvent(state, next, state.archivedAt, '_conversation', {
        type: 'replaceConversation',
        conversation: cloneJson(next),
        updatedAt: next.updatedAt,
      });
      await this.compactConversation(context, conversation.id);
    });
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const context = await this.readActiveContext();
    const catalog = await this.readCatalogWithRepair(context);
    if (!catalog.entries.some(entry => entry.id === conversationId)) return;
    await this.archiveConversation(conversationId);
  }

  async archiveConversation(
    conversationId: string,
    expectedRevision?: number,
  ): Promise<ConversationArchiveMutationResult> {
    return this.setArchived(conversationId, true, expectedRevision);
  }

  async restoreConversation(
    conversationId: string,
    expectedRevision?: number,
  ): Promise<ConversationArchiveMutationResult> {
    return this.setArchived(conversationId, false, expectedRevision);
  }

  async beginTurn(input: BeginTurnInput): Promise<TurnMutationResult> {
    validateBeginTurnInput(input);
    const turnId = input.turnId?.trim() || createId('turn');
    return this.enqueueConversation(input.conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      let state = await this.loadConversationMutationStateOrNull(
        context,
        input.conversationId,
        { requireNonterminalMessages: false },
      );
      let preallocated: Allocation | null = null;
      if (state && input.contextCheckpointDraft) {
        // Checkpoint hashes bind the complete canonical prefix, not the
        // bounded mutation tail.
        state = await this.loadConversationState(context, input.conversationId);
      }
      let existingTurn = state?.conversation.turns.find(turn => turn.id === turnId);
      if (state && existingTurn) {
        const replayUserMessageId = existingTurn.userMessageId;
        const replayAssistantMessageId = existingTurn.assistantMessageId;
        if (!state.conversation.messages.some(message => message.id === replayUserMessageId)
          || !state.conversation.messages.some(message => message.id === replayAssistantMessageId)) {
          state = await this.loadConversationState(context, input.conversationId);
          existingTurn = requireTurn(state.conversation, turnId);
        }
        assertBeginTurnReplay(state.conversation, existingTurn, input);
        return turnResult(false, state.conversation, existingTurn);
      }
      if (!state) {
        // Publish the catalog transaction marker before the seed body. If the
        // process crashes after seeding, rebuild sees wasCataloged=false and
        // keeps the empty body out of history until an idempotent retry commits
        // the first turn. The old seed -> marker order could create a phantom.
        preallocated = await this.allocateGlobal(context, input.conversationId, true);
        const now = this.now();
        const seed: VersionedStoredConversation = {
          id: input.conversationId,
          title: titleFromMessage(input.userMessage),
          agentId: input.agentId,
          createdAt: now,
          updatedAt: now,
          messages: [],
          revision: 0,
          turns: [],
        };
        await this.writeInitialConversation(context, seed, null);
        state = await this.loadConversationMutationState(
          context,
          input.conversationId,
          { requireNonterminalMessages: false },
        );
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const contextCheckpoint = input.contextCheckpointDraft
        ? materializeAtomicContextCheckpoint(state.conversation, input.contextCheckpointDraft)
        : undefined;
      for (const message of [input.userMessage, input.assistantMessage]) {
        if (state.conversation.messages.some(item => item.id === message.id)) {
          throw new ConversationTurnStateError(`Message id ${message.id} is already in use.`);
        }
      }
      const initialState = input.initialState ?? 'active';
      if (initialState === 'active') assertNoOtherActiveTurn(state.conversation);
      const allocation = preallocated
        ?? await this.allocateGlobal(context, input.conversationId, true);
      const now = this.now();
      const turn: StoredConversationTurn = {
        id: turnId,
        agentId: input.agentId,
        userMessageId: input.userMessage.id,
        assistantMessageId: input.assistantMessage.id,
        state: initialState,
        queueSequence: allocation.queueSequence!,
        createdAt: now,
        updatedAt: now,
        runtime: normalizeRuntimeSnapshot(input.runtime, 'turn runtime snapshot'),
        ...(initialState === 'active' ? { startedAt: now } : {}),
      };
      const next = cloneJson(state.conversation);
      next.messages.push(cloneJson(input.userMessage), cloneJson(input.assistantMessage));
      next.turns.push(turn);
      if (contextCheckpoint) next.contextCheckpoint = cloneJson(contextCheckpoint);
      next.agentId = input.agentId;
      next.updatedAt = now;
      next.revision = allocation.revision;
      if (!next.title || next.title === DEFAULT_CONVERSATION_TITLE) {
        next.title = titleFromMessage(input.userMessage, next.title);
      }
      await this.commitConversationEvent(state, next, state.archivedAt, turnId, {
        type: 'beginTurn',
        title: next.title,
        agentId: input.agentId,
        createdAt: state.conversation.messages.length === 0 ? next.createdAt : state.conversation.createdAt,
        updatedAt: now,
        userMessage: cloneJson(input.userMessage),
        assistantMessage: cloneJson(input.assistantMessage),
        turn: cloneJson(turn),
        ...(contextCheckpoint ? { contextCheckpoint: cloneJson(contextCheckpoint) } : {}),
      });
      return turnResult(true, next, turn);
    });
  }

  async activateTurn(input: ConversationMutationInput): Promise<TurnMutationResult> {
    return this.mutateExistingConversation(input.conversationId, async (state, context) => {
      const turn = requireTurn(state.conversation, input.turnId);
      if (turn.state === 'active') return turnResult(false, state.conversation, turn);
      if (turn.state !== 'queued' && turn.state !== 'paused') {
        throw new ConversationTurnStateError(`Turn ${turn.id} cannot become active from ${turn.state}.`);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      assertNoOtherActiveTurn(state.conversation, turn.id);
      const allocation = await this.allocateGlobal(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const nextTurn = requireTurn(next, turn.id);
      nextTurn.state = 'active';
      nextTurn.startedAt = now;
      nextTurn.updatedAt = now;
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, turn.id, {
        type: 'turnUpdate', turn: cloneJson(nextTurn), updatedAt: now,
      });
      return turnResult(true, next, nextTurn);
    });
  }

  async patchMessage(input: PatchMessageInput): Promise<MessageMutationResult> {
    return this.mutateExistingConversation(input.conversationId, async (state, context) => {
      const message = requireMessage(state.conversation, input.messageId);
      const turn = input.turnId
        ? requireTurn(state.conversation, input.turnId)
        : state.conversation.turns.find(item => (
          item.userMessageId === input.messageId || item.assistantMessageId === input.messageId
        )) ?? null;
      if (turn && input.turnId
        && turn.userMessageId !== input.messageId
        && turn.assistantMessageId !== input.messageId) {
        throw new ConversationTurnStateError(
          `Message ${input.messageId} does not belong to turn ${turn.id}.`,
        );
      }
      const nextMessage = applyMessagePatch(message, input.patch);
      if (jsonEqual(message, nextMessage)) {
        return messageResult(false, state.conversation, message, turn);
      }
      if (turn && (isTerminalTurnState(turn.state) || turn.state === 'cancelRequested')) {
        throw new ConversationTurnStateError(`Turn ${turn.id} no longer accepts message patches.`);
      }
      const messageIndex = state.conversation.messages.findIndex(item => item.id === message.id);
      // The partial mutation fast path keeps only messages appended after the
      // immutable snapshot. Convert that tail-local index back to the canonical
      // conversation sequence before enforcing a context-checkpoint boundary.
      const messageSequence = (state.partial ? state.snapshot.messageCount : 0)
        + messageIndex
        + 1;
      if (state.conversation.contextCheckpoint
        && messageSequence <= state.conversation.contextCheckpoint.throughMessageSequence) {
        throw new ConversationTurnStateError(
          'Messages covered by a context checkpoint cannot be changed.',
        );
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const allocation = await this.allocateGlobal(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const storedMessage = requireMessage(next, input.messageId);
      assignMessage(storedMessage, nextMessage);
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, turn?.id ?? '_conversation', {
        type: 'patchMessage', message: cloneJson(storedMessage), updatedAt: now,
      });
      return messageResult(
        true,
        next,
        storedMessage,
        turn ? requireTurn(next, turn.id) : null,
      );
    }, { requiredMessageIds: [input.messageId] });
  }

  /** Journal-only streaming checkpoint. Snapshot/chunk compaction is deferred to finalize/cancel/recovery. */
  async checkpointAssistantMessage(input: PatchMessageInput): Promise<MessageMutationResult> {
    return this.patchMessage(input);
  }

  async patchSession(input: PatchSessionInput): Promise<SessionMutationResult> {
    return this.enqueueConversation(input.conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      return this.enqueueCleanCatalogMutation(context, async () => {
      const state = await this.loadConversationMutationState(context, input.conversationId, {
        requireNonterminalMessages: false,
      });
      const turn = input.turnId ? requireTurn(state.conversation, input.turnId) : null;
      const previousSessionId = state.conversation.sessionIds?.[input.agentId] ?? null;
      const nextSessionIds = { ...(state.conversation.sessionIds ?? {}) };
      const nextConfigKeys = { ...(state.conversation.sessionConfigKeys ?? {}) };
      const nextOwnerships = { ...(state.conversation.sessionOwnerships ?? {}) };
      assignNullableAgentValue(nextSessionIds, input.agentId, input.sessionId);
      assignNullableAgentValue(nextConfigKeys, input.agentId, input.configKey);
      if (input.sessionId === null) delete nextOwnerships[input.agentId];
      else if (typeof input.sessionId === 'string') {
        const existing = nextOwnerships[input.agentId];
        if (!existing || existing.sessionId !== input.sessionId) {
          nextOwnerships[input.agentId] = {
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            agentId: input.agentId,
            runId: input.turnId ?? 'legacy',
            claimedAt: this.now(),
          };
        }
      }
      if (jsonEqual(nextSessionIds, state.conversation.sessionIds ?? {})
        && jsonEqual(nextConfigKeys, state.conversation.sessionConfigKeys ?? {})
        && jsonEqual(nextOwnerships, state.conversation.sessionOwnerships ?? {})) {
        return sessionResult(false, state.conversation);
      }
      if (turn && (isTerminalTurnState(turn.state) || turn.state === 'cancelRequested')) {
        throw new ConversationTurnStateError(`Turn ${turn.id} no longer accepts session patches.`);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      if (typeof input.sessionId === 'string' && input.sessionId.trim()) {
        const owner = await this.readSessionOwnerFromIndex(context, input.sessionId);
        if (owner && (owner.conversationId !== input.conversationId || owner.agentId !== input.agentId)) {
          throw new ConversationSessionConflictError({
            sessionId: owner.sessionId,
            conversationId: owner.conversationId,
            agentId: owner.agentId,
            runId: owner.runId,
            claimedAt: owner.claimedAt,
          });
        }
      }
      const allocation = await this.allocateGlobalUnlocked(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      next.sessionIds = nextSessionIds;
      next.sessionConfigKeys = nextConfigKeys;
      next.sessionOwnerships = nextOwnerships;
      next.updatedAt = now;
      next.revision = allocation.revision;
      const entry = await this.commitConversationEvent(
        state,
        next,
        state.archivedAt,
        turn?.id ?? '_conversation',
        {
          type: 'patchSession',
          agentId: input.agentId,
          sessionId: input.sessionId,
          configKey: input.configKey,
          ownership: input.sessionId === null ? null : cloneJson(nextOwnerships[input.agentId]),
          updatedAt: now,
        },
        false,
      );
      if (input.sessionId !== undefined) {
        const durableOwner = input.sessionId === null ? null : nextOwnerships[input.agentId];
        await this.replaceIndexedSessionOwner(
          context,
          previousSessionId,
          durableOwner ? { ...durableOwner, updatedAt: now } : null,
          { conversationId: input.conversationId, agentId: input.agentId },
        );
      }
      await this.upsertCatalogEntryUnlocked(context, entry);
      return sessionResult(true, next);
      });
    });
  }

  async claimSessionOwnership(input: ConversationSessionClaimInput): Promise<SessionMutationResult> {
    const conversationId = requireNonEmptyString(input.conversationId, 'conversation id');
    const sessionId = requireNonEmptyString(input.sessionId, 'runtime session id');
    const runId = requireNonEmptyString(input.runId, 'runtime run id');
    return this.enqueueConversation(conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      return this.enqueueCleanCatalogMutation(context, async () => {
      const state = await this.loadConversationMutationState(context, conversationId, {
        requireNonterminalMessages: false,
      });
      const lookup = await this.loadSessionOwnerLookup(context, sessionId);
      const existing = lookup.owner;
      if (existing && (existing.conversationId !== conversationId
        || existing.agentId !== input.agentId)) {
        throw new ConversationSessionConflictError({
          sessionId: existing.sessionId,
          conversationId: existing.conversationId,
          agentId: existing.agentId,
          runId: existing.runId,
          claimedAt: existing.claimedAt,
        });
      }
      const current = state.conversation.sessionOwnerships?.[input.agentId];
      const desiredConfigKey = input.sessionConfigKey === undefined
        ? state.conversation.sessionConfigKeys?.[input.agentId]
        : input.sessionConfigKey;
      if (existing && current
        && existing.conversationId === current.conversationId
        && existing.agentId === current.agentId
        && existing.sessionId === current.sessionId
        && existing.runId === runId
        && state.conversation.sessionIds?.[input.agentId] === sessionId
        && (state.conversation.sessionConfigKeys?.[input.agentId] ?? undefined)
          === desiredConfigKey) {
        return sessionResult(false, state.conversation);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const allocation = await this.allocateGlobalUnlocked(context, conversationId, false);
      const now = this.now();
      const owner: ConversationSessionOwner = {
        sessionId,
        conversationId,
        agentId: input.agentId,
        runId,
        claimedAt: now,
      };
      const next = cloneJson(state.conversation);
      next.sessionIds = { ...(next.sessionIds ?? {}), [input.agentId]: sessionId };
      next.sessionConfigKeys = { ...(next.sessionConfigKeys ?? {}) };
      assignNullableAgentValue(
        next.sessionConfigKeys,
        input.agentId,
        input.sessionConfigKey === undefined ? undefined : input.sessionConfigKey,
      );
      next.sessionOwnerships = { ...(next.sessionOwnerships ?? {}), [input.agentId]: owner };
      next.updatedAt = now;
      next.revision = allocation.revision;
      const entry = await this.commitConversationEvent(state, next, state.archivedAt, runId, {
        type: 'patchSession',
        agentId: input.agentId,
        sessionId,
        configKey: input.sessionConfigKey,
        ownership: cloneJson(owner),
        updatedAt: now,
      }, false);
      await this.replaceIndexedSessionOwner(
        context,
        state.conversation.sessionIds?.[input.agentId] ?? null,
        { ...owner, updatedAt: now },
        { conversationId, agentId: input.agentId },
        lookup,
      );
      await this.upsertCatalogEntryUnlocked(context, entry);
      return sessionResult(true, next);
      });
    });
  }

  async requestTurnCancellation(input: ConversationMutationInput): Promise<TurnMutationResult> {
    return this.mutateExistingConversation(input.conversationId, async (state, context) => {
      const turn = requireTurn(state.conversation, input.turnId);
      if (turn.state === 'cancelRequested' || isTerminalTurnState(turn.state)) {
        return turnResult(false, state.conversation, turn);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const allocation = await this.allocateGlobal(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const nextTurn = requireTurn(next, turn.id);
      nextTurn.state = 'cancelRequested';
      nextTurn.cancelRequestedAt = now;
      nextTurn.updatedAt = now;
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, turn.id, {
        type: 'turnUpdate', turn: cloneJson(nextTurn), updatedAt: now,
      });
      return turnResult(true, next, nextTurn);
    });
  }

  async finalizeTurn(input: FinalizeTurnInput): Promise<TurnMutationResult> {
    return this.mutateExistingConversation(input.conversationId, async (state, context) => {
      const turn = requireTurn(state.conversation, input.turnId);
      const outcome = input.outcome ?? 'completed';
      if (turn.state === 'cancelRequested' || turn.state === 'cancelled') {
        return turnResult(false, state.conversation, turn);
      }
      const assistant = requireTurnAssistant(state.conversation, turn);
      const nextAssistant = input.assistantPatch
        ? applyMessagePatch(assistant, input.assistantPatch)
        : assistant;
      if (turn.state === outcome && jsonEqual(assistant, nextAssistant)) {
        return turnResult(false, state.conversation, turn);
      }
      if (isTerminalTurnState(turn.state)) {
        throw new ConversationTurnStateError(`Turn ${turn.id} already ended as ${turn.state}.`);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const allocation = await this.allocateGlobal(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const nextTurn = requireTurn(next, turn.id);
      const storedAssistant = requireTurnAssistant(next, nextTurn);
      assignMessage(storedAssistant, nextAssistant);
      nextTurn.state = outcome;
      nextTurn.updatedAt = now;
      nextTurn.completedAt = now;
      if (input.error !== undefined) nextTurn.error = input.error;
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, turn.id, {
        type: 'turnUpdate',
        turn: cloneJson(nextTurn),
        assistantMessage: cloneJson(storedAssistant),
        updatedAt: now,
      });
      await this.compactConversation(context, input.conversationId);
      return turnResult(true, next, nextTurn);
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<TurnMutationResult> {
    return this.mutateExistingConversation(input.conversationId, async (state, context) => {
      const turn = requireTurn(state.conversation, input.turnId);
      const assistant = requireTurnAssistant(state.conversation, turn);
      const nextAssistant = input.assistantPatch
        ? applyMessagePatch(assistant, input.assistantPatch)
        : assistant;
      if (turn.state === 'cancelled' && jsonEqual(assistant, nextAssistant)) {
        return turnResult(false, state.conversation, turn);
      }
      if (isTerminalTurnState(turn.state)) {
        return turnResult(false, state.conversation, turn);
      }
      assertExpectedRevision(state.conversation, input.expectedRevision);
      const allocation = await this.allocateGlobal(context, input.conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const nextTurn = requireTurn(next, turn.id);
      const storedAssistant = requireTurnAssistant(next, nextTurn);
      assignMessage(storedAssistant, nextAssistant);
      nextTurn.state = 'cancelled';
      nextTurn.cancelRequestedAt ??= now;
      nextTurn.updatedAt = now;
      nextTurn.completedAt = now;
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, turn.id, {
        type: 'turnUpdate',
        turn: cloneJson(nextTurn),
        assistantMessage: cloneJson(storedAssistant),
        updatedAt: now,
      });
      await this.compactConversation(context, input.conversationId);
      return turnResult(true, next, nextTurn);
    });
  }

  async recoverInterruptedTurns(): Promise<ConversationRecoveryResult> {
    const context = await this.readActiveContext();
    await this.readCatalogWithRepair(context);
    const conversationRoot = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY);
    const directories = await listFolders(this.adapter, conversationRoot);
    const recoverableIds: string[] = [];
    for (const directory of directories) {
      const runStatePath = joinPath(conversationRoot, directory, RUN_STATE_PATH);
      if (!(await this.adapter.exists(runStatePath))) continue;
      const snapshot = parseChecksummed<ConversationSnapshot>(
        await readRequired(
          this.adapter,
          joinPath(conversationRoot, directory, SNAPSHOT_PATH),
          'conversation snapshot',
        ),
        'conversation snapshot',
      );
      validateSnapshot(snapshot, context.generation);
      const runState = parseRunState(
        await this.adapter.read(runStatePath),
        context.generation,
        snapshot.conversationId,
      );
      if (runState.turns.some(turn => (
        turn.state === 'queued' || turn.state === 'active' || turn.state === 'cancelRequested'
      ))) recoverableIds.push(runState.conversationId);
    }
    const results = await Promise.all(recoverableIds.map(id => this.recoverConversation(id)));
    const transitions = results.flatMap(result => result.transitions.map(transition => ({
      transition,
      queueSequence: result.minQueueSequence,
    }))).sort((left, right) => left.queueSequence - right.queueSequence)
      .map(item => item.transition);
    return {
      applied: transitions.length > 0,
      transitions,
      conversations: results
        .filter(result => result.conversation !== null)
        .map(result => cloneJson(result.conversation!)),
    };
  }

  private enqueueConversation<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const key = conversationDirectoryName(conversationId);
    const previous = this.conversationTails.get(key) ?? Promise.resolve();
    const result = previous.then(async () => {
      // A failed predecessor may have left a catalog marker that this process
      // still classified as local. Reclassify it before the retry begins so
      // readCatalogWithRepair can rebuild instead of waiting on this new tail.
      this.localPendingMutations.delete(conversationId);
      return operation();
    });
    const settled = result.then(() => undefined, () => undefined);
    this.conversationTails.set(key, settled);
    void settled.finally(() => {
      if (this.conversationTails.get(key) === settled) {
        this.conversationTails.delete(key);
        this.localPendingMutations.delete(conversationId);
      }
    });
    return result;
  }

  private enqueueCatalog<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.catalogTail.then(operation);
    this.catalogTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async enqueueCleanCatalogMutation<T>(
    context: ActiveGenerationContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CATALOG_READ_EPOCH_ATTEMPTS; attempt += 1) {
      await this.readCatalogWithRepair(context);
      const result = await this.enqueueCatalog(async () => {
        const catalog = await this.readCatalog(context);
        if ((catalog.pendingMutations ?? []).length > 0) {
          return { retry: true as const };
        }
        return { retry: false as const, value: await operation() };
      });
      if (!result.retry) return result.value;
    }
    throw new ConversationStoreAtomicWriteError(
      'The v2 catalog never reached a clean mutation epoch.',
    );
  }

  private async mutateExistingConversation<T>(
    conversationId: string,
    operation: (
      state: LoadedConversationState,
      context: ActiveGenerationContext,
    ) => Promise<T>,
    options: {
      requireNonterminalMessages?: boolean;
      requiredMessageIds?: readonly string[];
    } = {},
  ): Promise<T> {
    return this.enqueueConversation(conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      const state = await this.loadConversationMutationState(context, conversationId, options);
      return operation(state, context);
    });
  }

  private async readActiveContext(): Promise<ActiveGenerationContext> {
    let pointerRaw: string;
    try {
      pointerRaw = await this.adapter.read(CHAT_STORE_POINTER_PATH);
    } catch (error) {
      throw new ConversationStoreCorruptError(
        `The v2 chat-store pointer could not be read: ${errorMessage(error)}`,
      );
    }
    const pointer = parseChecksummed<ChatStorePointer>(pointerRaw, 'v2 chat-store pointer');
    if (pointer.version !== 2 || !isSafeGeneration(pointer.activeGeneration)
      || !isSha256(pointer.manifestHash)) {
      throw new ConversationStoreCorruptError('The v2 chat-store pointer is invalid.');
    }
    const generation = pointer.activeGeneration;
    const generationRoot = generationRootPath(generation);
    const manifestPath = joinPath(generationRoot, MANIFEST_PATH);
    let manifestRaw: string;
    try {
      manifestRaw = await this.adapter.read(manifestPath);
    } catch (error) {
      throw new ConversationStoreCorruptError(
        `The active v2 manifest could not be read: ${errorMessage(error)}`,
      );
    }
    if (sha256(manifestRaw) !== pointer.manifestHash) {
      throw new ConversationStoreCorruptError('The active v2 manifest hash does not match the pointer.');
    }
    const manifest = parseChecksummed<GenerationManifest>(manifestRaw, 'v2 manifest');
    validateManifest(manifest, generation);
    return { pointer, pointerRaw, generation, generationRoot, manifest, manifestRaw };
  }

  private async readCatalogWithRepair(context: ActiveGenerationContext): Promise<Catalog> {
    let catalog: Catalog;
    try {
      catalog = await this.readCatalog(context);
    } catch (error) {
      if (!(error instanceof ConversationStoreCorruptError)) throw error;
      try {
        await this.assertWrite(true);
      } catch {
        // A read-only instance must never replace a corrupt cache or silently
        // omit session owners. Fail closed and let the writer repair it.
        throw error;
      }
      await this.enqueueCatalog(() => this.rebuildCatalogUnlocked(context));
      catalog = await this.readCatalog(context);
    }
    const pending = catalog.pendingMutations ?? [];
    if (pending.length === 0) return catalog;

    const tails = new Set<Promise<void>>();
    const allLocal = pending.every(mutation => {
      if (!this.isLocalPendingMutation(mutation)) return false;
      const tail = this.conversationTails.get(conversationDirectoryName(mutation.conversationId));
      if (!tail) return false;
      tails.add(tail);
      return true;
    });
    if (allLocal) {
      await Promise.all(tails);
      return this.readCatalogWithRepair(context);
    }

    try {
      await this.assertWrite(true);
    } catch {
      throw new ConversationStoreCorruptError(
        'The v2 catalog contains an unfinished mutation and requires writer recovery.',
      );
    }
    await this.enqueueCatalog(() => this.rebuildCatalogUnlocked(context));
    return this.readCatalog(context);
  }

  private async readCatalog(context: ActiveGenerationContext): Promise<Catalog> {
    const path = joinPath(context.generationRoot, CATALOG_PATH);
    let raw: string;
    try {
      raw = await this.adapter.read(path);
    } catch (error) {
      throw new ConversationStoreCorruptError(`The v2 catalog could not be read: ${errorMessage(error)}`);
    }
    const catalog = parseChecksummed<Catalog>(raw, 'v2 catalog');
    validateCatalog(catalog, context.generation);
    return catalog;
  }

  private async readConsistentCatalogView<T>(
    context: ActiveGenerationContext,
    reader: (catalog: Catalog) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < MAX_CATALOG_READ_EPOCH_ATTEMPTS; attempt += 1) {
      const before = await this.readCatalogWithRepair(context);
      if ((before.pendingMutations ?? []).length > 0) continue;
      let value: T | undefined;
      let readError: unknown;
      try {
        value = await reader(before);
      } catch (error) {
        readError = error;
      }
      const after = await this.readCatalogWithRepair(context);
      if ((after.pendingMutations ?? []).length > 0 || after.checksum !== before.checksum) {
        continue;
      }
      if (readError !== undefined) {
        if (readError instanceof CatalogReadEpochChangedError) continue;
        if (readError instanceof Error) throw readError;
        throw new ConversationStoreCorruptError(errorMessage(readError));
      }
      return value as T;
    }
    throw new ConversationStoreCorruptError(
      'The v2 catalog changed repeatedly while reading a combined conversation view.',
    );
  }

  private assertConversationMatchesCatalog(
    conversation: Pick<VersionedStoredConversation, 'id' | 'revision'>,
    entry: CatalogEntry,
  ): void {
    if (conversation.id !== entry.id || conversation.revision !== entry.revision) {
      throw new CatalogReadEpochChangedError();
    }
  }

  private assertSessionOwnerMatchesCatalog(
    owner: ConversationSessionOwnership,
    catalog: Catalog,
  ): void {
    const entry = catalog.entries.find(item => item.id === owner.conversationId);
    const durableOwner = entry?.sessionOwnerships[owner.agentId];
    if (!entry
      || entry.sessions[owner.agentId] !== owner.sessionId
      || (durableOwner
        ? durableOwner.sessionId !== owner.sessionId
          || durableOwner.conversationId !== owner.conversationId
          || durableOwner.agentId !== owner.agentId
          || durableOwner.runId !== owner.runId
          || durableOwner.claimedAt !== owner.claimedAt
        : owner.runId !== 'legacy' || owner.claimedAt !== entry.updatedAt)) {
      throw new CatalogReadEpochChangedError();
    }
  }

  private async rebuildCatalogUnlocked(
    context: ActiveGenerationContext,
  ): Promise<CatalogRebuildReport> {
    const conversationRoot = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY);
    await ensureDirectory(this.adapter, conversationRoot);
    const catalogPath = joinPath(context.generationRoot, CATALOG_PATH);
    const existingRaw = await readOptional(this.adapter, catalogPath);
    let previousRevision = 0;
    let previousNextQueue = 1;
    let interruptedMutations: CatalogPendingMutation[] = [];
    if (existingRaw !== null) {
      try {
        const existing = parseChecksummed<Catalog>(existingRaw, 'v2 catalog');
        validateCatalog(existing, context.generation);
        previousRevision = existing.revision;
        previousNextQueue = existing.nextQueueSequence;
        interruptedMutations = cloneJson(existing.pendingMutations ?? []);
      } catch {
        // Body files below remain canonical when the derivable cache itself is corrupt.
      }
    }
    const directories = await listFolders(this.adapter, conversationRoot);
    const entries: CatalogEntry[] = [];
    let maxRevision = 0;
    let maxQueueSequence = 0;
    const seenIds = new Set<string>();
    const seenSessions = new Map<string, string>();
    const sessionOwnerships: ConversationSessionOwnership[] = [];
    for (const directory of directories.sort()) {
      const runStatePath = joinPath(conversationRoot, directory, RUN_STATE_PATH);
      if (!(await this.adapter.exists(runStatePath))) continue; // draft-only directory
      const snapshot = parseChecksummed<ConversationSnapshot>(
        await readRequired(
          this.adapter,
          joinPath(conversationRoot, directory, SNAPSHOT_PATH),
          'conversation snapshot',
        ),
        'conversation snapshot',
      );
      validateSnapshot(snapshot, context.generation);
      const runState = parseRunState(
        await this.adapter.read(runStatePath),
        context.generation,
        snapshot.conversationId,
      );
      if (seenIds.has(runState.conversationId)) {
        throw new ConversationStoreCorruptError(`Duplicate v2 conversation ${runState.conversationId}.`);
      }
      seenIds.add(runState.conversationId);
      if (directory !== conversationDirectoryName(runState.conversationId)) {
        throw new ConversationStoreCorruptError(
          `Conversation ${runState.conversationId} is stored in the wrong directory.`,
        );
      }
      const firstVisibilityRevision = interruptedMutations
        .filter(mutation => (
          mutation.conversationId === runState.conversationId && !mutation.wasCataloged
        ))
        .reduce((minimum, mutation) => Math.min(minimum, mutation.revision), Number.MAX_SAFE_INTEGER);
      if (runState.revision < firstVisibilityRevision
        && firstVisibilityRevision !== Number.MAX_SAFE_INTEGER) {
        // A crash after seeding an empty body but before its first durable
        // event must not create a phantom history item. The body is retained
        // so an idempotent retry can finish it.
        continue;
      }
      let entry: CatalogEntry | null = null;
      const metaRaw = await readOptional(this.adapter, joinPath(conversationRoot, directory, META_PATH));
      if (metaRaw !== null) {
        try {
          const meta = parseConversationMeta(metaRaw, context.generation, directory);
          if (meta.id === runState.conversationId && meta.revision === runState.revision) {
            entry = catalogEntryFromMeta(meta);
          }
        } catch {
          // Fall through to full body replay only when the derivable meta cache
          // is corrupt or stale.
        }
      }
      if (!entry) {
        const state = await this.loadConversationStateFromDirectory(context, directory);
        entry = catalogEntryFromConversation(state.conversation, state.archivedAt);
        await this.writeConversationMeta(context, directory, entry, false, true);
      }
      for (const [agentId, sessionId] of Object.entries(runState.sessionIds)) {
        if (!sessionId) continue;
        const owner = `${runState.conversationId}/${agentId}`;
        const previous = seenSessions.get(sessionId);
        if (previous && previous !== owner) {
          throw new ConversationStoreCorruptError(
            `Runtime session ${sessionId} has multiple persisted owners.`,
          );
        }
        seenSessions.set(sessionId, owner);
        const durableOwner = runState.sessionOwnerships[requireAgentId(agentId, 'run-state session agent')];
        sessionOwnerships.push({
          sessionId,
          conversationId: runState.conversationId,
          agentId: requireAgentId(agentId, 'run-state session agent'),
          updatedAt: entry.updatedAt,
          runId: durableOwner?.runId ?? 'legacy',
          claimedAt: durableOwner?.claimedAt ?? entry.updatedAt,
        });
      }
      maxRevision = Math.max(maxRevision, runState.revision);
      for (const turn of runState.turns) {
        maxQueueSequence = Math.max(maxQueueSequence, turn.queueSequence);
      }
      entries.push(entry);
    }
    const catalog = withChecksum<CatalogUnsigned>({
      version: 2,
      generation: context.generation,
      revision: Math.max(previousRevision, maxRevision),
      nextQueueSequence: Math.max(previousNextQueue, maxQueueSequence + 1),
      entries: sortCatalogEntries(entries),
      pendingMutations: [],
    });
    // Install a complete new sharded generation before clearing the catalog's
    // pending marker. Readers either see the old complete generation or the
    // new complete generation; they never accept a partially rebuilt shard set.
    await this.rebuildSessionOwnerIndex(context, sessionOwnerships);
    await this.atomicCasChecksummed(
      catalogPath,
      catalog,
      existingRaw,
    );
    return {
      generation: context.generation,
      conversationCount: entries.length,
      sessionCount: seenSessions.size,
      revision: catalog.revision,
    };
  }

  private async scanSessionOwnerships(
    context: ActiveGenerationContext,
  ): Promise<ConversationSessionOwnership[]> {
    const conversationRoot = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY);
    const directories = await listFolders(this.adapter, conversationRoot);
    const ownerships: ConversationSessionOwnership[] = [];
    const seen = new Map<string, ConversationSessionOwnership>();
    for (const directoryName of directories) {
      const runStatePath = joinPath(conversationRoot, directoryName, RUN_STATE_PATH);
      if (!(await this.adapter.exists(runStatePath))) continue; // draft-only directory
      const snapshot = parseChecksummed<ConversationSnapshot>(
        await readRequired(
          this.adapter,
          joinPath(conversationRoot, directoryName, SNAPSHOT_PATH),
          'conversation snapshot',
        ),
        'conversation snapshot',
      );
      validateSnapshot(snapshot, context.generation);
      const runState = parseRunState(
        await this.adapter.read(runStatePath),
        context.generation,
        snapshot.conversationId,
      );
      let updatedAt = snapshot.conversation.updatedAt;
      const metaRaw = await readOptional(
        this.adapter,
        joinPath(conversationRoot, directoryName, META_PATH),
      );
      if (metaRaw !== null) {
        try {
          const meta = parseConversationMeta(metaRaw, context.generation, directoryName);
          if (meta.id === snapshot.conversationId && meta.revision === runState.revision) {
            updatedAt = meta.updatedAt;
          }
        } catch {
          // The body/run-state remain canonical. A later catalog rebuild can
          // repair derivable meta without hiding a session owner here.
        }
      }
      for (const [rawAgentId, sessionId] of Object.entries(runState.sessionIds)) {
        if (!sessionId) continue;
        const agentId = requireAgentId(rawAgentId, 'run-state session agent');
        const durableOwner = runState.sessionOwnerships[agentId];
        const ownership: ConversationSessionOwnership = {
          sessionId,
          conversationId: runState.conversationId,
          agentId,
          updatedAt,
          runId: durableOwner?.runId ?? 'legacy',
          claimedAt: durableOwner?.claimedAt ?? updatedAt,
        };
        const previous = seen.get(sessionId);
        if (previous && (previous.conversationId !== ownership.conversationId
          || previous.agentId !== ownership.agentId)) {
          throw new ConversationStoreCorruptError(
            `Runtime session ${sessionId} has multiple persisted owners.`,
          );
        }
        seen.set(sessionId, ownership);
        ownerships.push(ownership);
      }
    }
    return ownerships;
  }

  private async readSessionOwnerIndexPointer(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
  ): Promise<SessionOwnerIndexPointer> {
    const raw = await readRequired(
      this.adapter,
      joinPath(context.generationRoot, SESSION_OWNER_INDEX_PATH),
      'session-owner index pointer',
    );
    const pointer = parseChecksummed<SessionOwnerIndexPointer>(raw, 'session-owner index pointer');
    validateSessionOwnerIndexPointer(pointer, context.generation);
    return pointer;
  }

  private async readSessionOwnerBucket(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    pointer: SessionOwnerIndexPointer,
    shard: string,
  ): Promise<{ bucket: SessionOwnerBucket; raw: string; path: string }> {
    const indexGeneration = sessionOwnerBucketGeneration(pointer, shard);
    const path = sessionOwnerBucketPath(context.generationRoot, indexGeneration, shard);
    const raw = await readRequired(this.adapter, path, `session-owner index bucket ${shard}`);
    const bucket = parseChecksummed<SessionOwnerBucket>(raw, `session-owner index bucket ${shard}`);
    validateSessionOwnerBucket(bucket, context.generation, indexGeneration, shard);
    return { bucket, raw, path };
  }

  private async readSessionOwnerFromIndex(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    sessionId: string,
  ): Promise<ConversationSessionOwnership | null> {
    return (await this.loadSessionOwnerLookup(context, sessionId)).owner;
  }

  private async loadSessionOwnerLookup(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    sessionId: string,
  ): Promise<SessionOwnerLookup> {
    const pointerPath = joinPath(context.generationRoot, SESSION_OWNER_INDEX_PATH);
    const pointerRaw = await readRequired(this.adapter, pointerPath, 'session-owner index pointer');
    const pointer = parseChecksummed<SessionOwnerIndexPointer>(pointerRaw, 'session-owner index pointer');
    validateSessionOwnerIndexPointer(pointer, context.generation);
    const sessionHash = sha256(sessionId);
    const loaded = await this.readSessionOwnerBucket(
      context,
      pointer,
      sessionOwnerShard(sessionHash),
    );
    const indexed = loaded.bucket.owners.find(owner => owner.sessionHash === sessionHash);
    if (indexed && indexed.sessionId !== sessionId) {
      throw new ConversationStoreCorruptError(
        `Session-owner index hash collision or identity mismatch for ${sessionHash}.`,
      );
    }
    const owner = indexed
      ? (({ sessionHash: _sessionHash, ...ownership }) => cloneJson(ownership))(indexed)
      : null;
    return {
      pointer,
      pointerRaw,
      bucket: loaded.bucket,
      bucketRaw: loaded.raw,
      bucketPath: loaded.path,
      sessionHash,
      owner,
    };
  }

  private async readAllSessionOwnersFromIndex(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
  ): Promise<ConversationSessionOwnership[]> {
    const pointer = await this.readSessionOwnerIndexPointer(context);
    const result: ConversationSessionOwnership[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < SESSION_OWNER_BUCKET_COUNT; index += 1) {
      const shard = index.toString(16).padStart(2, '0');
      const { bucket } = await this.readSessionOwnerBucket(context, pointer, shard);
      for (const indexed of bucket.owners) {
        if (seen.has(indexed.sessionId)) {
          throw new ConversationStoreCorruptError(
            `Runtime session ${indexed.sessionId} appears more than once in the owner index.`,
          );
        }
        seen.add(indexed.sessionId);
        result.push(cloneJson({
          sessionId: indexed.sessionId,
          conversationId: indexed.conversationId,
          agentId: indexed.agentId,
          updatedAt: indexed.updatedAt,
          runId: indexed.runId,
          claimedAt: indexed.claimedAt,
        }));
      }
    }
    if (result.length !== pointer.ownerCount) {
      throw new ConversationStoreCorruptError(
        `Session-owner index count mismatch: expected ${pointer.ownerCount}, found ${result.length}.`,
      );
    }
    return result;
  }

  private async rebuildSessionOwnerIndex(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    ownerships: readonly ConversationSessionOwnership[],
  ): Promise<void> {
    const normalized = normalizeSessionIndexOwnerships(ownerships);
    const indexGeneration = sessionOwnerIndexGenerationId(normalized);
    const buckets = new Map<string, SessionOwnerIndexEntry[]>();
    for (const owner of normalized) {
      const sessionHash = sha256(owner.sessionId);
      const shard = sessionOwnerShard(sessionHash);
      const values = buckets.get(shard) ?? [];
      values.push({ ...cloneJson(owner), sessionHash });
      buckets.set(shard, values);
    }
    const indexRoot = sessionOwnerIndexGenerationRoot(context.generationRoot, indexGeneration);
    await ensureDirectory(this.adapter, joinPath(indexRoot, SESSION_OWNER_BUCKETS_DIRECTORY));
    for (let index = 0; index < SESSION_OWNER_BUCKET_COUNT; index += 1) {
      const shard = index.toString(16).padStart(2, '0');
      const bucket = withChecksum<SessionOwnerBucketUnsigned>({
        version: 1,
        generation: context.generation,
        indexGeneration,
        shard,
        owners: [...(buckets.get(shard) ?? [])]
          .sort((left, right) => left.sessionHash.localeCompare(right.sessionHash)),
      });
      await this.writeImmutableChecksummed(
        sessionOwnerBucketPath(context.generationRoot, indexGeneration, shard),
        bucket,
      );
    }
    const pointerPath = joinPath(context.generationRoot, SESSION_OWNER_INDEX_PATH);
    const existingRaw = await readOptional(this.adapter, pointerPath);
    const pointer = withChecksum<SessionOwnerIndexPointerUnsigned>({
      version: 2,
      generation: context.generation,
      indexGeneration,
      bucketGenerations: Object.fromEntries(
        sessionOwnerShards().map(shard => [shard, indexGeneration]),
      ),
      bucketCount: SESSION_OWNER_BUCKET_COUNT,
      ownerCount: normalized.length,
      builtAt: normalized.reduce((latest, owner) => Math.max(latest, owner.updatedAt), 0),
    });
    await this.atomicCasChecksummed(pointerPath, pointer, existingRaw);
  }

  private async replaceIndexedSessionOwner(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    previousSessionId: string | null,
    nextOwner: ConversationSessionOwnership | null,
    expectedScope: Pick<ConversationSessionOwnership, 'conversationId' | 'agentId'>,
    nextLookup?: SessionOwnerLookup,
  ): Promise<void> {
    const pointerPath = joinPath(context.generationRoot, SESSION_OWNER_INDEX_PATH);
    const pointerRaw = nextLookup?.pointerRaw
      ?? await readRequired(this.adapter, pointerPath, 'session-owner index pointer');
    const pointer = nextLookup?.pointer
      ?? parseChecksummed<SessionOwnerIndexPointer>(pointerRaw, 'session-owner index pointer');
    validateSessionOwnerIndexPointer(pointer, context.generation);
    const ids = [...new Set([
      previousSessionId?.trim() || null,
      nextOwner?.sessionId.trim() || null,
    ].filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return;
    const loaded = new Map<string, { bucket: SessionOwnerBucket; raw: string; path: string }>();
    if (nextLookup) {
      loaded.set(nextLookup.bucket.shard, {
        bucket: nextLookup.bucket,
        raw: nextLookup.bucketRaw,
        path: nextLookup.bucketPath,
      });
    }
    for (const sessionId of ids) {
      const shard = sessionOwnerShard(sha256(sessionId));
      if (!loaded.has(shard)) {
        loaded.set(shard, await this.readSessionOwnerBucket(context, pointer, shard));
      }
    }
    const ownersByShard = new Map(
      [...loaded.entries()].map(([shard, item]) => [shard, item.bucket.owners.map(cloneJson)]),
    );
    let removed = 0;
    let added = 0;
    if (previousSessionId) {
      const sessionHash = sha256(previousSessionId);
      const shard = sessionOwnerShard(sessionHash);
      const owners = ownersByShard.get(shard)!;
      const previous = owners.find(owner => (
        owner.sessionHash === sessionHash && owner.sessionId === previousSessionId
      ));
      if (!previous) {
        throw new ConversationStoreCorruptError(
          `Session-owner index is missing persisted session ${previousSessionId}.`,
        );
      }
      if (previous.conversationId !== expectedScope.conversationId
        || previous.agentId !== expectedScope.agentId) {
        throw new ConversationStoreCorruptError(
          `Persisted session ${previousSessionId} does not match its conversation owner.`,
        );
      }
      ownersByShard.set(shard, owners.filter(owner => !(
        owner.sessionHash === sessionHash && owner.sessionId === previousSessionId
      )));
      removed += 1;
    }
    if (nextOwner) {
      const normalized = normalizeSessionIndexOwnerships([nextOwner])[0];
      const sessionHash = sha256(normalized.sessionId);
      const shard = sessionOwnerShard(sessionHash);
      const owners = ownersByShard.get(shard)!;
      const existing = owners.find(owner => owner.sessionHash === sessionHash);
      if (existing && (existing.sessionId !== normalized.sessionId
        || existing.conversationId !== normalized.conversationId
        || existing.agentId !== normalized.agentId)) {
        throw new ConversationSessionConflictError(existing);
      }
      const nextOwners = owners.filter(owner => owner.sessionHash !== sessionHash);
      if (!existing) added += 1;
      nextOwners.push({ ...cloneJson(normalized), sessionHash });
      ownersByShard.set(shard, nextOwners);
    }
    const indexGeneration = sessionOwnerMutationGenerationId(pointer, ownersByShard);
    for (const [shard, owners] of ownersByShard) {
      const bucket = withChecksum<SessionOwnerBucketUnsigned>({
        version: 1,
        generation: context.generation,
        indexGeneration,
        shard,
        owners: owners.sort((left, right) => left.sessionHash.localeCompare(right.sessionHash)),
      });
      await this.writeImmutableChecksummed(
        sessionOwnerBucketPath(context.generationRoot, indexGeneration, shard),
        bucket,
      );
    }
    const ownerCount = pointer.ownerCount - removed + added;
    const bucketGenerations = sessionOwnerBucketGenerationMap(pointer);
    for (const shard of ownersByShard.keys()) bucketGenerations[shard] = indexGeneration;
    const nextPointer = withChecksum<SessionOwnerIndexPointerUnsigned>({
      version: 2,
      generation: pointer.generation,
      indexGeneration: pointer.indexGeneration,
      bucketGenerations,
      bucketCount: pointer.bucketCount,
      ownerCount,
      builtAt: Math.max(pointer.builtAt, nextOwner?.updatedAt ?? 0),
    });
    if (!jsonEqual(pointer, nextPointer)) {
      await this.atomicCasChecksummed(pointerPath, nextPointer, pointerRaw);
    }
  }

  private allocateGlobal(
    context: ActiveGenerationContext,
    conversationId: string,
    withQueueSequence: boolean,
  ): Promise<Allocation> {
    return this.enqueueCatalog(() => (
      this.allocateGlobalUnlocked(context, conversationId, withQueueSequence)
    ));
  }

  private async allocateGlobalUnlocked(
    context: ActiveGenerationContext,
    conversationId: string,
    withQueueSequence: boolean,
  ): Promise<Allocation> {
    const path = joinPath(context.generationRoot, CATALOG_PATH);
    let raw = await this.adapter.read(path);
    let catalog = parseChecksummed<Catalog>(raw, 'v2 catalog');
    validateCatalog(catalog, context.generation);
    const pending = catalog.pendingMutations ?? [];
    if (pending.some(mutation => !this.isLocalPendingMutation(mutation))) {
      if (pending.some(mutation => this.isLocalPendingMutation(mutation))) {
        throw new ConversationStoreAtomicWriteError(
          'Catalog recovery is deferred until in-flight conversation mutations settle.',
        );
      }
      await this.rebuildCatalogUnlocked(context);
      raw = await this.adapter.read(path);
      catalog = parseChecksummed<Catalog>(raw, 'v2 catalog');
      validateCatalog(catalog, context.generation);
    }
    const allocation: Allocation = {
      revision: catalog.revision + 1,
      ...(withQueueSequence ? { queueSequence: catalog.nextQueueSequence } : {}),
    };
    const marker: CatalogPendingMutation = {
      conversationId,
      revision: allocation.revision,
      wasCataloged: catalog.entries.some(entry => entry.id === conversationId),
      writerInstanceId: this.instanceId,
    };
    const next = withChecksum<CatalogUnsigned>({
      version: 2,
      generation: catalog.generation,
      revision: allocation.revision,
      nextQueueSequence: withQueueSequence
        ? catalog.nextQueueSequence + 1
        : catalog.nextQueueSequence,
      entries: catalog.entries,
      pendingMutations: [...(catalog.pendingMutations ?? []), marker],
    });
    await this.atomicCasChecksummed(path, next, raw);
    const local = this.localPendingMutations.get(conversationId) ?? new Set<number>();
    local.add(allocation.revision);
    this.localPendingMutations.set(conversationId, local);
    return allocation;
  }

  private upsertCatalogEntry(
    context: ActiveGenerationContext,
    entry: CatalogEntry,
  ): Promise<void> {
    return this.enqueueCatalog(() => this.upsertCatalogEntryUnlocked(context, entry));
  }

  private async upsertCatalogEntryUnlocked(
    context: ActiveGenerationContext,
    entry: CatalogEntry,
  ): Promise<void> {
    const path = joinPath(context.generationRoot, CATALOG_PATH);
    const raw = await this.adapter.read(path);
    const catalog = parseChecksummed<Catalog>(raw, 'v2 catalog');
    validateCatalog(catalog, context.generation);
    const currentEntry = catalog.entries.find(item => item.id === entry.id);
    const pendingMutations = (catalog.pendingMutations ?? []).filter(mutation => !(
      mutation.conversationId === entry.id && mutation.revision <= entry.revision
    ));
    const removedPending = pendingMutations.length !== (catalog.pendingMutations ?? []).length;
    if (currentEntry && currentEntry.revision > entry.revision && !removedPending) return;
    if (currentEntry && currentEntry.revision === entry.revision) {
      if (jsonEqual(currentEntry, entry) && !removedPending) return;
      if (!jsonEqual(currentEntry, entry)) {
        throw new ConversationStoreCorruptError(
          `Catalog entry ${entry.id} revision ${entry.revision} has conflicting content.`,
        );
      }
    }
    const entries = currentEntry && currentEntry.revision > entry.revision
      ? [...catalog.entries]
      : [...catalog.entries.filter(item => item.id !== entry.id), cloneJson(entry)];
    const next = withChecksum<CatalogUnsigned>({
      version: 2,
      generation: catalog.generation,
      revision: Math.max(catalog.revision, entry.revision),
      nextQueueSequence: catalog.nextQueueSequence,
      entries: sortCatalogEntries(entries),
      pendingMutations,
    });
    await this.atomicCasChecksummed(path, next, raw);
  }

  private isLocalPendingMutation(mutation: CatalogPendingMutation): boolean {
    return this.localPendingMutations.get(mutation.conversationId)?.has(mutation.revision) ?? false;
  }

  private async writeInitialConversation(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    conversation: VersionedStoredConversation,
    archivedAt: number | null,
  ): Promise<void> {
    const normalized = this.normalizeConversation(conversation, `conversation ${conversation.id}`);
    if (normalized.contextCheckpoint) {
      verifyContextCheckpointBinding(normalized, normalized.contextCheckpoint);
    }
    const directoryName = conversationDirectoryName(normalized.id);
    const root = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY, directoryName);
    await ensureDirectory(this.adapter, joinPath(root, MESSAGES_DIRECTORY));
    await ensureDirectory(this.adapter, joinPath(root, JOURNALS_DIRECTORY));

    const chunks = await this.writeMessageChunks(context, root, normalized);
    const snapshot = withChecksum<ConversationSnapshotUnsigned>({
      version: 2,
      generation: context.generation,
      conversationId: normalized.id,
      revision: normalized.revision,
      archivedAt,
      journalSequence: 0,
      journalChecksum: null,
      messageCount: normalized.messages.length,
      chunks,
      conversation: snapshotConversationFrom(normalized),
    });
    await this.writeImmutableChecksummed(joinPath(root, SNAPSHOT_PATH), snapshot);

    const runState = withChecksum<RunStateUnsigned>({
      version: 2,
      generation: context.generation,
      conversationId: normalized.id,
      revision: normalized.revision,
      turnsMode: 'tail',
      turns: normalized.turns.filter(turn => !isTerminalTurnState(turn.state)).map(cloneJson),
      sessionIds: cloneJson(normalized.sessionIds ?? {}),
      sessionConfigKeys: cloneJson(normalized.sessionConfigKeys ?? {}),
      sessionOwnerships: cloneJson(normalized.sessionOwnerships ?? {}),
      headSequence: 0,
      headChecksum: null,
      journalSegments: [],
      pendingJournalRecord: null,
      pendingJournalPath: null,
      retiredTruncatedSegments: [],
    });
    await this.writeImmutableChecksummed(joinPath(root, RUN_STATE_PATH), runState);
    await this.writeConversationMeta(
      context,
      directoryName,
      catalogEntryFromConversation(normalized, archivedAt),
      true,
    );
  }

  private async writeMessageChunks(
    context: Pick<ActiveGenerationContext, 'generation'>,
    conversationRoot: string,
    conversation: VersionedStoredConversation,
  ): Promise<MessageChunkDescriptor[]> {
    const descriptors: MessageChunkDescriptor[] = [];
    for (let offset = 0; offset < conversation.messages.length;) {
      const { values, serialized } = buildSerializedMessageChunk(
        context.generation,
        conversation.id,
        conversation.revision,
        conversation.messages,
        offset,
        1,
      );
      const filename = `chunk-${String(offset + 1).padStart(8, '0')}-r${conversation.revision}-${sha256(JSON.stringify(values)).slice(0, 12)}.json`;
      const relativePath = joinPath(MESSAGES_DIRECTORY, filename);
      await this.writeImmutableText(
        joinPath(conversationRoot, relativePath),
        serialized,
        undefined,
        CHAT_V2_MAX_MESSAGE_CHUNK_BYTES,
      );
      descriptors.push({
        path: relativePath,
        startSequence: values[0].sequence,
        endSequence: values.at(-1)!.sequence,
        count: values.length,
        hash: sha256(serialized),
      });
      offset += values.length;
    }
    return descriptors;
  }

  private async writeAppendedMessageChunks(
    context: Pick<ActiveGenerationContext, 'generation'>,
    conversationRoot: string,
    conversationId: string,
    revision: number,
    firstSequence: number,
    messages: readonly ChatMessage[],
  ): Promise<MessageChunkDescriptor[]> {
    const descriptors: MessageChunkDescriptor[] = [];
    for (let offset = 0; offset < messages.length;) {
      const { values, serialized } = buildSerializedMessageChunk(
        context.generation,
        conversationId,
        revision,
        messages,
        offset,
        firstSequence,
      );
      const filename = `chunk-${String(values[0].sequence).padStart(8, '0')}-r${revision}-${sha256(JSON.stringify(values)).slice(0, 12)}.json`;
      const relativePath = joinPath(MESSAGES_DIRECTORY, filename);
      await this.writeImmutableText(
        joinPath(conversationRoot, relativePath),
        serialized,
        undefined,
        CHAT_V2_MAX_MESSAGE_CHUNK_BYTES,
      );
      descriptors.push({
        path: relativePath,
        startSequence: values[0].sequence,
        endSequence: values.at(-1)!.sequence,
        count: values.length,
        hash: sha256(serialized),
      });
      offset += values.length;
    }
    return descriptors;
  }

  private async writeConversationMeta(
    context: Pick<ActiveGenerationContext, 'generation' | 'generationRoot'>,
    directoryName: string,
    entry: CatalogEntry,
    immutable = false,
    repair = false,
  ): Promise<void> {
    const path = joinPath(
      context.generationRoot,
      CONVERSATIONS_DIRECTORY,
      directoryName,
      META_PATH,
    );
    const meta = withChecksum<ConversationMetaUnsigned>({
      ...cloneJson(entry),
      version: 2,
      generation: context.generation,
      directoryName,
    });
    if (immutable) await this.writeImmutableChecksummed(path, meta);
    else {
      const currentRaw = await readOptional(this.adapter, path);
      if (currentRaw !== null) {
        try {
          const current = parseChecksummed<ConversationMeta>(currentRaw, 'conversation meta');
          if (current.id !== entry.id || current.directoryName !== directoryName
            || current.generation !== context.generation) {
            throw new ConversationStoreCorruptError('Conversation meta identity is invalid.');
          }
          if (current.revision > entry.revision) return;
          if (current.revision === entry.revision) {
            if (jsonEqual(current, meta)) return;
            if (!repair) {
              throw new ConversationStoreCorruptError(
                `Conversation meta revision ${entry.revision} has conflicting content.`,
              );
            }
          }
        } catch (error) {
          if (!repair) throw error;
        }
      }
      await this.atomicCasChecksummed(path, meta, currentRaw);
    }
  }

  private async loadConversationStateOrNull(
    context: ActiveGenerationContext,
    conversationId: string,
  ): Promise<LoadedConversationState | null> {
    const snapshotPath = conversationFilePath(context.generationRoot, conversationId, SNAPSHOT_PATH);
    const runStatePath = conversationFilePath(context.generationRoot, conversationId, RUN_STATE_PATH);
    const snapshotExists = await this.adapter.exists(snapshotPath);
    const runStateExists = await this.adapter.exists(runStatePath);
    if (!snapshotExists && !runStateExists) return null;
    if (!snapshotExists || !runStateExists) {
      throw new ConversationStoreCorruptError(
        `Conversation ${conversationId} has an incomplete v2 body.`,
      );
    }
    return this.loadConversationState(context, conversationId);
  }

  private async loadConversationMutationStateOrNull(
    context: ActiveGenerationContext,
    conversationId: string,
    options: {
      requireNonterminalMessages?: boolean;
      requiredMessageIds?: readonly string[];
    } = {},
  ): Promise<LoadedConversationState | null> {
    const snapshotPath = conversationFilePath(context.generationRoot, conversationId, SNAPSHOT_PATH);
    const runStatePath = conversationFilePath(context.generationRoot, conversationId, RUN_STATE_PATH);
    const snapshotExists = await this.adapter.exists(snapshotPath);
    const runStateExists = await this.adapter.exists(runStatePath);
    if (!snapshotExists && !runStateExists) return null;
    if (!snapshotExists || !runStateExists) {
      throw new ConversationStoreCorruptError(
        `Conversation ${conversationId} has an incomplete v2 body.`,
      );
    }
    return this.loadConversationMutationState(context, conversationId, options);
  }

  private loadConversationState(
    context: ActiveGenerationContext,
    conversationId: string,
  ): Promise<LoadedConversationState> {
    return this.loadConversationStateFromDirectory(context, conversationDirectoryName(conversationId), conversationId);
  }

  private async loadConversationStateFromDirectory(
    context: ActiveGenerationContext,
    directoryName: string,
    expectedConversationId?: string,
  ): Promise<LoadedConversationState> {
    if (!isSafeDirectoryName(directoryName)) {
      throw new ConversationStoreCorruptError(`Invalid v2 conversation directory ${directoryName}.`);
    }
    const root = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY, directoryName);
    const snapshotRaw = await readRequired(this.adapter, joinPath(root, SNAPSHOT_PATH), 'conversation snapshot');
    const snapshot = parseChecksummed<ConversationSnapshot>(snapshotRaw, 'conversation snapshot');
    validateSnapshot(snapshot, context.generation);
    if (expectedConversationId !== undefined && snapshot.conversationId !== expectedConversationId) {
      throw new ConversationStoreCorruptError(
        `Conversation directory ${directoryName} contains ${snapshot.conversationId}.`,
      );
    }
    if (conversationDirectoryName(snapshot.conversationId) !== directoryName) {
      throw new ConversationStoreCorruptError(
        `Conversation ${snapshot.conversationId} directory hash does not match.`,
      );
    }
    const runStatePath = joinPath(root, RUN_STATE_PATH);
    const runStateRaw = await readRequired(this.adapter, runStatePath, 'conversation run-state');
    const runState = parseRunState(runStateRaw, context.generation, snapshot.conversationId);

    const sequencedMessages: SequencedChatMessage[] = [];
    let expectedMessageSequence = 1;
    for (const descriptor of snapshot.chunks) {
      validateChunkDescriptor(descriptor, expectedMessageSequence);
      const raw = await readRequired(
        this.adapter,
        joinPath(root, descriptor.path),
        'message chunk',
        CHAT_V2_MAX_MESSAGE_CHUNK_BYTES,
      );
      if (sha256(raw) !== descriptor.hash) {
        throw new ConversationStoreCorruptError(`Message chunk ${descriptor.path} hash mismatch.`);
      }
      const chunk = parseChecksummed<MessageChunk>(raw, `message chunk ${descriptor.path}`);
      validateMessageChunk(chunk, snapshot, descriptor);
      for (const value of chunk.messages) {
        if (value.sequence !== expectedMessageSequence) {
          throw new ConversationStoreCorruptError('Message chunk sequences are not contiguous.');
        }
        sequencedMessages.push({
          sequence: value.sequence,
          message: normalizeMessage(value.message, `message ${value.sequence}`),
        });
        expectedMessageSequence += 1;
      }
    }
    if (sequencedMessages.length !== snapshot.messageCount) {
      throw new ConversationStoreCorruptError('Snapshot message count does not match its chunks.');
    }
    let conversation = this.normalizeConversation({
      ...cloneJson(snapshot.conversation),
      messages: sequencedMessages.map(item => item.message),
      revision: snapshot.revision,
      turns: cloneJson(snapshot.conversation.turns),
      ...(snapshot.conversation.sessionIds === undefined
        ? {}
        : { sessionIds: cloneJson(snapshot.conversation.sessionIds) }),
      ...(snapshot.conversation.sessionConfigKeys === undefined
        ? {}
        : { sessionConfigKeys: cloneJson(snapshot.conversation.sessionConfigKeys) }),
      ...(snapshot.conversation.sessionOwnerships === undefined
        ? {}
        : { sessionOwnerships: cloneJson(snapshot.conversation.sessionOwnerships) }),
    }, `conversation ${snapshot.conversationId}`);
    let archivedAt = snapshot.archivedAt;
    const records: JournalRecord[] = [];
    const segmentRaws = new Map<string, string>();
    const truncatedSegments: string[] = [];
    for (const relativePath of runState.journalSegments) {
      if (!isSafeRelativeJournalPath(relativePath)) {
        throw new ConversationStoreCorruptError(`Invalid journal path ${relativePath}.`);
      }
      const raw = await readRequired(
        this.adapter,
        joinPath(root, relativePath),
        'conversation journal',
        CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
      );
      segmentRaws.set(relativePath, raw);
      const parsed = parseJournalSegment(raw, relativePath);
      if (parsed.truncatedTail) truncatedSegments.push(relativePath);
      records.push(...parsed.records);
    }
    records.sort((left, right) => left.sequence - right.sequence);
    const chainBaseline = journalChainBaseline(records, snapshot);
    validateJournalChain(
      records.slice(chainBaseline.recordOffset),
      context.generation,
      snapshot.conversationId,
      chainBaseline.sequence,
      chainBaseline.checksum,
      chainBaseline.revision,
      this.normalizeConversation,
    );
    const bySequence = new Map(records.map(record => [record.sequence, record]));
    if (bySequence.size !== records.length) {
      throw new ConversationStoreCorruptError('Conversation journal contains duplicate sequences.');
    }
    if (records.length > 0 && records.at(-1)!.sequence < snapshot.journalSequence) {
      throw new ConversationStoreCorruptError('Conversation journal is older than its snapshot.');
    }
    for (const record of records) {
      if (record.sequence <= snapshot.journalSequence) continue;
      ({ conversation, archivedAt } = applyJournalRecord(conversation, archivedAt, record, this.normalizeConversation));
    }
    const durableHead = records.at(-1) ?? null;
    let logicalHeadSequence = durableHead?.sequence ?? snapshot.journalSequence;
    let logicalHeadChecksum = durableHead?.checksum ?? snapshot.journalChecksum;
    if (runState.pendingJournalRecord) {
      const pending = runState.pendingJournalRecord;
      validateJournalRecord(
        pending,
        context.generation,
        snapshot.conversationId,
        this.normalizeConversation,
      );
      const durable = bySequence.get(pending.sequence);
      if (durable && !jsonEqual(durable, pending)) {
        throw new ConversationStoreCorruptError('Pending journal record conflicts with durable journal data.');
      }
      if (!durable) {
        if (pending.sequence !== logicalHeadSequence + 1
          || pending.previousChecksum !== logicalHeadChecksum) {
          throw new ConversationStoreCorruptError('Pending journal record does not extend the journal head.');
        }
        ({ conversation, archivedAt } = applyJournalRecord(
          conversation,
          archivedAt,
          pending,
          this.normalizeConversation,
        ));
      }
      logicalHeadSequence = pending.sequence;
      logicalHeadChecksum = pending.checksum;
    }
    if (runState.pendingJournalRecord === null) {
      if (runState.headSequence !== logicalHeadSequence || runState.headChecksum !== logicalHeadChecksum) {
        throw new ConversationStoreCorruptError('Run-state journal head does not match durable records.');
      }
    } else if (runState.headSequence !== runState.pendingJournalRecord.sequence - 1
      || runState.headChecksum !== runState.pendingJournalRecord.previousChecksum
      || !runState.pendingJournalPath) {
      throw new ConversationStoreCorruptError('Run-state pending journal metadata is inconsistent.');
    }
    if (conversation.revision !== runState.revision
      || !jsonEqual(conversation.turns, materializeRunStateTurns(snapshot.conversation.turns, runState))
      || !jsonEqual(conversation.sessionIds ?? {}, runState.sessionIds)
      || !jsonEqual(conversation.sessionConfigKeys ?? {}, runState.sessionConfigKeys)
      || !jsonEqual(conversation.sessionOwnerships ?? {}, runState.sessionOwnerships)) {
      throw new ConversationStoreCorruptError('Run-state does not match the replayed conversation.');
    }
    return {
      context,
      directoryName,
      conversation,
      archivedAt,
      lastSequence: logicalHeadSequence,
      lastChecksum: logicalHeadChecksum,
      runState,
      runStateRaw,
      snapshotRaw,
      segmentRaws,
      truncatedSegments,
      snapshot,
      catalogEntry: catalogEntryFromConversation(conversation, archivedAt),
      partial: false,
    };
  }

  /**
   * Loads the mutable header/run state and only messages appended after the
   * immutable snapshot. Normal begin/checkpoint/final paths therefore never
   * touch historical message chunks. Legacy/exceptional shapes fall back to
   * the full loader instead of weakening validation.
   */
  private async loadConversationMutationState(
    context: ActiveGenerationContext,
    conversationId: string,
    options: {
      requireNonterminalMessages?: boolean;
      requiredMessageIds?: readonly string[];
    } = {},
  ): Promise<LoadedConversationState> {
    const directoryName = conversationDirectoryName(conversationId);
    const root = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY, directoryName);
    const snapshotRaw = await readRequired(
      this.adapter,
      joinPath(root, SNAPSHOT_PATH),
      'conversation snapshot',
    );
    const snapshot = parseChecksummed<ConversationSnapshot>(snapshotRaw, 'conversation snapshot');
    validateSnapshot(snapshot, context.generation);
    if (snapshot.conversationId !== conversationId) {
      throw new ConversationStoreCorruptError(`Conversation ${conversationId} snapshot identity mismatch.`);
    }
    validateSnapshotChunkDescriptors(snapshot);

    const runStateRaw = await readRequired(
      this.adapter,
      joinPath(root, RUN_STATE_PATH),
      'conversation run-state',
    );
    const runState = parseRunState(runStateRaw, context.generation, conversationId);
    const meta = parseConversationMeta(
      await readRequired(this.adapter, joinPath(root, META_PATH), 'conversation meta'),
      context.generation,
      directoryName,
    );

    const records: JournalRecord[] = [];
    const segmentRaws = new Map<string, string>();
    const truncatedSegments: string[] = [];
    for (const relativePath of runState.journalSegments) {
      if (!isSafeRelativeJournalPath(relativePath)) {
        throw new ConversationStoreCorruptError(`Invalid journal path ${relativePath}.`);
      }
      const raw = await readRequired(
        this.adapter,
        joinPath(root, relativePath),
        'conversation journal',
        CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
      );
      segmentRaws.set(relativePath, raw);
      const parsed = parseJournalSegment(raw, relativePath);
      if (parsed.truncatedTail) truncatedSegments.push(relativePath);
      records.push(...parsed.records);
    }
    records.sort((left, right) => left.sequence - right.sequence);
    const baseline = journalChainBaseline(records, snapshot);
    validateJournalChain(
      records.slice(baseline.recordOffset),
      context.generation,
      conversationId,
      baseline.sequence,
      baseline.checksum,
      baseline.revision,
      this.normalizeConversation,
    );
    const bySequence = new Map(records.map(record => [record.sequence, record]));
    if (bySequence.size !== records.length) {
      throw new ConversationStoreCorruptError('Conversation journal contains duplicate sequences.');
    }
    const durableHead = records.at(-1) ?? null;
    let logicalHeadSequence = durableHead?.sequence ?? snapshot.journalSequence;
    let logicalHeadChecksum = durableHead?.checksum ?? snapshot.journalChecksum;
    const replayRecords = records.filter(record => record.sequence > snapshot.journalSequence);
    if (runState.pendingJournalRecord) {
      const pending = runState.pendingJournalRecord;
      validateJournalRecord(
        pending,
        context.generation,
        conversationId,
        this.normalizeConversation,
      );
      const durable = bySequence.get(pending.sequence);
      if (durable && !jsonEqual(durable, pending)) {
        throw new ConversationStoreCorruptError('Pending journal record conflicts with durable journal data.');
      }
      if (!durable) {
        if (pending.sequence !== logicalHeadSequence + 1
          || pending.previousChecksum !== logicalHeadChecksum) {
          throw new ConversationStoreCorruptError('Pending journal record does not extend the journal head.');
        }
        replayRecords.push(pending);
      }
      logicalHeadSequence = pending.sequence;
      logicalHeadChecksum = pending.checksum;
    }
    if (runState.pendingJournalRecord === null) {
      if (runState.headSequence !== logicalHeadSequence || runState.headChecksum !== logicalHeadChecksum) {
        throw new ConversationStoreCorruptError('Run-state journal head does not match durable records.');
      }
    } else if (runState.headSequence !== runState.pendingJournalRecord.sequence - 1
      || runState.headChecksum !== runState.pendingJournalRecord.previousChecksum
      || !runState.pendingJournalPath) {
      throw new ConversationStoreCorruptError('Run-state pending journal metadata is inconsistent.');
    }

    let archivedAt = snapshot.archivedAt;
    const conversation: VersionedStoredConversation = {
      ...cloneJson(snapshot.conversation),
      messages: [],
      turns: materializeRunStateTurns(snapshot.conversation.turns, runState),
      sessionIds: cloneJson(runState.sessionIds),
      sessionConfigKeys: cloneJson(runState.sessionConfigKeys),
      sessionOwnerships: cloneJson(runState.sessionOwnerships),
      revision: snapshot.revision,
    };
    for (const record of replayRecords) {
      const event = record.event;
      switch (event.type) {
        case 'beginTurn':
          if (event.contextCheckpoint) {
            if (event.contextCheckpoint.sourceRevision !== conversation.revision) {
              throw new ConversationStoreCorruptError(
                'Atomic context checkpoint source revision does not match its journal predecessor.',
              );
            }
            conversation.contextCheckpoint = cloneJson(event.contextCheckpoint);
          }
          conversation.title = event.title;
          conversation.agentId = event.agentId;
          conversation.createdAt = event.createdAt;
          conversation.updatedAt = event.updatedAt;
          conversation.messages.push(
            cloneJson(event.userMessage),
            cloneJson(event.assistantMessage),
          );
          break;
        case 'appendMessage':
          conversation.title = event.title;
          conversation.updatedAt = event.updatedAt;
          conversation.messages.push(cloneJson(event.message));
          break;
        case 'patchMessage': {
          const index = conversation.messages.findIndex(message => message.id === event.message.id);
          if (index >= 0) conversation.messages[index] = cloneJson(event.message);
          conversation.updatedAt = event.updatedAt;
          break;
        }
        case 'patchSession':
          conversation.updatedAt = event.updatedAt;
          break;
        case 'setContextCheckpoint':
          if (event.checkpoint.sourceRevision !== conversation.revision) {
            throw new ConversationStoreCorruptError(
              'Context checkpoint source revision does not match its journal predecessor.',
            );
          }
          conversation.contextCheckpoint = cloneJson(event.checkpoint);
          conversation.updatedAt = event.updatedAt;
          break;
        case 'turnUpdate': {
          if (event.assistantMessage) {
            const index = conversation.messages.findIndex(message => (
              message.id === event.assistantMessage!.id
            ));
            if (index >= 0) conversation.messages[index] = cloneJson(event.assistantMessage);
          }
          conversation.updatedAt = event.updatedAt;
          break;
        }
        case 'archive':
          archivedAt = event.archivedAt;
          conversation.updatedAt = event.updatedAt;
          break;
        case 'restore':
          archivedAt = null;
          conversation.updatedAt = event.updatedAt;
          break;
        case 'replaceConversation':
        case 'recovery':
          return this.loadConversationState(context, conversationId);
        default:
          throw new ConversationStoreCorruptError('Conversation journal event type is unsupported.');
      }
      conversation.revision = record.revision;
    }
    conversation.revision = runState.revision;
    conversation.turns = materializeRunStateTurns(snapshot.conversation.turns, runState)
      .map((turn, index) => normalizeTurn(turn, `active-tail turn ${index + 1}`));
    conversation.sessionIds = cloneJson(runState.sessionIds);
    conversation.sessionConfigKeys = cloneJson(runState.sessionConfigKeys);
    conversation.sessionOwnerships = cloneJson(runState.sessionOwnerships);
    conversation.messages = conversation.messages.map((value, index) => (
      normalizeMessage(value, `active-tail message ${index + 1}`)
    ));

    // A stale meta means a prior crash stopped between journal finalization and
    // index repair. The full loader provides an exact projection for recovery.
    if (meta.revision !== conversation.revision || meta.archivedAt !== archivedAt) {
      return this.loadConversationState(context, conversationId);
    }
    const availableMessageIds = new Set(conversation.messages.map(message => message.id));
    const requiredMessageIds = new Set(options.requiredMessageIds ?? []);
    if (options.requireNonterminalMessages ?? true) {
      for (const turn of conversation.turns) {
        if (isTerminalTurnState(turn.state)) continue;
        requiredMessageIds.add(turn.userMessageId);
        requiredMessageIds.add(turn.assistantMessageId);
      }
    }
    if ([...requiredMessageIds].some(messageId => !availableMessageIds.has(messageId))) {
      return this.loadConversationState(context, conversationId);
    }

    return {
      context,
      directoryName,
      conversation,
      archivedAt,
      lastSequence: logicalHeadSequence,
      lastChecksum: logicalHeadChecksum,
      runState,
      runStateRaw,
      snapshotRaw,
      segmentRaws,
      truncatedSegments,
      snapshot,
      catalogEntry: catalogEntryFromMeta(meta),
      partial: true,
    };
  }

  private async loadConversationSlice(
    context: ActiveGenerationContext,
    conversationId: string,
    beforeSequence: number | null,
    limit: number,
  ): Promise<SelectiveConversationSlice> {
    const directoryName = conversationDirectoryName(conversationId);
    const root = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY, directoryName);
    const snapshotRaw = await readRequired(this.adapter, joinPath(root, SNAPSHOT_PATH), 'conversation snapshot');
    const snapshot = parseChecksummed<ConversationSnapshot>(snapshotRaw, 'conversation snapshot');
    validateSnapshot(snapshot, context.generation);
    if (snapshot.conversationId !== conversationId) {
      throw new ConversationStoreCorruptError(`Conversation ${conversationId} snapshot identity mismatch.`);
    }
    const runState = parseRunState(
      await readRequired(this.adapter, joinPath(root, RUN_STATE_PATH), 'conversation run-state'),
      context.generation,
      conversationId,
    );
    const records: JournalRecord[] = [];
    for (const relativePath of runState.journalSegments) {
      if (!isSafeRelativeJournalPath(relativePath)) {
        throw new ConversationStoreCorruptError(`Invalid journal path ${relativePath}.`);
      }
      const parsed = parseJournalSegment(
        await readRequired(
          this.adapter,
          joinPath(root, relativePath),
          'conversation journal',
          CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
        ),
        relativePath,
      );
      records.push(...parsed.records);
    }
    records.sort((left, right) => left.sequence - right.sequence);
    const baseline = journalChainBaseline(records, snapshot);
    validateJournalChain(
      records.slice(baseline.recordOffset),
      context.generation,
      conversationId,
      baseline.sequence,
      baseline.checksum,
      baseline.revision,
      this.normalizeConversation,
    );
    if (runState.pendingJournalRecord) {
      const pending = runState.pendingJournalRecord;
      validateJournalRecord(
        pending,
        context.generation,
        conversationId,
        this.normalizeConversation,
      );
      const durable = records.find(record => record.sequence === pending.sequence);
      if (durable && !jsonEqual(durable, pending)) {
        throw new ConversationStoreCorruptError('Pending journal record conflicts with durable journal data.');
      }
      if (!durable) {
        const durableHead = records.at(-1);
        const headSequence = durableHead?.sequence ?? snapshot.journalSequence;
        const headChecksum = durableHead?.checksum ?? snapshot.journalChecksum;
        if (pending.sequence !== headSequence + 1 || pending.previousChecksum !== headChecksum) {
          throw new ConversationStoreCorruptError('Pending journal record does not extend the journal head.');
        }
        records.push(pending);
      }
    }
    records.sort((left, right) => left.sequence - right.sequence);

    const header: VersionedStoredConversation = {
      ...cloneJson(snapshot.conversation),
      messages: [],
      turns: cloneJson(snapshot.conversation.turns),
      ...(snapshot.conversation.sessionIds === undefined
        ? {}
        : { sessionIds: cloneJson(snapshot.conversation.sessionIds) }),
      ...(snapshot.conversation.sessionConfigKeys === undefined
        ? {}
        : { sessionConfigKeys: cloneJson(snapshot.conversation.sessionConfigKeys) }),
      ...(snapshot.conversation.sessionOwnerships === undefined
        ? {}
        : { sessionOwnerships: cloneJson(snapshot.conversation.sessionOwnerships) }),
    };
    let appended: ChatMessage[] = [];
    const patches = new Map<string, ChatMessage>();
    let materializedMessages: ChatMessage[] | null = null;
    for (const record of records) {
      if (record.sequence <= snapshot.journalSequence) continue;
      const event = record.event;
      switch (event.type) {
        case 'beginTurn':
          if (event.contextCheckpoint) {
            if (event.contextCheckpoint.sourceRevision !== header.revision) {
              throw new ConversationStoreCorruptError(
                'Atomic context checkpoint source revision does not match its journal predecessor.',
              );
            }
            header.contextCheckpoint = cloneJson(event.contextCheckpoint);
          }
          header.title = event.title;
          header.agentId = event.agentId;
          header.updatedAt = event.updatedAt;
          header.turns.push(cloneJson(event.turn));
          if (materializedMessages) {
            materializedMessages.push(cloneJson(event.userMessage), cloneJson(event.assistantMessage));
          } else {
            appended.push(cloneJson(event.userMessage), cloneJson(event.assistantMessage));
          }
          break;
        case 'appendMessage':
          header.title = event.title;
          header.updatedAt = event.updatedAt;
          if (materializedMessages) materializedMessages.push(cloneJson(event.message));
          else appended.push(cloneJson(event.message));
          break;
        case 'patchMessage':
          {
            const patched = normalizeMessage(event.message, `journal message ${event.message.id}`);
            patches.set(patched.id, patched);
            if (materializedMessages) {
              const index = materializedMessages.findIndex(message => message.id === patched.id);
              if (index >= 0) materializedMessages[index] = patched;
            }
          }
          header.updatedAt = event.updatedAt;
          break;
        case 'patchSession': {
          const sessions = { ...(header.sessionIds ?? {}) };
          const configs = { ...(header.sessionConfigKeys ?? {}) };
          const ownerships = { ...(header.sessionOwnerships ?? {}) };
          assignNullableAgentValue(sessions, event.agentId, event.sessionId);
          assignNullableAgentValue(configs, event.agentId, event.configKey);
          if (event.ownership === null || event.sessionId === null) delete ownerships[event.agentId];
          else if (event.ownership) ownerships[event.agentId] = cloneJson(event.ownership);
          header.sessionIds = sessions;
          header.sessionConfigKeys = configs;
          header.sessionOwnerships = ownerships;
          header.updatedAt = event.updatedAt;
          break;
        }
        case 'setContextCheckpoint':
          if (event.checkpoint.sourceRevision !== header.revision) {
            throw new ConversationStoreCorruptError(
              'Context checkpoint source revision does not match its journal predecessor.',
            );
          }
          header.contextCheckpoint = cloneJson(event.checkpoint);
          header.updatedAt = event.updatedAt;
          break;
        case 'turnUpdate': {
          const index = header.turns.findIndex(turn => turn.id === event.turn.id);
          if (index < 0) throw new ConversationStoreCorruptError('Journal updates a missing turn.');
          header.turns[index] = cloneJson(event.turn);
          if (event.assistantMessage) {
            const assistant = normalizeMessage(
              event.assistantMessage,
              `journal assistant message ${event.assistantMessage.id}`,
            );
            patches.set(assistant.id, assistant);
          }
          header.updatedAt = event.updatedAt;
          break;
        }
        case 'replaceConversation':
        case 'recovery': {
          const replacement = cloneJson(event.conversation);
          Object.assign(header, replacement, { messages: [] });
          materializedMessages = replacement.messages;
          appended = [];
          patches.clear();
          break;
        }
        case 'archive':
        case 'restore':
          header.updatedAt = event.updatedAt;
          break;
        default:
          throw new ConversationStoreCorruptError('Conversation journal event type is unsupported.');
      }
      header.revision = record.revision;
    }
    if (header.revision !== runState.revision
      || !jsonEqual(header.turns, materializeRunStateTurns(snapshot.conversation.turns, runState))
      || !jsonEqual(header.sessionIds ?? {}, runState.sessionIds)
      || !jsonEqual(header.sessionConfigKeys ?? {}, runState.sessionConfigKeys)
      || !jsonEqual(header.sessionOwnerships ?? {}, runState.sessionOwnerships)) {
      throw new ConversationStoreCorruptError('Window replay does not match conversation run-state.');
    }

    validateSnapshotChunkDescriptors(snapshot);
    const total = materializedMessages?.length ?? snapshot.messageCount + appended.length;
    const boundedLimit = normalizeLimit(limit, 100);
    const exclusiveEnd = beforeSequence === null
      ? total + 1
      : Math.min(total + 1, normalizeBeforeSequence(beforeSequence));
    const endIndex = Math.max(0, exclusiveEnd - 1);
    const startIndex = Math.max(0, endIndex - boundedLimit);
    const selected: SequencedChatMessage[] = [];
    if (materializedMessages) {
      for (let index = startIndex; index < endIndex; index += 1) {
        const message = materializedMessages[index];
        if (message) selected.push({ sequence: index + 1, message: normalizeMessage(message, `message ${index + 1}`) });
      }
    } else {
      const firstSequence = startIndex + 1;
      const lastSequence = endIndex;
      const relevantChunks = snapshot.chunks.filter(descriptor => (
        descriptor.endSequence >= firstSequence
          && descriptor.startSequence <= Math.min(lastSequence, snapshot.messageCount)
      ));
      for (const descriptor of relevantChunks) {
        const raw = await readRequired(
          this.adapter,
          joinPath(root, descriptor.path),
          'message chunk',
          CHAT_V2_MAX_MESSAGE_CHUNK_BYTES,
        );
        if (sha256(raw) !== descriptor.hash) {
          throw new ConversationStoreCorruptError(`Message chunk ${descriptor.path} hash mismatch.`);
        }
        const chunk = parseChecksummed<MessageChunk>(raw, `message chunk ${descriptor.path}`);
        validateMessageChunk(chunk, snapshot, descriptor);
        for (const value of chunk.messages) {
          if (value.sequence < firstSequence || value.sequence > lastSequence) continue;
          const message = normalizeMessage(value.message, `message ${value.sequence}`);
          selected.push({ sequence: value.sequence, message: patches.get(message.id) ?? message });
        }
      }
      appended.forEach((message, index) => {
        const sequence = snapshot.messageCount + index + 1;
        if (sequence < firstSequence || sequence > lastSequence) return;
        const normalized = normalizeMessage(message, `message ${sequence}`);
        selected.push({ sequence, message: patches.get(normalized.id) ?? normalized });
      });
      selected.sort((left, right) => left.sequence - right.sequence);
    }
    assertMessageWindowBudget(selected);
    header.messages = selected.map(item => cloneJson(item.message));
    return {
      conversation: header,
      messages: selected.map(item => cloneJson(item)),
      nextBeforeSequence: startIndex > 0 ? startIndex + 1 : null,
      totalMessageCount: total,
    };
  }

  private async commitConversationEvent(
    originalState: LoadedConversationState,
    nextConversation: VersionedStoredConversation,
    nextArchivedAt: number | null,
    turnId: string,
    event: JournalEvent,
    updateCatalog = true,
  ): Promise<CatalogEntry> {
    let state = originalState;
    if (state.runState.pendingJournalRecord) {
      await this.finishPendingJournal(state);
      state = state.partial
        ? await this.loadConversationMutationState(state.context, state.conversation.id)
        : await this.loadConversationState(state.context, state.conversation.id);
    }
    if (nextConversation.revision <= state.conversation.revision) {
      throw new ConversationStoreAtomicWriteError(
        `Conversation ${nextConversation.id} revision did not advance.`,
      );
    }
    const record = withChecksum<JournalRecordUnsigned>({
      version: 2,
      generation: state.context.generation,
      conversationId: nextConversation.id,
      turnId,
      sequence: state.lastSequence + 1,
      revision: nextConversation.revision,
      previousChecksum: state.lastChecksum,
      event: cloneJson(event),
    });
    const retired = uniqueStrings([
      ...state.runState.retiredTruncatedSegments,
      ...state.truncatedSegments,
    ]);
    const journalPath = selectJournalPath(state, turnId, record.sequence, retired);
    const expectedJournalRaw = state.segmentRaws.get(journalPath) ?? null;
    assertJournalAppendBudget(expectedJournalRaw, record);
    const segments = state.runState.journalSegments.includes(journalPath)
      ? [...state.runState.journalSegments]
      : [...state.runState.journalSegments, journalPath];
    const pending = withChecksum<RunStateUnsigned>({
      version: 2,
      generation: state.context.generation,
      conversationId: nextConversation.id,
      revision: nextConversation.revision,
      turnsMode: 'tail',
      turns: mutationRunStateTurns(nextConversation.turns, state.snapshot.conversation.turns),
      sessionIds: cloneJson(nextConversation.sessionIds ?? {}),
      sessionConfigKeys: cloneJson(nextConversation.sessionConfigKeys ?? {}),
      sessionOwnerships: cloneJson(nextConversation.sessionOwnerships ?? {}),
      headSequence: state.runState.headSequence,
      headChecksum: state.runState.headChecksum,
      journalSegments: segments,
      pendingJournalRecord: record,
      pendingJournalPath: journalPath,
      retiredTruncatedSegments: retired,
    });
    const runStatePath = conversationFilePath(
      state.context.generationRoot,
      nextConversation.id,
      RUN_STATE_PATH,
    );
    await this.atomicCasChecksummed(runStatePath, pending, state.runStateRaw);
    await this.appendJournalRecord(
      state.context,
      nextConversation.id,
      journalPath,
      record,
      expectedJournalRaw,
    );
    const finalized = withChecksum<RunStateUnsigned>({
      version: 2,
      generation: state.context.generation,
      conversationId: nextConversation.id,
      revision: nextConversation.revision,
      turnsMode: 'tail',
      turns: mutationRunStateTurns(nextConversation.turns, state.snapshot.conversation.turns),
      sessionIds: cloneJson(nextConversation.sessionIds ?? {}),
      sessionConfigKeys: cloneJson(nextConversation.sessionConfigKeys ?? {}),
      sessionOwnerships: cloneJson(nextConversation.sessionOwnerships ?? {}),
      headSequence: record.sequence,
      headChecksum: record.checksum,
      journalSegments: segments,
      pendingJournalRecord: null,
      pendingJournalPath: null,
      retiredTruncatedSegments: retired,
    });
    await this.atomicCasChecksummed(runStatePath, finalized, serializeJson(pending));
    const entry = catalogEntryAfterEvent(
      state.catalogEntry,
      nextConversation,
      nextArchivedAt,
      event,
    );
    await this.writeConversationMeta(state.context, state.directoryName, entry);
    if (updateCatalog) await this.upsertCatalogEntry(state.context, entry);
    return entry;
  }

  private async finishPendingJournal(state: LoadedConversationState): Promise<void> {
    const record = state.runState.pendingJournalRecord;
    const journalPath = state.runState.pendingJournalPath;
    if (!record || !journalPath) return;
    await this.appendJournalRecord(
      state.context,
      state.conversation.id,
      journalPath,
      record,
      state.segmentRaws.get(journalPath) ?? null,
    );
    const finalized = withChecksum<RunStateUnsigned>({
      version: 2,
      generation: state.context.generation,
      conversationId: state.conversation.id,
      revision: state.runState.revision,
      turnsMode: state.runState.turnsMode,
      turns: cloneJson(state.runState.turns),
      sessionIds: cloneJson(state.runState.sessionIds),
      sessionConfigKeys: cloneJson(state.runState.sessionConfigKeys),
      sessionOwnerships: cloneJson(state.runState.sessionOwnerships),
      headSequence: record.sequence,
      headChecksum: record.checksum,
      journalSegments: [...state.runState.journalSegments],
      pendingJournalRecord: null,
      pendingJournalPath: null,
      retiredTruncatedSegments: [...state.runState.retiredTruncatedSegments],
    });
    await this.atomicCasChecksummed(
      conversationFilePath(state.context.generationRoot, state.conversation.id, RUN_STATE_PATH),
      finalized,
      state.runStateRaw,
    );
  }

  private async appendJournalRecord(
    context: ActiveGenerationContext,
    conversationId: string,
    relativePath: string,
    record: JournalRecord,
    expectedRaw: string | null,
  ): Promise<void> {
    const path = conversationFilePath(context.generationRoot, conversationId, relativePath);
    const line = `${JSON.stringify(record)}\n`;
    assertJournalAppendBudget(expectedRaw, record);
    if (expectedRaw === null) {
      const existing = await readOptional(this.adapter, path);
      if (existing === null) {
        await this.writeImmutableText(
          path,
          line,
          raw => {
            const parsed = parseJournalSegment(raw, relativePath);
            if (parsed.truncatedTail || parsed.records.length !== 1
              || !jsonEqual(parsed.records[0], record)) {
              throw new ConversationStoreAtomicWriteError('Journal staging validation failed.');
            }
          },
          CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
        );
        return;
      }
      const parsed = parseJournalSegment(existing, relativePath);
      const durable = parsed.records.find(item => item.sequence === record.sequence);
      if (durable && jsonEqual(durable, record)) return;
      throw new ConversationStoreAtomicWriteError(`Unexpected existing journal segment ${relativePath}.`);
    }
    const parsedExpected = parseJournalSegment(expectedRaw, relativePath);
    if (parsedExpected.truncatedTail) {
      throw new ConversationStoreAtomicWriteError(`Cannot append to truncated journal ${relativePath}.`);
    }
    const durable = parsedExpected.records.find(item => item.sequence === record.sequence);
    if (durable) {
      if (jsonEqual(durable, record)) return;
      throw new ConversationStoreAtomicWriteError('Journal sequence is already occupied.');
    }
    await this.atomicCasText(
      path,
      `${expectedRaw}${line}`,
      expectedRaw,
      raw => {
        const parsed = parseJournalSegment(raw, relativePath);
        if (parsed.truncatedTail || !parsed.records.some(item => jsonEqual(item, record))) {
          throw new ConversationStoreAtomicWriteError('Journal staging validation failed.');
        }
      },
      CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
    );
  }

  private async compactConversation(
    context: ActiveGenerationContext,
    conversationId: string,
  ): Promise<void> {
    let state = await this.loadConversationMutationState(context, conversationId);
    if (state.runState.pendingJournalRecord) {
      await this.finishPendingJournal(state);
      state = await this.loadConversationMutationState(context, conversationId);
    }
    const root = joinPath(context.generationRoot, CONVERSATIONS_DIRECTORY, state.directoryName);
    const appendedChunks = state.partial
      ? await this.writeAppendedMessageChunks(
        context,
        root,
        conversationId,
        state.conversation.revision,
        state.snapshot.messageCount + 1,
        state.conversation.messages,
      )
      : [];
    const chunks = state.partial
      ? [...state.snapshot.chunks, ...appendedChunks]
      : await this.writeMessageChunks(context, root, state.conversation);
    const messageCount = state.partial
      ? state.snapshot.messageCount + state.conversation.messages.length
      : state.conversation.messages.length;
    const snapshot = withChecksum<ConversationSnapshotUnsigned>({
      version: 2,
      generation: context.generation,
      conversationId,
      revision: state.conversation.revision,
      archivedAt: state.archivedAt,
      journalSequence: state.lastSequence,
      journalChecksum: state.lastChecksum,
      messageCount,
      chunks,
      conversation: snapshotConversationFrom(state.conversation),
    });
    await this.atomicCasChecksummed(joinPath(root, SNAPSHOT_PATH), snapshot, state.snapshotRaw);
    const trimmedRunState = withChecksum<RunStateUnsigned>({
      version: 2,
      generation: context.generation,
      conversationId,
      revision: state.runState.revision,
      turnsMode: 'tail',
      turns: state.conversation.turns
        .filter(turn => !isTerminalTurnState(turn.state))
        .map(cloneJson),
      sessionIds: cloneJson(state.runState.sessionIds),
      sessionConfigKeys: cloneJson(state.runState.sessionConfigKeys),
      sessionOwnerships: cloneJson(state.runState.sessionOwnerships),
      headSequence: state.runState.headSequence,
      headChecksum: state.runState.headChecksum,
      // Old journals remain on disk as recovery evidence. Clearing only the
      // logical segment list makes future windows depend on the new snapshot
      // plus post-snapshot deltas, keeping read IO bounded.
      journalSegments: [],
      pendingJournalRecord: null,
      pendingJournalPath: null,
      retiredTruncatedSegments: [],
    });
    await this.atomicCasChecksummed(
      joinPath(root, RUN_STATE_PATH),
      trimmedRunState,
      state.runStateRaw,
    );
  }

  private async setArchived(
    conversationId: string,
    archived: boolean,
    expectedRevision?: number,
  ): Promise<ConversationArchiveMutationResult> {
    return this.mutateExistingConversation(conversationId, async (state, context) => {
      if ((state.archivedAt !== null) === archived) {
        return {
          applied: false,
          revision: state.conversation.revision,
          archivedAt: state.archivedAt,
        };
      }
      if (archived) {
        const nonTerminal = state.conversation.turns.find(turn => !isTerminalTurnState(turn.state));
        if (nonTerminal) {
          throw new ConversationTurnStateError(
            `Conversation ${conversationId} cannot be archived while turn ${nonTerminal.id} is ${nonTerminal.state}.`,
          );
        }
      }
      assertExpectedRevision(state.conversation, expectedRevision);
      const allocation = await this.allocateGlobal(context, conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      next.updatedAt = now;
      next.revision = allocation.revision;
      const nextArchivedAt = archived ? now : null;
      await this.commitConversationEvent(state, next, nextArchivedAt, '_conversation', archived
        ? { type: 'archive', archivedAt: now, updatedAt: now }
        : { type: 'restore', updatedAt: now });
      await this.compactConversation(context, conversationId);
      return { applied: true, revision: next.revision, archivedAt: nextArchivedAt };
    }, { requireNonterminalMessages: false });
  }

  private async recoverConversation(conversationId: string): Promise<{
    conversation: VersionedStoredConversation | null;
    transitions: ConversationRecoveryResult['transitions'];
    minQueueSequence: number;
  }> {
    return this.enqueueConversation(conversationId, async () => {
      await this.assertWrite();
      const context = await this.readActiveContext();
      await this.readCatalogWithRepair(context);
      const state = await this.loadConversationState(context, conversationId);
      const pending = state.conversation.turns.filter(turn => (
        turn.state === 'queued' || turn.state === 'active' || turn.state === 'cancelRequested'
      ));
      if (pending.length === 0) {
        return { conversation: null, transitions: [], minQueueSequence: Number.MAX_SAFE_INTEGER };
      }
      const allocation = await this.allocateGlobal(context, conversationId, false);
      const now = this.now();
      const next = cloneJson(state.conversation);
      const transitions: ConversationRecoveryResult['transitions'] = [];
      for (const oldTurn of pending) {
        const turn = requireTurn(next, oldTurn.id);
        const from = oldTurn.state as 'queued' | 'active' | 'cancelRequested';
        const to = from === 'queued' ? 'paused' : 'interrupted';
        turn.state = to;
        turn.updatedAt = now;
        if (to === 'interrupted') {
          turn.completedAt = now;
          const assistant = requireTurnAssistant(next, turn);
          const interruption = '上次任务因插件重启而中断';
          assistant.role = 'error';
          if (!assistant.content.includes(interruption)) {
            assistant.content = assistant.content.trim()
              ? `${assistant.content.trimEnd()}\n\n${interruption}`
              : interruption;
          }
        }
        transitions.push({
          conversationId,
          turnId: turn.id,
          from,
          to,
          revision: allocation.revision,
        });
      }
      next.updatedAt = now;
      next.revision = allocation.revision;
      await this.commitConversationEvent(state, next, state.archivedAt, '_recovery', {
        type: 'recovery', conversation: cloneJson(next), updatedAt: now,
      });
      await this.compactConversation(context, conversationId);
      return {
        conversation: cloneJson(next),
        transitions,
        minQueueSequence: Math.min(...pending.map(turn => turn.queueSequence)),
      };
    });
  }

  private async verifyMigratedGeneration(
    migration: { generation: string; generationRoot: string },
    source: V1MigrationSource,
    manifest: GenerationManifest,
  ): Promise<void> {
    const catalogRaw = await readRequired(
      this.adapter,
      joinPath(migration.generationRoot, CATALOG_PATH),
      'migrated catalog',
    );
    const catalog = parseChecksummed<Catalog>(catalogRaw, 'migrated catalog');
    validateCatalog(catalog, migration.generation);
    const context = {
      generation: migration.generation,
      generationRoot: migration.generationRoot,
      pointer: null,
      pointerRaw: '',
      manifest,
      manifestRaw: '',
    } as unknown as ActiveGenerationContext;
    const migrated: VersionedStoredConversation[] = [];
    for (const original of source.conversations) {
      const state = await this.loadConversationState(context, original.id);
      migrated.push(state.conversation);
      if (!jsonEqual(state.conversation, original)) {
        throw new ConversationStoreMigrationError(
          `Conversation ${original.id} failed byte-equivalent data verification.`,
        );
      }
    }
    const counts = countConversations(migrated);
    if (counts.conversationCount !== manifest.conversationCount
      || counts.messageCount !== manifest.messageCount
      || counts.sessionCount !== manifest.sessionCount
      || hashConversationSet(migrated) !== manifest.contentHash
      || catalog.entries.length !== migrated.length) {
      throw new ConversationStoreMigrationError('The migrated generation failed count/hash verification.');
    }
    const originalIds = source.conversations.map(item => item.id).sort();
    const catalogIds = catalog.entries.map(item => item.id).sort();
    if (!jsonEqual(originalIds, catalogIds)) {
      throw new ConversationStoreMigrationError('The migrated catalog conversation IDs do not match v1.');
    }
  }

  private async installInitialPointer(pointer: ChatStorePointer): Promise<void> {
    const serialized = serializeJson(pointer);
    const existing = await readOptional(this.adapter, CHAT_STORE_POINTER_PATH);
    if (existing !== null) {
      const current = parseChecksummed<ChatStorePointer>(existing, 'v2 chat-store pointer');
      if (current.activeGeneration === pointer.activeGeneration
        && current.manifestHash === pointer.manifestHash) return;
      throw new ConversationStoreMigrationError(
        'Another active chat-store pointer appeared before migration commit.',
      );
    }
    await this.writeImmutableText(CHAT_STORE_POINTER_PATH, serialized, raw => {
      parseChecksummed<ChatStorePointer>(raw, 'v2 chat-store pointer');
    });
  }

  private atomicWriteChecksummed<T extends ChecksummedBase>(path: string, value: T): Promise<void> {
    return this.writeImmutableChecksummed(path, value);
  }

  private writeImmutableChecksummed<T extends ChecksummedBase>(path: string, value: T): Promise<void> {
    return this.writeImmutableText(path, serializeJson(value), raw => {
      parseChecksummed<T>(raw, path);
    });
  }

  private async writeImmutableText(
    path: string,
    value: string,
    validate: (raw: string) => void = () => undefined,
    maximumBytes?: number,
  ): Promise<void> {
    validate(value);
    await ensureDirectory(this.adapter, parentPath(path));
    const existing = await readOptional(this.adapter, path, maximumBytes, path);
    if (existing !== null) {
      validate(existing);
      if (existing !== value) {
        throw new ConversationStoreAtomicWriteError(`Immutable v2 file already differs: ${path}.`);
      }
      return;
    }
    await this.assertWrite();
    await this.assertWrite(true);
    if (this.fencedCompareAndSwap) {
      const written = await this.fencedCompareAndSwap(path, null, value);
      if (written !== null) {
        if (written) return;
        const current = await readOptional(this.adapter, path, maximumBytes, path);
        if (current === value) return;
        throw new ConversationStoreAtomicWriteError(
          `Fenced immutable creation failed for ${path}; target already differs.`,
        );
      }
    }
    // Narrow fallback for test/nonstandard adapters without a physical helper.
    // Production must never expose a stage artifact outside the flock helper.
    const tempPath = `${path}.${this.instanceId}.stage`;
    await this.adapter.write(tempPath, value);
    const staged = await this.adapter.read(tempPath);
    validate(staged);
    if (staged !== value) {
      throw new ConversationStoreAtomicWriteError(`Staged v2 file verification failed: ${path}.`);
    }
    try {
      await this.adapter.copy(tempPath, path);
    } catch (error) {
      const current = await readOptional(this.adapter, path, maximumBytes, path);
      if (current === value) return;
      throw new ConversationStoreAtomicWriteError(
        `Exclusive creation failed for ${path}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private atomicCasChecksummed<T extends ChecksummedBase>(
    path: string,
    value: T,
    expectedRaw: string | null,
  ): Promise<void> {
    return this.atomicCasText(path, serializeJson(value), expectedRaw, raw => {
      parseChecksummed<T>(raw, path);
    });
  }

  private async atomicCasText(
    path: string,
    value: string,
    expectedRaw: string | null,
    validate: (raw: string) => void = raw => { JSON.parse(raw); },
    maximumBytes?: number,
  ): Promise<void> {
    if (maximumBytes !== undefined) assertUtf8ByteBudget(value, maximumBytes, path);
    validate(value);
    await ensureDirectory(this.adapter, parentPath(path));
    await this.assertWrite();
    await this.assertWrite(true);
    if (this.fencedCompareAndSwap) {
      const written = await this.fencedCompareAndSwap(path, expectedRaw, value);
      if (written !== null) {
        if (written) return;
        const current = await readOptional(this.adapter, path, maximumBytes, path);
        if (current === value) return;
        const expectedHash = expectedRaw === null ? 'missing' : sha256(expectedRaw);
        const actualHash = current === null ? 'missing' : sha256(current);
        throw new ConversationStoreAtomicWriteError(
          `Fenced v2 CAS failed for ${path}; expected ${expectedHash}, found ${actualHash}.`,
        );
      }
    }
    // Narrow fallback for test/nonstandard adapters without a physical helper.
    const tempPath = `${path}.${this.instanceId}.stage`;
    await this.adapter.write(tempPath, value);
    const staged = maximumBytes === undefined
      ? await this.adapter.read(tempPath)
      : await readRequired(this.adapter, tempPath, 'staged v2 file', maximumBytes);
    validate(staged);
    if (staged !== value) {
      throw new ConversationStoreAtomicWriteError(`Staged v2 CAS verification failed: ${path}.`);
    }
    if (expectedRaw === null) {
      try {
        await this.adapter.copy(tempPath, path);
        return;
      } catch (error) {
        const current = await readOptional(this.adapter, path, maximumBytes, path);
        if (current === value) return;
        throw new ConversationStoreAtomicWriteError(
          `Initial v2 CAS failed for ${path}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    let actualHash = 'missing';
    try {
      if (maximumBytes !== undefined) {
        const current = await readOptional(this.adapter, path, maximumBytes, path);
        if (current !== expectedRaw) {
          actualHash = current === null ? 'missing' : sha256(current);
          throw new RevisionCasMismatchError();
        }
      }
      await this.adapter.process(path, current => {
        if (maximumBytes !== undefined) assertUtf8ByteBudget(current, maximumBytes, path);
        actualHash = sha256(current);
        if (current !== expectedRaw) throw new RevisionCasMismatchError();
        return staged;
      });
    } catch (error) {
      if (error instanceof RevisionCasMismatchError) {
        throw new ConversationStoreAtomicWriteError(
          `V2 CAS failed for ${path}; expected ${sha256(expectedRaw)}, found ${actualHash}.`,
        );
      }
      throw new ConversationStoreAtomicWriteError(
        `V2 CAS failed for ${path}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

function sessionOwnerIndexGenerationRoot(generationRoot: string, indexGeneration: string): string {
  return joinPath(generationRoot, SESSION_OWNER_INDEXES_DIRECTORY, indexGeneration);
}

function sessionOwnerBucketPath(
  generationRoot: string,
  indexGeneration: string,
  shard: string,
): string {
  return joinPath(
    sessionOwnerIndexGenerationRoot(generationRoot, indexGeneration),
    SESSION_OWNER_BUCKETS_DIRECTORY,
    `${shard}.json`,
  );
}

function sessionOwnerShard(sessionHash: string): string {
  if (!isSha256(sessionHash)) throw new ConversationStoreCorruptError('Session hash is invalid.');
  return sessionHash.slice(0, 2);
}

function sessionOwnerShards(): string[] {
  return Array.from(
    { length: SESSION_OWNER_BUCKET_COUNT },
    (_, index) => index.toString(16).padStart(2, '0'),
  );
}

function sessionOwnerBucketGeneration(
  pointer: SessionOwnerIndexPointer,
  shard: string,
): string {
  const indexGeneration = pointer.version === 2
    ? pointer.bucketGenerations?.[shard]
    : pointer.indexGeneration;
  if (!indexGeneration || !/^owners-[a-f0-9]{24}$/.test(indexGeneration)) {
    throw new ConversationStoreCorruptError(
      `Session-owner index has no valid immutable generation for shard ${shard}.`,
    );
  }
  return indexGeneration;
}

function sessionOwnerBucketGenerationMap(
  pointer: SessionOwnerIndexPointer,
): Record<string, string> {
  return Object.fromEntries(
    sessionOwnerShards().map(shard => [shard, sessionOwnerBucketGeneration(pointer, shard)]),
  );
}

function sessionOwnerMutationGenerationId(
  pointer: SessionOwnerIndexPointer,
  ownersByShard: ReadonlyMap<string, readonly SessionOwnerIndexEntry[]>,
): string {
  const changed = [...ownersByShard.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([shard, owners]) => ({
      shard,
      owners: [...owners].sort((left, right) => left.sessionHash.localeCompare(right.sessionHash)),
    }));
  return `owners-${sha256(canonicalJson({ pointer: pointer.checksum, changed })).slice(0, 24)}`;
}

function sessionOwnerIndexGenerationId(
  ownerships: readonly ConversationSessionOwnership[],
): string {
  return `owners-${sha256(canonicalJson(ownerships)).slice(0, 24)}`;
}

function normalizeSessionIndexOwnerships(
  ownerships: readonly ConversationSessionOwnership[],
): ConversationSessionOwnership[] {
  const normalized = ownerships.map((owner, index): ConversationSessionOwnership => ({
    sessionId: requireNonEmptyString(owner.sessionId, `session owner ${index + 1} id`).trim(),
    conversationId: requireNonEmptyString(
      owner.conversationId,
      `session owner ${index + 1} conversation`,
    ).trim(),
    agentId: requireAgentId(owner.agentId, `session owner ${index + 1} agent`),
    runId: requireNonEmptyString(owner.runId, `session owner ${index + 1} run`).trim(),
    claimedAt: requireTimestamp(owner.claimedAt, `session owner ${index + 1} claimedAt`),
    updatedAt: requireTimestamp(owner.updatedAt, `session owner ${index + 1} updatedAt`),
  })).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const seen = new Map<string, ConversationSessionOwnership>();
  for (const owner of normalized) {
    const previous = seen.get(owner.sessionId);
    if (previous && (previous.conversationId !== owner.conversationId
      || previous.agentId !== owner.agentId)) {
      throw new ConversationStoreCorruptError(
        `Runtime session ${owner.sessionId} has multiple persisted owners.`,
      );
    }
    if (previous) {
      throw new ConversationStoreCorruptError(
        `Runtime session ${owner.sessionId} appears more than once in the owner index source.`,
      );
    }
    seen.set(owner.sessionId, owner);
  }
  return normalized;
}

function sessionOwnershipsFromConversations(
  conversations: readonly VersionedStoredConversation[],
): ConversationSessionOwnership[] {
  return normalizeSessionIndexOwnerships(conversations.flatMap(conversation => (
    Object.entries(conversation.sessionIds ?? {}).flatMap(([rawAgentId, sessionId]) => {
      if (!sessionId) return [];
      const agentId = requireAgentId(rawAgentId, 'conversation session agent');
      const durableOwner = conversation.sessionOwnerships?.[agentId];
      return [{
        sessionId,
        conversationId: conversation.id,
        agentId,
        updatedAt: conversation.updatedAt,
        runId: durableOwner?.runId ?? 'legacy',
        claimedAt: durableOwner?.claimedAt ?? conversation.updatedAt,
      }];
    })
  )));
}

function validateSessionOwnerIndexPointer(
  pointer: SessionOwnerIndexPointer,
  generation: string,
): void {
  if ((pointer.version !== 1 && pointer.version !== 2)
    || pointer.generation !== generation
    || !/^owners-[a-f0-9]{24}$/.test(pointer.indexGeneration)
    || pointer.bucketCount !== SESSION_OWNER_BUCKET_COUNT
    || !isNonNegativeInteger(pointer.ownerCount)
    || !isFiniteTimestamp(pointer.builtAt)) {
    throw new ConversationStoreCorruptError('The session-owner index pointer is invalid.');
  }
  if (pointer.version === 2) {
    if (!isRecord(pointer.bucketGenerations)) {
      throw new ConversationStoreCorruptError('The session-owner shard generation map is missing.');
    }
    const expectedShards = sessionOwnerShards();
    const actualShards = Object.keys(pointer.bucketGenerations).sort();
    if (!jsonEqual(actualShards, expectedShards)
      || expectedShards.some(shard => (
        !/^owners-[a-f0-9]{24}$/.test(pointer.bucketGenerations?.[shard] ?? '')
      ))) {
      throw new ConversationStoreCorruptError('The session-owner shard generation map is invalid.');
    }
  }
}

function validateSessionOwnerBucket(
  bucket: SessionOwnerBucket,
  generation: string,
  indexGeneration: string,
  shard: string,
): void {
  if (bucket.version !== 1
    || bucket.generation !== generation
    || bucket.indexGeneration !== indexGeneration
    || bucket.shard !== shard
    || !/^[a-f0-9]{2}$/.test(shard)
    || !Array.isArray(bucket.owners)) {
    throw new ConversationStoreCorruptError(`Session-owner bucket ${shard} is invalid.`);
  }
  let previousHash = '';
  const seen = new Set<string>();
  for (const owner of bucket.owners) {
    if (!isRecord(owner)
      || !isSha256(owner.sessionHash)
      || sessionOwnerShard(owner.sessionHash) !== shard
      || sha256(requireNonEmptyString(owner.sessionId, 'indexed session id')) !== owner.sessionHash
      || !requireNonEmptyString(owner.conversationId, 'indexed conversation id')
      || !isAgentId(owner.agentId)
      || !requireNonEmptyString(owner.runId, 'indexed run id')
      || !isFiniteTimestamp(owner.claimedAt)
      || !isFiniteTimestamp(owner.updatedAt)
      || owner.sessionHash <= previousHash
      || seen.has(owner.sessionId)) {
      throw new ConversationStoreCorruptError(`Session-owner bucket ${shard} has an invalid owner.`);
    }
    previousHash = owner.sessionHash;
    seen.add(owner.sessionId);
  }
}

function validateManifest(manifest: GenerationManifest, generation: string): void {
  if (manifest.version !== 2 || manifest.generation !== generation
    || (manifest.source !== 'empty' && manifest.source !== 'v1')
    || (manifest.sourceHash !== null && !isSha256(manifest.sourceHash))
    || !isNonNegativeInteger(manifest.createdAt)
    || !isNonNegativeInteger(manifest.conversationCount)
    || !isNonNegativeInteger(manifest.messageCount)
    || !isNonNegativeInteger(manifest.sessionCount)
    || !isSha256(manifest.contentHash)
    || (manifest.rollbackExportPath !== null && manifest.rollbackExportPath !== ROLLBACK_V1_PATH)
    || (manifest.rollbackExportHash !== null && !isSha256(manifest.rollbackExportHash))) {
    throw new ConversationStoreCorruptError('The v2 generation manifest is invalid.');
  }
  if ((manifest.source === 'empty') !== (manifest.sourceHash === null)
    || (manifest.rollbackExportPath === null) !== (manifest.rollbackExportHash === null)) {
    throw new ConversationStoreCorruptError('The v2 generation manifest source metadata is inconsistent.');
  }
}

function validateCatalog(catalog: Catalog, generation: string): void {
  if (catalog.version !== 2 || catalog.generation !== generation
    || !isNonNegativeInteger(catalog.revision)
    || !isPositiveInteger(catalog.nextQueueSequence)
    || !Array.isArray(catalog.entries)
    || (catalog.pendingMutations !== undefined && !Array.isArray(catalog.pendingMutations))) {
    throw new ConversationStoreCorruptError('The v2 catalog envelope is invalid.');
  }
  const pendingRevisions = new Set<number>();
  for (const mutation of catalog.pendingMutations ?? []) {
    if (!isRecord(mutation)
      || typeof mutation.conversationId !== 'string' || !mutation.conversationId
      || !isPositiveInteger(mutation.revision)
      || mutation.revision > catalog.revision
      || typeof mutation.wasCataloged !== 'boolean'
      || typeof mutation.writerInstanceId !== 'string' || !mutation.writerInstanceId
      || pendingRevisions.has(mutation.revision)) {
      throw new ConversationStoreCorruptError('A v2 catalog pending mutation is invalid.');
    }
    pendingRevisions.add(mutation.revision);
  }
  const ids = new Set<string>();
  const sessions = new Map<string, string>();
  for (const entry of catalog.entries) {
    validateCatalogEntry(entry);
    if (ids.has(entry.id)) throw new ConversationStoreCorruptError(`Duplicate catalog id ${entry.id}.`);
    ids.add(entry.id);
    if (entry.revision > catalog.revision) {
      throw new ConversationStoreCorruptError('Catalog revision is behind an entry revision.');
    }
    for (const [agentId, sessionId] of Object.entries(entry.sessions)) {
      requireAgentId(agentId, 'catalog session agent');
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        throw new ConversationStoreCorruptError('Catalog session id is invalid.');
      }
      const owner = `${entry.id}/${agentId}`;
      const previous = sessions.get(sessionId);
      if (previous && previous !== owner) {
        throw new ConversationStoreCorruptError(`Runtime session ${sessionId} has duplicate owners.`);
      }
      sessions.set(sessionId, owner);
    }
  }
}

function validateCatalogEntry(entry: unknown): asserts entry is CatalogEntry {
  if (!isRecord(entry)
    || typeof entry.id !== 'string' || !entry.id
    || typeof entry.title !== 'string'
    || !isAgentId(entry.agentId)
    || !isFiniteTimestamp(entry.createdAt)
    || !isFiniteTimestamp(entry.updatedAt)
    || !isNonNegativeInteger(entry.revision)
    || !isNonNegativeInteger(entry.messageCount)
    || !isNonNegativeInteger(entry.turnCount)
    || (entry.archivedAt !== null && !isFiniteTimestamp(entry.archivedAt))
    || typeof entry.lastMessagePreview !== 'string'
    || typeof entry.searchText !== 'string'
    || !isRecord(entry.sessions)
    || !isRecord(entry.sessionOwnerships)) {
    throw new ConversationStoreCorruptError('A v2 catalog entry is invalid.');
  }
}

function validateSnapshot(snapshot: ConversationSnapshot, generation: string): void {
  if (snapshot.version !== 2 || snapshot.generation !== generation
    || typeof snapshot.conversationId !== 'string' || !snapshot.conversationId
    || !isNonNegativeInteger(snapshot.revision)
    || (snapshot.archivedAt !== null && !isFiniteTimestamp(snapshot.archivedAt))
    || !isNonNegativeInteger(snapshot.journalSequence)
    || (snapshot.journalChecksum !== null && !isSha256(snapshot.journalChecksum))
    || !isNonNegativeInteger(snapshot.messageCount)
    || !Array.isArray(snapshot.chunks)
    || !isRecord(snapshot.conversation)
    || snapshot.conversation.id !== snapshot.conversationId
    || snapshot.conversation.revision !== snapshot.revision) {
    throw new ConversationStoreCorruptError('The v2 conversation snapshot is invalid.');
  }
  if (snapshot.conversation.contextCheckpoint !== undefined) {
    const checkpoint = normalizeContextCheckpoint(
      snapshot.conversation.contextCheckpoint,
      'conversation snapshot contextCheckpoint',
    );
    if (checkpoint.sourceRevision >= snapshot.revision
      || checkpoint.throughMessageSequence > snapshot.messageCount) {
      throw new ConversationStoreCorruptError(
        'The conversation snapshot contextCheckpoint is outside its canonical transcript.',
      );
    }
  }
}

function validateChunkDescriptor(descriptor: MessageChunkDescriptor, expectedStart: number): void {
  if (!isRecord(descriptor)
    || !/^messages\/[a-zA-Z0-9._-]+\.json$/.test(descriptor.path)
    || !isPositiveInteger(descriptor.startSequence)
    || !isPositiveInteger(descriptor.endSequence)
    || !isPositiveInteger(descriptor.count)
    || descriptor.startSequence !== expectedStart
    || descriptor.endSequence - descriptor.startSequence + 1 !== descriptor.count
    || descriptor.count > CHAT_V2_MESSAGE_CHUNK_SIZE
    || !isSha256(descriptor.hash)) {
    throw new ConversationStoreCorruptError('A v2 message chunk descriptor is invalid.');
  }
}

function validateSnapshotChunkDescriptors(snapshot: ConversationSnapshot): void {
  let expectedSequence = 1;
  for (const descriptor of snapshot.chunks) {
    validateChunkDescriptor(descriptor, expectedSequence);
    expectedSequence = descriptor.endSequence + 1;
  }
  if (expectedSequence - 1 !== snapshot.messageCount) {
    throw new ConversationStoreCorruptError('Snapshot message count does not match its chunk descriptors.');
  }
}

function validateMessageChunk(
  chunk: MessageChunk,
  snapshot: ConversationSnapshot,
  descriptor: MessageChunkDescriptor,
): void {
  if (chunk.version !== 2 || chunk.generation !== snapshot.generation
    || chunk.conversationId !== snapshot.conversationId
    || !isNonNegativeInteger(chunk.revision)
    || chunk.revision > snapshot.revision
    || !Array.isArray(chunk.messages)
    || chunk.messages.length !== descriptor.count) {
    throw new ConversationStoreCorruptError(`Message chunk ${descriptor.path} is invalid.`);
  }
}

function parseRunState(raw: string, generation: string, conversationId: string): RunState {
  const state = parseChecksummed<RunState>(raw, 'conversation run-state');
  if (state.version !== 2 || state.generation !== generation
    || state.conversationId !== conversationId
    || !isNonNegativeInteger(state.revision)
    || (state.turnsMode !== undefined && state.turnsMode !== 'all' && state.turnsMode !== 'tail')
    || !Array.isArray(state.turns)
    || !isRecord(state.sessionIds)
    || !isRecord(state.sessionConfigKeys)
    || !isRecord(state.sessionOwnerships)
    || !isNonNegativeInteger(state.headSequence)
    || (state.headChecksum !== null && !isSha256(state.headChecksum))
    || !Array.isArray(state.journalSegments)
    || (state.pendingJournalRecord !== null && !isRecord(state.pendingJournalRecord))
    || (state.pendingJournalPath !== null && typeof state.pendingJournalPath !== 'string')
    || !Array.isArray(state.retiredTruncatedSegments)) {
    throw new ConversationStoreCorruptError('Conversation run-state is invalid.');
  }
  const turns = state.turns.map((turn, index) => normalizeTurn(turn, `run-state turn ${index + 1}`));
  const sessionIds = normalizeAgentStringMap(state.sessionIds, 'run-state sessionIds') ?? {};
  const sessionConfigKeys = normalizeAgentStringMap(
    state.sessionConfigKeys,
    'run-state sessionConfigKeys',
  ) ?? {};
  const sessionOwnerships = normalizeSessionOwnerMap(
    state.sessionOwnerships,
    conversationId,
    sessionIds,
    'run-state sessionOwnerships',
  );
  const journalSegments = state.journalSegments.map((path, index) => (
    requireNonEmptyString(path, `journal segment ${index + 1}`)
  ));
  const retired = state.retiredTruncatedSegments.map((path, index) => (
    requireNonEmptyString(path, `retired journal segment ${index + 1}`)
  ));
  if (new Set(journalSegments).size !== journalSegments.length
    || new Set(retired).size !== retired.length
    || retired.some(path => !journalSegments.includes(path))) {
    throw new ConversationStoreCorruptError('Conversation journal segment registry is invalid.');
  }
  return {
    ...state,
    turns,
    sessionIds,
    sessionConfigKeys,
    sessionOwnerships,
    journalSegments,
    retiredTruncatedSegments: retired,
  };
}

function parseJournalSegment(raw: string, source: string): ParsedJournalSegment {
  if (!raw) return { records: [], truncatedTail: false };
  const terminated = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (terminated) lines.pop();
  const records: JournalRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      throw new ConversationStoreCorruptError(`Journal ${source} contains an empty middle line.`);
    }
    try {
      const value = JSON.parse(line) as unknown;
      if (!isRecord(value)) throw new Error('not an object');
      records.push(value as unknown as JournalRecord);
    } catch (error) {
      const isFinalUnterminated = index === lines.length - 1 && !terminated;
      if (isFinalUnterminated && looksLikeIncompleteJson(line)) {
        return { records, truncatedTail: true };
      }
      throw new ConversationStoreCorruptError(
        `Journal ${source} is corrupt at line ${index + 1}: ${errorMessage(error)}`,
      );
    }
  }
  return { records, truncatedTail: false };
}

function looksLikeIncompleteJson(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith('{')) return false;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of trimmed) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
  }
  return quoted || depth > 0;
}

function validateJournalChain(
  records: JournalRecord[],
  generation: string,
  conversationId: string,
  initialSequence = 0,
  initialChecksum: string | null = null,
  initialRevision = -1,
  normalizeConversationValue?: (
    value: unknown,
    source: string,
  ) => VersionedStoredConversation,
): void {
  let sequence = initialSequence;
  let checksum: string | null = initialChecksum;
  let revision = initialRevision;
  for (const record of records) {
    validateJournalRecord(record, generation, conversationId, normalizeConversationValue);
    if (record.sequence !== sequence + 1 || record.previousChecksum !== checksum
      || record.revision <= revision) {
      throw new ConversationStoreCorruptError('Conversation journal sequence/revision/checksum chain is broken.');
    }
    sequence = record.sequence;
    checksum = record.checksum;
    revision = record.revision;
  }
}

function journalChainBaseline(
  records: JournalRecord[],
  snapshot: ConversationSnapshot,
): { sequence: number; checksum: string | null; revision: number; recordOffset: number } {
  if (records.length === 0) {
    return {
      sequence: snapshot.journalSequence,
      checksum: snapshot.journalChecksum,
      revision: snapshot.revision,
      recordOffset: 0,
    };
  }
  if (records[0].sequence === 1) {
    if (snapshot.journalSequence > 0) {
      const snapshotHead = records.find(record => record.sequence === snapshot.journalSequence);
      if (!snapshotHead || snapshotHead.checksum !== snapshot.journalChecksum) {
        throw new ConversationStoreCorruptError('Snapshot journal baseline is not present in retained journals.');
      }
    }
    return { sequence: 0, checksum: null, revision: -1, recordOffset: 0 };
  }
  if (records[0].sequence !== snapshot.journalSequence + 1
    || records[0].previousChecksum !== snapshot.journalChecksum) {
    throw new ConversationStoreCorruptError('Trimmed journal does not extend the snapshot baseline.');
  }
  return {
    sequence: snapshot.journalSequence,
    checksum: snapshot.journalChecksum,
    revision: snapshot.revision,
    recordOffset: 0,
  };
}

function validateJournalRecord(
  record: JournalRecord,
  generation: string,
  conversationId: string,
  normalizeConversationValue?: (
    value: unknown,
    source: string,
  ) => VersionedStoredConversation,
): void {
  if (!isRecord(record)) {
    throw new ConversationStoreCorruptError('A conversation journal record is invalid.');
  }
  assertExactKeys(record, [
    'version',
    'generation',
    'conversationId',
    'turnId',
    'sequence',
    'revision',
    'previousChecksum',
    'event',
    'checksum',
  ], 'conversation journal record');
  if (record.version !== 2 || record.generation !== generation
    || record.conversationId !== conversationId
    || typeof record.turnId !== 'string' || !record.turnId
    || !isPositiveInteger(record.sequence)
    || !isPositiveInteger(record.revision)
    || (record.previousChecksum !== null && !isSha256(record.previousChecksum))
    || !isRecord(record.event)) {
    throw new ConversationStoreCorruptError('A conversation journal record is invalid.');
  }
  const { checksum, ...unsigned } = record;
  if (!isSha256(checksum) || checksum !== sha256(canonicalJson(unsigned))) {
    throw new ConversationStoreCorruptError('A conversation journal record checksum is invalid.');
  }
  try {
    validateJournalEvent(record, normalizeConversationValue);
  } catch (error) {
    if (error instanceof ConversationStoreCorruptError) throw error;
    throw new ConversationStoreCorruptError(
      `Conversation journal event is invalid: ${errorMessage(error)}`,
    );
  }
}

function validateJournalEvent(
  record: JournalRecord,
  normalizeConversationValue?: (
    value: unknown,
    source: string,
  ) => VersionedStoredConversation,
): void {
  const event = record.event;
  const source = `journal revision ${record.revision} ${String(event.type)}`;
  assertUtf8ByteBudget(
    JSON.stringify(event),
    CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES,
    `${source} event`,
  );
  switch (event.type) {
    case 'beginTurn': {
      assertExactKeys(event, [
        'type',
        'title',
        'agentId',
        'createdAt',
        'updatedAt',
        'userMessage',
        'assistantMessage',
        'turn',
        'contextCheckpoint',
      ], source);
      requireBoundedUtf8String(event.title, `${source} title`, 64 * 1024);
      requireAgentId(event.agentId, `${source} agentId`);
      requireTimestamp(event.createdAt, `${source} createdAt`);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      const userMessage = validateExactJournalMessage(event.userMessage, `${source} userMessage`);
      const assistantMessage = validateExactJournalMessage(
        event.assistantMessage,
        `${source} assistantMessage`,
      );
      const turn = validateExactJournalTurn(event.turn, `${source} turn`);
      if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant'
        || turn.id !== record.turnId
        || turn.agentId !== event.agentId
        || turn.userMessageId !== userMessage.id
        || turn.assistantMessageId !== assistantMessage.id) {
        throw corrupt(`${source} message/turn binding is invalid.`);
      }
      if (event.contextCheckpoint !== undefined) {
        const checkpoint = normalizeContextCheckpoint(
          event.contextCheckpoint,
          `${source} contextCheckpoint`,
        );
        if (!jsonEqual(checkpoint, event.contextCheckpoint)
          || checkpoint.sourceRevision >= record.revision) {
          throw corrupt(`${source} contextCheckpoint is invalid.`);
        }
      }
      break;
    }
    case 'appendMessage':
      assertExactKeys(event, ['type', 'message', 'title', 'updatedAt'], source);
      validateExactJournalMessage(event.message, `${source} message`);
      requireBoundedUtf8String(event.title, `${source} title`, 64 * 1024);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      break;
    case 'patchMessage':
      assertExactKeys(event, ['type', 'message', 'updatedAt'], source);
      validateExactJournalMessage(event.message, `${source} message`);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      break;
    case 'patchSession': {
      assertExactKeys(event, [
        'type',
        'agentId',
        'sessionId',
        'configKey',
        'ownership',
        'updatedAt',
      ], source);
      const agentId = requireAgentId(event.agentId, `${source} agentId`);
      const sessionId = validateNullableJournalString(
        event.sessionId,
        `${source} sessionId`,
      );
      validateNullableJournalString(event.configKey, `${source} configKey`);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      if (event.ownership !== undefined && event.ownership !== null) {
        if (sessionId === undefined || sessionId === null) {
          throw corrupt(`${source} ownership requires a sessionId.`);
        }
        const normalized = normalizeSessionOwnerMap(
          { [agentId]: event.ownership },
          record.conversationId,
          { [agentId]: sessionId },
          `${source} ownership`,
        )[agentId];
        if (!jsonEqual(normalized, event.ownership)) {
          throw corrupt(`${source} ownership is not canonical.`);
        }
      }
      break;
    }
    case 'setContextCheckpoint': {
      assertExactKeys(event, ['type', 'checkpoint', 'updatedAt'], source);
      const checkpoint = normalizeContextCheckpoint(
        event.checkpoint,
        `${source} checkpoint`,
      );
      if (!jsonEqual(checkpoint, event.checkpoint)
        || !isFiniteTimestamp(event.updatedAt)
        || checkpoint.sourceRevision >= record.revision) {
        throw corrupt(`${source} checkpoint is invalid.`);
      }
      break;
    }
    case 'replaceConversation':
    case 'recovery': {
      assertExactKeys(event, ['type', 'conversation', 'updatedAt'], source);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      if (!normalizeConversationValue) {
        throw corrupt(`${source} cannot be validated without a conversation normalizer.`);
      }
      const conversation = normalizeConversationValue(
        event.conversation,
        `${source} conversation`,
      );
      if (!jsonEqual(conversation, event.conversation)
        || conversation.id !== record.conversationId
        || conversation.revision !== record.revision) {
        throw corrupt(`${source} conversation is not canonical.`);
      }
      break;
    }
    case 'turnUpdate': {
      assertExactKeys(event, ['type', 'turn', 'assistantMessage', 'updatedAt'], source);
      const turn = validateExactJournalTurn(event.turn, `${source} turn`);
      if (turn.id !== record.turnId) throw corrupt(`${source} turn id is invalid.`);
      if (event.assistantMessage !== undefined) {
        const assistant = validateExactJournalMessage(
          event.assistantMessage,
          `${source} assistantMessage`,
        );
        // Failed turns legitimately finalize their assistant payload with the
        // persisted `error` role; identity, not terminal role, binds the
        // message to the turn.
        if (assistant.id !== turn.assistantMessageId
          || (assistant.role !== 'assistant' && assistant.role !== 'error')) {
          throw corrupt(`${source} assistant binding is invalid.`);
        }
      }
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      break;
    }
    case 'archive':
      assertExactKeys(event, ['type', 'archivedAt', 'updatedAt'], source);
      requireTimestamp(event.archivedAt, `${source} archivedAt`);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      break;
    case 'restore':
      assertExactKeys(event, ['type', 'updatedAt'], source);
      requireTimestamp(event.updatedAt, `${source} updatedAt`);
      break;
    default:
      throw corrupt(`${source} type is unsupported.`);
  }
}

function validateExactJournalMessage(value: unknown, source: string): ChatMessage {
  const normalized = normalizeMessage(value, source);
  if (!jsonEqual(normalized, value)) throw corrupt(`${source} is not canonical.`);
  return normalized;
}

function validateExactJournalTurn(value: unknown, source: string): StoredConversationTurn {
  const normalized = normalizeTurn(value, source);
  if (!jsonEqual(normalized, value)) throw corrupt(`${source} is not canonical.`);
  return normalized;
}

function validateNullableJournalString(
  value: unknown,
  source: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireBoundedNonEmptyUtf8String(value, source, 4 * 1024);
}

function selectJournalPath(
  state: LoadedConversationState,
  turnId: string,
  nextSequence: number,
  retired: string[],
): string {
  const key = sanitizePathSegment(turnId).slice(0, 32);
  const hash = sha256(turnId).slice(0, 12);
  const base = joinPath(JOURNALS_DIRECTORY, `${key}-${hash}.jsonl`);
  if (!retired.includes(base)
    && (state.lastSequence === 0 || state.runState.journalSegments.includes(base))) return base;
  return joinPath(JOURNALS_DIRECTORY, `${key}-${hash}-from-${nextSequence}.jsonl`);
}

function applyJournalRecord(
  current: VersionedStoredConversation,
  currentArchivedAt: number | null,
  record: JournalRecord,
  normalizeConversationValue: (value: unknown, source: string) => VersionedStoredConversation,
): { conversation: VersionedStoredConversation; archivedAt: number | null } {
  let conversation = cloneJson(current);
  let archivedAt = currentArchivedAt;
  const event = record.event;
  switch (event.type) {
    case 'beginTurn':
      if (event.contextCheckpoint) {
        if (event.contextCheckpoint.sourceRevision !== conversation.revision) {
          throw new ConversationStoreCorruptError(
            'Atomic context checkpoint source revision does not match its journal predecessor.',
          );
        }
        conversation.contextCheckpoint = cloneJson(event.contextCheckpoint);
      }
      conversation.title = event.title;
      conversation.agentId = event.agentId;
      conversation.createdAt = event.createdAt;
      conversation.updatedAt = event.updatedAt;
      conversation.messages.push(cloneJson(event.userMessage), cloneJson(event.assistantMessage));
      conversation.turns.push(cloneJson(event.turn));
      break;
    case 'appendMessage':
      conversation.messages.push(cloneJson(event.message));
      conversation.title = event.title;
      conversation.updatedAt = event.updatedAt;
      break;
    case 'patchMessage': {
      const index = conversation.messages.findIndex(message => message.id === event.message.id);
      if (index < 0) throw new ConversationStoreCorruptError('Journal patches a missing message.');
      conversation.messages[index] = cloneJson(event.message);
      conversation.updatedAt = event.updatedAt;
      break;
    }
    case 'patchSession': {
      const sessions = { ...(conversation.sessionIds ?? {}) };
      const configs = { ...(conversation.sessionConfigKeys ?? {}) };
      const ownerships = { ...(conversation.sessionOwnerships ?? {}) };
      assignNullableAgentValue(sessions, event.agentId, event.sessionId);
      assignNullableAgentValue(configs, event.agentId, event.configKey);
      if (event.ownership === null || event.sessionId === null) delete ownerships[event.agentId];
      else if (event.ownership) ownerships[event.agentId] = cloneJson(event.ownership);
      conversation.sessionIds = sessions;
      conversation.sessionConfigKeys = configs;
      conversation.sessionOwnerships = ownerships;
      conversation.updatedAt = event.updatedAt;
      break;
    }
    case 'setContextCheckpoint':
      if (event.checkpoint.sourceRevision !== conversation.revision) {
        throw new ConversationStoreCorruptError(
          'Context checkpoint source revision does not match its journal predecessor.',
        );
      }
      conversation.contextCheckpoint = cloneJson(event.checkpoint);
      conversation.updatedAt = event.updatedAt;
      break;
    case 'replaceConversation':
    case 'recovery':
      conversation = cloneJson(event.conversation);
      break;
    case 'turnUpdate': {
      const index = conversation.turns.findIndex(turn => turn.id === event.turn.id);
      if (index < 0) throw new ConversationStoreCorruptError('Journal updates a missing turn.');
      conversation.turns[index] = cloneJson(event.turn);
      if (event.assistantMessage) {
        const messageIndex = conversation.messages.findIndex(message => (
          message.id === event.assistantMessage!.id
        ));
        if (messageIndex < 0) throw new ConversationStoreCorruptError('Journal updates a missing assistant.');
        conversation.messages[messageIndex] = cloneJson(event.assistantMessage);
      }
      conversation.updatedAt = event.updatedAt;
      break;
    }
    case 'archive':
      archivedAt = event.archivedAt;
      conversation.updatedAt = event.updatedAt;
      break;
    case 'restore':
      archivedAt = null;
      conversation.updatedAt = event.updatedAt;
      break;
    default:
      throw new ConversationStoreCorruptError('Conversation journal event type is unsupported.');
  }
  conversation.revision = record.revision;
  return {
    conversation: normalizeConversationValue(conversation, `journal revision ${record.revision}`),
    archivedAt,
  };
}

function normalizeContextCheckpointDraft(
  value: unknown,
  source: string,
): ConversationContextCheckpointDraft {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, [
    'version',
    'id',
    'createdAt',
    'sourceRevision',
    'throughMessageSequence',
    'throughMessageId',
    'projectionVersion',
    'summary',
    'createdBy',
    'previousCheckpointId',
  ], source);
  const summary = normalizeContextSummary(value.summary, `${source} summary`);
  const createdBy = value.createdBy;
  if (createdBy !== 'local' && !isAgentId(createdBy)) throw corrupt(`${source} createdBy is invalid.`);
  const draft: ConversationContextCheckpointDraft = {
    version: requireLiteralOne(value.version, `${source} version`),
    id: requireBoundedNonEmptyString(value.id, `${source} id`, 512),
    createdAt: requireStrictTimestamp(value.createdAt, `${source} createdAt`),
    sourceRevision: requireNonNegativeInteger(value.sourceRevision, `${source} sourceRevision`),
    throughMessageSequence: requirePositiveInteger(
      value.throughMessageSequence,
      `${source} throughMessageSequence`,
    ),
    throughMessageId: requireBoundedNonEmptyString(
      value.throughMessageId,
      `${source} throughMessageId`,
      512,
    ),
    projectionVersion: requireLiteralOne(
      value.projectionVersion,
      `${source} projectionVersion`,
    ),
    summary,
    createdBy,
  };
  if (value.previousCheckpointId !== undefined) {
    draft.previousCheckpointId = requireBoundedNonEmptyString(
      value.previousCheckpointId,
      `${source} previousCheckpointId`,
      512,
    );
  }
  return draft;
}

function normalizeContextCheckpoint(
  value: unknown,
  source: string,
): ConversationContextCheckpoint {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, [
    'version',
    'id',
    'createdAt',
    'sourceRevision',
    'throughMessageSequence',
    'throughMessageId',
    'prefixSha256',
    'projectionVersion',
    'summary',
    'createdBy',
    'previousCheckpointId',
  ], source);
  const { prefixSha256, ...draft } = value;
  if (!isSha256(prefixSha256)) throw corrupt(`${source} prefixSha256 is invalid.`);
  return {
    ...normalizeContextCheckpointDraft(draft, source),
    prefixSha256,
  };
}

function normalizeContextSummary(
  value: unknown,
  source: string,
): ConversationContextCheckpoint['summary'] {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, [
    'facts',
    'decisions',
    'userPreferences',
    'constraints',
    'openLoops',
    'filesMentioned',
    'lastIntent',
  ], source);
  return {
    facts: normalizeBoundedStringArray(value.facts, `${source} facts`),
    decisions: normalizeBoundedStringArray(value.decisions, `${source} decisions`),
    userPreferences: normalizeBoundedStringArray(
      value.userPreferences,
      `${source} userPreferences`,
    ),
    constraints: normalizeBoundedStringArray(value.constraints, `${source} constraints`),
    openLoops: normalizeBoundedStringArray(value.openLoops, `${source} openLoops`),
    filesMentioned: normalizeBoundedStringArray(
      value.filesMentioned,
      `${source} filesMentioned`,
    ),
    lastIntent: requireBoundedString(value.lastIntent, `${source} lastIntent`, 16_384),
  };
}

function normalizeBoundedStringArray(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw corrupt(`${source} must be a bounded array.`);
  return value.map((item, index) => requireBoundedString(item, `${source} ${index + 1}`, 16_384));
}

function requireBoundedString(value: unknown, source: string, maximumLength: number): string {
  const normalized = requireString(value, source);
  if (normalized.length > maximumLength) throw corrupt(`${source} is too long.`);
  return normalized;
}

function requireBoundedNonEmptyString(
  value: unknown,
  source: string,
  maximumLength: number,
): string {
  const normalized = requireNonEmptyString(value, source);
  if (normalized.length > maximumLength) throw corrupt(`${source} is too long.`);
  return normalized;
}

function requireLiteralOne(value: unknown, source: string): 1 {
  if (value !== 1) throw corrupt(`${source} is invalid.`);
  return 1;
}

function requireStrictTimestamp(value: unknown, source: string): number {
  if (!isFiniteTimestamp(value)) throw corrupt(`${source} must be a finite non-negative number.`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  source: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) throw corrupt(`${source} contains unsupported field ${unexpected}.`);
}

function hashMessagePrefix(
  messages: readonly ChatMessage[],
  throughMessageSequence: number,
  throughMessageId: string,
): string {
  const sequence = requirePositiveInteger(
    throughMessageSequence,
    'context checkpoint throughMessageSequence',
  );
  if (sequence > messages.length) {
    throw new ConversationTurnStateError(
      `Context checkpoint sequence ${sequence} exceeds ${messages.length} messages.`,
    );
  }
  const boundary = messages[sequence - 1];
  if (boundary.id !== throughMessageId) {
    throw new ConversationTurnStateError(
      `Context checkpoint sequence ${sequence} does not identify message ${throughMessageId}.`,
    );
  }
  return sha256(canonicalJson(messages.slice(0, sequence).map((message, index) => ({
    sequence: index + 1,
    message,
  }))));
}

function assertContextCheckpointBoundary(
  conversation: VersionedStoredConversation,
  checkpoint: ConversationContextCheckpoint,
): void {
  const boundaryTurn = conversation.turns.find(turn => (
    turn.assistantMessageId === checkpoint.throughMessageId
  ));
  const boundaryMessage = conversation.messages[checkpoint.throughMessageSequence - 1];
  if (boundaryMessage?.role !== 'assistant'
    || (conversation.turns.length > 0
      && (!boundaryTurn || boundaryTurn.state !== 'completed'))) {
    throw new ConversationTurnStateError(
      'A context checkpoint must end at the assistant message of a completed turn.',
    );
  }
}

function verifyContextCheckpointBinding(
  conversation: VersionedStoredConversation,
  checkpoint: ConversationContextCheckpoint,
): void {
  if (checkpoint.sourceRevision >= conversation.revision) {
    throw new ConversationStoreCorruptError(
      'Context checkpoint source revision is not older than its commit.',
    );
  }
  let prefixSha256: string;
  try {
    prefixSha256 = hashMessagePrefix(
      conversation.messages,
      checkpoint.throughMessageSequence,
      checkpoint.throughMessageId,
    );
    assertContextCheckpointBoundary(conversation, checkpoint);
  } catch (error) {
    if (!(error instanceof ConversationTurnStateError)) throw error;
    throw new ConversationStoreCorruptError(error.message);
  }
  if (prefixSha256 !== checkpoint.prefixSha256) {
    throw new ConversationStoreCorruptError(
      'Context checkpoint transcript hash does not match its canonical prefix.',
    );
  }
}

function materializeAtomicContextCheckpoint(
  conversation: VersionedStoredConversation,
  value: ConversationContextCheckpointDraft,
): ConversationContextCheckpoint {
  const draft = normalizeContextCheckpointDraft(value, 'beginTurn contextCheckpointDraft');
  if (conversation.turns.some(turn => !isTerminalTurnState(turn.state))) {
    throw new ConversationTurnStateError(
      `Conversation ${conversation.id} cannot checkpoint while a turn is unfinished.`,
    );
  }
  if (draft.sourceRevision !== conversation.revision) {
    throw new ConversationRevisionConflictError(
      conversation.id,
      draft.sourceRevision,
      conversation.revision,
    );
  }
  const checkpoint = materializeAtomicContextCheckpointReplay(conversation, draft);
  const existing = conversation.contextCheckpoint;
  if (existing) {
    if (checkpoint.previousCheckpointId !== existing.id) {
      throw new ConversationTurnStateError(
        `Context checkpoint ${checkpoint.id} does not extend ${existing.id}.`,
      );
    }
    if (checkpoint.throughMessageSequence <= existing.throughMessageSequence) {
      throw new ConversationTurnStateError(
        'A context checkpoint must advance beyond the previous message boundary.',
      );
    }
  } else if (checkpoint.previousCheckpointId !== undefined) {
    throw new ConversationTurnStateError(
      'The first context checkpoint cannot reference a previous checkpoint.',
    );
  }
  return checkpoint;
}

function materializeAtomicContextCheckpointReplay(
  conversation: VersionedStoredConversation,
  value: ConversationContextCheckpointDraft,
): ConversationContextCheckpoint {
  const draft = normalizeContextCheckpointDraft(value, 'beginTurn contextCheckpointDraft');
  const checkpoint: ConversationContextCheckpoint = {
    ...cloneJson(draft),
    prefixSha256: hashMessagePrefix(
      conversation.messages,
      draft.throughMessageSequence,
      draft.throughMessageId,
    ),
  };
  assertContextCheckpointBoundary(conversation, checkpoint);
  return checkpoint;
}

function validateBeginTurnInput(input: BeginTurnInput): void {
  requireNonEmptyString(input.conversationId, 'conversation id');
  requireAgentId(input.agentId, 'turn agentId');
  const user = normalizeMessage(input.userMessage, 'user message');
  const assistant = normalizeMessage(input.assistantMessage, 'assistant message');
  if (user.role !== 'user') throw new ConversationTurnStateError('beginTurn userMessage must have role user.');
  if (assistant.role !== 'assistant') {
    throw new ConversationTurnStateError('beginTurn assistantMessage must have role assistant.');
  }
  if (user.id === assistant.id) {
    throw new ConversationTurnStateError('beginTurn message ids must be different.');
  }
  normalizeRuntimeSnapshot(input.runtime, 'turn runtime snapshot');
  if (input.contextCheckpointDraft !== undefined) {
    normalizeContextCheckpointDraft(input.contextCheckpointDraft, 'beginTurn contextCheckpointDraft');
  }
}

function assertBeginTurnReplay(
  conversation: VersionedStoredConversation,
  turn: StoredConversationTurn,
  input: BeginTurnInput,
): void {
  const user = conversation.messages.find(message => message.id === turn.userMessageId);
  const assistant = conversation.messages.find(message => message.id === turn.assistantMessageId);
  if (turn.agentId !== input.agentId
    || turn.userMessageId !== input.userMessage.id
    || turn.assistantMessageId !== input.assistantMessage.id
    || !user || !assistant
    || !jsonEqual(user, input.userMessage)
    || !jsonEqual(turn.runtime, normalizeRuntimeSnapshot(input.runtime, 'turn runtime snapshot'))) {
    throw new ConversationTurnStateError(`Turn id ${turn.id} is already in use by different input.`);
  }
  if (input.contextCheckpointDraft) {
    const expected = materializeAtomicContextCheckpointReplay(
      conversation,
      input.contextCheckpointDraft,
    );
    if (!conversation.contextCheckpoint || !jsonEqual(conversation.contextCheckpoint, expected)) {
      throw new ConversationTurnStateError(`Turn id ${turn.id} checkpoint is different from its replay.`);
    }
  }
}

function normalizeMessage(value: unknown, source: string): ChatMessage {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, ['id', 'role', 'content', 'createdAt', 'agentId', 'metadata'], source);
  const content = requireBoundedUtf8String(
    value.content,
    `${source} content`,
    CHAT_V2_MAX_MESSAGE_CONTENT_BYTES,
  );
  const metadata = normalizeMessageMetadata(value.metadata, content, `${source} metadata`);
  const normalized: ChatMessage = {
    id: requireBoundedNonEmptyUtf8String(value.id, `${source} id`, 1_024),
    role: requireMessageRole(value.role, `${source} role`),
    content,
    createdAt: requireTimestamp(value.createdAt, `${source} createdAt`),
    ...(value.agentId === undefined ? {} : { agentId: requireAgentId(value.agentId, `${source} agentId`) }),
    ...(metadata === undefined ? {} : { metadata }),
  };
  assertUtf8ByteBudget(
    JSON.stringify(normalized),
    CHAT_V2_MAX_MESSAGE_BYTES,
    source,
  );
  return normalized;
}

function normalizeMessageMetadata(
  value: unknown,
  content: string,
  source: string,
): ChatMessageMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);

  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'artifacts' || key === 'durationMs' || key === 'memoryReferences'
      || key === TOOL_LIFECYCLE_CONTENT_METADATA_KEY || entry === undefined) continue;
    defineJsonProperty(normalized, key, entry);
  }

  if (value.artifacts !== undefined) {
    if (!Array.isArray(value.artifacts) || value.artifacts.length > MAX_METADATA_ARTIFACTS) {
      throw corrupt(`${source} artifacts must be an array of at most ${MAX_METADATA_ARTIFACTS} items.`);
    }
    defineJsonProperty(normalized, 'artifacts', value.artifacts.map((artifact, index) => (
      normalizeChatArtifact(artifact, `${source} artifact ${index + 1}`)
    )));
  }

  if (value.durationMs !== undefined) {
    if (!Number.isSafeInteger(value.durationMs) || Number(value.durationMs) < 0
      || Number(value.durationMs) > MAX_DURATION_MS) {
      throw corrupt(`${source} durationMs must be a non-negative integer no greater than ${MAX_DURATION_MS}.`);
    }
    defineJsonProperty(normalized, 'durationMs', value.durationMs);
  }

  if (value.memoryReferences !== undefined) {
    if (!Array.isArray(value.memoryReferences)
      || value.memoryReferences.length > MAX_METADATA_MEMORY_REFERENCES) {
      throw corrupt(
        `${source} memoryReferences must be an array of at most ${MAX_METADATA_MEMORY_REFERENCES} items.`,
      );
    }
    defineJsonProperty(normalized, 'memoryReferences', value.memoryReferences.map((reference, index) => (
      normalizeMemoryReference(reference, `${source} memory reference ${index + 1}`)
    )));
  }

  const lifecycle = normalizeToolLifecycleMetadata(
    value[TOOL_LIFECYCLE_CONTENT_METADATA_KEY],
    content,
  );
  if (lifecycle) defineJsonProperty(normalized, TOOL_LIFECYCLE_CONTENT_METADATA_KEY, lifecycle);

  assertJsonMetadataValue(normalized, source);
  const serialized = JSON.stringify(normalized);
  assertUtf8ByteBudget(serialized, CHAT_V2_MAX_MESSAGE_METADATA_BYTES, source);
  if (Object.keys(normalized).length === 0) return undefined;
  return JSON.parse(serialized) as ChatMessageMetadata;
}

function normalizeChatArtifact(value: unknown, source: string): ChatArtifact {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, ['id', 'type', 'vaultPath', 'mimeType', 'createdAt', 'revisedPrompt'], source);
  if (value.type !== 'image') throw corrupt(`${source} type must be image.`);
  const mimeType = requireBoundedUtf8String(value.mimeType, `${source} mimeType`, 128);
  if (!ALLOWED_CHAT_ARTIFACT_MIME_TYPES.has(mimeType)) {
    throw corrupt(`${source} mimeType is unsupported.`);
  }
  const vaultPath = requireSafeRelativePath(value.vaultPath, `${source} vaultPath`, 1_024);
  if (!vaultPath.startsWith(`${STORAGE_IDS.generatedImagesPath}/`)) {
    throw corrupt(`${source} vaultPath is outside the generated-image store.`);
  }
  return {
    id: requireBoundedNonEmptyUtf8String(value.id, `${source} id`, 512),
    type: 'image',
    vaultPath,
    mimeType,
    createdAt: requireSafeNonNegativeInteger(value.createdAt, `${source} createdAt`),
    ...(value.revisedPrompt === undefined
      ? {}
      : {
          revisedPrompt: requireBoundedUtf8String(
            value.revisedPrompt,
            `${source} revisedPrompt`,
            64 * 1024,
          ),
        }),
  };
}

function normalizeMemoryReference(value: unknown, source: string): MemorySnapshotReference {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  assertExactKeys(value, [
    'channel',
    'relativePath',
    'appId',
    'projectId',
    'sha256',
    'verifiedAt',
    'gitHead',
    'queryHash',
    'retrievedAt',
    'stale',
    'liveVerificationRequired',
    'policyWarnings',
  ], source);
  if (value.channel !== 'creative' && value.channel !== 'project') {
    throw corrupt(`${source} channel is invalid.`);
  }
  if (!isSha256(value.sha256) || !isSha256(value.queryHash)) {
    throw corrupt(`${source} hashes are invalid.`);
  }
  const gitHead = requireBoundedUtf8String(value.gitHead, `${source} gitHead`, 64);
  if (gitHead && !/^[a-f0-9]{40,64}$/.test(gitHead)) {
    throw corrupt(`${source} gitHead is invalid.`);
  }
  if (typeof value.stale !== 'boolean' || typeof value.liveVerificationRequired !== 'boolean') {
    throw corrupt(`${source} verification flags must be booleans.`);
  }
  if (!Array.isArray(value.policyWarnings)
    || value.policyWarnings.length > MAX_METADATA_POLICY_WARNINGS) {
    throw corrupt(
      `${source} policyWarnings must be an array of at most ${MAX_METADATA_POLICY_WARNINGS} items.`,
    );
  }
  return {
    channel: value.channel,
    relativePath: requireSafeRelativePath(value.relativePath, `${source} relativePath`, 1_024),
    ...(value.appId === undefined
      ? {}
      : { appId: requireMetadataIdentifier(value.appId, `${source} appId`) }),
    ...(value.projectId === undefined
      ? {}
      : { projectId: requireMetadataIdentifier(value.projectId, `${source} projectId`) }),
    sha256: value.sha256,
    verifiedAt: requireBoundedMetadataString(value.verifiedAt, `${source} verifiedAt`, 128),
    gitHead,
    queryHash: value.queryHash,
    retrievedAt: requireBoundedMetadataString(value.retrievedAt, `${source} retrievedAt`, 128),
    stale: value.stale,
    liveVerificationRequired: value.liveVerificationRequired,
    policyWarnings: value.policyWarnings.map((warning, index) => (
      requireBoundedMetadataString(warning, `${source} policy warning ${index + 1}`, 512)
    )),
  };
}

function normalizeToolLifecycleMetadata(
  value: unknown,
  content: string,
): ChatToolLifecycleContentMetadata | undefined {
  if (!isRecord(value) || value.version !== 1 || !hasExactKeys(value, ['version', 'spans'])
    || !Array.isArray(value.spans) || value.spans.length > MAX_TOOL_LIFECYCLE_SPANS) return undefined;
  const spans: ChatToolLifecycleContentMetadata['spans'] = [];
  let previousEnd = 0;
  for (const item of value.spans) {
    if (!isRecord(item) || !hasExactKeys(item, ['start', 'end', 'sha256'])) return undefined;
    const { start, end, sha256: spanHash } = item;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || Number(start) < previousEnd || Number(end) <= Number(start)
      || Number(end) > content.length || !isSha256(spanHash)
      || sha256(content.slice(Number(start), Number(end))) !== spanHash) return undefined;
    spans.push({ start: Number(start), end: Number(end), sha256: spanHash });
    previousEnd = Number(end);
  }
  return { version: 1, spans };
}

function requireMetadataIdentifier(value: unknown, source: string): string {
  const normalized = requireBoundedMetadataString(value, source, 200);
  if (normalized && !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/.test(normalized)) {
    throw corrupt(`${source} is invalid.`);
  }
  return normalized;
}

function requireBoundedMetadataString(value: unknown, source: string, maximumBytes: number): string {
  const normalized = requireBoundedUtf8String(value, source, maximumBytes);
  if (Array.from(normalized).some(character => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  })) {
    throw corrupt(`${source} contains control characters.`);
  }
  return normalized;
}

function requireSafeRelativePath(value: unknown, source: string, maximumBytes: number): string {
  const normalized = requireBoundedNonEmptyUtf8String(value, source, maximumBytes);
  const segments = normalized.split('/');
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0')
    || normalized.startsWith('~') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(normalized)
    || Array.from(normalized).some(character => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
    || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw corrupt(`${source} must be a safe relative path.`);
  }
  return normalized;
}

function assertJsonMetadataValue(value: unknown, source: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_METADATA_NODES) throw corrupt(`${source} is structurally too large.`);
    if (current.depth > MAX_JSON_METADATA_DEPTH) throw corrupt(`${source} is nested too deeply.`);
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) throw corrupt(`${source} contains a non-finite number.`);
      continue;
    }
    if (typeof current.value === 'string') {
      if (Buffer.byteLength(current.value, 'utf8') > MAX_JSON_METADATA_STRING_BYTES) {
        throw corrupt(`${source} contains an oversized string.`);
      }
      continue;
    }
    if (typeof current.value !== 'object' || current.value === undefined) {
      throw corrupt(`${source} must contain JSON-compatible values only.`);
    }
    if (seen.has(current.value)) throw corrupt(`${source} contains a cycle or repeated object reference.`);
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_METADATA_ARRAY_ITEMS) {
        throw corrupt(`${source} contains an oversized array.`);
      }
      current.value.forEach(entry => stack.push({ value: entry, depth: current.depth + 1 }));
      continue;
    }
    const prototype: unknown = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw corrupt(`${source} contains a non-JSON object.`);
    }
    if (Object.getOwnPropertySymbols(current.value).length > 0) {
      throw corrupt(`${source} contains symbol keys.`);
    }
    const entries = Object.entries(current.value);
    if (entries.length > MAX_JSON_METADATA_OBJECT_KEYS) {
      throw corrupt(`${source} contains too many object fields.`);
    }
    for (const [key, entry] of entries) {
      if (Buffer.byteLength(key, 'utf8') > 512) throw corrupt(`${source} contains an oversized field name.`);
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
}

function defineJsonProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function normalizeTurn(value: unknown, source: string): StoredConversationTurn {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  const turn: StoredConversationTurn = {
    id: requireNonEmptyString(value.id, `${source} id`),
    agentId: requireAgentId(value.agentId, `${source} agentId`),
    userMessageId: requireNonEmptyString(value.userMessageId, `${source} userMessageId`),
    assistantMessageId: requireNonEmptyString(value.assistantMessageId, `${source} assistantMessageId`),
    state: requireTurnState(value.state, `${source} state`),
    queueSequence: requirePositiveInteger(value.queueSequence, `${source} queueSequence`),
    createdAt: requireTimestamp(value.createdAt, `${source} createdAt`),
    updatedAt: requireTimestamp(value.updatedAt, `${source} updatedAt`),
  };
  for (const key of ['startedAt', 'cancelRequestedAt', 'completedAt'] as const) {
    if (value[key] !== undefined) turn[key] = requireTimestamp(value[key], `${source} ${key}`);
  }
  if (value.error !== undefined) turn.error = requireString(value.error, `${source} error`);
  if (value.runtime !== undefined) turn.runtime = normalizeRuntimeSnapshot(value.runtime, `${source} runtime`);
  return turn;
}

function normalizeRuntimeSnapshot(value: unknown, source: string): ConversationRuntimeSnapshot {
  if (!isRecord(value)) throw new ConversationTurnStateError(`${source} must be an object.`);
  const configSource = value.configSource;
  if (configSource !== 'localCli' && configSource !== 'ccSwitchCurrent'
    && configSource !== 'providerProfile') {
    throw new ConversationTurnStateError(`${source} configSource is invalid.`);
  }
  if (typeof value.planMode !== 'boolean' || typeof value.fullAccess !== 'boolean') {
    throw new ConversationTurnStateError(`${source} permission flags must be booleans.`);
  }
  const snapshot: ConversationRuntimeSnapshot = {
    configSource,
    planMode: value.planMode,
    fullAccess: value.fullAccess,
  };
  for (const key of [
    'providerProfileId',
    'ccSwitchProviderId',
    'ccSwitchRouteFingerprint',
    'ccSwitchSessionFingerprint',
    'model',
    'reasoningEffort',
  ] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 512) {
      throw new ConversationTurnStateError(`${source} ${key} must be a bounded string.`);
    }
    snapshot[key] = value[key];
  }
  return snapshot;
}

function requireTurn(conversation: VersionedStoredConversation, turnId: string): StoredConversationTurn {
  const turn = conversation.turns.find(item => item.id === turnId);
  if (!turn) throw new ConversationTurnStateError(`Turn ${turnId} was not found.`);
  return turn;
}

function requireMessage(conversation: VersionedStoredConversation, messageId: string): ChatMessage {
  const message = conversation.messages.find(item => item.id === messageId);
  if (!message) throw new ConversationTurnStateError(`Message ${messageId} was not found.`);
  return message;
}

function requireTurnAssistant(
  conversation: VersionedStoredConversation,
  turn: StoredConversationTurn,
): ChatMessage {
  const assistant = conversation.messages.find(item => item.id === turn.assistantMessageId);
  if (!assistant) throw corrupt(`Turn ${turn.id} assistant message is missing.`);
  return assistant;
}

function applyMessagePatch(message: ChatMessage, patch: ChatMessagePatch): ChatMessage {
  const next = cloneJson(message);
  if (patch.role !== undefined) next.role = requireMessageRole(patch.role, 'message patch role');
  if (patch.content !== undefined) next.content = requireBoundedUtf8String(
    patch.content,
    'message patch content',
    CHAT_V2_MAX_MESSAGE_CONTENT_BYTES,
  );
  if (patch.agentId !== undefined) next.agentId = requireAgentId(patch.agentId, 'message patch agentId');
  if (patch.metadata === null) delete next.metadata;
  else if (patch.metadata !== undefined) {
    if (!isRecord(patch.metadata)) {
      throw new ConversationTurnStateError('Message patch metadata must be an object.');
    }
    next.metadata = { ...(next.metadata ?? {}), ...patch.metadata };
  }
  return normalizeMessage(next, `message ${message.id}`);
}

function assignMessage(target: ChatMessage, next: ChatMessage): void {
  if (next.metadata === undefined) delete target.metadata;
  Object.assign(target, next);
}

function assignNullableAgentValue(
  target: Partial<Record<AgentId, string>>,
  agentId: AgentId,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete target[agentId];
  else target[agentId] = requireNonEmptyString(value, `${agentId} session value`);
}

function assertExpectedRevision(
  conversation: VersionedStoredConversation,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0
    || conversation.revision !== expectedRevision) {
    throw new ConversationRevisionConflictError(
      conversation.id,
      expectedRevision,
      conversation.revision,
    );
  }
}

function assertNoOtherActiveTurn(
  conversation: VersionedStoredConversation,
  exceptTurnId?: string,
): void {
  const active = conversation.turns.find(turn => turn.id !== exceptTurnId
    && (turn.state === 'active' || turn.state === 'cancelRequested'));
  if (active) {
    throw new ConversationTurnStateError(
      `Conversation ${conversation.id} already has active turn ${active.id}.`,
    );
  }
}

function turnResult(
  applied: boolean,
  conversation: VersionedStoredConversation,
  turn: StoredConversationTurn,
): TurnMutationResult {
  return {
    applied,
    revision: conversation.revision,
    turn: cloneJson(turn),
  };
}

function messageResult(
  applied: boolean,
  conversation: VersionedStoredConversation,
  message: ChatMessage,
  turn: StoredConversationTurn | null,
): MessageMutationResult {
  return {
    applied,
    revision: conversation.revision,
    message: cloneJson(message),
    turn: turn ? cloneJson(turn) : null,
  };
}

function sessionResult(
  applied: boolean,
  conversation: VersionedStoredConversation,
): SessionMutationResult {
  return { applied, revision: conversation.revision };
}

function titleFromMessage(message: ChatMessage, fallback = DEFAULT_CONVERSATION_TITLE): string {
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
}

function isTerminalTurnState(state: StoredConversationTurn['state']): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'failed' || state === 'interrupted';
}

function materializeRunStateTurns(
  snapshotTurns: readonly StoredConversationTurn[],
  runState: Pick<RunState, 'turns' | 'turnsMode'>,
): StoredConversationTurn[] {
  if (runState.turnsMode !== 'tail') return cloneJson(runState.turns);
  const materialized = snapshotTurns.map(turn => cloneJson(turn));
  const indexes = new Map(materialized.map((turn, index) => [turn.id, index]));
  for (const override of runState.turns) {
    const index = indexes.get(override.id);
    if (index === undefined) {
      indexes.set(override.id, materialized.length);
      materialized.push(cloneJson(override));
    } else {
      materialized[index] = cloneJson(override);
    }
  }
  return materialized;
}

function mutationRunStateTurns(
  turns: readonly StoredConversationTurn[],
  snapshotTurns: readonly StoredConversationTurn[],
): StoredConversationTurn[] {
  const snapshotById = new Map(snapshotTurns.map(turn => [turn.id, turn]));
  return turns.filter(turn => (
    !isTerminalTurnState(turn.state)
      || !jsonEqual(snapshotById.get(turn.id), turn)
  )).map(turn => cloneJson(turn));
}

function normalizeAgentStringMap(
  value: unknown,
  source: string,
): Partial<Record<AgentId, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  const result: Partial<Record<AgentId, string>> = {};
  for (const [key, item] of Object.entries(value)) {
    const agentId = requireAgentId(key, `${source} key`);
    result[agentId] = requireNonEmptyString(item, `${source}.${key}`);
  }
  return result;
}

function normalizeSessionOwnerMap(
  value: unknown,
  conversationId: string,
  sessionIds: Partial<Record<AgentId, string>>,
  source: string,
): Partial<Record<AgentId, ConversationSessionOwner>> {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  const result: Partial<Record<AgentId, ConversationSessionOwner>> = {};
  for (const [rawAgentId, rawOwner] of Object.entries(value)) {
    const agentId = requireAgentId(rawAgentId, `${source} key`);
    if (!isRecord(rawOwner)) throw corrupt(`${source}.${agentId} must be an object.`);
    const owner: ConversationSessionOwner = {
      sessionId: requireNonEmptyString(rawOwner.sessionId, `${source}.${agentId}.sessionId`),
      conversationId: requireNonEmptyString(
        rawOwner.conversationId,
        `${source}.${agentId}.conversationId`,
      ),
      agentId: requireAgentId(rawOwner.agentId, `${source}.${agentId}.agentId`),
      runId: requireNonEmptyString(rawOwner.runId, `${source}.${agentId}.runId`),
      claimedAt: requireTimestamp(rawOwner.claimedAt, `${source}.${agentId}.claimedAt`),
    };
    if (owner.conversationId !== conversationId || owner.agentId !== agentId
      || sessionIds[agentId] !== owner.sessionId) {
      throw corrupt(`${source}.${agentId} does not match sessionIds.`);
    }
    result[agentId] = owner;
  }
  return result;
}

function requireTurnState(value: unknown, source: string): StoredConversationTurn['state'] {
  if (value === 'queued' || value === 'paused' || value === 'active'
    || value === 'cancelRequested' || value === 'completed' || value === 'cancelled'
    || value === 'failed' || value === 'interrupted') return value;
  throw corrupt(`${source} is invalid.`);
}

function requireMessageRole(value: unknown, source: string): MessageRole {
  if (value === 'user' || value === 'assistant' || value === 'system'
    || value === 'tool' || value === 'error') return value;
  throw corrupt(`${source} is invalid.`);
}

function requireAgentId(value: unknown, source: string): AgentId {
  if (isAgentId(value)) return value;
  throw corrupt(`${source} is invalid.`);
}

function isAgentId(value: unknown): value is AgentId {
  return value === 'claude' || value === 'codex' || value === 'pi' || value === 'antigravity';
}

function assertUtf8ByteBudget(value: string, maximumBytes: number, source: string): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    throw corrupt(`${source} is ${bytes} UTF-8 bytes and exceeds the ${maximumBytes}-byte budget.`);
  }
}

function assertMessageWindowBudget(messages: readonly SequencedChatMessage[]): void {
  let bytes = 2;
  for (const item of messages) {
    bytes += Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes > CHAT_V2_MAX_MESSAGE_WINDOW_BYTES) {
      throw new ConversationTurnStateError(
        `The requested message window exceeds ${CHAT_V2_MAX_MESSAGE_WINDOW_BYTES} UTF-8 bytes; request fewer messages.`,
      );
    }
  }
}

function assertJournalAppendBudget(expectedRaw: string | null, record: JournalRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  const bytes = (expectedRaw === null ? 0 : Buffer.byteLength(expectedRaw, 'utf8'))
    + Buffer.byteLength(line, 'utf8');
  if (bytes > CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES) {
    throw corrupt(
      `Conversation journal append would exceed the ${CHAT_V2_MAX_JOURNAL_SEGMENT_BYTES}-byte segment budget.`,
    );
  }
}

function requireBoundedUtf8String(value: unknown, source: string, maximumBytes: number): string {
  const normalized = requireString(value, source);
  assertUtf8ByteBudget(normalized, maximumBytes, source);
  return normalized;
}

function requireBoundedNonEmptyUtf8String(
  value: unknown,
  source: string,
  maximumBytes: number,
): string {
  const normalized = requireNonEmptyString(value, source);
  assertUtf8ByteBudget(normalized, maximumBytes, source);
  return normalized;
}

function requireSafeNonNegativeInteger(value: unknown, source: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  throw corrupt(`${source} must be a non-negative safe integer.`);
}

function requireString(value: unknown, source: string): string {
  if (typeof value === 'string') return value;
  throw corrupt(`${source} must be a string.`);
}

function requireNonEmptyString(value: unknown, source: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  throw corrupt(`${source} must be a non-empty string.`);
}

function requireTimestamp(value: unknown, source: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number) && number >= 0) return number;
  throw corrupt(`${source} must be a finite non-negative number.`);
}

function requireNonNegativeInteger(value: unknown, source: string): number {
  if (isNonNegativeInteger(value)) return value;
  throw corrupt(`${source} must be a non-negative integer.`);
}

function requirePositiveInteger(value: unknown, source: string): number {
  if (isPositiveInteger(value)) return value;
  throw corrupt(`${source} must be a positive integer.`);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function corrupt(message: string): ConversationStoreCorruptError {
  return new ConversationStoreCorruptError(message);
}
