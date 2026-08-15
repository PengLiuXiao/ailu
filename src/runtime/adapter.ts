import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { clearTimeout as cancelTimeout, setTimeout as scheduleTimeout } from 'timers';

import type { AgentId, ChatTurnRequest, ProviderProfile, RuntimeTurnEvent } from '../types';
import { runtimeEnvironment } from '../utils/env';
import { prepareCcSwitchProjection, prepareProviderProjection } from './providerProjection';
import {
  createClaudeStreamParserState,
  parseClaudeStreamLine,
  type ClaudeStreamParserState,
} from './parsers';
import {
  classifyClaudeProviderError,
  extractClaudeConnectorWarning,
  stripClaudeConnectorWarning,
} from './errors';
import { resolveClaudeRoutedModelLabel } from './localModels';
import {
  reconcileClaudeReasoningEffort,
  resolveClaudeReasoningCapability,
} from './reasoningCapabilities';
import { MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES } from './outputLimits';
import { assertManagedFrozenAttachments } from './frozenAttachments';

export interface AgentAdapterOptions {
  agentId: AgentId;
  binaryPath: string;
  providerProfile: ProviderProfile | null;
  ccSwitchRouteEnvironment?: NodeJS.ProcessEnv;
  ccSwitchClaudeConfigDir?: string;
  /** Production defaults to three seconds; tests may use a shorter grace. */
  terminationGraceMs?: number;
}

interface TerminationState {
  child: ChildProcess;
  processGroupId: number | null;
  escalationTimer: ReturnType<typeof scheduleTimeout> | null;
  livenessTimer: ReturnType<typeof scheduleTimeout> | null;
  settled: Promise<void>;
  resolve: () => void;
  finished: boolean;
  started: boolean;
}

const DEFAULT_TERMINATION_GRACE_MS = 3_000;
const PROCESS_GROUP_POLL_MS = 25;
export const CLAUDE_MAX_STDOUT_FRAME_BYTES = 1 * 1_024 * 1_024;
export const CLAUDE_MAX_RUNTIME_EVENT_BYTES = 512 * 1_024;
export const CLAUDE_MAX_TURN_OUTPUT_BYTES = MAX_PERSISTABLE_ASSISTANT_OUTPUT_BYTES;

export class AgentAdapter extends EventEmitter {
  private child: ChildProcess | null = null;
  private teardownBarrier: Promise<void> = Promise.resolve();
  private termination: TerminationState | null = null;
  private terminalErrorEmitted = false;
  private cancelled = false;
  private pendingTerminalError: Extract<RuntimeTurnEvent, { type: 'error' }> | null = null;
  private terminalErrorTimer: ReturnType<typeof scheduleTimeout> | null = null;
  private claudeStreamParserState: ClaudeStreamParserState = createClaudeStreamParserState();
  private requestedClaudeResumeSessionId: string | null = null;
  private emittedEventBytes = 0;

  constructor(private readonly options: AgentAdapterOptions) {
    super();
  }

