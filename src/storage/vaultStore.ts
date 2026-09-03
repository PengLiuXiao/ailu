import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';

import type { DataAdapter } from 'obsidian';

import { DEFAULT_CONVERSATION_TITLE, STORAGE_IDS } from '../ids';
import type {
  AgentId,
  ChatImageArtifact,
  ChatMessage,
  ChatMessageMetadata,
  ConversationContextCheckpoint,
  ConversationContextCheckpointDraft,
  MessageRole,
  RuntimeConfigSource,
  StoredConversation,
} from '../types';
import { createId } from '../utils/id';
import type { SlashCommand } from '../utils/slashCommands';
import {
  ChatStoreLease,
  ChatStoreLeaseCorruptError,
  ChatStoreLeaseLostError,
  type ChatStoreLeaseOptions,
  type ChatStoreLeaseStatus,
} from './chatStoreLease';
import {
  ConversationRevisionConflictError,
  ConversationSessionConflictError,
  ConversationStoreAtomicWriteError,
  ConversationStoreCorruptError,
  ConversationStoreMigrationError,
  ConversationStoreReadOnlyError,
  ConversationTurnStateError,
  type ConversationSessionOwner,
} from './conversationStoreErrors';
import {
  ConversationRepositoryV2,
  type CatalogRebuildReport,
  type ConversationArchiveFilter,
  type ConversationDraft,
  type ConversationMessagePage,
  type ConversationSearchOptions,
  type ConversationSessionOwnership,
  type ConversationStoreStatus,
  type ConversationSummaryPage,
  type ConversationWindow,
  type EnsureV2StoreOptions,
  type V2MigrationReport,
  type V1MigrationSource,
} from './conversationRepositoryV2';

export type {
  CatalogRebuildReport,
  ConversationArchiveFilter,
  ConversationDraft,
  ConversationMessagePage,
  ConversationSearchOptions,
  ConversationSessionOwnership,
  ConversationStoreStatus,
  ConversationSummary,
  ConversationSummaryPage,
  ConversationWindow,
  EnsureV2StoreOptions,
  SequencedChatMessage,
  V2MigrationCrashPoint,
  V2MigrationReport,
} from './conversationRepositoryV2';

export {
  ConversationRevisionConflictError,
  ConversationSessionConflictError,
  ConversationStoreAtomicWriteError,
  ConversationStoreCorruptError,
  ConversationStoreMigrationError,
  ConversationStoreReadOnlyError,
  ConversationTurnStateError,
} from './conversationStoreErrors';

interface ConversationFile {
  version: 1;
  /** Monotonic repository revision, allocated only while the mutation queue is held. */
  revision: number;
  /** Next globally unique queue position, allocated only while the mutation queue is held. */
  nextQueueSequence: number;
  conversations: VersionedStoredConversation[];
}

export type ConversationTurnState =
  | 'queued'
  | 'paused'
  | 'active'
  | 'cancelRequested'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

export interface StoredConversationTurn {
  id: string;
  agentId: AgentId;
  userMessageId: string;
  assistantMessageId: string;
  state: ConversationTurnState;
  queueSequence: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  cancelRequestedAt?: number;
  completedAt?: number;
  error?: string;
  /** Frozen non-secret launch configuration; absent only on pre-Phase-0 data. */
  runtime?: ConversationRuntimeSnapshot;
}

export interface ConversationRuntimeSnapshot {
  configSource: RuntimeConfigSource;
  providerProfileId?: string;
  ccSwitchProviderId?: string;
  ccSwitchRouteFingerprint?: string;
  ccSwitchSessionFingerprint?: string;
  model?: string;
  reasoningEffort?: string;
  planMode: boolean;
  fullAccess: boolean;
}

/** A strict superset of the old StoredConversation shape. */
export interface VersionedStoredConversation extends StoredConversation {
  revision: number;
  turns: StoredConversationTurn[];
  /** Durable runtime-session ownership used for cross-conversation conflict checks. */
  sessionOwnerships?: Partial<Record<AgentId, ConversationSessionOwner>>;
}

export interface ChatMessagePatch {
  role?: MessageRole;
  content?: string;
  agentId?: AgentId;
  /** `null` removes metadata; an object is shallow-merged with existing metadata. */
  metadata?: ChatMessageMetadata | null;
}

export interface BeginTurnInput {
  conversationId: string;
  agentId: AgentId;
  turnId?: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** Frozen before persistence; prompts, secrets, and attachment paths are deliberately excluded. */
  runtime: ConversationRuntimeSnapshot;
  /** Applied in the same revision and journal record as the new turn. */
  contextCheckpointDraft?: ConversationContextCheckpointDraft;
  expectedRevision?: number;
  /** Active mirrors the legacy immediate-run flow; schedulers can persist queued. */
  initialState?: 'active' | 'queued';
}

export interface ConversationMutationInput {
  conversationId: string;
  turnId: string;
  expectedRevision?: number;
}

export interface PatchMessageInput {
  conversationId: string;
  messageId: string;
  patch: ChatMessagePatch;
  turnId?: string;
  expectedRevision?: number;
}

export interface PatchSessionInput {
  conversationId: string;
  agentId: AgentId;
  sessionId?: string | null;
  configKey?: string | null;
  turnId?: string;
  expectedRevision?: number;
}

export interface CommitContextCheckpointInput {
  conversationId: string;
  checkpoint: ConversationContextCheckpointDraft;
  expectedRevision?: number;
}

export interface ConversationSessionClaimInput {
  conversationId: string;
  agentId: AgentId;
  sessionId: string;
  runId: string;
  /** Stored atomically with the canonical session owner claim. */
  sessionConfigKey?: string;
  expectedRevision?: number;
}

export interface FinalizeTurnInput extends ConversationMutationInput {
  outcome?: 'completed' | 'failed';
  assistantPatch?: ChatMessagePatch;
  error?: string;
}

export interface CancelTurnInput extends ConversationMutationInput {
  assistantPatch?: ChatMessagePatch;
}

export interface TurnMutationResult {
  applied: boolean;
  revision: number;
  turn: StoredConversationTurn;
}

export interface MessageMutationResult {
  applied: boolean;
  revision: number;
  message: ChatMessage;
  turn: StoredConversationTurn | null;
}

export interface SessionMutationResult {
  applied: boolean;
  revision: number;
}

export interface ContextCheckpointMutationResult {
  applied: boolean;
  revision: number;
  checkpoint: ConversationContextCheckpoint;
}

export interface ConversationArchiveMutationResult {
  applied: boolean;
  revision: number;
  archivedAt: number | null;
}

export interface PendingConversationTurn {
  conversationId: string;
  conversationRevision: number;
  turn: StoredConversationTurn;
}

export interface RecoveryTransition {
  conversationId: string;
  turnId: string;
  from: 'queued' | 'active' | 'cancelRequested';
  to: 'paused' | 'interrupted';
  revision: number;
}

export interface ConversationRecoveryResult {
  applied: boolean;
  transitions: RecoveryTransition[];
  conversations: VersionedStoredConversation[];
}

export interface VaultStoreOptions extends ChatStoreLeaseOptions {
  /** Existing callers remain compatible; onload should opt in or call acquireWriteLease(). */
  requireWriteLease?: boolean;
  /**
   * Central, once-per-ownership notification. It fires synchronously inside
   * the first protected mutation/heartbeat that observes lease or flock loss.
   */
  onWriteLeaseLost?: (error: Error) => void;
}

export interface GeneratedImageImportBudget {
  maxItemBytes: number;
  remainingTurnBytes: number;
  signal?: AbortSignal;
}

export interface GeneratedImageImportResult {
  artifact: ChatImageArtifact;
  byteLength: number;
}

class ConversationCasMismatchError extends Error {}

const CONVERSATIONS_PATH = STORAGE_IDS.conversationsPath;
const COMMANDS_PATH = STORAGE_IDS.commandsPath;
const MENTION_CACHE_PATH = STORAGE_IDS.mentionCachePath;
const GENERATED_IMAGES_PATH = STORAGE_IDS.generatedImagesPath;
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;

export class VaultStore {
  private readonly lease: ChatStoreLease;
  private readonly conversationRepositoryV2: ConversationRepositoryV2;
  private readonly now: () => number;
  private readonly onWriteLeaseLost?: (error: Error) => void;
  private readonly vaultBasePath: string | null;
  private mutationTail: Promise<void> = Promise.resolve();
  private leaseEnforced: boolean;
  private heartbeatTimer: number | null = null;
  private migrationGate: Promise<void> | null = null;
  private releaseMigrationGate: (() => void) | null = null;
  private writeLeaseLossNotified = false;

