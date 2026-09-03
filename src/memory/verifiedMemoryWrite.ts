import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';

import { defaultMemoryctlPath } from './memoryctlPath';
import { AGENT_MEMORY_RUNTIME_API_VERSION } from './verifiedMemory';
import {
  AiluMemoryRuntimeHandshakeError,
  ailuMemoryRuntimeGateFor,
  type AiluMemoryRuntimeGateLike,
} from './runtimeHandshake';
import { AILU_IDS } from '../ids';

export const AILU_MEMORY_WRITE_ACTOR = AILU_IDS.memoryActor;
export const AILU_MEMORY_WRITE_APP_ID = AILU_IDS.memoryAppId;
export const AILU_MEMORY_WRITE_PROJECT_ID = AILU_IDS.memoryProjectId;

const DEFAULT_PREPARE_TIMEOUT_MS = 90_000;
const DEFAULT_APPLY_TIMEOUT_MS = 360_000;
const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TARGET_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const MAX_PROPOSAL_BYTES = 2 * 1_024 * 1_024;
const MAX_TARGET_BYTES = 2 * 1_024 * 1_024;

export type MemoryWriteOperation = 'read-target' | 'prepare' | 'apply' | 'cancel';
export type MemoryWriteAction = 'ADD' | 'UPDATE' | 'NOOP' | 'MERGE_REQUIRED';
export type MemorySourceClass =
  | 'user_direct'
  | 'manual_edit'
  | 'local_verified'
  | 'external_untrusted'
  | 'agent_inferred'
  | 'unknown';
export type MemoryKnowledgeKind = 'fact' | 'preference' | 'rule' | 'inference' | 'hypothesis';
export type MemoryAsserter = 'user' | 'claude' | 'codex' | 'pi';

export interface MemoryWriteCandidate {
  relativePath: string;
  sha256: string;
  candidateRef: string;
}

interface PrepareBase {
  operation: 'prepare';
  action: MemoryWriteAction;
  targetRelativePath: string;
  proposalRawSha256: string;
  proposalCanonicalSha256: string;
  proposalSizeBytes: number;
  candidates: MemoryWriteCandidate[];
  warnings: string[];
}

export interface PreparedMemoryWrite extends PrepareBase {
  status: 'prepared';
  action: 'ADD' | 'UPDATE';
  proposalId: string;
  fencingToken: number;
  baseExists: boolean;
  baseRawSha256: string;
  baseCanonicalSha256: string;
  baseGitHead: string;
  expiresAt: string;
  confirmationRequired: true;
  recommendationMetrics: {
    similarity: number;
    coverage: number;
    rawSemanticDistance: number | null;
  };
}

export interface NoopMemoryWrite extends PrepareBase {
  status: 'noop';
  action: 'NOOP';
  confirmationRequired: false;
}

export interface MergeRequiredMemoryWrite extends PrepareBase {
  status: 'merge_required';
  action: 'MERGE_REQUIRED';
  confirmationRequired: false;
  reasonCode: string;
}

export type MemoryWritePrepareResult =
  | PreparedMemoryWrite
  | NoopMemoryWrite
  | MergeRequiredMemoryWrite;

export interface AppliedMemoryWrite {
  operation: 'apply';
  status: 'applied';
  proposalId: string;
  fencingToken: number;
  action: 'ADD' | 'UPDATE';
  targetRelativePath: string;
  proposalRawSha256: string;
  proposalCanonicalSha256: string;
  receiptId: string;
  gitCommit: string;
  completedAt: string;
  idempotent: boolean;
}

export interface CancelledMemoryWrite {
  operation: 'cancel';
  status: 'cancelled';
  proposalId: string;
  fencingToken: number;
  idempotent: boolean;
}

export interface MemoryWriteTarget {
  operation: 'read-target';
  status: 'found' | 'missing';
  targetRelativePath: string;
  exists: boolean;
  content: string;
  rawSha256: string;
  canonicalSha256: string;
  sizeBytes: number;
  gitHead: string;
  readToken: string;
  projectId: string;
}

export interface MemoryWritePrepareInput {
  summary: string;
  proposalMarkdown: string;
  readTarget: MemoryWriteTarget;
  sourceClass: MemorySourceClass;
  knowledgeKind: MemoryKnowledgeKind;
  assertedBy: MemoryAsserter;
  evidenceReference?: string;
  currentProject?: string;
  ttlHours?: number;
}

export interface MemoryWriteApplyInput {
  proposalMarkdown: string;
  confirmationReference: string;
}

export type MemoryWriteServiceState =
  | { status: 'idle' }
  | {
    status: 'queued';
    operation: MemoryWriteOperation;
    proposalId?: string;
    targetRelativePath?: string;
  }
  | { status: 'reading_target'; targetRelativePath: string }
  | { status: 'preparing' }
  | { status: 'applying'; proposalId: string }
  | { status: 'cancelling'; proposalId: string }
  | { status: 'prepared'; result: PreparedMemoryWrite }
  | { status: 'noop'; result: NoopMemoryWrite }
  | { status: 'merge_required'; result: MergeRequiredMemoryWrite }
  | { status: 'applied'; result: AppliedMemoryWrite }
  | { status: 'cancelled'; result: CancelledMemoryWrite }
  | { status: 'target_read'; result: MemoryWriteTarget }
  | { status: 'shutting_down'; pendingProposalIds: string[] }
  | { status: 'shutdown' }
  | { status: 'blocked'; operation: MemoryWriteOperation; error: MemoryWriteError };

