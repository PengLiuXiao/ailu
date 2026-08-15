import type {
  AgentId,
  ChatArtifact,
  ChatMessage,
  ChatTurnRequest,
  RuntimeTurnEvent,
  StoredConversation,
  ToolCallEvent,
} from '../types';
import { createId } from '../utils/id';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from '../runtime/outputLimits';
import {
  appendToolLifecycleDisplayText,
  clearToolLifecycleContentMetadata,
  cloneToolLifecycleContentMetadata,
  TOOL_LIFECYCLE_CONTENT_METADATA_KEY,
  withoutToolLifecycleDisplayText,
} from './contextCompression';

export type ChatRunPhase =
  | 'admitting'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'stopping'
  | 'persisting'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type ChatRunTerminalStatus = 'completed' | 'cancelled' | 'failed';
export type ChatRunCancellationReason = 'stop' | 'shutdown';

export type FrozenChatTurnRequest = Readonly<
  Omit<ChatTurnRequest, 'signal' | 'attachments'> & {
    attachments?: readonly Readonly<NonNullable<ChatTurnRequest['attachments']>[number]>[];
  }
>;

export interface ChatRunSubmission {
  runId?: string;
  conversationId: string;
  runtimeRequest: Omit<ChatTurnRequest, 'signal'>;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** Optional immediate seed for a view before the persisted snapshot is loaded. */
  conversationSnapshot?: StoredConversation | null;
  /** Runtime configuration ownership written beside a newly observed session. */
  sessionConfigKey?: string;
  cancellationMessage?: string;
  emptyAssistantContent?: string;
}

export interface FrozenChatRunSubmission extends Omit<ChatRunSubmission, 'runId' | 'runtimeRequest'> {
  runId: string;
  runtimeRequest: FrozenChatTurnRequest;
}

export interface ChatRunStartPersistence {
  runId: string;
  conversationId: string;
  stopEpoch: number;
  initialState: 'active' | 'queued';
  runtimeRequest: FrozenChatTurnRequest;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export interface ChatRunActivationPersistence {
  runId: string;
  conversationId: string;
}

export interface ChatRunSessionPersistence {
  runId: string;
  conversationId: string;
  agentId: AgentId;
  sessionId: string;
  sessionConfigKey?: string;
}

export interface ChatRunCancellationPersistence {
  runId: string;
  conversationId: string;
  reason: ChatRunCancellationReason;
  requestedAt: number;
}

export interface ChatRunCheckpointPersistence {
  runId: string;
  conversationId: string;
  assistantMessage: ChatMessage;
}

export interface ChatRunFinalPersistence {
  runId: string;
  conversationId: string;
  status: ChatRunTerminalStatus;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  sessionId?: string;
  sessionConfigKey?: string;
  cancellationReason?: ChatRunCancellationReason;
  error?: string;
  startedAt: number | null;
  finishedAt: number;
}

export interface ChatArtifactMaterialization {
  runId: string;
  conversationId: string;
  artifact: Extract<RuntimeTurnEvent, { type: 'artifact' }>['artifact'];
  /** Hard per-item cap enforced again by the physical materializer. */
  maxItemBytes: number;
  /** Turn budget still available when this serial reservation starts. */
  remainingTurnBytes: number;
  signal: AbortSignal;
}

export interface ChatArtifactMaterializationResult {
  artifact: ChatArtifact;
  /** Exact source bytes written to the Vault by the materializer. */
  byteLength: number;
}

export interface ChatSessionOwnership {
  sessionId: string;
  conversationId: string;
  agentId: AgentId;
  runId: string;
  claimedAt: number;
}

export interface ChatSessionOwnershipClaimRequest extends ChatSessionOwnership {
  /** Persisted in the same repository transaction as the canonical owner. */
  sessionConfigKey?: string;
}

export type ChatSessionOwnershipClaim =
  | { status: 'claimed'; owner?: ChatSessionOwnership }
  | { status: 'duplicate'; owner: ChatSessionOwnership };

export interface ChatCheckpointScheduler {
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number) => void;
}

export interface ChatRunCoordinatorDependencies {
  runTurn: (
    request: ChatTurnRequest,
    onEvent: (event: RuntimeTurnEvent) => void,
  ) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<StoredConversation | null>;
  /** Must durably add the frozen user/assistant pair before runTurn is called. */
  persistStart: (
    input: ChatRunStartPersistence,
  ) => Promise<StoredConversation | void>;
  /** A queued durable turn must cross this barrier before runTurn starts. */
  persistActivate: (
    input: ChatRunActivationPersistence,
  ) => Promise<StoredConversation | void>;
  persistSession: (
    input: ChatRunSessionPersistence,
  ) => Promise<StoredConversation | void>;
  /** Abort is immediate; this durable cancelRequested write joins the barrier. */
  persistCancellationRequested?: (
    input: ChatRunCancellationPersistence,
  ) => Promise<StoredConversation | void>;
  /** Journal checkpoint for crash-safe streaming assistant output. */
  persistCheckpoint: (
    input: ChatRunCheckpointPersistence,
  ) => Promise<StoredConversation | void>;
  /** Its settlement is part of the lane teardown barrier. */
  persistFinal: (
    input: ChatRunFinalPersistence,
  ) => Promise<StoredConversation | void>;
  /** Its settlement is part of the lane teardown barrier. */
  materializeArtifact: (
    input: ChatArtifactMaterialization,
  ) => Promise<ChatArtifactMaterializationResult>;
  formatToolEvent?: (
    toolCall: ToolCallEvent,
    submission: FrozenChatRunSubmission,
  ) => string | null;
  /** Converts a Runtime failure into user-visible copy; raw diagnostics stay in Runtime logs. */
  formatRuntimeError?: (
    message: string,
    detail: string | undefined,
    submission: FrozenChatRunSubmission,
  ) => string;
  loadSessionOwnerships?: () => Promise<readonly ChatSessionOwnership[]>;
  /** Constant-time durable lookup; startup deliberately does not enumerate owners. */
  loadSessionOwner?: (sessionId: string) => Promise<ChatSessionOwnership | null>;
  claimSessionOwnership: (
    ownership: ChatSessionOwnershipClaimRequest,
  ) => Promise<ChatSessionOwnershipClaim>;
  checkpointScheduler?: ChatCheckpointScheduler;
  now?: () => number;
  createRunId?: () => string;
}

export interface ChatRunSnapshot {
  runId: string;
  conversationId: string;
  phase: ChatRunPhase;
  terminalStatus: ChatRunTerminalStatus | null;
  stopEpoch: number;
  initialState: 'active' | 'queued';
  sequence: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  startPersisted: boolean;
  activationPersisted: boolean;
  cancellationRequestedPersisted: boolean;
  finalPersisted: boolean;
  sessionId: string | null;
  cancellationReason: ChatRunCancellationReason | null;
  error: string | null;
  persistenceError: string | null;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

export interface ChatConversationSnapshot {
  conversationId: string;
  conversation: StoredConversation | null;
  /** Persisted messages overlaid with every queued or live run by stable message ID. */
  messages: ChatMessage[];
  stopEpoch: number;
  activeRunId: string | null;
  queuedRunIds: string[];
  running: boolean;
  shuttingDown: boolean;
  /** A failed durable snapshot read is visible and is never presented as empty history. */
  loadError: string | null;
  runs: ChatRunSnapshot[];
  /** Volatile delivery cursors. They are deliberately never persisted. */
  cursors: Record<string, number>;
}

export type ChatRunDelivery =
  | {
    type: 'state';
    runId: string;
    conversationId: string;
    sequence: number;
    run: ChatRunSnapshot;
  }
  | {
    type: 'runtime';
    runId: string;
    conversationId: string;
    sequence: number;
    event: Exclude<RuntimeTurnEvent, { type: 'artifact' }>;
  }
  | {
    type: 'artifact';
    runId: string;
    conversationId: string;
    sequence: number;
    artifact: ChatArtifact;
  };

export type ChatConversationDelivery =
  | { type: 'snapshot'; snapshot: ChatConversationSnapshot }
  | { type: 'run'; event: ChatRunDelivery };

export interface ChatConversationWatchOptions {
  /** Last run-local sequence already incorporated by the caller. */
  after?: Readonly<Record<string, number>>;
}

export interface ChatConversationWatch {
  ready: Promise<void>;
  close: () => void;
}

export interface ChatRunResult {
  runId: string;
  conversationId: string;
  status: ChatRunTerminalStatus;
  assistantMessage: ChatMessage;
  sessionId: string | null;
  cancellationReason: ChatRunCancellationReason | null;
  error: string | null;
  persistenceError: string | null;
  startedAt: number | null;
  finishedAt: number;
  finalPersisted: boolean;
  cancellationRequestedPersisted: boolean;
}

export interface ChatRunHandle {
  runId: string;
  conversationId: string;
  /** Settles only after runtime teardown, artifact work, and persistFinal settle. */
  completion: Promise<ChatRunResult>;
}

export interface ChatStopResult {
  conversationId: string;
  stopEpoch: number;
  cancelledRunIds: string[];
  completions: Promise<ChatRunResult[]>;
}

export interface ChatLanePruneReport {
  maxRetained: number;
  prunedConversationIds: string[];
  retainedIdleConversationIds: string[];
}

export const DEFAULT_RETAINED_IDLE_CHAT_LANES = 8;
export const MAX_RETAINED_CHAT_MESSAGES = 100;
const MAX_RETAINED_TERMINAL_RUN_SNAPSHOTS = 8;
export const CHAT_CHECKPOINT_INTERVAL_MS = 1_000;
export const CHAT_CHECKPOINT_BYTE_THRESHOLD = 4 * 1_024;
export const CHAT_MAX_CHECKPOINT_WRITES_PER_TURN = 32;
export const CHAT_MAX_RUNTIME_EVENT_BYTES = 512 * 1_024;
export const CHAT_MAX_TURN_OUTPUT_BYTES = MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES;
export const CHAT_MAX_ARTIFACTS_PER_TURN = 8;
export const CHAT_MAX_ARTIFACT_BYTES = 25 * 1_024 * 1_024;
export const CHAT_MAX_ARTIFACT_BYTES_PER_TURN = 64 * 1_024 * 1_024;
export const CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS = 2;

export interface ChatRecoveryFailure {
  stage: 'session-ownership';
  error: string;
}

export interface ChatRecoveryReport {
  policy: 'registry-only';
  /** Durable turn recovery belongs exclusively to VaultStore before this call. */
  durableTurnRecovery: 'vault-store-required';
  sessionOwnershipsLoaded: number;
  failures: ChatRecoveryFailure[];
  sessionConflicts: ChatSessionConflict[];
}

export interface ChatSessionConflict {
  sessionId: string;
  owner: ChatSessionOwnership;
  contender: ChatSessionOwnership;
}

interface RunRecord {
  submission: InternalSubmission;
  phase: ChatRunPhase;
  terminalStatus: ChatRunTerminalStatus | null;
  stopEpoch: number;
  initialState: 'active' | 'queued';
  sequence: number;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  startPersisted: boolean;
  activationPersisted: boolean;
  cancellationRequestedPersisted: boolean;
  finalPersisted: boolean;
  sessionId: string | null;
  durablyAdmittedSessionId: string | null;
  cancellationReason: ChatRunCancellationReason | null;
  error: string | null;
  persistenceError: string | null;
  sessionPersistenceError: string | null;
  checkpointPersistenceError: string | null;
  controller: AbortController;
  acceptingRuntimeEvents: boolean;
  runtimePromise: Promise<void> | null;
  /** Durable begin crossed after another write opened the global circuit. */
  runtimeBlockedByPersistenceCircuit: boolean;
  admissionPromise: Promise<void>;
  activationPromise: Promise<void> | null;
  checkpointRevision: number;
  checkpointQueuedRevision: number;
  checkpointBytes: number;
  checkpointByteThreshold: number;
  checkpointWrites: number;
  checkpointTimer: number | null;
  checkpointTail: Promise<void>;
  checkpointDraining: boolean;
  checkpointingStopped: boolean;
  runtimeEventBytes: number;
  artifactEventsAccepted: number;
  /** Successful bytes plus the unreleased worst-case reservation of in-flight/failed work. */
  artifactBudgetUsedBytes: number;
  artifactTail: Promise<void>;
  artifactMaterializationStopped: boolean;
  artifactFailureReported: boolean;
  sideEffects: Promise<void>[];
  resolveStart: (handle: ChatRunHandle) => void;
  rejectStart: (error: unknown) => void;
  startPromise: Promise<ChatRunHandle>;
  resolveCompletion: (result: ChatRunResult) => void;
  completion: Promise<ChatRunResult>;
}

/**
 * Private coordinator/runtime contract. RuntimeManager preserves unknown
 * request fields while forwarding the request, and non-Codex adapters ignore
 * this callback. Codex must await it before `turn/start`.
 */
export interface CanonicalSessionAdmissionRequest {
  admitCanonicalSession?: (sessionId: string) => Promise<void>;
}

type InternalSubmission = FrozenChatRunSubmission;

interface Watcher {
  listener: (delivery: ChatConversationDelivery) => void;
  initializing: boolean;
  closed: boolean;
  seen: Map<string, number>;
  buffered: ChatRunDelivery[];
}

interface ConversationLane {
  conversationId: string;
  lastTouched: number;
  stopEpoch: number;
  queue: RunRecord[];
  active: RunRecord | null;
  runs: Map<string, RunRecord>;
  draining: boolean;
  loaded: boolean;
  loadPromise: Promise<void> | null;
  loadError: string | null;
  admissionTail: Promise<void>;
  persistedConversation: StoredConversation | null;
  seedConversation: StoredConversation | null;
  /** Bounded UI/status tail after the heavyweight RunRecord is released. */
  terminalRuns: ChatRunSnapshot[];
  /** Minimal circuit-breaker marker; the full output lives in the bounded message window. */
  unpersistedFailure: {
    runId: string;
    detail: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null;
  watchers: Set<Watcher>;
}

export class ChatRunCoordinator {
  private readonly lanes = new Map<string, ConversationLane>();
  private readonly sessionOwners = new Map<string, ChatSessionOwnership>();
  private readonly sessionConflicts: ChatSessionConflict[] = [];
  private laneTouchSequence = 0;
  private shuttingDown = false;
  private recoveryPromise: Promise<ChatRecoveryReport> | null = null;
  /** Serializes only the durable begin-turn mutation, never Runtime execution. */
  private persistenceAdmissionTail: Promise<void> = Promise.resolve();
  private persistenceCircuit: {
    conversationId: string;
    runId: string;
    detail: string;
  } | null = null;
  private activeArtifactMaterializations = 0;
  private readonly artifactMaterializationWaiters: Array<() => void> = [];

