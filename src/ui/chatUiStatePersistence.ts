import {
  ChatConversationUiStateCache,
  type ChatConversationUiState,
} from './chatConversationUiState';

export const CHAT_UI_STATE_PERSIST_DEBOUNCE_MS = 300;
export const CHAT_UI_STATE_SHUTDOWN_MAX_FLUSH_ROUNDS = 4;
export type ChatUiTimerHandle = number;
export type ChatUiStatePersistenceOperation = 'load' | 'save';

export interface PersistedChatConversationUiState {
  version: 2;
  draft: string;
  scrollTop: number;
  followBottom: boolean;
  anchorMessageId: string | null;
  anchorViewportOffset: number;
}

export interface ChatUiStatePersistenceOptions {
  cache: ChatConversationUiStateCache;
  canWrite: () => boolean;
  loadDraft: (conversationId: string) => Promise<unknown>;
  saveDraft: (conversationId: string, value: PersistedChatConversationUiState) => Promise<void>;
  onError?: (
    conversationId: string,
    error: unknown,
    operation: ChatUiStatePersistenceOperation,
  ) => void;
  /** Lets the plugin clear a previously surfaced warning after a healthy read or write. */
  onSuccess?: (
    conversationId: string,
    operation: ChatUiStatePersistenceOperation,
    caughtUp: boolean,
  ) => void;
  debounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ChatUiTimerHandle;
  clearTimer?: (timer: ChatUiTimerHandle) => void;
}

export class ChatUiStatePersistence {
  private readonly cache: ChatConversationUiStateCache;
  private readonly canWrite: () => boolean;
  private readonly loadDraft: (conversationId: string) => Promise<unknown>;
  private readonly saveDraft: (
    conversationId: string,
    value: PersistedChatConversationUiState,
  ) => Promise<void>;
  private readonly onError: (
    conversationId: string,
    error: unknown,
    operation: ChatUiStatePersistenceOperation,
  ) => void;
  private readonly onSuccess: (
    conversationId: string,
    operation: ChatUiStatePersistenceOperation,
    caughtUp: boolean,
  ) => void;
  private readonly debounceMs: number;
  private readonly setTimer: NonNullable<ChatUiStatePersistenceOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ChatUiStatePersistenceOptions['clearTimer']>;
  private readonly timers = new Map<string, ChatUiTimerHandle>();
  private readonly tails = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: ChatUiStatePersistenceOptions) {
    this.cache = options.cache;
    this.canWrite = options.canWrite;
    this.loadDraft = options.loadDraft;
    this.saveDraft = options.saveDraft;
    this.onError = options.onError ?? (() => {});
    this.onSuccess = options.onSuccess ?? (() => {});
    this.debounceMs = Math.max(0, Math.floor(
      options.debounceMs ?? CHAT_UI_STATE_PERSIST_DEBOUNCE_MS,
    ));
    // The view injects active-window timers in production; these defaults keep the service testable in Node.
    this.setTimer = options.setTimer ?? ((callback, delayMs) => (
      globalThis.setTimeout(callback, delayMs) as unknown as number
    ));
    this.clearTimer = options.clearTimer ?? (timer => globalThis.clearTimeout(timer));
  }

  async load(conversationId: string): Promise<ChatConversationUiState> {
    try {
      const raw = await this.loadDraft(conversationId);
      if (raw === null || raw === undefined) {
        this.reportSuccess(conversationId, 'load', true);
        return this.cache.snapshot(conversationId);
      }
      const persisted = parsePersistedChatUiState(raw);
      if (!persisted) {
        throw new ChatUiStatePersistenceFormatError(conversationId);
      }
      const state = this.cache.replaceFromPersistence(conversationId, persisted);
      this.reportSuccess(conversationId, 'load', true);
      return state;
    } catch (error) {
      this.reportError(conversationId, error, 'load');
    }
    return this.cache.snapshot(conversationId);
  }

  schedule(conversationId: string): void {
    if (this.closed || !this.canWrite()) return;
    const existing = this.timers.get(conversationId);
    if (existing) this.clearTimer(existing);
    const timer = this.setTimer(() => {
      this.timers.delete(conversationId);
      void this.flush(conversationId);
    }, this.debounceMs);
    this.timers.set(conversationId, timer);
  }

  flush(conversationId: string): Promise<void> {
    const timer = this.timers.get(conversationId);
    if (timer) {
      this.clearTimer(timer);
      this.timers.delete(conversationId);
    }
    const previous = this.tails.get(conversationId) ?? Promise.resolve();
    const task = previous.then(async () => {
      if (!this.canWrite()) return;
      const state = this.cache.snapshot(conversationId);
      if (state.revision === state.persistedRevision) return;
      const persistedRevision = state.revision;
      let saved = false;
      try {
        await this.saveDraft(conversationId, serializePersistedChatUiState(state));
        this.cache.acknowledgePersistence(conversationId, persistedRevision);
        saved = true;
      } catch (error) {
        this.reportError(conversationId, error, 'save');
      }
      const latest = this.cache.snapshot(conversationId);
      if (saved) {
        this.reportSuccess(
          conversationId,
          'save',
          latest.revision === latest.persistedRevision,
        );
      }
      // Retry immediately only when a successful write raced newer local
      // edits. A failed store remains dirty but waits for the next user action
      // or explicit flush, avoiding a tight warning/write loop.
      if (saved && !this.closed && latest.revision !== latest.persistedRevision) {
        this.schedule(conversationId);
      }
    });
    this.tails.set(conversationId, task);
    void task.finally(() => {
      if (this.tails.get(conversationId) === task) this.tails.delete(conversationId);
    });
    return task;
  }

  async flushAll(): Promise<void> {
    const conversationIds = new Set([
      ...this.timers.keys(),
      ...this.tails.keys(),
      ...this.cache.listDirtyConversationIds(),
    ]);
    await Promise.all([...conversationIds].map(conversationId => this.flush(conversationId)));
  }

  async shutdown(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const timer of this.timers.values()) this.clearTimer(timer);
      this.timers.clear();
    }
    for (let round = 0; round < CHAT_UI_STATE_SHUTDOWN_MAX_FLUSH_ROUNDS; round += 1) {
      await this.flushAll();
      await Promise.all(this.tails.values());
      if (this.cache.listDirtyConversationIds().length === 0) return;
    }
    const dirtyConversationIds = this.cache.listDirtyConversationIds();
    if (dirtyConversationIds.length === 0) return;
    const error = new Error(
      `Chat UI state shutdown left ${dirtyConversationIds.length} conversation(s) unsaved after ${CHAT_UI_STATE_SHUTDOWN_MAX_FLUSH_ROUNDS} flush rounds.`,
    );
    error.name = 'ChatUiStateShutdownError';
    for (const conversationId of dirtyConversationIds) this.reportError(conversationId, error, 'save');
    throw error;
  }

  private reportError(
    conversationId: string,
    error: unknown,
    operation: ChatUiStatePersistenceOperation,
  ): void {
    try {
      this.onError(conversationId, error, operation);
    } catch (callbackError) {
      console.error('Ailu chat UI state error callback failed.', callbackError);
    }
  }

  private reportSuccess(
    conversationId: string,
    operation: ChatUiStatePersistenceOperation,
    caughtUp: boolean,
  ): void {
    try {
      this.onSuccess(conversationId, operation, caughtUp);
    } catch (callbackError) {
      console.error('Ailu chat UI state success callback failed.', callbackError);
    }
  }
}

