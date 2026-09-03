import type { PiModelDescriptor, PiRuntimeStatus } from '../types';

/** Canonical Pi thinking-level order; unknown custom levels sort last. */
export const PI_THINKING_LEVEL_ORDER = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function piModelKey(model: Pick<PiModelDescriptor, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Derives the model's supported thinking levels from Pi's
 * `thinkingLevelMap`: keys map to provider-side level names and `null` means
 * the level is unavailable for that model.
 */
function thinkingLevelsFromMap(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const levels = new Set<string>();
  for (const [requested, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mapped === 'string' && mapped) levels.add(requested);
  }
  return orderPiThinkingLevels([...levels]);
}

export function orderPiThinkingLevels(levels: readonly string[]): string[] {
  return [...levels].sort((left, right) => {
    const leftIndex = PI_THINKING_LEVEL_ORDER.indexOf(left as never);
    const rightIndex = PI_THINKING_LEVEL_ORDER.indexOf(right as never);
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex;
    if (leftIndex >= 0) return -1;
    if (rightIndex >= 0) return 1;
    return left.localeCompare(right);
  });
}

export function parsePiModelDescriptor(value: unknown): PiModelDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = safeText(record.id).trim();
  const provider = safeText(record.provider).trim();
  if (!id || !provider) return null;
  return {
    id,
    provider,
    name: safeText(record.name).trim() || id,
    reasoning: record.reasoning === true,
    inputModalities: Array.isArray(record.input)
      ? record.input.filter((modality): modality is string => typeof modality === 'string')
      : [],
    thinkingLevels: thinkingLevelsFromMap(record.thinkingLevelMap),
  };
}

export function parsePiModelsResponse(data: unknown): PiModelDescriptor[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const parsed: PiModelDescriptor[] = [];
  for (const entry of models) {
    const descriptor = parsePiModelDescriptor(entry);
    if (descriptor && !parsed.some(model => piModelKey(model) === piModelKey(descriptor))) {
      parsed.push(descriptor);
    }
  }
  return parsed;
}

export function parsePiStateSessionId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const sessionId = safeText((data as Record<string, unknown>).sessionId).trim();
  return sessionId || null;
}

export function parsePiStateCurrentModelKey(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const model = (data as Record<string, unknown>).model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const key = piModelKey({
    provider: safeText((model as Record<string, unknown>).provider).trim(),
    id: safeText((model as Record<string, unknown>).id).trim(),
  });
  return key.includes('/') && !key.startsWith('/') ? key : null;
}

/** Matches `provider/id` keys and bare ids when they are unique. */
export function findPiModel(
  models: readonly PiModelDescriptor[],
  selected: string,
): PiModelDescriptor | null {
  const key = selected.trim();
  if (!key) return null;
  const exact = models.find(model => piModelKey(model) === key);
  if (exact) return exact;
  const bare = models.filter(model => model.id === key);
  return bare.length === 1 ? bare[0] : null;
}

export function reconcilePiThinkingLevel(
  model: PiModelDescriptor | null,
  selected: string,
): string {
  const level = selected.trim();
  if (!level) return '';
  if (!model || model.thinkingLevels.length === 0) return '';
  return model.thinkingLevels.includes(level) ? level : '';
}

export function piFollowLocalLabel(status: Pick<PiRuntimeStatus, 'state' | 'models' | 'currentModelId'>): string {
  if (status.state === 'ready' && status.currentModelId) {
    const model = findPiModel(status.models, status.currentModelId);
    return `跟随本机：${model?.name ?? status.currentModelId}`;
  }
  if (status.state === 'connecting') return '跟随本机（正在读取…）';
  if (status.state === 'error') return '跟随本机（状态读取失败）';
  return '跟随本机';
}

export function piModelSupportsImages(model: PiModelDescriptor | null): boolean {
  return model?.inputModalities.includes('image') ?? false;
}

export interface PiAttachmentPreflight {
  blocked: boolean;
  message?: string;
}

/**
 * Pi models that do not advertise image input must be blocked before the
 * process launches, with an explicit choice between switching models and
 * removing the attachment.
 */
export function resolvePiAttachmentPreflight(input: {
  attachments: readonly unknown[];
  model: PiModelDescriptor | null;
}): PiAttachmentPreflight {
  if (input.attachments.length === 0) return { blocked: false };
  if (input.model === null) {
    return {
      blocked: true,
      message: '无法确认当前 Pi 模型是否支持图片输入。请在模型选择器中选择模型（或重新读取模型列表），或移除图片附件后再发送。',
    };
  }
  if (!piModelSupportsImages(input.model)) {
    return {
      blocked: true,
      message: `所选 Pi 模型 ${input.model.name} 不支持图片输入。请在模型选择器改用带“支持图片”标记的模型，或移除图片附件后再发送。`,
    };
  }
  return { blocked: false };
}

export interface PiSendModelGuard {
  blocked: boolean;
  message?: string;
}

/**
 * A saved Pi model that the ready runtime no longer offers must block the
 * send instead of silently switching, with an explicit path back to
 * follow-local or a replacement choice.
 */
export function resolvePiSendModelGuard(input: {
  selectedModel: string;
  status: Pick<PiRuntimeStatus, 'state' | 'models' | 'currentModelId'>;
}): PiSendModelGuard {
  const selected = input.selectedModel.trim();
  if (!selected) return { blocked: false };
  if (input.status.state !== 'ready') return { blocked: false };
  if (findPiModel(input.status.models, selected)) return { blocked: false };
  return {
    blocked: true,
    message: `所选 Pi 模型 ${selected} 当前不可用。请在模型选择器中改回“跟随本机”，或重新选择可用模型。`,
  };
}