  run(request: ChatTurnRequest): Promise<void> {
    let effectiveRequest = isolatedTextRequest(request);
    this.terminalErrorEmitted = false;
    this.cancelled = false;
    this.claudeStreamParserState = createClaudeStreamParserState();
    this.emittedEventBytes = 0;
    this.requestedClaudeResumeSessionId = this.options.agentId === 'claude'
      ? effectiveRequest.sessionId?.trim() || null
      : null;
    this.clearPendingTerminalError();
    if (process.platform === 'win32') {
      this.emitEvent({
        type: 'error',
        message: 'Windows 上无法验证 Claude 子进程树已完整退出，本次未启动。',
        diagnostic: 'windows_runtime_process_tree_unsupported',
      });
      this.emitEvent({ type: 'done' });
      return Promise.resolve();
    }
    if (this.options.agentId !== 'claude') {
      this.emitEvent({
        type: 'error',
        message: '当前 Agent 不支持通过 CLI Adapter 启动。',
      });
      this.emitEvent({ type: 'done' });
      return Promise.resolve();
    }
    try {
      effectiveRequest = {
        ...effectiveRequest,
        attachments: assertManagedFrozenAttachments(
          effectiveRequest.attachments ?? [],
          effectiveRequest.cwd,
        ),
      };
    } catch (error) {
      this.emitEvent({
        type: 'error',
        message: '附件隔离检查失败，Claude 运行时未启动。',
        detail: error instanceof Error ? error.message : String(error),
        diagnostic: 'runtime_attachment_isolation_failed',
      });
      this.emitEvent({ type: 'done' });
      return Promise.resolve();
    }
    if (
      this.options.agentId === 'claude'
      && effectiveRequest.configSource === 'ccSwitchCurrent'
      && (!effectiveRequest.model?.trim() || !this.options.ccSwitchClaudeConfigDir?.trim())
    ) {
      this.emitEvent({
        type: 'error',
        message: 'CC Switch 全局 Claude 模型配置不完整，本次未启动。',
      });
      this.emitEvent({ type: 'done' });
      return Promise.resolve();
    }
    const baseEnv = runtimeEnvironment(process.env);
    let projection: ReturnType<typeof prepareProviderProjection>;
    try {
      projection = effectiveRequest.configSource === 'ccSwitchCurrent'
        ? prepareCcSwitchProjection(
          baseEnv,
          this.options.ccSwitchRouteEnvironment ?? {},
          this.options.ccSwitchClaudeConfigDir ?? '',
          effectiveRequest.cwd,
        )
        : prepareProviderProjection(
          this.options.agentId,
          effectiveRequest.configSource === 'providerProfile' ? this.options.providerProfile : null,
          baseEnv,
        );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        type: 'error',
        message: 'Claude configuration isolation check failed; the runtime was not started.',
        detail,
        diagnostic: 'claude_config_isolation_failed',
      });
      this.emitEvent({ type: 'done' });
      return Promise.resolve();
    }
    const prompt = buildEffectivePrompt(effectiveRequest, this.options.agentId);
    const { args, stdinPayload } = this.buildArgs(effectiveRequest, prompt, projection.args);

    const teardownBarrier = new Promise<void>((resolve) => {
      let stdoutBuffer = '';
      let stdoutBufferBytes = 0;
      let stdoutBytes = 0;
      let stderrTail = '';
      let sawOutput = false;
      let projectionCleanedUp = false;
      const cleanupProjection = (): void => {
        if (projectionCleanedUp) return;
        projectionCleanedUp = true;
        projection.cleanup();
      };

      let child: ChildProcess;
      try {
        child = spawn(this.options.binaryPath, args, {
          cwd: effectiveRequest.cwd,
          env: projection.env,
          stdio: [stdinPayload === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
          // On Unix, use a dedicated process group so cancelling a CLI also
          // terminates tools or helper processes it spawned. Windows keeps the
          // regular child-process path because negative process-group PIDs are
          // not supported there.
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        cleanupProjection();
        this.terminalErrorEmitted = true;
        const detail = error instanceof Error ? error.message : String(error);
        this.emitEvent({ type: 'error', message: `Failed to start ${this.options.agentId}: ${detail}` });
        resolve();
        return;
      }
      this.child = child;
      const processState = this.createTerminationState(child);
      this.termination = processState;

      if (stdinPayload !== null && child.stdin) {
        // The runtime may exit before consuming stdin; swallow the resulting EPIPE.
        child.stdin.on('error', () => {});
        child.stdin.end(stdinPayload);
      }

      child.stdout?.on('data', (chunk: unknown) => {
        if (this.terminalErrorEmitted) return;
        sawOutput = true;
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stdoutBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(text, 'utf8');
        if (stdoutBytes > CLAUDE_MAX_TURN_OUTPUT_BYTES) {
          this.emitOutputLimitError('turn');
          return;
        }
        let start = 0;
        let newline = text.indexOf('\n', start);
        while (newline >= 0) {
          const fragment = text.slice(start, newline);
          const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
          if (stdoutBufferBytes + fragmentBytes > CLAUDE_MAX_STDOUT_FRAME_BYTES) {
            this.emitOutputLimitError('frame');
            return;
          }
          stdoutBuffer += fragment;
          const line = stdoutBuffer.endsWith('\r') ? stdoutBuffer.slice(0, -1) : stdoutBuffer;
          stdoutBuffer = '';
          stdoutBufferBytes = 0;
          this.emitParsed(line);
          if (this.terminalErrorEmitted) return;
          start = newline + 1;
          newline = text.indexOf('\n', start);
        }
        const remainder = text.slice(start);
        const remainderBytes = Buffer.byteLength(remainder, 'utf8');
        if (stdoutBufferBytes + remainderBytes > CLAUDE_MAX_STDOUT_FRAME_BYTES) {
          this.emitOutputLimitError('frame');
          return;
        }
        stdoutBuffer += remainder;
        stdoutBufferBytes += remainderBytes;
      });

      child.stderr?.on('data', (chunk: unknown) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        stderrTail = appendTail(stderrTail, text);
        if (this.options.agentId === 'claude' && this.options.providerProfile) {
          const classified = classifyClaudeProviderError(stderrTail, {
            providerName: this.options.providerProfile?.name,
            providerProfileId: this.options.providerProfile?.id,
          });
          if (classified) this.scheduleTerminalProviderError(classified);
        }
      });

      child.on('error', error => {
        this.clearPendingTerminalError();
        this.terminalErrorEmitted = true;
        this.emitEvent({ type: 'error', message: `Failed to start ${this.options.agentId}: ${error.message}` });
        // Node emits `close` after `error` once the child and all stdio streams
        // are closed. Cleanup and promise settlement deliberately happen only
        // there so callers never observe a completed turn while teardown is
        // still in flight.
      });

      const ensureProcessGroupTeardown = (): void => {
        if (!processState.started) {
          if (this.isTerminationTargetAlive(processState)) this.beginTermination(child);
          else this.finishTermination(processState);
          return;
        }
        this.observeTermination(processState);
      };

      child.on('exit', () => {
        // `close` waits for every inherited stdio descriptor. A descendant can
        // therefore keep it from ever firing after the direct CLI exits. Start
        // process-group teardown at `exit`; final turn settlement still waits
        // for `close`, the group barrier, and projection cleanup below.
        ensureProcessGroupTeardown();
      });

      child.on('close', (code, signal) => {
        if (!this.terminalErrorEmitted && stdoutBuffer.trim()) {
          this.emitParsed(stdoutBuffer);
        }
        if (this.child === child) this.child = null;
        this.flushTerminalProviderError();
        // The direct CLI can exit normally while a detached tool process keeps
        // running with stdio redirected. Because the PGID was captured at
        // spawn, every close path can still detect and terminate that orphan.
        ensureProcessGroupTeardown();
        void (async () => {
          // A detached descendant can outlive the direct child and even close
          // the inherited stdio pipes. Cancellation is not complete until the
          // original process group has disappeared (or has been escalated).
          await processState.settled;
          // Retain the finished state until `close` so a late repeated cancel
          // cannot construct a fresh state and signal a recycled PGID.
          if (this.termination === processState) this.termination = null;
          cleanupProjection();
          if (this.terminalErrorEmitted) {
            resolve();
            return;
          }
          if (this.cancelled) {
            this.emitEvent({ type: 'done' });
            resolve();
            return;
          }
          if (code === 0) {
            if (!sawOutput) {
              this.emitEvent({ type: 'text', content: 'The runtime finished without visible output.' });
            }
            this.emitEvent({ type: 'done' });
            resolve();
            return;
          }
          const message = `${this.options.agentId} exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`;
          const providerClaudeRun = this.options.agentId === 'claude' && Boolean(this.options.providerProfile);
          const cleanedStderr = providerClaudeRun
            ? stripClaudeConnectorWarning(stderrTail)
            : stderrTail.trim();
          this.emitEvent({
            type: 'error',
            message,
            detail: cleanedStderr || undefined,
            providerProfileId: this.options.providerProfile?.id,
            diagnostic: providerClaudeRun ? extractClaudeConnectorWarning(stderrTail) : undefined,
          });
          resolve();
        })();
      });
    });
    this.teardownBarrier = teardownBarrier;
    return teardownBarrier;
  }

  /**
   * Requests cancellation of only this adapter and resolves after the child
   * process, its stdio, and provider-projection cleanup have all completed.
   */
  cancel(): Promise<void> {
    const child = this.child;
    if (!child) return this.teardownBarrier;
    this.cancelled = true;
    this.beginTermination(child);
    return this.teardownBarrier;
  }

  onRuntimeEvent(listener: (event: RuntimeTurnEvent) => void): () => void {
    this.on('runtimeEvent', listener);
    return () => this.off('runtimeEvent', listener);
  }

  // Prompts include full file contents and can exceed the OS argv size limit
  // (ARG_MAX), so they are piped through stdin whenever the CLI supports it.
  private buildArgs(
    request: ChatTurnRequest,
    prompt: string,
    providerArgs: string[],
  ): { args: string[]; stdinPayload: string | null } {
    if (this.options.agentId === 'claude') {
      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        // Only user-level Claude settings are trusted. Vault-controlled
        // project/local settings and hooks are excluded for every launch,
        // including ordinary, Plan, provider, and resumed turns.
        '--setting-sources',
        'user',
      ];
      args.push(...providerArgs);
      if (request.textOnly) {
        // Use only flags present in supported Claude Code releases. Tool-free
        // isolation is established by an empty tool allowlist, disabled slash
        // commands, no session persistence, and excluding project/local
        // settings so a Vault cannot re-enable hooks or custom behavior.
        args.push(
          '--disable-slash-commands',
          '--tools',
          '',
          '--no-session-persistence',
          '--effort',
          'low',
          '--system-prompt',
          'Follow the user instructions exactly and return only the requested text output.',
        );
      } else {
        const reasoningEffort = this.resolveClaudeReasoningEffort(request);
        if (reasoningEffort) args.push('--effort', reasoningEffort);
      }
      const model = request.configSource === 'ccSwitchCurrent'
        ? request.model
        : request.configSource === 'providerProfile' && this.options.providerProfile
          ? this.options.providerProfile.defaultModel || this.options.providerProfile.model
          : request.model;
      if (model?.trim()) {
        args.push('--model', model.trim());
      }
      if (request.sessionId?.trim()) {
        args.push('--resume', request.sessionId.trim());
      }
      if (request.planMode) {
        args.push('--permission-mode', 'plan');
      } else if (request.fullAccess === true && !request.textOnly) {
        args.push('--dangerously-skip-permissions');
      }
      // `claude -p` without a positional prompt reads it from stdin.
      return { args, stdinPayload: prompt };
    }

    throw new Error('Unsupported CLI adapter.');
  }

  private resolveClaudeReasoningEffort(request: ChatTurnRequest): string {
    const profileModel = this.options.providerProfile?.defaultModel
      || this.options.providerProfile?.model
      || '';
    const routedModel = request.configSource === 'ccSwitchCurrent'
      ? resolveClaudeRoutedModelLabel(
        request.model?.trim() ?? '',
        this.options.ccSwitchRouteEnvironment ?? {},
      )
      : request.configSource === 'providerProfile'
        ? profileModel
        : null;
    const capability = resolveClaudeReasoningCapability({
      configSource: request.configSource,
      cliModel: request.model,
      routedModel,
    });
    return reconcileClaudeReasoningEffort(capability, request.reasoningEffort);
  }

  private emitParsed(line: string): void {
    if (this.terminalErrorEmitted) return;
    const events = parseClaudeStreamLine(line, this.claudeStreamParserState);
    for (const event of events) {
      let terminalEvent = false;
      // `claude --resume <id>` appends to that exact transcript. Some Claude
      // startup/hook stream envelopes can nevertheless expose a fresh
      // invocation id in `session_id`. Treating that transport-local id as the
      // canonical conversation silently breaks the next resume. The requested
      // id is already durably verified before Runtime starts, so mismatched
      // stream ids are noise unless `--fork-session` is explicitly used (this
      // adapter never adds that flag).
      if (
        event.type === 'session'
        && this.requestedClaudeResumeSessionId
        && event.sessionId.trim() !== this.requestedClaudeResumeSessionId
      ) {
        continue;
      }
      if (event.type === 'error') {
        if (this.terminalErrorEmitted) continue;
        const classified = this.options.agentId === 'claude' && this.options.providerProfile
          ? classifyClaudeProviderError(`${event.message}\n${event.detail ?? ''}`, {
            providerName: this.options.providerProfile?.name,
            providerProfileId: this.options.providerProfile?.id,
          })
          : null;
        if (classified) {
          this.scheduleTerminalProviderError(classified);
          continue;
        }
        terminalEvent = true;
      }
      if (!this.emitBoundedEvent(event)) return;
      if (terminalEvent) this.terminalErrorEmitted = true;
    }
  }

  private emitBoundedEvent(event: RuntimeTurnEvent): boolean {
    const eventBytes = jsonByteLength(event);
    if (
      !Number.isFinite(eventBytes)
      || eventBytes > CLAUDE_MAX_RUNTIME_EVENT_BYTES
    ) {
      this.emitOutputLimitError('event');
      return false;
    }
    if (this.emittedEventBytes + eventBytes > CLAUDE_MAX_TURN_OUTPUT_BYTES) {
      this.emitOutputLimitError('turn');
      return false;
    }
    this.emittedEventBytes += eventBytes;
    this.emitEvent(event);
    return true;
  }

  private emitOutputLimitError(kind: 'frame' | 'event' | 'turn'): void {
    if (this.terminalErrorEmitted) return;
    this.clearPendingTerminalError();
    this.terminalErrorEmitted = true;
    this.emit('runtimeEvent', {
      type: 'error',
      message: 'Claude 输出超过安全上限，已终止本次回合。',
      detail: kind === 'frame'
        ? '单个 stdout 数据帧过大。'
        : kind === 'event'
          ? '单个运行时事件过大。'
          : '本回合累计输出过大。',
      diagnostic: 'claude_output_limit_exceeded',
    } satisfies RuntimeTurnEvent);
    const child = this.child;
    if (child) this.beginTermination(child);
  }

  private emitTerminalProviderError(event: Extract<RuntimeTurnEvent, { type: 'error' }>): void {
    if (this.terminalErrorEmitted) return;
    this.clearPendingTerminalError();
    this.terminalErrorEmitted = true;
    this.emitEvent(event);
    const child = this.child;
    if (child) this.beginTermination(child);
  }

  private beginTermination(child: ChildProcess): void {
    const tracked = this.termination?.child === child ? this.termination : null;
    if (tracked?.started || tracked?.finished) return;
    // A single adapter instance is sequential. Its previous run cannot still
    // be terminating because `run()` waits the process-group barrier.
    if (this.termination && !tracked && !this.termination.finished) return;
    const state = tracked ?? this.createTerminationState(child);
    state.started = true;
    this.termination = state;

    // This is intentionally the only SIGTERM call for a run. Repeated cancel,
    // provider-error, and direct-parent-close paths reuse the same state.
    this.signalTerminationTarget(state, 'SIGTERM');
    state.escalationTimer = scheduleTimeout(() => {
      state.escalationTimer = null;
      if (state.finished) return;
      if (this.isTerminationTargetAlive(state)) {
        this.signalTerminationTarget(state, 'SIGKILL');
      }
      this.observeTermination(state);
    }, Math.max(0, this.options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS));
    this.observeTermination(state);
  }

  private createTerminationState(child: ChildProcess): TerminationState {
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    return {
      child,
      processGroupId: process.platform !== 'win32' && child.pid ? child.pid : null,
      escalationTimer: null,
      livenessTimer: null,
      settled,
      resolve: resolveSettled,
      finished: false,
      started: false,
    };
  }

  private signalTerminationTarget(state: TerminationState, signal: NodeJS.Signals): void {
    if (state.processGroupId !== null) {
      try {
        process.kill(-state.processGroupId, signal);
        return;
      } catch {
        // The group may have disappeared between the liveness check and signal.
        // Only the initial TERM may fall back to the still-identical child;
        // never target a recycled positive PID during delayed escalation.
        if (signal === 'SIGKILL') return;
      }
    }
    const child = state.child;
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // The close/error lifecycle remains the source of truth for teardown.
      }
    }
  }

  private observeTermination(state: TerminationState): void {
    if (state.finished || this.termination !== state) return;
    if (!this.isTerminationTargetAlive(state)) {
      this.finishTermination(state);
      return;
    }
    if (state.livenessTimer !== null) return;
    state.livenessTimer = scheduleTimeout(() => {
      state.livenessTimer = null;
      this.observeTermination(state);
    }, PROCESS_GROUP_POLL_MS);
  }

  private isTerminationTargetAlive(state: TerminationState): boolean {
    if (state.processGroupId !== null) {
      try {
        process.kill(-state.processGroupId, 0);
        return true;
      } catch (error) {
        return isErrnoException(error) && error.code === 'EPERM';
      }
    }
    return Boolean(state.child.pid)
      && state.child.exitCode === null
      && state.child.signalCode === null;
  }

  private finishTermination(state: TerminationState): void {
    if (state.finished) return;
    state.finished = true;
    if (state.escalationTimer !== null) cancelTimeout(state.escalationTimer);
    if (state.livenessTimer !== null) cancelTimeout(state.livenessTimer);
    state.escalationTimer = null;
    state.livenessTimer = null;
    state.resolve();
  }

  private scheduleTerminalProviderError(event: Extract<RuntimeTurnEvent, { type: 'error' }>): void {
    if (this.terminalErrorEmitted) return;
    const pending = this.pendingTerminalError;
    this.pendingTerminalError = pending
      ? {
        ...event,
        detail: event.detail && event.detail.length >= (pending.detail?.length ?? 0) ? event.detail : pending.detail,
        statusCode: event.statusCode ?? pending.statusCode,
        retryAfterSeconds: event.retryAfterSeconds ?? pending.retryAfterSeconds,
        requestId: event.requestId ?? pending.requestId,
        providerProfileId: event.providerProfileId ?? pending.providerProfileId,
        diagnostic: event.diagnostic ?? pending.diagnostic,
      }
      : event;
    if (this.terminalErrorTimer) cancelTimeout(this.terminalErrorTimer);
    // Claude often prints the request id on the next stderr line. A short
    // debounce keeps the failure immediate while preserving that metadata.
    this.terminalErrorTimer = scheduleTimeout(() => this.flushTerminalProviderError(), 40);
  }

  private flushTerminalProviderError(): void {
    const event = this.pendingTerminalError;
    this.clearPendingTerminalError();
    if (event) this.emitTerminalProviderError(event);
  }

  private clearPendingTerminalError(): void {
    if (this.terminalErrorTimer) cancelTimeout(this.terminalErrorTimer);
    this.terminalErrorTimer = null;
    this.pendingTerminalError = null;
  }

  private emitEvent(event: RuntimeTurnEvent): void {
    this.emit('runtimeEvent', event);
  }
}

