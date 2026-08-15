import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';

import {
  larkCliAuthorizationRecordPath,
} from '../paths';
import { resolveCommand, readCommandVersion } from '../utils/command';
import {
  readJsonFile,
  writeJsonFile,
} from '../utils/fs';
import {
  buildFeishuCreatePayload,
  buildFeishuUpdatePayload,
} from './markdown';
import type {
  FeishuAssetDraft,
  FeishuAuthProgress,
  FeishuAuthorizationMode,
  FeishuCapabilityId,
  FeishuCapabilityState,
  FeishuConnectionState,
  FeishuDocumentResult,
  FeishuDriveFolder,
  FeishuFolderResult,
  FeishuCliStatus,
  FeishuWikiNode,
  FeishuWikiSpace,
  LarkAuthorizationRecord,
} from './types';

const LARK_AUTHORIZATION_MODE: FeishuAuthorizationMode = 'publishing';
const LARK_SCOPE_VERSION = 3;
const FEISHU_CLI_BRAND = 'feishu';
const DEFAULT_FOLDER_NAME = 'Ailu';
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 10 * 60_000;
const MAX_CAPTURE_CHARS = 4 * 1024 * 1024;

const CAPABILITY_META: Record<FeishuCapabilityId, Omit<FeishuCapabilityState, 'granted' | 'verified'>> = {
  im: {
    id: 'im',
    label: '消息',
    description: '读取与发送消息',
  },
  docs: {
    id: 'docs',
    label: '文档',
    description: '创建、更新文档并上传图片',
  },
  base: {
    id: 'base',
    label: '多维表格',
    description: '读取与管理多维表格',
  },
  calendar: {
    id: 'calendar',
    label: '日历',
    description: '查看与管理日程',
  },
  drive: {
    id: 'drive',
    label: '保存位置',
    description: '只读浏览云盘文件夹与知识库节点',
  },
};

const REQUIRED_SCOPES: Record<FeishuCapabilityId, string[]> = {
  im: [
    'im:chat:read',
    'im:message:readonly',
    'im:message.send_as_user',
  ],
  docs: [
    'docx:document:create',
    'docx:document:readonly',
    'docx:document:write_only',
    'docs:document.media:upload',
  ],
  base: [
    'base:app:read',
    'base:record:read',
    'base:table:read',
  ],
  calendar: [
    'calendar:calendar:read',
    'calendar:calendar.event:read',
    'calendar:calendar.event:create',
    'calendar:calendar.event:update',
  ],
  drive: [
    'drive:drive:readonly',
    'space:document:retrieve',
    'wiki:space:retrieve',
    'wiki:node:retrieve',
  ],
};

const PUBLISHING_CAPABILITY_IDS = ['docs', 'drive'] as const satisfies readonly FeishuCapabilityId[];
const PUBLISHING_REQUIRED_SCOPES = PUBLISHING_CAPABILITY_IDS
  .flatMap(id => REQUIRED_SCOPES[id]);

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
}

interface RunOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
  command?: string;
  env?: NodeJS.ProcessEnv;
  authorizationAttemptId?: string;
}

interface LarkAuthStatus {
  appId?: string;
  brand?: string;
  identity?: string;
  identities?: {
    user?: {
      status?: string;
      available?: boolean;
      message?: string;
      openId?: string;
      userName?: string;
      tokenStatus?: string;
      scope?: string | string[];
    };
  };
}

interface CliDiscovery {
  path: string | null;
  version: string | null;
  cliStatus: FeishuCliStatus;
}

interface FeishuProfilePin {
  profile: string;
  accountOpenId: string | null;
}

interface FeishuAuthorizationAttempt {
  id: string;
  profile: FeishuProfilePin | null;
}

type CapabilityVerificationFailureKind = 'authorization' | 'transient';

interface CapabilityVerificationResult {
  capabilities: Record<FeishuCapabilityId, FeishuCapabilityState>;
  failureKind: CapabilityVerificationFailureKind | null;
}

export interface FeishuAuthorizationHandle {
  attemptId: string;
  progress: Promise<FeishuAuthProgress>;
}

export class LarkCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly consoleUrl: string | null = null,
    readonly permissionViolations: string[] = [],
    readonly confirmationRequired = false,
  ) {
    super(message);
  }
}

function createCapability(
  id: FeishuCapabilityId,
  granted: boolean,
  verified = false,
  error?: string,
): FeishuCapabilityState {
  return {
    ...CAPABILITY_META[id],
    granted,
    verified,
    ...(error ? { error } : {}),
  };
}

function emptyCapabilities(): Record<FeishuCapabilityId, FeishuCapabilityState> {
  return {
    im: createCapability('im', false),
    docs: createCapability('docs', false),
    base: createCapability('base', false),
    calendar: createCapability('calendar', false),
    drive: createCapability('drive', false),
  };
}

function extractJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter(index => index >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const objectEnd = trimmed.lastIndexOf('}');
  const arrayEnd = trimmed.lastIndexOf(']');
  const end = Math.max(objectEnd, arrayEnd);
  if (end < start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

function walkValues(value: unknown, key: string, output: unknown[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, key, output);
    return;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) output.push(entryValue);
    walkValues(entryValue, key, output);
  }
}

function findString(value: unknown, keys: string[]): string | null {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    const match = values.find(item => typeof item === 'string' && item.trim());
    if (typeof match === 'string') return match.trim();
  }
  return null;
}

