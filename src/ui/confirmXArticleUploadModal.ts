import { App, Modal, setIcon } from 'obsidian';

export interface XArticleUploadConfirmation {
  title: string;
  coverIncluded: boolean;
  bodyImageCount: number;
  tableCount: number;
  warningCount: number;
  headedBrowser: boolean;
}

class XArticleUploadConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly summary: XArticleUploadConfirmation,
    private readonly settle: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass('ailu-confirm-modal', 'ailu-x-confirm-modal');
    const { contentEl } = this;
    contentEl.empty();

    const eyebrow = contentEl.createDiv({ cls: 'ailu-confirm-eyebrow' });
    const icon = eyebrow.createSpan();
    setIcon(icon, 'shield-check');
    eyebrow.createSpan({ text: '最后确认' });

    contentEl.createEl('h2', { text: '创建 X Article 草稿？' });
    contentEl.createEl('p', {
      cls: 'ailu-confirm-lead',
      text: '这一步会在独立浏览器中打开 X、填写文章并等待自动保存；只创建草稿，绝不会点击最终发布。',
    });

    const facts = contentEl.createDiv({ cls: 'ailu-confirm-facts' });
    this.renderFact(facts, '文章', this.summary.title || '未命名文章');
    this.renderFact(facts, '封面', this.summary.coverIncluded ? '将上传 1 张（单独，不占正文名额）' : '未设置，草稿创建后补充');
    this.renderFact(facts, '正文图片', `${this.summary.bodyImageCount}/25 张`);
    this.renderFact(facts, '原生表格', `${this.summary.tableCount} 个`);
    this.renderFact(
      facts,
      '浏览器',
      this.summary.headedBrowser ? '显示独立浏览器窗口' : '独立后台浏览器',
    );
    this.renderFact(facts, '待确认提醒', `${this.summary.warningCount} 项`);

    const boundary = contentEl.createDiv({ cls: 'ailu-x-confirm-boundary' });
    const boundaryIcon = boundary.createSpan();
    setIcon(boundaryIcon, 'circle-alert');
    boundary.createSpan({
      text: '若草稿 URL 已生成后流程失败，工作台会保留链接并要求人工核对，不会自动重试或删除。',
    });

    const actions = contentEl.createDiv({ cls: 'ailu-confirm-actions' });
    const cancel = actions.createEl('button', {
      text: '返回检查',
      attr: { type: 'button' },
    });
    cancel.onclick = () => this.finish(false);
    const confirm = actions.createEl('button', {
      cls: 'mod-cta',
      text: '确认创建草稿',
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

export function confirmXArticleUpload(
  app: App,
  summary: XArticleUploadConfirmation,
): Promise<boolean> {
  return new Promise(resolve => new XArticleUploadConfirmModal(app, summary, resolve).open());
}
