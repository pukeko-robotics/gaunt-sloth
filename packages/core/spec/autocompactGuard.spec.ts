/**
 * EXT-161 — **the default-on path through the guard**, driven by the real
 * {@link AutocompactController} rather than by a hand-supplied number.
 *
 * `compaction.spec.ts` already pins the four history-shape invariants (a)–(d) per provider
 * converter, so this file does NOT re-prove the shapes. What it proves is the thing being on by
 * default adds: that the threshold the controller resolves is the threshold the guard enforces,
 * that the off switch leaves `state.messages` untouched, and that an unknown window folds nothing.
 *
 * Every "does not fire" cell is written as a DISCRIMINATING PAIR — the same harness, the same
 * conversation, one thing changed — because a no-compaction assertion passes just as happily
 * against a harness that never wired the guard at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  createContextGuardMiddleware,
  defaultCompactionThreshold,
  effectiveOutputReserve,
  estimatePromptTokens,
} from '#src/core/GthLangChainAgent.js';
import { AutocompactController, resolveAutocompactConfig } from '#src/core/compactionThreshold.js';
import { compactMessages, isCompactionSummary } from '#src/core/compaction.js';
import type { ContextWindowReading } from '#src/core/contextWindow.js';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/utils/consoleUtils.js')>()),
  displayDebug: vi.fn(),
}));

interface HookResult {
  messages?: BaseMessage[];
}

const runHook = async (middleware: any, messages: BaseMessage[]): Promise<HookResult | undefined> =>
  (middleware.beforeModel.hook ?? middleware.beforeModel)({ messages });

/**
 * A conversation long enough that the default keep-recent tail leaves something to fold.
 *
 * `pairs` is a parameter because the derived-default cell needs an estimate above 8192 tokens: the
 * answer reserve is clamped to a QUARTER of the window below that size, so on a tiny window the
 * derived threshold is 0.75 × window rather than window − 2048, and a cell that assumed the flat
 * reserve would be computing the wrong number to sit either side of.
 */
const longHistory = (pairs = 6): BaseMessage[] => {
  const messages: BaseMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push(new HumanMessage(`ask ${i} ` + 'x'.repeat(400)));
    messages.push(new AIMessage(`answer ${i} ` + 'y'.repeat(400)));
  }
  return messages;
};

const RESERVE = 2048;
const windowOf = (reading: ContextWindowReading) => ({ read: async () => reading });

/** The guard as `GthLangChainAgent.init` wires it: one controller, one window, one threshold. */
function guardFor(
  config: unknown,
  reading: ContextWindowReading,
  compact = vi.fn(async (messages: BaseMessage[]) =>
    compactMessages({ messages, summarize: async () => 'a summary' })
  )
) {
  const controller = new AutocompactController({
    config: resolveAutocompactConfig(config),
    window: windowOf(reading),
    defaultThreshold: (window) => defaultCompactionThreshold(window, RESERVE, false),
  });
  const middleware = createContextGuardMiddleware({
    windowSource: async () => reading.tokens,
    thresholdSource: () => controller.threshold(),
    compact,
  });
  return { controller, middleware, compact };
}

describe('EXT-161 — the configured threshold is the one the guard enforces', () => {
  /**
   * The pair that proves the threshold is load-bearing: one conversation, two thresholds either
   * side of its estimate. A single-threshold cell would pass against a guard that compacted
   * unconditionally, or one that never did.
   */
  it('folds above the configured threshold and leaves the conversation alone below it', async () => {
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages, 0);

    const below = guardFor(estimate - 1, { tokens: 1_000_000, origin: 'models.dev' });
    const above = guardFor(estimate + 1, { tokens: 1_000_000, origin: 'models.dev' });

    const folded = await runHook(below.middleware, messages);
    const untouched = await runHook(above.middleware, messages);

    expect(folded?.messages).toBeDefined();
    expect(below.compact).toHaveBeenCalledTimes(1);

    expect(untouched).toBeUndefined();
    expect(above.compact).not.toHaveBeenCalled();
  });

  it('a session /autocompact moves the threshold the guard uses, mid-session', async () => {
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages, 0);
    // Configured well above the estimate, so nothing fires to begin with.
    const { controller, middleware, compact } = guardFor(estimate + 100_000, {
      tokens: 1_000_000,
      origin: 'models.dev',
    });

    expect(await runHook(middleware, messages)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();

    // The hook holds no state and re-reads the threshold before every call, which is what lets a
    // command typed later change what it does.
    controller.setSessionBudget({ kind: 'tokens', tokens: estimate - 1 });

    expect(await runHook(middleware, messages)).toBeDefined();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('a percentage threshold is enforced as its resolved absolute number', async () => {
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages, 0);
    // A window 50× the estimate: 1% of it is half the estimate (so the guard fires), and 90% of it
    // is 45× the estimate (so it does not). Derived from the estimate rather than written as a
    // literal, so the pair stays either side of it if the estimator's ratio ever changes.
    const window = estimate * 50;
    const tight = guardFor('1%', { tokens: window, origin: 'models.dev' });
    const loose = guardFor('90%', { tokens: window, origin: 'models.dev' });

    expect(Math.floor(window * 0.01)).toBeLessThan(estimate);
    expect(Math.floor(window * 0.9)).toBeGreaterThan(estimate);
    expect(await runHook(tight.middleware, messages)).toBeDefined();
    expect(await runHook(loose.middleware, messages)).toBeUndefined();
  });
});

