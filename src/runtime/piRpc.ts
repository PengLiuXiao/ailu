import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

/**
 * Pi RPC transport.
 *
 * Pi speaks a strict JSONL protocol over stdin/stdout (LF is the only
 * delimiter; U+2028/U+2029 are valid inside JSON strings, so line splitting
 * must never use generic line-reader semantics). Commands carry an optional
 * `id`; responses echo it. Every other stdout line is an event.
 */
export interface PiRpcCommand {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  type: 'response';
  command: string;
  success: boolean;
  id?: number | string;
  data?: unknown;
  error?: PiRpcErrorBody;
}

export interface PiRpcErrorBody {
  message?: string;
  [key: string]: unknown;
}

export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

export class PiRpcRequestError extends Error {
  readonly command: string;
  readonly errorBody: PiRpcErrorBody | undefined;

  constructor(command: string, errorBody: PiRpcErrorBody | undefined, message: string) {
    super(message);
    this.name = 'PiRpcRequestError';
    this.command = command;
    this.errorBody = errorBody;
  }
}

export interface PiRpcConnectOptions {
  executablePath: string;
  /** Extra CLI flags placed after `--mode rpc`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export const PI_RPC_MAX_STDOUT_FRAME_BYTES = 1 * 1_024 * 1_024;
export const PI_RPC_TERM_GRACE_MS = 2_000;
export const PI_RPC_KILL_WAIT_MS = 2_000;
export const PI_RPC_CONNECT_TIMEOUT_MS = 15_000;

export interface PiRpcClientOptions {
  killWaitMs?: number;
  termGraceMs?: number;
}

export class PiRpcClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private executablePath: string | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stdoutBuffer = '';
  private stdoutBufferBytes = 0;
  private stderrTail = '';
  private ready = false;
  private disconnecting = false;
  private disconnectBarrier: Promise<void> | null = null;
  private outputLimitExceeded = false;
  private processGroupId: number | null = null;

  constructor(private readonly options: PiRpcClientOptions = {}) {
    super();
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isRunning(): boolean {
    if (this.child && !this.childExited(this.child)) return true;
    return this.processTreeAlive(this.processGroupId, this.child);
  }

  get connectedExecutablePath(): string | null {
    return this.executablePath;
  }

  get lastStderrTail(): string {
    return this.stderrTail;
  }

  /**
   * Spawns `pi --mode rpc` and resolves once a `get_state` round trip proves
   * the protocol is live. Pi has no initialize handshake; this readiness gate
   * is what turns "old pi without RPC support" into an actionable error.
   */
  async connect(options: PiRpcConnectOptions): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('Pi RPC 运行时在 Windows 上不可用，因为无法验证子进程树已完整退出。');
    }
    if (this.isRunning && this.executablePath === options.executablePath && this.ready) return;
    if (this.child || this.processGroupId !== null) await this.disconnect();

    this.disconnecting = false;
    this.ready = false;
    this.stdoutBuffer = '';
    this.stdoutBufferBytes = 0;
    this.stderrTail = '';
    this.outputLimitExceeded = false;
    this.executablePath = options.executablePath;

    const child = spawn(options.executablePath, ['--mode', 'rpc', ...(options.args ?? [])], {
      env: options.env ?? process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    this.child = child;
    this.processGroupId = child.pid ?? null;

    child.stdout?.on('data', (chunk: unknown) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.handleStdout(text);
    });
    child.stderr?.on('data', (chunk: unknown) => {
      const text = (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)).trim();
      if (text) {
        this.stderrTail = `${this.stderrTail}\n${text}`.slice(-8_000).trim();
        this.emit('log', 'warn', text);
      }
    });
    child.on('error', error => this.handleFatal(error));
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));

    await this.request({ type: 'get_state' }, PI_RPC_CONNECT_TIMEOUT_MS);
    this.ready = true;
  }

  request<T = unknown>(command: PiRpcCommand, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      return Promise.reject(new Error('Pi RPC 进程未运行。'));
    }
    const id = `ailu-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC 命令 '${command.type}' 超时。`));
      }, timeoutMs);
      this.pending.set(id, {
        command: command.type,
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
      this.write({ id, ...command });
    });
  }

  /** Sends a command without waiting for a correlated response. */
  send(command: PiRpcCommand): void {
    this.write(command);
  }

  /** Answers a blocking `extension_ui_request` emitted as an event. */
  respondUiRequest(id: number | string, payload: Record<string, unknown>): void {
    this.write({ type: 'extension_ui_response', id, ...payload });
  }

  async disconnect(): Promise<void> {
    if (this.disconnectBarrier) return this.disconnectBarrier;
    const barrier = this.disconnectChildTree();
    this.disconnectBarrier = barrier;
    try {
      await barrier;
    } finally {
      if (this.disconnectBarrier === barrier) this.disconnectBarrier = null;
    }
  }

  private async disconnectChildTree(): Promise<void> {
    const child = this.child;
    const processGroupId = this.processGroupId ?? child?.pid ?? null;
    this.disconnecting = true;
    this.ready = false;
    this.executablePath = null;
    this.rejectPending(new Error('Pi RPC 进程已断开。'));
    if (!child && processGroupId === null) return;

    child?.stdin?.end();
    await this.signalProcessTree(child, processGroupId, 'SIGTERM');
    const graceful = await this.waitForProcessTreeExit(
      child,
      processGroupId,
      this.options.termGraceMs ?? PI_RPC_TERM_GRACE_MS,
    );
    if (!graceful) {
      await this.signalProcessTree(child, processGroupId, 'SIGKILL');
      const killed = await this.waitForProcessTreeExit(
        child,
        processGroupId,
        this.options.killWaitMs ?? PI_RPC_KILL_WAIT_MS,
      );
      if (!killed) {
        throw new Error('Pi RPC 进程树在 SIGKILL 后仍未退出。');
      }
    }
    if (this.child === child && child && this.childExited(child)) this.child = null;
    if (this.processGroupId === processGroupId) this.processGroupId = null;
  }

  private childExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  private processTreeAlive(processGroupId: number | null, child: ChildProcess | null): boolean {
    if (process.platform === 'win32') {
      if (child || processGroupId !== null) {
        throw new Error('Pi 进程树存活状态在 Windows 上无法验证。');
      }
      return false;
    }
    if (processGroupId === null) return Boolean(child && !this.childExited(child));
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'EPERM';
    }
  }

  private async signalProcessTree(
    child: ChildProcess | null,
    processGroupId: number | null,
    signal: 'SIGTERM' | 'SIGKILL',
  ): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('Pi 进程树清理在 Windows 上不可用。');
    }
    if (processGroupId !== null) {
      try {
        process.kill(-processGroupId, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (child && !this.childExited(child)) child.kill(signal);
  }

  private waitForProcessTreeExit(
    child: ChildProcess | null,
    processGroupId: number | null,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise(resolve => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let timer: number | null = null;
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        child?.removeListener('exit', check);
        resolve(value);
      };
      const check = (): void => {
        const childGone = !child || this.childExited(child);
        if (childGone && !this.processTreeAlive(processGroupId, child)) {
          finish(true);
          return;
        }
        if (Date.now() >= deadline) {
          finish(false);
          return;
        }
        timer = window.setTimeout(check, 20);
      };
      child?.on('exit', check);
      check();
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) {
      this.emit('log', 'warn', 'Pi RPC stdin 不可写。');
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(text: string): void {
    if (this.outputLimitExceeded) return;
    let start = 0;
    let newline = text.indexOf('\n', start);
    while (newline >= 0) {
      if (!this.appendStdoutFragment(text.slice(start, newline))) return;
      const line = this.stdoutBuffer.trim();
      this.stdoutBuffer = '';
      this.stdoutBufferBytes = 0;
      if (line) this.handleLine(line);
      if (this.outputLimitExceeded) return;
      start = newline + 1;
      newline = text.indexOf('\n', start);
    }
    this.appendStdoutFragment(text.slice(start));
  }

  private appendStdoutFragment(fragment: string): boolean {
    const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
    if (this.stdoutBufferBytes + fragmentBytes > PI_RPC_MAX_STDOUT_FRAME_BYTES) {
      this.failOutputLimit();
      return false;
    }
    this.stdoutBuffer += fragment;
    this.stdoutBufferBytes += fragmentBytes;
    return true;
  }

  private failOutputLimit(): void {
    if (this.outputLimitExceeded) return;
    this.outputLimitExceeded = true;
    this.stdoutBuffer = '';
    this.stdoutBufferBytes = 0;
    const error = new Error('Pi RPC stdout 帧超出安全字节上限。');
    this.ready = false;
    this.rejectPending(error);
    void this.disconnect().then(() => {
      this.emit('close', error.message);
    }).catch(disconnectError => {
      this.emit('close', `${error.message} 进程树清理失败：${String(disconnectError)}`);
    });
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit('log', 'warn', `Pi RPC 返回非 JSON 输出：${line.slice(0, 240)}`);
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message.type === 'response') {
      const response = message as unknown as PiRpcResponse;
      const id = response.id;
      if (id !== undefined) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          window.clearTimeout(pending.timeout);
          if (response.success === false) {
            const errorText = typeof response.error === 'object' && response.error !== null
              ? String(response.error.message ?? JSON.stringify(response.error).slice(0, 400))
              : 'Pi RPC 命令失败。';
            pending.reject(new PiRpcRequestError(response.command, response.error, errorText));
          } else {
            pending.resolve(response.data);
          }
          return;
        }
      }
      this.emit('response', response);
      return;
    }
    if (message.type === 'extension_ui_request') {
      this.emit('uiRequest', message);
      return;
    }
    this.emit('piEvent', message);
  }

  private handleFatal(error: Error): void {
    this.ready = false;
    this.rejectPending(error);
    void this.disconnect().then(() => {
      this.emit('close', error.message);
    }).catch(disconnectError => {
      this.emit('close', `${error.message}; 进程树清理失败：${String(disconnectError)}`);
    });
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = null;
    this.ready = false;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    const detail = this.stderrTail ? `${reason}: ${this.stderrTail}` : reason;
    this.rejectPending(new Error(`Pi RPC 进程意外退出（${detail}）。`));
    if (this.disconnecting) return;
    const processGroupId = this.processGroupId ?? child.pid ?? null;
    const barrier = (async (): Promise<void> => {
      try {
        await this.signalProcessTree(null, processGroupId, 'SIGTERM');
        const graceful = await this.waitForProcessTreeExit(
          null,
          processGroupId,
          this.options.termGraceMs ?? PI_RPC_TERM_GRACE_MS,
        );
        if (!graceful) {
          await this.signalProcessTree(null, processGroupId, 'SIGKILL');
          const killed = await this.waitForProcessTreeExit(
            null,
            processGroupId,
            this.options.killWaitMs ?? PI_RPC_KILL_WAIT_MS,
          );
          if (!killed) throw new Error('descendant process tree remained alive after SIGKILL');
        }
        if (this.processGroupId === processGroupId) this.processGroupId = null;
        this.emit('close', detail);
      } catch (error) {
        this.emit('close', `${detail}; 进程树清理失败：${String(error)}`);
      }
    })();
    this.disconnectBarrier = barrier;
    void barrier.finally(() => {
      if (this.disconnectBarrier === barrier) this.disconnectBarrier = null;
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

interface PendingRequest {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

/** Lean flags for capability probes: no session, no discovery, no network. */
export function buildPiRpcProbeArgs(): string[] {
  return [
    '--no-session',
    '--offline',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
  ];
}

export interface PiRpcProbeResult {
  state: 'ready' | 'unavailable' | 'unsupported';
  /** User-facing Chinese message describing the outcome and next action. */
  message: string;
  detail?: string;
}

/**
 * Verifies that the discovered `pi` binary actually speaks RPC mode. An old or
 * incompatible Pi must be reported before any turn is attempted, with an
 * upgrade path, instead of failing mid-conversation.
 */
export async function probePiRpcCapability(
  options: PiRpcConnectOptions & { timeoutMs?: number },
): Promise<PiRpcProbeResult> {
  if (process.platform === 'win32') {
    return {
      state: 'unavailable',
      message: 'Windows 上无法验证 Pi 子进程树已完整退出，Pi 运行时未启动。',
    };
  }
  const client = new PiRpcClient();
  try {
    await client.connect({
      executablePath: options.executablePath,
      args: buildPiRpcProbeArgs(),
      env: options.env,
      cwd: options.cwd,
    });
    return {
      state: 'ready',
      message: '已连接，Pi RPC 模式可用。',
    };
  } catch (error) {
    const detail = client.lastStderrTail || String(error);
    if (/--mode|unknown option|unrecognized/i.test(detail)) {
      return {
        state: 'unsupported',
        message: '当前 Pi 版本不支持 RPC 模式，请升级 Pi 后重试。',
        detail,
      };
    }
    return {
      state: 'unavailable',
      message: '无法启动 Pi RPC 进程，请检查 Pi 安装与本机配置。',
      detail,
    };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}
