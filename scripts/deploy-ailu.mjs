import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { verifyPublicSourceTree } from './public-source-policy.mjs';

const CANONICAL_PLUGIN_ID = 'ailu';
const CANONICAL_VAULT_NAMESPACE = '.ailu';
const ARTIFACTS = ['main.js', 'manifest.json', 'styles.css', 'build-attestation.json'];
const RECEIPT_SCHEMA_VERSION = 1;
const LOCK_HELPER = String.raw`
import base64
import ctypes
import fcntl
import json
import os
import stat
import sys

root = os.path.realpath(sys.argv[1])
lock_path = sys.argv[2]
parent = os.path.dirname(lock_path)
if os.path.realpath(parent) != parent:
    raise RuntimeError("lock directory symlinks are forbidden")
if os.path.commonpath([root, parent]) != root:
    raise RuntimeError("lock directory escapes authority")
flags = os.O_RDONLY
if hasattr(os, "O_DIRECTORY"):
    flags |= os.O_DIRECTORY
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
parent_fd = os.open(parent, flags)
lock_flags = os.O_CREAT | os.O_RDWR
if hasattr(os, "O_NOFOLLOW"):
    lock_flags |= os.O_NOFOLLOW
fd = os.open(os.path.basename(lock_path), lock_flags, 0o600, dir_fd=parent_fd)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    raise RuntimeError("lock path is not a regular file")
os.fchmod(fd, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print(json.dumps({"type":"BUSY"}, separators=(",",":")), flush=True)
    os.close(fd)
    os.close(parent_fd)
    raise SystemExit(73)
print(json.dumps({"type":"READY"}, separators=(",",":")), flush=True)

def read_file_at(directory_fd, name):
    read_flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        read_flags |= os.O_NOFOLLOW
    try:
        current_fd = os.open(name, read_flags, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(current_fd).st_mode):
            raise ValueError("CAS target must be a regular file")
        chunks = []
        while True:
            chunk = os.read(current_fd, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(current_fd)

def exchange_files(directory_fd, directory_path, left, right):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        renamex_np = libc.renamex_np
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        result = renamex_np(
            os.path.join(directory_path, left).encode(),
            os.path.join(directory_path, right).encode(),
            0x00000002,
        )
    elif hasattr(libc, "renameat2"):
        renameat2 = libc.renameat2
        renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        renameat2.restype = ctypes.c_int
        result = renameat2(directory_fd, left.encode(), directory_fd, right.encode(), 0x00000002)
    else:
        raise RuntimeError("atomic exchange is unavailable on this POSIX platform")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))

for line in sys.stdin:
    command = line.strip()
    if command == "release":
        break
    try:
        request = json.loads(command)
        if request.get("op") != "cas":
            raise ValueError("unsupported lock helper operation")
        target_path = request.get("target")
        expected = request.get("expected")
        replacement = request.get("replacement")
        if not isinstance(target_path, str) or not os.path.isabs(target_path):
            raise ValueError("CAS target must be absolute")
        target_parent = os.path.dirname(target_path)
        if os.path.realpath(target_parent) != target_parent:
            raise ValueError("CAS target parent symlinks are forbidden")
        if os.path.commonpath([root, target_parent]) != root:
            raise ValueError("CAS target escapes authority")
        target_name = os.path.basename(target_path)
        target_parent_fd = os.open(target_parent, flags)
        try:
            current = read_file_at(target_parent_fd, target_name)
            expected_bytes = None if expected is None else base64.b64decode(expected, validate=True)
            if current != expected_bytes:
                print(json.dumps({"type":"CAS","swapped":False}, separators=(",",":")), flush=True)
                continue
            replacement_bytes = base64.b64decode(replacement, validate=True)
            temp_name = target_name + ".ailu-stage-" + str(os.getpid()) + "-" + os.urandom(8).hex()
            temp_fd = os.open(temp_name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=target_parent_fd)
            try:
                offset = 0
                while offset < len(replacement_bytes):
                    offset += os.write(temp_fd, replacement_bytes[offset:])
                os.fsync(temp_fd)
            finally:
                os.close(temp_fd)
            if expected_bytes is None:
                try:
                    os.link(temp_name, target_name, src_dir_fd=target_parent_fd, dst_dir_fd=target_parent_fd, follow_symlinks=False)
                except FileExistsError:
                    print(json.dumps({"type":"CAS","swapped":False}, separators=(",",":")), flush=True)
                    continue
            else:
                # Keep an immutable link to the replacement so even an
                # uncooperative writer racing the exchange cannot lose bytes.
                recovery_fd = os.open(
                    temp_name + ".replacement",
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                    0o600,
                    dir_fd=target_parent_fd,
                )
                try:
                    recovery_offset = 0
                    while recovery_offset < len(replacement_bytes):
                        recovery_offset += os.write(recovery_fd, replacement_bytes[recovery_offset:])
                    os.fsync(recovery_fd)
                finally:
                    os.close(recovery_fd)
                exchange_files(target_parent_fd, target_parent, temp_name, target_name)
                displaced = read_file_at(target_parent_fd, temp_name)
                if displaced != expected_bytes:
                    exchange_files(target_parent_fd, target_parent, temp_name, target_name)
                    os.fsync(target_parent_fd)
                    print(json.dumps({"type":"CAS","swapped":False}, separators=(",",":")), flush=True)
                    continue
            installed_flags = os.O_RDONLY
            if hasattr(os, "O_NOFOLLOW"):
                installed_flags |= os.O_NOFOLLOW
            installed_fd = os.open(target_name, installed_flags, dir_fd=target_parent_fd)
            try:
                os.fchmod(installed_fd, 0o600)
            finally:
                os.close(installed_fd)
            os.fsync(target_parent_fd)
        finally:
            os.close(target_parent_fd)
        print(json.dumps({"type":"CAS","swapped":True}, separators=(",",":")), flush=True)
    except Exception as error:
        print(json.dumps({"type":"ERROR","error":str(error)[:512]}, separators=(",",":")), flush=True)
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
os.close(parent_fd)
`;

const options = parseArgs(process.argv.slice(2));
await main(options);

