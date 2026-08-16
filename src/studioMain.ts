import { type App, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { createHash, randomBytes } from 'node:crypto';

import { ChatContextService, ChatRunCoordinator } from './chat';
import { VerifiedMemoryReadService } from './memory/verifiedMemory';
import { VerifiedMemoryWriteService } from './memory/verifiedMemoryWrite';
import { defaultMemoryctlPath } from './memory/memoryctlPath';
import {
  ailuMemoryRuntimeGateFor,
  invalidateAiluMemoryRuntimeHandshakeCache,
  type AiluMemoryRuntimeGateLike,
} from './memory/runtimeHandshake';
import {
  AILU_IDS,
  COMMAND_IDS,
  PLUGIN_NAME,
  SECRET_IDS,
  VIEW_IDS,
} from './ids';
import { readFeishuDestination } from './feishu/destination';
import { validateFeishuAssociationKey } from './feishu/association';
import { LarkCliService } from './feishu/larkCli';
import { RuntimeManager } from './runtime/runtimeManager';
import { normalizePublishingSettings } from './settings/publishingSettings';
import { normalizeSecureRelayToken } from './publishing/publicationGuard';
import {
  canonicalizeStoredAgentSettings,
  normalizeAgentSettings,
} from './settings/agentSettings';
import {
  normalizeXPublishingSettings,
  xPublishingSettingsForPersistence,
} from './settings/xPublishingSettings';
import { ProviderStore } from './storage/providerStore';
import {
  createAiluProcessWriteLock,
  PythonFcntlProcessWriteLock,
  type ProcessWriteLock,
} from './storage/processWriteLock';
import { ailuHome, xCookiesPath } from './paths';
import { durableRuntimeFingerprint } from './storage/runtimeSnapshot';
import { appendLocalLog } from './storage/localLog';
import {
  ConversationSessionConflictError,
  VaultStore,
} from './storage/vaultStore';
import {
  DEFAULT_SETTINGS,
  type StoredConversation,
  type AiluSettings,
} from './types';
import { AiluChatView, type ChatWriteState } from './ui/chatView';
import { ChatConversationUiStateCache } from './ui/chatConversationUiState';
import { ChatUiStatePersistence } from './ui/chatUiStatePersistence';
import { runInlineEdit } from './ui/inlineEdit';
import { createMarkdownEditorScrollExtension } from './ui/markdownEditorScrollExtension';
import { PublishingStudioView } from './ui/publishingStudioView';
import {
  annotatePublishingSourceSection,
  PublishingEditorScrollSync,
} from './ui/publishingSourceScroll';
import { AiluSettingTab, type SettingsTabId } from './ui/settingsTab';
import { shouldRenderToolEvent } from './ui/toolEventVisibility';
import { createAiluBrandMark } from './ui/ailuBrandMark';
import {
  GeneratedImageDropController,
  GeneratedImageDropError,
} from './ui/generatedImageDrag';
import { getVaultBasePath } from './utils/vault';
import { userFacingErrorMessage, userFacingErrorText } from './utils/userFacingError';
import { DEFAULT_WECHAT_THEME_ID, isWeChatThemeId } from './wechat/themes';
import { XArticleUploadTaskCoordinator } from './xArticle/uploadTaskCoordinator';
import { XArticleLocalUploader } from './xArticle/localUploader';
import { XCookieMutationCoordinator } from './xArticle/cookieMutationCoordinator';
import {
  ensureCanonicalXCookieDirectories,
  migrateLegacyXCookies,
  validateCanonicalXCookies,
  writeCanonicalXCookies,
} from './xArticle/cookieStore';

interface AppWithSettings extends App {
  setting?: {
    open(): void;
    openTabById(id: string): void;
  };
}

const STUDIO_SHUTDOWN_HANDOFF = Symbol.for(AILU_IDS.shutdownHandoff);
const RELOAD_LEASE_GRACE_MS = 35_000;
const RESTART_LEASE_GRACE_MS = 1_500;

export default class AiluPlugin extends Plugin {
  settings!: AiluSettings;
  providerStore!: ProviderStore;
  vaultStore!: VaultStore;
  runtimeManager!: RuntimeManager;
  chatRunCoordinator!: ChatRunCoordinator;
  chatContextService!: ChatContextService;
  memoryReadService!: VerifiedMemoryReadService;
  memoryWriteService!: VerifiedMemoryWriteService;
  larkCliService!: LarkCliService;
  settingTab!: AiluSettingTab;
  private studioViewTransition: Promise<void> = Promise.resolve();
  private selectedChatConversation: StoredConversation | null = null;
  private chatWriteState: ChatWriteState = { available: false, reason: '正在检查对话存储…' };
  private readonly chatWriteStateListeners = new Set<(state: ChatWriteState) => void>();
  private chatSessionRegistryHealthy = true;
  private chatUiState!: ChatConversationUiStateCache;
  private chatUiStatePersistence!: ChatUiStatePersistence;
  private chatUiStatePersistenceWarning: string | null = null;
  private chatUiStatePersistenceWarningConversationId: string | null = null;
  private chatUiStatePersistenceWarningOperation: 'load' | 'save' | null = null;
  private chatLeaseLost = false;
  private chatLeaseLossBarrier: Promise<void> | null = null;
  private memoryRuntimeGate!: AiluMemoryRuntimeGateLike;
  private memoryRuntimeDiagnostic = '';
  private generatedImageDropController: GeneratedImageDropController | null = null;
  private canonicalSettingsSnapshot: { path: string; raw: string | null; sha256: string } | null = null;
  private settingsPersistenceAllowed = false;
  private homeWriterAvailable = false;
  private homeProcessWriteLock: ProcessWriteLock | null = null;
  private readonly publishingEditorScrollSync = new PublishingEditorScrollSync();
  private readonly xArticleUploadTasks = new XArticleUploadTaskCoordinator();
  private readonly xCookieMutations = new XCookieMutationCoordinator();
  private legacyXCookiesPath = '';
  private canonicalXCookiesVerified = false;

  override async onload(): Promise<void> {
    await this.awaitPreviousStudioShutdown();
    const vaultBasePath = getVaultBasePath(this.app);
    const supportsPhysicalWriter = process.platform !== 'win32' && Boolean(vaultBasePath);
    const writableVaultBasePath = supportsPhysicalWriter ? vaultBasePath : null;
    this.homeProcessWriteLock = supportsPhysicalWriter
      ? PythonFcntlProcessWriteLock.forPrivateDirectory(
        ailuHome(),
        'provider-writer.lock',
      )
      : null;
    this.providerStore = new ProviderStore(this.app.secretStorage, process.env, {
      canWrite: () => this.settingsPersistenceAllowed && this.homeWriterAvailable,
      processWriteLock: this.homeProcessWriteLock ?? undefined,
    });
    this.vaultStore = new VaultStore(this.app.vault.adapter, {
      requireWriteLease: true,
      ...(writableVaultBasePath ? { vaultBasePath: writableVaultBasePath } : {}),
      ...(writableVaultBasePath
        ? { processWriteLock: createAiluProcessWriteLock(writableVaultBasePath) }
        : {}),
      onWriteLeaseLost: error => this.handleChatWriteLeaseLoss(error),
    });
    let chatWriterAvailable = false;
    let acquiredWriterFence = false;
    try {
      await this.loadSettings();
      if (supportsPhysicalWriter) {
        const lease = await this.acquireChatWriteLeaseWithReloadGrace();
        acquiredWriterFence = lease.mode === 'writer';
        chatWriterAvailable = acquiredWriterFence;
        if (acquiredWriterFence) {
          this.vaultStore.startWriteLeaseHeartbeat(error => {
            chatWriterAvailable = false;
            this.handleChatWriteLeaseLoss(error);
          });
          if (this.homeProcessWriteLock && await this.homeProcessWriteLock.acquire()) {
            this.homeWriterAvailable = true;
            if (this.legacyXCookiesPath) {
              try {
                const migrated = await migrateLegacyXCookies(this.legacyXCookiesPath);
                await validateCanonicalXCookies(process.env, { repairPermissions: true });
                this.canonicalXCookiesVerified = true;
                if (migrated) new Notice('X 登录态已迁移到 Ailu 私密目录。');
              } catch {
                new Notice('旧 X Cookie 未自动迁移；请在设置中重新导入。');
              }
            }
            await this.providerStore.recoverInterruptedTransaction();
            await this.providerStore.migrateLegacySecretPointers();
            await this.providerStore.auditCanonicalSecretPointers();
          }
        }
      }
      if (chatWriterAvailable) {
        await this.vaultStore.ensureV2Store({
          quiescenceBarrier: async () => ({ activeRuns: 0 }),
        });
        this.settingsPersistenceAllowed = true;
        await this.persistCanonicalSettingsIfNeeded();
      } else if (!supportsPhysicalWriter) {
        this.setChatWriteState({
          available: false,
          reason: process.platform === 'win32'
            ? 'Ailu 0.2 在 Windows 上仅以只读模式运行，不创建跨进程写入锁。'
            : '当前 Vault 没有可验证的物理路径；Ailu 已禁止写入。',
        });
        new Notice(process.platform === 'win32'
          ? 'Ailu 0.2 在 Windows 上仅以只读模式启动，不执行写入。'
          : '当前 Vault 无法建立跨进程物理锁；Ailu 仅以只读模式启动。');
      } else {
        this.setChatWriteState({
          available: false,
          reason: '另一个 Obsidian 实例正在写入这个 Vault；当前只能查看历史。',
        });
        new Notice('当前 Vault 已由另一个 Obsidian 实例写入对话；本实例仅可查看历史。');
      }
    } catch (error) {
      chatWriterAvailable = false;
      this.vaultStore.stopWriteLeaseHeartbeat();
      this.homeWriterAvailable = false;
      await this.homeProcessWriteLock?.release().catch(releaseError => {
        console.error('Ailu could not release the failed Home writer lock.', releaseError);
      });
      if (acquiredWriterFence) {
        try {
          await this.vaultStore.releaseWriteLease();
        } catch (releaseError) {
          console.error('Ailu could not release the failed Vault writer lease.', releaseError);
        }
      }
      if (!this.settings) this.settings = normalizeSettings(null);
      console.error('Ailu could not initialize canonical settings or conversation storage.', error);
      this.setChatWriteState({
        available: false,
        reason: `对话存储初始化失败，已禁止继续写入：${errorMessage(error)}`,
      });
      new Notice(`对话存储初始化失败，已转为只读：${errorMessage(error)}`);
    }
    this.runtimeManager = new RuntimeManager(this.providerStore, () => this.settings);
    this.memoryRuntimeGate = ailuMemoryRuntimeGateFor(defaultMemoryctlPath());
    this.memoryReadService = new VerifiedMemoryReadService({ runtimeGate: this.memoryRuntimeGate });
    this.memoryWriteService = new VerifiedMemoryWriteService({ runtimeGate: this.memoryRuntimeGate });
    this.chatContextService = new ChatContextService({ store: this.vaultStore });
    await this.refreshAgentMemoryRuntimeHandshake(false);
    this.chatRunCoordinator = new ChatRunCoordinator({
      runTurn: (request, onEvent) => this.runtimeManager.runTurn(request, onEvent),
      formatRuntimeError: (message, detail) => userFacingErrorText(
        [message, detail].filter(Boolean).join('：'),
        '当前 Agent 执行失败，请查看本地诊断日志。',
      ),
      onPersistenceFailure: ({ stage, failureKind }) => {
        appendLocalLog('chat_persistence_failure', { stage, failureKind });
      },
      loadConversation: async conversationId => (
        (await this.vaultStore.loadConversationWindow(conversationId, 100))?.conversation ?? null
      ),
      persistStart: async input => {
        await this.vaultStore.beginTurn({
          conversationId: input.conversationId,
          agentId: input.runtimeRequest.agentId,
          turnId: input.runId,
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          runtime: {
            configSource: input.runtimeRequest.configSource,
            providerProfileId: input.runtimeRequest.providerProfileId,
            ccSwitchProviderId: input.runtimeRequest.ccSwitchProviderId,
            ccSwitchRouteFingerprint: durableRuntimeFingerprint(
              input.runtimeRequest.ccSwitchRouteFingerprint,
            ),
            ccSwitchSessionFingerprint: durableRuntimeFingerprint(
              input.runtimeRequest.ccSwitchSessionFingerprint,
            ),
            model: input.runtimeRequest.model,
            reasoningEffort: input.runtimeRequest.reasoningEffort,
            planMode: input.runtimeRequest.planMode === true,
            fullAccess: input.runtimeRequest.fullAccess === true,
          },
          initialState: input.initialState,
          contextCheckpointDraft: input.contextCheckpointDraft,
          expectedRevision: input.expectedRevision,
        });
      },
      persistActivate: async input => {
        await this.vaultStore.activateTurn({
          conversationId: input.conversationId,
          turnId: input.runId,
        });
      },
      persistSession: async input => {
        await this.vaultStore.patchSession({
          conversationId: input.conversationId,
          turnId: input.runId,
          agentId: input.agentId,
          sessionId: input.sessionId,
          configKey: input.sessionConfigKey,
        });
      },
      claimSessionOwnership: async ownership => {
        try {
          await this.vaultStore.claimSessionOwnership({
            conversationId: ownership.conversationId,
            agentId: ownership.agentId,
            sessionId: ownership.sessionId,
            runId: ownership.runId,
            sessionConfigKey: ownership.sessionConfigKey,
          });
          return { status: 'claimed', owner: ownership };
        } catch (error) {
          if (error instanceof ConversationSessionConflictError) {
            return { status: 'duplicate', owner: { ...error.existingOwner } };
          }
          throw error;
        }
      },
      loadSessionOwner: async sessionId => {
        const owner = await this.vaultStore.loadSessionOwner(sessionId);
        return owner
          ? {
            sessionId: owner.sessionId,
            conversationId: owner.conversationId,
            agentId: owner.agentId,
            runId: owner.runId,
            claimedAt: owner.claimedAt,
          }
          : null;
      },
      persistCheckpoint: async input => {
        await this.vaultStore.checkpointAssistantMessage({
          conversationId: input.conversationId,
          turnId: input.runId,
          messageId: input.assistantMessage.id,
          patch: {
            role: input.assistantMessage.role,
            content: input.assistantMessage.content,
            metadata: input.assistantMessage.metadata ?? null,
          },
        });
      },
      persistCancellationRequested: async input => {
        await this.vaultStore.requestTurnCancellation({
          conversationId: input.conversationId,
          turnId: input.runId,
        });
      },
      persistFinal: async input => {
        const assistantPatch = {
          role: input.assistantMessage.role,
          content: input.assistantMessage.content,
          metadata: input.assistantMessage.metadata ?? null,
        };
        if (input.status === 'cancelled') {
          await this.vaultStore.cancelTurn({
            conversationId: input.conversationId,
            turnId: input.runId,
            assistantPatch,
          });
        } else {
          await this.vaultStore.finalizeTurn({
            conversationId: input.conversationId,
            turnId: input.runId,
            outcome: input.status === 'failed' ? 'failed' : 'completed',
            assistantPatch,
            error: input.error,
          });
        }
      },
      materializeArtifact: input => this.vaultStore.importGeneratedImage(
        input.conversationId,
        input.artifact,
        {
          maxItemBytes: input.maxItemBytes,
          remainingTurnBytes: input.remainingTurnBytes,
          signal: input.signal,
        },
      ),
      formatToolEvent: (toolCall, submission) => (
        shouldRenderToolEvent(submission.runtimeRequest.agentId, toolCall)
          ? `\n\n• ${toolCall.name} ${toolCall.status}`
          : null
      ),
    });
    this.chatUiState = new ChatConversationUiStateCache({
      isConversationRunning: conversationId => (
        this.chatRunCoordinator.isConversationRunning(conversationId)
      ),
    });
    this.chatUiStatePersistence = new ChatUiStatePersistence({
      cache: this.chatUiState,
      canWrite: () => this.chatWriteState.available,
      loadDraft: async conversationId => (
        (await this.vaultStore.loadDraft(conversationId))?.value ?? null
      ),
      saveDraft: async (conversationId, value) => {
        await this.vaultStore.saveDraft(conversationId, value);
      },
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: timer => window.clearTimeout(timer),
      onError: (conversationId, error, operation) => {
        const warning = `对话草稿或阅读位置保存失败：${errorMessage(error)}`;
        console.error(
          `Ailu could not persist chat UI state for ${conversationId}.`,
          error,
        );
        if (this.chatUiStatePersistenceWarning === warning
          && this.chatUiStatePersistenceWarningConversationId === conversationId) return;
        this.chatUiStatePersistenceWarning = warning;
        this.chatUiStatePersistenceWarningConversationId = conversationId;
        this.chatUiStatePersistenceWarningOperation = operation;
        new Notice(warning);
        this.notifyChatWriteStateListeners();
      },
      onSuccess: (conversationId, operation, caughtUp) => {
        if (!caughtUp) return;
        if (this.chatUiStatePersistenceWarningConversationId !== conversationId) return;
        if (this.chatUiStatePersistenceWarningOperation !== operation) return;
        this.chatUiStatePersistenceWarning = null;
        this.chatUiStatePersistenceWarningConversationId = null;
        this.chatUiStatePersistenceWarningOperation = null;
        this.notifyChatWriteStateListeners();
      },
    });
    if (this.chatLeaseLost) this.enforceChatLeaseLossBarrier();
    if (chatWriterAvailable) {
      try {
        const recovery = await this.vaultStore.recoverInterruptedTurns();
        if (recovery.transitions.length > 0) {
          const interrupted = recovery.transitions.filter(item => item.to === 'interrupted').length;
          const paused = recovery.transitions.filter(item => item.to === 'paused').length;
          new Notice(`已恢复上次对话状态：${interrupted} 项已中断，${paused} 项保持暂停。`);
        }
        if (!this.chatLeaseLost && chatWriterAvailable) {
          this.setChatWriteState({ available: true, reason: '' });
        }
      } catch (error) {
        chatWriterAvailable = false;
        this.settingsPersistenceAllowed = false;
        this.homeWriterAvailable = false;
        this.vaultStore.stopWriteLeaseHeartbeat();
        try {
          await Promise.all([
            this.vaultStore.releaseWriteLease(),
            this.homeProcessWriteLock?.release(),
          ]);
        } catch (releaseError) {
          console.error('Ailu could not release the failed recovery lease.', releaseError);
        }
        console.error('Ailu could not recover interrupted chat turns.', error);
        this.setChatWriteState({
          available: false,
          reason: `对话恢复失败，已禁止继续写入：${errorMessage(error)}`,
        });
        new Notice(`无法完成对话恢复：${errorMessage(error)}`);
      }
    }
    const chatRecovery = await this.chatRunCoordinator.recover();
    if (chatRecovery.failures.length > 0) {
      this.chatSessionRegistryHealthy = false;
      console.error('Ailu could not rebuild every chat session owner.', chatRecovery.failures);
      new Notice('部分历史会话关系无法读取；为防止串话，相关对话将开启新会话。');
    }
    if (chatRecovery.sessionConflicts.length > 0) {
      new Notice(`发现 ${chatRecovery.sessionConflicts.length} 个重复会话关系；相关对话已禁止自动续接。`);
    }
    this.larkCliService = new LarkCliService();
    this.generatedImageDropController = new GeneratedImageDropController({
      app: this.app,
      onSuccess: result => {
        new Notice(`图片已保存到 ${result.attachmentPath}，并插入当前笔记。`);
      },
      onError: error => {
        console.error('Ailu could not import a generated image into the editor.', error);
        const message = errorMessage(error);
        new Notice(error instanceof GeneratedImageDropError
          ? message
          : `图片拖入失败：${message}`);
      },
    });
    this.registerEvent(this.app.workspace.on('editor-drop', (event, editor, info) => {
      if (event.defaultPrevented) return;
      if (this.generatedImageDropController?.handleEditorDrop(event, editor, info)) {
        event.preventDefault();
      }
    }));
    this.registerEditorExtension(createMarkdownEditorScrollExtension(this.publishingEditorScrollSync));
    this.registerMarkdownPostProcessor(annotatePublishingSourceSection);

    const createChatView = (leaf: WorkspaceLeaf) => new AiluChatView(leaf, {
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      providerStore: this.providerStore,
      vaultStore: this.vaultStore,
      runtimeManager: this.runtimeManager,
      chatRunCoordinator: this.chatRunCoordinator,
      chatContextService: this.chatContextService,
      memoryReadService: this.memoryReadService,
      memoryWriteService: this.memoryWriteService,
      isMemoryRuntimeReady: () => this.memoryRuntimeDiagnostic === '',
      setMemoryRuntimeDiagnostic: diagnostic => this.setMemoryRuntimeDiagnostic(diagnostic),
      chatUiState: this.chatUiState,
      chatUiStatePersistence: this.chatUiStatePersistence,
      getChatUiStatePersistenceWarning: () => this.chatUiStatePersistenceWarning,
      getChatWriteState: () => ({ ...this.chatWriteState }),
      onChatWriteStateChange: listener => {
        this.chatWriteStateListeners.add(listener);
        return () => this.chatWriteStateListeners.delete(listener);
      },
      isSessionRegistryHealthy: () => this.chatSessionRegistryHealthy,
      getSelectedConversation: () => this.selectedChatConversation,
      setSelectedConversation: conversation => {
        this.selectedChatConversation = conversation;
      },
      openSettings: () => this.openSettings('general'),
      openPublishing: () => void this.activatePublishing(),
    });
    const createPublishingView = (leaf: WorkspaceLeaf) => new PublishingStudioView(leaf, {
      larkCli: this.larkCliService,
      xArticleUploadTasks: this.xArticleUploadTasks,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      authorizeXCookieMutation: () => this.assertHomeWriteFenceHeld(),
      exportXCookiesFromChrome: () => this.exportXCookiesFromChrome(),
      ensureXCookiesForUpload: allowExport => this.ensureXCookiesForUpload(allowExport),
      getFeishuAssociationKey: () => this.readFeishuAssociationKey(),
      ensureFeishuAssociationKey: () => this.ensureFeishuAssociationKey(),
      editorScrollSync: this.publishingEditorScrollSync,
      openChat: () => void this.activateChat(),
      openSettings: () => this.openSettings('publishing'),
    });
    this.registerView(VIEW_IDS.chat, createChatView);
    this.registerView(VIEW_IDS.publishing, createPublishingView);
    this.app.workspace.onLayoutReady(() => {
      void this.consolidateStudioLeaves();
    });

    const ribbonIcon = this.addRibbonIcon('paw-print', PLUGIN_NAME, () => void this.activateChat());
    ribbonIcon.addClass('ailu-ribbon-icon');
    ribbonIcon.empty();
    createAiluBrandMark(ribbonIcon, 'ailu-ribbon-mark');
    this.addCommand({
      id: COMMAND_IDS.openChat,
      name: '打开对话',
      callback: () => void this.activateChat(),
    });
    this.addCommand({
      id: COMMAND_IDS.openPublishing,
      name: '打开草稿区',
      callback: () => void this.activatePublishing(),
    });
    this.addCommand({
      id: COMMAND_IDS.inlineEdit,
      name: '用当前 Agent 修改选中文字',
      editorCallback: () => {
        void runInlineEdit(this, this.runtimeManager, () => this.settings);
      },
    });
    this.addCommand({
      id: COMMAND_IDS.stopAgent,
      name: '停止当前 Agent',
      callback: () => {
        const conversationId = this.selectedChatConversation?.id;
        if (!conversationId) {
          new Notice('当前没有可停止的对话。');
          return;
        }
        const stopped = this.chatRunCoordinator.stopConversation(conversationId);
        new Notice(stopped.cancelledRunIds.length > 0
          ? '已停止当前对话。'
          : '当前对话没有正在运行的任务。');
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem(item => item
        .setTitle(`在 ${PLUGIN_NAME} 中预览`)
        .setIcon('panels-top-left')
        .onClick(() => void this.activatePublishing(file)));
    }));

    this.settingTab = new AiluSettingTab(this.app, this, {
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      saveRelayToken: (value: string) => this.saveRelayToken(value),
      importXCookies: (value: string) => this.importXCookies(value),
      exportXCookiesFromChrome: () => this.exportXCookiesFromChrome(),
      providerStore: this.providerStore,
      runtimeManager: this.runtimeManager,
      refreshViews: () => void this.refreshPublishingViews(),
      pluginVersion: this.manifest.version,
    });
    this.addSettingTab(this.settingTab);
  }

  override onunload(): void {
    this.larkCliService?.cancelActiveOperation();
    const coordinatorShutdown = this.chatRunCoordinator?.shutdown();
    const shutdown = (async () => {
      let cleanShutdown = false;
      try {
        const barriers = await Promise.allSettled([
          this.chatUiStatePersistence?.shutdown(),
          coordinatorShutdown,
          this.memoryWriteService?.shutdown(),
          this.generatedImageDropController?.shutdown(),
          this.xCookieMutations.shutdown(),
          this.xArticleUploadTasks.shutdown(),
        ]);
        const runtimeBarrier = await Promise.allSettled([
          this.runtimeManager?.shutdown(),
        ]);
        const failed = [...barriers, ...runtimeBarrier].find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) throw failed.reason;
        cleanShutdown = true;
      } finally {
        this.vaultStore?.stopWriteLeaseHeartbeat();
        this.setChatWriteState({ available: false, reason: '插件正在关闭，对话存储已停止接收新写入。' });
        if (cleanShutdown) {
          await Promise.all([
            this.vaultStore?.releaseWriteLease(),
            this.homeProcessWriteLock?.release(),
          ]);
          this.homeWriterAvailable = false;
        } else {
          // Fail closed: keep the OS process lock until Obsidian exits. A hot
          // reload must never let a new writer start while an old full-access
          // runtime or confirmed memory write has not reached its barrier.
          console.error('Ailu retained its writer lock after an incomplete shutdown. Restart Obsidian before reloading the plugin.');
        }
      }
    })();
    const handoffKey = this.studioShutdownHandoffKey();
    const handoffs = studioShutdownHandoffs();
    handoffs.set(handoffKey, shutdown);
    void shutdown.finally(() => {
      if (handoffs.get(handoffKey) === shutdown) handoffs.delete(handoffKey);
    }).catch(() => {});
    void shutdown.catch(error => {
      console.error('Ailu shutdown did not finish cleanly.', error);
    });
  }

  async activateChat(): Promise<void> {
    await this.activateStudioView(VIEW_IDS.chat);
  }

  async activatePublishing(file?: TFile): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const targetFile = file ?? (activeFile?.extension === 'md' ? activeFile : undefined);
    const leaf = await this.activateStudioView(VIEW_IDS.publishing, targetFile
      ? { filePath: targetFile.path }
      : undefined);
    if (targetFile && leaf?.view instanceof PublishingStudioView) {
      await leaf.view.setFile(targetFile);
    }
  }

  private async activateStudioView(
    type: string,
    state?: Record<string, unknown>,
  ): Promise<WorkspaceLeaf | null> {
    return this.queueStudioViewTransition(async () => {
      const studioLeaves = this.getStudioLeaves();
      let leaf = this.preferredStudioLeaf(studioLeaves, type);
      if (!leaf) leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return null;

      if (leaf.getViewState().type !== type) {
        await leaf.setViewState({ type, active: true, state });
      }
      for (const extraLeaf of studioLeaves) {
        if (extraLeaf !== leaf) extraLeaf.detach();
      }
      await this.app.workspace.revealLeaf(leaf);
      return leaf;
    });
  }

  private async consolidateStudioLeaves(): Promise<void> {
    await this.queueStudioViewTransition(async () => {
      const studioLeaves = this.getStudioLeaves();
      if (studioLeaves.length < 2) return;
      const leaf = this.preferredStudioLeaf(studioLeaves);
      if (!leaf) return;
      for (const extraLeaf of studioLeaves) {
        if (extraLeaf !== leaf) extraLeaf.detach();
      }
    });
  }

  private getStudioLeaves(): WorkspaceLeaf[] {
    return [...new Set([
      ...this.app.workspace.getLeavesOfType(VIEW_IDS.chat),
      ...this.app.workspace.getLeavesOfType(VIEW_IDS.publishing),
    ])];
  }

  private preferredStudioLeaf(
    studioLeaves: WorkspaceLeaf[],
    targetType?: string,
  ): WorkspaceLeaf | null {
    const recentRightLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rightSplit);
    if (recentRightLeaf && studioLeaves.includes(recentRightLeaf)) return recentRightLeaf;
    const recentLeftLeaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.leftSplit);
    if (recentLeftLeaf && studioLeaves.includes(recentLeftLeaf)) return recentLeftLeaf;
    return studioLeaves.find(leaf => leaf.getViewState().type === targetType)
      ?? studioLeaves[0]
      ?? null;
  }

  private queueStudioViewTransition<T>(action: () => Promise<T>): Promise<T> {
    const transition = this.studioViewTransition.then(action);
    this.studioViewTransition = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }

  private async acquireChatWriteLeaseWithReloadGrace() {
    let status = await this.vaultStore.acquireWriteLease({ startHeartbeat: false });
    const currentPid = typeof process === 'undefined' ? null : process.pid;
    if (status.mode !== 'readOnly' || currentPid === null) {
      return status;
    }
    // Same-process hot reload can need the full shutdown barrier. A complete
    // Obsidian restart has a different PID but may overlap the old flock
    // helper briefly, so retry it for a short bounded window instead of
    // remaining read-only until another manual restart.
    const sameProcessReload = status.ownerPid === currentPid;
    const deadline = Date.now() + (sameProcessReload
      ? RELOAD_LEASE_GRACE_MS
      : RESTART_LEASE_GRACE_MS);
    while (status.mode === 'readOnly' && Date.now() < deadline) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 100));
      status = await this.vaultStore.acquireWriteLease({ startHeartbeat: false });
      if (sameProcessReload && status.mode === 'readOnly' && status.ownerPid !== currentPid) break;
    }
    return status;
  }

  private handleChatWriteLeaseLoss(error: unknown): void {
    const firstLoss = !this.chatLeaseLost;
    this.chatLeaseLost = true;
    this.settingsPersistenceAllowed = false;
    this.setChatWriteState({
      available: false,
      reason: `对话存储写入权已失效：${errorMessage(error)}`,
    });
    if (firstLoss) new Notice(`对话已转为只读，正在停止全部对话任务：${errorMessage(error)}`);
    this.enforceChatLeaseLossBarrier();
  }

  private enforceChatLeaseLossBarrier(): void {
    if (this.chatLeaseLossBarrier || !this.chatRunCoordinator || !this.runtimeManager) return;
    // coordinator.shutdown() closes chat admission and aborts every chat-owned
    // request synchronously. cancelAll() is a conservative temporary scope
    // barrier: it may also stop another AI helper, but the manager remains
    // reusable and no full-access chat process can outlive lost Vault ownership.
    const coordinatorShutdown = this.chatRunCoordinator.shutdown();
    const runtimeCancellation = this.runtimeManager.cancelAll();
    this.chatLeaseLossBarrier = Promise.allSettled([
      coordinatorShutdown,
      runtimeCancellation,
    ]).then(results => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed) throw failed.reason;
    });
    void this.chatLeaseLossBarrier.catch(barrierError => {
      console.error('Ailu could not fully stop chat after losing the writer lease.', barrierError);
      new Notice('对话写入权已失效，部分后台进程未能确认停止；请退出 Obsidian 后再继续。');
    });
  }

  private async awaitPreviousStudioShutdown(): Promise<void> {
    const pending = studioShutdownHandoffs().get(this.studioShutdownHandoffKey());
    if (!pending) return;
    try {
      await pending;
    } catch (error) {
      new Notice('上一次插件关闭未完整收敛。为避免后台任务或记忆写入重叠，请先重启 Obsidian。');
      throw error;
    }
  }

  private studioShutdownHandoffKey(): string {
    return getVaultBasePath(this.app) ?? this.app.vault.getName();
  }

  private setChatWriteState(state: ChatWriteState): void {
    this.chatWriteState = { ...state };
    this.notifyChatWriteStateListeners();
  }

  private notifyChatWriteStateListeners(): void {
    for (const listener of this.chatWriteStateListeners) {
      try {
        listener({ ...this.chatWriteState });
      } catch (error) {
        console.error('Ailu chat write-state listener failed.', error);
      }
    }
  }

  private async captureCanonicalSettingsSnapshot(): Promise<{
    path: string;
    raw: string | null;
    sha256: string;
  }> {
    const pluginDir = this.manifest.dir
      ?? `${this.app.vault.configDir}/plugins/${AILU_IDS.pluginId}`;
    const settingsPath = `${pluginDir}/data.json`;
    if (!(await this.app.vault.adapter.exists(settingsPath))) {
      return { path: settingsPath, raw: null, sha256: sha256NullableText(null) };
    }
    const stat = await this.app.vault.adapter.stat(settingsPath);
    if (!stat || stat.type !== 'file') {
      throw new Error('Canonical Ailu data.json has an unsafe type.');
    }
    const raw = await this.app.vault.adapter.read(settingsPath);
    return { path: settingsPath, raw, sha256: sha256NullableText(raw) };
  }

  private async saveSettingsWithPhysicalCas(
    expectedRaw?: string | null,
  ): Promise<void> {
    const pluginDir = this.manifest.dir
      ?? `${this.app.vault.configDir}/plugins/${AILU_IDS.pluginId}`;
    const settingsPath = `${pluginDir}/data.json`;
    const current = expectedRaw !== undefined
      ? expectedRaw
      : this.canonicalSettingsSnapshot?.raw ?? null;
    const replacement = `${JSON.stringify(this.settingsForPersistence(), null, 2)}\n`;
    const result = await this.vaultStore.compareAndSwapExternalText(
      settingsPath,
      current,
      replacement,
    );
    if (!result.swapped) {
      throw new Error('Canonical Ailu settings changed concurrently; no settings were overwritten.');
    }
    this.canonicalSettingsSnapshot = {
      path: settingsPath,
      raw: replacement,
      sha256: sha256NullableText(replacement),
    };
  }

  async loadSettings(): Promise<void> {
    this.canonicalSettingsSnapshot = await this.captureCanonicalSettingsSnapshot();
    const currentLoaded = (await this.loadData()) as Partial<AiluSettings> | null;
    const rawXPublishing = currentLoaded?.xPublishing as unknown;
    this.legacyXCookiesPath = rawXPublishing && typeof rawXPublishing === 'object'
      && !Array.isArray(rawXPublishing)
      && typeof (rawXPublishing as { cookiesPath?: unknown }).cookiesPath === 'string'
      ? (rawXPublishing as { cookiesPath: string }).cookiesPath.trim()
      : '';
    this.canonicalXCookiesVerified = false;
    this.settings = normalizeSettings(currentLoaded);
  }

  private settingsForPersistence(): AiluSettings {
    return {
      ...this.settings,
      xPublishing: xPublishingSettingsForPersistence(
        this.settings.xPublishing,
        this.legacyXCookiesPath,
        this.canonicalXCookiesVerified,
      ),
    };
  }

  private async persistCanonicalSettingsIfNeeded(): Promise<void> {
    const currentRaw = this.canonicalSettingsSnapshot?.raw ?? null;
    if (currentRaw === null) {
      await this.saveSettingsWithPhysicalCas(null);
      return;
    }
    let current: unknown;
    try {
      current = JSON.parse(currentRaw) as unknown;
    } catch {
      throw new Error('Canonical Ailu data.json is not valid JSON.');
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      throw new Error('Canonical Ailu data.json must contain one settings object.');
    }
    const canonical = canonicalizeStoredAgentSettings(
      current as Record<string, unknown>,
      normalizeAgentSettings(this.settings),
    );
    canonical.xPublishing = xPublishingSettingsForPersistence(
      this.settings.xPublishing,
      this.legacyXCookiesPath,
      this.canonicalXCookiesVerified,
    );
    const replacement = `${JSON.stringify(canonical, null, 2)}\n`;
    if (currentRaw === replacement) return;
    const result = await this.vaultStore.compareAndSwapExternalText(
      this.canonicalSettingsSnapshot!.path,
      currentRaw,
      replacement,
    );
    if (!result.swapped) {
      throw new Error('Canonical Ailu settings changed concurrently; no settings were overwritten.');
    }
    this.canonicalSettingsSnapshot = {
      path: this.canonicalSettingsSnapshot!.path,
      raw: replacement,
      sha256: sha256NullableText(replacement),
    };
  }

  async saveSettings(): Promise<void> {
    if (!this.settingsPersistenceAllowed) {
      throw new Error('Ailu settings are read-only until the canonical Vault writer fence is held.');
    }
    await this.assertVaultWriteFenceHeld();
    this.settings = normalizeSettings(this.settings);
    await this.saveSettingsWithPhysicalCas();
    await this.refreshAgentMemoryRuntimeHandshake(true);
  }

  async saveRelayToken(value: string): Promise<void> {
    await this.assertHomeWriteFenceHeld();
    const trimmed = value.trim();
    const replacement = trimmed ? normalizeSecureRelayToken(trimmed) : '';
    this.app.secretStorage.setSecret(SECRET_IDS.wechatRelayToken, replacement);
    if ((this.app.secretStorage.getSecret(SECRET_IDS.wechatRelayToken) ?? '').trim() !== replacement) {
      throw new Error('Ailu relay token did not verify after the fenced SecretStorage write.');
    }
  }

  async importXCookies(value: string): Promise<{ cookieCount: number }> {
    return this.xCookieMutations.run(async () => {
      await this.assertHomeWriteFenceHeld();
      const status = await writeCanonicalXCookies(value);
      await this.assertHomeWriteFenceHeld();
      this.canonicalXCookiesVerified = true;
      return { cookieCount: status.cookieCount };
    });
  }

  async exportXCookiesFromChrome(): Promise<{ cookieCount: number }> {
    return this.xCookieMutations.run(signal => this.exportXCookiesFromChromeLocked(signal));
  }

  private async ensureXCookiesForUpload(allowExport: boolean): Promise<{ cookieCount: number }> {
    return this.xCookieMutations.run(async signal => {
      await this.assertHomeWriteFenceHeld();
      try {
        const status = await validateCanonicalXCookies(process.env, { repairPermissions: true });
        this.canonicalXCookiesVerified = true;
        return { cookieCount: status.cookieCount };
      } catch (error) {
        if (!allowExport) throw error;
      }
      return this.exportXCookiesFromChromeLocked(signal);
    });
  }

  private async exportXCookiesFromChromeLocked(signal: AbortSignal): Promise<{ cookieCount: number }> {
    await this.assertHomeWriteFenceHeld();
    await ensureCanonicalXCookieDirectories();
    await validateCanonicalXCookies(process.env, { repairPermissions: true }).catch(() => undefined);
    const settings = this.settings.xPublishing;
    const uploader = new XArticleLocalUploader({
      pythonCommand: settings.pythonCommand,
      uploadScriptPath: settings.uploadScriptPath,
      cookiesPath: xCookiesPath(),
      autoExportCookiesWhenMissing: false,
      headed: false,
      authorizeCookieMutation: () => this.assertHomeWriteFenceHeld(),
      commitCanonicalCookies: async text => {
        await this.assertHomeWriteFenceHeld();
        const committed = await writeCanonicalXCookies(text);
        await this.assertHomeWriteFenceHeld();
        return committed;
      },
    });
    const status = await uploader.exportCookies({ signal });
    await this.assertHomeWriteFenceHeld();
    this.canonicalXCookiesVerified = true;
    return { cookieCount: status.cookieCount };
  }

  private async assertVaultWriteFenceHeld(): Promise<void> {
    await this.vaultStore.assertWriteLeaseHeld();
  }

  private async assertHomeWriteFenceHeld(): Promise<void> {
    if (!this.homeWriterAvailable || !this.homeProcessWriteLock) {
      throw new Error('Ailu Home writer process lock is not held.');
    }
    await this.homeProcessWriteLock.assertHeld();
  }

  private readFeishuAssociationKey(): string | null {
    const stored = this.app.secretStorage.getSecret(SECRET_IDS.feishuAssociationKey) ?? '';
    if (!stored.trim()) return null;
    try {
      return validateFeishuAssociationKey(stored);
    } catch {
      return null;
    }
  }

  private async ensureFeishuAssociationKey(): Promise<string> {
    await this.assertHomeWriteFenceHeld();
    const existing = this.readFeishuAssociationKey();
    if (existing) return existing;
    const generated = randomBytes(32).toString('base64url');
    this.app.secretStorage.setSecret(SECRET_IDS.feishuAssociationKey, generated);
    await this.assertHomeWriteFenceHeld();
    const verified = this.readFeishuAssociationKey();
    if (verified !== generated) {
      throw new Error('Ailu 飞书关联签名密钥写入后未能验证。');
    }
    return generated;
  }

  private async refreshAgentMemoryRuntimeHandshake(invalidate: boolean): Promise<void> {
    if (!this.memoryRuntimeGate) return;
    if (invalidate) invalidateAiluMemoryRuntimeHandshakeCache();
    try {
      await this.memoryRuntimeGate.assertReady();
      this.setMemoryRuntimeDiagnostic(null);
    } catch (error) {
      const diagnostic = errorMessage(error);
      this.setMemoryRuntimeDiagnostic(diagnostic, error);
    }
  }

  private setMemoryRuntimeDiagnostic(diagnostic: string | null, error?: unknown): void {
    const next = diagnostic?.trim() ?? '';
    if (next && next !== this.memoryRuntimeDiagnostic) {
      console.warn('Ailu optional Agent Memory runtime v2 is unavailable.', error ?? next);
    }
    this.memoryRuntimeDiagnostic = next;
  }

  private async refreshPublishingViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_IDS.publishing)) {
      if (leaf.view instanceof PublishingStudioView) await leaf.view.refresh();
    }
  }

  private openSettings(tab: SettingsTabId = 'general'): void {
    const setting = (this.app as AppWithSettings).setting;
    if (!setting) {
      new Notice(`请打开设置并选择“${PLUGIN_NAME}”。`);
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
    this.settingTab?.openTab(tab);
  }
}

