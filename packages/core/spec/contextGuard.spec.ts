/**
 * [[EXT-160]] — **the pre-call guard: the window it trusts, the estimate it makes, and the two
 * things it must never do.**
 *
 * The two are worth naming, because both are silent failures rather than loud ones:
 *
 * - **An unknown window must trigger nothing.** LangChain's own overflow fallback guesses 4097 for
 *   anything it does not recognise; a guard that inherited that guess would fold a conversation on
 *   a 262144-token local model for no reason. The cell for it asserts an ABSENCE, so it is paired
 *   with a control mutation — the same history and a KNOWN window — which proves the assertion is
 *   capable of failing.
 * - **A compaction that folds nothing must let the call proceed.** The factory runs once per
 *   session and the hook holds no state, so it recomputes from `state.messages` every time: if
 *   "over the window" and "nothing to fold" both hold and the hook kept trying, `beforeModel` would
 *   re-enter on identical state forever. A vitest timeout cannot rescue a spin, so the cell asserts
 *   the call count directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { CompactMessagesResult } from '#src/core/compaction.js';
import { compactMessages, isCompactionSummary } from '#src/core/compaction.js';
import {
  createContextGuardMiddleware,
  estimatePromptTokens,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  MAX_RESERVE_FRACTION_OF_WINDOW,
} from '#src/core/GthLangChainAgent.js';
import {
  DEFAULT_OLLAMA_NUM_CTX,
  resolveContextWindowSource,
  UNKNOWN_CONTEXT_WINDOW,
} from '#src/core/contextWindow.js';

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

/** Run the middleware's `beforeModel` hook directly — the unit under test in this file. */
type HookResult = { messages: BaseMessage[] } | undefined;
const runHook = async (
  middleware: ReturnType<typeof createContextGuardMiddleware>,
  messages: BaseMessage[]
): Promise<HookResult> => {
  const hook = (middleware as any).beforeModel.hook ?? (middleware as any).beforeModel;
  return hook({ messages });
};

/** A conversation long enough that the default keep-recent tail leaves something to fold. */
const longHistory = (): BaseMessage[] => {
  const messages: BaseMessage[] = [];
  for (let i = 0; i < 6; i++) {
    messages.push(new HumanMessage(`ask ${i} ` + 'x'.repeat(400)));
    messages.push(new AIMessage(`answer ${i} ` + 'y'.repeat(400)));
  }
  return messages;
};

const realCompact = (messages: BaseMessage[]): Promise<CompactMessagesResult> =>
  compactMessages({ messages, summarize: async () => 'SUMMARY' });

