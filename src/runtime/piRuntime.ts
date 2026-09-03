import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

import type {
  ChatTurnRequest,
  RuntimeBinarySource,
  RuntimeTurnEvent,
} from '../types';
import { ailuHome } from '../paths';
import { assertManagedFrozenAttachments } from './frozenAttachments';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from './outputLimits';
import { PiRpcClient } from './piRpc';

export interface PiRuntimeConnection {
  binaryPath: string;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  executionIsCurrent?: () => boolean;
}

export interface PiRuntimeStatus {
  state: 'idle' | 'ready' | 'error';
  binaryPath: string | null;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  error: string | null;
}

export const PI_MAX_RUNTIME_EVENT_BYTES = 512 * 1_024;
export const PI_MAX_TURN_OUTPUT_BYTES = MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES;
export const PI_ABORT_COMPLETION_TIMEOUT_MS = 10_000;

const FIRE_AND_FORGET_UI_METHODS = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
]);

interface ActivePiTurn {
  client: PiRpcClient;
  listener: (event: RuntimeTurnEvent) => void;
  settle: () => void;
  settled: boolean;
  emittedOutputBytes: number;
  sessionId: string | null;
  exposeSession: boolean;
  interrupted: boolean;
  outputLimitExceeded: boolean;
  /** Set once an unexpected process exit has been reported for this turn. */
  exitReported: boolean;
  detachAbort: () => void;
}

/**
 * Pi runtime with one isolated `pi --mode rpc` process per turn.
 *
 * A per-turn process keeps cancellation physical and verifiable: stopping a
 * turn tears down exactly that conversation's process tree, and no Pi process
 * survives into the background. Native sessions are resumed through
 * `--session-id` inside Ailu's private session directory.
 */
export class PiRpcRuntime extends EventEmitter {
  private readonly activeTurns = new Set<ActivePiTurn>();
  private readonly clientTeardowns = new Set<Promise<void>>();
  private status: PiRuntimeStatus = {
    state: 'idle',
    binaryPath: null,
    binarySource: null,
    version: null,
    error: null,
  };
  private shutdownBarrier: Promise<void> | null = null;

  getStatus(): PiRuntimeStatus {
    return { ...this.status };
  }

  onStatusChange(listener: (status: PiRuntimeStatus) => void): () => void {
    this.on('status', listener);
    return () => this.off('status', listener);
  }

  async markUnavailable(reason: string): Promise<PiRuntimeStatus> {
    this.setStatus({
      state: 'error',
      binaryPath: null,
      binarySource: null,
      version: null,
      error: reason,
    });
    return this.getStatus();
  }