export interface MemoryWriteTransportRequest {
  executablePath: string;
  args: string[];
  stdin: string;
  sessionId: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface MemoryWriteTransportResponse {
  exitCode: number;
  stdout: string;
}

export interface VerifiedMemoryWriteServiceOptions {
  executablePath?: string;
  sessionId?: string;
  prepareTimeoutMs?: number;
  applyTimeoutMs?: number;
  cancelTimeoutMs?: number;
  readTargetTimeoutMs?: number;
  maxOutputBytes?: number;
  transport?: (request: MemoryWriteTransportRequest) => Promise<MemoryWriteTransportResponse>;
  runtimeGate?: AiluMemoryRuntimeGateLike;
}

type StateListener = (state: MemoryWriteServiceState) => void;

interface PendingApplyRecovery {
  prepared: PreparedMemoryWrite;
  input: MemoryWriteApplyInput;
}

let globalWriteQueue: Promise<void> = Promise.resolve();

export class MemoryWriteError extends Error {
  readonly code: string;
  readonly operation: MemoryWriteOperation;
  readonly retryable: boolean;

  constructor(
    code: string,
    operation: MemoryWriteOperation,
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'MemoryWriteError';
    this.code = safeReasonCode(code) || 'WRITE_PROTOCOL_ERROR';
    this.operation = operation;
    this.retryable = retryable;
  }
}

export class VerifiedMemoryWriteService {
  private readonly executablePath: string;
  private readonly sessionId: string;
  private readonly prepareTimeoutMs: number;
  private readonly applyTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly readTargetTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly transport: NonNullable<VerifiedMemoryWriteServiceOptions['transport']>;
  private readonly runtimeGate: AiluMemoryRuntimeGateLike;
  private readonly listeners = new Set<StateListener>();
  private readonly pendingPreparedIds = new Set<string>();
  private readonly pendingFencingTokens = new Map<string, number>();
  private readonly attemptedProposalIds = new Set<string>();
  private readonly pendingApplyRecovery = new Map<string, PendingApplyRecovery>();
  private instanceQueue: Promise<void> = Promise.resolve();
  private accepting = true;
  private shutdownPromise: Promise<void> | null = null;
  private state: MemoryWriteServiceState = { status: 'idle' };

  constructor(options: VerifiedMemoryWriteServiceOptions = {}) {
    this.executablePath = options.executablePath ?? defaultMemoryctlPath();
    this.sessionId = options.sessionId ?? `ailu-${randomUUID()}`;
    this.prepareTimeoutMs = boundedTimeout(options.prepareTimeoutMs, DEFAULT_PREPARE_TIMEOUT_MS);
    this.applyTimeoutMs = boundedTimeout(options.applyTimeoutMs, DEFAULT_APPLY_TIMEOUT_MS);
    this.cancelTimeoutMs = boundedTimeout(options.cancelTimeoutMs, DEFAULT_CANCEL_TIMEOUT_MS);
    this.readTargetTimeoutMs = boundedTimeout(
      options.readTargetTimeoutMs,
      DEFAULT_READ_TARGET_TIMEOUT_MS,
    );
    this.maxOutputBytes = boundedByteLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.transport = options.transport ?? runMemoryWriteProcess;
    this.runtimeGate = options.runtimeGate ?? ailuMemoryRuntimeGateFor(this.executablePath);
  }

  getState(): MemoryWriteServiceState {
    return cloneState(this.state);
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    try {
      listener(this.getState());
    } catch (error) {
      this.listeners.delete(listener);
      console.error('Ailu Agent Memory state listener failed.', error);
    }
    return () => this.listeners.delete(listener);
  }

  getPendingProposals(): Array<{
    proposalId: string;
    fencingToken: number;
    applyAttempted: boolean;
  }> {
    return [...this.pendingPreparedIds]
      .sort()
      .map(proposalId => ({
        proposalId,
        fencingToken: this.pendingFencingTokens.get(proposalId) ?? 0,
        applyAttempted: this.attemptedProposalIds.has(proposalId),
      }));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.accepting = false;
    const barrier = this.instanceQueue;
    const run = async (): Promise<void> => {
      this.setState({
        status: 'shutting_down',
        pendingProposalIds: [...this.pendingPreparedIds].sort(),
      });
      await barrier;
      for (const recovery of [...this.pendingApplyRecovery.values()]) {
        try {
          await this.cancelInternal(recovery.prepared.proposalId);
        } catch (error: unknown) {
          const normalized = normalizeWriteError(error, 'cancel');
          if (normalized.code === 'APPLY_RECOVERY_REQUIRED') {
            await this.applyInternal(recovery.prepared, recovery.input);
          } else if (normalized.code === 'INTENT_NOT_CANCELLABLE') {
            this.clearProposalTracking(recovery.prepared.proposalId);
          } else {
            throw normalized;
          }
        }
      }
      for (const proposalId of [...this.pendingPreparedIds]) {
        if (!this.attemptedProposalIds.has(proposalId)) {
          await this.cancelInternal(proposalId);
        }
      }
      this.setState({ status: 'shutdown' });
    };
    const promise = run();
    this.shutdownPromise = promise;
    void promise.catch(() => {
      if (this.shutdownPromise === promise) this.shutdownPromise = null;
    });
    return promise;
  }

