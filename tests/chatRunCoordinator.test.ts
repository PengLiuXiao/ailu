import {
  ChatCoordinatorShutdownError,
  ChatConversationLoadError,
  ChatPersistenceBackpressureError,
  ChatRecoveryOrderError,
  ChatRunCoordinator,
  CHAT_MAX_ARTIFACTS_PER_TURN,
  CHAT_MAX_ARTIFACT_BYTES,
  CHAT_MAX_ARTIFACT_BYTES_PER_TURN,
  CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS,
  CHAT_MAX_CHECKPOINT_WRITES_PER_TURN,
  CHAT_MAX_RUNTIME_EVENT_BYTES,
  CHAT_MAX_TURN_OUTPUT_BYTES,
  UnownedChatSessionError,
  type ChatRunActivationPersistence,
  type ChatArtifactMaterialization,
  type ChatArtifactMaterializationResult,
  type ChatConversationDelivery,
  type ChatRunCancellationPersistence,
  type ChatRunCheckpointPersistence,
  type ChatRunCoordinatorDependencies,
  type ChatRunFinalPersistence,
  type ChatRunSessionPersistence,
  type ChatRunStartPersistence,
  type ChatRunSubmission,
  type ChatStopResult,
} from '../src/chat/chatRunCoordinator';
import {
  cloneToolLifecycleContentMetadata,
  projectCompletedConversation,
  TOOL_LIFECYCLE_CONTENT_METADATA_KEY,
} from '../src/chat/contextCompression';
import type {
  ChatMessage,
  ChatTurnRequest,
  RuntimeTurnEvent,
  StoredConversation,
} from '../src/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
}

interface RuntimeInvocation {
  id: string;
  request: ChatTurnRequest;
  onEvent: (event: RuntimeTurnEvent) => void;
  deferred: Deferred<void>;
  aborted: boolean;
}

interface CanonicalSessionAdmissionRequest {
  admitCanonicalSession?: (sessionId: string) => Promise<void>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRuntime {
  readonly invocations: RuntimeInvocation[] = [];
  autoResolveOnAbort = false;

  readonly runTurn = (
    request: ChatTurnRequest,
    onEvent: (event: RuntimeTurnEvent) => void,
  ): Promise<void> => {
    const invocation: RuntimeInvocation = {
      id: request.prompt,
      request,
      onEvent,
      deferred: deferred<void>(),
      aborted: request.signal?.aborted ?? false,
    };
    request.signal?.addEventListener('abort', () => {
      invocation.aborted = true;
      if (this.autoResolveOnAbort) invocation.deferred.resolve();
    }, { once: true });
    this.invocations.push(invocation);
    return invocation.deferred.promise;
  };

  get(id: string): RuntimeInvocation {
    const invocation = this.invocations.find(item => item.id === id);
    if (!invocation) throw new Error(`Runtime invocation ${id} has not started.`);
    return invocation;
  }

  emit(id: string, event: RuntimeTurnEvent): void {
    this.get(id).onEvent(event);
  }

  admit(id: string, sessionId: string): Promise<void> {
    const callback = (this.get(id).request as ChatTurnRequest & CanonicalSessionAdmissionRequest)
      .admitCanonicalSession;
    if (!callback) throw new Error(`Runtime invocation ${id} has no session admission callback.`);
    return callback(sessionId);
  }

  finish(id: string, ...events: RuntimeTurnEvent[]): void {
    const invocation = this.get(id);
    for (const event of events) invocation.onEvent(event);
    invocation.deferred.resolve();
  }
}

class FakePersistence {
  readonly conversations = new Map<string, StoredConversation>();
  readonly loadCalls: string[] = [];
  readonly startCalls: ChatRunStartPersistence[] = [];
  readonly activationCalls: ChatRunActivationPersistence[] = [];
  readonly sessionCalls: ChatRunSessionPersistence[] = [];
  readonly finalCalls: ChatRunFinalPersistence[] = [];
  readonly cancellationCalls: ChatRunCancellationPersistence[] = [];
  readonly checkpointCalls: ChatRunCheckpointPersistence[] = [];
  readonly artifactCalls: ChatArtifactMaterialization[] = [];
  readonly startGates = new Map<string, Deferred<void>>();
  readonly activationGates = new Map<string, Deferred<void>>();
  readonly finalGates = new Map<string, Deferred<void>>();
  readonly cancellationGates = new Map<string, Deferred<void>>();
  readonly checkpointGates = new Map<string, Deferred<void>>();
  readonly artifactGates = new Map<string, Deferred<void>>();
  readonly durableSessionOwners = new Map<string, ChatRunSessionPersistence>();
  loadError: Error | null = null;
  readonly turnStates = new Map<string, 'active' | 'queued' | 'paused' | 'cancelRequested' | 'completed' | 'cancelled' | 'failed' | 'interrupted'>();
  private clock = 1_000;

  readonly now = (): number => {
    this.clock += 1;
    return this.clock;
  };

  readonly loadConversation = async (conversationId: string): Promise<StoredConversation | null> => {
    this.loadCalls.push(conversationId);
    if (this.loadError) throw this.loadError;
    return clone(this.conversations.get(conversationId) ?? null);
  };

  readonly persistStart = async (input: ChatRunStartPersistence): Promise<StoredConversation> => {
    this.startCalls.push(clone(input));
    await this.startGates.get(input.runId)?.promise;
    const conversation = this.ensureConversation(input.conversationId, input.userMessage);
    upsertMessage(conversation, input.userMessage);
    upsertMessage(conversation, input.assistantMessage);
    this.turnStates.set(input.runId, input.initialState);
    conversation.updatedAt = this.now();
    return clone(conversation);
  };

  readonly persistActivate = async (input: ChatRunActivationPersistence): Promise<StoredConversation> => {
    this.activationCalls.push(clone(input));
    await this.activationGates.get(input.runId)?.promise;
    this.turnStates.set(input.runId, 'active');
    return clone(this.ensureConversation(input.conversationId));
  };

  readonly persistSession = async (input: ChatRunSessionPersistence): Promise<StoredConversation> => {
    this.sessionCalls.push(clone(input));
    const conversation = this.ensureConversation(input.conversationId);
    conversation.sessionIds = {
      ...(conversation.sessionIds ?? {}),
      [input.agentId]: input.sessionId,
    };
    if (input.sessionConfigKey) {
      conversation.sessionConfigKeys = {
        ...(conversation.sessionConfigKeys ?? {}),
        [input.agentId]: input.sessionConfigKey,
      };
    }
    conversation.updatedAt = this.now();
    return clone(conversation);
  };

  readonly claimSessionOwnership: NonNullable<
    ChatRunCoordinatorDependencies['claimSessionOwnership']
  > = async ownership => {
    const existing = this.durableSessionOwners.get(ownership.sessionId);
    if (existing) {
      if (existing.conversationId === ownership.conversationId && existing.agentId === ownership.agentId) {
        return { status: 'claimed' };
      }
      return {
        status: 'duplicate',
        owner: {
          sessionId: existing.sessionId,
          conversationId: existing.conversationId,
          agentId: existing.agentId,
          runId: existing.runId,
          claimedAt: 0,
        },
      };
    }
    this.durableSessionOwners.set(ownership.sessionId, {
      runId: ownership.runId,
      conversationId: ownership.conversationId,
      agentId: ownership.agentId,
      sessionId: ownership.sessionId,
      sessionConfigKey: undefined,
    });
    return { status: 'claimed' };
  };

  readonly persistCancellationRequested = async (
    input: ChatRunCancellationPersistence,
  ): Promise<StoredConversation> => {
    this.cancellationCalls.push(clone(input));
    await this.cancellationGates.get(input.runId)?.promise;
    this.turnStates.set(input.runId, 'cancelRequested');
    return clone(this.ensureConversation(input.conversationId));
  };

  readonly persistFinal = async (input: ChatRunFinalPersistence): Promise<StoredConversation> => {
    this.finalCalls.push(clone(input));
    await this.finalGates.get(input.runId)?.promise;
    const conversation = this.ensureConversation(input.conversationId, input.userMessage);
    upsertMessage(conversation, input.userMessage);
    upsertMessage(conversation, input.assistantMessage);
    this.turnStates.set(input.runId, input.status);
    conversation.updatedAt = this.now();
    return clone(conversation);
  };

  readonly persistCheckpoint = async (
    input: ChatRunCheckpointPersistence,
  ): Promise<StoredConversation> => {
    this.checkpointCalls.push(clone(input));
    await this.checkpointGates.get(input.runId)?.promise;
    const conversation = this.ensureConversation(input.conversationId);
    upsertMessage(conversation, input.assistantMessage);
    conversation.updatedAt = this.now();
    return clone(conversation);
  };

  readonly materializeArtifact = async (
    input: ChatArtifactMaterialization,
  ): Promise<ChatArtifactMaterializationResult> => {
    this.artifactCalls.push(clone(input));
    await this.artifactGates.get(input.runId)?.promise;
    return {
      artifact: {
        id: input.artifact.itemId,
        type: 'image',
        vaultPath: `.ailu/generated-images/${input.conversationId}/${input.artifact.itemId}.png`,
        mimeType: input.artifact.mimeType ?? 'image/png',
        createdAt: this.now(),
        revisedPrompt: input.artifact.revisedPrompt,
      },
      byteLength: 8,
    };
  };

  dependencies(runtime: FakeRuntime): ChatRunCoordinatorDependencies {
    return {
      runTurn: runtime.runTurn,
      loadConversation: this.loadConversation,
      persistStart: this.persistStart,
      persistActivate: this.persistActivate,
      persistSession: this.persistSession,
      claimSessionOwnership: this.claimSessionOwnership,
      persistCheckpoint: this.persistCheckpoint,
      persistCancellationRequested: this.persistCancellationRequested,
      persistFinal: this.persistFinal,
      materializeArtifact: this.materializeArtifact,
      checkpointScheduler: {
        setTimeout: () => 1,
        clearTimeout: () => {},
      },
      now: this.now,
    };
  }

  simulateVaultRestartRecovery(): void {
    for (const [runId, state] of this.turnStates) {
      if (state === 'queued') this.turnStates.set(runId, 'paused');
      else if (state === 'active' || state === 'cancelRequested') {
        this.turnStates.set(runId, 'interrupted');
      }
    }
  }

  private ensureConversation(conversationId: string, firstMessage?: ChatMessage): StoredConversation {
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      conversation = {
        id: conversationId,
        title: firstMessage?.content || conversationId,
        agentId: firstMessage?.agentId ?? 'claude',
        createdAt: this.now(),
        updatedAt: this.now(),
        messages: [],
      };
      this.conversations.set(conversationId, conversation);
    }
    return conversation;
  }
}

function submission(conversationId: string, runId: string): ChatRunSubmission {
  return {
    runId,
    conversationId,
    runtimeRequest: {
      conversationId,
      agentId: 'claude',
      prompt: runId,
      cwd: '/vault',
      configSource: 'localCli',
    },
    userMessage: {
      id: `${runId}-user`,
      role: 'user',
      content: `user:${runId}`,
      createdAt: 10,
      agentId: 'claude',
    },
    assistantMessage: {
      id: `${runId}-assistant`,
      role: 'assistant',
      content: '',
      createdAt: 11,
      agentId: 'claude',
    },
    sessionConfigKey: `config:${runId}`,
  };
}

async function waitForCount(items: readonly unknown[], expected: number): Promise<void> {
  await vi.waitFor(() => expect(items).toHaveLength(expected), { timeout: 2_000, interval: 1 });
}

