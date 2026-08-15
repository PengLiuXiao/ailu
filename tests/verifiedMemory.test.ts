import { clearTimeout as nodeClearTimeout, setTimeout as nodeSetTimeout } from 'node:timers';

import { vi } from 'vitest';

import { AiluMemoryRuntimeHandshakeError } from '../src/memory/runtimeHandshake';

import {
  buildChatMemoryQuery,
  parseVerifiedMemoryResponse,
  VerifiedMemoryReadService,
  verifiedMemoryRetrieveArgs,
  verifiedMemoryRetrieveStdin,
  type VerifiedMemoryResponse,
  type VerifiedMemoryRetrieveRequest,
} from '../src/memory/verifiedMemory';

const timerOptions = {
  setTimer: (callback: () => void, delayMs: number) => nodeSetTimeout(callback, delayMs),
  clearTimer: (timer: ReturnType<typeof nodeSetTimeout> | number) => {
    if (typeof timer !== 'number') nodeClearTimeout(timer);
  },
};

function response(
  scopeStatus: 'global_shared' | 'current_project',
  excerpt: string,
  warningCodes: string[] = [],
): VerifiedMemoryResponse {
  return {
    queryHash: 'a'.repeat(64),
    gitHead: 'b'.repeat(40),
    retrievedAt: '2026-08-09T00:00:00+00:00',
    results: excerpt ? [{
      relativePath: scopeStatus === 'current_project' ? '项目/Ailu.md' : '用户记忆/创作偏好.md',
      sha256: 'c'.repeat(64),
      verifiedAt: '2026-08-09',
      verifiedAtSource: 'git',
      gitHead: 'b'.repeat(40),
      excerpt,
      excerptTruncated: false,
      sizeBytes: 100,
      policy: {
        status: 'active',
        agentScope: 'shared',
        appId: 'ailu',
        projectId: scopeStatus === 'current_project' ? 'ailu' : 'global',
        scopeStatus,
        validUntil: '',
        timeStatus: 'unspecified',
        warnings: [],
        canAuthorizeAction: false,
      },
      liveVerification: { required: false, reasons: [], verificationMode: 'current' },
    }] : [],
    warnings: warningCodes.map(code => ({ code })),
  };
}

