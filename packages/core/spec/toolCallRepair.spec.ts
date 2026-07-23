import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import {
  textToNativeToolCalls,
  promoteTextEmittedToolCallMessage,
  parseStandalonePlainTextToolCallBlocks,
} from '#src/core/toolCallRepair/index.js';

// EXT-35 — plain-text tool-call repair. Small/local models often serialise a tool call as
// assistant TEXT in one of three dialects; the repair promotes a STANDALONE such call to a native
// tool_call, gated HARD by (a) a bound-tool allow-list, (b) a payload-size cap, (c) standalone-only.
// These are the unit tests for the core module (real @langchain/core/messages, no mocks).

const ALLOW = ['get_weather', 'turn_right', 'a', 'b'];

describe('toolCallRepair — dialect parsing + promotion', () => {
  // Each dialect promotes to the correct native tool_call (name + args), preserving the message id.
  it('promotes the bracket dialect `[tool:name]{...}`', () => {
    const msg = new AIMessage({ id: 'm1', content: '[tool:get_weather]{"city":"Paris"}' });
    const promoted = promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW });
    expect(promoted).toBeDefined();
    expect(promoted!.id).toBe('m1'); // id preserved so the graph reducer REPLACES (not appends)
    expect(promoted!.content).toBe('');
    expect(promoted!.tool_calls).toHaveLength(1);
    expect(promoted!.tool_calls![0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'Paris' },
      type: 'tool_call',
    });
    expect(promoted!.tool_calls![0].id).toBeTruthy(); // a fresh id is minted (model emitted none)
  });

  it('promotes the bracket dialect with an explicit closing marker `[name]\\n{...}\\n[/name]`', () => {
    const msg = new AIMessage({
      id: 'm1b',
      content: '[get_weather]\n{"city":"Berlin"}\n[/get_weather]',
    });
    const promoted = promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW });
    expect(promoted!.tool_calls![0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'Berlin' },
    });
  });

  it('promotes the XML-ish dialect `<function=name><parameter=k>v</parameter></function>`', () => {
    const msg = new AIMessage({
      id: 'm2',
      content: '<function=get_weather><parameter=city>Paris</parameter></function>',
    });
    const promoted = promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW });
    expect(promoted).toBeDefined();
    expect(promoted!.id).toBe('m2');
    // XML-ish parameter values are strings.
    expect(promoted!.tool_calls![0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'Paris' },
      type: 'tool_call',
    });
  });

  it('promotes the Harmony dialect `<|channel|>commentary to=name code<|message|>{...}<|call|>`', () => {
    const msg = new AIMessage({
      id: 'm3',
      content: '<|channel|>commentary to=get_weather code<|message|>{"city":"Paris"}<|call|>',
    });
    const promoted = promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW });
    expect(promoted).toBeDefined();
    expect(promoted!.id).toBe('m3');
    expect(promoted!.tool_calls![0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'Paris' },
      type: 'tool_call',
    });
  });

  it('promotes multiple standalone calls in one message', () => {
    const msg = new AIMessage({ id: 'm4', content: '[tool:a]{"x":1}\n[tool:b]{"y":2}' });
    const promoted = promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW });
    expect(promoted!.tool_calls).toHaveLength(2);
    expect(promoted!.tool_calls!.map((t) => t.name)).toEqual(['a', 'b']);
    expect(promoted!.tool_calls!.map((t) => t.args)).toEqual([{ x: 1 }, { y: 2 }]);
  });
});

describe('toolCallRepair — the three gates', () => {
  // Gate 1: name allow-list. A call naming a tool NOT in the bound set is left as text.
  it('does NOT promote a call whose tool name is outside the allow-list', () => {
    const msg = new AIMessage({ id: 'g1', content: '[tool:delete_everything]{"path":"/"}' });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW })).toBeUndefined();
  });

  it('does NOT promote when the allow-list is empty (prose-safe default: no toolset ⇒ no call)', () => {
    const msg = new AIMessage({ id: 'g2', content: '[tool:get_weather]{"city":"Paris"}' });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: [] })).toBeUndefined();
    expect(
      textToNativeToolCalls('[tool:get_weather]{"city":"Paris"}', { allowedToolNames: [] })
    ).toBeUndefined();
  });

  // Gate 2: payload-size cap. An oversized blob is not treated as a call.
  it('does NOT promote a call whose payload exceeds the byte cap', () => {
    const msg = new AIMessage({ id: 'g3', content: '[tool:get_weather]{"city":"Paris"}' });
    // The JSON payload is well over 3 bytes, so with a tiny cap it is not treated as a call.
    expect(
      promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW, maxPayloadBytes: 3 })
    ).toBeUndefined();
    // The same call promotes under a generous cap — proving the cap (not the grammar) rejected it.
    expect(
      promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW, maxPayloadBytes: 10_000 })
    ).toBeDefined();
  });

  // Gate 3: standalone-only. A call buried inside prose is not promoted.
  it('does NOT promote a call embedded in surrounding prose (not standalone)', () => {
    const msg = new AIMessage({
      id: 'g4',
      content: 'Sure, let me check: [tool:get_weather]{"city":"Paris"} — one moment.',
    });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW })).toBeUndefined();
  });
});

describe('toolCallRepair — adversarial prose safety (never misread prose as a call)', () => {
  const CASES: Array<{ label: string; text: string }> = [
    {
      label: 'mentions a tool name in a bracket with no payload',
      text: 'Use the [tool:get_weather] helper to fetch the forecast.',
    },
    {
      label: 'contains an ordinary bracketed list',
      text: 'Here is a list: [1, 2, 3] and some prose after it.',
    },
    {
      label: 'contains a JSON object in prose (no marker)',
      text: 'The request body was {"city":"Paris"} as logged earlier.',
    },
    {
      label: 'merely names a tool in a sentence',
      text: "I'll call get_weather for you now and report back.",
    },
    {
      label: 'a markdown checkbox / bracket that is not a tool',
      text: '[x] done\n[ ] pending',
    },
    {
      label: 'an unterminated function tag with no parameters',
      text: '<function=get_weather> please fill this in later',
    },
  ];

  it.each(CASES)('does not promote: $label', ({ text }) => {
    const msg = new AIMessage({ id: 'p', content: text });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW })).toBeUndefined();
    // And the low-level parser agrees the whole text is not a standalone call.
    expect(parseStandalonePlainTextToolCallBlocks(text, { allowedToolNames: ALLOW })).toBeNull();
  });
});

describe('toolCallRepair — native happy path is untouched', () => {
  it('returns undefined when the message already has native tool_calls', () => {
    const msg = new AIMessage({
      id: 'n1',
      content: '',
      tool_calls: [{ id: 't1', name: 'get_weather', args: { city: 'Paris' }, type: 'tool_call' }],
    });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW })).toBeUndefined();
  });

  it('returns undefined for ordinary assistant prose (no call present)', () => {
    const msg = new AIMessage({ id: 'n2', content: 'The weather in Paris is sunny today.' });
    expect(promoteTextEmittedToolCallMessage(msg, { allowedToolNames: ALLOW })).toBeUndefined();
  });

  it('returns undefined for an empty / whitespace-only message', () => {
    expect(
      promoteTextEmittedToolCallMessage(new AIMessage({ id: 'n3', content: '   ' }), {
        allowedToolNames: ALLOW,
      })
    ).toBeUndefined();
  });
});
