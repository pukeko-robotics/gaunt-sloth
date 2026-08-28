import { describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '#src/core/types.js';

/**
 * [[TUI-C100]] — **`tool_end` says a call has ENDED, and a call that has not run has not ended.**
 *
 * One assistant message can carry several tool calls, and they do not finish together: the round's
 * first `ToolMessage` is what makes the aggregated chunk's arguments complete, so it is where every
 * call in the message gets its `tool_start` and `tool_args`. Ending them all there too is the
 * defect this file pins — the sibling still queued, or held at the approval gate for a human to
 * rule on, was reported finished before it was dispatched, and the surfaces that read the event say
 * so in the affirmative (the Ink TUI draws a ✓ and the word *done*) one row above the question
 * asking whether it may run at all.
 *
 * The split the fix rests on: **`tool_start`/`tool_args` are honest at flush time** (the model has
 * finished emitting the arguments — that is exactly what the aggregate becoming complete means),
 * **`tool_end` is not**, and it moves to the point where the call's own result is known.
 *
 * What closes a call that never produces a result is deliberately NOT here. `processEventStream`
 * cannot tell a terminal call from one suspended at the approval gate — both leave the stream with
 * the call unresolved, and the gate's prompt is opened by the runner AFTER this generator has
 * returned ({@link GthAgentRunner.processMessagesWithEvents} yields the stream to completion and
 * only then calls `resolveToolInterruptsWithEvents`). Closing them here would put the tick back on
 * screen a moment before the human is asked. The turn's end is the first place the distinction
 * exists, so that is where the drain lives; `GthAgentRunner.spec.ts` holds those cells.
 */

/** The chunk stream shape `processEventStream` consumes: `[message, metadata]` pairs. */
function streamOf(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) yield [message, {}];
  })();
}

/** A bare {@link GthAbstractAgent} over a scripted chunk stream — no graph, no model. */
async function agentOver(messages: unknown[]) {
  const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');
  class TestAgent extends GthAbstractAgent {
    async init(): Promise<void> {
      /* the graph is injected directly */
    }
  }
  const agent = new TestAgent(() => {}) as unknown as {
    config: unknown;
    agent: unknown;
    streamWithEvents: (messages: unknown[], runConfig: unknown) => AsyncGenerator<AgentStreamEvent>;
  };
  agent.config = { writeBinaryOutputsToFile: false };
  agent.agent = {
    async stream() {
      return streamOf(messages);
    },
  };
  return agent;
}

/** Drive one scripted stream and collect every event it yields, in order. */
async function eventsOf(messages: unknown[]): Promise<AgentStreamEvent[]> {
  const agent = await agentOver(messages);
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.streamWithEvents([], { configurable: { thread_id: 't' } })) {
    events.push(event);
  }
  return events;
}

/** `[type, id]` for every tool event, which is the ordering this file is about. */
const toolTrace = (events: AgentStreamEvent[]): Array<[string, string | undefined]> =>
  events.filter((e) => e.type.startsWith('tool_')).map((e) => [e.type, (e as { id?: string }).id]);

/** A two-call assistant message: a read that returns, and a shell command a gate will hold. */
const twoCallRound = () =>
  new AIMessageChunk({
    content: '',
    tool_call_chunks: [
      { id: 'call-read', name: 'list_directory', args: '{"path":"/tmp"}', index: 0 },
      {
        id: 'call-shell',
        name: 'run_shell_command',
        args: '{"command":"git clone https://example.invalid/x"}',
        index: 1,
      },
    ],
  });

