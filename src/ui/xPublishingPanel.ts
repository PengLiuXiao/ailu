import {
  App,
  Component,
  FileSystemAdapter,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  setIcon,
  TFile,
} from 'obsidian';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

import { xCookiesPath } from '../paths';
import {
  buildPublishingPreviewStats,
  publishingImageTargetsMatch,
  type PublishingPreviewStats,
} from '../publishing/previewStats';
import { appendLocalLog } from '../storage/localLog';
import type { AiluSettings } from '../types';
import {
  rawErrorMessage,
  userFacingErrorMessage,
  userFacingErrorText,
} from '../utils/userFacingError';
import { remapXArticleDom } from '../xArticle/domMapper';
import { enhanceXArticlePreview } from '../xArticle/enhancements';
import {
  buildXArticlePreviewDocument,
  buildXArticleHero,
  type XArticleHero,
} from '../xArticle/preview';
import {
  inspectXArticleCoverSources,
  prepareXArticleMarkdown,
} from '../xArticle/prepareMarkdown';
import {
  discoverXArticleSkill,
  shouldAutoOpenXArticleDraft,
  XArticleLocalUploader,
} from '../xArticle/localUploader';
import { presentXArticlePreflightIssue } from '../xArticle/issuePresentation';
import {
  XArticleUploadTaskCoordinator,
  type XArticleUploadTaskSnapshot,
} from '../xArticle/uploadTaskCoordinator';
import type {
  PreparedXArticleMarkdown,
  XArticleImageReference,
  XArticlePreflight,
  XArticleUploadOutcome,
} from '../xArticle/types';
import { confirmXArticleUpload } from './confirmXArticleUploadModal';
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

export interface RenderedXPublishingPreview {
  article: HTMLElement;
  sourceLineMap: readonly number[];
  viewport: HTMLElement;
}

interface XPublishingPanelOptions {
  app: App;
  component: Component;
  file: TFile;
  getSettings: () => AiluSettings;
  requestRender: () => void;
  uploadTasks: XArticleUploadTaskCoordinator;
  authorizeCookieMutation: () => Promise<void>;
  exportXCookiesFromChrome: () => Promise<{ cookieCount: number }>;
  ensureCookiesForUpload: (allowExport: boolean) => Promise<{ cookieCount: number }>;
}

interface XSourceSnapshot {
  frontmatter: Record<string, unknown> | null;
  hero: XArticleHero;
  markdown: string;
  previewMarkdown: string;
  sourceLineMap: number[];
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
  return button;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function xUploadSettingsFingerprint(settings: AiluSettings['xPublishing']): string {
  return JSON.stringify({
    pythonCommand: settings.pythonCommand,
    uploadScriptPath: settings.uploadScriptPath,
    autoExportCookiesWhenMissing: settings.autoExportCookiesWhenMissing,
    headed: settings.headed,
    openDraftAfterSuccess: settings.openDraftAfterSuccess,
  });
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

interface LocalImageDescriptor {
  extension: 'png' | 'jpg' | 'gif' | 'webp';
  sha256: string;
  size: number;
}

function inspectLocalImage(filePath: string): LocalImageDescriptor | null {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 20 * 1024 * 1024) return null;
  const content = fs.readFileSync(filePath);
  const bytes = content.subarray(0, 12);
  const length = bytes.length;
  const ascii = (start: number, count: number) => bytes.subarray(start, start + count).toString('ascii');
  let extension: LocalImageDescriptor['extension'] | null = null;
  if (length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    extension = 'png';
  } else if (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    extension = 'jpg';
  } else if (length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) {
    extension = 'gif';
  } else if (length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    extension = 'webp';
  }
  return extension ? {
    extension,
    sha256: createHash('sha256').update(content).digest('hex'),
    size: stat.size,
  } : null;
}

export class XPublishingPanel {
  private disposed = false;
  private loaded = false;
  private loading = false;
  private pendingRefresh = false;
  private loadVersion = 0;
  private operation: 'preflight' | 'exporting-cookies' | 'uploading' | null = null;
  private progressLabel = '';
  private source: XSourceSnapshot | null = null;
  private error: string | null = null;
  private draftUrl: string | null = null;
  private resultMessage = '';
  private resultTitle = '';
  private resultKind: 'success' | 'warning' | null = null;
  private preflight: XArticlePreflight | null = null;
  private prepared: PreparedXArticleMarkdown | null = null;
  private activeUploader: XArticleLocalUploader | null = null;
  private operationController: AbortController | null = null;
  private runtimeError: string | null = null;
  private attentionRequired = false;
  private taskUnsubscribe: (() => void) | null = null;

