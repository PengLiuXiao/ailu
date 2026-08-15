import { App, Modal, Setting } from 'obsidian';

import type { AgentStatus } from '../types';

export class RuntimeSetupModal extends Modal {
  constructor(
    app: App,
    private readonly status: AgentStatus,
    private readonly openSettings: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `配置 ${this.status.descriptor.displayName}` });
    contentEl.createEl('p', {
      text: '请从官方渠道单独安装 CLI，然后重启 Obsidian，或在“Ailu”设置中指定可执行文件路径。本插件不会安装或更新 CLI。',
    });
    new Setting(contentEl)
      .addButton(button => {
        button
          .setButtonText('打开官方指南')
          .setCta()
          .onClick(() => {
            window.open(this.status.descriptor.docsUrl, '_blank', 'noopener,noreferrer');
          });
      })
      .addButton(button => {
        button
          .setButtonText('配置路径')
          .onClick(() => {
            this.close();
            this.openSettings();
          });
      })
      .addButton(button => {
        button
          .setButtonText('关闭')
          .onClick(() => this.close());
      });
  }
}