async function main(args) {
  requirePosix();
  if (args.mode.startsWith('rollback-')) {
    await runRollback(args);
    return;
  }
  if (args.mode.startsWith('recover-')) {
    await runRecover(args);
    return;
  }
  const repoRoot = realDirectory(process.cwd(), 'repository');
  const artifacts = readArtifacts(repoRoot);
  const obsidianRunning = isObsidianRunning();
  const plans = args.vaults.map(vault => buildPlan(vault, artifacts, obsidianRunning));
  recoverInterruptedDeploymentReceipt(plans[0], args.mode);
  if (args.mode === 'plan') {
    emit({
      schema_version: RECEIPT_SCHEMA_VERSION,
      mode: 'plan',
      product: CANONICAL_PLUGIN_ID,
      platform: process.platform,
      obsidian_running: obsidianRunning,
      apply_requires_obsidian_stopped: true,
      apply_requires_all_writer_locks: true,
      plans,
    });
    return;
  }
  if (obsidianRunning) {
    throw new Error('DEPLOY_OBSIDIAN_RUNNING: quit every Obsidian process before apply.');
  }
  const results = [];
  for (const plan of plans) {
    results.push(await applyPlan(plan, artifacts));
  }
  emit({ schema_version: RECEIPT_SCHEMA_VERSION, mode: 'apply', product: CANONICAL_PLUGIN_ID, results });
}

function parseArgs(argv) {
  let mode = 'plan';
  let receipt = '';
  const vaults = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') mode = argv[++index] ?? '';
    else if (arg === '--vault') vaults.push(argv[++index] ?? '');
    else if (arg === '--receipt') receipt = argv[++index] ?? '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['plan', 'apply', 'rollback-plan', 'rollback-apply', 'recover-plan', 'recover-apply'].includes(mode)) {
    throw new Error('Mode must be plan, apply, rollback-plan, rollback-apply, recover-plan, or recover-apply.');
  }
  if (mode.startsWith('rollback-') || mode.startsWith('recover-')) {
    if (!receipt || vaults.length > 0) {
      throw new Error('Recovery/rollback requires exactly --receipt and accepts no --vault argument.');
    }
    return {
      mode,
      vaults: [],
      receipt: path.resolve(receipt),
    };
  }
  if (vaults.length === 0 || vaults.some(vault => !vault.trim())) {
    throw new Error('Plan/apply requires one or more --vault /absolute/path arguments.');
  }
  const uniqueVaults = [...new Set(vaults.map(vault => path.resolve(vault)))];
  if (uniqueVaults.length !== 1) {
    throw new Error('Ailu deployer handles exactly one Vault per invocation; verify it before the next.');
  }
  return {
    mode,
    vaults: uniqueVaults,
    receipt: '',
  };
}

async function runRecover(args) {
  const receiptAuthority = readJsonAuthority(args.receipt, 'deployment receipt');
  const record = receiptAuthority.value;
  if (!isRecord(record)
    || record.schema_version !== RECEIPT_SCHEMA_VERSION
    || record.product !== CANONICAL_PLUGIN_ID
    || record.state !== 'committed_by_community_pointer'
    || typeof record.vault !== 'string'
    || typeof record.backup_root !== 'string'
    || typeof record.community_plugins_path !== 'string'
    || typeof record.community_after_sha256 !== 'string'
    || !isRecord(record.artifact_after_sha256)) {
    throw new Error('Forward recovery receipt is invalid or not a committed Ailu deployment generation.');
  }
  if (path.resolve(args.receipt) !== path.join(path.resolve(record.backup_root), 'deploy-receipt.json')) {
    throw new Error('Forward recovery receipt is outside its declared backup root.');
  }
  const outcomePath = `${args.receipt}.deploy-outcome`;
  const plan = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    mode: args.mode,
    receipt: args.receipt,
    vault: record.vault,
    obsidian_running: isObsidianRunning(),
    requires_exact_community_after: record.community_after_sha256,
    verifies_artifact_hashes: true,
    outcome_path: outcomePath,
  };
  if (args.mode === 'recover-plan') {
    emit(plan);
    return;
  }
  if (plan.obsidian_running) throw new Error('RECOVER_OBSIDIAN_RUNNING: quit every Obsidian process.');
  const locks = await acquireDeploymentLocks(realDirectory(record.vault, 'Vault'));
  try {
    if (isObsidianRunning()) throw new Error('RECOVER_OBSIDIAN_RESTARTED: outcome was not adopted.');
    if (hashFile(record.community_plugins_path) !== record.community_after_sha256) {
      throw new Error('RECOVER_POINTER_GENERATION_MISMATCH: community-plugins.json is not the exact deployment generation.');
    }
    const targetDir = path.join(record.vault, '.obsidian', 'plugins', CANONICAL_PLUGIN_ID);
    for (const artifact of ARTIFACTS) {
      if (record.artifact_after_sha256[artifact] !== hashFile(path.join(targetDir, artifact))) {
        throw new Error(`RECOVER_ARTIFACT_MISMATCH: ${artifact} changed after deployment.`);
      }
    }
    const payload = Buffer.from(`${JSON.stringify({
      schema_version: RECEIPT_SCHEMA_VERSION,
      product: CANONICAL_PLUGIN_ID,
      state: 'deploy_pointer_observed',
      deployment_generation_sha256: deploymentGenerationHash(record),
      community_after_sha256: record.community_after_sha256,
      pointer_observed: true,
    }, null, 2)}\n`);
    const existing = readOptionalSafeFile(outcomePath);
    if (existing) {
      if (!existing.equals(payload)) throw new Error('Existing deploy outcome conflicts with this generation.');
    } else {
      writeExclusivePrivate(outcomePath, payload);
    }
    emit({ ...plan, status: 'deploy_outcome_adopted', all_writer_locks_held: true });
  } finally {
    await releaseLocksReverse(locks);
  }
}

function requirePosix() {
  if (process.platform === 'win32') {
    throw new Error('AILU_POSIX_ONLY: Ailu deployment and writer fencing are disabled on Windows.');
  }
  if (!fs.existsSync('/usr/bin/python3')) {
    throw new Error('AILU_PYTHON_MISSING: /usr/bin/python3 is required for the verified POSIX lock helper.');
  }
}