  constructor(
    private readonly adapter: DataAdapter,
    options: VaultStoreOptions = {},
  ) {
    this.lease = new ChatStoreLease(adapter, options);
    this.onWriteLeaseLost = options.onWriteLeaseLost;
    this.vaultBasePath = options.vaultBasePath ? path.resolve(options.vaultBasePath) : null;
    this.now = options.now ?? Date.now;
    this.leaseEnforced = options.requireWriteLease ?? false;
    this.conversationRepositoryV2 = new ConversationRepositoryV2({
      adapter,
      instanceId: this.lease.instanceId,
      now: this.now,
      assertWrite: refreshLease => this.assertMutationAllowed(refreshLease),
      fencedCompareAndSwap: async (path, expectedRaw, nextRaw) => {
        // VaultStore keeps a compatibility mode for callers that do not
        // require a writer lease. In that mode the repository must continue
        // through its adapter CAS path; once acquireWriteLease() enables
        // enforcement, this same closure switches to the physical fence.
        if (!this.leaseEnforced) return null;
        try {
          return await this.lease.compareAndSwapTextFile(path, expectedRaw, nextRaw);
        } catch (error) {
          // The helper itself is the fencing lifetime. A crash during the
          // final physical CAS must synchronously trip the central shutdown
          // callback in this mutation, not wait for the next heartbeat.
          this.notifyWriteLeaseLost(asError(error));
          throw error;
        }
      },
      readV1Source: () => this.readV1MigrationSource(),
      normalizeConversation,
    });
  }

  async acquireWriteLease(options: { startHeartbeat?: boolean } = {}): Promise<ChatStoreLeaseStatus> {
    this.leaseEnforced = true;
    const status = await this.lease.acquire();
    if (status.mode === 'writer') {
      this.writeLeaseLossNotified = false;
      if (options.startHeartbeat !== false) this.startWriteLeaseHeartbeat();
    }
    return status;
  }

  async renewWriteLease(): Promise<ChatStoreLeaseStatus> {
    try {
      const status = await this.lease.renew();
      if (status.mode !== 'writer') this.notifyWriteLeaseLost(new ChatStoreLeaseLostError());
      return status;
    } catch (error) {
      this.notifyWriteLeaseLost(asError(error));
      throw error;
    }
  }

  async releaseWriteLease(): Promise<ChatStoreLeaseStatus> {
    this.stopWriteLeaseHeartbeat();
    return this.lease.release();
  }

  async getWriteLeaseStatus(): Promise<ChatStoreLeaseStatus> {
    return this.lease.inspect();
  }

  /** Enables and asserts the canonical writer fence before external fenced work. */
  async assertWriteLeaseHeld(): Promise<void> {
    this.leaseEnforced = true;
    await this.lease.assertOwned();
  }

  /** Physical helper CAS for Vault-relative authority outside the chat store. */
  async compareAndSwapExternalText(
    vaultRelativePath: string,
    expectedRaw: string | null,
    replacementRaw: string,
  ): Promise<{ swapped: boolean; value: string | null }> {
    this.leaseEnforced = true;
    await this.lease.assertOwned();
    const swapped = await this.lease.compareAndSwapTextFile(
      vaultRelativePath,
      expectedRaw,
      replacementRaw,
    );
    const value = await this.lease.readTextFile(vaultRelativePath);
    return { swapped, value };
  }

  startWriteLeaseHeartbeat(
    onLeaseLost?: (error: Error, status?: ChatStoreLeaseStatus) => void,
  ): void {
    this.stopWriteLeaseHeartbeat();
    const intervalMs = Math.max(500, Math.floor(this.lease.ttlMs / 3));
    this.heartbeatTimer = window.setInterval(() => {
      void this.lease.renew().then(status => {
        if (status.mode === 'writer') return;
        this.stopWriteLeaseHeartbeat();
        const error = new ChatStoreLeaseLostError();
        this.notifyWriteLeaseLost(error);
        onLeaseLost?.(error, status);
      }).catch(error => {
        this.stopWriteLeaseHeartbeat();
        const normalized = asError(error);
        this.notifyWriteLeaseLost(normalized);
        onLeaseLost?.(normalized);
      });
    }, intervalMs);
  }

  stopWriteLeaseHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async ensureV2Store(options: EnsureV2StoreOptions = {}): Promise<V2MigrationReport> {
    if (this.migrationGate) {
      await this.migrationGate;
      return this.conversationRepositoryV2.ensureV2Store(options);
    }
    let release!: () => void;
    this.migrationGate = new Promise<void>(resolve => { release = resolve; });
    this.releaseMigrationGate = release;
    try {
      // Every v1 mutation admitted before the freeze must settle before the
      // injected runtime quiescence barrier and source verification run.
      await this.mutationTail;
      return await this.conversationRepositoryV2.ensureV2Store(options);
    } finally {
      this.releaseMigrationGate?.();
      this.releaseMigrationGate = null;
      this.migrationGate = null;
    }
  }

  async getConversationStoreStatus(): Promise<ConversationStoreStatus> {
    await this.waitForMigration();
    return this.conversationRepositoryV2.getStatus();
  }

