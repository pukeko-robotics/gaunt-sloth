/**
 * GS2-23 — the shared compaction mechanism's four transcript invariants, each as an assertion that
 * goes red when the invariant is violated, plus the provider-shape checks the invariants were
 * measured against.
 *
 * (a) a `tool_call` is never separated from its `tool_result`; (b) the system prompt survives and
 * the summary is a `HumanMessage`, never a mid-list `SystemMessage`; (c) the last message of the
 * input is the last message of the output, so nothing turns a pending user turn into a trailing
 * assistant one; (d) compacting twice leaves exactly one summary.
 *
 * **The provider-shape cells run the REAL converters** of `@langchain/anthropic` and
 * `@langchain/google` over the compacted output, because a no-crash check against a live model is
 * not evidence here: Anthropic accepts a trailing assistant message silently as prefill. The two
 * converters were measured before the shape was chosen: the Anthropic one throws on any system
 * message that is not first and passes consecutive `user` turns through unmerged (the Messages API
 * combines them); the Google one merges consecutive same-role contents into one and throws
 * `ToolCallNotFoundError` on a tool result whose call is missing. Each cell carries a control that
 * runs the converter over the shape the mechanism AVOIDS, so a converter that stopped caring would
 * be noticed rather than silently agreeing.
 *
 * Neither converter is on its package's `exports` map, so both are loaded by file path from the
 * package entry — the same files the chat models call, not a reimplementation.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import {
  buildCompactionPrompt,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SOURCE,
  compactionCutIndex,
  compactMessages,
  conversationSize,
  createCompactionSummaryMessage,
  createModelSummarizer,
  DEFAULT_KEEP_RECENT,
  isCompactionSummary,
  replaceGraphMessages,
} from '#src/core/compaction.js';

const h = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const sys = (text: string) => new SystemMessage(text);
const aiCalling = (...calls: { id: string; name?: string; args?: Record<string, unknown> }[]) =>
  new AIMessage({
    content: '',
    tool_calls: calls.map((call) => ({
      id: call.id,
      name: call.name ?? 'read_file',
      args: call.args ?? { path: `${call.id}.txt` },
    })),
  });
const result = (id: string, content = `contents of ${id}`) =>
  new ToolMessage({ tool_call_id: id, content, name: 'read_file' });

const types = (messages: readonly BaseMessage[]) => messages.map((m) => m.getType());

/** A summariser that records what it was given and answers with a short fixed text. */
const stubSummarizer = () =>
  vi.fn(async (_span: BaseMessage[], _focus?: string) => 'SUMMARY OF THE OLDER TURNS');

/**
 * The pairing check behind invariant (a): every tool result in `messages` is answered by an AI
 * message earlier in the SAME list, and every tool call issued in the list is answered in it.
 */
function toolPairsIntact(messages: readonly BaseMessage[]): boolean {
  const issued = new Map<string, number>();
  const answered = new Set<string>();
  messages.forEach((message, index) => {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) issued.set(call.id, index);
    }
  });
  for (const [index, message] of messages.entries()) {
    if (!ToolMessage.isInstance(message)) continue;
    const issuedAt = issued.get(message.tool_call_id);
    if (issuedAt === undefined || issuedAt > index) return false;
    answered.add(message.tool_call_id);
  }
  for (const id of issued.keys()) if (!answered.has(id)) return false;
  return true;
}

/** A twelve-message tool-heavy conversation: three exchanges, each with one tool pair. */
const toolHeavy = () => [
  h('one'),
  aiCalling({ id: 'c1' }),
  result('c1'),
  ai('answer one'),
  h('two'),
  aiCalling({ id: 'c2' }),
  result('c2'),
  ai('answer two'),
  h('three'),
  aiCalling({ id: 'c3' }),
  result('c3'),
  ai('answer three'),
];

