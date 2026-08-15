export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
}

export function parseSkillFrontmatter(text: string, fallbackName: string): ParsedSkillFrontmatter | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  const frontmatter = match[1];
  const name = extractField(frontmatter, 'name')?.trim() || fallbackName;
  const description = extractField(frontmatter, 'description') || '';
  if (!name) return null;
  return { name, description };
}

function extractField(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match quoted multi-line value first so actual newlines are not truncated by single-line regex
  const quotedStart = new RegExp(`^${escapedKey}:\\s*"`, 'm').exec(frontmatter);
  if (quotedStart) {
    const startIndex = quotedStart.index + quotedStart[0].length;
    const rest = frontmatter.slice(startIndex);
    let value = '';
    let escaped = false;
    for (let i = 0; i < rest.length; i += 1) {
      const char = rest[i];
      if (escaped) {
        value += char === 'n' ? '\n' : char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return value;
      }
      value += char;
    }
  }
  const blockStart = new RegExp(`^([ \\t]*)${escapedKey}:\\s*([|>])[-+]?\\s*$`, 'm').exec(frontmatter);
  if (blockStart) {
    const contentStart = blockStart.index + blockStart[0].length;
    const lines = frontmatter.slice(contentStart).replace(/^\r?\n/, '').split(/\r?\n/);
    const blockLines: string[] = [];
    let contentIndent: number | null = null;
    for (const line of lines) {
      if (line.trim().length === 0) {
        blockLines.push('');
        continue;
      }
      const indent = line.match(/^[ \\t]*/)?.[0].length ?? 0;
      if (contentIndent === null) contentIndent = indent;
      if (indent < contentIndent) break;
      blockLines.push(line.slice(contentIndent));
    }
    const literal = blockLines.join('\n').trim();
    if (blockStart[2] === '|') return literal;
    return literal
      .split(/\n{2,}/)
      .map(paragraph => paragraph.replace(/\n/g, ' '))
      .join('\n\n');
  }
  // Match single-line value: key: value
  const singleLine = new RegExp(`^${escapedKey}:\\s*(.*)$`, 'm').exec(frontmatter);
  if (singleLine) {
    const value = singleLine[1].trim();
    return unquote(value);
  }
  return null;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
