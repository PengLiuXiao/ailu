import { spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { decodeHTML } from 'entities';

import { normalizeXCookieJsonText } from './cookieStore';

import {
  addPreparedMarkdownPreflightErrors,
  parseXArticlePreflightJson,
  validateXArticlePreflight,
} from './preflight';
import {
  X_ARTICLE_CONTENT_LENGTH_UNIT,
  X_ARTICLE_COVER_RATIO,
  type PreparedXArticleMarkdown,
  type XArticleCookieStatus,
  type XArticlePreflight,
  type XArticleProgressCallback,
  type XArticleRunOptions,
  type XArticleSkillRuntime,
  type XArticleUploadArtifacts,
  type XArticleUploadFailureKind,
  type XArticleUploadOptions,
  type XArticleUploadOutcome,
  type XArticleUploadResult,
} from './types';

const UPLOAD_SCRIPT = 'upload_markdown_to_x_article.py';
const PARSE_SCRIPT = 'parse_markdown.py';
const COOKIE_SCRIPT = 'export_x_cookies_from_chrome.py';
const X_ARTICLE_DRAFT_URL_PREFIX = 'https://x.com/compose/articles/edit/';
const STRICT_RESULT_OK_LINE = 'RESULT_OK True';
const X_ARTICLE_PERSISTENCE_CONTRACT = 'x-article-persistence-v1';
const X_ARTICLE_VISUAL_SIGNATURE = /^visual-dhash-v1:[0-9a-f]{64}$/;
const X_ARTICLE_SOURCE_SAMPLE_ID = /^[0-9a-f]{16}$/;
const X_ARTICLE_MEDIA_BINDING_KEY = /^media-v1-[0-9a-f]{64}$/;
// 64-bit radius (25% of the 256-bit dHash) tolerates X's resize/recompression
// of very large text-heavy screenshots (observed ~39 bits on a 2948px-wide
// image) while still rejecting unrelated images (measured ~82+ bits).
const X_ARTICLE_VISUAL_MAX_HAMMING_DISTANCE = 64;
const X_ARTICLE_VISUAL_ADAPTIVE_MAX_HAMMING_DISTANCE = 80;
const X_ARTICLE_VISUAL_ADAPTIVE_MIN_MARGIN = 16;
const X_ARTICLE_VISUAL_ASPECT_RATIO_MAX_RELATIVE_DRIFT = 0.03;
const X_ARTICLE_RGB_SAMPLE_MAX_MAE = 0.12;
const X_ARTICLE_LUMA_SAMPLE_MAX_MAE = 0.10;
const X_ARTICLE_LUMA_CORRELATION_MIN = 0.88;
const X_ARTICLE_SAMPLE_MIN_NEAREST_MARGIN = 0.008;
const X_ARTICLE_FLOAT_TOLERANCE = 1e-12;
const DEFAULT_UPLOAD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_CHARS = 256_000;

export function shouldAutoOpenXArticleDraft(
  status: XArticleUploadOutcome['status'],
  openAfterSuccess: boolean,
): boolean {
  return status === 'success' && openAfterSuccess;
}

export interface XArticleRuntimeDiscoveryOptions {
  uploadScriptPath?: string;
  homeDirectory?: string;
  fileExists?: (filePath: string) => boolean;
}

export interface XArticleFileStat {
  isFile: boolean;
  size: number;
  mtimeMs: number;
  mode?: number;
}

export interface XArticleUploaderDependencies {
  spawn: typeof spawn;
  createPrivateFile(filePath: string): Promise<void>;
  fileExists(filePath: string): Promise<boolean>;
  readBytes(filePath: string): Promise<Uint8Array>;
  readText(filePath: string): Promise<string>;
  writeTextPrivate(filePath: string, text: string): Promise<void>;
  stat(filePath: string): Promise<XArticleFileStat>;
  chmod(filePath: string, mode: number): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  now(): number;
  tempDirectory(): string;
}

export interface XArticleLocalUploaderOptions {
  pythonCommand?: string;
  uploadScriptPath?: string;
  cookiesPath: string;
  autoExportCookiesWhenMissing?: boolean;
  headed?: boolean;
  timeoutMs?: number;
  preflightTimeoutMs?: number;
  authorizeCookieMutation?: () => Promise<void>;
  commitCanonicalCookies?: (normalizedJson: string) => Promise<{ path: string; cookieCount: number }>;
  runtime?: XArticleSkillRuntime;
  dependencies?: Partial<XArticleUploaderDependencies>;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

const defaultDependencies: XArticleUploaderDependencies = {
  spawn,
  createPrivateFile: async filePath => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const parent = await fsp.lstat(path.dirname(filePath));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error('X private output directory is unsafe.');
    }
    await fsp.chmod(path.dirname(filePath), 0o700);
    const handle = await fsp.open(filePath, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
  },
  fileExists: async filePath => {
    try {
      const stat = await fsp.lstat(filePath);
      return !stat.isSymbolicLink() && stat.isFile();
    } catch {
      return false;
    }
  },
  readBytes: filePath => fsp.readFile(filePath),
  readText: filePath => fsp.readFile(filePath, 'utf8'),
  writeTextPrivate: async (filePath, text) => {
    const directory = path.dirname(filePath);
    const parent = await fsp.lstat(directory);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error('Ailu private output directory is unsafe.');
    }
    const existing = await fsp.lstat(filePath).catch(error => {
      if (error && typeof error === 'object' && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT') return null;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Ailu private output target is unsafe.');
    }
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(text, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await fsp.lstat(filePath).catch(error => {
      if (error && typeof error === 'object' && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT') return null;
      throw error;
    });
    if (current && (current.isSymbolicLink() || !current.isFile())) {
      throw new Error('Ailu private output target changed before commit.');
    }
    await fsp.rename(temporary, filePath);
    await fsp.chmod(filePath, 0o600);
    const directoryHandle = await fsp.open(directory, fs.constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  },
  stat: async filePath => {
    const value = await fsp.lstat(filePath);
    return {
      isFile: !value.isSymbolicLink() && value.isFile(),
      size: value.size,
      mtimeMs: value.mtimeMs,
      mode: value.mode,
    };
  },
  chmod: (filePath, mode) => fsp.chmod(filePath, mode),
  mkdtemp: prefix => fsp.mkdtemp(prefix),
  now: () => Date.now(),
  tempDirectory: () => os.tmpdir(),
};

function runtimeFromUploadScript(
  uploadScript: string,
  source: XArticleSkillRuntime['source'],
  fileExists: (filePath: string) => boolean,
): XArticleSkillRuntime | null {
  const normalized = path.resolve(uploadScript);
  const scriptsDirectory = path.dirname(normalized);
  const skillDirectory = path.dirname(scriptsDirectory);
  const parseScript = path.join(scriptsDirectory, PARSE_SCRIPT);
  const cookieExportScript = path.join(scriptsDirectory, COOKIE_SCRIPT);
  const skillFile = path.join(skillDirectory, 'SKILL.md');
  if (path.basename(scriptsDirectory) !== 'scripts'
    || path.basename(skillDirectory) !== 'x-article-draft-uploader'
    || ![normalized, parseScript, cookieExportScript, skillFile].every(fileExists)) return null;
  return { scriptsDirectory, uploadScript: normalized, parseScript, cookieExportScript, source };
}

export function discoverXArticleSkill(
  options: XArticleRuntimeDiscoveryOptions = {},
): XArticleSkillRuntime {
  const fileExists = options.fileExists ?? (filePath => {
    try {
      return fs.statSync(filePath).isFile();
    } catch {
      return false;
    }
  });
  if (options.uploadScriptPath?.trim()) {
    const configured = runtimeFromUploadScript(options.uploadScriptPath.trim(), 'configured', fileExists);
    if (!configured) throw new Error('Configured X Article Skill scripts are incomplete.');
    return configured;
  }
  const home = options.homeDirectory ?? os.homedir();
  const candidates: Array<[string, XArticleSkillRuntime['source']]> = [
    [path.join(home, '.agents/skills/x-article-draft-uploader/scripts', UPLOAD_SCRIPT), 'agents-skill'],
    [path.join(home, '.codex/skills/x-article-draft-uploader/scripts', UPLOAD_SCRIPT), 'codex-skill'],
  ];
  for (const [candidate, source] of candidates) {
    const runtime = runtimeFromUploadScript(candidate, source, fileExists);
    if (runtime) return runtime;
  }
  throw new Error('Current X Article draft uploader Skill was not found.');
}

function mergeDependencies(overrides: Partial<XArticleUploaderDependencies> = {}): XArticleUploaderDependencies {
  return { ...defaultDependencies, ...overrides };
}

function appendBounded(current: string, chunk: string): { value: string; truncated: boolean } {
  const next = current + chunk;
  if (next.length <= MAX_CAPTURE_CHARS) return { value: next, truncated: false };
  return { value: next.slice(-MAX_CAPTURE_CHARS), truncated: true };
}

function safeDraftUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (!trimmed.startsWith(X_ARTICLE_DRAFT_URL_PREFIX)) return null;
  const articleId = trimmed.slice(X_ARTICLE_DRAFT_URL_PREFIX.length);
  return /^\d+$/.test(articleId) ? trimmed : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stdoutDraftUrl(stdout: string): string | null {
  const matches = [...stdout.matchAll(/^draft_url=(.+)$/gm)];
  return safeDraftUrl(matches.at(-1)?.[1]);
}

function failureKind(result: ProcessResult): XArticleUploadFailureKind {
  if (result.cancelled) return 'cancelled';
  if (result.timedOut) return 'timed-out';
  return 'failed';
}

function sanitizeProcessDiagnostic(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(
      /("value"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /("name"\s*:\s*"(?:auth_token|ct0)"\s*,\s*"value"\s*:\s*)"[^"]*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /("value"\s*:\s*)"[^"]*"(\s*,\s*"name"\s*:\s*"(?:auth_token|ct0)")/gi,
      '$1"<redacted>"$2',
    )
    .replace(
      /("(?:auth_token|ct0|cookie|authorization)"\s*:\s*)"[^"]*"/gi,
      '$1"<redacted>"',
    )
    .replace(
      /\b(auth_token|ct0|cookie|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2<redacted>',
    );
}

function assertSupportedXCookieJsonForReplacement(text: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('X Cookie content was not valid JSON.');
  }
  let cookies: unknown[];
  if (Array.isArray(parsed)) {
    cookies = parsed;
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.cookies)) {
      throw new Error('X Cookie content was not a supported Cookie container.');
    }
    cookies = record.cookies;
  } else {
    throw new Error('X Cookie content was not a supported Cookie container.');
  }

  // The canonical file is owned by this integration once it has a supported
  // Cookie container whose records all satisfy the X-domain schema. Probe that
  // schema without applying freshness or required-name checks: an expired file,
  // or one missing auth_token/ct0, must remain safely refreshable from Chrome.
  normalizeXCookieJsonText(JSON.stringify([
    ...cookies,
    { name: 'auth_token', value: 'replacement-validation', domain: 'x.com', path: '/' },
    { name: 'ct0', value: 'replacement-validation', domain: 'x.com', path: '/' },
  ]), { nowEpochSeconds: 0 });
}

function processDiagnosticText(result: ProcessResult): string {
  return `${JSON.stringify({
    exitCode: result.code,
    cancelled: result.cancelled,
    timedOut: result.timedOut,
    truncated: result.truncated,
    stdout: sanitizeProcessDiagnostic(result.stdout),
    stderr: sanitizeProcessDiagnostic(result.stderr),
  }, null, 2)}\n`;
}

async function tightenArtifactPermissions(
  dependencies: Pick<XArticleUploaderDependencies, 'fileExists' | 'chmod'>,
  artifacts: XArticleUploadArtifacts,
): Promise<string[]> {
  const failures: string[] = [];
  for (const filePath of [artifacts.resultJson, artifacts.url, artifacts.screenshot, artifacts.log]) {
    try {
      if (await dependencies.fileExists(filePath)) {
        await dependencies.chmod(filePath, 0o600);
      }
    } catch {
      failures.push(path.basename(filePath));
    }
  }
  return failures;
}

function processFailureSummary(result: ProcessResult): string | null {
  if (result.cancelled) return '操作收到取消信号；上传脚本没有返回错误。';
  if (result.timedOut) return '操作超过等待时限。';
  const progressLine = /^(?:\[\d+\/\d+\]|draft_url=|image \d+\/\d+|table \d+\/\d+|COVER_REMINDER\b)/;
  const diagnosticLines = (result.stderr.trim() || result.stdout.trim())
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => Boolean(line) && !progressLine.test(line));
  const lastLine = diagnosticLines.at(-1);
  if (!lastLine) return null;
  return sanitizeProcessDiagnostic(lastLine).slice(0, 320);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('X Article result JSON must be an object.');
  }
  return value as Record<string, unknown>;
}

function exactInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid.`);
  return value as number;
}

function exactFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function exactSignedFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function finiteNumbersMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= X_ARTICLE_FLOAT_TOLERANCE;
}

function exactStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} is invalid.`);
  }
  return value as string[];
}

function exactIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some(item => !Number.isInteger(item) || item < 0)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number[];
}

function exactStringMatrix(value: unknown, label: string): string[][] {
  if (!Array.isArray(value) || value.some(row => (
    !Array.isArray(row) || row.some(cell => typeof cell !== 'string')
  ))) {
    throw new Error(`${label} is invalid.`);
  }
  return value as string[][];
}

