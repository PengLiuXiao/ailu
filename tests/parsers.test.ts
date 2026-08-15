import {
  createClaudeStreamParserState,
  parseClaudeStreamLine,
  parseCodexStreamLine,
} from '../src/runtime/parsers';
import type { RuntimeTurnEvent } from '../src/types';

function textContent(events: RuntimeTurnEvent[]): string {
  return events.flatMap(event => event.type === 'text' ? [event.content] : []).join('');
}

function parseClaudeSequence(lines: unknown[]): RuntimeTurnEvent[] {
  const state = createClaudeStreamParserState();
  return lines.flatMap(line => parseClaudeStreamLine(JSON.stringify(line), state));
}

describe('stream parsers', () => {
  test('parses Claude assistant message content arrays', () => {
    const events = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hello' }],
      },
    }));
    expect(events).toContainEqual({ type: 'text', content: 'hello' });
  });

  test('parses Claude nested content block deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '<section>' },
      },
    }))).toContainEqual({ type: 'text', content: '<section>' });
  });

  test('does not append a Claude assistant snapshot after its streamed deltas', () => {
    const events = parseClaudeSequence([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);

    expect(textContent(events)).toBe('hello');
  });

  test('deduplicates each Claude text segment around tool use', () => {
    const events = parseClaudeSequence([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先检查' } },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '先检查' },
            { type: 'tool_use', id: 'tool-1', name: 'Read' },
          ],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
      },
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '已经完成' } },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '已经完成' }] },
      },
    ]);

    expect(textContent(events)).toBe('先检查已经完成');
  });

  test('uses a Claude assistant snapshot when no text delta arrived', () => {
    const events = parseClaudeSequence([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'fallback' }] },
      },
    ]);

    expect(textContent(events)).toBe('fallback');
  });

  test('fills a missing streamed suffix from the Claude assistant snapshot', () => {
    const events = parseClaudeSequence([
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      },
    ]);

    expect(textContent(events)).toBe('hello');
  });

  test('preserves whitespace-only Claude text deltas', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' ' },
      },
    }))).toEqual([{ type: 'text', content: ' ' }]);
  });

  test('ignores Claude tool results that contain HTML examples', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: '<section><p>Skill 组件示例</p></section>',
        }],
      },
    }))).toEqual([]);
  });

  test('keeps assistant text while ignoring non-text content blocks', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_result', content: '<section>工具输出</section>' },
          { type: 'text', text: '<section>正文</section>' },
        ],
      },
    }))).toEqual([{ type: 'text', content: '<section>正文</section>' }]);
  });

  test('parses Claude result errors', () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'API Error: Request rejected (429)',
    }))).toContainEqual({ type: 'error', message: 'API Error: Request rejected (429)' });
  });

  test('parses Codex deltas and errors', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.agent_message.delta',
      delta: 'hi',
    }))).toContainEqual({ type: 'text', content: 'hi' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'turn.failed',
      message: 'bad model',
    }))).toContainEqual({ type: 'error', message: 'bad model' });
  });

  test('parses Codex item.completed agent messages', () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'OK' },
    }))).toContainEqual({ type: 'text', content: 'OK' });
    expect(parseCodexStreamLine(JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_1', type: 'message', content: [{ type: 'output_text', text: 'hi there' }] },
    }))).toContainEqual({ type: 'text', content: 'hi there' });
  });

});