  readTarget(targetRelativePath: string, requestedProjectId?: string): Promise<MemoryWriteTarget> {
    if (!this.accepting) return Promise.reject(serviceShutdownError('read-target'));
    const target = safeRelativePath(targetRelativePath);
    if (!target) {
      return Promise.reject(new MemoryWriteError(
        'REQUEST_INVALID',
        'read-target',
        'Agent Memory 目标路径无效。',
      ));
    }
    let projectId: string;
    try {
      projectId = memoryProjectIdForTarget(target, requestedProjectId);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return this.enqueue('read-target', undefined, target, false, async () => {
      this.setState({ status: 'reading_target', targetRelativePath: target });
      const value = await this.invoke('read-target', {
        schema_version: AGENT_MEMORY_RUNTIME_API_VERSION,
        target_relative_path: target,
        app_id: AILU_MEMORY_WRITE_APP_ID,
        project_id: projectId,
      }, this.readTargetTimeoutMs);
      const result = parseTargetResult(value, projectId);
      this.setState({ status: 'target_read', result });
      return result;
    });
  }

  prepare(input: MemoryWritePrepareInput): Promise<MemoryWritePrepareResult> {
    if (!this.accepting) return Promise.reject(serviceShutdownError('prepare'));
    validatePrepareInput(input);
    return this.enqueue('prepare', undefined, undefined, true, async () => {
      this.setState({ status: 'preparing' });
      const value = await this.invoke('prepare', {
        schema_version: AGENT_MEMORY_RUNTIME_API_VERSION,
        summary: input.summary,
        proposal_markdown: input.proposalMarkdown,
        target_relative_path: input.readTarget.targetRelativePath,
        read_token: input.readTarget.readToken,
        app_id: AILU_MEMORY_WRITE_APP_ID,
        project_id: input.readTarget.projectId,
        source_class: input.sourceClass,
        knowledge_kind: input.knowledgeKind,
        asserted_by: input.assertedBy,
        evidence_ref: input.evidenceReference ?? '',
        current_project: input.currentProject
          ?? (input.readTarget.projectId || AILU_MEMORY_WRITE_PROJECT_ID),
        ...(input.ttlHours === undefined ? {} : { ttl_hours: input.ttlHours }),
      }, this.prepareTimeoutMs);
      const result = parsePrepareResult(value);
      validatePrepareTargetBinding(input.readTarget, result);
      validateProposalBinding(
        input.proposalMarkdown,
        result.proposalRawSha256,
        result.proposalCanonicalSha256,
        'prepare',
      );
      if (result.status === 'prepared') {
        this.pendingPreparedIds.add(result.proposalId);
        this.pendingFencingTokens.set(result.proposalId, result.fencingToken);
        this.setState({ status: 'prepared', result });
      }
      else if (result.status === 'noop') this.setState({ status: 'noop', result });
      else this.setState({ status: 'merge_required', result });
      return result;
    });
  }

  apply(
    prepared: PreparedMemoryWrite,
    input: MemoryWriteApplyInput,
  ): Promise<AppliedMemoryWrite> {
    if (!this.accepting) return Promise.reject(serviceShutdownError('apply'));
    validatePreparedWrite(prepared);
    validateApplyInput(input);
    validateProposalBinding(
      input.proposalMarkdown,
      prepared.proposalRawSha256,
      prepared.proposalCanonicalSha256,
      'apply',
    );
    return this.applyInternal(prepared, input);
  }

  private applyInternal(
    prepared: PreparedMemoryWrite,
    input: MemoryWriteApplyInput,
  ): Promise<AppliedMemoryWrite> {
    const boundFencingToken = this.pendingFencingTokens.get(prepared.proposalId);
    if (boundFencingToken !== undefined && boundFencingToken !== prepared.fencingToken) {
      return Promise.reject(new MemoryWriteError(
        'FENCING_TOKEN_MISMATCH',
        'apply',
        'Agent Memory 提案已绑定不同的 fencing token。',
      ));
    }
    this.pendingPreparedIds.add(prepared.proposalId);
    this.pendingFencingTokens.set(prepared.proposalId, prepared.fencingToken);
    this.attemptedProposalIds.add(prepared.proposalId);
    const recovery: PendingApplyRecovery = {
      prepared: clonePreparedWrite(prepared),
      input: { ...input },
    };
    this.pendingApplyRecovery.set(prepared.proposalId, recovery);
    return this.enqueue('apply', prepared.proposalId, undefined, true, async () => {
      this.setState({ status: 'applying', proposalId: prepared.proposalId });
      const value = await this.invoke('apply', {
        schema_version: AGENT_MEMORY_RUNTIME_API_VERSION,
        proposal_id: prepared.proposalId,
        fencing_token: prepared.fencingToken,
        target_relative_path: prepared.targetRelativePath,
        proposal_markdown: input.proposalMarkdown,
        proposal_raw_sha256: prepared.proposalRawSha256,
        proposal_canonical_sha256: prepared.proposalCanonicalSha256,
        confirmed_by: 'user',
        confirmation_reference: input.confirmationReference,
      }, this.applyTimeoutMs);
      const result = parseAppliedResult(value);
      if (result.proposalId !== prepared.proposalId
        || result.fencingToken !== prepared.fencingToken
        || result.action !== prepared.action
        || result.targetRelativePath !== prepared.targetRelativePath
        || result.proposalRawSha256 !== prepared.proposalRawSha256
        || result.proposalCanonicalSha256 !== prepared.proposalCanonicalSha256) {
        throw new MemoryWriteError(
          'APPLY_BINDING_MISMATCH',
          'apply',
          'Agent Memory 写入回执与已确认提案的绑定信息不匹配。',
        );
      }
      this.clearProposalTracking(prepared.proposalId);
      this.setState({ status: 'applied', result });
      return result;
    });
  }

  cancel(proposalId: string): Promise<CancelledMemoryWrite> {
    if (!this.accepting) return Promise.reject(serviceShutdownError('cancel'));
    if (!isProposalId(proposalId)) {
      return Promise.reject(new MemoryWriteError(
        'REQUEST_INVALID',
        'cancel',
        'Agent Memory 提案 ID 无效。',
      ));
    }
    return this.cancelInternal(proposalId);
  }

  private cancelInternal(proposalId: string): Promise<CancelledMemoryWrite> {
    const fencingToken = this.pendingFencingTokens.get(proposalId);
    if (!safePositiveInteger(fencingToken)) {
      return Promise.reject(new MemoryWriteError(
        'FENCING_TOKEN_REQUIRED',
        'cancel',
        'Agent Memory 取消操作缺少已绑定的 fencing token。',
      ));
    }
    return this.enqueue('cancel', proposalId, undefined, true, async () => {
      this.setState({ status: 'cancelling', proposalId });
      const value = await this.invoke('cancel', {
        schema_version: AGENT_MEMORY_RUNTIME_API_VERSION,
        proposal_id: proposalId,
        fencing_token: fencingToken,
      }, this.cancelTimeoutMs);
      const result = parseCancelledResult(value);
      if (result.proposalId !== proposalId || result.fencingToken !== fencingToken) {
        throw new MemoryWriteError(
          'CANCEL_BINDING_MISMATCH',
          'cancel',
          'Agent Memory 取消回执与已绑定提案不匹配。',
        );
      }
      this.clearProposalTracking(proposalId);
      this.setState({ status: 'cancelled', result });
      return result;
    });
  }

  private enqueue<T>(
    operation: MemoryWriteOperation,
    proposalId: string | undefined,
    targetRelativePath: string | undefined,
    globallySerialized: boolean,
    task: () => Promise<T>,
  ): Promise<T> {
    this.setState({
      status: 'queued',
      operation,
      ...(proposalId ? { proposalId } : {}),
      ...(targetRelativePath ? { targetRelativePath } : {}),
    });
    const result = this.instanceQueue.then(() => {
      if (!globallySerialized) return task();
      const globalResult = globalWriteQueue.then(task, task);
      globalWriteQueue = globalResult.then(() => undefined, () => undefined);
      return globalResult;
    });
    this.instanceQueue = result.then(() => undefined, () => undefined);
    return result.catch((error: unknown) => {
      const normalized = normalizeWriteError(error, operation);
      this.setState({ status: 'blocked', operation, error: normalized });
      throw normalized;
    });
  }

  private async invoke(
    operation: MemoryWriteOperation,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    await this.runtimeGate.assertReady();
    await access(this.executablePath);
    const request: MemoryWriteTransportRequest = {
      executablePath: this.executablePath,
      args: memoryWriteArgs(operation),
      stdin: JSON.stringify(payload),
      sessionId: this.sessionId,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    };
    const response = await this.transport(request);
    const parsed = parseProtocolResponse(response.stdout, operation);
    if (parsed.ok !== true) throw errorFromProtocol(parsed, operation);
    if (response.exitCode !== 0) {
      throw new MemoryWriteError(
        'WRITE_PROCESS_FAILED',
        operation,
        'Agent Memory 写入进程未正常完成。',
        true,
      );
    }
    return parsed;
  }

  private setState(state: MemoryWriteServiceState): void {
    this.state = cloneState(state);
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (error) {
        console.error('Ailu Agent Memory state listener failed.', error);
      }
    }
  }

