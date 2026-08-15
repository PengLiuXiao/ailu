import { createHash } from 'node:crypto';
import { setTimeout as nodeSetTimeout } from 'node:timers';

import { vi } from 'vitest';

import {
  AILU_MEMORY_WRITE_ACTOR,
  MemoryWriteError,
  VerifiedMemoryWriteService,
  memoryWriteArgs,
  runMemoryWriteProcess,
  type MemoryWritePrepareInput,
  type MemoryWriteTransportRequest,
  type MemoryWriteTransportResponse,
  type PreparedMemoryWrite,
} from '../src/memory/verifiedMemoryWrite';
import {
  AiluMemoryRuntimeHandshakeError,
  type AiluMemoryRuntimeGateLike,
} from '../src/memory/runtimeHandshake';

const proposalId = 'c'.repeat(32);
const fencingToken = 17;
const proposalMarkdown = '# Ailu\n\n## 当前有效摘要\n\n只在用户确认后写入。\n';
const proposalRawSha256 = createHash('sha256').update(proposalMarkdown).digest('hex');
const proposalCanonicalSha256 = proposalRawSha256;
const baseRawSha256 = createHash('sha256').update('').digest('hex');
const baseCanonicalSha256 = baseRawSha256;
const baseGitHead = 'f'.repeat(40);
const readToken = 'a'.repeat(64);
const targetRelativePath = '项目/Ailu.md';

function readyRuntimeGate(): AiluMemoryRuntimeGateLike {
  return {
    assertReady: async () => ({
      schemaVersion: 2,
      runtimeApiVersion: 2,
      writerProtocolVersion: 2,
      canonicalActors: ['ailu'],
      executableRealpath: process.execPath,
      manifestRealpath: '/test/runtime-manifest.json',
      manifestMtimeNs: '1',
      transitionMarkerFingerprint: 'test-ready-marker',
      runtimeIntegritySha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
    }),
  };
}

const prepareInput: MemoryWritePrepareInput = {
  summary: '用户确认后才写入正式记忆',
  proposalMarkdown,
  readTarget: {
    operation: 'read-target',
    status: 'missing',
    targetRelativePath,
    exists: false,
    content: '',
    rawSha256: baseRawSha256,
    canonicalSha256: baseCanonicalSha256,
    sizeBytes: 0,
    gitHead: baseGitHead,
    readToken,
    projectId: 'ailu',
  },
  sourceClass: 'user_direct',
  knowledgeKind: 'rule',
  assertedBy: 'user',
  evidenceReference: 'chat-message:confirmed-memory-rule',
};

function preparedPayload(): Record<string, unknown> {
  return {
    schema_version: 2,
    ok: true,
    stage: 'prepare',
    status: 'prepared',
    recommended_action: 'ADD',
    target_relative_path: targetRelativePath,
    proposal_raw_sha256: proposalRawSha256,
    proposal_canonical_sha256: proposalCanonicalSha256,
    proposal_size_bytes: Buffer.byteLength(proposalMarkdown, 'utf8'),
    confirmation_required: true,
    candidates: [],
    warnings: [],
    proposal_id: proposalId,
    fencing_token: fencingToken,
    base_exists: false,
    base_raw_sha256: baseRawSha256,
    base_canonical_sha256: baseCanonicalSha256,
    base_git_head: baseGitHead,
    expires_at: '2026-08-09T01:00:00+00:00',
    recommendation_metrics: {
      similarity: 0.12,
      coverage: 0.34,
      raw_semantic_distance: null,
    },
  };
}

function preparedResult(): PreparedMemoryWrite {
  return {
    operation: 'prepare',
    status: 'prepared',
    action: 'ADD',
    targetRelativePath,
    proposalRawSha256,
    proposalCanonicalSha256,
    proposalSizeBytes: Buffer.byteLength(proposalMarkdown, 'utf8'),
    candidates: [],
    warnings: [],
    proposalId,
    fencingToken,
    baseExists: false,
    baseRawSha256,
    baseCanonicalSha256,
    baseGitHead,
    expiresAt: '2026-08-09T01:00:00+00:00',
    confirmationRequired: true,
    recommendationMetrics: {
      similarity: 0.12,
      coverage: 0.34,
      rawSemanticDistance: null,
    },
  };
}

