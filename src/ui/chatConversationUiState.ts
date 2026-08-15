export const CHAT_INACTIVE_UI_CACHE_SIZE = 8;
export const CHAT_BOTTOM_FOLLOW_THRESHOLD = 48;

export interface ChatViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Stable reading position. `null` explicitly clears a previously saved anchor. */
  anchor?: ChatViewportAnchor | null;
}

export interface ChatViewportAnchor {
  messageId: string;
  viewportOffset: number;
}

export interface ChatConversationUiState {
  conversationId: string;
  draft: string;
  scrollTop: number;
  followBottom: boolean;
  anchorMessageId: string | null;
  anchorViewportOffset: number;
  revision: number;
  persistedRevision: number;
}

interface InternalChatConversationUiState extends ChatConversationUiState {
  touchedAt: number;
}

export interface ChatConversationUiStateCacheOptions {
  inactiveCapacity?: number;
  isConversationRunning?: (conversationId: string) => boolean;
}

export function isChatViewportNearBottom(
  viewport: ChatViewport,
  threshold = CHAT_BOTTOM_FOLLOW_THRESHOLD,
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

/**
 * Holds only transient UI state. Durable conversations remain owned by VaultStore.
 * Dirty entries are never evicted until the caller acknowledges their persistence.
 */
export class ChatConversationUiStateCache {
  private readonly entries = new Map<string, InternalChatConversationUiState>();
  private readonly inactiveCapacity: number;
  private readonly isConversationRunning: (conversationId: string) => boolean;
  private selectedConversationId: string | null = null;
  private clock = 0;

  constructor(options: ChatConversationUiStateCacheOptions = {}) {
    this.inactiveCapacity = Math.max(0, Math.floor(
      options.inactiveCapacity ?? CHAT_INACTIVE_UI_CACHE_SIZE,
    ));
    this.isConversationRunning = options.isConversationRunning ?? (() => false);
  }

  selectConversation(conversationId: string | null): ChatConversationUiState | null {
    this.selectedConversationId = conversationId;
    if (!conversationId) {
      this.prune();
      return null;
    }
    const entry = this.ensure(conversationId);
    this.touch(entry);
    this.prune();
    return cloneState(entry);
  }

  snapshot(conversationId: string): ChatConversationUiState {
    const entry = this.ensure(conversationId);
    this.touch(entry);
    return cloneState(entry);
  }

  updateDraft(conversationId: string, draft: string): ChatConversationUiState {
    const entry = this.ensure(conversationId);
    if (entry.draft !== draft) {
      entry.draft = draft;
      entry.revision += 1;
    }
    this.touch(entry);
    this.prune();
    return cloneState(entry);
  }

  updateViewport(conversationId: string, viewport: ChatViewport): ChatConversationUiState {
    const entry = this.ensure(conversationId);
    const scrollTop = Math.max(0, viewport.scrollTop);
    const followBottom = isChatViewportNearBottom(viewport);
    const anchor = viewport.anchor === undefined
      ? {
        messageId: entry.anchorMessageId,
        viewportOffset: entry.anchorViewportOffset,
      }
      : normalizeViewportAnchor(viewport.anchor);
    if (entry.scrollTop !== scrollTop
      || entry.followBottom !== followBottom
      || entry.anchorMessageId !== anchor.messageId
      || entry.anchorViewportOffset !== anchor.viewportOffset) {
      entry.scrollTop = scrollTop;
      entry.followBottom = followBottom;
      entry.anchorMessageId = anchor.messageId;
      entry.anchorViewportOffset = anchor.viewportOffset;
      entry.revision += 1;
    }
    this.touch(entry);
    this.prune();
    return cloneState(entry);
  }

  replaceFromPersistence(
    conversationId: string,
    persisted: Pick<ChatConversationUiState, 'draft' | 'scrollTop' | 'followBottom'>
      & Partial<Pick<ChatConversationUiState, 'anchorMessageId' | 'anchorViewportOffset'>>,
  ): ChatConversationUiState {
    const existing = this.entries.get(conversationId);
    if (existing && existing.revision !== existing.persistedRevision) {
      this.touch(existing);
      return cloneState(existing);
    }
    const entry = existing ?? this.ensure(conversationId);
    entry.draft = persisted.draft;
    entry.scrollTop = Math.max(0, persisted.scrollTop);
    entry.followBottom = persisted.followBottom;
    entry.anchorMessageId = persisted.anchorMessageId ?? null;
    entry.anchorViewportOffset = persisted.anchorMessageId
      ? persisted.anchorViewportOffset ?? 0
      : 0;
    entry.revision += 1;
    entry.persistedRevision = entry.revision;
    this.touch(entry);
    this.prune();
    return cloneState(entry);
  }

  acknowledgePersistence(conversationId: string, revision: number): ChatConversationUiState | null {
    const entry = this.entries.get(conversationId);
    if (!entry) return null;
    entry.persistedRevision = Math.max(
      entry.persistedRevision,
      Math.min(entry.revision, revision),
    );
    this.touch(entry);
    this.prune();
    return this.entries.has(conversationId) ? cloneState(entry) : null;
  }

  listCachedConversationIds(): string[] {
    return [...this.entries.values()]
      .sort((left, right) => right.touchedAt - left.touchedAt)
      .map(entry => entry.conversationId);
  }

  listDirtyConversationIds(): string[] {
    return [...this.entries.values()]
      .filter(entry => entry.revision !== entry.persistedRevision)
      .sort((left, right) => right.touchedAt - left.touchedAt)
      .map(entry => entry.conversationId);
  }

  private ensure(conversationId: string): InternalChatConversationUiState {
    const normalized = conversationId.trim();
    if (!normalized) throw new Error('conversationId is required.');
    let entry = this.entries.get(normalized);
    if (!entry) {
      entry = {
        conversationId: normalized,
        draft: '',
        scrollTop: 0,
        followBottom: true,
        anchorMessageId: null,
        anchorViewportOffset: 0,
        revision: 0,
        persistedRevision: 0,
        touchedAt: 0,
      };
      this.entries.set(normalized, entry);
    }
    return entry;
  }

  private touch(entry: InternalChatConversationUiState): void {
    this.clock += 1;
    entry.touchedAt = this.clock;
  }

  private prune(): void {
    const evictable = [...this.entries.values()]
      .filter(entry => (
        entry.conversationId !== this.selectedConversationId
        && !this.isConversationRunning(entry.conversationId)
        && entry.revision === entry.persistedRevision
      ))
      .sort((left, right) => left.touchedAt - right.touchedAt);
    const overflow = Math.max(0, evictable.length - this.inactiveCapacity);
    for (const entry of evictable.slice(0, overflow)) {
      this.entries.delete(entry.conversationId);
    }
  }
}

function cloneState(state: ChatConversationUiState): ChatConversationUiState {
  return {
    conversationId: state.conversationId,
    draft: state.draft,
    scrollTop: state.scrollTop,
    followBottom: state.followBottom,
    anchorMessageId: state.anchorMessageId,
    anchorViewportOffset: state.anchorViewportOffset,
    revision: state.revision,
    persistedRevision: state.persistedRevision,
  };
}

function normalizeViewportAnchor(anchor: ChatViewportAnchor | null): {
  messageId: string | null;
  viewportOffset: number;
} {
  if (!anchor) return { messageId: null, viewportOffset: 0 };
  const messageId = anchor.messageId.trim();
  if (!messageId || !Number.isFinite(anchor.viewportOffset)) {
    return { messageId: null, viewportOffset: 0 };
  }
  return {
    messageId,
    viewportOffset: anchor.viewportOffset,
  };
}
