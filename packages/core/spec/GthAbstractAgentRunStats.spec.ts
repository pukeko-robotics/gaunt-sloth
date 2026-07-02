import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import type { GthConfig } from '#src/config.js';
import type { GthCompiledGraph } from '#src/core/types.js';

/**
 * GS2-16 regression — the NON-streaming `invoke` path must harvest ONLY the CURRENT turn's new
 * messages, not the full accumulated conversation a checkpointer returns. Without the baseline
 * slice, a multi-turn `--no-tui` session with `streamOutput: false` re-sums prior turns'
 * usage_metadata and re-collects prior tools (per-turn over-count). This exercises the REAL
 * invoke harvest (a fake checkpointer-backed graph) rather than mocking getRunStats wholesale.
 */

/** A fake compiled graph that accumulates messages across invokes, like a real checkpointer. */
function createCheckpointedGraph(): GthCompiledGraph {
  const state: { messages: BaseMessage[] } = { messages: [] };
  let turn = 0;
  return {
    async getState(_config: RunnableConfig) {
      // Mirror LangGraph's StateSnapshot shape: channel values under `.values`.
      return { values: { messages: [...state.messages] } };
    },

    async invoke(input: any) {
      turn += 1;
      // Append this turn's input (Human message) to the persistent thread state.
      state.messages.push(...(input.messages as BaseMessage[]));
      // Generate this turn's AI response: distinct token usage + a distinct tool per turn.
      const ai = new AIMessage({
        content: `answer ${turn}`,
        tool_calls: [{ id: `c${turn}`, name: `tool_${turn}`, args: {} }],
        usage_metadata: {
          input_tokens: turn * 100,
          output_tokens: turn * 10,
          total_tokens: turn * 110,
        },
      });
      const toolMsg = new ToolMessage({
        content: 'ok',
        tool_call_id: `c${turn}`,
        name: `tool_${turn}`,
      });
      state.messages.push(ai, toolMsg);
      // Return the FULL accumulated conversation (what a checkpointer-backed graph returns).
      return { messages: [...state.messages] };
    },

    async stream() {
      throw new Error('stream not used in this test');
    },
  };
}

/** Minimal concrete agent that injects a prebuilt graph so we can drive `invoke` directly. */
class TestAgent extends GthAbstractAgent {
  async init(): Promise<void> {
    /* not used — we inject the graph directly */
  }
  useGraph(graph: GthCompiledGraph): void {
    (this as any).agent = graph;

    (this as any).config = { writeBinaryOutputsToFile: false } as GthConfig;
  }
}

const runConfig: RunnableConfig = { configurable: { thread_id: 't1' } };

describe('GthAbstractAgent invoke run-stats (GS2-16 per-turn isolation)', () => {
  it('records ONLY the current turn across a two-turn checkpointed invoke sequence', async () => {
    const agent = new TestAgent(() => {});
    agent.useGraph(createCheckpointedGraph());

    // Turn 1
    agent.resetRunStats();
    await agent.invoke([new HumanMessage('q1')], runConfig);
    const t1 = agent.getRunStats();
    expect(t1.tokensInput).toBe(100);
    expect(t1.tokensOutput).toBe(10);
    expect(t1.tools).toEqual(['tool_1']);

    // Turn 2 — the graph now returns turn 1's messages too; stats must NOT include them.
    agent.resetRunStats();
    await agent.invoke([new HumanMessage('q2')], runConfig);
    const t2 = agent.getRunStats();
    expect(t2.tokensInput).toBe(200); // turn 2 only (200), NOT 100 + 200 = 300
    expect(t2.tokensOutput).toBe(20); // turn 2 only (20), NOT 10 + 20 = 30
    expect(t2.tools).toEqual(['tool_2']); // turn 2 only, NOT ['tool_1','tool_2']
  });

  it('is fail-soft when getState is absent (harvests the whole turn from baseline 0)', async () => {
    const agent = new TestAgent(() => {});
    const graph = createCheckpointedGraph();
    // Drop getState → getStateMessageCount returns 0 (fail-soft baseline).

    delete (graph as any).getState;
    agent.useGraph(graph);

    agent.resetRunStats();
    await agent.invoke([new HumanMessage('q1')], runConfig);
    const stats = agent.getRunStats();
    // First turn: baseline 0 either way, so the single turn is counted correctly.
    expect(stats.tokensInput).toBe(100);
    expect(stats.tools).toEqual(['tool_1']);
  });
});