  async runTurn(
    request: ChatTurnRequest,
    connection: PiRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
  ): Promise<void> {
    const runtimeRequest = isolatePiRequest(request);
    if (runtimeRequest.attachments?.length) {
      listener({
        type: 'error',
        message: 'Pi 当前尚未支持图片附件，请移除附件后重试。',
        diagnostic: 'pi_attachments_not_supported',
      });
      listener({ type: 'done' });
      return;
    }
    // The assert re-validates the managed frozen copies even though Pi cannot
    // consume them yet, so a malformed attachment list fails before spawn.
    assertManagedFrozenAttachments(runtimeRequest.attachments ?? [], runtimeRequest.cwd, connection.env);

    const sessionDir = piSessionDir(connection.env);
    try {
      fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      listener({
        type: 'error',
        message: '无法创建 Pi 会话目录，本次未启动。',
        detail: String(error),
        diagnostic: 'pi_session_dir_unavailable',
      });
      listener({ type: 'done' });
      return;
    }

    const isolated = runtimeRequest.textOnly === true;
    const client = new PiRpcClient();
    let settleTurn!: () => void;
    const settledPromise = new Promise<void>(resolve => {
      settleTurn = resolve;
    });
    const active: ActivePiTurn = {
      client,
      listener,
      settle: () => {
        settleTurn();
      },
      settled: false,
      emittedOutputBytes: 0,
      sessionId: null,
      exposeSession: !isolated,
      interrupted: false,
      outputLimitExceeded: false,
      exitReported: false,
      detachAbort: () => undefined,
    };
    this.activeTurns.add(active);

    let sawTextDeltaForMessage = false;
    let pendingAgentError: RuntimeTurnEvent | null = null;

    const finish = (event?: RuntimeTurnEvent): void => {
      if (active.settled) return;
      active.settled = true;
      if (event) listener(event);
      listener({
        type: 'done',
        ...(active.exposeSession && active.sessionId ? { sessionId: active.sessionId } : {}),
      });
      active.detachAbort();
      this.activeTurns.delete(active);
      active.settle();
      this.trackClientTeardown(client);
    };

    const emitText = (content: string): void => {
      if (active.settled || active.outputLimitExceeded || !content) return;
      const bytes = Buffer.byteLength(content, 'utf8');
      if (
        bytes > PI_MAX_RUNTIME_EVENT_BYTES
        || active.emittedOutputBytes + bytes > PI_MAX_TURN_OUTPUT_BYTES
      ) {
        active.outputLimitExceeded = true;
        finish({
          type: 'error',
          message: 'Pi 输出超出安全字节上限，已停止本回合。',
          detail: '请缩小提问范围或降低输出长度后重试。',
          diagnostic: 'pi_output_limit_exceeded',
        });
        void this.abortTurn(active);
        return;
      }
      active.emittedOutputBytes += bytes;
      listener({ type: 'text', content });
    };

    const handleEvent = (event: Record<string, unknown>): void => {
      if (active.settled) return;
      switch (event.type) {
        case 'message_start':
          sawTextDeltaForMessage = false;
          return;
        case 'message_update': {
          const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!delta || typeof delta !== 'object') return;
          if (delta.type === 'text_delta' && typeof delta.delta === 'string') {
            sawTextDeltaForMessage = true;
            emitText(delta.delta);
          }
          return;
        }
        case 'message_end': {
          const message = event.message as Record<string, unknown> | undefined;
          if (!message || message.role !== 'assistant' || sawTextDeltaForMessage) return;
          const content = message.content;
          if (!Array.isArray(content)) return;
          const text = content
            .filter((block): block is { type: string; text?: unknown } =>
              typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
            .map(block => (typeof block.text === 'string' ? block.text : ''))
            .join('');
          emitText(text);
          return;
        }
        case 'tool_execution_start': {
          listener({
            type: 'tool',
            toolCall: {
              id: safeText(event.toolCallId, ''),
              name: safeText(event.toolName, 'unknown'),
              status: 'started',
              input: event.args,
            },
          });
          return;
        }
        case 'tool_execution_end': {
          const isError = event.isError === true;
          listener({
            type: 'tool',
            toolCall: {
              id: safeText(event.toolCallId, ''),
              name: safeText(event.toolName, 'unknown'),
              status: isError ? 'error' : 'completed',
              output: event.result,
              ...(isError ? { error: resultErrorText(event.result) } : {}),
            },
          });
          return;
        }
        case 'extension_error': {
          listener({
            type: 'diagnostic',
            code: 'pi_extension_error',
            message: `Pi 扩展 ${safeText(event.extensionPath, '未知来源')} 在 ${safeText(event.event, '未知事件')} 中出错。`,
            detail: typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? null),
          });
          return;
        }
        case 'auto_retry_start': {
          listener({
            type: 'diagnostic',
            code: 'pi_auto_retrying',
            message: `Pi 正在自动重试（第 ${safeText(event.attempt, '?')} 次）。`,
          });
          return;
        }
        case 'agent_end': {
          const messages = event.messages;
          if (!Array.isArray(messages) || messages.length === 0) return;
          const last = messages[messages.length - 1] as Record<string, unknown>;
          if (last.role === 'assistant' && last.stopReason === 'error' && !active.interrupted) {
            pendingAgentError = {
              type: 'error',
              message: 'Pi 本回合执行失败。',
              detail: assistantErrorText(last),
              diagnostic: 'pi_agent_error',
            };
          }
          return;
        }
        case 'agent_settled': {
          finish(pendingAgentError ?? undefined);
          return;
        }
        default:
          return;
      }
    };