function findNumber(value: unknown, keys: string[]): number | null {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    for (const item of values) {
      const parsed = typeof item === 'number' ? item : Number(item);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function findArray(value: unknown, keys: string[]): unknown[] {
  for (const key of keys) {
    const values: unknown[] = [];
    walkValues(value, key, values);
    const match = values.find(Array.isArray);
    if (Array.isArray(match)) return match;
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordString(value: unknown, key: string): string {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
}

function recordBoolean(value: unknown, key: string): boolean {
  return asRecord(value)?.[key] === true;
}

export interface FeishuDriveFolderPage {
  folders: FeishuDriveFolder[];
  hasMore: boolean;
  nextPageToken: string;
}

export function parseFeishuDriveFolderPage(payload: unknown): FeishuDriveFolderPage {
  const folders = findArray(payload, ['files'])
    .filter(item => recordString(item, 'type').toLowerCase() === 'folder')
    .flatMap((item): FeishuDriveFolder[] => {
      const token = recordString(item, 'token');
      const name = recordString(item, 'name');
      if (!token || !name) return [];
      return [{
        token,
        name,
        url: recordString(item, 'url'),
      }];
    });
  return {
    folders,
    hasMore: recordBoolean(asRecord(payload)?.data ?? payload, 'has_more'),
    nextPageToken: recordString(asRecord(payload)?.data ?? payload, 'next_page_token'),
  };
}

export function parseFeishuWikiSpaces(payload: unknown): FeishuWikiSpace[] {
  return findArray(payload, ['spaces']).flatMap((item): FeishuWikiSpace[] => {
    const spaceId = recordString(item, 'space_id');
    const name = recordString(item, 'name');
    return spaceId && name ? [{ spaceId, name }] : [];
  });
}

export function parseFeishuWikiNodes(payload: unknown): FeishuWikiNode[] {
  return findArray(payload, ['nodes']).flatMap((item): FeishuWikiNode[] => {
    const spaceId = recordString(item, 'space_id');
    const nodeToken = recordString(item, 'node_token');
    const title = recordString(item, 'title') || '未命名节点';
    if (!spaceId || !nodeToken) return [];
    return [{
      spaceId,
      nodeToken,
      parentNodeToken: recordString(item, 'parent_node_token'),
      title,
      hasChild: recordBoolean(item, 'has_child'),
    }];
  });
}

function parseCliError(result: CommandResult): LarkCliError {
  const payload = extractJson(result.stderr) ?? extractJson(result.stdout);
  const message = findString(payload, ['message', 'hint'])
    ?? (result.timedOut ? '飞书 CLI 操作超时，请重试。' : '飞书 CLI 操作失败，请重试。');
  const consoleUrl = findString(payload, ['console_url', 'consoleUrl']);
  const violations = findArray(payload, ['permission_violations', 'permissionViolations'])
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      const scope = findString(item, ['scope', 'name']);
      return scope ? [scope] : [];
    });
  const errorType = findString(payload, ['subtype', 'type']);
  return new LarkCliError(
    message,
    result.code,
    consoleUrl,
    violations,
    result.code === 10 && errorType === 'confirmation_required',
  );
}

function classifyCapabilityVerificationFailure(
  result: CommandResult,
  error: LarkCliError,
): CapabilityVerificationFailureKind {
  const payload = extractJson(result.stderr) ?? extractJson(result.stdout);
  const payloadRecord = asRecord(payload);
  const errorRecord = asRecord(payloadRecord?.error) ?? payloadRecord;
  const type = recordString(errorRecord, 'type').toLowerCase();
  const subtype = recordString(errorRecord, 'subtype').toLowerCase();
  const missingScopes = findArray(payload, ['missing_scopes', 'missingScopes']);
  const explicitAuthorizationSubtype = new Set([
    'authorization_required',
    'expired_token',
    'invalid_token',
    'missing_scope',
    'missing_scopes',
    'missing_token',
    'not_authorized',
    'permission_denied',
    'revoked_token',
    'token_expired',
    'token_invalid',
    'token_revoked',
  ]).has(subtype);
  if (
    missingScopes.length > 0
    || error.permissionViolations.length > 0
    || (['authorization', 'authentication'].includes(type) && explicitAuthorizationSubtype)
  ) {
    return 'authorization';
  }
  return 'transient';
}

export function parseLarkCliFailure(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  timedOut = false,
): LarkCliError {
  return parseCliError({
    code: exitCode,
    stdout,
    stderr,
    cancelled: false,
    timedOut,
  });
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((scope): scope is string => typeof scope === 'string')
      .flatMap(scope => scope.split(/\s+/))
      .map(scope => scope.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean);
}

function scopesForStatus(status: LarkAuthStatus): Set<string> {
  return new Set(normalizeScopes(status.identities?.user?.scope));
}

function requestedScopesFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  return normalizeScopes(
    record.requestedScopes
    ?? record.requested_scopes
    ?? record.scopes
    ?? record.scope,
  );
}

export function missingLarkScopes(
  expectedScopes: Iterable<string>,
  grantedScopes: Iterable<string>,
): string[] {
  const granted = new Set(grantedScopes);
  return Array.from(new Set(expectedScopes)).filter(scope => !granted.has(scope));
}

export function isValidLarkAuthorizationRecord(
  value: unknown,
): value is LarkAuthorizationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<LarkAuthorizationRecord>;
  const authorizedAt = typeof record.authorizedAt === 'string'
    ? Date.parse(record.authorizedAt)
    : Number.NaN;
  const currentRecord = record.authorizationMode === LARK_AUTHORIZATION_MODE
    && record.scopeVersion === LARK_SCOPE_VERSION;
  const previousPublishingRecord = record.authorizationMode === LARK_AUTHORIZATION_MODE
    && record.scopeVersion === 2;
  const legacyRecord = record.authorizationMode === 'all'
    && record.scopeVersion === 1;
  return (currentRecord || previousPublishingRecord || legacyRecord)
    && (typeof record.cliVersion === 'string' || record.cliVersion === null)
    && Number.isFinite(authorizedAt);
}

function ensureSafeVaultPath(vaultPath: string): string {
  const normalized = path.normalize(vaultPath);
  if (
    path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`图片路径超出当前 Vault：${vaultPath}`);
  }
  return normalized;
}

export function buildLarkAuthorizationArgs(): string[] {
  return [
    'auth',
    'login',
    '--scope',
    PUBLISHING_REQUIRED_SCOPES.join(' '),
    '--no-wait',
    '--json',
  ];
}

export function buildLarkAuthStatusArgs(): string[] {
  return ['auth', 'status', '--json', '--verify'];
}

export function buildFeishuDriveFolderListArgs(
  folderToken = '',
  pageToken = '',
): string[] {
  const params: Record<string, string | number> = {
    folder_token: folderToken.trim(),
    page_size: 200,
  };
  if (pageToken.trim()) params.page_token = pageToken.trim();
  return [
    'drive',
    'files',
    'list',
    '--as',
    'user',
    '--params',
    JSON.stringify(params),
    '--format',
    'json',
  ];
}

export function buildFeishuWikiSpaceListArgs(): string[] {
  return [
    'wiki',
    '+space-list',
    '--as',
    'user',
    '--page-all',
    '--page-limit',
    '0',
    '--json',
  ];
}

export function buildFeishuWikiNodeListArgs(
  spaceId: string,
  parentNodeToken = '',
): string[] {
  const normalizedSpaceId = spaceId.trim();
  if (!normalizedSpaceId) throw new Error('缺少飞书知识库标识。');
  const args = [
    'wiki',
    '+node-list',
    '--space-id',
    normalizedSpaceId,
    '--as',
    'user',
  ];
  if (parentNodeToken.trim()) {
    args.push('--parent-node-token', parentNodeToken.trim());
  }
  args.push('--page-all', '--page-limit', '0', '--json');
  return args;
}

export function buildFeishuCreateDocumentArgs(parentToken = '', title = ''): string[] {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error('飞书文档标题不能为空。');
  const args = [
    'docs',
    '+create',
    '--as',
    'user',
    '--doc-format',
    'markdown',
  ];
  if (parentToken.trim()) {
    args.push('--parent-token', parentToken.trim());
  } else {
    args.push('--parent-position', 'my_library');
  }
  args.push('--title', normalizedTitle);
  args.push(
    '--content',
    '-',
    '--json',
  );
  return args;
}

