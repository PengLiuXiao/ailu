import os from 'os';
import path from 'path';

import { STORAGE_IDS } from './ids';
import type { AgentId } from './types';

export function ailuHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[STORAGE_IDS.homeEnvironmentVariable]?.trim();
  return configured
    ? expandHome(configured)
    : path.join(os.homedir(), STORAGE_IDS.homeDirectoryName);
}

export function runtimeManagedDir(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'runtimes', agentId);
}

export function runtimeInstallRecordPath(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeManagedDir(agentId, env), 'install.json');
}

export function managedBinaryPath(agentId: AgentId, binaryName: string, env: NodeJS.ProcessEnv = process.env): string {
  const binary = process.platform === 'win32' ? `${binaryName}.cmd` : binaryName;
  return path.join(runtimeManagedDir(agentId, env), 'node_modules', '.bin', binary);
}

export function larkCliAuthorizationRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'lark', 'authorization.json');
}

export function providersPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'providers.json');
}

export function xCookiesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'secrets', 'x', 'cookies.json');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'logs');
}

export function tmpDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(ailuHome(env), 'tmp');
}

export function vaultAiluDir(vaultBasePath: string): string {
  return path.join(vaultBasePath, STORAGE_IDS.vaultDirectoryName);
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
