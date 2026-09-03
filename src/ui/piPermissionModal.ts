import { App, Modal, Setting, setIcon } from 'obsidian';

import type { PiPermissionDecision } from '../types';

const PI_CATEGORY_LABELS: Record<string, string> = {
  bash: '命令执行',
  powershell: '命令执行',
  edit: '文件编辑',
  write: '文件写入',
  custom: '自定义或未知工具',
};

export interface PiPermissionPrompt {
  toolName: string;
  category: string;
  detail: string;
}

/**
 * Deterministic approval surface for one Pi tool call: the user can allow
 * once, allow the same category for this turn, or deny. Dismissing the modal
 * (Escape, click-away, close) denies without blocking the conversation.
 */
export class PiPermissionModal extends Modal {
  private decided = false;

  constructor(
    app: App,
    private readonly prompt: PiPermissionPrompt,
    private readonly onDecision: (decision: PiPermissionDecision) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('Pi 请求执行工具');
    const categoryLabel = PI_CATEGORY_LABELS[this.prompt.category] ?? this.prompt.category;
    const header = this.contentEl.createDiv({ cls: 'ailu-permission-header' });
    const icon = header.createSpan({ cls: 'ailu-permission-icon' });
    setIcon(icon, 'shield-question');
    header.createDiv({
      cls: 'ailu-permission-tool',
      text: `${this.prompt.toolName} · ${categoryLabel}`,
    });
    const detail = this.prompt.detail.trim();
    if (detail) {
      const code = this.contentEl.createEl('pre', { cls: 'ailu-permission-detail' });
      code.setText(detail.slice(0, 400));
    } else {
      this.contentEl.createDiv({
        cls: 'ailu-permission-detail-empty',
        text: '该工具未提供可显示的参数。',
      });
    }
    this.contentEl.createDiv({
      cls: 'ailu-permission-note',
      text: '拒绝后 Pi 会收到一条说明并继续对话；"本次允许同类"仅对当前回合的同类工具生效。',
    });

    const actions = this.contentEl.createDiv({ cls: 'ailu-permission-actions' });
    new Setting(actions)
      .addButton(button => button
        .setButtonText('拒绝')
        .setCta()
        .onClick(() => this.decide('deny')));
    new Setting(actions)
      .addButton(button => button
        .setButtonText('允许一次')
        .onClick(() => this.decide('allow-once')));
    new Setting(actions)
      .addButton(button => button
        .setButtonText(`本次允许同类（${categoryLabel}）`)
        .onClick(() => this.decide('allow-turn')));
  }

  override onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.onDecision('dismissed');
    }
    this.contentEl.empty();
  }

  private decide(decision: PiPermissionDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.onDecision(decision);
    this.close();
  }
}
