import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import { TOOL_RESULT_CONTENT_CAP } from '#src/core/runStats.js';
import type { GthConfig } from '#src/config.js';
import type { GthCompiledGraph } from '#src/core/types.js';
import { bindMcpToolsets, mcpToolRegisteredName } from '#src/core/approvals/mcpSubjects.js';

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

/**
 * BATCH-43 — a graph that answers with one softened MCP tool error, the shape
 * `@langchain/mcp-adapters` produces once the agent's error-softening middleware has turned the
 * thrown `ToolException` into a ToolMessage.
 */
function createMcpErrorGraph(observed: string, registeredName: string): GthCompiledGraph {
  return {
    async getState(_config: RunnableConfig) {
      return { values: { messages: [] } };
    },
    async invoke(input: any) {
      return {
        messages: [
          ...(input.messages as BaseMessage[]),
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'c1', name: registeredName, args: {} }],
          }),
          new ToolMessage({
            content: observed,
            tool_call_id: 'c1',
            name: registeredName,
            status: 'error',
          }),
          new AIMessage({ content: 'the server refused' }),
        ],
      };
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

  /**
   * BATCH-43 — set `this.config` the way a real agent does, through `getEffectiveConfig`, rather
   * than assigning the object directly, and record the MCP tool bindings the way a backend does at
   * init (EXT-211), from the resolver's map restricted to the tools resolved — so the test covers
   * that hop to the fold instead of assuming it.
   */
  useGraphWithConfig(
    graph: GthCompiledGraph,
    extra: Partial<GthConfig>,
    resolvedToolNames: readonly string[] = []
  ): void {
    (this as any).agent = graph;
    this.recordMcpToolBindings(resolvedToolNames.map((name) => ({ name })));
    (this as any).config = this.getEffectiveConfig(
      {
        writeBinaryOutputsToFile: false,
        llm: { bindTools: () => undefined },
        ...extra,
      } as unknown as GthConfig,
      undefined
    );
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

/**
 * BATCH-43 — the production wiring, exercised end to end through a real `invoke`.
 *
 * Every other spec for this feature calls `accumulateMessage` / `extractRunStats` with the MCP tool
 * bindings passed by hand, so all of them stay green if `recordRunStats` stops supplying them: the
 * parameter defaults to no bindings, no server resolves, and the field is simply never recorded in
 * a real run while the suite reports success. This is the only test that fails when that single
 * argument goes missing, or when the agent stops recording the resolver's bindings.
 */
describe('GthAbstractAgent run-stats MCP error capture (BATCH-43 wiring)', () => {
  const REGISTERED = mcpToolRegisteredName('unimarket', 'contract_search');
  const resolvers = {
    getMcpToolBindings: () => bindMcpToolsets([['unimarket', [{ name: REGISTERED }]]]),
  };
  const BODY = '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';
  const OBSERVED = `MCP tool 'contract_search' on server 'unimarket' returned an error: ${BODY}`;

  it('records the recovered error body from the agent’s bindings, on a real invoke', async () => {
    const agent = new TestAgent(() => {}, resolvers);
    agent.useGraphWithConfig(
      createMcpErrorGraph(OBSERVED, REGISTERED),
      { mcpServers: { unimarket: { command: 'node', args: ['server.js'] } } },
      [REGISTERED]
    );

    agent.resetRunStats();
    await agent.invoke([new HumanMessage('search the contracts')], runConfig);

    expect(agent.getRunStats().toolResults).toEqual([
      {
        name: REGISTERED,
        isError: true,
        // What the model saw, unchanged.
        content: OBSERVED,
        // What an eval can now grade.
        errorPayload: BODY,
      },
    ]);
  });

  it('records no error body when the run resolved no MCP tools, whatever the resolver holds', async () => {
    const agent = new TestAgent(() => {}, resolvers);
    agent.useGraphWithConfig(createMcpErrorGraph(OBSERVED, REGISTERED), {}, []);

    agent.resetRunStats();
    await agent.invoke([new HumanMessage('search the contracts')], runConfig);

    expect(agent.getRunStats().toolResults).toEqual([
      { name: REGISTERED, isError: true, content: OBSERVED },
    ]);
  });

  it('truncates at the cap from the agent CONFIG, not at the default', async () => {
    // The only cell that fails if `recordRunStats` stops passing the configured cap: every other
    // spec calls `accumulateMessage` with the cap by hand, and the parameter defaults to the
    // constant, so a dropped argument records the full payload here while the suite stays green.
    // A success status keeps the error-body recovery out of this cell, so it pins the content site
    // alone; the cell below pins the error-body site through the same wiring.
    const agent = new TestAgent(() => {});
    const payload = 'p'.repeat(100);
    agent.useGraphWithConfig(createMcpErrorGraph(payload, 'read_file', 'success'), {
      toolResultCaptureMaxBytes: 40,
    });

    agent.resetRunStats();
    await agent.invoke([new HumanMessage('read it')], runConfig);

    const record = agent.getRunStats().toolResults![0];
    expect(Buffer.byteLength(record.content!)).toBe(40);
    expect(record.contentTruncated).toBe(true);
    expect(record.contentOriginalBytes).toBe(100);
    expect(record.errorPayload).toBeUndefined();
  });

  it('recovers an MCP error body at the cap from the agent CONFIG, not at the default', async () => {
    // A body the default cap drops, recovered only because the configured cap reached it. If
    // `recordRunStats` stopped passing the cap into the error-body site, this field stays absent
    // while the content-truncation cell above stays green.
    const body = `{"reason":"${'z'.repeat(TOOL_RESULT_CONTENT_CAP)}"}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(TOOL_RESULT_CONTENT_CAP);
    const observed = `MCP tool 'contract_search' on server 'unimarket' returned an error: ${body}`;
    const agent = new TestAgent(() => {}, resolvers);
    agent.useGraphWithConfig(
      createMcpErrorGraph(observed, REGISTERED),
      {
        mcpServers: { unimarket: { command: 'node', args: ['server.js'] } },
        toolResultCaptureMaxBytes: Buffer.byteLength(body),
      },
      [REGISTERED]
    );

    agent.resetRunStats();
    await agent.invoke([new HumanMessage('search the contracts')], runConfig);

    expect(agent.getRunStats().toolResults![0].errorPayload).toBe(body);
  });
});
