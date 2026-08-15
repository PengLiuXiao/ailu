#!/usr/bin/env node

process.stdin.resume();
process.stdin.on('end', () => {
  const resumeIndex = process.argv.indexOf('--resume');
  const resumedSessionId = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : null;
  const events = [
    ...(resumedSessionId ? [{
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `resume-argv:${resumedSessionId}` }] },
    }] : []),
    { type: 'system', subtype: 'init', session_id: 'fixture-session' },
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
          { type: 'tool_use', id: 'fixture-tool', name: 'Read' },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'fixture-tool', content: 'done' }],
      },
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
    { type: 'stream_event', event: { type: 'message_start' } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '回退消息' }] },
    },
    { type: 'result', subtype: 'success', is_error: false },
  ];
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
});
