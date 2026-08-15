import { App, Modal, Notice } from 'obsidian';

import {
  MemoryWriteError,
  VerifiedMemoryWriteService,
  type MemoryAsserter,
  type MemoryKnowledgeKind,
  type MemorySourceClass,
  type MemoryWritePrepareResult,
  type MemoryWriteTarget,
  type PreparedMemoryWrite,
} from '../memory/verifiedMemoryWrite';
import { AILU_IDS } from '../ids';
import type { AgentId, ChatMessage } from '../types';
import { userFacingErrorText } from '../utils/userFacingError';

const DEFAULT_MEMORY_TARGET = AILU_IDS.memoryProjectPath;

type MemoryWriteModalStage = 'target' | 'edit' | 'prepared' | 'result';
type MemorySourceChoice = 'agent-inference' | 'user-preference' | 'user-rule';

export interface MemoryWriteModalOptions {
  service: VerifiedMemoryWriteService;
  message: ChatMessage;
  conversationTitle: string;
  candidateTargets?: ReadonlyArray<{ relativePath: string; projectId: string }>;
}

export class MemoryWriteModal extends Modal {
  private stage: MemoryWriteModalStage = 'target';
  private busy = false;
  private closed = false;
  private targetRelativePath: string;
  private projectId: string = AILU_IDS.memoryProjectId;
  private target: MemoryWriteTarget | null = null;
  private proposalMarkdown = '';
  private summary: string;
  private sourceChoice: MemorySourceChoice = 'agent-inference';
  private prepared: PreparedMemoryWrite | null = null;
  private preparedMarkdown = '';
  private applyAttempted = false;
  private resultText = '';
  private readonly candidateTargets: Array<{ relativePath: string; projectId: string }>;

  constructor(
    app: App,
    private readonly options: MemoryWriteModalOptions,
  ) {
    super(app);
    this.candidateTargets = uniqueMemoryTargetSuggestions(options.candidateTargets ?? []);
    this.targetRelativePath = suggestMemoryTarget(
      this.candidateTargets.map(candidate => candidate.relativePath),
    );
    this.projectId = this.candidateTargets.find(
      candidate => candidate.relativePath === this.targetRelativePath,
    )?.projectId || AILU_IDS.memoryProjectId;
    this.summary = buildMemorySummary(options.conversationTitle, options.message.content);
  }

  override onOpen(): void {
    this.modalEl.addClass('ailu-memory-write-modal');
    this.render();
  }

