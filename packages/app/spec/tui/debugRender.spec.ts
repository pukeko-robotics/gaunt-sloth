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

  it('renderRequestDetails surfaces model params, system prompt and tool definitions', async () => {
    const { renderRequestDetails } = await import('#src/tui/debugRender.js');
    const out = renderRequestDetails({
      systemPrompt: 'You are a careful sloth.',
      toolChoice: 'auto',
      modelParams: { model: 'claude-opus-4', temperature: 0.3 },
      tools: [
        { name: 'read_file', description: 'Reads a file', schema: { type: 'object' } },
        { name: 'write_file', description: 'Writes a file' },
      ],
    });

    expect(out).toContain('MODEL PARAMS');
    expect(out).toContain('claude-opus-4');
    expect(out).toContain('TOOL CHOICE');
    expect(out).toContain('SYSTEM PROMPT');
    expect(out).toContain('You are a careful sloth.');
    expect(out).toContain('TOOL DEFINITIONS (2)');
    expect(out).toContain('read_file');
    expect(out).toContain('write_file');
    // The schema is rendered under the tool that has one.
    expect(out).toContain('params:');
  });

  it('renderRequestDetails converts a Zod tool schema to JSON schema', async () => {
    const { z } = await import('zod');
    const { renderRequestDetails } = await import('#src/tui/debugRender.js');
    const out = renderRequestDetails({
      tools: [{ name: 'do_thing', schema: z.object({ count: z.number() }) }],
    });
    expect(out).toContain('do_thing');
    // zodToJsonSchema yields a JSON-schema object with the property name.
    expect(out).toContain('count');
    expect(out).toContain('"type"');
  });

  it('renderRequestDetails shows a clear empty state when nothing was captured', async () => {
    const { renderRequestDetails } = await import('#src/tui/debugRender.js');
    expect(renderRequestDetails(undefined)).toContain('no request details captured');
  });
});
