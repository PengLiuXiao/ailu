import { vi } from 'vitest';

import { ChatConversationUiStateCache } from '../src/ui/chatConversationUiState';
import {
  ChatUiStatePersistence,
  ChatUiStatePersistenceFormatError,
  parsePersistedChatUiState,
} from '../src/ui/chatUiStatePersistence';

describe('chat UI state persistence', () => {
  test('debounces a draft and acknowledges only the saved local revision', async () => {
    vi.useFakeTimers();
    const cache = new ChatConversationUiStateCache();
    const writes: unknown[] = [];
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => null,
      saveDraft: async (_conversationId, value) => {
        writes.push(value);
      },
    });
    cache.updateDraft('conversation', 'one');
    persistence.schedule('conversation');
    cache.updateDraft('conversation', 'two');
    persistence.schedule('conversation');

    await vi.advanceTimersByTimeAsync(300);
    await persistence.flush('conversation');

    expect(writes).toEqual([{
      version: 2,
      draft: 'two',
      scrollTop: 0,
      followBottom: true,
      anchorMessageId: null,
      anchorViewportOffset: 0,
    }]);
    expect(cache.listDirtyConversationIds()).toEqual([]);
    await persistence.shutdown();
    vi.useRealTimers();
  });

  test('does not let a slow saved revision acknowledge newer local input', async () => {
    const cache = new ChatConversationUiStateCache();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => null,
      saveDraft: async () => blocked,
      debounceMs: 60_000,
    });
    cache.updateDraft('conversation', 'first');
    const saving = persistence.flush('conversation');
    await Promise.resolve();
    cache.updateDraft('conversation', 'newer');
    release();
    await saving;

    expect(cache.snapshot('conversation')).toMatchObject({
      draft: 'newer',
      revision: 2,
      persistedRevision: 1,
    });
    await persistence.shutdown();
  });

  test('keeps dirty data in memory when the durable write fails', async () => {
    vi.useFakeTimers();
    const cache = new ChatConversationUiStateCache();
    const errors: Array<{ error: unknown; operation: string }> = [];
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => null,
      saveDraft: async () => {
        throw new Error('disk full');
      },
      onError: (_conversationId, error, operation) => errors.push({ error, operation }),
      debounceMs: 300,
    });
    cache.updateDraft('conversation', 'unsaved');
    await persistence.flush('conversation');

    expect(cache.listDirtyConversationIds()).toEqual(['conversation']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toBe('save');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(errors).toHaveLength(1);
    await expect(persistence.shutdown()).rejects.toThrow('unsaved');
    vi.useRealTimers();
  });

  test('shutdown persists a newer edit that arrives while an earlier save is held', async () => {
    const cache = new ChatConversationUiStateCache();
    const writes: string[] = [];
    const successes: string[] = [];
    let releaseFirst!: () => void;
    const firstHold = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let saveCount = 0;
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => null,
      saveDraft: async (_conversationId, value) => {
        writes.push(value.draft);
        saveCount += 1;
        if (saveCount === 1) await firstHold;
      },
      onSuccess: (_conversationId, operation, caughtUp) => {
        successes.push(`${operation}:${caughtUp}`);
      },
      debounceMs: 60_000,
    });
    cache.updateDraft('conversation', 'first');
    const firstSave = persistence.flush('conversation');
    await Promise.resolve();
    cache.updateDraft('conversation', 'newest');

    const shutdown = persistence.shutdown();
    releaseFirst();
    await Promise.all([firstSave, shutdown]);

    expect(writes).toEqual(['first', 'newest']);
    expect(successes).toEqual(['save:false', 'save:true']);
    expect(cache.listDirtyConversationIds()).toEqual([]);
  });

  test('loads a valid persisted value without overwriting a newer local draft', async () => {
    const cache = new ChatConversationUiStateCache();
    cache.updateDraft('conversation', 'new local value');
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => ({
        version: 1,
        draft: 'old disk value',
        scrollTop: 80,
        followBottom: false,
      }),
      saveDraft: async () => {},
    });

    const loaded = await persistence.load('conversation');
    expect(loaded.draft).toBe('new local value');
  });

  test('rejects malformed persisted values', () => {
    expect(parsePersistedChatUiState({ version: 1, draft: 'x', scrollTop: -1, followBottom: true }))
      .toBeNull();
    expect(parsePersistedChatUiState({ version: 1, draft: 'x', scrollTop: 0, followBottom: true }))
      .toEqual({
        version: 2,
        draft: 'x',
        scrollTop: 0,
        followBottom: true,
        anchorMessageId: null,
        anchorViewportOffset: 0,
      });
    expect(parsePersistedChatUiState({
      version: 2,
      draft: 'x',
      scrollTop: 30,
      followBottom: false,
      anchorMessageId: 'message-3',
      anchorViewportOffset: -12,
    })).toEqual({
      version: 2,
      draft: 'x',
      scrollTop: 30,
      followBottom: false,
      anchorMessageId: 'message-3',
      anchorViewportOffset: -12,
    });
    expect(parsePersistedChatUiState({
      version: 2,
      draft: 'x',
      scrollTop: 30,
      followBottom: false,
      anchorMessageId: '',
      anchorViewportOffset: 0,
    })).toBeNull();
  });

  test('reports malformed durable state instead of silently treating it as empty', async () => {
    const cache = new ChatConversationUiStateCache();
    const errors: Array<{ error: unknown; operation: string }> = [];
    const successes: string[] = [];
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => ({ version: 2, draft: 42 }),
      saveDraft: async () => {},
      onError: (_conversationId, error, operation) => errors.push({ error, operation }),
      onSuccess: (_conversationId, operation, caughtUp) => {
        successes.push(`${operation}:${caughtUp}`);
      },
    });

    const loaded = await persistence.load('conversation');

    expect(loaded.draft).toBe('');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(ChatUiStatePersistenceFormatError);
    expect(errors[0]?.operation).toBe('load');
    expect(successes).toEqual([]);
    await persistence.shutdown();
  });

  test('notifies recovery after a healthy read and write so the host can clear warnings', async () => {
    const cache = new ChatConversationUiStateCache();
    const successes: string[] = [];
    const persistence = new ChatUiStatePersistence({
      cache,
      canWrite: () => true,
      loadDraft: async () => ({
        version: 2,
        draft: 'restored',
        scrollTop: 88,
        followBottom: false,
        anchorMessageId: 'message-8',
        anchorViewportOffset: -7,
      }),
      saveDraft: async () => {},
      onSuccess: (_conversationId, operation, caughtUp) => {
        successes.push(`${operation}:${caughtUp}`);
      },
    });

    const loaded = await persistence.load('conversation');
    expect(loaded).toMatchObject({
      draft: 'restored',
      anchorMessageId: 'message-8',
      anchorViewportOffset: -7,
    });
    cache.updateDraft('conversation', 'new value');
    await persistence.flush('conversation');

    expect(successes).toEqual(['load:true', 'save:true']);
    await persistence.shutdown();
  });
});
