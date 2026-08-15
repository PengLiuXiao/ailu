import { describe, expect, test } from 'vitest';

import { parseSkillFrontmatter } from '../src/skill/skillParser';

describe('parseSkillFrontmatter', () => {
  test('parses name and quoted description', () => {
    const text = '---\nname: browser-act\ndescription: "Browser automation CLI"\n---\n\nbody';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'browser-act', description: 'Browser automation CLI' });
  });

  test('parses unquoted single-line values', () => {
    const text = '---\nname: my-skill\ndescription: Do a thing\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'my-skill', description: 'Do a thing' });
  });

  test('uses fallback name when name is missing', () => {
    const text = '---\ndescription: No name here\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toEqual({ name: 'fallback', description: 'No name here' });
  });

  test('returns null when no frontmatter', () => {
    const text = 'No frontmatter here';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result).toBeNull();
  });

  test('parses multi-line quoted description', () => {
    const text = '---\nname: long-skill\ndescription: "Line one\nLine two"\nallowed-tools: Bash(*)\n---\n';
    const result = parseSkillFrontmatter(text, 'fallback');
    expect(result?.name).toBe('long-skill');
    expect(result?.description).toBe('Line one\nLine two');
  });

  test('parses literal block descriptions used by installed skills', () => {
    const text = [
      '---',
      'name: tutorial-writing',
      'description: |',
      '  Write practical tutorials.',
      '  Keep each step verifiable.',
      'allowed-tools: Bash(*)',
      '---',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(text, 'fallback')).toEqual({
      name: 'tutorial-writing',
      description: 'Write practical tutorials.\nKeep each step verifiable.',
    });
  });

  test('folds block descriptions without exposing the YAML marker', () => {
    const text = [
      '---',
      'name: concise-writing',
      'description: >-',
      '  Write concise copy.',
      '  Preserve the meaning.',
      '  Keep the result readable.',
      '',
      '  Start a new paragraph after a blank line.',
      '---',
      '',
    ].join('\n');
    expect(parseSkillFrontmatter(text, 'fallback')?.description)
      .toBe([
        'Write concise copy. Preserve the meaning. Keep the result readable.',
        'Start a new paragraph after a blank line.',
      ].join('\n\n'));
  });
});
