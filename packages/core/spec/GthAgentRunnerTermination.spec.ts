/**
 * [[EXT-159]] — one cell per RUNNER termination site, each driven *through* the site.
 *
 * The acceptance bar is a test per site that goes red when that site's reason is removed, "not one
 * test over a switch statement" — so nothing here calls the classifier directly. Every cell runs a
 * real `GthAgentRunner` turn that ends the way that site ends it, then reads
 * `getTerminationReason()` and asserts the **site** as well as the category. Asserting the category
 * alone would not discriminate: the two exception wrappers both report whatever the classifier
 * says, so a cell that checked only `context_overflow` would stay green with either site deleted.
 *
 * The two wrappers are **nested, not alternatives** — the inner `catch` re-throws into the outer
 * one, so on a streamed fault both execute. The carrier is therefore first-write-wins, and the two
 * cells below pin exactly that: a streamed fault must report `runner.stream-error`, and only the
 * non-streaming path may report `runner.turn-error`.
 *
 * The taxonomy's own rules (posture, classifier predicates) are unit-tested in
 * `terminationTaxonomy.spec.ts`; the agent's sites in `GthAbstractAgentTermination.spec.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextOverflowError } from '@langchain/core/errors';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import type { AgentStreamEvent, StatusUpdateCallback } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { terminationReasonOf } from '#src/core/terminationReason.js';

const mockAgent = {
  init: vi.fn(),
  setVerbose: vi.fn(),
  invoke: vi.fn(),
  stream: vi.fn(),
  streamWithEvents: vi.fn(),
  cleanup: vi.fn(),
  // [[EXT-159]] — the stub agent deliberately classifies NOTHING, so every reason a cell reads is
  // the runner's own. An agent that answered would win (its sites are inner), which would make
  // these cells green on a runner with its sites removed.
  resetTerminationReason: vi.fn(),
  getTerminationReason: vi.fn(() => null),
};

const resolveRaterModelMock = vi.fn();
vi.mock('#src/core/shell/raterModel.js', () => ({
  resolveRaterModel: resolveRaterModelMock,
}));

vi.mock('#src/core/GthLangChainAgent.js', () => ({
  GthLangChainAgent: class MockGthLangChainAgent {
    constructor() {
      return mockAgent;
    }
  },
  StatusUpdateCallback: vi.fn(),
}));

/** The persisted grant store is anchored at the project dir; clamp it so no real file is read. */
const projectDir = mkdtempSync(join(tmpdir(), 'gth-termination-spec-'));

