import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import type {
  AgyModelDescriptor,
  AgyRuntimeStatus,
  ChatTurnRequest,
  RuntimeBinarySource,
  RuntimeTurnEvent,
  ToolCallEvent,
} from '../types';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from './outputLimits';

export interface AgyRuntimeConnection {
  binaryPath: string;
  binarySource: RuntimeBinarySource | null;
  version: string | null;
  env: NodeJS.ProcessEnv;
  executionIsCurrent?: () => boolean;
}

export const AGY_MAX_RUNTIME_EVENT_BYTES = 512 * 1_024;
export const AGY_MAX_TURN_OUTPUT_BYTES = MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES;
export const AGY_MAX_STDOUT_FRAME_BYTES = 1 * 1_024 * 1_024;
export const AGY_TERM_GRACE_MS = 2_000;
export const AGY_KILL_WAIT_MS = 2_000;
export const AGY_MODELS_TIMEOUT_MS = 20_000;

interface ActiveAgyTurn {
  child: ChildProcess | null;
  processGroupId: number | null;
  listener: (event: RuntimeTurnEvent) => void;
  settle: () => void;
  settled: boolean;
  emittedText: string;
  emittedOutputBytes: number;
  sessionId: string | null;
  /** Only successful turns expose a session id for later resume. */
  exposeSession: boolean;
  outputLimitExceeded: boolean;
  exitReported: boolean;
  detachAbort: () => void;
}

/** Flags every headless `agy` turn runs with, regardless of request shape. */
export function buildAgyTurnArgs(request: ChatTurnRequest): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
  ];
  const sessionId = request.sessionId?.trim();
  if (sessionId) args.push('--conversation', sessionId);
  const model = request.model?.trim();
  if (model) args.push('--model', model);
  const effort = request.reasoningEffort?.trim();
  if (effort) args.push('--effort', effort);
  return args;
}

/** Headless `agy` only accepts text content blocks; the system prompt is
 * folded into the single user message exactly like the Pi turn does. */
export function composeAgyUserMessage(request: ChatTurnRequest): string {
  const systemPrompt = request.systemPrompt?.trim();
  const prompt = systemPrompt ? `${systemPrompt}\n\n${request.prompt}` : request.prompt;
  return JSON.stringify({
    event: 'user',
    message: {
      content: [{ type: 'text', text: prompt }],
    },
  });
}

/**
 * Parses the `agy models` TSV output: one `id<TAB>name` pair per line.
 *
 * `agy` encodes the reasoning effort in the model id of Gemini-family models
 * (gemini-3.8-flash-high / -medium / -low). Those families are folded into a
 * single base-model entry so the model picker stays short; the independent
 * effort picker drives `--effort` instead. Families with a single entry (for
 * example gpt-oss-120b-medium) keep their full id, because dropping "-medium"
 * would invent a model the CLI does not know.
 */
export function parseAgyModelsOutput(stdout: string): AgyModelDescriptor[] {
  const raw: Array<{ id: string; name: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tab = trimmed.indexOf('\t');
    if (tab <= 0) continue;
    const id = trimmed.slice(0, tab).trim();
    const name = trimmed.slice(tab + 1).trim();
    if (id && name) raw.push({ id, name });
  }

  const families = new Map<string, Array<{ id: string; name: string; effort: string }>>();
  for (const entry of raw) {
    const match = /-(low|medium|high)$/.exec(entry.id);
    if (!match) continue;
    const base = entry.id.slice(0, match.index);
    const family = families.get(base) ?? [];
    family.push({ ...entry, effort: match[1] });
    families.set(base, family);
  }

  const foldedIds = new Set<string>();
  for (const [base, variants] of families) {
    if (variants.length >= 2) foldedIds.add(base);
  }

  const models: AgyModelDescriptor[] = [];
  for (const entry of raw) {
    const match = /-(low|medium|high)$/.exec(entry.id);
    const base = match ? entry.id.slice(0, match.index) : '';
    if (match && foldedIds.has(base)) {
      if (models.some(model => model.id === base)) continue;
      const variants = families.get(base) ?? [];
      models.push({
        id: base,
        name: variants[0].name.replace(/\s*\((?:High|Medium|Low)\)$/, ''),
        defaultEffort: variants[0].effort,
      });
      continue;
    }
    if (!models.some(model => model.id === entry.id)) {
      models.push({ id: entry.id, name: entry.name });
    }
  }
  return models;
}

