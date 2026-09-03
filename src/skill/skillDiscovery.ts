import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';

import type { AgentId } from '../types';
import { parseSkillFrontmatter } from './skillParser';

export type LocalSkillSource = 'shared' | 'claude' | 'codex' | 'codex-plugin' | 'pi';
type SupportedSkillAgentId = 'claude' | 'codex' | 'pi';

export interface LocalSkill {
  name: string;
  description: string;
  directory: string;
  filePath: string;
  source: LocalSkillSource;
  sourceLabel: string;
  agentId: AgentId;
}

interface SkillRoot {
  directory: string;
  source: LocalSkillSource;
  sourceLabel: string;
  priority: number;
  allowSystemDirectory?: boolean;
  pluginCache?: boolean;
}

interface SkillCandidate extends LocalSkill {
  priority: number;
  modifiedAt: number;
}

export interface SkillDiscoveryOptions {
  homeDirectory?: string;
  useCache?: boolean;
}

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_DEPTH = 12;
const MAX_SCANNED_DIRECTORIES = 4_096;
const CACHE_TTL_MS = 30_000;

const skillCache = new Map<AgentId, { skills: LocalSkill[]; loadedAt: number }>();

export function getSkillDirectories(agentId: AgentId, home = homedir()): string[] {
  return getSkillRoots(agentId, home).map(root => root.directory);
}

export async function loadLocalSkills(
  agentId: AgentId,
  options: SkillDiscoveryOptions = {},
): Promise<LocalSkill[]> {
  const home = options.homeDirectory ?? homedir();
  const useCache = options.useCache ?? options.homeDirectory === undefined;
  const cached = useCache ? skillCache.get(agentId) : undefined;
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.skills;
  }

  const roots = getSkillRoots(agentId, home);
  const scanned = await Promise.all(roots.map(root => scanSkillRoot(root, agentId)));
  const selected = new Map<string, SkillCandidate>();
  for (const candidate of scanned.flat()) {
    const key = candidate.name.toLocaleLowerCase();
    const existing = selected.get(key);
    if (
      !existing
      || candidate.priority < existing.priority
      || (candidate.priority === existing.priority && candidate.modifiedAt > existing.modifiedAt)
    ) {
      selected.set(key, candidate);
    }
  }

  const skills = [...selected.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ priority: _priority, modifiedAt: _modifiedAt, ...skill }) => skill);
  if (useCache) skillCache.set(agentId, { skills, loadedAt: Date.now() });
  return skills;
}

export function invalidateSkillCache(agentId?: AgentId): void {
  if (agentId) {
    skillCache.delete(agentId);
  } else {
    skillCache.clear();
  }
}

function getSkillRoots(agentId: AgentId, home: string): SkillRoot[] {
  if (!isSupportedSkillAgentId(agentId)) return [];
  const nativeRoots: Record<SupportedSkillAgentId, SkillRoot> = {
    claude: {
      directory: join(home, '.claude', 'skills'),
      source: 'claude',
      sourceLabel: 'Claude Code',
      priority: 0,
    },
    codex: {
      directory: join(home, '.codex', 'skills'),
      source: 'codex',
      sourceLabel: 'Codex',
      priority: 0,
      allowSystemDirectory: true,
    },
    pi: {
      directory: join(home, '.pi', 'agent', 'skills'),
      source: 'pi',
      sourceLabel: 'Pi',
      priority: 0,
    },
  };
  const shared: SkillRoot = {
    directory: join(home, '.agents', 'skills'),
    source: 'shared',
    sourceLabel: '共享',
    priority: 1,
  };
  if (agentId === 'pi') {
    // Pi Skills stay visually and functionally distinct: only the Pi native
    // root and the agent-neutral shared root are discovered for Pi.
    return [nativeRoots.pi, shared];
  }
  const fallbackOrder: SupportedSkillAgentId[] = ['codex', 'claude'];
  const fallbacks = fallbackOrder
    .filter(id => id !== agentId)
    .map((id, index) => ({ ...nativeRoots[id], priority: 2 + index }));
  const pluginCache: SkillRoot = {
    directory: join(home, '.codex', 'plugins', 'cache'),
    source: 'codex-plugin',
    sourceLabel: 'Codex 插件',
    priority: 10,
    pluginCache: true,
  };
  return [nativeRoots[agentId], shared, ...fallbacks, pluginCache];
}

