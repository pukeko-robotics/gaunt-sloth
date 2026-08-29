/**
 * [[EXT-159]] — one cell per AGENT termination site, each driven *through* the site.
 *
 * These are the sites the runner cannot own, for two different reasons.
 *
 * The **metadata feeder** lives here because `GthAbstractAgent` is the only layer where a message's
 * `response_metadata` is visible at all — the runner only ever sees the rendered string. That is
 * the half of the taxonomy that reads a reason **off a message**; its counterpart, the exception
 * classifier, sees reasons that arrive as a **thrown error** and are in no metadata anywhere.
 *
 * The **cancellation and suspend** sites live here because they end a turn with no error reaching
 * the runner at all: the stream is closed rather than errored, and the event generators return.
 * From outside they are indistinguishable from a turn that simply finished, so if these sites do
 * not classify, nothing downstream can.
 *
 * Each cell asserts the `site` as well as the `category`, because the three metadata sites share
 * one category and a category-only assertion could not tell them apart.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { GraphInterrupt } from '@langchain/langgraph';
import type { AgentStreamEvent } from '#src/core/types.js';

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

/** An `AIMessageChunk` carrying one provider's stop/finish reason in `response_metadata`. */
function chunkWithMetadata(
  content: string,
  response_metadata: Record<string, unknown>
): AIMessageChunk {
  return new AIMessageChunk({ content, response_metadata });
}

