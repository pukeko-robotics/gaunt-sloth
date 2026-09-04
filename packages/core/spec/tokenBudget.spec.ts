/**
 * EXT-161 — **the one token-budget grammar**, pinned form by form.
 *
 * The acceptance cases are the forms the node names (`300000`, `300K`, `0.9M`, `1.5k`, whitespace,
 * case) and the percentage form the fraction spelling adds. The rejection cases matter more: this
 * parser exists because a malformed threshold silently becoming `NaN`, `0` or LangChain's 4097 is a
 * number the user cannot see and did not choose, so **every rejection is asserted to throw AND to
 * name the offending text**, and one sweep asserts that no malformed input can produce a number by
 * any route at all.
 */
import { describe, expect, it } from 'vitest';
import {
  formatTokenBudget,
  parseTokenBudget,
  resolveTokenBudget,
  TOKEN_BUDGET_MILLION,
  TOKEN_BUDGET_THOUSAND,
  TokenBudgetError,
} from '#src/config/tokenBudget.js';

describe('EXT-161 — parseTokenBudget accepts every documented form', () => {
  it.each([
    ['a plain number', 300000, 300000],
    ['a numeric string', '300000', 300000],
    ['an upper-case K', '300K', 300000],
    ['a lower-case k', '300k', 300000],
    ['a fractional k', '1.5k', 1500],
    ['an upper-case M', '0.9M', 900000],
    ['a lower-case m', '2m', 2000000],
    ['a leading-dot magnitude', '.9M', 900000],
    ['surrounding whitespace', '  300K  ', 300000],
    ['a space before the suffix', '300 K', 300000],
    ['a tab before the suffix', '300\tK', 300000],
  ])('%s → %s tokens', (_label, input, expected) => {
    expect(parseTokenBudget(input)).toEqual({ kind: 'tokens', tokens: expected });
  });

  it('reads K and M as DECIMAL multipliers, never binary', () => {
    // Provider token counts are decimal everywhere, so a `K` meaning 1024 would put a quiet 2.4%
    // error between what the user wrote and what the guard enforced.
    expect(TOKEN_BUDGET_THOUSAND).toBe(1000);
    expect(TOKEN_BUDGET_MILLION).toBe(1_000_000);
    expect(parseTokenBudget('1K')).toEqual({ kind: 'tokens', tokens: 1000 });
    expect(parseTokenBudget('1M')).toEqual({ kind: 'tokens', tokens: 1_000_000 });
  });

  it.each([
    ['80%', 0.8],
    ['  80 %  ', 0.8],
    ['100%', 1],
    ['12.5%', 0.125],
  ])('reads %s as a fraction of the context window', (input, fraction) => {
    expect(parseTokenBudget(input)).toEqual({ kind: 'fraction', fraction });
  });
});

describe('EXT-161 — a malformed budget is rejected by name, and never becomes a number', () => {
  const malformed: ReadonlyArray<[string, unknown]> = [
    ['letters', 'three hundred thousand'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a negative count', -5],
    ['a negative suffixed count', '-5K'],
    ['zero', 0],
    ['zero with a suffix', '0K'],
    ['an unknown suffix', '300G'],
    ['exponent notation', '1e5'],
    ['a bare fraction as a number', 0.8],
    ['a bare fraction as a string', '0.8'],
    ['a percentage over 100', '150%'],
    ['a zero percentage', '0%'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['an object', { threshold: 300000 }],
    ['a boolean', true],
    ['two numbers', '300K 400K'],
    ['a suffix with no magnitude', 'K'],
  ];

  it.each(malformed)('rejects %s', (_label, input) => {
    expect(() => parseTokenBudget(input)).toThrow(TokenBudgetError);
  });

  it('names the offending text in the message', () => {
    expect(() => parseTokenBudget('300G')).toThrow(/"300G"/);
    expect(() => parseTokenBudget('three hundred')).toThrow(/"three hundred"/);
    // The error also carries it structurally, so a caller can build its own message.
    try {
      parseTokenBudget('300G');
      expect.unreachable('a malformed budget must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenBudgetError);
      expect((error as TokenBudgetError).offendingValue).toBe('300G');
    }
  });

  it('points a bare fraction at the percentage form rather than guessing', () => {
    // `0.8` is both the obvious way to write "80% of the window" and a well-formed count of under
    // one token. Guessing which was meant would make the threshold depend on a rule nobody read.
    expect(() => parseTokenBudget('0.8')).toThrow(/"80%"/);
    expect(() => parseTokenBudget(0.8)).toThrow(/"80%"/);
  });

  /**
   * **The assertion the node asks for by name: a bad value cannot resolve to a number.**
   *
   * Written as a sweep over every malformed input rather than as individual throw assertions,
   * because the failure being guarded against is not "no error" — it is a number appearing anyway.
   * So this catches the throw and then asserts that nothing numeric came back by any route.
   */
  it.each(malformed)('cannot produce a number from %s — not NaN, not 0, not 4097', (_l, input) => {
    const NOTHING = Symbol('nothing');
    let produced: unknown = NOTHING;
    try {
      produced = parseTokenBudget(input);
    } catch {
      /* the expected path; the assertions below are about the case where it does NOT throw */
    }
    // The real assertion: the parser refused, so no value was produced at all. If a future change
    // makes one of these parse, the second assertion still forbids the three silent-wrong values
    // this module exists to prevent — so this cell cannot quietly stop testing anything.
    expect(produced).toBe(NOTHING);
    if (produced !== NOTHING) {
      expect([Number.NaN, 0, 4097]).not.toContain((produced as { tokens: number }).tokens);
    }
  });
});

describe('EXT-161 — resolving a budget against a window', () => {
  it('returns an absolute count unchanged, window or no window', () => {
    const budget = parseTokenBudget('300K');
    expect(resolveTokenBudget(budget, 1_000_000)).toBe(300000);
    // An absolute count needs no window: the user named the number themselves.
    expect(resolveTokenBudget(budget, null)).toBe(300000);
  });

  it('multiplies a fraction by the window', () => {
    expect(resolveTokenBudget(parseTokenBudget('80%'), 200_000)).toBe(160_000);
    expect(resolveTokenBudget(parseTokenBudget('12.5%'), 16_384)).toBe(2048);
  });

  it('returns null for a fraction with no window — never a guess', () => {
    // The same "unknown means no trigger" contract the window resolver holds: a percentage of a
    // window nobody could resolve is not a number.
    expect(resolveTokenBudget(parseTokenBudget('80%'), null)).toBeNull();
    expect(resolveTokenBudget(parseTokenBudget('80%'), 0)).toBeNull();
    expect(resolveTokenBudget(parseTokenBudget('80%'), Number.NaN)).toBeNull();
  });
});

describe('EXT-161 — formatTokenBudget echoes what was written', () => {
  it('renders a count as a number and a fraction as a percentage', () => {
    expect(formatTokenBudget(parseTokenBudget('300K'))).toBe('300000');
    expect(formatTokenBudget(parseTokenBudget('80%'))).toBe('80%');
    expect(formatTokenBudget(parseTokenBudget('12.5%'))).toBe('12.5%');
  });
});