function visualSignatureHammingDistance(left: string, right: string, label: string): number {
  if (!X_ARTICLE_VISUAL_SIGNATURE.test(left) || !X_ARTICLE_VISUAL_SIGNATURE.test(right)) {
    throw new Error(`${label} contains an invalid visual signature.`);
  }
  let difference = BigInt(`0x${left.slice(left.indexOf(':') + 1)}`)
    ^ BigInt(`0x${right.slice(right.indexOf(':') + 1)}`);
  let distance = 0;
  while (difference > 0n) {
    difference &= difference - 1n;
    distance += 1;
  }
  return distance;
}

interface UniqueSourceAssignment {
  distinctSourceSignatures: string[];
  sourceGroupOccurrences: number[];
  distances: number[];
  expectedDistance: number;
  expectedIsUniqueNearest: boolean;
  nearestDistance: number;
  nearestSignatures: string[];
  secondNearestDistance: number | null;
  nearestMargin: number | null;
}

function computeSourceAssignment(
  expectedSourceSignature: string,
  observedSignature: string,
  allSourceSignatures: string[],
  label: string,
): UniqueSourceAssignment {
  const distinctSources = [...new Set(allSourceSignatures)];
  const distances = distinctSources.map(sourceSignature => (
    visualSignatureHammingDistance(sourceSignature, observedSignature, label)
  ));
  const nearestDistance = Math.min(...distances);
  const nearestSignatures = distinctSources.filter((_, offset) => (
    distances[offset] === nearestDistance
  ));
  const expectedDistance = visualSignatureHammingDistance(
    expectedSourceSignature,
    observedSignature,
    label,
  );
  const otherDistances = distinctSources
    .filter(sourceSignature => sourceSignature !== expectedSourceSignature)
    .map(sourceSignature => visualSignatureHammingDistance(sourceSignature, observedSignature, label));
  const secondNearestDistance = otherDistances.length > 0 ? Math.min(...otherDistances) : null;
  const expectedIsUniqueNearest = nearestSignatures.length === 1
    && nearestSignatures[0] === expectedSourceSignature;
  const nearestMargin = expectedIsUniqueNearest && secondNearestDistance !== null
    ? secondNearestDistance - expectedDistance
    : null;
  return {
    distinctSourceSignatures: distinctSources,
    sourceGroupOccurrences: distinctSources.map(source => (
      allSourceSignatures.filter(candidate => candidate === source).length
    )),
    distances,
    expectedDistance,
    expectedIsUniqueNearest,
    nearestDistance,
    nearestSignatures,
    secondNearestDistance,
    nearestMargin,
  };
}

interface ValidatedVisualDimensions {
  aspectMatches: boolean;
}

function validateVisualDimensions(
  value: Record<string, unknown>,
  observedWidthValue: unknown,
  observedHeightValue: unknown,
  label: string,
): ValidatedVisualDimensions {
  const sourceWidth = exactInteger(value.source_natural_width, `${label}.source_natural_width`);
  const sourceHeight = exactInteger(value.source_natural_height, `${label}.source_natural_height`);
  const observedWidth = exactInteger(observedWidthValue, `${label}.observed_natural_width`);
  const observedHeight = exactInteger(observedHeightValue, `${label}.observed_natural_height`);
  if (sourceWidth < 1 || sourceHeight < 1 || observedWidth < 1 || observedHeight < 1) {
    throw new Error(`${label} adaptive visual dimensions were invalid.`);
  }
  const sourceRatio = sourceWidth / sourceHeight;
  const observedRatio = observedWidth / observedHeight;
  const computedAspectDrift = Math.abs(observedRatio / sourceRatio - 1);
  const reportedAspectDrift = exactFiniteNumber(
    value.aspect_ratio_relative_drift,
    `${label}.aspect_ratio_relative_drift`,
  );
  const aspectMatches = computedAspectDrift <= X_ARTICLE_VISUAL_ASPECT_RATIO_MAX_RELATIVE_DRIFT;
  if ((value.observed_natural_width !== undefined
      && exactInteger(value.observed_natural_width, `${label}.reported_observed_natural_width`)
        !== observedWidth)
    || (value.observed_natural_height !== undefined
      && exactInteger(value.observed_natural_height, `${label}.reported_observed_natural_height`)
        !== observedHeight)
    || !finiteNumbersMatch(reportedAspectDrift, computedAspectDrift)
    || value.aspect_ratio_matches !== aspectMatches) {
    throw new Error(`${label} visual aspect-ratio evidence was inconsistent.`);
  }
  return { aspectMatches };
}

function validateReportedSourceAssignment(
  value: Record<string, unknown>,
  expectedSourceSignature: string,
  observedSignature: string,
  allSourceSignatures: string[],
  label: string,
): UniqueSourceAssignment {
  const computed = computeSourceAssignment(
    expectedSourceSignature,
    observedSignature,
    allSourceSignatures,
    label,
  );
  const reportedGroups = Array.isArray(value.source_group_distances)
    ? value.source_group_distances.map(asRecord)
    : [];
  const reportedNearest = exactStringArray(
    value.nearest_source_signatures,
    `${label}.nearest_source_signatures`,
  );
  const groupsMatch = reportedGroups.length === computed.distinctSourceSignatures.length
    && reportedGroups.every((group, offset) => (
      group.source_signature === computed.distinctSourceSignatures[offset]
      && exactInteger(
        group.source_group_occurrences,
        `${label}.source_group_distances[${offset}].source_group_occurrences`,
      ) === computed.sourceGroupOccurrences[offset]
      && exactInteger(
        group.hamming_distance,
        `${label}.source_group_distances[${offset}].hamming_distance`,
      ) === computed.distances[offset]
    ));
  const nearestAmbiguous = computed.nearestSignatures.length !== 1;
  if (exactInteger(value.distinct_source_group_count, `${label}.distinct_source_group_count`)
      !== computed.distinctSourceSignatures.length
    || !groupsMatch
    || exactInteger(value.nearest_source_distance, `${label}.nearest_source_distance`)
      !== computed.nearestDistance
    || JSON.stringify(reportedNearest) !== JSON.stringify(computed.nearestSignatures)
    || value.nearest_source_ambiguous !== nearestAmbiguous
    || value.source_ambiguous !== !computed.expectedIsUniqueNearest
    || value.expected_source_is_unique_nearest !== computed.expectedIsUniqueNearest) {
    throw new Error(`${label} source-assignment evidence was inconsistent.`);
  }
  if (computed.secondNearestDistance === null) {
    if (value.second_nearest_source_distance !== null) {
      throw new Error(`${label} source-assignment second-nearest evidence was inconsistent.`);
    }
  } else if (exactInteger(
    value.second_nearest_source_distance,
    `${label}.second_nearest_source_distance`,
  ) !== computed.secondNearestDistance) {
    throw new Error(`${label} source-assignment second-nearest evidence was inconsistent.`);
  }
  if (computed.nearestMargin === null) {
    if (value.nearest_source_margin !== null) {
      throw new Error(`${label} source-assignment margin evidence was inconsistent.`);
    }
  } else if (exactInteger(value.nearest_source_margin, `${label}.nearest_source_margin`)
      !== computed.nearestMargin) {
    throw new Error(`${label} source-assignment margin evidence was inconsistent.`);
  }
  return computed;
}

function validateSampleConsensusEvidence(
  value: Record<string, unknown>,
  assignment: UniqueSourceAssignment,
  expectedSourceSampleId: string,
  allSourceSampleIds: string[],
  label: string,
): void {
  if (!X_ARTICLE_SOURCE_SAMPLE_ID.test(expectedSourceSampleId)
    || value.expected_source_sample_id !== expectedSourceSampleId) {
    throw new Error(`${label} expected source sample identity was inconsistent.`);
  }
  const sourceSampleGroups = [...new Set(allSourceSampleIds)];
  if (sourceSampleGroups.some(sampleId => !X_ARTICLE_SOURCE_SAMPLE_ID.test(sampleId))) {
    throw new Error(`${label} source sample contract was invalid.`);
  }
  const reportedGroups = Array.isArray(value.source_sample_distances)
    ? value.source_sample_distances.map(asRecord)
    : [];
  const distinctGroupCount = exactInteger(
    value.distinct_source_sample_group_count,
    `${label}.distinct_source_sample_group_count`,
  );
  if (distinctGroupCount !== sourceSampleGroups.length
    || reportedGroups.length !== sourceSampleGroups.length) {
    throw new Error(`${label} source sample groups were incomplete.`);
  }
  const scores = reportedGroups.map((group, offset) => {
    const sampleId = sourceSampleGroups[offset];
    const rgbError = exactFiniteNumber(
      group.rgb_mean_absolute_error,
      `${label}.source_sample_distances[${offset}].rgb_mean_absolute_error`,
    );
    const lumaError = exactFiniteNumber(
      group.luma_mean_absolute_error,
      `${label}.source_sample_distances[${offset}].luma_mean_absolute_error`,
    );
    const correlation = group.luma_correlation === null
      ? null
      : exactSignedFiniteNumber(
        group.luma_correlation,
        `${label}.source_sample_distances[${offset}].luma_correlation`,
      );
    const score = exactFiniteNumber(
      group.sample_distance_score,
      `${label}.source_sample_distances[${offset}].sample_distance_score`,
    );
    const computedScore = rgbError * 0.6 + lumaError * 0.4;
    const occurrences = allSourceSampleIds.filter(candidate => candidate === sampleId).length;
    if (group.source_sample_id !== sampleId
      || exactInteger(
        group.source_group_occurrences,
        `${label}.source_sample_distances[${offset}].source_group_occurrences`,
      ) !== occurrences
      || occurrences < 1
      || (correlation !== null && (
        correlation < -1 - X_ARTICLE_FLOAT_TOLERANCE
        || correlation > 1 + X_ARTICLE_FLOAT_TOLERANCE
      ))
      || !finiteNumbersMatch(score, computedScore)) {
      throw new Error(`${label} source sample distance evidence was inconsistent.`);
    }
    return { sampleId, rgbError, lumaError, correlation, score };
  });
  const nearestDistance = Math.min(...scores.map(item => item.score));
  const nearestGroups = scores.filter(item => (
    Math.abs(item.score - nearestDistance) <= X_ARTICLE_FLOAT_TOLERANCE
  ));
  const expected = scores.find(item => item.sampleId === expectedSourceSampleId);
  if (!expected || nearestGroups.length !== 1 || nearestGroups[0].sampleId !== expectedSourceSampleId
    || value.expected_source_sample_is_unique_nearest !== true) {
    throw new Error(`${label} expected source sample was not uniquely nearest.`);
  }
  const reportedNearestDistance = exactFiniteNumber(
    value.nearest_source_sample_distance,
    `${label}.nearest_source_sample_distance`,
  );
  const otherScores = scores
    .filter(item => item.sampleId !== expectedSourceSampleId)
    .map(item => item.score);
  const secondNearestDistance = otherScores.length > 0 ? Math.min(...otherScores) : null;
  const nearestMargin = secondNearestDistance === null
    ? null
    : secondNearestDistance - expected.score;
  if (!finiteNumbersMatch(reportedNearestDistance, nearestDistance)) {
    throw new Error(`${label} nearest source sample distance was inconsistent.`);
  }
  if (secondNearestDistance === null) {
    if (value.second_nearest_source_sample_distance !== null
      || value.nearest_source_sample_margin !== null) {
      throw new Error(`${label} source sample margin was inconsistent.`);
    }
  } else {
    const reportedSecond = exactFiniteNumber(
      value.second_nearest_source_sample_distance,
      `${label}.second_nearest_source_sample_distance`,
    );
    const reportedMargin = exactSignedFiniteNumber(
      value.nearest_source_sample_margin,
      `${label}.nearest_source_sample_margin`,
    );
    if (!finiteNumbersMatch(reportedSecond, secondNearestDistance)
      || !finiteNumbersMatch(reportedMargin, nearestMargin as number)) {
      throw new Error(`${label} source sample margin was inconsistent.`);
    }
  }
  const rgbError = exactFiniteNumber(value.rgb_mean_absolute_error, `${label}.rgb_mean_absolute_error`);
  const lumaError = exactFiniteNumber(value.luma_mean_absolute_error, `${label}.luma_mean_absolute_error`);
  const correlation = value.luma_correlation === null
    ? null
    : exactSignedFiniteNumber(value.luma_correlation, `${label}.luma_correlation`);
  const similarityMatches = rgbError <= X_ARTICLE_RGB_SAMPLE_MAX_MAE
    && lumaError <= X_ARTICLE_LUMA_SAMPLE_MAX_MAE
    && (correlation === null || correlation >= X_ARTICLE_LUMA_CORRELATION_MIN);
  const sampleMarginMatches = sourceSampleGroups.length === 1
    || (nearestMargin !== null && nearestMargin >= X_ARTICLE_SAMPLE_MIN_NEAREST_MARGIN)
    || (assignment.nearestMargin !== null
      && assignment.nearestMargin >= X_ARTICLE_VISUAL_ADAPTIVE_MIN_MARGIN);
  if (!finiteNumbersMatch(rgbError, expected.rgbError)
    || !finiteNumbersMatch(lumaError, expected.lumaError)
    || correlation !== expected.correlation
    || (correlation !== null && (
      correlation < -1 - X_ARTICLE_FLOAT_TOLERANCE
      || correlation > 1 + X_ARTICLE_FLOAT_TOLERANCE
    ))
    || value.sample_similarity_matches !== similarityMatches
    || value.sample_margin_matches !== sampleMarginMatches
    || !similarityMatches) {
    throw new Error(`${label} source sample similarity evidence was inconsistent.`);
  }
}

