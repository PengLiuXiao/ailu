import type { AgentId, ChatMessage } from '../types';

export type ChatMessageRenderMode = 'plain' | 'live-plain' | 'markdown';

export function resolveChatMessageRenderMode(options: {
  role: ChatMessage['role'];
  liveAssistant: boolean;
}): ChatMessageRenderMode {
  if (options.role !== 'assistant' && options.role !== 'error') return 'plain';
  return options.liveAssistant ? 'live-plain' : 'markdown';
}

export interface ChatMessageRenderFingerprint {
  role: ChatMessage['role'];
  content: string;
  agentId: AgentId | undefined;
  artifactsSignature: string;
  durationMs: number | undefined;
  mode: ChatMessageRenderMode;
  memoryActionAvailable: boolean;
}

export type ChatMessageRenderUpdate = 'reuse' | 'update-plain' | 'replace';

export type PlainTextMutation =
  | { type: 'none'; text: '' }
  | { type: 'append'; text: string }
  | { type: 'replace'; text: string };

/** Append-only streaming preserves existing Text nodes and browser Ranges. */
export function resolvePlainTextMutation(current: string, next: string): PlainTextMutation {
  if (current === next) return { type: 'none', text: '' };
  if (next.startsWith(current)) return { type: 'append', text: next.slice(current.length) };
  return { type: 'replace', text: next };
}

/**
 * Decide whether a message can keep its existing DOM node.
 *
 * Live assistant output and user messages are plain text, so content changes can
 * update the existing <pre> without destroying the browser selection. Completed
 * Markdown must be rebuilt when its source changes.
 */
export function resolveChatMessageRenderUpdate(
  current: ChatMessageRenderFingerprint,
  next: ChatMessageRenderFingerprint,
): ChatMessageRenderUpdate {
  if (current.role !== next.role
    || current.agentId !== next.agentId
    || current.artifactsSignature !== next.artifactsSignature
    || current.durationMs !== next.durationMs
    || current.mode !== next.mode
    || current.memoryActionAvailable !== next.memoryActionAvailable) {
    return 'replace';
  }
  if (current.content === next.content) return 'reuse';
  return next.mode === 'plain' || next.mode === 'live-plain'
    ? 'update-plain'
    : 'replace';
}

/**
 * Reconcile message order without re-appending nodes that are already in the
 * correct position. Moving a selected DOM subtree clears Chromium's selection,
 * so the no-op path must perform no DOM mutation at all.
 */
export function reconcileStableMessageOrder(
  parent: ParentNode,
  desiredNodes: readonly Node[],
  leadingNode: Node | null = null,
): void {
  let previous = leadingNode;
  for (const node of desiredNodes) {
    const expected = previous ? previous.nextSibling : parent.firstChild;
    if (expected !== node) parent.insertBefore(node, expected);
    previous = node;
  }
}