export class ChatUiStatePersistenceFormatError extends Error {
  readonly code = 'CHAT_UI_STATE_MALFORMED';

  constructor(conversationId: string) {
    super(`Conversation ${conversationId} has malformed persisted chat UI state.`);
    this.name = 'ChatUiStatePersistenceFormatError';
  }
}

export function serializePersistedChatUiState(
  state: Pick<
    ChatConversationUiState,
    'draft' | 'scrollTop' | 'followBottom' | 'anchorMessageId' | 'anchorViewportOffset'
  >,
): PersistedChatConversationUiState {
  return {
    version: 2,
    draft: state.draft,
    scrollTop: Math.max(0, state.scrollTop),
    followBottom: state.followBottom,
    anchorMessageId: state.anchorMessageId,
    anchorViewportOffset: state.anchorViewportOffset,
  };
}

export function parsePersistedChatUiState(value: unknown): PersistedChatConversationUiState | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)
    || typeof value.draft !== 'string'
    || typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop)
    || value.scrollTop < 0 || typeof value.followBottom !== 'boolean') {
    return null;
  }
  if (value.version === 1) {
    return {
      version: 2,
      draft: value.draft,
      scrollTop: value.scrollTop,
      followBottom: value.followBottom,
      anchorMessageId: null,
      anchorViewportOffset: 0,
    };
  }
  if ((value.anchorMessageId !== null && (
    typeof value.anchorMessageId !== 'string' || !value.anchorMessageId.trim()
  )) || typeof value.anchorViewportOffset !== 'number'
    || !Number.isFinite(value.anchorViewportOffset)) {
    return null;
  }
  return {
    version: 2,
    draft: value.draft,
    scrollTop: value.scrollTop,
    followBottom: value.followBottom,
    anchorMessageId: value.anchorMessageId,
    anchorViewportOffset: value.anchorMessageId === null ? 0 : value.anchorViewportOffset,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