describe('EXT-160 — the ollama context window source', () => {
  const ollamaModel = (extra: Record<string, unknown> = {}) => ({
    _llmType: () => 'ollama',
    numCtx: 16384,
    model: 'gemma4:12b',
    baseUrl: 'http://127.0.0.1:11434',
    ...extra,
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  const stubShow = (body: unknown, ok = true) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok, json: async () => body }))
    );

  it('uses the configured numCtx — the number the request will actually carry', async () => {
    stubShow({ model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 262144 } });
    const source = resolveContextWindowSource(ollamaModel({ numCtx: 8192 }));
    expect(await source()).toBe(8192);
  });

  it("caps numCtx at the model's own context_length when the daemon reports a smaller one", async () => {
    // Asking for more than the model holds does not buy more room, so guarding against the larger
    // number would let exactly the truncation this guard exists to prevent happen anyway.
    stubShow({ model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 } });
    const source = resolveContextWindowSource(ollamaModel({ numCtx: 16384, model: 'llama3' }));
    expect(await source()).toBe(4096);
  });

  it('falls back to the configured number when the daemon is absent — and does not throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const source = resolveContextWindowSource(ollamaModel({ numCtx: 16384 }));
    await expect(source()).resolves.toBe(16384);
  });

  it('falls back to the shared default for a model built without numCtx', async () => {
    // `providers/ollama.ts` always sets `numCtx`, so this branch is reached only by a hand-written
    // JS config — but the number it lands on must still be the one the request would carry.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const source = resolveContextWindowSource(ollamaModel({ numCtx: undefined }));
    expect(await source()).toBe(DEFAULT_OLLAMA_NUM_CTX);
  });

  it('asks the daemon once per session, however many calls the guard makes', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        model_info: { 'general.architecture': 'gemma4', 'gemma4.context_length': 4096 },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const source = resolveContextWindowSource(ollamaModel());
    await Promise.all([source(), source(), source()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('answers null for every provider no source is wired for', async () => {
    // The production default for nine of ten providers, not a test-only path — which is why the
    // guard is installed unconditionally and is nonetheless inert on all of them.
    expect(await resolveContextWindowSource({ _llmType: () => 'anthropic' })()).toBeNull();
    expect(await resolveContextWindowSource({})()).toBeNull();
    expect(await resolveContextWindowSource(undefined)()).toBeNull();
    expect(await UNKNOWN_CONTEXT_WINDOW()).toBeNull();
  });
});

describe('EXT-160 — the estimate, anchored on a real token count', () => {
  it('anchors on the last usage_metadata.input_tokens and extrapolates only the delta', () => {
    const anchored = new AIMessage({
      content: 'a',
      usage_metadata: { input_tokens: 5000, output_tokens: 1, total_tokens: 5001 },
    });
    const withAnchor = [
      new HumanMessage('x'.repeat(4000)),
      anchored,
      new HumanMessage('y'.repeat(350)),
    ];
    // Everything before the anchor is covered by its 5000; only the anchor message and what follows
    // it are extrapolated from characters.
    const estimate = estimatePromptTokens(withAnchor);
    expect(estimate).toBeGreaterThan(5000);
    // The 4000-character message BEFORE the anchor must not be counted twice. An estimator that
    // added EVERY character on top of the anchor lands at about 6870 for this fixture; this one
    // extrapolates only the ~351 characters since the anchor, so it lands just over 5600. 6000
    // discriminates between the two, which is the only thing this bound is for.
    expect(estimate).toBeLessThan(6000);
  });

  it('extrapolates everything, system prompt included, when nothing has measured yet', () => {
    const messages = [new HumanMessage('x'.repeat(350))];
    const withoutPrompt = estimatePromptTokens(messages, 0);
    const withPrompt = estimatePromptTokens(messages, 3500);
    // The static system prompt never appears in `state.messages`, so a guard that measured only the
    // state would under-count each request by its largest single block.
    expect(withPrompt).toBeGreaterThan(withoutPrompt);
    expect(withPrompt - withoutPrompt).toBeGreaterThan(1000);
  });

  it('does not add the system prompt on top of an anchor that already contains it', () => {
    const anchored = new AIMessage({
      content: 'a',
      usage_metadata: { input_tokens: 5000, output_tokens: 1, total_tokens: 5001 },
    });
    const messages = [new HumanMessage('hello'), anchored, new HumanMessage('again')];
    expect(estimatePromptTokens(messages, 4000)).toBe(estimatePromptTokens(messages, 0));
  });
});

describe('EXT-160 — the pre-call guard hook', () => {
  it('compacts before the call when the estimate plus the reserve exceeds the window', async () => {
    const compact = vi.fn(realCompact);
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 1000,
      reserve: 100,
      compact,
    });
    const messages = longHistory();
    const result = await runHook(middleware, messages);

    expect(compact).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    // The GS2-23 write shape: discard everything, keep what follows.
    const written = result!.messages;
    expect(RemoveMessage.isInstance(written[0])).toBe(true);
    expect((written[0] as RemoveMessage).id).toBe(REMOVE_ALL_MESSAGES);
    expect(written.length).toBeLessThan(messages.length + 1);
    expect(written.slice(1).some((m) => isCompactionSummary(m))).toBe(true);
  });

  it('leaves a conversation that fits entirely alone', async () => {
    const compact = vi.fn(realCompact);
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 1_000_000,
      compact,
    });
    expect(await runHook(middleware, longHistory())).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });

  it('never triggers on an UNKNOWN window — and the control proves the assertion can fail', async () => {
    const messages = longHistory();

    const compactUnknown = vi.fn(realCompact);
    const unknown = createContextGuardMiddleware({
      windowSource: UNKNOWN_CONTEXT_WINDOW,
      compact: compactUnknown,
    });
    expect(await runHook(unknown, messages)).toBeUndefined();
    expect(compactUnknown).not.toHaveBeenCalled();

    // THE CONTROL. Identical history, identical estimate — the ONLY difference is that the window
    // is known. It compacts, so the assertion above is measuring the window and not some accident
    // of the fixture being too small to trip anything.
    const compactKnown = vi.fn(realCompact);
    const known = createContextGuardMiddleware({
      windowSource: async () => 1000,
      reserve: 100,
      compact: compactKnown,
    });
    expect(await runHook(known, messages)).toBeDefined();
    expect(compactKnown).toHaveBeenCalledTimes(1);
  });

  it('treats a source that throws, or answers nonsense, as unknown', async () => {
    const compact = vi.fn(realCompact);
    for (const windowSource of [
      async () => {
        throw new Error('daemon exploded');
      },
      async () => 0,
      async () => Number.NaN,
    ]) {
      const middleware = createContextGuardMiddleware({ windowSource, compact });
      expect(await runHook(middleware, longHistory())).toBeUndefined();
    }
    expect(compact).not.toHaveBeenCalled();
  });

  it('triggers on a history that fits the window but not the window minus the reserve', async () => {
    // On ollama `num_ctx` covers prompt AND generation, so a prompt that "fits" with no room left
    // produces a truncated answer — the second failure wearing the first's clothes.
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages);
    const compactWithoutReserve = vi.fn(realCompact);
    const noReserve = createContextGuardMiddleware({
      windowSource: async () => estimate + 100,
      reserve: 0,
      compact: compactWithoutReserve,
    });
    expect(await runHook(noReserve, messages)).toBeUndefined();
    expect(compactWithoutReserve).not.toHaveBeenCalled();

    const compactWithReserve = vi.fn(realCompact);
    const withReserve = createContextGuardMiddleware({
      windowSource: async () => estimate + 100,
      reserve: 500,
      compact: compactWithReserve,
    });
    expect(await runHook(withReserve, messages)).toBeDefined();
    expect(compactWithReserve).toHaveBeenCalledTimes(1);
  });

  it('defaults the reserve rather than leaving the answer no room', async () => {
    // A window large enough that the quarter-of-the-window clamp does not bind, so the number under
    // test really is the default and not the ceiling.
    const messages: BaseMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push(new HumanMessage(`ask ${i} ` + 'x'.repeat(2000)));
      messages.push(new AIMessage(`answer ${i} ` + 'y'.repeat(2000)));
    }
    const estimate = estimatePromptTokens(messages);
    const window = estimate + DEFAULT_OUTPUT_RESERVE_TOKENS - 1;
    expect(Math.floor(window * MAX_RESERVE_FRACTION_OF_WINDOW)).toBeGreaterThanOrEqual(
      DEFAULT_OUTPUT_RESERVE_TOKENS
    );

    // Big enough for the prompt, one token short of the prompt plus the default reserve.
    const middleware = createContextGuardMiddleware({
      windowSource: async () => window,
      compact: vi.fn(realCompact),
    });
    expect(await runHook(middleware, messages)).toBeDefined();

    // One token more of window, and it does not trigger — so the cell is measuring the reserve.
    const roomy = createContextGuardMiddleware({
      windowSource: async () => window + 1,
      compact: vi.fn(realCompact),
    });
    expect(await runHook(roomy, messages)).toBeUndefined();
  });

  it('clamps the reserve to a fraction of the window, so a small window is not all headroom', async () => {
    // Measured live on a `num_ctx` of 2048: a flat 2048-token reserve makes `estimate + reserve >
    // window` true for EVERY call whatever the conversation holds, so the guard folded on every
    // turn and spent a summary call each time. A short conversation in a small window must be left
    // alone.
    const compact = vi.fn(realCompact);
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 2048,
      reserve: DEFAULT_OUTPUT_RESERVE_TOKENS,
      compact,
    });
    const short = [new HumanMessage('hello'), new AIMessage('hi')];
    expect(await runHook(middleware, short)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();

    // The clamp is a ceiling, not a floor: a conversation genuinely near the window still trips.
    const nearlyFull = createContextGuardMiddleware({
      windowSource: async () => 2048,
      reserve: DEFAULT_OUTPUT_RESERVE_TOKENS,
      compact: vi.fn(realCompact),
    });
    expect(await runHook(nearlyFull, longHistory())).toBeDefined();
  });

  it('never lets the clamped reserve exceed its quarter of the window', async () => {
    const window = 4000;
    const cap = Math.floor(window * MAX_RESERVE_FRACTION_OF_WINDOW);
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages);
    // A history that clears the window with more than the CAP to spare must not trigger, however
    // large the configured reserve.
    const middleware = createContextGuardMiddleware({
      windowSource: async () => estimate + cap + 10,
      reserve: 100_000,
      compact: vi.fn(realCompact),
    });
    expect(await runHook(middleware, messages)).toBeUndefined();
  });

  it('LETS THE CALL PROCEED when there is nothing to fold — the bail that stops it looping', async () => {
    // Over the window and nothing foldable: if the hook kept trying it would re-enter on identical
    // state forever, and a synchronous spin is not something a test timeout can interrupt. So this
    // asserts the call count, which is the only observation that distinguishes the two.
    const compact = vi.fn(realCompact);
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 1,
      reserve: 0,
      compact,
    });
    const tiny = [new HumanMessage('short')];
    for (let i = 0; i < 5; i++) {
      expect(await runHook(middleware, tiny)).toBeUndefined();
    }
    expect(compact).toHaveBeenCalledTimes(5);
  });

  it('sends the request as it is when the compaction itself fails', async () => {
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 1000,
      reserve: 100,
      compact: async () => {
        throw new Error('the summariser is down');
      },
    });
    await expect(runHook(middleware, longHistory())).resolves.toBeUndefined();
  });
});

