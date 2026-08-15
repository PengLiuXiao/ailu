import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PUBLIC_SOURCE_MANIFEST = 'public-source-files.json';
export const GENERATED_PUBLIC_ARTIFACTS = Object.freeze([
  'build-attestation.json',
  'main.js',
]);

const GENERATED_SET = new Set(GENERATED_PUBLIC_ARTIFACTS);
const LOCAL_ONLY_ROOTS = new Set(['.git', 'node_modules']);
const ALLOWED_BINARY_FILES = new Map([
  ['assets/ailu-ribbon-icon.png', {
    magic: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    sha256: 'e3f456b18da3704157f51c29b5dbe85baa4f8a48499fbdc6c176585050ce84aa',
  }],
]);
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.css',
  '.json',
  '.js',
  '.md',
  '.mjs',
  '.ts',
  '.txt',
  '.yml',
]);
const ALLOWED_EXTENSIONLESS_TEXT = new Set(['.gitignore', 'LICENSE']);
const MAX_PUBLIC_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const SAFE_SYNTHETIC_MACOS_USERS = new Set(['example']);
const SAFE_SYNTHETIC_WINDOWS_USERS = new Set(['example']);

function fail(message) {
  throw new Error(message);
}

function normalizedPublicPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0')) {
    fail('Public source manifest contains an invalid path.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value
    || path.posix.isAbsolute(value)
    || value === '..'
    || value.startsWith('../')
    || value.endsWith('/')) {
    fail(`Public source manifest contains a non-canonical path: ${value}`);
  }
  return normalized;
}

function assertAllowedSensitivePath(relativePath) {
  const lower = relativePath.toLowerCase();
  const base = path.posix.basename(lower);
  if (
    base === '.env'
    || (base.startsWith('.env.') && base !== '.env.example')
    || /\.(?:pem|key|p12|pfx|sqlite(?:-.*)?|db|log)$/i.test(base)
    || /(?:^|[-_.])cookies?(?:[-_.]|$)/i.test(base)
    || relativePath.split('/').some(part => [
      'AGENTS.md',
      'HEARTBEAT.md',
      'IDENTITY.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
    ].includes(part))
    || lower.includes('/e2e-results/')
    || lower.includes('/deploy-receipts/')
  ) {
    fail(`Sensitive or runtime-owned path cannot enter the public source tree: ${relativePath}`);
  }
}

export function assertPublicText(relativePath, text) {
  if (text.includes('\0')) fail(`Public text file contains a NUL byte: ${relativePath}`);
  for (const match of text.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
    if (!SAFE_SYNTHETIC_MACOS_USERS.has(match[1])) {
      fail(`Public source contains a personal macOS home path: ${relativePath}`);
    }
  }
  for (const match of text.matchAll(/[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)/gi)) {
    if (!SAFE_SYNTHETIC_WINDOWS_USERS.has(match[1].toLowerCase())) {
      fail(`Public source contains a personal Windows home path: ${relativePath}`);
    }
  }
  const privateKeyPattern = new RegExp([
    '-----BEGIN ',
    '(?:RSA |EC |OPENSSH )?',
    'PRIVATE KEY-----',
  ].join(''));
  const credentialPatterns = [
    new RegExp(['gh', '[pousr]_', '[A-Za-z0-9]{20,}'].join(''), 'g'),
    new RegExp(['github_', 'pat_', '[A-Za-z0-9_]{20,}'].join(''), 'g'),
    new RegExp(['xox', '[baprs]-', '[A-Za-z0-9-]{20,}'].join(''), 'g'),
    new RegExp(['AKIA', '[A-Z0-9]{16}'].join(''), 'g'),
    new RegExp(['AIza', '[A-Za-z0-9_-]{30,}'].join(''), 'g'),
    new RegExp(['eyJ', '[A-Za-z0-9_-]{10,}', '\\.', '[A-Za-z0-9_-]{10,}', '\\.', '[A-Za-z0-9_-]{10,}'].join(''), 'g'),
    new RegExp(['Authorization', '\\s*:\\s*Bearer\\s+', '[A-Za-z0-9._~-]{20,}'].join(''), 'gi'),
  ];
  const syntheticCredentialMarker = /(?:example|fake|fixture|placeholder|secret|sentinel|test)/i;
  if (privateKeyPattern.test(text)) {
    fail(`Public source contains private-key material: ${relativePath}`);
  }
  for (const pattern of credentialPatterns) {
    for (const match of text.matchAll(pattern)) {
      if (!syntheticCredentialMarker.test(match[0])) {
        fail(`Public source contains credential-like material: ${relativePath}`);
      }
    }
  }
  for (const match of text.matchAll(/\b(?:auth_token|ct0)\b\s*=\s*["']?([A-Za-z0-9%._~-]{20,})["']?/gi)) {
    const candidate = match[1] ?? '';
    if (/\d/.test(candidate) && !syntheticCredentialMarker.test(match[0])) {
      fail(`Public source contains cookie-like material: ${relativePath}`);
    }
  }
  for (const match of text.matchAll(/\bsk-[A-Za-z0-9_-]{20,}\b/g)) {
    if (!syntheticCredentialMarker.test(match[0])) {
      fail(`Public source contains API-key-like material: ${relativePath}`);
    }
  }
}

export function assertExactPublicInventory(manifestFiles, actualFiles) {
  const expected = manifestFiles.map(normalizedPublicPath);
  if (new Set(expected).size !== expected.length) fail('Public source manifest contains duplicates.');
  const sortedExpected = [...expected].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expected) !== JSON.stringify(sortedExpected)) {
    fail('Public source manifest paths must be sorted.');
  }
  const sortedActual = [...actualFiles].sort((left, right) => left.localeCompare(right));
  const missing = expected.filter(file => !sortedActual.includes(file));
  const unexpected = sortedActual.filter(file => !expected.includes(file));
  if (missing.length || unexpected.length) {
    fail(`Public source inventory mismatch. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`);
  }
  return expected;
}

