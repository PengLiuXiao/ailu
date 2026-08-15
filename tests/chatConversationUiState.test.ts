import {
  CHAT_INACTIVE_UI_CACHE_SIZE,
  ChatConversationUiStateCache,
  isChatViewportNearBottom,
} from '../src/ui/chatConversationUiState';

describe('chat conversation UI state', () => {
  test('keeps independent drafts and reading positions while switching conversations', () => {
    const cache = new ChatConversationUiStateCache();

    cache.selectConversation('first');
    cache.updateDraft('first', 'first draft');
    cache.updateViewport('first', {
      scrollTop: 120,
      scrollHeight: 1000,
      clientHeight: 400,
      anchor: { messageId: 'message-12', viewportOffset: -18 },
    });
    cache.selectConversation('second');
    cache.updateDraft('second', 'second draft');

    expect(cache.snapshot('first')).toMatchObject({
      draft: 'first draft',
      scrollTop: 120,
      followBottom: false,
      anchorMessageId: 'message-12',
      anchorViewportOffset: -18,
    });
    expect(cache.snapshot('second').draft).toBe('second draft');
  });

  test('follows appended content only while the viewport remains near the bottom', () => {
    expect(isChatViewportNearBottom({ scrollTop: 552, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isChatViewportNearBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  test('retains only eight persisted inactive entries without limiting running or selected conversations', () => {
    const running = new Set(['running-1', 'running-2']);
    const cache = new ChatConversationUiStateCache({
      isConversationRunning: id => running.has(id),
    });

    for (let index = 0; index < 12; index += 1) {
      cache.selectConversation(`history-${index}`);
    }
    cache.selectConversation('running-1');
    cache.selectConversation('running-2');
    cache.selectConversation('current');

    const ids = cache.listCachedConversationIds();
    expect(ids).toContain('current');
    expect(ids).toContain('running-1');
    expect(ids).toContain('running-2');
    expect(ids.filter(id => id.startsWith('history-'))).toHaveLength(CHAT_INACTIVE_UI_CACHE_SIZE);
  });

  test('never evicts an unsaved draft even when the inactive cache is full', () => {
    const cache = new ChatConversationUiStateCache({ inactiveCapacity: 1 });
    cache.selectConversation('dirty');
    cache.updateDraft('dirty', 'do not lose me');
    cache.selectConversation('other');
    cache.selectConversation('latest');

    expect(cache.listCachedConversationIds()).toContain('dirty');
    expect(cache.snapshot('dirty').draft).toBe('do not lose me');
  });

  test('evicts an old dirty entry only after the exact saved revision is acknowledged', () => {
    const cache = new ChatConversationUiStateCache({ inactiveCapacity: 1 });
    const dirty = cache.updateDraft('dirty', 'version one');
    cache.updateDraft('dirty', 'version two');
    cache.acknowledgePersistence('dirty', dirty.revision);
    cache.selectConversation('other');
    cache.selectConversation('latest');
    expect(cache.listCachedConversationIds()).toContain('dirty');

    const latestDirty = cache.snapshot('dirty');
    cache.acknowledgePersistence('dirty', latestDirty.revision);
    cache.selectConversation('newer');
    cache.selectConversation('newest');
    expect(cache.listCachedConversationIds()).not.toContain('dirty');
  });

  test('does not overwrite newer local input with an older persisted draft', () => {
    const cache = new ChatConversationUiStateCache();
    cache.updateDraft('conversation', 'local edit');

    const result = cache.replaceFromPersistence('conversation', {
      draft: 'older disk value',
      scrollTop: 50,
      followBottom: false,
    });

    expect(result.draft).toBe('local edit');
  });

  test('updates and clears a stable message viewport anchor independently per conversation', () => {
    const cache = new ChatConversationUiStateCache();
    cache.updateViewport('first', {
      scrollTop: 400,
      scrollHeight: 1200,
      clientHeight: 300,
      anchor: { messageId: 'message-old', viewportOffset: -24.5 },
    });
    cache.updateViewport('second', {
      scrollTop: 12,
      scrollHeight: 100,
      clientHeight: 50,
      anchor: null,
    });

    expect(cache.snapshot('first')).toMatchObject({
      anchorMessageId: 'message-old',
      anchorViewportOffset: -24.5,
    });
    expect(cache.snapshot('second')).toMatchObject({
      anchorMessageId: null,
      anchorViewportOffset: 0,
    });

    cache.updateViewport('first', {
      scrollTop: 450,
      scrollHeight: 1200,
      clientHeight: 300,
      anchor: null,
    });
    expect(cache.snapshot('first').anchorMessageId).toBeNull();
  });
});
