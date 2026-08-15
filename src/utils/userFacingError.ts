const HAN_CHARACTER = /[\u3400-\u9fff]/;
const TECHNICAL_ENGLISH = /[A-Za-z]{3,}(?:[\s._:/-]+[A-Za-z0-9]{2,})+/;

const DEFAULT_FALLBACK = '操作未完成，请稍后重试。';

export function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'string') return error.trim();
  if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
    return String(error);
  }
  if (typeof error === 'symbol') return error.description?.trim() ?? '';
  return '';
}

/**
 * Converts technical/runtime errors into concise Chinese copy for visible UI.
 * Raw details must stay in diagnostics and must not be rendered to the user.
 */
export function userFacingErrorMessage(
  error: unknown,
  fallback = DEFAULT_FALLBACK,
): string {
  return userFacingErrorText(rawErrorMessage(error), fallback);
}

export function userFacingErrorText(
  message: string | null | undefined,
  fallback = DEFAULT_FALLBACK,
): string {
  const raw = normalizeMessage(message);
  const safeFallback = normalizeFallback(fallback);
  if (!raw) return safeFallback;

  const translated = translateKnownError(raw);
  if (translated) return translated;

  const mixed = splitChinesePrefixFromTechnicalDetail(raw);
  if (mixed) {
    const detail = translateKnownError(mixed.detail)
      ?? (looksLikeTechnicalEnglish(mixed.detail) ? '详细原因无法识别，请查看本地诊断日志。' : mixed.detail);
    return `${mixed.prefix}${detail}`;
  }

  if (HAN_CHARACTER.test(raw)) {
    return looksLikeTechnicalEnglish(raw) ? safeFallback : raw;
  }
  if (looksLikeTechnicalEnglish(raw)) return safeFallback;
  return raw || safeFallback;
}

