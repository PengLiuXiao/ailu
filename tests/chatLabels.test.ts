import { describe, expect, test } from 'vitest';

import {
  chatMessageRoleLabel,
  compactModelButtonLabel,
  reasoningEffortLabel,
} from '../src/ui/chatLabels';

describe('chat UI labels', () => {
  test('uses compact reasoning labels', () => {
    expect(reasoningEffortLabel('')).toBe('自动');
    expect(reasoningEffortLabel('low')).toBe('低');
    expect(reasoningEffortLabel('ultra')).toBe('Ultra（自动委派）');
  });

  test('omits the redundant label above user messages', () => {
    expect(chatMessageRoleLabel('user', 'Claude Code')).toBeNull();
    expect(chatMessageRoleLabel('assistant', 'Claude Code')).toBe('Claude Code');
    expect(chatMessageRoleLabel('error', 'Claude Code')).toBe('error');
  });

  test('shortens toolbar model labels without changing unrelated model ids', () => {
    expect(compactModelButtonLabel('claude-fable5')).toBe('Fable5');
    expect(compactModelButtonLabel('claude-fable-5 · provider-id')).toBe('Fable5');
    expect(compactModelButtonLabel('claude-sonnet-4-5')).toBe('Sonnet 4.5');
    expect(compactModelButtonLabel('claude-fable5 · provider-id')).toBe('Fable5');
    expect(compactModelButtonLabel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });
});