describe('[[EXT-159]] a reason at every GthAbstractAgent termination site', () => {
  let GthAbstractAgent: typeof import('#src/core/GthAbstractAgent.js').GthAbstractAgent;

  beforeEach(async () => {
    vi.resetAllMocks();
    systemUtilsMock.getUseColour.mockReturnValue(false);
    ({ GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js'));
  });

  /** A concrete agent with the compiled graph injected, so each path can be driven directly. */
  function agentWithGraph(graph: Record<string, unknown>) {
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* graph injected directly */
      }
    }
    const agent = new TestAgent(() => {});
    (agent as unknown as { config: unknown }).config = { writeBinaryOutputsToFile: false };
    (agent as unknown as { agent: unknown }).agent = graph;
    return agent;
  }

  /** Drive a typed-event generator to exhaustion, returning what it yielded. */
  async function drain(stream: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  describe('agent.invoke-stop-metadata — the metadata feeder on the non-streaming path', () => {
    function graphReturning(final: AIMessage) {
      return {
        async getState() {
          return { values: { messages: [] } };
        },
        async invoke() {
          return { messages: [final] };
        },
        async stream() {
          throw new Error('stream not used');
        },
      };
    }

    it('classifies an OpenAI content_filter as `content_refusal`', async () => {
      const agent = agentWithGraph(
        graphReturning(
          new AIMessage({ content: '', response_metadata: { finish_reason: 'content_filter' } })
        )
      );

      await agent.invoke([new HumanMessage('q')], runConfig);

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-stop-metadata',
        category: 'content_refusal',
        source: 'metadata',
        provider: 'openai',
        detail: 'content_filter',
        // A refusal is deterministic for the same input, so the same prompt refuses again.
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'change-request',
      });
    });

    /**
     * The cheapest proof the feeder is genuinely GENERALISED rather than the old refusal detector
     * renamed: a second taxonomy member, read from the same four places, spelled per provider.
     * It surfaces nothing and changes no string — classification only.
     */
    it('classifies an Anthropic max_tokens stop as `output_truncated`', async () => {
      const agent = agentWithGraph(
        graphReturning(
          new AIMessage({
            content: 'half an ans',
            response_metadata: { stop_reason: 'max_tokens' },
          })
        )
      );

      await agent.invoke([new HumanMessage('q')], runConfig);

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-stop-metadata',
        category: 'output_truncated',
        source: 'metadata',
        detail: 'max_tokens',
      });
    });

    it('says nothing about an ordinary end, so an absent reason means an unclassified site', async () => {
      const agent = agentWithGraph(
        graphReturning(
          new AIMessage({ content: 'done', response_metadata: { finish_reason: 'stop' } })
        )
      );

      await agent.invoke([new HumanMessage('q')], runConfig);

      expect(agent.getTerminationReason()).toBeNull();
    });
  });

  describe('agent.invoke-tool-exception — the failure that becomes the ANSWER', () => {
    /**
     * A `ToolException` on this path is turned into the turn's answer and RETURNED, not raised, so
     * nothing further up ever sees an error to classify. Without a reason set here the turn is
     * indistinguishable from a successful one that happened to be about a failure.
     */
    it('classifies a ToolException as `tool_error` even though nothing is thrown onward', async () => {
      const toolException = Object.assign(new Error('read_file blew up'), {
        name: 'ToolException',
      });
      const agent = agentWithGraph({
        async getState() {
          return { values: { messages: [] } };
        },
        async invoke() {
          throw toolException;
        },
        async stream() {
          throw new Error('stream not used');
        },
      });

      const answer = await agent.invoke([new HumanMessage('q')], runConfig);

      expect(answer).toContain('Tool execution failed');
      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-tool-exception',
        category: 'tool_error',
        source: 'exception',
      });
    });
  });

  describe('agent.stream-stop-metadata — the metadata feeder on the string-streaming path', () => {
    function graphStreaming(chunks: AIMessageChunk[]) {
      return {
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          return (async function* () {
            for (const chunk of chunks) yield [chunk, {}];
          })();
        },
      };
    }

    it('classifies an Anthropic refusal read off the aggregated message', async () => {
      const agent = agentWithGraph(
        graphStreaming([
          chunkWithMetadata('', {}),
          chunkWithMetadata('', { stop_reason: 'refusal' }),
        ])
      );

      const stream = await agent.stream([new HumanMessage('q')], runConfig);
      for await (const _chunk of stream) void _chunk;

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'content_refusal',
        provider: 'anthropic',
      });
    });

    it('classifies an OpenAI `length` finish as `output_truncated`', async () => {
      const agent = agentWithGraph(
        graphStreaming([chunkWithMetadata('a partial ans', { finish_reason: 'length' })])
      );

      const stream = await agent.stream([new HumanMessage('q')], runConfig);
      for await (const _chunk of stream) void _chunk;

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'output_truncated',
        detail: 'length',
      });
    });
  });

  describe('agent.stream-cancelled — the turn that ends with no error anywhere', () => {
    /**
     * The stream is CLOSED here, not errored: the abort is swallowed so the run ends tidily. That
     * is exactly why the site has to classify — from the runner this is indistinguishable from a
     * turn that finished. [[TUI-C62]] (a stray meta-key sequence aborting a streaming turn) is the
     * member of the class this shape is for.
     */
    it('classifies an AbortError mid-stream as `cancelled`', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          return (async function* () {
            yield [new AIMessageChunk({ content: 'partial' }), {}];
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          })();
        },
      });

      const stream = await agent.stream([new HumanMessage('q')], runConfig);
      let text = '';
      for await (const chunk of stream) text += chunk;

      // The turn really did end tidily with partial content — no error reached the caller.
      expect(text).toBe('partial');
      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-cancelled',
        category: 'cancelled',
        retryableAsIs: false,
        retryableAfterRemedy: false,
      });
    });
  });

  describe('agent.events-ended — two different endings that share one catch', () => {
    function graphThrowingOnStream(error: unknown) {
      return {
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          throw error;
        },
      };
    }

    /**
     * A suspend is not a failure at all: the graph is parked on an `interrupt()` and continues on
     * a resume. Reporting it as a cancellation would be the same laundering this node exists to
     * remove, one branch further in — so the two must not share a reason.
     */
    it('classifies a GraphInterrupt as `suspended`, whose remedy is to resume', async () => {
      const agent = agentWithGraph(graphThrowingOnStream(new GraphInterrupt([])));

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-ended',
        category: 'suspended',
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'resume',
      });
    });

    it('classifies an AbortError as `cancelled` at the same site', async () => {
      const agent = agentWithGraph(
        graphThrowingOnStream(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      );

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-ended',
        category: 'cancelled',
      });
    });
  });

  describe('agent.events-resume-ended — the resume path’s twin', () => {
    it('classifies a suspend on a resumed graph under its own site', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          throw new GraphInterrupt([]);
        },
      });

      await drain(agent.streamWithEventsResume({ decisions: [] }, runConfig));

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-resume-ended',
        category: 'suspended',
      });
    });
  });

  describe('agent.events-stop-metadata — the metadata feeder on the typed-event path', () => {
    it('classifies a refusal read off the aggregated typed-event chunk', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          return (async function* () {
            yield [chunkWithMetadata('', { finish_reason: 'content_filter' }), {}];
          })();
        },
      });

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-stop-metadata',
        category: 'content_refusal',
        provider: 'openai',
      });
    });

    it('classifies a Gemini MAX_TOKENS finish as `output_truncated`', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          return (async function* () {
            yield [chunkWithMetadata('cut off', { finishReason: 'MAX_TOKENS' }), {}];
          })();
        },
      });

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-stop-metadata',
        category: 'output_truncated',
        detail: 'max_tokens',
      });
    });
  });

  describe('the carrier', () => {
    /** First-write-wins: the truer inner classification is not overwritten by a later, coarser one. */
    it('keeps the first reason recorded in a turn', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          throw new GraphInterrupt([]);
        },
      });

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));
      // A SECOND ending inside the same turn — the interrupt-resume loop runs several streams per
      // turn — must not relabel the first under its own site.
      await drain(agent.streamWithEventsResume({ decisions: [] }, runConfig));

      expect(agent.getTerminationReason()).toMatchObject({ site: 'agent.events-ended' });
    });

    it('is forgotten when the runner resets it at the next turn boundary', async () => {
      const agent = agentWithGraph({
        async invoke() {
          throw new Error('invoke not used');
        },
        async stream() {
          throw new GraphInterrupt([]);
        },
      });

      await drain(agent.streamWithEvents([new HumanMessage('q')], runConfig));
      expect(agent.getTerminationReason()).not.toBeNull();

      agent.resetTerminationReason();

      expect(agent.getTerminationReason()).toBeNull();
    });
  });
});