  private clearProposalTracking(proposalId: string): void {
    this.pendingPreparedIds.delete(proposalId);
    this.pendingFencingTokens.delete(proposalId);
    this.attemptedProposalIds.delete(proposalId);
    this.pendingApplyRecovery.delete(proposalId);
  }
}

export function memoryWriteArgs(operation: MemoryWriteOperation): string[] {
  return [
    '--actor', AILU_MEMORY_WRITE_ACTOR,
    'write', operation,
    '--json',
  ];
}

export function runMemoryWriteProcess(
  request: MemoryWriteTransportRequest,
): Promise<MemoryWriteTransportResponse> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.CODEX_THREAD_ID;
    delete environment.CLAUDE_SESSION_ID;
    delete environment.CLAUDE_CODE_SESSION_ID;
    environment.AGENT_MEMORY_SESSION_ID = request.sessionId;
    const detached = process.platform !== 'win32';
    const child = spawn(request.executablePath, request.args, {
      detached,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    let childClosed = false;
    let terminationError: Error | null = null;
    let timeoutTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    let groupPollTimer: ReturnType<typeof nodeSetTimeout> | null = null;
    const finish = (value?: MemoryWriteTransportResponse, error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) nodeClearTimeout(timeoutTimer);
      if (forceKillTimer) nodeClearTimeout(forceKillTimer);
      if (groupPollTimer) nodeClearTimeout(groupPollTimer);
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Agent Memory 写入进程异常结束。'));
    };
    const processGroupAlive = (): boolean => {
      if (!detached || !child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signalProcess = (signal: NodeJS.Signals): void => {
      if (child.pid && detached) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      } else {
        child.kill(signal);
      }
    };
    const finishAfterGroupExit = (): void => {
      if (!terminationError || !childClosed || settled) return;
      if (!processGroupAlive()) {
        finish(undefined, terminationError);
        return;
      }
      groupPollTimer = nodeSetTimeout(finishAfterGroupExit, 25);
    };
    const terminate = (error: Error): void => {
      if (terminationError || settled) return;
      terminationError = error;
      if (timeoutTimer) nodeClearTimeout(timeoutTimer);
      signalProcess('SIGTERM');
      forceKillTimer = nodeSetTimeout(() => {
        signalProcess('SIGKILL');
        finishAfterGroupExit();
      }, 1_000);
      if (childClosed) finishAfterGroupExit();
    };
    timeoutTimer = nodeSetTimeout(() => {
      terminate(new MemoryWriteError(
        'WRITE_PROCESS_TIMEOUT',
        operationFromArgs(request.args),
        'Agent Memory 写入超时。',
        true,
      ));
    }, request.timeoutMs);
    timeoutTimer.unref?.();
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (terminationError) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout, 'utf8') > request.maxOutputBytes) {
        stdout = '';
        terminate(new MemoryWriteError(
          'WRITE_RESPONSE_TOO_LARGE',
          operationFromArgs(request.args),
          'Agent Memory 返回数据过大。',
        ));
      }
    });
    child.stderr?.resume();
    child.stdin?.on('error', () => {});
    child.on('error', () => finish(undefined, new MemoryWriteError(
      'WRITE_PROCESS_START_FAILED',
      operationFromArgs(request.args),
      '无法启动 Agent Memory 写入进程。',
      true,
    )));
    child.on('close', code => {
      if (settled) return;
      childClosed = true;
      if (terminationError) {
        finishAfterGroupExit();
        return;
      }
      if (processGroupAlive()) {
        terminate(new MemoryWriteError(
          'WRITE_PROCESS_TREE_REMAINED',
          operationFromArgs(request.args),
          'Agent Memory 命令结束后仍有后台进程，已停止并拒绝本次结果。',
          true,
        ));
        return;
      }
      finish({ exitCode: code ?? 2, stdout });
    });
    child.stdin?.end(request.stdin, 'utf8');
  });
}