function readManifest(root) {
  const manifestPath = path.join(root, PUBLIC_SOURCE_MANIFEST);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.files)) {
    fail('Public source manifest has an unsupported schema.');
  }
  return parsed.files;
}

function collectTree(root) {
  const sourceFiles = [];
  const generatedFiles = [];
  const walk = (relativeDirectory) => {
    const directory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (!relativeDirectory && LOCAL_ONLY_ROOTS.has(entry.name)) continue;
      if (!relativeDirectory && GENERATED_SET.has(entry.name)) {
        if (!entry.isFile()) fail(`Generated release artifact must be a regular file: ${relativePath}`);
        generatedFiles.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) fail(`Public source tree must not contain symlinks: ${relativePath}`);
      if (entry.isDirectory()) {
        walk(relativePath);
      } else if (entry.isFile()) {
        sourceFiles.push(relativePath);
      } else {
        fail(`Public source tree must not contain special files: ${relativePath}`);
      }
    }
  };
  walk('');
  return { sourceFiles, generatedFiles };
}

function assertPublicFile(root, relativePath) {
  assertAllowedSensitivePath(relativePath);
  const absolutePath = path.join(root, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`Public source entry must be a regular non-symlink file: ${relativePath}`);
  }
  if (stat.size <= 0 || stat.size > MAX_PUBLIC_SOURCE_FILE_BYTES) {
    fail(`Public source file has an invalid size: ${relativePath}`);
  }
  const bytes = fs.readFileSync(absolutePath);
  const binaryPolicy = ALLOWED_BINARY_FILES.get(relativePath);
  if (binaryPolicy) {
    if (bytes.byteLength < binaryPolicy.magic.byteLength
      || !binaryPolicy.magic.every((value, index) => bytes[index] === value)
      || crypto.createHash('sha256').update(bytes).digest('hex') !== binaryPolicy.sha256) {
      fail(`Allowlisted public binary has an invalid signature: ${relativePath}`);
    }
    return;
  }
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (!ALLOWED_TEXT_EXTENSIONS.has(extension)
    && !ALLOWED_EXTENSIONLESS_TEXT.has(path.posix.basename(relativePath))) {
    fail(`Public binary or unsupported file type is not allowlisted: ${relativePath}`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`Public text file is not valid UTF-8: ${relativePath}`);
  }
  assertPublicText(relativePath, text);
}

export function assertExactGitIndexState(sourceFiles, entries, worktreeMatchesIndex) {
  if (!entries.length) return;
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0') {
      fail(`Git index contains a non-regular or unmerged public entry: ${entry.path}.`);
    }
  }
  const tracked = entries.map(entry => entry.path)
    .sort((left, right) => left.localeCompare(right));
  const trackedGenerated = tracked.filter(file => GENERATED_SET.has(file));
  if (trackedGenerated.length) {
    fail(`Generated release artifacts must remain untracked: ${trackedGenerated.join(', ')}.`);
  }
  const expected = [...sourceFiles].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(tracked) !== JSON.stringify(expected)) {
    const missing = expected.filter(file => !tracked.includes(file));
    const unexpected = tracked.filter(file => !expected.includes(file));
    fail(`Git index differs from the reviewed public tree. Missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`);
  }
  if (!worktreeMatchesIndex) {
    fail('Git index bytes or modes differ from the reviewed public working tree.');
  }
}

function assertGitIndexInventory(root, sourceFiles) {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) fail('Unable to inspect the Git index for public release validation.');
  const entries = result.stdout.split('\0').filter(Boolean).map((record) => {
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) fail('Git index returned a malformed public entry.');
    return { mode: match[1], stage: match[3], path: match[4] };
  });
  if (!entries.length) return;
  const compared = spawnSync(
    'git',
    ['diff-files', '--quiet', '--no-ext-diff', '--ignore-submodules=none', '--'],
    { cwd: root, stdio: 'ignore' },
  );
  if (compared.status !== 0 && compared.status !== 1) {
    fail('Unable to compare the Git index with the reviewed public working tree.');
  }
  assertExactGitIndexState(sourceFiles, entries, compared.status === 0);
}

export function verifyPublicSourceTree(
  root = process.cwd(),
  options = {},
) {
  const resolvedRoot = fs.realpathSync(root);
  const manifestFiles = readManifest(resolvedRoot);
  const { sourceFiles, generatedFiles } = collectTree(resolvedRoot);
  const files = assertExactPublicInventory(manifestFiles, sourceFiles);
  if (!files.includes(PUBLIC_SOURCE_MANIFEST)
    || !files.includes('scripts/public-source-policy.mjs')
    || !files.includes('scripts/test-public-source-policy.mjs')) {
    fail('Public source policy and its manifest/self-test must attest themselves.');
  }
  for (const file of files) assertPublicFile(resolvedRoot, file);
  if (options.requireGeneratedArtifacts === true) {
    const actual = [...generatedFiles].sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(actual) !== JSON.stringify([...GENERATED_PUBLIC_ARTIFACTS].sort())) {
      fail('Generated public release artifacts are missing or unexpected.');
    }
    for (const artifact of actual) assertPublicFile(resolvedRoot, artifact);
  }
  assertGitIndexInventory(resolvedRoot, files);
  return Object.freeze({ root: resolvedRoot, files: Object.freeze([...files]) });
}