function response(payload: Record<string, unknown>, exitCode = 0): MemoryWriteTransportResponse {
  return { exitCode, stdout: JSON.stringify(payload) };
}

function serviceWith(
  transport: (request: MemoryWriteTransportRequest) => Promise<MemoryWriteTransportResponse>,
  sessionId = 'ailu-test-session',
): VerifiedMemoryWriteService {
  return new VerifiedMemoryWriteService({
    executablePath: process.execPath,
    sessionId,
    transport,
    runtimeGate: readyRuntimeGate(),
  });
}

describe('verified Agent Memory write bridge', () => {
  test('isolates throwing state listeners from write and shutdown barriers', async () => {
    const transport = vi.fn(async (request: MemoryWriteTransportRequest) => {
      if (request.args.includes('prepare')) return response(preparedPayload());
      return response({
    schema_version: 2,
        ok: true,
        stage: 'cancel',
        status: 'cancelled',
        proposal_id: proposalId,
        fencing_token: fencingToken,
        idempotent: false,
      });
    });
    const service = serviceWith(transport, 'ailu-listener-isolation');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    service.subscribe(() => {
      throw new Error('broken UI listener');
    });

    await expect(service.prepare(prepareInput)).resolves.toMatchObject({ status: 'prepared' });
    await expect(service.shutdown()).resolves.toBeUndefined();

    expect(service.getState()).toEqual({ status: 'shutdown' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('reads an exact formal target through the read-only protocol', async () => {
    const content = '# Example\n\nExisting formal memory.\n';
    const digest = createHash('sha256').update(content).digest('hex');
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => response({
    schema_version: 2,
      ok: true,
      stage: 'read-target',
      status: 'found',
      target_relative_path: targetRelativePath,
      content,
      read_token: readToken,
      base_exists: true,
      base_raw_sha256: digest,
      base_canonical_sha256: digest,
      size_bytes: Buffer.byteLength(content, 'utf8'),
      base_git_head: baseGitHead,
    }));
    const service = serviceWith(transport);

    const result = await service.readTarget(targetRelativePath);

    expect(result).toEqual({
      operation: 'read-target',
      status: 'found',
      targetRelativePath,
      exists: true,
      content,
      rawSha256: digest,
      canonicalSha256: digest,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      gitHead: baseGitHead,
      readToken,
      projectId: 'ailu',
    });
    const request = transport.mock.calls[0]?.[0];
    expect(request?.args).toEqual(memoryWriteArgs('read-target'));
    expect(JSON.parse(request?.stdin ?? '{}')).toEqual({
    schema_version: 2,
      target_relative_path: targetRelativePath,
      app_id: 'ailu',
      project_id: 'ailu',
    });
  });

  test('keeps app-global creative memory outside the project scope', async () => {
    const creativePath = '用户记忆/创作偏好.md';
    const emptyDigest = createHash('sha256').update('').digest('hex');
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => response({
    schema_version: 2,
      ok: true,
      stage: 'read-target',
      status: 'missing',
      target_relative_path: creativePath,
      content: '',
      read_token: readToken,
      base_exists: false,
      base_raw_sha256: emptyDigest,
      base_canonical_sha256: emptyDigest,
      size_bytes: 0,
      base_git_head: baseGitHead,
    }));
    const service = serviceWith(transport, 'ailu-creative-scope');

    await expect(service.readTarget(creativePath)).resolves.toMatchObject({
      targetRelativePath: creativePath,
      projectId: 'global',
    });
    expect(JSON.parse(transport.mock.calls[0]?.[0].stdin ?? '{}')).toEqual({
    schema_version: 2,
      target_relative_path: creativePath,
      app_id: 'ailu',
      project_id: 'global',
    });
  });

  test('rejects global outside the user-memory directory', async () => {
    const globalPath = '工作流/Ailu-全局规则.md';
    const emptyDigest = createHash('sha256').update('').digest('hex');
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => response({
      schema_version: 2,
      ok: true,
      stage: 'read-target',
      status: 'missing',
      target_relative_path: globalPath,
      content: '',
      read_token: readToken,
      base_exists: false,
      base_raw_sha256: emptyDigest,
      base_canonical_sha256: emptyDigest,
      size_bytes: 0,
      base_git_head: baseGitHead,
    }));
    const service = serviceWith(transport, 'ailu-explicit-global');

    await expect(service.readTarget(globalPath, 'global')).rejects.toMatchObject({
      code: 'GLOBAL_TARGET_FORBIDDEN',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  test('serializes a read with its own instance without taking the global write queue', async () => {
    const content = '# Existing\n';
    const digest = createHash('sha256').update(content).digest('hex');
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>(resolve => {
      releaseRead = resolve;
    });
    const localOperations: string[] = [];
    const localTransport = vi.fn(async (request: MemoryWriteTransportRequest) => {
      if (request.args.includes('read-target')) {
        localOperations.push('read');
        await readGate;
        return response({
    schema_version: 2,
          ok: true,
          stage: 'read-target',
          status: 'found',
          target_relative_path: targetRelativePath,
          content,
          read_token: readToken,
          base_exists: true,
          base_raw_sha256: digest,
          base_canonical_sha256: digest,
          size_bytes: Buffer.byteLength(content, 'utf8'),
          base_git_head: baseGitHead,
        });
      }
      localOperations.push('prepare');
      return response(preparedPayload());
    });
    const otherTransport = vi.fn(async (_request: MemoryWriteTransportRequest) => (
      response({ ...preparedPayload(), proposal_id: '8'.repeat(32) })
    ));
    const local = serviceWith(localTransport, 'ailu-local-read');
    const other = serviceWith(otherTransport, 'ailu-other-write');

    const readPromise = local.readTarget(targetRelativePath);
    const localPreparePromise = local.prepare(prepareInput);
    await vi.waitFor(() => expect(localTransport).toHaveBeenCalledTimes(1));
    await expect(other.prepare(prepareInput)).resolves.toMatchObject({ status: 'prepared' });

    expect(localTransport).toHaveBeenCalledTimes(1);
    releaseRead?.();
    await Promise.all([readPromise, localPreparePromise]);
    expect(localOperations).toEqual(['read', 'prepare']);
  });

  test('uses the Ailu actor and keeps the proposal out of argv', async () => {
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => (
      response(preparedPayload())
    ));
    const service = serviceWith(transport);

    const result = await service.prepare(prepareInput);

    expect(memoryWriteArgs('prepare')).toEqual([
      '--actor', AILU_MEMORY_WRITE_ACTOR,
      'write', 'prepare', '--json',
    ]);
    const request = transport.mock.calls[0]?.[0];
    expect(request?.args.join(' ')).not.toContain(proposalMarkdown);
    expect(request?.sessionId).toBe('ailu-test-session');
    expect(JSON.parse(request?.stdin ?? '{}')).toMatchObject({
    schema_version: 2,
      proposal_markdown: proposalMarkdown,
      read_token: readToken,
      app_id: 'ailu',
      project_id: 'ailu',
      source_class: 'user_direct',
      knowledge_kind: 'rule',
      asserted_by: 'user',
    });
    expect(result).toEqual(preparedResult());
    expect(service.getState()).toEqual({ status: 'prepared', result: preparedResult() });
  });

  test('fails closed on a runtime API v1 response', async () => {
    const transport = vi.fn(async () => response({
      ...preparedPayload(),
      schema_version: 1,
    }));
    const service = serviceWith(transport, 'ailu-v1-rejection');

    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      code: 'WRITE_PROTOCOL_INVALID',
      operation: 'prepare',
    });
  });

  test('does not invoke a write operation when the runtime v2 handshake fails', async () => {
    const transport = vi.fn(async () => response(preparedPayload()));
    const service = new VerifiedMemoryWriteService({
      executablePath: process.execPath,
      sessionId: 'ailu-runtime-disabled',
      transport,
      runtimeGate: {
        assertReady: async () => {
          throw new AiluMemoryRuntimeHandshakeError(
            'RUNTIME_HANDSHAKE_INCOMPATIBLE',
            'Agent Memory runtime 不兼容。',
          );
        },
      },
    });

    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
      operation: 'prepare',
    });
    expect(transport).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({
      status: 'blocked',
      operation: 'prepare',
      error: { code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE' },
    });
  });

  test('fails closed when prepare omits a positive fencing token', async () => {
    const transport = vi.fn(async () => response({
      ...preparedPayload(),
      fencing_token: 0,
    }));
    const service = serviceWith(transport, 'ailu-missing-fence');

    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      code: 'WRITE_PROTOCOL_INVALID',
      operation: 'prepare',
    });
    expect(service.getPendingProposals()).toEqual([]);
  });

  test('apply binds the exact prepared proposal and an explicit user confirmation', async () => {
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => response({
    schema_version: 2,
      ok: true,
      stage: 'apply',
      status: 'applied',
      proposal_id: proposalId,
      fencing_token: fencingToken,
      recommended_action: 'ADD',
      target_relative_path: targetRelativePath,
      proposal_raw_sha256: proposalRawSha256,
      proposal_canonical_sha256: proposalCanonicalSha256,
      receipt_id: '1'.repeat(32),
      git_commit: '2'.repeat(40),
      completed_at: '2026-08-09T00:30:00+00:00',
      idempotent: false,
    }));
    const service = serviceWith(transport);

    const result = await service.apply(preparedResult(), {
      proposalMarkdown,
      confirmationReference: 'chat-message:user-confirmed-123',
    });

    const request = transport.mock.calls[0]?.[0];
    expect(request?.args).toEqual(memoryWriteArgs('apply'));
    expect(JSON.parse(request?.stdin ?? '{}')).toEqual({
      schema_version: 2,
      proposal_id: proposalId,
      fencing_token: fencingToken,
      target_relative_path: targetRelativePath,
      proposal_markdown: proposalMarkdown,
      proposal_raw_sha256: proposalRawSha256,
      proposal_canonical_sha256: proposalCanonicalSha256,
      confirmed_by: 'user',
      confirmation_reference: 'chat-message:user-confirmed-123',
    });
    expect(result).toMatchObject({
      operation: 'apply',
      status: 'applied',
      proposalId,
      fencingToken,
      receiptId: '1'.repeat(32),
      gitCommit: '2'.repeat(40),
    });
  });

  test('rejects an apply receipt with a different fencing token', async () => {
    const transport = vi.fn(async () => response({
      schema_version: 2,
      ok: true,
      stage: 'apply',
      status: 'applied',
      proposal_id: proposalId,
      fencing_token: fencingToken + 1,
      recommended_action: 'ADD',
      target_relative_path: targetRelativePath,
      proposal_raw_sha256: proposalRawSha256,
      proposal_canonical_sha256: proposalCanonicalSha256,
      receipt_id: '7'.repeat(32),
      git_commit: '8'.repeat(40),
      completed_at: '2026-08-09T00:35:00+00:00',
      idempotent: false,
    }));
    const service = serviceWith(transport, 'ailu-apply-fence-mismatch');

    await expect(service.apply(preparedResult(), {
      proposalMarkdown,
      confirmationReference: 'chat-message:user-confirmed-fence',
    })).rejects.toMatchObject({
      code: 'APPLY_BINDING_MISMATCH',
      operation: 'apply',
    });
    expect(service.getPendingProposals()).toEqual([{
      proposalId,
      fencingToken,
      applyAttempted: true,
    }]);
  });

  test('rejects a prepare result when the target changed after its read token was issued', async () => {
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => response({
      ...preparedPayload(),
      base_raw_sha256: '9'.repeat(64),
    }));
    const service = serviceWith(transport, 'ailu-stale-read-token');

    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      code: 'BASE_BINDING_MISMATCH',
      operation: 'prepare',
    });
  });

  test.each([
    {
      status: 'noop',
      action: 'NOOP',
      extra: {},
    },
    {
      status: 'merge_required',
      action: 'MERGE_REQUIRED',
      extra: { reason_code: 'MERGE_REQUIRED' },
    },
  ] as const)('returns $action as a terminal prepare result without a writable proposal', async item => {
    const transport = vi.fn(async () => response({
      ...preparedPayload(),
      status: item.status,
      recommended_action: item.action,
      confirmation_required: false,
      proposal_id: undefined,
      ...item.extra,
    }));
    const service = serviceWith(transport);

    const result = await service.prepare(prepareInput);

    expect(result.action).toBe(item.action);
    expect(result.confirmationRequired).toBe(false);
    expect('proposalId' in result).toBe(false);
    expect(service.getState().status).toBe(item.status);
  });

  test('surfaces a structured backend block without leaking arbitrary response fields', async () => {
    const transport = vi.fn(async () => response({
    schema_version: 2,
      ok: false,
      stage: 'prepare',
      status: 'blocked',
      reason_code: 'MERGE_REQUIRED',
      message: '发现冲突，需要用户选择。',
      retryable: false,
      private_excerpt: '不应暴露',
    }, 2));
    const service = serviceWith(transport);

    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      name: 'MemoryWriteError',
      code: 'MERGE_REQUIRED',
      operation: 'prepare',
      retryable: false,
      message: '发现冲突，需要用户选择。',
    });
    const state = service.getState();
    expect(state.status).toBe('blocked');
    expect(JSON.stringify(state)).not.toContain('不应暴露');
  });

  test('serializes write operations globally across service instances', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const callOrder: string[] = [];
    const firstTransport = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      callOrder.push('first:start');
      await firstGate;
      callOrder.push('first:end');
      active -= 1;
      return response(preparedPayload());
    });
    const secondTransport = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      callOrder.push('second:start');
      active -= 1;
      return response({
        ...preparedPayload(),
        proposal_id: '9'.repeat(32),
      });
    });
    const first = serviceWith(firstTransport, 'ailu-first');
    const second = serviceWith(secondTransport, 'ailu-second');

    const firstPromise = first.prepare(prepareInput);
    const secondPromise = second.prepare(prepareInput);
    await vi.waitFor(() => expect(firstTransport).toHaveBeenCalledTimes(1));
    expect(secondTransport).not.toHaveBeenCalled();
    expect(second.getState()).toMatchObject({ status: 'queued', operation: 'prepare' });

    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(maxActive).toBe(1);
    expect(callOrder).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('does not release the global queue until a timed-out process is actually killed', async () => {
    const ignoresTerm = [
      "process.on('SIGTERM', () => {});",
      'setInterval(() => {}, 1000);',
    ].join('');
    const firstTransport = vi.fn(async (request: MemoryWriteTransportRequest) => (
      runMemoryWriteProcess({
        ...request,
        args: ['-e', ignoresTerm, 'apply'],
      })
    ));
    const secondTransport = vi.fn(async (_request: MemoryWriteTransportRequest) => (
      response(preparedPayload())
    ));
    const first = new VerifiedMemoryWriteService({
      executablePath: process.execPath,
      sessionId: 'ailu-timeout',
      // Give Node enough time to install the SIGTERM handler before the
      // timeout fires; otherwise a loaded test runner can terminate the
      // helper before it reaches the behavior this test is meant to cover.
      applyTimeoutMs: 250,
      transport: firstTransport,
      runtimeGate: readyRuntimeGate(),
    });
    const second = serviceWith(secondTransport, 'ailu-after-timeout');
    const startedAt = Date.now();
    let firstSettled = false;

    const firstOutcome = first.apply(preparedResult(), {
      proposalMarkdown,
      confirmationReference: 'chat-message:timeout-confirmed',
    }).then(
      () => null,
      (error: unknown) => {
        firstSettled = true;
        return error;
      },
    );
    const secondPromise = second.prepare(prepareInput);
    await new Promise(resolve => nodeSetTimeout(resolve, 350));

    expect(firstSettled).toBe(false);
    expect(secondTransport).not.toHaveBeenCalled();

    const firstError = await firstOutcome;
    expect(firstError).toBeInstanceOf(MemoryWriteError);
    expect(firstError).toMatchObject({ code: 'WRITE_PROCESS_TIMEOUT' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    await expect(secondPromise).resolves.toMatchObject({ status: 'prepared' });
    expect(secondTransport).toHaveBeenCalledTimes(1);
  }, 5_000);

  test('waits for teardown after terminating a process with oversized output', async () => {
    const oversizedHelper = [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('x'.repeat(4096));",
      'setInterval(() => {}, 1000);',
    ].join('');
    const startedAt = Date.now();

    await expect(runMemoryWriteProcess({
      executablePath: process.execPath,
      args: ['-e', oversizedHelper, 'apply'],
      stdin: '',
      sessionId: 'ailu-oversized-output',
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    })).rejects.toMatchObject({ code: 'WRITE_RESPONSE_TOO_LARGE' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  }, 5_000);

  test('shutdown rejects new work and waits for an active apply to finish', async () => {
    let releaseApply: (() => void) | undefined;
    const applyGate = new Promise<void>(resolve => {
      releaseApply = resolve;
    });
    const transport = vi.fn(async (_request: MemoryWriteTransportRequest) => {
      await applyGate;
      return response({
    schema_version: 2,
        ok: true,
        stage: 'apply',
        status: 'applied',
        proposal_id: proposalId,
        fencing_token: fencingToken,
        recommended_action: 'ADD',
        target_relative_path: targetRelativePath,
        proposal_raw_sha256: proposalRawSha256,
        proposal_canonical_sha256: proposalCanonicalSha256,
        receipt_id: '3'.repeat(32),
        git_commit: '4'.repeat(40),
        completed_at: '2026-08-09T00:40:00+00:00',
        idempotent: false,
      });
    });
    const service = serviceWith(transport, 'ailu-shutdown');
    const applyPromise = service.apply(preparedResult(), {
      proposalMarkdown,
      confirmationReference: 'chat-message:shutdown-confirmed',
    });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    let shutdownSettled = false;

    const shutdownPromise = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await expect(service.prepare(prepareInput)).rejects.toMatchObject({
      code: 'WRITE_SERVICE_SHUTDOWN',
    });
    await new Promise(resolve => nodeSetTimeout(resolve, 50));
    expect(shutdownSettled).toBe(false);

    releaseApply?.();
    await expect(applyPromise).resolves.toMatchObject({ status: 'applied' });
    await shutdownPromise;
    expect(service.getState()).toEqual({ status: 'shutdown' });
    await expect(service.readTarget(targetRelativePath)).rejects.toMatchObject({
      code: 'WRITE_SERVICE_SHUTDOWN',
    });
    await expect(service.shutdown()).resolves.toBeUndefined();
  });

  test('rejects a successful parent result until its leftover process group is gone', async () => {
    if (process.platform === 'win32') return;
    const orphanHelper = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000);\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "child.on('message', () => { child.disconnect(); child.unref(); process.stdout.write(JSON.stringify({ schema_version: 2, ok: true, stage: 'prepare' })); });",
    ].join('');

    const startedAt = Date.now();
    await expect(runMemoryWriteProcess({
      executablePath: process.execPath,
      args: ['-e', orphanHelper, 'prepare'],
      stdin: '',
      sessionId: 'ailu-orphan-result',
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
    })).rejects.toMatchObject({ code: 'WRITE_PROCESS_TREE_REMAINED' });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test('shutdown cancels a prepared proposal that was never applied', async () => {
    const transport = vi.fn(async (request: MemoryWriteTransportRequest) => {
      if (request.args.includes('prepare')) return response(preparedPayload());
      return response({
    schema_version: 2,
        ok: true,
        stage: 'cancel',
        status: 'cancelled',
        proposal_id: proposalId,
        fencing_token: fencingToken,
        idempotent: false,
      });
    });
    const service = serviceWith(transport, 'ailu-shutdown-cancel');
    await service.prepare(prepareInput);
    expect(service.getPendingProposals()).toEqual([{
      proposalId,
      fencingToken,
      applyAttempted: false,
    }]);

    await service.shutdown();

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]?.[0].args).toEqual(memoryWriteArgs('cancel'));
    expect(service.getPendingProposals()).toEqual([]);
    expect(service.getState()).toEqual({ status: 'shutdown' });
  });

  test('shutdown recovers an apply only when guarded cancel reports content was written', async () => {
    let applyCalls = 0;
    const operationOrder: string[] = [];
    const transport = vi.fn(async (request: MemoryWriteTransportRequest) => {
      if (request.args.includes('cancel')) {
        operationOrder.push('cancel');
        return response({
    schema_version: 2,
          ok: false,
          stage: 'cancel',
          status: 'blocked',
          reason_code: 'APPLY_RECOVERY_REQUIRED',
          message: '必须完成已确认的应用收尾。',
          retryable: true,
        }, 2);
      }
      applyCalls += 1;
      operationOrder.push('apply');
      if (applyCalls === 1) {
        return response({
    schema_version: 2,
          ok: false,
          stage: 'apply',
          status: 'blocked',
          reason_code: 'CLOSEOUT_FAILED',
          message: '收尾失败。',
          retryable: true,
        }, 2);
      }
      return response({
    schema_version: 2,
        ok: true,
        stage: 'apply',
        status: 'applied',
        proposal_id: proposalId,
        fencing_token: fencingToken,
        recommended_action: 'ADD',
        target_relative_path: targetRelativePath,
        proposal_raw_sha256: proposalRawSha256,
        proposal_canonical_sha256: proposalCanonicalSha256,
        receipt_id: '5'.repeat(32),
        git_commit: '6'.repeat(40),
        completed_at: '2026-08-09T00:50:00+00:00',
        idempotent: true,
      });
    });
    const service = serviceWith(transport, 'ailu-shutdown-recovery');

    await expect(service.apply(preparedResult(), {
      proposalMarkdown,
      confirmationReference: 'chat-message:recovery-confirmed',
    })).rejects.toMatchObject({ code: 'CLOSEOUT_FAILED' });
    expect(service.getPendingProposals()).toEqual([{
      proposalId,
      fencingToken,
      applyAttempted: true,
    }]);

    await service.shutdown();

    expect(operationOrder).toEqual(['apply', 'cancel', 'apply']);
    expect(service.getPendingProposals()).toEqual([]);
    expect(service.getState()).toEqual({ status: 'shutdown' });
  });

  test('cancels only a concrete prepared proposal ID', async () => {
    const transport = vi.fn(async (request: MemoryWriteTransportRequest) => {
      if (request.args.includes('prepare')) return response(preparedPayload());
      return response({
        schema_version: 2,
        ok: true,
        stage: 'cancel',
        status: 'cancelled',
        proposal_id: proposalId,
        fencing_token: fencingToken,
        idempotent: true,
      });
    });
    const service = serviceWith(transport);

    await expect(service.cancel('not-an-id')).rejects.toBeInstanceOf(MemoryWriteError);
    await service.prepare(prepareInput);
    await expect(service.cancel(proposalId)).resolves.toEqual({
      operation: 'cancel',
      status: 'cancelled',
      proposalId,
      fencingToken,
      idempotent: true,
    });
    expect(JSON.parse(transport.mock.calls[1]?.[0].stdin ?? '{}')).toEqual({
      schema_version: 2,
      proposal_id: proposalId,
      fencing_token: fencingToken,
    });
  });
});