/**
 * Text-only and context-compression requests are deliberately stateless. This
 * normalization lives at the process boundary so an accidental caller value
 * cannot re-enable a native session, attachments, planning, or full access.
 */
function isolatedTextRequest(request: ChatTurnRequest): ChatTurnRequest {
  if (!request.textOnly && request.purpose !== 'contextCompression') return request;
  return {
    ...request,
    purpose: request.purpose,
    sessionId: undefined,
    attachments: [],
    fullAccess: false,
    planMode: false,
    textOnly: true,
    systemPrompt: undefined,
    freshSessionPrompt: undefined,
    allowFreshSessionFallback: false,
  };
}

function buildEffectivePrompt(request: ChatTurnRequest, agentId: AgentId): string {
  const sections: string[] = [];
  if (request.systemPrompt?.trim()) {
    sections.push(`System guidance:\n${request.systemPrompt.trim()}`);
  }
  sections.push(request.prompt);
  if (agentId === 'claude') {
    const attachmentPaths = (request.attachments ?? []).map(attachment => `- ${attachment.absolutePath}`);
    if (attachmentPaths.length > 0) {
      sections.push(`Attached files (use your file tools to read them):\n${attachmentPaths.join('\n')}`);
    }
  }
  return sections.join('\n\n');
}

function appendTail(current: string, addition: string): string {
  const next = current + addition;
  return next.length > 24_000 ? next.slice(next.length - 24_000) : next;
}

function jsonByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
