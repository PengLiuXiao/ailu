import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { verifyPublicSourceTree } from './public-source-policy.mjs';

const root = process.cwd();
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function collectInputs(files) {
  return files.map(file => ({
    path: file,
    sha256: sha256(fs.readFileSync(path.join(root, file))),
  }));
}

function toolchainSnapshot() {
  return {
    node_executable_sha256: sha256(fs.readFileSync(process.execPath)),
    esbuild_library_sha256: sha256(fs.readFileSync(path.join(root, 'node_modules/esbuild/lib/main.js'))),
    esbuild_binary_sha256: sha256(fs.readFileSync(path.join(root, 'node_modules/esbuild/bin/esbuild'))),
    typescript_cli_sha256: sha256(fs.readFileSync(path.join(root, 'node_modules/typescript/lib/tsc.js'))),
  };
}

function run(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed; no build attestation was written.`);
}

const publicSourceTree = verifyPublicSourceTree(root);
const before = {
  inputs: collectInputs(publicSourceTree.files),
  toolchain: toolchainSnapshot(),
};
run(['node_modules/typescript/lib/tsc.js', '--noEmit'], 'TypeScript validation');
run(['esbuild.config.mjs', 'production'], 'Production bundle');
const afterSourceTree = verifyPublicSourceTree(root);
const after = {
  inputs: collectInputs(afterSourceTree.files),
  toolchain: toolchainSnapshot(),
};
if (JSON.stringify(after) !== JSON.stringify(before)) {
  throw new Error('Build inputs or toolchain changed during typecheck/bundle generation.');
}

const artifacts = {};
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  artifacts[file] = sha256(fs.readFileSync(path.join(root, file)));
}
const attestation = {
  schema_version: 1,
  product: 'ailu',
  version: '0.3.2',
  build: {
    command: 'node scripts/build-release.mjs',
    typecheck: 'node node_modules/typescript/lib/tsc.js --noEmit',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  toolchain: before.toolchain,
  inputs: before.inputs,
  artifacts,
};
fs.writeFileSync(
  path.join(root, 'build-attestation.json'),
  `${JSON.stringify(attestation, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o600 },
);
