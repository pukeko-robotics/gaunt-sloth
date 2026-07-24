import { describe, expect, it } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { convertMessage, convertMessages } from '#src/modules/apiAgUiModule.js';

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

  it('promotes the real gpt-oss Harmony variant (dotted name + `<|constrain|>json`)', () => {
    const msg = convertMessage(
      {
        role: 'assistant',
        content:
          '<|channel|>commentary to=functions.get_weather<|constrain|>json<|message|>{"city":"Paris"}<|call|>',
        id: 'g',
      },
      ALLOW
    ) as AIMessage;
    expect(msg.tool_calls![0]).toMatchObject({ name: 'get_weather', args: { city: 'Paris' } });
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

// EXT-43 — the history-convert path (convertMessages) applies a dangling-call guard: promoting a
// STALLED text call replayed in history would yield an AIMessage with tool_calls and NO following
// tool_result, which a strict provider (Anthropic) 400s on. So a history text-call is promoted ONLY
// when it is immediately followed by its `tool` result; a dangling one stays plain text (as the
// pre-EXT-35 wire did). The live middleware path (fixing the CURRENT turn) is unaffected.
describe('apiAgUiModule.convertMessages — EXT-43 dangling history tool_call guard', () => {
  const ALLOW = new Set(['get_weather']);

  it('does NOT promote a dangling/stalled history text call (stays plain text)', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'weather in Paris?', id: 'u1' },
        { role: 'assistant', content: '[tool:get_weather]{"city":"Paris"}', id: 'a1' },
      ],
      ALLOW
    );
    const assistant = converted[1] as AIMessage;
    expect(AIMessage.isInstance(assistant)).toBe(true);
    expect(assistant.tool_calls ?? []).toHaveLength(0);
    // Stays exactly as the wire text — the pre-EXT-35 shape a strict provider accepts.
    expect(assistant.content).toBe('[tool:get_weather]{"city":"Paris"}');
  });

  it('DOES promote a history text call that IS followed by its tool_result', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'weather in Paris?', id: 'u1' },
        { role: 'assistant', content: '[tool:get_weather]{"city":"Paris"}', id: 'a1' },
        { role: 'tool', content: '{"tempC":21}', id: 't1', toolCallId: 'call_1' },
      ],
      ALLOW
    );
    const assistant = converted[1] as AIMessage;
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls![0]).toMatchObject({
      name: 'get_weather',
      args: { city: 'Paris' },
    });
    expect(assistant.content).toBe('');
  });

  it('does not promote a dangling widened gpt-oss variant either (guard is dialect-agnostic)', () => {
    const converted = convertMessages(
      [
        {
          role: 'assistant',
          content:
            '<|channel|>commentary to=functions.get_weather<|constrain|>json<|message|>{"city":"Paris"}<|call|>',
          id: 'a1',
        },
      ],
      ALLOW
    );
    const assistant = converted[0] as AIMessage;
    expect(assistant.tool_calls ?? []).toHaveLength(0);
  });

  it('leaves ordinary history prose untouched and passes non-assistant roles through', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'hi', id: 'u1' },
        { role: 'assistant', content: 'The weather is sunny.', id: 'a1' },
      ],
      ALLOW
    );
    expect((converted[1] as AIMessage).content).toBe('The weather is sunny.');
    expect((converted[1] as AIMessage).tool_calls ?? []).toHaveLength(0);
  });
});

// RC-18 — the symmetric backward guard (convertMessages). A replayed `role:'tool'` result whose
// matching tool_call id is not present on any PRECEDING assistant message is an ORPHAN: converting
// it to a ToolMessage yields a tool result with no preceding AIMessage.tool_calls, which a strict
// provider (Anthropic) 400s on (INVALID_TOOL_RESULTS). The bug: the robot's terminal `finish_task`
// result was replayed without its parenting assistant tool_call. The guard drops such orphans while
// keeping genuine call→result pairs (matched by tool_call_id, accumulated in iteration order).
describe('apiAgUiModule.convertMessages — RC-18 orphan tool-result guard', () => {
  const ALLOW = new Set(['finish_task']);

  const toolMessages = (msgs: ReturnType<typeof convertMessages>) =>
    msgs.filter((m): m is ToolMessage => ToolMessage.isInstance(m));

  it('drops an orphan tool result with no preceding assistant tool_call', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'finish it', id: 'u1' },
        { role: 'tool', content: 'FINISH[success]: done', id: 't1', toolCallId: 'X' },
      ],
      ALLOW
    );
    // The orphan is filtered out entirely — no ToolMessage survives.
    expect(toolMessages(converted)).toHaveLength(0);
    expect(converted).toHaveLength(1);
    expect((converted[0] as { content: unknown }).content).toBe('finish it');
  });

  it('keeps a genuine pair (assistant native tool_call + matching tool result)', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'finish it', id: 'u1' },
        {
          role: 'assistant',
          content: '',
          id: 'a1',
          toolCalls: [
            { id: 'X', type: 'function', function: { name: 'finish_task', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'FINISH[success]: done', id: 't1', toolCallId: 'X' },
      ],
      ALLOW
    );
    const assistant = converted[1] as AIMessage;
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls![0]).toMatchObject({ id: 'X', name: 'finish_task' });
    const tools = toolMessages(converted);
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_call_id).toBe('X');
  });

  it('drops only the orphan in a mixed history (paired result survives)', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'go', id: 'u1' },
        {
          role: 'assistant',
          content: '',
          id: 'a1',
          toolCalls: [
            { id: 'PAIRED', type: 'function', function: { name: 'finish_task', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'result for paired', id: 't1', toolCallId: 'PAIRED' },
        // No assistant ever emitted tool_call ORPHAN — this result is an orphan.
        { role: 'tool', content: 'result for orphan', id: 't2', toolCallId: 'ORPHAN' },
      ],
      ALLOW
    );
    const tools = toolMessages(converted);
    expect(tools.map((t) => t.tool_call_id)).toEqual(['PAIRED']);
    expect(tools.map((t) => t.content)).toEqual(['result for paired']);
  });

  it('drops a result whose matching call appears only LATER (ordering: call-after-result)', () => {
    const converted = convertMessages(
      [
        { role: 'user', content: 'go', id: 'u1' },
        // Result comes BEFORE its would-be call — still an orphan (set is accumulated in order).
        { role: 'tool', content: 'premature result', id: 't1', toolCallId: 'X' },
        {
          role: 'assistant',
          content: '',
          id: 'a1',
          toolCalls: [
            { id: 'X', type: 'function', function: { name: 'finish_task', arguments: '{}' } },
          ],
        },
      ],
      ALLOW
    );
    // The premature tool result is dropped; the (now result-less) assistant call is left untouched.
    expect(toolMessages(converted)).toHaveLength(0);
    expect((converted[converted.length - 1] as AIMessage).tool_calls).toHaveLength(1);
  });

  it('matches on tool_call_id via msg.id when toolCallId is absent', () => {
    const converted = convertMessages(
      [
        {
          role: 'assistant',
          content: '',
          id: 'a1',
          toolCalls: [
            { id: 'ID1', type: 'function', function: { name: 'finish_task', arguments: '{}' } },
          ],
        },
        // No toolCallId — falls back to msg.id, which matches the preceding call id.
        { role: 'tool', content: 'ok', id: 'ID1' },
      ],
      ALLOW
    );
    const tools = toolMessages(converted);
    expect(tools).toHaveLength(1);
    expect(tools[0].tool_call_id).toBe('ID1');
  });
});
