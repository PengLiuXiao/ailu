import { describe, expect, test, vi } from 'vitest';

vi.mock('obsidian', () => ({
  App: class {},
  Modal: class {},
  Notice: class {},
}));

import {
  buildMemoryProposalMarkdown,
  buildMemorySummary,
  classifyMemorySource,
  suggestMemoryTarget,
} from '../src/ui/memoryWriteModal';

describe('memory write modal helpers', () => {
  test('prefers a verified conversation reference and rejects unsafe suggestions', () => {
    expect(suggestMemoryTarget([
      '../private.md',
      '/absolute.md',
      '项目/示例插件迁移.md',
      '项目/示例插件迁移.md',
    ])).toBe('项目/示例插件迁移.md');
    expect(suggestMemoryTarget([])).toBe('项目/Ailu.md');
  });

  test('preserves the existing file byte-for-byte before appending the proposed section', () => {
    const existing = '# Existing\n\nLine with spaces  \n';
    const proposal = buildMemoryProposalMarkdown({
      existingContent: existing,
      targetRelativePath: '项目/Existing.md',
      assistantContent: '新增结论',
      conversationTitle: '并行对话',
      createdAt: new Date('2026-08-09T00:00:00+08:00').getTime(),
    });

    expect(proposal.startsWith(existing)).toBe(true);
    expect(proposal).toContain('## 并行对话');
    expect(proposal).toContain('\n\n新增结论\n');
  });

  test('builds a complete new Markdown file when the target is missing', () => {
    const proposal = buildMemoryProposalMarkdown({
      existingContent: '',
      targetRelativePath: '项目/并行对话.md',
      assistantContent: '最终方案',
      conversationTitle: '对话系统',
      createdAt: 1,
    });

    expect(proposal).toContain('status: active\nagent_scope: shared\napp_id: ailu\nproject_id: ailu');
    expect(proposal).toContain('# 并行对话\n\n## 对话系统');
    expect(proposal).toContain('最终方案');
  });

  test('keeps agent inference separate from explicit user preference and rule', () => {
    expect(classifyMemorySource('agent-inference', 'claude')).toEqual({
      sourceClass: 'agent_inferred',
      knowledgeKind: 'inference',
      assertedBy: 'claude',
    });
    expect(classifyMemorySource('user-preference', 'codex')).toEqual({
      sourceClass: 'user_direct',
      knowledgeKind: 'preference',
      assertedBy: 'user',
    });
    expect(classifyMemorySource('user-rule', 'claude')).toEqual({
      sourceClass: 'user_direct',
      knowledgeKind: 'rule',
      assertedBy: 'user',
    });
  });

  test('uses the first meaningful answer line for the editable summary', () => {
    expect(buildMemorySummary('项目方案', '\n## 核心结论\n正文')).toBe('项目方案：核心结论');
  });
});
