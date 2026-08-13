/**
 * CFG-42 — a subagent's private reasoning must not reach its parent as the delegation's result.
 *
 * deepagents' `task` tool builds the parent's `ToolMessage` from the subagent's last AI message
 * text. Gemini returns a thought summary as a content block marked `thought: true` and typed
 * `text` exactly like an answer block, so `BaseMessage.text` folds the thinking into the answer and
 * the parent model reads the child's reasoning as its report. Measured on the unfixed path, the
 * parent received `"<the thinking><the answer>"` — concatenated with no separator, which is why the
 * redaction has to happen while the content is still a block array and cannot be a string filter on
 * the result.
 *
 * Driven against the REAL deepagents graph with a scripted model: the shape that reaches the result
 * builder is the thing most likely to be assumed wrong (`task`'s own
 * `INVALID_TOOL_MESSAGE_BLOCK_TYPES` filter guards a different branch — the one taken when the tool
 * is called WITHOUT a tool-call id — while the delegation path applies no block filter at all), so a
 * test over the filter function alone would prove nothing about the path that actually leaks.
 */
import { describe, expect, it } from 'vitest';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent, createSubAgent, GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import * as z from 'zod';
import { buildGeneralPurposeSubagent } from '#src/core/subagentThoughtRedaction.js';

const THOUGHT_TEXT = 'THINKING: the user is probably wrong, but I will humour them.';
const SECOND_THOUGHT_TEXT = 'THINKING: better check the tool result before I answer.';
const ANSWER_TEXT = 'There are 9 sheep left.';
const CALL_SIGNATURE = 'SIGNATURE-ON-THE-FUNCTION-CALL';

/** A Gemini thought summary, in the exact shape `@langchain/google` builds from a thought part. */
function geminiThoughtBlock(text: string) {
  return {
    thought: true,
    thoughtSignature: 'SIGNATURE-ON-THE-THOUGHT-PART',
    type: 'text',
    text,
  };
}

const echoTool = tool(async ({ value }: { value: string }) => `echoed:${value}`, {
  name: 'echo',
  description: 'Echo a value back.',
  schema: z.object({ value: z.string() }),
});

/**
 * The child's first turn, as `@langchain/google` builds it: a thought summary beside a function
 * call, with the signature that actually replays riding on the `functionCall` part (and on the
 * `tool_calls` entry derived from it).
 */
const CHILD_TOOL_CALL_TURN = {
  content: [
    geminiThoughtBlock(THOUGHT_TEXT),
    {
      type: 'functionCall',
      thoughtSignature: CALL_SIGNATURE,
      functionCall: { name: 'echo', args: { value: 'sheep' } },
    },
  ],
  tool_calls: [
    {
      type: 'tool_call',
      name: 'echo',
      args: { value: 'sheep' },
      id: 'child-echo-1',
      thoughtSignature: CALL_SIGNATURE,
    },
  ],
};

/** The child's final turn: more thinking, then the answer the parent is entitled to see. */
const CHILD_ANSWER_TURN = {
  content: [geminiThoughtBlock(SECOND_THOUGHT_TEXT), { type: 'text', text: ANSWER_TEXT }],
};

/**
 * Scripts a two-level conversation with no provider: the parent delegates once, the child runs the
 * turns it was given. The two levels are told apart by the FIRST human message — for a subagent
 * that is the `description` the `task` call carried, since deepagents replaces the child's message
 * list with exactly that one message.
 */
