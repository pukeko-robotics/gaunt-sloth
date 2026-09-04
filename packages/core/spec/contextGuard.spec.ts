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

/**
 * LangChain's own fallback guess for a context window it does not recognise. The unknown-window
 * cell below uses this exact number rather than a round one, because the mutation it has to
 * discriminate is precisely "the guard inherited THIS guess" — see `contextWindow.ts`.
 */
const LANGCHAIN_FALLBACK_WINDOW_GUESS = 4097;

/**
 * A conversation whose estimate alone clears {@link LANGCHAIN_FALLBACK_WINDOW_GUESS}.
 *
 * `longHistory()` cannot do that job: it estimates ~1537 tokens, so at a 4097 window it fits with
 * room to spare and an unknown-window assertion built on it stays green even if the guard starts
 * guessing 4097. Sizing the fixture ABOVE the guess is what makes the absence assertion able to
 * fail, which is the whole point of the control.
 */
const overflowingHistory = (): BaseMessage[] => {
  const messages: BaseMessage[] = [];
  for (let i = 0; i < 10; i++) {
    messages.push(new HumanMessage(`ask ${i} ` + 'x'.repeat(1200)));
    messages.push(new AIMessage(`answer ${i} ` + 'y'.repeat(1200)));
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

  it('counts non-text content blocks, which the character source drops', () => {
    // `conversationSize` reads content through compaction's `contentText`, which returns '' for any
    // block without a string `text` field. An image or a structured tool result would therefore
    // weigh nothing, and the guard would under-count the payload most likely to fill the window —
    // the one direction none of the other approximations here err in.
    const textOnly = [new HumanMessage({ content: [{ type: 'text', text: 'hello' }] })];
    const withImage = [
      new HumanMessage({
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,' + 'A'.repeat(4000) },
          },
        ],
      }),
    ];
    const plain = estimatePromptTokens(textOnly);
    const withBlock = estimatePromptTokens(withImage);
    // Strictly larger, and by roughly the block's own weight — a 4000-character payload is about
    // 1257 tokens at this file's ratio and margin. Before this was counted the two were EQUAL.
    expect(withBlock).toBeGreaterThan(plain);
    expect(withBlock - plain).toBeGreaterThan(1000);

    // And the text block itself is still counted exactly once: an identical conversation whose text
    // is longer must also weigh more, which would not hold if the mirror of `contentText`'s accept
    // conditions had drifted and text were being double-counted or skipped.
    const longerText = [
      new HumanMessage({ content: [{ type: 'text', text: 'hello' + 'z'.repeat(700) }] }),
    ];
    expect(estimatePromptTokens(longerText)).toBeGreaterThan(plain);
  });

  /**
   * The cell above pins that a non-text block is counted AT ALL. This one pins that it is counted
   * with a BOUND, which is a different claim and the one the first version of this code got wrong:
   * it charged the block's serialised length, and an inline image's encoded length is nothing like
   * its cost. Measured on the pre-cap code, a 100 KB PNG was charged **42 920 tokens** — more than
   * any window this project wires, so the guard folded the conversation on every single turn.
   *
   * Both bounds are written out as literals rather than derived from the allowance constant. A cell
   * that computed its own ceiling from the constant under test would follow it anywhere and could
   * not fail — the defect the C item existed to remove from this file.
   */
  it('caps one non-text block, so a large image cannot fold every turn', () => {
    const plain = estimatePromptTokens([
      new HumanMessage({ content: [{ type: 'text', text: 'hello' }] }),
    ]);
    // ~136 500 base64 characters is a 100 KB PNG — an ordinary screenshot, not a pathological input.
    const huge = estimatePromptTokens([
      new HumanMessage({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: `data:image/png;base64,${'A'.repeat(136500)}` },
        ],
      }),
    ]);
    const attributedToTheImage = huge - plain;
    // Still counted — the under-count this function exists to fix must not come back.
    expect(attributedToTheImage).toBeGreaterThan(1000);
    // And bounded. Providers charge on the order of a thousand tokens for such an image; this errs
    // high on purpose, but by a bounded factor. Pre-cap this number was 42 920.
    expect(attributedToTheImage).toBeLessThan(2000);

    // The cap is a CEILING, not a flat charge: a block smaller than it is still counted at its own
    // length, so a modest structured tool result is not billed as if it were an image.
    const small = estimatePromptTokens([
      new HumanMessage({ content: [{ type: 'json', value: 'v'.repeat(1000) }] }),
    ]);
    expect(small).toBeGreaterThan(200);
    expect(small).toBeLessThan(attributedToTheImage);
  });

  /**
   * A block carrying BOTH a string `text` field and a payload. The earlier version mirrored
   * `contentText`'s accept conditions exactly, which meant it skipped such a block whole: its text
   * was counted by `contentText` and **its payload was counted by nothing**. That is the same
   * under-count in a narrower shape, and it is the unsafe direction — a silent zero lets a turn
   * through that overflows, where an over-count only wastes a summary call.
   */
  it('counts the payload of a block that also carries text', () => {
    const withPayload = estimatePromptTokens([
      new HumanMessage({ content: [{ type: 'thing', text: 'ok', data: 'z'.repeat(40000) }] }),
    ]);
    // Before this was fixed the whole block weighed 1 token: 'ok' and nothing else.
    expect(withPayload).toBeGreaterThan(1000);

    // THE CONTROL, and the reason this cannot be fixed by simply counting every block whole: an
    // ORDINARY text block must still weigh exactly what the same text weighs as a bare string.
    // Charging a text block's leftover keys would make these two differ, and the system prompt is
    // itself an array of text blocks, so that noise would land on every single request.
    const asBlock = estimatePromptTokens([
      new HumanMessage({ content: [{ type: 'text', text: 'x'.repeat(3500) }] }),
    ]);
    const asString = estimatePromptTokens([new HumanMessage('x'.repeat(3500))]);
    expect(asBlock).toBe(asString);
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
    // The fixture is sized ABOVE 4097 on purpose. The mutation this cell has to catch is the guard
    // treating an unknown window as LangChain's 4097 fallback guess, and a fixture that fits inside
    // 4097 cannot tell that mutation from correct behaviour — both leave the conversation alone.
    const messages = overflowingHistory();
    expect(estimatePromptTokens(messages)).toBeGreaterThan(LANGCHAIN_FALLBACK_WINDOW_GUESS);

    const compactUnknown = vi.fn(realCompact);
    const unknown = createContextGuardMiddleware({
      windowSource: UNKNOWN_CONTEXT_WINDOW,
      compact: compactUnknown,
    });
    expect(await runHook(unknown, messages)).toBeUndefined();
    expect(compactUnknown).not.toHaveBeenCalled();

    // THE CONTROL, and it is deliberately the 4097 case itself. Identical history, identical
    // estimate, identical (default) reserve — the ONLY difference is that the window is the guess
    // instead of unknown. It compacts. So if the guard ever adopts that guess for an unknown
    // window, the absence assertion above becomes this one and goes red.
    const compactKnown = vi.fn(realCompact);
    const known = createContextGuardMiddleware({
      windowSource: async () => LANGCHAIN_FALLBACK_WINDOW_GUESS,
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
    // The reserve is deliberately NOT passed. This cell is the regression pin for the live
    // thrashing, which happened on the DEFAULT reserve, and a default passed explicitly takes the
    // configured path with its more generous clamp — the same number, a different rule.
    const compact = vi.fn(realCompact);
    const middleware = createContextGuardMiddleware({
      windowSource: async () => 2048,
      compact,
    });
    const short = [new HumanMessage('hello'), new AIMessage('hi')];
    expect(await runHook(middleware, short)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();

    // The clamp is a ceiling, not a floor: a conversation genuinely near the window still trips.
    const nearlyFull = createContextGuardMiddleware({
      windowSource: async () => 2048,
      compact: vi.fn(realCompact),
    });
    expect(await runHook(nearlyFull, longHistory())).toBeDefined();
  });

  /**
   * Every number below is written out rather than derived from the constant under test. An earlier
   * version of this cell computed its own cap as `window * MAX_RESERVE_FRACTION_OF_WINDOW` and then
   * sized the window from that, so the arithmetic followed the constant wherever it went and the
   * cell could not fail on a change to it — the assertion-that-cannot-fail shape. The clamp's VALUE
   * is the entire content of the fix for the live thrashing, so it is pinned here in both
   * directions with fixed numbers and an injected estimate.
   */
  it('pins the DEFAULT reserve at a quarter of the window — in both directions', async () => {
    const fixedEstimate = (estimate: number) => () => estimate;

    // Raising the fraction must red this. Window 4096, estimate 3000, default reserve:
    //   at 1/4 the reserve is 1024 and 3000 + 1024 = 4024 fits, so nothing happens;
    //   at 1/2 it is 2048 and 3000 + 2048 = 5048 does not fit, so it would compact.
    const fits = vi.fn(realCompact);
    expect(
      await runHook(
        createContextGuardMiddleware({
          windowSource: async () => 4096,
          compact: fits,
          estimateTokens: fixedEstimate(3000),
        }),
        longHistory()
      )
    ).toBeUndefined();
    expect(fits).not.toHaveBeenCalled();

    // Lowering it must red this too. Same window, estimate 3400, default reserve:
    //   at 1/4 the reserve is 1024 and 3400 + 1024 = 4424 overflows, so it compacts;
    //   at 1/8 it is 512 and 3400 + 512 = 3912 fits, so nothing would happen.
    const overflows = vi.fn(realCompact);
    expect(
      await runHook(
        createContextGuardMiddleware({
          windowSource: async () => 4096,
          compact: overflows,
          estimateTokens: fixedEstimate(3400),
        }),
        longHistory()
      )
    ).toBeDefined();
    expect(overflows).toHaveBeenCalledTimes(1);
  });

  it('honours a configured reserve above a quarter of the window, and reduces one above a half', async () => {
    const fixedEstimate = (estimate: number) => () => estimate;

    // The measured regression: `numCtx: 16384` with `numPredict: 8192`. Clamping a number the user
    // chose down to a quarter (4096) makes the guard see 12044 + 4096 = 16140 and pass a turn whose
    // answer is then 3852 tokens short. Honoured at a half (8192), 12044 + 8192 = 20236 overflows
    // and the conversation is folded before the call — which is the point of the reserve.
    const honoured = vi.fn(realCompact);
    expect(
      await runHook(
        createContextGuardMiddleware({
          windowSource: async () => 16384,
          reserve: 8192,
          compact: honoured,
          estimateTokens: fixedEstimate(12044),
        }),
        longHistory()
      )
    ).toBeDefined();
    expect(honoured).toHaveBeenCalledTimes(1);

    // A configured number is still not unlimited. Window 4096, reserve 4000, estimate 2000:
    // reduced to half the window it is 2048 and 2000 + 2048 = 4048 fits, so the turn goes through.
    // Left unreduced it would be 4000, 2000 + 4000 = 6000 overflows, and the guard would fold a
    // conversation on every turn — the thrashing the default clamp exists to stop.
    const reduced = vi.fn(realCompact);
    expect(
      await runHook(
        createContextGuardMiddleware({
          windowSource: async () => 4096,
          reserve: 4000,
          compact: reduced,
          estimateTokens: fixedEstimate(2000),
        }),
        longHistory()
      )
    ).toBeUndefined();
    expect(reduced).not.toHaveBeenCalled();
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

  /**
   * The two cells above pin the estimator's arithmetic on blocks. This pins the DECISION that
   * arithmetic feeds, which is the thing a user would actually notice, and it pins it in both
   * directions from one fixture — the same conversation shape, once inside the window and once
   * genuinely past it.
   *
   * The window is 16384, a realistic ollama `num_ctx`, so the default reserve clamps to 4096 and
   * lands at 2048; the guard therefore fires above 14336 estimated tokens. Three 100 KB images
   * estimate at about 5280, so they sit well inside it. On the pre-cap code the same three were
   * charged over 128 000 tokens, so the first arm below folded a conversation that fits — every
   * turn, for as long as the images stayed in the history.
   */
  it('leaves an image-bearing conversation that FITS alone, and still folds one that does not', async () => {
    const image = () => ({
      type: 'image_url',
      image_url: `data:image/png;base64,${'A'.repeat(136500)}`,
    });
    // Twelve messages either way, so there is always a foldable span past the kept-recent tail.
    const conversation = (padding: number): BaseMessage[] => {
      const messages: BaseMessage[] = [];
      for (let i = 0; i < 6; i++) {
        messages.push(
          new HumanMessage({
            content:
              i < 3
                ? [{ type: 'text', text: `ask ${i} ` + 'x'.repeat(padding) }, image()]
                : [{ type: 'text', text: `ask ${i} ` + 'x'.repeat(padding) }],
          })
        );
        messages.push(new AIMessage(`answer ${i} ` + 'y'.repeat(padding)));
      }
      return messages;
    };

    // FITS: three images and a few words each. Nothing is folded — the hook returns undefined.
    const fitting = vi.fn(realCompact);
    expect(
      await runHook(
        createContextGuardMiddleware({ windowSource: async () => 16384, compact: fitting }),
        conversation(20)
      )
    ).toBeUndefined();
    expect(fitting).not.toHaveBeenCalled();

    // DOES NOT FIT: the same three images, now with a genuinely oversized conversation around them.
    // The cap must not have turned the guard off — only bounded what one block can claim.
    const overflowing = vi.fn(realCompact);
    const result = await runHook(
      createContextGuardMiddleware({ windowSource: async () => 16384, compact: overflowing }),
      conversation(4500)
    );
    expect(result).toBeDefined();
    expect(overflowing).toHaveBeenCalled();
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
  numPredict?: number;
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

  /**
   * The cell above pins the FUNCTION — it passes the character count in as an argument. This one
   * pins the ASSIGNMENT that makes production feed it a real number, which is a different claim and
   * was previously untested: setting `systemPromptCharacters = 0` in `init` left every cell green.
   *
   * It works by making the guard's DECISION depend on the prompt being counted. The conversation is
   * deliberately tiny — a few dozen characters — so the graph state alone comes nowhere near the
   * window, and the only thing that can push the estimate over it is the system prompt, which never
   * appears in `state.messages` at all. Measured in this fixture: the composed prompt is ~2396
   * characters with the prompt segments on and ~253 with them off, so the pair below straddles the
   * 900-token window by a wide margin in both directions.
   */
  it('feeds the guard the REAL system prompt length, not zero', async () => {
    const runTurns = async (extraConfig: Record<string, unknown>) => {
      const model = new RecordingModel();
      model.llmType = 'ollama';
      model.numCtx = 900;
      model.baseUrl = 'http://127.0.0.1:11434';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );
      const runner = new GthAgentRunner(statusUpdate, {
        resolveTools: vi.fn().mockResolvedValue([lookup]),
        resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
      });
      await runner.init(
        'chat',
        { ...BASE_CONFIG, ...extraConfig, llm: model } as unknown as GthConfig,
        new MemorySaver()
      );
      // Six short turns: twelve messages, which is past the kept tail so there IS something to
      // fold. Every message is a handful of characters, so the state's own contribution is noise.
      for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
        await runner.processMessages([new HumanMessage(text)]);
      }
      return statusUpdate.mock.calls.some((call) =>
        /context is nearly full/i.test(String(call[1] ?? ''))
      );
    };

    // With the prompt counted the estimate clears the window and the guard folds.
    expect(await runTurns({})).toBe(true);

    // THE CONTROL: the same tiny conversation, the same window, the prompt segments switched off so
    // the composed prompt collapses to the date and model note. Nothing triggers — which is what
    // the run above would also do if the assignment stopped feeding the real number.
    statusUpdate.mockClear();
    const off = { enabled: false } as const;
    expect(
      await runTurns({
        prompts: { system: off, chat: off, backstory: off, guidelines: off },
      })
    ).toBe(false);
  });

  /**
   * The four cells that pin the two reserve fractions all construct the middleware directly with
   * `reserve` already set, so what they pin is the clamping ARITHMETIC. None of them asserts that
   * production ever hands the user's `numPredict` to it — deleting that forwarding in `init` left
   * every other cell in this file green, so a user's configured answer budget could stop reaching
   * the guard entirely with nothing red. This is the wiring cell, built the way the system-prompt
   * one above is: drive a real runner through `init` and make the guard's DECISION depend on it.
   *
   * The discriminator is the window arithmetic. At `numCtx` 4096 a reserve nobody chose is clamped
   * to a quarter of the window (1024) and one the user set to a half (2048), so between those two
   * bars lies a band of conversation sizes that folds under a configured `numPredict: 2048` and not
   * under the default. Measured in this fixture that band runs from about 700 to about 1300
   * characters of padding per turn; 1000 sits in the middle, roughly 300 clear on either side.
   */
  it('hands the user configured numPredict to the guard, not just the default', async () => {
    const runTurns = async (numPredict?: number) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        })
      );
      const model = new RecordingModel();
      model.llmType = 'ollama';
      model.numCtx = 4096;
      model.baseUrl = 'http://127.0.0.1:11434';
      if (numPredict !== undefined) model.numPredict = numPredict;
      const runner = new GthAgentRunner(statusUpdate, {
        resolveTools: vi.fn().mockResolvedValue([lookup]),
        resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
      });
      await runner.init(
        'chat',
        { ...BASE_CONFIG, llm: model } as unknown as GthConfig,
        new MemorySaver()
      );
      const padding = ' ' + 'x'.repeat(1000);
      for (const text of ['one', 'two', 'three', 'four', 'five', 'six']) {
        await runner.processMessages([new HumanMessage(text + padding)]);
      }
      return statusUpdate.mock.calls.some((call) =>
        /context is nearly full/i.test(String(call[1] ?? ''))
      );
    };

    // The user asked for a 2048-token answer, so 2048 is held back and this history no longer fits.
    expect(await runTurns(2048)).toBe(true);

    // THE CONTROL: the identical conversation with no `numPredict` configured. The default reserve
    // clamps to 1024 and the same history fits — which is also what the run above would report if
    // `init` stopped forwarding the user's number.
    statusUpdate.mockClear();
    expect(await runTurns()).toBe(false);
  });
});
