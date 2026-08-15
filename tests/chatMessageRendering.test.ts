import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  reconcileStableMessageOrder,
  resolveChatMessageRenderMode,
  resolveChatMessageRenderUpdate,
  resolvePlainTextMutation,
  type ChatMessageRenderFingerprint,
} from '../src/ui/chatMessageRendering';

function fingerprint(
  overrides: Partial<ChatMessageRenderFingerprint> = {},
): ChatMessageRenderFingerprint {
  return {
    role: 'assistant',
    content: 'hello',
    agentId: 'claude',
    artifactsSignature: '[]',
    durationMs: undefined,
    mode: 'markdown',
    memoryActionAvailable: true,
    ...overrides,
  };
}

class FakeNode {
  parent: FakeParent | null = null;

  constructor(readonly id: string) {}

  get nextSibling(): FakeNode | null {
    if (!this.parent) return null;
    const index = this.parent.children.indexOf(this);
    return index < 0 ? null : this.parent.children[index + 1] ?? null;
  }
}

class FakeParent {
  readonly children: FakeNode[];
  moveCount = 0;

  constructor(children: FakeNode[]) {
    this.children = [...children];
    for (const child of children) child.parent = this;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode {
    this.moveCount += 1;
    const currentIndex = this.children.indexOf(node);
    if (currentIndex >= 0) this.children.splice(currentIndex, 1);
    const nextIndex = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(nextIndex, 0, node);
    node.parent = this;
    return node;
  }
}

describe('chat message rendering stability', () => {
  test('keeps every existing node untouched when message order is already correct', () => {
    const control = new FakeNode('control');
    const user = new FakeNode('user');
    const assistant = new FakeNode('assistant');
    const parent = new FakeParent([control, user, assistant]);

    reconcileStableMessageOrder(
      parent as unknown as ParentNode,
      [user, assistant] as unknown as Node[],
      control as unknown as Node,
    );

    expect(parent.children.map(node => node.id)).toEqual(['control', 'user', 'assistant']);
    expect(parent.moveCount).toBe(0);
  });

  test('forces selectable text through Obsidian theme overrides', () => {
    const stylesheet = fs.readFileSync(
      fileURLToPath(new URL('../styles.css', import.meta.url)),
      'utf8',
    );

    expect(stylesheet).toMatch(
      /\.ailu-message > pre\.ailu-message-content[\s\S]*?user-select: text !important;/,
    );
    expect(stylesheet).toMatch(
      /\.ailu-message \.markdown-rendered \*[\s\S]*?-webkit-user-select: text !important;/,
    );
  });

  test('moves only the out-of-order node and reaches the requested order', () => {
    const control = new FakeNode('control');
    const user = new FakeNode('user');
    const assistant = new FakeNode('assistant');
    const parent = new FakeParent([control, assistant, user]);

    reconcileStableMessageOrder(
      parent as unknown as ParentNode,
      [user, assistant] as unknown as Node[],
      control as unknown as Node,
    );

    expect(parent.children.map(node => node.id)).toEqual(['control', 'user', 'assistant']);
    expect(parent.moveCount).toBe(1);
  });

  test('updates live assistant text in the existing plain node', () => {
    const current = fingerprint({
      content: '第一段',
      mode: 'live-plain',
      memoryActionAvailable: false,
    });
    const next = fingerprint({
      content: '第一段\n第二段',
      mode: 'live-plain',
      memoryActionAvailable: false,
    });

    expect(resolveChatMessageRenderUpdate(current, next)).toBe('update-plain');
    expect(resolvePlainTextMutation(current.content, next.content)).toEqual({
      type: 'append',
      text: '\n第二段',
    });
  });

  test('replaces text only when a corrected snapshot is not append-only', () => {
    expect(resolvePlainTextMutation('旧答案尾巴', '已修正答案')).toEqual({
      type: 'replace',
      text: '已修正答案',
    });
  });

  test('does not rebuild a completed message when nothing changed', () => {
    const current = fingerprint();
    expect(resolveChatMessageRenderUpdate(current, { ...current })).toBe('reuse');
  });

  test('rebuilds Markdown once when live output becomes completed output', () => {
    const current = fingerprint({
      mode: 'live-plain',
      memoryActionAvailable: false,
    });
    const next = fingerprint({
      mode: 'markdown',
      memoryActionAvailable: true,
    });

    expect(resolveChatMessageRenderUpdate(current, next)).toBe('replace');
  });

  test('keeps older assistant messages as Markdown while another turn is live', () => {
    expect(resolveChatMessageRenderMode({
      role: 'assistant',
      liveAssistant: false,
    })).toBe('markdown');
    expect(resolveChatMessageRenderMode({
      role: 'assistant',
      liveAssistant: true,
    })).toBe('live-plain');
  });

  test('keeps user messages plain and live artifact-bearing output stable', () => {
    expect(resolveChatMessageRenderMode({
      role: 'user',
      liveAssistant: false,
    })).toBe('plain');
    expect(resolveChatMessageRenderMode({
      role: 'assistant',
      liveAssistant: true,
    })).toBe('live-plain');
  });
});