function validateAdaptiveVisualMatch(
  value: Record<string, unknown>,
  assignment: UniqueSourceAssignment,
  observedWidthValue: unknown,
  observedHeightValue: unknown,
  expectedSourceSampleId: string,
  allSourceSampleIds: string[],
  label: string,
): void {
  const strictMatch = assignment.expectedIsUniqueNearest
    && assignment.expectedDistance <= X_ARTICLE_VISUAL_MAX_HAMMING_DISTANCE;
  if (strictMatch) return;
  const marginMatches = assignment.distinctSourceSignatures.length === 1
    || (assignment.nearestMargin !== null
      && assignment.nearestMargin >= X_ARTICLE_VISUAL_ADAPTIVE_MIN_MARGIN);
  const { aspectMatches } = validateVisualDimensions(
    value,
    observedWidthValue,
    observedHeightValue,
    label,
  );
  const adaptiveMatch = assignment.expectedIsUniqueNearest
    && assignment.expectedDistance <= X_ARTICLE_VISUAL_ADAPTIVE_MAX_HAMMING_DISTANCE
    && marginMatches
    && aspectMatches;
  const sampleConsensusMatch = value.sample_consensus_match === true;
  if (sampleConsensusMatch) {
    validateSampleConsensusEvidence(
      value,
      assignment,
      expectedSourceSampleId,
      allSourceSampleIds,
      label,
    );
  }
  const expectedPolicy = sampleConsensusMatch
    ? 'multi-signal-consensus'
    : adaptiveMatch
      ? 'adaptive-unique-nearest'
      : 'rejected';
  if (value.strict_source_match !== false
    || value.adaptive_source_match !== adaptiveMatch
    || value.adaptive_margin_matches !== marginMatches
    || value.aspect_ratio_matches !== aspectMatches
    || value.match_policy !== expectedPolicy
    || (!sampleConsensusMatch && !adaptiveMatch)) {
    throw new Error(`${label} adaptive visual evidence was inconsistent.`);
  }
}

interface ValidatedSourceMediaContract {
  sourceSignatures: string[];
  sourceSampleIds: string[];
  sourceNaturalWidths: number[];
  sourceNaturalHeights: number[];
  occurrences: number[];
  bindingKeys: string[];
}

interface ValidatedMediaEvidence extends ValidatedSourceMediaContract {
  observedSignatures: string[];
}

function addVerificationWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

function validateTableEvidence(
  value: unknown,
  preflight: XArticlePreflight,
  phase: 'pre_reload' | 'post_reload',
): string[][][] {
  if (!Array.isArray(value) || value.length !== preflight.expectedTables) {
    throw new Error(`X Article ${phase} table evidence was incomplete.`);
  }
  return value.map((item, offset) => {
    const row = asRecord(item);
    const expected = preflight.tables[offset];
    const rows = exactInteger(row.rows, `${phase}.tables[${offset}].rows`);
    const columns = exactInteger(row.columns, `${phase}.tables[${offset}].columns`);
    const expectedMatrix = exactStringMatrix(
      row.expected_matrix,
      `${phase}.tables[${offset}].expected_matrix`,
    );
    const visibleMatrix = exactStringMatrix(
      row.visible_matrix,
      `${phase}.tables[${offset}].visible_matrix`,
    );
    const nonEmptyCells = exactInteger(
      row.visible_non_empty_cells,
      `${phase}.tables[${offset}].visible_non_empty_cells`,
    );
    const computedNonEmptyCells = visibleMatrix.flat().filter(cell => cell.trim()).length;
    if (!expected
      || row.index !== expected.index
      || row.dom_index !== offset
      || rows !== expected.rows
      || columns !== expected.columns
      || row.phase !== phase
      || row.visible_matrix_matches !== true
      || row.readback_matches !== true
      || typeof row.readback_markdown !== 'string'
      || !row.readback_markdown.trim()
      || expectedMatrix.length !== rows
      || expectedMatrix.some(matrixRow => matrixRow.length !== columns)
      || JSON.stringify(expectedMatrix) !== JSON.stringify(expected.normalizedMatrix)
      || JSON.stringify(visibleMatrix) !== JSON.stringify(expectedMatrix)
      || computedNonEmptyCells < 1
      || nonEmptyCells !== computedNonEmptyCells) {
      throw new Error(`X Article ${phase} table ${offset + 1} did not persist exactly.`);
    }
    return visibleMatrix;
  });
}

const MARKDOWN_ESCAPABLE_PUNCTUATION = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

function decodeVisibleHtmlEntities(value: string): string {
  return decodeHTML(value);
}

