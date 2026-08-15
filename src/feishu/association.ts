import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import type { FeishuPublishState } from './types';

export const FEISHU_ASSOCIATION_VERSION = 1 as const;

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface FeishuAssociationContext {
  vaultBasePath: string;
  sourcePath: string;
  accountOpenId: string;
}

export function normalizeFeishuDocumentId(value: string): string {
  const normalized = value.trim();
  if (!DOCUMENT_ID_PATTERN.test(normalized)) {
    throw new Error('飞书文档 ID 格式无效。');
  }
  return normalized;
}

export function canonicalizeFeishuDocumentUrl(value: string, documentId: string): string {
  const id = normalizeFeishuDocumentId(documentId);
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('飞书文档链接格式无效。');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:'
    || (parsed.port && parsed.port !== '443')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (hostname !== 'feishu.cn' && !hostname.endsWith('.feishu.cn'))) {
    throw new Error('飞书文档链接必须是无凭据、查询参数和片段的 HTTPS 飞书链接。');
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2
    || !['docx', 'docs'].includes(segments[0])
    || segments[1] !== id) {
    throw new Error('飞书文档链接与文档 ID 不一致。');
  }
  parsed.hostname = hostname;
  parsed.port = '';
  parsed.pathname = `/${segments[0]}/${id}`;
  return parsed.toString();
}

export function validateFeishuAssociationKey(value: string): string {
  const normalized = value.trim();
  if (!KEY_PATTERN.test(normalized)) {
    throw new Error('飞书关联签名密钥格式无效。');
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(normalized, 'base64url');
  } catch {
    throw new Error('飞书关联签名密钥格式无效。');
  }
  if (bytes.toString('base64url') !== normalized) {
    throw new Error('飞书关联签名密钥格式无效。');
  }
  if (bytes.byteLength < 32) throw new Error('飞书关联签名密钥强度不足。');
  return normalized;
}

function normalizedContext(context: FeishuAssociationContext): FeishuAssociationContext {
  const vaultBasePath = path.resolve(context.vaultBasePath.trim());
  const sourcePath = context.sourcePath.replace(/\\/g, '/').replace(/^\/+/, '').normalize('NFC');
  const accountOpenId = context.accountOpenId.trim().normalize('NFC');
  if (!sourcePath || sourcePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('飞书关联的 Vault 笔记路径无效。');
  }
  if (!accountOpenId) throw new Error('无法确认当前飞书账号，不能认证文档关联。');
  return { vaultBasePath, sourcePath, accountOpenId };
}

function associationPayload(
  state: Pick<FeishuPublishState, 'documentId' | 'url'>,
  context: FeishuAssociationContext,
): string {
  const normalized = normalizedContext(context);
  const documentId = normalizeFeishuDocumentId(state.documentId);
  const url = canonicalizeFeishuDocumentUrl(state.url, documentId);
  return JSON.stringify([
    'ailu-feishu-association',
    FEISHU_ASSOCIATION_VERSION,
    normalized.vaultBasePath,
    normalized.sourcePath,
    normalized.accountOpenId,
    documentId,
    url,
  ]);
}

export function signFeishuPublishState(
  state: FeishuPublishState,
  key: string,
  context: FeishuAssociationContext,
): FeishuPublishState {
  const secret = validateFeishuAssociationKey(key);
  const documentId = normalizeFeishuDocumentId(state.documentId);
  const url = canonicalizeFeishuDocumentUrl(state.url, documentId);
  const associationSignature = createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(associationPayload({ documentId, url }, context))
    .digest('base64url');
  return {
    ...state,
    documentId,
    url,
    associationVersion: FEISHU_ASSOCIATION_VERSION,
    associationSignature,
  };
}

export function verifyFeishuPublishState(
  state: FeishuPublishState | null,
  key: string | null | undefined,
  context: FeishuAssociationContext,
): boolean {
  if (!state
    || state.associationVersion !== FEISHU_ASSOCIATION_VERSION
    || !SIGNATURE_PATTERN.test(state.associationSignature ?? '')) return false;
  try {
    const expected = signFeishuPublishState(state, key ?? '', context).associationSignature ?? '';
    const actualBytes = Buffer.from(state.associationSignature ?? '', 'base64url');
    const expectedBytes = Buffer.from(expected, 'base64url');
    return actualBytes.byteLength === expectedBytes.byteLength
      && timingSafeEqual(actualBytes, expectedBytes);
  } catch {
    return false;
  }
}
