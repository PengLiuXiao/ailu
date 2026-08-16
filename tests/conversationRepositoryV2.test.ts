import { createHash } from 'node:crypto';

import type { DataAdapter } from 'obsidian';

import { STORAGE_IDS } from '../src/ids';
import {
  CHAT_STORE_POINTER_PATH,
  CHAT_V2_MAX_MESSAGE_CHUNK_BYTES,
  CHAT_V2_MAX_MESSAGE_CONTENT_BYTES,
  CHAT_V2_MAX_MESSAGE_METADATA_BYTES,
} from '../src/storage/conversationRepositoryV2';
import {
  ConversationRevisionConflictError,
  ConversationSessionConflictError,
  ConversationStoreAtomicWriteError,
  ConversationStoreCorruptError,
  ConversationTurnStateError,
  VaultStore,
  type BeginTurnInput,
  type ConversationRuntimeSnapshot,
  type VersionedStoredConversation,
} from '../src/storage/vaultStore';
import type {
  ProcessWriteLock,
  ProcessWriteLockCasResult,
} from '../src/storage/processWriteLock';
import type {
  AgentId,
  ChatMessage,
  ConversationContextCheckpointDraft,
} from '../src/types';

const RUNTIME: ConversationRuntimeSnapshot = {
  configSource: 'localCli',
  model: 'test-model',
  planMode: false,
  fullAccess: true,
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(',')}}`;
}

function withRecomputedChecksum(value: Record<string, unknown>): Record<string, unknown> {
  const unsigned = { ...value };
  delete unsigned.checksum;
  return {
    ...unsigned,
    checksum: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

class V2MemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly reads = new Map<string, number>();
  readonly removed: string[] = [];
  readonly reportedSizes = new Map<string, number>();
  beforeRead: ((path: string) => Promise<void>) | null = null;
  beforeProcess: ((path: string) => Promise<void>) | null = null;
  private readonly processTails = new Map<string, Promise<void>>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, value] of Object.entries(initial)) this.files.set(path, value);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async stat(path: string): Promise<{
    type: 'file' | 'folder';
    ctime: number;
    mtime: number;
    size: number;
  } | null> {
    const file = this.files.get(path);
    if (file !== undefined) {
      return {
        type: 'file',
        ctime: 0,
        mtime: 0,
        size: this.reportedSizes.get(path) ?? Buffer.byteLength(file, 'utf8'),
      };
    }
    if (this.directories.has(path)) return { type: 'folder', ctime: 0, mtime: 0, size: 0 };
    return null;
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${path.replace(/\/$/, '')}/`;
    const files = [...this.files.keys()].filter(item => (
      item.startsWith(prefix) && !item.slice(prefix.length).includes('/')
    ));
    const folders = [...this.directories].filter(item => (
      item.startsWith(prefix) && !item.slice(prefix.length).includes('/')
    ));
    return { files, folders };
  }

  async read(path: string): Promise<string> {
    await this.beforeRead?.(path);
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Missing ${path}`);
    return value;
  }

  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }

  async copy(source: string, target: string): Promise<void> {
    if (this.files.has(target) || this.directories.has(target)) {
      throw new Error(`Copy target exists: ${target}`);
    }
    const value = this.files.get(source);
    if (value === undefined) throw new Error(`Missing ${source}`);
    this.files.set(target, value);
  }

  async process(path: string, update: (raw: string) => string): Promise<string> {
    await this.beforeProcess?.(path);
    const previous = this.processTails.get(path) ?? Promise.resolve();
    let result = '';
    const operation = previous.then(() => {
      const current = this.files.get(path);
      if (current === undefined) throw new Error(`Missing ${path}`);
      result = update(current);
      this.files.set(path, result);
    });
    this.processTails.set(path, operation.then(() => undefined, () => undefined));
    await operation;
    return result;
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
    throw new Error('Tests prohibit deletion.');
  }

  getResourcePath(path: string): string {
    return `app://vault/${path}`;
  }

  resetReads(): void {
    this.reads.clear();
  }
}

class StrictListV2MemoryAdapter extends V2MemoryAdapter {
  override async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (!this.directories.has(path)) throw new Error(`Missing directory ${path}`);
    return super.list(path);
  }
}

class SharedProcessLockState {
  owner: FakeProcessWriteLock | null = null;
}

class FakeProcessWriteLock implements ProcessWriteLock {
  protected held = false;

  constructor(protected readonly shared: SharedProcessLockState) {}

  async acquire(): Promise<boolean> {
    if (this.held && this.shared.owner === this) return true;
    if (this.shared.owner) return false;
    this.shared.owner = this;
    this.held = true;
    return true;
  }

  async assertHeld(): Promise<void> {
    if (!this.held || this.shared.owner !== this) throw new Error('process lock lost');
  }

  async release(): Promise<void> {
    if (this.shared.owner === this) this.shared.owner = null;
    this.held = false;
  }

  simulateHelperCrash(): void {
    if (this.shared.owner === this) this.shared.owner = null;
    this.held = false;
  }
}

class PhysicalFakeProcessWriteLock extends FakeProcessWriteLock {
  constructor(shared: SharedProcessLockState, private readonly adapter: V2MemoryAdapter) {
    super(shared);
  }

  async readTextFile(filePath: string): Promise<string | null> {
    await this.assertHeld();
    return this.adapter.files.get(filePath) ?? null;
  }

  async compareAndSwapTextFile(
    filePath: string,
    expected: string | null,
    replacement: string,
  ): Promise<ProcessWriteLockCasResult> {
    await this.assertHeld();
    const current = this.adapter.files.get(filePath) ?? null;
    if (current !== expected) return { swapped: false, value: current };
    this.adapter.files.set(filePath, replacement);
    return { swapped: true, value: replacement };
  }
}

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  agentId: AgentId = 'codex',
): ChatMessage {
  return { id, role, content, createdAt: 1, agentId };
}

function beginInput(
  conversationId: string,
  turnId: string,
  initialState: BeginTurnInput['initialState'] = 'active',
): BeginTurnInput {
  return {
    conversationId,
    turnId,
    agentId: 'codex',
    userMessage: message(`${turnId}-user`, 'user', `Prompt ${turnId}`),
    assistantMessage: message(`${turnId}-assistant`, 'assistant', ''),
    runtime: RUNTIME,
    initialState,
  };
}

function contextCheckpointDraft(
  conversation: VersionedStoredConversation,
  id = 'context-checkpoint-1',
  previousCheckpointId?: string,
): ConversationContextCheckpointDraft {
  const throughMessageSequence = conversation.messages.length;
  const throughMessageId = conversation.messages.at(-1)?.id;
  if (!throughMessageId) throw new Error('A context checkpoint needs at least one message.');
  return {
    version: 1,
    id,
    createdAt: 10,
    sourceRevision: conversation.revision,
    throughMessageSequence,
    throughMessageId,
    projectionVersion: 1,
    summary: {
      facts: ['The canonical transcript remains complete.'],
      decisions: ['A provider-neutral checkpoint may be reused.'],
      userPreferences: ['Keep the handoff concise.'],
      constraints: ['Do not persist hidden reasoning.'],
      openLoops: ['Continue the active task.'],
      filesMentioned: ['src/types.ts'],
      lastIntent: 'Continue this conversation with another provider.',
    },
    createdBy: 'local',
    ...(previousCheckpointId === undefined ? {} : { previousCheckpointId }),
  };
}

async function initialize(adapter = new V2MemoryAdapter()): Promise<{
  adapter: V2MemoryAdapter;
  store: VaultStore;
}> {
  const store = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'v2-test' });
  await store.ensureV2Store();
  return { adapter, store };
}

