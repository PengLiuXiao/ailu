import { App, Modal, setIcon } from 'obsidian';

import {
  defaultFeishuDestination,
  feishuDestinationIdentity,
  feishuDestinationLabel,
  type FeishuDestinationSelection,
} from '../feishu/destination';
import type { LarkCliService } from '../feishu/larkCli';
import type {
  FeishuDriveFolder,
  FeishuWikiNode,
  FeishuWikiSpace,
} from '../feishu/types';
import { userFacingErrorMessage } from '../utils/userFacingError';

type DestinationTreeKind =
  | 'personal-root'
  | 'drive-group'
  | 'drive-folder'
  | 'wiki-group'
  | 'wiki-space'
  | 'wiki-node';

interface DestinationTreeNode {
  key: string;
  kind: DestinationTreeKind;
  label: string;
  path: string;
  token: string;
  url: string;
  spaceId: string;
  selectable: boolean;
  expandable: boolean;
}

const PERSONAL_ROOT_KEY = 'personal-root';
const DRIVE_GROUP_KEY = 'drive-group';
const WIKI_GROUP_KEY = 'wiki-group';

export function promptForFeishuDestination(
  app: App,
  cli: LarkCliService,
  initial: FeishuDestinationSelection,
): Promise<FeishuDestinationSelection | null> {
  return new Promise(resolve => {
    new FeishuDestinationModal(app, cli, initial, resolve).open();
  });
}

class FeishuDestinationModal extends Modal {
  private readonly children = new Map<string, DestinationTreeNode[]>();
  private readonly expanded = new Set<string>();
  private readonly loaded = new Set<string>();
  private readonly loading = new Set<string>();
  private readonly errors = new Map<string, string>();
  private selected: FeishuDestinationSelection;
  private rootsLoading = true;
  private rootsError: string | null = null;
  private submitted = false;
  private closed = false;

  constructor(
    app: App,
    private readonly cli: LarkCliService,
    initial: FeishuDestinationSelection,
    private readonly resolve: (value: FeishuDestinationSelection | null) => void,
  ) {
    super(app);
    this.selected = initial;
  }

  override onOpen(): void {
    this.modalEl.addClass('ailu-feishu-destination-modal');
    this.titleEl.setText('选择飞书保存位置');
    this.render();
    void this.loadRoots();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.resolve(this.submitted ? this.selected : null);
  }

  private async loadRoots(): Promise<void> {
    if (this.rootsLoading && this.loaded.size) return;
    this.rootsLoading = true;
    this.rootsError = null;
    this.renderIfOpen();
    try {
      const [driveFolders, wikiSpaces, personalNodes] = await Promise.all([
        this.cli.listDriveFolders(),
        this.cli.listWikiSpaces(),
        this.cli.listWikiNodes('my_library'),
      ]);
      if (this.closed) return;
      this.children.set(DRIVE_GROUP_KEY, driveFolders.map(folder => this.driveNode(folder, '云盘')));
      this.children.set(WIKI_GROUP_KEY, wikiSpaces.map(space => this.wikiSpaceNode(space)));
      this.children.set(
        PERSONAL_ROOT_KEY,
        personalNodes.map(node => this.wikiNode(node, '个人文档库')),
      );
      this.loaded.add(DRIVE_GROUP_KEY);
      this.loaded.add(WIKI_GROUP_KEY);
      this.loaded.add(PERSONAL_ROOT_KEY);
    } catch (error) {
      this.rootsError = userFacingErrorMessage(error, '读取飞书目录失败，请重新检查连接。');
    } finally {
      this.rootsLoading = false;
      this.renderIfOpen();
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      cls: 'ailu-feishu-destination-intro',
      text: '只读浏览飞书目录。位置变更只影响以后新建的文档。',
    });

    const current = contentEl.createDiv({ cls: 'ailu-feishu-destination-current' });
    const currentIcon = current.createSpan({ cls: 'ailu-feishu-destination-current-icon' });
    setIcon(currentIcon, 'map-pin');
    const currentCopy = current.createDiv({ cls: 'ailu-feishu-destination-current-copy' });
    currentCopy.createSpan({ text: '当前保存到' });
    currentCopy.createEl('strong', { text: feishuDestinationLabel(this.selected) });
    current.createSpan({
      cls: 'ailu-feishu-destination-current-note',
      text: '仅影响新建文档',
    });

