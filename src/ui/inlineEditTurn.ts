import type { AgentId, ChatTurnRequest, AiluSettings } from '../types';
import { createId } from '../utils/id';

/**
 * Builds the runtime request for an inline edit. Pi runs the proposal as a
 * fully isolated text-only turn: no tools, no extensions, no shared Native
 * Session; the runtime neutralizes privilege fields for text-only turns.
 */
export function buildInlineEditTurnInput(input: {
  settings: AiluSettings;
  agentId: AgentId;
  prompt: string;
  cwd: string;
}): ChatTurnRequest {
  const { settings, agentId } = input;
  const piIsolated = agentId === 'pi';
  return {
    conversationId: createId('inline'),
    agentId,
    prompt: input.prompt,
    cwd: input.cwd,
    configSource: settings.configSources[agentId],
    providerProfileId: settings.providerProfileByAgent[agentId],
    model: settings.localModelByAgent[agentId],
    systemPrompt: settings.systemPrompt,
    planMode: false,
    // Pi proposals must not be able to touch the Vault; other Agents keep
    // their existing inline-edit behaviour.
    fullAccess: piIsolated ? false : settings.fullAccessByAgent[agentId],
    textOnly: piIsolated ? true : undefined,
    ...(piIsolated ? {
      piCustomizationMode: 'isolated',
      reasoningEffort: settings.reasoningEffortByAgent.pi || undefined,
    } : {}),
    attachments: [],
  };
}