  async listConversationSummaries(
    cursor: string | null = null,
    pageSize = 50,
    archiveFilter: ConversationArchiveFilter = 'active',
  ): Promise<ConversationSummaryPage> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.listConversationSummaries(cursor, pageSize, archiveFilter);
  }

  async searchConversations(
    query: string,
    options: ConversationSearchOptions = {},
  ): Promise<ConversationSummaryPage> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.searchConversations(query, options);
  }

  async loadConversationWindow(
    conversationId: string,
    limit = 100,
  ): Promise<ConversationWindow | null> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.loadConversationWindow(conversationId, limit);
  }

  async loadMessages(
    conversationId: string,
    beforeSequence: number | null = null,
    limit = 100,
  ): Promise<ConversationMessagePage> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.loadMessages(conversationId, beforeSequence, limit);
  }

  async saveDraft<T>(conversationId: string, value: T): Promise<ConversationDraft<T>> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.saveDraft(conversationId, value);
  }

  async loadDraft<T = unknown>(conversationId: string): Promise<ConversationDraft<T> | null> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.loadDraft<T>(conversationId);
  }

  async commitContextCheckpoint(
    input: CommitContextCheckpointInput,
  ): Promise<ContextCheckpointMutationResult> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.commitContextCheckpoint(input);
  }

  async archiveConversation(
    conversationId: string,
    expectedRevision?: number,
  ): Promise<ConversationArchiveMutationResult> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.archiveConversation(conversationId, expectedRevision);
  }

  async restoreConversation(
    conversationId: string,
    expectedRevision?: number,
  ): Promise<ConversationArchiveMutationResult> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.restoreConversation(conversationId, expectedRevision);
  }

  async rebuildCatalog(): Promise<CatalogRebuildReport> {
    await this.requireV2Backend();
    return this.conversationRepositoryV2.rebuildCatalog();
  }

  async listSessionOwnerships(): Promise<ConversationSessionOwnership[]> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.listSessionOwnerships();
    }
    const file = await this.readConversationsFile();
    const ownerships: ConversationSessionOwnership[] = [];
    for (const conversation of file.conversations) {
      for (const [rawAgentId, sessionId] of Object.entries(conversation.sessionIds ?? {})) {
        if (!sessionId) continue;
        const agentId = requireAgentId(rawAgentId, 'session owner agent');
        const owner = conversation.sessionOwnerships?.[agentId];
        ownerships.push({
          sessionId,
          conversationId: conversation.id,
          agentId,
          updatedAt: conversation.updatedAt,
          runId: owner?.runId ?? 'legacy',
          claimedAt: owner?.claimedAt ?? conversation.updatedAt,
        });
      }
    }
    assertUnique(ownerships.map(owner => owner.sessionId), 'runtime session ownership');
    return ownerships.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async loadSessionOwner(sessionId: string): Promise<ConversationSessionOwnership | null> {
    const normalized = requireNonEmptyString(sessionId, 'runtime session id');
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.loadSessionOwner(normalized);
    }
    // v1 remains readable during the one-time migration window. The normal
    // production path migrates before the coordinator is allowed to run.
    const owners = await this.listSessionOwnerships();
    return owners.find(owner => owner.sessionId === normalized) ?? null;
  }

  async listConversations(): Promise<VersionedStoredConversation[]> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.listConversations();
    }
    await this.mutationTail;
    const file = await this.readConversationsFile();
    return file.conversations.map(cloneConversation).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConversation(id: string): Promise<VersionedStoredConversation | null> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.getConversation(id);
    }
    await this.mutationTail;
    const file = await this.readConversationsFile();
    const conversation = file.conversations.find(item => item.id === id);
    return conversation ? cloneConversation(conversation) : null;
  }

  async listPendingTurns(): Promise<PendingConversationTurn[]> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.listPendingTurns();
    }
    const conversations = await this.listConversations();
    return conversations.flatMap(conversation => conversation.turns
      .filter(turn => !isTerminalTurnState(turn.state))
      .map(turn => ({
        conversationId: conversation.id,
        conversationRevision: conversation.revision,
        turn: cloneTurn(turn),
      })))
      .sort((a, b) => a.turn.queueSequence - b.turn.queueSequence);
  }

  /**
   * Builds an in-memory conversation without touching disk. Empty sessions are
   * never persisted; the first replaceConversation() call after a message is
   * sent inserts it into the store.
   */
  createDraftConversation(agentId: StoredConversation['agentId']): VersionedStoredConversation {
    const now = this.now();
    return {
      id: createId('conv'),
      title: DEFAULT_CONVERSATION_TITLE,
      agentId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      revision: 0,
      turns: [],
    };
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<VersionedStoredConversation> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.appendMessage(conversationId, message);
    }
    return this.enqueueConversationMutation(async file => {
      let conversation = file.conversations.find(item => item.id === conversationId);
      if (!conversation) {
        const now = this.now();
        conversation = {
          id: conversationId,
          title: titleFromMessage(message),
          agentId: message.agentId ?? 'claude',
          createdAt: now,
          updatedAt: now,
          messages: [],
          revision: 0,
          turns: [],
        };
        file.conversations.unshift(conversation);
      }
      const duplicate = conversation.messages.find(item => item.id === message.id);
      if (duplicate) {
        if (!jsonEqual(duplicate, message)) {
          throw new ConversationTurnStateError(`Message id ${message.id} is already in use.`);
        }
        return { changed: false, value: cloneConversation(conversation) };
      }
      conversation.messages.push(cloneMessage(message));
      conversation.updatedAt = this.now();
      if (!conversation.title || conversation.title === DEFAULT_CONVERSATION_TITLE) {
        conversation.title = titleFromMessage(message, conversation.title);
      }
      allocateRevision(file, conversation);
      return { changed: true, value: cloneConversation(conversation) };
    });
  }

  async replaceConversation(conversation: StoredConversation): Promise<void> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.replaceConversation(conversation);
    }
    await this.enqueueConversationMutation(async file => {
      const index = file.conversations.findIndex(item => item.id === conversation.id);
      const existing = index >= 0 ? file.conversations[index] : null;
      const incoming = conversation as StoredConversation & Partial<VersionedStoredConversation>;
      if (existing && incoming.revision !== undefined && incoming.revision !== existing.revision) {
        throw new ConversationRevisionConflictError(
          conversation.id,
          incoming.revision,
          existing.revision,
        );
      }
      if (incoming.contextCheckpoint !== undefined
        && (!existing?.contextCheckpoint
          || !jsonEqual(incoming.contextCheckpoint, existing.contextCheckpoint))) {
        throw new ConversationTurnStateError(
          'Context checkpoints may only be created by commitContextCheckpoint().',
        );
      }
      if (existing?.contextCheckpoint) {
        const candidateMessages = incoming.messages ?? existing.messages;
        const covered = existing.contextCheckpoint.throughMessageSequence;
        if (candidateMessages.length < covered
          || !jsonEqual(
            candidateMessages.slice(0, covered),
            existing.messages.slice(0, covered),
          )) {
          throw new ConversationTurnStateError(
            'replaceConversation() cannot alter messages covered by a context checkpoint.',
          );
        }
      }
      const normalized = normalizeConversation({
        ...(existing ?? {}),
        ...cloneJson(conversation),
        revision: existing?.revision ?? 0,
        turns: incoming.turns === undefined
          ? existing?.turns ?? []
          : cloneJson(incoming.turns),
        updatedAt: this.now(),
      }, `conversation ${conversation.id}`);
      allocateRevision(file, normalized);
      if (index >= 0) file.conversations[index] = normalized;
      else file.conversations.unshift(normalized);
      return { changed: true, value: undefined };
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.deleteConversation(id);
    }
    await this.mutationTail;
    const file = await this.readConversationsFile();
    if (!file.conversations.some(item => item.id === id)) return;
    throw new ConversationStoreMigrationError(
      'Legacy conversations cannot be deleted; initialize repository v2 so delete maps to archive.',
    );
  }

  async beginTurn(input: BeginTurnInput): Promise<TurnMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.beginTurn(input);
    }
    return this.enqueueConversationMutation(async file => {
      validateBeginTurnInput(input);
      const turnId = input.turnId?.trim() || createId('turn');
      let conversation = file.conversations.find(item => item.id === input.conversationId);
      const existingTurn = conversation?.turns.find(turn => turn.id === turnId);
      if (conversation && existingTurn) {
        assertBeginTurnReplay(conversation, existingTurn, input);
        return {
          changed: false,
          value: turnResult(false, conversation, existingTurn),
        };
      }

      const now = this.now();
      if (!conversation) {
        conversation = {
          id: input.conversationId,
          title: titleFromMessage(input.userMessage),
          agentId: input.agentId,
          createdAt: now,
          updatedAt: now,
          messages: [],
          revision: 0,
          turns: [],
        };
        file.conversations.unshift(conversation);
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      const contextCheckpoint = input.contextCheckpointDraft
        ? materializeAtomicContextCheckpoint(conversation, input.contextCheckpointDraft)
        : undefined;
      for (const message of [input.userMessage, input.assistantMessage]) {
        if (conversation.messages.some(item => item.id === message.id)) {
          throw new ConversationTurnStateError(`Message id ${message.id} is already in use.`);
        }
      }
      const initialState = input.initialState ?? 'active';
      if (initialState === 'active') assertNoOtherActiveTurn(conversation);
      conversation.messages.push(cloneMessage(input.userMessage), cloneMessage(input.assistantMessage));
      conversation.agentId = input.agentId;
      conversation.updatedAt = now;
      if (!conversation.title || conversation.title === DEFAULT_CONVERSATION_TITLE) {
        conversation.title = titleFromMessage(input.userMessage, conversation.title);
      }
      const turn: StoredConversationTurn = {
        id: turnId,
        agentId: input.agentId,
        userMessageId: input.userMessage.id,
        assistantMessageId: input.assistantMessage.id,
        state: initialState,
        queueSequence: takeQueueSequence(file),
        createdAt: now,
        updatedAt: now,
        runtime: normalizeRuntimeSnapshot(input.runtime, 'turn runtime snapshot'),
        ...(initialState === 'active' ? { startedAt: now } : {}),
      };
      conversation.turns.push(turn);
      if (contextCheckpoint) conversation.contextCheckpoint = contextCheckpoint;
      allocateRevision(file, conversation);
      return { changed: true, value: turnResult(true, conversation, turn) };
    });
  }

  async activateTurn(input: ConversationMutationInput): Promise<TurnMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.activateTurn(input);
    }
    return this.enqueueConversationMutation(async file => {
      const { conversation, turn } = requireConversationTurn(file, input);
      if (turn.state === 'active') return { changed: false, value: turnResult(false, conversation, turn) };
      if (turn.state !== 'queued' && turn.state !== 'paused') {
        throw new ConversationTurnStateError(`Turn ${turn.id} cannot become active from ${turn.state}.`);
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      assertNoOtherActiveTurn(conversation, turn.id);
      const now = this.now();
      turn.state = 'active';
      turn.startedAt = now;
      turn.updatedAt = now;
      conversation.updatedAt = now;
      allocateRevision(file, conversation);
      return { changed: true, value: turnResult(true, conversation, turn) };
    });
  }

  async patchMessage(input: PatchMessageInput): Promise<MessageMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.patchMessage(input);
    }
    return this.enqueueConversationMutation(async file => {
      const conversation = requireConversation(file, input.conversationId);
      const message = conversation.messages.find(item => item.id === input.messageId);
      if (!message) throw new ConversationTurnStateError(`Message ${input.messageId} was not found.`);
      const turn = input.turnId
        ? requireTurn(conversation, input.turnId)
        : conversation.turns.find(item => (
          item.userMessageId === input.messageId || item.assistantMessageId === input.messageId
        )) ?? null;
      if (turn && input.turnId
        && turn.userMessageId !== input.messageId
        && turn.assistantMessageId !== input.messageId) {
        throw new ConversationTurnStateError(`Message ${input.messageId} does not belong to turn ${turn.id}.`);
      }
      const nextMessage = applyMessagePatch(message, input.patch);
      if (jsonEqual(message, nextMessage)) {
        return {
          changed: false,
          value: messageResult(false, conversation, message, turn),
        };
      }
      if (turn && (isTerminalTurnState(turn.state) || turn.state === 'cancelRequested')) {
        throw new ConversationTurnStateError(`Turn ${turn.id} no longer accepts message patches.`);
      }
      const messageSequence = conversation.messages.indexOf(message) + 1;
      if (conversation.contextCheckpoint
        && messageSequence <= conversation.contextCheckpoint.throughMessageSequence) {
        throw new ConversationTurnStateError(
          'Messages covered by a context checkpoint cannot be changed.',
        );
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      assignMessage(message, nextMessage);
      conversation.updatedAt = this.now();
      allocateRevision(file, conversation);
      return { changed: true, value: messageResult(true, conversation, message, turn) };
    });
  }

  async checkpointAssistantMessage(input: PatchMessageInput): Promise<MessageMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.checkpointAssistantMessage(input);
    }
    return this.patchMessage(input);
  }

  async patchSession(input: PatchSessionInput): Promise<SessionMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.patchSession(input);
    }
    return this.enqueueConversationMutation(async file => {
      const conversation = requireConversation(file, input.conversationId);
      const turn = input.turnId ? requireTurn(conversation, input.turnId) : null;
      if (typeof input.sessionId === 'string' && input.sessionId.trim()) {
        assertSessionIdAvailable(file, input.conversationId, input.agentId, input.sessionId);
      }
      const nextSessionIds = { ...(conversation.sessionIds ?? {}) };
      const nextConfigKeys = { ...(conversation.sessionConfigKeys ?? {}) };
      const nextOwnerships = { ...(conversation.sessionOwnerships ?? {}) };
      assignNullableAgentValue(nextSessionIds, input.agentId, input.sessionId);
      assignNullableAgentValue(nextConfigKeys, input.agentId, input.configKey);
      if (input.sessionId === null) delete nextOwnerships[input.agentId];
      else if (typeof input.sessionId === 'string') {
        const existingOwner = nextOwnerships[input.agentId];
        if (!existingOwner || existingOwner.sessionId !== input.sessionId) {
          nextOwnerships[input.agentId] = {
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            agentId: input.agentId,
            runId: input.turnId ?? 'legacy',
            claimedAt: this.now(),
          };
        }
      }
      if (jsonEqual(nextSessionIds, conversation.sessionIds ?? {})
        && jsonEqual(nextConfigKeys, conversation.sessionConfigKeys ?? {})
        && jsonEqual(nextOwnerships, conversation.sessionOwnerships ?? {})) {
        return { changed: false, value: sessionResult(false, conversation) };
      }
      if (turn && (isTerminalTurnState(turn.state) || turn.state === 'cancelRequested')) {
        throw new ConversationTurnStateError(`Turn ${turn.id} no longer accepts session patches.`);
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      conversation.sessionIds = nextSessionIds;
      conversation.sessionConfigKeys = nextConfigKeys;
      conversation.sessionOwnerships = nextOwnerships;
      conversation.updatedAt = this.now();
      allocateRevision(file, conversation);
      return { changed: true, value: sessionResult(true, conversation) };
    });
  }

  async claimSessionOwnership(input: ConversationSessionClaimInput): Promise<SessionMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.claimSessionOwnership(input);
    }
    return this.enqueueConversationMutation(async file => {
      const conversationId = requireNonEmptyString(input.conversationId, 'conversation id');
      const sessionId = requireNonEmptyString(input.sessionId, 'runtime session id');
      const runId = requireNonEmptyString(input.runId, 'runtime run id');
      const conversation = requireConversation(file, conversationId);
      const existingOwner = findSessionOwner(file, sessionId);
      if (existingOwner
        && (existingOwner.conversationId !== conversationId
          || existingOwner.agentId !== input.agentId)) {
        throw new ConversationSessionConflictError(existingOwner);
      }
      const localOwner = conversation.sessionOwnerships?.[input.agentId];
      if (existingOwner && localOwner && jsonEqual(existingOwner, localOwner)
        && conversation.sessionIds?.[input.agentId] === sessionId
        && localOwner.runId === runId
        && (conversation.sessionConfigKeys?.[input.agentId] ?? undefined)
          === input.sessionConfigKey) {
        return { changed: false, value: sessionResult(false, conversation) };
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      const now = this.now();
      conversation.sessionIds = { ...(conversation.sessionIds ?? {}), [input.agentId]: sessionId };
      conversation.sessionConfigKeys = { ...(conversation.sessionConfigKeys ?? {}) };
      if (input.sessionConfigKey !== undefined) {
        conversation.sessionConfigKeys[input.agentId] = requireNonEmptyString(
          input.sessionConfigKey,
          'session config key',
        );
      }
      conversation.sessionOwnerships = {
        ...(conversation.sessionOwnerships ?? {}),
        [input.agentId]: {
          sessionId,
          conversationId,
          agentId: input.agentId,
          runId,
          claimedAt: now,
        },
      };
      conversation.updatedAt = now;
      allocateRevision(file, conversation);
      return { changed: true, value: sessionResult(true, conversation) };
    });
  }

  async requestTurnCancellation(input: ConversationMutationInput): Promise<TurnMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.requestTurnCancellation(input);
    }
    return this.enqueueConversationMutation(async file => {
      const { conversation, turn } = requireConversationTurn(file, input);
      if (turn.state === 'cancelRequested' || isTerminalTurnState(turn.state)) {
        return { changed: false, value: turnResult(false, conversation, turn) };
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      const now = this.now();
      turn.state = 'cancelRequested';
      turn.cancelRequestedAt = now;
      turn.updatedAt = now;
      conversation.updatedAt = now;
      allocateRevision(file, conversation);
      return { changed: true, value: turnResult(true, conversation, turn) };
    });
  }

  async finalizeTurn(input: FinalizeTurnInput): Promise<TurnMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.finalizeTurn(input);
    }
    return this.enqueueConversationMutation(async file => {
      const { conversation, turn } = requireConversationTurn(file, input);
      const outcome = input.outcome ?? 'completed';
      if (turn.state === 'cancelRequested' || turn.state === 'cancelled') {
        return { changed: false, value: turnResult(false, conversation, turn) };
      }
      const assistant = requireTurnAssistant(conversation, turn);
      const nextAssistant = input.assistantPatch
        ? applyMessagePatch(assistant, input.assistantPatch)
        : assistant;
      if (turn.state === outcome && jsonEqual(assistant, nextAssistant)) {
        return { changed: false, value: turnResult(false, conversation, turn) };
      }
      if (isTerminalTurnState(turn.state)) {
        throw new ConversationTurnStateError(`Turn ${turn.id} already ended as ${turn.state}.`);
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      assignMessage(assistant, nextAssistant);
      const now = this.now();
      turn.state = outcome;
      turn.updatedAt = now;
      turn.completedAt = now;
      if (input.error !== undefined) turn.error = input.error;
      conversation.updatedAt = now;
      allocateRevision(file, conversation);
      return { changed: true, value: turnResult(true, conversation, turn) };
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<TurnMutationResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.cancelTurn(input);
    }
    return this.enqueueConversationMutation(async file => {
      const { conversation, turn } = requireConversationTurn(file, input);
      const assistant = requireTurnAssistant(conversation, turn);
      const nextAssistant = input.assistantPatch
        ? applyMessagePatch(assistant, input.assistantPatch)
        : assistant;
      if (turn.state === 'cancelled' && jsonEqual(assistant, nextAssistant)) {
        return { changed: false, value: turnResult(false, conversation, turn) };
      }
      if (isTerminalTurnState(turn.state)) {
        return { changed: false, value: turnResult(false, conversation, turn) };
      }
      assertExpectedRevision(conversation, input.expectedRevision);
      assignMessage(assistant, nextAssistant);
      const now = this.now();
      turn.state = 'cancelled';
      turn.cancelRequestedAt ??= now;
      turn.updatedAt = now;
      turn.completedAt = now;
      conversation.updatedAt = now;
      allocateRevision(file, conversation);
      return { changed: true, value: turnResult(true, conversation, turn) };
    });
  }

  async recoverInterruptedTurns(): Promise<ConversationRecoveryResult> {
    await this.waitForMigration();
    if (await this.conversationRepositoryV2.isActive()) {
      return this.conversationRepositoryV2.recoverInterruptedTurns();
    }
    return this.enqueueConversationMutation(async file => {
      const transitions: RecoveryTransition[] = [];
      const changedConversations: VersionedStoredConversation[] = [];
      for (const conversation of file.conversations) {
        const pending: Array<{
          turn: StoredConversationTurn;
          from: RecoveryTransition['from'];
          to: RecoveryTransition['to'];
        }> = [];
        for (const turn of conversation.turns) {
          if (turn.state === 'queued') pending.push({ turn, from: 'queued', to: 'paused' });
          else if (turn.state === 'active' || turn.state === 'cancelRequested') {
            pending.push({ turn, from: turn.state, to: 'interrupted' });
          }
        }
        if (pending.length === 0) continue;
        const now = this.now();
        for (const item of pending) {
          item.turn.state = item.to;
          item.turn.updatedAt = now;
          if (item.to === 'interrupted') {
            item.turn.completedAt = now;
            const assistant = requireTurnAssistant(conversation, item.turn);
            const interruption = '上次任务因插件重启而中断';
            assistant.role = 'error';
            if (!assistant.content.includes(interruption)) {
              assistant.content = assistant.content.trim()
                ? `${assistant.content.trimEnd()}\n\n${interruption}`
                : interruption;
            }
          }
        }
        conversation.updatedAt = now;
        allocateRevision(file, conversation);
        for (const item of pending) {
          transitions.push({
            conversationId: conversation.id,
            turnId: item.turn.id,
            from: item.from,
            to: item.to,
            revision: conversation.revision,
          });
        }
        changedConversations.push(cloneConversation(conversation));
      }
      return {
        changed: transitions.length > 0,
        value: {
          applied: transitions.length > 0,
          transitions,
          conversations: changedConversations,
        },
      };
    });
  }

  async listCommands(): Promise<SlashCommand[]> {
    return this.readJsonFile<SlashCommand[]>(COMMANDS_PATH, []);
  }

  async saveCommands(commands: SlashCommand[]): Promise<void> {
    await this.assertMutationAllowed();
    await this.writeJsonFile(COMMANDS_PATH, commands);
  }

  async readMentionCache(): Promise<Record<string, unknown>> {
    return this.readJsonFile<Record<string, unknown>>(MENTION_CACHE_PATH, {});
  }

  async writeMentionCache(cache: Record<string, unknown>): Promise<void> {
    await this.assertMutationAllowed();
    await this.writeJsonFile(MENTION_CACHE_PATH, cache);
  }

  async importGeneratedImage(
    conversationId: string,
    artifact: { itemId: string; sourcePath: string; mimeType?: string; revisedPrompt?: string },
    budget: GeneratedImageImportBudget,
  ): Promise<GeneratedImageImportResult> {
    const maxBytes = generatedImageBudgetLimit(budget);
    throwIfArtifactAborted(budget.signal);
    if (!path.isAbsolute(artifact.sourcePath)) {
      throw new Error('Codex returned a non-absolute image path.');
    }
    await this.assertMutationAllowed();
    const bytes = await readBoundedGeneratedImage(artifact.sourcePath, maxBytes, budget.signal);
    const detected = detectImageFormat(bytes);
    if (!detected) throw new Error('Codex returned an unsupported image format.');
    if (artifact.mimeType && artifact.mimeType !== detected.mimeType) {
      throw new Error('Codex image MIME type does not match its file contents.');
    }

    throwIfArtifactAborted(budget.signal);
    const safeConversationId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'conversation';
    const directory = `${GENERATED_IMAGES_PATH}/${safeConversationId}`;
    await this.ensureDirectory(directory);
    const filename = `${Date.now()}-${createId('image')}${detected.extension}`;
    const vaultPath = `${directory}/${filename}`;
    const arrayBuffer = Uint8Array.from(bytes).buffer;
    throwIfArtifactAborted(budget.signal);
    await this.assertMutationAllowed(true);
    throwIfArtifactAborted(budget.signal);
    await this.adapter.writeBinary(vaultPath, arrayBuffer);
    await this.hardenCanonicalPath(vaultPath, false);
    return {
      artifact: {
        id: artifact.itemId || createId('artifact'),
        type: 'image',
        vaultPath,
        mimeType: detected.mimeType,
        createdAt: Date.now(),
        revisedPrompt: artifact.revisedPrompt,
      },
      byteLength: bytes.byteLength,
    };
  }

  getResourcePath(vaultPath: string): string {
    return this.adapter.getResourcePath(vaultPath);
  }

  private async waitForMigration(): Promise<void> {
    const gate = this.migrationGate;
    if (gate) await gate;
  }

  private async requireV2Backend(): Promise<void> {
    await this.waitForMigration();
    if (!(await this.conversationRepositoryV2.isActive())) {
      throw new ConversationStoreMigrationError(
        'Conversation repository v2 has not been initialized; call ensureV2Store() first.',
      );
    }
  }

  private async readV1MigrationSource(): Promise<V1MigrationSource> {
    if (!(await this.adapter.exists(CONVERSATIONS_PATH))) {
      return { raw: null, revision: 0, nextQueueSequence: 1, conversations: [] };
    }
    let raw: string;
    try {
      raw = await this.adapter.read(CONVERSATIONS_PATH);
    } catch (error) {
      throw new ConversationStoreCorruptError(
        `The existing conversation store could not be read: ${errorMessage(error)}`,
      );
    }
    const file = parseConversationFile(raw);
    return {
      raw,
      revision: file.revision,
      nextQueueSequence: file.nextQueueSequence,
      conversations: file.conversations.map(cloneConversation),
    };
  }

  private async readConversationsFile(): Promise<ConversationFile> {
    if (!(await this.adapter.exists(CONVERSATIONS_PATH))) {
      return { version: 1, revision: 0, nextQueueSequence: 1, conversations: [] };
    }
    let raw: string;
    try {
      raw = await this.adapter.read(CONVERSATIONS_PATH);
    } catch (error) {
      throw new ConversationStoreCorruptError(
        `The existing conversation store could not be read: ${errorMessage(error)}`,
      );
    }
    return parseConversationFile(raw);
  }

  private async writeConversationsFile(file: ConversationFile, expectedRevision: number): Promise<void> {
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    // Validate exactly what will be written before touching either file.
    parseConversationFile(serialized);
    await this.ensureDirectory(STORAGE_IDS.vaultDirectoryName);
    await this.assertMutationAllowed();
    try {
      if (this.leaseEnforced) {
        // Production passes the already validated in-memory bytes directly to
        // the process helper. Never expose a stable adapter .tmp/.stage before
        // the fenced physical CAS.
        await this.assertMutationAllowed(true);
        const expectedRaw = await this.lease.readTextFile(CONVERSATIONS_PATH);
        const actualRevision = expectedRaw === null
          ? 0
          : parseConversationFile(expectedRaw).revision;
        if (actualRevision !== expectedRevision) {
          throw new ConversationStoreAtomicWriteError(
            `Conversation store revision CAS failed: expected ${expectedRevision}, found ${actualRevision}.`,
          );
        }
        const swapped = await this.lease.compareAndSwapTextFile(
          CONVERSATIONS_PATH,
          expectedRaw,
          serialized,
        );
        if (!swapped) {
          throw new ConversationStoreAtomicWriteError(
            `Conversation store revision CAS failed: expected ${expectedRevision}; the file changed before commit.`,
          );
        }
        return;
      }

      const safeInstanceId = this.lease.instanceId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const stagingPath = `${CONVERSATIONS_PATH}.${safeInstanceId}.${createId('cas')}.tmp`;
      // Keep each uniquely named sidecar as recovery evidence. This fallback
      // deliberately never calls a destructive adapter API.
      await this.adapter.write(stagingPath, serialized);
      await this.hardenFallbackTempFile(stagingPath);
      const staged = await this.adapter.read(stagingPath);
      if (staged !== serialized) {
        throw new ConversationStoreAtomicWriteError('Conversation temp-file verification failed.');
      }
      parseConversationFile(staged);
      await this.compareAndSwapConversationFile(staged, expectedRevision, stagingPath);
    } catch (error) {
      if (error instanceof ConversationStoreAtomicWriteError
        || error instanceof ConversationStoreCorruptError
        || error instanceof ConversationStoreReadOnlyError
        || error instanceof ChatStoreLeaseCorruptError) {
        throw error;
      }
      throw new ConversationStoreAtomicWriteError(
        `Conversation store atomic write failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private enqueueConversationMutation<T>(
    mutate: (file: ConversationFile) => Promise<{ changed: boolean; value: T }>,
  ): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      await this.assertMutationAllowed();
      const file = await this.readConversationsFile();
      const expectedRevision = file.revision;
      const result = await mutate(file);
      if (result.changed) await this.writeConversationsFile(file, expectedRevision);
      return result.value;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async compareAndSwapConversationFile(
    staged: string,
    expectedRevision: number,
    stagingPath: string,
  ): Promise<void> {
    if (!(await this.adapter.exists(CONVERSATIONS_PATH))) {
      if (expectedRevision !== 0) {
        throw new ConversationStoreAtomicWriteError(
          `Conversation store disappeared before CAS at revision ${expectedRevision}.`,
        );
      }
      if (typeof this.adapter.copy !== 'function') {
        if (this.leaseEnforced) {
          throw new ConversationStoreAtomicWriteError('The vault adapter does not support exclusive create.');
        }
        await this.adapter.write(CONVERSATIONS_PATH, staged);
        return;
      }
      try {
        await this.adapter.copy(stagingPath, CONVERSATIONS_PATH);
        return;
      } catch (error) {
        if (!(await this.adapter.exists(CONVERSATIONS_PATH))) throw error;
      }
    }
    if (typeof this.adapter.process !== 'function') {
      // Compatibility for deliberately narrow legacy test adapters only.
      // Production DataAdapter exposes process(), which is required for CAS.
      if (this.leaseEnforced) {
        throw new ConversationStoreAtomicWriteError('The vault adapter does not support revision CAS.');
      }
      await this.adapter.rename(stagingPath, CONVERSATIONS_PATH);
      return;
    }
    let actualRevision = -1;
    try {
      await this.adapter.process(CONVERSATIONS_PATH, currentRaw => {
        const current = parseConversationFile(currentRaw);
        actualRevision = current.revision;
        if (actualRevision !== expectedRevision) throw new ConversationCasMismatchError();
        return staged;
      });
    } catch (error) {
      if (error instanceof ConversationCasMismatchError) {
        throw new ConversationStoreAtomicWriteError(
          `Conversation store revision CAS failed: expected ${expectedRevision}, found ${actualRevision}.`,
        );
      }
      throw error;
    }
  }

  private async hardenFallbackTempFile(vaultRelativePath: string): Promise<void> {
    if (!this.vaultBasePath || process.platform === 'win32') return;
    const canonicalRoot = path.resolve(this.vaultBasePath, STORAGE_IDS.vaultDirectoryName);
    const target = path.resolve(this.vaultBasePath, vaultRelativePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new ConversationStoreAtomicWriteError('Conversation temp path escaped Ailu storage.');
    }
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ConversationStoreAtomicWriteError('Conversation temp path has an unsafe type.');
    }
    await fs.chmod(target, 0o600);
  }

  private async assertMutationAllowed(refreshLease = false): Promise<void> {
    if (!this.leaseEnforced) return;
    try {
      if (refreshLease) {
        const status = await this.lease.renew();
        if (status.mode !== 'writer') throw new ChatStoreLeaseLostError();
      } else {
        await this.lease.assertOwned();
      }
    } catch (error) {
      this.notifyWriteLeaseLost(asError(error));
      if (error instanceof ChatStoreLeaseCorruptError) throw error;
      let status: ChatStoreLeaseStatus;
      try {
        status = await this.lease.inspect();
      } catch (inspectError) {
        if (inspectError instanceof ChatStoreLeaseCorruptError) {
          this.notifyWriteLeaseLost(inspectError);
          throw inspectError;
        }
        throw error;
      }
      throw new ConversationStoreReadOnlyError(status);
    }
  }

  private notifyWriteLeaseLost(error: Error): void {
    if (this.writeLeaseLossNotified) return;
    this.writeLeaseLossNotified = true;
    try {
      this.onWriteLeaseLost?.(error);
    } catch (callbackError) {
      console.error('Ailu write-lease loss callback failed.', callbackError);
    }
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      if (!(await this.adapter.exists(filePath))) {
        return fallback;
      }
      return JSON.parse(await this.adapter.read(filePath)) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    await this.ensureDirectory(STORAGE_IDS.vaultDirectoryName);
    await this.assertMutationAllowed(true);
    await this.adapter.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
    await this.hardenCanonicalPath(filePath, false);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    const parts = directory.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch (error) {
          if (!(await this.adapter.exists(current))) throw error;
        }
      }
      await this.hardenCanonicalPath(current, true);
    }
  }

  private async hardenCanonicalPath(vaultRelativePath: string, directory: boolean): Promise<void> {
    const root = this.vaultBasePath;
    if (!root) return;
    const canonicalRoot = path.join(root, STORAGE_IDS.vaultDirectoryName);
    const target = path.resolve(root, vaultRelativePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error('Canonical Ailu storage path escaped its physical root.');
    }
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error('Canonical Ailu storage path has an unsafe physical type.');
    }
    await fs.chmod(target, directory ? 0o700 : 0o600);
  }
}

function parseConversationFile(raw: string): ConversationFile {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConversationStoreCorruptError(
      `The existing conversation store is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(value)) {
    throw new ConversationStoreCorruptError('The existing conversation store must be a JSON object.');
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new ConversationStoreCorruptError('The existing conversation store has an unsupported version.');
  }
  if (!Array.isArray(value.conversations)) {
    throw new ConversationStoreCorruptError('The existing conversation store has no conversations array.');
  }

  const conversations = value.conversations.map((item, index) => (
    normalizeConversation(item, `conversation ${index + 1}`)
  ));
  assertUnique(conversations.map(item => item.id), 'conversation id');
  const queueSequences = conversations.flatMap(conversation => (
    conversation.turns.map(turn => turn.queueSequence)
  ));
  assertUnique(queueSequences, 'turn queue sequence');
  const maxRevision = conversations.reduce((max, item) => Math.max(max, item.revision), 0);
  const revision = value.revision === undefined
    ? maxRevision
    : requireNonNegativeInteger(value.revision, 'repository revision');
  if (revision < maxRevision) {
    throw new ConversationStoreCorruptError('Repository revision is older than a conversation revision.');
  }
  const maxQueueSequence = queueSequences.reduce((max, item) => Math.max(max, item), 0);
  const nextQueueSequence = value.nextQueueSequence === undefined
    ? maxQueueSequence + 1
    : requirePositiveInteger(value.nextQueueSequence, 'next queue sequence');
  if (nextQueueSequence <= maxQueueSequence) {
    throw new ConversationStoreCorruptError('Next queue sequence is not ahead of persisted turns.');
  }
  return { version: 1, revision, nextQueueSequence, conversations };
}

function normalizeConversation(value: unknown, source: string): VersionedStoredConversation {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  const id = requireNonEmptyString(value.id, `${source} id`);
  if (typeof value.title !== 'string') throw corrupt(`${source} title must be a string.`);
  const title = value.title;
  const agentId = requireAgentId(value.agentId, `${source} agentId`);
  const createdAt = requireTimestamp(value.createdAt, `${source} createdAt`);
  const updatedAt = requireTimestamp(value.updatedAt, `${source} updatedAt`);
  if (!Array.isArray(value.messages)) throw corrupt(`${source} messages must be an array.`);
  const messages = value.messages.map((item, index) => normalizeMessage(item, `${source} message ${index + 1}`));
  assertUnique(messages.map(item => item.id), `${source} message id`);

  const sessionIds = normalizeAgentStringMap(value.sessionIds, `${source} sessionIds`);
  const sessionConfigKeys = normalizeAgentStringMap(value.sessionConfigKeys, `${source} sessionConfigKeys`);
  const sessionOwnerships = normalizeSessionOwnershipMap(
    value.sessionOwnerships,
    id,
    sessionIds,
    `${source} sessionOwnerships`,
  );
  const revision = value.revision === undefined
    ? 0
    : requireNonNegativeInteger(value.revision, `${source} revision`);
  const rawTurns = value.turns === undefined ? [] : value.turns;
  if (!Array.isArray(rawTurns)) throw corrupt(`${source} turns must be an array.`);
  const messageIds = new Set(messages.map(item => item.id));
  const turns = rawTurns.map((item, index) => normalizeTurn(item, `${source} turn ${index + 1}`));
  assertUnique(turns.map(item => item.id), `${source} turn id`);
  for (const turn of turns) {
    if (!messageIds.has(turn.userMessageId) || !messageIds.has(turn.assistantMessageId)) {
      throw corrupt(`${source} turn ${turn.id} references a missing message.`);
    }
  }
  const activeCount = turns.filter(turn => turn.state === 'active' || turn.state === 'cancelRequested').length;
  if (activeCount > 1) throw corrupt(`${source} has more than one active turn.`);
  const contextCheckpoint = value.contextCheckpoint === undefined
    ? undefined
    : normalizeContextCheckpoint(value.contextCheckpoint, `${source} contextCheckpoint`);
  if (contextCheckpoint) {
    validateContextCheckpointBinding(contextCheckpoint, messages, turns, revision, source);
  }

  return {
    ...(value as Partial<StoredConversation>),
    id,
    title,
    agentId,
    createdAt,
    updatedAt,
    messages,
    ...(sessionIds === undefined ? {} : { sessionIds }),
    ...(sessionConfigKeys === undefined ? {} : { sessionConfigKeys }),
    ...(sessionOwnerships === undefined ? {} : { sessionOwnerships }),
    ...(contextCheckpoint === undefined ? {} : { contextCheckpoint }),
    revision,
    turns,
  };
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
  if (!isRecord(value.summary)) throw corrupt(`${source} summary must be an object.`);
  const summary = value.summary;
  assertExactKeys(summary, [
    'facts',
    'decisions',
    'userPreferences',
    'constraints',
    'openLoops',
    'filesMentioned',
    'lastIntent',
  ], `${source} summary`);
  const normalizedSummary = {
    facts: normalizeBoundedStringArray(summary.facts, `${source} summary facts`),
    decisions: normalizeBoundedStringArray(summary.decisions, `${source} summary decisions`),
    userPreferences: normalizeBoundedStringArray(
      summary.userPreferences,
      `${source} summary userPreferences`,
    ),
    constraints: normalizeBoundedStringArray(summary.constraints, `${source} summary constraints`),
    openLoops: normalizeBoundedStringArray(summary.openLoops, `${source} summary openLoops`),
    filesMentioned: normalizeBoundedStringArray(
      summary.filesMentioned,
      `${source} summary filesMentioned`,
    ),
    lastIntent: requireBoundedString(summary.lastIntent, `${source} summary lastIntent`, 16_384),
  };
  const createdBy = value.createdBy === 'local'
    ? 'local'
    : requireAgentId(value.createdBy, `${source} createdBy`);
  const checkpoint: ConversationContextCheckpoint = {
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
    prefixSha256: requireSha256(value.prefixSha256, `${source} prefixSha256`),
    projectionVersion: requireLiteralOne(value.projectionVersion, `${source} projectionVersion`),
    summary: normalizedSummary,
    createdBy,
  };
  if (value.previousCheckpointId !== undefined) {
    checkpoint.previousCheckpointId = requireBoundedNonEmptyString(
      value.previousCheckpointId,
      `${source} previousCheckpointId`,
      512,
    );
  }
  return checkpoint;
}

function validateContextCheckpointBinding(
  checkpoint: ConversationContextCheckpoint,
  messages: readonly ChatMessage[],
  turns: readonly StoredConversationTurn[],
  conversationRevision: number,
  source: string,
): void {
  if (checkpoint.sourceRevision >= conversationRevision) {
    throw corrupt(`${source} contextCheckpoint sourceRevision is not older than its commit.`);
  }
  if (checkpoint.throughMessageSequence > messages.length) {
    throw corrupt(`${source} contextCheckpoint exceeds the canonical transcript.`);
  }
  const boundary = messages[checkpoint.throughMessageSequence - 1];
  if (boundary.id !== checkpoint.throughMessageId) {
    throw corrupt(`${source} contextCheckpoint message boundary is invalid.`);
  }
  if (boundary.role !== 'assistant') {
    throw corrupt(`${source} contextCheckpoint must end at an assistant message.`);
  }
  if (turns.length > 0) {
    const boundaryTurn = turns.find(turn => turn.assistantMessageId === boundary.id);
    if (!boundaryTurn || boundaryTurn.state !== 'completed') {
      throw corrupt(`${source} contextCheckpoint must end at a completed turn.`);
    }
  }
  const prefixSha256 = hashConversationMessagePrefix(
    messages,
    checkpoint.throughMessageSequence,
  );
  if (checkpoint.prefixSha256 !== prefixSha256) {
    throw corrupt(`${source} contextCheckpoint transcript hash does not match.`);
  }
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw corrupt(`${source} must be a finite non-negative number.`);
  }
  return value;
}

function requireSha256(value: unknown, source: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw corrupt(`${source} is invalid.`);
  }
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

function hashConversationMessagePrefix(
  messages: readonly ChatMessage[],
  throughMessageSequence: number,
): string {
  const prefix = messages.slice(0, throughMessageSequence).map((message, index) => ({
    sequence: index + 1,
    message,
  }));
  return createHash('sha256').update(canonicalJson(prefix)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function normalizeMessage(value: unknown, source: string): ChatMessage {
  if (!isRecord(value)) throw corrupt(`${source} must be an object.`);
  const role = requireMessageRole(value.role, `${source} role`);
  const metadata = value.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw corrupt(`${source} metadata must be an object.`);
  }
  return {
    ...(value as Partial<ChatMessage>),
    id: requireNonEmptyString(value.id, `${source} id`),
    role,
    content: requireString(value.content, `${source} content`),
    createdAt: requireTimestamp(value.createdAt, `${source} createdAt`),
    ...(value.agentId === undefined ? {} : { agentId: requireAgentId(value.agentId, `${source} agentId`) }),
    ...(metadata === undefined ? {} : { metadata: cloneJson(metadata) }),
  };
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
  if (value.runtime !== undefined) {
    turn.runtime = normalizeRuntimeSnapshot(value.runtime, `${source} runtime`);
  }
  return turn;
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
    normalizeAtomicContextCheckpointDraft(input.contextCheckpointDraft);
  }
}

function normalizeAtomicContextCheckpointDraft(
  value: unknown,
): ConversationContextCheckpointDraft {
  if (!isRecord(value)) throw corrupt('beginTurn contextCheckpointDraft must be an object.');
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
  ], 'beginTurn contextCheckpointDraft');
  const draft = { ...normalizeContextCheckpoint({
    ...value,
    prefixSha256: '0'.repeat(64),
  }, 'beginTurn contextCheckpointDraft') };
  Reflect.deleteProperty(draft, 'prefixSha256');
  return draft;
}

