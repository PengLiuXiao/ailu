import { createHmac, randomBytes } from 'crypto';

import type {
  AgentId,
  AgentStatus,
  ChatTurnRequest,
  CodexRuntimeStatus,
  ProviderProfile,
  RuntimeExecutionFingerprint,
  RuntimeTurnEvent,
  AiluSettings,
} from '../types';
import { ProviderStore } from '../storage/providerStore';
import { appendLocalLog } from '../storage/localLog';
import { providerHost, requiresProviderApiKey, resolveAnthropicAuthMode } from '../utils/providerAuth';
import { RuntimeDiscovery } from './discovery';
import { AgentAdapter } from './adapter';
import { runtimeEnvironment } from '../utils/env';
import { CodexAppServerRuntime } from './codexRuntime';
import {
  CcSwitchClient,
  ccSwitchGlobalSnapshot,
  ccSwitchSnapshotLabel,
  type CcSwitchSnapshot,
} from './ccSwitch';
import { resolveClaudeCcSwitchSessionConfig } from './localModels';

export type RuntimeEventListener = (event: RuntimeTurnEvent) => void;

type RuntimeManagerLifecycle = 'running' | 'shuttingDown' | 'closed';

interface ManagerRunRegistration {
  epoch: number;
  controller: AbortController;
  detachCallerAbort: () => void;
  settled: Promise<void>;
  resolve: () => void;
}

export class RuntimeManager {
  // Multiple turns can be in flight at once (chat + inline edit), so track every
  // live adapter instead of only the most recent one.
  private readonly activeAdapters = new Set<AgentAdapter>();
  private readonly cooldownByProfile = new Map<string, number>();
  private readonly ccSwitchStatusListeners = new Set<(snapshot: CcSwitchSnapshot) => void>();
  private readonly inflightRuns = new Set<ManagerRunRegistration>();
  private readonly maintenanceOperations = new Set<Promise<unknown>>();
  /** Prevents opaque execution stamps from becoming stable hashes of secrets. */
  private readonly executionFingerprintKey = randomBytes(32);
  private lifecycle: RuntimeManagerLifecycle = 'running';
  private lifecycleEpoch = 0;
  private shutdownBarrier: Promise<void> | null = null;

  constructor(
    private readonly providerStore: ProviderStore,
    private getSettings: () => AiluSettings,
    private readonly ccSwitchClient = new CcSwitchClient(),
    private readonly codexRuntime = new CodexAppServerRuntime(),
  ) {}

  getCcSwitchSnapshot(): CcSwitchSnapshot {
    return this.ccSwitchClient.getSnapshot();
  }

  onCcSwitchStatusChange(listener: (snapshot: CcSwitchSnapshot) => void): () => void {
    this.ccSwitchStatusListeners.add(listener);
    return () => this.ccSwitchStatusListeners.delete(listener);
  }

