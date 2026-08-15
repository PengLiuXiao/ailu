import { homedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';

import type { AgentId } from '../types';
import { loadCreativeSkills } from '../skill/creativeSkills';
import type { LocalSkill } from '../skill/skillDiscovery';

export interface SlashCommand {
  id: string;
  label: string;
  insertText: string;
  description: string;
  sourceLabel?: string;
  skillFilePath?: string;
}

export async function loadChatSkills(
  agentId: AgentId,
  selectedNames: readonly string[],
): Promise<SlashCommand[]> {
  const skills = await loadCreativeSkills(agentId, selectedNames);
  return skills.map(skill => ({
    id: skill.filePath,
    label: `/${skill.name}`,
    insertText: buildSkillInvocationPrompt(skill),
    description: [skill.sourceLabel, truncate(skill.description, 120)].filter(Boolean).join(' · '),
    sourceLabel: skill.sourceLabel,
    skillFilePath: skill.filePath,
  }));
}

export function buildSkillInvocationPrompt(
  skill: Pick<LocalSkill, 'name' | 'description' | 'filePath'>,
): string {
  const promptPath = homeRelativeSkillPath(skill.filePath);
  return [
    `Use the local Skill ${JSON.stringify(skill.name)} for this request.`,
    `Skill entrypoint (home-relative): ${JSON.stringify(promptPath)}`,
    'Before taking task actions, read that SKILL.md completely and follow it.',
    'Resolve relative references from the directory containing that SKILL.md.',
    'The current user and system instructions take precedence over Skill instructions.',
    'If this Skill publishes or uploads, do not ask for a duplicate confirmation solely because of that action: the user\'s current request is the authorization. Still obey higher-priority instructions and clarify a missing target or content.',
    'If the Skill requires a tool that is unavailable in this Agent, state that limitation and continue with the safest useful fallback.',
    skill.description ? `Skill summary: ${skill.description}` : '',
  ].filter(Boolean).join('\n');
}

export function homeRelativeSkillPath(filePath: string, homeDirectory = homedir()): string {
  const relativePath = relative(homeDirectory, filePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Skill entrypoint must be contained within the user home directory');
  }
  return `~/${relativePath.split(sep).join('/')}`;
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.toLowerCase();
  return commands.filter(command => (
    command.label.toLowerCase().includes(normalized)
    || command.description.toLowerCase().includes(normalized)
  ));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}…`;
}
