import { describe, expect, it } from 'vitest';

import {
  applyChatAgentSelection,
  applyLocalCliSelection,
  buildClaudeSessionConfigKey,
  buildCodexSessionConfigKey,
  conversationHandoffHint,
  resolveAvailableDefaultAgent,
  shouldAttemptSessionResume,
  shouldResumeClaudeSession,
  buildPiSessionConfigKey,
  shouldResumePiSession,
  shouldResumeCodexSession,
} from '../src/ui/chatAgentSelection';
import { normalizeSelectableAgentId, SELECTABLE_AGENT_IDS } from '../src/agents';
import type {
  ConversationTurnState,
  VersionedStoredConversation,
} from '../src/storage/vaultStore';
import { normalizeFullAccessByAgent } from '../src/types';

function conversationWithTurn(
  state: ConversationTurnState = 'completed',
  overrides: Partial<VersionedStoredConversation> = {},
): VersionedStoredConversation {
  return {
    id: 'conversation-a',
    title: '历史对话',
    agentId: 'claude',
    createdAt: 1,
    updatedAt: 3,
    revision: 1,
    messages: [
      {
        id: 'user-a',
        role: 'user',
        content: '上一轮问题',
        createdAt: 2,
        agentId: 'claude',
      },
      {
        id: 'assistant-a',
        role: 'assistant',
        content: '上一轮由 Claude 完成。',
        createdAt: 3,
        agentId: 'claude',
      },
    ],
    turns: [{
      id: 'turn-a',
      agentId: 'claude',
      userMessageId: 'user-a',
      assistantMessageId: 'assistant-a',
      state,
      queueSequence: 1,
      createdAt: 2,
      updatedAt: 3,
      ...(state === 'completed' ? { completedAt: 3 } : {}),
    }],
    ...overrides,
  };
}