  constructor(private readonly options: XPublishingPanelOptions) {
    this.taskUnsubscribe = options.uploadTasks.subscribe(() => this.handleUploadTaskChange());
    this.hydrateUploadTask(options.uploadTasks.snapshot());
  }

  activate(): void {
    if (!this.loaded && !this.loading) void this.load();
  }

  async refresh(): Promise<void> {
    if (this.isBusy()) {
      this.pendingRefresh = true;
      return;
    }
    await this.load();
  }

  isBusy(): boolean {
    return this.loading
      || Boolean(this.operation)
      || Boolean(this.options.uploadTasks.snapshot())
      || this.attentionRequired;
  }

  activity(): PublishingTargetActivity {
    const task = this.options.uploadTasks.snapshot();
    if (task?.status === 'running') {
      return runningPublishingTargetActivity(
        task.sourcePath === this.options.file.path ? '正在创建草稿' : '另一篇草稿正在创建',
      );
    }
    if (task) return attentionPublishingTargetActivity('草稿待核对');
    if (this.operation === 'preflight') return runningPublishingTargetActivity('正在检查草稿');
    if (this.operation === 'exporting-cookies') return runningPublishingTargetActivity('正在刷新登录');
    if (this.operation === 'uploading') return runningPublishingTargetActivity('正在创建草稿');
    if (this.loading) return runningPublishingTargetActivity('正在准备预览');
    if (this.attentionRequired) return attentionPublishingTargetActivity('草稿待核对');
    if (this.runtimeError || this.error || this.resultKind === 'warning') {
      return attentionPublishingTargetActivity('需要检查');
    }
    return IDLE_PUBLISHING_TARGET_ACTIVITY;
  }

  dispose(): void {
    this.disposed = true;
    this.loadVersion += 1;
    this.taskUnsubscribe?.();
    this.taskUnsubscribe = null;
    // Confirmed uploads are owned by the plugin-level coordinator. Disposing
    // this view only stops panel-local preflight or cookie work.
    this.operationController?.abort();
    this.activeUploader?.cancel();
  }

  async render(parent: HTMLElement): Promise<RenderedXPublishingPreview | null> {
    this.renderMeta(parent);
    const viewport = parent.createDiv({
      cls: 'ailu-publishing-scroll ailu-x-publishing-scroll',
    });
    const surface = viewport.createDiv({ cls: 'ailu-x-publishing-surface' });
    this.refreshRuntimeState();
    this.renderOperation(surface);
    this.renderPreflight(surface);
    this.renderResult(surface);

    if (this.loading || !this.loaded) {
      this.renderState(surface, 'loader-circle', '正在准备 X 预览', '读取当前 Markdown 与本地图片。');
      this.renderActions(parent, false);
      return null;
    }
    if (this.error) {
      this.renderState(surface, 'triangle-alert', 'X 预览生成失败', this.error);
      this.renderActions(parent, false);
      return null;
    }
    if (!this.source) {
      this.renderState(surface, 'file-warning', '没有可预览内容', '请检查当前笔记是否可读。');
      this.renderActions(parent, false);
      return null;
    }

    this.renderHero(surface, this.source.hero);
    const card = surface.createDiv({ cls: 'ailu-x-card' });
    const article = card.createDiv({
      cls: 'ailu-publishing-article ailu-x-preview-body markdown-rendered',
    });
    await MarkdownRenderer.render(
      this.options.app,
      instrumentPublishingMarkdown(this.source.previewMarkdown, this.source.sourceLineMap),
      article,
      this.options.file.path,
      this.options.component,
    );
    if (this.disposed || !article.isConnected) return null;
    materializePublishingSourceMarkers(article);
    remapXArticleDom(article);
    enhanceXArticlePreview(article);
    this.renderActions(parent, true);
    return { article, sourceLineMap: this.source.sourceLineMap, viewport };
  }

  private async load(): Promise<void> {
    const version = ++this.loadVersion;
    this.loading = true;
    this.error = null;
    this.options.requestRender();
    try {
      const markdown = await this.readCurrentMarkdown();
      if (this.disposed || version !== this.loadVersion) return;
      const frontmatter = this.readFrontmatter();
      const settings = this.options.getSettings().xPublishing;
      const preview = buildXArticlePreviewDocument(markdown, {
        filename: this.options.file.name,
        stripFrontmatter: settings.previewStripFrontmatter,
        useFilenameAsTitle: settings.previewUseFilenameTitle,
      });
      this.source = {
        markdown,
        previewMarkdown: preview.markdown,
        sourceLineMap: preview.sourceLineMap,
        frontmatter,
        hero: buildXArticleHero(preview.markdown, {
          filename: this.options.file.name,
          frontmatter,
          fallbackSummary: 'X Article 本地草稿预览',
        }),
      };
      this.prepared = null;
      this.preflight = null;
      this.error = null;
    } catch (error) {
      if (this.disposed || version !== this.loadVersion) return;
      this.source = null;
      this.error = userFacingErrorMessage(error, '无法读取当前 Markdown。');
    } finally {
      if (!this.disposed && version === this.loadVersion) {
        this.loaded = true;
        this.loading = false;
        this.hydrateUploadTask(this.options.uploadTasks.snapshot());
        if (this.pendingRefresh) {
          this.pendingRefresh = false;
          void this.load();
        } else {
          this.options.requestRender();
        }
      }
    }
  }