describe('GS2-23 compactMessages — invariant (a): a tool call is never separated from its result', () => {
  it('widens the kept tail to the start of a pair the cut would have split', async () => {
    const messages = toolHeavy();
    // The last 6 would begin at index 6 — the tool result of call c2 — leaving its call behind.
    const summarize = stubSummarizer();
    const out = await compactMessages({ messages, summarize, keepRecent: 6 });

    expect(out.changed).toBe(true);
    expect(toolPairsIntact(out.messages)).toBe(true);
    // The tail was widened back to the AI message that issued c2, so 7 are kept and 5 folded.
    expect(out.keptCount).toBe(7);
    expect(out.removedCount).toBe(5);
    expect(out.messages.slice(1)).toEqual(messages.slice(5));
    // And the folded span handed to the summariser is exactly the other side of that cut.
    expect(summarize.mock.calls[0][0]).toEqual(messages.slice(0, 5));
    expect(toolPairsIntact(summarize.mock.calls[0][0])).toBe(true);
  });

  it('keeps a pair whole when the cut lands between two results of one parallel call', async () => {
    const messages = [
      h('one'),
      ai('answer one'),
      h('two'),
      aiCalling({ id: 'p1' }, { id: 'p2' }),
      result('p1'),
      result('p2'),
      ai('answer two'),
    ];
    // keepRecent 2 would start the tail at the second result of the parallel call.
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 2 });
    expect(out.changed).toBe(true);
    expect(toolPairsIntact(out.messages)).toBe(true);
    expect(out.messages.slice(1)).toEqual(messages.slice(3));
  });

  it('pairs a result with the NEAREST call that issued its id, so a reused id does not widen to the head', async () => {
    // Two turns whose tool calls carry the same id — what a replayed fixture and some providers
    // produce. The cut lands on the second result; its call is the message just before it.
    const messages = [
      h('one'),
      aiCalling({ id: 'reused' }),
      result('reused', 'first result'),
      ai('answer one'),
      h('two'),
      aiCalling({ id: 'reused' }),
      result('reused', 'second result'),
      ai('answer two'),
    ];
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 2 });
    expect(out.changed).toBe(true);
    expect(out.removedCount).toBe(5);
    expect(out.keptCount).toBe(3);
    expect(out.messages.slice(1)).toEqual(messages.slice(5));
    expect(toolPairsIntact(out.messages)).toBe(true);
  });

  it('does not widen when the tail already begins at the pair (the call itself)', () => {
    const messages = toolHeavy();
    // The last 7 begin exactly at the AI message issuing c2: nothing to widen.
    expect(compactionCutIndex(messages, 7)).toBe(5);
  });

  it('folds nothing when widening would reach the head of the conversation', async () => {
    // One turn, one giant pair: the tail wants 2 but the pair starts at the first message.
    const messages = [aiCalling({ id: 'only' }), result('only'), ai('done')];
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 2 });
    expect(out.changed).toBe(false);
    expect(out.messages).toEqual(messages);
  });
});

describe('GS2-23 compactMessages — invariant (b): the system prompt survives, the summary is a HumanMessage', () => {
  const withSystem = () => [
    sys('You are the system prompt.'),
    h('one'),
    ai('answer one'),
    h('two'),
    ai('answer two'),
    h('three'),
    ai('answer three'),
  ];

  it('leaves a leading system prompt first and untouched, and never folds it', async () => {
    const messages = withSystem();
    const summarize = stubSummarizer();
    const out = await compactMessages({ messages, summarize, keepRecent: 2 });

    expect(out.changed).toBe(true);
    expect(out.messages[0]).toBe(messages[0]);
    expect(types(out.messages)).toEqual(['system', 'human', 'human', 'ai']);
    // The system prompt is not part of what the model is asked to summarise.
    expect(summarize.mock.calls[0][0].some((m) => SystemMessage.isInstance(m))).toBe(false);
    expect(summarize.mock.calls[0][0]).toEqual(messages.slice(1, 5));
  });

  it('carries the summary as a marked HumanMessage, not a SystemMessage', async () => {
    const out = await compactMessages({
      messages: withSystem(),
      summarize: stubSummarizer(),
      keepRecent: 2,
    });
    const summary = out.messages[1];
    expect(HumanMessage.isInstance(summary)).toBe(true);
    expect(SystemMessage.isInstance(summary)).toBe(false);
    expect(summary.additional_kwargs.lc_source).toBe(COMPACTION_SUMMARY_SOURCE);
    expect(isCompactionSummary(summary)).toBe(true);
    expect(String(summary.content)).toBe(
      `${COMPACTION_SUMMARY_PREFIX}\n\nSUMMARY OF THE OLDER TURNS`
    );
    // No system message anywhere but the head.
    expect(out.messages.slice(1).some((m) => SystemMessage.isInstance(m))).toBe(false);
  });
});

describe('GS2-23 compactMessages — invariant (c): the end of the conversation is never truncated', () => {
  it('a history ending on the pending user turn still ends on that very message', async () => {
    const pending = h('the question the model has not answered yet');
    const messages = [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3'), pending];
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 3 });

    expect(out.changed).toBe(true);
    expect(out.messages[out.messages.length - 1]).toBe(pending);
    expect(AIMessage.isInstance(out.messages[out.messages.length - 1])).toBe(false);
  });

  it('a completed exchange still ends on the same assistant message it ended on', async () => {
    const last = ai('a3');
    const messages = [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), last];
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 2 });
    expect(out.messages[out.messages.length - 1]).toBe(last);
    // The shape the providers see: summary, then the kept tail — two human turns adjacent.
    expect(types(out.messages)).toEqual(['human', 'human', 'ai']);
  });
});