function materializeAtomicContextCheckpoint(
  conversation: VersionedStoredConversation,
  value: ConversationContextCheckpointDraft,
): ConversationContextCheckpoint {
  const draft = normalizeAtomicContextCheckpointDraft(value);
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
  const draft = normalizeAtomicContextCheckpointDraft(value);
  const sequence = draft.throughMessageSequence;
  if (sequence > conversation.messages.length) {
    throw new ConversationTurnStateError(
      `Context checkpoint sequence ${sequence} exceeds ${conversation.messages.length} messages.`,
    );
  }
  const boundary = conversation.messages[sequence - 1];
  if (boundary?.id !== draft.throughMessageId || boundary.role !== 'assistant') {
    throw new ConversationTurnStateError('A context checkpoint has an invalid assistant boundary.');
  }
  if (conversation.turns.length > 0) {
    const boundaryTurn = conversation.turns.find(turn => turn.assistantMessageId === boundary.id);
    if (!boundaryTurn || boundaryTurn.state !== 'completed') {
      throw new ConversationTurnStateError(
        'A context checkpoint must end at the assistant message of a completed turn.',
      );
    }
  }
  return normalizeContextCheckpoint({
    ...draft,
    prefixSha256: hashConversationMessagePrefix(conversation.messages, sequence),
  }, 'beginTurn context checkpoint');
}

