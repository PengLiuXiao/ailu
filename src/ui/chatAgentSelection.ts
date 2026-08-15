import type { AgentId, RuntimeConfigSource, StoredConversation, AiluSettings } from '../types';
import { projectCompletedConversation } from '../chat/contextCompression';
import type { VersionedStoredConversation } from '../storage/vaultStore';

export interface ChatAgentSelectionResult {
  agentId: AgentId;
  agentChanged: boolean;
  defaultChanged: boolean;
}

export interface ClaudeSessionConfigKeyInput {
  configSource: RuntimeConfigSource;
  effectiveModel: string;
  fullAccess?: boolean;
  localRouteFingerprint?: string;
  reasoningEffort?: string;
  providerProfileId?: string;
  providerProfileUpdatedAt?: number;
  /** Current CC Switch provider id. Changes must never resume the old route. */
  ccSwitchProviderId?: string;
}

export interface CodexSessionConfigKeyInput {
  fullAccess?: boolean;
}

export interface KnownChatSessionOwner {
  conversationId: string;
  agentId: AgentId;
}

export interface ConversationHandoffHintState {
  running: boolean;
  preparing: boolean;
}

/**
 * Apply the visible Agent choice and its persisted default as one atomic state
 * decision. Keeping this separate prevents direct Agent switches and history
 * restores from drifting into different persistence behavior.
 */
export function applyChatAgentSelection(
  settings: Pick<AiluSettings, 'defaultAgentId'>,
  currentAgentId: AgentId,
  nextAgentId: AgentId,
): ChatAgentSelectionResult {
  const agentChanged = currentAgentId !== nextAgentId;
  const defaultChanged = settings.defaultAgentId !== nextAgentId;
  settings.defaultAgentId = nextAgentId;
  return {
    agentId: nextAgentId,
    agentChanged,
    defaultChanged,
  };
}

/** Keep a deliberate local model override for Claude; Codex models
 * are reconciled against live App Server metadata by its dedicated selector. */
export function applyLocalCliSelection(
  settings: Pick<AiluSettings, 'configSources' | 'localModelByAgent'>,
  agentId: AgentId,
  modelId: string,
): void {
  settings.configSources[agentId] = 'localCli';
  settings.localModelByAgent[agentId] = agentId === 'codex' ? '' : modelId.trim();
}

/**
 * Build a stable, non-secret description of the Claude runtime selection.
 * Provider credentials and endpoints are deliberately excluded; `updatedAt`
 * invalidates the session when the selected profile is edited.
 */
export function buildClaudeSessionConfigKey(input: ClaudeSessionConfigKeyInput): string {
  return JSON.stringify({
    version: 1,
    configSource: input.configSource,
    effectiveModel: input.effectiveModel.trim(),
    fullAccess: input.fullAccess === true,
    localRouteFingerprint: input.localRouteFingerprint ?? '',
    reasoningEffort: input.reasoningEffort?.trim() ?? '',
    providerProfileId: input.providerProfileId?.trim() ?? '',
    providerProfileUpdatedAt: Number.isFinite(input.providerProfileUpdatedAt)
      ? input.providerProfileUpdatedAt
      : 0,
    ccSwitchProviderId: input.ccSwitchProviderId?.trim() ?? '',
  });
}

/** Existing/legacy Claude sessions without a matching configuration key start
 * a fresh session once instead of silently retaining a previous model. */
export function shouldResumeClaudeSession(
  sessionId: string | undefined,
  storedConfigKey: string | undefined,
  currentConfigKey: string,
): boolean {
  return Boolean(sessionId?.trim() && storedConfigKey && storedConfigKey === currentConfigKey);
}

/**
 * Codex approvals can outlive a single turn in older App Server sessions.
 * Bind persisted continuation to the access mode so an upgrade or permission
 * toggle starts from a fresh provider-neutral handoff.
 */
export function buildCodexSessionConfigKey(input: CodexSessionConfigKeyInput): string {
  return JSON.stringify({
    version: 1,
    access: input.fullAccess === true ? 'full' : 'restricted',
  });
}

/** Legacy Codex sessions without an access binding are never resumed. */
export function shouldResumeCodexSession(
  sessionId: string | undefined,
  storedConfigKey: string | undefined,
  currentConfigKey: string,
): boolean {
  return Boolean(sessionId?.trim() && storedConfigKey && storedConfigKey === currentConfigKey);
}

/**
 * Decide whether the UI should pass a persisted session to the coordinator.
 *
 * The coordinator's registry is intentionally lazy after a plugin restart, so
 * a missing in-memory owner means "not loaded yet", not "unowned". The
 * coordinator performs the authoritative durable lookup and claim before the
 * runtime sees the prompt. A known conflicting owner can still be rejected
 * early without losing restart continuity.
 */
export function shouldAttemptSessionResume(input: {
  sessionId: string | undefined;
  registryHealthy: boolean;
  hasKnownConflict: boolean;
  knownOwner: KnownChatSessionOwner | null;
  conversationId: string;
  agentId: AgentId;
}): boolean {
  if (!input.sessionId?.trim() || !input.registryHealthy || input.hasKnownConflict) return false;
  if (!input.knownOwner) return true;
  return input.knownOwner.conversationId === input.conversationId
    && input.knownOwner.agentId === input.agentId;
}

/** Short, user-facing explanation shown before a cross-Agent handoff. */
export function conversationHandoffHint(
  conversation: (StoredConversation & Partial<VersionedStoredConversation>) | null,
  targetAgentId: AgentId,
  targetLabel: string,
  state: ConversationHandoffHintState = { running: false, preparing: false },
): string | null {
  if (!conversation || state.running || state.preparing) return null;
  if (!Number.isInteger(conversation.revision) || !Array.isArray(conversation.turns)) return null;
  const projection = projectCompletedConversation(conversation as VersionedStoredConversation);
  const latestCompletedVisibleTurn = projection.turns[projection.turns.length - 1];
  if (!latestCompletedVisibleTurn || latestCompletedVisibleTurn.agentId === targetAgentId) return null;
  return `发送时，Ailu 会整理这段对话，让 ${targetLabel} 接着聊。`;
}
