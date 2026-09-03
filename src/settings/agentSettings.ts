import { normalizeSelectableAgentId } from '../agents';
import {
  DEFAULT_SETTINGS,
  normalizeFullAccessByAgent,
  type AiluSettings,
} from '../types';

export type CanonicalAgentSettings = Pick<
  AiluSettings,
  | 'defaultAgentId'
  | 'configSources'
  | 'configuredPaths'
  | 'providerProfileByAgent'
  | 'localModelByAgent'
  | 'reasoningEffortByAgent'
  | 'fullAccessByAgent'
  | 'creativeSkillNames'
>;

/** Rebuilds every per-agent map so retired or unknown keys are never persisted again. */
export function normalizeAgentSettings(
  value: Partial<AiluSettings> | null | undefined,
): CanonicalAgentSettings {
  const claudeConfigSource = value?.configSources?.claude;
  return {
    defaultAgentId: normalizeSelectableAgentId(value?.defaultAgentId),
    configSources: {
      claude: claudeConfigSource === 'providerProfile' || claudeConfigSource === 'ccSwitchCurrent'
        ? claudeConfigSource
        : 'localCli',
      codex: 'localCli',
      pi: 'localCli',
    },
    configuredPaths: {
      claude: typeof value?.configuredPaths?.claude === 'string'
        ? value.configuredPaths.claude
        : DEFAULT_SETTINGS.configuredPaths.claude,
      codex: typeof value?.configuredPaths?.codex === 'string'
        ? value.configuredPaths.codex
        : DEFAULT_SETTINGS.configuredPaths.codex,
      pi: typeof value?.configuredPaths?.pi === 'string'
        ? value.configuredPaths.pi
        : DEFAULT_SETTINGS.configuredPaths.pi,
    },
    providerProfileByAgent: {
      claude: typeof value?.providerProfileByAgent?.claude === 'string'
        ? value.providerProfileByAgent.claude
        : DEFAULT_SETTINGS.providerProfileByAgent.claude,
      codex: typeof value?.providerProfileByAgent?.codex === 'string'
        ? value.providerProfileByAgent.codex
        : DEFAULT_SETTINGS.providerProfileByAgent.codex,
      pi: typeof value?.providerProfileByAgent?.pi === 'string'
        ? value.providerProfileByAgent.pi
        : DEFAULT_SETTINGS.providerProfileByAgent.pi,
    },
    localModelByAgent: {
      claude: typeof value?.localModelByAgent?.claude === 'string'
        ? value.localModelByAgent.claude
        : DEFAULT_SETTINGS.localModelByAgent.claude,
      codex: typeof value?.localModelByAgent?.codex === 'string'
        ? value.localModelByAgent.codex
        : DEFAULT_SETTINGS.localModelByAgent.codex,
      pi: typeof value?.localModelByAgent?.pi === 'string'
        ? value.localModelByAgent.pi
        : DEFAULT_SETTINGS.localModelByAgent.pi,
    },
    reasoningEffortByAgent: {
      claude: typeof value?.reasoningEffortByAgent?.claude === 'string'
        ? value.reasoningEffortByAgent.claude
        : DEFAULT_SETTINGS.reasoningEffortByAgent.claude,
      codex: typeof value?.reasoningEffortByAgent?.codex === 'string'
        ? value.reasoningEffortByAgent.codex
        : DEFAULT_SETTINGS.reasoningEffortByAgent.codex,
      pi: typeof value?.reasoningEffortByAgent?.pi === 'string'
        ? value.reasoningEffortByAgent.pi
        : DEFAULT_SETTINGS.reasoningEffortByAgent.pi,
    },
    fullAccessByAgent: normalizeFullAccessByAgent(value?.fullAccessByAgent),
    creativeSkillNames: normalizeSelectedSkillNames(value?.creativeSkillNames),
  };
}

/** Drops retired sensitive fields and unknown per-agent keys while preserving unrelated settings. */
export function canonicalizeStoredAgentSettings(
  value: Record<string, unknown>,
  normalized: CanonicalAgentSettings,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    ...value,
    defaultAgentId: normalized.defaultAgentId,
    configSources: normalized.configSources,
    configuredPaths: normalized.configuredPaths,
    providerProfileByAgent: normalized.providerProfileByAgent,
    localModelByAgent: normalized.localModelByAgent,
    reasoningEffortByAgent: normalized.reasoningEffortByAgent,
    fullAccessByAgent: normalized.fullAccessByAgent,
    creativeSkillNames: normalized.creativeSkillNames,
  };
  delete canonical.sharedEnvironmentVariables;
  return canonical;
}

function normalizeSelectedSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => Boolean(item) && item.length <= 200 && !hasControlCharacter(item)))]
    .slice(0, 256);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}
