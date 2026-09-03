import type {
  AgentId,
  ConversationContextCheckpointDraft,
  ConversationContextSummary,
} from '../types';
import type { VersionedStoredConversation } from '../storage/vaultStore';
import type { ConversationWindow } from '../storage/conversationRepositoryV2';
import { createId } from '../utils/id';
import {
  buildConversationHandoffPrompt,
  buildDeterministicFallbackSummary,
  DEFAULT_HARD_CONTEXT_RATIO,
  DEFAULT_RAW_TAIL_TURNS,
  DEFAULT_SOFT_CONTEXT_RATIO,
  DEFAULT_TURN_CHECKPOINT_LIMIT,
  DEFAULT_UNKNOWN_CONTEXT_TOKENS,
  estimateContextBudget,
  evaluateTargetSessionFreshness,
  projectCompletedConversation,
  sanitizeConversationContextSummary,
  selectRawTail,
  type CompletedConversationProjection,
  type ContextTailSelection,
  type ProjectedContextTurn,
} from './contextCompression';

const DEFAULT_WINDOW_MESSAGES = 100;
const DEFAULT_SAFETY_FACTOR = 1.25;

export type ChatContextPreparationMode =
  | 'new-conversation'
  | 'native-resume'
  | 'fresh-handoff'
  | 'checkpoint-handoff';

export interface ChatContextPreparation {
  effectivePrompt: string;
  /** Canonical revision used to prepare this prompt; beginTurn must match it. */
  sourceRevision?: number;
  sessionId?: string;
  freshSessionPrompt?: string;
  allowFreshSessionFallback: boolean;
  contextCheckpointId?: string;
  /** Committed atomically with beginTurn; preparation itself is read-only. */
  contextCheckpointDraft?: ConversationContextCheckpointDraft;
  mode: ChatContextPreparationMode;
  notice: string;
}

export interface PrepareChatContextInput {
  conversationId: string;
  targetAgentId: AgentId;
  currentPrompt: string;
  /** A session already validated against the active runtime configuration. */
  resumeCandidate?: string;
  modelContextTokens?: number;
}

export interface ChatContextStore {
  loadConversationWindow(conversationId: string, limit?: number): Promise<ConversationWindow | null>;
  getConversation(conversationId: string): Promise<VersionedStoredConversation | null>;
}

export interface ChatContextServiceOptions {
  store: ChatContextStore;
  now?: () => number;
  createCheckpointId?: () => string;
  windowMessages?: number;
  rawTailTurns?: number;
  checkpointTurnLimit?: number;
  softContextRatio?: number;
  hardContextRatio?: number;
  safetyFactor?: number;
}

export class ChatContextOverflowError extends Error {
  constructor(message = '当前消息和最近上下文过长，无法在安全范围内完成交接。') {
    super(message);
    this.name = 'ChatContextOverflowError';
  }
}

/**
 * Turns the canonical V2 transcript into a provider-neutral handoff only when
 * a native provider session can no longer be trusted as current. Provider
 * sessions are accelerators; they never become the source of conversation
 * truth.
 */
export class ChatContextService {
  private readonly now: () => number;
  private readonly createCheckpointId: () => string;
  private readonly windowMessages: number;
  private readonly rawTailTurns: number;
  private readonly checkpointTurnLimit: number;
  private readonly softContextRatio: number;
  private readonly hardContextRatio: number;
  private readonly safetyFactor: number;

  constructor(private readonly options: ChatContextServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createCheckpointId = options.createCheckpointId ?? (() => createId('ctx'));
    this.windowMessages = positiveInteger(options.windowMessages, DEFAULT_WINDOW_MESSAGES);
    this.rawTailTurns = nonNegativeInteger(options.rawTailTurns, DEFAULT_RAW_TAIL_TURNS);
    this.checkpointTurnLimit = positiveInteger(
      options.checkpointTurnLimit,
      DEFAULT_TURN_CHECKPOINT_LIMIT,
    );
    this.softContextRatio = boundedRatio(options.softContextRatio, DEFAULT_SOFT_CONTEXT_RATIO);
    this.hardContextRatio = boundedRatio(options.hardContextRatio, DEFAULT_HARD_CONTEXT_RATIO);
    this.safetyFactor = positiveNumber(options.safetyFactor, DEFAULT_SAFETY_FACTOR);
  }