/** A text stream over a fixed list of chunks — the shape `agent.stream` returns. */
function textStreamOf(chunks: string[]) {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

/** A text stream that throws mid-drain. */
function throwingTextStream(error: unknown) {
  return (async function* () {
    yield '';
    throw error;
  })();
}

/** An event stream over a fixed list — the shape `streamWithEvents` returns. */
function eventStreamOf(events: AgentStreamEvent[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

describe('[[EXT-159]] a reason at every GthAgentRunner termination site', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let statusUpdateCallback: Mock<StatusUpdateCallback>;
  let streamingConfig: GthConfig;
  let invokeConfig: GthConfig;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    statusUpdateCallback = vi.fn();
    mockAgent.getTerminationReason.mockReturnValue(null);

    const base = {
      contentSource: 'file',
      requirementSource: 'file',
      filesystem: 'none',
      useColour: false,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: false,
      llm: { _llmType: vi.fn().mockReturnValue('test'), verbose: false },
    } as unknown as GthConfig;
    streamingConfig = { ...base, streamOutput: true };
    invokeConfig = { ...base, streamOutput: false };

    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => setProjectDir(priorProjectDir));
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  async function runnerFor(config: GthConfig) {
    const runner = new GthAgentRunner(statusUpdateCallback);
    await runner.init(undefined, config);
    return runner;
  }

  const ask = [new HumanMessage('hello')];

  describe('runner.completed — the ordinary end of a turn', () => {
    /**
     * Recording an ordinary completion is what makes "no reason" mean *a site nobody classified*
     * rather than *nothing went wrong*. Without it the absent case is ambiguous, and every
     * consumer downstream has to guess which of the two it is looking at.
     */
    it('sets `completed` when a streamed turn returns an answer', async () => {
      mockAgent.stream.mockResolvedValue(textStreamOf(['all ', 'done']));
      const runner = await runnerFor(streamingConfig);

      await expect(runner.processMessages(ask)).resolves.toBe('all done');

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.completed',
        category: 'completed',
        source: 'control',
        retryableAsIs: false,
        retryableAfterRemedy: false,
      });
    });

    it('sets `completed` when a non-streaming turn returns an answer', async () => {
      mockAgent.invoke.mockResolvedValue('an answer');
      const runner = await runnerFor(invokeConfig);

      await expect(runner.processMessages(ask)).resolves.toBe('an answer');

      expect(runner.getTerminationReason()).toMatchObject({ site: 'runner.completed' });
    });

    /** A reason belongs to one turn; the next turn starts with none of the previous one's. */
    it('is forgotten at the next turn boundary', async () => {
      mockAgent.invoke.mockResolvedValueOnce('');
      const runner = await runnerFor(invokeConfig);
      await expect(runner.processMessages(ask)).rejects.toThrow(/empty response/);
      expect(runner.getTerminationReason()).toMatchObject({ category: 'empty_response' });

      mockAgent.invoke.mockResolvedValueOnce('fine now');
      await runner.processMessages(ask);
      expect(runner.getTerminationReason()).toMatchObject({ category: 'completed' });
    });
  });

  describe('runner.empty-after-fallback — the streamed turn that was empty twice', () => {
    it('sets `empty_response` after the retry has been spent', async () => {
      mockAgent.stream.mockResolvedValue(textStreamOf(['']));
      mockAgent.invoke.mockResolvedValue('   ');
      const runner = await runnerFor(streamingConfig);

      await expect(runner.processMessages(ask)).rejects.toThrow(/after tool execution/);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.empty-after-fallback',
        category: 'empty_response',
        // The one cause the runtime already retries as-is — and it is right to.
        retryableAsIs: true,
        retryableAfterRemedy: true,
        remedy: 'change-model',
      });
    });
  });

  describe('runner.empty-invoke — the non-streaming turn that produced nothing', () => {
    it('sets `empty_response` with no retry spent', async () => {
      mockAgent.invoke.mockResolvedValue('');
      const runner = await runnerFor(invokeConfig);

      await expect(runner.processMessages(ask)).rejects.toThrow(/empty response/);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.empty-invoke',
        category: 'empty_response',
      });
    });

    /**
     * The classification must not be readable only off the sentence. Assert the reason rides the
     * thrown error too, because that is the carrier every layer above the runner actually sees.
     */
    it('carries the reason on the thrown error, not only in the message', async () => {
      mockAgent.invoke.mockResolvedValue('');
      const runner = await runnerFor(invokeConfig);

      const error = await runner.processMessages(ask).catch((e: unknown) => e);

      expect(terminationReasonOf(error)).toMatchObject({
        site: 'runner.empty-invoke',
        category: 'empty_response',
      });
    });
  });

  describe('runner.stream-error — the INNER of the two nested wrappers', () => {
    /**
     * The sharpest available evidence for this node's premise: `@langchain/core` hands us a typed
     * `ContextOverflowError` and the funnel used to flatten it into a sentence. The predicate is
     * `isInstance`, never `lc_error_code` — OpenAI sets the class without the code.
     */
    it('classifies a thrown ContextOverflowError as `context_overflow`', async () => {
      mockAgent.stream.mockResolvedValue(
        throwingTextStream(new ContextOverflowError('maximum context length is 4096 tokens'))
      );
      const runner = await runnerFor(streamingConfig);

      await expect(runner.processMessages(ask)).rejects.toThrow(/Stream processing failed/);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.stream-error',
        category: 'context_overflow',
        source: 'exception',
        // The two facts, and the whole reason they are two: LangChain stamps this class
        // non-retryable, which is right for the same prompt and backwards for a smaller one.
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'reduce-context',
      });
    });

    /**
     * **The nesting cell.** The inner wrapper re-throws into the outer one, so both sites run on
     * every streamed fault. Under last-write-wins the outer would overwrite the inner and deleting
     * the inner site's reason would be invisible here.
     */
    it('wins over the outer wrapper, which also executes on this path', async () => {
      mockAgent.stream.mockResolvedValue(throwingTextStream(new Error('429 rate limit reached')));
      const runner = await runnerFor(streamingConfig);

      const error = await runner.processMessages(ask).catch((e: unknown) => e);

      // The message really is doubly wrapped, which is what makes the ordering matter.
      expect(String((error as Error).message)).toContain('Agent processing failed:');
      expect(String((error as Error).message)).toContain('Stream processing failed:');
      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.stream-error',
        category: 'rate_limited',
      });
      // Both carriers agree: the outer wrapper inherits the inner site's reason rather than
      // re-classifying under its own.
      expect(terminationReasonOf(error)).toMatchObject({ site: 'runner.stream-error' });
    });
  });

  describe('runner.turn-error — the OUTER wrapper, reached alone on the non-streaming path', () => {
    it('classifies a provider fault thrown by invoke', async () => {
      mockAgent.invoke.mockRejectedValue(new Error('Internal error during token generation'));
      const runner = await runnerFor(invokeConfig);

      await expect(runner.processMessages(ask)).rejects.toThrow(/Agent processing failed/);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.turn-error',
        category: 'provider_error',
        source: 'exception',
        retryableAsIs: true,
      });
    });

    it('carries the reason on the wrapper it throws', async () => {
      mockAgent.invoke.mockRejectedValue(new Error('401 Unauthorized'));
      const runner = await runnerFor(invokeConfig);

      const error = await runner.processMessages(ask).catch((e: unknown) => e);

      expect(terminationReasonOf(error)).toMatchObject({
        site: 'runner.turn-error',
        category: 'auth_failed',
        remedy: 'fix-credentials',
      });
    });
  });

  describe('the approvals stop — re-thrown unchanged, and now classified', () => {
    /**
     * `ApprovalStopError` is re-thrown with its message intact precisely so its explanation is not
     * buried. Adding a reason takes nothing away: the message is asserted unchanged here, because
     * a classification that cost the gate its own words would be a regression, not a fix.
     */
    it('sets `approval_stop` at the stream site and leaves the message intact', async () => {
      const { AttackHaltError } = await import('#src/core/shell/approvalStop.js');
      const stop = new AttackHaltError('rm -rf /', 'the structure is an exfiltration attempt');
      mockAgent.stream.mockResolvedValue(throwingTextStream(stop));
      const runner = await runnerFor(streamingConfig);

      const error = await runner.processMessages(ask).catch((e: unknown) => e);

      expect(error).toBe(stop);
      expect((error as Error).message).toContain('Run halted:');
      expect((error as Error).message).toContain('the structure is an exfiltration attempt');
      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.stream-approval-stop',
        category: 'approval_stop',
        // The gate refused. Re-running a refused command automatically is the failure the gate
        // exists to prevent, so neither retry field offers it.
        retryableAsIs: false,
        retryableAfterRemedy: false,
      });
    });

    it('sets `approval_stop` at the turn site on the non-streaming path', async () => {
      const { AttackHaltError } = await import('#src/core/shell/approvalStop.js');
      const stop = new AttackHaltError('rm -rf /', 'the structure is an exfiltration attempt');
      mockAgent.invoke.mockRejectedValue(stop);
      const runner = await runnerFor(invokeConfig);

      await expect(runner.processMessages(ask)).rejects.toBe(stop);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.turn-approval-stop',
        category: 'approval_stop',
      });
    });
  });

  describe('the typed-event path', () => {
    async function drain(stream: AsyncGenerator<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
      const events: AgentStreamEvent[] = [];
      for await (const event of stream) events.push(event);
      return events;
    }

    it('runner.events-completed — sets `completed` when the event turn drains to the end', async () => {
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStreamOf([{ type: 'text', delta: 'hi' }])
      );
      const runner = await runnerFor(streamingConfig);

      await drain(runner.processMessagesWithEvents(ask));

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.events-completed',
        category: 'completed',
      });
    });

    /**
     * Esc does not throw here: the signal is aborted, `streamWithEvents` swallows the `AbortError`
     * and returns cleanly, and the turn reaches its own end like any other. [[TUI-C62]]'s stray
     * meta-key sequence is exactly this shape — a stop the runtime never sees as an error, which
     * still owes the user a reason.
     */
    it('runner.events-cancelled — sets `cancelled` when the turn was aborted', async () => {
      const ac = new AbortController();
      mockAgent.streamWithEvents.mockImplementation(() =>
        (async function* () {
          yield { type: 'text', delta: 'partial' } as AgentStreamEvent;
          ac.abort();
        })()
      );
      const runner = await runnerFor(streamingConfig);

      await drain(runner.processMessagesWithEvents(ask, ac.signal));

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.events-cancelled',
        category: 'cancelled',
        // The user chose to stop. Retrying without being asked overrides the one decision they made.
        retryableAsIs: false,
        retryableAfterRemedy: false,
      });
    });

    /**
     * The typed-event path had NO catch at all, so a provider fault on the surface most users are
     * looking at was the one termination nothing classified — not even into a string.
     */
    it('runner.events-error — classifies a fault thrown by the event stream, re-thrown unchanged', async () => {
      const fault = new Error('503 service unavailable');
      mockAgent.streamWithEvents.mockImplementation(() =>
        (async function* (): AsyncGenerator<AgentStreamEvent> {
          yield { type: 'text', delta: 'x' };
          throw fault;
        })()
      );
      const runner = await runnerFor(streamingConfig);

      const error = await drain(runner.processMessagesWithEvents(ask)).catch((e: unknown) => e);

      // Unchanged: this site adds a reason and takes nothing away.
      expect(error).toBe(fault);
      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.events-error',
        category: 'provider_error',
      });
    });

    /**
     * The one ending that reaches neither the end of the `try` nor the `catch`: a consumer that
     * stops consuming. Only the `finally` runs, so only the `finally` can speak for it.
     */
    it('runner.events-abandoned — sets `abandoned` when the consumer stops consuming', async () => {
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStreamOf([
          { type: 'text', delta: 'one' },
          { type: 'text', delta: 'two' },
        ])
      );
      const runner = await runnerFor(streamingConfig);

      const turn = runner.processMessagesWithEvents(ask);
      for await (const _event of turn) break; // the consumer walks away mid-turn

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'runner.events-abandoned',
        category: 'abandoned',
      });
    });

    /** The `finally` runs on every path, so its site must not overwrite a real one. */
    it('does not let the abandoned site overwrite a completed turn', async () => {
      mockAgent.streamWithEvents.mockImplementation(() =>
        eventStreamOf([{ type: 'text', delta: 'hi' }])
      );
      const runner = await runnerFor(streamingConfig);

      await drain(runner.processMessagesWithEvents(ask));

      expect(runner.getTerminationReason()).toMatchObject({ category: 'completed' });
    });
  });

  describe('the agent’s own reason outranks the runner’s', () => {
    /**
     * The agent's sites sit INSIDE the runner's catches, so the innermost classification is the
     * true one. A refusal that also returns text would otherwise be reported as an ordinary
     * completion — the same laundering, one level up.
     */
    it('reports the agent’s refusal rather than the runner’s `completed`', async () => {
      mockAgent.invoke.mockResolvedValue('The model declined to respond.');
      mockAgent.getTerminationReason.mockReturnValue({
        category: 'content_refusal',
        site: 'agent.invoke-stop-metadata',
        source: 'metadata',
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'change-request',
      });
      const runner = await runnerFor(invokeConfig);

      await runner.processMessages(ask);

      expect(runner.getTerminationReason()).toMatchObject({
        site: 'agent.invoke-stop-metadata',
        category: 'content_refusal',
      });
    });

    /** And it survives cleanup, which nulls the agent before the single-shot path reads it. */
    it('survives cleanup, which the single-shot path reads after', async () => {
      mockAgent.invoke.mockResolvedValue('answer');
      mockAgent.getTerminationReason.mockReturnValue({
        category: 'output_truncated',
        site: 'agent.invoke-stop-metadata',
        source: 'metadata',
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'change-request',
      });
      const runner = await runnerFor(invokeConfig);
      await runner.processMessages(ask);

      await runner.cleanup();

      expect(runner.getTerminationReason()).toMatchObject({ category: 'output_truncated' });
    });
  });
});
