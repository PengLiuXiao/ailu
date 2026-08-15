import {
  App,
  Component,
  getFrontMatterInfo,
  MarkdownRenderer,
  Notice,
  parseYaml,
  setIcon,
  TFile,
} from 'obsidian';
import { realpathSync } from 'node:fs';

import {
  FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY,
  FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY,
  FEISHU_CONTENT_HASH_FRONTMATTER_KEY,
  FEISHU_DOC_ID_FRONTMATTER_KEY,
  FEISHU_DOC_URL_FRONTMATTER_KEY,
  FEISHU_PUBLISHED_AT_FRONTMATTER_KEY,
  FEISHU_TITLE_FRONTMATTER_KEY,
  parseFeishuPublishState,
  reconcileCompletedFeishuPublishState,
  sameFeishuPublishState,
} from '../feishu/frontmatter';
import {
  canonicalizeFeishuDocumentUrl,
  signFeishuPublishState,
  verifyFeishuPublishState,
  type FeishuAssociationContext,
} from '../feishu/association';
import {
  applyFeishuDestination,
  feishuDestinationIdentity,
  feishuDestinationLabel,
  readFeishuDestination,
  type FeishuDestinationSelection,
} from '../feishu/destination';
import { LarkCliError, LarkCliService } from '../feishu/larkCli';
import { publishFeishuSnapshot } from '../feishu/publisher';
import { buildFeishuPreviewMarkdown } from '../feishu/preview';
import {
  buildFeishuSnapshot,
  hashFeishuSourceIntent,
  withFeishuSnapshotTitle,
} from '../feishu/snapshot';
import type {
  FeishuAuthProgress,
  FeishuConnectionState,
  FeishuPublishState,
  FeishuSnapshot,
} from '../feishu/types';
import type { AiluSettings } from '../types';
import { appendLocalLog } from '../storage/localLog';
import {
  rawErrorMessage,
  userFacingErrorMessage,
  userFacingErrorText,
} from '../utils/userFacingError';
import { getVaultBasePath } from '../utils/vault';
import {
  ManagedPreviewUrlStore,
  sanitizeManagedPreviewMarkdown,
} from '../utils/previewSecurity';
import { promptForFeishuDestination } from './feishuDestinationModal';
import {
  resolveFeishuConnectionControl,
  resolveFeishuConnectionIndicator,
  shouldCheckFeishuConnection,
  type FeishuPanelRefreshMode,
} from './feishuConnectionRefresh';
import { confirmShareAction } from './shareConfirm';
import {
  instrumentPublishingMarkdown,
  materializePublishingSourceMarkers,
} from './publishingSourceScroll';
import {
  attentionPublishingTargetActivity,
  IDLE_PUBLISHING_TARGET_ACTIVITY,
  runningPublishingTargetActivity,
  type PublishingTargetActivity,
} from './publishingTargetActivity';

export interface RenderedFeishuPublishingPreview {
  article: HTMLElement;
  viewport: HTMLElement;
}

interface FeishuPublishingPanelOptions {
  app: App;
  component: Component;
  cli: LarkCliService;
  file: TFile;
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  getAssociationKey: () => string | null;
  ensureAssociationKey: () => Promise<string>;
  requestRender: () => void;
}

interface FeishuDestinationIdentity {
  cliPath: string | null;
  accountOpenId: string | null;
  documentId: string | null;
  destinationKey: string;
  parentToken: string;
  label: string;
}

