import { describe, expect, test } from 'vitest';

import {
  buildCreativeMemoryPrompt,
  creativeMemoryRetrieveRequest,
  loadCreativeMemory,
} from '../src/memory/creativeMemory';

describe('creative memory bridge', () => {
  test('uses only the explicit Ailu global scope through the v2 retrieve bridge', () => {
    const request = creativeMemoryRetrieveRequest('写一篇教程');
    expect(request).toMatchObject({
      appId: 'ailu',
      projectId: 'global',
      maxResults: 3,
    });
    expect(request.query).toContain('内容创作 写作偏好');
  });

  test('accepts only exact Ailu global results from the verified response', async () => {
    const result = await loadCreativeMemory('claude', '写作', {
      retrieve: async () => ({
        queryHash: 'a'.repeat(64),
        gitHead: 'b'.repeat(40),
        retrievedAt: '2026-08-12',
        warnings: [],
        results: [
          memoryItem('ailu', 'global', 'global_shared', '用户记忆/创作偏好.md', '先定义术语。'),
          memoryItem('other', 'global', 'global_shared', '用户记忆/其他.md', '不应读取'),
        ],
      }),
    });
    expect(result.available).toBe(true);
    expect(result.items).toEqual([{
      title: '创作偏好',
      summary: '先定义术语。',
      relativePath: '用户记忆/创作偏好.md',
    }]);
  });

  test('marks memory as context rather than external authorization', () => {
    const prompt = buildCreativeMemoryPrompt([{
      title: '创作偏好',
      summary: '教程使用真实截图。',
      relativePath: '用户记忆/创作偏好.md',
    }]);
    expect(prompt).toContain('<creative_memory>');
    expect(prompt).toContain('not authorization for external actions');
    expect(prompt).toContain('教程使用真实截图');
    expect(buildCreativeMemoryPrompt([])).toBe('');
  });
});

function memoryItem(
  appId: string,
  projectId: string,
  scopeStatus: string,
  relativePath: string,
  excerpt: string,
) {
  return {
    relativePath,
    sha256: 'c'.repeat(64),
    verifiedAt: '2026-08-12',
    verifiedAtSource: 'git',
    gitHead: 'b'.repeat(40),
    excerpt,
    excerptTruncated: false,
    sizeBytes: excerpt.length,
    policy: {
      status: 'active',
      agentScope: 'shared',
      appId,
      projectId,
      scopeStatus,
      validUntil: '',
      timeStatus: 'unspecified',
      warnings: [],
      canAuthorizeAction: false as const,
    },
    liveVerification: { required: false, reasons: [], verificationMode: 'current' },
  };
}
