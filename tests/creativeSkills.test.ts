import { describe, expect, test } from 'vitest';

import { filterCreativeSkills } from '../src/skill/creativeSkills';
import type { LocalSkill } from '../src/skill/skillDiscovery';

function localSkill(name: string): LocalSkill {
  return {
    name,
    description: `${name} description`,
    directory: `/skills/${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    source: 'shared',
    sourceLabel: '共享',
    agentId: 'codex',
  };
}

describe('creative Skill catalog', () => {
  test('shows only names explicitly selected from local discovery', () => {
    const skills = [
      localSkill('github:github'),
      localSkill('tutorial-writing'),
      localSkill('codex-security:security-scan'),
      localSkill('content-helper'),
    ];

    expect(filterCreativeSkills(skills, ['tutorial-writing', 'CONTENT-HELPER']).map(skill => skill.name)).toEqual([
      'tutorial-writing',
      'content-helper',
    ]);
  });
});
