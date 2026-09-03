import type { AgentDescriptor, AgentId } from './types';

export const SELECTABLE_AGENT_IDS = ['claude', 'codex', 'pi'] as const;
export type SelectableAgentId = typeof SELECTABLE_AGENT_IDS[number];

export const AGENT_DESCRIPTORS: Record<SelectableAgentId, AgentDescriptor> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    shortName: 'Claude',
    packageName: '@anthropic-ai/claude-code',
    binaryName: 'claude',
    bestFor: 'Long-form vault work, edits, and agentic note workflows.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: true,
    docsUrl: 'https://code.claude.com/',
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    shortName: 'Codex',
    packageName: '@openai/codex',
    binaryName: 'codex',
    bestFor: 'Structured coding-agent turns with JSON event streaming.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: false,
    docsUrl: 'https://github.com/openai/codex',
  },
  pi: {
    id: 'pi',
    displayName: 'Pi',
    shortName: 'Pi',
    packageName: '@earendil-works/pi-coding-agent',
    binaryName: 'pi',
    bestFor: 'Local Pi agent turns with explicit skill and permission control.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: false,
    docsUrl: 'https://pi.dev/docs/latest/quickstart',
  },
};

export const AGENT_IDS: readonly SelectableAgentId[] = SELECTABLE_AGENT_IDS;

export function getAgentDescriptor(agentId: AgentId): AgentDescriptor {
  const descriptor = AGENT_DESCRIPTORS[agentId];
  if (!descriptor) throw new Error('Unsupported agent.');
  return descriptor;
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_IDS.includes(value as SelectableAgentId);
}

export function normalizeSelectableAgentId(value: unknown): SelectableAgentId {
  return value === 'codex' || value === 'pi' ? value : 'claude';
}
