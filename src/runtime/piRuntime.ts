import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';

import type {
  ChatTurnRequest,
  FileAttachment,
  PiPermissionDecision,
  PiRuntimeStatus,
  RuntimeBinarySource,
  RuntimeTurnEvent,
} from '../types';
import { ailuHome } from '../paths';
import { assertManagedFrozenAttachments } from './frozenAttachments';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from './outputLimits';
import { PiRpcClient, buildPiRpcProbeArgs, isPiRpcUnsupportedDetail } from './piRpc';
import {
  AILU_BRIDGE_ACTIVE_NOTIFY,
  ensurePiBridgeExtension,
  parseAiluPermissionRequest,
  PI_READ_ONLY_TOOLS,
} from './piBridgeExtension';
import {
  parsePiModelsResponse,
  parsePiStateCurrentModelKey,
} from './piModels';

export interface PiRuntimeConnection {
  binaryPath: string;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  executionIsCurrent?: () => boolean;
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
  /** Unsettled bridge dialogs; the turn denies them on teardown. */
  pendingPermissions: Set<number | string>;
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
  /** Connect failures report through their own error path, not via close. */
  connectCompleted: boolean;
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
    models: [],
    currentModelId: null,
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
      models: [],
      currentModelId: null,
      error: reason,
    });
    return this.getStatus();
  }

  /**
   * Spawns a short-lived probe process and reads the model catalog plus the
   * local default model. Read-only: nothing is written to Pi configuration.
   */
  async refreshStatus(connection: PiRuntimeConnection): Promise<PiRuntimeStatus> {
    const client = new PiRpcClient();
    this.setStatus({
      state: 'connecting',
      binaryPath: connection.binaryPath,
      binarySource: connection.binarySource,
      version: connection.version,
      models: this.status.state === 'ready' ? this.status.models : [],
      currentModelId: this.status.currentModelId,
      error: null,
    });
    try {
      await client.connect({
        executablePath: connection.binaryPath,
        args: buildPiRpcProbeArgs(),
        env: connection.env,
      });
      const modelsData = await client.request({ type: 'get_available_models' }, 20_000);
      const state = client.stateData;
      this.setStatus({
        state: 'ready',
        binaryPath: connection.binaryPath,
        binarySource: connection.binarySource,
        version: connection.version,
        models: parsePiModelsResponse(modelsData),
        currentModelId: parsePiStateCurrentModelKey(state),
        error: null,
      });
    } catch (error) {
      const detail = client.lastStderrTail || String(error);
      const unsupported = isPiRpcUnsupportedDetail(detail);
      this.setStatus({
        state: 'error',
        binaryPath: connection.binaryPath,
        binarySource: connection.binarySource,
        version: connection.version,
        models: [],
        currentModelId: null,
        error: unsupported
          ? '当前 Pi 版本不支持 RPC 模式，请在设置中升级 Pi 后重新检测。'
          : `无法读取 Pi 模型列表：${detail.slice(0, 300)}`,
      });
    } finally {
      this.trackClientTeardown(client);
    }
    return this.getStatus();
  }

  async runTurn(
    request: ChatTurnRequest,
    connection: PiRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
  ): Promise<void> {
    const runtimeRequest = isolatePiRequest(request);
    let frozenAttachments: FileAttachment[] = [];
    try {
      // Re-validates the managed frozen copies (identity, size, root) so a
      // stale or tampered attachment fails before any process spawns.
      frozenAttachments = assertManagedFrozenAttachments(
        runtimeRequest.attachments ?? [],
        runtimeRequest.cwd,
        connection.env,
      );
    } catch (error) {
      listener({
        type: 'error',
        message: '图片附件校验失败，本次未启动。',
        detail: `${String(error)} 请移除附件后重新添加，再发送。`,
        diagnostic: 'pi_attachments_invalid',
      });
      listener({ type: 'done' });
      return;
    }

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
      pendingPermissions: new Set(),
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
      connectCompleted: false,
      detachAbort: () => undefined,
    };
    this.activeTurns.add(active);

    let sawTextDeltaForMessage = false;
    let pendingAgentError: RuntimeTurnEvent | null = null;

    const finish = (event?: RuntimeTurnEvent): void => {
      if (active.settled) return;
      active.settled = true;
      if (event) listener(event);
      for (const pendingId of [...active.pendingPermissions]) {
        active.pendingPermissions.delete(pendingId);
        try {
          active.client.respondUiRequest(pendingId, { cancelled: true });
        } catch {
          // The process is going away; a missed response is harmless.
        }
      }
      listener({
        type: 'done',
        ...(active.exposeSession && active.sessionId ? { sessionId: active.sessionId } : {}),
      });
      active.detachAbort();
      this.activeTurns.delete(active);
      active.settle();
      this.trackClientTeardown(active.client);
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
            detail: `${typeof event.error === 'string' ? event.error : JSON.stringify(event.error ?? null)}\n\n恢复方式：在 设置 → Pi → 定制与信任 中切换为“隔离模式”后重试。`,
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

    let bridgeActive = false;

    const handleUiRequest = (request_: Record<string, unknown>): void => {
      const method = safeText(request_.method, '');
      const id = request_.id;
      if (id === undefined) return;
      if (method === 'notify' && safeText(request_.message, '') === AILU_BRIDGE_ACTIVE_NOTIFY) {
        bridgeActive = true;
        return;
      }
      const permission = method === 'select'
        ? parseAiluPermissionRequest(request_.title)
        : null;
      if (permission) {
        const requester = active.client;
        active.pendingPermissions.add(id as number | string);
        listener({
          type: 'permission',
          permission: {
            id: id as number | string,
            toolName: permission.tool,
            category: permission.category,
            detail: permission.detail,
            respond: (decision: PiPermissionDecision) => {
              if (!active.pendingPermissions.delete(id as number | string)
                && decision !== 'deny') {
                // Already settled or answered; a stale duplicate response is
                // ignored so a dismissal cannot flip an earlier decision.
                return;
              }
              try {
                requester.respondUiRequest(
                  id as number | string,
                  decision === 'dismissed' || decision === 'deny'
                    ? (
                      // deny keeps the dialog protocol alive with an explicit
                      // choice; dismissal cancels it. Both block the tool.
                      decision === 'deny' ? { value: 'deny' } : { cancelled: true }
                    )
                    : { value: decision },
                );
              } catch {
                // The process is going away; the turn already accounts for it.
              }
            },
          },
        });
        return;
      }
      if (!FIRE_AND_FORGET_UI_METHODS.has(method)) {
        // Extension dialogs that Ailu cannot render are cancelled so Pi can
        // continue; the permission bridge handles its own dialogs above.
        active.client.respondUiRequest(id as number | string, { cancelled: true });
        listener({
          type: 'diagnostic',
          code: 'pi_extension_dialog_cancelled',
          message: `已自动取消 Pi 扩展弹窗（${method}）：Ailu 不转发扩展自定义界面。`,
        });
      }
    };

    const handleClose = (reason: string): void => {
      if (!active.connectCompleted || active.settled || active.exitReported) return;
      active.exitReported = true;
      finish({
        type: 'error',
        message: 'Pi 进程意外退出，本回合已停止。',
        detail: `${reason}。对话记录已保留，可直接重试；若反复出现，请在设置中重新检测 Pi。`,
        diagnostic: 'pi_runtime_unexpected_exit',
      });
    };

    const onAbort = (): void => {
      active.interrupted = true;
      pendingAgentError = null;
      void this.abortTurn(active);
    };
    runtimeRequest.signal?.addEventListener('abort', onAbort, { once: true });
    active.detachAbort = () => runtimeRequest.signal?.removeEventListener('abort', onAbort);

    /**
     * Connects the live client and records whether a requested resume found
     * an empty session file (Pi recreates missing sessions with the same id).
     */
    const bridgeConfig = {
      fullAccess: runtimeRequest.fullAccess === true && runtimeRequest.planMode !== true,
      planMode: runtimeRequest.planMode === true,
    };
    let bridgePath: string | null = null;
    if (!isolated) {
      try {
        bridgePath = ensurePiBridgeExtension(bridgeConfig, connection.env);
      } catch (error) {
        listener({
          type: 'error',
          message: '无法写入 Pi 权限桥扩展，本次未启动。',
          detail: String(error),
          diagnostic: 'pi_permission_bridge_unavailable',
        });
        listener({ type: 'done' });
        return;
      }
    }
    // The bridge must be provably loaded before unguarded tool execution.
    const bridgeRequired = !isolated && !bridgeConfig.fullAccess;

    const connectPiSession = async (connectRequest: ChatTurnRequest): Promise<boolean> => {
      const connectClient = active.client;
      connectClient.on('piEvent', (event: Record<string, unknown>) => handleEvent(event));
      connectClient.on('uiRequest', (request_: Record<string, unknown>) => handleUiRequest(request_));
      connectClient.on('close', (reason: string) => handleClose(reason));
      await connectClient.connect({
        executablePath: connection.binaryPath,
        args: buildPiTurnArgs(connectRequest, sessionDir, bridgePath),
        env: connection.env,
        cwd: connectRequest.cwd,
      });
      const state = active.client.stateData as Record<string, unknown> | null;
      if (state && typeof state.sessionId === 'string' && state.sessionId) {
        active.sessionId = state.sessionId;
      }
      const messageCount = state && typeof state.messageCount === 'number'
        ? state.messageCount
        : null;
      return Boolean(connectRequest.sessionId?.trim() && messageCount === 0);
    };

    const swapToFreshSession = (): void => {
      const previousClient = active.client;
      active.client = new PiRpcClient();
      active.sessionId = null;
      bridgeActive = false;
      this.trackClientTeardown(previousClient);
    };

    const fallbackAllowed = runtimeRequest.allowFreshSessionFallback === true
      && Boolean(runtimeRequest.freshSessionPrompt?.trim())
      && runtimeRequest.textOnly !== true;
    let effectiveRequest = runtimeRequest;
    let prompt = composePiPrompt(runtimeRequest);

    const failConnect = (error: unknown, connectClient: PiRpcClient): void => {
      const detail = connectClient.lastStderrTail || String(error);
      const unsupported = isPiRpcUnsupportedDetail(detail);
      const extensionFailure = /extension|\.mjs|\.ts\b/i.test(detail) && !unsupported;
      const detailWithRecovery = extensionFailure
        ? `${detail}\n\n可能是 Pi 扩展或配置加载失败（见上方来源路径）。可在 设置 → Pi → 定制与信任 中切换为“隔离模式”后重试。`
        : detail;
      finish({
        type: 'error',
        message: unsupported
          ? '当前 Pi 版本不支持 RPC 模式，请升级 Pi 后重试。'
          : extensionFailure
            ? 'Pi 启动时加载扩展或配置失败，本次未发送。'
            : '无法启动 Pi RPC 进程，本次未发送。',
        detail: detailWithRecovery,
        diagnostic: unsupported
          ? 'pi_rpc_unsupported'
          : extensionFailure
            ? 'pi_customization_failed'
            : 'pi_rpc_start_failed',
      });
    };

    try {
      const rebuilt = await connectPiSession(effectiveRequest);
      if (rebuilt) {
        listener({
          type: 'diagnostic',
          code: 'pi_session_rebuilt',
          message: '原 Pi 会话已不存在，已按当前对话重建新会话；聊天记录完整保留。',
        });
        if (fallbackAllowed) {
          swapToFreshSession();
          effectiveRequest = { ...runtimeRequest, sessionId: undefined };
          prompt = runtimeRequest.freshSessionPrompt as string;
          await connectPiSession(effectiveRequest);
        }
      }
    } catch (error) {
      const failedClient = active.client;
      const detail = failedClient.lastStderrTail || String(error);
      const unsupported = isPiRpcUnsupportedDetail(detail);
      // A stored session file that refuses to load is corrupt; with a verified
      // handoff prompt the turn can restart on a brand-new private session.
      if (!unsupported && fallbackAllowed && effectiveRequest.sessionId?.trim()) {
        listener({
          type: 'diagnostic',
          code: 'pi_session_rebuilt',
          message: '原 Pi 会话无法加载（可能已损坏），已按当前对话重建新会话；聊天记录完整保留。',
        });
        swapToFreshSession();
        effectiveRequest = { ...runtimeRequest, sessionId: undefined };
        prompt = runtimeRequest.freshSessionPrompt as string;
        try {
          await connectPiSession(effectiveRequest);
        } catch (fallbackError) {
          if (!active.settled) failConnect(fallbackError, active.client);
          return;
        }
      } else {
        failConnect(error, failedClient);
        return;
      }
    }

    active.connectCompleted = true;
    if (bridgeRequired) {
      const deadline = Date.now() + 5_000;
      while (!bridgeActive && !active.settled && Date.now() < deadline) {
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, 25);
        });
      }
      if (!bridgeActive && !active.settled) {
        finish({
          type: 'error',
          message: 'Pi 权限桥扩展未加载，本次已按安全策略取消。',
          detail: '请重试；若持续出现，请在设置中重新检测 Pi 或升级 Pi 版本。',
          diagnostic: 'pi_permission_bridge_missing',
        });
        return;
      }
    }
    if (active.exposeSession && active.sessionId) {
      listener({ type: 'session', sessionId: active.sessionId });
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

    let promptImages: Array<Record<string, unknown>> = [];
    try {
      promptImages = await readPiAttachmentImages(frozenAttachments);
    } catch (error) {
      finish({
        type: 'error',
        message: '读取图片附件失败，本回合已停止。',
        detail: `${String(error)} 请移除附件后重新添加，再发送。`,
        diagnostic: 'pi_attachments_invalid',
      });
      return;
    }

    try {
      await active.client.request({
        type: 'prompt',
        message: prompt,
        ...(promptImages.length > 0 ? { images: promptImages } : {}),
      }, PI_ABORT_COMPLETION_TIMEOUT_MS);
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

export function buildPiTurnArgs(
  request: ChatTurnRequest,
  sessionDir: string,
  bridgePath?: string | null,
): string[] {
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
  } else if (request.planMode === true) {
    // Plan mode is a hard read-only boundary: only approved read/search/list
    // tools exist for the model, discovery is fully disabled, and project
    // trust is explicitly declined for the run. The bridge (-e) still loads
    // and blocks anything that slips past the allowlist.
    args.push(
      '--session-dir',
      sessionDir,
      ...(request.sessionId?.trim() ? ['--session-id', request.sessionId.trim()] : []),
      '--tools',
      [...PI_READ_ONLY_TOOLS].join(','),
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-approve',
    );
  } else {
    args.push('--session-dir', sessionDir);
    if (request.sessionId?.trim()) args.push('--session-id', request.sessionId.trim());
    // Customization scope. `--no-approve` pins project-local resources off
    // even when the user's own Pi defaults to always trusting projects;
    // `--approve` trusts the Vault's .pi resources for this run only.
    // Skill auto-discovery stays off in every mode: only the Skills the user
    // explicitly selected for this task load, through explicit --skill paths.
    args.push('--no-skills');
    if (request.piCustomizationMode === 'isolated') {
      args.push(
        '--no-extensions',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--no-approve',
      );
    } else if (request.piCustomizationMode === 'trustedVault') {
      args.push('--approve');
    } else {
      args.push('--no-approve');
    }
    for (const skillPath of request.skillPaths ?? []) {
      const normalized = skillPath.trim();
      if (path.isAbsolute(normalized)) args.push('--skill', normalized);
    }
  }
  if (bridgePath && request.textOnly !== true) args.push('-e', bridgePath);
  const model = request.model?.trim();
  if (model) args.push('--model', model);
  const thinking = request.reasoningEffort?.trim();
  if (thinking) args.push('--thinking', thinking);
  return args;
}

/** Base64-encodes the immutable managed copies into Pi image content blocks. */
async function readPiAttachmentImages(
  attachments: readonly FileAttachment[],
): Promise<Array<Record<string, unknown>>> {
  const images: Array<Record<string, unknown>> = [];
  let encodedBytes = 0;
  for (const attachment of attachments) {
    const body = await fsp.readFile(attachment.absolutePath);
    encodedBytes += body.byteLength;
    if (encodedBytes > 64 * 1_024 * 1_024) {
      throw new Error('图片附件总量超出安全上限。');
    }
    images.push({
      type: 'image',
      data: body.toString('base64'),
      mimeType: attachment.mimeType ?? 'application/octet-stream',
    });
  }
  return images;
}

export function composePiPrompt(request: ChatTurnRequest): string {
  const systemPrompt = request.systemPrompt?.trim();
  if (!systemPrompt) return request.prompt;
  return `${systemPrompt}\n\n${request.prompt}`;
}
