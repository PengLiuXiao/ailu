export interface XArticleMarkdownFenceState {
  character: '`' | '~' | null;
  length: number;
}

/**
 * Applies the CommonMark fenced-code opening/closing rules used by every X
 * preview and upload boundary. The state is mutated only for a valid delimiter.
 */
export function consumeXArticleMarkdownFence(
  line: string,
  state: XArticleMarkdownFenceState,
): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return false;
  const character = match[1][0] as '`' | '~';
  const remainder = match[2];
  if (!state.character) {
    if (character === '`' && remainder.includes('`')) return false;
    state.character = character;
    state.length = match[1].length;
    return true;
  }
  if (character !== state.character || match[1].length < state.length
    || !/^[ \t]*$/.test(remainder)) return false;
  state.character = null;
  state.length = 0;
  return true;
}

export function xArticleMarkdownFenceState(): XArticleMarkdownFenceState {
  return { character: null, length: 0 };
}