function parseProtocolResponse(
  output: string,
  operation: MemoryWriteOperation,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      operation,
      'Agent Memory 返回了无效数据。',
    );
  }
  if (!isRecord(value)
    || value.schema_version !== AGENT_MEMORY_RUNTIME_API_VERSION
    || value.stage !== operation
    || typeof value.ok !== 'boolean') {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      operation,
      'Agent Memory 返回格式不受支持。',
    );
  }
  return value;
}

function errorFromProtocol(
  value: Record<string, unknown>,
  operation: MemoryWriteOperation,
): MemoryWriteError {
  return new MemoryWriteError(
    safeReasonCode(value.reason_code) || 'WRITE_BLOCKED',
    operation,
    safeString(value.message, 240) || 'Agent Memory 已停止本次写入。',
    value.retryable === true,
  );
}

function parsePrepareResult(value: Record<string, unknown>): MemoryWritePrepareResult {
  const status = safeString(value.status, 40);
  const action = safeAction(value.recommended_action);
  const base = parsePrepareBase(value, action);
  if (status === 'prepared' && (action === 'ADD' || action === 'UPDATE')) {
    const proposalId = safeString(value.proposal_id, 64);
    const baseRawSha256 = safeSha256(value.base_raw_sha256);
    const baseCanonicalSha256 = safeSha256(value.base_canonical_sha256);
    const baseGitHead = safeGitHead(value.base_git_head);
    const fencingToken = safePositiveInteger(value.fencing_token);
    if (!isProposalId(proposalId) || !baseRawSha256 || !baseCanonicalSha256
      || !baseGitHead || !fencingToken) {
      throw new MemoryWriteError(
        'WRITE_PROTOCOL_INVALID',
        'prepare',
        'Agent Memory 提案绑定信息不完整。',
      );
    }
    const metrics = isRecord(value.recommendation_metrics) ? value.recommendation_metrics : {};
    return {
      ...base,
      status: 'prepared',
      action,
      proposalId,
      fencingToken,
      baseExists: value.base_exists === true,
      baseRawSha256,
      baseCanonicalSha256,
      baseGitHead,
      expiresAt: safeString(value.expires_at, 80),
      confirmationRequired: true,
      recommendationMetrics: {
        similarity: safeNumber(metrics.similarity),
        coverage: safeNumber(metrics.coverage),
        rawSemanticDistance: metrics.raw_semantic_distance === null
          ? null
          : safeNullableNumber(metrics.raw_semantic_distance),
      },
    };
  }
  if (status === 'noop' && action === 'NOOP') {
    return { ...base, status: 'noop', action, confirmationRequired: false };
  }
  if (status === 'merge_required' && action === 'MERGE_REQUIRED') {
    return {
      ...base,
      status: 'merge_required',
      action,
      confirmationRequired: false,
      reasonCode: safeReasonCode(value.reason_code) || 'MERGE_REQUIRED',
    };
  }
  throw new MemoryWriteError(
    'WRITE_PROTOCOL_INVALID',
    'prepare',
    'Agent Memory 返回了未知的准备状态。',
  );
}

