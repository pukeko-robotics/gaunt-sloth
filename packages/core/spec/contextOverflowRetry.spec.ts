/**
 * [[EXT-160]] — **the reactive seam, driven through a real `GthAgentRunner` and a real graph.**
 *
 * Every cell here provokes a genuine `ContextOverflowError` out of the model inside a real turn and
 * then reads what the runtime did about it, rather than calling the seam directly — because the
 * facts under test are all about the seam's PLACE: that both drivers reach it, that it reaches it
 * once each, and that the retry carries a smaller prompt than the attempt that failed.
 *
 * The two drivers get separate cells on purpose. `processMessages` has nested `catch`es and the
 * streaming path does not always use the inner one: an overflow raised while the stream is being
 * created (`await agent.stream(…)`, above the inner `try`) lands in the outer one, which is where
 * the seam therefore sits. A cell on only one branch would leave the other unproven.
 *
 * The measurement is `requests[]` — what the model actually received on each attempt — cross-checked
 * against `lastModelRequest`, the snapshot `/debug-dump` reads. A smaller retry is the point of the
 * node, so it is asserted as a number (messages AND characters), never as "a compaction happened".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ContextOverflowError } from '@langchain/core/errors';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import { conversationSize, isCompactionSummary } from '#src/core/compaction.js';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
  };
});

/**
 * A model that can be told to overflow. `requests` records the messages of every TURN call as the
 * model received them — recorded BEFORE the overflow decision, so a failed attempt's prompt is
 * measurable too, which is the whole before/after comparison. Summary calls are recognised by the
 * compaction prompt's opening `<role>` block and counted separately: "exactly one compaction" is an
 * assertion about that counter.
 */
class OverflowingModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  summaryCalls = 0;
  /** How many of the NEXT turn calls throw a context overflow. */
  overflowsRemaining = 0;
  /** Response metadata stamped on the next answer — used for the output-truncation cell. */
  responseMetadata: Record<string, unknown> | undefined;

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    const lastText = typeof last?.content === 'string' ? last.content : '';
    if (HumanMessage.isInstance(last) && lastText.startsWith('<role>')) {
      this.summaryCalls++;
      return { generations: [{ message: new AIMessage('SUMMARY'), text: 'SUMMARY' }] };
    }
    this.requests.push(messages);
    if (this.overflowsRemaining > 0) {
      this.overflowsRemaining--;
      throw new ContextOverflowError("This model's maximum context length is 100 tokens.");
    }
    const lastHuman = [...messages].reverse().find((m) => HumanMessage.isInstance(m));
    const ask = typeof lastHuman?.content === 'string' ? lastHuman.content : '';
    const message = new AIMessage({
      content: `answer: ${ask.slice(0, 12)}`,
      ...(this.responseMetadata ? { response_metadata: this.responseMetadata } : {}),
    });
    return { generations: [{ message, text: message.content as string }] };
  }
}

const lookup = tool(async () => 'LOOKED-UP', {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({}),
});

const BASE_CONFIG = {
  streamOutput: true,
  contentSource: 'file',
  requirementSource: 'file',
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: false,
  writeBinaryOutputsToFile: false,
  streamSessionInferenceLog: false,
  canInterruptInferenceWithEsc: false,
  includeCurrentDateAfterGuidelines: true,
};

/** Long enough that folding it is measurable in characters as well as in message count. */
const PADDING = ' ' + 'x'.repeat(400);

