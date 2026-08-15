import fs from 'fs';
import os from 'os';
import path from 'path';

/** Builds the inherited runtime environment without accepting persisted plaintext overrides. */
export function runtimeEnvironment(
  base: NodeJS.ProcessEnv,
  executablePath = '',
): NodeJS.ProcessEnv {
  const home = base.HOME?.trim() || os.homedir();
  const inherited = executableSearchPath(base.PATH, home);
  const binaryDirectory = executablePath.trim() && path.isAbsolute(executablePath.trim())
    ? path.dirname(executablePath.trim())
    : '';
  return {
    ...base,
    PATH: uniquePath([binaryDirectory, inherited]),
  };
}

type DirectoryNamesReader = (directoryPath: string) => readonly string[];

function readDirectoryNames(directoryPath: string): string[] {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

/** Standard nvm installs keep each Node toolchain under versions/node/<version>/bin. */
export function nvmVersionBinPaths(
  home = os.homedir(),
  readNames: DirectoryNamesReader = readDirectoryNames,
): string[] {
  const versionsRoot = path.join(home, '.nvm', 'versions', 'node');
  return [...readNames(versionsRoot)]
    .filter(name => /^v?\d+(?:\.\d+){0,2}$/.test(name))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map(name => path.join(versionsRoot, name, 'bin'));
}

/**
 * GUI apps on macOS inherit a minimal PATH and cannot launch npm CLI shims
 * whose shebang uses `env node`. Keep the inherited/user-configured entries
 * first, then add the common per-user and package-manager executable folders.
 */
export function executableSearchPath(currentPath = '', home = os.homedir()): string {
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
      ...nvmVersionBinPaths(home),
      path.join(home, '.nvm', 'current', 'bin'),
      path.join(home, '.fnm', 'current', 'bin'),
      path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      path.join(home, '.asdf', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.mise', 'shims'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];
  return uniquePath(candidates);
}

function uniquePath(values: readonly string[]): string {
  return [...new Set(
    values.flatMap(value => value.split(path.delimiter)).filter(Boolean),
  )].join(path.delimiter);
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '********';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