    const picker = contentEl.createDiv({ cls: 'ailu-feishu-destination-picker' });
    const pickerHeader = picker.createDiv({ cls: 'ailu-feishu-destination-picker-header' });
    const pickerTitle = pickerHeader.createDiv({ cls: 'ailu-feishu-destination-picker-title' });
    const pickerIcon = pickerTitle.createSpan();
    setIcon(pickerIcon, 'folder-tree');
    pickerTitle.createEl('strong', { text: '选择保存位置' });
    pickerHeader.createSpan({ text: '一次展开一个目录' });

    const tree = picker.createDiv({
      cls: 'ailu-feishu-destination-tree',
      attr: {
        role: 'tree',
        'aria-label': '飞书文档保存位置',
      },
    });
    if (this.rootsLoading) {
      this.renderLoadingRow(tree, '正在读取完整目录入口…', 0);
    } else if (this.rootsError) {
      this.renderRootError(tree);
    } else {
      for (const node of this.rootNodes()) this.renderNode(tree, node, 0);
    }

    const footnote = contentEl.createDiv({ cls: 'ailu-feishu-destination-footnote' });
    const footnoteIcon = footnote.createSpan();
    setIcon(footnoteIcon, 'info');
    footnote.createSpan({
      text: '团队知识库需选择具体节点；个人文档库和云盘文件夹可直接保存。',
    });
    const actions = contentEl.createDiv({ cls: 'ailu-feishu-destination-modal-actions' });
    const cancel = actions.createEl('button', {
      text: '取消',
      attr: { type: 'button' },
    });
    cancel.onclick = () => this.close();
    const save = actions.createEl('button', {
      cls: 'mod-cta',
      text: '使用此位置',
      attr: { type: 'button' },
    });
    save.disabled = this.rootsLoading || Boolean(this.rootsError);
    save.onclick = () => {
      this.submitted = true;
      this.close();
    };
  }

  private rootNodes(): DestinationTreeNode[] {
    return [
      {
        key: PERSONAL_ROOT_KEY,
        kind: 'personal-root',
        label: '个人文档库',
        path: '个人文档库',
        token: '',
        url: '',
        spaceId: 'my_library',
        selectable: true,
        expandable: true,
      },
      {
        key: DRIVE_GROUP_KEY,
        kind: 'drive-group',
        label: '云盘文件夹',
        path: '云盘',
        token: '',
        url: '',
        spaceId: '',
        selectable: false,
        expandable: true,
      },
      {
        key: WIKI_GROUP_KEY,
        kind: 'wiki-group',
        label: '知识库',
        path: '知识库',
        token: '',
        url: '',
        spaceId: '',
        selectable: false,
        expandable: true,
      },
    ];
  }

  private renderNode(parent: HTMLElement, node: DestinationTreeNode, depth: number): void {
    const selected = this.isSelected(node);
    const branchSelected = this.isBranchSelected(node);
    const expanded = this.expanded.has(node.key);
    const row = parent.createDiv({
      cls: [
        'ailu-feishu-destination-tree-row',
        depth === 0 ? 'ailu-feishu-destination-tree-row--root' : '',
        selected ? 'ailu-feishu-destination-tree-row--selected' : '',
        branchSelected ? 'ailu-feishu-destination-tree-row--branch' : '',
        expanded ? 'ailu-feishu-destination-tree-row--expanded' : '',
      ].filter(Boolean).join(' '),
      attr: {
        role: 'treeitem',
        'aria-level': String(depth + 1),
        'aria-selected': String(selected),
        ...(selected ? { 'aria-current': 'true' } : {}),
        ...(node.expandable ? { 'aria-expanded': String(expanded) } : {}),
      },
    });

    if (node.expandable) {
      const expand = row.createEl('button', {
        cls: 'ailu-feishu-destination-expander',
        attr: {
          type: 'button',
          'aria-label': `${this.expanded.has(node.key) ? '收起' : '展开'}${node.label}`,
        },
      });
      setIcon(expand, expanded ? 'chevron-down' : 'chevron-right');
      expand.onclick = () => void this.toggleNode(node);
    } else {
      row.createSpan({ cls: 'ailu-feishu-destination-expander-spacer' });
    }

    const meta = this.metaForNode(node);
    const main = row.createEl('button', {
      cls: 'ailu-feishu-destination-tree-main',
      attr: {
        type: 'button',
        title: meta ? `${node.path} · ${meta}` : node.path,
        'aria-label': meta ? `${node.label}，${meta}` : node.label,
      },
    });
    const icon = main.createSpan({ cls: 'ailu-feishu-destination-tree-icon' });
    setIcon(icon, this.iconForNode(node));
    const copy = main.createDiv({ cls: 'ailu-feishu-destination-tree-copy' });
    copy.createEl('strong', { text: node.label });
    if (selected) {
      const selected = main.createSpan({
        cls: 'ailu-feishu-destination-tree-selected',
        attr: { 'aria-label': '当前选择' },
      });
      setIcon(selected, 'check');
    } else if (branchSelected) {
      main.createSpan({
        cls: 'ailu-feishu-destination-tree-branch-badge',
        text: '当前',
      });
    } else if (depth === 0) {
      const childCount = this.children.get(node.key)?.length;
      if (typeof childCount === 'number') {
        main.createSpan({
          cls: 'ailu-feishu-destination-tree-count',
          text: String(childCount),
          attr: { 'aria-label': `${childCount} 个入口` },
        });
      }
    }
    main.onclick = () => {
      if (node.selectable) {
        this.selected = this.selectionForNode(node);
        this.render();
      } else if (node.expandable) {
        void this.toggleNode(node);
      }
    };

    if (!expanded) return;
    const children = parent.createDiv({ cls: 'ailu-feishu-destination-tree-children' });
    if (this.loading.has(node.key)) {
      this.renderLoadingRow(children, '正在读取下一级…', depth + 1);
      return;
    }
    const error = this.errors.get(node.key);
    if (error) {
      this.renderNodeError(children, node, error, depth + 1);
      return;
    }
    const nested = this.children.get(node.key) ?? [];
    if (!nested.length) {
      children.createDiv({
        cls: 'ailu-feishu-destination-tree-empty',
        text: '没有下一级目录',
        attr: { style: `--ailu-feishu-tree-depth:${depth + 1}` },
      });
      return;
    }
    for (const child of nested) this.renderNode(children, child, depth + 1);
  }

  private async toggleNode(node: DestinationTreeNode): Promise<void> {
    if (this.expanded.has(node.key)) {
      this.expanded.delete(node.key);
      this.renderIfOpen();
      return;
    }
    if ([PERSONAL_ROOT_KEY, DRIVE_GROUP_KEY, WIKI_GROUP_KEY].includes(node.key)) {
      for (const rootKey of [PERSONAL_ROOT_KEY, DRIVE_GROUP_KEY, WIKI_GROUP_KEY]) {
        if (rootKey !== node.key) this.expanded.delete(rootKey);
      }
    }
    this.expanded.add(node.key);
    this.renderIfOpen();
    if (!this.loaded.has(node.key)) await this.loadChildren(node);
  }

  private async loadChildren(node: DestinationTreeNode): Promise<void> {
    if (this.loading.has(node.key)) return;
    this.loading.add(node.key);
    this.errors.delete(node.key);
    this.renderIfOpen();
    try {
      let children: DestinationTreeNode[];
      if (node.kind === 'drive-folder') {
        const folders = await this.cli.listDriveFolders(node.token);
        children = folders.map(folder => this.driveNode(folder, node.path));
      } else if (node.kind === 'wiki-space') {
        const wikiNodes = await this.cli.listWikiNodes(node.spaceId);
        children = wikiNodes.map(child => this.wikiNode(child, node.path));
      } else if (node.kind === 'wiki-node') {
        const wikiNodes = await this.cli.listWikiNodes(node.spaceId, node.token);
        children = wikiNodes.map(child => this.wikiNode(child, node.path));
      } else {
        children = this.children.get(node.key) ?? [];
      }
      if (this.closed) return;
      this.children.set(node.key, children);
      this.loaded.add(node.key);
    } catch (error) {
      if (this.closed) return;
      this.errors.set(
        node.key,
        userFacingErrorMessage(error, '读取下一级目录失败，请稍后重试。'),
      );
    } finally {
      this.loading.delete(node.key);
      this.renderIfOpen();
    }
  }

  private driveNode(folder: FeishuDriveFolder, parentPath: string): DestinationTreeNode {
    const path = `${parentPath} / ${folder.name}`;
    return {
      key: `drive:${folder.token}`,
      kind: 'drive-folder',
      label: folder.name,
      path,
      token: folder.token,
      url: folder.url,
      spaceId: '',
      selectable: true,
      expandable: true,
    };
  }

  private wikiSpaceNode(space: FeishuWikiSpace): DestinationTreeNode {
    return {
      key: `wiki-space:${space.spaceId}`,
      kind: 'wiki-space',
      label: space.name,
      path: `知识库 / ${space.name}`,
      token: '',
      url: '',
      spaceId: space.spaceId,
      selectable: false,
      expandable: true,
    };
  }

  private wikiNode(node: FeishuWikiNode, parentPath: string): DestinationTreeNode {
    return {
      key: `wiki-node:${node.spaceId}:${node.nodeToken}`,
      kind: 'wiki-node',
      label: node.title,
      path: `${parentPath} / ${node.title}`,
      token: node.nodeToken,
      url: '',
      spaceId: node.spaceId,
      selectable: true,
      expandable: node.hasChild,
    };
  }

  private selectionForNode(node: DestinationTreeNode): FeishuDestinationSelection {
    if (node.kind === 'personal-root') return defaultFeishuDestination();
    return {
      kind: node.kind === 'drive-folder' ? 'drive-folder' : 'wiki-node',
      token: node.token,
      name: node.label,
      path: node.path,
      url: node.kind === 'drive-folder' ? node.url : '',
      spaceId: node.kind === 'wiki-node' ? node.spaceId : '',
    };
  }

  private isSelected(node: DestinationTreeNode): boolean {
    if (!node.selectable) return false;
    return feishuDestinationIdentity(this.selectionForNode(node))
      === feishuDestinationIdentity(this.selected);
  }

  private isBranchSelected(node: DestinationTreeNode): boolean {
    return !this.isSelected(node) && this.selected.path.startsWith(`${node.path} / `);
  }

  private iconForNode(node: DestinationTreeNode): string {
    if (node.kind === 'drive-group') return 'hard-drive';
    if (node.kind === 'drive-folder') return 'folder';
    if (node.kind === 'wiki-space' || node.kind === 'wiki-group') return 'library';
    if (node.kind === 'personal-root') return 'book-open';
    return 'file-text';
  }

  private metaForNode(node: DestinationTreeNode): string {
    if (node.kind === 'personal-root') return '可直接保存，也可展开选择下级节点';
    if (node.kind === 'drive-group') return '只显示可作为保存位置的文件夹';
    if (node.kind === 'drive-folder') return '';
    if (node.kind === 'wiki-group') return '展开后选择一个知识库';
    if (node.kind === 'wiki-space') return '展开后选择具体节点';
    return '';
  }

  private renderLoadingRow(parent: HTMLElement, text: string, depth: number): void {
    const row = parent.createDiv({ cls: 'ailu-feishu-destination-tree-status' });
    row.style.setProperty('--ailu-feishu-tree-depth', String(depth));
    const icon = row.createSpan();
    setIcon(icon, 'loader-circle');
    row.createSpan({ text });
  }

  private renderRootError(parent: HTMLElement): void {
    const error = parent.createDiv({ cls: 'ailu-feishu-destination-tree-error' });
    error.createSpan({ text: this.rootsError ?? '读取飞书目录失败。' });
    const retry = error.createEl('button', {
      text: '重试',
      attr: { type: 'button' },
    });
    retry.onclick = () => void this.loadRoots();
  }

  private renderNodeError(
    parent: HTMLElement,
    node: DestinationTreeNode,
    message: string,
    depth: number,
  ): void {
    const error = parent.createDiv({ cls: 'ailu-feishu-destination-tree-error' });
    error.style.setProperty('--ailu-feishu-tree-depth', String(depth));
    error.createSpan({ text: message });
    const retry = error.createEl('button', {
      text: '重试',
      attr: { type: 'button' },
    });
    retry.onclick = () => void this.loadChildren(node);
  }

  private renderIfOpen(): void {
    if (!this.closed && this.contentEl.isConnected) this.render();
  }
}