  private async readCurrentMarkdown(): Promise<string> {
    const matching = this.options.app.workspace.getLeavesOfType('markdown')
      .find(leaf => leaf.view instanceof MarkdownView
        && leaf.view.file?.path === this.options.file.path);
    if (matching?.view instanceof MarkdownView) return matching.view.editor.getValue();
    return this.options.app.vault.cachedRead(this.options.file);
  }

  private readFrontmatter(): Record<string, unknown> | null {
    const value = this.options.app.metadataCache.getFileCache(this.options.file)?.frontmatter;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  }

  private renderMeta(parent: HTMLElement): void {
    const stats = this.currentPreviewStats();
    const meta = parent.createDiv({ cls: 'ailu-publishing-meta' });
    meta.createEl('strong', {
      text: this.source?.hero.title || this.options.file.basename || '未命名文章',
    });
    meta.createSpan({
      text: `正文图 ${stats.bodyImageCount} 张`,
      attr: { title: '按正文中实际出现次数统计，不含封面' },
    });
    meta.createSpan({
      text: stats.coverImageCount ? '封面 1 张' : '未设置封面',
      attr: { title: '封面单独计算，不占 X 正文图片名额' },
    });
    meta.createSpan({
      text: `正文 ${stats.visibleTextLength.toLocaleString()} 字`,
      attr: { title: '不计 YAML、Markdown 标记、图片地址和排版空白' },
    });
    const uploadTask = this.options.uploadTasks.snapshot();
    if (uploadTask?.status === 'running') {
      meta.createSpan({
        text: uploadTask.sourcePath === this.options.file.path
          ? uploadTask.progressLabel || '正在创建草稿'
          : '另一篇 X 草稿正在后台创建',
      });
    } else if (this.operation) {
      meta.createSpan({ text: this.progressLabel || '处理中' });
    } else if (this.error) {
      meta.createSpan({ cls: 'has-warning', text: '需要处理' });
    } else if (this.source) {
      meta.createSpan({ cls: 'is-ready', text: '本地预览' });
    }
  }

  private currentPreviewStats(): PublishingPreviewStats {
    const source = this.source;
    if (!source) {
      return { bodyImageCount: 0, coverImageCount: 0, visibleTextLength: 0 };
    }
    const coverSources = inspectXArticleCoverSources(source.markdown);
    const leadingIsConfiguredCover = Boolean(
      coverSources.leadingTarget
      && coverSources.configuredTarget
      && this.samePreviewImageTarget(coverSources.leadingTarget, coverSources.configuredTarget),
    );
    const stats = buildPublishingPreviewStats(source.previewMarkdown, {
      bodyCoverTarget: coverSources.leadingTarget
        && (!coverSources.configuredTarget || leadingIsConfiguredCover)
        ? coverSources.leadingTarget
        : null,
      hasCover: Boolean(coverSources.configuredTarget || coverSources.leadingTarget),
      title: source.hero.title,
    });
    return this.preflight
      ? {
          ...stats,
          bodyImageCount: this.preflight.expectedBodyImages,
          coverImageCount: this.preflight.coverUpload ? 1 : 0,
        }
      : stats;
  }

  private samePreviewImageTarget(left: string, right: string): boolean {
    if (publishingImageTargetsMatch(left, right)) return true;
    const leftUrl = this.resolvePreviewImage(left);
    const rightUrl = this.resolvePreviewImage(right);
    return Boolean(leftUrl && rightUrl && leftUrl === rightUrl);
  }

  private refreshRuntimeState(): void {
    try {
      const settings = this.options.getSettings().xPublishing;
      discoverXArticleSkill({ uploadScriptPath: settings.uploadScriptPath });
      this.runtimeError = null;
    } catch (error) {
      this.runtimeError = userFacingErrorMessage(error, '未找到当前 X Article Skill。');
    }
  }

