import type { RuntimeConfigSource } from '../types';

export const CLAUDE_CLI_REASONING_EFFORT_ORDER = ['low', 'medium', 'high', 'max'] as const;

export type ClaudeReasoningEffort = typeof CLAUDE_CLI_REASONING_EFFORT_ORDER[number];

export interface ClaudeReasoningCapability {
  supportedEfforts: ClaudeReasoningEffort[];
  autoNote: string;
  source: 'claude-cli' | 'claude-model' | 'deepseek-v4' | 'unknown';
}

export interface ClaudeReasoningCapabilityInput {
  configSource: RuntimeConfigSource;
  /** Exact model passed to Claude Code, which may be a family alias such as `sonnet`. */
  cliModel?: string | null;
  /** Upstream model resolved through CC Switch or another compatible provider. */
  routedModel?: string | null;
}

const ALL_CLAUDE_CLI_EFFORTS = [...CLAUDE_CLI_REASONING_EFFORT_ORDER];
const CLAUDE_EFFORTS_WITHOUT_MAX: ClaudeReasoningEffort[] = ['low', 'medium', 'high'];
const DEEPSEEK_V4_EFFORTS: ClaudeReasoningEffort[] = ['high', 'max'];

function normalizedModel(input: ClaudeReasoningCapabilityInput): string {
  return (input.routedModel?.trim() || input.cliModel?.trim() || '').toLowerCase();
}

function isDeepSeekV4(model: string): boolean {
  return /^deepseek[-_]?v4[-_](?:flash|pro)(?:[-_:]|$)/i.test(model);
}

function isClaudeOpus45(model: string): boolean {
  return /^claude[-_]opus[-_]4[-_.]5(?:[-_:]|$)/i.test(model);
}

function isClaudeModelWithMaxEffort(model: string): boolean {
  return [
    /^claude[-_]opus[-_]4[-_.](?:6|7|8)(?:[-_:]|$)/i,
    /^claude[-_]sonnet[-_]4[-_.]6(?:[-_:]|$)/i,
    /^claude[-_](?:opus|sonnet|fable|mythos)[-_]5(?:[-_:]|$)/i,
    /^claude[-_]mythos[-_]preview(?:[-_:]|$)/i,
  ].some(pattern => pattern.test(model));
}

/**
 * Resolve the intersection between Claude Code's CLI flags and the selected
 * upstream model's documented effort levels. Unknown compatible providers
 * deliberately stay on automatic instead of receiving an unverified flag.
 */
export function resolveClaudeReasoningCapability(
  input: ClaudeReasoningCapabilityInput,
): ClaudeReasoningCapability {
  const model = normalizedModel(input);
  if (isDeepSeekV4(model)) {
    return {
      supportedEfforts: [...DEEPSEEK_V4_EFFORTS],
      autoNote: '模型普通请求默认高；Claude Code 等复杂 Agent 请求通常自动极高',
      source: 'deepseek-v4',
    };
  }
  if (isClaudeOpus45(model)) {
    return {
      supportedEfforts: [...CLAUDE_EFFORTS_WITHOUT_MAX],
      autoNote: '模型默认高',
      source: 'claude-model',
    };
  }
  if (isClaudeModelWithMaxEffort(model)) {
    return {
      supportedEfforts: [...ALL_CLAUDE_CLI_EFFORTS],
      autoNote: '模型默认高',
      source: 'claude-model',
    };
  }
  if (input.configSource === 'localCli') {
    return {
      supportedEfforts: [...ALL_CLAUDE_CLI_EFFORTS],
      autoNote: '跟随 Claude Code 当前模型',
      source: 'claude-cli',
    };
  }
  return {
    supportedEfforts: [],
    autoNote: '当前模型未公布可验证的强度档位，保持自动',
    source: 'unknown',
  };
}

export function reconcileClaudeReasoningEffort(
  capability: ClaudeReasoningCapability,
  selectedEffort: string | null | undefined,
): ClaudeReasoningEffort | '' {
  const selected = selectedEffort?.trim() ?? '';
  if (!selected) return '';
  return capability.supportedEfforts.includes(selected as ClaudeReasoningEffort)
    ? selected as ClaudeReasoningEffort
    : '';
}