function isSupportedSkillAgentId(agentId: AgentId): agentId is SupportedSkillAgentId {
  return agentId === 'claude' || agentId === 'codex' || agentId === 'pi';
}

async function scanSkillRoot(root: SkillRoot, agentId: AgentId): Promise<SkillCandidate[]> {
  const skills: SkillCandidate[] = [];
  const seenDirectories = new Set<string>();
  const queue: Array<{ directory: string; depth: number; symlinkOnly?: boolean }> = [{
    directory: root.directory,
    depth: 0,
  }];

  while (queue.length > 0 && seenDirectories.size < MAX_SCANNED_DIRECTORIES) {
    const current = queue.shift();
    if (!current || current.depth > MAX_SCAN_DEPTH) continue;
    let resolvedDirectory: string;
    try {
      resolvedDirectory = await realpath(current.directory);
    } catch {
      continue;
    }
    if (seenDirectories.has(resolvedDirectory)) continue;
    seenDirectories.add(resolvedDirectory);

    const candidate = await readSkillDirectory(current.directory, root, agentId);
    if (candidate) {
      skills.push(candidate);
      continue;
    }
    if (current.symlinkOnly) continue;

    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldSkipDirectory(entry.name, root)) continue;
      const child = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        queue.push({ directory: child, depth: current.depth + 1 });
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(child)).isDirectory()) {
            // Installed Skills are commonly linked into another Agent's root.
            // A linked directory is treated as one Skill root and is never
            // recursively expanded, preventing a broad or cyclic traversal.
            queue.push({ directory: child, depth: current.depth + 1, symlinkOnly: true });
          }
        } catch {
          // Ignore broken links.
        }
      }
    }
  }
  return skills;
}

async function readSkillDirectory(
  directory: string,
  root: SkillRoot,
  agentId: AgentId,
): Promise<SkillCandidate | null> {
  const filePath = join(directory, SKILL_FILE);
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_SKILL_FILE_BYTES) return null;
    const text = await readFile(filePath, 'utf-8');
    const parsed = parseSkillFrontmatter(text, basename(directory));
    if (!parsed) return null;
    const parsedName = normalizeSkillName(parsed.name, basename(directory));
    const pluginNamespace = root.pluginCache ? pluginNamespaceFor(filePath, root.directory) : '';
    const name = pluginNamespace && !parsedName.includes(':')
      ? `${pluginNamespace}:${parsedName}`
      : parsedName;
    return {
      name,
      description: parsed.description.trim().slice(0, 2_000),
      directory,
      filePath,
      source: root.source,
      sourceLabel: pluginNamespace ? `${root.sourceLabel} · ${pluginNamespace}` : root.sourceLabel,
      agentId,
      priority: root.priority,
      modifiedAt: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

function shouldSkipDirectory(name: string, root: SkillRoot): boolean {
  if (name === '.system' && root.allowSystemDirectory) return false;
  return name.startsWith('.')
    || name.startsWith('_')
    || name === 'node_modules'
    || name === 'archive';
}

function pluginNamespaceFor(filePath: string, pluginCacheDirectory: string): string {
  const parts = relative(pluginCacheDirectory, filePath).split(sep);
  const skillsIndex = parts.lastIndexOf('skills');
  if (skillsIndex < 2) return '';
  return normalizeSkillName(parts[skillsIndex - 2] ?? '', 'plugin');
}

function normalizeSkillName(value: string, fallback: string): string {
  const normalized = value.replace(/[\r\n/]+/g, '-').replace(/\s+/g, '-').trim();
  return (normalized || fallback).slice(0, 160);
}
