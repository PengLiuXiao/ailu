import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { getSkillDirectories, loadLocalSkills } from '../src/skill/skillDiscovery';

const fixtureHome = fileURLToPath(new URL('fixtures/skill-home', import.meta.url));

describe('local Skill discovery', () => {
  test.each(['claude', 'codex'] as const)(
    'loads the shared union for %s',
    async agentId => {
      const skills = await loadLocalSkills(agentId, { homeDirectory: fixtureHome, useCache: false });
      expect(skills.map(skill => skill.name)).toEqual([
        'build-web-apps:frontend-testing',
        'duplicate-skill',
        'shared-writer',
        'system-one',
      ]);
      expect(skills.find(skill => skill.name === 'hidden-backup')).toBeUndefined();
      expect(skills.find(skill => skill.name === 'build-web-apps:frontend-testing')).toMatchObject({
        source: 'codex-plugin',
        sourceLabel: 'Codex 插件 · build-web-apps',
      });
    },
  );

  test('prefers the active Agent copy when names collide', async () => {
    const claudeSkills = await loadLocalSkills('claude', { homeDirectory: fixtureHome, useCache: false });
    const codexSkills = await loadLocalSkills('codex', { homeDirectory: fixtureHome, useCache: false });
    expect(claudeSkills.find(skill => skill.name === 'duplicate-skill')).toMatchObject({
      description: 'Claude copy.',
      source: 'claude',
    });
    expect(codexSkills.find(skill => skill.name === 'duplicate-skill')).toMatchObject({
      description: 'Shared copy.',
      source: 'shared',
    });
  });

  test.each(['claude', 'codex'] as const)('includes every supported local root for %s', agentId => {
    const directories = getSkillDirectories(agentId, fixtureHome);
    expect(directories).toEqual(expect.arrayContaining([
      `${fixtureHome}/.agents/skills`,
      `${fixtureHome}/.codex/skills`,
      `${fixtureHome}/.claude/skills`,
      `${fixtureHome}/.codex/plugins/cache`,
    ]));
  });
});
