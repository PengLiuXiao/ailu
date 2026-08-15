import type { AgentId } from '../types';
import { loadLocalSkills, type LocalSkill } from './skillDiscovery';

export function filterCreativeSkills(
  skills: LocalSkill[],
  selectedNames: readonly string[],
): LocalSkill[] {
  const selected = new Set(selectedNames.map(name => name.toLocaleLowerCase()));
  return skills
    .filter(skill => selected.has(skill.name.toLocaleLowerCase()));
}

export async function loadCreativeSkills(
  agentId: AgentId,
  selectedNames: readonly string[],
): Promise<LocalSkill[]> {
  return filterCreativeSkills(await loadLocalSkills(agentId), selectedNames);
}