  override onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    const prepared = this.prepared;
    if (!prepared || this.applyAttempted) return;
    this.prepared = null;
    void this.options.service.cancel(prepared.proposalId).catch(error => {
      console.error('Ailu could not cancel an unused memory proposal.', error);
      new Notice('未能清理尚未写入的记忆提案；插件关闭时会再次处理。');
    });
  }

  private render(): void {
    if (this.closed) return;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '沉淀到 Agent 记忆' });
    contentEl.createEl('p', {
      cls: 'ailu-memory-write-intro',
      text: '先读取目标文件，再检查完整最终正文。只有最后点击“确认写入正式记忆”才会修改文件。',
    });
    if (this.stage === 'target') this.renderTargetStage(contentEl);
    else if (this.stage === 'edit') this.renderEditStage(contentEl);
    else if (this.stage === 'prepared') this.renderPreparedStage(contentEl);
    else this.renderResultStage(contentEl);
  }

  private renderTargetStage(parent: HTMLElement): void {
    const field = parent.createDiv({ cls: 'ailu-memory-write-field' });
    field.createEl('label', { text: '保存到（Agent记忆内的相对路径）' });
    const input = field.createEl('input', {
      type: 'text',
      value: this.targetRelativePath,
      attr: {
        placeholder: '例如：项目/Obsidian插件迁移脱敏.md',
        spellcheck: 'false',
      },
    });
    input.disabled = this.busy;
    input.oninput = () => {
      this.targetRelativePath = input.value;
    };
    const projectField = parent.createDiv({ cls: 'ailu-memory-write-field' });
    projectField.createEl('label', { text: 'project_id（用户记忆会自动使用 global）' });
    const projectInput = projectField.createEl('input', {
      type: 'text',
      value: this.projectId,
      attr: { spellcheck: 'false' },
    });
    projectInput.disabled = this.busy;
    projectInput.oninput = () => {
      this.projectId = projectInput.value.trim();
    };
    if (this.candidateTargets.length > 0) {
      const suggestions = parent.createDiv({ cls: 'ailu-memory-write-suggestions' });
      suggestions.createDiv({ cls: 'ailu-memory-write-label', text: '本次对话引用过的记忆文件' });
      for (const candidate of this.candidateTargets) {
        const button = suggestions.createEl('button', {
          text: candidate.relativePath,
          attr: { type: 'button' },
        });
        button.disabled = this.busy;
        button.onclick = () => {
          this.targetRelativePath = candidate.relativePath;
          this.projectId = candidate.projectId || AILU_IDS.memoryProjectId;
          input.value = candidate.relativePath;
          projectInput.value = this.projectId;
        };
      }
    }
    const actions = parent.createDiv({ cls: 'ailu-memory-write-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.disabled = this.busy;
    cancel.onclick = () => this.close();
    const read = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.busy ? '正在读取…' : '读取目标文件',
      attr: { type: 'button' },
    });
    read.disabled = this.busy;
    read.onclick = () => void this.readTarget();
  }

  private renderEditStage(parent: HTMLElement): void {
    const target = this.target;
    if (!target) {
      this.stage = 'target';
      this.render();
      return;
    }
    const targetCard = parent.createDiv({ cls: 'ailu-memory-write-target-card' });
    targetCard.createDiv({ cls: 'ailu-memory-write-label', text: target.exists ? '将更新' : '将新建' });
    targetCard.createEl('code', { text: target.targetRelativePath });
    targetCard.createEl('button', {
      text: '更换目标',
      attr: { type: 'button' },
    }).onclick = () => {
      this.target = null;
      this.stage = 'target';
      this.render();
    };

    const summaryField = parent.createDiv({ cls: 'ailu-memory-write-field' });
    summaryField.createEl('label', { text: '这次要记住什么' });
    const summary = summaryField.createEl('input', {
      type: 'text',
      value: this.summary,
      attr: { maxlength: '2400' },
    });
    summary.disabled = this.busy;
    summary.oninput = () => {
      this.summary = summary.value;
    };

    const sourceField = parent.createDiv({ cls: 'ailu-memory-write-field' });
    sourceField.createEl('label', { text: '这条内容的性质' });
    const source = sourceField.createEl('select');
    for (const option of MEMORY_SOURCE_OPTIONS) {
      const element = source.createEl('option', { text: option.label, value: option.value });
      element.selected = option.value === this.sourceChoice;
    }
    source.disabled = this.busy;
    source.onchange = () => {
      this.sourceChoice = source.value as MemorySourceChoice;
    };

    const proposalField = parent.createDiv({ cls: 'ailu-memory-write-field' });
    proposalField.createEl('label', { text: '写入后的完整文件（可编辑）' });
    proposalField.createEl('p', {
      cls: 'ailu-memory-write-help',
      text: '这里显示的是整个文件，不是局部补丁。确认后，正式文件会精确变成下面这份内容。',
    });
    const proposal = proposalField.createEl('textarea', {
      text: this.proposalMarkdown,
      attr: { rows: '18', spellcheck: 'false' },
    });
    proposal.disabled = this.busy;
    proposal.oninput = () => {
      this.proposalMarkdown = proposal.value;
    };

    const actions = parent.createDiv({ cls: 'ailu-memory-write-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.disabled = this.busy;
    cancel.onclick = () => this.close();
    const prepare = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.busy ? '正在检查…' : '检查提案',
      attr: { type: 'button' },
    });
    prepare.disabled = this.busy;
    prepare.onclick = () => void this.prepare();
  }

  private renderPreparedStage(parent: HTMLElement): void {
    const prepared = this.prepared;
    if (!prepared) {
      this.stage = 'edit';
      this.render();
      return;
    }
    const card = parent.createDiv({ cls: 'ailu-memory-write-confirm-card' });
    card.createDiv({
      cls: 'ailu-memory-write-confirm-title',
      text: prepared.action === 'ADD' ? '检查通过：将新建文件' : '检查通过：将更新文件',
    });
    card.createEl('code', { text: prepared.targetRelativePath });
    card.createDiv({
      cls: 'ailu-memory-write-help',
      text: `完整正文 ${prepared.proposalSizeBytes.toLocaleString()} 字节，尚未写入。`,
    });
    if (this.applyAttempted) {
      card.createDiv({
        cls: 'ailu-memory-write-recovery-warning',
        text: '上次确认写入未完成。请重试同一份提案；为保护恢复现场，这里不会把它当成普通取消。',
      });
    }
    const preview = parent.createEl('textarea', {
      text: this.preparedMarkdown,
      attr: { rows: '18', readonly: 'true', spellcheck: 'false' },
    });
    preview.addClass('ailu-memory-write-preview');

    const actions = parent.createDiv({ cls: 'ailu-memory-write-actions' });
    const close = actions.createEl('button', { text: '暂不写入', attr: { type: 'button' } });
    close.disabled = this.busy;
    close.onclick = () => this.close();
    if (!this.applyAttempted) {
      const edit = actions.createEl('button', { text: '返回修改', attr: { type: 'button' } });
      edit.disabled = this.busy;
      edit.onclick = () => void this.cancelPreparedAndReturn();
    }
    const apply = actions.createEl('button', {
      cls: 'mod-cta',
      text: this.busy
        ? '正在写入…'
        : this.applyAttempted
          ? '重试同一份写入'
          : '确认写入正式记忆',
      attr: { type: 'button' },
    });
    apply.disabled = this.busy;
    apply.onclick = () => void this.apply();
  }

  private renderResultStage(parent: HTMLElement): void {
    parent.createDiv({ cls: 'ailu-memory-write-result', text: this.resultText });
    const actions = parent.createDiv({ cls: 'ailu-memory-write-actions' });
    actions.createEl('button', {
      cls: 'mod-cta',
      text: '完成',
      attr: { type: 'button' },
    }).onclick = () => this.close();
  }

  private async readTarget(): Promise<void> {
    const targetRelativePath = this.targetRelativePath.trim();
    if (!targetRelativePath) {
      new Notice('请先填写 Agent记忆 内的 Markdown 路径。');
      return;
    }
    this.busy = true;
    this.render();
    try {
      const target = await this.options.service.readTarget(
        targetRelativePath,
        targetRelativePath.startsWith('用户记忆/') ? 'global' : this.projectId,
      );
      if (this.closed) return;
      this.target = target;
      this.targetRelativePath = target.targetRelativePath;
      this.proposalMarkdown = buildMemoryProposalMarkdown({
        existingContent: target.content,
        targetRelativePath: target.targetRelativePath,
        assistantContent: this.options.message.content,
        conversationTitle: this.options.conversationTitle,
        createdAt: this.options.message.createdAt,
        projectId: target.projectId,
      });
      this.stage = 'edit';
    } catch (error) {
      if (!this.closed) new Notice(memoryWriteErrorMessage(error, '无法读取目标记忆文件。'));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async prepare(): Promise<void> {
    const target = this.target;
    const proposalMarkdown = this.proposalMarkdown;
    if (!target) return;
    if (!this.summary.trim() || !proposalMarkdown.trim()) {
      new Notice('摘要和完整文件内容都不能为空。');
      return;
    }
    this.busy = true;
    this.render();
    try {
      const classification = classifyMemorySource(
        this.sourceChoice,
        this.options.message.agentId,
      );
      const result = await this.options.service.prepare({
        summary: this.summary.trim(),
        proposalMarkdown,
        readTarget: target,
        sourceClass: classification.sourceClass,
        knowledgeKind: classification.knowledgeKind,
        assertedBy: classification.assertedBy,
        evidenceReference: `chat-message:${this.options.message.id}`,
      });
      if (this.closed) {
        if (result.status === 'prepared') {
          void this.options.service.cancel(result.proposalId).catch(error => {
            console.error('Ailu could not cancel a proposal after closing its modal.', error);
          });
        }
        return;
      }
      this.handlePrepareResult(result, proposalMarkdown);
    } catch (error) {
      if (!this.closed) new Notice(memoryWriteErrorMessage(error, '记忆提案检查失败。'));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private handlePrepareResult(
    result: MemoryWritePrepareResult,
    proposalMarkdown: string,
  ): void {
    if (result.status === 'prepared') {
      this.prepared = result;
      this.preparedMarkdown = proposalMarkdown;
      this.applyAttempted = false;
      this.stage = 'prepared';
      return;
    }
    if (result.status === 'noop') {
      this.resultText = '没有写入：正式记忆中已经有等价内容。';
      this.stage = 'result';
      return;
    }
    const candidates = result.candidates.map(candidate => candidate.relativePath).join('、');
    this.resultText = candidates
      ? `没有写入：需要先人工合并。可能相关的文件：${candidates}`
      : '没有写入：检查发现内容需要人工合并，当前正式记忆保持不变。';
    this.stage = 'result';
  }

  private async cancelPreparedAndReturn(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared || this.applyAttempted) return;
    this.busy = true;
    this.render();
    try {
      await this.options.service.cancel(prepared.proposalId);
      if (this.closed) return;
      this.prepared = null;
      this.preparedMarkdown = '';
      this.stage = 'edit';
    } catch (error) {
      if (!this.closed) new Notice(memoryWriteErrorMessage(error, '无法取消当前记忆提案。'));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async apply(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) return;
    this.applyAttempted = true;
    this.busy = true;
    this.render();
    try {
      const applied = await this.options.service.apply(prepared, {
        proposalMarkdown: this.preparedMarkdown,
        confirmationReference: `chat-message:${this.options.message.id}`,
      });
      if (this.closed) return;
      this.prepared = null;
      this.resultText = `${applied.action === 'ADD' ? '已新建' : '已更新'}：${applied.targetRelativePath}`;
      this.stage = 'result';
      new Notice('正式 Agent 记忆已写入并完成记录。');
    } catch (error) {
      if (!this.closed) {
        new Notice(memoryWriteErrorMessage(error, '正式记忆写入未完成，请重试同一份提案。'));
      }
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

const MEMORY_SOURCE_OPTIONS: Array<{ value: MemorySourceChoice; label: string }> = [
  { value: 'agent-inference', label: 'Agent 的分析或推断（默认）' },
  { value: 'user-preference', label: '我明确表达的偏好' },
  { value: 'user-rule', label: '我明确要求长期遵守的规则' },
];

export function suggestMemoryTarget(candidates: readonly string[]): string {
  return uniqueMemoryTargets(candidates)[0] ?? DEFAULT_MEMORY_TARGET;
}

export function buildMemorySummary(conversationTitle: string, assistantContent: string): string {
  const firstLine = assistantContent
    .split(/\r?\n/)
    .map(line => line.replace(/^\s{0,3}#{1,6}\s+/, '').trim())
    .find(Boolean) ?? '对话结论';
  const prefix = conversationTitle.trim() && conversationTitle.trim() !== '新对话'
    ? `${conversationTitle.trim()}：`
    : '';
  return `${prefix}${firstLine}`.slice(0, 240);
}

export function buildMemoryProposalMarkdown(input: {
  existingContent: string;
  targetRelativePath: string;
  assistantContent: string;
  conversationTitle: string;
  createdAt: number;
  projectId?: string;
}): string {
  const existing = input.existingContent;
  const answer = input.assistantContent.trim();
  const title = input.conversationTitle.trim() || '对话结论';
  const date = new Date(input.createdAt).toLocaleDateString('sv-SE');
  const section = `## ${title}（${date}）\n\n${answer}`;
  if (existing.trim()) {
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return `${existing}${separator}${section}\n`;
  }
  const basename = input.targetRelativePath.split('/').pop()?.replace(/\.md$/i, '').trim()
    || 'Agent 记忆';
  const projectId = input.targetRelativePath.startsWith('用户记忆/')
    ? 'global'
    : input.projectId?.trim() || AILU_IDS.memoryProjectId;
  return [
    '---',
    'status: active',
    'agent_scope: shared',
    `app_id: ${AILU_IDS.memoryAppId}`,
    `project_id: ${projectId}`,
    '---',
    '',
    `# ${basename}`,
    '',
    section,
    '',
  ].join('\n');
}

export function classifyMemorySource(
  choice: MemorySourceChoice,
  agentId: AgentId | undefined,
): {
  sourceClass: MemorySourceClass;
  knowledgeKind: MemoryKnowledgeKind;
  assertedBy: MemoryAsserter;
} {
  if (choice === 'user-preference') {
    return { sourceClass: 'user_direct', knowledgeKind: 'preference', assertedBy: 'user' };
  }
  if (choice === 'user-rule') {
    return { sourceClass: 'user_direct', knowledgeKind: 'rule', assertedBy: 'user' };
  }
  return {
    sourceClass: 'agent_inferred',
    knowledgeKind: 'inference',
    assertedBy: agentId === 'claude' ? 'claude' : 'codex',
  };
}

function uniqueMemoryTargets(candidates: readonly string[]): string[] {
  return [...new Set(candidates.map(path => path.trim()).filter(path => (
    /^(?:用户记忆|项目|工作流|决策|agent)\/(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]+\.md$/u.test(path)
  )))];
}

function uniqueMemoryTargetSuggestions(
  candidates: ReadonlyArray<{ relativePath: string; projectId: string }>,
): Array<{ relativePath: string; projectId: string }> {
  const seen = new Set<string>();
  const result: Array<{ relativePath: string; projectId: string }> = [];
  for (const candidate of candidates) {
    const relativePath = uniqueMemoryTargets([candidate.relativePath])[0];
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    result.push({
      relativePath,
      projectId: candidate.projectId.trim(),
    });
  }
  return result;
}

function memoryWriteErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof MemoryWriteError) return userFacingErrorText(error.message, fallback);
  return userFacingErrorText(error instanceof Error ? error.message : '', fallback);
}