  constructor(private readonly deps: ChatRunCoordinatorDependencies) {}

  /**
   * Enqueues immediately, but resolves only after this run's durable start
   * barrier. Runtime completion remains separate on handle.completion.
   */
  submit(submission: ChatRunSubmission): Promise<ChatRunHandle> {
    if (this.shuttingDown) {
      return Promise.reject(new ChatCoordinatorShutdownError());
    }
    const normalized = this.normalizeSubmission(submission);
    const backpressure = this.persistenceBackpressureFor(normalized.conversationId);
    if (backpressure) return Promise.reject(backpressure);
    const lane = this.getLane(normalized.conversationId);
    this.mergeSeedConversation(lane, submission.conversationSnapshot ?? null);
    const initialState = this.isLaneTrulyIdle(lane) ? 'active' : 'queued';
    const run = this.createRun(normalized, lane.stopEpoch, initialState);
    lane.queue.push(run);
    lane.runs.set(run.submission.runId, run);
    this.emitState(lane, run);
    this.scheduleAdmission(lane, run);
    this.kickLane(lane);
    return run.startPromise;
  }

  stopConversation(conversationId: string): ChatStopResult {
    const normalized = conversationId.trim();
    const lane = this.lanes.get(normalized);
    if (!lane) {
      return {
        conversationId: normalized,
        stopEpoch: 0,
        cancelledRunIds: [],
        completions: Promise.resolve([]),
      };
    }
    const throughEpoch = lane.stopEpoch;
    lane.stopEpoch += 1;
    const affected = [...lane.runs.values()].filter(run => (
      run.stopEpoch <= throughEpoch && isCancellablePhase(run.phase)
      && run.cancellationReason === null
    ));
    for (const run of affected) this.cancelRun(lane, run, 'stop');
    const completions = Promise.all(affected.map(run => this.completionAfterSideEffects(run)));
    this.kickLane(lane);
    return {
      conversationId,
      stopEpoch: lane.stopEpoch,
      cancelledRunIds: affected.map(run => run.submission.runId),
      completions,
    };
  }

  watchConversation(
    conversationId: string,
    listener: (delivery: ChatConversationDelivery) => void,
    options: ChatConversationWatchOptions = {},
  ): ChatConversationWatch {
    const lane = this.getLane(conversationId);
    const watcher: Watcher = {
      listener,
      initializing: true,
      closed: false,
      seen: new Map(Object.entries(options.after ?? {})),
      buffered: [],
    };
    // Registration intentionally precedes the asynchronous persisted snapshot.
    lane.watchers.add(watcher);
    const ready = this.initializeWatcher(lane, watcher);
    return {
      ready,
      close: () => {
        if (watcher.closed) return;
        watcher.closed = true;
        lane.watchers.delete(watcher);
        watcher.buffered.length = 0;
        this.touchLane(lane);
        this.pruneIdleLanes();
      },
    };
  }

  async snapshotConversation(conversationId: string): Promise<ChatConversationSnapshot> {
    const lane = this.getLane(conversationId);
    await this.ensureLaneLoaded(lane);
    const snapshot = this.buildConversationSnapshot(lane);
    this.pruneIdleLanes();
    return snapshot;
  }

  isConversationRunning(conversationId: string): boolean {
    const lane = this.lanes.get(conversationId);
    if (!lane) return false;
    return [...lane.runs.values()].some(run => !isTerminalPhase(run.phase));
  }

  getSessionOwner(sessionId: string): ChatSessionOwnership | null {
    const owner = this.sessionOwners.get(sessionId);
    return owner ? { ...owner } : null;
  }

  listSessionConflicts(): ChatSessionConflict[] {
    return this.sessionConflicts.map(conflict => ({
      sessionId: conflict.sessionId,
      owner: { ...conflict.owner },
      contender: { ...conflict.contender },
    }));
  }

  /** Forces dirty streaming output through the optional checkpoint journal. */
  async flushCheckpoints(conversationId?: string): Promise<void> {
    const normalized = conversationId?.trim();
    const lanes = normalized === undefined
      ? [...this.lanes.values()]
      : [this.lanes.get(normalized)].filter((lane): lane is ConversationLane => Boolean(lane));
    await Promise.all(lanes.flatMap(lane => (
      [...lane.runs.values()].map(run => this.flushRunCheckpoint(lane, run))
    )));
  }

  /**
   * Drops only completed, unwatched lane state from memory. Persisted history
   * and the independent session ownership registry are never changed; opening
   * a pruned conversation therefore loads it again through loadConversation.
   */
  pruneIdleLanes(
    maxRetained = DEFAULT_RETAINED_IDLE_CHAT_LANES,
  ): ChatLanePruneReport {
    if (!Number.isInteger(maxRetained) || maxRetained < 0) {
      throw new RangeError('maxRetained must be a non-negative integer.');
    }
    const idle = [...this.lanes.values()]
      .filter(lane => this.isPrunableIdleLane(lane))
      .sort((left, right) => right.lastTouched - left.lastTouched);
    const retained = idle.slice(0, maxRetained);
    const pruned = idle.slice(maxRetained);
    for (const lane of pruned) {
      if (this.lanes.get(lane.conversationId) === lane) {
        this.lanes.delete(lane.conversationId);
        this.clearSessionRegistryForConversation(lane.conversationId);
      }
    }
    return {
      maxRetained,
      prunedConversationIds: pruned.map(lane => lane.conversationId),
      retainedIdleConversationIds: retained.map(lane => lane.conversationId),
    };
  }

  /**
   * Startup order is deliberately split: VaultStore first performs the only
   * durable migration (queued -> paused, active/cancelRequested -> interrupted,
   * with no automatic replay). This method then rebuilds only the in-memory
   * session ownership/conflict registry. Run delivery sequences start fresh
   * and are never persisted.
   */
  recover(): Promise<ChatRecoveryReport> {
    if (!this.recoveryPromise) this.recoveryPromise = this.performRecovery();
    return this.recoveryPromise;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await Promise.all([...this.lanes.values()].flatMap(lane => (
        [...lane.runs.values()]
          .filter(run => !isTerminalPhase(run.phase))
          .map(run => this.completionAfterSideEffects(run))
      )));
      return;
    }
    this.shuttingDown = true;
    const completions: Promise<ChatRunResult>[] = [];
    for (const lane of this.lanes.values()) {
      lane.stopEpoch += 1;
      for (const run of lane.runs.values()) {
        if (isTerminalPhase(run.phase)) continue;
        this.cancelRun(lane, run, 'shutdown');
        completions.push(this.completionAfterSideEffects(run));
      }
      this.kickLane(lane);
    }
    await Promise.all(completions);
  }

