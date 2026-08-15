import { createHash } from 'crypto';

export interface PublishingSourceIdentity {
  revision: number;
  filePath: string;
  snapshotContentHash: string;
  themeContentHash: string;
  renderedHtml: string;
  preparedContentHash: string;
  preflightIntegrityHash: string;
}

export interface PublishingDestinationIdentity {
  transport: 'localRelay';
  relayUrl: string;
  relayOrigin: string;
  relayHost: string;
  appId: string;
  relayTokenFingerprint: string;
}

export function normalizeSecureRelayToken(value: string): string {
  const relayToken = value.trim();
  if (!relayToken) throw new Error('请先在草稿设置中填写中转 Token');
  if (!/^[A-Za-z0-9._~+/=-]+$/u.test(relayToken)) {
    throw new Error('公众号中转 Token 只能包含可安全放入 Bearer 请求头的 ASCII 字符');
  }
  const minimumLength = /^[0-9a-f]+$/iu.test(relayToken) ? 64 : 43;
  if (relayToken.length < minimumLength || relayToken.length > 512) {
    throw new Error('公众号中转 Token 必须由至少 32 个随机字节生成（Base64/Base64URL 至少 43 字符，十六进制至少 64 字符）');
  }
  return relayToken;
}

export function normalizeSecureRelayUrl(value: string): {
  relayUrl: string;
  relayOrigin: string;
  relayHost: string;
} {
  const relayUrl = value.trim().replace(/\/+$/g, '');
  if (!relayUrl) throw new Error('请先在草稿设置中填写中转地址');
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('公众号中转地址无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('公众号中转地址仅支持 HTTP 或 HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('公众号中转地址不能包含账号密码、查询参数或片段');
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw new Error('公网公众号中转地址必须使用 HTTPS；HTTP 仅限本机回环地址');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
  const normalizedRelayUrl = `${parsed.origin}${normalizedPath === '/' ? '' : normalizedPath}`;
  return {
    relayUrl: normalizedRelayUrl,
    relayOrigin: parsed.origin,
    relayHost: `${parsed.host}${normalizedPath === '/' ? '' : normalizedPath}`,
  };
}

export function createPublishingDestinationIdentity(input: {
  relayUrl: string;
  appId: string;
  relayToken: string;
}): PublishingDestinationIdentity {
  const relayToken = normalizeSecureRelayToken(input.relayToken);
  const destination = normalizeSecureRelayUrl(input.relayUrl);
  return {
    transport: 'localRelay',
    ...destination,
    appId: input.appId.trim(),
    relayTokenFingerprint: createHash('sha256').update(relayToken).digest('hex'),
  };
}

export function maskedPublishingAppId(appId: string): string {
  const normalized = appId.trim();
  if (!normalized) return '未设置';
  if (normalized.length <= 6) return `${normalized.slice(0, 1)}•••${normalized.slice(-1)}`;
  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

export function isCurrentPublishingSource(
  capturedRevision: number,
  capturedFilePath: string,
  currentRevision: number,
  currentFilePath: string,
): boolean {
  return capturedRevision === currentRevision && capturedFilePath === currentFilePath;
}

export function assertPublishingSourceUnchanged(
  captured: PublishingSourceIdentity,
  current: PublishingSourceIdentity | null,
): void {
  const unchanged = current !== null
    && captured.revision === current.revision
    && captured.filePath === current.filePath
    && captured.snapshotContentHash === current.snapshotContentHash
    && captured.themeContentHash === current.themeContentHash
    && captured.renderedHtml === current.renderedHtml
    && captured.preparedContentHash === current.preparedContentHash
    && captured.preflightIntegrityHash === current.preflightIntegrityHash;
  if (!unchanged) {
    throw new Error('文章或排版在确认期间已变化，请重新检查并确认');
  }
}

export function assertPublishingDestinationUnchanged(
  captured: PublishingDestinationIdentity,
  current: PublishingDestinationIdentity | null,
): void {
  const unchanged = current !== null
    && captured.transport === current.transport
    && captured.relayUrl === current.relayUrl
    && captured.relayOrigin === current.relayOrigin
    && captured.appId === current.appId
    && captured.relayTokenFingerprint === current.relayTokenFingerprint;
  if (!unchanged) {
    throw new Error('公众号目标或中转凭据在确认期间已变化，请重新确认');
  }
}
