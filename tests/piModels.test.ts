import { describe, expect, test } from 'vitest';

import type { PiModelDescriptor, PiRuntimeStatus } from '../src/types';
import {
  findPiModel,
  orderPiThinkingLevels,
  parsePiModelsResponse,
  parsePiStateCurrentModelKey,
  parsePiStateSessionId,
  piFollowLocalLabel,
  piModelKey,
  reconcilePiThinkingLevel,
  resolvePiAttachmentPreflight,
  resolvePiSendModelGuard,
} from '../src/runtime/piModels';

const deepseekFlash = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  reasoning: true,
  input: ['text'],
  thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
};

const deepseekVision = {
  ...deepseekFlash,
  id: 'deepseek-v4-flash-vision-exp',
  name: 'DeepSeek V4 Flash Vision (Exp)',
  input: ['text', 'image'],
};

const plainModel = {
  id: 'plain-model',
  name: 'Plain Model',
  provider: 'other',
  reasoning: false,
  input: ['text'],
};

const models = parsePiModelsResponse({
  models: [deepseekFlash, deepseekVision, plainModel, { id: 'broken' }],
});

describe('parsePiModelsResponse', () => {
  test('parses providers, modalities, and supported thinking levels', () => {
    expect(models).toHaveLength(3);
    const flash = findPiModel(models, 'deepseek/deepseek-v4-flash');
    expect(flash?.name).toBe('DeepSeek V4 Flash');
    expect(flash?.thinkingLevels).toEqual(['low', 'high', 'max']);
    expect(flash?.inputModalities).toEqual(['text']);
    const vision = findPiModel(models, 'deepseek/deepseek-v4-flash-vision-exp');
    expect(vision?.inputModalities).toEqual(['text', 'image']);
  });

  test('drops entries without a provider and deduplicates keys', () => {
    expect(models.some(model => model.id === 'broken')).toBe(false);
    expect(models.filter(model => piModelKey(model) === 'deepseek/deepseek-v4-flash'))
      .toHaveLength(1);
  });

  test('models without a thinking map get an empty level list', () => {
    expect(findPiModel(models, 'other/plain-model')?.thinkingLevels).toEqual([]);
  });

  test('state parsing reads the session id and the local default model key', () => {
    expect(parsePiStateSessionId({ sessionId: ' s-1 ' })).toBe('s-1');
    expect(parsePiStateSessionId({ sessionId: '' })).toBeNull();
    expect(parsePiStateCurrentModelKey({ model: deepseekFlash })).toBe('deepseek/deepseek-v4-flash');
    expect(parsePiStateCurrentModelKey({ model: null })).toBeNull();
  });
});

describe('findPiModel', () => {
  test('matches exact provider/id keys', () => {
    expect(findPiModel(models, ' deepseek/deepseek-v4-flash ')?.id).toBe('deepseek-v4-flash');
  });

  test('matches a bare id only when unique', () => {
    expect(findPiModel(models, 'plain-model')?.id).toBe('plain-model');
    expect(findPiModel([], 'plain-model')).toBeNull();
  });

  test('returns null for empty selection', () => {
    expect(findPiModel(models, '')).toBeNull();
  });
});

describe('thinking levels', () => {
  test('orders canonical levels and sorts unknown ones last', () => {
    expect(orderPiThinkingLevels(['max', 'low', 'high'])).toEqual(['low', 'high', 'max']);
    expect(orderPiThinkingLevels(['zzz', 'high', 'alpha'])).toEqual(['high', 'alpha', 'zzz']);
  });

  test('reconcile keeps a supported level and drops an unsupported one', () => {
    const flash = findPiModel(models, 'deepseek/deepseek-v4-flash');
    expect(reconcilePiThinkingLevel(flash, 'high')).toBe('high');
    expect(reconcilePiThinkingLevel(flash, 'medium')).toBe('');
    expect(reconcilePiThinkingLevel(null, 'high')).toBe('');
    expect(reconcilePiThinkingLevel(flash, '')).toBe('');
  });
});