  private scheduleAdmission(lane: ConversationLane, run: RunRecord): void {
    const admission = lane.admissionTail.then(() => this.admitRun(lane, run));
    run.admissionPromise = admission;
    // Admission failures are converted into terminal run state inside admitRun,
    // so one failed durable write never poisons later submissions in the lane.
    lane.admissionTail = admission;
  }

  private async admitRun(lane: ConversationLane, run: RunRecord): Promise<void> {
    await this.ensureLaneLoaded(lane);
    const preAdmissionBackpressure = this.persistenceBackpressureFor(lane.conversationId);
    if (preAdmissionBackpressure) {
      this.rejectBackpressuredAdmission(lane, run, preAdmissionBackpressure);
      return;
    }
    if (lane.loadError) {
      this.openPersistenceCircuit(lane, run, lane.loadError);
      this.failAdmission(
        lane,
        run,
        new ChatConversationLoadError(lane.conversationId, lane.loadError),
      );
      return;
    }
    await this.enqueuePersistenceAdmission(async () => {
      const backpressure = this.persistenceBackpressureFor(lane.conversationId);
      if (backpressure) {
        this.rejectBackpressuredAdmission(lane, run, backpressure);
        return;
      }
      // A stop ordered before the durable begin converts an otherwise-idle run
      // into a queued turn, so recovery can never mistake it for live Runtime work.
      if (run.cancellationReason && run.initialState === 'active') run.initialState = 'queued';
      try {
        const persisted = await this.deps.persistStart({
          runId: run.submission.runId,
          conversationId: run.submission.conversationId,
          stopEpoch: run.stopEpoch,
          initialState: run.initialState,
          runtimeRequest: run.submission.runtimeRequest,
          userMessage: cloneMessage(run.submission.userMessage),
          assistantMessage: cloneMessage(run.submission.assistantMessage),
        });
        run.startPersisted = true;
        run.activationPersisted = run.initialState === 'active';
        if (persisted) this.acceptPersistedConversation(lane, persisted);
        // The write itself may have been in flight when another persistence
        // operation opened the circuit. Remember that boundary before exposing
        // the handle; executeRun will settle it without entering Runtime.
        run.runtimeBlockedByPersistenceCircuit = this.persistenceCircuit !== null;
      } catch (error) {
        if (this.persistenceCircuit) {
          this.rejectBackpressuredAdmission(
            lane,
            run,
            this.persistenceBackpressureFor(lane.conversationId)
              ?? new ChatPersistenceBackpressureError(
                lane.conversationId,
                'global',
                Math.max(1, this.countUnpersistedLanes()),
              ),
          );
          return;
        }
        this.openPersistenceCircuit(lane, run, error);
        this.failAdmission(lane, run, error);
        return;
      }

      if (!run.cancellationReason) {
        this.setPhase(lane, run, run.initialState === 'active' ? 'preparing' : 'queued');
      }
      run.resolveStart(this.handleFor(run));
    });
  }