function parsePrepareBase(
  value: Record<string, unknown>,
  action: MemoryWriteAction,
): PrepareBase {
  const proposalRawSha256 = safeSha256(value.proposal_raw_sha256);
  const proposalCanonicalSha256 = safeSha256(value.proposal_canonical_sha256);
  if (!proposalRawSha256 || !proposalCanonicalSha256) {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      'prepare',
      'Agent Memory 提案哈希无效。',
    );
  }
  return {
    operation: 'prepare',
    action,
    targetRelativePath: safeRelativePath(value.target_relative_path),
    proposalRawSha256,
    proposalCanonicalSha256,
    proposalSizeBytes: safeNonNegativeInteger(value.proposal_size_bytes),
    candidates: Array.isArray(value.candidates)
      ? value.candidates.slice(0, 10).flatMap(parseCandidate)
      : [],
    warnings: Array.isArray(value.warnings)
      ? value.warnings.slice(0, 20).flatMap(item => {
        const warning = safeReasonCode(item);
        return warning ? [warning] : [];
      })
      : [],
  };
}

function parseCandidate(value: unknown): MemoryWriteCandidate[] {
  if (!isRecord(value)) return [];
  const relativePath = safeRelativePath(value.relative_path);
  const sha256 = safeSha256(value.sha256);
  const candidateRef = safeString(value.candidate_ref, 40);
  if (!relativePath || !sha256 || !/^[a-f0-9]{12,40}$/.test(candidateRef)) return [];
  return [{ relativePath, sha256, candidateRef }];
}

function parseAppliedResult(value: Record<string, unknown>): AppliedMemoryWrite {
  const action = safeAction(value.recommended_action);
  const proposalId = safeString(value.proposal_id, 64);
  const targetRelativePath = safeRelativePath(value.target_relative_path);
  const proposalRawSha256 = safeSha256(value.proposal_raw_sha256);
  const proposalCanonicalSha256 = safeSha256(value.proposal_canonical_sha256);
  const receiptId = safeString(value.receipt_id, 64);
  const gitCommit = safeGitHead(value.git_commit);
  const fencingToken = safePositiveInteger(value.fencing_token);
  if (value.status !== 'applied' || (action !== 'ADD' && action !== 'UPDATE')
    || !isProposalId(proposalId) || !targetRelativePath || !proposalRawSha256
    || !proposalCanonicalSha256 || !/^[a-f0-9]{32,64}$/.test(receiptId)
    || !gitCommit || !fencingToken) {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      'apply',
      'Agent Memory 写入回执无效。',
    );
  }
  return {
    operation: 'apply',
    status: 'applied',
    proposalId,
    fencingToken,
    action,
    targetRelativePath,
    proposalRawSha256,
    proposalCanonicalSha256,
    receiptId,
    gitCommit,
    completedAt: safeString(value.completed_at, 80),
    idempotent: value.idempotent === true,
  };
}

