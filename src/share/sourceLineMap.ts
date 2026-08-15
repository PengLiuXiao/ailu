function lineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

function interpolatedLineMap(sourceLines: readonly number[], targetCount: number): number[] {
  if (targetCount <= 0) return [];
  if (!sourceLines.length) return Array.from({ length: targetCount }, (_, index) => index);
  if (targetCount === 1) return [sourceLines[0]];
  const lastSourceIndex = sourceLines.length - 1;
  return Array.from({ length: targetCount }, (_, index) => {
    const sourceIndex = Math.round((index / (targetCount - 1)) * lastSourceIndex);
    return sourceLines[sourceIndex];
  });
}

export function createBodySourceLineMap(source: string, body: string): number[] {
  const bodyStart = source.endsWith(body) ? source.length - body.length : 0;
  const firstBodyLine = source.slice(0, bodyStart).split('\n').length - 1;
  return Array.from({ length: lineCount(body) }, (_, index) => firstBodyLine + index);
}

export function reconcileSourceLineMap(
  markdown: string,
  sourceLines: readonly number[],
): number[] {
  const targetCount = lineCount(markdown);
  return sourceLines.length === targetCount
    ? [...sourceLines]
    : interpolatedLineMap(sourceLines, targetCount);
}

export function collapseMermaidSourceLineMap(
  markdown: string,
  sourceLines: readonly number[],
): number[] {
  const lines = markdown.split(/\r?\n/);
  const normalizedSourceLines = reconcileSourceLineMap(markdown, sourceLines);
  const result: number[] = [];
  for (let index = 0; index < lines.length;) {
    if (/^```mermaid[^\r\n]*$/i.test(lines[index])) {
      let closingIndex = index + 1;
      while (closingIndex < lines.length && !/^```[ \t]*$/.test(lines[closingIndex])) {
        closingIndex += 1;
      }
      if (closingIndex < lines.length) {
        result.push(normalizedSourceLines[index]);
        index = closingIndex + 1;
        continue;
      }
    }
    result.push(normalizedSourceLines[index]);
    index += 1;
  }
  return result;
}