export function normalizeXArticleVisibleDomAnchor(value: string): string {
  return value
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .normalize('NFC')
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^>\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/^\|+|\|+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface BalancedMarkdownSpan {
  content: string;
  closing: number;
}

function markdownCharacterIsEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let offset = index - 1; offset >= 0 && value[offset] === '\\'; offset -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function parseBalancedMarkdownSpan(
  value: string,
  start: number,
  opener: '[' | '(',
  closer: ']' | ')',
): BalancedMarkdownSpan | null {
  if (value[start] !== opener || markdownCharacterIsEscaped(value, start)) return null;
  let depth = 0;
  for (let offset = start; offset < value.length; offset += 1) {
    if (markdownCharacterIsEscaped(value, offset)) continue;
    if (value[offset] === opener) depth += 1;
    if (value[offset] !== closer) continue;
    depth -= 1;
    if (depth === 0) return { content: value.slice(start + 1, offset), closing: offset };
  }
  return null;
}

function replaceMarkdownInlineLinks(value: string): string {
  let rendered = '';
  let cursor = 0;
  while (cursor < value.length) {
    const imagePrefix = value.startsWith('![', cursor)
      && !markdownCharacterIsEscaped(value, cursor);
    const bracketIndex = imagePrefix ? cursor + 1 : cursor;
    if (value[bracketIndex] !== '[' || markdownCharacterIsEscaped(value, bracketIndex)) {
      rendered += value[cursor] ?? '';
      cursor += 1;
      continue;
    }
    const label = parseBalancedMarkdownSpan(value, bracketIndex, '[', ']');
    const following = (label?.closing ?? -1) + 1;
    const destination = label
      ? parseBalancedMarkdownSpan(value, following, '(', ')')
      : null;
    const reference = label
      ? parseBalancedMarkdownSpan(value, following, '[', ']')
      : null;
    const target = destination ?? reference;
    if (!label || !target) {
      rendered += value[cursor] ?? '';
      cursor += 1;
      continue;
    }
    rendered += label.content;
    cursor = target.closing + 1;
  }
  return rendered;
}

/**
 * Canonical visible-text form shared with the Python uploader. The source side
 * is Markdown while the X DOM side is rendered text, so presentation-only
 * delimiters must not decide whether an otherwise exact image is in place.
 */
export function normalizeXArticleVisibleAnchor(value: string): string {
  const protectedText: string[] = [];
  const protect = (visible: string): string => {
    const token = `\u{f0000}${protectedText.length}\u{f0001}`;
    protectedText.push(visible);
    return token;
  };
  let normalized = value;

  // Code-span contents and escaped punctuation are literal visible text. Keep
  // them out of the emphasis/link passes, then restore them at the end.
  normalized = normalized.replace(
    /(?<!\\)(`+)([\s\S]+?)(?<!`)\1(?!`)/g,
    (_match, _ticks: string, rawContent: string) => {
      let content = rawContent.replace(/[\r\n]+/g, ' ');
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        content = content.slice(1, -1);
      }
      return protect(content);
    },
  );
  normalized = normalized.replace(
    MARKDOWN_ESCAPABLE_PUNCTUATION,
    (_match, punctuation: string) => protect(punctuation),
  );
  normalized = replaceMarkdownInlineLinks(decodeVisibleHtmlEntities(normalized)).replace(
    /<((?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)|(?:[^\s<>]+@[^\s<>]+))>/g,
    '$1',
  );

  // Strip only paired presentation delimiters. Repeating supports nested
  // forms such as ***bold italic*** without touching unmatched literal marks.
  for (const pairedEmphasis of [
    /(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g,
    /(\*|_)(?=\S)([\s\S]*?\S)\1/g,
  ]) {
    while (true) {
      const next = normalized.replace(pairedEmphasis, '$2');
      if (next === normalized) break;
      normalized = next;
    }
  }

  normalized = normalized.replace(/\u{f0000}(\d+)\u{f0001}/gu, (match, index: string) => (
    protectedText[Number(index)] ?? match
  ));
  return normalizeXArticleVisibleDomAnchor(normalized);
}

export function xArticleVisibleAnchorsMatch(expected: string, actual: string): boolean {
  const expectedAnchor = normalizeXArticleVisibleAnchor(expected);
  const actualAnchor = normalizeXArticleVisibleDomAnchor(actual);
  if (!expectedAnchor || !actualAnchor) return false;
  return expectedAnchor === actualAnchor || actualAnchor.endsWith(expectedAnchor);
}

function mediaAnchorMatches(expected: string, actual: string): boolean {
  return xArticleVisibleAnchorsMatch(expected, actual);
}

function mediaPositionMatches(
  expected: XArticlePreflight['anchors'][number],
  actual: string,
): boolean {
  return expected.placement === 'composer-start'
    ? !normalizeXArticleVisibleDomAnchor(actual)
    : mediaAnchorMatches(expected.anchor, actual);
}

export function validateXArticleVisibleAnchorContract(preflight: XArticlePreflight): void {
  const seen = new Map<string, number>();
  let afterAnchorSeen = false;
  preflight.anchors.forEach((anchor, offset) => {
    if (anchor.placement === 'composer-start') {
      if (afterAnchorSeen || anchor.anchor) {
        throw new Error('X Article composer-start placement contract was invalid.');
      }
      return;
    }
    afterAnchorSeen = true;
    const visibleAnchor = normalizeXArticleVisibleAnchor(anchor.anchor);
    if (!visibleAnchor) {
      throw new Error(`X Article body image ${offset + 1} has no visible placement anchor.`);
    }
    const prior = seen.get(visibleAnchor);
    if (prior !== undefined && offset - prior > 1) {
      throw new Error(
        `X Article body images ${prior + 1} and ${offset + 1} share the same visible placement anchor.`,
      );
    }
    seen.set(visibleAnchor, offset);
  });
}

export function computeXArticleMediaBindingKey(
  sourceSignature: string,
  occurrence: number,
  anchor: string,
  domOrder: number,
): string {
  return `media-v1-${sha256(JSON.stringify([
    sourceSignature,
    occurrence,
    normalizeMediaAnchor(anchor),
    domOrder,
  ]))}`;
}

function validateSourceMediaContract(
  value: unknown,
  preflight: XArticlePreflight,
): ValidatedSourceMediaContract {
  if (!Array.isArray(value) || value.length !== preflight.expectedBodyImages) {
    throw new Error('X Article source-media contract was incomplete.');
  }
  const occurrences = new Map<string, number>();
  const sourceSignatures: string[] = [];
  const sourceSampleIds: string[] = [];
  const sourceNaturalWidths: number[] = [];
  const sourceNaturalHeights: number[] = [];
  const sourceOccurrences: number[] = [];
  const bindingKeys: string[] = [];
  value.forEach((item, offset) => {
    const row = asRecord(item);
    const expected = preflight.anchors[offset];
    const sourceSignature = typeof row.source_signature === 'string'
      ? row.source_signature.trim()
      : '';
    const sourceSampleId = typeof row.expected_source_sample_id === 'string'
      ? row.expected_source_sample_id.trim()
      : '';
    const sourceNaturalWidth = exactInteger(
      row.source_natural_width,
      `source_media_contract[${offset}].source_natural_width`,
    );
    const sourceNaturalHeight = exactInteger(
      row.source_natural_height,
      `source_media_contract[${offset}].source_natural_height`,
    );
    const occurrence = (occurrences.get(sourceSignature) ?? 0) + 1;
    const bindingKey = typeof row.binding_key === 'string' ? row.binding_key.trim() : '';
    const computedBindingKey = computeXArticleMediaBindingKey(
      sourceSignature,
      occurrence,
      expected?.anchor ?? '',
      offset,
    );
    if (!expected
      || row.index !== offset + 1
      || typeof row.file !== 'string'
      || path.basename(row.file) !== path.basename(expected.file)
      || !X_ARTICLE_VISUAL_SIGNATURE.test(sourceSignature)
      || !X_ARTICLE_SOURCE_SAMPLE_ID.test(sourceSampleId)
      || sourceNaturalWidth < 1
      || sourceNaturalHeight < 1
      || row.occurrence !== occurrence
      || row.expected_anchor !== expected.anchor
      || row.placement !== expected.placement
      || row.expected_dom_order !== offset
      || !X_ARTICLE_MEDIA_BINDING_KEY.test(bindingKey)
      || bindingKey !== computedBindingKey) {
      throw new Error(`X Article source-media contract item ${offset + 1} was inconsistent.`);
    }
    occurrences.set(sourceSignature, occurrence);
    sourceSignatures.push(sourceSignature);
    sourceSampleIds.push(sourceSampleId);
    sourceNaturalWidths.push(sourceNaturalWidth);
    sourceNaturalHeights.push(sourceNaturalHeight);
    sourceOccurrences.push(occurrence);
    bindingKeys.push(bindingKey);
  });
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new Error('X Article source-media binding keys were not unique.');
  }
  return {
    sourceSignatures,
    sourceSampleIds,
    sourceNaturalWidths,
    sourceNaturalHeights,
    occurrences: sourceOccurrences,
    bindingKeys,
  };
}

function validateMediaEvidence(
  value: unknown,
  preflight: XArticlePreflight,
  sourceContract: ValidatedSourceMediaContract,
  phase: 'pre_reload' | 'post_reload',
  warnings: string[],
): ValidatedMediaEvidence {
  const evidence = asRecord(value);
  const expectedCount = exactInteger(evidence.expected_count, `${phase}.media.expected_count`);
  const actualCount = exactInteger(evidence.actual_count, `${phase}.media.actual_count`);
  const observedSignatures = exactStringArray(
    evidence.ordered_signatures,
    `${phase}.media.ordered_signatures`,
  );
  const orderedIdentityKeys = exactStringArray(
    evidence.ordered_identity_keys,
    `${phase}.media.ordered_identity_keys`,
  );
  const orderedBindingKeys = exactStringArray(
    evidence.ordered_binding_keys,
    `${phase}.media.ordered_binding_keys`,
  );
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  if (expectedCount !== preflight.expectedBodyImages
    || actualCount !== expectedCount
    || observedSignatures.length !== expectedCount
    || observedSignatures.some(signature => !X_ARTICLE_VISUAL_SIGNATURE.test(signature))
    || items.length !== expectedCount
    || JSON.stringify(orderedIdentityKeys) !== JSON.stringify(sourceContract.bindingKeys)
    || JSON.stringify(orderedBindingKeys) !== JSON.stringify(sourceContract.bindingKeys)) {
    throw new Error(`X Article ${phase} body-media evidence was incomplete.`);
  }
  if (evidence.exact_count !== true
    || evidence.duplicate_signatures_allowed !== true
    || evidence.valid !== true) {
    addVerificationWarning(
      warnings,
      `X Article ${phase} body-media summary flag disagreed with independently verified evidence.`,
    );
  }
  items.forEach((item, offset) => {
    const row = asRecord(item);
    const expected = preflight.anchors[offset];
    const sourceSignature = sourceContract.sourceSignatures[offset];
    const observedSignature = observedSignatures[offset];
    const computedDistance = visualSignatureHammingDistance(
      sourceSignature,
      observedSignature,
      `${phase}.media[${offset}]`,
    );
    const sourceDistance = exactInteger(
      row.source_hamming_distance,
      `${phase}.media[${offset}].source_hamming_distance`,
    );
    const signatureDistance = exactInteger(
      row.signature_hamming_distance,
      `${phase}.media[${offset}].signature_hamming_distance`,
    );
    const sourceAssignment = validateReportedSourceAssignment(
      row,
      sourceSignature,
      observedSignature,
      sourceContract.sourceSignatures,
      `${phase}.media[${offset}]`,
    );
    validateAdaptiveVisualMatch(
      row,
      sourceAssignment,
      row.natural_width,
      row.natural_height,
      sourceContract.sourceSampleIds[offset],
      sourceContract.sourceSampleIds,
      `${phase}.media[${offset}]`,
    );
    const actualAnchor = typeof row.anchor_before === 'string' ? row.anchor_before : '';
    if (!expected
      || row.index !== offset + 1
      || typeof row.file !== 'string'
      || path.basename(row.file) !== path.basename(expected.file)
      || row.source_signature !== sourceSignature
      || row.observed_signature !== observedSignature
      || row.source_natural_width !== sourceContract.sourceNaturalWidths[offset]
      || row.source_natural_height !== sourceContract.sourceNaturalHeights[offset]
      || sourceDistance !== computedDistance
      || signatureDistance !== computedDistance
      || row.source_occurrence !== sourceContract.occurrences[offset]
      || row.observed_occurrence !== sourceContract.occurrences[offset]
      || row.occurrence !== sourceContract.occurrences[offset]
      || row.identity_key !== sourceContract.bindingKeys[offset]
      || row.binding_key !== sourceContract.bindingKeys[offset]
      || exactInteger(row.natural_width, `${phase}.media[${offset}].natural_width`) < 1
      || exactInteger(row.natural_height, `${phase}.media[${offset}].natural_height`) < 1
      || exactInteger(row.dom_order, `${phase}.media[${offset}].dom_order`) !== offset
      || exactInteger(row.expected_dom_order, `${phase}.media[${offset}].expected_dom_order`) !== offset
      || exactInteger(row.block_index, `${phase}.media[${offset}].block_index`) < 0
      || row.expected_anchor !== expected.anchor
      || !mediaPositionMatches(expected, actualAnchor)
    ) {
      throw new Error(`X Article ${phase} body image ${offset + 1} did not persist at its source-bound anchor.`);
    }
    if (row.source_matches !== true
      || row.signature_match !== true
      || row.occurrence_matches !== true
      || row.identity_matches !== true
      || row.dom_order_matches !== true
      || row.anchor_matches !== true
      || row.recognizable !== true) {
      addVerificationWarning(
        warnings,
        `X Article ${phase} body image ${offset + 1} summary flag disagreed with independently verified evidence.`,
      );
    }
  });
  return {
    observedSignatures,
    sourceSignatures: sourceContract.sourceSignatures,
    sourceSampleIds: sourceContract.sourceSampleIds,
    sourceNaturalWidths: sourceContract.sourceNaturalWidths,
    sourceNaturalHeights: sourceContract.sourceNaturalHeights,
    occurrences: sourceContract.occurrences,
    bindingKeys: sourceContract.bindingKeys,
  };
}

function validateAutosaveEvidence(value: unknown, expectedEpoch: string): string {
  const evidence = asRecord(value);
  const lastMutationAt = exactInteger(evidence.lastMutationAt, 'autosave.lastMutationAt');
  const lastMutationSequence = exactInteger(
    evidence.last_mutation_sequence,
    'autosave.last_mutation_sequence',
  );
  const mutationBaseline = Array.isArray(evidence.mutationBaseline)
    ? evidence.mutationBaseline.map(asRecord)
    : [];
  const current = Array.isArray(evidence.current) ? evidence.current.map(asRecord) : [];
  const savedNodes = current.filter(item => (
    item.state === 'saved'
    && typeof item.channelKey === 'string' && item.channelKey.trim()
    && typeof item.text === 'string' && item.text.trim()
    && typeof item.token === 'string' && item.token.trim()
    && exactInteger(item.nodeInstance, 'autosave.current.nodeInstance') > 0
  ));
  const currentSavedByChannel = new Map(savedNodes.map(item => [String(item.channelKey), item]));
  const baselineByChannel = new Map<string, { token: string; nodeInstance: number }>();
  mutationBaseline.forEach((item, offset) => {
    const channelKey = typeof item.channelKey === 'string' ? item.channelKey.trim() : '';
    const token = typeof item.token === 'string' ? item.token.trim() : '';
    const nodeInstance = exactInteger(
      item.nodeInstance,
      `autosave.mutationBaseline[${offset}].nodeInstance`,
    );
    if (!channelKey || !token || nodeInstance < 1 || baselineByChannel.has(channelKey)) {
      throw new Error('X Article autosave mutation baseline was invalid.');
    }
    baselineByChannel.set(channelKey, { token, nodeInstance });
  });
  const transitions = Array.isArray(evidence.saving_to_saved_transitions)
    ? evidence.saving_to_saved_transitions.map(asRecord)
    : [];
  const changedSavedNodes = Array.isArray(evidence.changed_saved_nodes)
    ? evidence.changed_saved_nodes.map(asRecord)
    : [];
  const postMutationSavedObservations = Array.isArray(evidence.post_mutation_saved_observations)
    ? evidence.post_mutation_saved_observations.map(asRecord)
    : [];
  const relevantEvents = Array.isArray(evidence.relevant_events)
    ? evidence.relevant_events.map(asRecord)
    : [];
  const relevantSequences = relevantEvents.map((item, offset) => exactInteger(
    item.sequence,
    `autosave.relevant_events[${offset}].sequence`,
  ));
  const relevantNodeInstances = relevantEvents.map((item, offset) => exactInteger(
    item.nodeInstance,
    `autosave.relevant_events[${offset}].nodeInstance`,
  ));
  const relevantEventsValid = relevantEvents.length > 0
    && relevantEvents.every((item, offset) => {
      const state = typeof item.state === 'string' ? item.state : '';
      const commonEvidenceValid = relevantSequences[offset] > lastMutationSequence
        && exactInteger(
          item.observedAt,
          `autosave.relevant_events[${offset}].observedAt`,
        ) > lastMutationAt
        && typeof item.channelKey === 'string' && item.channelKey.trim()
        && relevantNodeInstances[offset] > 0
        && (offset === 0 || relevantSequences[offset] > relevantSequences[offset - 1]);
      if (!commonEvidenceValid) return false;
      if (state === 'saving' || state === 'saved') {
        return typeof item.text === 'string' && Boolean(item.text.trim())
          && typeof item.token === 'string' && Boolean(item.token.trim());
      }
      if (state === 'departed' || state === 'unclassified') {
        return item.text === ''
          && item.token === ''
          && typeof item.previousToken === 'string'
          && Boolean(item.previousToken.trim());
      }
      return false;
    });
  const channelChangedSequences = new Set<number>();
  const previousByChannel = new Map(baselineByChannel);
  relevantEvents.forEach((item, offset) => {
    const channelKey = String(item.channelKey);
    const token = String(item.token);
    const nodeInstance = relevantNodeInstances[offset];
    const previous = previousByChannel.get(channelKey);
    if (!previous || previous.token !== token || previous.nodeInstance !== nodeInstance) {
      channelChangedSequences.add(relevantSequences[offset]);
    }
    previousByChannel.set(channelKey, { token, nodeInstance });
  });
  const isRecentSavedText = (item: Record<string, unknown>): boolean => (
    typeof item.text === 'string'
    && /(?:刚刚最后保存|刚刚保存|Last saved\s+(?:just now|now)|^Saved(?:\b|\s|$))/i.test(item.text.trim())
  );
  const currentSavedChannelMatches = (
    item: Record<string, unknown>,
    exact: boolean,
  ): boolean => {
    const currentSaved = currentSavedByChannel.get(String(item.channelKey));
    if (!currentSaved) return false;
    return !exact || (
      currentSaved.token === item.token
      && currentSaved.nodeInstance === item.nodeInstance
    );
  };
  const matchingRelevantEvent = (item: Record<string, unknown>, state: string): boolean => {
    const sequence = exactInteger(item.sequence, 'autosave.saved_observation.sequence');
    const observedAt = exactInteger(item.observedAt, 'autosave.saved_observation.observedAt');
    const nodeInstance = exactInteger(
      item.nodeInstance,
      'autosave.saved_observation.nodeInstance',
    );
    return Boolean(item.state === state
      && sequence > lastMutationSequence
      && observedAt > lastMutationAt
      && nodeInstance > 0
      && typeof item.channelKey === 'string' && item.channelKey.trim()
      && typeof item.text === 'string' && item.text.trim()
      && typeof item.token === 'string' && item.token.trim()
      && relevantEvents.some((event, offset) => (
        relevantSequences[offset] === sequence
        && event.state === state
        && event.channelKey === item.channelKey
        && event.text === item.text
        && event.token === item.token
        && relevantNodeInstances[offset] === nodeInstance
        && event.observedAt === observedAt
      )));
  };
  const expectedTransitions: Array<Record<string, unknown>> = [];
  relevantEvents.forEach((saving, savingOffset) => {
    if (saving.state !== 'saving') return;
    const savedOffset = relevantEvents.findIndex((saved, offset) => (
      offset > savingOffset
      && saved.state === 'saved'
      && saved.channelKey === saving.channelKey
      && currentSavedChannelMatches(saved, true)
    ));
    if (savedOffset >= 0) {
      expectedTransitions.push({
        channel_key: saving.channelKey,
        saving_sequence: relevantSequences[savingOffset],
        saved_sequence: relevantSequences[savedOffset],
      });
    }
  });
  const expectedChangedSequences = relevantEvents.flatMap((item, offset) => {
    const baseline = baselineByChannel.get(String(item.channelKey));
    const changedFromBaseline = baseline && (
      baseline.token !== item.token || baseline.nodeInstance !== relevantNodeInstances[offset]
    );
    return item.state === 'saved'
      && channelChangedSequences.has(relevantSequences[offset])
      && changedFromBaseline
      && isRecentSavedText(item)
      && currentSavedChannelMatches(item, true)
      ? [relevantSequences[offset]]
      : [];
  });
  const previousLiveByChannel = new Map<string, {
    token: string;
    nodeInstance: number;
    sequence: number | null;
  }>([...baselineByChannel].map(([channelKey, item]) => [channelKey, {
    ...item,
    sequence: null,
  }]));
  const departedByChannel = new Map<string, {
    departureSequence: number;
    previousLive: { token: string; nodeInstance: number; sequence: number | null };
  }>();
  const expectedDepartureTransitions: Array<Record<string, unknown>> = [];
  const expectedPostMutationSequences: number[] = [];
  relevantEvents.forEach((item, offset) => {
    const channelKey = String(item.channelKey);
    const state = String(item.state);
    if (state === 'departed' || state === 'unclassified') {
      const previousLive = previousLiveByChannel.get(channelKey);
      if (previousLive
        && item.previousToken === previousLive.token
        && relevantNodeInstances[offset] === previousLive.nodeInstance) {
        departedByChannel.set(channelKey, {
          departureSequence: relevantSequences[offset],
          previousLive,
        });
      } else {
        departedByChannel.delete(channelKey);
      }
      return;
    }
    if (state !== 'saving' && state !== 'saved') return;
    const departurePair = departedByChannel.get(channelKey);
    if (state === 'saved' && departurePair) {
      if (isRecentSavedText(item) && currentSavedChannelMatches(item, true)) {
        expectedDepartureTransitions.push({
          channel_key: channelKey,
          previous_live_sequence: departurePair.previousLive.sequence,
          previous_live_token: departurePair.previousLive.token,
          previous_live_node_instance: departurePair.previousLive.nodeInstance,
          departure_sequence: departurePair.departureSequence,
          saved_sequence: relevantSequences[offset],
          saved_token: item.token,
          saved_node_instance: relevantNodeInstances[offset],
        });
        expectedPostMutationSequences.push(relevantSequences[offset]);
      }
      departedByChannel.delete(channelKey);
    }
    previousLiveByChannel.set(channelKey, {
      token: String(item.token),
      nodeInstance: relevantNodeInstances[offset],
      sequence: relevantSequences[offset],
    });
  });
  const reportedTransitions = transitions.map(item => ({
    channel_key: item.channel_key,
    saving_sequence: exactInteger(item.saving_sequence, 'autosave.saving_sequence'),
    saved_sequence: exactInteger(item.saved_sequence, 'autosave.saved_sequence'),
  }));
  const reportedChangedSequences = changedSavedNodes.map(item => (
    exactInteger(item.sequence, 'autosave.changed_saved_nodes.sequence')
  ));
  const departureTransitions = Array.isArray(evidence.departure_to_saved_transitions)
    ? evidence.departure_to_saved_transitions.map(asRecord)
    : [];
  const reportedDepartureTransitions = departureTransitions.map(item => ({
    channel_key: item.channel_key,
    previous_live_sequence: item.previous_live_sequence === null
      ? null
      : exactInteger(
        item.previous_live_sequence,
        'autosave.departure_to_saved.previous_live_sequence',
      ),
    previous_live_token: item.previous_live_token,
    previous_live_node_instance: exactInteger(
      item.previous_live_node_instance,
      'autosave.departure_to_saved.previous_live_node_instance',
    ),
    departure_sequence: exactInteger(
      item.departure_sequence,
      'autosave.departure_to_saved.departure_sequence',
    ),
    saved_sequence: exactInteger(
      item.saved_sequence,
      'autosave.departure_to_saved.saved_sequence',
    ),
    saved_token: item.saved_token,
    saved_node_instance: exactInteger(
      item.saved_node_instance,
      'autosave.departure_to_saved.saved_node_instance',
    ),
  }));
  const reportedPostMutationSequences = postMutationSavedObservations.map(item => (
    exactInteger(item.sequence, 'autosave.post_mutation_saved_observations.sequence')
  ));
  const transitionsValid = JSON.stringify(reportedTransitions) === JSON.stringify(expectedTransitions);
  const changedNodesValid = JSON.stringify(reportedChangedSequences)
      === JSON.stringify(expectedChangedSequences)
    && changedSavedNodes.every(item => matchingRelevantEvent(item, 'saved'));
  const departureTransitionsValid = JSON.stringify(reportedDepartureTransitions)
    === JSON.stringify(expectedDepartureTransitions);
  const postMutationObservationsValid = JSON.stringify(reportedPostMutationSequences)
      === JSON.stringify(expectedPostMutationSequences)
    && postMutationSavedObservations.every(item => matchingRelevantEvent(item, 'saved'));
  if (evidence.verified !== true
    || evidence.epoch_matches !== true
    || evidence.epoch !== expectedEpoch
    || exactInteger(evidence.startedAt, 'autosave.startedAt') < 1
    || exactInteger(evidence.mutationCount, 'autosave.mutationCount') < 1
    || lastMutationAt < 1
    || lastMutationSequence < 0
    || exactInteger(evidence.lastMutationSequence, 'autosave.lastMutationSequence')
      !== lastMutationSequence
    || exactInteger(evidence.lastMutationEventCursor, 'autosave.lastMutationEventCursor')
      !== lastMutationSequence
    || typeof evidence.lastMutationLabel !== 'string'
    || !evidence.lastMutationLabel.trim()
    || evidence.saved_state_present !== true
    || savedNodes.length < 1
    || mutationBaseline.length < 1
    || (transitions.length < 1
      && changedSavedNodes.length < 1
      && departureTransitions.length < 1)
    || !relevantEventsValid
    || !transitionsValid
    || !changedNodesValid
    || !departureTransitionsValid
    || !postMutationObservationsValid) {
    throw new Error('X Article mutation-epoch autosave evidence was incomplete.');
  }
  const latestSavedText = savedNodes.at(-1)?.text;
  return typeof latestSavedText === 'string' ? latestSavedText.trim() : '';
}

function validatePostReloadAutosaveSentinel(value: unknown): void {
  const evidence = asRecord(value);
  if (evidence.verification_required !== false
    || typeof evidence.reason !== 'string'
    || !evidence.reason.trim()) {
    throw new Error('X Article post-reload autosave sentinel was incomplete.');
  }
}

interface ValidatedCoverEvidence {
  sourceSignature: string;
  observedSignature: string;
}

function validateCoverEvidence(
  value: unknown,
  expectedCover: boolean,
  label: 'pre-reload' | 'post-reload',
  warnings: string[],
): ValidatedCoverEvidence {
  const evidence = asRecord(value);
  const expectedCount = expectedCover ? 1 : 0;
  const signatures = exactStringArray(
    evidence.ordered_signatures,
    `${label}.cover.ordered_signatures`,
  );
  const items = Array.isArray(evidence.items) ? evidence.items : [];
  const sourceSignature = typeof evidence.source_signature === 'string'
    ? evidence.source_signature.trim()
    : '';
  if (exactInteger(evidence.expected_count, `${label}.cover.expected_count`) !== expectedCount
    || exactInteger(evidence.actual_count, `${label}.cover.actual_count`) !== expectedCount
    || signatures.length !== expectedCount
    || items.length !== expectedCount
    || signatures.some(signature => !X_ARTICLE_VISUAL_SIGNATURE.test(signature))) {
    throw new Error(`X Article ${label} cover evidence was incomplete.`);
  }
  if (evidence.exact_count !== true
    || evidence.recognizable !== true
    || evidence.valid !== true
    || evidence.source_matches !== true
    || evidence.signature_match !== true
    || evidence.added_from_cleared_state !== true) {
    addVerificationWarning(
      warnings,
      `X Article ${label} cover summary flag disagreed with independently verified evidence.`,
    );
  }
  if ((label === 'pre-reload' && evidence.cleared_baseline_count !== 0)
    || (label === 'post-reload' && evidence.cleared_baseline_count !== null)) {
    addVerificationWarning(
      warnings,
      `X Article ${label} cover baseline evidence was unavailable.`,
    );
  }
  if (!expectedCover) {
    if (sourceSignature
      || evidence.source_hamming_distance !== null
      || evidence.signature_hamming_distance !== null) {
      throw new Error(`X Article ${label} empty-cover evidence was inconsistent.`);
    }
    return { sourceSignature: '', observedSignature: '' };
  }
  if (!X_ARTICLE_VISUAL_SIGNATURE.test(sourceSignature)) {
    throw new Error(`X Article ${label} cover source signature was invalid.`);
  }
  const observedSignature = signatures[0];
  const computedDistance = visualSignatureHammingDistance(
    sourceSignature,
    observedSignature,
    `${label}.cover`,
  );
  const sourceAssignment = computeSourceAssignment(
    sourceSignature,
    observedSignature,
    [sourceSignature],
    `${label}.cover`,
  );
  const row = asRecord(items[0]);
  validateAdaptiveVisualMatch(
    evidence,
    sourceAssignment,
    row.naturalWidth,
    row.naturalHeight,
    typeof evidence.expected_source_sample_id === 'string'
      ? evidence.expected_source_sample_id
      : '',
    [typeof evidence.expected_source_sample_id === 'string'
      ? evidence.expected_source_sample_id
      : ''],
    `${label}.cover`,
  );
  if (exactInteger(evidence.source_hamming_distance, `${label}.cover.source_hamming_distance`)
      !== computedDistance
    || exactInteger(evidence.signature_hamming_distance, `${label}.cover.signature_hamming_distance`)
      !== computedDistance) {
    throw new Error(`X Article ${label} cover fingerprint did not match its local source.`);
  }
  if (row.sourceSignature !== observedSignature
    || exactInteger(row.naturalWidth, `${label}.cover.naturalWidth`) < 1
    || exactInteger(row.naturalHeight, `${label}.cover.naturalHeight`) < 1) {
    throw new Error(`X Article ${label} cover image was not recognizable.`);
  }
  return { sourceSignature, observedSignature };
}

function validateBlankReplacementEvidence(value: unknown): void {
  const evidence = asRecord(value);
  if (evidence.mode !== 'new_draft_blank') {
    throw new Error('X Article upload did not begin from a verified blank draft.');
  }
  for (const phase of ['initial', 'cleared'] as const) {
    const state = asRecord(evidence[phase]);
    if (state.title !== ''
      || state.body_text !== ''
      || exactInteger(state.table_count, `replacement_clear.${phase}.table_count`) !== 0
      || exactInteger(state.body_media_count, `replacement_clear.${phase}.body_media_count`) !== 0
      || exactInteger(state.cover_media_count, `replacement_clear.${phase}.cover_media_count`) !== 0
      || state.verified !== true) {
      throw new Error(`X Article ${phase} draft baseline was not empty.`);
    }
  }
}

const normalizeMediaAnchor = normalizeXArticleVisibleAnchor;

function validatePreReloadContentEvidence(
  value: unknown,
  prepared: PreparedXArticleMarkdown,
  preflight: XArticlePreflight,
  expectedBindingKeys: string[],
): void {
  const evidence = asRecord(value);
  const verifiedBindingKeys = exactStringArray(
    evidence.verifiedMediaBindingKeys,
    'content_before_reload.verifiedMediaBindingKeys',
  );
  if (evidence.title !== prepared.title
    || evidence.hasStart !== true
    || evidence.hasEnd !== true
    || evidence.marker !== false
    || evidence.tableMarker !== false
    || evidence.allCheckpointsMatched !== true
    || evidence.checkpointsInOrder !== true
    || evidence.exactCompactLength !== true
    || evidence.exactCompactSha256 !== true
    || evidence.tableStripReliable !== true
    || evidence.mediaStripReliable !== true
    || evidence.expectedCompactLength !== preflight.expectedCompactLength
    || evidence.compactTextLength !== preflight.expectedCompactLength
    || evidence.expectedCompactSha256 !== preflight.expectedCompactSha256
    || evidence.contentCompactSha256 !== preflight.expectedCompactSha256
    || evidence.tableCount !== preflight.expectedTables
    || evidence.nativeTableNodesFound !== preflight.expectedTables
    || evidence.nativeMediaNodesFound !== preflight.expectedBodyImages
    || JSON.stringify(verifiedBindingKeys) !== JSON.stringify(expectedBindingKeys)) {
    throw new Error('X Article pre-reload body evidence did not match the prepared content.');
  }
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validateUploadResult(
  value: unknown,
  prepared: PreparedXArticleMarkdown,
  preflight: XArticlePreflight,
  draftUrl: string,
): XArticleUploadResult {
  const result = asRecord(value);
  const verificationWarnings: string[] = [];
  if (result.verification_contract !== X_ARTICLE_PERSISTENCE_CONTRACT) {
    throw new Error('X Article persistence verification contract is missing or outdated.');
  }
  if (result.title !== prepared.title || result.draft_url !== draftUrl) {
    throw new Error('X Article title or draft URL did not match the current upload.');
  }
  if (result.hasStart !== true || result.hasEnd !== true || result.marker !== false || result.tableMarker !== false) {
    throw new Error('X Article body verification failed.');
  }
  if (result.endCheckText !== preflight.endCheckText) {
    throw new Error('X Article ending verification did not match the preflight.');
  }
  const contentCheckpoints = exactStringArray(result.contentCheckpoints, 'contentCheckpoints');
  const matchedCheckpoints = exactStringArray(result.matchedCheckpoints, 'matchedCheckpoints');
  const checkpointPositions = exactIntegerArray(result.checkpointPositions, 'checkpointPositions');
  if (JSON.stringify(contentCheckpoints) !== JSON.stringify(preflight.contentCheckpoints)
    || JSON.stringify(matchedCheckpoints) !== JSON.stringify(preflight.contentCheckpoints)
    || checkpointPositions.length !== preflight.contentCheckpoints.length
    || checkpointPositions.some((position, index) => (
      position + codePointLength(preflight.contentCheckpoints[index]) > preflight.expectedCompactLength
      || (index > 0
        && position < checkpointPositions[index - 1]
          + codePointLength(preflight.contentCheckpoints[index - 1]))
    ))
    || result.allCheckpointsMatched !== true
    || result.checkpointsInOrder !== true) {
    throw new Error('X Article full-body checkpoints did not match the preflight.');
  }
  const expectedCompactLength = exactInteger(
    result.expectedCompactLength,
    'expectedCompactLength',
  );
  const compactTextLength = exactInteger(result.compactTextLength, 'compactTextLength');
  if (result.compactLengthUnit !== X_ARTICLE_CONTENT_LENGTH_UNIT
    || result.checkpointPositionUnit !== X_ARTICLE_CONTENT_LENGTH_UNIT
    || preflight.compactLengthUnit !== X_ARTICLE_CONTENT_LENGTH_UNIT
    || preflight.checkpointPositionUnit !== X_ARTICLE_CONTENT_LENGTH_UNIT) {
    throw new Error('X Article compact body units did not match the preflight.');
  }
  const expectedCompactSha256 = exactSha256(
    result.expectedCompactSha256,
    'expectedCompactSha256',
  );
  const contentCompactSha256 = exactSha256(
    result.contentCompactSha256,
    'contentCompactSha256',
  );
  if (expectedCompactLength !== preflight.expectedCompactLength
    || compactTextLength !== expectedCompactLength
    || expectedCompactSha256 !== preflight.expectedCompactSha256
    || contentCompactSha256 !== preflight.expectedCompactSha256
    || result.exactCompactLength !== true
    || result.exactCompactSha256 !== true
    || result.tableStripReliable !== true
    || result.mediaStripReliable !== true) {
    throw new Error('X Article exact compact body verification did not match the preflight.');
  }
  const mediaCount = exactInteger(result.media_count, 'media_count');
  const bodyMediaCount = exactInteger(result.body_media_count, 'body_media_count');
  const expectedBodyMedia = exactInteger(result.expected_body_media, 'expected_body_media');
  const expectedTotalMedia = exactInteger(result.expected_total_media, 'expected_total_media');
  const tableCount = exactInteger(result.tableCount, 'tableCount');
  const expectedTableCount = exactInteger(result.expected_table_count, 'expected_table_count');
  if (expectedTotalMedia !== preflight.totalMedia || mediaCount !== expectedTotalMedia) {
    throw new Error('X Article media accounting was inconsistent.');
  }
  if (expectedBodyMedia !== preflight.expectedBodyImages || bodyMediaCount !== expectedBodyMedia) {
    throw new Error('X Article body-media accounting was inconsistent.');
  }
  if (expectedTableCount !== preflight.expectedTables || tableCount !== expectedTableCount) {
    throw new Error('X Article table accounting was inconsistent.');
  }
  if (exactInteger(result.nativeTableNodesFound, 'nativeTableNodesFound') !== expectedTableCount) {
    throw new Error('X Article native table stripping was inconsistent.');
  }
  if (exactInteger(result.nativeMediaNodesFound, 'nativeMediaNodesFound') !== expectedBodyMedia) {
    throw new Error('X Article native media stripping was inconsistent.');
  }
  if (result.cover_uploaded !== preflight.coverUpload || result.cover_missing !== preflight.coverMissing
    || result.recommended_cover_ratio !== X_ARTICLE_COVER_RATIO) {
    throw new Error('X Article cover accounting was inconsistent.');
  }
  const sourceMediaContract = validateSourceMediaContract(
    result.source_media_contract,
    preflight,
  );
  try {
    const topLevelBindingKeys = exactStringArray(
      result.ordered_binding_keys,
      'ordered_binding_keys',
    );
    const verifiedMediaBindingKeys = exactStringArray(
      result.verifiedMediaBindingKeys,
      'verifiedMediaBindingKeys',
    );
    if (JSON.stringify(topLevelBindingKeys) !== JSON.stringify(sourceMediaContract.bindingKeys)
      || JSON.stringify(verifiedMediaBindingKeys) !== JSON.stringify(sourceMediaContract.bindingKeys)) {
      throw new Error('top-level binding annotation mismatch');
    }
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article top-level DOM binding annotations were incomplete; post-reload media remained authoritative.',
    );
  }
  const inserted = Array.isArray(result.inserted) ? result.inserted : [];
  try {
    if (inserted.length !== preflight.expectedBodyImages) {
      throw new Error('X Article inserted image accounting was inconsistent.');
    }
    const insertedIndexes = new Set<number>();
    const insertedBindingKeys: string[] = [];
    inserted.forEach((item, offset) => {
      const row = asRecord(item);
      const index = exactInteger(row.index, 'inserted.index');
      const expectedAnchor = preflight.anchors[index - 1];
      const sourceSignature = sourceMediaContract.sourceSignatures[offset];
      if (!expectedAnchor
        || index < 1 || index > preflight.expectedBodyImages || insertedIndexes.has(index)
        || index !== offset + 1
        || row.expected_anchor !== expectedAnchor.anchor
        || row.placement !== expectedAnchor.placement
        || path.basename(typeof row.file === 'string' ? row.file : '')
          !== path.basename(expectedAnchor.file)
        || row.source_signature !== sourceSignature
        || row.occurrence !== sourceMediaContract.occurrences[offset]
        || row.expected_dom_order !== offset
        || row.binding_key !== sourceMediaContract.bindingKeys[offset]) {
        throw new Error('X Article inserted image source contract was inconsistent.');
      }
      try {
        const observedSignature = typeof row.observed_signature === 'string'
          ? row.observed_signature.trim()
          : '';
        const computedDistance = visualSignatureHammingDistance(
          sourceSignature,
          observedSignature,
          `inserted[${offset}]`,
        );
        const pasteBinding = asRecord(row.paste_binding);
        const sourceAssignment = validateReportedSourceAssignment(
          pasteBinding,
          sourceSignature,
          observedSignature,
          sourceMediaContract.sourceSignatures,
          `inserted[${offset}].paste_binding`,
        );
        validateAdaptiveVisualMatch(
          pasteBinding,
          sourceAssignment,
          pasteBinding.observed_natural_width,
          pasteBinding.observed_natural_height,
          sourceMediaContract.sourceSampleIds[offset],
          sourceMediaContract.sourceSampleIds,
          `inserted[${offset}].paste_binding`,
        );
        const beforeSignatures = exactStringArray(
          pasteBinding.before_signatures,
          `inserted[${offset}].paste_binding.before_signatures`,
        );
        const afterSignatures = exactStringArray(
          pasteBinding.after_signatures,
          `inserted[${offset}].paste_binding.after_signatures`,
        );
        const candidateIndices = exactIntegerArray(
          pasteBinding.candidate_indices,
          `inserted[${offset}].paste_binding.candidate_indices`,
        );
        const identityCandidateIndices = exactIntegerArray(
          pasteBinding.identity_candidate_indices,
          `inserted[${offset}].paste_binding.identity_candidate_indices`,
        );
        const matchingCandidateIndices = exactIntegerArray(
          pasteBinding.matching_candidate_indices,
          `inserted[${offset}].paste_binding.matching_candidate_indices`,
        );
        const actualDomOrder = exactInteger(
          pasteBinding.actual_dom_order,
          `inserted[${offset}].paste_binding.actual_dom_order`,
        );
        const remainingSignatures = afterSignatures.filter((_, signatureOffset) => (
          signatureOffset !== actualDomOrder
        ));
        const survivingSequenceMatches = remainingSignatures.length === beforeSignatures.length
          && remainingSignatures.every((signature, signatureOffset) => (
            visualSignatureHammingDistance(
              beforeSignatures[signatureOffset],
              signature,
              `inserted[${offset}].paste_binding.sequence[${signatureOffset}]`,
            ) <= X_ARTICLE_VISUAL_MAX_HAMMING_DISTANCE
          ));
        if (row.observed_signature !== observedSignature
          || exactInteger(
            row.signature_hamming_distance,
            `inserted[${offset}].signature_hamming_distance`,
          ) !== computedDistance
          || row.signature_match !== true
          || pasteBinding.source_signature !== sourceSignature
          || pasteBinding.observed_signature !== observedSignature
          || exactInteger(
            pasteBinding.source_hamming_distance,
            `inserted[${offset}].paste_binding.source_hamming_distance`,
          ) !== computedDistance
          || exactInteger(
            pasteBinding.signature_hamming_distance,
            `inserted[${offset}].paste_binding.signature_hamming_distance`,
          ) !== computedDistance
          || pasteBinding.signature_match !== true
          || pasteBinding.source_occurrence !== sourceMediaContract.occurrences[offset]
          || pasteBinding.occurrence !== sourceMediaContract.occurrences[offset]
          || pasteBinding.expected_anchor !== expectedAnchor.anchor
          || pasteBinding.expected_final_dom_order !== offset
          || pasteBinding.identity_key !== sourceMediaContract.bindingKeys[offset]
          || pasteBinding.binding_key !== sourceMediaContract.bindingKeys[offset]
          || afterSignatures.length !== beforeSignatures.length + 1
          || identityCandidateIndices.length !== 1
          || identityCandidateIndices[0] !== actualDomOrder
          || actualDomOrder >= afterSignatures.length
          || afterSignatures[actualDomOrder] !== observedSignature
          || !survivingSequenceMatches
          || pasteBinding.anchor_matches !== true
          || pasteBinding.valid !== true
          || pasteBinding.recognizable !== true
          || pasteBinding.eligible_for_final_verification === false
          || matchingCandidateIndices.length !== 1
          || matchingCandidateIndices[0] !== actualDomOrder
          || !candidateIndices.includes(actualDomOrder)
          || typeof row.anchor_used !== 'string'
          || !mediaPositionMatches(expectedAnchor, row.anchor_used)
          || typeof pasteBinding.anchor_before !== 'string'
          || !mediaPositionMatches(expectedAnchor, pasteBinding.anchor_before)) {
          throw new Error('transient inserted image evidence mismatch');
        }
      } catch {
        addVerificationWarning(
          verificationWarnings,
          `X Article inserted image ${index} transient paste evidence was incomplete; post-reload media remained authoritative.`,
        );
      }
      insertedIndexes.add(index);
      insertedBindingKeys.push(sourceMediaContract.bindingKeys[offset]);
    });
    if (JSON.stringify(insertedBindingKeys) !== JSON.stringify(sourceMediaContract.bindingKeys)) {
      throw new Error('X Article inserted image binding order was inconsistent.');
    }
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article insertion-stage image records were incomplete; post-reload media remained authoritative.',
    );
  }
  try {
    const insertedTables = Array.isArray(result.inserted_tables) ? result.inserted_tables : [];
    if (insertedTables.length !== preflight.expectedTables) {
      throw new Error('X Article native table readback failed.');
    }
    insertedTables.forEach((item, offset) => {
      const row = asRecord(item);
      const expected = preflight.tables[offset];
      const expectedMatrix = exactStringMatrix(
        row.expected_matrix,
        `inserted_tables[${offset}].expected_matrix`,
      );
      const visibleMatrix = exactStringMatrix(
        row.visible_matrix,
        `inserted_tables[${offset}].visible_matrix`,
      );
      const insertedNonEmptyCells = exactInteger(
        row.visible_non_empty_cells,
        `inserted_tables[${offset}].visible_non_empty_cells`,
      );
      const computedInsertedNonEmptyCells = visibleMatrix.flat().filter(cell => cell.trim()).length;
      if (row.index !== expected?.index || row.rows !== expected.rows || row.columns !== expected.columns
        || row.marker !== expected.marker || row.table_dom_index !== offset
        || row.readback_matches !== true || row.visible_matrix_matches !== true
        || typeof row.readback_markdown !== 'string' || !row.readback_markdown.trim()
        || JSON.stringify(expectedMatrix) !== JSON.stringify(expected.normalizedMatrix)
        || JSON.stringify(visibleMatrix) !== JSON.stringify(expectedMatrix)
        || expectedMatrix.length !== expected.rows
        || expectedMatrix.some(matrixRow => matrixRow.length !== expected.columns)
        || computedInsertedNonEmptyCells < 1
        || insertedNonEmptyCells !== computedInsertedNonEmptyCells) {
        throw new Error('X Article native table readback failed.');
      }
    });
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article insertion-time table readback was incomplete; post-reload tables remained authoritative.',
    );
  }
  if (result.persistence_verified !== true) {
    throw new Error('X Article reload persistence was not verified.');
  }
  if (result.media_bindings_persisted !== true) {
    addVerificationWarning(
      verificationWarnings,
      'X Article top-level media persistence summary was unavailable; post-reload media remained authoritative.',
    );
  }
  const persistence = asRecord(result.persistence_evidence);
  if (persistence.reloaded !== true
    || persistence.verified !== true
    || persistence.draft_url_before_reload !== draftUrl
    || persistence.draft_url_after_reload !== draftUrl) {
    throw new Error('X Article reload persistence evidence was inconsistent.');
  }
  if (persistence.content_before_reload_verified !== true
    || persistence.content_after_reload_verified !== true
    || persistence.media_signatures_persisted !== true
    || persistence.paste_bindings_verified !== true
    || persistence.hosted_media_identity_persisted !== true
    || persistence.media_bindings_persisted !== true
    || persistence.replacement_baseline_verified !== true
    || persistence.cover_signature_persisted !== true
    || persistence.cover_persisted !== true) {
    addVerificationWarning(
      verificationWarnings,
      'X Article persistence summary flags were incomplete; exact post-reload evidence remained authoritative.',
    );
  }
  const mutationEpoch = typeof persistence.mutation_epoch === 'string'
    ? persistence.mutation_epoch.trim()
    : '';
  if (!mutationEpoch) addVerificationWarning(
    verificationWarnings,
    'X Article save-status mutation epoch was missing; reload persistence remained authoritative.',
  );
  try {
    validateBlankReplacementEvidence(persistence.replacement_clear);
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article blank-draft baseline observation was incomplete; post-reload content remained authoritative.',
    );
  }
  try {
    const persistenceBindingKeys = exactStringArray(
      persistence.ordered_binding_keys,
      'persistence_evidence.ordered_binding_keys',
    );
    if (JSON.stringify(persistenceBindingKeys) !== JSON.stringify(sourceMediaContract.bindingKeys)) {
      throw new Error('X Article hosted-media binding order was inconsistent.');
    }
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article persistence binding summary was incomplete; post-reload binding order remained authoritative.',
    );
  }
  try {
    validatePreReloadContentEvidence(
      persistence.content_before_reload,
      prepared,
      preflight,
      sourceMediaContract.bindingKeys,
    );
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article pre-reload body observation was incomplete; exact post-reload body remained authoritative.',
    );
  }
  let autosaveText = '';
  let autosaveVerified = false;
  if (result.autosave_verified === true
    && persistence.autosave_verified === true
    && mutationEpoch) {
    try {
      autosaveText = validateAutosaveEvidence(
        persistence.autosave_before_reload,
        mutationEpoch,
      );
      autosaveVerified = true;
    } catch {
      addVerificationWarning(
        verificationWarnings,
        'X Article save-status UI evidence was incomplete; reload persistence remained authoritative.',
      );
    }
  } else {
    addVerificationWarning(
      verificationWarnings,
      'X Article save-status UI was unavailable; reload persistence remained authoritative.',
    );
  }
  try {
    validatePostReloadAutosaveSentinel(persistence.autosave_after_reload);
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article post-reload save-status sentinel changed; reloaded content evidence remained authoritative.',
    );
  }
  let coverBefore: ValidatedCoverEvidence | null = null;
  try {
    coverBefore = validateCoverEvidence(
      persistence.cover_before_reload,
      preflight.coverUpload,
      'pre-reload',
      verificationWarnings,
    );
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article pre-reload cover observation was incomplete; post-reload cover remained authoritative.',
    );
  }
  const coverAfter = validateCoverEvidence(
    persistence.cover_after_reload,
    preflight.coverUpload,
    'post-reload',
    verificationWarnings,
  );
  try {
    if (!coverBefore) throw new Error('pre-reload cover evidence unavailable');
    const coverSignaturesExact = coverBefore.observedSignature === coverAfter.observedSignature;
    const coverPrePostDistance = preflight.coverUpload
      ? visualSignatureHammingDistance(
        coverBefore.observedSignature,
        coverAfter.observedSignature,
        'cover pre/post reload',
      )
      : null;
    if (coverBefore.sourceSignature !== coverAfter.sourceSignature
      || persistence.cover_signatures_exact !== coverSignaturesExact
      || (preflight.coverUpload
        ? exactInteger(
          persistence.cover_pre_post_hamming_distance,
          'cover_pre_post_hamming_distance',
        ) !== coverPrePostDistance
        : persistence.cover_pre_post_hamming_distance !== null)) {
      throw new Error('cover phase summary mismatch');
    }
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article cover phase comparison was incomplete; source-bound post-reload cover remained authoritative.',
    );
  }
  if (persistence.cover_count_after_reload !== (preflight.coverUpload ? 1 : 0)) {
    addVerificationWarning(
      verificationWarnings,
      'X Article cover count summary disagreed with exact post-reload cover evidence.',
    );
  }
  let tableMatricesBefore: string[][][] | null = null;
  try {
    tableMatricesBefore = validateTableEvidence(
      persistence.tables_before_reload,
      preflight,
      'pre_reload',
    );
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article pre-reload table observation was incomplete; post-reload tables remained authoritative.',
    );
  }
  const tableMatricesAfter = validateTableEvidence(
    persistence.tables_after_reload,
    preflight,
    'post_reload',
  );
  if (tableMatricesBefore
    && JSON.stringify(tableMatricesAfter) !== JSON.stringify(tableMatricesBefore)) {
    addVerificationWarning(
      verificationWarnings,
      'X Article table phase comparison changed; exact post-reload tables remained authoritative.',
    );
  }
  let mediaBefore: ValidatedMediaEvidence | null = null;
  try {
    mediaBefore = validateMediaEvidence(
      persistence.media_before_reload,
      preflight,
      sourceMediaContract,
      'pre_reload',
      verificationWarnings,
    );
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article pre-reload body-media observation was incomplete; post-reload media remained authoritative.',
    );
  }
  const mediaAfter = validateMediaEvidence(
    persistence.media_after_reload,
    preflight,
    sourceMediaContract,
    'post_reload',
    verificationWarnings,
  );
  try {
    if (!mediaBefore) throw new Error('pre-reload media evidence unavailable');
    const mediaPhase = asRecord(persistence.media_phase_persistence);
    const prePostDistances = exactIntegerArray(
      mediaPhase.observed_pre_post_hamming_distances,
      'media_phase_persistence.observed_pre_post_hamming_distances',
    );
    const computedPrePostDistances = mediaBefore.observedSignatures.map((signature, offset) => (
      visualSignatureHammingDistance(
        signature,
        mediaAfter.observedSignatures[offset],
        `media_phase_persistence[${offset}]`,
      )
    ));
    const exactObservedSignatures = JSON.stringify(mediaBefore.observedSignatures)
      === JSON.stringify(mediaAfter.observedSignatures);
    if (mediaPhase.before_valid !== true
      || mediaPhase.after_valid !== true
      || mediaPhase.ordered_identities_match !== true
      || mediaPhase.valid !== true
      || mediaPhase.exact_signatures_equal !== exactObservedSignatures
      || JSON.stringify(prePostDistances) !== JSON.stringify(computedPrePostDistances)
      || JSON.stringify(mediaBefore.bindingKeys) !== JSON.stringify(mediaAfter.bindingKeys)) {
      throw new Error('media phase summary mismatch');
    }
  } catch {
    addVerificationWarning(
      verificationWarnings,
      'X Article media phase comparison was incomplete; source-bound post-reload media remained authoritative.',
    );
  }
  inserted.forEach((item, offset) => {
    try {
      const row = asRecord(item);
      const persistedMedia = asRecord(row.persisted_media);
      if (row.binding_persisted !== true
        || persistedMedia.index !== offset + 1
        || persistedMedia.source_signature !== sourceMediaContract.sourceSignatures[offset]
        || persistedMedia.observed_signature !== mediaAfter.observedSignatures[offset]
        || persistedMedia.occurrence !== sourceMediaContract.occurrences[offset]
        || persistedMedia.identity_key !== sourceMediaContract.bindingKeys[offset]
        || persistedMedia.binding_key !== sourceMediaContract.bindingKeys[offset]) {
        throw new Error('persisted media summary mismatch');
      }
    } catch {
      addVerificationWarning(
        verificationWarnings,
        `X Article body image ${offset + 1} persistence summary was incomplete; post-reload identity remained authoritative.`,
      );
    }
  });
  const saveText = typeof result.saveText === 'string' ? result.saveText.trim() : '';
  if (!saveText || (autosaveVerified && saveText !== autosaveText)) {
    addVerificationWarning(
      verificationWarnings,
      'X Article save-status wording changed; reloaded content evidence remained authoritative.',
    );
  }
  return {
    verificationContract: X_ARTICLE_PERSISTENCE_CONTRACT,
    title: prepared.title,
    draftUrl,
    mediaCount,
    bodyMediaCount,
    expectedBodyMediaCount: expectedBodyMedia,
    expectedTotalMedia,
    tableCount,
    expectedTableCount,
    contentCheckpoints,
    matchedCheckpoints,
    checkpointPositions,
    expectedCompactLength,
    compactTextLength,
    compactLengthUnit: X_ARTICLE_CONTENT_LENGTH_UNIT,
    checkpointPositionUnit: X_ARTICLE_CONTENT_LENGTH_UNIT,
    expectedCompactSha256,
    contentCompactSha256,
    coverUploaded: preflight.coverUpload,
    coverMissing: preflight.coverMissing,
    coverPersisted: true,
    autosaveVerified,
    persistenceVerified: true,
    saveText,
    verificationWarnings,
    raw: result,
  };
}

export class XArticleLocalUploader {
  private readonly dependencies: XArticleUploaderDependencies;
  private readonly runtime: XArticleSkillRuntime;
  private readonly pythonCommand: string;
  private readonly cookiesPath: string;
  private readonly autoExportCookiesWhenMissing: boolean;
  private readonly headed: boolean;
  private readonly timeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly authorizeCookieMutation: (() => Promise<void>) | null;
  private readonly commitCanonicalCookies: XArticleLocalUploaderOptions['commitCanonicalCookies'];
  private activeChild: ChildProcess | null = null;
  private stopActive: ((kind: 'cancelled' | 'timed-out') => void) | null = null;
  private cancelled = false;

  constructor(options: XArticleLocalUploaderOptions) {
    this.dependencies = mergeDependencies(options.dependencies);
    this.runtime = options.runtime
      ?? discoverXArticleSkill({ uploadScriptPath: options.uploadScriptPath });
    this.pythonCommand = options.pythonCommand?.trim() || 'python3';
    this.cookiesPath = options.cookiesPath;
    this.autoExportCookiesWhenMissing = options.autoExportCookiesWhenMissing ?? false;
    this.headed = options.headed ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
    this.preflightTimeoutMs = options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    this.authorizeCookieMutation = options.authorizeCookieMutation ?? null;
    this.commitCanonicalCookies = options.commitCanonicalCookies;
  }

  cancel(): void {
    this.cancelled = true;
    this.stopActive?.('cancelled');
  }

  async preflight(
    prepared: PreparedXArticleMarkdown,
    options: XArticleRunOptions = {},
  ): Promise<XArticlePreflight> {
    this.throwIfCancelled(options.signal);
    await this.assertPreparedFileCurrent(prepared);
    await this.assertPreparedAssetsCurrent(prepared);
    this.throwIfCancelled(options.signal);
    options.onProgress?.({ stage: 'preflight', message: '正在执行 X Article 安全预检。' });
    const args = [
      '-u', this.runtime.uploadScript, prepared.path,
      '--parse-script', this.runtime.parseScript,
      '--title', prepared.title,
      '--dry-run',
    ];
    const result = await this.runProcess(args, this.preflightTimeoutMs, options.signal);
    if (result.cancelled) throw new Error('X Article preflight was cancelled.');
    if (result.timedOut) throw new Error('X Article preflight timed out.');
    if (result.truncated) throw new Error('X Article preflight output exceeded the safe limit.');
    await this.assertPreparedFileCurrent(prepared);
    await this.assertPreparedAssetsCurrent(prepared);
    this.throwIfCancelled(options.signal);
    let parsed: XArticlePreflight;
    try {
      parsed = addPreparedMarkdownPreflightErrors(
        validateXArticlePreflight(parseXArticlePreflightJson(result.stdout), prepared.contentHash),
        prepared.rewrittenMarkdown,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`X Article preflight output was invalid: ${detail}`);
    }
    if (parsed.title !== prepared.title || parsed.coverImage !== prepared.coverPath) {
      throw new Error('X Article preflight did not match the prepared Markdown.');
    }
    if (!parsed.errors.length) validateXArticleVisibleAnchorContract(parsed);
    if (prepared.omittedRemoteImages.length > 0) {
      throw new Error('X Article prepared Markdown omitted remote images; review them before uploading.');
    }
    if (parsed.totalMedia !== prepared.resolvedImages.length) {
      throw new Error('X Article preflight media count did not match the prepared Markdown occurrences.');
    }
    if (result.code !== 0 && !(result.code === 2 && parsed.errors.length > 0)) {
      throw new Error('X Article preflight process failed.');
    }
    options.onProgress?.({
      stage: 'preflight',
      message: parsed.errors.length ? 'X Article 检查发现需要处理的问题。' : 'X Article 检查通过。',
    });
    return parsed;
  }

  async exportCookies(options: XArticleRunOptions = {}): Promise<XArticleCookieStatus> {
    this.throwIfCancelled(options.signal);
    if (!this.authorizeCookieMutation) {
      throw new Error('X Cookie 写入未获得 Ailu Home 写入锁授权。');
    }
    await this.authorizeCookieMutation();
    if (!this.commitCanonicalCookies) {
      throw new Error('X Cookie 写入未配置 canonical 原子提交器。');
    }
    this.throwIfCancelled(options.signal);
    await this.assertCookieTargetReplaceable();
    const stagingPath = this.cookieExportStagingPath();
    await this.prepareCookieExportStagingFile(stagingPath);
    this.throwIfCancelled(options.signal);
    options.onProgress?.({ stage: 'cookies', message: '正在导出 X 登录态。' });
    const result = await this.runProcess(
      ['-u', this.runtime.cookieExportScript, '--output', stagingPath],
      this.preflightTimeoutMs,
      options.signal,
    );
    if (result.code !== 0 || result.cancelled || result.timedOut) {
      throw new Error('X 登录态导出失败；未返回任何 Cookie 内容。');
    }
    const status = await this.sanitizeExportedCookies(stagingPath);
    options.onProgress?.({ stage: 'cookies', message: 'X 登录态已验证。' });
    return status;
  }

  async upload(
    prepared: PreparedXArticleMarkdown,
    options: XArticleUploadOptions = {},
  ): Promise<XArticleUploadOutcome> {
    this.throwIfCancelled(options.signal);
    const preflight = options.preflight ?? await this.preflight(prepared, options);
    if (preflight.preparedContentHash !== prepared.contentHash) {
      throw new Error('X Article preflight is stale for the prepared Markdown.');
    }
    if (preflight.errors.length) {
      return {
        status: 'failed',
        message: 'X Article 检查未通过，未打开 X、未创建草稿。',
        draftUrl: null,
        artifacts: null,
        preflight,
        result: null,
      };
    }
    validateXArticleVisibleAnchorContract(preflight);
    await this.assertPreparedFileCurrent(prepared);
    await this.assertPreparedAssetsCurrent(prepared);
    this.throwIfCancelled(options.signal);
    try {
      await this.ensureCookies(options);
    } catch (error) {
      return {
        status: options.signal?.aborted ? 'cancelled' : 'failed',
        message: error instanceof Error ? error.message : 'X 登录态不可用。',
        draftUrl: null,
        artifacts: null,
        preflight,
        result: null,
      };
    }
    this.throwIfCancelled(options.signal);
    const directory = await this.dependencies.mkdtemp(
      path.join(this.dependencies.tempDirectory(), 'ailu-x-article-upload-'),
    );
    await this.dependencies.chmod(directory, 0o700);
    this.throwIfCancelled(options.signal);
    const artifacts: XArticleUploadArtifacts = {
      directory,
      resultJson: path.join(directory, 'result.json'),
      url: path.join(directory, 'draft-url.txt'),
      screenshot: path.join(directory, 'final.png'),
      log: path.join(directory, 'run.log'),
    };
    if ((await Promise.all([
      this.dependencies.fileExists(artifacts.resultJson),
      this.dependencies.fileExists(artifacts.url),
      this.dependencies.fileExists(artifacts.screenshot),
      this.dependencies.fileExists(artifacts.log),
    ])).some(Boolean)) {
      throw new Error('X Article artifact directory was not unique.');
    }
    await this.assertPreparedFileCurrent(prepared);
    await this.assertPreparedAssetsCurrent(prepared);
    this.throwIfCancelled(options.signal);
    const startedAt = this.dependencies.now();
    const args = [
      '-u', this.runtime.uploadScript, prepared.path,
      '--parse-script', this.runtime.parseScript,
      '--title', prepared.title,
      '--cookies-json', this.cookiesPath,
      '--result-json', artifacts.resultJson,
      '--url-output', artifacts.url,
      '--screenshot', artifacts.screenshot,
    ];
    if (this.headed) args.push('--headed');
    options.onProgress?.({ stage: 'upload', message: '正在创建并填写新的 X Article 草稿。' });
    const processResult = await this.runProcess(args, this.timeoutMs, options.signal, options.onProgress);
    let diagnosticLogWritten = true;
    try {
      await this.dependencies.writeTextPrivate(artifacts.log, processDiagnosticText(processResult));
    } catch {
      diagnosticLogWritten = false;
    }
    const artifactPermissionFailures = await tightenArtifactPermissions(this.dependencies, artifacts);
    const transportWarnings: string[] = [];
    if (!diagnosticLogWritten) {
      addVerificationWarning(
        transportWarnings,
        'X Article diagnostic log could not be written inside the private artifact directory.',
      );
    }
    if (artifactPermissionFailures.length > 0) {
      addVerificationWarning(
        transportWarnings,
        `X Article artifact file permissions could not be individually tightened (${artifactPermissionFailures.join('、')}); the containing directory remains private.`,
      );
    }
    const artifactUrl = await this.readFreshDraftUrl(artifacts.url, startedAt);
    const outputUrl = stdoutDraftUrl(processResult.stdout);
    const draftUrl = outputUrl ?? artifactUrl;
    const kind = failureKind(processResult);
    const partial = (message: string): XArticleUploadOutcome => draftUrl ? {
      status: 'partial-draft',
      failureKind: kind,
      message,
      draftUrl,
      artifacts,
      preflight,
      result: null,
    } : {
      status: kind,
      message,
      draftUrl: null,
      artifacts,
      preflight,
      result: null,
    };
    try {
      await this.assertPreparedFileCurrent(prepared);
      await this.assertPreparedAssetsCurrent(prepared);
    } catch {
      return partial('X Article 准备稿在浏览器运行期间发生变化；已保留草稿线索，未判定成功、未自动重试。');
    }
    if (processResult.code !== 0 || processResult.cancelled || processResult.timedOut) {
      const reason = processFailureSummary(processResult);
      return partial(`X Article 上传未完整成功；如已创建草稿，系统已保留其 URL 和全部诊断产物，未自动重试。${reason ? ` 原因：${reason}` : ''}`);
    }
    const hasStrictResultMarker = processResult.stdout
      .split(/\r?\n/)
      .some(line => line.trim() === STRICT_RESULT_OK_LINE);
    if (!hasStrictResultMarker) {
      addVerificationWarning(
        transportWarnings,
        'X Article stdout success marker was missing; atomic result artifacts remained authoritative.',
      );
    }
    if (!artifactUrl) {
      return partial('X Article 草稿 URL 原子产物缺失；未判定成功、未自动重试。');
    }
    if (!outputUrl) {
      addVerificationWarning(
        transportWarnings,
        'X Article stdout draft URL was missing; the atomic URL artifact remained authoritative.',
      );
    }
    if (outputUrl && outputUrl !== artifactUrl) {
      return partial('X Article 草稿 URL 产物彼此不一致；已保留可核对的链接，未自动重试。');
    }
    const verifiedDraftUrl = outputUrl ?? artifactUrl;
    try {
      const [resultText, , screenshotFresh] = await Promise.all([
        this.readFreshNonemptyText(artifacts.resultJson, startedAt),
        this.assertFreshNonemptyFile(artifacts.url, startedAt),
        this.assertFreshNonemptyFile(artifacts.screenshot, startedAt)
          .then(() => true)
          .catch(() => false),
      ]);
      if (!screenshotFresh) {
        addVerificationWarning(
          transportWarnings,
          'X Article final diagnostic screenshot was unavailable; persisted draft evidence remained authoritative.',
        );
      }
      const validated = validateUploadResult(
        JSON.parse(resultText) as unknown,
        prepared,
        preflight,
        verifiedDraftUrl,
      );
      const result: XArticleUploadResult = {
        ...validated,
        verificationWarnings: [
          ...transportWarnings,
          ...validated.verificationWarnings,
        ],
      };
      options.onProgress?.({ stage: 'upload', message: 'X Article 草稿上传并校验成功。' });
      return {
        status: 'success',
        message: preflight.coverMissing
          ? 'X Article 草稿已保存；当前缺少 5:2 封面。'
          : 'X Article 草稿已保存并通过严格校验。',
        draftUrl: verifiedDraftUrl,
        artifacts,
        preflight,
        result,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知校验错误';
      return partial(`X Article 已创建草稿，但结果产物或内容一致性校验失败：${reason} 未自动重试。`);
    }
  }

  private async ensureCookies(options: XArticleRunOptions): Promise<XArticleCookieStatus> {
    if (await this.dependencies.fileExists(this.cookiesPath)) {
      try {
        return await this.validateCookies();
      } catch (error) {
        if (!this.autoExportCookiesWhenMissing) throw error;
      }
      return this.exportCookies(options);
    }
    if (!this.autoExportCookiesWhenMissing) {
      throw new Error('X Cookie 文件不存在；未获准自动导出。');
    }
    return this.exportCookies(options);
  }

  private cookieExportStagingPath(): string {
    return path.join(
      path.dirname(this.cookiesPath),
      `.${path.basename(this.cookiesPath)}.chrome-export.json`,
    );
  }

  private async prepareCookieExportStagingFile(stagingPath: string): Promise<void> {
    if (!(await this.dependencies.fileExists(stagingPath))) {
      try {
        await this.dependencies.createPrivateFile(stagingPath);
      } catch (error) {
        if (!(await this.dependencies.fileExists(stagingPath))) throw error;
      }
    }
    const stat = await this.dependencies.stat(stagingPath).catch(() => null);
    if (!stat?.isFile || stat.size < 0 || stat.size > 5 * 1024 * 1024) {
      throw new Error('X Cookie 临时输出路径不是可安全覆盖的普通文件。');
    }
    await this.dependencies.chmod(stagingPath, 0o600);
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (this.cancelled || signal?.aborted) throw new Error('X Article operation was cancelled.');
  }

  private async assertPreparedFileCurrent(prepared: PreparedXArticleMarkdown): Promise<void> {
    let current: string;
    try {
      current = await this.dependencies.readText(prepared.path);
    } catch {
      throw new Error('X Article prepared Markdown is missing or unreadable.');
    }
    if (sha256(current) !== prepared.contentHash) {
      throw new Error('X Article prepared Markdown changed after preflight.');
    }
  }

  private async assertPreparedAssetsCurrent(prepared: PreparedXArticleMarkdown): Promise<void> {
    const expectedPaths = new Set(prepared.resolvedImages.map(image => image.absolutePath));
    const recordedPaths = new Set(prepared.assetDigests.map(asset => asset.path));
    if (expectedPaths.size !== recordedPaths.size
      || Array.from(expectedPaths).some(assetPath => !recordedPaths.has(assetPath))) {
      throw new Error('X Article staged image inventory did not match the prepared Markdown.');
    }
    for (const asset of prepared.assetDigests) {
      const stat = await this.dependencies.stat(asset.path).catch(() => null);
      if (!stat?.isFile || stat.size !== asset.size || asset.size <= 0 || asset.size > 20 * 1024 * 1024) {
        throw new Error('X Article staged image is missing or changed.');
      }
      const bytes = await this.dependencies.readBytes(asset.path).catch(() => null);
      if (!bytes || bytes.byteLength !== asset.size
        || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
        throw new Error('X Article staged image hash changed after preflight.');
      }
    }
  }

  private async validateCookies(): Promise<XArticleCookieStatus> {
    const stat = await this.dependencies.stat(this.cookiesPath).catch(() => null);
    if (!stat?.isFile || stat.size <= 0 || stat.size > 5 * 1024 * 1024) {
      throw new Error('X Cookie 文件不是合理大小的普通文件；Cookie 值未被读取。');
    }
    if (typeof stat.mode === 'number' && (stat.mode & 0o077) !== 0) {
      throw new Error('X Cookie 文件权限不安全；拒绝读取。');
    }
    const normalized = normalizeXCookieJsonText(await this.dependencies.readText(this.cookiesPath));
    return { path: this.cookiesPath, cookieCount: normalized.cookieCount, requiredNamesPresent: true };
  }

  private async sanitizeExportedCookies(stagingPath: string): Promise<XArticleCookieStatus> {
    const stat = await this.dependencies.stat(stagingPath).catch(() => null);
    if (!stat?.isFile || stat.size < 0 || stat.size > 5 * 1024 * 1024) {
      throw new Error('X 登录态导出结果不是合理大小的普通文件。');
    }
    const text = await this.dependencies.readText(stagingPath).catch(() => '');
    const normalized = normalizeXCookieJsonText(text, { filterInvalid: true });
    if (!this.authorizeCookieMutation) {
      throw new Error('X Cookie 提交未获得 Ailu Home 写入锁授权。');
    }
    await this.authorizeCookieMutation();
    await this.assertCookieTargetReplaceable();
    if (!this.commitCanonicalCookies) {
      throw new Error('X Cookie 提交未配置 canonical 原子提交器。');
    }
    const committed = await this.commitCanonicalCookies(normalized.json);
    if (path.resolve(committed.path) !== path.resolve(this.cookiesPath)
      || committed.cookieCount !== normalized.cookieCount) {
      throw new Error('X Cookie canonical 提交结果不一致。');
    }
    await this.dependencies.writeTextPrivate(stagingPath, '[]\n').catch(() => undefined);
    return { path: committed.path, cookieCount: committed.cookieCount, requiredNamesPresent: true };
  }

  private async assertCookieTargetReplaceable(): Promise<void> {
    const stat = await this.dependencies.stat(this.cookiesPath).catch(() => null);
    if (!stat) return;
    if (!stat.isFile || stat.size < 0 || stat.size > 5 * 1024 * 1024) {
      throw new Error('X Cookie 正式文件不是可安全覆盖的普通文件。');
    }
    if (typeof stat.mode === 'number' && (stat.mode & 0o077) !== 0) {
      throw new Error('X Cookie 正式文件权限不安全；拒绝覆盖。');
    }
    if (stat.size === 0) return;
    const text = await this.dependencies.readText(this.cookiesPath).catch(() => null);
    if (text === null || !text.trim()) return;
    try {
      assertSupportedXCookieJsonForReplacement(text);
    } catch {
      throw new Error('X Cookie 正式文件已有非规范内容，拒绝覆盖。');
    }
  }

  private async readFreshDraftUrl(filePath: string, startedAt: number): Promise<string | null> {
    try {
      const text = await this.readFreshNonemptyText(filePath, startedAt);
      return safeDraftUrl(text);
    } catch {
      return null;
    }
  }

  private async assertFreshNonemptyFile(filePath: string, startedAt: number): Promise<void> {
    const stat = await this.dependencies.stat(filePath);
    if (!stat.isFile || stat.size <= 0 || stat.mtimeMs < startedAt - 1_000) {
      throw new Error('X Article artifact was missing, stale, or empty.');
    }
  }

  private async readFreshNonemptyText(filePath: string, startedAt: number): Promise<string> {
    await this.assertFreshNonemptyFile(filePath, startedAt);
    const text = await this.dependencies.readText(filePath);
    if (!text.trim()) throw new Error('X Article text artifact was empty.');
    return text;
  }

  private runProcess(
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
    onProgress?: XArticleProgressCallback,
  ): Promise<ProcessResult> {
    if (this.activeChild) throw new Error('An X Article process is already running.');
    if (this.cancelled || signal?.aborted) {
      return Promise.resolve({
        code: null, stdout: '', stderr: '', truncated: false, cancelled: true, timedOut: false,
      });
    }
    return new Promise(resolve => {
      let child: ChildProcess;
      try {
        child = this.dependencies.spawn(this.pythonCommand, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });
      } catch {
        resolve({ code: null, stdout: '', stderr: '', truncated: false, cancelled: false, timedOut: false });
        return;
      }
      this.activeChild = child;
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let stopped: 'cancelled' | 'timed-out' | null = null;
      let settled = false;
      let lineBuffer = '';
      const stop = (kind: 'cancelled' | 'timed-out') => {
        if (stopped) return;
        stopped = kind;
        child.kill('SIGTERM');
        window.setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 1_500);
      };
      this.stopActive = stop;
      const timer = window.setTimeout(() => stop('timed-out'), timeoutMs);
      const onAbort = () => stop('cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.activeChild = null;
        this.stopActive = null;
        resolve({
          code,
          stdout,
          stderr,
          truncated,
          cancelled: stopped === 'cancelled',
          timedOut: stopped === 'timed-out',
        });
      };
      child.stdout?.on('data', chunk => {
        const text = String(chunk);
        const appended = appendBounded(stdout, text);
        stdout = appended.value;
        truncated ||= appended.truncated;
        if (onProgress && args.includes('--result-json')) {
          lineBuffer += text;
          const lines = lineBuffer.split(/\r?\n/);
          lineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            if (/^(?:\[|draft_url=|image |table |COVER_REMINDER)/.test(line)) {
              onProgress({ stage: 'upload', message: line.slice(0, 240) });
            }
          }
        }
      });
      child.stderr?.on('data', chunk => {
        const appended = appendBounded(stderr, String(chunk));
        stderr = appended.value;
        truncated ||= appended.truncated;
      });
      child.once('error', () => finish(null));
      child.once('close', code => finish(code));
    });
  }
}
