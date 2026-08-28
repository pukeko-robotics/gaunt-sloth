import { describe, expect, it } from 'vitest';
import { AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import { toolStatusDisplay } from '@gaunt-sloth/core/core/toolDisplay.js';

/**
 * [[TUI-C100]] — **what the row SAYS, folded from what the agent actually emits.**
 *
 * The core specs assert the event stream and `viewModel.spec.ts` asserts the reducer; neither of
 * them alone can catch this defect, because it lives in the join: the events were honest about
 * nothing in particular and the reducer faithfully rendered them as a finished call. So this drives
 * the real `processEventStream` over a two-call round — the first call's result lands, the second's
 * does not, which is what a call held at the approval gate looks like — folds the events it emits
 * with the real `foldEvents`, and reads the row.
 *
 * `toolStatusDisplay` is included because the row's words are what the human acts on: `done`, in the
 * success tone, next to a tick, one line above a question asking whether the command may run.
 */

/** The chunk stream shape `processEventStream` consumes: `[message, metadata]` pairs. */
function streamOf(messages: unknown[]) {
  return (async function* () {
    for (const message of messages) yield [message, {}];
  })();
}

/** Drive a bare agent over a scripted stream and collect the typed events it emits. */
async function eventsOf(messages: unknown[]): Promise<AgentStreamEvent[]> {
  const { GthAbstractAgent } = await import('@gaunt-sloth/core/core/GthAbstractAgent.js');
  class TestAgent extends GthAbstractAgent {
    async init(): Promise<void> {
      /* the graph is injected directly */
    }
  }
  const agent = new TestAgent(() => {}) as unknown as {
    config: unknown;
    agent: unknown;
    streamWithEvents: (m: unknown[], c: unknown) => AsyncGenerator<AgentStreamEvent>;
  };
  agent.config = { writeBinaryOutputsToFile: false };
  agent.agent = {
    async stream() {
      return streamOf(messages);
    },
  };
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.streamWithEvents([], { configurable: { thread_id: 't' } })) {
    events.push(event);
  }
  return events;
}

/** A read that returns, and a shell command a gate holds — in ONE assistant message. */
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

async function foldGatedRound() {
  const { foldEventSequence } = await import('#src/tui/viewModel.js');
  const events = await eventsOf([
    twoCallRound(),
    new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'call-read' }),
  ]);
  const vm = foldEventSequence(events);
  const tools = vm.segments.filter((s) => s.kind === 'tool').map((s) => (s as { tool: any }).tool);
  return {
    read: tools.find((t) => t.id === 'call-read'),
    gated: tools.find((t) => t.id === 'call-shell'),
  };
}

describe('[[TUI-C100]] a call held at the approval gate does not render as done', () => {
  it('the gated sibling is not done when its returning sibling’s result lands', async () => {
    const { gated } = await foldGatedRound();
    expect(gated).toBeDefined();
    expect(gated.status).not.toBe('done');
  });

  /**
   * The control that makes the assertion above mean something: the call that DID finish still says
   * so. A build that had simply stopped ending calls would pass the first cell and fail this one.
   */
  it('the sibling that returned is still done', async () => {
    const { read } = await foldGatedRound();
    expect(read.status).toBe('done');
    expect(read.result).toBe('[FILE] start.js');
  });

  /** The gated call is on screen, with the arguments the human is being asked to rule on. */
  it('the gated call is rendered, named, with its arguments', async () => {
    const { gated } = await foldGatedRound();
    expect(gated.name).toBe('run_shell_command');
    expect(JSON.parse(gated.argsText)).toEqual({
      command: 'git clone https://example.invalid/x',
    });
  });

  /**
   * And the words. `done` in the success tone is what the row used to claim; the finished sibling
   * is the one entitled to it.
   */
  it('the tick and the word “done” belong to the finished call only', async () => {
    const { read, gated } = await foldGatedRound();
    expect(
      toolStatusDisplay({ isError: read.isError, raterClarification: read.raterClarification })
    ).toEqual({ glyph: '✓', label: 'done', tone: 'success' });
    // The gated row never reaches the branch that produces those words: it is not `done`.
    expect(gated.status).toBe('running');
  });

  /**
   * A single gated call, the case that has no sibling to flush it — the control for the whole
   * mechanism. It has always been drawn as running; it still is.
   */
  it('a lone gated call is not done either', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const events = await eventsOf([
      new AIMessageChunk({
        content: '',
        tool_call_chunks: [
          { id: 'call-only', name: 'run_shell_command', args: '{"command":"ls"}', index: 0 },
        ],
      }),
    ]);
    const vm = foldEventSequence(events);
    const tools = vm.segments
      .filter((s) => s.kind === 'tool')
      .map((s) => (s as { tool: any }).tool);
    expect(tools.every((t) => t.status !== 'done')).toBe(true);
  });

  /**
   * The other direction, which an over-eager fix breaks silently: a round where both results land
   * still ends both rows. A row that never leaves *running* is a different wrong answer to the same
   * question, and it fails quietly.
   */
  it('both rows reach done once both results land', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const events = await eventsOf([
      twoCallRound(),
      new ToolMessage({ content: '[FILE] start.js', tool_call_id: 'call-read' }),
      new ToolMessage({ content: 'cloned', tool_call_id: 'call-shell' }),
    ]);
    const vm = foldEventSequence(events);
    const tools = vm.segments
      .filter((s) => s.kind === 'tool')
      .map((s) => (s as { tool: any }).tool);
    expect(tools.map((t) => t.status)).toEqual(['done', 'done']);
  });

  /**
   * [[TUI-C69]] §5.4 — and the two rows that were already right stay right: a refused call is an
   * error, a rating rejection is a clarification request. The fix is about the window BEFORE a
   * result, so neither of these is touched by it.
   */
  it('leaves the error and rater-clarification rows exactly as they were', async () => {
    const { foldEventSequence } = await import('#src/tui/viewModel.js');
    const events: AgentStreamEvent[] = [
      { type: 'tool_start', id: 'a', name: 'run_shell_command' },
      { type: 'tool_args', id: 'a', delta: '{"command":"boom"}' },
      { type: 'tool_end', id: 'a' },
      { type: 'tool_result', id: 'a', content: 'exit 1', isError: true },
      { type: 'tool_start', id: 'b', name: 'run_shell_command' },
      { type: 'tool_args', id: 'b', delta: '{"command":"rm -rf /"}' },
      { type: 'tool_end', id: 'b' },
      {
        type: 'tool_result',
        id: 'b',
        content: 'narrow it',
        isError: true,
        raterClarification: true,
      },
    ];
    const vm = foldEventSequence(events);
    const tools = vm.segments
      .filter((s) => s.kind === 'tool')
      .map((s) => (s as { tool: any }).tool);
    expect(toolStatusDisplay({ isError: tools[0].isError })).toEqual({
      glyph: '✗',
      label: 'error',
      tone: 'error',
    });
    expect(
      toolStatusDisplay({
        isError: tools[1].isError,
        raterClarification: tools[1].raterClarification,
      })
    ).toEqual({
      glyph: '⚠',
      label: 'auto-rater: clarification requested',
      tone: 'warn',
    });
  });
});
