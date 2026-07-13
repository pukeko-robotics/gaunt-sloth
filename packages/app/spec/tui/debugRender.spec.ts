import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';

describe('tui/debugRender', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renderHistory serializes the message list as readable JSON (type + content)', async () => {
    const { renderHistory } = await import('#src/tui/debugRender.js');
    const out = renderHistory([new SystemMessage('sys'), new HumanMessage('hello')]);
    // TUI-C16: a leading description scrolls with the content; the JSON body follows it.
    const parsed = JSON.parse(out.slice(out.indexOf('[')));
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

  it('renderSystemDetails surfaces model params, tool-choice and the system prompt (no tool defs)', async () => {
    const { renderSystemDetails } = await import('#src/tui/debugRender.js');
    const out = renderSystemDetails({
      systemPrompt: 'You are a careful sloth.',
      toolChoice: 'auto',
      modelParams: { model: 'claude-opus-4', temperature: 0.3 },
      tools: [{ name: 'read_file', description: 'Reads a file', schema: { type: 'object' } }],
    });

    expect(out).toContain('MODEL PARAMS');
    expect(out).toContain('claude-opus-4');
    expect(out).toContain('TOOL CHOICE');
    expect(out).toContain('SYSTEM PROMPT');
    expect(out).toContain('You are a careful sloth.');
    // TUI-C16: the tool catalogue lives on its own tab, not in the system view.
    expect(out).not.toContain('TOOL DEFINITIONS');
    expect(out).not.toContain('read_file');
  });

  it('renderToolDetails leads with a name list, then the full per-tool descriptors', async () => {
    const { renderToolDetails } = await import('#src/tui/debugRender.js');
    const out = renderToolDetails({
      tools: [
        { name: 'read_file', description: 'Reads a file', schema: { type: 'object' } },
        { name: 'write_file', description: 'Writes a file' },
      ],
    });

    expect(out).toContain('TOOLS (2)');
    expect(out).toContain('TOOL DEFINITIONS');
    expect(out).toContain('read_file');
    expect(out).toContain('write_file');
    // (3) the compact name list precedes the full definitions block.
    expect(out.indexOf('• read_file')).toBeLessThan(out.indexOf('TOOL DEFINITIONS'));
    // The schema is rendered under the tool that has one.
    expect(out).toContain('params:');
  });

  it('renderToolDetails converts a Zod tool schema to JSON schema', async () => {
    const { z } = await import('zod');
    const { renderToolDetails } = await import('#src/tui/debugRender.js');
    const out = renderToolDetails({
      tools: [{ name: 'do_thing', schema: z.object({ count: z.number() }) }],
    });
    expect(out).toContain('do_thing');
    // zodToJsonSchema yields a JSON-schema object with the property name.
    expect(out).toContain('count');
    expect(out).toContain('"type"');
  });

  it('renderSystemDetails / renderToolDetails show a clear empty state when nothing was captured', async () => {
    const { renderSystemDetails, renderToolDetails } = await import('#src/tui/debugRender.js');
    expect(renderSystemDetails(undefined)).toContain('no request details captured');
    expect(renderToolDetails(undefined)).toContain('no request details captured');
  });
});
