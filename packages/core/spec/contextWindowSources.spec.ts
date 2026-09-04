/**
 * EXT-161 — **where a context window comes from, and which source wins when they disagree.**
 *
 * The ruled order is ollama, then models.dev, then the LangChain profile, then nothing. The
 * disagreement cells are the ones that carry weight: two sources AGREEING proves nothing about
 * precedence, so every precedence test here feeds deliberately conflicting numbers and asserts
 * which one lands.
 *
 * The tail of the file pins the contract the whole feature rests on — **an unknown window resolves
 * to `null`, never to a guess** — as a discriminating pair (a known window resolves to a number in
 * the same harness), so a miswired harness cannot pass it by answering `null` to everything.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_WINDOW_ORIGIN_LABELS,
  readProfileContextWindow,
  resolveContextWindow,
  resolveContextWindowSource,
  UNKNOWN_CONTEXT_WINDOW,
} from '#src/core/contextWindow.js';
import type { ProviderCatalog } from '#src/providers/modelCatalog.js';

/** A models.dev slice carrying one model id at one context limit. */
const catalogWith = (models: Record<string, number>): ProviderCatalog => ({
  providerId: 'anthropic',
  providerKey: 'anthropic',
  fetchedAt: Date.now(),
  models: Object.fromEntries(
    Object.entries(models).map(([id, context]) => [id, { limit: { context } }])
  ),
});

/** A chat model that reports a LangChain profile window, and nothing else. */
const modelWithProfile = (maxInputTokens: number): unknown => ({ profile: { maxInputTokens } });

describe('EXT-161 — models.dev outranks the LangChain profile (RULED)', () => {
  it('takes the catalog number when the two DISAGREE', async () => {
    // The measured case this ruling exists for: `@langchain/deepseek`'s own table reports a
    // 1,000,000-token window for `deepseek-chat`. A profile is a table compiled into a provider
    // package and moves only when that package is republished; the catalog refreshes on a 24h TTL.
    // So the profile can be wrong as well as absent, and wrong-and-confident means no preventive
    // compaction at all — exactly what this node exists to prevent.
    const catalogReader = vi.fn(async () => catalogWith({ 'deepseek-chat': 128_000 }));
    const reading = await resolveContextWindow(modelWithProfile(1_000_000), {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      catalogReader,
    }).read();

    expect(reading).toEqual({ tokens: 128_000, origin: 'models.dev' });
    // Naming the loser explicitly: a test asserting only `128000` would still pass if the profile
    // tier had been deleted rather than outranked.
    expect(readProfileContextWindow(modelWithProfile(1_000_000))).toBe(1_000_000);
  });

  it('falls through to the profile when the catalog has no entry for the model', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ 'some-other-model': 128_000 }));
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'a-model-the-catalog-never-heard-of',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('falls through to the profile when the catalog is unavailable altogether', async () => {
    // Offline, on-prem no-egress, or a cold cache: `getProviderCatalog` degrades to null and the
    // backstop takes over rather than the resolution failing.
    const catalogReader = vi.fn(async () => null);
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('survives a catalog reader that throws, and still reaches the profile', async () => {
    const catalogReader = vi.fn(async () => {
      throw new Error('models.dev exploded');
    });
    const reading = await resolveContextWindow(modelWithProfile(64_000), {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(reading).toEqual({ tokens: 64_000, origin: 'profile' });
  });

  it('never reaches the network from the runtime path: the catalog read is cache-only', async () => {
    // The resolution sits in front of the first model call of a session. `api.json` is a few MB
    // behind a 10s timeout, so a cold fetch here would be experienced as the agent hanging before
    // it said anything — and it would write the slice into the user's home from a unit run.
    const catalogReader = vi.fn(async () => catalogWith({ 'claude-sonnet-4-5': 200_000 }));
    await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
    }).read();
    expect(catalogReader).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ cacheOnly: true })
    );
  });

  it('lets an explicit caller opt back into fetching (this is what `gth init` does)', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ 'claude-sonnet-4-5': 200_000 }));
    await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
      catalogReader,
      catalogOptions: { cacheOnly: false },
    }).read();
    expect(catalogReader).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ cacheOnly: false })
    );
  });
});

