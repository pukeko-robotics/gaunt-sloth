import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentStreamEvent } from '#src/core/types.js';

/**
 * [[TUI-C69]] §5.4 — **attributing the gate's decision to the call on screen.**
 *
 * Two halves, and the first is what makes the second possible. LangChain's HITL `ActionRequest` is
 * `{ name, args, description }` and carries no id, so a decision about a pending call had nothing to
 * attribute it to; the id is recovered from the same suspended-state snapshot the requests come
 * from. With one in hand, a call the gate refused BACK TO THE AGENT can be named, and both display
 * paths tone its result row as a round of an argument rather than as a failed tool.
 *
 * **`isError` is untouched throughout**, and these cases assert that: the call did not run, which
 * the model, `gth eval`'s tool-result assertions and the ACP bridge all read off that flag.
 */

const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayToolIndication: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  getUseColour: vi.fn(() => false),
  stdout: { isTTY: false, write: vi.fn() },
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const runConfig: RunnableConfig = { configurable: { thread_id: 't1' } };

/** A suspended-graph snapshot in the shape LangGraph's `getState` returns at a HITL interrupt. */
const suspendedState = (
  toolCalls: Array<{ name: string; args: Record<string, unknown>; id: string }>,
  requests: Array<{ name: string; args: Record<string, unknown> }>
) => ({
  tasks: [{ interrupts: [{ value: { actionRequests: requests } }] }],
  values: {
    messages: [
      new AIMessage({ content: 'earlier turn' }),
      new AIMessage({
        content: '',
        tool_calls: toolCalls.map((c) => ({ ...c, type: 'tool_call' as const })),
      }),
    ],
  },
});

async function makeAgent(state: unknown) {
  const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');
  class TestAgent extends GthAbstractAgent {
    async init(): Promise<void> {
      /* graph injected directly */
    }
  }
  const agent = new TestAgent(() => {});
  (agent as any).config = { writeBinaryOutputsToFile: false };
  (agent as any).agent = {
    async invoke() {
      throw new Error('not used');
    },
    async stream() {
      throw new Error('not used');
    },
    async getState() {
      return state;
    },
  };
  return agent as any;
}

