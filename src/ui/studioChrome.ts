import { setIcon } from 'obsidian';
import { PLUGIN_NAME } from '../ids';
import { createAiluBrandMark } from './ailuBrandMark';

export type StudioSection = 'chat' | 'publishing';

interface StudioChromeOptions {
  active: StudioSection;
  context?: string;
  onNavigate: (section: StudioSection) => void;
  renderActions?: (parent: HTMLElement) => void;
}

/** Shared, intentionally quiet chrome for both plugin workspaces. */
export function renderStudioChrome(parent: HTMLElement, options: StudioChromeOptions): void {
  const header = parent.createDiv({ cls: 'ailu-chrome' });
  const identity = header.createDiv({ cls: 'ailu-chrome-identity' });
  createAiluBrandMark(identity, 'ailu-chrome-mark');
  const title = identity.createDiv({ cls: 'ailu-chrome-title' });
  title.createSpan({ text: PLUGIN_NAME });
  if (options.context) title.createEl('small', { text: options.context });

  const controls = header.createDiv({ cls: 'ailu-chrome-controls' });
  const navigation = controls.createDiv({
    cls: 'ailu-chrome-nav',
    attr: { role: 'tablist', 'aria-label': '工作区' },
  });
  for (const item of [
    { id: 'chat' as const, label: '对话', icon: 'message-square' },
    { id: 'publishing' as const, label: '草稿', icon: 'panels-top-left' },
  ]) {
    const button = navigation.createEl('button', {
      cls: options.active === item.id ? 'is-active' : '',
      attr: {
        type: 'button',
        role: 'tab',
        'aria-selected': String(options.active === item.id),
      },
    });
    const icon = button.createSpan();
    setIcon(icon, item.icon);
    button.createSpan({ text: item.label });
    button.onclick = () => options.onNavigate(item.id);
  }

  if (options.renderActions) {
    const actions = controls.createDiv({ cls: 'ailu-chrome-actions' });
    options.renderActions(actions);
  }
}