  async prepare(input: PrepareChatContextInput): Promise<ChatContextPreparation> {
    const conversationId = requireText(input.conversationId, 'conversationId');
    const currentPrompt = requireText(input.currentPrompt, 'currentPrompt');
    const window = await this.options.store.loadConversationWindow(
      conversationId,
      this.windowMessages,
    );
    if (!window) throw new Error(`Conversation ${conversationId} was not found.`);

    const completedTurns = window.conversation.turns.filter(turn => turn.state === 'completed');
    if (completedTurns.length === 0) {
      this.assertCurrentPromptFits(currentPrompt, input.modelContextTokens);
      return {
        effectivePrompt: currentPrompt,
        sourceRevision: window.conversation.revision,
        allowFreshSessionFallback: false,
        mode: 'new-conversation',
        notice: '',
      };
    }

    const storedSession = window.conversation.sessionIds?.[input.targetAgentId]?.trim();
    const resumeCandidate = input.resumeCandidate?.trim();
    const freshness = evaluateTargetSessionFreshness(
      window.conversation,
      input.targetAgentId,
    );
    const canResume = Boolean(
      resumeCandidate
      && storedSession
      && resumeCandidate === storedSession
      && !freshness.stale,
    );
    const latestCompletedTurn = completedTurns
      .slice()
      .sort((left, right) => left.queueSequence - right.queueSequence || left.id.localeCompare(right.id))
      .at(-1);
    const agentSwitch = latestCompletedTurn?.agentId !== input.targetAgentId;
    const needsFreshHandoff = !canResume || agentSwitch;
    const postCheckpointTurnCount = countCompletedTurnsAfterCheckpoint(window.conversation);
    const turnLimitReached = postCheckpointTurnCount >= this.checkpointTurnLimit;

    let source = deriveWindowSource(window);
    // Codex provider threads and Pi native sessions can disappear underneath
    // Ailu; both resume paths always carry a verified fresh-session handoff.
    const nativeFallbackNeeded = canResume
      && (input.targetAgentId === 'codex' || input.targetAgentId === 'pi');
    if (!source.safe && (needsFreshHandoff || turnLimitReached || nativeFallbackNeeded)) {
      const full = await this.options.store.getConversation(conversationId);
      if (!full) throw new Error(`Conversation ${conversationId} was not found.`);
      source = deriveFullSource(full);
    }

    const sourceBudget = estimateContextBudget({
      projection: source.projection,
      previousSummary: checkpointSummary(source.conversation),
      additionalText: [currentPrompt],
      modelContextTokens: input.modelContextTokens ?? DEFAULT_UNKNOWN_CONTEXT_TOKENS,
      softRatio: this.softContextRatio,
      hardRatio: this.hardContextRatio,
      safetyFactor: this.safetyFactor,
    });
    const budgetCheckpointNeeded = source.safe && sourceBudget.overSoftLimit;
    const handoffWouldDropPrefix = needsFreshHandoff && source.projection.turns.length > this.rawTailTurns;
    let checkpointNeeded = turnLimitReached || budgetCheckpointNeeded || handoffWouldDropPrefix;

    if (!source.safe && checkpointNeeded) {
      const full = await this.options.store.getConversation(conversationId);
      if (!full) throw new Error(`Conversation ${conversationId} was not found.`);
      source = deriveFullSource(full);
    }

    if (checkpointNeeded && source.projection.turns.length === 0) checkpointNeeded = false;

    if (checkpointNeeded) {
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        input.modelContextTokens,
        true,
      );
      if (!compression.selection.summarySource.length
        || compression.selection.throughMessageSequence === null
        || !compression.selection.throughMessageId) {
        throw new ChatContextOverflowError();
      }
      const draft: ConversationContextCheckpointDraft = {
        version: 1,
        id: this.createCheckpointId(),
        createdAt: this.now(),
        sourceRevision: source.conversation.revision,
        throughMessageSequence: compression.selection.throughMessageSequence,
        throughMessageId: compression.selection.throughMessageId,
        projectionVersion: 1,
        summary: compression.summary,
        createdBy: 'local',
        ...(source.conversation.contextCheckpoint
          ? { previousCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
      };
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: draft.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: freshSessionPrompt,
        sourceRevision: source.conversation.revision,
        freshSessionPrompt,
        allowFreshSessionFallback: false,
        contextCheckpointId: draft.id,
        contextCheckpointDraft: draft,
        mode: 'checkpoint-handoff',
        notice: '已压缩较早对话，完整聊天记录仍然保留。',
      };
    }

    if (needsFreshHandoff) {
      if (!source.safe) {
        const full = await this.options.store.getConversation(conversationId);
        if (!full) throw new Error(`Conversation ${conversationId} was not found.`);
        source = deriveFullSource(full);
      }
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        input.modelContextTokens,
        false,
      );
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: compression.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: freshSessionPrompt,
        sourceRevision: source.conversation.revision,
        freshSessionPrompt,
        allowFreshSessionFallback: false,
        ...(source.conversation.contextCheckpoint
          ? { contextCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
        mode: 'fresh-handoff',
        notice: `已整理上下文，${agentDisplayName(input.targetAgentId)} 将从这里继续。`,
      };
    }

    if (nativeFallbackNeeded) {
      if (!source.safe) {
        const full = await this.options.store.getConversation(conversationId);
        if (!full) throw new Error(`Conversation ${conversationId} was not found.`);
        source = deriveFullSource(full);
      }
      const compression = this.chooseSafeCompression(
        source.projection,
        checkpointSummary(source.conversation),
        currentPrompt,
        input.modelContextTokens,
        false,
      );
      const freshSessionPrompt = appendCurrentPrompt(
        buildConversationHandoffPrompt({
          summary: compression.summary,
          rawTail: compression.selection.rawTail,
          targetAgentId: input.targetAgentId,
        }),
        currentPrompt,
      );
      return {
        effectivePrompt: currentPrompt,
        sourceRevision: source.conversation.revision,
        sessionId: resumeCandidate,
        freshSessionPrompt,
        allowFreshSessionFallback: true,
        ...(source.conversation.contextCheckpoint
          ? { contextCheckpointId: source.conversation.contextCheckpoint.id }
          : {}),
        mode: 'native-resume',
        notice: '',
      };
    }

    this.assertCurrentPromptFits(currentPrompt, input.modelContextTokens);
    return {
      effectivePrompt: currentPrompt,
      sourceRevision: source.conversation.revision,
      sessionId: resumeCandidate,
      allowFreshSessionFallback: false,
      mode: 'native-resume',
      notice: '',
    };
  }