    const handleUiRequest = (request_: Record<string, unknown>): void => {
      const method = safeText(request_.method, '');
      const id = request_.id;
      if (id === undefined) return;
      if (!FIRE_AND_FORGET_UI_METHODS.has(method)) {
        // Extension dialogs that Ailu cannot render are cancelled so Pi can
        // continue; the #6 permission bridge handles its own dialogs.
        client.respondUiRequest(id as number | string, { cancelled: true });
        listener({
          type: 'diagnostic',
          code: 'pi_extension_dialog_cancelled',
          message: `已自动取消 Pi 扩展弹窗（${method}）：Ailu 不转发扩展自定义界面。`,
        });
      }
    };

    const handleClose = (reason: string): void => {
      if (active.settled || active.exitReported) return;
      active.exitReported = true;
      finish({
        type: 'error',
        message: 'Pi 进程意外退出，本回合已停止。',
        detail: `${reason}。对话记录已保留，可直接重试；若反复出现，请在设置中重新检测 Pi。`,
        diagnostic: 'pi_runtime_unexpected_exit',
      });
    };

    client.on('piEvent', (event: Record<string, unknown>) => handleEvent(event));
    client.on('uiRequest', (request_: Record<string, unknown>) => handleUiRequest(request_));
    client.on('close', (reason: string) => handleClose(reason));

    const onAbort = (): void => {
      active.interrupted = true;
      pendingAgentError = null;
      void this.abortTurn(active);
    };
    runtimeRequest.signal?.addEventListener('abort', onAbort, { once: true });
    active.detachAbort = () => runtimeRequest.signal?.removeEventListener('abort', onAbort);

    try {
      await client.connect({
        executablePath: connection.binaryPath,
        args: buildPiTurnArgs(runtimeRequest, sessionDir),
        env: connection.env,
        cwd: runtimeRequest.cwd,
      });
    } catch (error) {
      const detail = client.lastStderrTail || String(error);
      const unsupported = /--mode|unknown option|unrecognized/i.test(detail);
      finish({
        type: 'error',
        message: unsupported
          ? '当前 Pi 版本不支持 RPC 模式，请升级 Pi 后重试。'
          : '无法启动 Pi RPC 进程，本次未发送。',
        detail,
        diagnostic: unsupported ? 'pi_rpc_unsupported' : 'pi_rpc_start_failed',
      });
      return;
    }

    const state = client.stateData as Record<string, unknown> | null;
    const sessionId = state && typeof state.sessionId === 'string' ? state.sessionId : null;
    if (sessionId) active.sessionId = sessionId;
    if (active.exposeSession && sessionId) {
      listener({ type: 'session', sessionId });
    }

    if (connection.executionIsCurrent && !connection.executionIsCurrent()) {
      finish({
        type: 'error',
        message: '排队期间运行配置已改变，本次未发送。',
        detail: '请重新发送；插件会按当前配置重新建立安全快照。',
        diagnostic: 'runtime_execution_config_changed',
      });
      return;
    }

    const prompt = composePiPrompt(runtimeRequest);
    try {
      await client.request({ type: 'prompt', message: prompt }, PI_ABORT_COMPLETION_TIMEOUT_MS);
    } catch (error) {
      if (active.settled) return;
      finish({
        type: 'error',
        message: 'Pi 未接受本次输入，本回合已停止。',
        detail: String(error),
        diagnostic: 'pi_prompt_rejected',
      });
      return;
    }