async function waitForRuntime(runtime: FakeRuntime, runId: string): Promise<void> {
  await vi.waitFor(
    () => expect(runtime.invocations.map(invocation => invocation.id)).toContain(runId),
    { timeout: 2_000, interval: 1 },
  );
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function upsertMessage(conversation: StoredConversation, message: ChatMessage): void {
  const index = conversation.messages.findIndex(item => item.id === message.id);
  if (index >= 0) conversation.messages[index] = clone(message);
  else conversation.messages.push(clone(message));
}

describe('ChatRunCoordinator', () => {
  test('stores only localized Runtime failures when a UI formatter is configured', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.formatRuntimeError = () => '当前 Agent 执行失败，请查看本地诊断日志。';
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('localized-error', 'localized-error-run'));
    await waitForRuntime(runtime, 'localized-error-run');

    runtime.finish('localized-error-run', {
      type: 'error',
      message: 'Unexpected upstream protocol transition in provider worker',
      detail: 'provider_internal_code=42',
    }, { type: 'done' });
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.assistantMessage.content).toBe('当前 Agent 执行失败，请查看本地诊断日志。');
    expect(result.assistantMessage.content).not.toContain('Unexpected upstream');
    expect(persistence.finalCalls[0]?.error).toBe('当前 Agent 执行失败，请查看本地诊断日志。');
  });

  test('keeps a repository-committed context checkpoint in a loaded lane snapshot', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const base = submission('checkpoint-lane', 'checkpoint-run');
    persistence.conversations.set('checkpoint-lane', {
      id: 'checkpoint-lane',
      title: 'Checkpoint lane',
      agentId: 'claude',
      createdAt: 1,
      updatedAt: 10,
      messages: [{
        id: 'old-user',
        role: 'user',
        content: '旧问题',
        createdAt: 1,
        agentId: 'claude',
      }, {
        id: 'old-assistant',
        role: 'assistant',
        content: '旧答案',
        createdAt: 2,
        agentId: 'claude',
      }],
    });
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    await coordinator.snapshotConversation('checkpoint-lane');
    base.conversationSnapshot = {
      ...persistence.conversations.get('checkpoint-lane')!,
      updatedAt: 20,
      contextCheckpoint: {
        version: 1,
        id: 'ctx-1',
        createdAt: 19,
        sourceRevision: 1,
        throughMessageSequence: 2,
        throughMessageId: 'old-assistant',
        prefixSha256: 'a'.repeat(64),
        projectionVersion: 1,
        summary: {
          facts: ['旧答案已完成'],
          decisions: [],
          userPreferences: [],
          constraints: [],
          openLoops: [],
          filesMentioned: [],
          lastIntent: '继续',
        },
        createdBy: 'local',
      },
    };

    const handle = await coordinator.submit(base);
    await waitForRuntime(runtime, 'checkpoint-run');
    expect((await coordinator.snapshotConversation('checkpoint-lane')).conversation?.contextCheckpoint?.id)
      .toBe('ctx-1');
    runtime.finish('checkpoint-run', { type: 'text', content: 'OK' }, { type: 'done' });
    await handle.completion;
  });

  test('forwards a planned context checkpoint through the durable start barrier', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const next = submission('atomic-context-lane', 'atomic-context-run');
    next.contextCheckpointDraft = {
      version: 1,
      id: 'ctx-atomic',
      createdAt: 10,
      sourceRevision: 7,
      throughMessageSequence: 2,
      throughMessageId: 'older-assistant',
      projectionVersion: 1,
      summary: {
        facts: ['已完成旧任务'],
        decisions: [],
        userPreferences: [],
        constraints: [],
        openLoops: [],
        filesMentioned: [],
        lastIntent: '继续',
      },
      createdBy: 'local',
    };
    next.expectedRevision = 7;

    const handle = await coordinator.submit(next);

    expect(persistence.startCalls[0]?.contextCheckpointDraft).toEqual(next.contextCheckpointDraft);
    expect(persistence.startCalls[0]?.expectedRevision).toBe(7);
    await waitForRuntime(runtime, 'atomic-context-run');
    runtime.finish('atomic-context-run', { type: 'done' });
    await handle.completion;
  });

  test('crosses persistStart before submit resolves and invokes every stage exactly once', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const startGate = deferred<void>();
    persistence.startGates.set('one', startGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    let submitSettled = false;

    const pendingHandle = coordinator.submit(submission('conversation', 'one')).then(handle => {
      submitSettled = true;
      return handle;
    });
    await waitForCount(persistence.startCalls, 1);
    expect(submitSettled).toBe(false);
    expect(runtime.invocations).toHaveLength(0);

    startGate.resolve();
    const handle = await pendingHandle;
    await waitForCount(runtime.invocations, 1);
    runtime.finish('one', { type: 'text', content: 'OK' }, { type: 'done' });
    const result = await handle.completion;

    expect(result.status).toBe('completed');
    expect(result.assistantMessage.content).toBe('OK');
    expect(persistence.startCalls).toHaveLength(1);
    expect(runtime.invocations).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
  });

  test('runs sixteen conversations concurrently without an application-level cap', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const runIds = Array.from({ length: 16 }, (_, index) => `parallel-${index}`);

    const handles = await Promise.all(runIds.map(runId => (
      coordinator.submit(submission(`conversation-${runId}`, runId))
    )));
    expect(persistence.startCalls.every(call => call.initialState === 'active')).toBe(true);
    await waitForCount(runtime.invocations, 16);
    expect(runtime.invocations.every(invocation => !invocation.aborted)).toBe(true);

    for (const runId of runIds) {
      runtime.finish(runId, { type: 'text', content: runId }, { type: 'done' });
    }
    const results = await Promise.all(handles.map(handle => handle.completion));
    expect(results.every(result => result.status === 'completed')).toBe(true);
    expect(persistence.finalCalls).toHaveLength(16);
  });

  test('durably admits queued runs immediately while keeping runtime execution FIFO', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('same', 'first'));
    await waitForRuntime(runtime, 'first');

    const second = await coordinator.submit(submission('same', 'second'));
    const third = await coordinator.submit(submission('same', 'third'));
    const other = await coordinator.submit(submission('other', 'other'));
    await waitForCount(runtime.invocations, 2);
    expect(runtime.invocations.map(item => item.id).sort()).toEqual(['first', 'other']);
    expect(persistence.startCalls.find(call => call.runId === 'first')?.initialState).toBe('active');
    expect(persistence.startCalls.find(call => call.runId === 'second')?.initialState).toBe('queued');
    expect(persistence.startCalls.find(call => call.runId === 'third')?.initialState).toBe('queued');
    expect(persistence.startCalls.find(call => call.runId === 'other')?.initialState).toBe('active');
    const admitted = await coordinator.snapshotConversation('same');
    expect(admitted.runs.find(run => run.runId === 'second')).toMatchObject({
      phase: 'queued',
      startPersisted: true,
      activationPersisted: false,
    });

    runtime.finish('first', { type: 'done' });
    await first.completion;
    await waitForRuntime(runtime, 'second');
    expect(runtime.invocations.map(item => item.id)).not.toContain('third');
    expect(persistence.activationCalls.map(call => call.runId)).toEqual(['second']);

    runtime.finish('second', { type: 'done' });
    await second.completion;
    await waitForRuntime(runtime, 'third');
    expect(persistence.activationCalls.map(call => call.runId)).toEqual(['second', 'third']);
    runtime.finish('third', { type: 'done' });
    runtime.finish('other', { type: 'done' });
    await Promise.all([third.completion, other.completion]);
  });

  test('holds a queued run behind persistActivate before invoking Runtime', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const activationGate = deferred<void>();
    persistence.activationGates.set('activate-second', activationGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('activate-lane', 'activate-first'));
    await waitForRuntime(runtime, 'activate-first');
    const second = await coordinator.submit(submission('activate-lane', 'activate-second'));

    expect(persistence.startCalls.find(call => call.runId === 'activate-second')?.initialState)
      .toBe('queued');
    expect(runtime.invocations.map(invocation => invocation.id)).not.toContain('activate-second');
    runtime.finish('activate-first', { type: 'done' });
    await first.completion;
    await waitForCount(persistence.activationCalls, 1);
    expect(runtime.invocations.map(invocation => invocation.id)).not.toContain('activate-second');
    expect((await coordinator.snapshotConversation('activate-lane')).runs
      .find(run => run.runId === 'activate-second')).toMatchObject({
      phase: 'preparing',
      activationPersisted: false,
    });

    activationGate.resolve();
    await waitForRuntime(runtime, 'activate-second');
    runtime.finish('activate-second', { type: 'done' });
    expect((await second.completion).status).toBe('completed');
  });

  test('stops a run during admission after one queued start and never activates it', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const startGate = deferred<void>();
    persistence.startGates.set('admission-stop', startGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));

    const pendingHandle = coordinator.submit(submission('admission-stop-lane', 'admission-stop'));
    const stop = coordinator.stopConversation('admission-stop-lane');
    const repeatedStop = coordinator.stopConversation('admission-stop-lane');
    expect(repeatedStop.cancelledRunIds).toEqual([]);
    await expect(repeatedStop.completions).resolves.toEqual([]);
    await waitForCount(persistence.startCalls, 1);
    expect(persistence.startCalls[0]?.initialState).toBe('queued');
    expect((await coordinator.snapshotConversation('admission-stop-lane')).runs[0]).toMatchObject({
      phase: 'stopping',
      startPersisted: false,
      cancellationReason: 'stop',
    });

    startGate.resolve();
    const handle = await pendingHandle;
    const [result] = await stop.completions;
    expect(result?.status).toBe('cancelled');
    expect((await handle.completion).status).toBe('cancelled');
    expect(persistence.startCalls).toHaveLength(1);
    expect(persistence.cancellationCalls).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
    expect(persistence.activationCalls).toHaveLength(0);
    expect(runtime.invocations).toHaveLength(0);
  });

  test('does not invoke Runtime when a watcher stops at the running-state boundary', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const stopped = deferred<ChatStopResult>();
    let didStop = false;
    const watch = coordinator.watchConversation('running-boundary', delivery => {
      if (
        delivery.type === 'run'
        && delivery.event.type === 'state'
        && delivery.event.run.phase === 'running'
        && !didStop
      ) {
        didStop = true;
        stopped.resolve(coordinator.stopConversation('running-boundary'));
      }
    });
    await watch.ready;

    const handle = await coordinator.submit(submission('running-boundary', 'running-boundary-run'));
    const stop = await stopped.promise;
    expect(runtime.invocations).toHaveLength(0);
    expect((await stop.completions)[0]?.status).toBe('cancelled');
    expect((await handle.completion).status).toBe('cancelled');
    watch.close();
  });

  test('settles stop completion when admission persistence fails', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistStart = async input => {
      persistence.startCalls.push(clone(input));
      throw new Error('durable admission failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);

    const pendingHandle = coordinator.submit(submission('failed-admission', 'failed-admission-run'));
    const stop = coordinator.stopConversation('failed-admission');
    await expect(pendingHandle).rejects.toThrow('durable admission failed');
    await expect(stop.completions).resolves.toMatchObject([{
      runId: 'failed-admission-run',
      status: 'failed',
    }]);
    expect(runtime.invocations).toHaveLength(0);
    expect(persistence.finalCalls).toHaveLength(0);
  });

  test('targets stop to one conversation and leaves another runtime untouched', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('one', 'stop-me'));
    const second = await coordinator.submit(submission('two', 'keep-going'));
    await waitForCount(runtime.invocations, 2);

    const stop = coordinator.stopConversation('one');
    const [stopped] = await stop.completions;
    expect(stop.cancelledRunIds).toEqual(['stop-me']);
    expect(stopped?.status).toBe('cancelled');
    expect(runtime.get('stop-me').aborted).toBe(true);
    expect(runtime.get('keep-going').aborted).toBe(false);
    expect(coordinator.isConversationRunning('two')).toBe(true);

    runtime.finish('keep-going', { type: 'done' });
    await Promise.all([first.completion, second.completion]);
  });

  test('uses an ordered stop epoch to cancel earlier queued work but not a later submission', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('lane', 'epoch-before-active'));
    const queuedBeforePromise = coordinator.submit(submission('lane', 'epoch-before-queued'));
    const stop = coordinator.stopConversation('lane');
    const afterPromise = coordinator.submit(submission('lane', 'epoch-after'));

    const stopped = await stop.completions;
    const queuedBefore = await queuedBeforePromise;
    expect(stopped.map(result => result.runId).sort()).toEqual([
      'epoch-before-active',
      'epoch-before-queued',
    ]);
    expect(stopped.every(result => result.status === 'cancelled')).toBe(true);
    expect((await queuedBefore.completion).status).toBe('cancelled');
    expect(persistence.startCalls.map(call => call.runId)).toContain('epoch-before-queued');
    expect(persistence.finalCalls.map(call => call.runId)).toContain('epoch-before-queued');
    expect(runtime.invocations.map(item => item.id)).not.toContain('epoch-before-queued');
    expect(stop.stopEpoch).toBe(1);
    expect(persistence.cancellationCalls.map(call => call.runId).sort()).toEqual([
      'epoch-before-active',
      'epoch-before-queued',
    ]);

    const after = await afterPromise;
    await vi.waitFor(() => expect(runtime.invocations.map(item => item.id)).toContain('epoch-after'));
    expect(runtime.get('epoch-after').aborted).toBe(false);
    runtime.finish('epoch-after', { type: 'done' });
    await Promise.all([first.completion, after.completion]);
  });

  test('continues and persists correctly with no subscribers', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('headless', 'headless-run'));
    await waitForRuntime(runtime, 'headless-run');

    runtime.finish(
      'headless-run',
      { type: 'session', sessionId: 'session-headless' },
      { type: 'text', content: 'background output' },
      { type: 'done' },
    );
    const result = await handle.completion;
    const snapshot = await coordinator.snapshotConversation('headless');

    expect(result.status).toBe('completed');
    expect(persistence.sessionCalls).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
    expect(snapshot.messages.find(message => message.id === 'headless-run-assistant')?.content)
      .toBe('background output');
  });

  test('keeps long successful history bounded after folding terminal runs', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwner = async () => null;
    const coordinator = new ChatRunCoordinator(dependencies);

    for (let index = 0; index < 220; index += 1) {
      const runId = `bounded-${index}`;
      const handle = await coordinator.submit(submission('bounded-history', runId));
      await waitForRuntime(runtime, runId);
      runtime.finish(runId, { type: 'text', content: `answer-${index}` }, { type: 'done' });
      await handle.completion;
    }

    const snapshot = await coordinator.snapshotConversation('bounded-history');
    expect(snapshot.messages).toHaveLength(100);
    expect(snapshot.messages.at(-1)?.content).toBe('answer-219');
    expect(snapshot.runs.length).toBeLessThanOrEqual(8);
    expect(snapshot.runs.every(run => run.phase === 'completed')).toBe(true);
  });

  test('does no startup owner enumeration and gates a resume through lazy durable lookup', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    let fullScans = 0;
    let exactLookups = 0;
    dependencies.loadSessionOwnerships = async () => {
      fullScans += 1;
      return Array.from({ length: 10_000 }, (_, index) => ({
        sessionId: `history-${index}`,
        conversationId: `history-conversation-${index}`,
        agentId: 'codex' as const,
        runId: `history-run-${index}`,
        claimedAt: index,
      }));
    };
    dependencies.loadSessionOwner = async sessionId => {
      exactLookups += 1;
      return sessionId === 'lazy-session' ? {
        sessionId,
        conversationId: 'lazy-conversation',
        agentId: 'claude',
        runId: 'prior-run',
        claimedAt: 1,
      } : null;
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    await expect(coordinator.recover()).resolves.toMatchObject({ sessionOwnershipsLoaded: 0 });
    expect(fullScans).toBe(0);
    expect(exactLookups).toBe(0);

    const resume = submission('lazy-conversation', 'lazy-resume');
    resume.runtimeRequest.sessionId = 'lazy-session';
    const handle = await coordinator.submit(resume);
    await waitForRuntime(runtime, 'lazy-resume');
    expect(exactLookups).toBe(1);
    runtime.finish('lazy-resume', { type: 'text', content: 'resumed' }, { type: 'done' });
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed' });
  });

  test('clears a transient session error when the same session later persists successfully', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    let attempts = 0;
    dependencies.persistSession = async input => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient session write');
      return persistence.persistSession(input);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('session-repair', 'session-repair-run'));
    await waitForRuntime(runtime, 'session-repair-run');
    runtime.emit('session-repair-run', { type: 'session', sessionId: 'repair-session' });
    await vi.waitFor(() => expect(attempts).toBe(1));
    runtime.emit('session-repair-run', { type: 'session', sessionId: 'repair-session' });
    await vi.waitFor(() => expect(attempts).toBe(2));
    runtime.finish('session-repair-run', { type: 'text', content: 'ok' }, { type: 'done' });
    await expect(handle.completion).resolves.toMatchObject({
      status: 'completed',
      finalPersisted: true,
      persistenceError: null,
    });
  });

  test('checkpoints changed output on manual flush or 4KB and awaits the final checkpoint', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('checkpoint', 'checkpoint-run'));
    await waitForRuntime(runtime, 'checkpoint-run');

    runtime.emit('checkpoint-run', { type: 'text', content: 'partial' });
    expect(persistence.checkpointCalls).toHaveLength(0);
    await coordinator.flushCheckpoints('checkpoint');
    expect(persistence.checkpointCalls[0]?.assistantMessage.content).toBe('partial');

    runtime.emit('checkpoint-run', { type: 'text', content: 'x'.repeat(4 * 1_024) });
    await waitForCount(persistence.checkpointCalls, 2);
    expect(persistence.checkpointCalls[1]?.assistantMessage.content).toHaveLength(4 * 1_024 + 7);

    const finalCheckpointGate = deferred<void>();
    persistence.checkpointGates.set('checkpoint-run', finalCheckpointGate);
    runtime.finish(
      'checkpoint-run',
      { type: 'text', content: 'tail' },
      { type: 'done' },
    );
    let completionSettled = false;
    void handle.completion.then(() => {
      completionSettled = true;
    });
    await waitForCount(persistence.checkpointCalls, 3);
    expect(completionSettled).toBe(false);
    expect(persistence.finalCalls).toHaveLength(0);

    finalCheckpointGate.resolve();
    const result = await handle.completion;
    expect(result.status).toBe('completed');
    expect(persistence.finalCalls).toHaveLength(1);
    expect(persistence.checkpointCalls[2]?.assistantMessage.content).toContain('tail');
  });

  test('coalesces many checkpoint thresholds while one full snapshot write is in flight', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const checkpointGate = deferred<void>();
    persistence.checkpointGates.set('coalesced-checkpoint-run', checkpointGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission(
      'coalesced-checkpoint',
      'coalesced-checkpoint-run',
    ));
    await waitForRuntime(runtime, 'coalesced-checkpoint-run');

    runtime.emit('coalesced-checkpoint-run', { type: 'text', content: 'a'.repeat(4 * 1_024) });
    await waitForCount(persistence.checkpointCalls, 1);
    for (let index = 0; index < 32; index += 1) {
      runtime.emit('coalesced-checkpoint-run', { type: 'text', content: 'b'.repeat(4 * 1_024) });
    }
    await Promise.resolve();
    expect(persistence.checkpointCalls).toHaveLength(1);

    const flush = coordinator.flushCheckpoints('coalesced-checkpoint');
    checkpointGate.resolve();
    await flush;
    expect(persistence.checkpointCalls).toHaveLength(2);
    expect(persistence.checkpointCalls[1]?.assistantMessage.content)
      .toHaveLength(33 * 4 * 1_024);

    runtime.finish('coalesced-checkpoint-run', { type: 'done' });
    await handle.completion;
  });

  test('hard-caps repeated full-message checkpoints for one turn', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('checkpoint-cap', 'checkpoint-cap-run'));
    await waitForRuntime(runtime, 'checkpoint-cap-run');

    for (let index = 0; index < CHAT_MAX_CHECKPOINT_WRITES_PER_TURN + 5; index += 1) {
      runtime.emit('checkpoint-cap-run', { type: 'text', content: 'x' });
      await coordinator.flushCheckpoints('checkpoint-cap');
    }

    expect(persistence.checkpointCalls).toHaveLength(CHAT_MAX_CHECKPOINT_WRITES_PER_TURN);
    runtime.finish('checkpoint-cap-run', { type: 'done' });
    await handle.completion;
    expect(persistence.checkpointCalls).toHaveLength(CHAT_MAX_CHECKPOINT_WRITES_PER_TURN);
  });

  test('rejects one oversized runtime event before content or checkpoints can grow', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const deliveries: ChatConversationDelivery[] = [];
    const watch = coordinator.watchConversation('oversized-event', delivery => deliveries.push(delivery));
    await watch.ready;
    const handle = await coordinator.submit(submission('oversized-event', 'oversized-event-run'));
    await waitForRuntime(runtime, 'oversized-event-run');

    runtime.emit('oversized-event-run', {
      type: 'text',
      content: 'x'.repeat(CHAT_MAX_RUNTIME_EVENT_BYTES),
    });
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.assistantMessage.content.length).toBeLessThan(1_024);
    expect(runtime.get('oversized-event-run').aborted).toBe(true);
    expect(persistence.checkpointCalls).toHaveLength(0);
    const errors = deliveries.flatMap(delivery => (
      delivery.type === 'run'
      && delivery.event.type === 'runtime'
      && delivery.event.event.type === 'error'
        ? [delivery.event.event]
        : []
    ));
    expect(errors).toEqual([
      expect.objectContaining({ diagnostic: 'runtime_output_limit_exceeded' }),
    ]);
    watch.close();
  });

  test('bounds many small runtime events and stops checkpoint snapshot amplification', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const deliveries: ChatConversationDelivery[] = [];
    const watch = coordinator.watchConversation('many-small-output', delivery => deliveries.push(delivery));
    await watch.ready;
    const handle = await coordinator.submit(submission('many-small-output', 'many-small-output-run'));
    await waitForRuntime(runtime, 'many-small-output-run');

    const event: RuntimeTurnEvent = { type: 'text', content: 'x'.repeat(128 * 1_024) };
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    const count = Math.floor(CHAT_MAX_TURN_OUTPUT_BYTES / eventBytes) + 1;
    for (let index = 0; index < count; index += 1) {
      runtime.emit('many-small-output-run', event);
    }
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(true);
    expect(new TextEncoder().encode(result.assistantMessage.content).byteLength)
      .toBeLessThanOrEqual(CHAT_MAX_TURN_OUTPUT_BYTES + 1_024);
    expect(runtime.get('many-small-output-run').aborted).toBe(true);
    expect(persistence.checkpointCalls).toHaveLength(0);
    const errors = deliveries.flatMap(delivery => (
      delivery.type === 'run'
      && delivery.event.type === 'runtime'
      && delivery.event.event.type === 'error'
        ? [delivery.event.event]
        : []
    ));
    expect(errors).toEqual([
      expect.objectContaining({ diagnostic: 'runtime_output_limit_exceeded' }),
    ]);
    watch.close();
  });

  test('checkpoints changed output after one second even below the byte threshold', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const scheduled: { callback: (() => void) | null; delayMs: number | null } = {
      callback: null,
      delayMs: null,
    };
    dependencies.checkpointScheduler = {
      setTimeout: (callback, delayMs) => {
        scheduled.callback = callback;
        scheduled.delayMs = delayMs;
        return 1;
      },
      clearTimeout: () => {
        scheduled.callback = null;
      },
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('checkpoint-timer', 'checkpoint-timer-run'));
    await vi.waitFor(() => expect(runtime.invocations).toHaveLength(1));

    runtime.emit('checkpoint-timer-run', { type: 'text', content: 'small partial' });
    expect(scheduled.delayMs).toBe(1_000);
    expect(persistence.checkpointCalls).toHaveLength(0);
    const callback = scheduled.callback;
    expect(callback).not.toBeNull();
    callback?.();
    await vi.waitFor(() => expect(persistence.checkpointCalls).toHaveLength(1));
    expect(persistence.checkpointCalls[0]?.assistantMessage.content).toBe('small partial');

    runtime.finish('checkpoint-timer-run', { type: 'done' });
    await handle.completion;
  });

  test('recovers a transient checkpoint failure when the complete final write succeeds', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistCheckpoint = async input => {
      persistence.checkpointCalls.push(clone(input));
      throw new Error('checkpoint journal failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('checkpoint-failure', 'checkpoint-failure-run'));
    await waitForRuntime(runtime, 'checkpoint-failure-run');

    runtime.emit('checkpoint-failure-run', { type: 'text', content: 'before failure' });
    await coordinator.flushCheckpoints('checkpoint-failure');
    expect(runtime.get('checkpoint-failure-run').aborted).toBe(false);
    expect((await coordinator.snapshotConversation('checkpoint-failure')).runs[0]?.persistenceError)
      .toContain('checkpoint journal failed');

    runtime.finish(
      'checkpoint-failure-run',
      { type: 'text', content: ' and after failure' },
      { type: 'done' },
    );
    const result = await handle.completion;
    expect(result.status).toBe('completed');
    expect(result.finalPersisted).toBe(true);
    expect(result.persistenceError).toBeNull();
    expect(result.assistantMessage.content).toBe('before failure and after failure');
    expect(runtime.get('checkpoint-failure-run').aborted).toBe(false);
    const pruned: string[] = [];
    await vi.waitFor(() => {
      pruned.push(...coordinator.pruneIdleLanes(0).prunedConversationIds);
      expect(pruned).toContain('checkpoint-failure');
    });
  });

  test('keeps a run unprunable when the complete final write really fails', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistFinal = async input => {
      persistence.finalCalls.push(clone(input));
      throw new Error('final journal failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('final-failure', 'final-failure-run'));
    await waitForRuntime(runtime, 'final-failure-run');

    runtime.finish('final-failure-run', { type: 'text', content: 'complete output' }, { type: 'done' });
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(false);
    expect(result.persistenceError).toContain('final journal failed');
    expect(coordinator.pruneIdleLanes(0).prunedConversationIds).not.toContain('final-failure');
  });

  test('registers before snapshot, buffers reentrant output, and reconnects without duplicate delivery or cancellation', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('watch', 'watch-run'));
    await waitForRuntime(runtime, 'watch-run');
    const firstDeliveries: ChatConversationDelivery[] = [];
    let emittedDuringSnapshot = false;
    const firstWatch = coordinator.watchConversation('watch', delivery => {
      firstDeliveries.push(delivery);
      if (delivery.type === 'snapshot' && !emittedDuringSnapshot) {
        emittedDuringSnapshot = true;
        runtime.emit('watch-run', { type: 'text', content: 'A' });
      }
    });
    await firstWatch.ready;
    const firstTextEvents = firstDeliveries.filter(delivery => (
      delivery.type === 'run'
      && delivery.event.type === 'runtime'
      && delivery.event.event.type === 'text'
    ));
    expect(firstTextEvents).toHaveLength(1);
    const firstText = firstTextEvents[0];
    if (firstText?.type !== 'run') throw new Error('Expected run delivery.');
    const cursor = firstText.event.sequence;

    firstWatch.close();
    runtime.emit('watch-run', { type: 'text', content: 'B' });
    expect(runtime.get('watch-run').aborted).toBe(false);

    const reconnectDeliveries: ChatConversationDelivery[] = [];
    const reconnect = coordinator.watchConversation('watch', delivery => reconnectDeliveries.push(delivery), {
      after: { 'watch-run': cursor },
    });
    await reconnect.ready;
    const reconnectSnapshot = reconnectDeliveries.find(delivery => delivery.type === 'snapshot');
    if (reconnectSnapshot?.type !== 'snapshot') throw new Error('Expected reconnect snapshot.');
    expect(reconnectSnapshot.snapshot.messages.find(message => message.id === 'watch-run-assistant')?.content)
      .toBe('AB');
    expect(reconnectDeliveries.filter(delivery => delivery.type === 'run')).toHaveLength(0);

    runtime.emit('watch-run', { type: 'text', content: 'C' });
    const reconnectText = reconnectDeliveries.filter(delivery => (
      delivery.type === 'run'
      && delivery.event.type === 'runtime'
      && delivery.event.event.type === 'text'
    ));
    expect(reconnectText).toHaveLength(1);
    runtime.finish('watch-run', { type: 'done' });
    await handle.completion;
    reconnect.close();
  });

  test('ignores every runtime event after a terminal event or cancellation boundary', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('late', 'late-run'));
    await waitForRuntime(runtime, 'late-run');

    runtime.emit('late-run', { type: 'text', content: 'before' });
    runtime.emit('late-run', { type: 'done' });
    runtime.emit('late-run', { type: 'text', content: 'late' });
    runtime.emit('late-run', {
      type: 'artifact',
      artifact: { itemId: 'late-image', kind: 'image', sourcePath: '/tmp/late.png' },
    });
    runtime.get('late-run').deferred.resolve();
    const result = await handle.completion;
    runtime.emit('late-run', { type: 'text', content: 'later still' });

    expect(result.assistantMessage.content).toBe('before');
    expect(persistence.artifactCalls).toHaveLength(0);
    expect(persistence.finalCalls[0]?.assistantMessage.content).toBe('before');
  });

  test('persists visible tool progress as structured UI-only spans excluded from handoff projection', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.formatToolEvent = toolCall => `\n\n• ${toolCall.name} ${toolCall.status}`;
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('tool-handoff', 'tool-handoff-run'));
    await waitForRuntime(runtime, 'tool-handoff-run');

    runtime.finish(
      'tool-handoff-run',
      { type: 'text', content: '已经完成检查。' },
      {
        type: 'tool',
        toolCall: { id: 'tool-1', name: 'Read', status: 'started' },
      },
      {
        type: 'tool',
        toolCall: { id: 'tool-1', name: 'Read', status: 'completed' },
      },
      { type: 'text', content: '结果没有异常。' },
      { type: 'done' },
    );
    const result = await handle.completion;
    const persistedMessage = persistence.finalCalls[0].assistantMessage;

    expect(result.assistantMessage.content).toBe(
      '已经完成检查。\n\n• Read started\n\n• Read completed结果没有异常。',
    );
    expect(persistedMessage.content).toBe(result.assistantMessage.content);
    const lifecycleMetadata = cloneToolLifecycleContentMetadata(persistedMessage.metadata);
    expect(lifecycleMetadata).toMatchObject({
      version: 1,
      spans: [
        { start: 7, end: 23 },
        { start: 23, end: 41 },
      ],
    });
    expect(lifecycleMetadata?.spans.every(span => /^[a-f0-9]{64}$/u.test(span.sha256))).toBe(true);

    const persistedConversation = {
      id: 'tool-handoff',
      title: 'tool handoff',
      agentId: 'claude' as const,
      createdAt: 1,
      updatedAt: 2,
      revision: 1,
      messages: [
        persistence.finalCalls[0].userMessage,
        persistedMessage,
      ],
      turns: [{
        id: 'tool-handoff-run',
        agentId: 'claude' as const,
        userMessageId: persistence.finalCalls[0].userMessage.id,
        assistantMessageId: persistedMessage.id,
        state: 'completed' as const,
        queueSequence: 1,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }],
    };
    const projectedAssistant = projectCompletedConversation(persistedConversation)
      .turns[0]?.messages.find(message => message.role === 'assistant')?.content;

    expect(projectedAssistant).toBe('已经完成检查。\n\n结果没有异常。');
    expect(projectedAssistant).not.toContain('Read');
  });

  test('adds a provider-neutral completion when a successful turn emitted only tool progress', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.formatToolEvent = toolCall => `\n\n• ${toolCall.name} ${toolCall.status}`;
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('tool-only-handoff', 'tool-only-run'));
    await waitForRuntime(runtime, 'tool-only-run');

    runtime.finish(
      'tool-only-run',
      {
        type: 'tool',
        toolCall: { id: 'tool-1', name: 'Read', status: 'completed' },
      },
      { type: 'done' },
    );
    const result = await handle.completion;
    const persistedMessage = persistence.finalCalls[0].assistantMessage;
    const persistedConversation = {
      id: 'tool-only-handoff',
      title: 'tool only handoff',
      agentId: 'claude' as const,
      createdAt: 1,
      updatedAt: 2,
      revision: 1,
      messages: [persistence.finalCalls[0].userMessage, persistedMessage],
      turns: [{
        id: 'tool-only-run',
        agentId: 'claude' as const,
        userMessageId: persistence.finalCalls[0].userMessage.id,
        assistantMessageId: persistedMessage.id,
        state: 'completed' as const,
        queueSequence: 1,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }],
    };
    const projectedAssistant = projectCompletedConversation(persistedConversation)
      .turns[0]?.messages.find(message => message.role === 'assistant')?.content;

    expect(result.assistantMessage.content).toBe('\n\n• Read completed\n\nDone.');
    expect(projectedAssistant).toBe('Done.');
    expect(projectedAssistant).not.toContain('Read');
  });

  test('adds a provider-neutral completion when a successful turn emitted only an artifact', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('artifact-only-handoff', 'artifact-only-run'));
    await waitForRuntime(runtime, 'artifact-only-run');

    runtime.finish(
      'artifact-only-run',
      {
        type: 'artifact',
        artifact: {
          itemId: 'image-only',
          kind: 'image',
          sourcePath: '/tmp/image-only.png',
          mimeType: 'image/png',
        },
      },
      { type: 'done' },
    );
    const result = await handle.completion;
    const persistedMessage = persistence.finalCalls[0].assistantMessage;
    const persistedConversation = {
      id: 'artifact-only-handoff',
      title: 'artifact only handoff',
      agentId: 'codex' as const,
      createdAt: 1,
      updatedAt: 2,
      revision: 1,
      messages: [persistence.finalCalls[0].userMessage, persistedMessage],
      turns: [{
        id: 'artifact-only-run',
        agentId: 'codex' as const,
        userMessageId: persistence.finalCalls[0].userMessage.id,
        assistantMessageId: persistedMessage.id,
        state: 'completed' as const,
        queueSequence: 1,
        createdAt: 1,
        updatedAt: 2,
        completedAt: 2,
      }],
    };
    const projectedAssistant = projectCompletedConversation(persistedConversation)
      .turns[0]?.messages.find(message => message.role === 'assistant')?.content;

    expect(result.assistantMessage.content).toBe('Done.');
    expect(result.assistantMessage.metadata?.artifacts).toHaveLength(1);
    expect(projectedAssistant).toBe('Done.');
  });

  test('removes tool lifecycle metadata when cancellation replaces the assistant content', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.formatToolEvent = toolCall => `\n\n• ${toolCall.name} ${toolCall.status}`;
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('tool-cancel', 'tool-cancel-run'));
    await waitForRuntime(runtime, 'tool-cancel-run');
    runtime.emit('tool-cancel-run', {
      type: 'tool',
      toolCall: { id: 'tool-1', name: 'Command', status: 'started' },
    });

    const stop = coordinator.stopConversation('tool-cancel');
    await stop.completions;
    const result = await handle.completion;

    expect(result.assistantMessage.content).toBe('当前任务已取消');
    expect(result.assistantMessage.metadata?.[TOOL_LIFECYCLE_CONTENT_METADATA_KEY]).toBeUndefined();
    expect(persistence.finalCalls[0]?.assistantMessage.metadata?.[TOOL_LIFECYCLE_CONTENT_METADATA_KEY])
      .toBeUndefined();
  });

  test('does not cross the teardown barrier until the runtime Promise and persistFinal both settle', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const finalGate = deferred<void>();
    persistence.finalGates.set('barrier-first', finalGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('barrier', 'barrier-first'));
    await waitForRuntime(runtime, 'barrier-first');
    const stop = coordinator.stopConversation('barrier');
    const secondPromise = coordinator.submit(submission('barrier', 'barrier-second'));

    expect(runtime.get('barrier-first').aborted).toBe(true);
    expect(runtime.invocations.map(item => item.id)).toEqual(['barrier-first']);
    runtime.emit('barrier-first', { type: 'text', content: 'teardown noise' });
    runtime.get('barrier-first').deferred.resolve();
    await waitForCount(persistence.finalCalls, 1);
    expect(runtime.invocations.map(item => item.id)).toEqual(['barrier-first']);

    finalGate.resolve();
    await stop.completions;
    const second = await secondPromise;
    await vi.waitFor(() => expect(runtime.invocations.map(item => item.id)).toContain('barrier-second'));
    expect((await first.completion).assistantMessage.content).toBe('当前任务已取消');
    runtime.finish('barrier-second', { type: 'done' });
    await second.completion;
  });

  test('aborts immediately but waits for the durable cancelRequested transition before finalizing', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const cancellationGate = deferred<void>();
    persistence.cancellationGates.set('durable-stop', cancellationGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('durable-stop-conversation', 'durable-stop'));
    await waitForRuntime(runtime, 'durable-stop');
    let stopSettled = false;

    const stop = coordinator.stopConversation('durable-stop-conversation');
    void stop.completions.then(() => {
      stopSettled = true;
    });
    expect(runtime.get('durable-stop').aborted).toBe(true);
    await waitForCount(persistence.cancellationCalls, 1);
    expect(stopSettled).toBe(false);
    expect(persistence.finalCalls).toHaveLength(0);

    cancellationGate.resolve();
    const [result] = await stop.completions;
    expect(result?.status).toBe('cancelled');
    expect(result?.cancellationRequestedPersisted).toBe(true);
    expect((await handle.completion).finalPersisted).toBe(true);
    expect(persistence.finalCalls).toHaveLength(1);
  });

  test('includes asynchronous artifact import in the teardown and final-persistence barrier', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const artifactGate = deferred<void>();
    persistence.artifactGates.set('artifact-run', artifactGate);
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('artifact', 'artifact-run'));
    await waitForRuntime(runtime, 'artifact-run');
    let completed = false;
    void handle.completion.then(() => {
      completed = true;
    });

    runtime.finish('artifact-run', {
      type: 'artifact',
      artifact: {
        itemId: 'image-1',
        kind: 'image',
        sourcePath: '/tmp/image-1.png',
        mimeType: 'image/png',
      },
    }, { type: 'done' });
    await waitForCount(persistence.artifactCalls, 1);
    expect(completed).toBe(false);
    expect(persistence.finalCalls).toHaveLength(0);

    artifactGate.resolve();
    const result = await handle.completion;
    expect(result.assistantMessage.metadata?.artifacts).toHaveLength(1);
    expect(persistence.finalCalls[0]?.assistantMessage.metadata?.artifacts).toHaveLength(1);
  });

  test('rejects artifact events above the per-turn count before materialization and reports once', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('artifact-count', 'artifact-count-run'));
    await waitForRuntime(runtime, 'artifact-count-run');

    runtime.finish(
      'artifact-count-run',
      ...Array.from({ length: CHAT_MAX_ARTIFACTS_PER_TURN + 3 }, (_, index): RuntimeTurnEvent => ({
        type: 'artifact',
        artifact: {
          itemId: `count-image-${index + 1}`,
          kind: 'image',
          sourcePath: `/tmp/count-image-${index + 1}.png`,
          mimeType: 'image/png',
        },
      })),
      { type: 'done' },
    );
    const result = await handle.completion;

    expect(persistence.artifactCalls).toHaveLength(CHAT_MAX_ARTIFACTS_PER_TURN);
    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(true);
    expect(result.assistantMessage.metadata?.artifacts).toHaveLength(CHAT_MAX_ARTIFACTS_PER_TURN);
    expect(result.assistantMessage.content.match(/本回合图片数量超过 8 张上限/g)).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
  });

  test('serializes burst artifacts against one shared byte budget and never writes the over-budget item', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const calls: ChatArtifactMaterialization[] = [];
    const vaultWrites: string[] = [];
    let active = 0;
    let maximumActive = 0;
    dependencies.materializeArtifact = async input => {
      calls.push(clone(input));
      const requestedBytes = input.artifact.itemId === 'budget-third'
        ? 15 * 1_024 * 1_024
        : CHAT_MAX_ARTIFACT_BYTES;
      const allowedBytes = Math.min(input.maxItemBytes, input.remainingTurnBytes);
      if (requestedBytes > allowedBytes) {
        throw new Error('source exceeds the remaining artifact budget');
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (input.artifact.itemId === 'budget-first') await firstGate.promise;
        if (input.artifact.itemId === 'budget-second') await secondGate.promise;
        vaultWrites.push(input.artifact.itemId);
        return {
          artifact: {
            id: input.artifact.itemId,
            type: 'image',
            vaultPath: `generated/${input.artifact.itemId}.png`,
            mimeType: 'image/png',
            createdAt: 1,
          },
          byteLength: requestedBytes,
        };
      } finally {
        active -= 1;
      }
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('artifact-budget', 'artifact-budget-run'));
    await waitForRuntime(runtime, 'artifact-budget-run');

    runtime.finish(
      'artifact-budget-run',
      ...['budget-first', 'budget-second', 'budget-third', 'budget-after-failure']
        .map((itemId): RuntimeTurnEvent => ({
          type: 'artifact',
          artifact: { itemId, kind: 'image', sourcePath: `/tmp/${itemId}.png` },
        })),
      { type: 'done' },
    );
    await waitForCount(calls, 1);
    expect(maximumActive).toBe(1);
    firstGate.resolve();
    await waitForCount(calls, 2);
    expect(maximumActive).toBe(1);
    secondGate.resolve();
    await waitForCount(calls, 3);
    const result = await handle.completion;

    expect(calls.map(call => call.remainingTurnBytes)).toEqual([
      CHAT_MAX_ARTIFACT_BYTES_PER_TURN,
      CHAT_MAX_ARTIFACT_BYTES_PER_TURN - CHAT_MAX_ARTIFACT_BYTES,
      CHAT_MAX_ARTIFACT_BYTES_PER_TURN - (2 * CHAT_MAX_ARTIFACT_BYTES),
    ]);
    expect(calls.every(call => call.maxItemBytes === CHAT_MAX_ARTIFACT_BYTES)).toBe(true);
    expect(vaultWrites).toEqual(['budget-first', 'budget-second']);
    expect(calls.map(call => call.artifact.itemId)).not.toContain('budget-after-failure');
    expect(result.assistantMessage.metadata?.artifacts?.map(artifact => artifact.id)).toEqual([
      'budget-first',
      'budget-second',
    ]);
    expect(result.assistantMessage.content.match(/图片保存失败/g)).toHaveLength(1);
    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(true);
    expect(persistence.finalCalls).toHaveLength(1);
  });

  test('cancellation never releases an in-flight reservation to queued artifact work', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const calls: ChatArtifactMaterialization[] = [];
    dependencies.materializeArtifact = async input => {
      calls.push(clone(input));
      if (!input.signal.aborted) {
        await new Promise<void>(resolve => {
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      throw new Error('materialization cancelled');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('artifact-cancel', 'artifact-cancel-run'));
    await waitForRuntime(runtime, 'artifact-cancel-run');

    runtime.emit('artifact-cancel-run', {
      type: 'artifact',
      artifact: { itemId: 'cancel-first', kind: 'image', sourcePath: '/tmp/cancel-first.png' },
    });
    runtime.emit('artifact-cancel-run', {
      type: 'artifact',
      artifact: { itemId: 'cancel-queued', kind: 'image', sourcePath: '/tmp/cancel-queued.png' },
    });
    await waitForCount(calls, 1);
    const stop = coordinator.stopConversation('artifact-cancel');
    await stop.completions;
    const result = await handle.completion;

    expect(calls.map(call => call.artifact.itemId)).toEqual(['cancel-first']);
    expect(result.status).toBe('cancelled');
    expect(result.assistantMessage.metadata?.artifacts).toBeUndefined();
    expect(result.finalPersisted).toBe(true);
    expect(persistence.finalCalls).toHaveLength(1);
  });

  test('bounds artifact materialization concurrency across simultaneous conversations', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const calls: ChatArtifactMaterialization[] = [];
    const gates: Array<Deferred<void>> = [];
    let active = 0;
    let maximumActive = 0;
    dependencies.materializeArtifact = async input => {
      calls.push(clone(input));
      const gate = deferred<void>();
      gates.push(gate);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await gate.promise;
        return {
          artifact: {
            id: input.artifact.itemId,
            type: 'image',
            vaultPath: `generated/${input.artifact.itemId}.png`,
            mimeType: 'image/png',
            createdAt: 1,
          },
          byteLength: 8,
        };
      } finally {
        active -= 1;
      }
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handles = await Promise.all(['one', 'two', 'three'].map(name => (
      coordinator.submit(submission(`artifact-global-${name}`, `artifact-global-${name}-run`))
    )));
    await Promise.all(handles.map(handle => waitForRuntime(runtime, handle.runId)));

    for (const handle of handles) {
      runtime.finish(handle.runId, {
        type: 'artifact',
        artifact: {
          itemId: `${handle.runId}-image`,
          kind: 'image',
          sourcePath: `/tmp/${handle.runId}.png`,
        },
      }, { type: 'done' });
    }
    await waitForCount(calls, CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS);
    expect(maximumActive).toBe(CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS);
    gates[0]?.resolve();
    await waitForCount(calls, 3);
    expect(maximumActive).toBe(CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS);
    for (const gate of gates) gate.resolve();
    const results = await Promise.all(handles.map(handle => handle.completion));

    expect(results.every(result => result.status === 'completed')).toBe(true);
    expect(results.every(result => result.finalPersisted)).toBe(true);
  });

  test('keeps normal multi-image Runtime order through final persistence', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('artifact-order', 'artifact-order-run'));
    await waitForRuntime(runtime, 'artifact-order-run');

    runtime.finish(
      'artifact-order-run',
      ...['first', 'second', 'third'].map((itemId): RuntimeTurnEvent => ({
        type: 'artifact',
        artifact: { itemId, kind: 'image', sourcePath: `/tmp/${itemId}.png` },
      })),
      { type: 'done' },
    );
    const result = await handle.completion;

    const expected = ['first', 'second', 'third'];
    expect(persistence.artifactCalls.map(call => call.artifact.itemId)).toEqual(expected);
    expect(result.assistantMessage.metadata?.artifacts?.map(artifact => artifact.id)).toEqual(expected);
    expect(persistence.finalCalls[0]?.assistantMessage.metadata?.artifacts?.map(artifact => artifact.id))
      .toEqual(expected);
    expect(result.status).toBe('completed');
    expect(result.finalPersisted).toBe(true);
  });

  test('keeps a runtime diagnostic out of chat and continues through image materialization', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const handle = await coordinator.submit(submission('diagnostic-image', 'diagnostic-image-run'));
    await waitForRuntime(runtime, 'diagnostic-image-run');

    runtime.finish(
      'diagnostic-image-run',
      { type: 'text', content: '正在生成图片。' },
      {
        type: 'diagnostic',
        code: 'codex_stream_snapshot_diverged',
        message: 'Codex 流式文本与最终快照不一致，已保留已接收内容。',
        detail: 'streamedLength=7; snapshotLength=9',
      },
      {
        type: 'artifact',
        artifact: {
          itemId: 'diagnostic-image-artifact',
          kind: 'image',
          sourcePath: '/tmp/diagnostic-image.png',
          mimeType: 'image/png',
        },
      },
      { type: 'done' },
    );
    const result = await handle.completion;

    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.content).toBe('正在生成图片。');
    expect(result.assistantMessage.content).not.toContain('流式文本与最终快照不一致');
    expect(result.assistantMessage.metadata?.artifacts).toHaveLength(1);
    expect(persistence.finalCalls[0]?.assistantMessage.metadata?.artifacts).toHaveLength(1);
  });

  test('does not abort the runtime when session persistence fails and marks output unpersisted', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistSession = async () => {
      throw new Error('session disk write failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('session-failure', 'session-failure-run'));
    await waitForRuntime(runtime, 'session-failure-run');

    runtime.emit('session-failure-run', { type: 'session', sessionId: 'session-to-save' });
    await vi.waitFor(async () => {
      const snapshot = await coordinator.snapshotConversation('session-failure');
      expect(snapshot.runs[0]?.persistenceError).toContain('session disk write failed');
    });
    expect(runtime.get('session-failure-run').aborted).toBe(false);
    runtime.finish(
      'session-failure-run',
      { type: 'text', content: 'runtime kept going' },
      { type: 'done' },
    );
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(false);
    expect(result.persistenceError).toContain('session disk write failed');
    expect(result.assistantMessage.content).toContain('runtime kept going');
    expect(runtime.get('session-failure-run').aborted).toBe(false);
  });

  test('does not abort the runtime when artifact materialization fails and persists later text once', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.materializeArtifact = async () => {
      throw new Error('artifact disk write failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('artifact-failure', 'artifact-failure-run'));
    await waitForRuntime(runtime, 'artifact-failure-run');

    runtime.emit('artifact-failure-run', {
      type: 'artifact',
      artifact: { itemId: 'broken-image', kind: 'image', sourcePath: '/tmp/broken.png' },
    });
    await vi.waitFor(async () => {
      const snapshot = await coordinator.snapshotConversation('artifact-failure');
      expect(snapshot.runs[0]?.error).toContain('artifact disk write failed');
    });
    expect(runtime.get('artifact-failure-run').aborted).toBe(false);
    runtime.finish(
      'artifact-failure-run',
      { type: 'text', content: 'text after artifact failure' },
      { type: 'done' },
    );
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.finalPersisted).toBe(true);
    expect(result.persistenceError).toBeNull();
    expect(result.assistantMessage.content).toContain('图片保存失败');
    expect(result.assistantMessage.content).toContain('text after artifact failure');
    expect(result.assistantMessage.content.match(/图片保存失败/g)).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
    expect(runtime.get('artifact-failure-run').aborted).toBe(false);
  });

  test('shutdown cancels active and queued runs, waits for their persistence, and rejects new work', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const first = await coordinator.submit(submission('shutdown-one', 'shutdown-active-one'));
    const queuedPromise = coordinator.submit(submission('shutdown-one', 'shutdown-queued'));
    const second = await coordinator.submit(submission('shutdown-two', 'shutdown-active-two'));
    await waitForCount(runtime.invocations, 2);

    const firstShutdown = coordinator.shutdown();
    const repeatedShutdown = coordinator.shutdown();
    await Promise.all([firstShutdown, repeatedShutdown]);
    const queued = await queuedPromise;
    const results = await Promise.all([first.completion, queued.completion, second.completion]);

    expect(results.every(result => result.status === 'cancelled')).toBe(true);
    expect(results.every(result => result.cancellationReason === 'shutdown')).toBe(true);
    expect(runtime.invocations.map(item => item.id).sort()).toEqual([
      'shutdown-active-one',
      'shutdown-active-two',
    ]);
    expect(persistence.startCalls.map(call => call.runId)).toContain('shutdown-queued');
    expect(persistence.finalCalls).toHaveLength(3);
    expect(persistence.cancellationCalls).toHaveLength(3);
    await expect(coordinator.submit(submission('new', 'after-shutdown')))
      .rejects.toBeInstanceOf(ChatCoordinatorShutdownError);
  });

  test('makes queued to paused restart recovery reachable without replaying the queued run', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const active = await coordinator.submit(submission('restart-lane', 'restart-active'));
    await waitForRuntime(runtime, 'restart-active');
    const queued = await coordinator.submit(submission('restart-lane', 'restart-queued'));

    expect(persistence.turnStates.get('restart-active')).toBe('active');
    expect(persistence.turnStates.get('restart-queued')).toBe('queued');
    expect(runtime.invocations.map(invocation => invocation.id)).not.toContain('restart-queued');

    // This models VaultStore.recoverInterruptedTurns(), which runs before a
    // fresh coordinator and is the sole owner of durable turn migration.
    persistence.simulateVaultRestartRecovery();
    expect(persistence.turnStates.get('restart-active')).toBe('interrupted');
    expect(persistence.turnStates.get('restart-queued')).toBe('paused');
    expect(runtime.invocations.map(invocation => invocation.id)).toEqual(['restart-active']);

    await coordinator.shutdown();
    await Promise.all([active.completion, queued.completion]);
  });

  test('detects duplicate runtime session ownership across conversations', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const owner = await coordinator.submit(submission('owner', 'owner-run'));
    const contender = await coordinator.submit(submission('contender', 'contender-run'));
    await waitForCount(runtime.invocations, 2);

    runtime.emit('owner-run', { type: 'session', sessionId: 'duplicate-session' });
    runtime.emit('contender-run', { type: 'session', sessionId: 'duplicate-session' });
    runtime.finish('owner-run', { type: 'done' });
    runtime.get('contender-run').deferred.resolve();
    const [ownerResult, contenderResult] = await Promise.all([
      owner.completion,
      contender.completion,
    ]);

    expect(ownerResult.status).toBe('completed');
    expect(contenderResult.status).toBe('failed');
    expect(contenderResult.sessionId).toBeNull();
    expect(runtime.get('contender-run').aborted).toBe(true);
    expect(coordinator.getSessionOwner('duplicate-session')).toMatchObject({
      conversationId: 'owner',
      runId: 'owner-run',
    });
    expect(coordinator.listSessionConflicts()).toHaveLength(1);
  });

  test('does not expose a canonical session until durable claim and session patch both settle', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const claimGate = deferred<void>();
    const claimEntered = deferred<void>();
    const dependencies = persistence.dependencies(runtime);
    const durableClaim = dependencies.claimSessionOwnership;
    dependencies.claimSessionOwnership = async ownership => {
      claimEntered.resolve();
      await claimGate.promise;
      return durableClaim(ownership);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('durable-session', 'durable-session-run'));
    await waitForRuntime(runtime, 'durable-session-run');

    let admissionSettled = false;
    const admission = runtime.admit('durable-session-run', 'canonical-session')
      .then(() => { admissionSettled = true; });
    await claimEntered.promise;
    expect(admissionSettled).toBe(false);
    expect(persistence.sessionCalls).toHaveLength(0);
    expect((await coordinator.snapshotConversation('durable-session')).runs[0]?.sessionId).toBeNull();

    claimGate.resolve();
    await admission;
    expect(persistence.sessionCalls).toHaveLength(1);
    expect((await coordinator.snapshotConversation('durable-session')).runs[0]?.sessionId)
      .toBe('canonical-session');

    runtime.finish('durable-session-run',
      { type: 'session', sessionId: 'canonical-session' },
      { type: 'done', sessionId: 'canonical-session' });
    expect((await handle.completion).status).toBe('completed');
    expect(persistence.sessionCalls).toHaveLength(1);
  });

  test('durably admits only one of two conversations racing for one canonical session', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const claimGate = deferred<void>();
    const dependencies = persistence.dependencies(runtime);
    const durableClaim = dependencies.claimSessionOwnership;
    dependencies.claimSessionOwnership = async ownership => {
      await claimGate.promise;
      return durableClaim(ownership);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const first = await coordinator.submit(submission('canonical-first', 'canonical-first-run'));
    const second = await coordinator.submit(submission('canonical-second', 'canonical-second-run'));
    await waitForCount(runtime.invocations, 2);

    const admissions = [
      runtime.admit('canonical-first-run', 'shared-canonical'),
      runtime.admit('canonical-second-run', 'shared-canonical'),
    ];
    claimGate.resolve();
    const settled = await Promise.allSettled(admissions);
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect(persistence.sessionCalls).toHaveLength(1);

    const winningSessionCall = persistence.sessionCalls[0];
    if (!winningSessionCall) throw new Error('Expected one durable session winner.');
    const winner = winningSessionCall.runId;
    const loser = winner === 'canonical-first-run' ? 'canonical-second-run' : 'canonical-first-run';
    runtime.finish(winner,
      { type: 'session', sessionId: 'shared-canonical' },
      { type: 'done', sessionId: 'shared-canonical' });
    runtime.finish(loser,
      { type: 'error', message: 'canonical session admission failed' },
      { type: 'done' });
    const results = await Promise.all([first.completion, second.completion]);
    expect(results.filter(result => result.status === 'completed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'failed')).toHaveLength(1);
  });

  test('fails closed before Runtime when a requested resume session has no verified owner', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const pending = submission('resume-missing-owner', 'resume-missing-owner-run');
    pending.runtimeRequest.sessionId = 'missing-owner-session';

    const handle = await coordinator.submit(pending);
    const result = await handle.completion;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('has no verified owner');
    expect(runtime.invocations).toHaveLength(0);
    expect(persistence.finalCalls).toHaveLength(1);
    expect(result.assistantMessage.role).toBe('error');
    expect(new UnownedChatSessionError({
      sessionId: 'missing-owner-session',
      conversationId: 'resume-missing-owner',
      agentId: 'claude',
      runId: 'resume-missing-owner-run',
      claimedAt: 0,
    })).toBeInstanceOf(UnownedChatSessionError);
  });

  test('resumes only the verified conversation and rejects cross-conversation use before Runtime', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwnerships = async () => [{
      sessionId: 'verified-resume-session',
      conversationId: 'verified-owner',
      agentId: 'claude',
      runId: 'historical-run',
      claimedAt: 1,
    }];
    const coordinator = new ChatRunCoordinator(dependencies);
    await coordinator.recover();

    const allowedSubmission = submission('verified-owner', 'verified-resume');
    allowedSubmission.runtimeRequest.sessionId = 'verified-resume-session';
    const allowed = await coordinator.submit(allowedSubmission);
    await waitForRuntime(runtime, 'verified-resume');
    runtime.finish('verified-resume', { type: 'done', sessionId: 'verified-resume-session' });
    expect((await allowed.completion).status).toBe('completed');
    expect(coordinator.getSessionOwner('verified-resume-session')?.runId).toBe('verified-resume');

    const rejectedSubmission = submission('wrong-conversation', 'rejected-resume');
    rejectedSubmission.runtimeRequest.sessionId = 'verified-resume-session';
    const rejected = await coordinator.submit(rejectedSubmission);
    const rejectedResult = await rejected.completion;
    expect(rejectedResult.status).toBe('failed');
    expect(runtime.invocations.map(invocation => invocation.id)).not.toContain('rejected-resume');
    expect(coordinator.listSessionConflicts()).toHaveLength(1);
  });

  test('accepts a replacement session when the runtime does not resume stored metadata', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwnerships = async () => [{
      sessionId: 'stored-claude-session',
      conversationId: 'claude-owner',
      agentId: 'claude',
      runId: 'historical-claude-run',
      claimedAt: 1,
    }];
    const coordinator = new ChatRunCoordinator(dependencies);
    await coordinator.recover();

    const pending = submission('claude-owner', 'claude-new-session');
    pending.runtimeRequest.agentId = 'claude';
    pending.runtimeRequest.sessionId = 'stored-claude-session';
    pending.userMessage.agentId = 'claude';
    pending.assistantMessage.agentId = 'claude';
    const handle = await coordinator.submit(pending);
    await waitForRuntime(runtime, 'claude-new-session');
    runtime.finish(
      'claude-new-session',
      { type: 'session', sessionId: 'fresh-claude-session' },
      { type: 'done', sessionId: 'fresh-claude-session' },
    );

    await expect(handle.completion).resolves.toMatchObject({
      status: 'completed',
      sessionId: 'fresh-claude-session',
    });
    expect(persistence.sessionCalls.some(call => (
      call.agentId === 'claude' && call.sessionId === 'fresh-claude-session'
    ))).toBe(true);
  });

  test('does not pollute the session registry when durable ownership claim fails', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.claimSessionOwnership = async () => {
      throw new Error('session claim write failed');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handle = await coordinator.submit(submission('claim-failure', 'claim-failure-run'));
    await waitForRuntime(runtime, 'claim-failure-run');

    runtime.emit('claim-failure-run', { type: 'session', sessionId: 'unclaimed-session' });
    await vi.waitFor(async () => {
      expect((await coordinator.snapshotConversation('claim-failure')).runs[0]?.persistenceError)
        .toContain('session claim write failed');
    });
    expect(coordinator.getSessionOwner('unclaimed-session')).toBeNull();
    expect(runtime.get('claim-failure-run').aborted).toBe(false);

    runtime.finish('claim-failure-run', { type: 'text', content: 'still running' }, { type: 'done' });
    const result = await handle.completion;
    expect(result.status).toBe('failed');
    expect(result.sessionId).toBeNull();
    expect(coordinator.getSessionOwner('unclaimed-session')).toBeNull();
  });

  test('clears pruned conversation owners and conflicts, then reloads the durable owner on resume', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwner = async sessionId => {
      const owner = persistence.durableSessionOwners.get(sessionId);
      return owner ? {
        sessionId: owner.sessionId,
        conversationId: owner.conversationId,
        agentId: owner.agentId,
        runId: owner.runId,
        claimedAt: 0,
      } : null;
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const ownerRun = await coordinator.submit(submission('registry-owner', 'registry-owner-run'));
    await waitForRuntime(runtime, 'registry-owner-run');
    runtime.finish(
      'registry-owner-run',
      { type: 'session', sessionId: 'registry-session' },
      { type: 'done' },
    );
    await ownerRun.completion;

    const contenderSubmission = submission('registry-contender', 'registry-contender-run');
    contenderSubmission.runtimeRequest.sessionId = 'registry-session';
    const contender = await coordinator.submit(contenderSubmission);
    expect((await contender.completion).status).toBe('failed');
    expect(runtime.invocations.map(invocation => invocation.id))
      .not.toContain('registry-contender-run');
    expect(coordinator.listSessionConflicts()).toHaveLength(1);

    await vi.waitFor(() => {
      expect(coordinator.pruneIdleLanes(2).retainedIdleConversationIds.sort()).toEqual([
        'registry-contender',
        'registry-owner',
      ]);
    });
    expect(coordinator.pruneIdleLanes(0).prunedConversationIds.sort()).toEqual([
      'registry-contender',
      'registry-owner',
    ]);
    expect(coordinator.getSessionOwner('registry-session')).toBeNull();
    expect(coordinator.listSessionConflicts()).toEqual([]);

    const resumeSubmission = submission('registry-owner', 'registry-resume-run');
    resumeSubmission.runtimeRequest.sessionId = 'registry-session';
    const resumed = await coordinator.submit(resumeSubmission);
    await waitForRuntime(runtime, 'registry-resume-run');
    runtime.finish('registry-resume-run', { type: 'done', sessionId: 'registry-session' });
    expect((await resumed.completion).status).toBe('completed');
    expect(coordinator.getSessionOwner('registry-session')).toMatchObject({
      conversationId: 'registry-owner',
      runId: 'registry-resume-run',
    });
  });

  test('retains only eight completed unwatched lanes and reloads pruned history', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwner = async sessionId => {
      const owner = persistence.durableSessionOwners.get(sessionId);
      return owner ? {
        sessionId: owner.sessionId,
        conversationId: owner.conversationId,
        agentId: owner.agentId,
        runId: owner.runId,
        claimedAt: 0,
      } : null;
    };
    const coordinator = new ChatRunCoordinator(dependencies);

    for (let index = 0; index < 12; index += 1) {
      const runId = `lru-run-${index}`;
      const handle = await coordinator.submit(submission(`lru-${index}`, runId));
      await waitForRuntime(runtime, runId);
      const events: RuntimeTurnEvent[] = index === 0
        ? [
          { type: 'session', sessionId: 'lru-session-owner' },
          { type: 'text', content: 'historical output' },
          { type: 'done' },
        ]
        : [{ type: 'done' }];
      runtime.finish(runId, ...events);
      await handle.completion;
    }

    await vi.waitFor(() => {
      expect(coordinator.pruneIdleLanes().retainedIdleConversationIds).toHaveLength(8);
    });
    const retained = coordinator.pruneIdleLanes();
    expect(retained.prunedConversationIds).toHaveLength(0);
    expect(retained.retainedIdleConversationIds).toHaveLength(8);
    expect(retained.retainedIdleConversationIds).not.toContain('lru-0');
    expect(coordinator.getSessionOwner('lru-session-owner')).toBeNull();

    const loadsBeforeReopen = persistence.loadCalls.filter(id => id === 'lru-0').length;
    const reopened = await coordinator.snapshotConversation('lru-0');
    expect(persistence.loadCalls.filter(id => id === 'lru-0')).toHaveLength(loadsBeforeReopen + 1);
    expect(reopened.messages.find(message => message.id === 'lru-run-0-assistant')?.content)
      .toBe('historical output');

    const resumedSubmission = submission('lru-0', 'lru-resume');
    resumedSubmission.runtimeRequest.sessionId = 'lru-session-owner';
    const resumed = await coordinator.submit(resumedSubmission);
    await waitForRuntime(runtime, 'lru-resume');
    runtime.finish('lru-resume', { type: 'done', sessionId: 'lru-session-owner' });
    expect((await resumed.completion).status).toBe('completed');
    expect(coordinator.getSessionOwner('lru-session-owner')).toMatchObject({
      conversationId: 'lru-0',
      runId: 'lru-resume',
    });
  });

  test('prunes history-only lanes to eight and reloads the oldest on demand', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    for (let index = 0; index < 12; index += 1) {
      persistence.conversations.set(`history-${index}`, {
        id: `history-${index}`,
        title: `History ${index}`,
        agentId: 'claude',
        createdAt: index,
        updatedAt: index,
        messages: [{
          id: `history-message-${index}`,
          role: 'assistant',
          content: `history ${index}`,
          createdAt: index,
          agentId: 'claude',
        }],
      });
    }
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    for (let index = 0; index < 12; index += 1) {
      await coordinator.snapshotConversation(`history-${index}`);
    }

    const loadsBeforeReopen = persistence.loadCalls.filter(id => id === 'history-0').length;
    const reopened = await coordinator.snapshotConversation('history-0');
    expect(reopened.messages[0]?.content).toBe('history 0');
    expect(persistence.loadCalls.filter(id => id === 'history-0')).toHaveLength(loadsBeforeReopen + 1);

    const report = coordinator.pruneIdleLanes();
    expect(report.prunedConversationIds).toHaveLength(0);
    expect(report.retainedIdleConversationIds).toHaveLength(8);
  });

  test('stopping an unknown conversation does not create an unbounded empty lane', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    for (let index = 0; index < 20; index += 1) {
      const stopped = coordinator.stopConversation(`unknown-${index}`);
      expect(stopped).toMatchObject({ stopEpoch: 0, cancelledRunIds: [] });
      await expect(stopped.completions).resolves.toEqual([]);
    }

    expect(coordinator.pruneIdleLanes()).toMatchObject({
      prunedConversationIds: [],
      retainedIdleConversationIds: [],
    });
    expect(persistence.loadCalls).toHaveLength(0);
  });

  test('keeps failed durable admission caller-owned without manufacturing backpressure', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    const diagnostics: Array<{ stage: string; failureKind: string }> = [];
    dependencies.onPersistenceFailure = input => diagnostics.push(input);
    dependencies.persistStart = async input => {
      persistence.startCalls.push(clone(input));
      throw new Error(`start failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    await expect(coordinator.submit(submission('unsafe-0', 'unsafe-run-0')))
      .rejects.toThrow('start failed for unsafe-run-0');
    let sameLaneError: unknown;
    try {
      await coordinator.submit(submission('unsafe-0', 'unsafe-run-retry'));
    } catch (error) {
      sameLaneError = error;
    }
    expect(sameLaneError).toBeInstanceOf(Error);
    expect((sameLaneError as Error).message).toBe('start failed for unsafe-run-retry');
    let overflowError: unknown;
    try {
      await coordinator.submit(submission('unsafe-overflow', 'unsafe-run-overflow'));
    } catch (error) {
      overflowError = error;
    }
    expect(overflowError).toBeInstanceOf(Error);
    expect((overflowError as Error).message).toBe('start failed for unsafe-run-overflow');
    expect(persistence.startCalls).toHaveLength(3);
    expect(diagnostics).toEqual([
      { stage: 'start', failureKind: 'Error' },
      { stage: 'start', failureKind: 'Error' },
      { stage: 'start', failureKind: 'Error' },
    ]);
    expect(() => coordinator.assertContextPreparationAllowed('unsafe-0')).not.toThrow();

    const report = coordinator.pruneIdleLanes(0);
    expect(report.prunedConversationIds).toContain('unsafe-0');
    const loadsBeforeSnapshot = persistence.loadCalls.filter(id => id === 'unsafe-0').length;
    const snapshot = await coordinator.snapshotConversation('unsafe-0');
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.messages).toEqual([]);
    expect(persistence.loadCalls.filter(id => id === 'unsafe-0')).toHaveLength(loadsBeforeSnapshot + 1);
  });

  test('serializes twenty concurrent start failures without starting Runtime or opening a circuit', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistStart = async input => {
      persistence.startCalls.push(clone(input));
      throw new Error(`concurrent start failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const submissions = Array.from({ length: 20 }, (_, index) => (
      coordinator.submit(submission(`concurrent-failure-${index}`, `concurrent-failure-run-${index}`))
    ));
    const settled = await Promise.allSettled(submissions);

    expect(settled.every(result => result.status === 'rejected')).toBe(true);
    expect(settled.filter(result => (
      result.status === 'rejected' && result.reason instanceof ChatPersistenceBackpressureError
    ))).toHaveLength(0);
    expect(persistence.startCalls).toHaveLength(20);
    expect(runtime.invocations).toHaveLength(0);
    for (let index = 0; index < 20; index += 1) {
      const conversationId = `concurrent-failure-${index}`;
      const snapshot = await coordinator.snapshotConversation(conversationId);
      expect(snapshot.messages).toEqual([]);
      expect(snapshot.runs).toEqual([]);
    }
  });

  test('keeps sixty prequeued same-lane start failures caller-owned', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistStart = async input => {
      persistence.startCalls.push(clone(input));
      throw new Error(`same-lane start failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const settled = await Promise.allSettled(Array.from({ length: 60 }, (_, index) => (
      coordinator.submit(submission('same-lane-failure', `same-lane-failure-run-${index}`))
    )));

    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(60);
    expect(settled.filter(result => (
      result.status === 'rejected' && result.reason instanceof ChatPersistenceBackpressureError
    ))).toHaveLength(0);
    expect(persistence.startCalls).toHaveLength(60);
    expect(runtime.invocations).toHaveLength(0);
    const snapshot = await coordinator.snapshotConversation('same-lane-failure');
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.runs).toEqual([]);
  });

  test.each([false, true])(
    'blocks sixty already-persisted same-lane turns after the first final failure (preCancelled=%s)',
    async preCancelled => {
      const runtime = new FakeRuntime();
      const persistence = new FakePersistence();
      const dependencies = persistence.dependencies(runtime);
      dependencies.persistFinal = async input => {
        persistence.finalCalls.push(clone(input));
        throw new Error(`first final failed for ${input.runId}`);
      };
      const coordinator = new ChatRunCoordinator(dependencies);
      const handles = await Promise.all(Array.from({ length: 60 }, (_, index) => (
        coordinator.submit(submission('persisted-queue-failure', `persisted-queue-run-${index}`))
      )));
      expect(persistence.startCalls).toHaveLength(60);
      expect(runtime.invocations.map(invocation => invocation.id)).toEqual(['persisted-queue-run-0']);

      let stopped: ChatStopResult | null = null;
      if (preCancelled) {
        runtime.autoResolveOnAbort = true;
        stopped = coordinator.stopConversation('persisted-queue-failure');
        expect(stopped.cancelledRunIds).toHaveLength(60);
      } else {
        runtime.finish(
          'persisted-queue-run-0',
          { type: 'text', content: 'first unique unpersisted output' },
          { type: 'done' },
        );
      }
      const results = await Promise.all(handles.map(handle => handle.completion));
      await stopped?.completions;

      expect(results[0]).toMatchObject({ status: 'failed', finalPersisted: false });
      for (const result of results.slice(1)) {
        expect(result.status).toBe('failed');
        expect(result.error).toContain('已安全写入队列');
      }
      expect(results.slice(1).every(result => (
        result.error?.includes('恢复为暂停任务') === true
      ))).toBe(true);
      expect(runtime.invocations).toHaveLength(1);
      expect(persistence.activationCalls).toHaveLength(0);
      expect(persistence.finalCalls).toHaveLength(1);

      const snapshot = await coordinator.snapshotConversation('persisted-queue-failure');
      expect(snapshot.messages).toHaveLength(100);
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0]?.runId).toBe('persisted-queue-run-0');
      if (!preCancelled) {
        expect(snapshot.messages.find(message => message.id === 'persisted-queue-run-0-assistant')?.content)
          .toBe('first unique unpersisted output');
      }
      persistence.simulateVaultRestartRecovery();
      for (let index = 1; index < 60; index += 1) {
        expect(persistence.turnStates.get(`persisted-queue-run-${index}`))
          .toBe(preCancelled ? 'interrupted' : 'paused');
      }
    },
  );

  test('preserves the first volatile failure after late queued cancellation snapshots settle', async () => {
    const runtime = new FakeRuntime();
    runtime.autoResolveOnAbort = true;
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistFinal = async input => {
      persistence.finalCalls.push(clone(input));
      throw new Error(`late-snapshot final failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const firstSubmission = submission('late-snapshot-lane', 'late-snapshot-run-0');
    firstSubmission.cancellationMessage = 'first unique volatile output';
    const handles = await Promise.all([
      coordinator.submit(firstSubmission),
      ...Array.from({ length: 59 }, (_, index) => (
        coordinator.submit(submission(
          'late-snapshot-lane',
          `late-snapshot-run-${index + 1}`,
        ))
      )),
    ]);
    await waitForRuntime(runtime, 'late-snapshot-run-0');

    const cancellationGate = deferred<void>();
    for (let index = 1; index < 60; index += 1) {
      persistence.cancellationGates.set(`late-snapshot-run-${index}`, cancellationGate);
    }
    let stopSettled = false;
    const stop = coordinator.stopConversation('late-snapshot-lane');
    void stop.completions.then(() => {
      stopSettled = true;
    });
    await waitForCount(persistence.cancellationCalls, 60);
    const first = await handles[0].completion;
    expect(first).toMatchObject({ status: 'failed', finalPersisted: false });
    expect(stopSettled).toBe(false);
    expect((await coordinator.snapshotConversation('late-snapshot-lane')).messages
      .find(message => message.id === 'late-snapshot-run-0-assistant')?.content)
      .toBe('first unique volatile output');

    cancellationGate.resolve();
    await stop.completions;
    const snapshot = await coordinator.snapshotConversation('late-snapshot-lane');
    expect(snapshot.messages).toHaveLength(100);
    expect(snapshot.messages.find(message => message.id === 'late-snapshot-run-0-assistant')?.content)
      .toBe('first unique volatile output');
    expect(snapshot.runs).toEqual([
      expect.objectContaining({ runId: 'late-snapshot-run-0', finalPersisted: false }),
    ]);
  });

  test('blocks an active run whose persistStart returns after another lane opens the circuit', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const startGate = deferred<void>();
    const startEntered = deferred<void>();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistStart = async input => {
      if (input.runId === 'late-start-target') {
        startEntered.resolve();
        await startGate.promise;
      }
      return persistence.persistStart(input);
    };
    dependencies.persistFinal = async input => {
      if (input.runId === 'late-start-source') {
        persistence.finalCalls.push(clone(input));
        throw new Error('source final failed while target start was in flight');
      }
      return persistence.persistFinal(input);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const source = await coordinator.submit(submission('late-start-source-lane', 'late-start-source'));
    await waitForRuntime(runtime, 'late-start-source');
    const targetPromise = coordinator.submit(submission('late-start-target-lane', 'late-start-target'));
    await startEntered.promise;

    runtime.finish(
      'late-start-source',
      { type: 'text', content: 'source volatile output' },
      { type: 'done' },
    );
    await source.completion;
    startGate.resolve();
    const target = await targetPromise;
    const result = await target.completion;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('恢复为中断任务');
    expect(runtime.invocations.map(invocation => invocation.id)).toEqual(['late-start-source']);
    expect(persistence.turnStates.get('late-start-target')).toBe('active');
    persistence.simulateVaultRestartRecovery();
    expect(persistence.turnStates.get('late-start-target')).toBe('interrupted');
  });

  test('rejects an in-flight same-lane start failure without overwriting the first volatile failure', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const startGate = deferred<void>();
    const startEntered = deferred<void>();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistStart = async input => {
      if (input.runId === 'late-start-failing-target') {
        startEntered.resolve();
        await startGate.promise;
        persistence.startCalls.push(clone(input));
        throw new Error('target start failed after circuit opened');
      }
      return persistence.persistStart(input);
    };
    dependencies.persistFinal = async input => {
      persistence.finalCalls.push(clone(input));
      throw new Error('first final failure');
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const source = await coordinator.submit(submission('late-start-failure-lane', 'late-start-failure-source'));
    await waitForRuntime(runtime, 'late-start-failure-source');
    const targetOutcome = coordinator
      .submit(submission('late-start-failure-lane', 'late-start-failing-target'))
      .then(handle => handle, error => error as unknown);
    await startEntered.promise;

    runtime.finish(
      'late-start-failure-source',
      { type: 'text', content: 'first protected output' },
      { type: 'done' },
    );
    await source.completion;
    startGate.resolve();
    expect(await targetOutcome).toBeInstanceOf(ChatPersistenceBackpressureError);

    const snapshot = await coordinator.snapshotConversation('late-start-failure-lane');
    expect(snapshot.messages.find(message => message.id === 'late-start-failure-source-assistant')?.content)
      .toBe('first protected output');
    expect(snapshot.messages.some(message => message.id === 'late-start-failing-target-user')).toBe(false);
    expect(snapshot.runs.map(run => run.runId)).toEqual(['late-start-failure-source']);
    expect(runtime.invocations.map(invocation => invocation.id)).toEqual(['late-start-failure-source']);
  });

  test('blocks a queued run when its activation returns after another lane opens the circuit', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const activationGate = deferred<void>();
    persistence.activationGates.set('late-activation-target', activationGate);
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistFinal = async input => {
      if (input.runId === 'late-activation-source') {
        persistence.finalCalls.push(clone(input));
        throw new Error('source final failed while activation was in flight');
      }
      return persistence.persistFinal(input);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const source = await coordinator.submit(submission('late-activation-source-lane', 'late-activation-source'));
    const laneHead = await coordinator.submit(submission('late-activation-lane', 'late-activation-head'));
    const target = await coordinator.submit(submission('late-activation-lane', 'late-activation-target'));
    await waitForRuntime(runtime, 'late-activation-source');
    await waitForRuntime(runtime, 'late-activation-head');

    runtime.finish('late-activation-head', { type: 'done' });
    await laneHead.completion;
    await waitForCount(persistence.activationCalls, 1);
    runtime.finish('late-activation-source', { type: 'done' });
    await source.completion;
    activationGate.resolve();
    const result = await target.completion;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('恢复为中断任务');
    expect(runtime.invocations.map(invocation => invocation.id)).not.toContain('late-activation-target');
    expect(persistence.turnStates.get('late-activation-target')).toBe('active');
    persistence.simulateVaultRestartRecovery();
    expect(persistence.turnStates.get('late-activation-target')).toBe('interrupted');
  });

  test('blocks a resume after its owner lookup returns into an open persistence circuit', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const ownerGate = deferred<void>();
    const ownerLookupEntered = deferred<void>();
    persistence.durableSessionOwners.set('late-resume-session', {
      runId: 'previous-resume-run',
      conversationId: 'late-resume-target-lane',
      agentId: 'claude',
      sessionId: 'late-resume-session',
      sessionConfigKey: 'previous-config',
    });
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwner = async sessionId => {
      ownerLookupEntered.resolve();
      await ownerGate.promise;
      return {
        sessionId,
        conversationId: 'late-resume-target-lane',
        agentId: 'claude',
        runId: 'previous-resume-run',
        claimedAt: 1,
      };
    };
    dependencies.persistFinal = async input => {
      if (input.runId === 'late-resume-source') {
        persistence.finalCalls.push(clone(input));
        throw new Error('source final failed during resume lookup');
      }
      return persistence.persistFinal(input);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const source = await coordinator.submit(submission('late-resume-source-lane', 'late-resume-source'));
    await waitForRuntime(runtime, 'late-resume-source');
    const resumeSubmission = submission('late-resume-target-lane', 'late-resume-target');
    resumeSubmission.runtimeRequest.sessionId = 'late-resume-session';
    const target = await coordinator.submit(resumeSubmission);
    await ownerLookupEntered.promise;

    runtime.finish('late-resume-source', { type: 'done' });
    await source.completion;
    ownerGate.resolve();
    const result = await target.completion;

    expect(result.status).toBe('failed');
    expect(result.error).toContain('恢复为中断任务');
    expect(runtime.invocations.map(invocation => invocation.id)).toEqual(['late-resume-source']);
    expect(persistence.turnStates.get('late-resume-target')).toBe('active');
  });

  test('does not yield a microtask between the final circuit fence and Runtime entry', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    let boundaryMicrotaskRan = false;
    dependencies.runTurn = (request, onEvent) => {
      expect(boundaryMicrotaskRan).toBe(false);
      return runtime.runTurn(request, onEvent);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const watch = coordinator.watchConversation('synchronous-runtime-fence', delivery => {
      if (delivery.type === 'run' && delivery.event.type === 'state'
        && delivery.event.run.phase === 'running') {
        void Promise.resolve().then(() => {
          boundaryMicrotaskRan = true;
        });
      }
    });
    await watch.ready;

    const handle = await coordinator.submit(submission(
      'synchronous-runtime-fence',
      'synchronous-runtime-fence-run',
    ));
    await waitForRuntime(runtime, 'synchronous-runtime-fence-run');
    await Promise.resolve();
    expect(boundaryMicrotaskRan).toBe(true);
    runtime.finish('synchronous-runtime-fence-run', { type: 'done' });
    await handle.completion;
    watch.close();
  });

  test('serializes only healthy start persistence while sixteen runtimes remain concurrent', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    let activeStartWrites = 0;
    let maxActiveStartWrites = 0;
    dependencies.persistStart = async input => {
      activeStartWrites += 1;
      maxActiveStartWrites = Math.max(maxActiveStartWrites, activeStartWrites);
      await Promise.resolve();
      try {
        return await persistence.persistStart(input);
      } finally {
        activeStartWrites -= 1;
      }
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handles = await Promise.all(Array.from({ length: 16 }, (_, index) => (
      coordinator.submit(submission(`healthy-concurrent-${index}`, `healthy-concurrent-run-${index}`))
    )));
    await vi.waitFor(() => expect(runtime.invocations).toHaveLength(16));
    expect(maxActiveStartWrites).toBe(1);
    expect(persistence.startCalls).toHaveLength(16);

    for (let index = 0; index < 16; index += 1) {
      runtime.finish(`healthy-concurrent-run-${index}`, { type: 'done' });
    }
    await expect(Promise.all(handles.map(handle => handle.completion)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'completed', finalPersisted: true }),
      ]));
  });

  test('folds final-write failures into bounded UI state and opens the global circuit breaker', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistFinal = async input => {
      persistence.finalCalls.push(clone(input));
      throw new Error(`final failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);

    const runId = 'unsafe-final-run';
    const handle = await coordinator.submit(submission('unsafe-final', runId));
    await waitForRuntime(runtime, runId);
    runtime.finish(runId, { type: 'text', content: 'unpersisted output' }, { type: 'done' });
    const result = await handle.completion;
    expect(result).toMatchObject({ status: 'failed', finalPersisted: false });
    const snapshot = await coordinator.snapshotConversation('unsafe-final');
    expect(snapshot.runs).toEqual([
      expect.objectContaining({ runId, phase: 'failed', finalPersisted: false }),
    ]);
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]?.content).toBe('unpersisted output');

    await expect(coordinator.submit(submission('unsafe-final-overflow', 'unsafe-final-overflow-run')))
      .rejects.toBeInstanceOf(ChatPersistenceBackpressureError);
    expect(() => coordinator.assertContextPreparationAllowed('unsafe-final-overflow'))
      .toThrow(ChatPersistenceBackpressureError);
    expect(runtime.invocations).toHaveLength(1);
    expect(persistence.finalCalls).toHaveLength(1);
    expect(coordinator.pruneIdleLanes(0).prunedConversationIds).toEqual([]);
  });

  test('retains the active set at a final-write outage but never grows it after the circuit opens', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.persistFinal = async input => {
      persistence.finalCalls.push(clone(input));
      throw new Error(`simultaneous final failed for ${input.runId}`);
    };
    const coordinator = new ChatRunCoordinator(dependencies);
    const handles = await Promise.all(Array.from({ length: 16 }, (_, index) => (
      coordinator.submit(submission(`final-outage-${index}`, `final-outage-run-${index}`))
    )));
    await vi.waitFor(() => expect(runtime.invocations).toHaveLength(16));

    for (let index = 0; index < 16; index += 1) {
      runtime.finish(
        `final-outage-run-${index}`,
        { type: 'text', content: `copyable outage output ${index}` },
        { type: 'done' },
      );
    }
    const results = await Promise.all(handles.map(handle => handle.completion));
    expect(results).toHaveLength(16);
    expect(results.every(result => result.status === 'failed' && !result.finalPersisted)).toBe(true);
    for (let index = 0; index < 16; index += 1) {
      const snapshot = await coordinator.snapshotConversation(`final-outage-${index}`);
      expect(snapshot.messages.at(-1)?.content).toBe(`copyable outage output ${index}`);
      expect(snapshot.runs).toEqual([
        expect.objectContaining({ runId: `final-outage-run-${index}`, finalPersisted: false }),
      ]);
    }

    const startsAtCircuit = persistence.startCalls.length;
    const runtimesAtCircuit = runtime.invocations.length;
    const rejected = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => (
      coordinator.submit(submission(`after-final-outage-${index}`, `after-final-outage-run-${index}`))
    )));
    expect(rejected.every(result => (
      result.status === 'rejected' && result.reason instanceof ChatPersistenceBackpressureError
    ))).toBe(true);
    expect(persistence.startCalls).toHaveLength(startsAtCircuit);
    expect(runtime.invocations).toHaveLength(runtimesAtCircuit);
    expect(persistence.finalCalls).toHaveLength(16);
  });

  test('never counts running or watched lanes against the idle-lane retention limit', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const completedHandles = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const runId = `idle-${index}`;
      const handle = await coordinator.submit(submission(`idle-lane-${index}`, runId));
      await waitForRuntime(runtime, runId);
      runtime.finish(runId, { type: 'done' });
      return handle;
    }));
    await Promise.all(completedHandles.map(handle => handle.completion));

    const running = await coordinator.submit(submission('running-lane', 'still-running'));
    await waitForRuntime(runtime, 'still-running');
    const watchedHandle = await coordinator.submit(submission('watched-lane', 'watched-completed'));
    await waitForRuntime(runtime, 'watched-completed');
    const watch = coordinator.watchConversation('watched-lane', () => {});
    await watch.ready;
    runtime.finish('watched-completed', { type: 'done' });
    await watchedHandle.completion;

    const report = coordinator.pruneIdleLanes();
    expect(report.retainedIdleConversationIds).toHaveLength(8);
    expect(report.prunedConversationIds).not.toContain('running-lane');
    expect(report.prunedConversationIds).not.toContain('watched-lane');
    expect(coordinator.isConversationRunning('running-lane')).toBe(true);
    const watchedSnapshot = await coordinator.snapshotConversation('watched-lane');
    expect(watchedSnapshot.runs[0]?.phase).toBe('completed');

    watch.close();
    runtime.finish('still-running', { type: 'done' });
    await running.completion;
  });

  test('fails closed on conversation-load failure without persistStart or runtime execution', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    persistence.loadError = new Error('conversation file is corrupt');
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const deliveries: ChatConversationDelivery[] = [];
    const watch = coordinator.watchConversation('corrupt', delivery => deliveries.push(delivery));
    const pendingSubmission = coordinator.submit(submission('corrupt', 'must-not-run'));
    const rejectedSubmission = expect(pendingSubmission).rejects.toBeInstanceOf(ChatConversationLoadError);

    await watch.ready;
    await rejectedSubmission;
    const initial = deliveries[0];
    expect(initial?.type).toBe('snapshot');
    if (initial?.type !== 'snapshot') throw new Error('Expected snapshot delivery.');
    expect(initial.snapshot.loadError).toBe('conversation file is corrupt');
    expect(initial.snapshot.conversation).toBeNull();
    expect(persistence.startCalls).toHaveLength(0);
    expect(persistence.finalCalls).toHaveLength(0);
    expect(runtime.invocations).toHaveLength(0);
    const terminal = await coordinator.snapshotConversation('corrupt');
    expect(terminal.runs).toEqual([]);
    watch.close();
  });

  test('recovery is registry-only and never replays or rewrites durable turns', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwnerships = async () => [
      {
        sessionId: 'recovered-session',
        conversationId: 'first-owner',
        agentId: 'claude',
        runId: 'historical-first',
        claimedAt: 1,
      },
      {
        sessionId: 'recovered-session',
        conversationId: 'duplicate-owner',
        agentId: 'claude',
        runId: 'historical-duplicate',
        claimedAt: 2,
      },
    ];
    const coordinator = new ChatRunCoordinator(dependencies);

    const report = await coordinator.recover();

    expect(report).toMatchObject({
      policy: 'registry-only',
      durableTurnRecovery: 'vault-store-required',
      sessionOwnershipsLoaded: 2,
    });
    expect(report.sessionConflicts).toHaveLength(1);
    expect(coordinator.getSessionOwner('recovered-session')?.conversationId).toBe('first-owner');
    expect(runtime.invocations).toHaveLength(0);
    expect(persistence.startCalls).toHaveLength(0);
    expect(persistence.finalCalls).toHaveLength(0);
  });

  test('quarantines every persisted owner of a conflicted session before Runtime', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const dependencies = persistence.dependencies(runtime);
    dependencies.loadSessionOwnerships = async () => [
      {
        sessionId: 'quarantined-session',
        conversationId: 'first-owner',
        agentId: 'claude',
        runId: 'historical-first',
        claimedAt: 1,
      },
      {
        sessionId: 'quarantined-session',
        conversationId: 'second-owner',
        agentId: 'claude',
        runId: 'historical-second',
        claimedAt: 2,
      },
    ];
    const coordinator = new ChatRunCoordinator(dependencies);
    await coordinator.recover();

    for (const [conversationId, runId] of [
      ['first-owner', 'quarantined-first'],
      ['second-owner', 'quarantined-second'],
    ] as const) {
      const next = submission(conversationId, runId);
      next.runtimeRequest.sessionId = 'quarantined-session';
      const handle = await coordinator.submit(next);
      const result = await handle.completion;
      expect(result).toMatchObject({ status: 'failed', sessionId: null });
      expect(result.error).toContain('conflicting persisted owners');
    }

    expect(runtime.invocations).toHaveLength(0);
    expect(persistence.finalCalls).toHaveLength(2);
  });

  test('rejects registry recovery after a watcher creates live in-memory state', async () => {
    const runtime = new FakeRuntime();
    const persistence = new FakePersistence();
    const coordinator = new ChatRunCoordinator(persistence.dependencies(runtime));
    const watch = coordinator.watchConversation('already-live', () => {});
    await watch.ready;

    await expect(coordinator.recover()).rejects.toBeInstanceOf(ChatRecoveryOrderError);
    watch.close();
  });
});