  async refreshCcSwitchStatus(): Promise<CcSwitchSnapshot> {
    if (this.lifecycle !== 'running') return this.ccSwitchClient.getSnapshot();
    const epoch = this.lifecycleEpoch;
    const operation = this.ccSwitchClient.refresh();
    this.maintenanceOperations.add(operation);
    let snapshot: CcSwitchSnapshot;
    try {
      snapshot = await operation;
    } finally {
      this.maintenanceOperations.delete(operation);
    }
    if (this.lifecycle !== 'running' || epoch !== this.lifecycleEpoch) return snapshot;
    for (const listener of this.ccSwitchStatusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error('Ailu CC Switch status listener failed.', error);
      }
    }
    return snapshot;
  }

  resolveStatus(request: ChatTurnRequest): AgentStatus {
    const settings = this.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(request.agentId, {
      withVersion: request.agentId === 'codex' && process.platform !== 'win32',
    });
    if (process.platform !== 'win32') return status;
    return {
      ...status,
      state: 'unsupported',
      found: false,
      binaryPath: null,
      source: null,
      version: null,
      error: 'Windows 上无法验证 Agent 子进程树已完整退出。',
    };
  }

  getCodexStatus(): CodexRuntimeStatus {
    return this.codexRuntime.getStatus();
  }

  onCodexStatusChange(listener: (status: CodexRuntimeStatus) => void): () => void {
    return this.codexRuntime.onStatusChange(listener);
  }

  /**
   * Captures the exact live execution configuration before a request is queued.
   * The returned HMAC is meaningful only to this RuntimeManager instance and
   * is safe to keep in memory; callers must not persist it as session metadata.
   */
  captureExecutionFingerprint(
    request: Pick<
      ChatTurnRequest,
      | 'agentId'
      | 'cwd'
      | 'configSource'
      | 'providerProfileId'
      | 'model'
      | 'reasoningEffort'
      | 'fullAccess'
      | 'planMode'
      | 'textOnly'
      | 'purpose'
      | 'allowFreshSessionFallback'
    >,
  ): RuntimeExecutionFingerprint {
    if (!isSupportedRuntimeAgentId(request.agentId)) {
      throw new Error('Unsupported agent runtime.');
    }
    const snapshot = this.executionFingerprintSnapshot(request);
    return {
      executionFingerprint: this.signExecutionFingerprint(snapshot.payload),
      ...(snapshot.providerProfileUpdatedAt === undefined
        ? {}
        : { providerProfileUpdatedAt: snapshot.providerProfileUpdatedAt }),
    };
  }

  async refreshCodexStatus(): Promise<CodexRuntimeStatus> {
    if (this.lifecycle !== 'running') return this.codexRuntime.getStatus();
    if (process.platform === 'win32') {
      await this.codexRuntime.markUnavailable('Windows 上无法验证 Codex 子进程树已完整退出。');
      return this.codexRuntime.getStatus();
    }
    const epoch = this.lifecycleEpoch;
    const settings = this.getSettings();
    const discovery = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve('codex', { withVersion: true });
    const operation = discovery.binaryPath
      ? this.codexRuntime.refreshStatus({
        binaryPath: discovery.binaryPath,
        binarySource: discovery.source,
        version: discovery.version,
        env: runtimeEnvironment(process.env),
      })
      : this.codexRuntime.markUnavailable(discovery.error ?? 'codex was not found.').then(() => (
        this.codexRuntime.getStatus()
      ));
    this.maintenanceOperations.add(operation);
    try {
      const status = await operation;
      if (this.lifecycle !== 'running' || epoch !== this.lifecycleEpoch) return this.codexRuntime.getStatus();
      return status;
    } finally {
      this.maintenanceOperations.delete(operation);
    }
  }

  /**
   * Runs one turn and delivers its events only to the provided listener, so
   * concurrent runs (for example chat and inline edit) never see each other's
   * output.
   */
  async runTurn(request: ChatTurnRequest, onEvent: RuntimeEventListener): Promise<void> {
    if (this.lifecycle !== 'running') {
      onEvent({
        type: 'error',
        message: this.lifecycle === 'closed'
          ? '运行时已关闭，请重载插件后重试。'
          : '运行时正在关闭。',
        diagnostic: 'runtime_manager_closed',
      });
      onEvent({ type: 'done' });
      return;
    }

    if (process.platform === 'win32') {
      onEvent({
        type: 'error',
        message: 'Windows 上无法验证 Agent 子进程树已完整退出，本次未启动。',
        diagnostic: 'windows_runtime_process_tree_unsupported',
      });
      onEvent({ type: 'done' });
      return;
    }
    const registration = this.registerRun(request.signal);
    try {
      await this.executeRunTurn(
        { ...request, signal: registration.controller.signal },
        onEvent,
        registration,
      );
    } finally {
      registration.detachCallerAbort();
      this.inflightRuns.delete(registration);
      registration.resolve();
    }
  }

  private async executeRunTurn(
    request: ChatTurnRequest,
    onEvent: RuntimeEventListener,
    registration: ManagerRunRegistration,
  ): Promise<void> {
    const deliver = (event: RuntimeTurnEvent): void => {
      if (event.type === 'diagnostic') {
        appendLocalLog('runtime_diagnostic', {
          code: event.code,
          message: event.message,
          detail: event.detail,
        });
      } else if (event.type === 'error') {
        if (event.providerProfileId && event.retryAfterSeconds) {
          this.cooldownByProfile.set(event.providerProfileId, Date.now() + event.retryAfterSeconds * 1_000);
        }
        appendLocalLog('runtime_error', {
          message: event.message,
          detail: event.detail,
          statusCode: event.statusCode,
          retryAfterSeconds: event.retryAfterSeconds,
          requestId: event.requestId,
          providerProfileId: event.providerProfileId,
          diagnostic: event.diagnostic,
        });
      }
      onEvent(event);
    };

    if (!isSupportedRuntimeAgentId(request.agentId)) {
      deliver({
        type: 'error',
        message: '该 Agent 已不受 Ailu 支持。',
        diagnostic: 'unsupported_agent_runtime',
      });
      deliver({ type: 'done' });
      return;
    }

    if (!this.canContinue(registration)) {
      deliver({ type: 'done' });
      return;
    }

    if (!this.executionFingerprintIsCurrent(request)) {
      this.emitExecutionConfigChanged(deliver);
      return;
    }

    if (request.purpose === 'contextCompression' && request.agentId !== 'claude') {
      deliver({
        type: 'error',
        message: '当前运行时不能安全执行上下文压缩。',
        detail: 'Ailu 已阻止带内建工具的压缩请求；请由上层使用本地回退。',
        diagnostic: 'context_compression_local_fallback_required',
      });
      deliver({ type: 'done' });
      return;
    }

    const settings = this.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(request.agentId, { withVersion: request.agentId === 'codex' });
    if (!status.binaryPath) {
      appendLocalLog('runtime_missing', { agentId: request.agentId, error: status.error });
      deliver({
        type: 'error',
        message: `${status.descriptor.displayName} is not installed.`,
        detail: status.error ?? undefined,
      });
      return;
    }

    if (request.agentId === 'codex') {
      if (request.configSource !== 'localCli') {
        deliver({
          type: 'error',
          message: 'Codex 仅支持本机 Codex App 配置。',
          detail: '旧 Codex Provider Profile 已保留，但不会参与执行。',
        });
        deliver({ type: 'done' });
        return;
      }
      const startedAt = Date.now();
      appendLocalLog('runtime_turn_start', {
        agentId: 'codex',
        configSource: 'localCli',
        binarySource: status.source,
        model: this.codexRuntime.getStatus().currentModelId,
      });
      if (!this.executionFingerprintIsCurrent(request)) {
        this.emitExecutionConfigChanged(deliver);
        return;
      }
      await this.codexRuntime.runTurn(request, {
        binaryPath: status.binaryPath,
        binarySource: status.source,
        version: status.version,
        env: runtimeEnvironment(process.env),
        executionIsCurrent: () => this.executionFingerprintIsCurrent(request),
      }, deliver);
      appendLocalLog('runtime_turn_finish', {
        agentId: 'codex',
        durationMs: Date.now() - startedAt,
        cancelled: Boolean(request.signal?.aborted),
      });
      return;
    }

    let runtimeRequest = request;
    let ccSwitchRouteEnvironment: NodeJS.ProcessEnv | undefined;
    let ccSwitchClaudeConfigDir: string | undefined;
    let profile = this.resolveProviderProfile(request);
    if (request.configSource === 'ccSwitchCurrent') {
      if (request.agentId !== 'claude') {
        deliver({
          type: 'error',
          message: 'CC Switch 全局配置仅支持 Claude Code。',
        });
        return;
      }
      const ccSwitch = await this.refreshCcSwitchStatus();
      if (!this.canContinue(registration)) {
        deliver({ type: 'done' });
        return;
      }
      if (
        ccSwitch.state !== 'ready'
        || ccSwitch.selectionSource !== 'liveConfig'
        || !ccSwitch.currentProviderId
        || !ccSwitch.currentCliModel?.trim()
        || !ccSwitch.claudeConfigDir?.trim()
        || !ccSwitch.routeFingerprint
      ) {
        deliver({
          type: 'error',
          message: '未连接到 CC Switch 本地代理。',
          detail: ccSwitch.error ?? '请启动 CC Switch 并启用 Claude 代理。',
        });
        return;
      }
      if (
        request.ccSwitchProviderId?.trim()
        && request.ccSwitchProviderId.trim() !== ccSwitch.currentProviderId
      ) {
        deliver({
          type: 'error',
          message: 'CC Switch 当前 Provider 已改变，本次未发送。',
          detail: '请再次发送，插件会使用最新的 CC Switch 配置并开启新会话。',
        });
        return;
      }
      if (
        request.ccSwitchRouteFingerprint?.trim()
        && request.ccSwitchRouteFingerprint.trim() !== ccSwitch.routeFingerprint
      ) {
        deliver({
          type: 'error',
          message: 'CC Switch 当前模型路由已改变，本次未发送。',
          detail: '请再次发送，插件会使用最新的 CC Switch 配置并开启新会话。',
        });
        return;
      }
      const checkedSessionConfig = resolveClaudeCcSwitchSessionConfig(
        ccSwitch.routeEnvironment,
        ccSwitch.currentCliModel,
        ccSwitch.routeFingerprint,
      );
      if (
        request.ccSwitchSessionFingerprint?.trim()
        && request.ccSwitchSessionFingerprint.trim() !== checkedSessionConfig.routeFingerprint
      ) {
        deliver({
          type: 'error',
          message: 'CC Switch 全局模型配置已改变，本次未发送。',
          detail: '请再次发送，插件会按最新全局配置开启新会话。',
        });
        return;
      }
      const canResumeCheckedSession = Boolean(
        request.ccSwitchProviderId?.trim()
        && request.ccSwitchRouteFingerprint?.trim()
        && request.ccSwitchSessionFingerprint?.trim(),
      );
      runtimeRequest = {
        ...request,
        // Older callers did not capture all three CC Switch fingerprints. They
        // may still send safely, but must start a new Claude session rather
        // than resume one created under an unverifiable route.
        sessionId: canResumeCheckedSession ? request.sessionId : undefined,
        ccSwitchProviderId: ccSwitch.currentProviderId,
        ccSwitchRouteFingerprint: ccSwitch.routeFingerprint,
        ccSwitchSessionFingerprint: checkedSessionConfig.routeFingerprint,
        model: checkedSessionConfig.cliModel || undefined,
      };
      ccSwitchRouteEnvironment = { ...ccSwitch.routeEnvironment };
      ccSwitchClaudeConfigDir = ccSwitch.claudeConfigDir;
      const checkedAt = ccSwitch.checkedAt ?? Date.now();
      const globalCcSwitch = ccSwitchGlobalSnapshot(ccSwitch);
      profile = {
        id: `ccswitch:${ccSwitch.currentProviderId}`,
        agentId: 'claude',
        name: `CC Switch · ${ccSwitchSnapshotLabel(globalCcSwitch)}`,
        apiKey: '',
        baseUrl: ccSwitch.baseUrl,
        model: '',
        defaultModel: '',
        models: [],
        wireApi: 'chat',
        anthropicAuthMode: 'authToken',
        isDefault: false,
        createdAt: checkedAt,
        updatedAt: checkedAt,
      };
    }
    if (request.configSource === 'providerProfile' && !profile) {
      appendLocalLog('runtime_profile_missing', {
        agentId: request.agentId,
        providerProfileId: request.providerProfileId ?? null,
      });
      deliver({
        type: 'error',
        message: '所选供应商配置已不存在。',
        detail: '请在模型选择器中改用其他供应商配置，或切回本地 CLI。',
      });
      return;
    }
    if (profile && requiresProviderApiKey(profile.baseUrl) && !profile.apiKey.trim()) {
      deliver({
        type: 'error',
        message: `${profile.name} API Key 缺失，请在“Ailu”设置中重新输入后再试。`,
        providerProfileId: profile.id,
      });
      return;
    }
    if (profile) {
      const cooldownUntil = this.cooldownByProfile.get(profile.id) ?? 0;
      if (cooldownUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1_000));
        deliver({
          type: 'error',
          message: `${profile.name} 仍在冷却中，请等待 ${retryAfterSeconds} 秒后再试。`,
          statusCode: 429,
          retryAfterSeconds,
          providerProfileId: profile.id,
        });
        return;
      }
      this.cooldownByProfile.delete(profile.id);
    }
    // Async route/status checks above may outlive a user cancellation. Recheck
    // immediately before spawning so an already-fired AbortSignal cannot be
    // missed by the listener installed below.
    if (!this.canContinue(registration)) {
      deliver({ type: 'done' });
      return;
    }
    if (!this.executionFingerprintIsCurrent(request)) {
      this.emitExecutionConfigChanged(deliver);
      return;
    }
    const adapter = new AgentAdapter({
      agentId: request.agentId,
      binaryPath: status.binaryPath,
      providerProfile: profile,
      ccSwitchRouteEnvironment,
      ccSwitchClaudeConfigDir,
    });
    const cancelAdapter = (): void => {
      void adapter.cancel();
    };
    request.signal?.addEventListener('abort', cancelAdapter, { once: true });
    this.activeAdapters.add(adapter);
    const startedAt = Date.now();
    appendLocalLog('runtime_turn_start', {
      agentId: request.agentId,
      configSource: request.configSource,
      providerProfileId: profile?.id,
      providerName: profile?.name,
      providerHost: profile ? providerHost(profile.baseUrl) : null,
      model: runtimeRequest.configSource === 'ccSwitchCurrent'
        ? runtimeRequest.model ?? null
        : profile?.defaultModel || profile?.model || request.model || null,
      anthropicAuthMode: profile?.agentId === 'claude' ? resolveAnthropicAuthMode(profile) : null,
    });
    const unsubscribe = adapter.onRuntimeEvent(deliver);
    try {
      if (!this.executionFingerprintIsCurrent(request)) {
        this.emitExecutionConfigChanged(deliver);
        return;
      }
      await adapter.run(runtimeRequest);
      appendLocalLog('runtime_turn_finish', {
        agentId: request.agentId,
        providerProfileId: profile?.id,
        durationMs: Date.now() - startedAt,
        cancelled: Boolean(request.signal?.aborted),
      });
    } finally {
      request.signal?.removeEventListener('abort', cancelAdapter);
      unsubscribe();
      this.activeAdapters.delete(adapter);
    }
  }

  /** Cancels every runtime turn. Normal UI cancellation must use request.signal. */
  async cancelAll(): Promise<void> {
    const registrations = [...this.inflightRuns];
    for (const registration of registrations) registration.controller.abort();
    const adapterTeardowns = [...this.activeAdapters].map(adapter => adapter.cancel());
    const failures: unknown[] = [];
    const teardownResults = await Promise.allSettled([
      ...adapterTeardowns,
      this.codexRuntime.cancelAll(),
    ]);
    for (const result of teardownResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) {
      // Codex deliberately keeps an unconfirmed turn unsettled when physical
      // disconnect fails. Return the failure now so shutdown can retry instead
      // of deadlocking on that registration.
      throw new AggregateError(failures, 'Runtime cancellation could not confirm every runtime stopped.');
    }
    const runResults = await Promise.allSettled(
      registrations.map(registration => registration.settled),
    );
    for (const result of runResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Runtime cancellation did not fully converge.');
    }
  }

  /** @deprecated Use a per-request AbortController; retained for transition wiring only. */
  cancel(): void {
    void this.cancelAll().catch(error => {
      console.error('Ailu runtime cancellation failed.', error);
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownBarrier) return this.shutdownBarrier;
    if (this.lifecycle === 'closed') return;

    this.lifecycle = 'shuttingDown';
    this.lifecycleEpoch += 1;
    for (const registration of this.inflightRuns) registration.controller.abort();

    const barrier = (async () => {
      const failures: unknown[] = [];
      const stopFailures: unknown[] = [];
      try {
        await this.cancelAll();
      } catch {
        // Runtime-specific shutdown barriers below retry any failed cancel.
      }
      const maintenanceResults = await Promise.allSettled([...this.maintenanceOperations]);
      for (const result of maintenanceResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      try {
        await this.codexRuntime.shutdown();
      } catch (error) {
        failures.push(error);
        stopFailures.push(error);
      }
      const adapterResults = await Promise.allSettled(
        [...this.activeAdapters].map(adapter => adapter.cancel()),
      );
      for (const result of adapterResults) {
        if (result.status === 'rejected') {
          failures.push(result.reason);
          stopFailures.push(result.reason);
        }
      }
      if (stopFailures.length > 0) {
        // Do not wait registrations whose runtimes could still be mutating
        // files, and do not claim this manager is closed.
        throw new AggregateError(failures, 'Runtime manager shutdown could not confirm every runtime stopped.');
      }
      const runResults = await Promise.allSettled(
        [...this.inflightRuns].map(registration => registration.settled),
      );
      for (const result of runResults) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
      this.lifecycle = 'closed';
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Runtime manager shutdown did not fully converge.');
      }
    })();
    this.shutdownBarrier = barrier;
    void barrier.catch(() => {
      if (this.shutdownBarrier === barrier && this.lifecycle !== 'closed') {
        this.shutdownBarrier = null;
      }
    });
    return barrier;
  }

  private registerRun(callerSignal?: AbortSignal): ManagerRunRegistration {
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve;
    });
    const registration: ManagerRunRegistration = {
      epoch: this.lifecycleEpoch,
      controller,
      detachCallerAbort: () => callerSignal?.removeEventListener('abort', abortFromCaller),
      settled,
      resolve: resolveSettled,
    };
    this.inflightRuns.add(registration);
    return registration;
  }

  private canContinue(registration: ManagerRunRegistration): boolean {
    return this.lifecycle === 'running'
      && registration.epoch === this.lifecycleEpoch
      && !registration.controller.signal.aborted;
  }

  private resolveProviderProfile(request: ChatTurnRequest): ProviderProfile | null {
    if (request.configSource !== 'providerProfile') return null;
    const selected = request.providerProfileId?.trim();
    return this.providerStore.find(request.agentId, selected || undefined);
  }

  private executionFingerprintIsCurrent(
    request: Pick<
      ChatTurnRequest,
      | 'agentId'
      | 'cwd'
      | 'configSource'
      | 'providerProfileId'
      | 'model'
      | 'reasoningEffort'
      | 'fullAccess'
      | 'planMode'
      | 'textOnly'
      | 'purpose'
      | 'allowFreshSessionFallback'
      | 'executionFingerprint'
      | 'providerProfileUpdatedAt'
    >,
  ): boolean {
    if (request.fullAccess === true
      && this.getSettings().fullAccessByAgent[request.agentId] !== true) {
      return false;
    }
    const expected = request.executionFingerprint?.trim();
    if (!expected) return true;
    try {
      const current = this.executionFingerprintSnapshot(request);
      if (request.configSource === 'providerProfile') {
        if (
          request.providerProfileUpdatedAt === undefined
          || current.providerProfileUpdatedAt !== request.providerProfileUpdatedAt
        ) return false;
      }
      return this.signExecutionFingerprint(current.payload) === expected;
    } catch (error) {
      console.error('Ailu execution fingerprint check failed.', error);
      return false;
    }
  }

  private executionFingerprintSnapshot(
    request: Pick<
      ChatTurnRequest,
      | 'agentId'
      | 'cwd'
      | 'configSource'
      | 'providerProfileId'
      | 'model'
      | 'reasoningEffort'
      | 'fullAccess'
      | 'planMode'
      | 'textOnly'
      | 'purpose'
      | 'allowFreshSessionFallback'
    >,
  ): { payload: string; providerProfileUpdatedAt: number | undefined } {
    if (!isSupportedRuntimeAgentId(request.agentId)) {
      throw new Error('Unsupported agent runtime.');
    }
    const settings = this.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(request.agentId, { withVersion: request.agentId === 'codex' });
    const selectedProfileId = request.providerProfileId?.trim()
      || settings.providerProfileByAgent[request.agentId]?.trim()
      || undefined;
    const profile = request.configSource === 'providerProfile'
      ? this.providerStore.find(request.agentId, selectedProfileId)
      : null;
    const environment = Object.keys(process.env)
      .sort()
      .map(key => [key, process.env[key] ?? null]);
    const payload = JSON.stringify({
      version: 1,
      request: {
        agentId: request.agentId,
        cwd: request.cwd,
        configSource: request.configSource,
        providerProfileId: request.providerProfileId?.trim() || null,
        model: request.model?.trim() || null,
        reasoningEffort: request.reasoningEffort?.trim() || null,
        fullAccess: request.fullAccess === true,
        planMode: request.planMode === true,
        textOnly: request.textOnly === true,
        purpose: request.purpose ?? 'chat',
        allowFreshSessionFallback: request.allowFreshSessionFallback === true,
      },
      live: {
        configSource: settings.configSources[request.agentId],
        configuredPath: settings.configuredPaths[request.agentId],
        selectedProviderProfileId: settings.providerProfileByAgent[request.agentId],
        currentFullAccess: settings.fullAccessByAgent[request.agentId] === true,
        binaryPath: status.binaryPath,
        binarySource: status.source,
        binaryVersion: status.version,
        environment,
        // The raw profile, including a possible API key, exists only inside
        // the keyed HMAC input. Neither it nor a stable naked hash is returned.
        providerProfile: profile,
      },
    });
    return {
      payload,
      providerProfileUpdatedAt: profile?.updatedAt,
    };
  }

  private signExecutionFingerprint(payload: string): string {
    return `v1:${createHmac('sha256', this.executionFingerprintKey).update(payload).digest('base64url')}`;
  }

  private emitExecutionConfigChanged(deliver: RuntimeEventListener): void {
    deliver({
      type: 'error',
      message: '排队期间运行配置已改变，本次未发送。',
      detail: '请重新发送；插件会按当前供应商、模型、可执行文件和环境配置重新建立安全快照。',
      diagnostic: 'runtime_execution_config_changed',
    });
    deliver({ type: 'done' });
  }
}

function isSupportedRuntimeAgentId(agentId: AgentId): agentId is 'claude' | 'codex' {
  return agentId === 'claude' || agentId === 'codex';
}
