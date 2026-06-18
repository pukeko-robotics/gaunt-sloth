import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

describe('tui/debugRender', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renderHistory serializes the message list as readable JSON (type + content)', async () => {
    const { renderHistory } = await import('#src/tui/debugRender.js');
    const out = renderHistory([new SystemMessage('sys'), new HumanMessage('hello')]);
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    // mapChatMessagesToStoredMessages tags each entry with its type and a data.content field.
    expect(out).toContain('system');
    expect(out).toContain('human');
    expect(out).toContain('hello');
  });

  it('renderResponse serializes an AIMessage response', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const out = renderResponse(new AIMessage('the answer'));
    expect(out).toContain('the answer');
    expect(out).toContain('ai');
  });

  it('renderResponse falls back to plain JSON for a non-message value', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const out = renderResponse({ foo: 'bar' });
    expect(JSON.parse(out)).toEqual({ foo: 'bar' });
  });

  it('renderResponse degrades gracefully on a non-serializable value (never throws)', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = renderResponse(circular);
    expect(out).toContain('could not render response');
  });
});
