/**
 * EXT-161 — **the threshold in force, and who decided it.**
 *
 * Three things can name the number, in order: the session (`/autocompact`), the `autocompact`
 * config key, and the window-derived default. This file pins that order with DISAGREEING values at
 * every step — two sources agreeing would prove nothing — and pins the two answers that must never
 * be a number: an unknown window with no absolute threshold, and the off switch.
 */
import { describe, expect, it } from 'vitest';
import {
  AutocompactController,
  DEFAULT_AUTOCOMPACT_SEED_FRACTION,
  resolveAutocompactConfig,
  seedAutocompactThreshold,
} from '#src/core/compactionThreshold.js';
import { parseTokenBudget, TokenBudgetError } from '#src/config/tokenBudget.js';
import type { ContextWindowReading } from '#src/core/contextWindow.js';

/** A stand-in for the session's one memoised window resolution. */
const windowOf = (reading: ContextWindowReading) => ({ read: async () => reading });

/** The guard's own default rule, as the wiring site supplies it: the window less the reserve. */
const RESERVE = 2048;
const defaultThreshold = (window: number) => window - Math.min(RESERVE, Math.floor(window * 0.25));

const controller = (config: unknown, reading: ContextWindowReading) =>
  new AutocompactController({
    config: resolveAutocompactConfig(config),
    window: windowOf(reading),
    defaultThreshold,
  });

const KNOWN: ContextWindowReading = { tokens: 200_000, origin: 'models.dev' };
const UNKNOWN: ContextWindowReading = { tokens: null, origin: 'unknown' };

describe('EXT-161 — reading the `autocompact` config key', () => {
  it('is ON when the key is absent (RULED: on by default)', () => {
    expect(resolveAutocompactConfig(undefined)).toEqual({ enabled: true, budget: null });
    expect(resolveAutocompactConfig(null)).toEqual({ enabled: true, budget: null });
  });

  it.each([
    ['false', false, { enabled: false, budget: null }],
    ['true', true, { enabled: true, budget: null }],
    ['{ enabled: false }', { enabled: false }, { enabled: false, budget: null }],
  ])('reads %s as %o', (_label, input, expected) => {
    expect(resolveAutocompactConfig(input)).toEqual(expected);
  });

  it.each([
    ['a count', 300000, 300000],
    ['a suffixed string', '300K', 300000],
    ['a fractional million', '0.9M', 900000],
    ['the object form', { threshold: '300K' }, 300000],
  ])('reads %s as a %s-token budget', (_label, input, tokens) => {
    expect(resolveAutocompactConfig(input)).toEqual({
      enabled: true,
      budget: { kind: 'tokens', tokens },
    });
  });

  it('reads a percentage as a fraction, unresolved until a window is known', () => {
    expect(resolveAutocompactConfig('80%')).toEqual({
      enabled: true,
      budget: { kind: 'fraction', fraction: 0.8 },
    });
  });

  it('raises the shared parser’s error for a malformed threshold, naming the text', () => {
    // NOT coerced, not defaulted: 2.0 is a breaking config line with no back-compat coercion, and
    // a threshold that silently became a number would be one the user cannot see.
    expect(() => resolveAutocompactConfig('300G')).toThrow(TokenBudgetError);
    expect(() => resolveAutocompactConfig({ threshold: 'nonsense' })).toThrow(/"nonsense"/);
  });
});