function parseCancelledResult(value: Record<string, unknown>): CancelledMemoryWrite {
  const proposalId = safeString(value.proposal_id, 64);
  const fencingToken = safePositiveInteger(value.fencing_token);
  if (value.status !== 'cancelled' || !isProposalId(proposalId) || !fencingToken) {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      'cancel',
      'Agent Memory 取消回执无效。',
    );
  }
  return {
    operation: 'cancel',
    status: 'cancelled',
    proposalId,
    fencingToken,
    idempotent: value.idempotent === true,
  };
}

function parseTargetResult(value: Record<string, unknown>, projectId: string): MemoryWriteTarget {
  const status = value.status;
  const targetRelativePath = safeRelativePath(value.target_relative_path);
  const content = typeof value.content === 'string' ? value.content : null;
  const rawSha256 = safeSha256(value.base_raw_sha256);
  const canonicalSha256 = safeSha256(value.base_canonical_sha256);
  const gitHead = safeGitHead(value.base_git_head);
  const readToken = safeSha256(value.read_token);
  const contentSize = content === null ? -1 : Buffer.byteLength(content, 'utf8');
  if ((status !== 'found' && status !== 'missing') || !targetRelativePath
    || content === null || contentSize > MAX_TARGET_BYTES || value.size_bytes !== contentSize
    || !rawSha256 || !canonicalSha256 || !gitHead || !readToken
    || value.base_exists !== (status === 'found')
    || (status === 'missing' && content !== '')
    || sha256(content) !== rawSha256
    || sha256(canonicalizeMemoryText(content)) !== canonicalSha256) {
    throw new MemoryWriteError(
      'WRITE_PROTOCOL_INVALID',
      'read-target',
      'Agent Memory 目标读取回执无效。',
    );
  }
  return {
    operation: 'read-target',
    status,
    targetRelativePath,
    exists: value.base_exists,
    content,
    rawSha256,
    canonicalSha256,
    sizeBytes: contentSize,
    gitHead,
    readToken,
    projectId,
  };
}

function validatePrepareInput(input: MemoryWritePrepareInput): void {
  if (!input.summary.trim() || input.summary.length > 2_400
    || !input.proposalMarkdown || Buffer.byteLength(input.proposalMarkdown, 'utf8') > MAX_PROPOSAL_BYTES
    || !isValidMemoryWriteTarget(input.readTarget)
    || (input.ttlHours !== undefined && (!Number.isFinite(input.ttlHours) || input.ttlHours <= 0))) {
    throw new MemoryWriteError(
      'REQUEST_INVALID',
      'prepare',
      '正式记忆提案信息不完整。',
    );
  }
}

function validatePrepareTargetBinding(
  target: MemoryWriteTarget,
  result: MemoryWritePrepareResult,
): void {
  if (result.status !== 'prepared') return;
  if (result.targetRelativePath !== target.targetRelativePath) {
    throw new MemoryWriteError(
      'TARGET_BINDING_MISMATCH',
      'prepare',
      'Agent Memory 检查结果与刚才读取的目标不一致。',
    );
  }
  if (
    result.baseExists !== target.exists
    || result.baseRawSha256 !== target.rawSha256
    || result.baseCanonicalSha256 !== target.canonicalSha256
    || result.baseGitHead !== target.gitHead
  ) {
    throw new MemoryWriteError(
      'BASE_BINDING_MISMATCH',
      'prepare',
      'Agent Memory 目标在检查期间发生了变化。',
      true,
    );
  }
}

function isValidMemoryWriteTarget(target: MemoryWriteTarget | undefined): target is MemoryWriteTarget {
  return Boolean(target
    && target.operation === 'read-target'
    && (target.status === 'found' || target.status === 'missing')
    && safeRelativePath(target.targetRelativePath)
    && safeSha256(target.rawSha256)
    && safeSha256(target.canonicalSha256)
    && safeGitHead(target.gitHead)
    && safeSha256(target.readToken)
    && Boolean(safeProjectId(target.projectId))
    && target.projectId !== 'shared'
    && !target.projectId.includes(',')
    && target.exists === (target.status === 'found'));
}

function memoryProjectIdForTarget(
  targetRelativePath: string,
  requestedProjectId: string | undefined,
): string {
  if (targetRelativePath.startsWith('用户记忆/')) return 'global';
  const requested = safeProjectId(requestedProjectId);
  if (requested === 'global') {
    throw new MemoryWriteError(
      'GLOBAL_TARGET_FORBIDDEN',
      'read-target',
      'global 仅可用于用户记忆/目录；项目或工作流必须填写实际 project_id。',
    );
  }
  if (requested && requested !== 'shared' && !requested.includes(',')) {
    return requested;
  }
  if (targetRelativePath === AILU_IDS.memoryProjectPath) return AILU_MEMORY_WRITE_PROJECT_ID;
  throw new MemoryWriteError(
    'PROJECT_ID_REQUIRED',
    'read-target',
    '写入非 Ailu 项目记忆时必须明确填写实际 project_id。',
  );
}