  private chooseSafeCompression(
    projection: CompletedConversationProjection,
    previousSummary: ConversationContextSummary | undefined,
    currentPrompt: string,
    modelContextTokens: number | undefined,
    requireCheckpointBoundary: boolean,
  ): CompressionMaterial {
    const maxTail = Math.min(this.rawTailTurns, projection.turns.length);
    for (let tailTurns = maxTail; tailTurns >= 0; tailTurns -= 1) {
      const selection = selectCheckpointSafeTail(projection, tailTurns);
      if (requireCheckpointBoundary && selection.summarySource.length === 0) continue;
      const summaryDelta = buildDeterministicFallbackSummary({
        ...projection,
        turns: selection.summarySource,
      });
      const summary = mergeContextSummaries(previousSummary, summaryDelta);
      const compactedProjection: CompletedConversationProjection = {
        ...projection,
        turns: selection.rawTail,
      };
      const budget = estimateContextBudget({
        projection: compactedProjection,
        previousSummary: summary,
        additionalText: [currentPrompt],
        modelContextTokens: modelContextTokens ?? DEFAULT_UNKNOWN_CONTEXT_TOKENS,
        softRatio: this.softContextRatio,
        hardRatio: this.hardContextRatio,
        safetyFactor: this.safetyFactor,
      });
      if (!budget.overHardLimit) return { selection, summary };
    }
    throw new ChatContextOverflowError();
  }

  private assertCurrentPromptFits(currentPrompt: string, modelContextTokens: number | undefined): void {
    const budget = estimateContextBudget({
      additionalText: [currentPrompt],
      modelContextTokens: modelContextTokens ?? DEFAULT_UNKNOWN_CONTEXT_TOKENS,
      softRatio: this.softContextRatio,
      hardRatio: this.hardContextRatio,
      safetyFactor: this.safetyFactor,
    });
    if (budget.overHardLimit) throw new ChatContextOverflowError();
  }
}

interface CanonicalProjectionSource {
  conversation: VersionedStoredConversation;
  projection: CompletedConversationProjection;
  safe: boolean;
}

interface CompressionMaterial {
  selection: ContextTailSelection;
  summary: ConversationContextSummary;
}

