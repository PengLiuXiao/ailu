import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as setNodeTimeout } from 'timers';

import type { DataAdapter } from 'obsidian';

import { STORAGE_IDS } from '../src/ids';
import {
  CHAT_STORE_LEASE_PATH,
  ChatStoreLease,
  ChatStoreLeaseCorruptError,
} from '../src/storage/chatStoreLease';
import {
  createAiluProcessWriteLock,
  PythonFcntlProcessWriteLock,
  type ProcessWriteLock,
  type ProcessWriteLockCasResult,
} from '../src/storage/processWriteLock';
import {
  ConversationRevisionConflictError,
  ConversationSessionConflictError,
  ConversationStoreAtomicWriteError,
  ConversationStoreCorruptError,
  ConversationStoreMigrationError,
  ConversationStoreReadOnlyError,
  ConversationTurnStateError,
  VaultStore,
  type BeginTurnInput,
  type ConversationRuntimeSnapshot,
} from '../src/storage/vaultStore';
import type { AgentId, ChatMessage } from '../src/types';

const RUNTIME: ConversationRuntimeSnapshot = {
  configSource: 'localCli',
  model: 'test-model',
  reasoningEffort: 'high',
  planMode: false,
  fullAccess: true,
};

class MemoryDataAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly binaries = new Map<string, ArrayBuffer>();
  readonly removed: string[] = [];
  failRename = false;
  failConversationProcess = false;
  corruptNextConversationTemp = false;
  conversationTempWrites = 0;
  beforeConversationProcess: (() => Promise<void>) | null = null;

  private readonly processTails = new Map<string, Promise<void>>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, value] of Object.entries(initial)) this.files.set(path, value);
  }

  async exists(target: string): Promise<boolean> {
    return this.files.has(target) || this.directories.has(target) || this.binaries.has(target);
  }

  async mkdir(target: string): Promise<void> {
    this.directories.add(target);
  }

  async read(target: string): Promise<string> {
    const value = this.files.get(target);
    if (value === undefined) throw new Error(`Missing ${target}`);
    return value;
  }

  async write(target: string, value: string): Promise<void> {
    if (target.includes('conversations.json.') && target.endsWith('.tmp')) {
      this.conversationTempWrites += 1;
      if (this.corruptNextConversationTemp) {
        this.corruptNextConversationTemp = false;
        this.files.set(target, '{corrupt-stage');
        return;
      }
      // Force concurrent callers to overlap if VaultStore fails to serialize.
      await Promise.resolve();
    }
    this.files.set(target, value);
  }

  async writeBinary(target: string, value: ArrayBuffer): Promise<void> {
    this.binaries.set(target, value);
  }

  async rename(source: string, target: string): Promise<void> {
    if (this.failRename) throw new Error('simulated rename failure');
    const value = this.files.get(source);
    if (value === undefined) throw new Error(`Missing rename source ${source}`);
    this.files.set(target, value);
    this.files.delete(source);
  }

  async copy(source: string, target: string): Promise<void> {
    if (this.files.has(target)) throw new Error(`Copy target exists: ${target}`);
    const value = this.files.get(source);
    if (value === undefined) throw new Error(`Missing copy source ${source}`);
    this.files.set(target, value);
  }

  async process(target: string, update: (value: string) => string): Promise<string> {
    if (target === STORAGE_IDS.conversationsPath) {
      await this.beforeConversationProcess?.();
      if (this.failConversationProcess) throw new Error('simulated CAS failure');
    }
    const previous = this.processTails.get(target) ?? Promise.resolve();
    let result = '';
    const operation = previous.then(async () => {
      const current = await this.read(target);
      result = update(current);
      this.files.set(target, result);
    });
    this.processTails.set(target, operation.then(() => undefined, () => undefined));
    await operation;
    return result;
  }

  async remove(target: string): Promise<void> {
    this.removed.push(target);
    throw new Error('Tests prohibit direct file deletion.');
  }

  getResourcePath(target: string): string {
    return `app://vault/${target}`;
  }
}

class FilesystemDataAdapter {
  processCalls = 0;

  constructor(private readonly root: string) {}

  async exists(target: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(target));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(target: string): Promise<void> {
    await fs.mkdir(this.resolve(target), { recursive: true });
  }

  async read(target: string): Promise<string> {
    return fs.readFile(this.resolve(target), 'utf8');
  }

  async write(target: string, value: string): Promise<void> {
    const resolved = this.resolve(target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, value, 'utf8');
  }

  async copy(source: string, target: string): Promise<void> {
    const resolvedTarget = this.resolve(target);
    await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
    await fs.copyFile(this.resolve(source), resolvedTarget, fsConstants.COPYFILE_EXCL);
  }

  async process(_target: string, _update: (value: string) => string): Promise<string> {
    this.processCalls += 1;
    throw new Error('Physical lease tests must not fall back to DataAdapter.process().');
  }

  async remove(_target: string): Promise<void> {
    throw new Error('Tests prohibit direct file deletion.');
  }

  getResourcePath(target: string): string {
    return `file://${this.resolve(target)}`;
  }

