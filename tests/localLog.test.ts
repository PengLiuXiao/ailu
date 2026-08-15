import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendLocalLog, buildRedactedDiagnosticBundle } from '../src/storage/localLog';

describe('local logging', () => {
  test('keeps the authentication mode while redacting credentials', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-log-'));
    try {
      appendLocalLog('runtime_turn_start', {
        providerHost: 'api.moonshot.cn',
        model: 'kimi-k3',
        anthropicAuthMode: 'authToken',
        apiKey: 'sk-secret-value',
        authorization: 'Bearer secret-value',
      }, { AILU_HOME: tempDir });

      const [file] = fs.readdirSync(path.join(tempDir, 'logs'));
      const record = JSON.parse(fs.readFileSync(path.join(tempDir, 'logs', file), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({
        providerHost: 'api.moonshot.cn',
        model: 'kimi-k3',
        anthropicAuthMode: 'authToken',
        apiKey: '<redacted>',
        authorization: '<redacted>',
      });
      expect(JSON.stringify(record)).not.toContain('secret-value');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('exports only an allowlisted diagnostic shape with no content, URL, identifier, or path leakage', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ailu-log-export-'));
    try {
      appendLocalLog('x_article_upload_partial_draft', {
        status: 'partial',
        sourceHash: 'abc123def456',
        mediaCount: 14,
        draftUrl: 'https://x.com/compose/articles/edit/secret-draft',
        diagnosticLog: '/Users/example/private/run.log',
        sourcePath: '/Users/example/Vault/private.md',
        mediaId: 'secret-media-id',
        openId: 'secret-open-id',
        headers: { authorization: 'Bearer secret-token' },
        body: 'private article body',
        error: 'Cookie auth_token=secret-cookie',
      }, { AILU_HOME: tempDir });

      const exported = buildRedactedDiagnosticBundle({
        env: { AILU_HOME: tempDir },
        pluginVersion: '0.2.0',
        now: new Date('2026-08-14T12:00:00.000Z'),
      });
      const parsed = JSON.parse(exported) as { records: Array<Record<string, unknown>> };
      expect(parsed.records).toEqual([expect.objectContaining({
        event: 'x_article_upload_partial_draft',
        status: 'partial',
        mediaCount: 14,
      })]);
      for (const forbidden of [
        'secret-draft', 'private.md', 'run.log', 'secret-media-id', 'secret-open-id',
        'secret-token', 'private article body', 'secret-cookie', '/Users/', 'auth_token',
        'abc123def456',
      ]) expect(exported).not.toContain(forbidden);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
