import { vi } from 'vitest';

import {
  AiluMemoryRuntimeGate,
  invalidateAiluMemoryRuntimeHandshakeCache,
  type AiluMemoryRuntimeHandshakeTransportRequest,
  type AiluMemoryRuntimeIdentity,
} from '../src/memory/runtimeHandshake';

const executableRealpath = '/test/agent-memory/bin/memoryctl';
const manifestRealpath = '/test/agent-memory/config/runtime-manifest.json';
const runtimeIntegritySha256 = 'a'.repeat(64);
const manifestSha256 = 'b'.repeat(64);
const bundleSha256 = 'c'.repeat(64);
const runtimeFilesIntegritySha256 = 'd'.repeat(64);

function identity(mtime = '1', marker = 'marker-a'): AiluMemoryRuntimeIdentity {
  return {
    executableRealpath,
    manifestRealpath,
    manifestMtimeNs: mtime,
    transitionMarkerFingerprint: marker,
  };
}

function compatibleResponse(): string {
  return JSON.stringify({
    schema_version: 2,
    ok: true,
    ready: true,
    runtime_api_version: 2,
    writer_protocol_version: 2,
    canonical_actors: ['codex', 'claude', 'ailu'],
    runtime_integrity_sha256: runtimeIntegritySha256,
    manifest_sha256: manifestSha256,
    runtime_transition: {
      ready: true,
      phase: 'ready',
      runtime_integrity_sha256: runtimeIntegritySha256,
      runtime_integrity: {
        ok: true,
        bundle_sha256: bundleSha256,
        manifest_sha256: manifestSha256,
        runtime_integrity_sha256: runtimeFilesIntegritySha256,
        file_count: 20,
        mismatched_count: 0,
      },
      state: {
        ok: true,
        state_schema_version: '3',
        writer_protocol_version: '2',
        missing_tables: [],
        missing_incident_columns: [],
        quick_check: 'ok',
      },
    },
  });
}

describe('Ailu Agent Memory runtime handshake', () => {
  beforeEach(() => {
    invalidateAiluMemoryRuntimeHandshakeCache();
  });

  test('uses the v2 actor handshake and caches by binary identity plus manifest mtime', async () => {
    let currentIdentity = identity();
    const resolveIdentity = vi.fn(async () => ({ ...currentIdentity }));
    const transport = vi.fn(async (_request: AiluMemoryRuntimeHandshakeTransportRequest) => ({
      exitCode: 0,
      stdout: compatibleResponse(),
    }));
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity,
      transport,
    });

    const first = await gate.assertReady();
    expect(first).toMatchObject({
      schemaVersion: 2,
      runtimeApiVersion: 2,
      writerProtocolVersion: 2,
      manifestMtimeNs: '1',
      runtimeIntegritySha256,
      manifestSha256,
    });
    expect(first.canonicalActors).toContain('ailu');
    await expect(gate.assertReady()).resolves.toMatchObject({ manifestMtimeNs: '1' });

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      executablePath: executableRealpath,
      args: ['--actor', 'ailu', 'version', '--json'],
    }));

    currentIdentity = identity('2');
    await expect(gate.assertReady()).resolves.toMatchObject({ manifestMtimeNs: '2' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test.each([
    { runtime_api_version: 1 },
    { writer_protocol_version: 1 },
    { ready: false },
    { canonical_actors: ['codex', 'claude'] },
  ])('fails closed and never caches an incompatible response: %j', async override => {
    const transport = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        schema_version: 2,
        ok: true,
        ready: true,
        runtime_api_version: 2,
        writer_protocol_version: 2,
        canonical_actors: ['ailu'],
        runtime_integrity_sha256: runtimeIntegritySha256,
        manifest_sha256: manifestSha256,
        runtime_transition: {
          ready: true,
          runtime_integrity_sha256: runtimeIntegritySha256,
          runtime_integrity: {
            ok: true,
            bundle_sha256: bundleSha256,
            manifest_sha256: manifestSha256,
            runtime_integrity_sha256: runtimeFilesIntegritySha256,
            file_count: 20,
            mismatched_count: 0,
          },
          state: {
            ok: true,
            state_schema_version: '3',
            writer_protocol_version: '2',
            missing_tables: [],
            missing_incident_columns: [],
            quick_check: 'ok',
          },
        },
        ...override,
      }),
    }));
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity: async () => identity(),
      transport,
    });

    await expect(gate.assertReady()).rejects.toMatchObject({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
    });
    await expect(gate.assertReady()).rejects.toMatchObject({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  test('rejects a handshake if the executable or manifest identity changes in flight', async () => {
    const resolveIdentity = vi.fn()
      .mockResolvedValueOnce(identity('1'))
      .mockResolvedValueOnce(identity('2'));
    const transport = vi.fn(async () => ({
      exitCode: 0,
      stdout: compatibleResponse(),
    }));
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity,
      transport,
    });

    await expect(gate.assertReady()).rejects.toMatchObject({
      code: 'RUNTIME_IDENTITY_CHANGED',
    });
  });

  test('invalidates on transition marker changes and after the short cache TTL', async () => {
    let now = 1_000;
    let currentIdentity = identity('1', 'marker-a');
    const transport = vi.fn(async () => ({ exitCode: 0, stdout: compatibleResponse() }));
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity: async () => ({ ...currentIdentity }),
      transport,
      cacheTtlMs: 50,
      now: () => now,
    });

    await gate.assertReady();
    await gate.assertReady();
    expect(transport).toHaveBeenCalledTimes(1);

    currentIdentity = identity('1', 'marker-b');
    await gate.assertReady();
    expect(transport).toHaveBeenCalledTimes(2);

    now += 51;
    await gate.assertReady();
    expect(transport).toHaveBeenCalledTimes(3);
  });

  test('fails closed when the runtime transition state is not schema-v3 ready', async () => {
    const payload = JSON.parse(compatibleResponse()) as Record<string, unknown>;
    const transition = payload.runtime_transition as { state: Record<string, unknown> };
    transition.state.quick_check = 'corrupt';
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity: async () => identity(),
      transport: async () => ({ exitCode: 0, stdout: JSON.stringify(payload) }),
    });

    await expect(gate.assertReady()).rejects.toMatchObject({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
    });
  });

  test('fails closed when the nested runtime-files digest is malformed', async () => {
    const payload = JSON.parse(compatibleResponse()) as Record<string, unknown>;
    const transition = payload.runtime_transition as {
      runtime_integrity: Record<string, unknown>;
    };
    transition.runtime_integrity.runtime_integrity_sha256 = 'not-a-digest';
    const gate = new AiluMemoryRuntimeGate({
      executablePath: '/configured/memoryctl',
      resolveIdentity: async () => identity(),
      transport: async () => ({ exitCode: 0, stdout: JSON.stringify(payload) }),
    });

    await expect(gate.assertReady()).rejects.toMatchObject({
      code: 'RUNTIME_HANDSHAKE_INCOMPATIBLE',
    });
  });
});