  private enqueuePersistenceAdmission(operation: () => Promise<void>): Promise<void> {
    const admitted = this.persistenceAdmissionTail.then(operation);
    this.persistenceAdmissionTail = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  private failAdmission(lane: ConversationLane, run: RunRecord, error: unknown): void {
    if (isTerminalPhase(run.phase)) return;
    this.failRun(run, error);
    run.finishedAt = this.now();
    run.terminalStatus = 'failed';
    this.setPhase(lane, run, 'failed');
    this.touchLane(lane);
    run.rejectStart(error);
    run.resolveCompletion(this.resultFor(run));
    this.foldAndReleaseTerminalRun(lane, run);
  }

  private rejectBackpressuredAdmission(
    lane: ConversationLane,
    run: RunRecord,
    error: ChatPersistenceBackpressureError,
  ): void {
    if (isTerminalPhase(run.phase)) return;
    this.failRun(run, error);
    run.finishedAt = this.now();
    run.terminalStatus = 'failed';
    this.setPhase(lane, run, 'failed');
    this.touchLane(lane);
    run.rejectStart(error);
    run.resolveCompletion(this.resultFor(run));
    // This submission never crossed the durable start barrier. Its rejected
    // input remains owned by the caller/UI and must not displace retained
    // messages or terminal snapshots from an actually failed persistence.
    lane.runs.delete(run.submission.runId);
  }

  private async settlePersistedRunBlocked(lane: ConversationLane, run: RunRecord): Promise<void> {
    if (isTerminalPhase(run.phase)) return;
    // Cancellation/session side effects can already be in flight. They must
    // settle through the protected snapshot merge before stop/shutdown or the
    // run completion barrier is allowed to resolve.
    await Promise.allSettled(run.sideEffects);
    if (isTerminalPhase(run.phase)) return;
    const recoveryState = run.initialState === 'active' || run.activationPersisted
      ? 'interrupted'
      : 'paused';
    const error = new ChatPersistedRunBlockedError(
      lane.conversationId,
      run.submission.runId,
      recoveryState,
    );
    this.failRun(run, error);
    run.finishedAt = this.now();
    run.terminalStatus = 'failed';
    this.setPhase(lane, run, 'failed');
    this.touchLane(lane);
    run.resolveCompletion(this.resultFor(run));
    // The durable turn remains queued. Restart recovery converts it to paused;
    // folding it here would let blocked placeholders evict the first unique
    // unpersisted assistant output from the bounded UI window.
    lane.runs.delete(run.submission.runId);
  }

  private shouldBlockBeforeRuntime(run: RunRecord): boolean {
    return run.startPersisted
      && run.runtimePromise === null
      && (run.runtimeBlockedByPersistenceCircuit || this.persistenceCircuit !== null);
  }

  private async settleBeforeRuntimeWhenBlocked(
    lane: ConversationLane,
    run: RunRecord,
  ): Promise<void> {
    if (!this.shouldBlockBeforeRuntime(run)) return;
    run.runtimeBlockedByPersistenceCircuit = true;
    await this.settlePersistedRunBlocked(lane, run);
  }

  private async executeRun(lane: ConversationLane, run: RunRecord): Promise<void> {
    if (this.shouldBlockBeforeRuntime(run)) {
      await this.settleBeforeRuntimeWhenBlocked(lane, run);
      return;
    }

    if (run.cancellationReason || run.controller.signal.aborted) {
      await this.finalizeRun(lane, run, 'cancelled');
      return;
    }

    if (run.initialState === 'queued' && !run.activationPersisted) {
      this.setPhase(lane, run, 'preparing');
      const activation = Promise.resolve().then(async () => {
        if (run.cancellationReason) return;
        const persisted = await this.deps.persistActivate({
          runId: run.submission.runId,
          conversationId: lane.conversationId,
        });
        run.activationPersisted = true;
        if (persisted) this.acceptPersistedConversation(lane, persisted);
      });
      run.activationPromise = activation;
      try {
        await activation;
      } catch (error) {
        if (!run.cancellationReason) {
          run.submission.assistantMessage.role = 'error';
          const visibleError = this.formatVisibleError(
            run,
            `任务启动状态保存失败：${errorMessage(error)}`,
          );
          appendAssistantError(
            run.submission.assistantMessage,
            visibleError,
          );
          this.recordPersistenceFailure(lane, run, error);
          await this.finalizeRun(lane, run, 'failed');
          return;
        }
      }
      if (this.shouldBlockBeforeRuntime(run)) {
        await this.settleBeforeRuntimeWhenBlocked(lane, run);
        return;
      }
      if (run.cancellationReason || run.controller.signal.aborted) {
        await this.finalizeRun(lane, run, 'cancelled');
        return;
      }
      if (!run.activationPersisted) {
        const error = new Error('Queued chat run did not cross its activation barrier.');
        this.recordPersistenceFailure(lane, run, error);
        await this.finalizeRun(lane, run, 'failed');
        return;
      }
    } else {
      this.setPhase(lane, run, 'preparing');
    }

    if (run.cancellationReason || run.controller.signal.aborted) {
      await this.finalizeRun(lane, run, 'cancelled');
      return;
    }

    const resumeError = await this.validateResumeSession(lane, run);
    if (this.shouldBlockBeforeRuntime(run)) {
      await this.settleBeforeRuntimeWhenBlocked(lane, run);
      return;
    }
    if (resumeError) {
      this.failRun(run, resumeError);
      await this.finalizeRun(lane, run, 'failed');
      return;
    }

    run.startedAt = this.now();
    this.setPhase(lane, run, 'running');
    // A watcher can synchronously order stop from the running state delivery.
    // Recheck before invoking Runtime so that boundary never launches work.
    if (run.cancellationReason || run.controller.signal.aborted) {
      await this.finalizeRun(lane, run, 'cancelled');
      return;
    }
    // This predicate and deps.runTurn remain in one synchronous call stack.
    // A false fence must not yield a microtask where another lane can open the
    // circuit before Runtime is actually entered.
    if (this.shouldBlockBeforeRuntime(run)) {
      run.startedAt = null;
      await this.settleBeforeRuntimeWhenBlocked(lane, run);
      return;
    }
    const request: ChatTurnRequest & CanonicalSessionAdmissionRequest = {
      ...run.submission.runtimeRequest,
      attachments: run.submission.runtimeRequest.attachments?.map(attachment => ({ ...attachment })),
      signal: run.controller.signal,
      admitCanonicalSession: sessionId => this.admitCanonicalSession(lane, run, sessionId),
    };
    try {
      run.runtimePromise = Promise.resolve(this.deps.runTurn(
        request,
        event => this.acceptRuntimeEvent(lane, run, event),
      ));
      await run.runtimePromise;
    } catch (error) {
      if (!run.cancellationReason) this.failRun(run, error);
    } finally {
      run.acceptingRuntimeEvents = false;
    }

    await Promise.allSettled(run.sideEffects);
    const status: ChatRunTerminalStatus = run.cancellationReason
      ? 'cancelled'
      : run.error || hasUnresolvedPersistenceError(run)
        ? 'failed'
        : 'completed';
    await this.finalizeRun(lane, run, status);
  }

  private acceptRuntimeEvent(
    lane: ConversationLane,
    run: RunRecord,
    event: RuntimeTurnEvent,
  ): void {
    if (!run.acceptingRuntimeEvents || run.cancellationReason || isTerminalPhase(run.phase)) return;
    const eventBytes = jsonByteLength(event);
    if (!Number.isFinite(eventBytes) || eventBytes > CHAT_MAX_RUNTIME_EVENT_BYTES) {
      this.rejectOversizedRuntimeOutput(lane, run, 'event');
      return;
    }
    if (run.runtimeEventBytes + eventBytes > CHAT_MAX_TURN_OUTPUT_BYTES) {
      this.rejectOversizedRuntimeOutput(lane, run, 'turn');
      return;
    }
    run.runtimeEventBytes += eventBytes;
    if (event.type === 'artifact') {
      if (run.artifactEventsAccepted >= CHAT_MAX_ARTIFACTS_PER_TURN) {
        this.recordArtifactFailure(
          lane,
          run,
          `本回合图片数量超过 ${CHAT_MAX_ARTIFACTS_PER_TURN} 张上限。`,
        );
        return;
      }
      run.artifactEventsAccepted += 1;
      // A turn-local queue is the byte-budget lock: no two events can observe
      // the same remaining allowance, and successful artifacts retain Runtime
      // order even when several events arrive in one synchronous burst.
      const task = run.artifactTail.then(() => this.materializeArtifact(lane, run, event));
      run.artifactTail = task.then(() => undefined, () => undefined);
      run.sideEffects.push(task);
      return;
    }
    let deliveredEvent: Exclude<RuntimeTurnEvent, { type: 'artifact' }> = event;

    if (event.type === 'session') {
      if (run.durablyAdmittedSessionId === event.sessionId) {
        run.sessionId = event.sessionId;
      } else {
        const task = this.persistSession(lane, run, event.sessionId);
        run.sideEffects.push(task);
      }
    } else if (event.type === 'text') {
      run.submission.assistantMessage.content += event.content;
      this.markCheckpointDirty(lane, run, utf8ByteLength(event.content));
    } else if (event.type === 'tool') {
      const formatted = this.deps.formatToolEvent
        ? this.deps.formatToolEvent(event.toolCall, run.submission)
        : `\n\n• ${event.toolCall.name} ${event.toolCall.status}`;
      if (formatted) {
        appendToolLifecycleDisplayText(run.submission.assistantMessage, formatted);
        this.markCheckpointDirty(lane, run, utf8ByteLength(formatted));
      }
    } else if (event.type === 'diagnostic') {
      // RuntimeManager persists diagnostics to the local log. They are
      // intentionally excluded from assistant content and terminal status.
    } else if (event.type === 'error') {
      run.submission.assistantMessage.role = 'error';
      const detail = this.deps.formatRuntimeError
        ? this.deps.formatRuntimeError(event.message, event.detail, run.submission)
        : `${event.message}${event.detail ? `\n${event.detail}` : ''}`;
      deliveredEvent = { ...event, message: detail, detail: undefined };
      appendAssistantError(run.submission.assistantMessage, detail);
      this.markCheckpointDirty(lane, run, utf8ByteLength(detail));
      run.error = detail;
      run.acceptingRuntimeEvents = false;
      run.controller.abort(event);
    } else if (event.type === 'done') {
      if (event.sessionId) {
        const task = this.persistSession(lane, run, event.sessionId);
        run.sideEffects.push(task);
      }
      run.acceptingRuntimeEvents = false;
    }
    this.emitRunDelivery(lane, run, {
      type: 'runtime',
      runId: run.submission.runId,
      conversationId: lane.conversationId,
      sequence: this.nextSequence(run),
      event: deliveredEvent,
    });
  }

  private rejectOversizedRuntimeOutput(
    lane: ConversationLane,
    run: RunRecord,
    kind: 'event' | 'turn',
  ): void {
    if (!run.acceptingRuntimeEvents || run.cancellationReason || isTerminalPhase(run.phase)) return;
    const message = kind === 'event'
      ? '运行时返回的单个事件过大，已为安全起见终止本次回合。'
      : '运行时返回的本回合累计输出过大，已为安全起见终止。';
    const visibleError = this.formatVisibleError(run, message);
    const runtimeError: Extract<RuntimeTurnEvent, { type: 'error' }> = {
      type: 'error',
      message: visibleError,
      diagnostic: 'runtime_output_limit_exceeded',
    };
    this.stopRunCheckpointing(run);
    run.submission.assistantMessage.role = 'error';
    appendAssistantError(run.submission.assistantMessage, visibleError);
    run.error = visibleError;
    run.acceptingRuntimeEvents = false;
    this.emitRunDelivery(lane, run, {
      type: 'runtime',
      runId: run.submission.runId,
      conversationId: lane.conversationId,
      sequence: this.nextSequence(run),
      event: runtimeError,
    });
    run.controller.abort(runtimeError);
  }

  private async persistSession(lane: ConversationLane, run: RunRecord, sessionId: string): Promise<void> {
    try {
      await this.claimAndPersistSession(lane, run, sessionId);
    } catch (error) {
      if (error instanceof DuplicateChatSessionError) this.failRun(run, error);
      else this.recordSessionPersistenceFailure(lane, run, error);
    }
  }

  private async admitCanonicalSession(
    lane: ConversationLane,
    run: RunRecord,
    sessionId: string,
  ): Promise<void> {
    if (run.cancellationReason || run.controller.signal.aborted || isTerminalPhase(run.phase)) {
      throw new Error('Chat run was cancelled before canonical session admission completed.');
    }
    await this.claimAndPersistSession(lane, run, sessionId);
    if (run.cancellationReason || run.controller.signal.aborted || isTerminalPhase(run.phase)) {
      throw new Error('Chat run was cancelled during canonical session admission.');
    }
    run.durablyAdmittedSessionId = sessionId.trim();
  }

  private async claimAndPersistSession(
    lane: ConversationLane,
    run: RunRecord,
    sessionId: string,
  ): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) throw new Error('Runtime returned an empty canonical session id.');
    if (run.durablyAdmittedSessionId === normalizedSessionId) return;
    const contender: ChatSessionOwnership = {
      sessionId: normalizedSessionId,
      conversationId: lane.conversationId,
      agentId: run.submission.runtimeRequest.agentId,
      runId: run.submission.runId,
      claimedAt: this.now(),
    };
    const localOwner = this.sessionOwners.get(normalizedSessionId);
    if (localOwner && !sameSessionScope(localOwner, contender)) {
      this.recordSessionConflict(localOwner, contender);
      throw new DuplicateChatSessionError(localOwner, contender);
    }
    // The in-memory owner is only a fast conflict check. Every new turn must
    // re-enter the durable ownership transaction so a stale process cannot
    // rely on an owner loaded before lease takeover.
    const claim = await this.deps.claimSessionOwnership({
      ...contender,
      sessionConfigKey: run.submission.sessionConfigKey,
    });
    if (claim.status === 'duplicate') {
      this.sessionOwners.set(normalizedSessionId, claim.owner);
      this.recordSessionConflict(claim.owner, contender);
      throw new DuplicateChatSessionError(claim.owner, contender);
    }
    const ownerToRemember = claim.owner ?? contender;
    if (!sameSessionScope(ownerToRemember, contender)) {
      this.sessionOwners.set(normalizedSessionId, ownerToRemember);
      this.recordSessionConflict(ownerToRemember, contender);
      throw new DuplicateChatSessionError(ownerToRemember, contender);
    }
    // Compatibility for the pre-index persistence contract. Production wires
    // loadSessionOwner and performs owner + config in the claim transaction,
    // so it never takes this second-write branch.
    if (!this.deps.loadSessionOwner) {
      const persisted = await this.deps.persistSession({
        runId: run.submission.runId,
        conversationId: lane.conversationId,
        agentId: run.submission.runtimeRequest.agentId,
        sessionId: normalizedSessionId,
        sessionConfigKey: run.submission.sessionConfigKey,
      });
      if (persisted) this.acceptPersistedConversation(lane, persisted);
    }
    this.rememberSessionOwner(contender);
    run.sessionId = normalizedSessionId;
    // A later event for the same canonical session is allowed to repair a
    // transient claim/config write failure. Do not keep the earlier warning as
    // a permanent finalPersisted=false once the atomic claim succeeds.
    run.sessionPersistenceError = null;
  }

  private async materializeArtifact(
    lane: ConversationLane,
    run: RunRecord,
    event: Extract<RuntimeTurnEvent, { type: 'artifact' }>,
  ): Promise<void> {
    if (
      run.artifactMaterializationStopped
      || run.cancellationReason
      || run.controller.signal.aborted
      || isTerminalPhase(run.phase)
    ) return;
    const releaseSlot = await this.acquireArtifactMaterializationSlot();
    try {
      if (
        run.artifactMaterializationStopped
        || run.cancellationReason
        || run.controller.signal.aborted
        || isTerminalPhase(run.phase)
      ) return;
      const remainingTurnBytes = CHAT_MAX_ARTIFACT_BYTES_PER_TURN
        - run.artifactBudgetUsedBytes;
      if (remainingTurnBytes <= 0) {
        run.artifactMaterializationStopped = true;
        this.recordArtifactFailure(lane, run, '本回合图片总大小超过 64 MB 上限。');
        return;
      }
      // Reserve the entire authority exposed to the materializer before it can
      // read or write. A failed/cancelled operation keeps this reservation, so
      // an uncertain partial write can never grant later work extra authority.
      const reservedBytes = Math.min(CHAT_MAX_ARTIFACT_BYTES, remainingTurnBytes);
      run.artifactBudgetUsedBytes += reservedBytes;
      const result = await this.deps.materializeArtifact({
        runId: run.submission.runId,
        conversationId: lane.conversationId,
        artifact: event.artifact,
        maxItemBytes: CHAT_MAX_ARTIFACT_BYTES,
        remainingTurnBytes,
        signal: run.controller.signal,
      });
      if (
        !Number.isSafeInteger(result.byteLength)
        || result.byteLength <= 0
        || result.byteLength > reservedBytes
      ) {
        throw new Error('图片物化器返回了无效或超出预算的字节数。');
      }
      // Only a successful, exact receipt releases unused reservation bytes.
      run.artifactBudgetUsedBytes -= reservedBytes - result.byteLength;
      if (run.cancellationReason || isTerminalPhase(run.phase)) return;
      const artifact = result.artifact;
      const metadata = run.submission.assistantMessage.metadata ?? {};
      run.submission.assistantMessage.metadata = {
        ...metadata,
        artifacts: [...(metadata.artifacts ?? []), cloneArtifact(artifact)],
      };
      this.markCheckpointDirty(lane, run, utf8ByteLength(JSON.stringify(artifact)));
      this.emitRunDelivery(lane, run, {
        type: 'artifact',
        runId: run.submission.runId,
        conversationId: lane.conversationId,
        sequence: this.nextSequence(run),
        artifact: cloneArtifact(artifact),
      });
    } catch (error) {
      if (run.cancellationReason) return;
      run.artifactMaterializationStopped = true;
      this.recordArtifactFailure(lane, run, errorMessage(error));
    } finally {
      releaseSlot();
    }
  }