export function buildFeishuUpdateDocumentArgs(documentId: string): string[] {
  return [
    'docs',
    '+update',
    '--as',
    'user',
    '--doc',
    documentId,
    '--command',
    'overwrite',
    '--doc-format',
    'markdown',
    '--content',
    '-',
    '--json',
  ];
}

export function buildFeishuFetchDocumentArgs(documentId: string): string[] {
  return [
    'docs',
    '+fetch',
    '--as',
    'user',
    '--doc',
    documentId,
    '--doc-format',
    'xml',
    '--detail',
    'with-ids',
    '--json',
  ];
}

export function parseFeishuPlaceholderBlockIds(
  content: string,
  placeholders: Iterable<string>,
): Map<string, string> {
  const requested = new Set(placeholders);
  const resolved = new Map<string, string>();
  const blockPattern = /<(p|h[1-9]|li|blockquote|checkbox)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of content.matchAll(blockPattern)) {
    const id = /\bid=["']([^"']+)["']/i.exec(match[2])?.[1];
    if (!id) continue;
    const text = match[3].replace(/<[^>]+>/g, '').trim();
    if (requested.has(text)) resolved.set(text, id);
  }
  return resolved;
}

export class LarkCliService extends EventEmitter {
  private readonly activeChildren = new Set<ChildProcess>();
  private readonly authorizationChildren = new Map<string, Set<ChildProcess>>();
  private activePublishingOperation: Promise<unknown> | null = null;
  private cancelled = false;
  private pendingDeviceCode: string | null = null;
  private pendingVerificationUrl: string | null = null;
  private pendingRequestedScopes: string[] = [];
  private pendingExpiresAt: number | null = null;
  private pendingAuthorizationProfile: FeishuProfilePin | null = null;
  private activeAuthorizationAttempt: FeishuAuthorizationAttempt | null = null;
  private resolvedCliPath: string | null = null;
  private cachedConnectionState: FeishuConnectionState | null = null;
  private activeConnectionCheck: {
    verifyCapabilities: boolean;
    promise: Promise<FeishuConnectionState>;
  } | null = null;
  private activePublishingProfile: FeishuProfilePin | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    super();
  }

  onProgress(listener: (progress: FeishuAuthProgress) => void): () => void {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }

  getCachedConnectionState(): FeishuConnectionState | null {
    return this.cachedConnectionState;
  }

  discoverCli(): CliDiscovery {
    const cliPath = resolveCommand('lark-cli', this.buildSearchEnv());
    this.resolvedCliPath = cliPath;
    return {
      path: cliPath,
      version: cliPath ? readCommandVersion(cliPath, this.buildSearchEnv()) : null,
      cliStatus: cliPath ? 'ready' : 'missing',
    };
  }

  async ensureConfigured(
    onVerificationUrl?: (url: string) => void,
    authorizationAttemptId?: string,
  ): Promise<void> {
    const cliPath = this.requireCli();
    const configuration = await this.readConfigurationBrand(
      cliPath,
      null,
      authorizationAttemptId,
    );
    if (configuration.configured && configuration.brand === FEISHU_CLI_BRAND) return;
    if (configuration.configured) {
      throw new LarkCliError(
        configuration.brand === 'lark'
          ? '当前激活的是 Lark 国际版配置。Ailu 只连接中国版飞书（Feishu）；请先切换到 brand=feishu 的 CLI 配置。'
          : '无法确认当前 CLI 是否为中国版飞书（Feishu）配置。请更新 CLI 并切换到 brand=feishu 后重试。',
        null,
      );
    }
    this.emitProgress({
      ...(authorizationAttemptId ? { attemptId: authorizationAttemptId } : {}),
      phase: 'configuring',
      message: '正在配置飞书应用…',
      detail: '请在浏览器中完成飞书应用配置。',
    });
    const seenUrls = new Set<string>();
    const result = await this.run(
      ['config', 'init', '--new', '--brand', FEISHU_CLI_BRAND, '--lang', 'zh'],
      {
        command: cliPath,
        timeoutMs: AUTH_TIMEOUT_MS,
        authorizationAttemptId,
        onOutput: (chunk) => {
          for (const match of chunk.matchAll(/https:\/\/[^\s"'<>]+/g)) {
            const url = match[0];
            if (seenUrls.has(url)) continue;
            seenUrls.add(url);
            onVerificationUrl?.(url);
            this.emitProgress({
              ...(authorizationAttemptId ? { attemptId: authorizationAttemptId } : {}),
              phase: 'configuring',
              message: '请在浏览器中完成飞书应用配置',
              verificationUrl: url,
            });
          }
        },
      },
    );
    this.assertSuccess(result);
  }

  beginAuthorization(
    onVerificationUrl?: (url: string) => void,
  ): FeishuAuthorizationHandle {
    if (this.activeAuthorizationAttempt) {
      throw new LarkCliError('另一窗口正在进行飞书授权，请先完成或取消。', null);
    }
    if (this.activePublishingOperation) {
      throw new LarkCliError('飞书同步正在进行，完成后才能重新授权。', null);
    }
    const attempt: FeishuAuthorizationAttempt = {
      id: randomUUID(),
      profile: null,
    };
    this.activeAuthorizationAttempt = attempt;
    return {
      attemptId: attempt.id,
      progress: this.startAuthorizationAttempt(attempt, onVerificationUrl),
    };
  }

  async startAuthorization(
    onVerificationUrl?: (url: string) => void,
  ): Promise<FeishuAuthProgress> {
    return this.beginAuthorization(onVerificationUrl).progress;
  }

  private async startAuthorizationAttempt(
    attempt: FeishuAuthorizationAttempt,
    onVerificationUrl?: (url: string) => void,
  ): Promise<FeishuAuthProgress> {
    try {
      const cliPath = this.requireCli();
      await this.ensureConfigured(onVerificationUrl, attempt.id);
      this.assertActiveAuthorizationAttempt(attempt.id);
      const profile = await this.resolveAuthorizationProfilePin(cliPath, attempt.id);
      this.assertActiveAuthorizationAttempt(attempt.id);
      attempt.profile = profile;
      this.pendingDeviceCode = null;
      this.pendingVerificationUrl = null;
      this.pendingRequestedScopes = [];
      this.pendingExpiresAt = null;
      this.pendingAuthorizationProfile = profile;
      this.emitProgress({
        attemptId: attempt.id,
        phase: 'waiting-auth',
        message: '正在申请飞书文档发布与目录只读权限…',
      });
      const result = await this.runWithFeishuProfile(
        buildLarkAuthorizationArgs(),
        profile,
        { command: cliPath, authorizationAttemptId: attempt.id },
      );
      this.assertActiveAuthorizationAttempt(attempt.id);
      this.assertSuccess(result);
      const payload = extractJson(result.stdout);
      const deviceCode = findString(payload, ['device_code', 'deviceCode']);
      const verificationUrl = findString(payload, [
        'verification_url',
        'verification_uri_complete',
        'verificationUrl',
      ]);
      if (!deviceCode || !verificationUrl) {
        throw new LarkCliError('飞书 CLI 未返回有效授权地址，请重试。', result.code);
      }
      this.pendingDeviceCode = deviceCode;
      this.pendingVerificationUrl = verificationUrl;
      this.pendingRequestedScopes = requestedScopesFromPayload(payload);
      const expiresIn = findNumber(payload, ['expires_in', 'expiresIn']) ?? 600;
      this.pendingExpiresAt = Date.now() + expiresIn * 1000;
      const expiresAt = new Date(this.pendingExpiresAt).toISOString();
      const qrCodeDataUrl = await QRCode.toDataURL(verificationUrl, {
        width: 256,
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      this.assertActiveAuthorizationAttempt(attempt.id);
      const progress: FeishuAuthProgress = {
        attemptId: attempt.id,
        phase: 'waiting-auth',
        message: '等待你在手机飞书 App 内完成授权……',
        verificationUrl,
        qrCodeDataUrl,
        expiresAt,
      };
      this.emitProgress(progress);
      return progress;
    } catch (error) {
      this.clearAuthorizationAttempt(attempt.id);
      throw error;
    }
  }

  async completeAuthorization(attemptId: string): Promise<FeishuConnectionState> {
    this.assertActiveAuthorizationAttempt(attemptId);
    const deviceCode = this.pendingDeviceCode;
    const pendingProfile = this.pendingAuthorizationProfile;
    if (!deviceCode || !pendingProfile) {
      this.clearAuthorizationAttempt(attemptId);
      throw new LarkCliError(
        deviceCode ? '飞书授权配置已变化，请重新发起授权。' : '当前授权请求已失效，请重新发起授权。',
        null,
      );
    }
    try {
      const cliPath = this.requireCli();
      const checkedProfile = await this.resolveAuthorizationProfilePinByName(
        cliPath,
        pendingProfile.profile,
        attemptId,
      );
      this.assertActiveAuthorizationAttempt(attemptId);
      const result = await this.runWithFeishuProfile(
        ['auth', 'login', '--device-code', deviceCode],
        checkedProfile,
        {
          command: cliPath,
          timeoutMs: AUTH_TIMEOUT_MS,
          authorizationAttemptId: attemptId,
        },
      );
      this.assertActiveAuthorizationAttempt(attemptId);
      if (
        result.code !== 0
        && this.pendingExpiresAt
        && Date.now() >= this.pendingExpiresAt
      ) {
        throw new LarkCliError('当前授权二维码已过期，请刷新二维码。', result.code);
      }
      this.assertSuccess(result);
      this.emitProgress({ phase: 'verifying', message: '正在验证飞书文档发布与目录只读权限…' });
      const inFlightCheck = this.activeConnectionCheck?.promise;
      if (inFlightCheck) await inFlightCheck;
      const authorizedProfile = await this.resolvePublishingProfilePinByName(
        cliPath,
        checkedProfile.profile,
        attemptId,
      );
      this.assertActiveAuthorizationAttempt(attemptId);
      const connection = await this.inspectConnectionState(
        true,
        authorizedProfile,
        attemptId,
      );
      this.cachedConnectionState = connection;
      if (!connection.connected) {
        throw new LarkCliError(connection.message || '飞书授权尚未完成。', null, connection.consoleUrl);
      }
      const grantedScopes = await this.readGrantedScopes(
        cliPath,
        authorizedProfile,
        attemptId,
      );
      const missingRequested = missingLarkScopes(this.pendingRequestedScopes, grantedScopes);
      if (missingRequested.length) {
        throw new LarkCliError('飞书文档发布与目录只读权限尚未完整授权，请重新扫码。', null);
      }
      const authorizationRecord: LarkAuthorizationRecord = {
        authorizationMode: LARK_AUTHORIZATION_MODE,
        scopeVersion: LARK_SCOPE_VERSION,
        cliVersion: connection.cliVersion,
        authorizedAt: new Date().toISOString(),
      };
      writeJsonFile(
        larkCliAuthorizationRecordPath(this.env),
        authorizationRecord,
        0o600,
      );
      this.emitProgress({ phase: 'success', message: '飞书已连接，文档发布与目录只读权限已授权。' });
      const authorizedConnection: FeishuConnectionState = {
        ...connection,
        authorizationMode: authorizationRecord.authorizationMode,
        permissionsComplete: true,
        authorizedAt: authorizationRecord.authorizedAt,
      };
      this.cachedConnectionState = authorizedConnection;
      return authorizedConnection;
    } finally {
      this.clearAuthorizationAttempt(attemptId);
    }
  }

  async getConnectionState(verifyCapabilities = false): Promise<FeishuConnectionState> {
    await this.waitForPublishingIdle();
    const active = this.activeConnectionCheck;
    if (active) {
      if (active.verifyCapabilities || !verifyCapabilities) return active.promise;
      await active.promise;
      return this.getConnectionState(true);
    }
    const promise = this.inspectConnectionState(verifyCapabilities);
    const check = { verifyCapabilities, promise };
    this.activeConnectionCheck = check;
    try {
      const connection = await promise;
      this.cachedConnectionState = connection;
      return connection;
    } finally {
      if (this.activeConnectionCheck === check) this.activeConnectionCheck = null;
    }
  }

  async runPublishingOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeAuthorizationAttempt) {
      throw new LarkCliError('飞书授权正在进行，完成后才能同步文档。', null);
    }
    if (this.activePublishingOperation) {
      throw new LarkCliError('另一项飞书同步仍在进行，请完成后重试。', null);
    }
    const active = (async () => {
      const cliPath = this.requireCli();
      const profile = await this.resolvePublishingProfilePin(cliPath);
      this.assertProfileMatchesCheckedConnection(profile);
      this.activePublishingProfile = profile;
      try {
        return await operation();
      } finally {
        if (this.activePublishingProfile === profile) this.activePublishingProfile = null;
      }
    })();
    this.activePublishingOperation = active;
    try {
      return await active;
    } finally {
      if (this.activePublishingOperation === active) this.activePublishingOperation = null;
    }
  }

  private async inspectConnectionState(
    verifyCapabilities: boolean,
    profile: FeishuProfilePin | null = null,
    authorizationAttemptId?: string,
  ): Promise<FeishuConnectionState> {
    const discovered = this.discoverCli();
    if (!discovered.path) {
      return {
        status: 'missing-cli',
        cliPath: null,
        cliVersion: null,
        cliStatus: discovered.cliStatus,
        configured: false,
        connected: false,
        authorizationMode: null,
        permissionsComplete: false,
        authorizedAt: null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: null,
        message: '未检测到系统中的飞书 CLI。请先按照官方指引独立安装。',
      };
    }

    const authorizationRecord = this.readAuthorizationRecord();
    const configured = await this.hasConfiguration(profile, authorizationAttemptId);
    if (!configured) {
      return {
        status: 'needs-config',
        cliPath: discovered.path,
        cliVersion: discovered.version,
        cliStatus: discovered.cliStatus,
        configured: false,
        connected: false,
        authorizationMode: authorizationRecord?.authorizationMode ?? null,
        permissionsComplete: false,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: null,
        message: '飞书 CLI 尚未完成应用配置',
      };
    }

    try {
      const statusResult = await this.runWithOptionalFeishuProfile(
        buildLarkAuthStatusArgs(),
        profile,
        { command: discovered.path, authorizationAttemptId },
      );
      this.assertSuccess(statusResult);
      const status = (extractJson(statusResult.stdout) ?? {}) as LarkAuthStatus;
      if (status.brand?.trim().toLowerCase() !== FEISHU_CLI_BRAND) {
        return {
          status: 'needs-config',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          cliStatus: discovered.cliStatus,
          configured: false,
          connected: false,
          authorizationMode: null,
          permissionsComplete: false,
          authorizedAt: null,
          accountName: null,
          accountOpenId: null,
          tenantName: null,
          capabilities: emptyCapabilities(),
          consoleUrl: null,
          message: '当前激活的不是中国版飞书（Feishu）配置。请切换到 brand=feishu 的 CLI 配置后重新检查。',
        };
      }
      const user = status.identities?.user;
      const accountOpenId = user?.openId?.trim() || null;
      const grantedScopes = scopesForStatus(status);
      const capabilities = this.capabilitiesForScopes(grantedScopes);
      const tokenStatus = user?.tokenStatus?.toLowerCase() ?? '';
      const tokenReady = user?.available === true
        && user.status === 'ready'
        && !['expired', 'invalid', 'missing', 'revoked'].includes(tokenStatus);

      if (!tokenReady) {
        return {
          status: 'needs-auth',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          cliStatus: discovered.cliStatus,
          configured: true,
          connected: false,
          authorizationMode: authorizationRecord?.authorizationMode ?? null,
          permissionsComplete: false,
          authorizedAt: authorizationRecord?.authorizedAt ?? null,
          accountName: user?.userName ?? null,
          accountOpenId,
          tenantName: null,
          capabilities,
          consoleUrl: null,
          message: user?.message || '请使用手机飞书 App 扫码授权文档发布与目录只读能力。',
        };
      }

      if (!accountOpenId) {
        return {
          status: 'error',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          cliStatus: discovered.cliStatus,
          configured: true,
          connected: false,
          authorizationMode: authorizationRecord?.authorizationMode ?? null,
          permissionsComplete: false,
          authorizedAt: authorizationRecord?.authorizedAt ?? null,
          accountName: user?.userName ?? '飞书用户',
          accountOpenId: null,
          tenantName: null,
          capabilities,
          consoleUrl: null,
          message: '飞书 CLI 未返回可绑定的账号标识，请重新检查连接或重新授权。',
        };
      }

      const permissionsComplete = missingLarkScopes(
        PUBLISHING_REQUIRED_SCOPES,
        grantedScopes,
      ).length === 0;
      if (!permissionsComplete) {
        return {
          status: 'needs-auth',
          cliPath: discovered.path,
          cliVersion: discovered.version,
          cliStatus: discovered.cliStatus,
          configured: true,
          connected: false,
          authorizationMode: authorizationRecord?.authorizationMode ?? null,
          permissionsComplete,
          authorizedAt: authorizationRecord?.authorizedAt ?? null,
          accountName: user?.userName ?? '飞书用户',
          accountOpenId,
          tenantName: null,
          capabilities,
          consoleUrl: null,
          message: '授权范围不完整，请重新扫码授权文档发布与目录只读能力。',
        };
      }

      let verification: CapabilityVerificationResult = {
        capabilities,
        failureKind: null,
      };
      if (verifyCapabilities) {
        verification = await this.verifyReadCapabilities(
          capabilities,
          profile,
          authorizationAttemptId,
        );
      }
      const verifiedCapabilities = verification.capabilities;
      const allGranted = PUBLISHING_CAPABILITY_IDS.every((id) => {
        const capability = verifiedCapabilities[id];
        return capability.granted && (!verifyCapabilities || capability.verified);
      });
      const connectionStatus = allGranted
        ? 'connected'
        : verification.failureKind === 'transient'
          ? 'error'
          : 'needs-auth';
      return {
        status: connectionStatus,
        cliPath: discovered.path,
        cliVersion: discovered.version,
        cliStatus: discovered.cliStatus,
        configured: true,
        connected: allGranted,
        authorizationMode: authorizationRecord?.authorizationMode
          ?? LARK_AUTHORIZATION_MODE,
        permissionsComplete: verification.failureKind === 'authorization'
          ? false
          : permissionsComplete,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: user?.userName ?? '飞书用户',
        accountOpenId,
        tenantName: null,
        capabilities: verifiedCapabilities,
        consoleUrl: null,
        message: allGranted
          ? null
          : verification.failureKind === 'transient'
            ? '飞书登录仍有效，但连接能力检查暂时失败。请点击“检查连接”重试；无需重新授权。'
            : '飞书返回了明确的权限或令牌拒绝，请重新授权文档发布与目录只读能力。',
      };
    } catch (error) {
      const larkError = error instanceof LarkCliError ? error : null;
      return {
        status: larkError?.consoleUrl ? 'admin-action-required' : 'error',
        cliPath: discovered.path,
        cliVersion: discovered.version,
        cliStatus: discovered.cliStatus,
        configured: true,
        connected: false,
        authorizationMode: authorizationRecord?.authorizationMode ?? null,
        permissionsComplete: false,
        authorizedAt: authorizationRecord?.authorizedAt ?? null,
        accountName: null,
        accountOpenId: null,
        tenantName: null,
        capabilities: emptyCapabilities(),
        consoleUrl: larkError?.consoleUrl ?? null,
        message: error instanceof Error ? error.message : '检测飞书连接失败',
      };
    }
  }

  async disconnect(): Promise<void> {
    throw new LarkCliError(
      '飞书 CLI 登录由本机所有工作流共享，请在飞书 CLI 中自行管理全局授权。',
      null,
    );
  }

  async listDriveFolders(folderToken = ''): Promise<FeishuDriveFolder[]> {
    await this.waitForPublishingIdle();
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const folders = new Map<string, FeishuDriveFolder>();
    const seenPages = new Set<string>();
    let pageToken: string | null = '';
    while (pageToken !== null) {
      if (seenPages.has(pageToken)) {
        throw new LarkCliError('飞书云盘目录分页重复，已停止读取以避免目录缺失。', null);
      }
      seenPages.add(pageToken);
      const result = await this.runWithFeishuProfile(
        buildFeishuDriveFolderListArgs(folderToken, pageToken),
        profile,
        { command: cliPath },
      );
      this.assertSuccess(result);
      const page = parseFeishuDriveFolderPage(extractJson(result.stdout));
      for (const folder of page.folders) folders.set(folder.token, folder);
      if (!page.hasMore) {
        pageToken = null;
        continue;
      }
      if (!page.nextPageToken) {
        throw new LarkCliError('飞书云盘目录未返回下一页标记，当前列表可能不完整。', result.code);
      }
      pageToken = page.nextPageToken;
    }
    return Array.from(folders.values());
  }

  async listWikiSpaces(): Promise<FeishuWikiSpace[]> {
    await this.waitForPublishingIdle();
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const result = await this.runWithFeishuProfile(buildFeishuWikiSpaceListArgs(), profile, {
      command: cliPath,
    });
    this.assertSuccess(result);
    return parseFeishuWikiSpaces(extractJson(result.stdout));
  }

  async listWikiNodes(
    spaceId: string,
    parentNodeToken = '',
  ): Promise<FeishuWikiNode[]> {
    await this.waitForPublishingIdle();
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const result = await this.runWithFeishuProfile(
      buildFeishuWikiNodeListArgs(spaceId, parentNodeToken),
      profile,
      { command: cliPath },
    );
    this.assertSuccess(result);
    return parseFeishuWikiNodes(extractJson(result.stdout));
  }

  async findOrCreateDefaultFolder(): Promise<FeishuFolderResult> {
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const existing = await this.findFolder(cliPath, profile, DEFAULT_FOLDER_NAME);
    if (existing) return existing;

    const created = await this.runWithFeishuProfile([
      'drive',
      '+create-folder',
      '--as',
      'user',
      '--name',
      DEFAULT_FOLDER_NAME,
      '--json',
    ], profile, { command: cliPath });
    this.assertSuccess(created);
    const payload = extractJson(created.stdout);
    const folderToken = findString(payload, ['folder_token', 'token']);
    if (!folderToken) throw new LarkCliError('飞书已创建文件夹，但未返回文件夹标识。', created.code);
    return {
      folderToken,
      url: findString(payload, ['url']),
    };
  }

  async createDocument(
    markdown: string,
    parentToken: string,
    title = '',
  ): Promise<FeishuDocumentResult> {
    const prepared = buildFeishuCreatePayload(markdown, title);
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const result = await this.runWithFeishuProfile(
      buildFeishuCreateDocumentArgs(parentToken, prepared.title),
      profile,
      {
        command: cliPath,
        input: prepared.bodyMarkdown,
        timeoutMs: AUTH_TIMEOUT_MS,
      },
    );
    this.assertSuccess(result);
    const payload = extractJson(result.stdout);
    const documentId = findString(payload, ['document_id', 'documentId', 'doc_id']);
    const url = findString(payload, ['url', 'doc_url']);
    if (!documentId || !url) {
      throw new LarkCliError('飞书已创建文档，但未返回文档地址。', result.code);
    }
    return { documentId, url };
  }

  async updateDocument(documentId: string, markdown: string): Promise<void> {
    const payload = buildFeishuUpdatePayload(markdown);
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const result = await this.runWithFeishuProfile(buildFeishuUpdateDocumentArgs(documentId), profile, {
      command: cliPath,
      input: payload,
      timeoutMs: AUTH_TIMEOUT_MS,
    });
    this.assertSuccess(result);
  }

  async fetchDocumentContent(documentId: string): Promise<string> {
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const result = await this.runWithFeishuProfile(buildFeishuFetchDocumentArgs(documentId), profile, {
      command: cliPath,
      timeoutMs: AUTH_TIMEOUT_MS,
    });
    this.assertSuccess(result);
    const content = findString(extractJson(result.stdout), ['content']);
    if (content === null) {
      throw new LarkCliError('飞书已返回文档，但未包含可验证的正文。', result.code);
    }
    return content;
  }

  async insertAssets(
    documentId: string,
    vaultBasePath: string,
    assets: FeishuAssetDraft[],
  ): Promise<void> {
    if (!assets.length) return;
    const cliPath = this.requireCli();
    const profile = await this.resolveCheckedFeishuProfilePin(cliPath);
    const content = await this.fetchDocumentContent(documentId);
    const placeholderBlockIds = parseFeishuPlaceholderBlockIds(
      content,
      assets.map(asset => asset.placeholder),
    );
    const missingPlaceholder = assets.find(asset => !placeholderBlockIds.has(asset.placeholder));
    if (missingPlaceholder) {
      throw new LarkCliError(
        `飞书文档中未找到图片定位标记：${missingPlaceholder.fileName}`,
        null,
      );
    }
    for (const asset of assets) {
      const relativePath = ensureSafeVaultPath(asset.vaultPath);
      const inserted = await this.runWithFeishuProfile([
        'docs',
        '+media-insert',
        '--as',
        'user',
        '--doc',
        documentId,
        '--file',
        relativePath,
        '--align',
        'center',
        '--json',
      ], profile, {
        command: cliPath,
        cwd: vaultBasePath,
        timeoutMs: AUTH_TIMEOUT_MS,
      });
      this.assertSuccess(inserted);
      const insertedBlockId = findString(extractJson(inserted.stdout), ['block_id', 'blockId']);
      if (!insertedBlockId) {
        throw new LarkCliError(`飞书已上传图片，但未返回图片位置：${asset.fileName}`, inserted.code);
      }
      const placeholderBlockId = placeholderBlockIds.get(asset.placeholder)!;

      const movedImage = await this.runWithFeishuProfile([
        'docs',
        '+update',
        '--as',
        'user',
        '--doc',
        documentId,
        '--command',
        'block_move_after',
        '--block-id',
        placeholderBlockId,
        '--src-block-ids',
        insertedBlockId,
        '--json',
      ], profile, { command: cliPath, timeoutMs: AUTH_TIMEOUT_MS });
      this.assertSuccess(movedImage);

      const removedPlaceholder = await this.runWithFeishuProfile([
        'docs',
        '+update',
        '--as',
        'user',
        '--doc',
        documentId,
        '--command',
        'block_delete',
        '--block-id',
        placeholderBlockId,
        '--json',
      ], profile, { command: cliPath, timeoutMs: AUTH_TIMEOUT_MS });
      this.assertSuccess(removedPlaceholder);
    }
  }

  cancelActiveOperation(): void {
    this.cancelled = true;
    this.pendingDeviceCode = null;
    this.pendingVerificationUrl = null;
    this.pendingRequestedScopes = [];
    this.pendingExpiresAt = null;
    this.pendingAuthorizationProfile = null;
    this.activeAuthorizationAttempt = null;
    for (const child of this.activeChildren) child.kill('SIGTERM');
    this.emitProgress({ phase: 'cancelled', message: '已取消飞书连接操作。' });
  }

  cancelAuthorization(attemptId: string): boolean {
    if (this.activeAuthorizationAttempt?.id !== attemptId) return false;
    const children = this.authorizationChildren.get(attemptId);
    if (children) {
      for (const child of children) child.kill('SIGTERM');
    }
    this.clearAuthorizationAttempt(attemptId);
    this.emitProgress({
      attemptId,
      phase: 'cancelled',
      message: '已取消飞书连接操作。',
    });
    return true;
  }

  private async waitForPublishingIdle(): Promise<void> {
    const active = this.activePublishingOperation;
    if (!active) return;
    await active.catch(() => undefined);
  }

  private assertActiveAuthorizationAttempt(attemptId: string): void {
    if (this.activeAuthorizationAttempt?.id === attemptId) return;
    throw new LarkCliError('飞书授权已取消或被新的操作替代。', null);
  }

  private clearAuthorizationAttempt(attemptId: string): void {
    if (this.activeAuthorizationAttempt?.id !== attemptId) return;
    this.activeAuthorizationAttempt = null;
    this.pendingDeviceCode = null;
    this.pendingVerificationUrl = null;
    this.pendingRequestedScopes = [];
    this.pendingExpiresAt = null;
    this.pendingAuthorizationProfile = null;
    this.authorizationChildren.delete(attemptId);
  }

  private async hasConfiguration(
    profile: FeishuProfilePin | null = null,
    authorizationAttemptId?: string,
  ): Promise<boolean> {
    const cliPath = this.requireCli();
    return (await this.readConfigurationBrand(
      cliPath,
      profile,
      authorizationAttemptId,
    )).configured;
  }

  private async readConfigurationBrand(
    cliPath: string,
    profile: FeishuProfilePin | null = null,
    authorizationAttemptId?: string,
  ): Promise<{ brand: string | null; configured: boolean }> {
    const result = await this.runWithOptionalFeishuProfile(
      ['auth', 'status', '--json'],
      profile,
      { command: cliPath, authorizationAttemptId },
    );
    if (result.code !== 0) return { brand: null, configured: false };
    const status = (extractJson(result.stdout) ?? {}) as LarkAuthStatus;
    return {
      brand: status.brand?.trim().toLowerCase() || null,
      configured: true,
    };
  }

  private async resolveCheckedFeishuProfilePin(cliPath: string): Promise<FeishuProfilePin> {
    const active = this.activePublishingProfile;
    if (active) return active;
    const profile = await this.resolvePublishingProfilePin(cliPath);
    this.assertProfileMatchesCheckedConnection(profile);
    return profile;
  }

  private async resolveAuthorizationProfilePin(
    cliPath: string,
    authorizationAttemptId: string,
  ): Promise<FeishuProfilePin> {
    return this.resolveFeishuProfilePin(cliPath, authorizationAttemptId, false);
  }

  private async resolvePublishingProfilePin(
    cliPath: string,
  ): Promise<FeishuProfilePin> {
    return this.resolveFeishuProfilePin(cliPath, undefined, true);
  }

  private async resolveFeishuProfilePin(
    cliPath: string,
    authorizationAttemptId?: string,
    requireAccountOpenId = true,
  ): Promise<FeishuProfilePin> {
    const result = await this.run(
      ['whoami', '--json'],
      { command: cliPath, authorizationAttemptId },
    );
    this.assertSuccess(result);
    const payload = extractJson(result.stdout);
    const brand = findString(payload, ['brand'])?.toLowerCase() ?? '';
    const profile = findString(payload, ['profile']);
    if (brand !== FEISHU_CLI_BRAND || !profile) {
      throw new LarkCliError(
        '当前 CLI 不是可固定的中国版飞书配置；已停止远程操作。',
        result.code,
      );
    }
    return this.resolveFeishuProfilePinByName(
      cliPath,
      profile,
      authorizationAttemptId,
      requireAccountOpenId,
    );
  }

  private async resolveAuthorizationProfilePinByName(
    cliPath: string,
    profileName: string,
    authorizationAttemptId: string,
  ): Promise<FeishuProfilePin> {
    return this.resolveFeishuProfilePinByName(
      cliPath,
      profileName,
      authorizationAttemptId,
      false,
    );
  }

  private async resolvePublishingProfilePinByName(
    cliPath: string,
    profileName: string,
    authorizationAttemptId?: string,
  ): Promise<FeishuProfilePin> {
    return this.resolveFeishuProfilePinByName(
      cliPath,
      profileName,
      authorizationAttemptId,
      true,
    );
  }

  private async resolveFeishuProfilePinByName(
    cliPath: string,
    profileName: string,
    authorizationAttemptId?: string,
    requireAccountOpenId = true,
  ): Promise<FeishuProfilePin> {
    const profileStub: FeishuProfilePin = {
      profile: profileName,
      accountOpenId: null,
    };
    const result = await this.runWithFeishuProfile(
      ['auth', 'status', '--json'],
      profileStub,
      { command: cliPath, authorizationAttemptId },
    );
    this.assertSuccess(result);
    const status = (extractJson(result.stdout) ?? {}) as LarkAuthStatus;
    if (status.brand?.trim().toLowerCase() !== FEISHU_CLI_BRAND) {
      throw new LarkCliError(
        '当前固定配置不是中国版飞书（brand=feishu）；已停止远程操作。',
        result.code,
      );
    }
    const accountOpenId = status.identities?.user?.openId?.trim() || null;
    if (requireAccountOpenId && !accountOpenId) {
      throw new LarkCliError(
        '飞书 CLI 未返回可绑定的账号标识；已停止远程操作，请重新检查连接或重新授权。',
        result.code,
      );
    }
    return {
      profile: profileName,
      accountOpenId,
    };
  }

  private assertProfileMatchesCheckedConnection(profile: FeishuProfilePin): void {
    const checkedConnection = this.cachedConnectionState?.connected
      ? this.cachedConnectionState
      : null;
    if (checkedConnection && !checkedConnection.accountOpenId) {
      throw new LarkCliError(
        '上次飞书连接检查缺少账号标识；请重新检查连接后再同步。',
        null,
      );
    }
    if (
      checkedConnection?.accountOpenId
      && profile.accountOpenId !== checkedConnection.accountOpenId
    ) {
      throw new LarkCliError(
        '飞书账号在检查后已变化；请重新检查连接并确认。',
        null,
      );
    }
  }

  private runWithFeishuProfile(
    args: string[],
    profile: FeishuProfilePin,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const pinnedArgs = args.includes('--profile')
      ? args
      : [...args, '--profile', profile.profile];
    return this.run(pinnedArgs, options);
  }

  private runWithOptionalFeishuProfile(
    args: string[],
    profile: FeishuProfilePin | null,
    options: RunOptions = {},
  ): Promise<CommandResult> {
    return profile
      ? this.runWithFeishuProfile(args, profile, options)
      : this.run(args, options);
  }

  private async verifyReadCapabilities(
    capabilities: Record<FeishuCapabilityId, FeishuCapabilityState>,
    profile: FeishuProfilePin | null = null,
    authorizationAttemptId?: string,
  ): Promise<CapabilityVerificationResult> {
    const cliPath = this.requireCli();
    const verified = { ...capabilities };
    let failureKind: CapabilityVerificationFailureKind | null = null;
    for (const id of PUBLISHING_CAPABILITY_IDS) {
      if (!verified[id].granted) continue;
      const result = await this.runWithOptionalFeishuProfile([
        'auth',
        'check',
        '--scope',
        REQUIRED_SCOPES[id].join(' '),
        '--json',
      ], profile, { command: cliPath, authorizationAttemptId });
      if (result.code === 0) {
        verified[id] = { ...verified[id], verified: true };
        continue;
      }
      const error = parseCliError(result);
      if (error.consoleUrl) throw error;
      const currentFailureKind = classifyCapabilityVerificationFailure(result, error);
      if (failureKind !== 'authorization') failureKind = currentFailureKind;
      verified[id] = {
        ...verified[id],
        verified: false,
        error: error.message,
      };
    }
    return { capabilities: verified, failureKind };
  }

  private capabilitiesForScopes(
    grantedScopes: Set<string>,
  ): Record<FeishuCapabilityId, FeishuCapabilityState> {
    return {
      im: createCapability('im', REQUIRED_SCOPES.im.every(scope => grantedScopes.has(scope))),
      docs: createCapability('docs', REQUIRED_SCOPES.docs.every(scope => grantedScopes.has(scope))),
      base: createCapability('base', REQUIRED_SCOPES.base.every(scope => grantedScopes.has(scope))),
      calendar: createCapability(
        'calendar',
        REQUIRED_SCOPES.calendar.every(scope => grantedScopes.has(scope)),
      ),
      drive: createCapability(
        'drive',
        REQUIRED_SCOPES.drive.every(scope => grantedScopes.has(scope)),
      ),
    };
  }

  private async readGrantedScopes(
    cliPath: string,
    profile: FeishuProfilePin | null = null,
    authorizationAttemptId?: string,
  ): Promise<Set<string>> {
    const statusResult = await this.runWithOptionalFeishuProfile(
      buildLarkAuthStatusArgs(),
      profile,
      { command: cliPath, authorizationAttemptId },
    );
    this.assertSuccess(statusResult);
    const status = (extractJson(statusResult.stdout) ?? {}) as LarkAuthStatus;
    return scopesForStatus(status);
  }

  private async findFolder(
    cliPath: string,
    profile: FeishuProfilePin,
    folderName: string,
  ): Promise<FeishuFolderResult | null> {
    const search = await this.runWithFeishuProfile([
      'drive',
      '+search',
      '--as',
      'user',
      '--query',
      folderName,
      '--doc-types',
      'folder',
      '--only-title',
      '--page-size',
      '20',
      '--json',
    ], profile, { command: cliPath });
    this.assertSuccess(search);
    const results = findArray(extractJson(search.stdout), ['results']);
    for (const result of results) {
      const title = findString(result, ['title', 'name']);
      const docType = findString(result, ['doc_type', 'type']);
      if (title !== folderName || docType?.toLowerCase() !== 'folder') continue;
      const folderToken = findString(result, ['folder_token', 'token', 'obj_token']);
      if (folderToken) {
        return {
          folderToken,
          url: findString(result, ['url']),
        };
      }
    }
    return null;
  }

  private readAuthorizationRecord(): LarkAuthorizationRecord | null {
    const record = readJsonFile<unknown>(
      larkCliAuthorizationRecordPath(this.env),
      null,
    );
    return isValidLarkAuthorizationRecord(record) ? record : null;
  }

  private requireCli(): string {
    return this.resolvedCliPath ?? this.discoverCli().path
      ?? (() => { throw new LarkCliError('未安装飞书 CLI。', null); })();
  }

  private buildSearchEnv(): NodeJS.ProcessEnv {
    return {
      ...this.env,
      PATH: [
        this.env.PATH ?? '',
        path.join(os.homedir(), '.npm-global', 'bin'),
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.volta', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ].join(path.delimiter),
    };
  }

  private emitProgress(progress: FeishuAuthProgress): void {
    this.emit('progress', progress);
  }

  private assertSuccess(result: CommandResult): void {
    if (result.code === 0) return;
    if (result.cancelled || this.cancelled) {
      throw new LarkCliError('飞书操作已取消。', result.code);
    }
    throw parseCliError(result);
  }

  private run(args: string[], options: RunOptions = {}): Promise<CommandResult> {
    const command = options.command ?? this.requireCli();
    const env = options.env ?? this.buildSearchEnv();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cancelled = false;
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.activeChildren.add(child);
      const authorizationAttemptId = options.authorizationAttemptId;
      if (authorizationAttemptId) {
        const children = this.authorizationChildren.get(authorizationAttemptId)
          ?? new Set<ChildProcess>();
        children.add(child);
        this.authorizationChildren.set(authorizationAttemptId, children);
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const append = (current: string, chunk: Buffer | string): string => {
        if (current.length >= MAX_CAPTURE_CHARS) return current;
        return (current + String(chunk)).slice(0, MAX_CAPTURE_CHARS);
      };
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.activeChildren.delete(child);
        if (authorizationAttemptId) {
          const children = this.authorizationChildren.get(authorizationAttemptId);
          children?.delete(child);
          if (children?.size === 0) this.authorizationChildren.delete(authorizationAttemptId);
        }
        resolve({
          code,
          stdout,
          stderr,
          cancelled: this.cancelled,
          timedOut,
        });
      };
      const timer = window.setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout?.on('data', (chunk: unknown) => {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
        stdout = append(stdout, chunk);
        options.onOutput?.(String(chunk));
      });
      child.stderr?.on('data', (chunk: unknown) => {
        if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
        stderr = append(stderr, chunk);
        options.onOutput?.(String(chunk));
      });
      child.on('error', (error) => {
        stderr = append(stderr, JSON.stringify({ message: error.message }));
        finish(null);
      });
      child.on('close', code => finish(code));
      if (options.input !== undefined) {
        child.stdin?.end(options.input);
      } else {
        child.stdin?.end();
      }
    });
  }
}