    await settledPromise;
  }

  /** Cancels one active turn: asks Pi to abort, then tears the process tree. */
  private async abortTurn(active: ActivePiTurn): Promise<void> {
    if (active.settled) return;
    try {
      await active.client.request({ type: 'abort' }, PI_ABORT_COMPLETION_TIMEOUT_MS);
      // The abort response means the agent reached idle; agent_settled usually
      // fires first and finished the turn. Guard for missed settle paths.
      if (!active.settled) {
        active.settled = true;
        active.listener({
          type: 'done',
          ...(active.exposeSession && active.sessionId
            ? { sessionId: active.sessionId }
            : {}),
        });
        active.detachAbort();
        this.activeTurns.delete(active);
        active.settle();
        this.trackClientTeardown(active.client);
      }
    } catch {
      // Abort RPC failed or timed out: safety-disconnect the process tree.
      await this.safetyDisconnect(active);
    }
  }

  private async safetyDisconnect(active: ActivePiTurn): Promise<void> {
    if (active.settled) {
      await active.client.disconnect();
      return;
    }
    active.settled = true;
    active.listener({
      type: 'error',
      message: 'Pi 本回合未能确认停止，已强制结束进程。',
      detail: '对话记录已保留；若反复出现，请重新检测 Pi 或重启 Obsidian。',
      diagnostic: 'pi_safety_disconnect_required',
    });
    active.listener({
      type: 'done',
      ...(active.exposeSession && active.sessionId ? { sessionId: active.sessionId } : {}),
    });
    active.detachAbort();
    this.activeTurns.delete(active);
    active.settle();
    // Rejection propagates to the cancel barrier after the turn is settled.
    await active.client.disconnect();
  }

  async cancelAll(): Promise<void> {
    const turns = [...this.activeTurns];
    const results = await Promise.allSettled(
      turns.map(turn => this.abortTurn(turn).catch(async () => this.safetyDisconnect(turn))),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result): unknown => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Pi runtime cancellation could not confirm every turn stopped.');
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownBarrier) return this.shutdownBarrier;
    this.shutdownBarrier = (async () => {
      try {
        await this.cancelAll();
      } catch {
        // Individual teardown failures are retried below via disconnect.
      }
      for (const turn of [...this.activeTurns]) {
        await turn.client.disconnect().catch(() => undefined);
      }
      await Promise.allSettled([...this.clientTeardowns]);
    })();
    void this.shutdownBarrier.catch(() => undefined);
    return this.shutdownBarrier;
  }

  /** Keeps the fire-and-forget client teardown observable by shutdown(). */
  private trackClientTeardown(client: PiRpcClient): void {
    const teardown = client.disconnect().catch(error => {
      appendSafeErrorLog(`Pi RPC disconnect after turn failed: ${String(error)}`);
    });
    this.clientTeardowns.add(teardown);
    void teardown.finally(() => this.clientTeardowns.delete(teardown));
  }

  private setStatus(status: PiRuntimeStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }
}

function appendSafeErrorLog(message: string): void {
  console.error(`Ailu: ${message}`);
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function resultErrorText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.content === 'string') return record.content;
  }
  return JSON.stringify(result ?? null).slice(0, 400);
}

function assistantErrorText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return 'Pi 未返回可识别的错误详情。';
  const text = content
    .filter((block): block is { type: string; text?: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map(block => (typeof block.text === 'string' ? block.text : ''))
    .join('')
    .trim();
  return text || 'Pi 未返回可识别的错误详情。';
}

/** Neutralizes session, attachment, and privilege fields for isolated turns. */
function isolatePiRequest(request: ChatTurnRequest): ChatTurnRequest {
  if (request.textOnly !== true && request.purpose !== 'contextCompression') return request;
  return {
    ...request,
    sessionId: undefined,
    attachments: [],
    fullAccess: false,
    planMode: false,
  };
}

export function piSessionDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'pi-sessions');
}

export function buildPiTurnArgs(request: ChatTurnRequest, sessionDir: string): string[] {
  const args: string[] = [];
  if (request.textOnly === true) {
    args.push(
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
    );
  } else {
    args.push('--session-dir', sessionDir);
    if (request.sessionId?.trim()) args.push('--session-id', request.sessionId.trim());
  }
  const model = request.model?.trim();
  if (model) args.push('--model', model);
  const thinking = request.reasoningEffort?.trim();
  if (thinking) args.push('--thinking', thinking);
  return args;
}

export function composePiPrompt(request: ChatTurnRequest): string {
  const systemPrompt = request.systemPrompt?.trim();
  if (!systemPrompt) return request.prompt;
  return `${systemPrompt}\n\n${request.prompt}`;
}