describe('[[TUI-C100]] tool_end timing in processEventStream', () => {
  /**
   * **The node.** The first call's result lands; the second call is the one at the approval gate,
   * so its `ToolMessage` never arrives in this stream. It must not be told it ended.
   */
  it('does not end a sibling whose own result has not arrived', async () => {
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({
        content: '[FILE] start.js',
        tool_call_id: 'call-read',
      }),
    ]);

    const endedIds = events
      .filter((e) => e.type === 'tool_end')
      .map((e) => (e as { id: string }).id);
    expect(endedIds).not.toContain('call-shell');
    expect(endedIds).toEqual(['call-read']);
  });

  /**
   * The gated sibling is still ANNOUNCED, with its arguments — that half of the flush is honest and
   * is what puts the call on screen at all. Losing it would trade a wrong row for a missing one,
   * and the arguments are what the human is being asked to rule on.
   */
  it('still announces the sibling and its arguments at flush time', async () => {
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({
        content: '[FILE] start.js',
        tool_call_id: 'call-read',
      }),
    ]);

    expect(events).toContainEqual({
      type: 'tool_start',
      id: 'call-shell',
      name: 'run_shell_command',
    });
    const args = events.find(
      (e) => e.type === 'tool_args' && (e as { id: string }).id === 'call-shell'
    );
    expect(JSON.parse((args as { delta: string }).delta)).toEqual({
      command: 'git clone https://example.invalid/x',
    });
  });

  /**
   * The call whose result DID arrive ends immediately before that result — the ordering every
   * consumer already relies on (the AG-UI bridge maps the pair onto `TOOL_CALL_END` then
   * `TOOL_CALL_RESULT`, and the protocol's own verifier requires the end).
   */
  it('ends the returning call immediately before its result', async () => {
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({
        content: '[FILE] start.js',
        tool_call_id: 'call-read',
      }),
    ]);

    expect(toolTrace(events)).toEqual([
      ['tool_start', 'call-read'],
      ['tool_args', 'call-read'],
      ['tool_start', 'call-shell'],
      ['tool_args', 'call-shell'],
      ['tool_end', 'call-read'],
      ['tool_result', 'call-read'],
    ]);
  });

  /**
   * **The control that behaves correctly today.** A lone gated call has no sibling to flush it, so
   * nothing about it reaches the surface until its result does — which is why the defect went
   * unnoticed, and why a regression in the easy case must not be able to hide behind the hard one.
   */
  it('a single gated call, with no returning sibling, emits nothing that claims it ended', async () => {
    const events = await eventsOf([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { id: 'call-only', name: 'run_shell_command', args: '{"command":"ls"}', index: 0 },
        ],
      }),
    ]);

    expect(events.filter((e) => e.type === 'tool_end')).toEqual([]);
  });

  /**
   * A whole round that completes is unchanged, end to end: both calls end, each before its own
   * result, and the two never cross.
   */
  it('ends each call of a completed round before that call’s own result', async () => {
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'call-read' }),
      new ToolMessage({ content: 'cloned', tool_call_id: 'call-shell' }),
    ]);

    expect(toolTrace(events)).toEqual([
      ['tool_start', 'call-read'],
      ['tool_args', 'call-read'],
      ['tool_start', 'call-shell'],
      ['tool_args', 'call-shell'],
      ['tool_end', 'call-read'],
      ['tool_result', 'call-read'],
      ['tool_end', 'call-shell'],
      ['tool_result', 'call-shell'],
    ]);
  });

  /**
   * An INVALID tool call can never be dispatched — there is no call to run and no `ToolMessage` to
   * wait for — so it is finished at the moment it is surfaced, and it ends inline. Deferring it
   * would leave a row that cannot progress sitting at *running* until the turn ended, for nothing.
   *
   * **The fixture is measured, not assumed.** Two argument payloads are both "malformed" in
   * ordinary speech and LangChain files them in different places: a merely TRUNCATED buffer
   * (`{"comm`) becomes a perfectly valid call with empty args and takes the deferred path above,
   * while two concatenated JSON objects — the shape a local model that ignores
   * `disable_parallel_tool_use` produces when it merges sibling calls' argument buffers — is what
   * actually reaches `invalid_tool_calls`. A spec written from the first would have exercised the
   * wrong branch and passed either way.
   */
  it('ends an invalid tool call inline, because it can never be dispatched', async () => {
    const events = await eventsOf([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { id: 'call-bad', name: 'run_shell_command', args: '{"a":1}{"b":2}', index: 0 },
        ],
      }),
    ]);

    expect(toolTrace(events)).toEqual([
      ['tool_start', 'call-bad'],
      ['tool_args', 'call-bad'],
      ['tool_end', 'call-bad'],
    ]);
  });

  /**
   * The non-chunk `AIMessage` path (a resumed / non-streamed message) merges its calls into the
   * same aggregate, so it inherits the same timing rather than a second one.
   */
  it('applies the same timing to tool calls carried by a non-chunk AIMessage', async () => {
    const events = await eventsOf([
      new AIMessage({
        content: '',
        tool_calls: [
          { name: 'list_directory', args: { path: '/tmp' }, id: 'call-read', type: 'tool_call' },
          {
            name: 'run_shell_command',
            args: { command: 'ls' },
            id: 'call-shell',
            type: 'tool_call',
          },
        ],
      }),
      new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'call-read' }),
    ]);

    const endedIds = events
      .filter((e) => e.type === 'tool_end')
      .map((e) => (e as { id: string }).id);
    expect(endedIds).toEqual(['call-read']);
  });

  /**
   * The `aggregatedAIChunk = null` reset after each round is load-bearing for a reason that has
   * nothing to do with this change — OpenAI restarts `tool_call_chunks.index` at 0 per round, and
   * without the reset round 2's chunks collide with round 1's groups and end up with empty args.
   * `GthLangChainAgent.spec.ts` pins that through the agent; this is the same property at the
   * abstract-agent level, so the line cannot be "simplified" while chasing the timing above.
   */
  it('keeps rounds isolated so a restarted chunk index does not collide (the reset still works)', async () => {
    const events = await eventsOf([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: 'tc-1', name: 'list_directory', args: '', index: 0 }],
      }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: '{"path":"."}', index: 0 }],
      }),
      new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'tc-1' }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ id: 'tc-2', name: 'get_file_info', args: '', index: 0 }],
      }),
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [{ args: '{"path":"start.js"}', index: 0 }],
      }),
      new ToolMessage({ content: 'size: 3001', tool_call_id: 'tc-2' }),
    ]);

    const argEvents = events.filter((e) => e.type === 'tool_args') as Array<{ delta: string }>;
    expect(argEvents).toHaveLength(2);
    expect(JSON.parse(argEvents[0].delta)).toEqual({ path: '.' });
    expect(JSON.parse(argEvents[1].delta)).toEqual({ path: 'start.js' });
  });
});

describe('[[TUI-C100]] the timing holds for the events a renderer folds', () => {
  it('leaves no tool event out of the trace (guard against a silent drop)', async () => {
    vi.resetModules();
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({
        content: '[FILE] start.js',
        tool_call_id: 'call-read',
      }),
    ]);
    // Two starts, two args, one end, one result.
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_args')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });
});
