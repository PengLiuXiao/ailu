import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import { PLUGIN_NAME, PROTOCOL_IDS } from '../ids';

export interface JsonRpcError {
  code: number | string;
  message: string;
  data?: unknown;
}

/**
 * Preserves the machine-readable JSON-RPC failure envelope. Callers that need
 * a narrowly-scoped recovery path must not infer it from a flattened message.
 */
export class CodexJsonRpcError extends Error {
  readonly code: number | string;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, error: JsonRpcError) {
    super(error.message || `Codex App Server error ${error.code}`);
    this.name = 'CodexJsonRpcError';
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }
}

export interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export interface CodexAppServerConnectOptions {
  executablePath: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
}

/**
 * Codex CLI has changed the accepted service-tier values over time. The
 * desktop config can retain an older `default`/`priority` value, which makes
 * a newer app-server reject the whole configuration before a thread starts.
 * `fast` is accepted by current CLI versions and is safely omitted by Codex
 * when the selected model does not advertise that tier.
 */
export function buildCodexAppServerArgs(): string[] {
  return ['app-server', '-c', 'service_tier="fast"', '--listen', 'stdio://'];
}

export const CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES = 1 * 1_024 * 1_024;
export const CODEX_APP_SERVER_TERM_GRACE_MS = 2_000;
export const CODEX_APP_SERVER_KILL_WAIT_MS = 2_000;

export interface CodexAppServerClientOptions {
  killWaitMs?: number;
  termGraceMs?: number;
}

export class CodexAppServerClient extends EventEmitter {
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

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
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

  async connect(options: CodexAppServerConnectOptions): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('Codex App Server is disabled on Windows because process-tree teardown cannot be verified.');
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

    const child = spawn(options.executablePath, buildCodexAppServerArgs(), {
      env: options.env ?? process.env,
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

    await this.request('initialize', {
      clientInfo: {
        name: PROTOCOL_IDS.codexClientName,
        title: PLUGIN_NAME,
        version: options.clientVersion ?? '0.3.2',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, 10_000);
    this.notify('initialized', {});
    this.ready = true;
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child || this.child.killed || this.child.exitCode !== null) {
      return Promise.reject(new Error('Codex App Server is not running'));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request '${method}' timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  reject(id: number | string, code: number | string, message: string, data?: unknown): void {
    this.write({ id, error: { code, message, data } });
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
    this.rejectPending(new Error('Codex App Server disconnected'));
    if (!child && processGroupId === null) return;

    child?.stdin?.end();
    await this.signalProcessTree(child, processGroupId, 'SIGTERM');
    const graceful = await this.waitForProcessTreeExit(
      child,
      processGroupId,
      this.options.termGraceMs ?? CODEX_APP_SERVER_TERM_GRACE_MS,
    );
    if (!graceful) {
      await this.signalProcessTree(child, processGroupId, 'SIGKILL');
      const killed = await this.waitForProcessTreeExit(
        child,
        processGroupId,
        this.options.killWaitMs ?? CODEX_APP_SERVER_KILL_WAIT_MS,
      );
      if (!killed) {
        throw new Error('Codex App Server process tree did not exit after SIGKILL.');
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
        throw new Error('Codex process-tree liveness cannot be verified on Windows.');
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
      throw new Error('Codex process-tree teardown is unavailable on Windows.');
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

  private write(message: JsonRpcMessage): void {
    if (!this.child?.stdin?.writable) {
      this.emit('log', 'warn', 'Codex App Server stdin is not writable');
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
    if (this.stdoutBufferBytes + fragmentBytes > CODEX_APP_SERVER_MAX_STDOUT_FRAME_BYTES) {
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
    const error = new Error('Codex App Server stdout frame exceeded the safe byte limit.');
    this.ready = false;
    this.rejectPending(error);
    // A protocol peer that violates the frame bound is no longer trusted for
    // any active turn. Do not publish `close` until the physical process tree
    // has crossed the exit barrier.
    void this.disconnect().then(() => {
      this.emit('close', error.message);
    }).catch(disconnectError => {
      this.emit('close', `${error.message} Process-tree teardown failed: ${String(disconnectError)}`);
    });
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.emit('log', 'warn', `Codex App Server returned non-JSON output: ${line.slice(0, 240)}`);
      return;
    }

    if (message.id !== undefined) {
      if (message.method) {
        this.emit('serverRequest', message.id, message.method, message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        window.clearTimeout(pending.timeout);
        if (message.error) {
          pending.reject(new CodexJsonRpcError(pending.method, message.error));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      return;
    }

    if (message.method) this.emit('notification', message.method, message.params);
  }

  private handleFatal(error: Error): void {
    this.ready = false;
    this.rejectPending(error);
    void this.disconnect().then(() => {
      this.emit('close', error.message);
    }).catch(disconnectError => {
      this.emit('close', `${error.message}; process-tree teardown failed: ${String(disconnectError)}`);
    });
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child === child) this.child = null;
    this.ready = false;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    const detail = this.stderrTail ? `${reason}: ${this.stderrTail}` : reason;
    this.rejectPending(new Error(`Codex App Server exited with ${detail}`));
    if (this.disconnecting) return;
    const processGroupId = this.processGroupId ?? child.pid ?? null;
    const barrier = (async (): Promise<void> => {
      try {
        await this.signalProcessTree(null, processGroupId, 'SIGTERM');
        const graceful = await this.waitForProcessTreeExit(
          null,
          processGroupId,
          this.options.termGraceMs ?? CODEX_APP_SERVER_TERM_GRACE_MS,
        );
        if (!graceful) {
          await this.signalProcessTree(null, processGroupId, 'SIGKILL');
          const killed = await this.waitForProcessTreeExit(
            null,
            processGroupId,
            this.options.killWaitMs ?? CODEX_APP_SERVER_KILL_WAIT_MS,
          );
          if (!killed) throw new Error('descendant process tree remained alive after SIGKILL');
        }
        if (this.processGroupId === processGroupId) this.processGroupId = null;
        this.emit('close', detail);
      } catch (error) {
        this.emit('close', `${detail}; process-tree teardown failed: ${String(error)}`);
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
