import {
  canonicalizeStoredAgentSettings,
  normalizeAgentSettings,
} from '../src/settings/agentSettings';
import type { AiluSettings } from '../src/types';

describe('canonical agent settings', () => {
  test('keeps only Claude and Codex while preserving their current values', () => {
    const imported = {
      defaultAgentId: 'retired-agent',
      configSources: {
        claude: 'ccSwitchCurrent',
        codex: 'localCli',
        retiredAgent: 'localCli',
      },
      configuredPaths: {
        claude: '/usr/local/bin/claude',
        codex: '/usr/local/bin/codex',
        retiredAgent: '/usr/local/bin/retired',
      },
      providerProfileByAgent: {
        claude: 'claude-profile',
        codex: 'codex-profile',
        retiredAgent: 'retired-profile',
      },
      localModelByAgent: {
        claude: 'sonnet',
        codex: 'gpt-5.6',
        retiredAgent: 'retired-model',
      },
      reasoningEffortByAgent: {
        claude: 'high',
        codex: 'max',
        retiredAgent: 'medium',
      },
      fullAccessByAgent: {
        claude: false,
        codex: true,
        retiredAgent: false,
      },
      creativeSkillNames: ['tutorial-writing', ' content-helper ', 'tutorial-writing'],
    } as unknown as Partial<AiluSettings>;

    const normalized = normalizeAgentSettings(imported);

    expect(normalized.defaultAgentId).toBe('claude');
    for (const value of [
      normalized.configSources,
      normalized.configuredPaths,
      normalized.providerProfileByAgent,
      normalized.localModelByAgent,
      normalized.reasoningEffortByAgent,
      normalized.fullAccessByAgent,
    ]) {
      expect(Object.keys(value)).toEqual(['claude', 'codex']);
    }
    expect(normalized).toMatchObject({
      configSources: { claude: 'ccSwitchCurrent', codex: 'localCli' },
      configuredPaths: {
        claude: '/usr/local/bin/claude',
        codex: '/usr/local/bin/codex',
      },
      providerProfileByAgent: { claude: 'claude-profile', codex: 'codex-profile' },
      localModelByAgent: { claude: 'sonnet', codex: 'gpt-5.6' },
      reasoningEffortByAgent: { claude: 'high', codex: 'max' },
      fullAccessByAgent: { claude: false, codex: true },
      creativeSkillNames: ['tutorial-writing', 'content-helper'],
    });
  });

  test('canonicalizes only agent maps and preserves unrelated stored settings', () => {
    const stored = {
      schemaVersion: 1,
      configSources: { claude: 'localCli', codex: 'localCli', retiredAgent: 'localCli' },
      configuredPaths: { claude: '', codex: '', retiredAgent: '' },
      providerProfileByAgent: { claude: '', codex: '', retiredAgent: '' },
      localModelByAgent: { claude: '', codex: '', retiredAgent: '' },
      reasoningEffortByAgent: { claude: '', codex: '', retiredAgent: '' },
      fullAccessByAgent: { claude: true, codex: true, retiredAgent: false },
      creativeSkillNames: ['local-selected-skill'],
      sharedEnvironmentVariables: 'API_TOKEN=must-not-remain-in-data-json',
      publishing: {
        themeId: 'paper-ink',
        retiredFeatureFlag: true,
        retiredFeatureAgent: 'claude',
      },
      unknownTopLevel: { keep: true },
    };
    const normalized = normalizeAgentSettings(stored as unknown as Partial<AiluSettings>);

    const canonical = canonicalizeStoredAgentSettings(stored, normalized);

    expect(canonical.publishing).toEqual(stored.publishing);
    expect(canonical.unknownTopLevel).toEqual(stored.unknownTopLevel);
    expect(canonical).not.toHaveProperty('sharedEnvironmentVariables');
    expect(canonical.creativeSkillNames).toEqual(['local-selected-skill']);
    for (const key of [
      'configSources',
      'configuredPaths',
      'providerProfileByAgent',
      'localModelByAgent',
      'reasoningEffortByAgent',
      'fullAccessByAgent',
    ] as const) {
      expect(Object.keys(canonical[key] as Record<string, unknown>)).toEqual(['claude', 'codex']);
    }
  });

  test('defaults new installs to restricted access while preserving explicit grants', () => {
    expect(normalizeAgentSettings(null).fullAccessByAgent).toEqual({
      claude: false,
      codex: false,
    });
    expect(normalizeAgentSettings({
      fullAccessByAgent: { claude: true, codex: true },
    }).fullAccessByAgent).toEqual({
      claude: true,
      codex: true,
    });
  });
});