describe('GS2-23 compactMessages — invariant (d): compacting twice leaves exactly one summary', () => {
  const summaries = (messages: readonly BaseMessage[]) => messages.filter(isCompactionSummary);

  it('folds the previous summary into the new one instead of nesting or keeping it', async () => {
    const summarize = stubSummarizer();
    const first = await compactMessages({
      messages: [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3')],
      summarize,
      keepRecent: 2,
    });
    expect(summaries(first.messages)).toHaveLength(1);

    const grown = [...first.messages, h('four'), ai('a4'), h('five'), ai('a5')];
    const second = await compactMessages({ messages: grown, summarize, keepRecent: 2 });

    expect(second.changed).toBe(true);
    expect(summaries(second.messages)).toHaveLength(1);
    expect(isCompactionSummary(second.messages[0])).toBe(true);
    expect(second.messages[0]).not.toBe(first.messages[0]);
    // The earlier summary went INTO the summariser's span — it was folded, not dropped or kept.
    expect(summarize.mock.calls[1][0][0]).toBe(first.messages[0]);
    expect(second.removedCount).toBe(5);
  });

  it('does not thrash: a compacted history with nothing new behind the summary is left alone', async () => {
    const summarize = stubSummarizer();
    const first = await compactMessages({
      messages: [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3')],
      summarize,
      keepRecent: 2,
    });
    const again = await compactMessages({ messages: first.messages, summarize, keepRecent: 2 });
    expect(again.changed).toBe(false);
    expect(again.messages).toEqual(first.messages);
    expect(summaries(again.messages)).toHaveLength(1);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("recognises LangChain's own summarization marker — by the marker, not by position", async () => {
    // A history the opt-in middleware already summarised: THEIR summary, then one exchange. With
    // keepRecent 2 the cut lands right behind the summary, so the span is that one message and
    // nothing else: only RECOGNISING the marker makes this the settled, leave-alone case. Read as
    // an ordinary human turn it would be folded into a fresh summary of itself.
    const theirs = new HumanMessage({
      content: 'Here is a summary of the conversation to date:\n\nolder',
      additional_kwargs: { lc_source: 'summarization' },
    });
    const summarize = stubSummarizer();
    const settled = [theirs, h('one'), ai('a1')];
    const untouched = await compactMessages({ messages: settled, summarize, keepRecent: 2 });
    expect(untouched.changed).toBe(false);
    expect(untouched.messages).toEqual(settled);
    expect(summarize).not.toHaveBeenCalled();

    // And once there is new material behind it, their summary goes INTO the span and the history
    // converges to one summary, now marked as ours.
    const grown = [...settled, h('two'), ai('a2')];
    const out = await compactMessages({ messages: grown, summarize, keepRecent: 2 });
    expect(out.changed).toBe(true);
    expect(summaries(out.messages)).toHaveLength(1);
    expect(out.messages[0].additional_kwargs.lc_source).toBe(COMPACTION_SUMMARY_SOURCE);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0][0]).toBe(theirs);
  });
});

describe('GS2-23 compactMessages — the rest of the contract', () => {
  it('a conversation no longer than the kept tail is returned unchanged, with no model call', async () => {
    const messages = [h('one'), ai('a1')];
    const summarize = stubSummarizer();
    const out = await compactMessages({ messages, summarize });
    expect(out).toEqual({
      messages,
      summaryText: '',
      removedCount: 0,
      keptCount: 2,
      changed: false,
    });
    expect(out.messages[0]).toBe(messages[0]);
    expect(summarize).not.toHaveBeenCalled();
    expect(compactionCutIndex(messages)).toBeNull();
    expect(DEFAULT_KEEP_RECENT).toBe(6);
  });

  it('calls the summariser once, with the focus, and puts its text into the summary', async () => {
    const summarize = stubSummarizer();
    const out = await compactMessages({
      messages: [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3')],
      summarize,
      keepRecent: 2,
      focus: 'keep the file names',
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][1]).toBe('keep the file names');
    expect(out.summaryText).toBe('SUMMARY OF THE OLDER TURNS');
  });

  it('an empty summary is an error, never a replacement of history with nothing', async () => {
    await expect(
      compactMessages({
        messages: [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3')],
        summarize: async () => '   ',
        keepRecent: 2,
      })
    ).rejects.toThrow(/empty summary/);
  });

  it('a summariser failure propagates instead of being written into the conversation', async () => {
    await expect(
      compactMessages({
        messages: [h('one'), ai('a1'), h('two'), ai('a2'), h('three'), ai('a3')],
        summarize: async () => {
          throw new Error('provider down');
        },
        keepRecent: 2,
      })
    ).rejects.toThrow('provider down');
  });

  it('the prompt carries the rendered span and the focus, and the model summariser reads block content', async () => {
    const span = [h('what is in a.txt?'), aiCalling({ id: 'c1' }), result('c1', 'A-CONTENTS')];
    const prompt = buildCompactionPrompt(span, 'file names');
    expect(prompt).toContain('Messages to summarize:');
    expect(prompt).toContain('what is in a.txt?');
    expect(prompt).toContain('A-CONTENTS');
    expect(prompt).toContain('pay particular attention to: file names');
    expect(buildCompactionPrompt(span)).not.toContain('<focus>');

    const invoke = vi.fn(async (_input: string) => ({
      content: [
        { type: 'text', text: 'first ' },
        { type: 'text', text: 'second' },
      ],
    }));
    const summarizer = createModelSummarizer({ invoke });
    expect(await summarizer(span, 'file names')).toBe('first second');
    expect(invoke.mock.calls[0][0]).toBe(prompt);
  });

  it('conversationSize counts text, tool-call arguments and tool results, never tokens', () => {
    const size = conversationSize([
      h('12345'),
      aiCalling({ id: 'c1', args: { path: 'a' } }),
      result('c1', 'xyz'),
    ]);
    expect(size.messages).toBe(3);
    // 5 (text) + 'read_file' (9) + '{"path":"a"}' (12) + 3 (result).
    expect(size.characters).toBe(5 + 9 + 12 + 3);
    expect(conversationSize([])).toEqual({ messages: 0, characters: 0 });
  });

  it('replaceGraphMessages writes REMOVE_ALL followed by the replacement, through updateState', async () => {
    const updateState = vi.fn(async () => undefined);
    const replacement = [createCompactionSummaryMessage('s'), h('kept')];
    await replaceGraphMessages({ updateState }, { configurable: { thread_id: 't' } }, replacement);
    expect(updateState).toHaveBeenCalledTimes(1);
    const [config, values] = updateState.mock.calls[0] as unknown as [
      { configurable: { thread_id: string } },
      { messages: BaseMessage[] },
    ];
    expect(config.configurable.thread_id).toBe('t');
    expect(RemoveMessage.isInstance(values.messages[0])).toBe(true);
    expect(values.messages[0].id).toBe(REMOVE_ALL_MESSAGES);
    expect(values.messages.slice(1)).toEqual(replacement);
  });
});

/** Load a provider's converter module by file path from its package entry (see the file doc). */
async function loadProviderModule<T>(pkg: string, relativeFromDist: string): Promise<T> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(pkg);
  // Both packages resolve their entry to `<pkg>/dist/index.cjs`; the ESM twin sits beside it.
  const file = resolve(dirname(entry), relativeFromDist);
  return (await import(pathToFileURL(file).href)) as T;
}

type AnthropicPayload = {
  system: unknown;
  messages: {
    role: string;
    content: string | { type: string; id?: string; tool_use_id?: string }[];
  }[];
};
type GeminiContent = {
  role: string;
  parts: { text?: string; functionCall?: { name: string }; functionResponse?: { name: string } }[];
};

/**
 * A tool-calling AI message as Gemini's own responses are shaped: the call is a `functionCall`
 * content block AND a `tool_calls` entry. The legacy Google converter reads the block, not the
 * entry, so a Gemini-shaped history has to carry it that way to be Gemini-shaped at all.
 */
const geminiCalling = (id: string) =>
  new AIMessage({
    content: [
      { type: 'functionCall', functionCall: { name: 'read_file', args: { path: `${id}.txt` } } },
    ],
    tool_calls: [{ id, name: 'read_file', args: { path: `${id}.txt` } }],
  });

describe('GS2-23 compactMessages — the compacted shape through the real provider converters', () => {
  /**
   * A compaction over a tool-heavy history with an in-band system prompt, ending on a pending
   * user turn. `keepRecent: 5` starts the kept tail on a HUMAN turn, so the summary and the first
   * kept message are adjacent user turns — the case each converter was measured on.
   */
  const compacted = async (calling: (id: string) => AIMessage) => {
    const messages = [
      sys('SYSTEM PROMPT'),
      h('one'),
      calling('c1'),
      result('c1'),
      ai('answer one'),
      h('two'),
      calling('c2'),
      result('c2'),
      ai('answer two'),
      h('three'),
      calling('c3'),
      result('c3'),
      ai('answer three'),
      h('four'),
    ];
    const out = await compactMessages({ messages, summarize: stubSummarizer(), keepRecent: 5 });
    expect(out.changed).toBe(true);
    expect(types(out.messages)).toEqual(['system', 'human', 'human', 'ai', 'tool', 'ai', 'human']);
    return out.messages;
  };

  it('Anthropic: no mid-list system, pairs intact, consecutive user turns passed through, no trailing assistant', async () => {
    const { _convertMessagesToAnthropicPayload } = await loadProviderModule<{
      _convertMessagesToAnthropicPayload: (messages: BaseMessage[]) => AnthropicPayload;
    }>('@langchain/anthropic', 'utils/message_inputs.js');

    const messages = await compacted((id) => aiCalling({ id }));
    const payload = _convertMessagesToAnthropicPayload(messages);

    // The system prompt went where Anthropic wants it, and the summary did not.
    expect(payload.system).toBe('SYSTEM PROMPT');
    expect(payload.messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(payload.messages[0].role).toBe('user');
    expect(JSON.stringify(payload.messages[0].content)).toContain(COMPACTION_SUMMARY_PREFIX);
    // Measured converter behaviour: the summary and the first kept turn arrive as two `user`
    // turns; the Messages API combines consecutive same-role turns, so the shape is accepted.
    expect(payload.messages[1].role).toBe('user');
    // Every tool_result names a tool_use that precedes it.
    const seenUses = new Set<string>();
    for (const message of payload.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id) seenUses.add(block.id);
        if (block.type === 'tool_result') expect(seenUses.has(block.tool_use_id ?? '')).toBe(true);
      }
    }
    // The pending user turn is still the last thing the model sees — no silent prefill.
    expect(payload.messages[payload.messages.length - 1].role).toBe('user');

    // CONTROL 1 — the shape this mechanism avoids: a summary carried as a mid-list SystemMessage
    // is rejected by this converter, which is why the summary is a HumanMessage.
    const asSystem = [messages[0], new SystemMessage('summary'), ...messages.slice(2)];
    expect(() => _convertMessagesToAnthropicPayload(asSystem)).toThrow(
      'System messages are only permitted as the first passed message.'
    );
    // CONTROL 2 — a split pair reaches the wire as a tool_result with no tool_use before it, which
    // the check above would catch: the assertion can fail.
    const split = messages.filter(
      (m) => !(AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0)
    );
    const splitPayload = _convertMessagesToAnthropicPayload(split);
    const orphan = splitPayload.messages.some(
      (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result')
    );
    expect(orphan).toBe(true);
    expect(
      splitPayload.messages.some(
        (m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_use')
      )
    ).toBe(false);
  });

  it('Gemini: roles alternate after the converter merges the adjacent user turns, function pairs intact', async () => {
    const { convertMessagesToGeminiContents, convertMessagesToGeminiSystemInstruction } =
      await loadProviderModule<{
        convertMessagesToGeminiContents: (messages: BaseMessage[]) => GeminiContent[];
        convertMessagesToGeminiSystemInstruction: (
          messages: BaseMessage[]
        ) => { parts: { text?: string }[] } | undefined;
      }>('@langchain/google', 'converters/messages.js');

    const messages = await compacted(geminiCalling);
    const contents = convertMessagesToGeminiContents(messages);

    // The system prompt is a system instruction, and the summary is not in it.
    const instruction = convertMessagesToGeminiSystemInstruction(messages);
    expect(JSON.stringify(instruction)).toContain('SYSTEM PROMPT');
    expect(JSON.stringify(instruction)).not.toContain(COMPACTION_SUMMARY_PREFIX);
    // Measured converter behaviour: the summary and the kept turn after it are merged into ONE
    // user content, so the roles strictly alternate on the wire.
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts.some((p) => p.text?.includes(COMPACTION_SUMMARY_PREFIX))).toBe(true);
    for (let i = 1; i < contents.length; i++)
      expect(contents[i].role).not.toBe(contents[i - 1].role);
    // Every functionResponse follows a functionCall of the same name.
    const calls: string[] = [];
    for (const content of contents) {
      for (const part of content.parts) {
        if (part.functionCall) calls.push(part.functionCall.name);
        if (part.functionResponse) expect(calls).toContain(part.functionResponse.name);
      }
    }
    expect(contents[contents.length - 1].role).toBe('user');

    // CONTROL — a split pair is a hard error in this converter: the tool result's call is gone.
    const split = messages.filter(
      (m) => !(AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0)
    );
    expect(() => convertMessagesToGeminiContents(split)).toThrow();
  });
});