function deriveWindowSource(window: ConversationWindow): CanonicalProjectionSource {
  const loadedCount = window.conversation.messages.length;
  const offset = Math.max(0, window.totalMessageCount - loadedCount);
  const checkpointBoundary = window.conversation.contextCheckpoint?.throughMessageSequence ?? 0;
  const safe = offset === 0 || checkpointBoundary >= offset;
  const projected = projectCompletedConversation(window.conversation);
  const projection: CompletedConversationProjection = {
    ...projected,
    turns: projected.turns.flatMap<ProjectedContextTurn>(turn => {
      const messages = turn.messages
        .map(message => ({ ...message, sequence: message.sequence + offset }))
        .filter(message => message.sequence > checkpointBoundary);
      return messages.length > 0 ? [{ ...turn, messages }] : [];
    }),
  };
  return { conversation: window.conversation, projection, safe };
}

function deriveFullSource(conversation: VersionedStoredConversation): CanonicalProjectionSource {
  const projected = projectCompletedConversation(conversation);
  const checkpointBoundary = conversation.contextCheckpoint?.throughMessageSequence ?? 0;
  return {
    conversation,
    projection: {
      ...projected,
      turns: projected.turns.flatMap<ProjectedContextTurn>(turn => {
        const messages = turn.messages.filter(message => message.sequence > checkpointBoundary);
        return messages.length > 0 ? [{ ...turn, messages }] : [];
      }),
    },
    safe: true,
  };
}

function countCompletedTurnsAfterCheckpoint(conversation: VersionedStoredConversation): number {
  const completed = conversation.turns
    .filter(turn => turn.state === 'completed')
    .sort((left, right) => left.queueSequence - right.queueSequence || left.id.localeCompare(right.id));
  const boundaryId = conversation.contextCheckpoint?.throughMessageId;
  if (!boundaryId) return completed.length;
  const boundaryIndex = completed.findIndex(turn => turn.assistantMessageId === boundaryId);
  return boundaryIndex < 0 ? completed.length : completed.length - boundaryIndex - 1;
}

function selectCheckpointSafeTail(
  projection: CompletedConversationProjection,
  maxTurns: number,
): ContextTailSelection {
  const initial = selectRawTail(projection, maxTurns);
  if (initial.summarySource.length === 0) return initial;
  let boundary = initial.summarySource.length;
  while (boundary > 0) {
    const turn = projection.turns[boundary - 1];
    const last = turn?.messages.at(-1);
    if (turn && last?.role === 'assistant') break;
    boundary -= 1;
  }
  const summarySource = projection.turns.slice(0, boundary);
  const rawTail = projection.turns.slice(boundary);
  const boundaryMessage = summarySource.at(-1)?.messages.at(-1);
  return {
    summarySource,
    rawTail,
    throughMessageSequence: boundaryMessage?.sequence ?? null,
    throughMessageId: boundaryMessage?.id ?? null,
  };
}

function mergeContextSummaries(
  previous: ConversationContextSummary | undefined,
  current: ConversationContextSummary,
): ConversationContextSummary {
  if (!previous) return current;
  return {
    facts: mergeSummaryItems(previous.facts, current.facts),
    decisions: mergeSummaryItems(previous.decisions, current.decisions),
    userPreferences: mergeSummaryItems(previous.userPreferences, current.userPreferences),
    constraints: mergeSummaryItems(previous.constraints, current.constraints),
    openLoops: mergeSummaryItems(previous.openLoops, current.openLoops),
    filesMentioned: mergeSummaryItems(previous.filesMentioned, current.filesMentioned),
    lastIntent: current.lastIntent || previous.lastIntent,
  };
}

function checkpointSummary(
  conversation: VersionedStoredConversation,
): ConversationContextSummary | undefined {
  return conversation.contextCheckpoint
    ? sanitizeConversationContextSummary(conversation.contextCheckpoint.summary)
    : undefined;
}

function mergeSummaryItems(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].slice(-32);
}

function appendCurrentPrompt(handoff: string, currentPrompt: string): string {
  return `${handoff}\n\n当前回合输入：\n${currentPrompt}`;
}

function agentDisplayName(agentId: AgentId): string {
  if (agentId === 'claude') return 'Claude Code';
  if (agentId === 'pi') return 'Pi';
  return 'Codex';
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${label} must not be empty.`);
  return normalized;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function boundedRatio(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 && Number(value) < 1
    ? Number(value)
    : fallback;
}