/**
 * Reconciles the requested model and effort into the exact `agy` flag pair.
 *
 * - `--model <base>` (for example gemini-3.8-flash) requires an explicit
 *   `--effort`; an empty picker falls back to the family's default level.
 * - A full id already encodes its level, and passing `--effort` alongside it
 *   makes `agy` abort the turn ("conflicts with --effort"), so the effort
 *   flag is dropped for those models.
 */
export function resolveAgyTurnModelSelection(
  request: Pick<ChatTurnRequest, 'model' | 'reasoningEffort'>,
  models: readonly AgyModelDescriptor[],
): { model: string; effort: string } {
  const selected = request.model?.trim() ?? '';
  const effort = request.reasoningEffort?.trim() ?? '';
  if (!selected) return { model: '', effort };
  const descriptor = models.find(model => model.id === selected);
  if (descriptor?.defaultEffort) {
    return { model: selected, effort: effort || descriptor.defaultEffort };
  }
  return { model: selected, effort: '' };
}

/**
 * Antigravity CLI runtime with one headless `agy` process per turn.
 *
 * A per-turn process keeps cancellation physical and verifiable, mirroring the
 * Pi runtime. Native sessions resume through `--conversation`; a conversation
 * id that no longer exists is silently replaced by a fresh session by the CLI
 * itself, so no fallback round trip is needed.
 *
 * The headless stream has no interactive permission channel (control requests
 * end the session), so every turn runs with `--dangerously-skip-permissions`
 * and the settings UI states that plainly instead of offering a toggle.
 */
export class AgyRuntime extends EventEmitter {
  private readonly activeTurns = new Set<ActiveAgyTurn>();
  private status: AgyRuntimeStatus = {
    state: 'idle',
    binaryPath: null,
    binarySource: null,
    version: null,
    models: [],
    error: null,
  };
  private shutdownBarrier: Promise<void> | null = null;

  getStatus(): AgyRuntimeStatus {
    return { ...this.status, models: [...this.status.models] };
  }

  onStatusChange(listener: (status: AgyRuntimeStatus) => void): () => void {
    this.on('status', listener);
    return () => this.off('status', listener);
  }

  async markUnavailable(reason: string): Promise<AgyRuntimeStatus> {
    this.setStatus({
      state: 'error',
      binaryPath: null,
      binarySource: null,
      version: null,
      models: [],
      error: reason,
    });
    return this.getStatus();
  }

  /**
   * Reads the model catalog with a short-lived `agy models` call. Read-only:
   * nothing is written to Antigravity configuration.
   */
  async refreshStatus(connection: AgyRuntimeConnection): Promise<AgyRuntimeStatus> {
    if (process.platform === 'win32') {
      return this.markUnavailable('Windows 上无法验证 Antigravity CLI 子进程树已完整退出。');
    }
    this.setStatus({
      state: 'connecting',
      binaryPath: connection.binaryPath,
      binarySource: connection.binarySource,
      version: connection.version,
      models: [],
      error: null,
    });
    const result = spawnSync(connection.binaryPath, ['models'], {
      encoding: 'utf8',
      env: connection.env,
      shell: false,
      timeout: AGY_MODELS_TIMEOUT_MS,
    });
    const stderr = (result.stderr ?? '').trim();
    const failed = result.status !== 0
      || (result.status === null && result.error !== undefined);
    if (!failed) {
      const models = parseAgyModelsOutput(result.stdout ?? '');
      if (models.length > 0) {
        this.setStatus({
          state: 'ready',
          binaryPath: connection.binaryPath,
          binarySource: connection.binarySource,
          version: connection.version,
          models,
          error: null,
        });
        return this.getStatus();
      }
    }
    const detail = stderr || (result.error ? String(result.error) : '');
    const needsSignIn = /sign[ -]?in|login|auth/i.test(detail);
    this.setStatus({
      state: 'error',
      binaryPath: connection.binaryPath,
      binarySource: connection.binarySource,
      version: connection.version,
      models: [],
      error: needsSignIn
        ? 'Antigravity CLI 未登录或登录已过期。请在终端运行 agy 完成登录后重试；对话仍会跟随本机默认模型。'
        : detail
          ? `无法读取 Antigravity CLI 模型列表：${detail.slice(0, 300)}`
          : '无法读取 Antigravity CLI 模型列表。',
    });
    return this.getStatus();
  }