describe('EXT-161 — the default-on path, and the one key that turns it off', () => {
  it('is ON with no config at all: a conversation past the derived threshold is folded', async () => {
    // Compaction on by default is a RULED exception to the default-on-middleware rule, so the
    // default path is asserted directly rather than assumed.
    // 40 exchanges puts the estimate comfortably above 8192 tokens, where the answer reserve is the
    // flat 2048 rather than a quarter of the window — so `window − reserve` is the derived rule
    // being exercised here.
    const messages = longHistory(40);
    const estimate = estimatePromptTokens(messages, 0);
    const window = estimate + RESERVE - 1;
    const { middleware, compact } = guardFor(undefined, { tokens: window, origin: 'models.dev' });

    // The reserve really is the flat one at this size, and the derived threshold really is under
    // the estimate — stated rather than assumed, so a change to either constant fails here loudly
    // instead of quietly turning this into a test of nothing.
    expect(effectiveOutputReserve(window, RESERVE, false)).toBe(RESERVE);
    expect(defaultCompactionThreshold(window, RESERVE, false)).toBeLessThan(estimate);

    expect(await runHook(middleware, messages)).toBeDefined();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  /**
   * **The off switch is one key, and it leaves `state.messages` untouched.**
   *
   * The pair is the point: the identical conversation and window with the key absent DOES fold, so
   * this cannot pass by simply failing to reach the guard.
   */
  it('folds nothing when `autocompact: false`, while the same setup without it folds', async () => {
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages, 0);
    const reading: ContextWindowReading = { tokens: estimate - 1, origin: 'models.dev' };

    const off = guardFor(false, reading);
    const on = guardFor(undefined, reading);

    const offResult = await runHook(off.middleware, messages);
    const onResult = await runHook(on.middleware, messages);

    // Off: no state update at all, and the compaction was never even attempted.
    expect(offResult).toBeUndefined();
    expect(off.compact).not.toHaveBeenCalled();
    // And the input list itself is the object it always was, unmutated.
    expect(messages).toHaveLength(12);
    expect(messages.every((m) => !isCompactionSummary(m))).toBe(true);

    // On: the discriminator.
    expect(onResult?.messages).toBeDefined();
    expect(on.compact).toHaveBeenCalledTimes(1);
  });

  it('`{ enabled: false }` is the same switch as `false`', async () => {
    const messages = longHistory();
    const reading: ContextWindowReading = {
      tokens: estimatePromptTokens(messages, 0) - 1,
      origin: 'models.dev',
    };
    const { middleware, compact } = guardFor({ enabled: false }, reading);
    expect(await runHook(middleware, messages)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });
});

describe('EXT-161 — an unknown window folds nothing, and never guesses', () => {
  /**
   * The discriminating pair for the claim the whole feature rests on. The unknown case must not
   * fold; the known case, same conversation and same controller shape, must.
   *
   * **The history is deliberately large, and that is what makes the unknown half able to fail.**
   * A control mutation — making the unknown-window branch fall back to the forbidden 4097 name
   * table — resolves to a 3073-token threshold. At the default `longHistory()` size the estimate
   * is roughly 1230 tokens, which is UNDER 3073, so the guard would decline to fold for the wrong
   * reason and this cell would pass against a production that guesses exactly the number the node
   * forbids. Sizing the conversation above that threshold is what converts "did not fold" from an
   * accident of the fixture into evidence that no threshold existed at all.
   */
  it('does not fold on an unknown window, while a known one does', async () => {
    const messages = longHistory(40);
    const estimate = estimatePromptTokens(messages, 0);

    const unknown = guardFor(undefined, { tokens: null, origin: 'unknown' });
    const known = guardFor(undefined, { tokens: estimate - 1, origin: 'models.dev' });

    expect(await runHook(unknown.middleware, messages)).toBeUndefined();
    expect(unknown.compact).not.toHaveBeenCalled();

    expect(await runHook(known.middleware, messages)).toBeDefined();
    expect(known.compact).toHaveBeenCalledTimes(1);
  });

  it('an ABSOLUTE configured threshold still protects a model whose window is unknown', async () => {
    const messages = longHistory();
    const estimate = estimatePromptTokens(messages, 0);
    const { middleware, compact } = guardFor(estimate - 1, { tokens: null, origin: 'unknown' });
    // The user named the number, so it needs no window — the one case where an unknown window
    // still leaves the session protected.
    expect(await runHook(middleware, messages)).toBeDefined();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('a PERCENTAGE threshold on an unknown window folds nothing rather than guessing', async () => {
    // Sized past the 4097-fallback threshold for the same reason as the pair above: a small
    // history would decline to fold even if production HAD guessed a window.
    const messages = longHistory(40);
    const { middleware, compact } = guardFor('1%', { tokens: null, origin: 'unknown' });
    expect(await runHook(middleware, messages)).toBeUndefined();
    expect(compact).not.toHaveBeenCalled();
  });
});

describe('EXT-161 — the default-on path over provider-shaped histories', () => {
  /**
   * The node requires the default-on path asserted over a Gemini-shaped and an Anthropic-shaped
   * history, and says a no-crash check is explicitly not sufficient. `compaction.spec.ts` runs the
   * real converters over the compacted output; what is asserted HERE is that the default-on path
   * produces output of that shape at all — the system prompt still first and untouched, the summary
   * a `HumanMessage` and never a mid-list `SystemMessage`, the tool pair intact, and the last
   * message of the input still the last message of the output.
   */
  const shapedHistory = (): BaseMessage[] => [
    new SystemMessage('you are a careful assistant'),
    ...Array.from({ length: 4 }, (_, i) => [
      new HumanMessage(`question ${i} ` + 'q'.repeat(400)),
      new AIMessage(`answer ${i} ` + 'a'.repeat(400)),
    ]).flat(),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call_1', name: 'gth_read_file', args: { path: 'README.md' } }],
    }),
    new ToolMessage({ content: 'r'.repeat(400), tool_call_id: 'call_1' }),
    new AIMessage('and here is what it says'),
    new HumanMessage('now the pending turn'),
  ];

  let folded: BaseMessage[];

  beforeEach(async () => {
    const messages = shapedHistory();
    const { middleware } = guardFor(undefined, {
      tokens: estimatePromptTokens(messages, 0) - 1,
      origin: 'models.dev',
    });
    const result = await runHook(middleware, messages);
    expect(result?.messages).toBeDefined();
    // The hook returns the RemoveMessage sentinel first; the replacement history follows it.
    folded = (result as HookResult).messages!.slice(1);
  });

  it('(b, Anthropic) keeps the system prompt first and carries the summary as a HumanMessage', () => {
    // `ChatAnthropic` rejects any system message that is not first, so a summary injected as a
    // mid-list SystemMessage is a hard failure on that provider.
    expect(SystemMessage.isInstance(folded[0])).toBe(true);
    expect(folded[0].content).toBe('you are a careful assistant');
    expect(folded.slice(1).some((m) => SystemMessage.isInstance(m))).toBe(false);
    expect(folded.filter(isCompactionSummary)).toHaveLength(1);
    expect(HumanMessage.isInstance(folded.find(isCompactionSummary)!)).toBe(true);
  });

  it('(a) never separates a tool_call from its tool_result', () => {
    const results = folded.filter((m): m is ToolMessage => ToolMessage.isInstance(m));
    for (const result of results) {
      const issuer = folded.find(
        (m) =>
          AIMessage.isInstance(m) &&
          (m.tool_calls ?? []).some((call) => call.id === result.tool_call_id)
      );
      // Orphaning either half is a hard 400 on OpenAI and Anthropic alike.
      expect(issuer).toBeDefined();
    }
  });

  it('(c, Gemini) leaves the last message of the input as the last message of the output', () => {
    // A trailing assistant message is a crash risk on Gemini and is silently accepted by Anthropic
    // as prefill, which is exactly why this is asserted on the SHAPE rather than by a live probe.
    expect(HumanMessage.isInstance(folded[folded.length - 1])).toBe(true);
    expect(folded[folded.length - 1].content).toBe('now the pending turn');
  });

  it('(d) converges: compacting the compacted history again leaves exactly one summary', async () => {
    const { middleware } = guardFor(undefined, {
      tokens: estimatePromptTokens(folded, 0) - 1,
      origin: 'models.dev',
    });
    const again = await runHook(middleware, folded);
    const twice = again?.messages ? again.messages.slice(1) : folded;
    expect(twice.filter(isCompactionSummary)).toHaveLength(1);
  });
});