function safeProjectId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/.test(normalized) ? normalized : '';
}

function validatePreparedWrite(prepared: PreparedMemoryWrite): void {
  if (prepared.status !== 'prepared' || (prepared.action !== 'ADD' && prepared.action !== 'UPDATE')
    || !isProposalId(prepared.proposalId) || !safeRelativePath(prepared.targetRelativePath)
    || !safeSha256(prepared.proposalRawSha256)
    || !safeSha256(prepared.proposalCanonicalSha256)
    || !safePositiveInteger(prepared.fencingToken)) {
    throw new MemoryWriteError(
      'REQUEST_INVALID',
      'apply',
      '准备结果无效，不能写入正式记忆。',
    );
  }
}

function validateApplyInput(input: MemoryWriteApplyInput): void {
  if (!input.proposalMarkdown
    || Buffer.byteLength(input.proposalMarkdown, 'utf8') > MAX_PROPOSAL_BYTES
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,511}$/.test(input.confirmationReference)) {
    throw new MemoryWriteError(
      'CONFIRMATION_INVALID',
      'apply',
      '确认记录或提案正文无效。',
    );
  }
}

function validateProposalBinding(
  proposalMarkdown: string,
  rawSha256: string,
  canonicalSha256: string,
  operation: 'prepare' | 'apply',
): void {
  if (sha256(proposalMarkdown) !== rawSha256
    || sha256(canonicalizeMemoryText(proposalMarkdown)) !== canonicalSha256) {
    throw new MemoryWriteError(
      'PROPOSAL_HASH_MISMATCH',
      operation,
      'Agent Memory 提案内容与绑定哈希不一致。',
    );
  }
}

function normalizeWriteError(error: unknown, operation: MemoryWriteOperation): MemoryWriteError {
  if (error instanceof MemoryWriteError) return error;
  if (error instanceof AiluMemoryRuntimeHandshakeError) {
    return new MemoryWriteError(error.code, operation, error.message, true);
  }
  return new MemoryWriteError(
    'WRITE_UNAVAILABLE',
    operation,
    'Agent Memory 写入暂时不可用。',
    true,
  );
}

function serviceShutdownError(operation: MemoryWriteOperation): MemoryWriteError {
  return new MemoryWriteError(
    'WRITE_SERVICE_SHUTDOWN',
    operation,
    'Agent Memory 写入服务已进入关闭流程。',
  );
}

function clonePreparedWrite(prepared: PreparedMemoryWrite): PreparedMemoryWrite {
  return {
    ...prepared,
    candidates: prepared.candidates.map(candidate => ({ ...candidate })),
    warnings: [...prepared.warnings],
    recommendationMetrics: { ...prepared.recommendationMetrics },
  };
}

function cloneState(state: MemoryWriteServiceState): MemoryWriteServiceState {
  if (state.status === 'blocked') return { ...state, error: state.error };
  if (state.status === 'shutting_down') {
    return { ...state, pendingProposalIds: [...state.pendingProposalIds] };
  }
  if ('result' in state) {
    return {
      ...state,
      result: {
        ...state.result,
        ...('candidates' in state.result
          ? {
            candidates: state.result.candidates.map(candidate => ({ ...candidate })),
            warnings: [...state.result.warnings],
          }
          : {}),
      },
    } as MemoryWriteServiceState;
  }
  return { ...state };
}

function operationFromArgs(args: string[]): MemoryWriteOperation {
  for (const value of args) {
    if (value === 'read-target' || value === 'prepare' || value === 'apply' || value === 'cancel') {
      return value;
    }
  }
  return 'prepare';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalizeMemoryText(value: string): string {
  let text = value.startsWith('\uFEFF') ? value.slice(1) : value;
  text = text.replace(/\r\n?/g, '\n').normalize('NFC');
  return text.replace(/\n+$/g, '') + (text ? '\n' : '');
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function boundedByteLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(64 * 1_024 * 1_024, Math.max(1_024, Math.floor(value)));
}

function safeAction(value: unknown): MemoryWriteAction {
  if (value === 'ADD' || value === 'UPDATE' || value === 'NOOP' || value === 'MERGE_REQUIRED') {
    return value;
  }
  throw new MemoryWriteError(
    'WRITE_PROTOCOL_INVALID',
    'prepare',
    'Agent Memory 返回了未知动作。',
  );
}

function safeRelativePath(value: unknown): string {
  const path = safeString(value, 512);
  if (!path || path.startsWith('/') || path.includes('..') || path.includes('\\')
    || !path.endsWith('.md')) return '';
  return path;
}

function safeReasonCode(value: unknown): string {
  const code = safeString(value, 96).toUpperCase();
  return /^[A-Z0-9][A-Z0-9_.:-]{0,95}$/.test(code) ? code : '';
}

function safeString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return [...value].filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('').trim().slice(0, maxLength);
}

function safeSha256(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function safeGitHead(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) ? value : '';
}

function isProposalId(value: string): boolean {
  return /^[a-f0-9]{32}$/.test(value);
}

function safeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safePositiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