/**
 * A model that records every request and answers the compaction summariser, so a real graph can be
 * asked what the model SAW rather than what the middleware returned. `_llmType` is settable so the
 * wiring cell can present itself as ollama.
 */
class RecordingModel extends BaseChatModel {
  requests: BaseMessage[][] = [];
  llmType = 'scripted';
  numCtx?: number;
  baseUrl?: string;
  model = 'test-model';

  constructor() {
    super({});
  }
  _llmType(): string {
    return this.llmType;
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const last = messages[messages.length - 1];
    const lastText = typeof last?.content === 'string' ? last.content : '';
    if (HumanMessage.isInstance(last) && lastText.startsWith('<role>')) {
      return { generations: [{ message: new AIMessage('SUMMARY'), text: 'SUMMARY' }] };
    }
    this.requests.push(messages);
    return { generations: [{ message: new AIMessage('answered'), text: 'answered' }] };
  }
}

const lookup = tool(async () => 'LOOKED-UP', {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({}),
});

const BASE_CONFIG = {
  streamOutput: false,
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

describe('EXT-160 — the guard as the lean agent installs it', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  const statusUpdate = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  const makeRunner = async (model: RecordingModel) => {
    const runner = new GthAgentRunner(statusUpdate, {
      resolveTools: vi.fn().mockResolvedValue([lookup]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    await runner.init(
      'chat',
      { ...BASE_CONFIG, llm: model } as unknown as GthConfig,
      new MemorySaver()
    );
    return runner;
  };

  it('compacts before the call on ollama — the model sees the compacted list, not the original', async () => {
    // No daemon: the window is the configured `numCtx`, which is what the request would carry.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const model = new RecordingModel();
    model.llmType = 'ollama';
    model.numCtx = 600;
    model.baseUrl = 'http://127.0.0.1:11434';
    const runner = await makeRunner(model);

    const padding = ' ' + 'x'.repeat(400);
    for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await runner.processMessages([new HumanMessage(text + padding)]);
    }

    const lastRequest = model.requests[model.requests.length - 1];
    // The model was handed a summary rather than the whole history: the compaction happened BEFORE
    // the call, which is the only point at which ollama's silent truncation can be prevented.
    expect(lastRequest.some((m) => isCompactionSummary(m))).toBe(true);
    expect(lastRequest.some((m) => String(m.content).startsWith('one'))).toBe(false);
    // And the last message is still the turn being asked, unfolded.
    expect(String(lastRequest[lastRequest.length - 1].content)).toContain('six');
    expect(
      statusUpdate.mock.calls.some((call) => /context is nearly full/i.test(String(call[1] ?? '')))
    ).toBe(true);
  });

  it('leaves every other provider untouched — the same history, no compaction', async () => {
    // The control for the cell above: identical fixture, `_llmType` the only difference.
    const model = new RecordingModel();
    const runner = await makeRunner(model);
    const padding = ' ' + 'x'.repeat(400);
    for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await runner.processMessages([new HumanMessage(text + padding)]);
    }
    const lastRequest = model.requests[model.requests.length - 1];
    expect(lastRequest.some((m) => isCompactionSummary(m))).toBe(false);
    expect(lastRequest.some((m) => String(m.content).startsWith('one'))).toBe(true);
  });

  it('counts the system prompt, which never appears in the graph state', async () => {
    const messages = [new HumanMessage('short')];
    const graphOnly = estimatePromptTokens(messages, 0);
    const withSystem = estimatePromptTokens(messages, 8000);
    expect(withSystem).toBeGreaterThan(graphOnly * 2);
    // Sanity: the estimator is fed characters, and a SystemMessage sitting in the state would be
    // counted by the ordinary path rather than by this argument.
    expect(estimatePromptTokens([new SystemMessage('x'.repeat(8000))], 0)).toBeGreaterThan(
      graphOnly
    );
  });
});