describe('[[TUI-C69]] §5.4 — the pending call carries its id, and a refused round is named', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    systemUtilsMock.getUseColour.mockReturnValue(false);
  });

  /**
   * **Measured against a real suspended graph before it was written**: `getState()` at a HITL
   * interrupt does expose `values.messages` with the AI message carrying `tool_calls`, ids and all,
   * because the middleware's hook runs as its own graph node after the model node has committed.
   * An implementation guess here would have been a heuristic latch instead.
   */
  it('recovers each pending call’s tool_call id from the suspended state', async () => {
    const agent = await makeAgent(
      suspendedState(
        [{ name: 'run_shell_command', args: { command: 'git clone x' }, id: 'call_abc' }],
        [{ name: 'run_shell_command', args: { command: 'git clone x' } }]
      )
    );
    const pending = await agent.getPendingToolInterrupts(runConfig);
    expect(pending).toEqual([
      { name: 'run_shell_command', args: { command: 'git clone x' }, id: 'call_abc' },
    ]);
  });

  /**
   * Two identical calls in one message is the case a name-only match gets wrong: both requests
   * would claim the first id, and one call's decision would be attributed to the other's row.
   */
  it('claims one id per request, so identical sibling calls do not share one', async () => {
    const agent = await makeAgent(
      suspendedState(
        [
          { name: 'run_shell_command', args: { command: 'ls' }, id: 'call_1' },
          { name: 'run_shell_command', args: { command: 'ls' }, id: 'call_2' },
        ],
        [
          { name: 'run_shell_command', args: { command: 'ls' } },
          { name: 'run_shell_command', args: { command: 'ls' } },
        ]
      )
    );
    const pending = await agent.getPendingToolInterrupts(runConfig);
    expect(pending.map((p: { id?: string }) => p.id)).toEqual(['call_1', 'call_2']);
  });

  /**
   * **The match is name AND arguments, and this is the fixture that can tell the difference.**
   *
   * The sibling case above cannot: its two calls share a name *and* their arguments, so a name-only
   * match plus the `claimed` flag still hands back `call_1, call_2` and a relaxed matcher survives
   * it. Here the two calls differ in their arguments and the requests arrive in the OPPOSITE order
   * to the `tool_calls` they were built from — the one arrangement where "first unclaimed call with
   * this name" and "the call this request was built from" are different objects. Name-only returns
   * `b → call_a`, `a → call_b`: every request gets an id, all the ids are used once, and each one
   * is attached to the wrong command.
   *
   * That is what makes the exactness worth pinning at all. The id is a display attribution — the
   * gate reads nothing from it — so a relaxed matcher does not break a run; it silently tones one
   * command's row with another command's rejection, on a screen whose whole purpose is telling a
   * person which call the rater refused.
   */
  it('claims the id of the call a request was built from, not the first of that name', async () => {
    const agent = await makeAgent(
      suspendedState(
        [
          { name: 'run_shell_command', args: { command: 'git status' }, id: 'call_a' },
          { name: 'run_shell_command', args: { command: 'git push --force' }, id: 'call_b' },
        ],
        [
          { name: 'run_shell_command', args: { command: 'git push --force' } },
          { name: 'run_shell_command', args: { command: 'git status' } },
        ]
      )
    );
    const pending = await agent.getPendingToolInterrupts(runConfig);
    expect(
      pending.map((p: { args: Record<string, unknown>; id?: string }) => [p.args.command, p.id])
    ).toEqual([
      ['git push --force', 'call_b'],
      ['git status', 'call_a'],
    ]);
  });

  /** Argument key ORDER is not identity — a re-serialised object must still match its own call. */
  it('matches a request whose argument keys arrived in a different order', async () => {
    const agent = await makeAgent(
      suspendedState(
        [{ name: 'fetch', args: { url: 'https://x', method: 'GET' }, id: 'call_k' }],
        [{ name: 'fetch', args: { method: 'GET', url: 'https://x' } }]
      )
    );
    const pending = await agent.getPendingToolInterrupts(runConfig);
    expect(pending[0].id).toBe('call_k');
  });

  /**
   * **Defensive at every step, and absent means "attribute nothing".** An unexpected state shape
   * must degrade to an interrupt with no id rather than throw: the id is a display attribution, and
   * nothing about whether a call is allowed may depend on it.
   */
  it('yields an interrupt with no id when the state carries no matching call', async () => {
    const agent = await makeAgent({
      tasks: [
        { interrupts: [{ value: { actionRequests: [{ name: 'run_shell_command', args: {} }] } }] },
      ],
      values: { messages: 'not an array' },
    });
    const pending = await agent.getPendingToolInterrupts(runConfig);
    expect(pending).toEqual([{ name: 'run_shell_command', args: {} }]);
  });

  /**
   * §5.4 — the typed event a renderer folds. Additive: `isError` stays true beside the new field,
   * because both are facts and they answer different questions — *did the call run* and *how should
   * this row be toned*.
   */
  it('marks the named call’s result event as a clarification, leaving isError alone', async () => {
    const { GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js');
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* graph injected directly */
      }
    }
    const agent = new TestAgent(() => {}) as any;
    agent.config = { writeBinaryOutputsToFile: false };
    agent.agent = {
      async invoke() {
        throw new Error('not used');
      },
      async stream() {
        async function* messages() {
          yield [
            new ToolMessage({
              content: 'Rejected. Narrow it.',
              tool_call_id: 'c1',
              status: 'error',
            }),
            {},
          ];
          yield [new ToolMessage({ content: 'boom', tool_call_id: 'c2', status: 'error' }), {}];
        }
        return messages();
      },
    };

    // The gate names ONE of the two calls — the one it bounced back to the agent as a round.
    agent.noteRaterClarification('c1');

    const events: AgentStreamEvent[] = [];
    for await (const event of agent.streamWithEvents([], runConfig)) events.push(event);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toEqual([
      {
        type: 'tool_result',
        id: 'c1',
        content: 'Rejected. Narrow it.',
        isError: true,
        raterClarification: true,
      },
      { type: 'tool_result', id: 'c2', content: 'boom', isError: true },
    ]);
  });
});