describe('ConversationRepository v2', () => {
  test('round-trips bounded known metadata and preserves bounded opaque extensions', async () => {
    const { store } = await initialize();
    const lifecycleText = '\n\n• Read completed';
    const content = `Verified answer.${lifecycleText}`;
    const start = content.length - lifecycleText.length;
    const stored = message('metadata-valid', 'assistant', content);
    stored.metadata = {
      artifacts: [{
        id: 'generated-image-1',
        type: 'image',
        vaultPath: `${STORAGE_IDS.generatedImagesPath}/metadata-valid/image.png`,
        mimeType: 'image/png',
        createdAt: 2,
        revisedPrompt: 'A concise diagram.',
      }],
      durationMs: 1_234,
      memoryReferences: [{
        channel: 'project',
        relativePath: 'project/current.md',
        appId: 'com.example.ailu',
        projectId: 'ailu-open-source',
        sha256: 'a'.repeat(64),
        verifiedAt: '2026-08-15T00:00:00.000Z',
        gitHead: 'b'.repeat(40),
        queryHash: 'c'.repeat(64),
        retrievedAt: '2026-08-15T00:00:01.000Z',
        stale: false,
        liveVerificationRequired: false,
        policyWarnings: ['current snapshot'],
      }],
      ailuToolLifecycleContentV1: {
        version: 1,
        spans: [{
          start,
          end: content.length,
          sha256: createHash('sha256').update(lifecycleText).digest('hex'),
        }],
      },
      futureExtension: { version: 1, labels: ['bounded', 'opaque'] },
    };

    await store.appendMessage('metadata-round-trip', stored);
    const loaded = await store.getConversation('metadata-round-trip');
    expect(loaded?.messages).toEqual([stored]);
  });

  test.each([
    ['artifacts object', { artifacts: {} }],
    ['null artifact', { artifacts: [null] }],
    ['null memory reference', { memoryReferences: [null] }],
    ['artifact traversal', { artifacts: [{
      id: 'escaped',
      type: 'image',
      vaultPath: '../outside.png',
      mimeType: 'image/png',
      createdAt: 1,
    }] }],
    ['absolute memory path', { memoryReferences: [{
      channel: 'project',
      relativePath: 'C:/Users/example/private.md',
      sha256: 'a'.repeat(64),
      verifiedAt: '',
      gitHead: '',
      queryHash: 'b'.repeat(64),
      retrievedAt: '',
      stale: true,
      liveVerificationRequired: true,
      policyWarnings: [],
    }] }],
  ])('rejects malformed known metadata without mutating the store: %s', async (_label, metadata) => {
    const { adapter, store } = await initialize();
    const before = [...adapter.files.entries()];
    const stored = message('metadata-invalid', 'assistant', 'Do not persist this.');
    stored.metadata = metadata as ChatMessage['metadata'];

    await expect(store.appendMessage('metadata-invalid', stored))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect([...adapter.files.entries()]).toEqual(before);
  });

  test('drops only malformed lifecycle markers while preserving all message content', async () => {
    const { store } = await initialize();
    const stored = message('lifecycle-stale', 'assistant', 'Ordinary answer\n\n• Read completed');
    stored.metadata = {
      futureExtension: { version: 1 },
      ailuToolLifecycleContentV1: {
        version: 1,
        spans: [{ start: 16, end: 34, sha256: '0'.repeat(64) }],
      },
    };

    const appended = await store.appendMessage('lifecycle-normalized', stored);
    expect(appended.messages[0]?.content).toBe(stored.content);
    expect(appended.messages[0]?.metadata).toEqual({ futureExtension: { version: 1 } });
    expect((await store.getConversation('lifecycle-normalized'))?.messages[0])
      .toEqual(appended.messages[0]);
  });

  test('rejects message and metadata byte-budget overruns before any durable write', async () => {
    const { adapter, store } = await initialize();
    const before = [...adapter.files.entries()];
    const oversizedContent = message(
      'oversized-content',
      'assistant',
      '界'.repeat(Math.floor(CHAT_V2_MAX_MESSAGE_CONTENT_BYTES / 3) + 1),
    );
    await expect(store.appendMessage('oversized-content', oversizedContent))
      .rejects.toThrow(/UTF-8 bytes/u);
    expect([...adapter.files.entries()]).toEqual(before);

    const oversizedMetadata = message('oversized-metadata', 'assistant', 'bounded content');
    oversizedMetadata.metadata = {
      first: 'a'.repeat(200 * 1024),
      second: 'b'.repeat(200 * 1024),
      third: 'c'.repeat(200 * 1024),
    };
    expect(Buffer.byteLength(JSON.stringify(oversizedMetadata.metadata), 'utf8'))
      .toBeGreaterThan(CHAT_V2_MAX_MESSAGE_METADATA_BYTES);
    await expect(store.appendMessage('oversized-metadata', oversizedMetadata))
      .rejects.toThrow(/byte budget/u);
    expect([...adapter.files.entries()]).toEqual(before);
  });

  test('rejects an oversized persisted message chunk before reading or parsing it', async () => {
    const { adapter, store } = await initialize();
    await store.replaceConversation({
      id: 'oversized-chunk',
      title: 'Oversized chunk',
      agentId: 'codex',
      createdAt: 1,
      updatedAt: 1,
      messages: [message('chunk-message', 'assistant', 'small durable message')],
    });
    const snapshotPath = [...adapter.files.keys()].find(path => path.endsWith('/snapshot.json'));
    if (!snapshotPath) throw new Error('Expected a persisted conversation snapshot.');
    const snapshot = JSON.parse(adapter.files.get(snapshotPath) ?? '{}') as {
      chunks?: Array<{ path?: string }>;
    };
    const relativeChunkPath = snapshot.chunks?.[0]?.path;
    if (!relativeChunkPath) throw new Error('Expected an active persisted message chunk.');
    const chunkPath = `${snapshotPath.slice(0, -'snapshot.json'.length)}${relativeChunkPath}`;
    adapter.reportedSizes.set(chunkPath, CHAT_V2_MAX_MESSAGE_CHUNK_BYTES + 1);
    adapter.resetReads();

    await expect(store.getConversation('oversized-chunk'))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect(adapter.reads.get(chunkPath) ?? 0).toBe(0);
  });

  test('preflights malformed v1 metadata before creating or switching a v2 generation', async () => {
    const legacy = {
      version: 1,
      revision: 0,
      nextQueueSequence: 1,
      conversations: [{
        id: 'legacy-malformed',
        title: 'Legacy malformed',
        agentId: 'codex',
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
        messages: [{
          ...message('legacy-message', 'assistant', 'Legacy content remains in v1.'),
          metadata: { artifacts: [null] },
        }],
        turns: [],
      }],
    };
    const raw = `${JSON.stringify(legacy, null, 2)}\n`;
    const adapter = new V2MemoryAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);

    await expect(store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) }))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(raw);
    expect(adapter.files.has(CHAT_STORE_POINTER_PATH)).toBe(false);
    expect([...adapter.files.keys()].some(path => path.includes('/chat-v2-'))).toBe(false);
  });

  test('never exposes stage files when a physical fenced CAS is available', async () => {
    const adapter = new V2MemoryAdapter();
    const locks = new SharedProcessLockState();
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'physical-no-stage',
      requireWriteLease: true,
      processWriteLock: new PhysicalFakeProcessWriteLock(locks, adapter),
    });
    expect((await store.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await store.ensureV2Store();
    await store.beginTurn(beginInput('no-stage', 'no-stage-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'no-stage',
      turnId: 'no-stage-turn',
      messageId: 'no-stage-turn-assistant',
      patch: { content: 'physical helper only' },
    });

    expect([...adapter.files.keys()].some(filePath => filePath.includes('.stage'))).toBe(false);
    await store.releaseWriteLease();
  });

  test('creates and repairs the conversations directory for an empty v2 store', async () => {
    const adapter = new StrictListV2MemoryAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'empty-store' });
    await expect(store.ensureV2Store()).resolves.toMatchObject({ status: 'created-empty' });
    const status = await store.getConversationStoreStatus();
    const conversationRoot = `${status.generationPath}/conversations`;
    expect(adapter.directories.has(conversationRoot)).toBe(true);
    await expect(store.recoverInterruptedTurns()).resolves.toMatchObject({
      applied: false,
      transitions: [],
      conversations: [],
    });

    // Simulate a store created by the first v2 implementation, whose pointer
    // and checksummed empty catalog are valid but whose empty directory was
    // never materialized on disk.
    adapter.directories.delete(conversationRoot);
    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'empty-store-restart',
    });
    await expect(restarted.ensureV2Store()).resolves.toMatchObject({ status: 'already-v2' });
    expect(adapter.directories.has(conversationRoot)).toBe(true);
    await expect(restarted.recoverInterruptedTurns()).resolves.toMatchObject({ applied: false });
  });

  test('does not mask a missing conversations directory in a non-empty v2 store', async () => {
    const adapter = new StrictListV2MemoryAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'nonempty-store' });
    await store.ensureV2Store();
    await store.beginTurn(beginInput('must-remain-visible', 'visible-turn'));
    const status = await store.getConversationStoreStatus();
    const conversationRoot = `${status.generationPath}/conversations`;

    adapter.directories.delete(conversationRoot);
    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'nonempty-store-restart',
    });
    await expect(restarted.ensureV2Store()).resolves.toMatchObject({ status: 'already-v2' });
    expect(adapter.directories.has(conversationRoot)).toBe(false);
    await expect(restarted.recoverInterruptedTurns()).rejects.toThrow(
      `Could not scan ${conversationRoot}`,
    );
  });

  test('creates one active generation and keeps using it for conversation writes', async () => {
    const { adapter, store } = await initialize();
    const first = await store.getConversationStoreStatus();
    expect(first.backend).toBe('v2');
    expect(first.activeGeneration).toBeTruthy();

    await store.beginTurn(beginInput('conversation-a', 'turn-a'));
    await store.beginTurn(beginInput('conversation-b', 'turn-b'));
    const second = await store.getConversationStoreStatus();
    expect(second.activeGeneration).toBe(first.activeGeneration);
    expect(second.conversationCount).toBe(2);
    expect([...adapter.directories].filter(path => path.includes('/chat-v2-'))).not.toHaveLength(0);
    expect(adapter.removed).toEqual([]);
  });

  test('migrates v1 byte-for-byte, verifies it, and never edits the legacy file', async () => {
    const adapter = new V2MemoryAdapter();
    const v1 = new VaultStore(adapter as unknown as DataAdapter);
    await v1.beginTurn(beginInput('legacy', 'legacy-turn', 'queued'));
    await v1.patchSession({
      conversationId: 'legacy',
      agentId: 'codex',
      turnId: 'legacy-turn',
      sessionId: 'legacy-session',
      configKey: 'safe-key',
    });
    const original = adapter.files.get(STORAGE_IDS.conversationsPath)!;
    const report = await v1.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    expect(report.status).toBe('migrated-v1');
    expect(report.conversationCount).toBe(1);
    expect(report.messageCount).toBe(2);
    expect(report.sessionCount).toBe(1);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);
    expect((await v1.getConversation('legacy'))?.messages).toHaveLength(2);
    expect(adapter.removed).toEqual([]);
  });

  test('migrates the pre-Phase-0 conversation shape without inventing message or session data', async () => {
    const legacy = {
      version: 1,
      conversations: [{
        id: 'old-shape',
        title: 'Old shape',
        agentId: 'claude',
        createdAt: 10,
        updatedAt: 20,
        messages: [message('old-message', 'user', 'legacy body', 'claude')],
        sessionIds: { claude: 'old-session' },
        sessionConfigKeys: { claude: 'old-config' },
      }],
    };
    const raw = JSON.stringify(legacy);
    const adapter = new V2MemoryAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    expect(await store.getConversation('old-shape')).toMatchObject({
      id: 'old-shape', revision: 0, turns: [],
      messages: [expect.objectContaining({ id: 'old-message', content: 'legacy body' })],
      sessionIds: { claude: 'old-session' },
      sessionConfigKeys: { claude: 'old-config' },
    });
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(raw);
  });

  test('paginates and searches a 10,000-conversation catalog without loading bodies', async () => {
    const conversations: VersionedStoredConversation[] = Array.from({ length: 10_000 }, (_, index) => ({
      id: `bulk-${String(index).padStart(5, '0')}`,
      title: index % 100 === 0 ? `Needle ${index}` : `Conversation ${index}`,
      agentId: 'codex',
      createdAt: index,
      updatedAt: index,
      messages: [],
      revision: 0,
      turns: [],
      sessionIds: { codex: `bulk-session-${String(index).padStart(5, '0')}` },
    }));
    const raw = `${JSON.stringify({
      version: 1, revision: 0, nextQueueSequence: 1, conversations,
    })}\n`;
    const adapter = new V2MemoryAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    adapter.resetReads();

    const first = await store.listConversationSummaries(null, 50);
    const second = await store.listConversationSummaries(first.nextCursor, 50);
    expect(first.items).toHaveLength(50);
    expect(second.items).toHaveLength(50);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(100);
    const search = await store.searchConversations('needle', { pageSize: 50 });
    expect(search.items).toHaveLength(50);
    expect(search.items.every(item => item.title.startsWith('Needle'))).toBe(true);
    expect([...adapter.reads.keys()].some(path => path.endsWith('/snapshot.json'))).toBe(false);

    adapter.resetReads();
    const restarted = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'bulk-restart' });
    await restarted.ensureV2Store();
    expect([...adapter.reads.keys()].some(path => (
      path.endsWith('/snapshot.json') || path.endsWith('/run-state.json')
    ))).toBe(false);
    expect([...adapter.reads.values()].reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(5);

    adapter.resetReads();
    await expect(restarted.loadSessionOwner('bulk-session-09999')).resolves.toMatchObject({
      conversationId: 'bulk-09999',
      agentId: 'codex',
    });
    expect([...adapter.reads.keys()].some(path => (
      path.endsWith('/snapshot.json') || path.endsWith('/run-state.json')
    ))).toBe(false);
    expect([...adapter.reads.values()].reduce((total, count) => total + count, 0)).toBeLessThanOrEqual(6);
  }, 60_000);

  test('keeps the pointer absent at every pre-switch migration crash point and retries safely', async () => {
    const points = [
      'after-generation-created',
      'after-rollback-export',
      'after-conversations',
      'after-catalog',
      'after-manifest',
      'before-pointer-switch',
    ] as const;
    for (const point of points) {
      const adapter = new V2MemoryAdapter();
      const store = new VaultStore(adapter as unknown as DataAdapter);
      await store.beginTurn(beginInput(`legacy-${point}`, `turn-${point}`, 'queued'));
      const original = adapter.files.get(STORAGE_IDS.conversationsPath)!;
      await expect(store.ensureV2Store({
        quiescenceBarrier: async () => ({ activeRuns: 0 }),
        faultInjector: current => {
          if (current === point) throw new Error(`crash:${point}`);
        },
      })).rejects.toThrow(`crash:${point}`);
      expect(adapter.files.has('.ailu/chat-store.json')).toBe(false);
      expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);
      await expect(store.ensureV2Store({
        quiescenceBarrier: async () => ({ activeRuns: 0 }),
      })).resolves.toMatchObject({ status: 'migrated-v1', pointerSwitched: true });
      expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);
    }
  });

  test('treats an after-switch crash as committed and reports already-v2 on retry', async () => {
    const adapter = new V2MemoryAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.beginTurn(beginInput('after-switch', 'after-switch-turn', 'queued'));
    const original = adapter.files.get(STORAGE_IDS.conversationsPath)!;
    await expect(store.ensureV2Store({
      quiescenceBarrier: async () => ({ activeRuns: 0 }),
      faultInjector: point => {
        if (point === 'after-pointer-switch') throw new Error('crash:after-pointer-switch');
      },
    })).rejects.toThrow('crash:after-pointer-switch');
    expect(adapter.files.has('.ailu/chat-store.json')).toBe(true);
    await expect(store.ensureV2Store()).resolves.toMatchObject({ status: 'already-v2' });
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);
  });

  test('serializes one conversation while allowing distinct conversations to persist without overwrite', async () => {
    const { store } = await initialize();
    const [left, right] = await Promise.all([
      store.beginTurn(beginInput('left', 'left-turn')),
      store.beginTurn(beginInput('right', 'right-turn')),
    ]);
    expect(new Set([left.turn.queueSequence, right.turn.queueSequence]).size).toBe(2);
    await Promise.all([
      store.checkpointAssistantMessage({
        conversationId: 'left', turnId: 'left-turn', messageId: 'left-turn-assistant',
        patch: { content: 'left partial' },
      }),
      store.checkpointAssistantMessage({
        conversationId: 'right', turnId: 'right-turn', messageId: 'right-turn-assistant',
        patch: { content: 'right partial' },
      }),
    ]);
    expect((await store.getConversation('left'))?.messages.at(-1)?.content).toBe('left partial');
    expect((await store.getConversation('right'))?.messages.at(-1)?.content).toBe('right partial');
  });

  test('fences a paused stale writer before its canonical run-state CAS can overwrite a takeover', async () => {
    let now = 1_000;
    const adapter = new V2MemoryAdapter();
    const first = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'writer-a', ttlMs: 1_000, now: () => now, requireWriteLease: true,
    });
    await first.acquireWriteLease({ startHeartbeat: false });
    await first.ensureV2Store();
    await first.beginTurn(beginInput('fenced', 'fenced-turn'));

    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let didBlock = false;
    adapter.beforeProcess = async path => {
      if (!didBlock && path.endsWith('/run-state.json')) {
        didBlock = true;
        await blocked;
      }
    };
    const staleWrite = first.checkpointAssistantMessage({
      conversationId: 'fenced', turnId: 'fenced-turn', messageId: 'fenced-turn-assistant',
      patch: { content: 'stale writer' },
    });
    while (!didBlock) await Promise.resolve();

    now += 1_001;
    const second = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'writer-b', ttlMs: 1_000, now: () => now, requireWriteLease: true,
    });
    expect((await second.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await second.checkpointAssistantMessage({
      conversationId: 'fenced', turnId: 'fenced-turn', messageId: 'fenced-turn-assistant',
      patch: { content: 'takeover writer' },
    });
    release();
    await expect(staleWrite).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    expect((await second.getConversation('fenced'))?.messages.at(-1)?.content).toBe('takeover writer');
  });

  test('rejects an old writer after process-lock loss and TTL takeover on an unrelated conversation', async () => {
    const adapter = new V2MemoryAdapter();
    const processLocks = new SharedProcessLockState();
    const oldLock = new FakeProcessWriteLock(processLocks);
    let now = 10_000;
    const oldWriter = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'old-writer',
      ttlMs: 1_000,
      now: () => now,
      requireWriteLease: true,
      processWriteLock: oldLock,
    });
    expect((await oldWriter.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await oldWriter.ensureV2Store();
    await oldWriter.beginTurn(beginInput('old-target', 'old-target-turn'));
    expect((await oldWriter.renewWriteLease()).mode).toBe('writer');

    // Models the long-lived fcntl helper dying while its JS host is paused.
    // The OS releases the descriptor, but the old JSON lease remains until TTL.
    oldLock.simulateHelperCrash();
    now += 1_001;
    const newWriter = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'new-writer',
      ttlMs: 1_000,
      now: () => now,
      requireWriteLease: true,
      processWriteLock: new FakeProcessWriteLock(processLocks),
    });
    expect((await newWriter.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await newWriter.beginTurn(beginInput('unrelated-target', 'unrelated-turn'));

    await expect(oldWriter.checkpointAssistantMessage({
      conversationId: 'old-target',
      turnId: 'old-target-turn',
      messageId: 'old-target-turn-assistant',
      patch: { content: 'stale write must not land' },
    })).rejects.toMatchObject({ name: 'ConversationStoreReadOnlyError' });
    expect((await newWriter.getConversation('old-target'))?.messages.at(-1)?.content).toBe('');
    expect(await newWriter.getConversation('unrelated-target')).not.toBeNull();
  });

  test('opens read-only when another process already holds the advisory writer lock', async () => {
    const adapter = new V2MemoryAdapter();
    const processLocks = new SharedProcessLockState();
    const first = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'process-owner',
      requireWriteLease: true,
      processWriteLock: new FakeProcessWriteLock(processLocks),
    });
    expect((await first.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await first.ensureV2Store();

    const contender = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'process-contender',
      requireWriteLease: true,
      processWriteLock: new FakeProcessWriteLock(processLocks),
    });
    expect((await contender.acquireWriteLease({ startHeartbeat: false })).mode).toBe('readOnly');
    await expect(contender.beginTurn(beginInput('must-stay-read-only', 'blocked-turn')))
      .rejects.toMatchObject({ name: 'ConversationStoreReadOnlyError' });
  });

  test('rejects stale conversation revisions and structured duplicate session claims', async () => {
    const { adapter, store } = await initialize();
    const first = await store.beginTurn(beginInput('first', 'first-turn'));
    await store.beginTurn(beginInput('second', 'second-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'first', turnId: 'first-turn', messageId: 'first-turn-assistant',
      expectedRevision: first.revision, patch: { content: 'checkpoint' },
    });
    await expect(store.checkpointAssistantMessage({
      conversationId: 'first', turnId: 'first-turn', messageId: 'first-turn-assistant',
      expectedRevision: first.revision, patch: { content: 'stale' },
    })).rejects.toBeInstanceOf(ConversationRevisionConflictError);

    await store.claimSessionOwnership({
      conversationId: 'first', agentId: 'codex', sessionId: 'shared', runId: 'first-turn',
    });
    await store.finalizeTurn({ conversationId: 'first', turnId: 'first-turn' });
    await store.beginTurn(beginInput('first', 'first-turn-2'));
    const resumed = await store.claimSessionOwnership({
      conversationId: 'first', agentId: 'codex', sessionId: 'shared', runId: 'first-turn-2',
    });
    const patched = await store.patchSession({
      conversationId: 'first', turnId: 'first-turn-2', agentId: 'codex',
      sessionId: 'shared', configKey: 'resume-config',
    });
    expect(resumed.applied).toBe(true);
    expect(patched.applied).toBe(true);
    const persisted = await store.getConversation('first');
    expect(persisted?.sessionOwnerships?.codex?.runId).toBe('first-turn-2');
    expect(persisted?.sessionConfigKeys?.codex).toBe('resume-config');
    let conflict: unknown;
    try {
      await store.claimSessionOwnership({
        conversationId: 'second', agentId: 'codex', sessionId: 'shared', runId: 'second-turn',
      });
    } catch (error) {
      conflict = error;
    }
    if (!(conflict instanceof ConversationSessionConflictError)) throw conflict;
    expect(conflict.existingOwner).toMatchObject({
      sessionId: 'shared', conversationId: 'first', agentId: 'codex', runId: 'first-turn-2',
    });
    adapter.resetReads();
    expect(await store.listSessionOwnerships()).toEqual([
      expect.objectContaining({
        sessionId: 'shared', conversationId: 'first', agentId: 'codex', runId: 'first-turn-2',
      }),
    ]);
    expect([...adapter.reads.keys()].some(path => path.includes('/messages/chunk-'))).toBe(false);
  });

  test('claims canonical owner and config in one sharded lookup and fails closed on a corrupt shard', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('indexed-owner', 'indexed-turn'));
    adapter.resetReads();
    await store.claimSessionOwnership({
      conversationId: 'indexed-owner',
      agentId: 'codex',
      sessionId: 'indexed-session',
      runId: 'indexed-turn',
      sessionConfigKey: 'indexed-config',
    });
    expect((await store.getConversation('indexed-owner'))?.sessionConfigKeys?.codex)
      .toBe('indexed-config');
    const authoritativeBucketReads = [...adapter.reads.keys()].filter(path => (
      path.includes('/session-owner-indexes/')
      && path.includes('/buckets/')
      && path.endsWith('.json')
    ));
    expect(authoritativeBucketReads).toHaveLength(1);
    await expect(store.loadSessionOwner('indexed-session')).resolves.toMatchObject({
      conversationId: 'indexed-owner',
      runId: 'indexed-turn',
    });

    const bucketPath = [...adapter.files.entries()].find(([path, raw]) => (
      path.includes('/session-owner-indexes/')
      && path.includes('/buckets/')
      && path.endsWith('.json')
      && raw.includes('indexed-session')
    ))?.[0];
    if (!bucketPath) throw new Error('Expected indexed owner bucket.');
    adapter.files.set(bucketPath, '{corrupt');
    await expect(store.loadSessionOwner('indexed-session'))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    await store.rebuildCatalog();
    await expect(store.loadSessionOwner('indexed-session')).resolves.toMatchObject({
      conversationId: 'indexed-owner',
    });
  });

  test.each([
    ['across shards', 'switch-b-0'],
    ['inside one shard', 'switch-b-1012'],
  ])('atomically replaces a canonical session %s without growing owner count', async (_, nextSession) => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('session-switch', 'session-switch-turn'));
    await store.claimSessionOwnership({
      conversationId: 'session-switch',
      agentId: 'codex',
      sessionId: 'switch-a',
      runId: 'session-switch-a',
    });
    await store.claimSessionOwnership({
      conversationId: 'session-switch',
      agentId: 'codex',
      sessionId: nextSession,
      runId: 'session-switch-b',
      sessionConfigKey: 'switch-config-b',
    });

    await expect(store.loadSessionOwner('switch-a')).resolves.toBeNull();
    await expect(store.loadSessionOwner(nextSession)).resolves.toMatchObject({
      conversationId: 'session-switch',
      agentId: 'codex',
      runId: 'session-switch-b',
    });
    expect(await store.listSessionOwnerships()).toHaveLength(1);
    const ownerPointerPath = [...adapter.files.keys()]
      .find(path => path.endsWith('/session-owner-index.json'));
    if (!ownerPointerPath) throw new Error('Expected session-owner index pointer.');
    const ownerPointer = JSON.parse(adapter.files.get(ownerPointerPath)!) as {
      ownerCount?: unknown;
    };
    expect(ownerPointer.ownerCount).toBe(1);
    expect((await store.getConversation('session-switch'))?.sessionIds?.codex).toBe(nextSession);

    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: `session-switch-restart-${nextSession}`,
    });
    await restarted.ensureV2Store();
    await expect(restarted.loadSessionOwner('switch-a')).resolves.toBeNull();
    await expect(restarted.loadSessionOwner(nextSession)).resolves.toMatchObject({
      runId: 'session-switch-b',
    });
    await restarted.rebuildCatalog();
    await expect(restarted.loadSessionOwner('switch-a')).resolves.toBeNull();
    expect(await restarted.listSessionOwnerships()).toEqual([
      expect.objectContaining({ sessionId: nextSession, runId: 'session-switch-b' }),
    ]);
  });

  test('repairs an interrupted cross-shard owner replacement without exposing both sessions', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('session-switch-crash', 'session-switch-crash-turn'));
    await store.claimSessionOwnership({
      conversationId: 'session-switch-crash',
      agentId: 'codex',
      sessionId: 'switch-a',
      runId: 'session-switch-crash-a',
    });
    let failedPointerSwitch = false;
    adapter.beforeProcess = async path => {
      if (!failedPointerSwitch && path.endsWith('/session-owner-index.json')) {
        failedPointerSwitch = true;
        throw new Error('crash-before-session-owner-pointer-switch');
      }
    };
    await expect(store.claimSessionOwnership({
      conversationId: 'session-switch-crash',
      agentId: 'codex',
      sessionId: 'switch-b-0',
      runId: 'session-switch-crash-b',
    })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    adapter.beforeProcess = null;

    await store.claimSessionOwnership({
      conversationId: 'session-switch-crash',
      agentId: 'codex',
      sessionId: 'switch-b-0',
      runId: 'session-switch-crash-b',
    });
    await expect(store.loadSessionOwner('switch-a')).resolves.toBeNull();
    await expect(store.loadSessionOwner('switch-b-0')).resolves.toMatchObject({
      conversationId: 'session-switch-crash',
      runId: 'session-switch-crash-b',
    });

    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'session-switch-crash-restart',
    });
    await restarted.ensureV2Store();
    await expect(restarted.loadSessionOwner('switch-a')).resolves.toBeNull();
    await expect(restarted.loadSessionOwner('switch-b-0')).resolves.toMatchObject({
      conversationId: 'session-switch-crash',
      runId: 'session-switch-crash-b',
    });
    expect(await restarted.listSessionOwnerships()).toHaveLength(1);
  });

  test.each(['body', 'owner-pointer', 'catalog-publish'] as const)(
    'repairs a failed session replacement at the %s boundary on the same store instance',
    async faultPoint => {
      const { adapter, store } = await initialize();
      const conversationId = `session-fault-${faultPoint}`;
      await store.beginTurn(beginInput(conversationId, `${conversationId}-turn`));
      await store.claimSessionOwnership({
        conversationId,
        agentId: 'codex',
        sessionId: 'switch-a',
        runId: `${conversationId}-a`,
      });
      let failed = false;
      let catalogProcesses = 0;
      adapter.beforeProcess = async path => {
        if (failed) return;
        if (path.endsWith('/catalog.json')) catalogProcesses += 1;
        const shouldFail = faultPoint === 'body'
          ? path.endsWith('/run-state.json')
          : faultPoint === 'owner-pointer'
            ? path.endsWith('/session-owner-index.json')
            : path.endsWith('/catalog.json') && catalogProcesses === 2;
        if (shouldFail) {
          failed = true;
          throw new Error(`session-fault-${faultPoint}`);
        }
      };
      await expect(store.claimSessionOwnership({
        conversationId,
        agentId: 'codex',
        sessionId: 'switch-b-0',
        runId: `${conversationId}-b`,
      })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
      adapter.beforeProcess = null;

      await store.claimSessionOwnership({
        conversationId,
        agentId: 'codex',
        sessionId: 'switch-b-0',
        runId: `${conversationId}-b`,
      });
      await expect(store.loadSessionOwner('switch-a')).resolves.toBeNull();
      await expect(store.loadSessionOwner('switch-b-0')).resolves.toMatchObject({
        conversationId,
        runId: `${conversationId}-b`,
      });
      expect(await store.listSessionOwnerships()).toHaveLength(1);
    },
  );

  test.each(['body', 'owner-pointer'] as const)(
    'does not expose a mixed body/owner view while a session switch is held at %s',
    async holdPoint => {
      const { adapter, store } = await initialize();
      await store.beginTurn(beginInput('session-hold', 'session-hold-turn'));
      await store.claimSessionOwnership({
        conversationId: 'session-hold',
        agentId: 'codex',
        sessionId: 'switch-a',
        runId: 'session-hold-a',
      });
      const entered = deferred();
      const release = deferred();
      let held = false;
      adapter.beforeProcess = async path => {
        const matches = holdPoint === 'body'
          ? path.endsWith('/run-state.json')
          : path.endsWith('/session-owner-index.json');
        if (!held && matches) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      const switching = store.claimSessionOwnership({
        conversationId: 'session-hold',
        agentId: 'codex',
        sessionId: 'switch-b-0',
        runId: 'session-hold-b',
      });
      await entered.promise;

      let readsSettled = false;
      const reads = Promise.all([
        store.getConversation('session-hold'),
        store.loadConversationWindow('session-hold', 100),
        store.loadSessionOwner('switch-a'),
        store.loadSessionOwner('switch-b-0'),
      ]).finally(() => {
        readsSettled = true;
      });
      await Promise.resolve();
      expect(readsSettled).toBe(false);
      release.resolve();
      await switching;
      const [conversation, window, oldOwner, nextOwner] = await reads;
      expect(conversation?.sessionIds?.codex).toBe('switch-b-0');
      expect(window?.conversation.sessionIds?.codex).toBe('switch-b-0');
      expect(oldOwner).toBeNull();
      expect(nextOwner).toMatchObject({ runId: 'session-hold-b' });
      adapter.beforeProcess = null;
    },
  );

  test.each(['get', 'window', 'owner'] as const)(
    'retries a %s read whose clean catalog epoch changes before its body/index read',
    async readKind => {
      const { adapter, store } = await initialize();
      await store.beginTurn(beginInput('session-read-race', 'session-read-race-turn'));
      await store.claimSessionOwnership({
        conversationId: 'session-read-race',
        agentId: 'codex',
        sessionId: 'switch-a',
        runId: 'session-read-race-a',
      });
      const runStatePath = [...adapter.files.keys()].find(path => (
        path.endsWith('/run-state.json') && adapter.files.get(path)?.includes('session-read-race')
      ));
      const ownerBucketPath = [...adapter.files.entries()].find(([path, raw]) => (
        path.includes('/session-owner-indexes/') && path.endsWith('.json') && raw.includes('switch-a')
      ))?.[0];
      if (!runStatePath || !ownerBucketPath) throw new Error('Expected race target files.');
      const targetPath = readKind === 'owner' ? ownerBucketPath : runStatePath;
      const entered = deferred();
      const release = deferred();
      let held = false;
      adapter.beforeRead = async path => {
        if (!held && path === targetPath) {
          held = true;
          entered.resolve();
          await release.promise;
        }
      };
      const reading = readKind === 'get'
        ? store.getConversation('session-read-race')
        : readKind === 'window'
          ? store.loadConversationWindow('session-read-race', 100)
          : store.loadSessionOwner('switch-a');
      await entered.promise;
      await store.claimSessionOwnership({
        conversationId: 'session-read-race',
        agentId: 'codex',
        sessionId: 'switch-b-0',
        runId: 'session-read-race-b',
      });
      release.resolve();
      const result = await reading;
      if (readKind === 'owner') {
        expect(result).toBeNull();
      } else {
        const conversation = readKind === 'get'
          ? result as VersionedStoredConversation
          : (result as { conversation: VersionedStoredConversation }).conversation;
        expect(conversation.sessionIds?.codex).toBe('switch-b-0');
      }
      adapter.beforeRead = null;
    },
  );

  test('a read-only second instance fails closed on a foreign pending owner switch without repairing it', async () => {
    const adapter = new V2MemoryAdapter();
    const locks = new SharedProcessLockState();
    const writer = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'seqlock-writer',
      requireWriteLease: true,
      processWriteLock: new FakeProcessWriteLock(locks),
    });
    expect((await writer.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await writer.ensureV2Store();
    await writer.beginTurn(beginInput('foreign-pending', 'foreign-pending-turn'));
    await writer.claimSessionOwnership({
      conversationId: 'foreign-pending',
      agentId: 'codex',
      sessionId: 'switch-a',
      runId: 'foreign-pending-a',
    });
    const reader = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'seqlock-reader',
      requireWriteLease: true,
      processWriteLock: new FakeProcessWriteLock(locks),
    });
    expect((await reader.acquireWriteLease({ startHeartbeat: false })).mode).toBe('readOnly');

    const entered = deferred();
    const release = deferred();
    let held = false;
    adapter.beforeProcess = async path => {
      if (!held && path.endsWith('/session-owner-index.json')) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    const switching = writer.claimSessionOwnership({
      conversationId: 'foreign-pending',
      agentId: 'codex',
      sessionId: 'switch-b-0',
      runId: 'foreign-pending-b',
    });
    await entered.promise;
    const catalogPath = [...adapter.files.keys()].find(path => path.endsWith('/catalog.json'));
    const pointerPath = [...adapter.files.keys()].find(path => path.endsWith('/session-owner-index.json'));
    if (!catalogPath || !pointerPath) throw new Error('Expected pending switch files.');
    const catalogBeforeRead = adapter.files.get(catalogPath);
    const pointerBeforeRead = adapter.files.get(pointerPath);
    await expect(reader.loadSessionOwner('switch-a'))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect(adapter.files.get(catalogPath)).toBe(catalogBeforeRead);
    expect(adapter.files.get(pointerPath)).toBe(pointerBeforeRead);

    release.resolve();
    await switching;
    adapter.beforeProcess = null;
    await expect(reader.loadSessionOwner('switch-a')).resolves.toBeNull();
    await expect(reader.loadSessionOwner('switch-b-0')).resolves.toMatchObject({
      runId: 'foreign-pending-b',
    });
  });

  test('keeps draft-only conversations out of history and promotes them only on beginTurn', async () => {
    const { adapter, store } = await initialize();
    const draftsBefore = [...adapter.files.keys()].filter(path => path.endsWith('/draft.json')).length;
    await store.saveDraft('draft-only-empty', '   ');
    expect([...adapter.files.keys()].filter(path => path.endsWith('/draft.json'))).toHaveLength(draftsBefore);
    await store.saveDraft('draft-only', { text: 'unsent text' });
    expect((await store.loadDraft<{ text: string }>('draft-only'))?.value.text).toBe('unsent text');
    expect((await store.listConversationSummaries()).items).toEqual([]);
    await store.beginTurn(beginInput('draft-only', 'draft-turn'));
    expect((await store.listConversationSummaries()).items.map(item => item.id)).toEqual(['draft-only']);
  });

  test('does not expose a seeded new conversation when the first turn crashes before body commit', async () => {
    const { adapter, store } = await initialize();
    let crashed = false;
    adapter.beforeProcess = async path => {
      if (!crashed && path.endsWith('/run-state.json')) {
        crashed = true;
        throw new Error('crash-before-first-turn-body-commit');
      }
    };
    await expect(store.beginTurn(beginInput('seed-crash', 'seed-crash-turn')))
      .rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    adapter.beforeProcess = null;

    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'seed-crash-restart',
    });
    expect((await restarted.listConversationSummaries()).items).toEqual([]);
    await restarted.beginTurn(beginInput('seed-crash', 'seed-crash-turn'));
    expect((await restarted.listConversationSummaries()).items)
      .toEqual([expect.objectContaining({ id: 'seed-crash' })]);
  });

  test('archives without deleting, restores, and keeps legacy list/get semantics', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('archive-me', 'archive-turn'));
    await store.finalizeTurn({ conversationId: 'archive-me', turnId: 'archive-turn' });
    await store.archiveConversation('archive-me');
    expect(await store.getConversation('archive-me')).toBeNull();
    expect((await store.listConversationSummaries(null, 50, 'archived')).items).toHaveLength(1);
    await store.restoreConversation('archive-me');
    expect(await store.getConversation('archive-me')).not.toBeNull();
    expect(adapter.removed).toEqual([]);
  });

  test.each(['active', 'queued', 'cancelRequested', 'paused'] as const)(
    'rejects durable archive while a %s turn is nonterminal',
    async state => {
      const { store } = await initialize();
      await store.beginTurn(beginInput(
        `archive-${state}`,
        `turn-${state}`,
        state === 'queued' || state === 'paused' ? 'queued' : 'active',
      ));
      if (state === 'cancelRequested') {
        await store.requestTurnCancellation({
          conversationId: `archive-${state}`,
          turnId: `turn-${state}`,
        });
      } else if (state === 'paused') {
        await store.recoverInterruptedTurns();
      }

      await expect(store.archiveConversation(`archive-${state}`))
        .rejects.toBeInstanceOf(ConversationTurnStateError);
      expect(await store.getConversation(`archive-${state}`)).not.toBeNull();
    },
  );

  test('keeps the title searchable when a long body exceeds the search-text budget', async () => {
    const { store } = await initialize();
    const input = beginInput('search-title-tail', 'search-title-turn');
    input.userMessage.content = 'Unique Durable Title Sentinel';
    await store.beginTurn(input);
    await store.checkpointAssistantMessage({
      conversationId: input.conversationId,
      turnId: input.turnId,
      messageId: input.assistantMessage.id,
      patch: { content: `body-tail-${'x'.repeat(20_000)}` },
    });
    await store.finalizeTurn({ conversationId: input.conversationId, turnId: input.turnId! });

    expect((await store.searchConversations('Unique Durable Title Sentinel')).items)
      .toEqual([expect.objectContaining({ id: input.conversationId })]);
  });

  test('mutates a 1000-message history from its active tail without reading or rewriting old chunks', async () => {
    const adapter = new V2MemoryAdapter();
    const legacyStore = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'long-v1' });
    const historicalMessages = Array.from({ length: 1_000 }, (_, index) => message(
      `historical-${index}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `Historical message ${index}`,
    ));
    await legacyStore.replaceConversation({
      id: 'long-history',
      title: 'Long History',
      agentId: 'codex',
      createdAt: 1,
      updatedAt: 2,
      messages: historicalMessages,
    });
    await legacyStore.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const oldChunkPaths = new Set(
      [...adapter.files.keys()].filter(path => (
        path.includes('/messages/chunk-') && path.endsWith('.json')
      )),
    );
    expect(oldChunkPaths.size).toBe(10);
    const bytesBeforeTurns = [...adapter.files.values()]
      .reduce((total, value) => total + Buffer.byteLength(value), 0);

    for (let index = 0; index < 12; index += 1) {
      const turnId = `tail-turn-${index}`;
      adapter.resetReads();
      const begun = await legacyStore.beginTurn(beginInput('long-history', turnId));
      expect(Object.keys(begun).sort()).toEqual(['applied', 'revision', 'turn']);
      const checkpoint = await legacyStore.checkpointAssistantMessage({
        conversationId: 'long-history',
        turnId,
        messageId: `${turnId}-assistant`,
        patch: { content: `Tail answer ${index}` },
      });
      expect(Object.keys(checkpoint).sort()).toEqual(['applied', 'message', 'revision', 'turn']);
      const finalized = await legacyStore.finalizeTurn({
        conversationId: 'long-history',
        turnId,
      });
      expect(Object.keys(finalized).sort()).toEqual(['applied', 'revision', 'turn']);
      expect([...adapter.reads.keys()].filter(path => oldChunkPaths.has(path))).toEqual([]);
      expect([...oldChunkPaths].every(path => adapter.files.has(path))).toBe(true);
      expect([...adapter.files.keys()].filter(path => (
        path.includes('/messages/chunk-') && path.endsWith('.json')
      )))
        .toHaveLength(oldChunkPaths.size + index + 1);
    }

    const bytesAfterTurns = [...adapter.files.values()]
      .reduce((total, value) => total + Buffer.byteLength(value), 0);
    expect(bytesAfterTurns - bytesBeforeTurns).toBeLessThan(750_000);
    const restored = await legacyStore.getConversation('long-history');
    expect(restored?.messages).toHaveLength(1_024);
    expect(restored?.turns).toHaveLength(12);
    const runStatePath = [...adapter.files.keys()].find(path => path.endsWith('/run-state.json'));
    if (!runStatePath) throw new Error('Expected long-history run-state.');
    const runState = JSON.parse(adapter.files.get(runStatePath) ?? '{}') as {
      turnsMode?: string;
      turns?: unknown[];
    };
    expect(runState.turnsMode).toBe('tail');
    expect(runState.turns).toEqual([]);
  });

  test('keeps the prior snapshot intact when atomic compaction fails after a durable final journal', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('atomic-final', 'atomic-turn'));
    const snapshotPath = [...adapter.files.keys()].find(path => path.endsWith('/snapshot.json'))!;
    const originalSnapshot = adapter.files.get(snapshotPath);
    let failed = false;
    adapter.beforeProcess = async path => {
      if (!failed && path === snapshotPath) {
        failed = true;
        throw new Error('simulated snapshot CAS failure');
      }
    };
    await expect(store.finalizeTurn({
      conversationId: 'atomic-final', turnId: 'atomic-turn',
      assistantPatch: { content: 'durable final answer' },
    })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    expect(adapter.files.get(snapshotPath)).toBe(originalSnapshot);
    expect((await store.getConversation('atomic-final'))?.messages.at(-1)?.content)
      .toBe('durable final answer');
    expect(adapter.removed).toEqual([]);
  });

  test('commits a completed context checkpoint atomically, idempotently, and without truncating history', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('context-history', 'context-turn'));
    await store.finalizeTurn({
      conversationId: 'context-history',
      turnId: 'context-turn',
      assistantPatch: { content: 'Durable answer' },
    });
    const before = await store.getConversation('context-history');
    if (!before) throw new Error('Expected completed conversation.');
    const draft = contextCheckpointDraft(before);

    const committed = await store.commitContextCheckpoint({
      conversationId: before.id,
      checkpoint: draft,
      expectedRevision: before.revision,
    });
    expect(committed).toMatchObject({ applied: true });
    expect(committed.checkpoint.prefixSha256).toMatch(/^[a-f0-9]{64}$/);
    const after = await store.getConversation(before.id);
    expect(after?.messages).toEqual(before.messages);
    expect(after?.turns).toEqual(before.turns);
    expect(after?.contextCheckpoint).toEqual(committed.checkpoint);
    await expect(store.replaceConversation({
      ...after!,
      messages: after!.messages.map((item, index) => (
        index === 0 ? { ...item, content: 'silently rewritten prefix' } : item
      )),
    })).rejects.toBeInstanceOf(ConversationTurnStateError);

    const replay = await store.commitContextCheckpoint({
      conversationId: before.id,
      checkpoint: draft,
      // Retries can carry the pre-commit CAS revision; checkpoint id/content
      // makes this safe and must win before the stale-revision check.
      expectedRevision: before.revision,
    });
    expect(replay).toEqual({
      applied: false,
      revision: committed.revision,
      checkpoint: committed.checkpoint,
    });

    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'context-history-restart',
    });
    const restored = await restarted.getConversation(before.id);
    expect(restored?.messages).toEqual(before.messages);
    expect(restored?.contextCheckpoint).toEqual(committed.checkpoint);
    expect((await restarted.loadConversationWindow(before.id, 1))?.conversation.contextCheckpoint)
      .toEqual(committed.checkpoint);
  });

  test('commits a cross-Agent checkpoint and beginTurn in one journal revision', async () => {
    const { adapter, store } = await initialize();
    const first = beginInput('atomic-context-turn', 'claude-source');
    first.agentId = 'claude';
    first.userMessage.agentId = 'claude';
    first.assistantMessage.agentId = 'claude';
    await store.beginTurn(first);
    await store.finalizeTurn({
      conversationId: first.conversationId,
      turnId: first.turnId!,
      assistantPatch: { content: 'Claude completed the durable source turn.' },
    });
    const before = await store.getConversation(first.conversationId);
    if (!before) throw new Error('Expected completed source conversation.');
    const next = beginInput(first.conversationId, 'codex-target');
    next.contextCheckpointDraft = contextCheckpointDraft(before, 'atomic-context-checkpoint');
    next.expectedRevision = before.revision;

    const begun = await store.beginTurn(next);
    const after = await store.getConversation(first.conversationId);

    expect(begun).toMatchObject({ applied: true, revision: after?.revision });
    expect(after?.contextCheckpoint).toMatchObject({
      id: 'atomic-context-checkpoint',
      sourceRevision: before.revision,
      throughMessageId: before.messages.at(-1)?.id,
    });
    expect(after?.turns.at(-1)).toMatchObject({ id: 'codex-target', agentId: 'codex', state: 'active' });
    expect(after?.messages).toHaveLength(before.messages.length + 2);

    const atomicJournal = [...adapter.files.values()].find(raw => (
      raw.includes('atomic-context-checkpoint') && raw.includes('"type":"beginTurn"')
    ));
    expect(atomicJournal).toContain('"contextCheckpoint"');
    expect(atomicJournal).not.toContain('"type":"setContextCheckpoint"');

    await expect(store.beginTurn(next)).resolves.toMatchObject({
      applied: false,
      revision: begun.revision,
    });

    const checkpointed = await store.checkpointAssistantMessage({
      conversationId: first.conversationId,
      turnId: next.turnId!,
      messageId: next.assistantMessage.id,
      patch: { content: 'Codex streaming output remains patchable after the handoff.' },
    });
    expect(checkpointed).toMatchObject({ applied: true });
    const afterCheckpoint = await store.getConversation(first.conversationId);
    expect(afterCheckpoint?.messages.at(-1)?.content)
      .toBe('Codex streaming output remains patchable after the handoff.');
    expect(afterCheckpoint?.contextCheckpoint?.throughMessageSequence).toBe(before.messages.length);

    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'atomic-context-restart',
    });
    await expect(restarted.getConversation(first.conversationId)).resolves.toEqual(afterCheckpoint);
  });

  test('patches the canonical active tail after an earlier context checkpoint', async () => {
    const { store } = await initialize();
    const source = beginInput('prior-context-tail', 'prior-context-source');
    await store.beginTurn(source);
    await store.finalizeTurn({
      conversationId: source.conversationId,
      turnId: source.turnId!,
      assistantPatch: { content: 'The completed source remains immutable.' },
    });
    const before = await store.getConversation(source.conversationId);
    if (!before) throw new Error('Expected completed source conversation.');
    const committed = await store.commitContextCheckpoint({
      conversationId: before.id,
      checkpoint: contextCheckpointDraft(before, 'prior-context-checkpoint'),
      expectedRevision: before.revision,
    });

    const next = beginInput(source.conversationId, 'prior-context-next');
    await store.beginTurn(next);
    await expect(store.checkpointAssistantMessage({
      conversationId: source.conversationId,
      turnId: next.turnId!,
      messageId: next.assistantMessage.id,
      patch: { content: 'A new assistant tail is outside the immutable prefix.' },
    })).resolves.toMatchObject({ applied: true });

    const checkpointed = await store.getConversation(source.conversationId);
    expect(checkpointed?.contextCheckpoint).toEqual(committed.checkpoint);
    expect(checkpointed?.messages.at(-1)?.content)
      .toBe('A new assistant tail is outside the immutable prefix.');
    await store.finalizeTurn({
      conversationId: source.conversationId,
      turnId: next.turnId!,
    });
  });

  test('rolls back both checkpoint and turn when the planned source revision is stale', async () => {
    const { store } = await initialize();
    await store.beginTurn(beginInput('atomic-context-stale', 'source-turn'));
    await store.finalizeTurn({
      conversationId: 'atomic-context-stale',
      turnId: 'source-turn',
      assistantPatch: { content: 'Source completed.' },
    });
    const source = await store.getConversation('atomic-context-stale');
    if (!source) throw new Error('Expected source conversation.');
    const staleDraft = contextCheckpointDraft(source, 'stale-atomic-checkpoint');
    await store.appendMessage(source.id, message('intervening-note', 'assistant', 'Intervening durable write'));
    const beforeAttempt = await store.getConversation(source.id);
    const next = beginInput(source.id, 'stale-target-turn');
    next.contextCheckpointDraft = staleDraft;
    next.expectedRevision = staleDraft.sourceRevision;

    await expect(store.beginTurn(next)).rejects.toBeInstanceOf(ConversationRevisionConflictError);
    const afterAttempt = await store.getConversation(source.id);
    expect(afterAttempt).toEqual(beforeAttempt);
    expect(afterAttempt?.contextCheckpoint).toBeUndefined();
    expect(afterAttempt?.turns.some(turn => turn.id === 'stale-target-turn')).toBe(false);
  });

  test('rejects unfinished, stale, forged, and non-assistant context checkpoints', async () => {
    const { store } = await initialize();
    await store.beginTurn(beginInput('context-invalid', 'context-active'));
    const active = await store.getConversation('context-invalid');
    if (!active) throw new Error('Expected active conversation.');
    await expect(store.commitContextCheckpoint({
      conversationId: active.id,
      checkpoint: contextCheckpointDraft(active),
    })).rejects.toBeInstanceOf(ConversationTurnStateError);

    await store.finalizeTurn({
      conversationId: active.id,
      turnId: 'context-active',
      assistantPatch: { content: 'Done' },
    });
    const completed = await store.getConversation(active.id);
    if (!completed) throw new Error('Expected completed conversation.');
    await expect(store.commitContextCheckpoint({
      conversationId: completed.id,
      checkpoint: {
        ...contextCheckpointDraft(completed),
        sourceRevision: completed.revision - 1,
      },
    })).rejects.toBeInstanceOf(ConversationRevisionConflictError);
    await expect(store.commitContextCheckpoint({
      conversationId: completed.id,
      checkpoint: {
        ...contextCheckpointDraft(completed),
        throughMessageSequence: 1,
        throughMessageId: completed.messages[0].id,
      },
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
    await expect(store.commitContextCheckpoint({
      conversationId: completed.id,
      checkpoint: {
        ...contextCheckpointDraft(completed),
        prefixSha256: '0'.repeat(64),
      } as unknown as ConversationContextCheckpointDraft,
    })).rejects.toBeInstanceOf(ConversationStoreCorruptError);
    await expect(store.commitContextCheckpoint({
      conversationId: completed.id,
      checkpoint: {
        ...contextCheckpointDraft(completed),
        createdAt: '10',
      } as unknown as ConversationContextCheckpointDraft,
    })).rejects.toBeInstanceOf(ConversationStoreCorruptError);
    await expect(store.replaceConversation({
      ...completed,
      contextCheckpoint: {
        ...contextCheckpointDraft(completed),
        prefixSha256: '0'.repeat(64),
      },
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
  });

  test('recovers a durable context journal when snapshot compaction CAS fails', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('context-crash', 'context-crash-turn'));
    await store.finalizeTurn({
      conversationId: 'context-crash',
      turnId: 'context-crash-turn',
      assistantPatch: { content: 'Completed before compression' },
    });
    const before = await store.getConversation('context-crash');
    if (!before) throw new Error('Expected completed conversation.');
    const draft = contextCheckpointDraft(before, 'context-crash-checkpoint');
    const snapshotPath = [...adapter.files.keys()].find(path => path.endsWith('/snapshot.json'))!;
    const originalSnapshot = adapter.files.get(snapshotPath);
    let failed = false;
    adapter.beforeProcess = async path => {
      if (!failed && path === snapshotPath) {
        failed = true;
        throw new Error('simulated checkpoint snapshot CAS failure');
      }
    };

    await expect(store.commitContextCheckpoint({
      conversationId: before.id,
      checkpoint: draft,
    })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    expect(adapter.files.get(snapshotPath)).toBe(originalSnapshot);
    const journalRecovered = await store.getConversation(before.id);
    expect(journalRecovered?.contextCheckpoint?.id).toBe(draft.id);
    expect(journalRecovered?.messages).toEqual(before.messages);

    adapter.beforeProcess = null;
    const restarted = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'context-crash-restart',
    });
    const replay = await restarted.commitContextCheckpoint({
      conversationId: before.id,
      checkpoint: draft,
    });
    expect(replay.applied).toBe(false);
    expect((await restarted.getConversation(before.id))?.contextCheckpoint?.id).toBe(draft.id);
  });

  test('requires replacement checkpoints to extend the latest completed boundary', async () => {
    const { store } = await initialize();
    await store.beginTurn(beginInput('context-chain', 'context-chain-first'));
    await store.finalizeTurn({
      conversationId: 'context-chain',
      turnId: 'context-chain-first',
      assistantPatch: { content: 'First answer' },
    });
    const firstSource = await store.getConversation('context-chain');
    if (!firstSource) throw new Error('Expected first completed turn.');
    const first = await store.commitContextCheckpoint({
      conversationId: firstSource.id,
      checkpoint: contextCheckpointDraft(firstSource, 'context-chain-1'),
    });
    await store.beginTurn(beginInput('context-chain', 'context-chain-second'));
    await store.finalizeTurn({
      conversationId: 'context-chain',
      turnId: 'context-chain-second',
      assistantPatch: { content: 'Second answer' },
    });
    const secondSource = await store.getConversation('context-chain');
    if (!secondSource) throw new Error('Expected second completed turn.');
    await expect(store.commitContextCheckpoint({
      conversationId: secondSource.id,
      checkpoint: contextCheckpointDraft(secondSource, 'context-chain-2'),
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
    const second = await store.commitContextCheckpoint({
      conversationId: secondSource.id,
      checkpoint: contextCheckpointDraft(secondSource, 'context-chain-2', first.checkpoint.id),
    });
    expect(second.checkpoint.previousCheckpointId).toBe(first.checkpoint.id);
    expect(second.checkpoint.throughMessageSequence)
      .toBeGreaterThan(first.checkpoint.throughMessageSequence);
  });

  test('repairs a valid-but-stale catalog after body commit wins and catalog publish crashes', async () => {
    const { adapter, store } = await initialize();
    let catalogProcesses = 0;
    adapter.beforeProcess = async path => {
      if (path.endsWith('/catalog.json') && ++catalogProcesses === 2) {
        throw new Error('simulated catalog publish crash');
      }
    };
    await expect(store.beginTurn(beginInput('catalog-recovery', 'catalog-recovery-turn')))
      .rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    adapter.beforeProcess = null;

    const catalogPath = [...adapter.files.keys()].find(path => path.endsWith('/catalog.json'))!;
    const interruptedCatalog = JSON.parse(adapter.files.get(catalogPath)!) as {
      pendingMutations: unknown[];
    };
    expect(interruptedCatalog.pendingMutations).toHaveLength(1);
    const restarted = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'restarted-writer' });
    const summaries = await restarted.listConversationSummaries();
    expect(summaries.items.map(item => item.id)).toContain('catalog-recovery');
    expect((await restarted.getConversation('catalog-recovery'))?.messages).toHaveLength(2);
    const repairedCatalog = JSON.parse(adapter.files.get(catalogPath)!) as {
      pendingMutations: unknown[];
    };
    expect(repairedCatalog.pendingMutations).toEqual([]);
    expect(adapter.removed).toEqual([]);
  });

  test('fails closed on pointer/manifest corruption and never falls back to intact v1 bytes', async () => {
    const adapter = new V2MemoryAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.beginTurn(beginInput('pointer-corrupt', 'pointer-turn', 'queued'));
    const originalV1 = adapter.files.get(STORAGE_IDS.conversationsPath)!;
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    const manifestPath = [...adapter.files.keys()].find(path => path.endsWith('/manifest.json'))!;
    adapter.files.set(manifestPath, `${adapter.files.get(manifestPath)!} `);
    await expect(store.listConversations()).rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect((await store.getConversationStoreStatus()).backend).toBe('invalid');
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(originalV1);
  });

  test('persists active checkpoint and maps queued/active turns on restart recovery', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('active-conversation', 'active-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'active-conversation', turnId: 'active-turn',
      messageId: 'active-turn-assistant', patch: { content: 'durable partial' },
    });
    await store.beginTurn(beginInput('queued-conversation', 'queued-turn', 'queued'));
    const restarted = new VaultStore(adapter as unknown as DataAdapter);
    const recovery = await restarted.recoverInterruptedTurns();
    expect(recovery.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'active-conversation', to: 'interrupted' }),
      expect.objectContaining({ conversationId: 'queued-conversation', to: 'paused' }),
    ]));
    const active = await restarted.getConversation('active-conversation');
    expect(active?.messages.at(-1)).toMatchObject({ role: 'error' });
    expect(active?.messages.at(-1)?.content).toContain('durable partial');
    expect(active?.messages.at(-1)?.content).toContain('上次任务因插件重启而中断');
  });

  test('reads only intersecting snapshot chunks for a bounded message window and overlays checkpoints', async () => {
    const conversations: VersionedStoredConversation[] = [{
      id: 'large', title: 'Large', agentId: 'codex', createdAt: 1, updatedAt: 2,
      revision: 1, turns: [],
      messages: Array.from({ length: 1_050 }, (_, index) => (
        message(`message-${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `body-${index + 1}`)
      )),
    }];
    const raw = `${JSON.stringify({
      version: 1, revision: 1, nextQueueSequence: 1, conversations,
    }, null, 2)}\n`;
    const adapter = new V2MemoryAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    adapter.resetReads();
    const window = await store.loadConversationWindow('large', 100);
    expect(window?.conversation.messages).toHaveLength(100);
    expect(window?.conversation.messages[0].id).toBe('message-951');
    const chunkReads = [...adapter.reads.entries()].filter(([path]) => path.includes('/messages/chunk-'));
    expect(chunkReads).toHaveLength(2);
    expect(chunkReads.some(([path]) => path.includes('00000901'))).toBe(true);
    expect(chunkReads.some(([path]) => path.includes('00001001'))).toBe(true);

    adapter.resetReads();
    const page = await store.loadMessages('large', 951, 100);
    expect(page.messages[0].sequence).toBe(851);
    expect(page.messages.at(-1)?.sequence).toBe(950);
    const earlierChunkReads = [...adapter.reads.keys()].filter(path => path.includes('/messages/chunk-'));
    expect(earlierChunkReads).toHaveLength(2);
    expect(earlierChunkReads.some(path => path.includes('00000001'))).toBe(false);

    await store.beginTurn(beginInput('large', 'streaming-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'large',
      turnId: 'streaming-turn',
      messageId: 'streaming-turn-assistant',
      patch: { content: 'latest complete checkpoint' },
    });
    adapter.resetReads();
    const streamingWindow = await store.loadConversationWindow('large', 100);
    expect(streamingWindow?.conversation.messages.at(-1)?.content).toBe('latest complete checkpoint');
    expect([...adapter.reads.keys()].filter(path => path.includes('/messages/chunk-'))).toHaveLength(2);
    expect([...adapter.reads.keys()].some(path => path.includes('00000001'))).toBe(false);
  });

  test('validates skipped journal messages and rejects malformed metadata with recomputed checksums', async () => {
    const conversations: VersionedStoredConversation[] = [{
      id: 'skipped-journal', title: 'Skipped journal', agentId: 'codex', createdAt: 1, updatedAt: 2,
      revision: 1, turns: [],
      messages: Array.from({ length: 150 }, (_, index) => (
        message(`history-${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `body-${index + 1}`)
      )),
    }];
    const adapter = new V2MemoryAdapter({
      [STORAGE_IDS.conversationsPath]: `${JSON.stringify({
        version: 1, revision: 1, nextQueueSequence: 1, conversations,
      }, null, 2)}\n`,
    });
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });
    await store.beginTurn(beginInput('skipped-journal', 'skipped-turn'));

    // A valid legacy/migrated body and journal still support a window that does
    // not include the newly appended turn.
    const legacyWindow = await store.loadMessages('skipped-journal', 51, 50);
    expect(legacyWindow.messages).toHaveLength(50);
    expect(legacyWindow.messages[0].sequence).toBe(1);

    const journalPath = [...adapter.files.keys()].find(path => (
      path.includes('/journals/') && path.endsWith('.jsonl')
    ))!;
    const record = JSON.parse(adapter.files.get(journalPath)!.trim()) as Record<string, unknown>;
    const event = record.event as Record<string, unknown>;
    const userMessage = event.userMessage as Record<string, unknown>;
    userMessage.metadata = {
      artifacts: [{
        id: 'escaped-image',
        type: 'image',
        vaultPath: '../outside.png',
        mimeType: 'image/png',
        createdAt: 3,
      }],
    };
    const tamperedRecord = withRecomputedChecksum(record);
    adapter.files.set(journalPath, `${JSON.stringify(tamperedRecord)}\n`);

    const runStatePath = [...adapter.files.keys()].find(path => path.endsWith('/run-state.json'))!;
    const runState = JSON.parse(adapter.files.get(runStatePath)!) as Record<string, unknown>;
    runState.headChecksum = tamperedRecord.checksum;
    adapter.files.set(
      runStatePath,
      `${JSON.stringify(withRecomputedChecksum(runState), null, 2)}\n`,
    );

    await expect(store.loadMessages('skipped-journal', 51, 50))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
  });

  test('rejects an extra snapshot descriptor outside the requested window', async () => {
    const conversations: VersionedStoredConversation[] = [{
      id: 'extra-descriptor', title: 'Extra descriptor', agentId: 'codex', createdAt: 1, updatedAt: 2,
      revision: 1, turns: [],
      messages: Array.from({ length: 150 }, (_, index) => (
        message(`descriptor-${index + 1}`, index % 2 === 0 ? 'user' : 'assistant', `body-${index + 1}`)
      )),
    }];
    const adapter = new V2MemoryAdapter({
      [STORAGE_IDS.conversationsPath]: `${JSON.stringify({
        version: 1, revision: 1, nextQueueSequence: 1, conversations,
      }, null, 2)}\n`,
    });
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) });

    const snapshotPath = [...adapter.files.keys()].find(path => path.endsWith('/snapshot.json'))!;
    const snapshot = JSON.parse(adapter.files.get(snapshotPath)!) as Record<string, unknown>;
    const chunks = snapshot.chunks as Array<Record<string, unknown>>;
    chunks.push({
      path: 'messages/extra.json',
      startSequence: 151,
      endSequence: 151,
      count: 1,
      hash: 'a'.repeat(64),
    });
    adapter.files.set(
      snapshotPath,
      `${JSON.stringify(withRecomputedChecksum(snapshot), null, 2)}\n`,
    );

    await expect(store.loadMessages('extra-descriptor', 51, 50))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
  });

  test('rebuilds a corrupt catalog from bodies without losing conversations', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('repair-a', 'repair-a-turn'));
    await store.beginTurn(beginInput('repair-b', 'repair-b-turn'));
    const catalogPath = [...adapter.files.keys()].find(path => path.endsWith('/catalog.json'))!;
    const metaPath = [...adapter.files.keys()].find(path => path.endsWith('/meta.json'))!;
    adapter.files.set(catalogPath, '{corrupt');
    adapter.files.set(metaPath, '{corrupt-meta');
    const report = await store.rebuildCatalog();
    expect(report.conversationCount).toBe(2);
    expect((await store.listConversationSummaries()).items.map(item => item.id).sort())
      .toEqual(['repair-a', 'repair-b']);
  });

  test('fails closed on a complete corrupt journal middle line', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('corrupt-journal', 'corrupt-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'corrupt-journal', turnId: 'corrupt-turn',
      messageId: 'corrupt-turn-assistant', patch: { content: 'partial' },
    });
    const journalPath = [...adapter.files.keys()].find(path => (
      path.includes('/journals/') && path.endsWith('.jsonl')
    ))!;
    const current = adapter.files.get(journalPath)!;
    adapter.files.set(journalPath, `${current.split('\n')[0]}\n{broken}\n${current.split('\n').slice(1).join('\n')}`);
    await expect(store.getConversation('corrupt-journal'))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
  });

  test('accepts only an unfinished final JSONL tail, retires it, and preserves the last checkpoint', async () => {
    const { adapter, store } = await initialize();
    await store.beginTurn(beginInput('tail-recovery', 'tail-turn'));
    await store.checkpointAssistantMessage({
      conversationId: 'tail-recovery', turnId: 'tail-turn',
      messageId: 'tail-turn-assistant', patch: { content: 'checkpoint one' },
    });
    const firstJournal = [...adapter.files.keys()].find(path => (
      path.includes('/journals/') && path.endsWith('.jsonl')
    ))!;
    adapter.files.set(firstJournal, `${adapter.files.get(firstJournal)!}{"unfinished"`);
    expect((await store.getConversation('tail-recovery'))?.messages.at(-1)?.content)
      .toBe('checkpoint one');

    await store.checkpointAssistantMessage({
      conversationId: 'tail-recovery', turnId: 'tail-turn',
      messageId: 'tail-turn-assistant', patch: { content: 'checkpoint two' },
    });
    expect((await store.getConversation('tail-recovery'))?.messages.at(-1)?.content)
      .toBe('checkpoint two');
    expect(adapter.files.get(firstJournal)).toContain('{"unfinished"');
    expect([...adapter.files.keys()].filter(path => (
      path.includes('/journals/') && path.endsWith('.jsonl')
    )).length).toBeGreaterThanOrEqual(2);
    expect(adapter.removed).toEqual([]);
  });
});
