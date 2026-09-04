import { App, Notice, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';

import {
  getAgentDescriptor,
  SELECTABLE_AGENT_IDS,
  type SelectableAgentId,
} from '../agents';
import { ailuHome, logsDir, providersPath, tmpDir, xCookiesPath } from '../paths';
import { SECRET_IDS, STORAGE_IDS } from '../ids';
import { ProviderStore } from '../storage/providerStore';
import { buildRedactedDiagnosticBundle } from '../storage/localLog';
import type {
  AgentId,
  AgentStatus,
  AnthropicAuthMode,
  ProviderProfile,
  ProviderWireApi,
  RuntimeBinarySource,
  AiluSettings,
} from '../types';
import { RuntimeDiscovery, invalidateRuntimeDiscoveryCache } from '../runtime/discovery';
import { normalizePiCustomizationMode } from '../settings/agentSettings';
import {
  ccSwitchRouteSummary,
  ccSwitchGlobalSnapshot,
  ccSwitchSnapshotLabel,
} from '../runtime/ccSwitch';
import { getClaudeDetectedLocalModel } from '../runtime/localModels';
import { filterCreativeSkills } from '../skill/creativeSkills';
import { invalidateSkillCache, loadLocalSkills } from '../skill/skillDiscovery';
import type { RuntimeManager } from '../runtime/runtimeManager';
import { inferAnthropicAuthMode, requiresProviderApiKey } from '../utils/providerAuth';
import { runtimeEnvironment } from '../utils/env';
import { fetchProviderModels, resolveProviderModels, testProviderConnection } from '../utils/providerModels';
import { userFacingErrorMessage, userFacingErrorText } from '../utils/userFacingError';
import { getVaultBasePath } from '../utils/vault';
import { SELECTABLE_WECHAT_THEME_DEFINITIONS } from '../wechat/themes';
import {
  WECHAT_BODY_FONT_DEFINITIONS,
  WECHAT_BODY_FONT_SIZE_OPTIONS,
  type WeChatBodyFontId,
} from '../wechat/typography';
import { promptForText } from './textPromptModal';
import { MAX_X_COOKIE_FILE_BYTES } from '../xArticle/cookieStore';
import {
  initializeStoredSecretInput,
  resolveSecretInput,
  STORED_SECRET_MASK,
} from './secretInput';

export interface SettingsTabDeps {
  getSettings: () => AiluSettings;
  saveSettings: () => Promise<void>;
  saveRelayToken: (value: string) => Promise<void>;
  importXCookies: (value: string) => Promise<{ cookieCount: number }>;
  exportXCookiesFromChrome: () => Promise<{ cookieCount: number }>;
  providerStore: ProviderStore;
  runtimeManager: RuntimeManager;
  refreshViews: () => void;
  pluginVersion: string;
}

export type SettingsTabId = 'general' | 'publishing' | SelectableAgentId;
type ProviderApiFormat = 'anthropic' | 'openai';

const RUNTIME_SOURCE_LABELS: Record<RuntimeBinarySource, string> = {
  configured: '手动路径',
  desktopApp: '桌面应用内置',
  managed: '托管安装',
  path: '系统 PATH',
};

function runtimeSourceLabel(source: RuntimeBinarySource): string {
  return RUNTIME_SOURCE_LABELS[source];
}

interface ProviderModelPreset {
  id: string;
  name: string;
}

interface ProviderPreset {
  key: string;
  label: string;
  iconText: string;
  accent: string;
  defaultApiFormat: ProviderApiFormat;
  baseUrls: Record<ProviderApiFormat, string>;
  models: ProviderModelPreset[];
  anthropicAuthMode?: AnthropicAuthMode;
  apiKeyUrl?: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    iconText: 'OA',
    accent: '#111827',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: '',
      openai: 'https://api.openai.com/v1',
    },
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    ],
    apiKeyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'anthropic',
    label: 'Claude',
    iconText: 'AI',
    accent: '#d97757',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.anthropic.com',
      openai: '',
    },
    models: [
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
    anthropicAuthMode: 'apiKey',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'google',
    label: 'Google',
    iconText: 'G',
    accent: '#4285f4',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: '',
      openai: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
    ],
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    iconText: 'DS',
    accent: '#3b82f6',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.deepseek.com/anthropic',
      openai: 'https://api.deepseek.com',
    },
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    key: 'moonshot',
    label: 'Moonshot',
    iconText: 'K',
    accent: '#1f2937',
    defaultApiFormat: 'openai',
    baseUrls: {
      anthropic: 'https://api.moonshot.cn/anthropic',
      openai: 'https://api.moonshot.cn/v1',
    },
    models: [
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    key: 'qwen',
    label: 'Qwen',
    iconText: 'Q',
    accent: '#7c3aed',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    models: [
      { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus' },
      { id: 'qwen3-max', name: 'Qwen3 Max' },
      { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
      { id: 'qwen3-coder-480b-a35b-instruct', name: 'Qwen3 Coder 480B' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    key: 'zhipu',
    label: 'Zhipu',
    iconText: 'Z',
    accent: '#2563eb',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
      openai: 'https://open.bigmodel.cn/api/paas/v4',
    },
    models: [
      { id: 'glm-5.1', name: 'GLM 5.1' },
      { id: 'glm-5', name: 'GLM 5' },
      { id: 'glm-4.7', name: 'GLM 4.7' },
      { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    iconText: 'M',
    accent: '#ef4444',
    defaultApiFormat: 'anthropic',
    baseUrls: {
      anthropic: 'https://api.minimaxi.com/anthropic',
      openai: 'https://api.minimaxi.com/v1',
    },
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M3', name: 'MiniMax M3' },
    ],
    anthropicAuthMode: 'authToken',
    apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
];

export class AiluSettingTab extends PluginSettingTab {
  private editingProfileId: string | null = null;
  private activeTab: SettingsTabId = 'general';
  private selectedProviderKey = 'deepseek';
  private ccSwitchAutoRefreshRequested = false;

  constructor(app: App, plugin: Plugin, private readonly deps: SettingsTabDeps) {
    super(app, plugin);
  }

  openTab(tab: SettingsTabId): void {
    if (tab === 'claude') this.ccSwitchAutoRefreshRequested = false;
    this.activeTab = tab;
    this.editingProfileId = null;
    this.display();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('ailu-settings-root');
    this.renderTabs(containerEl);
    const panel = containerEl.createDiv({ cls: 'ailu-settings-panel' });
    panel.id = 'ailu-settings-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `ailu-settings-tab-${this.activeTab}`);
    if (this.activeTab === 'general') {
      this.renderGeneral(panel);
      this.renderEnvironment(panel);
      this.renderPrivacy(panel);
      return;
    }
    if (this.activeTab === 'publishing') {
      this.renderPublishing(panel);
      return;
    }
    this.renderAgentSettings(panel, this.activeTab);
    if (getAgentDescriptor(this.activeTab).supportsProviderProfiles) {
      this.renderProfiles(panel, this.activeTab);
    }
    this.renderSkills(panel, this.activeTab);
  }

  private renderTabs(containerEl: HTMLElement): void {
    const wrap = containerEl.createDiv({ cls: 'ailu-settings-tabs-wrap' });
    const tabs = wrap.createDiv({ cls: 'ailu-settings-tabs' });
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '设置分类');
    const entries: Array<{ id: SettingsTabId; label: string }> = [
      { id: 'general', label: '通用' },
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'publishing', label: '草稿' },
    ];
    const activate = (id: SettingsTabId, restoreFocus: boolean): void => {
      if (id === 'claude') this.ccSwitchAutoRefreshRequested = false;
      this.activeTab = id;
      this.editingProfileId = null;
      this.display();
      if (restoreFocus) {
        queueMicrotask(() => {
          const active = containerEl.querySelector<HTMLElement>(`[data-settings-tab="${id}"]`);
          active?.focus();
        });
      }
    };
    entries.forEach((entry, index) => {
      const selected = this.activeTab === entry.id;
      const tab = tabs.createEl('button', {
        cls: 'ailu-settings-tab',
        text: entry.label,
        attr: {
          id: `ailu-settings-tab-${entry.id}`,
          type: 'button',
          role: 'tab',
          'aria-controls': 'ailu-settings-panel',
          'aria-selected': String(selected),
          tabindex: selected ? '0' : '-1',
          'data-settings-tab': entry.id,
        },
      });
      tab.toggleClass('is-active', selected);
      tab.onclick = () => activate(entry.id, false);
      tab.onkeydown = event => {
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : 0;
        let nextIndex = index;
        if (direction !== 0) nextIndex = (index + direction + entries.length) % entries.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = entries.length - 1;
        if (nextIndex === index && direction === 0 && event.key !== 'Home' && event.key !== 'End') return;
        event.preventDefault();
        activate(entries[nextIndex].id, true);
      };
    });
  }

  private renderGeneral(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'ailu-settings-section' });
    const settings = this.deps.getSettings();

    new Setting(section)
      .setName('默认 Agent')
      .setDesc('新对话与行内修改默认使用的 Agent。')
      .addDropdown(dropdown => {
        for (const agentId of SELECTABLE_AGENT_IDS) {
          dropdown.addOption(agentId, getAgentDescriptor(agentId).displayName);
        }
        dropdown
          .setValue(settings.defaultAgentId)
          .onChange(async value => {
            settings.defaultAgentId = value as AgentId;
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });

    new Setting(section)
      .setName('新对话默认使用 Plan')
      .setDesc('只改变新打开的对话；对话输入框仍可随时切换。')
      .addToggle(toggle => toggle
        .setValue(settings.planModeDefault)
        .onChange(async value => {
          settings.planModeDefault = value;
          await this.deps.saveSettings();
        }));
  }

  private renderPublishing(containerEl: HTMLElement): void {
    const settings = this.deps.getSettings();
    const publishing = settings.publishing;
    const section = containerEl.createDiv({ cls: 'ailu-settings-section' });
    new Setting(section)
      .setName('公众号草稿')
      .setDesc('预览与检查完全在本机完成；只有你在草稿区确认后，才会通过中转创建草稿。')
      .setHeading();

    new Setting(section)
      .setName('默认排版')
      .setDesc('模板只负责颜色、标题和版式结构；正文字体与字号单独设置。')
      .addDropdown(dropdown => {
        for (const theme of SELECTABLE_WECHAT_THEME_DEFINITIONS) {
          dropdown.addOption(theme.id, theme.label);
        }
        dropdown
          .setValue(publishing.themeId)
          .onChange(async value => {
            publishing.themeId = value as typeof publishing.themeId;
            settings.wechatThemeId = publishing.themeId;
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });

    new Setting(section)
      .setName('默认正文字体')
      .setDesc('用于正文、列表、引用和表格；标题、代码及结尾装饰仍跟随模板。')
      .addDropdown(dropdown => {
        for (const font of WECHAT_BODY_FONT_DEFINITIONS) {
          dropdown.addOption(font.id, font.label);
        }
        dropdown
          .setValue(publishing.bodyFontId)
          .onChange(async value => {
            publishing.bodyFontId = value as WeChatBodyFontId;
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });

    new Setting(section)
      .setName('默认正文字号')
      .setDesc('常用字号优先排列；表格会自动比正文小 2px，避免列宽拥挤。')
      .addDropdown(dropdown => {
        for (const size of WECHAT_BODY_FONT_SIZE_OPTIONS) {
          dropdown.addOption(String(size), size === 0 ? '跟随模板' : `${size}px`);
        }
        dropdown
          .setValue(String(publishing.bodyFontSize))
          .onChange(async value => {
            publishing.bodyFontSize = Number(value);
            await this.deps.saveSettings();
            this.deps.refreshViews();
          });
      });

    new Setting(section)
      .setName('草稿通道')
      .setDesc('连接你自行部署的 wechat-relay，只创建草稿，不提供群发或正式发布。')
      .addDropdown(dropdown => dropdown
        .addOption('localRelay', '自托管公众号中转')
        .setValue(publishing.transport)
        .onChange(async () => {
          publishing.transport = 'localRelay';
          await this.deps.saveSettings();
          this.deps.refreshViews();
        }));

    new Setting(section)
      .setName('中转地址')
      .setDesc('Tailscale Serve 填 HTTPS MagicDNS 地址；域名路线填 Caddy HTTPS 地址。只填服务根地址，不加 /v1。')
      .addText(text => text
        .setPlaceholder('https://relay.example.com')
        .setValue(publishing.relayUrl)
        .onChange(async value => {
          publishing.relayUrl = value.trim();
          await this.deps.saveSettings();
        }));

    const storedRelayToken = this.app.secretStorage
      .getSecret(SECRET_IDS.wechatRelayToken)?.trim() ?? '';
    new Setting(section)
      .setName('中转 Token')
      .setDesc('须由至少 32 个随机字节生成；保存在 Obsidian SecretStorage，不写入 data.json。')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('输入中转 Token');
        initializeStoredSecretInput(text.inputEl, Boolean(storedRelayToken));
        text.onChange(async value => {
          if (value === STORED_SECRET_MASK) return;
          await this.deps.saveRelayToken(value);
        });
      });

    new Setting(section)
      .setName('公众号 AppID（仅作标记）')
      .setDesc('不会随草稿请求发送；用于确认当前配置属于哪个公众号。')
      .addText(text => text
        .setPlaceholder('wx...')
        .setValue(publishing.appId)
        .onChange(async value => {
          publishing.appId = value.trim();
          await this.deps.saveSettings();
        }));

    const xPublishing = settings.xPublishing;
    const xSection = containerEl.createDiv({ cls: 'ailu-settings-section' });
    new Setting(xSection)
      .setName('X Article 草稿')
      .setDesc('本地预览与 dry-run 不登录 X；只有你在草稿区确认后，才会调用现有 Skill 创建草稿。')
      .setHeading();

    new Setting(xSection)
      .setName('Python 命令')
      .setDesc('用于运行 x-article-draft-uploader Skill；插件不会安装或升级 Python。')
      .addText(text => text
        .setPlaceholder('python3')
        .setValue(xPublishing.pythonCommand)
        .onChange(async value => {
          xPublishing.pythonCommand = value.trim() || 'python3';
          await this.deps.saveSettings();
        }));

    new Setting(xSection)
      .setName('Skill 上传脚本（可选）')
      .setDesc('留空时自动发现 ~/.agents/skills/x-article-draft-uploader；这里只接受当前 Skill，不回退旧插件内嵌脚本。')
      .addText(text => text
        .setPlaceholder('自动发现当前 Skill')
        .setValue(xPublishing.uploadScriptPath)
        .onChange(async value => {
          xPublishing.uploadScriptPath = value.trim();
          await this.deps.saveSettings();
          this.deps.refreshViews();
        }));

    new Setting(xSection)
      .setName('X 登录态')
      .setDesc(`Cookie 只保存在本机私密文件 ${xCookiesPath()}（目录0700、文件0600），不写入 Vault 设置或日志。`)
      .addButton(button => button
        .setButtonText('从 Chrome 导入')
        .onClick(async () => {
          try {
            const status = await this.deps.exportXCookiesFromChrome();
            new Notice(`已导入并验证 ${status.cookieCount} 个 X Cookie。`);
          } catch (error) {
            new Notice(userFacingErrorMessage(error, '从 Chrome 导入 X 登录态失败。'));
          }
        }))
      .addButton(button => button
        .setButtonText('粘贴 JSON')
        .onClick(async () => {
          const value = await promptForText(this.app, {
            title: '导入 X Cookie JSON',
            placeholder: '粘贴 Cookie 数组；内容不会写入设置或日志',
            multiline: true,
            submitLabel: '安全导入',
            cancelLabel: '取消',
          });
          if (!value?.trim()) return;
          try {
            const status = await this.deps.importXCookies(value);
            new Notice(`已导入并验证 ${status.cookieCount} 个 X Cookie。`);
          } catch (error) {
            new Notice(userFacingErrorMessage(error, 'X Cookie JSON 导入失败。'));
          }
        }))
      .addButton(button => button
        .setButtonText('选择 JSON')
        .onClick(() => {
          const picker = document.createElement('input');
          picker.type = 'file';
          picker.accept = '.json,application/json';
          picker.onchange = () => {
            const file = picker.files?.[0];
            if (!file) return;
            void (async () => {
              try {
                if (file.size > MAX_X_COOKIE_FILE_BYTES) throw new Error('X Cookie JSON 超过 5 MB 上限。');
                const status = await this.deps.importXCookies(await file.text());
                new Notice(`已导入并验证 ${status.cookieCount} 个 X Cookie。`);
              } catch (error) {
                new Notice(userFacingErrorMessage(error, 'X Cookie JSON 导入失败。'));
              }
            })();
          };
          picker.click();
        }));

    new Setting(xSection)
      .setName('Cookie 缺失时导出')
      .setDesc('只在文件不存在、为空或缺必需 Cookie 时从本机 Chrome 导出；可能触发 macOS 钥匙串授权，不会每次上传都执行。')
      .addToggle(toggle => toggle
        .setValue(xPublishing.autoExportCookiesWhenMissing)
        .onChange(async value => {
          xPublishing.autoExportCookiesWhenMissing = value;
          await this.deps.saveSettings();
        }));

    new Setting(xSection)
      .setName('显示独立浏览器')
      .setDesc('开启后可看到 Skill 填写草稿的过程；无论是否显示，都不会接管当前 Chrome。')
      .addToggle(toggle => toggle
        .setValue(xPublishing.headed)
        .onChange(async value => {
          xPublishing.headed = value;
          await this.deps.saveSettings();
        }));

    new Setting(xSection)
      .setName('成功后打开草稿')
      .setDesc('创建并核验成功后，在系统浏览器中打开返回的 X 草稿链接。')
      .addToggle(toggle => toggle
        .setValue(xPublishing.openDraftAfterSuccess)
        .onChange(async value => {
          xPublishing.openDraftAfterSuccess = value;
          await this.deps.saveSettings();
        }));

    new Setting(xSection)
      .setName('预览隐藏 frontmatter')
      .setDesc('隐藏 YAML 元数据，但上传时仍会读取 formatter.title 与 formatter.cover。')
      .addToggle(toggle => toggle
        .setValue(xPublishing.previewStripFrontmatter)
        .onChange(async value => {
          xPublishing.previewStripFrontmatter = value;
          await this.deps.saveSettings();
          this.deps.refreshViews();
        }));

    new Setting(xSection)
      .setName('缺少标题时使用文件名')
      .setDesc('只影响本地预览和未设置标题的上传副本，不修改 Markdown 原文。')
      .addToggle(toggle => toggle
        .setValue(xPublishing.previewUseFilenameTitle)
        .onChange(async value => {
          xPublishing.previewUseFilenameTitle = value;
          await this.deps.saveSettings();
          this.deps.refreshViews();
        }));

    const safety = containerEl.createDiv({ cls: 'ailu-settings-section ailu-safety-note' });
    new Setting(safety).setName('不可关闭的安全步骤').setHeading();
    safety.createEl('p', {
      text: '公众号和 X 每次上传前都会重新检查正文与全部图片，弹出最终确认，并在创建草稿后回读核验。公众号不按正文图片数量设置额外提醒或阻断；X 正文超过 25 张时会直接显示超出的数量并停止创建草稿。封面单独上传、不占 X 正文名额。插件没有群发或正式发布入口。',
    });
  }

  private renderAgentSettings(containerEl: HTMLElement, agentId: AgentId): void {
    const descriptor = getAgentDescriptor(agentId);
    const section = containerEl.createDiv({ cls: 'ailu-settings-section ailu-agent-settings-section' });
    const settings = this.deps.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(agentId, { withVersion: true });

    const row = section.createDiv({
      cls: `ailu-agent-row ${status.found ? 'is-ready' : 'is-missing'}`,
    });
    row.createDiv({ cls: 'ailu-agent-row-label', text: 'CLI 状态' });
    const sourceLabel = status.source ? runtimeSourceLabel(status.source) : '';
    row.createDiv({
      cls: 'ailu-agent-row-detail',
      text: status.found
        ? `${sourceLabel} · ${status.version ?? status.binaryPath}`
        : `未检测到 ${descriptor.binaryName} 可执行文件`,
    });
    const actions = row.createDiv({ cls: 'ailu-agent-row-actions' });
    if (status.found) {
      const statusPill = actions.createSpan({ cls: 'ailu-agent-status-pill is-ready' });
      const icon = statusPill.createSpan({ cls: 'ailu-agent-status-icon' });
      setIcon(icon, 'circle-check');
      statusPill.createSpan({ text: '可用' });
    } else {
      const setup = actions.createEl('button', {
        text: '查看安装指南',
        attr: { type: 'button' },
      });
      setup.onclick = () => {
        window.open(descriptor.docsUrl, '_blank', 'noopener,noreferrer');
      };
    }

    if (agentId === 'codex' || agentId === 'pi' || agentId === 'antigravity') {
      const runtimeMode = new Setting(section)
        .setName('运行方式')
        .setDesc(agentId === 'codex'
          ? '使用官方 ChatGPT / Codex 桌面应用内置的 App Server；模型与推理强度从本机实时读取。'
          : agentId === 'pi'
            ? 'Ailu 为每个回合启动独立的 Pi RPC 进程；模型与思考级别跟随本机 Pi 配置，或在对话中显式选择。'
            : 'Ailu 为每个回合启动独立的 Antigravity headless 进程；模型与推理强度跟随本机配置，或在对话中显式选择。');
      runtimeMode.controlEl.createSpan({
        cls: 'ailu-readonly-value',
        text: agentId === 'codex' ? '本地 App Server' : agentId === 'pi' ? '本地 RPC 进程' : '本地 Headless 进程',
      });
    } else {
      const configSourceSetting = new Setting(section)
        .setName('模型与配置来源')
        .addDropdown(dropdown => {
          dropdown.addOption('localCli', '本地模式');
          if (agentId === 'claude') {
            dropdown.addOption('ccSwitchCurrent', 'CC Switch · 跟随全局');
          }
          dropdown.addOption('providerProfile', '自定义供应商');
          dropdown
            .setValue(settings.configSources[agentId])
            .onChange(async value => {
              if (agentId === 'claude' && value === 'ccSwitchCurrent') {
                settings.configSources[agentId] = 'ccSwitchCurrent';
              } else {
                settings.configSources[agentId] = value === 'providerProfile' ? 'providerProfile' : 'localCli';
              }
              this.ccSwitchAutoRefreshRequested = false;
              await this.deps.saveSettings();
              this.deps.refreshViews();
              if (this.activeTab === agentId) this.display();
            });
        });
      if (agentId === 'claude' && settings.configSources.claude === 'ccSwitchCurrent') {
        configSourceSetting.setDesc(
          '只读取 CC Switch 的全局 Provider、模型和家族路由，不读取当前 Vault 的 Claude 项目配置；在 CC Switch 中切换后，下一次发送会自动跟随。',
        );
        this.renderCcSwitchStatus(section);
      }
    }

    new Setting(section)
      .setName('CLI 路径')
      .setDesc('可选的本机可执行文件路径；留空时自动查找桌面应用与系统 PATH。')
      .addText(text => {
        text
          .setPlaceholder(descriptor.binaryName)
          .setValue(settings.configuredPaths[agentId])
          .onChange(async value => {
            settings.configuredPaths[agentId] = value.trim();
            invalidateRuntimeDiscoveryCache(agentId);
            await this.deps.saveSettings();
          });
      });

    if (agentId === 'claude' || agentId === 'codex' || agentId === 'pi') {
      new Setting(section)
        .setName('普通对话完全访问')
        .setDesc(agentId === 'claude'
          ? '默认关闭。开启后，普通对话与行内修改会跳过 Claude Code 的文件编辑和命令权限确认；Plan 模式仍只规划。'
          : agentId === 'pi'
            ? '默认关闭。开启后，普通对话跳过 Pi 的文件写入、命令执行与自定义工具确认；Plan 模式仍只规划。'
            : '默认关闭。开启后，普通对话与行内修改可访问 Vault 外文件和网络，并使用全主机访问；Plan 模式仍只规划。')
        .addToggle(toggle => toggle
          .setValue(settings.fullAccessByAgent[agentId])
          .onChange(async value => {
            settings.fullAccessByAgent[agentId] = value;
            await this.deps.saveSettings();
            this.deps.refreshViews();
          }));
    }

    if (agentId === 'antigravity') {
      new Setting(section)
        .setName('权限说明')
        .setDesc('Antigravity CLI 的 headless 流没有交互式权限确认通道（权限请求会直接结束会话），因此每个回合都以完全访问运行。请仅在本机环境信任 Agent 行为时使用。');
    }

    if (agentId === 'codex') {
      const codexStatus = this.deps.runtimeManager.getCodexStatus();
      const modelLabel = codexStatus.currentModel?.displayName ?? codexStatus.currentModelId ?? '等待 Codex App 返回';
      const statusText = codexStatus.state === 'ready'
        ? codexStatus.authenticated === false
          ? '已连接，Codex 尚未登录。请在 Codex App 或 CLI 中完成登录。'
          : `已连接 · ${modelLabel}`
        : codexStatus.state === 'connecting'
          ? '正在连接 Codex App Server…'
          : codexStatus.state === 'error'
            ? `连接失败：${userFacingErrorText(codexStatus.error, 'Codex 暂时不可用。')}`
            : '尚未连接';
      new Setting(section)
        .setName('Codex 应用服务')
        .setDesc(statusText)
        .addButton(button => button
          .setButtonText('刷新状态')
          .onClick(async () => {
            button.setDisabled(true);
            await this.deps.runtimeManager.refreshCodexStatus();
            this.display();
          }));
      new Setting(section)
        .setName('当前模型')
        .setDesc('模型与可用推理强度来自本机 Codex App Server。')
        .addText(text => {
          text.setValue(modelLabel);
          text.inputEl.disabled = true;
        });
      new Setting(section)
        .setName('图片生成')
        .setDesc(codexStatus.imageGeneration === false
          ? '当前模型或供应商未提供图片生成，普通聊天仍可使用。'
          : codexStatus.imageGeneration === true
            ? '可用，生成结果会保存到 Vault。'
            : '能力状态尚未返回。');
      if (codexStatus.state === 'idle') {
        void this.deps.runtimeManager.refreshCodexStatus().then(() => {
          if (this.activeTab === 'codex') this.display();
        });
      }
      return;
    }

    if (agentId === 'pi') {
      new Setting(section)
        .setName('定制与信任')
        .setDesc('控制 Pi 回合加载哪些扩展、技能与项目资源。切换后，下一次发送会开启新的 Pi 会话。')
        .addDropdown(dropdown => {
          dropdown
            .addOption('isolated', '隔离模式（不加载任何扩展/技能/模板）')
            .addOption('user', '用户配置（仅 ~/.pi 用户资源）')
            .addOption('trustedVault', '信任当前 Vault（加载 .pi 项目资源）')
            .setValue(settings.piCustomizationMode ?? 'user')
            .onChange(async value => {
              settings.piCustomizationMode = normalizePiCustomizationMode(value);
              await this.deps.saveSettings();
              this.deps.refreshViews();
              this.display();
            });
        });
      if ((settings.piCustomizationMode ?? 'user') === 'trustedVault') {
        const warning = section.createDiv({ cls: 'ailu-setting-warning' });
        warning.createEl('strong', { text: '注意：信任当前 Vault 的加载时风险' });
        warning.createEl('p', {
          text: '开启后，Vault 内 .pi 目录中的项目扩展会在 Pi 启动时立即执行，早于任何工具确认。仅在完全信任此 Vault 全部内容时选择；若扩展导致 Pi 启动失败，切回“隔离模式”即可恢复。',
        });
      }
      this.renderPiRpcStatus(section, status);
      return;
    }

    if (agentId === 'antigravity') {
      new Setting(section)
        .setName('模型 ID')
        .setDesc('可选；留空时跟随本机默认模型。模型列表读取失败时可直接填写，例如 gemini-3.8-flash-high。')
        .addText(text => {
          text
            .setPlaceholder('跟随本机')
            .setValue(settings.localModelByAgent.antigravity)
            .onChange(async value => {
              settings.localModelByAgent.antigravity = value.trim();
              await this.deps.saveSettings();
              this.deps.refreshViews();
            });
        });
      this.renderAgyStatus(section, status);
      return;
    }

    if (agentId === 'claude' && settings.configSources.claude === 'ccSwitchCurrent') {
      return;
    }

    const detectedClaudeModel = agentId === 'claude'
      ? getClaudeDetectedLocalModel(
        runtimeEnvironment(process.env),
        getVaultBasePath(this.app) ?? undefined,
      )
      : null;
    new Setting(section)
      .setName('本地模型')
      .setDesc(detectedClaudeModel
        ? `当前本机配置：${detectedClaudeModel.label}（${detectedClaudeModel.note}）。留空时沿用；填写后仅为插件会话临时覆盖。`
        : '可选；留空时沿用本机 CLI 配置。')
      .addText(text => {
        text
          .setPlaceholder(detectedClaudeModel ? `跟随本机：${detectedClaudeModel.label}` : '跟随 CLI 默认配置')
          .setValue(settings.localModelByAgent[agentId])
          .onChange(async value => {
            settings.localModelByAgent[agentId] = value.trim();
            await this.deps.saveSettings();
          });
      });
  }

  private renderPiRpcStatus(section: HTMLElement, status: AgentStatus): void {
    const piStatus = this.deps.runtimeManager.getPiStatus();
    const modelLabel = piStatus.currentModelId ?? '等待 Pi 返回本机默认模型';
    const statusText = piStatus.state === 'ready'
      ? `已连接 · ${piStatus.models.length} 个模型可用 · 本机默认：${modelLabel}`
      : piStatus.state === 'connecting'
        ? '正在读取 Pi 模型列表…'
        : piStatus.state === 'error'
          ? `连接失败：${piStatus.error ?? 'Pi 暂时不可用。'}`
          : status.binaryPath
            ? '尚未连接，打开 Pi 对话或点击刷新。'
            : '未检测到 Pi CLI，请先安装 Pi。';
    new Setting(section)
      .setName('Pi RPC 服务')
      .setDesc(statusText)
      .addButton(button => button
        .setButtonText('重新检测')
        .onClick(async () => {
          button.setDisabled(true);
          await this.deps.runtimeManager.refreshPiStatus();
          this.display();
        }));
    if (piStatus.state === 'idle' && status.binaryPath) {
      void this.deps.runtimeManager.refreshPiStatus().then(() => {
        if (this.activeTab === 'pi') this.display();
      });
    }
  }

  private renderAgyStatus(section: HTMLElement, status: AgentStatus): void {
    const agyStatus = this.deps.runtimeManager.getAgyStatus();
    const statusText = agyStatus.state === 'ready'
      ? `已连接 · ${agyStatus.models.length} 个模型可用`
      : agyStatus.state === 'connecting'
        ? '正在读取 Antigravity CLI 模型列表…'
        : agyStatus.state === 'error'
          ? `连接失败：${agyStatus.error ?? 'Antigravity CLI 暂时不可用。'}`
          : status.binaryPath
            ? '尚未连接，打开 Antigravity 对话或点击刷新。'
            : '未检测到 Antigravity CLI，请先安装 agy。';
    new Setting(section)
      .setName('Antigravity CLI 服务')
      .setDesc(statusText)
      .addButton(button => button
        .setButtonText('重新检测')
        .onClick(async () => {
          button.setDisabled(true);
          await this.deps.runtimeManager.refreshAgyStatus();
          this.display();
        }));
    if (agyStatus.state === 'idle' && status.binaryPath) {
      void this.deps.runtimeManager.refreshAgyStatus().then(() => {
        if (this.activeTab === 'antigravity') this.display();
      });
    }
  }

  private renderCcSwitchStatus(section: HTMLElement): void {
    const snapshot = ccSwitchGlobalSnapshot(this.deps.runtimeManager.getCcSwitchSnapshot());
    const currentLabel = ccSwitchSnapshotLabel(snapshot);
    const routeSummary = ccSwitchRouteSummary(snapshot);
    const state = snapshot.state;
    const statusText = state === 'ready'
      ? `本机代理在线 · ${currentLabel}${!snapshot.currentModel && routeSummary
        ? ` · Haiku / Sonnet / Opus / Fable 家族路由：${routeSummary}`
        : ''}`
      : state === 'error'
        ? `本机代理不可用：${userFacingErrorText(snapshot.error, '未返回可识别的错误详情。')}`
        : '尚未检查本机代理状态';
    const checkedAt = snapshot?.checkedAt && Number.isFinite(snapshot.checkedAt)
      ? new Date(snapshot.checkedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      : null;
    const description = createFragment();
    const statusLine = description.createSpan({
      cls: `ailu-ccswitch-status-line is-${state}`,
      text: statusText,
    });
    if (snapshot?.currentProviderId) statusLine.title = `Provider ID: ${snapshot.currentProviderId}`;
    description.createSpan({
      cls: 'ailu-ccswitch-status-note',
      text: `${checkedAt ? `上次检查 ${checkedAt} · ` : ''}${state === 'ready'
        ? snapshot.proxyStatusStale
          ? 'CC Switch 状态端点仍记录上次请求，已按当前配置重新读取。未验证上游模型。'
          : '已读取 CC Switch 当前配置。未验证上游模型。'
        : state === 'error'
          ? '未读取到可用的 CC Switch 当前配置；不会回退到上次请求记录。'
          : '等待读取 CC Switch 当前配置。'}`,
    });

    const statusSetting = new Setting(section)
      .setName('CC Switch 状态')
      .setDesc(description);
    statusSetting.settingEl.addClass('ailu-ccswitch-status');
    statusSetting.addButton(button => button
      .setButtonText('刷新状态')
      .onClick(async () => {
        button.setDisabled(true);
        button.setButtonText('刷新中…');
        try {
          const refreshed = await this.deps.runtimeManager.refreshCcSwitchStatus();
          if (refreshed.state === 'ready') {
            const current = ccSwitchGlobalSnapshot(refreshed);
            new Notice(`CC Switch 已刷新：${ccSwitchSnapshotLabel(current)}`);
          } else {
            new Notice(userFacingErrorText(
              refreshed.error,
              'CC Switch 状态刷新失败，本机代理不可用。',
            ));
          }
        } catch (error) {
          new Notice(userFacingErrorMessage(error, 'CC Switch 状态刷新失败，请稍后重试。'));
        } finally {
          const current = this.deps.getSettings();
          if (this.activeTab === 'claude' && current.configSources.claude === 'ccSwitchCurrent') {
            this.display();
          } else {
            button.setDisabled(false);
            button.setButtonText('刷新状态');
          }
        }
      }));

    if (!this.ccSwitchAutoRefreshRequested) {
      this.ccSwitchAutoRefreshRequested = true;
      void this.deps.runtimeManager.refreshCcSwitchStatus()
        .catch(error => {
          console.warn('Ailu could not refresh CC Switch status.', error);
        })
        .then(() => {
          const current = this.deps.getSettings();
          if (this.activeTab === 'claude' && current.configSources.claude === 'ccSwitchCurrent') {
            this.display();
          }
        });
    }
  }

  private renderProfiles(containerEl: HTMLElement, agentFilter?: AgentId): void {
    const section = containerEl.createDiv({ cls: 'ailu-settings-section' });
    new Setting(section)
      .setName(agentFilter ? `${getAgentDescriptor(agentFilter).shortName} 模型配置` : '模型')
      .setHeading();
    this.renderProviderConsole(section, agentFilter);
  }

  private renderProviderConsole(section: HTMLElement, agentFilter?: AgentId): void {
    const visiblePresets = agentFilter
      ? PROVIDER_PRESETS.filter(preset => Boolean(preset.baseUrls[providerFormatForAgent(agentFilter)]))
      : [...PROVIDER_PRESETS];
    if (!visiblePresets.some(preset => preset.key === this.selectedProviderKey)) {
      this.selectedProviderKey = visiblePresets[0]?.key ?? PROVIDER_PRESETS[0].key;
    }

    const preset = visiblePresets.find(item => item.key === this.selectedProviderKey) ?? visiblePresets[0] ?? PROVIDER_PRESETS[0];
    const anyExistingProfile = this.findPresetProfile(preset, agentFilter);
    let format = this.resolveInitialProviderFormat(preset, anyExistingProfile, agentFilter);
    let modelItems = toModelItems(anyExistingProfile, preset);
    let selectedModelId = anyExistingProfile?.defaultModel || anyExistingProfile?.model || modelItems[0]?.id || '';
    let anthropicAuthMode = inferAnthropicAuthMode(
      'claude',
      preset.label,
      anyExistingProfile?.baseUrl || preset.baseUrls.anthropic,
      anyExistingProfile?.anthropicAuthMode ?? preset.anthropicAuthMode,
    ) ?? 'authToken';

    const consoleEl = section.createDiv({ cls: 'ailu-provider-console' });
    const sidebar = consoleEl.createDiv({ cls: 'ailu-provider-sidebar' });
    const sidebarHead = sidebar.createDiv({ cls: 'ailu-provider-sidebar-head' });
    sidebarHead.createSpan({ text: '模型提供商' });
    const sidebarActions = sidebarHead.createDiv({ cls: 'ailu-provider-sidebar-actions' });
    const importBtn = sidebarActions.createEl('button', { text: '导入', attr: { type: 'button' } });
    importBtn.onclick = () => void this.importProviderProfiles();
    const exportBtn = sidebarActions.createEl('button', { text: '导出', attr: { type: 'button' } });
    exportBtn.onclick = () => void this.exportProviderProfiles();

    const list = sidebar.createDiv({ cls: 'ailu-provider-list' });
    for (const item of visiblePresets) {
      const profile = this.findPresetProfile(item, agentFilter);
      const needsRepair = Boolean(profile?.configurationError);
      const enabled = !needsRepair && Boolean(profile?.apiKey || profile?.baseUrl || profile?.models.length);
      const row = list.createEl('button', {
        cls: 'ailu-provider-list-item',
        attr: { type: 'button' },
      });
      row.toggleClass('is-selected', item.key === preset.key);
      row.toggleClass('is-enabled', enabled);
      row.toggleClass('needs-repair', needsRepair);
      if (needsRepair) row.setAttribute('aria-label', `${item.label}：URL 需修复`);
      row.onclick = () => {
        this.selectedProviderKey = item.key;
        this.display();
      };
      const icon = row.createSpan({ cls: 'ailu-provider-icon', text: item.iconText });
      icon.style.setProperty('--provider-accent', item.accent);
      row.createSpan({ cls: 'ailu-provider-name', text: needsRepair ? `${item.label} · URL 需修复` : item.label });
      const toggle = row.createSpan({ cls: 'ailu-provider-toggle' });
      toggle.createSpan();
    }

    const detail = consoleEl.createDiv({ cls: 'ailu-provider-detail' });
    const detailHead = detail.createDiv({ cls: 'ailu-provider-detail-head' });
    const titleWrap = detailHead.createDiv({ cls: 'ailu-provider-title-wrap' });
    const titleIcon = titleWrap.createSpan({ cls: 'ailu-provider-icon large', text: preset.iconText });
    titleIcon.style.setProperty('--provider-accent', preset.accent);
    const title = titleWrap.createDiv();
    const titleLine = title.createDiv({ cls: 'ailu-provider-title-line' });
    titleLine.createSpan({ text: `${preset.label} 提供商设置` });
    if (preset.apiKeyUrl) {
      const keyLink = titleLine.createEl('a', {
        cls: 'ailu-provider-link-icon',
        href: preset.apiKeyUrl,
        attr: { 'aria-label': `${preset.label} API Key` },
      });
      keyLink.setAttr('target', '_blank');
      keyLink.setAttr('rel', 'noopener');
      setIcon(keyLink, 'external-link');
    }
    const activeProfile = this.findPresetProfile(preset, agentFilter ?? providerAgentForFormat(format));
    const isEnabled = Boolean(activeProfile?.apiKey || activeProfile?.baseUrl || activeProfile?.models.length);
    detailHead.createSpan({
      cls: `ailu-provider-status ${isEnabled ? 'is-enabled' : ''}`,
      text: isEnabled ? '已开启' : '未开启',
    });

    const apiKeyField = detail.createDiv({ cls: 'ailu-provider-field' });
    const apiKeyHead = apiKeyField.createDiv({ cls: 'ailu-provider-field-head' });
    apiKeyHead.createSpan({ text: 'API key' });
    if (preset.apiKeyUrl) {
      const getKey = apiKeyHead.createEl('a', { text: '获取 API key ->', href: preset.apiKeyUrl });
      getKey.setAttr('target', '_blank');
      getKey.setAttr('rel', 'noopener');
    }
    const secretWrap = apiKeyField.createDiv({ cls: 'ailu-provider-secret' });
    const apiKeyInput = secretWrap.createEl('input', {
      attr: {
        type: 'password',
        placeholder: '输入你的 API key',
        'aria-label': anyExistingProfile?.apiKey
          ? 'API key 已安全保存，输入新值可替换'
          : '输入 API key',
      },
    });
    initializeStoredSecretInput(apiKeyInput, Boolean(anyExistingProfile?.apiKey));
    const reveal = secretWrap.createEl('button', {
      cls: 'ailu-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '显示 API key' },
    });
    setIcon(reveal, 'eye-off');
    reveal.onclick = () => {
      const visible = apiKeyInput.type === 'text';
      apiKeyInput.type = visible ? 'password' : 'text';
      reveal.setAttr('aria-label', visible ? '显示 API key' : '隐藏 API key');
      setIcon(reveal, visible ? 'eye-off' : 'eye');
    };

    const baseUrlField = detail.createDiv({ cls: 'ailu-provider-field' });
    baseUrlField.createDiv({ cls: 'ailu-provider-field-head' }).createSpan({ text: 'API Base URL' });
    const baseWrap = baseUrlField.createDiv({ cls: 'ailu-provider-input-wrap' });
    const baseUrlInput = baseWrap.createEl('input', {
      attr: {
        type: 'text',
        placeholder: 'https://api.example.com',
      },
    });
    baseUrlInput.value = anyExistingProfile?.baseUrl || preset.baseUrls[format] || '';
    const resetBaseUrl = baseWrap.createEl('button', {
      cls: 'ailu-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '恢复默认地址' },
    });
    setIcon(resetBaseUrl, 'x-circle');
    resetBaseUrl.onclick = () => {
      baseUrlInput.value = preset.baseUrls[format] || '';
    };

    const formatField = detail.createDiv({ cls: 'ailu-provider-field' });
    formatField.createDiv({ cls: 'ailu-provider-field-head' }).createSpan({ text: 'API 格式' });
    const formatOptions = formatField.createDiv({ cls: 'ailu-api-format-options' });
    const formatGroupName = `ailu-provider-format-${preset.key}-${agentFilter ?? 'all'}`;
    const formatHelp = formatField.createDiv({ cls: 'ailu-provider-help' });
    for (const option of [
      { value: 'anthropic' as const, label: 'Anthropic 兼容' },
      { value: 'openai' as const, label: 'OpenAI 兼容' },
    ]) {
      const optionEl = formatOptions.createEl('label');
      const radio = optionEl.createEl('input', {
        attr: {
          type: 'radio',
          name: formatGroupName,
          value: option.value,
        },
      });
      radio.checked = format === option.value;
      radio.disabled = Boolean(agentFilter) || !preset.baseUrls[option.value];
      radio.onchange = () => {
        if (!radio.checked) return;
        const oldBaseUrls = Object.values(preset.baseUrls).filter(Boolean);
        const currentBaseUrl = baseUrlInput.value.trim();
        format = option.value;
        if (!currentBaseUrl || oldBaseUrls.includes(currentBaseUrl)) {
          baseUrlInput.value = preset.baseUrls[format] || '';
        }
        formatHelp.setText(`请选择 API 协议格式：${providerFormatLabel(format)}`);
      };
      optionEl.createSpan({ text: option.label });
    }
    formatHelp.setText(`请选择 API 协议格式：${providerFormatLabel(format)}`);

    const authField = detail.createDiv({ cls: 'ailu-provider-field' });
    authField.createDiv({ cls: 'ailu-provider-field-head' }).createSpan({ text: 'Claude 鉴权方式' });
    const authOptions = authField.createDiv({ cls: 'ailu-api-format-options' });
    const authGroupName = `ailu-provider-auth-${preset.key}-${agentFilter ?? 'all'}`;
    for (const option of [
      { value: 'authToken' as const, label: 'Auth Token（兼容服务）' },
      { value: 'apiKey' as const, label: 'API Key（Anthropic 官方）' },
    ]) {
      const optionEl = authOptions.createEl('label');
      const radio = optionEl.createEl('input', {
        attr: { type: 'radio', name: authGroupName, value: option.value },
      });
      radio.checked = anthropicAuthMode === option.value;
      radio.disabled = (agentFilter ?? providerAgentForFormat(format)) !== 'claude';
      radio.onchange = () => {
        if (radio.checked) anthropicAuthMode = option.value;
      };
      optionEl.createSpan({ text: option.label });
    }
    authField.createDiv({
      cls: 'ailu-provider-help',
      text: 'Moonshot 等 Anthropic 兼容服务使用 Auth Token；api.anthropic.com 使用 API Key。',
    });

    const testRow = detail.createDiv({ cls: 'ailu-provider-test-row' });
    const testBtn = testRow.createEl('button', { text: '测试连接', attr: { type: 'button' } });
    testBtn.onclick = () => void this.testProviderConfiguration({
      preset,
      agentFilter,
      getFormat: () => format,
      getAnthropicAuthMode: () => anthropicAuthMode,
      getModel: () => selectedModelId || modelItems[0]?.id || '',
      baseUrlInput,
      apiKeyInput,
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      trigger: testBtn,
    });

    const modelHead = detail.createDiv({ cls: 'ailu-provider-model-head' });
    modelHead.createSpan({ text: '可用模型列表' });
    const modelActions = modelHead.createDiv({ cls: 'ailu-provider-model-actions' });
    const refreshModels = modelActions.createEl('button', { text: '获取模型列表', attr: { type: 'button' } });
    const refreshIcon = refreshModels.createSpan({ cls: 'ailu-provider-action-icon' });
    setIcon(refreshIcon, 'refresh-cw');
    refreshModels.onclick = () => void this.loadModelsIntoPanel({
      preset,
      agentFilter,
      getFormat: () => format,
      getAnthropicAuthMode: () => anthropicAuthMode,
      baseUrlInput,
      apiKeyInput,
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      setModels: next => {
        modelItems = mergeModelItems([...modelItems, ...next]);
        selectedModelId = modelItems.find(item => item.id === selectedModelId)?.id ?? modelItems[0]?.id ?? '';
      },
      renderModelCards,
      trigger: refreshModels,
      noticePrefix: '已获取',
    });
    const addModel = modelActions.createEl('button', { text: '添加模型', attr: { type: 'button' } });
    const addIcon = addModel.createSpan({ cls: 'ailu-provider-action-icon' });
    setIcon(addIcon, 'plus-circle');
    let editingModelId: string | null = null;

    const addPanel = detail.createDiv({ cls: 'ailu-provider-model-add is-hidden' });
    const addIdInput = addPanel.createEl('input', {
      attr: {
        type: 'text',
        placeholder: '模型 ID，例如 deepseek-chat',
      },
    });
    const addNameInput = addPanel.createEl('input', {
      attr: {
        type: 'text',
        placeholder: '显示名称，可选',
      },
    });
    const addConfirm = addPanel.createEl('button', { text: '添加', attr: { type: 'button' } });
    const addCancel = addPanel.createEl('button', {
      cls: 'ailu-provider-icon-btn',
      attr: { type: 'button', 'aria-label': '取消添加模型' },
    });
    setIcon(addCancel, 'x');
    addModel.onclick = () => showModelAddPanel();
    addConfirm.onclick = () => upsertInlineModel();
    addCancel.onclick = () => hideModelAddPanel();
    const submitAddOnKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        upsertInlineModel();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideModelAddPanel();
      }
    };
    addIdInput.addEventListener('keydown', submitAddOnKey);
    addNameInput.addEventListener('keydown', submitAddOnKey);

    const modelList = detail.createDiv({ cls: 'ailu-provider-model-list' });
    function showModelAddPanel(model?: ProviderModelPreset): void {
      editingModelId = model?.id ?? null;
      addPanel.removeClass('is-hidden');
      addConfirm.setText(model ? '保存' : '添加');
      addIdInput.value = model?.id ?? '';
      addNameInput.value = model?.name ?? '';
      addIdInput.focus();
      addIdInput.select();
    }

    function hideModelAddPanel(): void {
      editingModelId = null;
      addConfirm.setText('添加');
      addPanel.addClass('is-hidden');
    }

    function upsertInlineModel(): void {
      const id = addIdInput.value.trim();
      if (!id) {
        new Notice('请输入模型 ID。');
        addIdInput.focus();
        return;
      }
      const existing = modelItems.find(model => model.id === id && model.id !== editingModelId);
      if (existing) {
        selectedModelId = existing.id;
        renderModelCards();
        hideModelAddPanel();
        new Notice('模型已存在，已选中该模型。');
        return;
      }
      const next = {
        id,
        name: addNameInput.value.trim() || modelNameFromId(id),
      };
      if (editingModelId) {
        modelItems = mergeModelItems(modelItems.map(model => model.id === editingModelId ? next : model));
        if (selectedModelId === editingModelId) {
          selectedModelId = next.id;
        }
      } else {
        modelItems = mergeModelItems([...modelItems, next]);
      }
      selectedModelId = next.id;
      renderModelCards();
      hideModelAddPanel();
    }

    function renderModelCards(): void {
      modelList.empty();
      if (modelItems.length === 0) {
        modelList.createDiv({ cls: 'ailu-provider-empty', text: '暂无模型，请手动添加或获取模型列表。' });
        return;
      }
      for (const model of modelItems) {
        const card = modelList.createDiv({ cls: 'ailu-provider-model-card' });
        card.toggleClass('is-selected', model.id === selectedModelId);
        card.onclick = () => {
          selectedModelId = model.id;
          renderModelCards();
        };
        card.createSpan({ cls: 'ailu-provider-model-dot' });
        const copy = card.createDiv();
        copy.createDiv({ cls: 'ailu-provider-model-name', text: model.name });
        copy.createDiv({ cls: 'ailu-provider-model-id', text: model.id });
        const actions = card.createDiv({ cls: 'ailu-provider-model-card-actions' });
        const edit = actions.createEl('button', {
          cls: 'ailu-provider-icon-btn',
          attr: { type: 'button', 'aria-label': '编辑模型' },
        });
        setIcon(edit, 'pencil');
        edit.onclick = event => {
          event.stopPropagation();
          selectedModelId = model.id;
          showModelAddPanel(model);
          renderModelCards();
        };
        const remove = actions.createEl('button', {
          cls: 'ailu-provider-icon-btn',
          attr: { type: 'button', 'aria-label': '删除模型' },
        });
        setIcon(remove, 'trash-2');
        remove.onclick = event => {
          event.stopPropagation();
          modelItems = modelItems.filter(item => item.id !== model.id);
          if (selectedModelId === model.id) {
            selectedModelId = modelItems[0]?.id ?? '';
          }
          if (editingModelId === model.id) {
            hideModelAddPanel();
          }
          renderModelCards();
        };
      }
    }
    renderModelCards();

    const footer = detail.createDiv({ cls: 'ailu-provider-footer' });
    const cancel = footer.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.onclick = () => this.display();
    const save = footer.createEl('button', {
      cls: 'mod-cta',
      text: '保存',
      attr: { type: 'button' },
    });
    save.onclick = () => void this.saveProviderPresetProfile({
      preset,
      agentFilter,
      format,
      baseUrl: baseUrlInput.value,
      apiKey: resolveSecretInput(apiKeyInput.value, anyExistingProfile?.apiKey ?? ''),
      existingApiKey: anyExistingProfile?.apiKey ?? '',
      models: modelItems,
      defaultModel: selectedModelId || modelItems[0]?.id || '',
      anthropicAuthMode,
    });
  }

  private resolveInitialProviderFormat(
    preset: ProviderPreset,
    profile: ProviderProfile | null,
    agentFilter?: AgentId,
  ): ProviderApiFormat {
    if (agentFilter) {
      return supportedProviderFormat(preset, providerFormatForAgent(agentFilter));
    }
    if (profile) {
      return supportedProviderFormat(preset, providerFormatForAgent(profile.agentId));
    }
    return supportedProviderFormat(preset, preset.defaultApiFormat);
  }

  private findPresetProfile(preset: ProviderPreset, agentId?: AgentId): ProviderProfile | null {
    const profiles = this.deps.providerStore.list(agentId);
    const names = new Set([preset.key, preset.label, preset.label.toLowerCase()]);
    return profiles.find(profile => names.has(profile.name) || names.has(profile.name.toLowerCase())) ?? null;
  }

  private async exportProviderProfiles(): Promise<void> {
    try {
      await navigator.clipboard.writeText(JSON.stringify(this.deps.providerStore.exportProfiles(), null, 2));
      new Notice('已复制脱敏模型配置。');
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '复制模型配置失败。'));
    }
  }

  private async importProviderProfiles(): Promise<void> {
    // Electron does not implement window.prompt; collect the JSON via a modal.
    const importText = await promptForText(this.app, {
      title: '导入模型配置',
      placeholder: '粘贴导出的 Provider Profiles JSON',
      multiline: true,
      submitLabel: '导入',
      cancelLabel: '取消',
    });
    if (!importText?.trim()) return;
    try {
      const parsed: unknown = JSON.parse(importText);
      const imported = await this.deps.providerStore.importProfiles(parsed);
      new Notice(`已导入 ${imported.length} 个模型配置。`);
      this.display();
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '导入模型配置失败，请检查 JSON 内容。'));
    }
  }

  private async loadModelsIntoPanel(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    getFormat: () => ProviderApiFormat;
    getAnthropicAuthMode: () => AnthropicAuthMode;
    baseUrlInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    existingApiKey: string;
    setModels: (models: ProviderModelPreset[]) => void;
    renderModelCards: () => void;
    trigger: HTMLButtonElement;
    noticePrefix: string;
  }): Promise<void> {
    options.trigger.disabled = true;
    try {
      const format = options.getFormat();
      const apiKey = resolveSecretInput(options.apiKeyInput.value, options.existingApiKey);
      const altFormat: ProviderApiFormat = format === 'anthropic' ? 'openai' : 'anthropic';
      const altBaseUrl = options.preset.baseUrls[altFormat];
      const { models: fetched, source } = await resolveProviderModels({
        primary: {
          agentId: options.agentFilter ?? providerAgentForFormat(format),
          baseUrl: options.baseUrlInput.value,
          apiKey,
          anthropicAuthMode: options.getAnthropicAuthMode(),
        },
        fallback: altBaseUrl
          ? { agentId: providerAgentForFormat(altFormat), baseUrl: altBaseUrl, apiKey }
          : undefined,
        presetModelIds: options.preset.models.map(model => model.id),
      });
      const modelItems = mergeModelItems(fetched.map(id => {
        const presetModel = options.preset.models.find(model => model.id === id);
        return {
          id,
          name: presetModel?.name ?? modelNameFromId(id),
        };
      }));
      options.setModels(modelItems);
      options.renderModelCards();
      const sourceNote = source === 'fallback'
        ? '（已从兼容端点获取）'
        : source === 'preset'
          ? '（该端点未提供模型列表，已载入内置模型，可手动添加）'
          : '';
      new Notice(`${options.noticePrefix} ${modelItems.length} 个模型。${sourceNote}`);
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '读取模型列表失败，请检查服务地址和密钥。'));
    } finally {
      options.trigger.disabled = false;
    }
  }

  private async testProviderConfiguration(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    getFormat: () => ProviderApiFormat;
    getAnthropicAuthMode: () => AnthropicAuthMode;
    getModel: () => string;
    baseUrlInput: HTMLInputElement;
    apiKeyInput: HTMLInputElement;
    existingApiKey: string;
    trigger: HTMLButtonElement;
  }): Promise<void> {
    options.trigger.disabled = true;
    try {
      const format = options.getFormat();
      const agentId = options.agentFilter ?? providerAgentForFormat(format);
      await testProviderConnection({
        agentId,
        baseUrl: options.baseUrlInput.value,
        apiKey: resolveSecretInput(options.apiKeyInput.value, options.existingApiKey),
        anthropicAuthMode: options.getAnthropicAuthMode(),
        model: options.getModel(),
        wireApi: providerWireApi(options.preset, format),
      });
      new Notice(`连接成功：${options.getModel()}`);
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '连接模型服务失败，请检查配置后重试。'));
    } finally {
      options.trigger.disabled = false;
    }
  }

  private async saveProviderPresetProfile(options: {
    preset: ProviderPreset;
    agentFilter?: AgentId;
    format: ProviderApiFormat;
    baseUrl: string;
    apiKey: string;
    existingApiKey: string;
    models: ProviderModelPreset[];
    defaultModel: string;
    anthropicAuthMode: AnthropicAuthMode;
  }): Promise<void> {
    try {
      const targetAgent = options.agentFilter ?? providerAgentForFormat(options.format);
      if (targetAgent === 'codex') {
        throw new Error('Codex 不使用普通兼容供应商，请选择本机 App Server。');
      }
      const existing = this.findPresetProfile(options.preset, targetAgent);
      const baseUrl = options.baseUrl.trim() || options.preset.baseUrls[options.format];
      const apiKey = options.apiKey || options.existingApiKey;
      if (requiresProviderApiKey(baseUrl) && !apiKey.trim()) {
        throw new Error('远程模型服务需要 API Key，请重新输入后保存。');
      }
      const profile = await this.deps.providerStore.save({
        agentId: targetAgent,
        id: existing?.id,
        name: options.preset.label,
        defaultModel: options.defaultModel,
        models: options.models.map(model => model.id),
        baseUrl,
        apiKey,
        wireApi: providerWireApi(options.preset, options.format),
        anthropicAuthMode: targetAgent === 'claude' ? options.anthropicAuthMode : undefined,
        isDefault: true,
      });
      const settings = this.deps.getSettings();
      settings.providerProfileByAgent[targetAgent] = profile.id;
      settings.configSources[targetAgent] = 'providerProfile';
      await this.deps.saveSettings();
      this.deps.refreshViews();
      new Notice(`${options.preset.label} 模型配置已保存到 ${getAgentDescriptor(targetAgent).shortName}。`);
      this.display();
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '保存模型配置失败。'));
    }
  }

  private async setProfileDefault(profile: ProviderProfile): Promise<void> {
    try {
      await this.deps.providerStore.setDefault(profile.agentId, profile.id);
      const settings = this.deps.getSettings();
      settings.providerProfileByAgent[profile.agentId] = profile.id;
      await this.deps.saveSettings();
      this.display();
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '设置默认模型配置失败。'));
    }
  }

  private async deleteProfile(id: string): Promise<void> {
    const removed = await this.deps.providerStore.remove(id);
    if (!removed) return;
    const settings = this.deps.getSettings();
    if (settings.providerProfileByAgent[removed.agentId] === id) {
      settings.providerProfileByAgent[removed.agentId] = this.deps.providerStore.find(removed.agentId)?.id ?? '';
      await this.deps.saveSettings();
    }
    if (this.editingProfileId === id) {
      this.editingProfileId = null;
    }
    this.display();
  }

  private renderProfileForm(section: HTMLElement, agentFilter?: AgentId): void {
    const editing = this.editingProfileId
      ? this.deps.providerStore.list().find(profile => profile.id === this.editingProfileId) ?? null
      : null;
    const form = section.createDiv({ cls: 'ailu-provider-form' });
    new Setting(form).setName(editing ? '编辑供应商配置' : '添加供应商配置').setHeading();
    const agent = form.createEl('select');
    for (const agentId of SELECTABLE_AGENT_IDS) {
      agent.createEl('option', { text: getAgentDescriptor(agentId).displayName, value: agentId });
    }
    agent.value = editing?.agentId ?? agentFilter ?? 'claude';
    agent.disabled = Boolean(agentFilter);

    const name = form.createEl('input', { attr: { placeholder: 'Profile name' } });
    name.value = editing?.name ?? '';
    const defaultModel = form.createEl('input', { attr: { placeholder: 'Default model' } });
    defaultModel.value = editing?.defaultModel || editing?.model || '';
    const baseUrl = form.createEl('input', { attr: { placeholder: 'Base URL' } });
    baseUrl.value = editing?.baseUrl ?? '';
    const wireApi = form.createEl('select');
    wireApi.createEl('option', { text: 'Chat completions', value: 'chat' });
    wireApi.createEl('option', { text: 'Responses API', value: 'responses' });
    wireApi.value = editing?.wireApi ?? 'chat';

    const models = form.createEl('textarea', { cls: 'full', attr: { placeholder: 'Models, one per line' } });
    models.rows = 4;
    models.value = (editing?.models ?? []).join('\n');
    const apiKey = form.createEl('input', { attr: { placeholder: 'API key', type: 'password' } });
    apiKey.addClass('full');
    initializeStoredSecretInput(apiKey, Boolean(editing?.apiKey));

    const load = form.createEl('button', { text: '加载模型' });
    load.onclick = () => {
      void this.loadProviderModels({
        agent,
        baseUrl,
        apiKey,
        existingApiKey: editing?.apiKey ?? '',
        models,
        defaultModel,
      });
    };

    const save = form.createEl('button', { text: editing ? 'Save profile' : 'Add profile' });
    save.onclick = () => void this.saveProfileForm({
      editing,
      agent,
      name,
      defaultModel,
      models,
      baseUrl,
      apiKey,
      wireApi,
    });

    if (editing) {
      const cancel = form.createEl('button', { text: '取消编辑' });
      cancel.onclick = () => {
        this.editingProfileId = null;
        this.display();
      };
    }
  }

  private async loadProviderModels(elements: {
    agent: HTMLSelectElement;
    baseUrl: HTMLInputElement;
    apiKey: HTMLInputElement;
    existingApiKey: string;
    models: HTMLTextAreaElement;
    defaultModel: HTMLInputElement;
  }): Promise<void> {
    try {
      const fetched = await fetchProviderModels({
        agentId: elements.agent.value as AgentId,
        baseUrl: elements.baseUrl.value,
        apiKey: resolveSecretInput(elements.apiKey.value, elements.existingApiKey),
      });
      elements.models.value = fetched.join('\n');
      if (!elements.defaultModel.value && fetched[0]) {
        elements.defaultModel.value = fetched[0];
      }
      new Notice(`已读取 ${fetched.length} 个模型。`);
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '读取供应商模型失败，请检查服务地址和密钥。'));
    }
  }

  private async saveProfileForm(elements: {
    editing: ProviderProfile | null;
    agent: HTMLSelectElement;
    name: HTMLInputElement;
    defaultModel: HTMLInputElement;
    models: HTMLTextAreaElement;
    baseUrl: HTMLInputElement;
    apiKey: HTMLInputElement;
    wireApi: HTMLSelectElement;
  }): Promise<void> {
    try {
      const modelList = parseModelList(elements.models.value);
      const profile = await this.deps.providerStore.save({
        agentId: elements.agent.value as AgentId,
        id: elements.editing?.id,
        name: elements.name.value,
        defaultModel: elements.defaultModel.value,
        models: modelList,
        baseUrl: elements.baseUrl.value,
        apiKey: resolveSecretInput(elements.apiKey.value, elements.editing?.apiKey ?? ''),
        wireApi: elements.wireApi.value as ProviderWireApi,
        isDefault: elements.editing?.isDefault,
      });
      const settings = this.deps.getSettings();
      if (elements.editing && elements.editing.agentId !== profile.agentId
        && settings.providerProfileByAgent[elements.editing.agentId] === profile.id) {
        settings.providerProfileByAgent[elements.editing.agentId] = this.deps.providerStore.find(elements.editing.agentId)?.id ?? '';
      }
      settings.providerProfileByAgent[profile.agentId] = profile.id;
      await this.deps.saveSettings();
      this.editingProfileId = null;
      this.display();
    } catch (error) {
      new Notice(userFacingErrorMessage(error, '保存供应商配置失败。'));
    }
  }

  private renderImportExport(section: HTMLElement): void {
    new Setting(section)
      .setName('导出供应商配置')
      .setDesc('复制已脱敏的供应商配置到剪贴板。')
      .addButton(button => {
        button.setButtonText('复制脱敏 JSON').onClick(async () => {
          await navigator.clipboard.writeText(JSON.stringify(this.deps.providerStore.exportProfiles(), null, 2));
          new Notice('已复制脱敏后的供应商配置。');
        });
      });

    let importText = '';
    new Setting(section)
      .setName('导入供应商配置')
      .setDesc('粘贴导出的 Provider Profiles JSON；脱敏 API Key 会按空值导入。')
      .addTextArea(text => {
        text.inputEl.rows = 5;
        text.setPlaceholder('[{"agentId":"codex","name":"OpenAI","defaultModel":"gpt-5.4"}]')
          .onChange(value => {
            importText = value;
          });
      });
    new Setting(section)
      .addButton(button => {
        button.setButtonText('导入 JSON').onClick(async () => {
          try {
            const parsed: unknown = JSON.parse(importText);
            const imported = await this.deps.providerStore.importProfiles(parsed);
            new Notice(`已导入 ${imported.length} 个供应商配置。`);
            this.display();
          } catch (error) {
            new Notice(userFacingErrorMessage(error, '导入供应商配置失败，请检查 JSON 内容。'));
          }
        });
      });
  }

  private renderEnvironment(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'ailu-settings-section' });
    new Setting(section).setName('运行环境').setHeading();
    const settings = this.deps.getSettings();
    new Setting(section)
      .setName('系统提示词')
      .setDesc('可选；添加到对话和行内修改任务前的统一指令。')
      .addTextArea(text => {
        text.inputEl.rows = 4;
        text
          .setValue(settings.systemPrompt)
          .onChange(async value => {
            settings.systemPrompt = value;
            await this.deps.saveSettings();
          });
      });
  }

  private renderSkills(containerEl: HTMLElement, agentId: AgentId): void {
    const section = containerEl.createDiv({ cls: 'ailu-settings-section ailu-skills-section' });
    const disclosure = section.createEl('details', { cls: 'ailu-skills-disclosure' });
    const summary = disclosure.createEl('summary', { cls: 'ailu-skills-summary' });
    const disclosureIcon = summary.createSpan({ cls: 'ailu-skills-disclosure-icon' });
    setIcon(disclosureIcon, 'chevron-right');
    const summaryCopy = summary.createSpan({ cls: 'ailu-skills-summary-copy' });
    summaryCopy.createEl('strong', { text: '本机 Skills' });
    summaryCopy.createSpan({
      text: `自动读取 ${getAgentDescriptor(agentId).shortName} 能看到的 Skills；只有你勾选的才会出现在对话中。`,
    });
    const status = summary.createSpan({ cls: 'ailu-skills-count', text: '载入中…' });
    const content = disclosure.createDiv({ cls: 'ailu-skills-content' });
    void this.loadAndRenderSkills(content, status, agentId);
  }

  private async loadAndRenderSkills(
    content: HTMLElement,
    status: HTMLElement,
    agentId: AgentId,
  ): Promise<void> {
    content.empty();
    status.removeClass('is-error');
    status.setText('载入中…');
    let skills: Awaited<ReturnType<typeof loadLocalSkills>>;
    try {
      skills = await loadLocalSkills(agentId);
    } catch (error) {
      status.addClass('is-error');
      status.setText('读取失败');
      content.createEl('p', {
        cls: 'setting-item-description ailu-skills-error',
        text: userFacingErrorMessage(error, '无法读取本机 Skills，请检查安装目录。'),
      });
      return;
    }
    const isPi = agentId === 'pi';
    const selectedNames = (): string[] => (
      isPi ? this.deps.getSettings().piSkillNames : this.deps.getSettings().creativeSkillNames
    );
    const enabled = filterCreativeSkills(skills, selectedNames());
    status.setText(`${enabled.length}/${skills.length} 已选`);
    content.createEl('p', {
      cls: 'setting-item-description',
      text: isPi
        ? '勾选只对 Pi 生效，与 Claude Code / Codex 的选择互不影响。Pi 发送时只加载勾选的 Skill，未勾选的不会自动加载。'
        : '勾选结果由 Claude Code 与 Codex 共用。Ailu 不会安装、上传或自动启用本机 Skill。',
    });

    if (skills.length === 0) {
      content.createEl('p', {
        cls: 'ailu-skills-empty',
        text: '当前没有找到可用的创作 Skill。刷新后仍为空时，请检查本机 Skill 安装目录。',
      });
    } else {
      const tableWrap = content.createDiv({ cls: 'ailu-skills-table-wrap' });
      const table = tableWrap.createEl('table', { cls: 'ailu-skills-table' });
      const thead = table.createEl('thead');
      const headerRow = thead.createEl('tr');
      headerRow.createEl('th', { text: '启用', attr: { scope: 'col' } });
      headerRow.createEl('th', { text: '名称', attr: { scope: 'col' } });
      headerRow.createEl('th', { text: '来源', attr: { scope: 'col' } });
      headerRow.createEl('th', { text: '说明', attr: { scope: 'col' } });
      const tbody = table.createEl('tbody');

      for (const skill of skills) {
        const row = tbody.createEl('tr');
        const enabledCell = row.createEl('td');
        const checkbox = enabledCell.createEl('input', {
          attr: { type: 'checkbox', 'aria-label': `启用 ${skill.name}` },
        });
        checkbox.checked = selectedNames().includes(skill.name);
        checkbox.onchange = () => {
          const currentSettings = this.deps.getSettings();
          const previous = [...(isPi ? currentSettings.piSkillNames : currentSettings.creativeSkillNames)];
          const selected = new Set(isPi ? currentSettings.piSkillNames : currentSettings.creativeSkillNames);
          if (checkbox.checked) selected.add(skill.name);
          else selected.delete(skill.name);
          if (isPi) currentSettings.piSkillNames = [...selected];
          else currentSettings.creativeSkillNames = [...selected];
          void this.deps.saveSettings().then(() => {
            const count = filterCreativeSkills(
              skills,
              isPi ? this.deps.getSettings().piSkillNames : this.deps.getSettings().creativeSkillNames,
            ).length;
            status.setText(`${count}/${skills.length} 已选`);
          }).catch(error => {
            currentSettings.creativeSkillNames = previous;
            checkbox.checked = !checkbox.checked;
            new Notice(userFacingErrorMessage(error, '保存 Skill 选择失败。'));
          });
        };
        row.createEl('td', { text: skill.name, cls: 'ailu-skill-name' });
        row.createEl('td', { text: skill.sourceLabel, cls: 'ailu-skill-source' });
        const description = row.createEl('td', { cls: 'ailu-skill-description' });
        description.createSpan({ text: formatSkillDescription(skill.description) });
      }
    }

    const footer = content.createDiv({ cls: 'ailu-skills-footer' });
    const refresh = footer.createEl('button', {
      cls: 'ailu-skill-refresh-button',
      text: '刷新',
      attr: { type: 'button' },
    });
    refresh.onclick = () => {
      invalidateSkillCache(agentId);
      void this.loadAndRenderSkills(content, status, agentId);
    };
  }

  private renderPrivacy(containerEl: HTMLElement): void {
    const section = containerEl.createDiv({ cls: 'ailu-settings-section' });
    new Setting(section).setName('隐私与存储').setHeading();
    const locations = section.createEl('dl', { cls: 'ailu-storage-locations' });
    for (const [label, value] of [
      ['对话', `${this.app.vault.getName()}/${STORAGE_IDS.vaultDirectoryName}/`],
      ['全局目录', ailuHome()],
      ['供应商配置', providersPath()],
      ['临时运行目录', tmpDir()],
      ['本地日志', logsDir()],
    ]) {
      locations.createEl('dt', { text: label });
      locations.createEl('dd').createEl('code', { text: value });
    }
    section.createEl('p', {
      cls: 'ailu-settings-footnote',
      text: 'Agent 可执行文件只检测和调用，不由插件安装或更新。',
    });
    new Setting(section)
      .setName('脱敏诊断')
      .setDesc('提交问题时只复制这份诊断；不要上传日志目录、Cookie 文件、截图或草稿链接。')
      .addButton(button => button
        .setButtonText('复制脱敏诊断')
        .onClick(async () => {
          try {
            await navigator.clipboard.writeText(buildRedactedDiagnosticBundle({
              pluginVersion: this.deps.pluginVersion,
            }));
            new Notice('脱敏诊断已复制，不包含正文、路径、草稿链接或凭据。');
          } catch (error) {
            new Notice(userFacingErrorMessage(error, '复制脱敏诊断失败。'));
          }
        }));
  }

}
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}…`;
}

function formatSkillDescription(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || /^[|>+-]+$/.test(normalized)) return '暂无说明';
  return truncate(normalized, 180);
}

function parseModelList(value: string): string[] {
  return [...new Set(value
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(Boolean))];
}

function supportedProviderFormat(preset: ProviderPreset, preferred: ProviderApiFormat): ProviderApiFormat {
  if (preset.baseUrls[preferred]) {
    return preferred;
  }
  if (preset.baseUrls[preset.defaultApiFormat]) {
    return preset.defaultApiFormat;
  }
  return preset.baseUrls.anthropic ? 'anthropic' : 'openai';
}

function providerAgentForFormat(format: ProviderApiFormat): AgentId {
  return format === 'anthropic' ? 'claude' : 'codex';
}

function providerFormatForAgent(agentId: AgentId): ProviderApiFormat {
  return agentId === 'claude' ? 'anthropic' : 'openai';
}

function providerFormatLabel(format: ProviderApiFormat): string {
  return format === 'anthropic' ? 'Anthropic 兼容' : 'OpenAI 兼容';
}

function providerWireApi(preset: ProviderPreset, format: ProviderApiFormat): ProviderWireApi {
  if (preset.key === 'openai' && format === 'openai') {
    return 'responses';
  }
  return 'chat';
}

function toModelItems(profile: ProviderProfile | null, preset: ProviderPreset): ProviderModelPreset[] {
  const ids = profile
    ? [...profile.models, ...preset.models.map(model => model.id)]
    : preset.models.map(model => model.id);
  const items = ids.map(id => {
    const presetModel = preset.models.find(model => model.id === id);
    return {
      id,
      name: presetModel?.name ?? modelNameFromId(id),
    };
  });
  const activeModel = profile?.defaultModel || profile?.model || '';
  if (activeModel && !items.some(item => item.id === activeModel)) {
    items.unshift({ id: activeModel, name: modelNameFromId(activeModel) });
  }
  return mergeModelItems(items);
}

function mergeModelItems(items: ProviderModelPreset[]): ProviderModelPreset[] {
  const seen = new Set<string>();
  const merged: ProviderModelPreset[] = [];
  for (const item of items) {
    const id = item.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push({
      id,
      name: item.name.trim() || modelNameFromId(id),
    });
  }
  return merged;
}

function modelNameFromId(id: string): string {
  return id
    .split(/[/:_-]/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}
