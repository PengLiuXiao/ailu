import type { RuntimeTurnEvent, ToolCallEvent } from '../types';
import { createId } from '../utils/id';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentArrayText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (isRecord(item)) {
      const blockType = firstString(item.type);
      if (blockType && blockType !== 'text' && blockType !== 'output_text') continue;
      const text = firstText(item.text, item.content);
      if (text) parts.push(text);
    }
  }
  return parts.length ? parts.join('') : null;
}

export interface ClaudeStreamParserState {
  currentMessageDeltaText: string;
}

export function createClaudeStreamParserState(): ClaudeStreamParserState {
  return { currentMessageDeltaText: '' };
}

export function parseClaudeStreamLine(
  line: string,
  state?: ClaudeStreamParserState,
): RuntimeTurnEvent[] {
  const events: RuntimeTurnEvent[] = [];
  const parsed = parseJson(line);
  if (!parsed) return line.trim() ? [{ type: 'text', content: line }] : [];

  const eventType = firstString(parsed.type, parsed.event);
  const nestedEvent = isRecord(parsed.event) ? parsed.event : null;
  const nestedType = firstString(nestedEvent?.type);
  if (state && nestedType === 'message_start') {
    state.currentMessageDeltaText = '';
  }
  if (eventType === 'error') {
    events.push({ type: 'error', message: firstString(parsed.message, parsed.error) ?? stringify(parsed) });
  }
  if (eventType === 'result' && (parsed.is_error === true || firstString(parsed.subtype)?.includes('error'))) {
    events.push({
      type: 'error',
      message: firstString(parsed.result, parsed.error, parsed.message) ?? stringify(parsed),
    });
  }

  const sessionId = firstString(parsed.session_id, parsed.sessionId);
  if (sessionId) {
    events.push({ type: 'session', sessionId });
  }

  const directText = firstText(parsed.text, parsed.delta, parsed.content);
  if (directText && eventType !== 'result') {
    events.push({ type: 'text', content: directText });
  }

  const hasAssistantMessage = (
    isRecord(parsed.message)
    && (eventType === 'assistant' || firstString(parsed.message.role) === 'assistant')
  );
  if (hasAssistantMessage && isRecord(parsed.message)) {
    const messageText = contentArrayText(parsed.message.content) ?? firstText(parsed.message.text);
    if (messageText) {
      const remainingText = state
        ? remainingClaudeSnapshotText(messageText, state.currentMessageDeltaText)
        : messageText;
      if (remainingText) events.push({ type: 'text', content: remainingText });
    }
    if (state) state.currentMessageDeltaText = '';
  }

  if (isRecord(parsed.delta)) {
    const deltaText = firstText(parsed.delta.text);
    if (deltaText) {
      if (state) state.currentMessageDeltaText += deltaText;
      events.push({ type: 'text', content: deltaText });
    }
  }

  if (nestedEvent) {
    const nestedDelta = isRecord(nestedEvent.delta) ? nestedEvent.delta : null;
    if (nestedType === 'content_block_delta' && nestedDelta) {
      const deltaText = firstText(nestedDelta.text, nestedDelta.content);
      if (deltaText) {
        if (state) state.currentMessageDeltaText += deltaText;
        events.push({ type: 'text', content: deltaText });
      }
    }
  }

  return events;
}

function remainingClaudeSnapshotText(snapshotText: string, streamedText: string): string | null {
  if (!streamedText) return snapshotText;
  if (snapshotText.startsWith(streamedText)) {
    return snapshotText.slice(streamedText.length) || null;
  }
  // The live delta stream has already been rendered. If a provider returns a
  // divergent snapshot for the same message, do not append a second copy.
  return null;
}

export function parseCodexStreamLine(line: string): RuntimeTurnEvent[] {
  const parsed = parseJson(line);
  if (!parsed) return line.trim() ? [{ type: 'text', content: line }] : [];
  const msg = isRecord(parsed.msg) ? parsed.msg : null;
  const type = firstString(parsed.type, parsed.event, msg?.type);
  if (type === 'thread.started') {
    const sessionId = firstString(parsed.thread_id, parsed.threadId, parsed.id);
    return sessionId ? [{ type: 'session', sessionId }] : [];
  }
  if (type === 'item.agent_message.delta') {
    const text = firstText(parsed.delta, parsed.text, parsed.message);
    return text ? [{ type: 'text', content: text }] : [];
  }
  if (type === 'item.completed' && isRecord(parsed.item)) {
    const itemType = firstString(parsed.item.type);
    if (itemType === 'agent_message' || itemType === 'message') {
      const text = firstText(parsed.item.text, parsed.item.message) ?? contentArrayText(parsed.item.content);
      return text ? [{ type: 'text', content: text }] : [];
    }
    if (itemType === 'command_execution' || itemType === 'tool_call') {
      return [{ type: 'tool', toolCall: toolFromRecord(parsed.item) }];
    }
  }
  if (type === 'turn.failed' || type === 'error') {
    return [{ type: 'error', message: firstString(parsed.message, parsed.error) ?? stringify(parsed) }];
  }
  if (type === 'response_item' && isRecord(parsed.item)) {
    const itemType = firstString(parsed.item.type);
    if (itemType === 'agent_message') {
      const text = firstText(parsed.item.text, parsed.item.content) ?? contentArrayText(parsed.item.content);
      return text ? [{ type: 'text', content: text }] : [];
    }
    if (itemType === 'command_execution' || itemType === 'tool_call') {
      return [{ type: 'tool', toolCall: toolFromRecord(parsed.item) }];
    }
  }
  if (type === 'event_msg') {
    const text = firstText(parsed.message, parsed.msg, parsed.text);
    return text ? [{ type: 'text', content: text }] : [];
  }
  return [];
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolFromRecord(record: Record<string, unknown>): ToolCallEvent {
  return {
    id: firstString(record.id, record.call_id, record.toolCallId) ?? createId('tool'),
    name: firstString(record.name, record.command, record.tool_name, record.type) ?? 'tool',
    status: firstString(record.status) === 'error' ? 'error' : 'completed',
    input: record.input ?? record.arguments,
    output: record.output ?? record.result,
    error: firstString(record.error) ?? undefined,
  };
}