function readArtifacts(repoRoot) {
  const verified = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (verified.status !== 0) {
    throw new Error(`Release verification failed before deployment: ${verified.stderr || verified.stdout}`);
  }
  const result = [];
  for (const filename of ARTIFACTS) {
    const source = path.join(repoRoot, filename);
    const state = safeLstat(source);
    if (!state?.isFile() || state.isSymbolicLink()) {
      throw new Error(`Release artifact is missing or unsafe: ${filename}.`);
    }
    const bytes = fs.readFileSync(source);
    if (bytes.length === 0) throw new Error(`Release artifact is empty: ${filename}.`);
    result.push({ filename, source, bytes, sha256: hashBytes(bytes) });
  }
  const attested = JSON.parse(
    result.find(item => item.filename === 'build-attestation.json').bytes.toString('utf8'),
  );
  if (!isRecord(attested)
    || attested.schema_version !== 1
    || attested.product !== CANONICAL_PLUGIN_ID
    || attested.version !== '0.4.0'
    || !Array.isArray(attested.inputs)) {
    throw new Error('Captured build attestation has an unsupported identity or schema.');
  }
  for (const artifact of ['main.js', 'manifest.json', 'styles.css']) {
    const captured = result.find(item => item.filename === artifact);
    if (attested.artifacts?.[artifact] !== captured?.sha256) {
      throw new Error(`Captured ${artifact} bytes do not match the captured build attestation.`);
    }
  }
  const inputPaths = collectBuildInputPaths(repoRoot);
  const capturedInputs = inputPaths.map(file => ({
    path: file,
    sha256: hashFile(path.join(repoRoot, file)),
  }));
  if (JSON.stringify(attested.inputs) !== JSON.stringify(capturedInputs)) {
    throw new Error('Captured build attestation does not match the current complete input set.');
  }
  const toolchain = {
    node_executable_sha256: hashFile(process.execPath),
    esbuild_library_sha256: hashFile(path.join(repoRoot, 'node_modules/esbuild/lib/main.js')),
    esbuild_binary_sha256: hashFile(path.join(repoRoot, 'node_modules/esbuild/bin/esbuild')),
    typescript_cli_sha256: hashFile(path.join(repoRoot, 'node_modules/typescript/lib/tsc.js')),
  };
  if (canonicalJson(attested.toolchain) !== canonicalJson(toolchain)) {
    throw new Error('Captured build attestation does not match the active Node/esbuild/TypeScript toolchain.');
  }
  const manifest = JSON.parse(result.find(item => item.filename === 'manifest.json').bytes.toString('utf8'));
  if (manifest.id !== CANONICAL_PLUGIN_ID || manifest.version !== '0.4.0') {
    throw new Error('Release manifest is not the canonical Ailu 0.4.0 identity.');
  }
  const newestSourceMtime = newestTreeMtime(path.join(repoRoot, 'src'));
  const bundleMtime = fs.statSync(path.join(repoRoot, 'main.js')).mtimeMs;
  if (bundleMtime < newestSourceMtime) {
    throw new Error('main.js is older than Ailu source files; run npm run build and verify:release first.');
  }
  const finalInputPaths = collectBuildInputPaths(repoRoot);
  const finalInputs = finalInputPaths.map(file => ({
    path: file,
    sha256: hashFile(path.join(repoRoot, file)),
  }));
  const finalToolchain = {
    node_executable_sha256: hashFile(process.execPath),
    esbuild_library_sha256: hashFile(path.join(repoRoot, 'node_modules/esbuild/lib/main.js')),
    esbuild_binary_sha256: hashFile(path.join(repoRoot, 'node_modules/esbuild/bin/esbuild')),
    typescript_cli_sha256: hashFile(path.join(repoRoot, 'node_modules/typescript/lib/tsc.js')),
  };
  if (JSON.stringify(finalInputs) !== JSON.stringify(capturedInputs)
    || canonicalJson(finalToolchain) !== canonicalJson(toolchain)) {
    throw new Error('Build inputs or toolchain changed while deployment artifacts were being captured.');
  }
  return result;
}

function collectBuildInputPaths(repoRoot) {
  return verifyPublicSourceTree(repoRoot).files;
}

