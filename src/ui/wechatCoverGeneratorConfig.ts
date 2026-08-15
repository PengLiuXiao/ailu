import type { CodexRuntimeStatus, AiluSettings } from '../types';
import { userFacingErrorText } from '../utils/userFacingError';

export function coverGeneratorConfigError(
  settings: AiluSettings,
  status: CodexRuntimeStatus,
): string | null {
  if (settings.configSources.codex !== 'localCli') {
    return 'Codex 当前不是本地 CLI 配置。请检查 Ailu 设置中的 Codex 配置源。';
  }
  if (status.imageGeneration === false) {
    return '当前 Codex 模型/配置不支持图片生成。';
  }
  if (status.imageGeneration !== true) {
    return status.error
      ? `无法确认 Codex 图片生成能力：${userFacingErrorText(status.error, 'Codex 暂时不可用。')}`
      : '无法确认 Codex 图片生成能力。';
  }
  return null;
}