function formatUpdatedAt(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function createIconButton(
  parent: HTMLElement,
  text: string,
  iconName: string,
  className = '',
): HTMLButtonElement {
  const button = parent.createEl('button', {
    cls: className,
    attr: { type: 'button' },
  });
  const icon = button.createSpan();
  setIcon(icon, iconName);
  button.createSpan({ text });
  if (text) {
    button.setAttribute('aria-label', text);
    button.setAttribute('title', text);
  }
  return button;
}

/**
 * Feishu-only publishing host for the unified Studio. It intentionally does
 * not expose global CLI logout or the retired predecessor share surface.
 */
export class FeishuPublishingPanel {
  private loaded = false;
  private loading = false;
  private loadingMode: FeishuPanelRefreshMode | null = null;
  private disposed = false;
  private confirming = false;
  private pendingRefresh = false;
  private pendingConnectionCheck = false;
  private loadVersion = 0;
  private connection: FeishuConnectionState | null = null;
  private snapshot: FeishuSnapshot | null = null;
  private publishState: FeishuPublishState | null = null;
  private duplicatePath: string | null = null;
  private authProgress: FeishuAuthProgress | null = null;
  private operationLabel: string | null = null;
  private error: string | null = null;
  private consoleUrl: string | null = null;
  private title = '';
  private destinationSaving = false;
  private authUnsubscribe: (() => void) | null = null;
  private primaryButton: HTMLButtonElement | null = null;
  private lastLoggedConnectionFailure: string | null = null;
  private lastConnectionCheckSucceeded = false;
  private connectionCheckError: string | null = null;
  private titleDirty = false;
  private previewTitleEl: HTMLElement | null = null;
  private authStarting = false;
  private authAttemptId: string | null = null;
  private authEpoch = 0;
  private pendingRefreshTimer: number | null = null;
  private readonly previewUrls = new ManagedPreviewUrlStore();

  constructor(private readonly options: FeishuPublishingPanelOptions) {}

  activate(): void {
    if (this.disposed) return;
    if (!this.authUnsubscribe) {
      this.authUnsubscribe = this.options.cli.onProgress((progress) => {
        if (!this.authAttemptId || progress.attemptId !== this.authAttemptId) return;
        this.authProgress = progress;
        if (progress.consoleUrl) this.consoleUrl = progress.consoleUrl;
        this.requestRender();
      });
    }
    if (!this.loaded && !this.loading) {
      void this.load('content');
    }
  }

  async refresh(mode: FeishuPanelRefreshMode = 'content'): Promise<void> {
    if (this.disposed) return;
    if (this.isBusy()) {
      this.pendingRefresh = true;
      if (mode === 'connection') this.pendingConnectionCheck = true;
      return;
    }
    await this.load(mode);
  }

  isBusy(): boolean {
    return this.loading
      || this.confirming
      || this.destinationSaving
      || this.authStarting
      || Boolean(this.operationLabel)
      || Boolean(this.authProgress && !['idle', 'success', 'failed', 'cancelled']
        .includes(this.authProgress.phase));
  }

  activity(): PublishingTargetActivity {
    if (this.operationLabel) return runningPublishingTargetActivity(this.operationLabel);
    if (this.authStarting) return runningPublishingTargetActivity('正在准备授权');
    if (this.destinationSaving) return runningPublishingTargetActivity('正在保存位置');
    if (this.confirming) return runningPublishingTargetActivity('等待确认');
    if (this.loading) return runningPublishingTargetActivity('正在准备预览');
    if (this.authProgress && !['idle', 'success', 'failed', 'cancelled']
      .includes(this.authProgress.phase)) {
      return runningPublishingTargetActivity(this.authProgress.message || '正在处理授权');
    }
    if (this.connectionCheckError || this.error) {
      return attentionPublishingTargetActivity('需要检查');
    }
    if (this.connection && !this.connection.connected) {
      return attentionPublishingTargetActivity('需要连接');
    }
    return IDLE_PUBLISHING_TARGET_ACTIVITY;
  }

  dispose(): void {
    this.disposed = true;
    this.authEpoch += 1;
    this.loadVersion += 1;
    if (this.pendingRefreshTimer !== null) {
      window.clearTimeout(this.pendingRefreshTimer);
      this.pendingRefreshTimer = null;
    }
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    if (this.authAttemptId) {
      this.options.cli.cancelAuthorization(this.authAttemptId);
      this.authAttemptId = null;
    }
    this.previewUrls.revokeAll();
  }

  async render(parent: HTMLElement): Promise<RenderedFeishuPublishingPreview | null> {
    this.primaryButton = null;
    this.previewTitleEl = null;
    this.renderMeta(parent);
    const viewport = parent.createDiv({ cls: 'ailu-publishing-scroll ailu-feishu-publishing-scroll' });
    const surface = viewport.createDiv({ cls: 'ailu-feishu-publishing-surface' });

    this.renderControls(surface);
    this.renderInlineStatus(surface);
    if (this.authProgress && this.isAuthFlowVisible()) {
      this.renderAuthorization(surface, this.authProgress);
    }

    if (!this.snapshot) {
      this.renderState(
        surface,
        this.loading ? 'loader-circle' : 'file-warning',
        this.loading ? '正在生成飞书本地预览' : '没有可预览内容',
        this.error || '读取当前 Markdown 与本地图片。',
      );
      this.renderActions(parent, false);
      return null;
    }

    const previewSnapshot = withFeishuSnapshotTitle(this.snapshot, this.title);
    const activePreviewKeys = new Set<string>();
    const previewAssetUrls = new Map<string, string>();
    for (const asset of previewSnapshot.assets) {
      if (!asset.body) continue;
      try {
        const previewUrl = this.previewUrls.setVerifiedImage(
          asset.placeholder,
          asset.body,
          asset.mimeType,
          asset.contentHash,
        );
        activePreviewKeys.add(asset.placeholder);
        previewAssetUrls.set(asset.placeholder, previewUrl);
      } catch {
        // A failed frozen-byte check becomes a local placeholder. Never fall
        // back to a Vault resource URL or remote URL in MarkdownRenderer.
      }
    }
    this.previewUrls.revokeExcept(activePreviewKeys);
    const previewMarkdown = sanitizeManagedPreviewMarkdown(
      buildFeishuPreviewMarkdown(
        previewSnapshot,
        asset => previewAssetUrls.get(asset.placeholder) ?? null,
      ),
      this.previewUrls.allowedObjectUrls(),
    );
    const card = surface.createDiv({ cls: 'ailu-feishu-preview-card' });
    card.createDiv({ cls: 'ailu-feishu-preview-kicker', text: '飞书文档 · 本地预览' });
    const article = card.createDiv({
      cls: 'ailu-publishing-article ailu-feishu-preview-body markdown-rendered',
    });
    await MarkdownRenderer.render(
      this.options.app,
      instrumentPublishingMarkdown(previewMarkdown, previewSnapshot.sourceLineMap),
      article,
      previewSnapshot.sourcePath || this.options.file.path,
      this.options.component,
    );
    if (this.disposed || !article.isConnected) return null;
    materializePublishingSourceMarkers(article);
    this.previewTitleEl = article.querySelector<HTMLElement>('h1');
    if (this.previewTitleEl) this.previewTitleEl.textContent = this.title;
    this.renderActions(parent, true);
    return { article, viewport };
  }

  private async load(mode: FeishuPanelRefreshMode): Promise<void> {
    if (this.disposed) return;
    const version = ++this.loadVersion;
    const checkConnection = shouldCheckFeishuConnection(mode);
    this.loading = true;
    this.loadingMode = checkConnection ? 'connection' : 'content';
    if (checkConnection) {
      this.lastConnectionCheckSucceeded = false;
      this.connectionCheckError = null;
    } else {
      this.error = null;
      if (!this.connection) this.connection = this.options.cli.getCachedConnectionState();
    }
    this.requestRender();
    try {
      if (checkConnection) {
        const connection = await this.options.cli.getConnectionState(true);
        if (this.disposed || version !== this.loadVersion) return;
        this.connection = connection;
        this.consoleUrl = connection.consoleUrl;
        this.lastConnectionCheckSucceeded = true;
        this.connectionCheckError = null;
        this.handleConnectionCheckResult(connection);
      } else {
        const frontmatter = this.options.app.metadataCache
          .getFileCache(this.options.file)
          ?.frontmatter;
        const publishState = parseFeishuPublishState(frontmatter);
        const snapshot = await buildFeishuSnapshot(this.options.app, this.options.file);
        if (this.disposed || version !== this.loadVersion) return;
        this.publishState = publishState;
        const trustedState = this.trustedPublishState(publishState, this.connection);
        this.duplicatePath = trustedState
          ? this.findDuplicatePath(trustedState.documentId)
          : null;
        this.snapshot = snapshot;
        if (!this.titleDirty) {
          this.title = trustedState?.title || snapshot.title;
        }
      }
    } catch (error) {
      if (this.disposed || version !== this.loadVersion) return;
      if (checkConnection) {
        this.lastConnectionCheckSucceeded = false;
        this.connectionCheckError = userFacingErrorMessage(
          error,
          '检查飞书连接失败，请手动重试。',
        );
      } else {
        this.error = userFacingErrorMessage(error, '加载飞书文章内容失败。');
      }
    } finally {
      if (!this.disposed && version === this.loadVersion) {
        if (!checkConnection) this.loaded = true;
        this.loading = false;
        this.loadingMode = null;
        this.requestRender();
        this.drainPendingRefresh();
      }
    }
  }

  private renderMeta(parent: HTMLElement): void {
    const meta = parent.createDiv({ cls: 'ailu-publishing-meta ailu-feishu-publishing-meta' });
    const title = this.snapshot?.title || this.options.file.basename || '未命名文章';
    meta.createEl('strong', { text: title });
    if (this.snapshot) {
      meta.createSpan({ text: `${this.snapshot.assets.length} 张图片` });
      meta.createSpan({ text: `${this.snapshot.markdown.length.toLocaleString()} 字符` });
    }
    if (this.loading) {
      meta.createSpan({ text: this.loadingMode === 'connection' ? '检查连接中' : '更新内容中' });
    } else if (this.error) {
      meta.createSpan({ cls: 'has-warning', text: '预览需要处理' });
    } else if (this.snapshot?.warnings.length) {
      meta.createSpan({ cls: 'has-warning', text: `${this.snapshot.warnings.length} 项提示` });
    } else if (this.snapshot) {
      meta.createSpan({ cls: 'is-ready', text: '本地预览' });
    }
  }

  private renderControls(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: 'ailu-feishu-document-card' });
    const form = card.createDiv({ cls: 'ailu-feishu-document-form' });
    const titleLabel = form.createEl('label');
    titleLabel.createSpan({ text: '文档标题' });
    const titleInput = titleLabel.createEl('input', {
      attr: {
        type: 'text',
        value: this.title,
        'aria-label': '飞书文档标题',
      },
    });
    titleInput.disabled = this.isBusy();
    titleInput.oninput = () => {
      this.title = titleInput.value;
      this.titleDirty = true;
      if (this.previewTitleEl) this.previewTitleEl.textContent = this.title.trim() || this.snapshot?.title || '';
      this.updatePrimaryButton();
    };
    this.renderDestination(form);

    const trustedState = this.trustedPublishState();
    if (trustedState?.url) {
      const status = form.createDiv({ cls: 'ailu-feishu-linked-document' });
      const icon = status.createSpan();
      setIcon(icon, 'link-2');
      const copy = status.createDiv();
      copy.createEl('strong', { text: '已关联飞书文档' });
      const updatedAt = formatUpdatedAt(trustedState.updatedAt);
      copy.createSpan({
        text: !trustedState.contentHash
          ? '上次同步未完成，请核对后重试'
          : updatedAt
            ? `最后同步 ${updatedAt}`
            : '后续默认更新同一篇文档并保持链接不变',
      });
    } else if (this.publishState) {
      form.createDiv({
        cls: 'ailu-feishu-sync-rule has-warning',
        text: '检测到尚未由本机 Ailu 认证的旧关联；不会直接覆盖，下一步会先核验账号、文档 ID 和链接。',
      });
    } else {
      form.createDiv({
        cls: 'ailu-feishu-sync-rule',
        text: '首次创建后将记录关联，后续默认更新同一篇文档。',
      });
    }

    if (this.duplicatePath) {
      this.renderNotice(
        card,
        'copy-x',
        '检测到重复关联',
        `另一篇笔记“${this.duplicatePath}”关联了同一篇飞书文档，本次会创建新文档。`,
        'is-warning',
      );
    }
    if (this.snapshot?.warnings.length) {
      this.renderNotice(
        card,
        'triangle-alert',
        '内容提示',
        this.snapshot.warnings.join('；'),
        'is-warning',
      );
    }
    if (this.error) {
      this.renderNotice(card, 'circle-alert', '上次同步未完成', this.error, 'is-error');
    } else if (this.connectionCheckError) {
      this.renderNotice(
        card,
        'wifi-off',
        '连接检查暂时失败',
        this.connectionCheckError,
        'is-warning',
      );
    } else if (trustedState && !trustedState.contentHash) {
      this.renderNotice(
        card,
        'circle-alert',
        '上次同步未完成',
        '远端可能已发生部分变化；请先打开文档核对，再重新同步。',
        'is-warning',
      );
    } else if (this.isUnchanged()) {
      this.renderNotice(card, 'circle-check', '飞书文档已是最新', '当前笔记与最后同步内容一致。', 'is-success');
    }
  }

  private connectionSummary(): string {
    const connection = this.connection;
    if (!connection) return '未检查 · 同步时会检查连接';
    if (connection.connected) return '已连接 · 同步时会再次检查';
    if (connection.status === 'missing-cli') return '未检测到本机飞书 CLI';
    if (connection.status === 'needs-config') return '尚未配置飞书应用';
    if (connection.status === 'needs-auth') return '飞书授权需要更新';
    if (connection.status === 'admin-action-required') return '需要在飞书后台开放文档权限';
    return userFacingErrorText(connection.message, '上次连接检查未完成。');
  }

  private renderInlineStatus(parent: HTMLElement): void {
    if (this.authStarting && !this.authProgress) {
      this.renderNotice(parent, 'loader-circle', '正在准备飞书授权', '只会连接中国版飞书。', 'is-progress');
    }
    if (this.operationLabel) {
      this.renderNotice(parent, 'loader-circle', this.operationLabel, '请保持 Obsidian 打开。', 'is-progress');
    }
    if (this.loading && this.loadingMode === 'connection' && !this.operationLabel) {
      this.renderNotice(parent, 'loader-circle', '正在检查飞书连接', '只读取本机登录与授权状态。', 'is-progress');
    }
    if (this.connection && !this.connection.connected) {
      this.renderNotice(
        parent,
        this.connection.status === 'error' ? 'wifi-off' : 'circle-alert',
        this.connection.status === 'error' ? '飞书连接检查未完成' : '飞书暂未连接',
        userFacingErrorText(this.connection.message, this.connectionSummary()),
        'is-warning',
      );
    }
  }

  private handleConnectionAction(): void {
    const status = this.connection?.status;
    if (status === 'missing-cli') {
      this.openExternal('https://github.com/larksuite/cli#installation');
    } else if (status === 'needs-config') {
      void this.connect();
    } else if (status === 'needs-auth') {
      void this.reauthorize();
    } else if (status === 'admin-action-required' && this.consoleUrl) {
      this.openExternal(this.consoleUrl);
    } else {
      void this.checkConnection();
    }
  }

  private renderAuthorization(parent: HTMLElement, progress: FeishuAuthProgress): void {
    const title = progress.phase === 'configuring'
      ? '配置飞书应用'
      : progress.phase === 'verifying'
        ? '正在验证授权'
        : progress.phase === 'failed'
          ? '授权暂未完成'
          : '在飞书中完成授权';
    const card = parent.createDiv({ cls: 'ailu-feishu-auth-card' });
    card.createEl('h3', { text: title });
    card.createEl('p', {
      text: progress.phase === 'failed'
        ? userFacingErrorText(progress.message, '飞书授权未完成，请重新尝试。')
        : progress.message || '仅申请文档发布，以及云盘和知识库目录只读权限。',
    });
    if (progress.qrCodeDataUrl) {
      card.createEl('img', {
        cls: 'ailu-feishu-auth-qr',
        attr: { src: progress.qrCodeDataUrl, alt: '飞书授权二维码' },
      });
      card.createDiv({
        cls: 'ailu-feishu-auth-scope',
        text: '授权范围：文档创建、读取、更新、图片上传，以及保存位置目录只读',
      });
    } else if (!['failed', 'cancelled'].includes(progress.phase)) {
      const spinner = card.createSpan({ cls: 'ailu-feishu-inline-spinner' });
      setIcon(spinner, 'loader-circle');
    }
    if (progress.phase === 'failed' && progress.consoleUrl) {
      this.consoleUrl = progress.consoleUrl;
    }
  }

  private renderState(
    parent: HTMLElement,
    iconName: string,
    title: string,
    description: string,
  ): void {
    const state = parent.createDiv({ cls: 'ailu-feishu-state' });
    const icon = state.createSpan({ cls: 'ailu-feishu-state-icon' });
    setIcon(icon, iconName);
    state.createEl('h3', { text: title });
    state.createEl('p', { text: description });
  }

  private renderNotice(
    parent: HTMLElement,
    iconName: string,
    title: string,
    message: string,
    state: string,
  ): void {
    const notice = parent.createDiv({
      cls: `ailu-feishu-inline-notice ${state}`,
      attr: {
        role: state === 'is-error' ? 'alert' : 'status',
        'aria-live': state === 'is-error' ? 'assertive' : 'polite',
      },
    });
    const icon = notice.createSpan();
    setIcon(icon, iconName);
    const copy = notice.createDiv();
    copy.createEl('strong', { text: title });
    copy.createSpan({ text: message });
  }

  private renderAuthorizationActions(parent: HTMLElement, progress: FeishuAuthProgress): void {
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions ailu-feishu-publishing-actions' });
    if (progress.verificationUrl) {
      const open = createIconButton(actions, '打开授权页', 'external-link');
      open.onclick = () => this.openExternal(progress.verificationUrl!);
    }
    if (progress.phase === 'failed' || progress.phase === 'cancelled') {
      const retry = createIconButton(actions, '重新授权', 'rotate-cw', 'mod-cta');
      retry.onclick = () => void this.reauthorize();
      return;
    }
    const cancel = actions.createEl('button', {
      cls: 'mod-cta',
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => {
      this.authEpoch += 1;
      if (this.authAttemptId) this.options.cli.cancelAuthorization(this.authAttemptId);
      this.authAttemptId = null;
      this.authProgress = null;
      this.authStarting = false;
      this.requestRender();
      this.drainPendingRefresh();
    };
  }

  private renderActions(parent: HTMLElement, ready: boolean): void {
    if (this.authProgress && this.isAuthFlowVisible()) {
      this.renderAuthorizationActions(parent, this.authProgress);
      return;
    }
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions ailu-feishu-publishing-actions' });
    const connectionIndicator = resolveFeishuConnectionIndicator({
      status: this.connection?.status ?? null,
      connected: Boolean(this.connection?.connected),
      accountName: this.connection?.accountName,
      checking: this.loadingMode === 'connection',
      checkFailed: Boolean(this.connectionCheckError),
    });
    const connectionStatus = actions.createDiv({
      cls: `ailu-feishu-action-status is-${connectionIndicator.tone}`,
      attr: {
        role: 'status',
        'aria-live': 'polite',
        'aria-label': this.connectionCheckError || this.connectionSummary(),
        title: this.connectionCheckError || this.connectionSummary(),
      },
    });
    connectionStatus.createSpan({ cls: 'ailu-feishu-action-status-dot' });
    connectionStatus.createSpan({ text: connectionIndicator.label });
    const trustedState = this.trustedPublishState();
    if (trustedState?.url) {
      const open = createIconButton(actions, '打开文档', 'external-link');
      open.onclick = () => this.openExternal(trustedState.url);
      const copy = createIconButton(actions, '复制链接', 'copy');
      copy.onclick = () => void navigator.clipboard.writeText(trustedState.url)
        .then(() => new Notice('飞书文档链接已复制。'))
        .catch(() => new Notice('复制失败，请打开飞书文档后从地址栏复制链接。'));
    }
    const connectionControl = resolveFeishuConnectionControl(this.connection?.status ?? null);
    const check = createIconButton(actions, connectionControl.label, connectionControl.icon);
    check.disabled = this.isBusy();
    check.onclick = () => {
      if (connectionControl.mode === 'manage') this.handleConnectionAction();
      else void this.checkConnection();
    };
    const primary = createIconButton(actions, '', 'send', 'mod-cta');
    this.primaryButton = primary;
    primary.onclick = () => void this.publish(Boolean(this.duplicatePath));
    this.updatePrimaryButton();
    if (!ready) primary.disabled = true;
  }

  private updatePrimaryButton(): void {
    const button = this.primaryButton;
    if (!button) return;
    const text = button.querySelector('span:last-child');
    const unchanged = this.isUnchanged();
    const trustedState = this.trustedPublishState();
    const label = this.duplicatePath
      ? '创建新文档'
      : trustedState
        ? unchanged ? '已同步' : '同步到飞书'
        : this.publishState ? '核验并同步' : '创建飞书文档';
    if (text) text.textContent = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.disabled = !this.snapshot
      || !this.title.trim()
      || unchanged
      || this.loading
      || this.confirming
      || this.destinationSaving
      || Boolean(this.operationLabel);
  }

  private isUnchanged(): boolean {
    const trustedState = this.trustedPublishState();
    if (!trustedState || !this.snapshot || this.duplicatePath) return false;
    return trustedState.contentHash === withFeishuSnapshotTitle(
      this.snapshot,
      this.title,
    ).contentHash;
  }

  private associationContext(accountOpenId: string): FeishuAssociationContext {
    const basePath = getVaultBasePath(this.options.app);
    if (!basePath) throw new Error('飞书文档关联仅支持本地文件系统 Vault。');
    return {
      vaultBasePath: realpathSync(basePath),
      sourcePath: this.options.file.path,
      accountOpenId,
    };
  }

  private trustedPublishState(
    state: FeishuPublishState | null = this.publishState,
    connection: FeishuConnectionState | null = this.connection,
  ): FeishuPublishState | null {
    const accountOpenId = connection?.connected ? connection.accountOpenId?.trim() ?? '' : '';
    if (!state || !accountOpenId) return null;
    try {
      return verifyFeishuPublishState(
        state,
        this.options.getAssociationKey(),
        this.associationContext(accountOpenId),
      ) ? state : null;
    } catch {
      return null;
    }
  }

  private async connect(): Promise<void> {
    if (this.isBusy()) return;
    const epoch = ++this.authEpoch;
    this.authStarting = true;
    this.error = null;
    this.consoleUrl = null;
    this.requestRender();
    try {
      if (!this.options.cli.discoverCli().path) {
        this.openExternal('https://github.com/larksuite/cli#installation');
        return;
      }
      const handle = this.options.cli.beginAuthorization((url) => {
        if (this.isCurrentAuthEpoch(epoch)) this.openExternal(url);
      });
      this.authAttemptId = handle.attemptId;
      const progress = await handle.progress;
      if (!this.isCurrentAuthEpoch(epoch)) {
        this.options.cli.cancelAuthorization(handle.attemptId);
        return;
      }
      this.authProgress = progress;
      this.requestRender();
      window.setTimeout(() => void this.finishAuthorization(epoch), 0);
    } catch (error) {
      if (this.isCurrentAuthEpoch(epoch)) this.handleAuthError(error, '连接飞书失败');
    } finally {
      if (this.isCurrentAuthEpoch(epoch)) this.authStarting = false;
      this.requestRender();
      this.drainPendingRefresh();
    }
  }

  private async reauthorize(): Promise<void> {
    if (this.isBusy()) return;
    const epoch = ++this.authEpoch;
    this.authStarting = true;
    this.error = null;
    this.requestRender();
    try {
      const handle = this.options.cli.beginAuthorization();
      this.authAttemptId = handle.attemptId;
      const progress = await handle.progress;
      if (!this.isCurrentAuthEpoch(epoch)) {
        this.options.cli.cancelAuthorization(handle.attemptId);
        return;
      }
      this.authProgress = progress;
      this.requestRender();
      window.setTimeout(() => void this.finishAuthorization(epoch), 0);
    } catch (error) {
      if (this.isCurrentAuthEpoch(epoch)) this.handleAuthError(error, '重新授权失败');
    } finally {
      if (this.isCurrentAuthEpoch(epoch)) this.authStarting = false;
      this.requestRender();
      this.drainPendingRefresh();
    }
  }

  private async finishAuthorization(epoch: number): Promise<void> {
    const attemptId = this.authAttemptId;
    if (!attemptId || !this.isCurrentAuthEpoch(epoch)) return;
    try {
      const connection = await this.options.cli.completeAuthorization(attemptId);
      if (!this.isCurrentAuthEpoch(epoch)) return;
      this.connection = connection;
      this.authProgress = null;
      this.error = null;
      this.connectionCheckError = null;
      new Notice('飞书文档发布与目录只读权限已连接。');
      await this.load('content');
    } catch (error) {
      if (this.isCurrentAuthEpoch(epoch)) this.handleAuthError(error, '飞书授权失败');
    } finally {
      if (this.authAttemptId === attemptId) this.authAttemptId = null;
    }
  }

  private async publish(asNew: boolean): Promise<void> {
    if (!this.snapshot || !this.title.trim() || this.isBusy()) return;

    this.operationLabel = '正在检查飞书连接…';
    this.connectionCheckError = null;
    this.lastConnectionCheckSucceeded = false;
    this.requestRender();
    let connection: FeishuConnectionState | null = null;
    try {
      const checkedConnection = await this.options.cli.getConnectionState(true);
      if (this.disposed) return;
      connection = checkedConnection;
      this.connection = checkedConnection;
      this.consoleUrl = checkedConnection.consoleUrl;
      this.lastConnectionCheckSucceeded = true;
      this.handleConnectionCheckResult(checkedConnection);
    } catch (error) {
      if (this.disposed) return;
      this.connectionCheckError = userFacingErrorMessage(
        error,
        '检查飞书连接失败，请手动重试。',
      );
    } finally {
      this.operationLabel = null;
      this.requestRender();
    }
    if (!connection?.connected) {
      this.drainPendingRefresh();
      return;
    }

    this.operationLabel = '正在核对当前文章…';
    this.requestRender();
    let latestSnapshot: FeishuSnapshot | null = null;
    try {
      const builtSnapshot = await buildFeishuSnapshot(this.options.app, this.options.file);
      if (this.disposed) return;
      latestSnapshot = builtSnapshot;
      const latestPublishState = await this.readPersistedPublishState();
      this.snapshot = builtSnapshot;
      this.publishState = latestPublishState;
      const trustedLatestPublishState = this.trustedPublishState(
        latestPublishState,
        connection,
      );
      this.duplicatePath = trustedLatestPublishState
        ? this.findDuplicatePath(trustedLatestPublishState.documentId)
        : null;
      if (!this.titleDirty) this.title = trustedLatestPublishState?.title || latestSnapshot.title;
    } catch (error) {
      if (this.disposed) return;
      this.error = userFacingErrorMessage(error, '核对飞书文章失败，请刷新预览后重试。');
    } finally {
      this.operationLabel = null;
      this.requestRender();
    }
    if (!latestSnapshot) {
      this.drainPendingRefresh();
      return;
    }

    const expected = withFeishuSnapshotTitle(latestSnapshot, this.title);
    const expectedSourceIntentHash = hashFeishuSourceIntent(
      await this.options.app.vault.read(this.options.file),
    );
    const baselinePublishState = this.publishState;
    const accountOpenId = connection.accountOpenId?.trim() ?? '';
    if (!accountOpenId) {
      this.error = '无法确认当前飞书账号，已停止发布。请重新检查飞书连接。';
      this.requestRender();
      this.drainPendingRefresh();
      return;
    }
    const trustedBaseline = this.trustedPublishState(baselinePublishState, connection);
    let existing = !asNew && !this.duplicatePath ? trustedBaseline : null;
    let requiresAdoption = false;
    if (!existing && baselinePublishState && !asNew && !this.duplicatePath) {
      this.operationLabel = '正在核验旧飞书关联…';
      this.requestRender();
      try {
        const canonicalUrl = canonicalizeFeishuDocumentUrl(
          baselinePublishState.url,
          baselinePublishState.documentId,
        );
        await this.options.cli.runPublishingOperation(
          () => this.options.cli.fetchDocumentContent(baselinePublishState.documentId),
        );
        existing = {
          ...baselinePublishState,
          url: canonicalUrl,
        };
        requiresAdoption = true;
      } catch (error) {
        this.error = userFacingErrorMessage(
          error,
          '旧飞书关联无法由当前账号核验；未覆盖任何文档。请修正关联或创建新文档。',
        );
      } finally {
        this.operationLabel = null;
        this.requestRender();
      }
      if (!existing) {
        this.drainPendingRefresh();
        return;
      }
    }
    const selectedDestination = this.currentDestination();
    const destination: FeishuDestinationIdentity = {
      cliPath: connection.cliPath,
      accountOpenId: connection.accountOpenId,
      documentId: baselinePublishState?.documentId ?? null,
      destinationKey: feishuDestinationIdentity(selectedDestination),
      parentToken: selectedDestination.token,
      label: feishuDestinationLabel(selectedDestination),
    };
    const accountLabel = connection.accountName?.trim() || connection.tenantName?.trim() || '当前账号';
    const targetDescription = existing
      ? `账号：${accountLabel}（${accountOpenId}）\n文档 ID：${existing.documentId}\n链接：${existing.url}`
      : `账号：${accountLabel}（${accountOpenId}）\n保存位置：${destination.label}`;
    this.confirming = true;
    this.updatePrimaryButton();
    const confirmed = await confirmShareAction(this.options.app, {
      title: requiresAdoption ? '认领并覆盖这篇飞书文档？' : existing ? '同步到飞书？' : '创建飞书文档？',
      message: requiresAdoption
        ? `这是一条尚未由本机 Ailu 认证的旧关联。当前账号已成功读取目标文档；确认后会建立本机签名绑定，并用当前笔记覆盖正文与图片。\n${targetDescription}\n本次包含 ${expected.assets.length} 张图片。`
        : existing
          ? `将用当前笔记覆盖已认证关联文档的正文与图片，并保持链接不变。飞书端手工修改和评论可能受影响；本次包含 ${expected.assets.length} 张图片。\n${targetDescription}`
          : `将在“${destination.label}”创建《${expected.title}》，包含 ${expected.assets.length} 张本地图片。\n${targetDescription}`,
      confirmText: requiresAdoption ? '确认认领并覆盖' : existing ? '确认同步' : '确认创建',
      dangerous: requiresAdoption,
    });
    this.confirming = false;
    if (!confirmed || this.disposed) {
      this.requestRender();
      this.drainPendingRefresh();
      return;
    }

    let associationKey: string;
    try {
      associationKey = await this.options.ensureAssociationKey();
    } catch (error) {
      this.error = userFacingErrorMessage(error, '无法建立飞书文档的本机可信绑定，已停止发布。');
      this.requestRender();
      this.drainPendingRefresh();
      return;
    }
    const protectState = (value: FeishuPublishState): FeishuPublishState =>
      signFeishuPublishState(value, associationKey, this.associationContext(accountOpenId));

    const logContext = {
      mode: existing ? 'update' : 'create',
      notePath: this.options.file.path,
      imageCount: expected.assets.length,
      destinationKind: selectedDestination.kind,
    };
    appendLocalLog('feishu_publish_started', logContext);
    await this.runOperation(existing ? '正在同步正文与图片…' : '正在创建飞书文档…', async () => {
      try {
        await this.assertDestinationCurrent(destination, baselinePublishState);
        await this.assertSnapshotCurrent(expected);
        await this.assertSourceIntentCurrent(expectedSourceIntentHash);
        let expectedPersistedState = baselinePublishState;
        if (requiresAdoption && existing) {
          const adoptedState = protectState(existing);
          await this.setPublishState(adoptedState, expectedPersistedState);
          expectedPersistedState = adoptedState;
          existing = adoptedState;
          this.publishState = adoptedState;
        }
        const returnedState = await publishFeishuSnapshot({
          cli: this.options.cli,
          snapshot: expected,
          existing,
          parentToken: destination.parentToken,
          persistState: async (value) => {
            const protectedValue = protectState(value);
            await this.setPublishState(protectedValue, expectedPersistedState);
            expectedPersistedState = protectedValue;
          },
          onPendingState: (value) => {
            this.publishState = protectState(value);
          },
          onStage: event => appendLocalLog('feishu_publish_stage', {
            ...logContext,
            stage: event.stage,
            status: event.status,
            ...(event.message ? { message: event.message } : {}),
          }),
          beforeRemoteWrite: async () => {
            await this.assertLocalIntentCurrent(
              expected,
              destination,
              expectedSourceIntentHash,
              expectedPersistedState,
            );
          },
          onCleanupWarning: error => {
            appendLocalLog('feishu_asset_staging_cleanup_failed', {
              ...logContext,
              message: rawErrorMessage(error) || '清理飞书图片临时目录失败',
            });
            new Notice('飞书已同步；图片临时目录未能自动清理，请稍后重启 Ailu。');
          },
        });
        const state = protectState(returnedState);
        if (!sameFeishuPublishState(state, expectedPersistedState)) {
          throw new Error('飞书完成状态与本机可信绑定不一致；已停止并保留诊断。');
        }
        this.publishState = state;
        this.duplicatePath = null;
        this.title = state.title;
        this.titleDirty = false;
        this.error = null;
        appendLocalLog('feishu_publish_succeeded', {
          ...logContext,
          contentHash: state.contentHash,
          updatedAt: state.updatedAt,
        });
        new Notice(existing ? '飞书文档已同步并回读验证。' : '飞书文档已创建并回读验证。');
      } catch (error) {
        const larkError = error instanceof LarkCliError ? error : null;
        appendLocalLog('feishu_publish_failed', {
          ...logContext,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: rawErrorMessage(error) || '飞书同步失败',
          exitCode: larkError?.exitCode ?? null,
          permissionViolationCount: larkError?.permissionViolations.length ?? 0,
          confirmationRequired: larkError?.confirmationRequired ?? false,
        });
        throw error;
      }
    });
  }

  private async assertSnapshotCurrent(expected: FeishuSnapshot): Promise<void> {
    if (this.disposed) throw new Error('飞书面板已关闭，已停止本次同步。');
    const latest = withFeishuSnapshotTitle(
      await buildFeishuSnapshot(this.options.app, this.options.file),
      this.title,
    );
    if (latest.contentHash !== expected.contentHash) {
      this.snapshot = latest;
      throw new Error('笔记或图片在确认期间已变化，请重新确认。');
    }
  }

  private async assertDestinationCurrent(
    expected: FeishuDestinationIdentity,
    expectedPublishState: FeishuPublishState | null,
  ): Promise<void> {
    const connection = await this.options.cli.getConnectionState(true);
    if (this.disposed) throw new Error('飞书面板已关闭，已停止本次同步。');
    const frontmatterState = await this.readPersistedPublishState();
    if (
      !connection.connected
      || connection.cliPath !== expected.cliPath
      || connection.accountOpenId !== expected.accountOpenId
      || !sameFeishuPublishState(frontmatterState, expectedPublishState)
      || feishuDestinationIdentity(this.currentDestination()) !== expected.destinationKey
    ) {
      this.connection = connection;
      this.publishState = frontmatterState;
      throw new Error('飞书账号或关联文档在确认期间已变化，请重新检查并确认。');
    }
  }

  private async assertLocalIntentCurrent(
    expectedSnapshot: FeishuSnapshot,
    expectedDestination: FeishuDestinationIdentity,
    expectedSourceIntentHash: string,
    expectedPublishState: FeishuPublishState | null,
  ): Promise<void> {
    if (this.disposed) throw new Error('飞书面板已关闭，已停止本次同步。');
    const sourceBefore = await this.options.app.vault.read(this.options.file);
    if (hashFeishuSourceIntent(sourceBefore) !== expectedSourceIntentHash) {
      throw new Error('笔记正文、标题或发布设置在确认期间已变化，请重新确认。');
    }
    const frontmatterState = this.parsePersistedPublishState(sourceBefore);
    if (
      !sameFeishuPublishState(frontmatterState, expectedPublishState)
      || feishuDestinationIdentity(this.currentDestination()) !== expectedDestination.destinationKey
    ) {
      this.publishState = frontmatterState;
      throw new Error('飞书关联文档或保存位置在确认期间已变化，请重新确认。');
    }

    const latest = withFeishuSnapshotTitle(
      await buildFeishuSnapshot(this.options.app, this.options.file),
      this.title,
    );
    const sourceAfter = await this.options.app.vault.read(this.options.file);
    if (
      this.disposed
      || sourceAfter !== sourceBefore
      || hashFeishuSourceIntent(sourceAfter) !== expectedSourceIntentHash
      || latest.contentHash !== expectedSnapshot.contentHash
      || feishuDestinationIdentity(this.currentDestination()) !== expectedDestination.destinationKey
    ) {
      this.snapshot = latest;
      this.publishState = this.parsePersistedPublishState(sourceAfter);
      throw new Error('笔记、图片、标题或飞书保存位置在确认期间已变化，请重新确认。');
    }
  }

  private async assertSourceIntentCurrent(expectedHash: string): Promise<void> {
    if (this.disposed) throw new Error('飞书面板已关闭，已停止本次同步。');
    const source = await this.options.app.vault.read(this.options.file);
    if (hashFeishuSourceIntent(source) !== expectedHash) {
      throw new Error('笔记正文、标题或发布设置在确认期间已变化，请重新确认。');
    }
  }

  private async readPersistedPublishState(): Promise<FeishuPublishState | null> {
    const source = await this.options.app.vault.read(this.options.file);
    return this.parsePersistedPublishState(source);
  }

  private parsePersistedPublishState(source: string): FeishuPublishState | null {
    const info = getFrontMatterInfo(source);
    if (!info.exists || !info.frontmatter.trim()) return null;
    const parsed: unknown = parseYaml(info.frontmatter);
    return parseFeishuPublishState(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null,
    );
  }

  private async runOperation(label: string, operation: () => Promise<void>): Promise<void> {
    this.operationLabel = label;
    this.error = null;
    this.requestRender();
    let completedState: FeishuPublishState | null = null;
    try {
      await operation();
      completedState = this.publishState?.contentHash ? this.publishState : null;
    } catch (error) {
      this.error = userFacingErrorMessage(error, '飞书同步失败，请查看本地诊断日志。');
      const larkError = error instanceof LarkCliError ? error : null;
      this.consoleUrl = larkError?.consoleUrl ?? this.consoleUrl;
      new Notice(this.error, 0);
    } finally {
      this.operationLabel = null;
      if (this.pendingRefresh) {
        const operationError = this.error;
        const pendingMode: FeishuPanelRefreshMode = this.pendingConnectionCheck
          ? 'connection'
          : 'content';
        this.pendingRefresh = false;
        this.pendingConnectionCheck = false;
        await this.load(pendingMode);
        this.publishState = reconcileCompletedFeishuPublishState(
          this.publishState,
          completedState,
        );
        if (this.publishState?.title && !this.titleDirty) this.title = this.publishState.title;
        if (operationError) {
          this.error = operationError;
        }
        this.requestRender();
      } else {
        this.requestRender();
      }
    }
  }

  private async setPublishState(
    state: FeishuPublishState,
    expected: FeishuPublishState | null,
  ): Promise<void> {
    await this.options.app.fileManager.processFrontMatter(
      this.options.file,
      (frontmatter: Record<string, unknown>) => {
        const current = parseFeishuPublishState(frontmatter);
        if (!sameFeishuPublishState(current, expected)) {
          throw new Error('飞书关联状态已被另一个窗口修改；已保留较新的状态并停止本次同步。');
        }
        frontmatter[FEISHU_DOC_ID_FRONTMATTER_KEY] = state.documentId;
        frontmatter[FEISHU_DOC_URL_FRONTMATTER_KEY] = state.url;
        frontmatter[FEISHU_CONTENT_HASH_FRONTMATTER_KEY] = state.contentHash;
        frontmatter[FEISHU_PUBLISHED_AT_FRONTMATTER_KEY] = state.updatedAt;
        frontmatter[FEISHU_TITLE_FRONTMATTER_KEY] = state.title;
        if (state.associationVersion === undefined) {
          delete frontmatter[FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY];
        } else {
          frontmatter[FEISHU_ASSOCIATION_VERSION_FRONTMATTER_KEY] = state.associationVersion;
        }
        if (!state.associationSignature) {
          delete frontmatter[FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY];
        } else {
          frontmatter[FEISHU_ASSOCIATION_SIGNATURE_FRONTMATTER_KEY] = state.associationSignature;
        }
      },
    );
    const written = await this.readPersistedPublishState();
    if (!sameFeishuPublishState(written, state)) {
      throw new Error('飞书关联状态在写入后再次变化；已停止本次同步，请重新核对。');
    }
  }

  private findDuplicatePath(documentId: string): string | null {
    for (const candidate of this.options.app.vault.getMarkdownFiles()) {
      if (candidate.path === this.options.file.path) continue;
      const state = parseFeishuPublishState(
        this.options.app.metadataCache.getFileCache(candidate)?.frontmatter,
      );
      const accountOpenId = this.connection?.connected
        ? this.connection.accountOpenId?.trim() ?? ''
        : '';
      if (!state || !accountOpenId) continue;
      try {
        const basePath = getVaultBasePath(this.options.app);
        if (!basePath) continue;
        if (verifyFeishuPublishState(state, this.options.getAssociationKey(), {
          vaultBasePath: realpathSync(basePath),
          sourcePath: candidate.path,
          accountOpenId,
        }) && state.documentId === documentId) return candidate.path;
      } catch {
        // A malformed or foreign association is not update authorization and
        // must not block a trusted local document association.
      }
    }
    return null;
  }

  private renderDestination(parent: HTMLElement): void {
    const selected = this.currentDestination();
    const destination = parent.createDiv({ cls: 'ailu-feishu-destination' });
    const copy = destination.createDiv({ cls: 'ailu-feishu-destination-copy' });
    copy.createSpan({ text: this.publishState ? '新文档保存到' : '保存到' });
    copy.createEl('strong', { text: feishuDestinationLabel(selected) });
    const actions = destination.createDiv({ cls: 'ailu-feishu-destination-actions' });
    if (selected.url) {
      const open = actions.createEl('button', {
        cls: 'ailu-feishu-text-button',
        text: '打开',
        attr: { type: 'button', 'aria-label': '打开当前飞书保存位置' },
      });
      open.onclick = () => this.openExternal(selected.url);
    }
    const edit = actions.createEl('button', {
      cls: 'ailu-feishu-text-button',
      text: '更改',
      attr: { type: 'button', 'aria-label': '选择飞书文档保存位置' },
    });
    edit.disabled = this.isBusy();
    edit.onclick = () => void this.chooseDestination();
  }

  private currentDestination(): FeishuDestinationSelection {
    return readFeishuDestination(this.options.getSettings());
  }

  private async chooseDestination(): Promise<void> {
    if (this.isBusy()) return;
    this.operationLabel = '正在检查飞书连接…';
    this.connectionCheckError = null;
    this.requestRender();
    let connected = false;
    try {
      const connection = await this.options.cli.getConnectionState(true);
      if (this.disposed) return;
      this.connection = connection;
      this.consoleUrl = connection.consoleUrl;
      this.lastConnectionCheckSucceeded = true;
      this.handleConnectionCheckResult(connection);
      connected = connection.connected;
    } catch (error) {
      if (this.disposed) return;
      this.lastConnectionCheckSucceeded = false;
      this.connectionCheckError = userFacingErrorMessage(
        error,
        '检查飞书连接失败，请手动重试。',
      );
    } finally {
      this.operationLabel = null;
      this.requestRender();
    }
    if (!connected) {
      this.drainPendingRefresh();
      return;
    }
    const selected = await promptForFeishuDestination(
      this.options.app,
      this.options.cli,
      this.currentDestination(),
    );
    if (!selected || this.disposed) return;
    await this.saveDestination(selected);
  }

  private async saveDestination(destination: FeishuDestinationSelection): Promise<void> {
    if (this.destinationSaving) return;
    const previous = this.currentDestination();
    if (feishuDestinationIdentity(previous) === feishuDestinationIdentity(destination)) return;
    this.destinationSaving = true;
    this.error = null;
    this.requestRender();
    try {
      const settings = this.options.getSettings();
      applyFeishuDestination(settings, destination);
      await this.options.saveSettings();
      new Notice(`飞书新文档将保存到“${feishuDestinationLabel(destination)}”。`);
    } catch (error) {
      const settings = this.options.getSettings();
      applyFeishuDestination(settings, previous);
      this.error = userFacingErrorMessage(error, '保存飞书位置失败。');
      new Notice(this.error, 0);
    } finally {
      this.destinationSaving = false;
      this.requestRender();
      this.drainPendingRefresh();
    }
  }

  private handleAuthError(error: unknown, fallback: string): void {
    this.authAttemptId = null;
    const larkError = error instanceof LarkCliError ? error : null;
    this.error = userFacingErrorMessage(error, fallback);
    this.consoleUrl = larkError?.consoleUrl ?? null;
    this.authProgress = {
      phase: 'failed',
      message: this.error,
      ...(this.consoleUrl ? { consoleUrl: this.consoleUrl } : {}),
    };
    this.requestRender();
    this.drainPendingRefresh();
  }

  private isAuthFlowVisible(): boolean {
    const phase = this.authProgress?.phase;
    return Boolean(phase && !['idle', 'success'].includes(phase));
  }

  private openExternal(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }

  private async checkConnection(): Promise<void> {
    if (this.isBusy()) return;
    await this.refresh('connection');
    if (this.lastConnectionCheckSucceeded && this.connection?.connected) {
      new Notice('飞书连接正常。');
    }
  }

  private drainPendingRefresh(): void {
    if (this.disposed || !this.pendingRefresh || this.isBusy()) return;
    const mode: FeishuPanelRefreshMode = this.pendingConnectionCheck
      ? 'connection'
      : 'content';
    this.pendingRefresh = false;
    this.pendingConnectionCheck = false;
    if (this.pendingRefreshTimer !== null) window.clearTimeout(this.pendingRefreshTimer);
    this.pendingRefreshTimer = window.setTimeout(() => {
      this.pendingRefreshTimer = null;
      if (!this.disposed) void this.refresh(mode);
    }, 0);
  }

  private isCurrentAuthEpoch(epoch: number): boolean {
    return !this.disposed && epoch === this.authEpoch;
  }

  private handleConnectionCheckResult(connection: FeishuConnectionState): void {
    this.authProgress = null;
    if (connection.status !== 'error') {
      if (this.lastLoggedConnectionFailure && connection.connected) {
        appendLocalLog('feishu_connection_recovered', { status: connection.status });
      }
      this.lastLoggedConnectionFailure = null;
      return;
    }

    const failureKey = `${connection.status}:${connection.message ?? ''}`;
    if (failureKey !== this.lastLoggedConnectionFailure) {
      appendLocalLog('feishu_connection_check_failed', {
        status: connection.status,
        message: connection.message || '检测飞书连接失败',
      });
      this.lastLoggedConnectionFailure = failureKey;
    }
  }
}