export function normalizeSettings(
  value: Partial<AiluSettings> | null | undefined,
): AiluSettings {
  const agentSettings = normalizeAgentSettings(value);
  const publishing = normalizePublishingSettings(value?.publishing);
  const xPublishing = normalizeXPublishingSettings(value?.xPublishing);
  const feishuDestination = readFeishuDestination(value);
  return {
    schemaVersion: 1,
    ...agentSettings,
    systemPrompt: typeof value?.systemPrompt === 'string'
      ? value.systemPrompt
      : DEFAULT_SETTINGS.systemPrompt,
    planModeDefault: typeof value?.planModeDefault === 'boolean'
      ? value.planModeDefault
      : DEFAULT_SETTINGS.planModeDefault,
    maxContextFileChars: typeof value?.maxContextFileChars === 'number'
      && Number.isFinite(value.maxContextFileChars)
      ? value.maxContextFileChars
      : DEFAULT_SETTINGS.maxContextFileChars,
    feishuFolderToken: feishuDestination.token,
    feishuFolderUrl: feishuDestination.url,
    feishuDestinationKind: feishuDestination.kind,
    feishuDestinationName: feishuDestination.name,
    feishuDestinationPath: feishuDestination.path,
    feishuDestinationSpaceId: feishuDestination.spaceId,
    wechatThemeId: isWeChatThemeId(publishing.themeId)
      ? publishing.themeId
      : isWeChatThemeId(value?.wechatThemeId)
        ? value.wechatThemeId
        : DEFAULT_WECHAT_THEME_ID,
    publishing,
    xPublishing,
  };
}

function errorMessage(error: unknown): string {
  return userFacingErrorMessage(error, '操作未完成，请查看本地诊断日志。');
}

function sha256NullableText(value: string | null): string {
  return createHash('sha256')
    .update(value === null ? 'absent\0' : `value\0${value}`)
    .digest('hex');
}

function studioShutdownHandoffs(): Map<string, Promise<void>> {
  const host = window as unknown as Record<PropertyKey, unknown>;
  const canonical = host[STUDIO_SHUTDOWN_HANDOFF];
  const handoffs = canonical instanceof Map
    ? canonical as Map<string, Promise<void>>
    : new Map<string, Promise<void>>();
  host[STUDIO_SHUTDOWN_HANDOFF] = handoffs;
  return handoffs;
}
