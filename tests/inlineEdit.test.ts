import { describe, expect, test } from 'vitest';

import { DEFAULT_SETTINGS } from '../src/types';
import { buildInlineEditTurnInput } from '../src/ui/inlineEditTurn';
import { buildPiTurnArgs, piSessionDir } from '../src/runtime/piRuntime';

describe('buildInlineEditTurnInput', () => {
  test('Pi proposals run fully isolated text-only turns', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      fullAccessByAgent: { ...DEFAULT_SETTINGS.fullAccessByAgent, pi: true },
      reasoningEffortByAgent: { ...DEFAULT_SETTINGS.reasoningEffortByAgent, pi: 'high' },
    };
    const request = buildInlineEditTurnInput({
      settings,
      agentId: 'pi',
      prompt: '改写这段文字',
      cwd: '/vault',
    });
    expect(request.textOnly).toBe(true);
    expect(request.fullAccess).toBe(false);
    expect(request.planMode).toBe(false);
    expect(request.attachments).toEqual([]);
    expect(request.piCustomizationMode).toBe('isolated');
    expect(request.sessionId).toBeUndefined();
    expect(request.reasoningEffort).toBe('high');
  });

  test('other Agents keep their existing inline-edit behaviour', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      fullAccessByAgent: { ...DEFAULT_SETTINGS.fullAccessByAgent, claude: true },
    };
    const request = buildInlineEditTurnInput({
      settings,
      agentId: 'claude',
      prompt: '改写这段文字',
      cwd: '/vault',
    });
    expect(request.textOnly).toBeUndefined();
    expect(request.fullAccess).toBe(true);
    expect(request.piCustomizationMode).toBeUndefined();
  });

  test('the isolated Pi spawn cannot reach tools, extensions, or a session', () => {
    const request = buildInlineEditTurnInput({
      settings: DEFAULT_SETTINGS,
      agentId: 'pi',
      prompt: '改写这段文字',
      cwd: '/vault',
    });
    const args = buildPiTurnArgs(request, piSessionDir({ AILU_HOME: '/ailu-home' }));
    expect(args).toContain('--no-session');
    expect(args).toContain('--no-tools');
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-skills');
    expect(args).not.toContain('--session-dir');
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('-e');
    expect(args).not.toContain('--skill');
  });
});