function translateKnownError(raw: string): string | null {
  const anchor = raw.match(/anchors\[(\d+)]\.anchor\s+must\s+be\s+a\s+non-empty\s+string/i);
  if (anchor) {
    return `X Article 上传前检查失败：第 ${Number(anchor[1]) + 1} 个图片定位点不能为空。请检查该图片前后是否有可用的正文。`;
  }

  const field = raw.match(/(?:^|[.:\s])([A-Za-z][A-Za-z0-9_.-]{1,80})\s+must\s+be\s+a\s+non-empty\s+string/i);
  if (field) return `输入数据不完整：字段“${field[1]}”不能为空。`;

  const imageBinding = raw.match(/(?:RuntimeError:\s*)?Image\s+(\d+)\s+could\s+not\s+be\s+bound\s+to\s+exactly\s+one\s+hosted\s+media\s+signature/i);
  if (imageBinding) return `X Article 图片校验失败：第 ${imageBinding[1]} 张图片无法唯一匹配到 X 托管媒体。草稿线索已保留，请先人工核对。`;

  const anchoredMedia = raw.match(/image\s+(\d+)\s*\/\s*(\d+)\s+anchor=.*?media=(\d+)/i);
  if (anchoredMedia) {
    return `X Article 图片校验失败：第 ${anchoredMedia[1]}/${anchoredMedia[2]} 张图片与 ${anchoredMedia[3]} 个已上传媒体的对应关系不唯一。草稿线索已保留，请先人工核对。`;
  }

  const weakAnchor = raw.match(/anchors\[(\d+)]\.anchor\s+is\s+too\s+weak/i);
  if (weakAnchor) {
    return `X Article 上传前检查失败：第 ${Number(weakAnchor[1]) + 1} 个图片定位文本过短或不唯一，请在图片前补充明确说明。`;
  }

  const bodyImage = raw.match(/X Article\s+.+?body image\s+(\d+)\s+did not persist/i);
  if (bodyImage) return `X Article 刷新回读失败：第 ${bodyImage[1]} 张正文图片没有稳定保存在原位置。`;

  if (/X Article preflight output was invalid/i.test(raw)) {
    return 'X Article 上传前检查返回了无法识别的数据，已停止创建草稿。';
  }
  if (/X Article preflight (?:was )?cancelled/i.test(raw)) return 'X Article 上传前检查已取消。';
  if (/X Article (?:operation|upload).*(?:was )?cancelled/i.test(raw)) return 'X Article 草稿操作已取消。';
  if (/X Article preflight timed out/i.test(raw)) return 'X Article 上传前检查超时，请稍后重试。';
  if (/X Article preflight output exceeded the safe limit/i.test(raw)) {
    return 'X Article 上传前检查输出过大，已为安全起见停止。';
  }
  if (/X Article preflight did not match the prepared Markdown/i.test(raw)) {
    return 'X Article 上传前检查结果与当前文章不一致，请刷新预览后重试。';
  }
  if (/X Article prepared Markdown (?:is missing or unreadable|changed after preflight)/i.test(raw)) {
    return 'X Article 准备稿已被移动、修改或无法读取，请重新检查后再上传。';
  }
  if (/X Article staged image (?:is missing or changed|hash changed after preflight)/i.test(raw)) {
    return 'X Article 待上传图片已被移动或修改，请重新检查。';
  }
  if (/X Article .*image could not be resolved locally/i.test(raw)) {
    return 'X Article 中的图片无法在当前 Vault 内找到，请检查图片链接。';
  }
  if (/X Article (?:script did not emit|script did not give).*success marker/i.test(raw)) {
    return 'X Article 上传脚本没有返回可验证的成功标记，已停止自动处理。';
  }

  if (/\b(?:AbortError|aborted|operation was cancelled|operation canceled)\b/i.test(raw)) return '操作已取消。';
  if (/\b(?:timed out|timeout)\b/i.test(raw)) return '操作超时，请稍后重试。';
  if (/\b(?:Failed to fetch|fetch failed|NetworkError|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)\b/i.test(raw)) {
    return '网络请求失败，请检查网络或本地代理后重试。';
  }
  if (/\b(?:EACCES|EPERM|permission denied|operation not permitted)\b/i.test(raw)) {
    return '没有访问所需文件或目录的权限。';
  }
  if (/\b(?:ENOENT|no such file or directory)\b/i.test(raw)) return '所需文件不存在或已被移动。';
  if (/(?:not valid JSON|invalid JSON|JSON parse|Unexpected token .* JSON)/i.test(raw)) {
    return '保存的数据格式异常，已停止操作以保护原数据。';
  }
  if (/Provider profile not found/i.test(raw)) return '没有找到对应的自定义供应商配置。';
  if (/Conversation .* was not found|No conversation found/i.test(raw)) return '没有找到对应的对话记录，已停止操作。';
  if (/Codex App Server .*timed out/i.test(raw)) return 'Codex 响应超时，请稍后重试。';
  if (/\bHTTP\s+401\b|unauthori[sz]ed|invalid api key|authentication failed/i.test(raw)) {
    return '身份验证失败，请检查账号授权或 API 密钥。';
  }
  if (/\bHTTP\s+403\b|forbidden/i.test(raw)) return '当前账号或应用没有执行此操作的权限。';
  if (/\bHTTP\s+429\b|rate limit|too many requests/i.test(raw)) return '请求过于频繁，请稍后重试。';
  if (/\bHTTP\s+5\d\d\b|internal server error|bad gateway|service unavailable/i.test(raw)) {
    return '远程服务暂时异常，请稍后重试。';
  }
  return null;
}

function splitChinesePrefixFromTechnicalDetail(raw: string): { prefix: string; detail: string } | null {
  const separators = Array.from(raw.matchAll(/[：:]/g));
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const separator = separators[index];
    const offset = separator.index ?? -1;
    if (offset < 0) continue;
    const prefix = raw.slice(0, offset + 1).trim();
    const detail = raw.slice(offset + 1).trim();
    if (HAN_CHARACTER.test(prefix) && detail && !HAN_CHARACTER.test(detail) && looksLikeTechnicalEnglish(detail)) {
      return { prefix, detail };
    }
  }
  return null;
}

function looksLikeTechnicalEnglish(value: string): boolean {
  return TECHNICAL_ENGLISH.test(value)
    || /\b(?:Error|Exception|RuntimeError|TypeError|ReferenceError|failed|invalid|missing|must|cannot|could not|not found)\b/i.test(value);
}

function normalizeMessage(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function normalizeFallback(value: string): string {
  const normalized = normalizeMessage(value);
  if (normalized && HAN_CHARACTER.test(normalized)) return normalized;
  return DEFAULT_FALLBACK;
}