  async runTurn(
    request: ChatTurnRequest,
    connection: AgyRuntimeConnection,
    listener: (event: RuntimeTurnEvent) => void,
  ): Promise<void> {
    if (process.platform === 'win32') {
      listener({
        type: 'error',
        message: 'Windows 上无法验证 Antigravity CLI 子进程树已完整退出，本次未启动。',
        diagnostic: 'windows_runtime_process_tree_unsupported',
      });
      listener({ type: 'done' });
      return;
    }
    if ((request.attachments?.length ?? 0) > 0) {
      listener({
        type: 'error',
        message: 'Antigravity CLI 的 headless 模式不支持图片附件。',
        detail: '请移除图片附件，或把图片放入 Vault 后让 Agent 用工具自行读取。',
        diagnostic: 'agy_attachments_unsupported',
      });
      listener({ type: 'done' });
      return;
    }

    const resolvedSelection = resolveAgyTurnModelSelection(request, this.status.models);
    const runtimeRequest = {
      ...request,
      model: resolvedSelection.model || undefined,
      reasoningEffort: resolvedSelection.effort || undefined,
    };
    const child = spawn(connection.binaryPath, buildAgyTurnArgs(runtimeRequest), {
      env: connection.env,
      cwd: request.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    const processGroupId = child.pid ?? null;

    let settleTurn!: () => void;
    const settledPromise = new Promise<void>(resolve => {
      settleTurn = resolve;
    });
    const active: ActiveAgyTurn = {
      child,
      processGroupId,
      listener,
      settle: settleTurn,
      settled: false,
      emittedText: '',
      emittedOutputBytes: 0,
      sessionId: null,
      exposeSession: false,
      outputLimitExceeded: false,
      exitReported: false,
      detachAbort: () => undefined,
    };
    this.activeTurns.add(active);

    const finish = (event?: RuntimeTurnEvent): void => {
      this.finishActiveTurn(active, event);
    };

    const abort = (): void => {
      if (active.settled) return;
      void this.teardownChildTree(active.child, active.processGroupId)
        .catch(() => undefined)
        .then(() => finish());
    };
    if (request.signal?.aborted) {
      abort();
      await settledPromise;
      return;
    }
    request.signal?.addEventListener('abort', abort, { once: true });
    active.detachAbort = () => request.signal?.removeEventListener('abort', abort);

    let stdoutBuffer = '';
    let stdoutBufferBytes = 0;
    let stderrTail = '';
    const handleStdout = (text: string): void => {
      if (active.settled || active.outputLimitExceeded) return;
      let start = 0;
      let newline = text.indexOf('\n', start);
      while (newline >= 0) {
        stdoutBuffer += text.slice(start, newline);
        stdoutBufferBytes += Buffer.byteLength(text.slice(start, newline), 'utf8');
        if (stdoutBufferBytes > AGY_MAX_STDOUT_FRAME_BYTES) {
          stdoutBuffer = '';
          stdoutBufferBytes = 0;
          this.failOutputLimit(active);
          return;
        }
        const line = stdoutBuffer.trim();
        stdoutBuffer = '';
        stdoutBufferBytes = 0;
        if (line) this.handleLine(active, line);
        if (active.settled || active.outputLimitExceeded) return;
        start = newline + 1;
        newline = text.indexOf('\n', start);
      }
      const remainder = text.slice(start);
      if (remainder) {
        stdoutBuffer += remainder;
        stdoutBufferBytes += Buffer.byteLength(remainder, 'utf8');
        if (stdoutBufferBytes > AGY_MAX_STDOUT_FRAME_BYTES) {
          stdoutBuffer = '';
          stdoutBufferBytes = 0;
          this.failOutputLimit(active);
        }
      }
    };

    // `agy` can exit (or reject our flags) while the user message is still
    // being written; EPIPE must never escape as an uncaught stream error.
    child.stdin?.on('error', (error: unknown) => {
      console.error('Ailu: agy stdin 写入失败（进程可能已退出）。', error);
    });
    child.stdout?.on('data', (chunk: unknown) => {
      handleStdout(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    });
    child.stderr?.on('data', (chunk: unknown) => {
      const text = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).trim();
      if (text) stderrTail = `${stderrTail}\n${text}`.slice(-8_000).trim();
    });
    child.on('error', error => {
      if (active.settled || active.exitReported) return;
      active.exitReported = true;
      finish({
        type: 'error',
        message: '无法启动 Antigravity CLI。',
        detail: error.message,
        diagnostic: 'agy_spawn_failed',
      });
    });
    child.on('exit', (code, signal) => {
      if (active.settled || active.exitReported) return;
      active.exitReported = true;
      if (code === 0) {
        // A turn that ends without a result event still produced a clean exit;
        // treat it as a completed turn so the UI does not hang.
        finish();
        return;
      }
      finish({
        type: 'error',
        message: 'Antigravity CLI 意外退出，本轮未完成。',
        detail: stderrTail || `exit code ${code ?? signal ?? 'unknown'}`,
        diagnostic: 'agy_unexpected_exit',
      });
    });

    try {
      child.stdin?.write(`${composeAgyUserMessage(request)}\n`);
      child.stdin?.end();
    } catch (error) {
      console.error('Ailu: agy stdin 写入抛出异常。', error);
    }
    await settledPromise;
  }

  private handleLine(active: ActiveAgyTurn, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON progress lines are not part of the protocol.
      return;
    }
    if (!message || typeof message !== 'object') return;
    const record = message as {
      event?: string;
      conversation_id?: string;
      step_update?: {
        step_index?: number;
        state?: string;
        step_type?: string;
        text_delta?: string;
        tool_name?: string;
        tool_info?: { name?: string; parameters?: unknown; output?: unknown };
      };
      result?: {
        conversation_id?: string;
        status?: string;
        response?: string;
        error?: string;
      };
    };
    if (record.event === 'init') {
      const conversationId = record.conversation_id?.trim();
      if (conversationId) active.sessionId = conversationId;
      return;
    }
    if (record.event === 'step_update') {
      const update = record.step_update;
      if (!update) return;
      if (update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
        this.emitText(active, update.text_delta);
        return;
      }
      if (update.step_type === 'tool') {
        this.emitToolUpdate(active, update);
      }
      return;
    }
    if (record.event === 'result') {
      const result = record.result;
      if (!result) return;
      if (result.status === 'SUCCESS') {
        // The CLI may replace an unresolvable resume target with a fresh
        // conversation; trust the final id for the next resume.
        const conversationId = record.conversation_id?.trim()
          || result.conversation_id?.trim();
        if (conversationId) {
          active.sessionId = conversationId;
          active.exposeSession = true;
        }
        if (typeof result.response === 'string') this.emitRemainingText(active, result.response);
        this.finishActiveTurn(active);
        return;
      }
      this.finishActiveTurn(active, {
        type: 'error',
        message: `Antigravity CLI 返回错误：${result.error ?? '未知错误'}`,
        diagnostic: 'agy_result_error',
      });
    }
  }

  private emitText(active: ActiveAgyTurn, content: string): void {
    if (active.settled || active.outputLimitExceeded || !content) return;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (
      bytes > AGY_MAX_RUNTIME_EVENT_BYTES
      || active.emittedOutputBytes + bytes > AGY_MAX_TURN_OUTPUT_BYTES
    ) {
      this.failOutputLimit(active);
      return;
    }
    active.emittedOutputBytes += bytes;
    active.emittedText += content;
    active.listener({ type: 'text', content });
  }

  /** Reconciles the cumulative stream deltas against the authoritative
   * `result.response` so a turn that emitted no deltas still renders. */
  private emitRemainingText(active: ActiveAgyTurn, response: string): void {
    if (active.settled || active.outputLimitExceeded) return;
    if (!response) return;
    if (active.emittedText === response) return;
    if (response.startsWith(active.emittedText)) {
      this.emitText(active, response.slice(active.emittedText.length));
      return;
    }
    // Divergent streams should not happen; prefer the streamed content over a
    // full replace to avoid a visual jump.
    if (!active.emittedText) this.emitText(active, response);
  }

  private emitToolUpdate(
    active: ActiveAgyTurn,
    update: {
      step_index?: number;
      state?: string;
      tool_name?: string;
      tool_info?: { name?: string; parameters?: unknown; output?: unknown };
    },
  ): void {
    if (active.settled || active.outputLimitExceeded) return;
    const name = update.tool_info?.name || update.tool_name;
    if (!name) return;
    const id = `agy-${update.step_index ?? 0}-${name}`;
    const toolCall: ToolCallEvent = {
      id,
      name,
      status: update.state === 'ACTIVE' ? 'started' : 'completed',
      ...(update.tool_info?.parameters !== undefined
        ? { input: update.tool_info.parameters }
        : {}),
      ...(update.tool_info?.output !== undefined
        ? { output: update.tool_info.output }
        : {}),
    };
    active.listener({ type: 'tool', toolCall });
  }

  private failOutputLimit(active: ActiveAgyTurn): void {
    if (active.settled || active.outputLimitExceeded) return;
    active.outputLimitExceeded = true;
    this.finishActiveTurn(active, {
      type: 'error',
      message: 'Antigravity CLI 输出超过安全上限，本轮已截断。',
      diagnostic: 'agy_output_limit_exceeded',
    });
    void this.teardownChildTree(active.child, active.processGroupId).catch(() => undefined);
  }

  async cancelAll(): Promise<void> {
    const teardowns = [...this.activeTurns].map(active => this.teardownChildTree(
      active.child,
      active.processGroupId,
    ));
    const results = await Promise.allSettled(teardowns);
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Antigravity CLI 进程树清理未完全收敛。');
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownBarrier) return this.shutdownBarrier;
    this.shutdownBarrier = this.cancelAll().finally(() => {
      this.shutdownBarrier = null;
    });
    return this.shutdownBarrier;
  }