describe('piFollowLocalLabel', () => {
  test('describes the local default, pending, and failure states', () => {
    const ready: Pick<PiRuntimeStatus, 'state' | 'models' | 'currentModelId'> = {
      state: 'ready',
      models,
      currentModelId: 'deepseek/deepseek-v4-flash',
    };
    expect(piFollowLocalLabel(ready)).toBe('跟随本机：DeepSeek V4 Flash');
    expect(piFollowLocalLabel({ state: 'connecting', models: [], currentModelId: null }))
      .toBe('跟随本机（正在读取…）');
    expect(piFollowLocalLabel({ state: 'error', models: [], currentModelId: null }))
      .toBe('跟随本机（状态读取失败）');
    expect(piFollowLocalLabel({ state: 'idle', models: [], currentModelId: null }))
      .toBe('跟随本机');
  });
});

describe('resolvePiSendModelGuard', () => {
  const readyStatus: Pick<PiRuntimeStatus, 'state' | 'models' | 'currentModelId'> = {
    state: 'ready',
    models,
    currentModelId: 'deepseek/deepseek-v4-flash',
  };

  test('blocks an unavailable saved model with a recovery path', () => {
    const guard = resolvePiSendModelGuard({
      selectedModel: 'deepseek/removed-model',
      status: readyStatus,
    });
    expect(guard.blocked).toBe(true);
    expect(guard.message).toContain('跟随本机');
    expect(guard.message).toContain('deepseek/removed-model');
  });

  test('allows follow-local, verified models, and unverifiable states', () => {
    expect(resolvePiSendModelGuard({ selectedModel: '', status: readyStatus }).blocked).toBe(false);
    expect(resolvePiSendModelGuard({
      selectedModel: 'deepseek/deepseek-v4-flash',
      status: readyStatus,
    }).blocked).toBe(false);
    expect(resolvePiSendModelGuard({
      selectedModel: 'deepseek/deepseek-v4-flash',
      status: { state: 'idle', models: [], currentModelId: null },
    }).blocked).toBe(false);
    expect(resolvePiSendModelGuard({
      selectedModel: 'deepseek/deepseek-v4-flash',
      status: { state: 'error', models: [], currentModelId: null },
    }).blocked).toBe(false);
  });

  test('a bare saved id still resolves when uniquely available', () => {
    const guard = resolvePiSendModelGuard({ selectedModel: 'plain-model', status: readyStatus });
    expect(guard.blocked).toBe(false);
  });
});

describe('resolvePiAttachmentPreflight', () => {
  test('allows turns without attachments regardless of model', () => {
    expect(resolvePiAttachmentPreflight({ attachments: [], model: null }).blocked).toBe(false);
    expect(resolvePiAttachmentPreflight({ attachments: [], model: models[0] }).blocked).toBe(false);
  });

  test('allows image-capable models and blocks text-only models', () => {
    const vision = findPiModel(models, 'deepseek/deepseek-v4-flash-vision-exp');
    const textOnly = findPiModel(models, 'deepseek/deepseek-v4-flash');
    expect(resolvePiAttachmentPreflight({
      attachments: [{}],
      model: vision,
    }).blocked).toBe(false);
    const blocked = resolvePiAttachmentPreflight({ attachments: [{}], model: textOnly });
    expect(blocked.blocked).toBe(true);
    expect(blocked.message).toContain('移除图片附件');
    expect(blocked.message).toContain('模型');
  });

  test('blocks when the effective model cannot be verified', () => {
    const blocked = resolvePiAttachmentPreflight({ attachments: [{}], model: null });
    expect(blocked.blocked).toBe(true);
    expect(blocked.message).toContain('无法确认');
  });
});

describe('PiModelDescriptor persistence shape', () => {
  test('the stored override is a plain provider/id string', () => {
    const flash: PiModelDescriptor | null = findPiModel(models, 'deepseek/deepseek-v4-flash');
    expect(typeof piModelKey(flash as PiModelDescriptor)).toBe('string');
    expect(piModelKey(flash as PiModelDescriptor)).toBe('deepseek/deepseek-v4-flash');
  });
});