describe('EXT-161 — ollama outranks both, because it is the number the request carries', () => {
  it('takes num_ctx over a catalog entry and a profile that both disagree', async () => {
    const ollama = {
      _llmType: () => 'ollama',
      numCtx: 16_384,
      profile: { maxInputTokens: 999_999 },
    };
    const catalogReader = vi.fn(async () => catalogWith({ 'gemma4:12b': 262_144 }));
    const reading = await resolveContextWindow(ollama, {
      providerId: 'ollama',
      modelId: 'gemma4:12b',
      catalogReader,
    }).read();

    expect(reading).toEqual({ tokens: 16_384, origin: 'ollama' });
    // models.dev deliberately has no ollama entry, so the catalog must not even be consulted.
    expect(catalogReader).not.toHaveBeenCalled();
  });
});

describe('EXT-161 — an unknown window is reported as unknown, and never guessed', () => {
  /**
   * **The discriminating pair.** "Unknown yields null" is an assertion about ABSENCE and would pass
   * against a harness that resolved nothing at all, so the known case runs in the same harness and
   * must produce a number.
   */
  it('resolves a number when a source knows, and null when none does', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ known: 200_000 }));

    const known = await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'known',
      catalogReader,
    }).read();
    const unknown = await resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'unknown',
      catalogReader,
    }).read();

    expect(known).toEqual({ tokens: 200_000, origin: 'models.dev' });
    expect(unknown).toEqual({ tokens: null, origin: 'unknown' });
  });

  it('never answers 4097, the value LangChain guesses for a model it does not recognise', async () => {
    // The whole reason there is no `?? DEFAULT` on this path: `fraction: 0.8` over a 4097 default
    // compacts at roughly 3.3k tokens, silently, on any model outside the table.
    const reading = await resolveContextWindow(
      {},
      { providerId: 'openai', modelId: 'nope' }
    ).read();
    expect(reading.tokens).toBeNull();
    expect(reading.tokens).not.toBe(4097);
  });

  it.each([
    ['a model with no profile at all', {}],
    ['undefined', undefined],
    ['a profile with no maxInputTokens', { profile: {} }],
    ['a profile whose window is zero', { profile: { maxInputTokens: 0 } }],
    ['a profile whose window is negative', { profile: { maxInputTokens: -1 } }],
    [
      'a profile getter that throws',
      {
        get profile(): never {
          throw new Error('nope');
        },
      },
    ],
  ])('reads no window from %s', (_label, llm) => {
    expect(readProfileContextWindow(llm)).toBeNull();
  });

  it('keeps UNKNOWN_CONTEXT_WINDOW answering null', async () => {
    expect(await UNKNOWN_CONTEXT_WINDOW()).toBeNull();
  });

  it('describes every origin, so /status can never print a bare enum value', () => {
    for (const origin of ['ollama', 'models.dev', 'profile', 'unknown'] as const) {
      expect(CONTEXT_WINDOW_ORIGIN_LABELS[origin]).toMatch(/\S/);
    }
  });
});

describe('EXT-161 — one resolution, shared by the guard and /status', () => {
  it('asks the catalog once however many times either reader is called', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ m: 200_000 }));
    const resolved = resolveContextWindow(undefined, {
      providerId: 'anthropic',
      modelId: 'm',
      catalogReader,
    });

    const [a, b, c, d] = await Promise.all([
      resolved.source(),
      resolved.source(),
      resolved.read(),
      resolved.read(),
    ]);

    expect(catalogReader).toHaveBeenCalledTimes(1);
    expect([a, b]).toEqual([200_000, 200_000]);
    // The two readers cannot disagree, because they share the one memoised promise — a `/status`
    // describing a threshold the guard is not enforcing is the failure this shape rules out.
    expect(c).toEqual(d);
    expect(c.tokens).toBe(a);
  });

  it('resolveContextWindowSource is the same resolution with the provenance dropped', async () => {
    const catalogReader = vi.fn(async () => catalogWith({ m: 200_000 }));
    const source = resolveContextWindowSource(undefined, {
      providerId: 'anthropic',
      modelId: 'm',
      catalogReader,
    });
    expect(await source()).toBe(200_000);
  });
});