class ScriptedDelegationModel extends BaseChatModel {
  parentCalls = 0;
  childCalls = 0;
  constructor(private readonly childTurns: (Record<string, unknown> | AIMessage)[]) {
    super({});
  }
  _llmType(): string {
    return 'scripted-delegation';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const first = messages.find((m) => HumanMessage.isInstance(m));
    const isChild =
      typeof first?.content === 'string' && first.content.includes('CHILD: answer the question');
    let message: AIMessage;
    if (isChild) {
      const turn = this.childTurns[Math.min(this.childCalls, this.childTurns.length - 1)];
      this.childCalls++;
      // A turn given as a message instance is used AS IS, so a spec can put an AIMessageChunk —
      // what the streaming path leaves in state — through the very same graph.
      message = AIMessage.isInstance(turn) ? turn : new AIMessage(turn as never);
    } else if (messages.some((m) => ToolMessage.isInstance(m))) {
      message = new AIMessage('relayed');
    } else {
      this.parentCalls++;
      message = new AIMessage({
        content: '',
        tool_calls: [
          {
            name: 'task',
            args: { description: 'CHILD: answer the question', subagent_type: 'general-purpose' },
            id: `parent-${this.parentCalls}`,
          },
        ],
      });
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

/**
 * Run one delegation through the real graph and hand back what the `task` tool reported to the
 * parent. `redact: false` reproduces stock deepagents (its own auto-added general-purpose
 * subagent), which is what makes the pair of runs a measurement rather than an assertion of intent.
 */
async function delegate(
  childTurns: Record<string, unknown>[],
  threadId: string,
  options: { redact: boolean }
): Promise<string> {
  const model = new ScriptedDelegationModel(childTurns);
  const graph = createDeepAgent({
    model: model as never,
    tools: [echoTool],
    subagents: options.redact
      ? [buildGeneralPurposeSubagent({ model, tools: [echoTool] }) as never]
      : [],
    checkpointer: new MemorySaver(),
  });
  const result = (await graph.invoke(
    { messages: [new HumanMessage('delegate it')] },
    { configurable: { thread_id: threadId }, recursionLimit: 30 }
  )) as { messages: BaseMessage[] };
  // Without this the assertions below would pass on a run in which nothing was delegated at all.
  expect(model.childCalls).toBeGreaterThan(0);
  const toolMessage = result.messages.find(
    (m) => ToolMessage.isInstance(m) && m.name === 'task'
  ) as ToolMessage;
  expect(toolMessage).toBeDefined();
  return typeof toolMessage.content === 'string'
    ? toolMessage.content
    : JSON.stringify(toolMessage.content);
}

describe("CFG-42 — the parent reads the subagent's answer, not its thinking", () => {
  it('keeps a Gemini thought summary out of the task tool result', async () => {
    const reported = await delegate([CHILD_ANSWER_TURN], 'cfg42-thought', { redact: true });

    expect(reported).not.toContain(SECOND_THOUGHT_TEXT);
    // …while the answer still gets through, so this is not passing by reporting nothing.
    expect(reported).toBe(ANSWER_TEXT);
  });

  it('leaks it without the redaction — the harness can see the difference', async () => {
    // The defect itself, measured on the same graph and the same script. Without this the test
    // above could be green on a harness that never produced a thought part in the first place.
    const reported = await delegate([CHILD_ANSWER_TURN], 'cfg42-unfixed', { redact: false });

    expect(reported).toBe(`${SECOND_THOUGHT_TEXT}${ANSWER_TEXT}`);
  });

  it('redacts across a tool-calling turn too, not just the final message', async () => {
    const reported = await delegate([CHILD_TOOL_CALL_TURN, CHILD_ANSWER_TURN], 'cfg42-tools', {
      redact: true,
    });

    expect(reported).toBe(ANSWER_TEXT);
    expect(reported).not.toContain(THOUGHT_TEXT);
  });

  /**
   * The discriminating control. A delegation whose result carries no reasoning block must come back
   * exactly as stock deepagents would report it — a redaction that mangles ordinary results is a
   * regression, not a fix. The two runs are compared to each other rather than to a literal, so
   * this stays honest if the result builder ever changes what it reports.
   */
  it('reports an ordinary result byte-identically, with and without the redaction', async () => {
    const plainTurn = { content: [{ type: 'text', text: ANSWER_TEXT }] };

    const withRedaction = await delegate([plainTurn], 'cfg42-control-on', { redact: true });
    const withoutRedaction = await delegate([plainTurn], 'cfg42-control-off', { redact: false });

    expect(withRedaction).toBe(withoutRedaction);
    expect(withRedaction).toBe(ANSWER_TEXT);
  });
});

/**
 * The subagent's own message list, which the `task` tool reads but never hands to the parent
 * (deepagents excludes `messages` from the state update a delegation returns). Invoking the
 * compiled subagent directly is the only place these are observable, and two things have to hold
 * there: the redaction REPLACES messages rather than appending clean copies beside the dirty ones,
 * and it leaves the parts that carry thought signatures alone.
 */
describe('CFG-42 — what the redaction does to the subagent’s own messages', () => {
  async function runSubagent(childTurns: (Record<string, unknown> | AIMessage)[], redact: boolean) {
    const model = new ScriptedDelegationModel(childTurns);
    const spec = redact
      ? buildGeneralPurposeSubagent({ model, tools: [echoTool] })
      : { ...GENERAL_PURPOSE_SUBAGENT, model: model as never, tools: [echoTool] as never };
    const subagent = createSubAgent(spec as never);
    const result = (await subagent.invoke(
      { messages: [new HumanMessage('CHILD: answer the question')] },
      { recursionLimit: 30 }
    )) as { messages: BaseMessage[] };
    return result.messages;
  }

  it('replaces the redacted messages instead of appending copies of them', async () => {
    const turns = [CHILD_TOOL_CALL_TURN, CHILD_ANSWER_TURN];
    const redacted = await runSubagent(turns, true);
    const untouched = await runSubagent(turns, false);

    // A copy that lost its id would be APPENDED by the messages reducer, leaving the original
    // (leaking) message in the list — and the result builder's backward scan would still find the
    // clean copy first, so a content-only assertion would pass on that broken shape.
    expect(redacted).toHaveLength(untouched.length);
    expect(redacted.map((m) => m.getType())).toEqual(untouched.map((m) => m.getType()));
    // Exactly one assistant message carries the tool call, rather than a dirty one and a clean one.
    expect(
      redacted.filter((m) => AIMessage.isInstance(m) && (m.tool_calls?.length ?? 0) > 0)
    ).toHaveLength(1);
    expect(new Set(redacted.map((m) => m.id)).size).toBe(redacted.length);
  });

  it('drops the thought parts and keeps every signature-bearing part', async () => {
    const messages = await runSubagent([CHILD_TOOL_CALL_TURN, CHILD_ANSWER_TURN], true);
    const assistant = messages.filter((m) => AIMessage.isInstance(m)) as AIMessage[];
    const blocks = assistant.flatMap((m) => (Array.isArray(m.content) ? m.content : []));

    // No thinking survives anywhere in the child's own history…
    expect(blocks.some((b) => (b as { thought?: unknown }).thought === true)).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain(THOUGHT_TEXT);
    expect(JSON.stringify(blocks)).not.toContain(SECOND_THOUGHT_TEXT);

    // …and the parts that actually carry a signature on replay are untouched. `@langchain/google`
    // rebuilds a text part as `{ text }` alone (dropping `thought`/`thoughtSignature`), so a text
    // part's signature was never replayed in the first place; a `functionCall` part is spread
    // whole, which is what makes THIS the assertion worth making.
    const functionCalls = blocks.filter(
      (b) => (b as { type?: string }).type === 'functionCall'
    ) as { thoughtSignature?: string }[];
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0].thoughtSignature).toBe(CALL_SIGNATURE);

    const withToolCalls = assistant.find((m) => (m.tool_calls?.length ?? 0) > 0);
    expect(
      (withToolCalls?.tool_calls?.[0] as { thoughtSignature?: string })?.thoughtSignature
    ).toBe(CALL_SIGNATURE);
    // The tool call still resolved, so the redaction did not break the turn it rode on.
    expect(messages.some((m) => ToolMessage.isInstance(m) && m.content === 'echoed:sheep')).toBe(
      true
    );
  });

  /**
   * The streaming path leaves an `AIMessageChunk` in state, and `AIMessage.isInstance` matches one,
   * so this branch runs in production on every streamed run. Two things are easy to lose in a copy
   * and neither is visible from the parent: the concrete class, and `tool_call_chunks` — a chunk
   * rebuilt without that field comes back with an EMPTY chunk list rather than the one it had.
   */
  it('keeps a streamed chunk a chunk, with its tool-call chunks intact', async () => {
    const streamedTurn = new AIMessageChunk({
      content: [
        geminiThoughtBlock(THOUGHT_TEXT),
        {
          type: 'functionCall',
          thoughtSignature: CALL_SIGNATURE,
          functionCall: { name: 'echo', args: { value: 'sheep' } },
        },
      ] as never,
      tool_call_chunks: [
        {
          type: 'tool_call_chunk',
          name: 'echo',
          args: '{"value":"sheep"}',
          id: 'child-echo-1',
          index: 0,
        },
      ],
    });

    const messages = await runSubagent([streamedTurn, CHILD_ANSWER_TURN], true);
    const redactedChunk = messages.find((m) => AIMessageChunk.isInstance(m)) as AIMessageChunk;

    expect(redactedChunk).toBeDefined();
    expect(redactedChunk.constructor).toBe(AIMessageChunk);
    expect(redactedChunk.tool_call_chunks).toEqual(streamedTurn.tool_call_chunks);
    expect(redactedChunk.tool_calls?.[0]?.name).toBe('echo');
    // …and it really was redacted, so this is not passing on an untouched message.
    expect(JSON.stringify(redactedChunk.content)).not.toContain(THOUGHT_TEXT);
    expect(JSON.stringify(redactedChunk.content)).toContain(CALL_SIGNATURE);
  });
});
