import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { convertMessage } from '#src/modules/apiAgUiModule.js';

// EXT-35 — the AG-UI convertMessage wire-in point. An INCOMING assistant message with no native
// `toolCalls` whose content is a STANDALONE text-emitted call (a small/local model serialising a
// tool call as prose) is promoted to a native tool_call, gated by the bound-tool allow-list +
// payload cap + standalone-only. Deliberately a SEPARATE spec from apiAgUiModule.spec.ts: that
// suite mocks @langchain/core/messages with trivial constructors that drop `tool_calls`, so the
// promotion must be asserted against REAL messages here (this file mocks nothing).

describe('apiAgUiModule.convertMessage — EXT-35 plain-text tool-call repair', () => {
  const ALLOW = new Set(['get_weather', 'turn_right']);

  it('promotes a standalone bracket-dialect call to a native tool_call', () => {
    const msg = convertMessage(
      { role: 'assistant', content: '[tool:get_weather]{"city":"Paris"}', id: 'a1' },
      ALLOW
    ) as AIMessage;
    expect(AIMessage.isInstance(msg)).toBe(true);
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]).toMatchObject({ name: 'get_weather', args: { city: 'Paris' } });
    expect(msg.content).toBe('');
  });

  it('promotes the XML-ish and Harmony dialects too', () => {
    const xml = convertMessage(
      {
        role: 'assistant',
        content: '<function=turn_right><parameter=deg>90</parameter></function>',
        id: 'x',
      },
      ALLOW
    ) as AIMessage;
    expect(xml.tool_calls![0]).toMatchObject({ name: 'turn_right', args: { deg: '90' } });

    const harmony = convertMessage(
      {
        role: 'assistant',
        content: '<|channel|>commentary to=get_weather code<|message|>{"city":"NYC"}<|call|>',
        id: 'h',
      },
      ALLOW
    ) as AIMessage;
    expect(harmony.tool_calls![0]).toMatchObject({ name: 'get_weather', args: { city: 'NYC' } });
  });

  it('leaves ordinary assistant prose as plain text (no promotion)', () => {
    const msg = convertMessage(
      { role: 'assistant', content: 'The weather in Paris is sunny.', id: 'a2' },
      ALLOW
    ) as AIMessage;
    expect(msg.tool_calls ?? []).toHaveLength(0);
    expect(msg.content).toBe('The weather in Paris is sunny.');
  });

  it('does not promote when no allow-list is passed (prose-safe default)', () => {
    const msg = convertMessage({
      role: 'assistant',
      content: '[tool:get_weather]{"city":"Paris"}',
      id: 'a3',
    }) as AIMessage;
    expect(msg.tool_calls ?? []).toHaveLength(0);
    expect(msg.content).toBe('[tool:get_weather]{"city":"Paris"}');
  });

  it('does not promote a call naming a tool outside the allow-list', () => {
    const msg = convertMessage(
      { role: 'assistant', content: '[tool:delete_all]{"x":1}', id: 'a4' },
      ALLOW
    ) as AIMessage;
    expect(msg.tool_calls ?? []).toHaveLength(0);
  });

  it('still converts a native tool_calls assistant message (existing path, unchanged)', () => {
    const msg = convertMessage(
      {
        role: 'assistant',
        content: 'ok',
        id: 'a5',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      ALLOW
    ) as AIMessage;
    expect(msg.tool_calls![0]).toMatchObject({
      id: 'tc1',
      name: 'get_weather',
      args: { city: 'Paris' },
    });
  });
});
