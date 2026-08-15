import type { AgentId, AnthropicAuthMode, ProviderProfile } from '../types';

const LOOPBACK_PROVIDER_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validates a provider base URL before it can be persisted, probed, or passed
 * to a child process. Remote credentials must never travel over plaintext
 * HTTP, and URL-owned credentials/query parameters are intentionally rejected
 * so secrets have one auditable home in SecretStorage.
 */
export function normalizeProviderBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim();
  if (!value) return '';
  if ([...value].some(character => {
    const code = character.charCodeAt(0);
    return character === '\\' || code <= 0x1f || code === 0x7f;
  })) {
    throw new Error('API Base URL 不得包含反斜杠或控制字符。');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('API Base URL 格式无效。');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('API Base URL 只支持 HTTPS；本机回环服务可使用 HTTP。');
  }
  if (!parsed.hostname) {
    throw new Error('API Base URL 缺少主机名。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('API Base URL 不得包含账号或密码。');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('API Base URL 不得包含查询参数或片段。');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:' && !LOOPBACK_PROVIDER_HOSTS.has(host)) {
    throw new Error('API Base URL 必须使用 HTTPS；仅 localhost、127.0.0.1 和 [::1] 可使用 HTTP。');
  }

  // Rebuild from the WHATWG URL parser instead of returning the original
  // bytes. Different downstream clients disagree on how to interpret
  // backslashes and authority-like path fragments; one canonical spelling
  // keeps the host we validated identical to the host that receives secrets.
  const pathname = parsed.pathname.replace(/\/+$/u, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export function inferAnthropicAuthMode(
  agentId: AgentId,
  name: string,
  baseUrl: string,
  explicit?: AnthropicAuthMode,
): AnthropicAuthMode | undefined {
  if (agentId !== 'claude') return undefined;
  if (explicit === 'apiKey' || explicit === 'authToken') return explicit;

  try {
    if (new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com') {
      return 'apiKey';
    }
  } catch {
    if (name.trim().toLowerCase() === 'anthropic' || name.trim().toLowerCase() === 'claude') {
      return 'apiKey';
    }
  }
  return 'authToken';
}

export function resolveAnthropicAuthMode(profile: ProviderProfile): AnthropicAuthMode {
  return inferAnthropicAuthMode(
    profile.agentId,
    profile.name,
    profile.baseUrl,
    profile.anthropicAuthMode,
  ) ?? 'authToken';
}

export function buildProviderAuthHeaders(options: {
  agentId: AgentId;
  apiKey: string;
  anthropicAuthMode?: AnthropicAuthMode;
}): Record<string, string> {
  if (options.agentId !== 'claude') {
    return options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  }

  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
  };
  if (!options.apiKey) {
    return headers;
  }
  if (options.anthropicAuthMode === 'apiKey') {
    headers['x-api-key'] = options.apiKey;
  } else {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  return headers;
}

export function requiresProviderApiKey(baseUrl: string): boolean {
  const value = normalizeProviderBaseUrl(baseUrl);
  if (!value) return true;
  const hostname = new URL(value).hostname.toLowerCase();
  return !LOOPBACK_PROVIDER_HOSTS.has(hostname);
}

export function providerHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
}