describe('verified Agent Memory bridge', () => {
  test('keeps the private query and scope in stdin instead of process arguments', () => {
    const request = {
      query: '写一篇教程',
      appId: 'ailu',
      projectId: 'ailu',
    };
    const args = verifiedMemoryRetrieveArgs(request);
    expect(args).toEqual([
      '--actor', 'ailu',
      'retrieve',
      '--json',
    ]);
    expect(args.join(' ')).not.toContain('写一篇教程');
    expect(JSON.parse(verifiedMemoryRetrieveStdin(request))).toMatchObject({
      schema_version: 2,
      query: '写一篇教程',
      app_id: 'ailu',
      project_id: 'ailu',
    });
  });

  test('parses verified pointers and excerpts while rejecting unsafe paths', () => {
    const raw = JSON.stringify({
      schema_version: 2,
      ok: true,
      query_hash: 'a'.repeat(64),
      git_head: 'b'.repeat(40),
      retrieved_at: '2026-08-09T00:00:00+00:00',
      results: [
        {
          relative_path: '用户记忆/创作偏好.md',
          sha256: 'c'.repeat(64),
          verified_at: '2026-08-09',
          verified_at_source: 'git',
          git_head: 'b'.repeat(40),
          excerpt: '先定义术语。',
          excerpt_truncated: false,
          size_bytes: 20,
          policy: {
            status: 'active', agent_scope: 'shared', app_id: 'ailu',
            project_id: 'global', scope_status: 'global_shared', valid_until: '',
            time_status: 'unspecified', warnings: [], can_authorize_action: false,
          },
          live_verification: { required: false, reasons: [], verification_mode: 'current' },
        },
        {
          relative_path: '../secret.md',
          sha256: 'd'.repeat(64),
          excerpt: 'unsafe',
          policy: {},
          live_verification: {},
        },
      ],
      warnings: [],
    });
    const parsed = parseVerifiedMemoryResponse(raw);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]?.relativePath).toBe('用户记忆/创作偏好.md');
  });

  test('fails closed on a runtime API v1 response', () => {
    expect(() => parseVerifiedMemoryResponse(JSON.stringify({
      schema_version: 1,
      ok: true,
      query_hash: 'a'.repeat(64),
      results: [],
      warnings: [],
    }))).toThrow('Agent Memory 返回格式不受支持');
  });

  test('requires one explicit project_id and rejects shared fan-out', () => {
    expect(() => verifiedMemoryRetrieveStdin({
      query: '写一篇教程',
      appId: 'ailu',
    })).toThrow('project_id');
    expect(() => verifiedMemoryRetrieveStdin({
      query: '写一篇教程',
      appId: 'ailu',
      projectId: 'shared',
    })).toThrow('project_id');
    expect(() => verifiedMemoryRetrieveStdin({
      query: '写一篇教程',
      appId: 'other-app',
      projectId: 'global',
    })).toThrow('app_id');
  });

  test('uses global results only for creative context and project results only for project context', async () => {
    const retrieve = vi.fn(async (request: VerifiedMemoryRetrieveRequest) => (
      request.projectId === 'ailu'
        ? response('current_project', '项目运行规则')
        : response('global_shared', '全局写作偏好')
    ));
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 1_000, ...timerOptions });
    const context = await service.read('写教程');

    expect(context.prompt).toContain('全局写作偏好');
    expect(context.prompt).toContain('项目运行规则');
    expect(context.references).toHaveLength(2);
    expect(JSON.stringify(context.references)).not.toContain('全局写作偏好');
  });

  test('drops results whose returned app or project scope is not the requested scope', async () => {
    const retrieve = vi.fn(async (request: VerifiedMemoryRetrieveRequest) => {
      const result = request.projectId === 'ailu'
        ? response('current_project', '不应跨项目读到')
        : response('global_shared', '不应跨应用读到');
      if (request.projectId === 'ailu') result.results[0].policy.projectId = 'other-project';
      else result.results[0].policy.appId = 'other-app';
      return result;
    });
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 1_000, ...timerOptions });

    const context = await service.read('严格作用域');

    expect(context.prompt).toBe('');
    expect(context.references).toEqual([]);
  });

  test('falls back only to the exact cached query when a later lookup times out', async () => {
    let mode: 'live' | 'blocked' = 'live';
    const never = new Promise<VerifiedMemoryResponse>(() => {});
    const retrieve = vi.fn(async (request: VerifiedMemoryRetrieveRequest) => {
      if (mode === 'blocked') return never;
      return request.projectId === 'ailu'
        ? response('current_project', '项目缓存')
        : response('global_shared', '偏好缓存');
    });
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 5, ...timerOptions });
    await service.read('同一个查询');
    mode = 'blocked';
    const stalePromise = service.read('同一个查询');
    const stale = await stalePromise;
    expect(stale.usedStaleCache).toBe(true);
    expect(stale.prompt).toContain('可能已过期');

    const differentPromise = service.read('不同查询');
    const different = await differentPromise;
    expect(different.prompt).toBe('');
  });

  test('keeps a prior cache when the read-only index is temporarily unavailable', async () => {
    let degraded = false;
    const retrieve = vi.fn(async (request: VerifiedMemoryRetrieveRequest) => {
      if (degraded) return response(request.projectId === 'ailu' ? 'current_project' : 'global_shared', '', [
        'SEARCH_INDEX_MISSING',
      ]);
      return request.projectId === 'ailu'
        ? response('current_project', '项目缓存')
        : response('global_shared', '偏好缓存');
    });
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 1_000, ...timerOptions });
    await service.read('稳定查询');
    degraded = true;
    const stale = await service.read('稳定查询');
    expect(stale.usedStaleCache).toBe(true);
    expect(stale.warnings.some(item => item.code === 'SEARCH_INDEX_MISSING')).toBe(true);
  });

  test('disables formal reads and clears stale cache after a runtime handshake failure', async () => {
    let mode: 'live' | 'incompatible' | 'blocked' = 'live';
    const never = new Promise<VerifiedMemoryResponse>(() => {});
    const retrieve = vi.fn(async (request: VerifiedMemoryRetrieveRequest) => {
      if (mode === 'incompatible') {
        throw new AiluMemoryRuntimeHandshakeError(
          'RUNTIME_HANDSHAKE_INCOMPATIBLE',
          'Agent Memory runtime 不兼容。',
        );
      }
      if (mode === 'blocked') return never;
      return request.projectId === 'ailu'
        ? response('current_project', '项目缓存')
        : response('global_shared', '偏好缓存');
    });
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 5, ...timerOptions });
    await service.read('同一个查询');

    mode = 'incompatible';
    const disabled = await service.read('同一个查询');
    expect(disabled.prompt).toBe('');
    expect(disabled.references).toEqual([]);
    expect(disabled.usedStaleCache).toBe(false);
    expect(disabled.warnings).toEqual([expect.objectContaining({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
    })]);

    mode = 'blocked';
    const afterFailure = await service.read('同一个查询');
    expect(afterFailure.prompt).toBe('');
    expect(afterFailure.usedStaleCache).toBe(false);
  });

  test('contains speculative prefetch failures until read can choose its fallback', async () => {
    const retrieve = vi.fn(async (): Promise<VerifiedMemoryResponse> => {
      throw new Error('runtime unavailable');
    });
    const service = new VerifiedMemoryReadService({ retrieve, waitMs: 1, ...timerOptions });

    service.prefetch('不会产生未处理拒绝');
    await Promise.resolve();
    await Promise.resolve();

    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  test('builds a bounded query from the current task without absolute attachment paths', () => {
    const query = buildChatMemoryQuery({
      userInput: '帮我改写',
      conversationTitle: '教程',
      recentMessages: ['旧消息', '最近消息'],
      activeNotePath: '内容/教程.md',
      selectedSkillLabel: '/写作',
    });
    expect(query).toContain('内容/教程.md');
    expect(query).toContain('/写作');
    expect(query.length).toBeLessThanOrEqual(2_400);
  });
});
