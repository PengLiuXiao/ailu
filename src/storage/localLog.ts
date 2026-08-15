import fs from 'fs';
import path from 'path';

import { logsDir } from '../paths';
import { ensureDir } from '../utils/fs';

const DIAGNOSTIC_STRING_KEYS = new Set([
  'agentId',
  'status',
  'stage',
  'failureKind',
  'model',
]);
const DIAGNOSTIC_NUMBER_KEYS = new Set([
  'mediaCount',
  'bodyImageCount',
  'tableCount',
  'warningCount',
  'errorCount',
  'cookieCount',
]);
const DIAGNOSTIC_BOOLEAN_KEYS = new Set([
  'coverIncluded',
  'headed',
]);
const DIAGNOSTIC_EVENT_PATTERN = /^[a-z0-9_]{1,80}$/;
const DIAGNOSTIC_VALUE_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export function appendLocalLog(event: string, detail: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = logsDir(env);
    ensureDir(dir);
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `${date}.log`);
    const sanitizedDetail = sanitizeLogValue(detail) as Record<string, unknown>;
    const line = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...sanitizedDetail,
    });
    fs.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // chmod is best-effort on some filesystems.
    }
  } catch {
    // Local logging should never interrupt agent work.
  }
}

function sanitizeLogValue(value: unknown, key = ''): unknown {
  if (key === 'anthropicAuthMode') {
    return value;
  }
  if (/api.?key|auth(?:orization)?|secret|token/i.test(key)) {
    return value ? '<redacted>' : value;
  }
  if (typeof value === 'string') {
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>');
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeLogValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeLogValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export function buildRedactedDiagnosticBundle(
  options: {
    pluginVersion?: string;
    maxRecords?: number;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  } = {},
): string {
  const records: Array<Record<string, unknown>> = [];
  const maxRecords = Math.max(1, Math.min(500, options.maxRecords ?? 200));
  const directory = logsDir(options.env ?? process.env);
  try {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isSymbolicLink() && directoryStat.isDirectory()) {
      const files = fs.readdirSync(directory)
        .filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort()
        .slice(-3);
      for (const name of files) {
        const filePath = path.join(directory, name);
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
        for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const source = JSON.parse(line) as unknown;
            const record = redactDiagnosticRecord(source);
            if (record) records.push(record);
          } catch {
            // A malformed local line is omitted instead of copied verbatim.
          }
        }
      }
    }
  } catch {
    // A missing or unsafe log directory produces an empty, still-useful bundle.
  }
  const bounded = records.slice(-maxRecords);
  return `${JSON.stringify({
    schema: 'ailu-redacted-diagnostics-v1',
    generatedAt: (options.now ?? new Date()).toISOString(),
    pluginVersion: safeDiagnosticString(options.pluginVersion) ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    recordCount: bounded.length,
    records: bounded,
    privacy: 'No prompts, article content, credentials, headers, draft URLs, media IDs, or local paths are included.',
  }, null, 2)}\n`;
}

function redactDiagnosticRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const event = typeof source.event === 'string' && DIAGNOSTIC_EVENT_PATTERN.test(source.event)
    ? source.event
    : null;
  if (!event) return null;
  const record: Record<string, unknown> = { event };
  if (typeof source.at === 'string' && Number.isFinite(Date.parse(source.at))) {
    record.at = new Date(source.at).toISOString();
  }
  for (const key of DIAGNOSTIC_STRING_KEYS) {
    const safe = safeDiagnosticString(source[key]);
    if (safe !== null) record[key] = safe;
  }
  for (const key of DIAGNOSTIC_NUMBER_KEYS) {
    const candidate = source[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)
      && candidate >= 0 && candidate <= 1_000_000) record[key] = candidate;
  }
  for (const key of DIAGNOSTIC_BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') record[key] = source[key];
  }
  return record;
}

function safeDiagnosticString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return DIAGNOSTIC_VALUE_PATTERN.test(trimmed) ? trimmed : null;
}
