import { describe, expect, test } from 'vitest';

import {
  reconcileClaudeReasoningEffort,
  resolveClaudeReasoningCapability,
} from '../src/runtime/reasoningCapabilities';

describe('Claude reasoning capabilities', () => {
  test('exposes only the effective DeepSeek V4 effort levels', () => {
    const capability = resolveClaudeReasoningCapability({
      configSource: 'ccSwitchCurrent',
      cliModel: 'sonnet',
      routedModel: 'deepseek-v4-flash',
    });

    expect(capability.source).toBe('deepseek-v4');
    expect(capability.supportedEfforts).toEqual(['high', 'max']);
    expect(capability.autoNote).toContain('Claude Code');
  });

  test('uses the documented Claude model levels intersected with the CLI', () => {
    expect(resolveClaudeReasoningCapability({
      configSource: 'ccSwitchCurrent',
      routedModel: 'claude-opus-4-5-20251101',
    }).supportedEfforts).toEqual(['low', 'medium', 'high']);
    expect(resolveClaudeReasoningCapability({
      configSource: 'providerProfile',
      routedModel: 'claude-sonnet-4-6',
    }).supportedEfforts).toEqual(['low', 'medium', 'high', 'max']);
  });

  test('keeps unknown compatible providers on automatic', () => {
    const capability = resolveClaudeReasoningCapability({
      configSource: 'ccSwitchCurrent',
      routedModel: 'qwen3.8-max-preview',
    });

    expect(capability.source).toBe('unknown');
    expect(capability.supportedEfforts).toEqual([]);
    expect(reconcileClaudeReasoningEffort(capability, 'max')).toBe('');
  });

  test('clears a stale level when the newly selected model does not support it', () => {
    const deepSeek = resolveClaudeReasoningCapability({
      configSource: 'ccSwitchCurrent',
      routedModel: 'deepseek-v4-pro',
    });

    expect(reconcileClaudeReasoningEffort(deepSeek, 'medium')).toBe('');
    expect(reconcileClaudeReasoningEffort(deepSeek, 'high')).toBe('high');
    expect(reconcileClaudeReasoningEffort(deepSeek, 'max')).toBe('max');
  });

  test('retains the Claude CLI levels when the local upstream model is unknown', () => {
    const capability = resolveClaudeReasoningCapability({
      configSource: 'localCli',
      cliModel: 'custom-local-alias',
    });

    expect(capability.source).toBe('claude-cli');
    expect(capability.supportedEfforts).toEqual(['low', 'medium', 'high', 'max']);
  });
});
