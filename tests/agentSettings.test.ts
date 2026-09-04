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
      ccSwitchModelByAgent: {
        claude: 'opus',
        codex: '',
        retiredAgent: 'haiku',
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
      normalized.ccSwitchModelByAgent,
      normalized.reasoningEffortByAgent,
      normalized.fullAccessByAgent,
    ]) {
      expect(Object.keys(value)).toEqual(['claude', 'codex', 'pi', 'antigravity']);
    }
    expect(normalized).toMatchObject({
      configSources: { claude: 'ccSwitchCurrent', codex: 'localCli' },
      configuredPaths: {
        claude: '/usr/local/bin/claude',
        codex: '/usr/local/bin/codex',
      },
      providerProfileByAgent: { claude: 'claude-profile', codex: 'codex-profile' },
      localModelByAgent: { claude: 'sonnet', codex: 'gpt-5.6' },
      ccSwitchModelByAgent: { claude: 'opus', codex: '' },
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
      ccSwitchModelByAgent: { claude: 'opus', codex: '', retiredAgent: 'haiku' },
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
      'ccSwitchModelByAgent',
      'reasoningEffortByAgent',
      'fullAccessByAgent',
    ] as const) {
      expect(Object.keys(canonical[key] as Record<string, unknown>)).toEqual(['claude', 'codex', 'pi', 'antigravity']);
    }
  });

  test('defaults new installs to restricted access while preserving explicit grants', () => {
    expect(normalizeAgentSettings(null).fullAccessByAgent).toEqual({
      claude: false,
      codex: false,
      pi: false,
      antigravity: false,
    });
    expect(normalizeAgentSettings({
      fullAccessByAgent: { claude: true, codex: true, pi: true, antigravity: true },
    }).fullAccessByAgent).toEqual({
      claude: true,
      codex: true,
      pi: true,
      antigravity: true,
    });
  });

  test('falls back to empty CC Switch models for illegal or missing values', () => {
    expect(normalizeAgentSettings(null).ccSwitchModelByAgent).toEqual({
      claude: '',
      codex: '',
      pi: '',
      antigravity: '',
    });
    expect(normalizeAgentSettings({
      ccSwitchModelByAgent: {
        claude: 42,
        codex: true,
        pi: null,
        antigravity: 'opus',
      } as unknown as AiluSettings['ccSwitchModelByAgent'],
    }).ccSwitchModelByAgent).toEqual({
      claude: '',
      codex: '',
      pi: '',
      antigravity: 'opus',
    });
  });
});
