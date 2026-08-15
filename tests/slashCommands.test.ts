import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildSkillInvocationPrompt,
  filterSlashCommands,
  homeRelativeSkillPath,
} from '../src/utils/slashCommands';

describe('filterSlashCommands', () => {
  test('filters by label', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Alpha skill' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Beta skill' },
    ];
    expect(filterSlashCommands(commands, 'bet')).toHaveLength(1);
    expect(filterSlashCommands(commands, 'bet')[0]?.id).toBe('b');
  });

  test('filters by description', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Fetch pages' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Extract data' },
    ];
    expect(filterSlashCommands(commands, 'extract')).toHaveLength(1);
  });

  test('empty query returns all', () => {
    const commands = [
      { id: 'a', label: '/alpha', insertText: 'alpha', description: 'Alpha' },
      { id: 'b', label: '/beta', insertText: 'beta', description: 'Beta' },
    ];
    expect(filterSlashCommands(commands, '')).toHaveLength(2);
  });

  test('loads the selected Skill entrypoint instead of sending only its description', () => {
    const filePath = join(homedir(), '.agents', 'skills', 'writer', 'SKILL.md');
    const prompt = buildSkillInvocationPrompt({
      name: 'writer',
      description: 'Write a tutorial.',
      filePath,
    });
    expect(prompt).toContain('Skill entrypoint (home-relative): "~/.agents/skills/writer/SKILL.md"');
    expect(prompt).not.toContain(homedir());
    expect(prompt).toContain('read that SKILL.md completely');
    expect(prompt).toContain('Resolve relative references');
    expect(prompt).toContain('user and system instructions take precedence');
    expect(prompt).toContain('do not ask for a duplicate confirmation');
    expect(prompt).toContain("user's current request is the authorization");
  });

  test('rejects a Skill entrypoint outside the user home instead of disclosing it', () => {
    expect(() => homeRelativeSkillPath('/private/tmp/foreign/SKILL.md', '/Users/example'))
      .toThrow('Skill entrypoint must be contained within the user home directory');
  });
});