  private recordArtifactFailure(
    lane: ConversationLane,
    run: RunRecord,
    reason: string,
  ): void {
    if (run.artifactFailureReported || run.cancellationReason || isTerminalPhase(run.phase)) return;
    run.artifactFailureReported = true;
    const detail = this.formatVisibleError(run, `图片保存失败：${reason}`);
    run.error = run.error ? `${run.error}\n${detail}` : detail;
    run.submission.assistantMessage.role = 'error';
    appendAssistantError(run.submission.assistantMessage, detail);
    this.markCheckpointDirty(lane, run, utf8ByteLength(detail));
    this.emitState(lane, run);
  }

  private async acquireArtifactMaterializationSlot(): Promise<() => void> {
    if (this.activeArtifactMaterializations < CHAT_MAX_CONCURRENT_ARTIFACT_MATERIALIZATIONS) {
      this.activeArtifactMaterializations += 1;
    } else {
      await new Promise<void>(resolve => this.artifactMaterializationWaiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.artifactMaterializationWaiters.shift();
      if (next) next();
      else this.activeArtifactMaterializations -= 1;
    };
  }

  private markCheckpointDirty(
    lane: ConversationLane,
    run: RunRecord,
    changedBytes: number,
  ): void {
    if (run.checkpointingStopped || !this.deps.persistCheckpoint || !run.startPersisted) return;
    run.checkpointRevision += 1;
    run.checkpointBytes += Math.max(1, changedBytes);
    if (run.checkpointBytes >= run.checkpointByteThreshold) {
      void this.queueRunCheckpoint(lane, run);
      return;
    }
    if (run.checkpointTimer !== null) return;
    const schedule = this.deps.checkpointScheduler?.setTimeout
      ?? ((callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs));
    run.checkpointTimer = schedule(() => {
      run.checkpointTimer = null;
      void this.queueRunCheckpoint(lane, run);
    }, CHAT_CHECKPOINT_INTERVAL_MS);
  }

  private flushRunCheckpoint(lane: ConversationLane, run: RunRecord): Promise<void> {
    if (run.checkpointTimer !== null) {
      this.clearCheckpointTimer(run.checkpointTimer);
      run.checkpointTimer = null;
    }
    return run.checkpointingStopped ? run.checkpointTail : this.queueRunCheckpoint(lane, run);
  }

  private queueRunCheckpoint(lane: ConversationLane, run: RunRecord): Promise<void> {
    if (run.checkpointTimer !== null) {
      this.clearCheckpointTimer(run.checkpointTimer);
      run.checkpointTimer = null;
    }
    const persist = this.deps.persistCheckpoint;
    if (run.checkpointingStopped || !persist || !run.startPersisted) return run.checkpointTail;
    if (run.checkpointDraining || run.checkpointRevision <= run.checkpointQueuedRevision) {
      return run.checkpointTail;
    }
    // Coalesce bursts into the latest snapshot. The previous implementation
    // cloned the entire ever-growing assistant message at every 4 KiB edge,
    // allowing many small runtime frames to retain quadratic checkpoint data.
    run.checkpointDraining = true;
    const task = run.checkpointTail.then(async () => {
      while (
        !run.checkpointingStopped
        && run.checkpointQueuedRevision < run.checkpointRevision
      ) {
        if (run.checkpointWrites >= CHAT_MAX_CHECKPOINT_WRITES_PER_TURN) {
          this.stopRunCheckpointing(run);
          break;
        }
        const revision = run.checkpointRevision;
        run.checkpointQueuedRevision = revision;
        run.checkpointBytes = 0;
        const assistantMessage = cloneMessage(run.submission.assistantMessage);
        const snapshotBytes = jsonByteLength(assistantMessage);
        if (Number.isFinite(snapshotBytes)) {
          // Each full-message checkpoint must buy proportionally more new
          // output before the next byte-triggered write. This turns repeated
          // snapshots from quadratic growth into a geometric, bounded series.
          run.checkpointByteThreshold = Math.min(
            CHAT_MAX_TURN_OUTPUT_BYTES,
            Math.max(CHAT_CHECKPOINT_BYTE_THRESHOLD, snapshotBytes),
          );
        }
        run.checkpointWrites += 1;
        try {
          const persisted = await persist({
            runId: run.submission.runId,
            conversationId: lane.conversationId,
            assistantMessage,
          });
          if (persisted) this.acceptPersistedConversation(lane, persisted);
        } catch (error) {
          this.recordCheckpointFailure(lane, run, error);
        }
      }
    }).finally(() => {
      run.checkpointDraining = false;
    });
    run.checkpointTail = task;
    return task;
  }

  private stopRunCheckpointing(run: RunRecord): void {
    run.checkpointingStopped = true;
    run.checkpointBytes = 0;
    if (run.checkpointTimer !== null) {
      this.clearCheckpointTimer(run.checkpointTimer);
      run.checkpointTimer = null;
    }
  }

  private clearCheckpointTimer(handle: number): void {
    const clear = this.deps.checkpointScheduler?.clearTimeout
      ?? ((timer: number) => window.clearTimeout(timer));
    clear(handle);
  }

  private async finalizeRun(
    lane: ConversationLane,
    run: RunRecord,
    requestedStatus: ChatRunTerminalStatus,
  ): Promise<void> {
    run.acceptingRuntimeEvents = false;
    this.setPhase(lane, run, 'persisting');
    await Promise.allSettled(run.sideEffects);
    let status = requestedStatus;
    if (run.cancellationReason) {
      status = 'cancelled';
      run.submission.assistantMessage.role = 'assistant';
      run.submission.assistantMessage.content = run.submission.cancellationMessage
        ?? '当前任务已取消';
      clearToolLifecycleContentMetadata(run.submission.assistantMessage);
    } else if (
      !run.error
      && !hasUnresolvedPersistenceError(run)
      && !withoutToolLifecycleDisplayText(run.submission.assistantMessage).trim()
    ) {
      const completionText = run.submission.emptyAssistantContent ?? 'Done.';
      run.submission.assistantMessage.content = run.submission.assistantMessage.content.trim()
        ? `${run.submission.assistantMessage.content}\n\n${completionText}`
        : completionText;
      this.markCheckpointDirty(
        lane,
        run,
        utf8ByteLength(completionText),
      );
    }
    await this.flushRunCheckpoint(lane, run);
    if (!run.cancellationReason && (run.error || hasUnresolvedPersistenceError(run))) {
      status = 'failed';
      run.submission.assistantMessage.role = 'error';
    }
    run.finishedAt = this.now();
    if (run.startedAt !== null) {
      run.submission.assistantMessage.metadata = {
        ...(run.submission.assistantMessage.metadata ?? {}),
        durationMs: Math.max(0, run.finishedAt - run.startedAt),
      };
    }
    try {
      const persisted = await this.deps.persistFinal({
        runId: run.submission.runId,
        conversationId: lane.conversationId,
        status,
        userMessage: cloneMessage(run.submission.userMessage),
        assistantMessage: cloneMessage(run.submission.assistantMessage),
        sessionId: run.sessionId ?? undefined,
        sessionConfigKey: run.submission.sessionConfigKey,
        cancellationReason: run.cancellationReason ?? undefined,
        error: combinedRunError(run) ?? undefined,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      });
      // A complete final write contains the entire assistant payload and
      // therefore supersedes any missing transient streaming checkpoint.
      run.checkpointPersistenceError = null;
      run.finalPersisted = run.persistenceError === null
        && run.sessionPersistenceError === null;
      if (persisted) this.acceptPersistedConversation(lane, persisted);
    } catch (error) {
      status = 'failed';
      this.recordPersistenceFailure(lane, run, error);
    }

    run.terminalStatus = status;
    this.setPhase(lane, run, status);
    this.touchLane(lane);
    const result = this.resultFor(run);
    run.resolveCompletion(result);
    this.foldAndReleaseTerminalRun(lane, run);
  }

  private cancelRun(
    lane: ConversationLane,
    run: RunRecord,
    reason: ChatRunCancellationReason,
  ): void {
    if (!isCancellablePhase(run.phase) || run.cancellationReason) return;
    run.cancellationReason = reason;
    run.acceptingRuntimeEvents = false;
    run.controller.abort(reason);
    this.scheduleCancellationPersistence(lane, run, reason);
    this.setPhase(lane, run, 'stopping');
  }

  private scheduleCancellationPersistence(
    lane: ConversationLane,
    run: RunRecord,
    reason: ChatRunCancellationReason,
  ): void {
    const persist = this.deps.persistCancellationRequested;
    if (!persist) return;
    const requestedAt = this.now();
    const task = run.startPromise.then(async () => {
      try {
        // If activation was already admitted to the store mutation queue, let
        // that write settle before ordering cancelRequested behind it.
        await run.activationPromise?.catch(() => undefined);
        // Persist any accepted partial output before cancelRequested closes
        // the checkpoint mutation path. The final cancellation write below
        // carries the complete replacement message and needs no checkpoint.
        await this.flushRunCheckpoint(lane, run);
        const persisted = await persist({
          runId: run.submission.runId,
          conversationId: lane.conversationId,
          reason,
          requestedAt,
        });
        run.cancellationRequestedPersisted = true;
        if (persisted) this.acceptPersistedConversation(lane, persisted);
      } catch (error) {
        this.recordPersistenceFailure(lane, run, error);
      }
    }).catch(() => {
      // persistStart failed, so there is no durable turn to mark cancelRequested.
    });
    run.sideEffects.push(task);
  }

  private failRun(run: RunRecord, error: unknown): void {
    const detail = this.formatVisibleError(run, errorMessage(error));
    run.error = run.error ? `${run.error}\n${detail}` : detail;
    run.submission.assistantMessage.role = 'error';
    appendAssistantError(run.submission.assistantMessage, detail);
    run.acceptingRuntimeEvents = false;
    run.controller.abort(error);
  }

  private formatVisibleError(run: RunRecord, message: string): string {
    return this.deps.formatRuntimeError
      ? this.deps.formatRuntimeError(message, undefined, run.submission)
      : message;
  }

  private recordPersistenceFailure(
    lane: ConversationLane,
    run: RunRecord,
    error: unknown,
  ): void {
    this.openPersistenceCircuit(lane, run, error);
    const detail = errorMessage(error);
    run.persistenceError = run.persistenceError
      ? `${run.persistenceError}\n${detail}`
      : detail;
    run.finalPersisted = false;
    if (!isTerminalPhase(run.phase)) this.emitState(lane, run);
  }

  private recordCheckpointFailure(
    lane: ConversationLane,
    run: RunRecord,
    error: unknown,
  ): void {
    this.openPersistenceCircuit(lane, run, error);
    const detail = errorMessage(error);
    run.checkpointPersistenceError = run.checkpointPersistenceError
      ? `${run.checkpointPersistenceError}\n${detail}`
      : detail;
    run.finalPersisted = false;
    if (!isTerminalPhase(run.phase)) this.emitState(lane, run);
  }

  private recordSessionPersistenceFailure(
    lane: ConversationLane,
    run: RunRecord,
    error: unknown,
  ): void {
    this.openPersistenceCircuit(lane, run, error);
    run.sessionPersistenceError = errorMessage(error);
    run.finalPersisted = false;
    if (!isTerminalPhase(run.phase)) this.emitState(lane, run);
  }

  private acceptPersistedConversation(
    lane: ConversationLane,
    conversation: StoredConversation,
  ): void {
    const next = cloneConversation(conversation);
    const currentCheckpoint = (lane.persistedConversation ?? lane.seedConversation)?.contextCheckpoint;
    if (currentCheckpoint && (
      !next.contextCheckpoint
      || currentCheckpoint.throughMessageSequence > next.contextCheckpoint.throughMessageSequence
    )) {
      next.contextCheckpoint = cloneContextCheckpoint(currentCheckpoint);
    }
    const protectedMessages = this.protectedFailureMessages(lane);
    if (protectedMessages.length > 0) {
      const protectedIds = new Set(protectedMessages.map(message => message.id));
      const merged = next.messages
        .filter(message => !protectedIds.has(message.id))
        .map(cloneMessage);
      // Preserve the durable order and insert the volatile pair at its natural
      // timestamp boundary. When the window is full, evict only durable
      // placeholders; the sole copy of failed output is never a trim target.
      for (const message of protectedMessages) {
        const cloned = cloneMessage(message);
        const insertion = merged.findIndex(candidate => candidate.createdAt > cloned.createdAt);
        if (insertion < 0) merged.push(cloned);
        else merged.splice(insertion, 0, cloned);
      }
      while (merged.length > MAX_RETAINED_CHAT_MESSAGES) {
        const removable = merged.findIndex(message => !protectedIds.has(message.id));
        if (removable < 0) break;
        merged.splice(removable, 1);
      }
      next.messages = merged;
      const current = lane.persistedConversation ?? lane.seedConversation;
      if (current) next.updatedAt = Math.max(next.updatedAt, current.updatedAt);
    }
    lane.persistedConversation = next;
  }

  private protectedFailureMessages(lane: ConversationLane): ChatMessage[] {
    const marker = lane.unpersistedFailure;
    if (!marker) return [];
    const snapshot = lane.terminalRuns.find(run => run.runId === marker.runId);
    if (snapshot) {
      return [cloneMessage(snapshot.userMessage), cloneMessage(snapshot.assistantMessage)];
    }
    const current = lane.persistedConversation ?? lane.seedConversation;
    if (!current) return [];
    const byId = new Map(current.messages.map(message => [message.id, message]));
    return [marker.userMessageId, marker.assistantMessageId]
      .map(id => byId.get(id))
      .filter((message): message is ChatMessage => Boolean(message))
      .map(cloneMessage);
  }

  private foldAndReleaseTerminalRun(lane: ConversationLane, run: RunRecord): void {
    const existing = lane.persistedConversation ?? lane.seedConversation;
    const base: StoredConversation = existing ? cloneConversation(existing) : {
      id: lane.conversationId,
      title: run.submission.userMessage.content.trim().slice(0, 80) || 'New conversation',
      agentId: run.submission.runtimeRequest.agentId,
      createdAt: run.submission.userMessage.createdAt,
      updatedAt: run.finishedAt ?? this.now(),
      messages: [],
    };
    const messages = base.messages.map(cloneMessage);
    const indexes = new Map(messages.map((message, index) => [message.id, index]));
    for (const message of [run.submission.userMessage, run.submission.assistantMessage]) {
      const next = cloneMessage(message);
      const index = indexes.get(next.id);
      if (index === undefined) {
        indexes.set(next.id, messages.length);
        messages.push(next);
      } else {
        messages[index] = next;
      }
    }
    base.messages = messages.slice(-MAX_RETAINED_CHAT_MESSAGES);
    base.updatedAt = Math.max(base.updatedAt, run.finishedAt ?? this.now());
    base.agentId = run.submission.runtimeRequest.agentId;
    if (run.sessionId) {
      base.sessionIds = { ...(base.sessionIds ?? {}), [base.agentId]: run.sessionId };
      if (run.submission.sessionConfigKey) {
        base.sessionConfigKeys = {
          ...(base.sessionConfigKeys ?? {}),
          [base.agentId]: run.submission.sessionConfigKey,
        };
      }
    }
    lane.terminalRuns = [
      ...lane.terminalRuns.filter(snapshot => snapshot.runId !== run.submission.runId),
      this.snapshotRun(run),
    ].slice(-MAX_RETAINED_TERMINAL_RUN_SNAPSHOTS);
    if (!run.finalPersisted && lane.unpersistedFailure === null) {
      lane.unpersistedFailure = {
        runId: run.submission.runId,
        detail: combinedRunError(run) ?? combinedPersistenceError(run) ?? 'unknown persistence failure',
        userMessageId: run.submission.userMessage.id,
        assistantMessageId: run.submission.assistantMessage.id,
      };
    }
    // Establish the protection marker before the bounded accept/trim. This is
    // especially important when a persisted start snapshot already contains
    // more than the 100-message UI window.
    this.acceptPersistedConversation(lane, base);
    lane.seedConversation = null;
    lane.runs.delete(run.submission.runId);
  }

  private kickLane(lane: ConversationLane): void {
    if (lane.draining) return;
    lane.draining = true;
    void this.drainLane(lane);
  }

  private async drainLane(lane: ConversationLane): Promise<void> {
    try {
      while (lane.queue.length > 0) {
        const run = lane.queue.shift();
        if (!run) continue;
        lane.active = run;
        try {
          await run.admissionPromise;
          if (!isTerminalPhase(run.phase)) await this.executeRun(lane, run);
        } finally {
          lane.active = null;
        }
      }
    } finally {
      lane.draining = false;
      if (lane.queue.length > 0) this.kickLane(lane);
      else this.pruneIdleLanes();
    }
  }

  private async initializeWatcher(lane: ConversationLane, watcher: Watcher): Promise<void> {
    try {
      await this.ensureLaneLoaded(lane);
      if (watcher.closed) return;
      const snapshot = this.buildConversationSnapshot(lane);
      this.safeDeliver(watcher, { type: 'snapshot', snapshot });
      for (const [runId, sequence] of Object.entries(snapshot.cursors)) {
        watcher.seen.set(runId, Math.max(watcher.seen.get(runId) ?? 0, sequence));
      }
      watcher.initializing = false;
      const buffered = watcher.buffered.splice(0);
      for (const event of buffered) this.deliverRunEvent(watcher, event);
    } catch {
      if (!watcher.closed) {
        watcher.initializing = false;
        const snapshot = this.buildConversationSnapshot(lane);
        this.safeDeliver(watcher, { type: 'snapshot', snapshot });
        const buffered = watcher.buffered.splice(0);
        for (const event of buffered) this.deliverRunEvent(watcher, event);
      }
    } finally {
      // close() may run while the persisted snapshot is still loading. Its
      // earlier prune attempt intentionally retained that loading lane; retry
      // once loading has settled so history-only views remain bounded.
      if (watcher.closed) this.pruneIdleLanes();
    }
  }

  private emitState(lane: ConversationLane, run: RunRecord): void {
    this.emitRunDelivery(lane, run, {
      type: 'state',
      runId: run.submission.runId,
      conversationId: lane.conversationId,
      sequence: this.nextSequence(run),
      run: this.snapshotRun(run),
    });
  }

  private setPhase(lane: ConversationLane, run: RunRecord, phase: ChatRunPhase): void {
    if (run.phase === phase) return;
    run.phase = phase;
    this.emitState(lane, run);
  }

  private emitRunDelivery(lane: ConversationLane, _run: RunRecord, event: ChatRunDelivery): void {
    for (const watcher of lane.watchers) {
      if (watcher.closed) continue;
      if (watcher.initializing) watcher.buffered.push(event);
      else this.deliverRunEvent(watcher, event);
    }
  }

  private deliverRunEvent(watcher: Watcher, event: ChatRunDelivery): void {
    const seen = watcher.seen.get(event.runId) ?? 0;
    if (event.sequence <= seen) return;
    watcher.seen.set(event.runId, event.sequence);
    this.safeDeliver(watcher, { type: 'run', event: cloneDelivery(event) });
  }

  private safeDeliver(watcher: Watcher, delivery: ChatConversationDelivery): void {
    if (watcher.closed) return;
    try {
      watcher.listener(delivery);
    } catch (error) {
      console.error('Ailu chat watcher failed.', error);
    }
  }

  private async ensureLaneLoaded(lane: ConversationLane): Promise<void> {
    if (lane.loaded) return;
    if (!lane.loadPromise) {
      lane.loadPromise = this.deps.loadConversation(lane.conversationId).then(conversation => {
        if (conversation) this.acceptPersistedConversation(lane, conversation);
        lane.loaded = true;
      }).catch(error => {
        lane.loaded = true;
        lane.loadError = errorMessage(error);
      });
    }
    await lane.loadPromise;
  }

  private buildConversationSnapshot(lane: ConversationLane): ChatConversationSnapshot {
    const conversation = lane.persistedConversation ?? lane.seedConversation;
    const messages = conversation?.messages.map(cloneMessage) ?? [];
    const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
    for (const run of lane.runs.values()) {
      for (const message of [run.submission.userMessage, run.submission.assistantMessage]) {
        const cloned = cloneMessage(message);
        const existing = messageIndex.get(cloned.id);
        if (existing === undefined) {
          messageIndex.set(cloned.id, messages.length);
          messages.push(cloned);
        } else {
          messages[existing] = cloned;
        }
      }
    }
    const liveRuns = [...lane.runs.values()].map(run => this.snapshotRun(run));
    const liveIds = new Set(liveRuns.map(run => run.runId));
    const runs = [
      ...lane.terminalRuns.filter(run => !liveIds.has(run.runId)),
      ...liveRuns,
    ];
    return {
      conversationId: lane.conversationId,
      conversation: conversation ? { ...cloneConversation(conversation), messages: messages.map(cloneMessage) } : null,
      messages,
      stopEpoch: lane.stopEpoch,
      activeRunId: lane.active?.submission.runId ?? null,
      queuedRunIds: lane.queue.map(run => run.submission.runId),
      running: runs.some(run => !isTerminalPhase(run.phase)),
      shuttingDown: this.shuttingDown,
      loadError: lane.loadError,
      runs,
      cursors: Object.fromEntries(runs.map(run => [run.runId, run.sequence])),
    };
  }

  private snapshotRun(run: RunRecord): ChatRunSnapshot {
    return {
      runId: run.submission.runId,
      conversationId: run.submission.conversationId,
      phase: run.phase,
      terminalStatus: run.terminalStatus,
      stopEpoch: run.stopEpoch,
      initialState: run.initialState,
      sequence: run.sequence,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startPersisted: run.startPersisted,
      activationPersisted: run.activationPersisted,
      cancellationRequestedPersisted: run.cancellationRequestedPersisted,
      finalPersisted: run.finalPersisted,
      sessionId: run.sessionId,
      cancellationReason: run.cancellationReason,
      error: run.error,
      persistenceError: combinedPersistenceError(run),
      userMessage: cloneMessage(run.submission.userMessage),
      assistantMessage: cloneMessage(run.submission.assistantMessage),
    };
  }

  private createRun(
    submission: InternalSubmission,
    stopEpoch: number,
    initialState: 'active' | 'queued',
  ): RunRecord {
    let resolveStart!: (handle: ChatRunHandle) => void;
    let rejectStart!: (error: unknown) => void;
    const startPromise = new Promise<ChatRunHandle>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    let resolveCompletion!: (result: ChatRunResult) => void;
    const completion = new Promise<ChatRunResult>(resolve => {
      resolveCompletion = resolve;
    });
    return {
      submission,
      phase: 'admitting',
      terminalStatus: null,
      stopEpoch,
      initialState,
      sequence: 0,
      queuedAt: this.now(),
      startedAt: null,
      finishedAt: null,
      startPersisted: false,
      activationPersisted: false,
      cancellationRequestedPersisted: false,
      finalPersisted: false,
      sessionId: null,
      durablyAdmittedSessionId: null,
      cancellationReason: null,
      error: null,
      persistenceError: null,
      sessionPersistenceError: null,
      checkpointPersistenceError: null,
      controller: new AbortController(),
      acceptingRuntimeEvents: true,
      runtimePromise: null,
      runtimeBlockedByPersistenceCircuit: false,
      admissionPromise: Promise.resolve(),
      activationPromise: null,
      checkpointRevision: 0,
      checkpointQueuedRevision: 0,
      checkpointBytes: 0,
      checkpointByteThreshold: CHAT_CHECKPOINT_BYTE_THRESHOLD,
      checkpointWrites: 0,
      checkpointTimer: null,
      checkpointTail: Promise.resolve(),
      checkpointDraining: false,
      checkpointingStopped: false,
      runtimeEventBytes: 0,
      artifactEventsAccepted: 0,
      artifactBudgetUsedBytes: 0,
      artifactTail: Promise.resolve(),
      artifactMaterializationStopped: false,
      artifactFailureReported: false,
      sideEffects: [],
      resolveStart,
      rejectStart,
      startPromise,
      resolveCompletion,
      completion,
    };
  }

  private normalizeSubmission(submission: ChatRunSubmission): InternalSubmission {
    const conversationId = submission.conversationId.trim();
    if (!conversationId) throw new Error('conversationId is required.');
    if (submission.runtimeRequest.conversationId !== conversationId) {
      throw new Error('runtimeRequest.conversationId must match submission.conversationId.');
    }
    if (submission.userMessage.id === submission.assistantMessage.id) {
      throw new Error('User and assistant message IDs must be distinct.');
    }
    if (submission.userMessage.role !== 'user') {
      throw new Error('userMessage.role must be user.');
    }
    if (submission.assistantMessage.role !== 'assistant') {
      throw new Error('assistantMessage.role must be assistant.');
    }
    const runId = submission.runId?.trim() || this.deps.createRunId?.() || createId('run');
    if ([...this.lanes.values()].some(lane => lane.runs.has(runId))) {
      throw new Error(`Duplicate chat run ID: ${runId}`);
    }
    return {
      ...submission,
      runId,
      conversationId,
      runtimeRequest: freezeRuntimeRequest(submission.runtimeRequest),
      userMessage: cloneMessage(submission.userMessage),
      assistantMessage: cloneMessage(submission.assistantMessage),
      conversationSnapshot: submission.conversationSnapshot
        ? cloneConversation(submission.conversationSnapshot)
        : null,
    };
  }

  private getLane(conversationId: string): ConversationLane {
    const normalized = conversationId.trim();
    let lane = this.lanes.get(normalized);
    if (!lane) {
      lane = {
        conversationId: normalized,
        lastTouched: 0,
        stopEpoch: 0,
        queue: [],
        active: null,
        runs: new Map(),
        draining: false,
        loaded: false,
        loadPromise: null,
        loadError: null,
        admissionTail: Promise.resolve(),
        persistedConversation: null,
        seedConversation: null,
        terminalRuns: [],
        unpersistedFailure: null,
        watchers: new Set(),
      };
      this.lanes.set(normalized, lane);
    }
    this.touchLane(lane);
    return lane;
  }

  private touchLane(lane: ConversationLane): void {
    this.laneTouchSequence += 1;
    lane.lastTouched = this.laneTouchSequence;
  }

  private isLaneTrulyIdle(lane: ConversationLane): boolean {
    return lane.active === null
      && lane.queue.length === 0
      && !lane.draining
      && [...lane.runs.values()].every(run => isTerminalPhase(run.phase));
  }

  private isPrunableIdleLane(lane: ConversationLane): boolean {
    return lane.watchers.size === 0
      && lane.loaded
      && this.isLaneTrulyIdle(lane)
      // Keep output that failed to reach durable final storage available for
      // the UI's copy/recovery warning instead of evicting its only copy.
      // A loaded history-only lane has no runs and is safe to reload later.
      && lane.unpersistedFailure === null
      && [...lane.runs.values()].every(run => run.startPersisted && run.finalPersisted);
  }

  private persistenceBackpressureFor(conversationId: string): ChatPersistenceBackpressureError | null {
    const existing = this.lanes.get(conversationId);
    if (existing?.unpersistedFailure) {
      return new ChatPersistenceBackpressureError(
        conversationId,
        'conversation',
        this.countUnpersistedLanes(),
      );
    }
    const retained = this.countUnpersistedLanes();
    if (this.persistenceCircuit) {
      return new ChatPersistenceBackpressureError(
        conversationId,
        'global',
        Math.max(1, retained),
      );
    }
    return null;
  }

  private countUnpersistedLanes(): number {
    return [...this.lanes.values()].filter(lane => lane.unpersistedFailure !== null).length;
  }

  private openPersistenceCircuit(
    lane: ConversationLane,
    run: RunRecord,
    error: unknown,
  ): void {
    if (this.persistenceCircuit) return;
    this.persistenceCircuit = {
      conversationId: lane.conversationId,
      runId: run.submission.runId,
      detail: errorMessage(error),
    };
  }

  private clearSessionRegistryForConversation(conversationId: string): void {
    for (const [sessionId, owner] of this.sessionOwners) {
      if (owner.conversationId === conversationId) this.sessionOwners.delete(sessionId);
    }
    for (let index = this.sessionConflicts.length - 1; index >= 0; index -= 1) {
      const conflict = this.sessionConflicts[index];
      if (conflict.owner.conversationId === conversationId
        || conflict.contender.conversationId === conversationId) {
        this.sessionConflicts.splice(index, 1);
      }
    }
  }

  private async validateResumeSession(
    lane: ConversationLane,
    run: RunRecord,
  ): Promise<Error | null> {
    const sessionId = run.submission.runtimeRequest.sessionId?.trim();
    if (!sessionId) return null;
    const contender: ChatSessionOwnership = {
      sessionId,
      conversationId: lane.conversationId,
      agentId: run.submission.runtimeRequest.agentId,
      runId: run.submission.runId,
      claimedAt: this.now(),
    };
    if (this.sessionConflicts.some(conflict => conflict.sessionId === sessionId)) {
      return new ConflictedChatSessionError(contender);
    }
    let owner: ChatSessionOwnership | null = null;
    if (this.deps.loadSessionOwner) {
      try {
        owner = await this.deps.loadSessionOwner(sessionId);
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
      if (owner) this.rememberSessionOwner(owner);
    } else {
      owner = this.sessionOwners.get(sessionId) ?? null;
    }
    if (!owner) return new UnownedChatSessionError(contender);
    if (!sameSessionScope(owner, contender)) {
      this.recordSessionConflict(owner, contender);
      return new DuplicateChatSessionError(owner, contender);
    }
    try {
      // A resume is not admitted merely because a startup-era lookup once
      // found the owner. Re-enter the durable transaction immediately before
      // Runtime and atomically refresh run/config ownership for this turn.
      await this.claimAndPersistSession(lane, run, sessionId);
      run.durablyAdmittedSessionId = sessionId;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return null;
  }

  private mergeSeedConversation(lane: ConversationLane, conversation: StoredConversation | null): void {
    if (!conversation || conversation.id !== lane.conversationId) return;
    const next = cloneConversation(conversation);
    if (lane.persistedConversation) {
      // Context checkpoints are committed by the canonical repository before
      // submit. Persistence callbacks intentionally return thin acknowledgements,
      // so merge that newer verified checkpoint into the loaded lane without
      // treating the UI's bounded message window as a replacement transcript.
      if (next.contextCheckpoint && (
        !lane.persistedConversation.contextCheckpoint
        || next.contextCheckpoint.throughMessageSequence
          > lane.persistedConversation.contextCheckpoint.throughMessageSequence
      )) {
        lane.persistedConversation = {
          ...lane.persistedConversation,
          contextCheckpoint: next.contextCheckpoint,
          updatedAt: Math.max(lane.persistedConversation.updatedAt, next.updatedAt),
        };
      }
      return;
    }
    if (!lane.seedConversation || next.updatedAt >= lane.seedConversation.updatedAt) {
      lane.seedConversation = next;
    }
  }

  private nextSequence(run: RunRecord): number {
    run.sequence += 1;
    return run.sequence;
  }

  private handleFor(run: RunRecord): ChatRunHandle {
    return {
      runId: run.submission.runId,
      conversationId: run.submission.conversationId,
      completion: run.completion,
    };
  }

  private async completionAfterSideEffects(run: RunRecord): Promise<ChatRunResult> {
    const result = await run.completion;
    await Promise.allSettled(run.sideEffects);
    return result;
  }

  private resultFor(run: RunRecord): ChatRunResult {
    return {
      runId: run.submission.runId,
      conversationId: run.submission.conversationId,
      status: run.terminalStatus ?? 'failed',
      assistantMessage: cloneMessage(run.submission.assistantMessage),
      sessionId: run.sessionId,
      cancellationReason: run.cancellationReason,
      error: run.error,
      persistenceError: combinedPersistenceError(run),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? this.now(),
      finalPersisted: run.finalPersisted,
      cancellationRequestedPersisted: run.cancellationRequestedPersisted,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async performRecovery(): Promise<ChatRecoveryReport> {
    if ([...this.lanes.values()].some(lane => lane.runs.size > 0 || lane.watchers.size > 0)) {
      throw new ChatRecoveryOrderError();
    }
    this.lanes.clear();
    this.sessionOwners.clear();
    this.sessionConflicts.length = 0;
    const failures: ChatRecoveryFailure[] = [];
    // Canonical owners are resolved lazily through the sharded durable index.
    // Retain the legacy enumerator only for callers not yet wired to that API.
    let sessionOwnershipsLoaded = 0;
    if (!this.deps.loadSessionOwner && this.deps.loadSessionOwnerships) {
      try {
        const owners = await this.deps.loadSessionOwnerships();
        sessionOwnershipsLoaded = owners.length;
        for (const owner of owners) {
          const existing = this.sessionOwners.get(owner.sessionId);
          if (existing && !sameSessionScope(existing, owner)) {
            this.recordSessionConflict(existing, owner);
          } else {
            this.rememberSessionOwner(owner);
          }
        }
      } catch (error) {
        failures.push({ stage: 'session-ownership', error: errorMessage(error) });
      }
    }
    return {
      policy: 'registry-only',
      durableTurnRecovery: 'vault-store-required',
      sessionOwnershipsLoaded,
      failures,
      sessionConflicts: this.listSessionConflicts(),
    };
  }

  private recordSessionConflict(owner: ChatSessionOwnership, contender: ChatSessionOwnership): void {
    if (this.sessionConflicts.some(conflict => (
      conflict.sessionId === contender.sessionId
      && conflict.contender.conversationId === contender.conversationId
      && conflict.contender.runId === contender.runId
    ))) return;
    this.sessionConflicts.push({
      sessionId: contender.sessionId,
      owner: { ...owner },
      contender: { ...contender },
    });
  }

  private rememberSessionOwner(owner: ChatSessionOwnership): void {
    for (const [sessionId, existing] of this.sessionOwners) {
      if (sessionId !== owner.sessionId && sameSessionScope(existing, owner)) {
        this.sessionOwners.delete(sessionId);
      }
    }
    this.sessionOwners.set(owner.sessionId, { ...owner });
  }
}

export class ChatCoordinatorShutdownError extends Error {
  constructor() {
    super('ChatRunCoordinator is shutting down and no longer accepts submissions.');
    this.name = 'ChatCoordinatorShutdownError';
  }
}

export class ChatConversationLoadError extends Error {
  constructor(readonly conversationId: string, detail: string) {
    super(`Conversation ${conversationId} could not be loaded: ${detail}`);
    this.name = 'ChatConversationLoadError';
  }
}

export class ChatPersistenceBackpressureError extends Error {
  constructor(
    readonly conversationId: string,
    readonly scope: 'conversation' | 'global',
    readonly retainedUnpersistedConversations: number,
  ) {
    super(scope === 'conversation'
      ? `对话 ${conversationId} 有一条未能保存的内容，内容仅保留在当前界面。请先复制该内容，再重启插件或修复存储后继续。`
      : `已有 ${retainedUnpersistedConversations} 个对话包含未能保存的内容，内容仅保留在各自当前界面。请先复制这些内容，再重启插件或修复存储后继续。`);
    this.name = 'ChatPersistenceBackpressureError';
  }
}

export class ChatPersistedRunBlockedError extends Error {
  constructor(
    readonly conversationId: string,
    readonly runId: string,
    readonly recoveryState: 'paused' | 'interrupted',
  ) {
    super(recoveryState === 'paused'
      ? `任务 ${runId} 已安全写入队列，但因存储故障未启动。重启插件后它会恢复为暂停任务。`
      : `任务 ${runId} 已安全写入运行记录，但因存储故障未启动。重启插件后它会恢复为中断任务。`);
    this.name = 'ChatPersistedRunBlockedError';
  }
}

export class ChatRecoveryOrderError extends Error {
  constructor() {
    super('ChatRunCoordinator.recover() must run before submissions or conversation watchers are created.');
    this.name = 'ChatRecoveryOrderError';
  }
}

export class DuplicateChatSessionError extends Error {
  constructor(
    readonly owner: ChatSessionOwnership,
    readonly contender: ChatSessionOwnership,
  ) {
    super(
      `Runtime session ${contender.sessionId} already belongs to conversation ${owner.conversationId}.`,
    );
    this.name = 'DuplicateChatSessionError';
  }
}

export class UnownedChatSessionError extends Error {
  constructor(readonly contender: ChatSessionOwnership) {
    super(
      `Runtime session ${contender.sessionId} has no verified owner and cannot be resumed safely.`,
    );
    this.name = 'UnownedChatSessionError';
  }
}

export class ConflictedChatSessionError extends Error {
  constructor(readonly contender: ChatSessionOwnership) {
    super(
      `Runtime session ${contender.sessionId} has conflicting persisted owners and is quarantined.`,
    );
    this.name = 'ConflictedChatSessionError';
  }
}

function freezeRuntimeRequest(request: Omit<ChatTurnRequest, 'signal'>): FrozenChatTurnRequest {
  const attachments = request.attachments?.map(attachment => Object.freeze({ ...attachment }));
  return Object.freeze({
    ...request,
    attachments: attachments ? Object.freeze(attachments) : undefined,
  });
}

function cloneMessage(message: ChatMessage): ChatMessage {
  const toolLifecycle = cloneToolLifecycleContentMetadata(message.metadata);
  return {
    ...message,
    metadata: message.metadata
      ? {
        ...message.metadata,
        artifacts: message.metadata.artifacts?.map(cloneArtifact),
        ...(toolLifecycle
          ? { [TOOL_LIFECYCLE_CONTENT_METADATA_KEY]: toolLifecycle }
          : {}),
      }
      : undefined,
  };
}

function cloneArtifact(artifact: ChatArtifact): ChatArtifact {
  return { ...artifact };
}

function cloneConversation(conversation: StoredConversation): StoredConversation {
  return {
    ...conversation,
    messages: conversation.messages
      .slice(-MAX_RETAINED_CHAT_MESSAGES)
      .map(cloneMessage),
    sessionIds: conversation.sessionIds ? { ...conversation.sessionIds } : undefined,
    sessionConfigKeys: conversation.sessionConfigKeys
      ? { ...conversation.sessionConfigKeys }
      : undefined,
    contextCheckpoint: conversation.contextCheckpoint
      ? cloneContextCheckpoint(conversation.contextCheckpoint)
      : undefined,
  };
}

function cloneContextCheckpoint(
  checkpoint: NonNullable<StoredConversation['contextCheckpoint']>,
): NonNullable<StoredConversation['contextCheckpoint']> {
  return {
    ...checkpoint,
    summary: {
      ...checkpoint.summary,
      facts: [...checkpoint.summary.facts],
      decisions: [...checkpoint.summary.decisions],
      userPreferences: [...checkpoint.summary.userPreferences],
      constraints: [...checkpoint.summary.constraints],
      openLoops: [...checkpoint.summary.openLoops],
      filesMentioned: [...checkpoint.summary.filesMentioned],
    },
  };
}

function cloneDelivery(event: ChatRunDelivery): ChatRunDelivery {
  if (event.type === 'state') return { ...event, run: { ...event.run, userMessage: cloneMessage(event.run.userMessage), assistantMessage: cloneMessage(event.run.assistantMessage) } };
  if (event.type === 'artifact') return { ...event, artifact: cloneArtifact(event.artifact) };
  return { ...event, event: cloneRuntimeEvent(event.event) };
}

function cloneRuntimeEvent(event: Exclude<RuntimeTurnEvent, { type: 'artifact' }>): typeof event {
  if (event.type === 'tool') return { ...event, toolCall: { ...event.toolCall } };
  return { ...event };
}

function appendAssistantError(message: ChatMessage, detail: string): void {
  const prefix = message.content.trim() ? '\n' : '';
  message.content += `${prefix}${detail}`;
}

function sameSessionScope(a: ChatSessionOwnership, b: ChatSessionOwnership): boolean {
  return a.conversationId === b.conversationId && a.agentId === b.agentId;
}

function combinedRunError(
  run: Pick<RunRecord, 'error' | 'persistenceError' | 'sessionPersistenceError'>,
): string | null {
  return [run.error, run.persistenceError, run.sessionPersistenceError]
    .filter((value): value is string => Boolean(value))
    .join('\n') || null;
}

function combinedPersistenceError(
  run: Pick<
    RunRecord,
    'persistenceError' | 'sessionPersistenceError' | 'checkpointPersistenceError'
  >,
): string | null {
  return [run.persistenceError, run.sessionPersistenceError, run.checkpointPersistenceError]
    .filter((value): value is string => Boolean(value))
    .join('\n') || null;
}

function hasUnresolvedPersistenceError(
  run: Pick<RunRecord, 'persistenceError' | 'sessionPersistenceError'>,
): boolean {
  return Boolean(run.persistenceError || run.sessionPersistenceError);
}

export function isTerminalChatRunPhase(phase: ChatRunPhase): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'failed';
}

export function isChatConversationRunning(snapshot: ChatConversationSnapshot): boolean {
  return snapshot.runs.some(run => !isTerminalChatRunPhase(run.phase));
}

function isTerminalPhase(phase: ChatRunPhase): boolean {
  return isTerminalChatRunPhase(phase);
}

function isCancellablePhase(phase: ChatRunPhase): boolean {
  return phase === 'admitting'
    || phase === 'queued'
    || phase === 'preparing'
    || phase === 'running'
    || phase === 'stopping';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : utf8ByteLength(serialized);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