function assertBeginTurnReplay(
  conversation: VersionedStoredConversation,
  turn: StoredConversationTurn,
  input: BeginTurnInput,
): void {
  const user = conversation.messages.find(item => item.id === turn.userMessageId);
  const assistant = conversation.messages.find(item => item.id === turn.assistantMessageId);
  if (turn.agentId !== input.agentId
    || turn.userMessageId !== input.userMessage.id
    || turn.assistantMessageId !== input.assistantMessage.id
    || !user
    || !assistant
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

function requireConversation(file: ConversationFile, conversationId: string): VersionedStoredConversation {
  const conversation = file.conversations.find(item => item.id === conversationId);
  if (!conversation) throw new ConversationTurnStateError(`Conversation ${conversationId} was not found.`);
  return conversation;
}

function requireTurn(
  conversation: VersionedStoredConversation,
  turnId: string,
): StoredConversationTurn {
  const turn = conversation.turns.find(item => item.id === turnId);
  if (!turn) throw new ConversationTurnStateError(`Turn ${turnId} was not found.`);
  return turn;
}

function requireConversationTurn(
  file: ConversationFile,
  input: ConversationMutationInput,
): { conversation: VersionedStoredConversation; turn: StoredConversationTurn } {
  const conversation = requireConversation(file, input.conversationId);
  return { conversation, turn: requireTurn(conversation, input.turnId) };
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
  const next = cloneMessage(message);
  if (patch.role !== undefined) next.role = requireMessageRole(patch.role, 'message patch role');
  if (patch.content !== undefined) next.content = requireString(patch.content, 'message patch content');
  if (patch.agentId !== undefined) next.agentId = requireAgentId(patch.agentId, 'message patch agentId');
  if (patch.metadata === null) delete next.metadata;
  else if (patch.metadata !== undefined) {
    if (!isRecord(patch.metadata)) throw new ConversationTurnStateError('Message patch metadata must be an object.');
    next.metadata = { ...(next.metadata ?? {}), ...cloneJson(patch.metadata) };
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
    throw new ConversationRevisionConflictError(conversation.id, expectedRevision, conversation.revision);
  }
}

function assertNoOtherActiveTurn(
  conversation: VersionedStoredConversation,
  exceptTurnId?: string,
): void {
  const active = conversation.turns.find(turn => turn.id !== exceptTurnId
    && (turn.state === 'active' || turn.state === 'cancelRequested'));
  if (active) {
    throw new ConversationTurnStateError(`Conversation ${conversation.id} already has active turn ${active.id}.`);
  }
}

function assertSessionIdAvailable(
  file: ConversationFile,
  conversationId: string,
  agentId: AgentId,
  sessionId: string,
): void {
  const owner = findSessionOwner(file, sessionId);
  if (!owner || (owner.conversationId === conversationId && owner.agentId === agentId)) return;
  throw new ConversationSessionConflictError(owner);
}

function findSessionOwner(file: ConversationFile, sessionId: string): ConversationSessionOwner | null {
  for (const conversation of file.conversations) {
    for (const [rawAgentId, storedSessionId] of Object.entries(conversation.sessionIds ?? {})) {
      if (storedSessionId !== sessionId) continue;
      const agentId = requireAgentId(rawAgentId, 'session owner agent');
      return conversation.sessionOwnerships?.[agentId] ?? {
        sessionId,
        conversationId: conversation.id,
        agentId,
        runId: conversation.turns
          .filter(turn => turn.agentId === agentId)
          .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.id ?? 'legacy',
        claimedAt: conversation.updatedAt,
      };
    }
  }
  return null;
}

function isTerminalTurnState(state: ConversationTurnState): boolean {
  return state === 'completed'
    || state === 'cancelled'
    || state === 'failed'
    || state === 'interrupted';
}

function takeQueueSequence(file: ConversationFile): number {
  const value = file.nextQueueSequence;
  file.nextQueueSequence += 1;
  return value;
}

function allocateRevision(file: ConversationFile, conversation: VersionedStoredConversation): number {
  file.revision += 1;
  conversation.revision = file.revision;
  return file.revision;
}

function turnResult(
  applied: boolean,
  conversation: VersionedStoredConversation,
  turn: StoredConversationTurn,
): TurnMutationResult {
  return {
    applied,
    revision: conversation.revision,
    turn: cloneTurn(turn),
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
    message: cloneMessage(message),
    turn: turn ? cloneTurn(turn) : null,
  };
}

function sessionResult(applied: boolean, conversation: VersionedStoredConversation): SessionMutationResult {
  return {
    applied,
    revision: conversation.revision,
  };
}

function cloneConversation(conversation: VersionedStoredConversation): VersionedStoredConversation {
  return cloneJson(conversation);
}

function cloneTurn(turn: StoredConversationTurn): StoredConversationTurn {
  return cloneJson(turn);
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return cloneJson(message);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function titleFromMessage(message: ChatMessage, fallback = DEFAULT_CONVERSATION_TITLE): string {
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
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

function normalizeSessionOwnershipMap(
  value: unknown,
  conversationId: string,
  sessionIds: Partial<Record<AgentId, string>> | undefined,
  source: string,
): Partial<Record<AgentId, ConversationSessionOwner>> | undefined {
  if (value === undefined) return undefined;
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
      || sessionIds?.[agentId] !== owner.sessionId) {
      throw corrupt(`${source}.${agentId} does not match persisted sessionIds.`);
    }
    result[agentId] = owner;
  }
  for (const agentId of Object.keys(sessionIds ?? {}) as AgentId[]) {
    if (!result[agentId]) throw corrupt(`${source} is missing owner metadata for ${agentId}.`);
  }
  return result;
}

function requireTurnState(value: unknown, source: string): ConversationTurnState {
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
  if (value === 'claude' || value === 'codex' || value === 'pi') return value;
  throw corrupt(`${source} is invalid.`);
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
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw corrupt(`${source} must be a non-negative integer.`);
}

function requirePositiveInteger(value: unknown, source: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw corrupt(`${source} must be a positive integer.`);
}

function assertUnique(values: Array<string | number>, source: string): void {
  if (new Set(values).size !== values.length) throw corrupt(`Duplicate ${source}.`);
}

function corrupt(message: string): ConversationStoreCorruptError {
  return new ConversationStoreCorruptError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generatedImageBudgetLimit(budget: GeneratedImageImportBudget): number {
  if (
    !Number.isSafeInteger(budget.maxItemBytes)
    || budget.maxItemBytes <= 0
    || budget.maxItemBytes > MAX_GENERATED_IMAGE_BYTES
  ) {
    throw new Error('Codex image item budget is invalid.');
  }
  if (!Number.isSafeInteger(budget.remainingTurnBytes) || budget.remainingTurnBytes <= 0) {
    throw new Error('Codex image turn budget is exhausted or invalid.');
  }
  return Math.min(budget.maxItemBytes, budget.remainingTurnBytes);
}

function throwIfArtifactAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error('Codex image materialization was cancelled.');
}

/**
 * Pins the Runtime-provided file with O_NOFOLLOW, bounds every read buffer by
 * the coordinator's remaining authority, and rejects mutation during the read.
 */
async function readBoundedGeneratedImage(
  sourcePath: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(sourcePath, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('Codex image path does not point to a regular file.');
    if (opened.size <= 0 || opened.size > maxBytes) {
      throw new Error('Codex image size is invalid or exceeds the remaining artifact budget.');
    }
    throwIfArtifactAborted(signal);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      throwIfArtifactAborted(signal);
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead <= 0) throw new Error('Codex image changed while it was being read.');
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      trailing,
      0,
      trailing.byteLength,
      bytes.byteLength,
    );
    const current = await handle.stat();
    if (
      trailingBytes !== 0
      || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs
      || current.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error('Codex image changed while it was being read.');
    }
    throwIfArtifactAborted(signal);
    return bytes;
  } finally {
    await handle.close();
  }
}

function detectImageFormat(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return { mimeType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return { mimeType: 'image/webp', extension: '.webp' };
  return null;
}
