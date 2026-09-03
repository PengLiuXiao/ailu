import { App, Editor, MarkdownView, Modal, Notice, Plugin, Setting } from 'obsidian';

import type { AgentId, RuntimeTurnEvent, AiluSettings } from '../types';
import { getAgentDescriptor } from '../agents';
import { RuntimeManager } from '../runtime/runtimeManager';
import { getVaultBasePath } from '../utils/vault';
import { userFacingErrorText } from '../utils/userFacingError';
import { promptForText } from './textPromptModal';
import { buildInlineEditTurnInput } from './inlineEditTurn';

export async function runInlineEdit(
  plugin: Plugin,
  runtimeManager: RuntimeManager,
  getSettings: () => AiluSettings,
): Promise<void> {
  const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice('请先打开一篇 Markdown 笔记。');
    return;
  }
  const editor = view.editor;
  const selection = editor.getSelection();
  const cursor = editor.getCursor();
  const original = selection || editor.getLine(cursor.line);
  if (!original.trim()) {
    new Notice('请选中文字，或把光标放在有文字的行内。');
    return;
  }

  const instruction = await promptForText(plugin.app, {
    title: 'AI 行内修改',
    placeholder: '希望 AI 怎样修改这段文字？',
    initialValue: '在不改变原意的前提下，让表达更清晰。',
    submitLabel: '生成修改',
  });
  if (!instruction?.trim()) return;

  const settings = getSettings();
  const agentId: AgentId = settings.defaultAgentId;
  if (!getAgentDescriptor(agentId).supportsInlineEdit) {
    new Notice(`${getAgentDescriptor(agentId).displayName} 暂不支持行内修改。`);
    return;
  }
  const vaultBasePath = getVaultBasePath(plugin.app);
  if (!vaultBasePath) {
    new Notice('Ailu 需要可访问的本地 Obsidian 仓库路径。');
    return;
  }

  const prompt = [
    '只返回下方原文的替换文本，不要解释。',
    `修改要求：${instruction.trim()}`,
    '',
    '原文：',
    original,
  ].join('\n');
  let proposed = '';
  await runtimeManager.runTurn(
    buildInlineEditTurnInput({ settings, agentId, prompt, cwd: vaultBasePath }),
    (event: RuntimeTurnEvent) => {
      if (event.type === 'text') proposed += event.content;
      if (event.type === 'error') {
        new Notice(userFacingErrorText(event.message, '行内修改失败，请稍后重试。'));
      }
    },
  );

  const cleaned = cleanReplacement(proposed);
  if (!cleaned.trim()) {
    new Notice('AI 没有返回可用的替换文本。');
    return;
  }

  new InlineEditModal(plugin.app, editor, original, cleaned).open();
}

function cleanReplacement(value: string): string {
  return value
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```$/, '')
    .trim();
}

class InlineEditModal extends Modal {
  constructor(
    app: App,
    private readonly editor: Editor,
    private readonly original: string,
    private readonly proposed: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '确认 AI 修改' });
    const diff = contentEl.createDiv({ cls: 'ailu-modal-diff' });
    const left = diff.createDiv();
    left.createEl('strong', { text: '原文' });
    left.createEl('pre', { text: this.original });
    const right = diff.createDiv();
    right.createEl('strong', { text: '修改后' });
    right.createEl('pre', { text: this.proposed });

    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText('采用')
          .setCta()
          .onClick(() => {
            if (this.editor.somethingSelected()) {
              this.editor.replaceSelection(this.proposed);
            } else {
              const cursor = this.editor.getCursor();
              this.editor.setLine(cursor.line, this.proposed);
            }
            this.close();
          });
      })
      .addButton(button => {
        button
          .setButtonText('取消')
          .onClick(() => this.close());
      });
  }
}
