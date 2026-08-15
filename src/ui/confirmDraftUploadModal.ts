import { App, Modal, setIcon } from 'obsidian';

export interface DraftUploadConfirmation {
  title: string;
  transportLabel: string;
  accountLabel: string;
  relayHost: string;
  imageCount: number;
  compressedImageCount: number;
  warningCount: number;
  warnings: string[];
}

class DraftUploadConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly summary: DraftUploadConfirmation,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('ailu-confirm-modal');
    const { contentEl } = this;
    contentEl.empty();
    const eyebrow = contentEl.createDiv({ cls: 'ailu-confirm-eyebrow' });
    const icon = eyebrow.createSpan();
    setIcon(icon, 'shield-check');
    eyebrow.createSpan({ text: '最后确认' });
    contentEl.createEl('h2', { text: '上传到公众号草稿箱？' });
    contentEl.createEl('p', {
      cls: 'ailu-confirm-lead',
      text: '这一步会上传封面和正文图片，并创建一篇公众号草稿；不会群发或正式发布。',
    });

    const facts = contentEl.createDiv({ cls: 'ailu-confirm-facts' });
    this.renderFact(facts, '文章', this.summary.title || '未命名文章');
    this.renderFact(facts, '公众号 AppID', this.summary.accountLabel);
    this.renderFact(facts, '中转目标', this.summary.relayHost);
    this.renderFact(facts, '通道', this.summary.transportLabel);
    this.renderFact(facts, '正文图片', `${this.summary.imageCount} 张`);
    this.renderFact(facts, '需要压缩', `${this.summary.compressedImageCount} 张`);
    this.renderFact(facts, '待确认提醒', `${this.summary.warningCount} 项`);

    if (this.summary.warnings.length) {
      const warning = contentEl.createDiv({ cls: 'ailu-confirm-warning' });
      const warningIcon = warning.createSpan();
      setIcon(warningIcon, 'circle-alert');
      warning.createSpan({ text: this.summary.warnings.join('；') });
    }

    const actions = contentEl.createDiv({ cls: 'ailu-confirm-actions' });
    const cancel = actions.createEl('button', { text: '返回检查', attr: { type: 'button' } });
    cancel.onclick = () => this.finish(false);
    const confirm = actions.createEl('button', {
      cls: 'mod-cta',
      text: '确认上传草稿',
      attr: { type: 'button' },
    });
    confirm.onclick = () => this.finish(true);
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.settled) this.settle(false);
  }

  private renderFact(parent: HTMLElement, label: string, value: string): void {
    const row = parent.createDiv();
    row.createSpan({ text: label });
    row.createEl('strong', { text: value });
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(confirmed);
    this.close();
  }
}

export function confirmDraftUpload(
  app: App,
  summary: DraftUploadConfirmation,
): Promise<boolean> {
  return new Promise(resolve => new DraftUploadConfirmModal(app, summary, resolve).open());
}