function newestTreeMtime(root) {
  let newest = 0;
  const walk = current => {
    const state = fs.lstatSync(current);
    if (state.isSymbolicLink()) throw new Error('Source tree contains a symbolic link.');
    newest = Math.max(newest, state.mtimeMs);
    if (state.isDirectory()) {
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
    }
  };
  walk(root);
  return newest;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deploymentGenerationHash(receipt) {
  return hashBytes(Buffer.from(canonicalJson({
    schema_version: receipt.schema_version,
    product: receipt.product,
    vault: receipt.vault,
    backup_root: receipt.backup_root,
    community_before_sha256: receipt.community_before_sha256,
    community_after_sha256: receipt.community_after_sha256,
    artifact_sha256: receipt.artifact_sha256,
  })));
}

function ensureRollbackOutcomeMarker(receiptPath, receipt) {
  const outcomePath = `${receiptPath}.rollback-outcome`;
  const payload = Buffer.from(`${JSON.stringify({
    schema_version: RECEIPT_SCHEMA_VERSION,
    product: CANONICAL_PLUGIN_ID,
    state: 'rollback_pointer_observed',
    deployment_generation_sha256: deploymentGenerationHash(receipt),
    community_after_sha256: receipt.community_before_sha256,
    pointer_observed: true,
  }, null, 2)}\n`);
  const existing = readOptionalSafeFile(outcomePath);
  if (existing) {
    if (!existing.equals(payload)) throw new Error('Rollback outcome marker conflicts with this generation.');
    return;
  }
  writeExclusivePrivate(outcomePath, payload);
}

function recoverInterruptedDeploymentReceipt(plan, mode) {
  const backupParent = path.join(plan.vault, '.obsidian', 'ailu-deployment-backups');
  const parentState = safeLstat(backupParent);
  if (!parentState) return;
  assertSafeDirectory(backupParent, 'Ailu deployment backup directory');
  for (const entry of fs.readdirSync(backupParent).sort()) {
    const receiptPath = path.join(backupParent, entry, 'deploy-receipt.json');
    const state = safeLstat(receiptPath);
    if (!state) continue;
    const receipt = readJsonAuthority(receiptPath, 'deployment receipt').value;
    if (!isRecord(receipt) || receipt.product !== CANONICAL_PLUGIN_ID) {
      throw new Error(`Invalid deployment receipt blocks ${mode}: ${receiptPath}.`);
    }
    if (receipt.state === 'prepared') {
      const current = safeLstat(receipt.community_plugins_path)
        ? hashFile(receipt.community_plugins_path)
        : '';
      if (current === receipt.community_before_sha256) {
        throw new Error(`PREVIOUS_DEPLOY_PREPARED: run rollback-apply with ${receiptPath}.`);
      }
      throw new Error(`PREVIOUS_DEPLOY_UNKNOWN_GENERATION: manual recovery required for ${receiptPath}.`);
    }
    if (receipt.state === 'rolled_back_pre_pointer') continue;
    const outcomePath = receipt.state === 'rollback_committed_by_community_pointer'
      ? `${receiptPath}.rollback-outcome`
      : `${receiptPath}.deploy-outcome`;
    const outcome = readOptionalSafeFile(outcomePath);
    if (outcome) {
      const parsedOutcome = JSON.parse(outcome.toString('utf8'));
      if (!isRecord(parsedOutcome)
        || parsedOutcome.schema_version !== RECEIPT_SCHEMA_VERSION
        || parsedOutcome.product !== CANONICAL_PLUGIN_ID
        || parsedOutcome.deployment_generation_sha256 !== deploymentGenerationHash(receipt)
        || parsedOutcome.pointer_observed !== true) {
        throw new Error(`Invalid deployment outcome marker blocks ${mode}: ${outcomePath}.`);
      }
      if (receipt.state === 'committed_by_community_pointer'
        && parsedOutcome.state === 'deploy_pointer_observed') continue;
      if (receipt.state === 'rollback_committed_by_community_pointer'
        && parsedOutcome.state === 'rollback_pointer_observed') continue;
      throw new Error(`Deployment outcome marker has the wrong terminal state: ${outcomePath}.`);
    }
    if (receipt.state === 'rollback_committed_by_community_pointer') {
      const current = safeLstat(receipt.community_plugins_path)
        ? hashFile(receipt.community_plugins_path)
        : '';
      if (current === receipt.community_before_sha256) {
        throw new Error(`PREVIOUS_ROLLBACK_OUTCOME_UNRECORDED: resume rollback-apply with ${receiptPath}.`);
      }
      if (current === receipt.community_after_sha256) {
        throw new Error(`PREVIOUS_ROLLBACK_POINTER_NOT_COMMITTED: resume rollback-apply with ${receiptPath}.`);
      }
      // This marker means rollback was prepared but its pointer-last outcome
      // was not observed. A third generation is still ambiguous and blocks.
      throw new Error(`PREVIOUS_ROLLBACK_UNKNOWN_GENERATION: resume rollback-apply with ${receiptPath}.`);
    }
    if (receipt.state === 'committed_by_community_pointer') {
      const current = safeLstat(receipt.community_plugins_path)
        ? hashFile(receipt.community_plugins_path)
        : '';
      if (current === receipt.community_after_sha256) {
        throw new Error(`PREVIOUS_DEPLOY_OUTCOME_UNRECORDED: run recover-plan then recover-apply with ${receiptPath}.`);
      }
      if (current === receipt.community_before_sha256) {
        throw new Error(`PREVIOUS_DEPLOY_POINTER_NOT_COMMITTED: run rollback-apply with ${receiptPath}.`);
      }
      throw new Error(`PREVIOUS_DEPLOY_UNKNOWN_GENERATION: recover ${receiptPath} before continuing.`);
    }
  }
}

function buildPlan(vaultInput, artifacts, obsidianRunning) {
  const vault = realDirectory(vaultInput, 'Vault');
  if (vault !== path.resolve(vaultInput)) {
    throw new Error('Vault path must be canonical and must not traverse a symbolic link.');
  }
  const configDir = path.join(vault, '.obsidian');
  assertSafeDirectory(configDir, 'Vault .obsidian directory');
  const pluginsDir = path.join(configDir, 'plugins');
  if (!safeLstat(pluginsDir)) {
    throw new Error(
      'VAULT_COMMUNITY_PLUGINS_NOT_INITIALIZED: open this Vault in Obsidian, enable Community plugins, quit Obsidian, and retry.',
    );
  }
  assertSafeDirectory(pluginsDir, 'Vault plugin directory');
  const communityPath = path.join(configDir, 'community-plugins.json');
  if (!safeLstat(communityPath)) {
    throw new Error(
      'VAULT_COMMUNITY_PLUGINS_NOT_INITIALIZED: open this Vault in Obsidian, enable Community plugins, quit Obsidian, and retry.',
    );
  }
  const community = readJsonArrayAuthority(communityPath, 'community-plugins.json');
  const targetDir = path.join(pluginsDir, CANONICAL_PLUGIN_ID);
  const targetState = safeLstat(targetDir);
  if (targetState && (!targetState.isDirectory() || targetState.isSymbolicLink())) {
    throw new Error('Canonical Ailu plugin target is not a safe directory.');
  }
  const canonicalAuthority = {
    vault_files: captureCanonicalVaultBaseline(vault).files,
    home: captureCanonicalHomeBaseline(),
    plugin_data: captureOptionalFileBaseline(path.join(targetDir, 'data.json')),
  };
  return {
    vault,
    obsidian_running: obsidianRunning,
    current_enabled_sha256: hashBytes(Buffer.from(fs.readFileSync(communityPath))),
    canonical_already_enabled: community.value.includes(CANONICAL_PLUGIN_ID),
    target_exists: Boolean(targetState),
    artifact_sha256: Object.fromEntries(artifacts.map(item => [item.filename, item.sha256])),
    backup_policy: 'exclusive_unique_private_copy',
    switch_order: 'artifacts_then_receipt_then_community_plugins_last',
    rollback_retains_ailu_directory: true,
    canonical_authority_sha256: hashBytes(Buffer.from(canonicalJson(canonicalAuthority))),
    lock_order: [
      `${CANONICAL_VAULT_NAMESPACE}/conversation-writer.lock`,
      '~/.ailu/provider-writer.lock',
    ],
    lock_proof: 'performed_during_apply_without_waiting',
  };
}

async function applyPlan(plan, artifacts) {
  const locks = [];
  let backupRoot = '';
  try {
    locks.push(...await acquireDeploymentLocks(plan.vault));
    if (isObsidianRunning()) {
      throw new Error('DEPLOY_OBSIDIAN_RESTARTED: Obsidian appeared after planning; no enable switch was made.');
    }
    const configDir = path.join(plan.vault, '.obsidian');
    const pluginsDir = path.join(configDir, 'plugins');
    const targetDir = path.join(pluginsDir, CANONICAL_PLUGIN_ID);
    const communityPath = path.join(configDir, 'community-plugins.json');
    const community = readJsonArrayAuthority(communityPath, 'community-plugins.json');
    const lockedCanonicalVaultBaseline = captureCanonicalVaultBaseline(plan.vault);
    const lockedCanonicalHomeBaseline = captureCanonicalHomeBaseline();
    const lockedTargetState = safeLstat(targetDir);
    if (lockedTargetState && (!lockedTargetState.isDirectory() || lockedTargetState.isSymbolicLink())) {
      throw new Error('CANONICAL_AUTHORITY_CHANGED: Ailu plugin target became unsafe after planning.');
    }
    const lockedCanonicalPluginDataBaseline = captureOptionalFileBaseline(
      path.join(targetDir, 'data.json'),
    );
    const lockedCanonicalAuthoritySha256 = hashBytes(Buffer.from(canonicalJson({
      vault_files: lockedCanonicalVaultBaseline.files,
      home: lockedCanonicalHomeBaseline,
      plugin_data: lockedCanonicalPluginDataBaseline,
    })));
    if (lockedCanonicalAuthoritySha256 !== plan.canonical_authority_sha256) {
      throw new Error('CANONICAL_AUTHORITY_CHANGED: Ailu data or settings changed after planning.');
    }
    const receiptCanonicalVaultBaseline = captureCanonicalVaultBaseline(plan.vault);
    backupRoot = createBackupRoot(configDir);
    const backupRecords = [];
    backupRecords.push(copyAuthorityToBackup(plan.vault, communityPath, backupRoot));
    const targetBackup = safeLstat(targetDir)
      ? copyDirectoryToBackup(plan.vault, targetDir, backupRoot)
      : null;

    const preparedReceiptPath = path.join(backupRoot, 'deploy-receipt.json');
    const receiptBase = {
      schema_version: RECEIPT_SCHEMA_VERSION,
      product: CANONICAL_PLUGIN_ID,
      state: 'prepared',
      vault: plan.vault,
      backup_root: backupRoot,
      community_plugins_path: communityPath,
      community_before_sha256: hashBytes(Buffer.from(community.raw)),
      backup_records: backupRecords,
      target_backup: targetBackup,
      canonical_vault_baseline: receiptCanonicalVaultBaseline,
      canonical_home_baseline: lockedCanonicalHomeBaseline,
      canonical_plugin_data_baseline: lockedCanonicalPluginDataBaseline,
      artifact_sha256: Object.fromEntries(artifacts.map(item => [item.filename, item.sha256])),
    };
    writeExclusivePrivate(preparedReceiptPath, Buffer.from(`${JSON.stringify(receiptBase, null, 2)}\n`));

    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    assertSafeDirectory(targetDir, 'canonical Ailu target');
    fs.chmodSync(targetDir, 0o700);
    const artifactAfter = {};
    for (const artifact of artifacts) {
      const target = path.join(targetDir, artifact.filename);
      await helperCasBuffer(
        locks[locks.length - 2],
        target,
        readOptionalSafeFile(target),
        artifact.bytes,
      );
      fs.chmodSync(target, 0o600);
      const deployedHash = hashFile(target);
      if (deployedHash !== artifact.sha256) throw new Error(`Artifact verification failed: ${artifact.filename}.`);
      artifactAfter[artifact.filename] = deployedHash;
    }

    if (isObsidianRunning()) {
      throw new Error('DEPLOY_OBSIDIAN_RESTARTED: Obsidian appeared before the enable switch; current enablement remains unchanged.');
    }
    assertCanonicalBaselinesUnchanged(receiptBase, 'DEPLOY');
    for (const artifact of artifacts) {
      if (hashFile(path.join(targetDir, artifact.filename)) !== artifact.sha256) {
        throw new Error(`DEPLOY_ARTIFACT_CHANGED: ${artifact.filename} changed before the enable switch.`);
      }
    }
    const currentCommunity = readJsonArrayAuthority(communityPath, 'community-plugins.json');
    if (currentCommunity.raw !== community.raw) {
      throw new Error('community-plugins.json changed after backup; Ailu was not enabled.');
    }
    const enabled = currentCommunity.value.filter(id => id !== CANONICAL_PLUGIN_ID);
    enabled.push(CANONICAL_PLUGIN_ID);
    const communityReplacement = Buffer.from(`${JSON.stringify(enabled, null, 2)}\n`);
    const pointerCommittedReceipt = {
      ...receiptBase,
      state: 'committed_by_community_pointer',
      artifact_after_sha256: artifactAfter,
      community_after_sha256: hashBytes(communityReplacement),
      community_switched_last: true,
      canonical_id_enabled: enabled.includes(CANONICAL_PLUGIN_ID),
    };
    await helperCasBuffer(
      locks[locks.length - 2],
      preparedReceiptPath,
      Buffer.from(`${JSON.stringify(receiptBase, null, 2)}\n`),
      Buffer.from(`${JSON.stringify(pointerCommittedReceipt, null, 2)}\n`),
    );
    // This is deliberately the final durable file mutation. The prewritten
    // receipt is committed iff this exact pointer hash is installed, so a
    // crash needs no ambiguous post-pointer receipt update.
    await helperCasBuffer(locks[locks.length - 2], communityPath, currentCommunity.bytes, communityReplacement);
    const communityAfterSha256 = hashFile(communityPath);
    if (communityAfterSha256 !== pointerCommittedReceipt.community_after_sha256) {
      throw new Error('The final community plugin switch failed hash verification.');
    }
    const outcomePath = `${preparedReceiptPath}.deploy-outcome`;
    writeExclusivePrivate(outcomePath, Buffer.from(`${JSON.stringify({
      schema_version: RECEIPT_SCHEMA_VERSION,
      product: CANONICAL_PLUGIN_ID,
      state: 'deploy_pointer_observed',
      deployment_generation_sha256: deploymentGenerationHash(pointerCommittedReceipt),
      community_after_sha256: communityAfterSha256,
      pointer_observed: true,
    }, null, 2)}\n`));
    return {
      vault: plan.vault,
      status: 'committed',
      receipt: preparedReceiptPath,
      community_switched_last: true,
    };
  } catch (error) {
    throw new Error(
      `DEPLOY_FAILED${backupRoot ? ` (private evidence retained at ${backupRoot})` : ''}: ${errorMessage(error)}`,
    );
  } finally {
    await releaseLocksReverse(locks);
  }
}

async function runRollback(args) {
  const receipt = readJsonAuthority(args.receipt, 'deployment receipt');
  const record = receipt.value;
  if (!isRecord(record)
    || record.schema_version !== RECEIPT_SCHEMA_VERSION
    || record.product !== CANONICAL_PLUGIN_ID
    || ![
      'prepared',
      'committed_by_community_pointer',
      'rollback_committed_by_community_pointer',
    ].includes(record.state)
    || typeof record.vault !== 'string'
    || typeof record.backup_root !== 'string'
    || !Array.isArray(record.backup_records)
    || typeof record.community_before_sha256 !== 'string'
    || (record.state !== 'prepared'
      && typeof record.community_after_sha256 !== 'string')) {
    throw new Error('Rollback receipt is invalid or is not a verified Ailu deployment.');
  }
  if (path.resolve(args.receipt) !== path.join(path.resolve(record.backup_root), 'deploy-receipt.json')) {
    throw new Error('Rollback receipt is outside its declared backup root.');
  }
  const plan = {
    schema_version: RECEIPT_SCHEMA_VERSION,
    mode: args.mode,
    vault: record.vault,
    receipt: args.receipt,
    obsidian_running: isObsidianRunning(),
    community_expected_sha256: record.community_after_sha256 ?? record.community_before_sha256,
    restores_backups_without_deleting_ailu: true,
  };
  if (args.mode === 'rollback-plan') {
    emit(plan);
    return;
  }
  if (plan.obsidian_running) throw new Error('ROLLBACK_OBSIDIAN_RUNNING: quit every Obsidian process.');
  const locks = await acquireDeploymentLocks(realDirectory(record.vault, 'Vault'));
  try {
    if (isObsidianRunning()) throw new Error('ROLLBACK_OBSIDIAN_RESTARTED: no backup was restored.');
    const currentCommunityHash = hashFile(record.community_plugins_path);
    if (record.state === 'rollback_committed_by_community_pointer'
      && currentCommunityHash === record.community_before_sha256) {
      ensureRollbackOutcomeMarker(args.receipt, record);
      emit({
        ...plan,
        status: 'rolled_back',
        community_restored_last: true,
        ailu_directory_retained: true,
      });
      return;
    }
    if (record.state === 'prepared'
      || (record.state === 'committed_by_community_pointer'
        && currentCommunityHash === record.community_before_sha256)) {
      if (currentCommunityHash !== record.community_before_sha256) {
        throw new Error('Prepared deployment enablement pointer changed; rollback stopped.');
      }
      await restorePriorTargetArtifacts(record, { allowPrepared: true }, locks[locks.length - 2]);
      const terminal = { ...record, state: 'rolled_back_pre_pointer' };
      await helperCasBuffer(
        locks[locks.length - 2],
        args.receipt,
        receipt.bytes,
        Buffer.from(`${JSON.stringify(terminal, null, 2)}\n`),
      );
      emit({
        ...plan,
        status: 'rolled_back_pre_pointer',
        community_unchanged: true,
        ailu_directory_retained: true,
      });
      return;
    }
    if (currentCommunityHash !== record.community_after_sha256) {
      throw new Error('community-plugins.json has an unknown generation; rollback stopped before restoring any file.');
    }
    assertCanonicalBaselinesUnchanged(record);
    const communityRecord = record.backup_records.find(item => item.relative_path === '.obsidian/community-plugins.json');
    if (!communityRecord) throw new Error('Rollback receipt has no community-plugins backup.');
    await restorePriorTargetArtifacts(
      record,
      { allowCurrentBackup: true },
      locks[locks.length - 2],
    );
    if (hashFile(record.community_plugins_path) !== record.community_after_sha256) {
      throw new Error('community-plugins.json no longer matches the deployed generation; rollback stopped.');
    }
    const rollbackPointerReceipt = {
      ...record,
      state: 'rollback_committed_by_community_pointer',
    };
    if (record.state !== 'rollback_committed_by_community_pointer') {
      await helperCasBuffer(
        locks[locks.length - 2],
        args.receipt,
        receipt.bytes,
        Buffer.from(`${JSON.stringify(rollbackPointerReceipt, null, 2)}\n`),
      );
    }
    const rollbackReceipt = path.join(record.backup_root, `rollback-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
    writeExclusivePrivate(rollbackReceipt, Buffer.from(`${JSON.stringify({
      schema_version: RECEIPT_SCHEMA_VERSION,
      state: 'committed_by_community_pointer',
      deployment_receipt_sha256: hashFile(args.receipt),
      community_restored_last: true,
      ailu_directory_retained: true,
    }, null, 2)}\n`));
    // As in apply, the enablement pointer is the last durable mutation.
    await restoreBackupRecordWithHelper(record, communityRecord, locks[locks.length - 2]);
    ensureRollbackOutcomeMarker(args.receipt, rollbackPointerReceipt);
    emit({ ...plan, status: 'rolled_back', rollback_receipt: rollbackReceipt, community_restored_last: true });
  } finally {
    await releaseLocksReverse(locks);
  }
}

async function restoreBackupRecordWithHelper(receipt, item, lock) {
  if (!isRecord(item)
    || typeof item.relative_path !== 'string'
    || typeof item.backup_path !== 'string'
    || typeof item.sha256 !== 'string') {
    throw new Error('Rollback backup record is invalid.');
  }
  const vault = path.resolve(receipt.vault);
  const target = path.resolve(vault, item.relative_path);
  if (!target.startsWith(`${vault}${path.sep}`)) throw new Error('Rollback target escapes its Vault.');
  const backupRoot = path.resolve(receipt.backup_root);
  const source = path.resolve(item.backup_path);
  if (!source.startsWith(`${backupRoot}${path.sep}`) || hashFile(source) !== item.sha256) {
    throw new Error('Rollback backup changed or escaped its backup root.');
  }
  await helperCasBuffer(lock, target, readOptionalSafeFile(target), fs.readFileSync(source));
}

async function restorePriorTargetArtifacts(receipt, options = {}, lock) {
  if (!receipt.target_backup) return;
  const backupRoot = path.resolve(receipt.backup_root);
  const backupDir = path.resolve(receipt.target_backup.backup_path);
  if (!backupDir.startsWith(`${backupRoot}${path.sep}`)) throw new Error('Target backup escaped its root.');
  if (hashDirectoryTree(backupDir) !== receipt.target_backup.tree_sha256) {
    throw new Error('Target backup tree changed after deployment.');
  }
  const targetDir = path.join(receipt.vault, '.obsidian', 'plugins', CANONICAL_PLUGIN_ID);
  for (const artifact of ARTIFACTS) {
    const source = path.join(backupDir, artifact);
    const sourceState = safeLstat(source);
    if (!sourceState) continue;
    if (!sourceState.isFile() || sourceState.isSymbolicLink()) throw new Error('Target backup contains an unsafe artifact.');
    const expectedHash = receipt.artifact_after_sha256?.[artifact];
    const currentPath = path.join(targetDir, artifact);
    const currentBytes = readOptionalSafeFile(currentPath);
    const currentHash = currentBytes ? hashBytes(currentBytes) : '';
    const plannedHash = receipt.artifact_sha256?.[artifact];
    const backupHash = hashFile(source);
    const allowed = options.allowPrepared
      ? new Set([expectedHash, plannedHash, backupHash].filter(value => typeof value === 'string'))
      : new Set([
        expectedHash,
        ...(options.allowCurrentBackup ? [backupHash] : []),
      ].filter(value => typeof value === 'string'));
    if (!allowed.has(currentHash)) {
      throw new Error(`Canonical ${artifact} changed after deployment; rollback stopped.`);
    }
    await helperCasBuffer(lock, currentPath, currentBytes, fs.readFileSync(source));
  }
}

function captureCanonicalVaultBaseline(vault) {
  return captureAuthorityTree(path.join(vault, CANONICAL_VAULT_NAMESPACE), relative => (
    relative !== 'conversation-writer.lock'
  ));
}

function captureCanonicalHomeBaseline() {
  const home = canonicalHome();
  const files = [
    'providers.json',
    'provider-transaction.json',
    'identity-home-v1.json',
    'lark/authorization.json',
  ];
  return files.map(relative => ({
    relative_path: relative,
    ...captureOptionalFileBaseline(path.join(home, relative)),
  }));
}

function captureOptionalFileBaseline(file) {
  const state = safeLstat(file);
  if (!state) return { status: 'absent' };
  if (!state.isFile() || state.isSymbolicLink()) {
    throw new Error(`Baseline authority is unsafe: ${file}.`);
  }
  return { status: 'file', sha256: hashFile(file) };
}

function captureAuthorityTree(root, include) {
  const rootState = safeLstat(root);
  if (!rootState) return { status: 'absent', files: [] };
  assertSafeDirectory(root, 'canonical authority root');
  const files = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current).sort()) {
      const full = path.join(current, entry);
      const state = fs.lstatSync(full);
      if (state.isSymbolicLink()) throw new Error('Canonical baseline refuses symbolic links.');
      const relative = path.relative(root, full);
      if (state.isDirectory()) walk(full);
      else if (state.isFile() && include(relative)) files.push({ relative_path: relative, sha256: hashFile(full) });
      else if (!state.isFile()) throw new Error('Canonical baseline refuses special files.');
    }
  };
  walk(root);
  return { status: 'directory', files };
}

function assertCanonicalBaselinesUnchanged(receipt, phase = 'ROLLBACK') {
  if (canonicalJson(captureCanonicalVaultBaseline(receipt.vault))
    !== canonicalJson(receipt.canonical_vault_baseline)) {
    throw new Error(
      `${phase}_CANONICAL_DATA_CHANGED: Ailu Vault data changed after the baseline was captured.`,
    );
  }
  if (canonicalJson(captureCanonicalHomeBaseline())
    !== canonicalJson(receipt.canonical_home_baseline)) {
    throw new Error(
      `${phase}_CANONICAL_HOME_CHANGED: Ailu Home data changed after the baseline was captured.`,
    );
  }
  const dataPath = path.join(receipt.vault, '.obsidian', 'plugins', CANONICAL_PLUGIN_ID, 'data.json');
  if (canonicalJson(captureOptionalFileBaseline(dataPath))
    !== canonicalJson(receipt.canonical_plugin_data_baseline)) {
    throw new Error(
      `${phase}_CANONICAL_SETTINGS_CHANGED: Ailu plugin settings changed after the baseline was captured.`,
    );
  }
}

async function acquireDeploymentLocks(vault) {
  const locks = [];
  try {
    const directory = path.join(vault, CANONICAL_VAULT_NAMESPACE);
    ensurePrivateRealDirectory(directory);
    locks.push(await acquireLock(vault, path.join(directory, 'conversation-writer.lock')));
    const home = canonicalHome();
    ensurePrivateRealDirectory(home);
    locks.push(await acquireLock(home, path.join(home, 'provider-writer.lock')));
    return locks;
  } catch (error) {
    await releaseLocksReverse(locks);
    throw error;
  }
}

function acquireLock(root, lockPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-u', '-c', LOCK_HELPER, root, lockPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Writer lock helper did not become ready.')), 5_000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill('SIGTERM');
        reject(error);
      } else resolve(result);
    };
    child.stdout.on('data', chunk => {
      output += String(chunk);
      for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value.type === 'READY') {
            finish(null, { child, lockPath, root, output: '', pendingCas: null });
            return;
          }
          if (value.type === 'BUSY') {
            finish(new Error('DEPLOY_WRITER_BUSY: an Ailu writer lock is already held.'));
            return;
          }
        } catch {
          // Wait for a complete helper line.
        }
      }
    });
    child.stderr.on('data', chunk => { errors = `${errors}${String(chunk)}`.slice(-1_024); });
    child.once('error', error => finish(error));
    child.once('exit', code => {
      if (!settled) finish(new Error(`Writer lock helper exited (${code}): ${errors.trim()}`));
    });
  });
}

function helperCasBuffer(lock, target, expected, replacement) {
  if (lock.pendingCas) throw new Error('Deployment lock helper already has a pending CAS request.');
  return new Promise((resolve, reject) => {
    const targetPath = path.resolve(target);
    const root = path.resolve(lock.root);
    if (!targetPath.startsWith(`${root}${path.sep}`)) {
      reject(new Error('Deployment CAS target escapes its fenced authority.'));
      return;
    }
    let settled = false;
    let output = '';
    const timeout = setTimeout(() => finish(new Error('Deployment CAS helper timed out.')), 5_000);
    const onData = chunk => {
      output += String(chunk);
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          finish(new Error('Deployment CAS helper returned invalid JSON.'));
          return;
        }
        if (value.type === 'CAS') {
          if (value.swapped === true) finish(null);
          else finish(new Error('CAS_CONFLICT: target changed; no replacement was installed.'));
          return;
        }
        if (value.type === 'ERROR') {
          finish(new Error(`Deployment CAS helper failed: ${String(value.error ?? '')}`));
          return;
        }
      }
    };
    const onExit = () => finish(new Error('Deployment CAS helper exited during CAS.'));
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lock.child.stdout.off('data', onData);
      lock.child.off('exit', onExit);
      lock.pendingCas = null;
      if (error) reject(error);
      else resolve();
    };
    lock.pendingCas = { target: targetPath };
    lock.child.stdout.on('data', onData);
    lock.child.once('exit', onExit);
    lock.child.stdin.write(`${JSON.stringify({
      op: 'cas',
      target: targetPath,
      expected: expected === null ? null : expected.toString('base64'),
      replacement: replacement.toString('base64'),
    })}\n`);
  });
}

async function releaseLocksReverse(locks) {
  for (const lock of [...locks].reverse()) {
    if (lock.child.exitCode !== null) continue;
    lock.child.stdin.end('release\n');
    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        lock.child.kill('SIGTERM');
        resolve();
      }, 1_500);
      lock.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

function createBackupRoot(configDir) {
  const parent = path.join(configDir, 'ailu-deployment-backups');
  ensurePrivateRealDirectory(parent);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
    const candidate = path.join(parent, id);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
    }
  }
  throw new Error('Could not allocate a unique Ailu backup directory.');
}

function copyAuthorityToBackup(vault, source, backupRoot) {
  const sourceState = safeLstat(source);
  if (!sourceState?.isFile() || sourceState.isSymbolicLink()) {
    throw new Error('Backup source is missing or unsafe.');
  }
  const relative = path.relative(vault, source);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Backup source escaped its Vault.');
  }
  const target = path.join(backupRoot, 'files', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  hardenParents(backupRoot, path.dirname(target));
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  if (hashFile(source) !== hashFile(target)) throw new Error('Backup hash verification failed.');
  return { relative_path: relative, backup_path: target, sha256: hashFile(target) };
}

function copyDirectoryToBackup(vault, source, backupRoot) {
  const relative = path.relative(vault, source);
  const target = path.join(backupRoot, 'directories', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  hardenParents(backupRoot, path.dirname(target));
  copyDirectoryExclusive(source, target);
  return { relative_path: relative, backup_path: target, tree_sha256: hashDirectoryTree(target) };
}

function copyDirectoryExclusive(source, target) {
  const state = fs.lstatSync(source);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Backup directory source is unsafe.');
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  for (const entry of fs.readdirSync(source).sort()) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    const entryState = fs.lstatSync(from);
    if (entryState.isSymbolicLink()) throw new Error('Backup source contains a symbolic link.');
    if (entryState.isDirectory()) copyDirectoryExclusive(from, to);
    else if (entryState.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
      if (hashFile(from) !== hashFile(to)) throw new Error('Target backup hash verification failed.');
    } else throw new Error('Backup source contains an unsupported file type.');
  }
}

function inspectPrivateTree(root, current, visit) {
  const state = fs.lstatSync(current);
  if (state.isSymbolicLink()) throw new Error('Private tree inspection refuses symbolic links.');
  const relative = path.relative(root, current) || '.';
  if (state.isDirectory()) {
    visit(relative, state, current);
    for (const entry of fs.readdirSync(current).sort()) inspectPrivateTree(root, path.join(current, entry), visit);
  } else if (state.isFile()) visit(relative, state, current);
  else throw new Error('Private tree inspection refuses special files.');
}

function readOptionalSafeFile(file) {
  const state = safeLstat(file);
  if (!state) return null;
  if (!state.isFile() || state.isSymbolicLink()) throw new Error('Authority path is not a safe regular file.');
  return fs.readFileSync(file);
}

function readJsonAuthority(file, label) {
  const bytes = readOptionalSafeFile(file);
  if (!bytes) throw new Error(`${label} is missing.`);
  try {
    return { bytes, raw: bytes.toString('utf8'), value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error(`${label} is invalid JSON.`);
  }
}

function readJsonArrayAuthority(file, label) {
  const authority = readJsonAuthority(file, label);
  if (!Array.isArray(authority.value)
    || authority.value.some(value => typeof value !== 'string')) {
    throw new Error(`${label} must be a JSON string array.`);
  }
  return authority;
}

function ensurePrivateRealDirectory(directory) {
  const resolved = path.resolve(directory);
  const missing = [];
  let cursor = resolved;
  while (!safeLstat(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('Private authority directory has no safe existing ancestor.');
    cursor = parent;
  }
  assertSafeDirectory(cursor, 'private authority ancestor');
  for (const candidate of missing.reverse()) {
    fs.mkdirSync(candidate, { mode: 0o700 });
    assertSafeDirectory(candidate, 'private authority directory');
  }
  assertSafeDirectory(resolved, 'private authority directory');
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error('Private authority directory traverses a symbolic link.');
  }
  fs.chmodSync(resolved, 0o700);
}

function assertSafeDirectory(directory, label) {
  const state = safeLstat(directory);
  if (!state?.isDirectory() || state.isSymbolicLink()) throw new Error(`${label} is missing or unsafe.`);
  if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error(`${label} traverses a symbolic link.`);
}

function realDirectory(directory, label) {
  const resolved = path.resolve(directory);
  assertSafeDirectory(resolved, label);
  return fs.realpathSync(resolved);
}

function hardenParents(root, directory) {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(directory);
  const relative = path.relative(resolvedRoot, current);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Private path escaped its root.');
  while (current === resolvedRoot || current.startsWith(`${resolvedRoot}${path.sep}`)) {
    assertSafeDirectory(current, 'private backup directory');
    fs.chmodSync(current, 0o700);
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
}

function writeExclusivePrivate(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const stage = `${file}.complete-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(stage, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.linkSync(stage, file);
  fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file));
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function hashDirectoryTree(root) {
  const digest = crypto.createHash('sha256');
  inspectPrivateTree(root, root, (relative, state, itemPath) => {
    digest.update(state.isDirectory() ? `d\0${relative}\0` : `f\0${relative}\0${hashFile(itemPath)}\0`);
  });
  return digest.digest('hex');
}

function hashFile(file) {
  return hashBytes(fs.readFileSync(file));
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalHome() {
  const configured = process.env.AILU_HOME?.trim();
  const userHome = process.env.HOME?.trim();
  const candidate = configured || (userHome ? path.join(userHome, '.ailu') : '');
  if (!candidate || !path.isAbsolute(candidate)) {
    throw new Error('AILU_HOME (or HOME) must resolve to an absolute path.');
  }
  return path.resolve(candidate);
}

function isObsidianRunning() {
  const exact = spawnSync('/usr/bin/pgrep', ['-x', 'Obsidian'], { encoding: 'utf8' });
  if (exact.status === 0 && exact.stdout.trim()) return true;
  const appPath = spawnSync('/usr/bin/pgrep', ['-f', '/Obsidian.app/Contents/MacOS/Obsidian'], { encoding: 'utf8' });
  return appPath.status === 0 && Boolean(appPath.stdout.trim());
}

function safeLstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (isCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function isCode(error, code) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