  private renderOperation(parent: HTMLElement): void {
    const uploadTask = this.options.uploadTasks.snapshot();
    if (!this.operation && uploadTask?.status !== 'running') return;
    const progress = parent.createDiv({ cls: 'ailu-x-progress', attr: { 'aria-live': 'polite' } });
    progress.createEl('strong', {
      text: uploadTask?.status === 'running'
        ? uploadTask.sourcePath === this.options.file.path
          ? '正在后台创建并核验 X 草稿'
          : '另一篇文章正在后台创建 X 草稿'
        : this.operation === 'preflight'
        ? '正在执行本地预检'
        : this.operation === 'exporting-cookies'
          ? '正在准备 X 登录凭据'
          : '正在创建并核验 X 草稿',
    });
    progress.createSpan({
      text: uploadTask?.status === 'running'
        ? uploadTask.progressLabel || '切换到对话或其他草稿目标不会中断任务。'
        : this.progressLabel || '请保持 Obsidian 打开。',
    });
  }

  private renderResult(parent: HTMLElement): void {
    if (!this.resultKind || !this.resultMessage) return;
    const card = parent.createDiv({
      cls: `ailu-x-result-card is-${this.resultKind}`,
    });
    card.createEl('strong', {
      text: this.resultTitle || (this.resultKind === 'success' ? 'X 草稿已创建并核验' : '需要处理'),
    });
    card.createSpan({ text: this.resultMessage });
  }

  private renderPreflight(parent: HTMLElement): void {
    const preflight = this.preflight;
    if (!preflight) return;
    const blocked = preflight.errors.length > 0;
    const card = parent.createDiv({
      cls: `ailu-x-result-card is-${blocked ? 'warning' : 'success'}`,
    });
    const primaryIssue = blocked
      ? presentXArticlePreflightIssue(preflight, preflight.errors[0])
      : null;
    card.createEl('strong', {
      text: primaryIssue?.title ?? 'X 草稿预检通过',
    });
    const cover = preflight.coverUpload ? '1 张封面（单独）' : '未设置封面';
    const summary = `${cover} · 正文图 ${preflight.expectedBodyImages}/25 · ${preflight.expectedTables} 个原生表格`;
    if (blocked) {
      card.createSpan({ text: primaryIssue?.message ?? '' });
      for (const issue of preflight.errors.slice(1)) {
        const presentation = presentXArticlePreflightIssue(preflight, issue);
        card.createSpan({ text: `另一个问题：${presentation.title}。${presentation.message}` });
      }
      card.createSpan({ text: `当前内容：${summary}` });
    } else if (preflight.warnings.length) {
      card.createSpan({ text: summary });
      card.createSpan({ text: `${preflight.warnings.length} 项提醒会在最终确认中再次显示。` });
    } else {
      card.createSpan({ text: summary });
    }
  }

  private renderHero(parent: HTMLElement, hero: XArticleHero): void {
    const card = parent.createDiv({ cls: 'ailu-x-hero' });
    const cover = card.createDiv({ cls: 'ailu-x-hero-cover' });
    const coverUrl = this.resolvePreviewImage(hero.cover);
    cover.toggleClass('has-image', Boolean(coverUrl));
    if (coverUrl) cover.style.setProperty('--ailu-x-cover-image', `url("${coverUrl.replace(/"/g, '%22')}")`);
    cover.createDiv({ cls: 'ailu-x-hero-badge', text: 'X Article · 5:2' });
    const body = card.createDiv({ cls: 'ailu-x-hero-body' });
    body.createDiv({ cls: 'ailu-x-hero-title', text: hero.title || this.options.file.basename });
    body.createDiv({ cls: 'ailu-x-hero-summary', text: hero.summary || '尚未提取到正文摘要。' });
  }