  private resolve(target: string): string {
    const resolved = path.resolve(this.root, target);
    const relative = path.relative(this.root, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Path escapes physical test vault: ${target}`);
    }
    return resolved;
  }
}

class CrashablePhysicalLock implements ProcessWriteLock {
  held = false;
  crashNextRepositoryCas = false;

  constructor(private readonly adapter: MemoryDataAdapter) {}

  async acquire(): Promise<boolean> {
    this.held = true;
    return true;
  }

  async assertHeld(): Promise<void> {
    if (!this.held) throw new Error('simulated helper is no longer held');
  }

  async readTextFile(target: string): Promise<string | null> {
    await this.assertHeld();
    return this.adapter.files.get(target) ?? null;
  }

  async compareAndSwapTextFile(
    target: string,
    expected: string | null,
    replacement: string,
  ): Promise<ProcessWriteLockCasResult> {
    await this.assertHeld();
    if (this.crashNextRepositoryCas && target !== CHAT_STORE_LEASE_PATH) {
      this.crashNextRepositoryCas = false;
      this.held = false;
      throw new Error('simulated helper crash during final CAS');
    }
    const current = this.adapter.files.get(target) ?? null;
    if (current !== expected) return { swapped: false, value: current };
    this.adapter.files.set(target, replacement);
    return { swapped: true, value: replacement };
  }

  async release(): Promise<void> {
    this.held = false;
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setNodeTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function userMessage(id: string, content = id, agentId: AgentId = 'codex'): ChatMessage {
  return { id, role: 'user', content, createdAt: 1, agentId };
}

function assistantMessage(id: string, agentId: AgentId = 'codex'): ChatMessage {
  return { id, role: 'assistant', content: '', createdAt: 1, agentId };
}

function beginInput(
  conversationId: string,
  turnId: string,
  state: BeginTurnInput['initialState'] = 'active',
): BeginTurnInput {
  return {
    conversationId,
    turnId,
    agentId: 'codex',
    userMessage: userMessage(`${turnId}-user`, `Prompt ${turnId}`),
    assistantMessage: assistantMessage(`${turnId}-assistant`),
    runtime: RUNTIME,
    initialState: state,
  };
}

describe('VaultStore conversation repository', () => {
  test('keeps unleased compatibility writes off the physical helper capability', async () => {
    const adapter = new MemoryDataAdapter();
    const processLock = new CrashablePhysicalLock(adapter);
    processLock.crashNextRepositoryCas = true;
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'unleased-compatibility',
      processWriteLock: processLock,
    });

    await store.ensureV2Store();
    await store.beginTurn(beginInput('unleased', 'unleased-turn'));
    expect(await store.getConversation('unleased')).not.toBeNull();
    expect(processLock.held).toBe(false);
    expect(processLock.crashNextRepositoryCas).toBe(true);
  });

  test('migrates an escape-dense v1 store whose legacy JSON CAS frame exceeded 64 MiB', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-v2-escape-dense-'));
    const adapter = new FilesystemDataAdapter(vaultRoot);
    const mebibyte = 1_024 * 1_024;
    const content = '"'.repeat(Math.floor(3.3 * mebibyte));
    const raw = `${JSON.stringify({
      version: 1,
      revision: 0,
      nextQueueSequence: 1,
      conversations: [{
        id: 'escape-dense-migration',
        title: 'Escape dense migration',
        agentId: 'codex',
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
        turns: [],
        messages: Array.from({ length: 5 }, (_, index) => ({
          id: `escape-dense-message-${index + 1}`,
          role: 'assistant',
          content,
          createdAt: index + 1,
          agentId: 'codex',
        })),
      }],
    }, null, 2)}\n`;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(64 * mebibyte);
    expect(Buffer.byteLength(JSON.stringify({
      id: 'legacy-frame',
      op: 'cas',
      path: '.ailu/rollback.json',
      expected: null,
      replacement: raw,
    }), 'utf8')).toBeGreaterThan(64 * mebibyte);
    await adapter.write(STORAGE_IDS.conversationsPath, raw);

    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'escape-dense-migration',
      requireWriteLease: true,
      vaultBasePath: vaultRoot,
    });
    await expect(store.acquireWriteLease({ startHeartbeat: false }))
      .resolves.toMatchObject({ mode: 'writer' });
    try {
      await expect(store.ensureV2Store({
        quiescenceBarrier: async () => ({ activeRuns: 0 }),
      })).resolves.toMatchObject({
        status: 'migrated-v1',
        conversationCount: 1,
        messageCount: 5,
        pointerSwitched: true,
      });
      const status = await store.getConversationStoreStatus();
      expect(status.generationPath).not.toBeNull();
      const rollback = await adapter.read(
        `${status.generationPath}/rollback/conversations.v1.json`,
      );
      expect(Buffer.byteLength(rollback, 'utf8')).toBe(Buffer.byteLength(raw, 'utf8'));
      expect(createHash('sha256').update(rollback).digest('hex'))
        .toBe(createHash('sha256').update(raw).digest('hex'));
      const migrated = await store.getConversation('escape-dense-migration');
      expect(migrated?.messages).toHaveLength(5);
      expect(createHash('sha256').update(migrated!.messages[0].content).digest('hex'))
        .toBe(createHash('sha256').update(content).digest('hex'));
      expect(adapter.processCalls).toBe(0);
    } finally {
      await store.releaseWriteLease();
    }
  }, 60_000);

  test('treats only a missing conversations.json as an empty legacy-compatible store', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    expect(await store.listConversations()).toEqual([]);

    adapter.files.set(STORAGE_IDS.conversationsPath, JSON.stringify({
      version: 1,
      conversations: [{
        id: 'legacy',
        title: 'Legacy',
        agentId: 'claude',
        createdAt: 1,
        updatedAt: 2,
        messages: [userMessage('legacy-message', 'old', 'claude')],
      }],
    }));
    await expect(store.getConversation('legacy')).resolves.toMatchObject({
      id: 'legacy',
      revision: 0,
      turns: [],
    });
  });

  test.each([
    '',
    '{broken',
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, conversations: {} }),
    JSON.stringify({ version: 1, conversations: [{ id: 'incomplete' }] }),
  ])('fails closed for an existing corrupt store', async raw => {
    const adapter = new MemoryDataAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);

    await expect(store.listConversations()).rejects.toBeInstanceOf(ConversationStoreCorruptError);
    await expect(store.appendMessage('new', userMessage('new-message')))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(raw);
  });

  test('fails closed when a legacy context checkpoint is forged or bound to the wrong prefix', async () => {
    const messages = [
      userMessage('legacy-context-user', 'Question'),
      { ...assistantMessage('legacy-context-assistant'), content: 'Answer' },
    ];
    const base = {
      id: 'legacy-context',
      title: 'Legacy context',
      agentId: 'codex',
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
      turns: [{
        id: 'legacy-context-turn',
        agentId: 'codex',
        userMessageId: 'legacy-context-user',
        assistantMessageId: 'legacy-context-assistant',
        state: 'completed',
        queueSequence: 1,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }],
      messages,
      contextCheckpoint: {
        version: 1,
        id: 'legacy-checkpoint',
        createdAt: 2,
        sourceRevision: 1,
        throughMessageSequence: 2,
        throughMessageId: 'legacy-context-assistant',
        prefixSha256: '0'.repeat(64),
        projectionVersion: 1,
        summary: {
          facts: [], decisions: [], userPreferences: [], constraints: [],
          openLoops: [], filesMentioned: [], lastIntent: 'Continue.',
        },
        createdBy: 'local',
      },
    };
    const raw = JSON.stringify({
      version: 1,
      revision: 2,
      nextQueueSequence: 2,
      conversations: [base],
    });
    const adapter = new MemoryDataAdapter({ [STORAGE_IDS.conversationsPath]: raw });
    const store = new VaultStore(adapter as unknown as DataAdapter);

    await expect(store.listConversations()).rejects.toBeInstanceOf(ConversationStoreCorruptError);
    await expect(store.ensureV2Store({ quiescenceBarrier: async () => ({ activeRuns: 0 }) }))
      .rejects.toBeInstanceOf(ConversationStoreCorruptError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(raw);
  });

  test('serializes concurrent conversation mutations without losing data', async () => {
    let now = 100;
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, { now: () => now++ });

    const [first, second] = await Promise.all([
      store.beginTurn(beginInput('conversation-a', 'turn-a')),
      store.beginTurn(beginInput('conversation-b', 'turn-b')),
    ]);

    expect([first.turn.queueSequence, second.turn.queueSequence].sort()).toEqual([1, 2]);
    const conversations = await new VaultStore(adapter as unknown as DataAdapter).listConversations();
    expect(conversations.map(item => item.id).sort()).toEqual(['conversation-a', 'conversation-b']);
    expect(conversations.map(item => item.revision).sort()).toEqual([1, 2]);
    expect(adapter.conversationTempWrites).toBe(2);
  });

  test('never physically deletes a legacy conversation and requires v2 archive semantics', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.beginTurn(beginInput('preserved', 'preserved-turn'));
    const original = adapter.files.get(STORAGE_IDS.conversationsPath);

    await expect(store.deleteConversation('preserved'))
      .rejects.toBeInstanceOf(ConversationStoreMigrationError);
    await expect(store.deleteConversation('missing')).resolves.toBeUndefined();
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);
    expect(adapter.removed).toEqual([]);
  });

  test('allocates revisions transactionally and rejects stale non-idempotent writes', async () => {
    const store = new VaultStore(new MemoryDataAdapter() as unknown as DataAdapter);
    const input = beginInput('conversation', 'turn');
    const begun = await store.beginTurn(input);
    const replay = await store.beginTurn({ ...input, expectedRevision: 0 });
    expect(replay.applied).toBe(false);
    expect(replay.revision).toBe(begun.revision);
    expect(replay.turn.queueSequence).toBe(begun.turn.queueSequence);

    const patched = await store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'partial' },
    });
    const patchReplay = await store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'partial' },
    });
    expect(patchReplay.applied).toBe(false);
    expect(patchReplay.revision).toBe(patched.revision);

    await expect(store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'stale replacement' },
    })).rejects.toBeInstanceOf(ConversationRevisionConflictError);
    expect((await store.getConversation('conversation'))?.messages.at(-1)?.content).toBe('partial');
  });

  test('patches runtime session state incrementally without overwriting messages', async () => {
    const store = new VaultStore(new MemoryDataAdapter() as unknown as DataAdapter);
    const begun = await store.beginTurn(beginInput('conversation', 'turn'));
    const patched = await store.patchSession({
      conversationId: 'conversation',
      turnId: 'turn',
      agentId: 'codex',
      sessionId: 'session-1',
      configKey: 'safe-fingerprint',
      expectedRevision: begun.revision,
    });
    expect(patched.applied).toBe(true);
    const persisted = await store.getConversation('conversation');
    expect(persisted?.sessionIds?.codex).toBe('session-1');
    expect(persisted?.sessionConfigKeys?.codex).toBe('safe-fingerprint');
    expect(persisted?.messages).toHaveLength(2);
  });

  test('atomically rejects duplicate session ownership across conversations and agents', async () => {
    const store = new VaultStore(new MemoryDataAdapter() as unknown as DataAdapter);
    await store.beginTurn(beginInput('first-conversation', 'first-turn'));
    await store.beginTurn(beginInput('second-conversation', 'second-turn'));
    await store.patchSession({
      conversationId: 'first-conversation',
      turnId: 'first-turn',
      agentId: 'codex',
      sessionId: 'shared-session',
    });

    await expect(store.patchSession({
      conversationId: 'second-conversation',
      turnId: 'second-turn',
      agentId: 'codex',
      sessionId: 'shared-session',
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
    await expect(store.patchSession({
      conversationId: 'first-conversation',
      turnId: 'first-turn',
      agentId: 'claude',
      sessionId: 'shared-session',
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
    expect((await store.getConversation('second-conversation'))?.sessionIds).toBeUndefined();
  });

  test('claims v1 session ownership atomically with structured owner diagnostics', async () => {
    const store = new VaultStore(new MemoryDataAdapter() as unknown as DataAdapter);
    await store.beginTurn(beginInput('owner', 'owner-turn'));
    await store.beginTurn(beginInput('contender', 'contender-turn'));
    const claimed = await store.claimSessionOwnership({
      conversationId: 'owner', agentId: 'codex', sessionId: 'runtime-session', runId: 'owner-turn',
    });
    const replay = await store.claimSessionOwnership({
      conversationId: 'owner', agentId: 'codex', sessionId: 'runtime-session', runId: 'owner-turn',
    });
    expect(claimed.applied).toBe(true);
    expect(replay.applied).toBe(false);

    await store.finalizeTurn({ conversationId: 'owner', turnId: 'owner-turn' });
    await store.beginTurn(beginInput('owner', 'owner-turn-2'));
    const resumed = await store.claimSessionOwnership({
      conversationId: 'owner', agentId: 'codex', sessionId: 'runtime-session', runId: 'owner-turn-2',
    });
    const patched = await store.patchSession({
      conversationId: 'owner', turnId: 'owner-turn-2', agentId: 'codex',
      sessionId: 'runtime-session', configKey: 'resume-config',
    });
    expect(resumed.applied).toBe(true);
    expect(patched.applied).toBe(true);
    const persisted = await store.getConversation('owner');
    expect(persisted?.sessionOwnerships?.codex?.runId).toBe('owner-turn-2');
    expect(persisted?.sessionConfigKeys?.codex).toBe('resume-config');

    let conflict: unknown;
    try {
      await store.claimSessionOwnership({
        conversationId: 'contender',
        agentId: 'codex',
        sessionId: 'runtime-session',
        runId: 'contender-turn',
      });
    } catch (error) {
      conflict = error;
    }
    if (!(conflict instanceof ConversationSessionConflictError)) throw conflict;
    expect(conflict.existingOwner).toMatchObject({
      sessionId: 'runtime-session',
      conversationId: 'owner',
      agentId: 'codex',
      runId: 'owner-turn-2',
    });
  });

  test('stages, validates, and renames atomically while preserving the previous file on failure', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter, { instanceId: 'atomic-test' });
    const begun = await store.beginTurn(beginInput('conversation', 'turn'));
    const original = adapter.files.get(STORAGE_IDS.conversationsPath);

    adapter.failConversationProcess = true;
    await expect(store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'must not replace the durable file' },
    })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);

    adapter.failConversationProcess = false;
    adapter.corruptNextConversationTemp = true;
    await expect(store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'corrupt stage' },
    })).rejects.toBeInstanceOf(ConversationStoreAtomicWriteError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toBe(original);

    await store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'committed' },
    });
    expect(adapter.files.get(STORAGE_IDS.conversationsPath)).toContain('committed');
    expect([...adapter.files.keys()].some(path => path.endsWith('.tmp'))).toBe(true);
    expect(adapter.removed).toEqual([]);
  });

  test('makes cancellation terminal before late completion and rejects late stream patches', async () => {
    const store = new VaultStore(new MemoryDataAdapter() as unknown as DataAdapter);
    await store.beginTurn(beginInput('conversation', 'turn'));
    await store.requestTurnCancellation({ conversationId: 'conversation', turnId: 'turn' });

    const lateFinalize = await store.finalizeTurn({
      conversationId: 'conversation',
      turnId: 'turn',
      assistantPatch: { content: 'late success' },
    });
    expect(lateFinalize.applied).toBe(false);
    expect(lateFinalize.turn.state).toBe('cancelRequested');

    const cancelled = await store.cancelTurn({
      conversationId: 'conversation',
      turnId: 'turn',
      assistantPatch: { content: '当前任务已取消' },
    });
    expect(cancelled.turn.state).toBe('cancelled');
    await expect(store.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      patch: { content: 'late delta' },
    })).rejects.toBeInstanceOf(ConversationTurnStateError);
  });

  test('recovers active work as interrupted and queued work as paused exactly once', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    await store.beginTurn(beginInput('active-conversation', 'active-turn'));
    await store.beginTurn(beginInput('queued-conversation', 'queued-turn', 'queued'));
    await store.requestTurnCancellation({
      conversationId: 'active-conversation',
      turnId: 'active-turn',
    });

    const restarted = new VaultStore(adapter as unknown as DataAdapter);
    const recovered = await restarted.recoverInterruptedTurns();
    expect(recovered.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 'active-turn', from: 'cancelRequested', to: 'interrupted' }),
      expect.objectContaining({ turnId: 'queued-turn', from: 'queued', to: 'paused' }),
    ]));
    const active = await restarted.getConversation('active-conversation');
    expect(active?.turns[0]?.state).toBe('interrupted');
    expect(active?.messages.at(-1)?.role).toBe('error');
    expect(active?.messages.at(-1)?.content).toContain('上次任务因插件重启而中断');
    const queued = await restarted.getConversation('queued-conversation');
    expect(queued?.turns[0]?.state).toBe('paused');
    expect(queued?.messages.at(-1)?.content).toBe('');
    expect((await restarted.recoverInterruptedTurns()).applied).toBe(false);
  });

  test('persists only the bounded non-secret runtime snapshot whitelist', async () => {
    const adapter = new MemoryDataAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);
    const runtimeWithForbiddenExtras = {
      ...RUNTIME,
      providerProfileId: 'profile-1',
      prompt: 'must-not-persist',
      systemPrompt: 'must-not-persist',
      attachments: [{ absolutePath: '/secret/path' }],
      apiKey: 'secret',
    } as ConversationRuntimeSnapshot;
    await store.beginTurn({ ...beginInput('conversation', 'turn'), runtime: runtimeWithForbiddenExtras });
    const raw = adapter.files.get(STORAGE_IDS.conversationsPath) ?? '';
    expect(raw).toContain('profile-1');
    expect(raw).not.toContain('must-not-persist');
    expect(raw).not.toContain('/secret/path');
    expect(raw).not.toContain('apiKey');
  });
});

describe('VaultStore writer lease', () => {
  test('notifies lease loss in the same mutation when the physical CAS helper dies', async () => {
    const adapter = new MemoryDataAdapter();
    const processLock = new CrashablePhysicalLock(adapter);
    const leaseLosses: Error[] = [];
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'cas-crash',
      requireWriteLease: true,
      processWriteLock: processLock,
      onWriteLeaseLost: error => leaseLosses.push(error),
    });
    await store.acquireWriteLease({ startHeartbeat: false });
    await store.ensureV2Store();
    processLock.crashNextRepositoryCas = true;

    await expect(store.beginTurn(beginInput('cas-crash-conversation', 'cas-crash-turn')))
      .rejects.toThrow('simulated helper crash during final CAS');
    expect(leaseLosses).toHaveLength(1);
    expect(leaseLosses[0]?.message).toContain('simulated helper crash during final CAS');
  });

  test('notifies central lease loss exactly once from the first protected mutation', async () => {
    let now = 20_000;
    const adapter = new MemoryDataAdapter();
    const leaseLosses: Error[] = [];
    const oldWriter = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'loss-old',
      ttlMs: 1_000,
      now: () => now,
      requireWriteLease: true,
      onWriteLeaseLost: error => leaseLosses.push(error),
    });
    await oldWriter.acquireWriteLease({ startHeartbeat: false });
    await oldWriter.beginTurn(beginInput('lease-loss', 'lease-loss-turn'));

    now += 1_001;
    const newWriter = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'loss-new',
      ttlMs: 1_000,
      now: () => now,
      requireWriteLease: true,
    });
    expect((await newWriter.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');

    await expect(oldWriter.checkpointAssistantMessage({
      conversationId: 'lease-loss',
      turnId: 'lease-loss-turn',
      messageId: 'lease-loss-turn-assistant',
      patch: { content: 'must not persist' },
    })).rejects.toBeInstanceOf(ConversationStoreReadOnlyError);
    expect(leaseLosses).toHaveLength(1);
    await expect(oldWriter.beginTurn(beginInput('lease-loss-two', 'lease-loss-two-turn')))
      .rejects.toBeInstanceOf(ConversationStoreReadOnlyError);
    expect(leaseLosses).toHaveLength(1);
  });

  test('target revision CAS blocks a stale writer that resumes after lease takeover', async () => {
    let now = 10_000;
    const adapter = new MemoryDataAdapter();
    const first = new VaultStore(adapter as unknown as DataAdapter, {
      requireWriteLease: true,
      instanceId: 'stale-first',
      pid: 101,
      ttlMs: 3_000,
      now: () => now,
    });
    const second = new VaultStore(adapter as unknown as DataAdapter, {
      requireWriteLease: true,
      instanceId: 'takeover-second',
      pid: 202,
      ttlMs: 3_000,
      now: () => now,
    });
    await first.acquireWriteLease({ startHeartbeat: false });
    const begun = await first.beginTurn(beginInput('conversation', 'turn'));

    let signalEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let shouldBlock = true;
    adapter.beforeConversationProcess = async () => {
      if (!shouldBlock) return;
      shouldBlock = false;
      signalEntered();
      await gate;
    };

    const staleWrite = first.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'stale writer content' },
    });
    await entered;
    now = 13_001;
    expect((await second.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    await second.patchMessage({
      conversationId: 'conversation',
      turnId: 'turn',
      messageId: 'turn-assistant',
      expectedRevision: begun.revision,
      patch: { content: 'new writer content' },
    });
    releaseFirst();

    await expect(staleWrite).rejects.toThrow('revision CAS failed');
    expect((await second.getConversation('conversation'))?.messages.at(-1)?.content)
      .toBe('new writer content');
  });

  test('elects one same-machine writer and keeps the second instance read-only', async () => {
    let now = 10_000;
    const adapter = new MemoryDataAdapter();
    const first = new VaultStore(adapter as unknown as DataAdapter, {
      requireWriteLease: true,
      instanceId: 'first-instance',
      pid: 101,
      ttlMs: 3_000,
      now: () => now,
    });
    const second = new VaultStore(adapter as unknown as DataAdapter, {
      requireWriteLease: true,
      instanceId: 'second-instance',
      pid: 202,
      ttlMs: 3_000,
      now: () => now,
    });

    const statuses = await Promise.all([
      first.acquireWriteLease({ startHeartbeat: false }),
      second.acquireWriteLease({ startHeartbeat: false }),
    ]);
    expect(statuses.map(status => status.mode).sort()).toEqual(['readOnly', 'writer']);
    const writer = statuses[0]?.mode === 'writer' ? first : second;
    const reader = writer === first ? second : first;
    const readOnlyStatus = statuses.find(status => status.mode === 'readOnly');
    expect(readOnlyStatus).toMatchObject({
      ownerInstanceId: statuses.find(status => status.mode === 'writer')?.instanceId,
      ownerPid: statuses.find(status => status.mode === 'writer')?.instanceId === 'first-instance' ? 101 : 202,
      expiresAt: 13_000,
    });

    await writer.beginTurn(beginInput('conversation', 'turn'));
    expect(await reader.listConversations()).toHaveLength(1);
    await expect(reader.beginTurn(beginInput('blocked', 'blocked-turn')))
      .rejects.toBeInstanceOf(ConversationStoreReadOnlyError);

    now = 13_001;
    const takeover = await reader.acquireWriteLease({ startHeartbeat: false });
    expect(takeover.mode).toBe('writer');
    await reader.beginTurn(beginInput('after-takeover', 'takeover-turn'));
    const lostHeartbeat = await writer.renewWriteLease();
    expect(lostHeartbeat).toMatchObject({
      mode: 'readOnly',
      ownerInstanceId: takeover.instanceId,
      ownerPid: takeover.ownerPid,
    });
    await expect(writer.beginTurn(beginInput('stale-writer', 'stale-turn')))
      .rejects.toBeInstanceOf(ConversationStoreReadOnlyError);
    expect(adapter.files.has(CHAT_STORE_LEASE_PATH)).toBe(true);
    expect(adapter.removed).toEqual([]);
  });

  test('fails closed on a corrupt lease while keeping conversation reads available', async () => {
    const adapter = new MemoryDataAdapter({
      [CHAT_STORE_LEASE_PATH]: '{broken-lease',
      [STORAGE_IDS.conversationsPath]: JSON.stringify({ version: 1, conversations: [] }),
    });
    const store = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'blocked',
      requireWriteLease: true,
    });

    await expect(store.acquireWriteLease({ startHeartbeat: false }))
      .rejects.toBeInstanceOf(ChatStoreLeaseCorruptError);
    await expect(store.listConversations()).resolves.toEqual([]);
    await expect(store.beginTurn(beginInput('blocked', 'blocked-turn')))
      .rejects.toBeInstanceOf(ChatStoreLeaseCorruptError);
    expect(adapter.files.get(STORAGE_IDS.conversationsPath))
      .toBe(JSON.stringify({ version: 1, conversations: [] }));
  });

  test('release leaves an auditable record and lets another instance acquire', async () => {
    const adapter = new MemoryDataAdapter();
    const first = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'first', pid: 1, requireWriteLease: true,
    });
    const second = new VaultStore(adapter as unknown as DataAdapter, {
      instanceId: 'second', pid: 2, requireWriteLease: true,
    });
    await first.acquireWriteLease({ startHeartbeat: false });
    expect((await first.releaseWriteLease()).mode).toBe('available');
    expect((await second.acquireWriteLease({ startHeartbeat: false })).mode).toBe('writer');
    expect(adapter.files.has(CHAT_STORE_LEASE_PATH)).toBe(true);
    expect(adapter.removed).toEqual([]);
  });
});

describe('Python process writer fence', () => {
  test('elects one helper, releases without unlinking, and lets the contender reacquire', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-compete-'));
    const first = createAiluProcessWriteLock(vaultRoot);
    const second = createAiluProcessWriteLock(vaultRoot);

    try {
      const [firstAcquired, secondAcquired] = await Promise.all([
        first.acquire(),
        second.acquire(),
      ]);
      expect([firstAcquired, secondAcquired].sort()).toEqual([false, true]);
      const winner = firstAcquired ? first : second;
      const contender = winner === first ? second : first;
      await expect(winner.assertHeld()).resolves.toBeUndefined();
      await expect(contender.assertHeld()).rejects.toThrow('no longer held');

      await winner.release();
      await expect(contender.acquire()).resolves.toBe(true);
      await expect(contender.assertHeld()).resolves.toBeUndefined();
      await contender.release();

      for (const namespace of [STORAGE_IDS.vaultDirectoryName]) {
        const directoryStat = await fs.stat(path.join(vaultRoot, namespace));
        const lockStat = await fs.stat(path.join(
          vaultRoot,
          namespace,
          'conversation-writer.lock',
        ));
        if (process.platform !== 'win32') {
          expect(directoryStat.mode & 0o777).toBe(0o700);
          expect(lockStat.mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      await first.release();
      await second.release();
    }
  });

  test('performs physical CAS and rejects traversal through relative paths or symlink parents', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-cas-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-outside-'));
    const lock = new PythonFcntlProcessWriteLock(vaultRoot);

    expect(await lock.acquire()).toBe(true);
    try {
      expect(await lock.readTextFile('.ailu/cas-target.json')).toBeNull();
      await expect(lock.compareAndSwapTextFile(
        '.ailu/cas-target.json',
        null,
        'first\n',
      )).resolves.toEqual({ swapped: true, value: 'first\n' });
      await expect(lock.compareAndSwapTextFile(
        '.ailu/cas-target.json',
        null,
        'wrong\n',
      )).resolves.toEqual({ swapped: false, value: 'first\n' });
      await expect(lock.compareAndSwapTextFile(
        '.ailu/cas-target.json',
        'first\n',
        'second\n',
      )).resolves.toEqual({ swapped: true, value: 'second\n' });
      await expect(fs.readFile(
        path.join(vaultRoot, '.ailu', 'cas-target.json'),
        'utf8',
      )).resolves.toBe('second\n');

      const largerThanLegacyProtocolLimit = 'x'.repeat((2 * 1024 * 1024) + 1_024);
      await expect(lock.compareAndSwapTextFile(
        '.ailu/large-target.json',
        null,
        largerThanLegacyProtocolLimit,
      )).resolves.toMatchObject({ swapped: true });
      await expect(fs.stat(path.join(
        vaultRoot,
        '.ailu',
        'large-target.json',
      ))).resolves.toMatchObject({ size: Buffer.byteLength(largerThanLegacyProtocolLimit) });

      const mebibyte = 1_024 * 1_024;
      const escapedContent = '"'.repeat(Math.floor(3.3 * mebibyte));
      const escapeDenseArtifact = `${JSON.stringify({
        version: 2,
        messages: Array.from({ length: 5 }, (_, index) => ({
          sequence: index + 1,
          message: {
            id: `escape-dense-${index + 1}`,
            role: 'assistant',
            content: escapedContent,
            createdAt: 1,
          },
        })),
      }, null, 2)}\n`;
      expect(Buffer.byteLength(escapeDenseArtifact, 'utf8')).toBeLessThan(64 * mebibyte);
      expect(Buffer.byteLength(JSON.stringify({
        id: 'legacy-frame',
        op: 'cas',
        path: '.ailu/escape-dense.json',
        expected: null,
        replacement: escapeDenseArtifact,
      }), 'utf8')).toBeGreaterThan(64 * mebibyte);

      await expect(lock.compareAndSwapTextFile(
        '.ailu/escape-dense.json',
        null,
        escapeDenseArtifact,
      )).resolves.toMatchObject({ swapped: true });
      const escapeDenseReadBack = await lock.readTextFile('.ailu/escape-dense.json');
      expect(escapeDenseReadBack).not.toBeNull();
      expect(Buffer.byteLength(escapeDenseReadBack!, 'utf8'))
        .toBe(Buffer.byteLength(escapeDenseArtifact, 'utf8'));
      expect(createHash('sha256').update(escapeDenseReadBack!).digest('hex'))
        .toBe(createHash('sha256').update(escapeDenseArtifact).digest('hex'));
      const escapeDenseConflict = await lock.compareAndSwapTextFile(
        '.ailu/escape-dense.json',
        null,
        'must-not-overwrite\n',
      );
      expect(escapeDenseConflict.swapped).toBe(false);
      expect(escapeDenseConflict.value).not.toBeNull();
      expect(createHash('sha256').update(escapeDenseConflict.value!).digest('hex'))
        .toBe(createHash('sha256').update(escapeDenseArtifact).digest('hex'));
      await expect(fs.stat(path.join(vaultRoot, '.ailu', 'escape-dense.json')))
        .resolves.toMatchObject({ size: Buffer.byteLength(escapeDenseArtifact) });

      await expect(lock.readTextFile('../outside.json')).rejects.toThrow('escapes the vault');
      await fs.symlink(outsideRoot, path.join(vaultRoot, 'linked-outside'));
      await expect(lock.readTextFile('linked-outside/secret.json'))
        .rejects.toThrow('path parent escapes the vault');
    } finally {
      await lock.release();
    }
  }, 30_000);

  test('rejects a helper success response whose compact write evidence does not match', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-evidence-'));
    const mismatchedEvidenceHelper = String.raw`
import json
import sys

print(json.dumps({"type": "READY"}), flush=True)
for raw_line in sys.stdin:
    request = json.loads(raw_line)
    if request.get("op") == "release":
        print(json.dumps({"id": request.get("id"), "ok": True}), flush=True)
        break
    print(json.dumps({
        "id": request.get("id"),
        "ok": True,
        "swapped": True,
        "valueSha256": "0" * 64,
        "valueBytes": 0,
    }), flush=True)
`;
    const lock = new PythonFcntlProcessWriteLock(vaultRoot, {
      helperSource: mismatchedEvidenceHelper,
    });

    expect(await lock.acquire()).toBe(true);
    try {
      await expect(lock.compareAndSwapTextFile(
        '.ailu/evidence-target.json',
        null,
        'verified bytes\n',
      )).rejects.toThrow('mismatched CAS write evidence');
      await expect(fs.access(path.join(vaultRoot, '.ailu', 'evidence-target.json')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await lock.release();
    }
  });

  test('writes an exact 64 MiB artifact with a compact verified CAS response', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-max-value-'));
    const lock = new PythonFcntlProcessWriteLock(vaultRoot);
    const maximumArtifact = 'x'.repeat(64 * 1_024 * 1_024);

    expect(await lock.acquire()).toBe(true);
    try {
      await expect(lock.compareAndSwapTextFile(
        '.ailu/maximum-artifact.json',
        null,
        maximumArtifact,
      )).resolves.toMatchObject({ swapped: true });
      await expect(fs.stat(path.join(vaultRoot, '.ailu', 'maximum-artifact.json')))
        .resolves.toMatchObject({ size: Buffer.byteLength(maximumArtifact) });
    } finally {
      await lock.release();
    }
  }, 60_000);

  test('fails closed when its helper crashes and lets a fresh helper reacquire', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-crash-'));
    const crashed = new PythonFcntlProcessWriteLock(vaultRoot);
    const recovered = new PythonFcntlProcessWriteLock(vaultRoot);

    expect(await crashed.acquire()).toBe(true);
    const helperPid = crashed.helperPid;
    expect(helperPid).not.toBeNull();
    process.kill(helperPid!, 'SIGKILL');
    await waitForCondition(async () => {
      try {
        await crashed.assertHeld();
        return false;
      } catch {
        return true;
      }
    });
    await expect(crashed.readTextFile('.ailu/after-crash.json'))
      .rejects.toThrow('no longer held');

    try {
      await expect(recovered.acquire()).resolves.toBe(true);
      await expect(recovered.compareAndSwapTextFile(
        '.ailu/after-crash.json',
        null,
        'recovered\n',
      )).resolves.toMatchObject({ swapped: true });
    } finally {
      await crashed.release();
      await recovered.release();
    }
  });

  test('on handshake timeout sends TERM, waits, then KILLs an unresponsive helper', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-process-lock-timeout-'));
    const markerPath = path.join(vaultRoot, 'term-seen.txt');
    const stubbornHelper = String.raw`
import signal
import sys
import time

marker_path = sys.argv[1] + "/term-seen.txt"
def on_term(_signal, _frame):
    with open(marker_path, "w", encoding="utf-8") as marker:
        marker.write("TERM")
        marker.flush()

signal.signal(signal.SIGTERM, on_term)
print('{"type":"STARTED"}', flush=True)
while True:
    time.sleep(1)
`;
    const lock = new PythonFcntlProcessWriteLock(vaultRoot, {
      helperSource: stubbornHelper,
      handshakeTimeoutMs: 500,
      killTimeoutMs: 100,
    });

    const acquisition = lock.acquire();
    await waitForCondition(() => lock.helperPid !== null);
    const helperPid = lock.helperPid!;
    await expect(acquisition).rejects.toThrow('did not become ready');
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('TERM');
    expect(lock.helperPid).toBeNull();
    expect(isProcessAlive(helperPid)).toBe(false);
  });
});

describe('ChatStoreLease physical fencing', () => {
  test('keeps the same writer usable after a wall-clock sleep gap while its OS lock survives', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-chat-lease-sleep-'));
    const adapter = new FilesystemDataAdapter(vaultRoot);
    let now = 20_000;
    const first = new ChatStoreLease(adapter as unknown as DataAdapter, {
      instanceId: 'sleeping-writer',
      pid: 301,
      ttlMs: 1_000,
      now: () => now,
      vaultBasePath: vaultRoot,
    });
    const second = new ChatStoreLease(adapter as unknown as DataAdapter, {
      instanceId: 'sleep-contender',
      pid: 302,
      ttlMs: 1_000,
      now: () => now,
      vaultBasePath: vaultRoot,
    });

    try {
      await expect(first.acquire()).resolves.toMatchObject({
        mode: 'writer',
        ownerInstanceId: 'sleeping-writer',
        expiresAt: 21_000,
      });

      // Date.now() advances through sleep even though JS heartbeat timers do
      // not. The long-lived fcntl descriptor remains the exclusive fence.
      now = 80_000;
      await expect(first.inspect()).resolves.toMatchObject({
        mode: 'writer',
        ownerInstanceId: 'sleeping-writer',
      });
      await expect(first.compareAndSwapTextFile(
        '.ailu/after-wake.json',
        null,
        'awake\n',
      )).resolves.toBe(true);
      await expect(first.renew()).resolves.toMatchObject({
        mode: 'writer',
        ownerInstanceId: 'sleeping-writer',
        heartbeatAt: 80_000,
        expiresAt: 81_000,
      });

      // A second helper still cannot enter while the original OS lock lives.
      await expect(second.acquire()).resolves.toMatchObject({
        mode: 'readOnly',
        ownerInstanceId: 'sleeping-writer',
      });

      await first.release();
      await expect(second.acquire()).resolves.toMatchObject({
        mode: 'writer',
        ownerInstanceId: 'sleep-contender',
      });
    } finally {
      await first.release();
      await second.release();
    }
  });

  test('keeps lease changes and repository CAS inside the process helper', async () => {
    const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ailu-chat-lease-physical-'));
    const adapter = new FilesystemDataAdapter(vaultRoot);
    const first = new ChatStoreLease(adapter as unknown as DataAdapter, {
      instanceId: 'physical-first',
      pid: 301,
      ttlMs: 5_000,
      now: () => 20_000,
      vaultBasePath: vaultRoot,
    });
    const second = new ChatStoreLease(adapter as unknown as DataAdapter, {
      instanceId: 'physical-second',
      pid: 302,
      ttlMs: 5_000,
      now: () => 20_000,
      vaultBasePath: vaultRoot,
    });

    try {
      await expect(first.acquire()).resolves.toMatchObject({
        mode: 'writer',
        ownerInstanceId: 'physical-first',
      });
      await expect(second.acquire()).resolves.toMatchObject({
        mode: 'readOnly',
        ownerInstanceId: 'physical-first',
      });

      const target = '.ailu/fenced-target.json';
      await expect(first.compareAndSwapTextFile(target, null, 'revision-1\n')).resolves.toBe(true);
      await expect(first.compareAndSwapTextFile(target, null, 'stale\n')).resolves.toBe(false);
      await expect(fs.readFile(path.join(vaultRoot, target), 'utf8'))
        .resolves.toBe('revision-1\n');

      await expect(first.release()).resolves.toMatchObject({ mode: 'available' });
      await expect(second.acquire()).resolves.toMatchObject({ mode: 'writer' });
      await expect(second.compareAndSwapTextFile(
        target,
        'revision-1\n',
        'revision-2\n',
      )).resolves.toBe(true);
      await expect(fs.readFile(path.join(vaultRoot, target), 'utf8'))
        .resolves.toBe('revision-2\n');
      expect(adapter.processCalls).toBe(0);
    } finally {
      await first.release();
      await second.release();
    }
  });
});
