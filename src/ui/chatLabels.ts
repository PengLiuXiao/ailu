import type { MessageRole } from '../types';

const REASONING_EFFORT_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极高',
  ultra: 'Ultra（自动委派）',
};

export function reasoningEffortLabel(effort: string): string {
  return effort ? REASONING_EFFORT_LABELS[effort] ?? effort : '自动';
}

export function chatMessageRoleLabel(role: MessageRole, assistantDisplayName: string): string | null {
  if (role === 'user') return null;
  return role === 'assistant' ? assistantDisplayName : role;
}

export function compactModelButtonLabel(label: string): string {
  const primaryLabel = label.trim().split(/\s+·\s+/, 1)[0] ?? '';
  const claudeModel = primaryLabel.replace(/^claude[-_\s]+/i, '');
  if (claudeModel === primaryLabel) return primaryLabel;
  if (/^fable[-_\s]*5$/i.test(claudeModel)) return 'Fable5';

  const compactName = claudeModel
    .replace(/(\d)-(?=\d)/g, '$1.')
    .replace(/[-_]+/g, ' ')
    .trim();
  return compactName.replace(/^[a-z]/, character => character.toUpperCase());
}