describe('EXT-161 — precedence: session, then config, then the derived default', () => {
  it('uses the window-derived default when nothing is configured', async () => {
    const status = await controller(undefined, KNOWN).status();
    expect(status).toMatchObject({
      enabled: true,
      thresholdTokens: defaultThreshold(200_000),
      thresholdOrigin: 'default',
      window: 200_000,
      windowOrigin: 'models.dev',
    });
  });

  it('lets a CONFIGURED threshold beat the derived default they disagree about', async () => {
    const status = await controller(50_000, KNOWN).status();
    // The default for this window is 197952; the config says 50000. The config must win, or the
    // key does nothing.
    expect(defaultThreshold(200_000)).not.toBe(50_000);
    expect(status.thresholdTokens).toBe(50_000);
    expect(status.thresholdOrigin).toBe('config');
  });

  it('lets a SESSION override beat a disagreeing config, and says so in the provenance', async () => {
    const c = controller(50_000, KNOWN);
    c.setSessionBudget(parseTokenBudget('300K'));
    const status = await c.status();

    expect(status.thresholdTokens).toBe(300_000);
    // The provenance must MOVE. A `/status` that still called a hand-typed number
    // config-derived would send the next diagnosis to the wrong place entirely.
    expect(status.thresholdOrigin).toBe('session');
    expect(c.sessionOverride).toEqual({ kind: 'tokens', tokens: 300_000 });
  });

  it('keeps a session override in force across repeated reads', async () => {
    // The guard asks before EVERY model call, so an override that decayed would silently revert.
    const c = controller(undefined, KNOWN);
    c.setSessionBudget(parseTokenBudget('120K'));
    for (let turn = 0; turn < 4; turn++) {
      expect(await c.threshold()).toBe(120_000);
    }
    expect((await c.status()).thresholdOrigin).toBe('session');
  });

  it('resolves a percentage against the window', async () => {
    const status = await controller('80%', KNOWN).status();
    expect(status.thresholdTokens).toBe(160_000);
    expect(status.thresholdOrigin).toBe('config');
    // The resolved config carries an ABSOLUTE number whichever form was written, so nothing
    // downstream has to know about the string.
    expect(typeof status.thresholdTokens).toBe('number');
  });

  it('lands the same absolute number whichever input form named it', async () => {
    const forms = [160000, '160000', '160K', '0.16M', '80%'];
    const resolved = await Promise.all(forms.map((form) => controller(form, KNOWN).threshold()));
    expect(resolved).toEqual([160_000, 160_000, 160_000, 160_000, 160_000]);
  });
});

describe('EXT-161 — the answers that must never be a number', () => {
  /**
   * **The discriminating pair the node asks for.** "An unknown window yields no trigger" is an
   * assertion about absence and would pass in a harness that resolved nothing at all, so the known
   * window runs through the same controller shape and must produce a number.
   */
  it('yields NO trigger for an unknown window, while a known one still yields a threshold', async () => {
    const unknown = await controller(undefined, UNKNOWN).status();
    const known = await controller(undefined, KNOWN).status();

    expect(unknown.thresholdTokens).toBeNull();
    expect(unknown.thresholdOrigin).toBe('none');
    // Never the LangChain guess.
    expect(unknown.thresholdTokens).not.toBe(4097);

    expect(known.thresholdTokens).toBe(defaultThreshold(200_000));
    expect(known.thresholdOrigin).toBe('default');
  });

  it('yields no trigger for a PERCENTAGE with no window — a share of nothing is not a number', async () => {
    expect(await controller('80%', UNKNOWN).threshold()).toBeNull();
  });

  it('still fires an ABSOLUTE threshold on a model whose window nobody knows', async () => {
    // The user named the number themselves, so it needs no window. This is the one case where an
    // unknown window still protects the session, and it is why the config key is worth having.
    const status = await controller('300K', UNKNOWN).status();
    expect(status.thresholdTokens).toBe(300_000);
    expect(status.thresholdOrigin).toBe('config');
    expect(status.window).toBeNull();
  });

  it('yields no trigger at all when the off switch is set, even with a known window', async () => {
    const status = await controller(false, KNOWN).status();
    expect(status.enabled).toBe(false);
    expect(status.thresholdTokens).toBeNull();
    expect(status.thresholdOrigin).toBe('none');
    // The window is still REPORTED — `/status` can say what the model holds even with compaction
    // off, which is what makes turning it back on an informed choice.
    expect(status.window).toBe(200_000);
  });

  it('off beats an explicitly configured threshold', async () => {
    const status = await controller({ enabled: false, threshold: '300K' }, KNOWN).status();
    expect(status.thresholdTokens).toBeNull();
  });
});

describe('EXT-161 — the threshold `gth init` seeds', () => {
  it('is a fixed share of the resolved window, and tracks the window', () => {
    expect(seedAutocompactThreshold(200_000)).toBe(
      Math.floor(200_000 * DEFAULT_AUTOCOMPACT_SEED_FRACTION)
    );
    // Tracking is the point: a different model's window must seed a different number, or the seed
    // is a constant wearing a function's clothes.
    expect(seedAutocompactThreshold(500_000)).toBeGreaterThan(
      seedAutocompactThreshold(200_000) as number
    );
  });

  it.each([[null], [0], [-1], [Number.NaN]])('seeds nothing for the unusable window %s', (w) => {
    // Seeding a guess would put a number in the user's config that looks chosen and was not.
    expect(seedAutocompactThreshold(w as number | null)).toBeNull();
  });

  it('leaves room below the window for the answer', () => {
    const window = 200_000;
    expect(seedAutocompactThreshold(window) as number).toBeLessThan(window);
  });
});
