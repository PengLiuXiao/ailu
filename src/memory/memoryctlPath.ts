import { homedir } from 'node:os';
import { join } from 'node:path';

export function defaultMemoryctlPath(home = homedir()): string {
  return join(home, '.config', 'agent-memory', 'scripts', 'memoryctl');
}
