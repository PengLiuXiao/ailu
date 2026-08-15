import { fileURLToPath } from 'url';

import { AgentAdapter } from '../src/runtime/adapter';
import type { ChatTurnRequest, RuntimeTurnEvent } from '../src/types';

describe('AgentAdapter Claude streaming', () => {
  test('emits streamed text once while retaining snapshot-only fallback messages', async () => {
    const binaryPath = fileURLToPath(new URL('./fixtures/fake-claude-duplicate-stream.mjs', import.meta.url));
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
    });
    const request: ChatTurnRequest = {
      conversationId: 'stream-fixture',
      agentId: 'claude',
      prompt: 'fixture prompt',
      cwd: process.cwd(),
      configSource: 'localCli',
    };
    const events: RuntimeTurnEvent[] = [];
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run(request);

    const text = events.flatMap(event => event.type === 'text' ? [event.content] : []).join('');
    expect(text).toBe('先检查已经完成回退消息');
    expect(events).toContainEqual({ type: 'session', sessionId: 'fixture-session' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('does not replace an explicitly resumed Claude session with a transient stream id', async () => {
    const binaryPath = fileURLToPath(new URL('./fixtures/fake-claude-duplicate-stream.mjs', import.meta.url));
    const adapter = new AgentAdapter({
      agentId: 'claude',
      binaryPath,
      providerProfile: null,
    });
    const request: ChatTurnRequest = {
      conversationId: 'resume-fixture',
      agentId: 'claude',
      prompt: 'fixture prompt',
      cwd: process.cwd(),
      configSource: 'localCli',
      sessionId: 'persisted-session',
    };
    const events: RuntimeTurnEvent[] = [];
    adapter.onRuntimeEvent(event => events.push(event));

    await adapter.run(request);

    expect(events).toContainEqual({ type: 'text', content: 'resume-argv:persisted-session' });
    expect(events).not.toContainEqual({ type: 'session', sessionId: 'fixture-session' });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});