describe('EXT-160 — compact and retry once on a context overflow', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  const statusUpdate = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  const makeRunner = async (model: OverflowingModel, extra: Record<string, unknown> = {}) => {
    const runner = new GthAgentRunner(statusUpdate, {
      resolveTools: vi.fn().mockResolvedValue([lookup]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, ...extra, llm: model } as unknown as GthConfig;
    await runner.init('chat', config, new MemorySaver());
    return runner;
  };

  const runConfigOf = (runner: InstanceType<typeof GthAgentRunner>): RunnableConfig =>
    (runner as unknown as { runConfig: RunnableConfig }).runConfig;

  /** Five exchanges, so the history is comfortably longer than the kept tail. */
  const buildHistory = async (runner: InstanceType<typeof GthAgentRunner>) => {
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await runner.processMessages([new HumanMessage(text + PADDING)]);
    }
  };

  const noticesFrom = (): string[] =>
    statusUpdate.mock.calls.map((call) => String(call[1] ?? '')).filter(Boolean);

  for (const streamOutput of [true, false]) {
    const driver = streamOutput ? 'streaming' : 'non-streaming';

    it(`retries with a measurably smaller prompt and answers (${driver})`, async () => {
      const model = new OverflowingModel();
      const runner = await makeRunner(model, { streamOutput });
      await buildHistory(runner);
      const turnsBefore = model.requests.length;

      model.overflowsRemaining = 1;
      const answer = await runner.processMessages([new HumanMessage('SIX' + PADDING)]);

      // The answer arrived: the turn recovered rather than surfacing a failure.
      expect(answer).toContain('answer: SIX');

      // Exactly two turn attempts, and exactly one compaction between them.
      expect(model.requests.length).toBe(turnsBefore + 2);
      expect(model.summaryCalls).toBe(1);

      const failed = conversationSize(model.requests[turnsBefore]);
      const retried = conversationSize(model.requests[turnsBefore + 1]);
      expect(retried.messages).toBeLessThan(failed.messages);
      expect(retried.characters).toBeLessThan(failed.characters);

      // The retry's prompt is the compacted one: a summary at the head of the conversation, and the
      // user's pending turn still last and present exactly once — the duplication a re-send (rather
      // than a resume) would have caused is invisible in the answer, so it is asserted here.
      const retryRequest = model.requests[turnsBefore + 1];
      expect(retryRequest.some((m) => isCompactionSummary(m))).toBe(true);
      const sixes = retryRequest.filter(
        (m) => HumanMessage.isInstance(m) && String(m.content).startsWith('SIX')
      );
      expect(sixes.length).toBe(1);
      expect(String(retryRequest[retryRequest.length - 1].content)).toContain('SIX');

      // And the graph holds one copy too, so the next turn does not inherit a duplicate.
      const agent = runner.getAgent() as GthAbstractAgent;
      const state = await agent.getConversationMessages(runConfigOf(runner));
      expect(
        state.filter((m) => HumanMessage.isInstance(m) && String(m.content).startsWith('SIX'))
          .length
      ).toBe(1);

      // `/debug-dump`'s snapshot agrees with what the model received. It is captured at
      // `wrapModelCall`, where the request is still `state.messages` — langchain prepends the static
      // system prompt after that — so the comparison drops the system message and nothing else.
      expect(conversationSize(agent.lastModelRequest!.messages)).toEqual(
        conversationSize(retryRequest.filter((m) => !SystemMessage.isInstance(m)))
      );

      // The user was told, in one line, what happened.
      expect(noticesFrom().some((n) => /context overflowed.*folded into a summary/i.test(n))).toBe(
        true
      );
    });

    it(`ends the turn on a SECOND overflow — one compaction, one retry, no loop (${driver})`, async () => {
      const model = new OverflowingModel();
      const runner = await makeRunner(model, { streamOutput });
      await buildHistory(runner);
      const turnsBefore = model.requests.length;

      model.overflowsRemaining = 2;
      await expect(runner.processMessages([new HumanMessage('SIX' + PADDING)])).rejects.toThrow();

      // Two attempts and no third: the retry budget is one, and it is spent.
      expect(model.requests.length).toBe(turnsBefore + 2);
      // One compaction, not two: a second fold would eat the tail the first one just kept.
      expect(model.summaryCalls).toBe(1);

      const reason = runner.getTerminationReason();
      expect(reason?.category).toBe('context_overflow');
      expect(reason?.site).toBe('runner.overflow-compact-exhausted');
      expect(reason?.remedy).toBe('reduce-context');
    });
  }

  it('does not compact when there is nothing left to fold, and says so at its own site', async () => {
    const model = new OverflowingModel();
    const runner = await makeRunner(model);
    // No history at all: the pending human turn alone is shorter than the kept tail, so the
    // mechanism reports `changed: false` and there is no smaller prompt to retry with.
    model.overflowsRemaining = 1;
    await expect(runner.processMessages([new HumanMessage('ONLY' + PADDING)])).rejects.toThrow();

    expect(model.requests.length).toBe(1);
    expect(model.summaryCalls).toBe(0);
    const reason = runner.getTerminationReason();
    expect(reason?.category).toBe('context_overflow');
    expect(reason?.site).toBe('runner.overflow-compact');
    expect(noticesFrom().some((n) => /nothing left to compact/i.test(n))).toBe(true);
  });

  it('leaves a failure that is NOT an overflow entirely alone — the control that must survive', async () => {
    // Without this, a seam that compacted on every thrown error would pass every cell above.
    const model = new OverflowingModel();
    const runner = await makeRunner(model);
    await buildHistory(runner);
    const turnsBefore = model.requests.length;
    vi.spyOn(model, '_generate').mockRejectedValueOnce(new Error('the provider is on fire'));

    await expect(runner.processMessages([new HumanMessage('SIX' + PADDING)])).rejects.toThrow(
      /on fire/
    );
    // One attempt, no compaction, no retry.
    expect(model.summaryCalls).toBe(0);
    expect(model.requests.length).toBe(turnsBefore);
    expect(runner.getTerminationReason()?.category).not.toBe('context_overflow');
  });

  it('does not compact a TRUNCATED OUTPUT — the remedy for that one is not less context', async () => {
    // The spike's second failure: the answer was cut off against the output cap. It is classified
    // (`output_truncated`) and surfaced by EXT-159, and folding the history would not add one token
    // of room to the part that ran out — so the seam must leave it alone.
    const model = new OverflowingModel();
    const runner = await makeRunner(model, { streamOutput: false });
    await buildHistory(runner);
    model.responseMetadata = { finish_reason: 'length' };

    const answer = await runner.processMessages([new HumanMessage('SIX' + PADDING)]);

    expect(answer).toContain('answer: SIX');
    expect(model.summaryCalls).toBe(0);
    const reason = runner.getTerminationReason();
    expect(reason?.category).toBe('output_truncated');
    expect(reason?.site).not.toBe('runner.overflow-compact');
    expect(reason?.site).not.toBe('runner.overflow-compact-exhausted');
  });

  it('still refuses the idle /compact seam while a turn is in flight', async () => {
    // The guard-free internal must not have become a guard-free PUBLIC method: `/compact` still
    // refuses to rewrite the thread underneath a running turn.
    const model = new OverflowingModel();
    const runner = await makeRunner(model);
    await buildHistory(runner);
    const runnerInternals = runner as unknown as { turnsInFlight: number };
    runnerInternals.turnsInFlight = 1;
    await expect(runner.compactConversation()).rejects.toThrow(/turn is still running/i);
    runnerInternals.turnsInFlight = 0;
  });
});