  private resolvePreviewImage(target: string | null): string | null {
    if (!target) return null;
    const trimmed = target.trim();
    if (!trimmed || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(trimmed)) return null;
    const normalized = trimmed.replace(/^\.\//, '');
    const linked = this.options.app.metadataCache
      .getFirstLinkpathDest(normalized, this.options.file.path);
    return linked instanceof TFile
      ? this.options.app.vault.getResourcePath(linked)
      : null;
  }

  private renderState(
    parent: HTMLElement,
    iconName: string,
    title: string,
    message: string,
  ): void {
    const card = parent.createDiv({ cls: 'ailu-x-state-card' });
    const icon = card.createSpan();
    setIcon(icon, iconName);
    card.createEl('strong', { text: title });
    card.createSpan({ text: message });
  }

  private renderActions(parent: HTMLElement, ready: boolean): void {
    const actions = parent.createDiv({ cls: 'ailu-publishing-actions ailu-x-actions' });
    const uploadTask = this.options.uploadTasks.snapshot();
    if (this.attentionRequired) {
      if (this.draftUrl) {
        const open = createIconButton(actions, '打开待核对草稿', 'external-link');
        open.onclick = () => this.openExternal(this.draftUrl!);
      }
      const acknowledge = createIconButton(
        actions,
        this.draftUrl ? '我已记录链接，继续' : '知道了，继续',
        'check-check',
        'mod-cta',
      );
      acknowledge.onclick = () => this.acknowledgeDraft();
      return;
    }
    if (this.draftUrl) {
      const open = createIconButton(actions, '打开草稿', 'external-link');
      open.onclick = () => this.openExternal(this.draftUrl!);
    } else {
      const refreshLogin = createIconButton(actions, '刷新 X 登录', 'key-round');
      refreshLogin.disabled = Boolean(this.operation) || Boolean(uploadTask) || Boolean(this.runtimeError);
      refreshLogin.onclick = () => void this.exportCookies();
    }
    const preflight = createIconButton(actions, '检查草稿', 'scan-search');
    preflight.disabled = !ready || Boolean(this.operation) || Boolean(uploadTask) || Boolean(this.runtimeError);
    preflight.onclick = () => void this.runPreflight();
    const publish = createIconButton(
      actions,
      uploadTask?.status === 'running' || this.operation === 'uploading'
        ? '正在创建草稿…'
        : '创建 X 草稿',
      'send',
      'mod-cta',
    );
    publish.disabled = !ready || Boolean(this.operation) || Boolean(uploadTask) || Boolean(this.runtimeError);
    publish.onclick = () => void this.publish();
  }

  private async runPreflight(): Promise<void> {
    if (this.operation || this.options.uploadTasks.snapshot()) return;
    this.operation = 'preflight';
    this.progressLabel = '正在生成不修改原文的上传副本…';
    this.resultKind = null;
    this.resultMessage = '';
    this.resultTitle = '';
    const controller = new AbortController();
    this.operationController = controller;
    this.options.requestRender();
    try {
      const uploadSettings = { ...this.options.getSettings().xPublishing };
      const settingsFingerprint = xUploadSettingsFingerprint(uploadSettings);
      const uploader = this.createUploader(uploadSettings);
      this.activeUploader = uploader;
      const prepared = await this.prepareCurrent(controller.signal);
      await this.assertIntentCurrent(prepared, settingsFingerprint, controller.signal);
      const preflight = await uploader.preflight(prepared, {
        signal: controller.signal,
        onProgress: progress => this.handleProgress(progress.message),
      });
      await this.assertIntentCurrent(prepared, settingsFingerprint, controller.signal);
      this.prepared = prepared;
      this.preflight = preflight;
      appendLocalLog('x_article_preflight_completed', {
        sourceHash: prepared.sourceContentHash.slice(0, 12),
        mediaCount: preflight.totalMedia,
        bodyImageCount: preflight.expectedBodyImages,
        coverIncluded: preflight.coverUpload,
        tableCount: preflight.expectedTables,
        warningCount: preflight.warnings.length,
        errorCount: preflight.errors.length,
      });
      if (preflight.errors.length) {
        const issue = presentXArticlePreflightIssue(preflight, preflight.errors[0]);
        new Notice(`X 草稿暂不能创建：${issue.title}。未打开 X。`);
      } else {
        new Notice(`X 草稿预检通过：正文图 ${preflight.expectedBodyImages}/25，封面单独，${preflight.expectedTables} 个表格。`);
      }
    } catch (error) {
      this.prepared = null;
      this.preflight = null;
      const diagnostic = rawErrorMessage(error);
      const message = userFacingErrorMessage(error, 'X 草稿上传前检查失败，请重试。');
      appendLocalLog('x_article_preflight_failed', { error: diagnostic, userMessage: message });
      new Notice(message);
    } finally {
      this.finishOperation();
    }
  }

  private async publish(): Promise<void> {
    if (this.operation || this.options.uploadTasks.snapshot()) return;
    this.operation = 'preflight';
    this.progressLabel = '上传前重新执行完整预检…';
    this.resultKind = null;
    this.resultMessage = '';
    this.resultTitle = '';
    const controller = new AbortController();
    this.operationController = controller;
    this.options.requestRender();
    try {
      const uploadSettings = { ...this.options.getSettings().xPublishing };
      const settingsFingerprint = xUploadSettingsFingerprint(uploadSettings);
      const uploader = this.createUploader(uploadSettings);
      this.activeUploader = uploader;
      const prepared = await this.prepareCurrent(controller.signal);
      await this.assertIntentCurrent(prepared, settingsFingerprint, controller.signal);
      const preflight = await uploader.preflight(prepared, {
        signal: controller.signal,
        onProgress: progress => this.handleProgress(progress.message),
      });
      this.prepared = prepared;
      this.preflight = preflight;
      if (preflight.errors.length) {
        const issue = presentXArticlePreflightIssue(preflight, preflight.errors[0]);
        new Notice(`X 草稿暂不能创建：${issue.title}。未打开 X。`);
        return;
      }
      this.progressLabel = '等待你确认是否打开 X 并创建草稿…';
      this.options.requestRender();
      const confirmed = await confirmXArticleUpload(this.options.app, {
        title: preflight.title,
        coverIncluded: preflight.coverUpload,
        bodyImageCount: preflight.expectedBodyImages,
        tableCount: preflight.expectedTables,
        warningCount: preflight.warnings.length + (preflight.coverMissing ? 1 : 0),
        headedBrowser: uploadSettings.headed,
      });
      if (!confirmed) return;
      await this.assertIntentCurrent(prepared, settingsFingerprint, controller.signal);

      this.progressLabel = '正在验证 X 登录态…';
      this.options.requestRender();
      await this.options.ensureCookiesForUpload(uploadSettings.autoExportCookiesWhenMissing);
      await this.assertIntentCurrent(prepared, settingsFingerprint, controller.signal);

      this.operation = 'uploading';
      this.progressLabel = '正在启动独立 Playwright 浏览器…';
      this.options.requestRender();
      appendLocalLog('x_article_upload_started', {
        sourceHash: prepared.sourceContentHash.slice(0, 12),
        mediaCount: preflight.totalMedia,
        bodyImageCount: preflight.expectedBodyImages,
        coverIncluded: preflight.coverUpload,
        tableCount: preflight.expectedTables,
        headed: uploadSettings.headed,
      });
      // From this point forward the mutation belongs to the plugin-level task
      // coordinator. The Draft view may be replaced by Chat without aborting
      // the already-confirmed browser operation.
      this.operationController = null;
      this.activeUploader = null;
      const task = this.options.uploadTasks.start({
        sourcePath: this.options.file.path,
        sourceHash: prepared.sourceContentHash,
        run: (signal, onProgress) => uploader.upload(prepared, {
          preflight,
          signal,
          onProgress,
        }),
      });
      const outcome = await task.completion;
      this.applyOutcome(outcome);
    } catch (error) {
      const diagnostic = rawErrorMessage(error);
      const message = userFacingErrorMessage(error, 'X 草稿创建失败，请稍后重试。');
      this.resultKind = 'warning';
      this.resultTitle = '草稿未创建';
      this.resultMessage = message;
      this.attentionRequired = Boolean(this.options.uploadTasks.snapshot());
      appendLocalLog('x_article_upload_failed_before_result', { error: diagnostic, userMessage: message });
      new Notice(message);
    } finally {
      this.finishOperation();
    }
  }

  private async exportCookies(): Promise<void> {
    if (this.operation) return;
    this.operation = 'exporting-cookies';
    const controller = new AbortController();
    this.operationController = controller;
    this.progressLabel = 'macOS 可能会要求你授权 Chrome Safe Storage…';
    this.options.requestRender();
    try {
      const status = await this.options.exportXCookiesFromChrome();
      appendLocalLog('x_article_cookies_refreshed', { cookieCount: status.cookieCount });
      new Notice(`X 登录态已刷新并验证：${status.cookieCount} 个 Cookie。`);
    } catch (error) {
      const diagnostic = rawErrorMessage(error);
      const message = userFacingErrorMessage(error, 'X 登录态刷新失败，请重新授权。');
      appendLocalLog('x_article_cookies_refresh_failed', { error: diagnostic, userMessage: message });
      new Notice(message);
    } finally {
      this.finishOperation();
    }
  }

  private createUploader(
    settings: AiluSettings['xPublishing'] = this.options.getSettings().xPublishing,
  ): XArticleLocalUploader {
    return new XArticleLocalUploader({
      pythonCommand: settings.pythonCommand,
      uploadScriptPath: settings.uploadScriptPath,
      cookiesPath: xCookiesPath(),
      autoExportCookiesWhenMissing: false,
      headed: settings.headed,
      authorizeCookieMutation: this.options.authorizeCookieMutation,
    });
  }

  private async prepareCurrent(signal: AbortSignal): Promise<PreparedXArticleMarkdown> {
    this.throwIfStopped(signal);
    const source = this.source;
    if (!source) throw new Error('当前 X 预览尚未准备好。');
    const latest = await this.readCurrentMarkdown();
    if (latest !== source.markdown) {
      void this.load();
      throw new Error('文章刚刚发生变化，预览已刷新；请重新检查。');
    }
    this.throwIfStopped(signal);
    const stagedAssets = new Map<string, LocalImageDescriptor & { path: string }>();
    let stagingDirectoryPromise: Promise<string> | null = null;
    const stagingDirectory = (): Promise<string> => {
      stagingDirectoryPromise ??= fsp.mkdtemp(
        path.join(os.tmpdir(), 'ailu-x-article-assets-'),
      ).then(async directory => {
        await fsp.chmod(directory, 0o700);
        return directory;
      });
      return stagingDirectoryPromise;
    };
    const prepared = await prepareXArticleMarkdown({
      sourcePath: this.absoluteSourcePath(),
      markdown: latest,
      resolveImage: reference => this.stageUploadImage(
        reference,
        signal,
        stagedAssets,
        stagingDirectory,
      ),
      remoteImagePolicy: 'reject',
    });
    prepared.assetDigests = Array.from(stagedAssets.values(), asset => ({
      path: asset.path,
      sha256: asset.sha256,
      size: asset.size,
    }));
    this.throwIfStopped(signal);
    return prepared;
  }

  private async assertIntentCurrent(
    prepared: PreparedXArticleMarkdown,
    settingsFingerprint: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.throwIfStopped(signal);
    const latest = await this.readCurrentMarkdown();
    this.throwIfStopped(signal);
    if (sha256(latest) !== prepared.sourceContentHash) {
      void this.load();
      throw new Error('文章在确认期间发生变化，已停止创建草稿；请重新检查。');
    }
    if (xUploadSettingsFingerprint(this.options.getSettings().xPublishing) !== settingsFingerprint) {
      throw new Error('X 上传设置在确认期间发生变化，已停止创建草稿；请重新检查。');
    }
  }

  private absoluteSourcePath(): string {
    return path.join(this.vaultBasePath(), this.options.file.path);
  }

  private vaultBasePath(): string {
    const adapter = this.options.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('X Article 草稿只支持本机文件系统 Vault。');
    }
    return adapter.getBasePath();
  }

