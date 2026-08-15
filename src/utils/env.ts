import os from 'os';
import path from 'path';

/** Builds the inherited runtime environment without accepting persisted plaintext overrides. */
export function runtimeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    PATH: executableSearchPath(base.PATH),
  };
}

/**
 * GUI apps on macOS inherit a minimal PATH and cannot launch npm CLI shims
 * whose shebang uses `env node`. Keep the inherited/user-configured entries
 * first, then add the common per-user and package-manager executable folders.
 */
export function executableSearchPath(currentPath = ''): string {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
      currentPath,
      path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'),
    ]
    : [
      currentPath,
      path.join(home, '.local', 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.volta', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  return [...new Set(
    candidates.flatMap(value => value.split(path.delimiter)).filter(Boolean),
  )].join(path.delimiter);
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '********';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