describe('chat Agent selection', () => {
  it('recovers a fresh install to the only available Agent', () => {
    const settings = { defaultAgentId: 'claude' as const };
    expect(resolveAvailableDefaultAgent(settings.defaultAgentId, { claude: false, codex: true, pi: false, antigravity: false }))
      .toBe('codex');
    expect(settings.defaultAgentId).toBe('claude');
    expect(resolveAvailableDefaultAgent('codex', { claude: true, codex: false, pi: false, antigravity: false })).toBe('claude');
  });

  it('keeps the preferred Agent when it is available or no runtime exists', () => {
    expect(resolveAvailableDefaultAgent('codex', { claude: true, codex: true, pi: true, antigravity: false })).toBe('codex');
    expect(resolveAvailableDefaultAgent('claude', { claude: false, codex: false, pi: false, antigravity: false })).toBe('claude');
    expect(resolveAvailableDefaultAgent('pi', { claude: false, codex: true, pi: false, antigravity: false })).toBe('codex');
  });

  it('only exposes Claude, Codex, Pi, and Antigravity for new conversations', () => {
    expect(SELECTABLE_AGENT_IDS).toEqual(['claude', 'codex', 'pi', 'antigravity']);
    expect(normalizeSelectableAgentId('other-agent')).toBe('claude');
    expect(normalizeSelectableAgentId('codex')).toBe('codex');
    expect(normalizeSelectableAgentId('pi')).toBe('pi');
    expect(normalizeSelectableAgentId('antigravity')).toBe('antigravity');
  });

  it('switches the visible Agent and persisted default together', () => {
    const settings = { defaultAgentId: 'claude' as const };

    const result = applyChatAgentSelection(settings, 'claude', 'codex');

    expect(result).toEqual({
      agentId: 'codex',
      agentChanged: true,
      defaultChanged: true,
    });
    expect(settings.defaultAgentId).toBe('codex');
  });

  it('persists an already visible history Agent when it differs from the default', () => {
    const settings: { defaultAgentId: 'claude' | 'codex' } = {
      defaultAgentId: 'claude',
    };

    const result = applyChatAgentSelection(settings, 'codex', 'codex');

    expect(result.agentChanged).toBe(false);
    expect(result.defaultChanged).toBe(true);
    expect(settings.defaultAgentId).toBe('codex');
  });

  it('reports a no-op when visible and persisted selections already match', () => {
    const settings = { defaultAgentId: 'codex' as const };

    const result = applyChatAgentSelection(settings, 'codex', 'codex');

    expect(result.agentChanged).toBe(false);
    expect(result.defaultChanged).toBe(false);
  });

  it('keeps an explicit local Claude model instead of clearing it', () => {
    const settings = {
      configSources: {
        claude: 'providerProfile',
        codex: 'localCli',
      } as {
        claude: 'localCli' | 'providerProfile';
        codex: 'localCli' | 'providerProfile';
        pi: 'localCli';
        antigravity: 'localCli';
      },
      localModelByAgent: { claude: '', codex: '', pi: '', antigravity: '' },
    };

    applyLocalCliSelection(settings, 'claude', 'opus');

    expect(settings.configSources.claude).toBe('localCli');
    expect(settings.localModelByAgent.claude).toBe('opus');
  });

  it('leaves Codex model reconciliation to the App Server selector', () => {
    const settings = {
      configSources: {
        claude: 'localCli',
        codex: 'localCli',
      } as {
        claude: 'localCli' | 'providerProfile';
        codex: 'localCli' | 'providerProfile';
        pi: 'localCli';
        antigravity: 'localCli';
      },
      localModelByAgent: { claude: '', codex: 'stale-model', pi: '', antigravity: '' },
    };

    applyLocalCliSelection(settings, 'codex', 'ignored-model');

    expect(settings.localModelByAgent.codex).toBe('');
  });

  it('resumes Claude only when the session configuration still matches', () => {
    const original = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'sonnet',
      reasoningEffort: 'high',
    });
    const changedModel = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'opus',
      reasoningEffort: 'high',
    });

    expect(shouldResumeClaudeSession('session-1', original, original)).toBe(true);
    expect(shouldResumeClaudeSession('session-1', original, changedModel)).toBe(false);
    expect(shouldResumeClaudeSession('session-1', undefined, original)).toBe(false);
  });

  it('passes a persisted session through after restart when the lazy owner cache is empty', () => {
    expect(shouldAttemptSessionResume({
      sessionId: 'persisted-session',
      registryHealthy: true,
      hasKnownConflict: false,
      knownOwner: null,
      conversationId: 'conversation-a',
      agentId: 'codex',
    })).toBe(true);
  });

  it('rejects a persisted session early when the in-memory owner is known to belong elsewhere', () => {
    expect(shouldAttemptSessionResume({
      sessionId: 'conflicting-session',
      registryHealthy: true,
      hasKnownConflict: false,
      knownOwner: { conversationId: 'conversation-b', agentId: 'codex' },
      conversationId: 'conversation-a',
      agentId: 'codex',
    })).toBe(false);
    expect(shouldAttemptSessionResume({
      sessionId: 'quarantined-session',
      registryHealthy: true,
      hasKnownConflict: true,
      knownOwner: null,
      conversationId: 'conversation-a',
      agentId: 'codex',
    })).toBe(false);
  });

  it('explains only an actual cross-Agent handoff after a completed visible response', () => {
    const conversation = conversationWithTurn('completed', {
      sessionIds: { claude: 'claude-session', codex: 'stale-codex-session' },
    });

    expect(conversationHandoffHint(conversation, 'codex', 'Codex'))
      .toBe('发送时，Ailu 会整理这段对话，让 Codex 接着聊。');
    expect(conversationHandoffHint(conversation, 'claude', 'Claude Code')).toBeNull();

    const withoutSessions = { ...conversation, sessionIds: undefined };
    expect(conversationHandoffHint(withoutSessions, 'codex', 'Codex'))
      .toBe('发送时，Ailu 会整理这段对话，让 Codex 接着聊。');
    expect(conversationHandoffHint(withoutSessions, 'claude', 'Claude Code')).toBeNull();
  });

  it('never offers a handoff for a first turn or while the conversation is busy', () => {
    const firstTurn: VersionedStoredConversation = {
      id: 'conversation-a',
      title: '新对话',
      agentId: 'claude',
      createdAt: 1,
      updatedAt: 2,
      revision: 0,
      turns: [],
      messages: [{
        id: 'user-a',
        role: 'user',
        content: '第一条消息',
        createdAt: 2,
        agentId: 'claude',
      }],
    };
    expect(conversationHandoffHint(firstTurn, 'codex', 'Codex')).toBeNull();

    const completed = conversationWithTurn();
    expect(conversationHandoffHint(completed, 'codex', 'Codex', {
      running: true,
      preparing: false,
    })).toBeNull();
    expect(conversationHandoffHint(completed, 'codex', 'Codex', {
      running: false,
      preparing: true,
    })).toBeNull();
  });

  it('ignores visible messages from every non-completed turn state', () => {
    const nonCompletedStates: ConversationTurnState[] = [
      'queued',
      'paused',
      'active',
      'cancelRequested',
      'cancelled',
      'failed',
      'interrupted',
    ];
    for (const state of nonCompletedStates) {
      expect(conversationHandoffHint(conversationWithTurn(state), 'codex', 'Codex')).toBeNull();
    }
  });

  it('fails closed when a completed turn has no visible projected history', () => {
    const conversation = conversationWithTurn('completed');
    conversation.messages = conversation.messages.map(message => ({ ...message, content: '   ' }));

    expect(conversationHandoffHint(conversation, 'codex', 'Codex')).toBeNull();
  });

  it('defaults Claude and Codex to restricted access while preserving explicit grants', () => {
    expect(normalizeFullAccessByAgent(undefined)).toEqual({
      claude: false,
      codex: false,
      pi: false,
      antigravity: false,
    });
    expect(normalizeFullAccessByAgent({ claude: true, codex: true })).toEqual({
      claude: true,
      codex: true,
      pi: false,
      antigravity: false,
    });
  });

  it('invalidates a Claude session when full-access mode changes', () => {
    const before = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'sonnet',
      fullAccess: false,
    });
    const after = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'sonnet',
      fullAccess: true,
    });

    expect(shouldResumeClaudeSession('session-1', before, after)).toBe(false);
  });

  it('binds Pi session continuation to the exact runtime shape', () => {
    const key = buildPiSessionConfigKey({
      fullAccess: false,
      model: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high',
      customizationMode: 'user',
    });
    expect(shouldResumePiSession('pi-session', key, key)).toBe(true);
    const fullAccessKey = buildPiSessionConfigKey({
      fullAccess: true,
      model: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high',
      customizationMode: 'user',
    });
    expect(shouldResumePiSession('pi-session', key, fullAccessKey)).toBe(false);
    const otherModelKey = buildPiSessionConfigKey({
      fullAccess: false,
      model: 'deepseek/deepseek-v4-pro',
      thinkingLevel: 'high',
      customizationMode: 'user',
    });
    expect(shouldResumePiSession('pi-session', key, otherModelKey)).toBe(false);
    const otherModeKey = buildPiSessionConfigKey({
      fullAccess: false,
      model: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high',
      customizationMode: 'trustedVault',
    });
    expect(shouldResumePiSession('pi-session', key, otherModeKey)).toBe(false);
  });

  it('binds a Pi plan turn to the restricted key without touching stored trust', () => {
    const fullKey = buildPiSessionConfigKey({
      fullAccess: true,
      model: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high',
      customizationMode: 'user',
    });
    // chatView collapses planModeAtSend into the key's access level.
    const planKey = buildPiSessionConfigKey({
      fullAccess: false,
      model: 'deepseek/deepseek-v4-flash',
      thinkingLevel: 'high',
      customizationMode: 'user',
    });
    expect(fullKey).not.toBe(planKey);
    // The stored preference itself is never rewritten by a plan turn: the key
    // is derived per send, and settings.fullAccessByAgent.pi stays untouched.
  });

  it('never resumes Pi from an unbound or mismatched legacy session', () => {
    const key = buildPiSessionConfigKey({
      fullAccess: false,
      model: '',
      thinkingLevel: '',
      customizationMode: 'user',
    });
    expect(shouldResumePiSession(undefined, undefined, key)).toBe(false);
    expect(shouldResumePiSession('pi-session', undefined, key)).toBe(false);
    expect(shouldResumePiSession('pi-session', 'legacy', key)).toBe(false);
  });

  it('never resumes Codex across an access-mode change or from an unbound legacy session', () => {
    const restricted = buildCodexSessionConfigKey({ fullAccess: false });
    const full = buildCodexSessionConfigKey({ fullAccess: true });

    expect(shouldResumeCodexSession('session-1', restricted, restricted)).toBe(true);
    expect(shouldResumeCodexSession('session-1', full, restricted)).toBe(false);
    expect(shouldResumeCodexSession('session-1', undefined, restricted)).toBe(false);
  });

  it('invalidates Claude sessions when a provider profile is edited', () => {
    const before = buildClaudeSessionConfigKey({
      configSource: 'providerProfile',
      effectiveModel: 'deepseek-v4-flash',
      providerProfileId: 'deepseek',
      providerProfileUpdatedAt: 100,
    });
    const after = buildClaudeSessionConfigKey({
      configSource: 'providerProfile',
      effectiveModel: 'deepseek-v4-flash',
      providerProfileId: 'deepseek',
      providerProfileUpdatedAt: 101,
    });

    expect(shouldResumeClaudeSession('session-1', before, after)).toBe(false);
    expect(before).not.toContain('api-key');
  });

  it('invalidates Claude sessions when the local gateway route changes', () => {
    const before = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'sonnet[1m]',
      localRouteFingerprint: 'cc-switch:qwen-before',
    });
    const after = buildClaudeSessionConfigKey({
      configSource: 'localCli',
      effectiveModel: 'sonnet[1m]',
      localRouteFingerprint: 'cc-switch:qwen-after',
    });

    expect(shouldResumeClaudeSession('session-1', before, after)).toBe(false);
  });

  it('invalidates Claude sessions when the current CC Switch provider changes', () => {
    const before = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: 'glm-4.7',
      ccSwitchProviderId: 'provider-before',
    });
    const after = buildClaudeSessionConfigKey({
      configSource: 'ccSwitchCurrent',
      effectiveModel: 'glm-4.7',
      ccSwitchProviderId: 'provider-after',
    });

    expect(shouldResumeClaudeSession('session-1', before, after)).toBe(false);
    expect(before).not.toContain('api-key');
  });
});