  private resolveVaultImage(reference: XArticleImageReference, signal: AbortSignal): string | null {
    this.throwIfStopped(signal);
    if (reference.remote) {
      throw new Error('X 草稿不会联网下载远程图片；请先把图片保存到当前 Vault。');
    }
    let candidate: string | null = null;
    if (path.isAbsolute(reference.target)) {
      candidate = reference.target;
    } else {
      const linked = this.options.app.metadataCache
        .getFirstLinkpathDest(reference.target, this.options.file.path);
      candidate = linked instanceof TFile
        ? path.join(this.vaultBasePath(), linked.path)
        : path.join(
          this.vaultBasePath(),
          this.options.file.parent?.path ?? '',
          reference.target,
        );
    }
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error('X 草稿不接受符号链接图片。');
      }
      const canonical = fs.realpathSync(candidate);
      const vault = fs.realpathSync(this.vaultBasePath());
      if (!isPathInside(vault, canonical)) {
        throw new Error('X 草稿只允许上传当前 Vault 内的图片。');
      }
      if (!inspectLocalImage(canonical)) {
        throw new Error('X 草稿图片必须是 20 MB 内的 PNG、JPEG、GIF 或 WebP 文件。');
      }
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('X 草稿')) throw error;
      return null;
    }
  }

  private async stageUploadImage(
    reference: XArticleImageReference,
    signal: AbortSignal,
    stagedAssets: Map<string, LocalImageDescriptor & { path: string }>,
    stagingDirectory: () => Promise<string>,
  ): Promise<string | null> {
    const source = this.resolveVaultImage(reference, signal);
    if (!source) return null;
    const existing = stagedAssets.get(source);
    if (existing) return existing.path;
    const sourceInfo = inspectLocalImage(source);
    if (!sourceInfo) throw new Error('X 草稿图片在准备期间发生变化。');
    const directory = await stagingDirectory();
    this.throwIfStopped(signal);
    const output = path.join(
      directory,
      `asset-${String(stagedAssets.size + 1).padStart(3, '0')}-${randomUUID()}.${sourceInfo.extension}`,
    );
    await fsp.copyFile(source, output, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(output, 0o600);
    this.throwIfStopped(signal);
    const stagedInfo = inspectLocalImage(output);
    if (!stagedInfo || stagedInfo.extension !== sourceInfo.extension) {
      throw new Error('X 草稿图片暂存副本校验失败。');
    }
    stagedAssets.set(source, { ...stagedInfo, path: output });
    return output;
  }

  private handleProgress(message: string): void {
    this.progressLabel = userFacingErrorText(message, '正在处理 X Article 草稿…');
    if (!this.disposed) this.options.requestRender();
  }

  private handleUploadTaskChange(): void {
    this.hydrateUploadTask(this.options.uploadTasks.snapshot());
    if (!this.disposed) this.options.requestRender();
  }

  private hydrateUploadTask(task: XArticleUploadTaskSnapshot | null): void {
    if (!task || task.sourcePath !== this.options.file.path) return;
    if (task.status === 'running') {
      this.progressLabel = task.progressLabel;
      return;
    }
    if (task.status === 'settled' && task.outcome) {
      this.applyOutcome(task.outcome, false);
      return;
    }
    if (task.status === 'failed') {
      this.resultKind = 'warning';
      this.resultTitle = 'X 草稿任务异常结束';
      this.resultMessage = userFacingErrorText(
        task.error,
        '后台上传任务异常结束，请查看本地诊断日志。',
      );
      this.attentionRequired = true;
    }
  }

  private applyOutcome(outcome: XArticleUploadOutcome, announce = true): void {
    this.preflight = outcome.preflight;
    this.draftUrl = outcome.draftUrl;
    const visibleMessage = userFacingErrorText(
      outcome.message,
      'X Article 草稿操作未完成，请查看本地诊断日志。',
    );
    this.resultMessage = visibleMessage;
    if (outcome.status === 'success') {
      this.attentionRequired = true;
      this.resultKind = 'success';
      this.resultTitle = 'X 草稿已创建并严格核验';
      if (announce) {
        appendLocalLog('x_article_upload_succeeded', {
          draftUrl: outcome.draftUrl,
          artifactsDirectory: outcome.artifacts.directory,
          mediaCount: outcome.result.mediaCount,
          tableCount: outcome.result.tableCount,
          coverUploaded: outcome.result.coverUploaded,
        });
        new Notice(visibleMessage);
        if (shouldAutoOpenXArticleDraft(
          outcome.status,
          this.options.getSettings().xPublishing.openDraftAfterSuccess,
        )) {
          this.openExternal(outcome.draftUrl);
        }
      }
      return;
    }
    this.resultKind = 'warning';
    this.attentionRequired = true;
    if (outcome.status === 'partial-draft') {
      this.resultTitle = '草稿可能已创建，请先人工核对';
      this.resultMessage = `${visibleMessage} 诊断日志：${outcome.artifacts.log}`;
      if (announce) {
        appendLocalLog('x_article_upload_partial_draft', {
          draftUrl: outcome.draftUrl,
          artifactsDirectory: outcome.artifacts.directory,
          diagnosticLog: outcome.artifacts.log,
          failureKind: outcome.failureKind,
          expectedMediaCount: outcome.preflight.totalMedia,
          expectedTableCount: outcome.preflight.expectedTables,
        });
        new Notice(`${visibleMessage} 已保留草稿链接；请从面板手动打开核对，勿直接重试。`, 0);
      }
      return;
    }
    this.resultTitle = outcome.status === 'cancelled'
      ? '操作已取消，未发现草稿 URL'
      : outcome.status === 'timed-out'
        ? '操作超时，未发现草稿 URL'
        : '草稿未创建';
    if (announce) {
      appendLocalLog('x_article_upload_failed', { status: outcome.status });
      new Notice(visibleMessage);
    }
  }

  private finishOperation(): void {
    this.activeUploader = null;
    this.operationController = null;
    this.operation = null;
    this.progressLabel = '';
    if (this.disposed) return;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      void this.load();
      return;
    }
    this.options.requestRender();
  }

  private acknowledgeDraft(): void {
    const draftUrl = this.draftUrl;
    const task = this.options.uploadTasks.snapshot();
    if (task?.sourcePath === this.options.file.path) {
      this.options.uploadTasks.acknowledge(task.taskId);
    }
    this.attentionRequired = false;
    appendLocalLog('x_article_draft_acknowledged', {
      draftUrl,
      sourcePath: this.options.file.path,
    });
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      void this.load();
      return;
    }
    this.options.requestRender();
  }

  private throwIfStopped(signal: AbortSignal): void {
    if (this.disposed || signal.aborted) throw new Error('X 草稿视图已关闭，操作已停止。');
  }

  private openExternal(url: string): void {
    const requireFn = (window as Window & { require?: (id: string) => unknown }).require;
    if (!requireFn) return;
    const electron = requireFn('electron') as {
      shell?: { openExternal: (target: string) => Promise<void> };
    };
    void electron.shell?.openExternal(url);
  }
}