  private async teardownChildTree(
    child: ChildProcess | null,
    processGroupId: number | null,
  ): Promise<void> {
    if (!child && processGroupId === null) return;
    const alive = (): boolean => {
      if (child && child.exitCode === null && child.signalCode === null) return true;
      if (processGroupId !== null) {
        try {
          process.kill(-processGroupId, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      return false;
    };
    if (!alive()) return;
    child?.stdin?.end();
    this.signalTree(processGroupId, child, 'SIGTERM');
    if (!await this.waitForExit(alive, AGY_TERM_GRACE_MS)) {
      this.signalTree(processGroupId, child, 'SIGKILL');
      if (!await this.waitForExit(alive, AGY_KILL_WAIT_MS)) {
        throw new Error('Antigravity CLI 进程树在 SIGKILL 后仍未退出。');
      }
    }
  }

  private signalTree(
    processGroupId: number | null,
    child: ChildProcess | null,
    signal: 'SIGTERM' | 'SIGKILL',
  ): void {
    if (processGroupId !== null) {
      try {
        process.kill(-processGroupId, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  }

  private waitForExit(alive: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const check = (): void => {
        if (!alive()) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(check, 20);
      };
      check();
    });
  }

  private setStatus(status: AgyRuntimeStatus): void {
    this.status = status;
    this.emit('status', this.getStatus());
  }

  private finishActiveTurn(active: ActiveAgyTurn, event?: RuntimeTurnEvent): void {
    if (active.settled) return;
    active.settled = true;
    if (event) active.listener(event);
    active.listener({
      type: 'done',
      ...(active.exposeSession && active.sessionId ? { sessionId: active.sessionId } : {}),
    });
    active.detachAbort();
    this.activeTurns.delete(active);
    active.settle();
  }
}
