/**
 * @packageDocumentation
 * EXT-161 — **the one parser for a configured token budget.**
 *
 * A token budget is written by a human in one of three forms, and this module is the only place
 * that knows how to read any of them:
 *
 * - a plain count — `300000`, or the string `"300000"`;
 * - a suffixed count — `"300K"`, `"0.9M"`, `"1.5k"`;
 * - a fraction of the model's context window — `"80%"`.
 *
 * **`K` is 1000 and `M` is 1,000,000 — decimal, never binary.** The number is compared against
 * provider token counts, and every provider counts tokens in decimal, so a `K` that meant 1024
 * would put a quiet 2.4% error between what the user wrote and what the guard enforced.
 *
 * **Why one parser and not two.** The same grammar is accepted by the `autocompact` config key and
 * by the in-session `/autocompact` command. Written twice they would agree on the day they were
 * written and drift afterwards, so both call sites import {@link parseTokenBudget} and there is no
 * second implementation to drift from — `packages/core/spec/tokenBudget.spec.ts` pins the grammar
 * and `packages/agent/spec/autocompactSlashCommand.spec.ts` pins that the command reaches this
 * function rather than a copy of it.
 *
 * **A malformed value is an error that names the text, and never a number.** The failure this
 * guards against is a bad value silently becoming `NaN`, `0` or LangChain's 4097 default: each of
 * those is a threshold the user cannot see and did not choose, and a wrong-but-silent threshold is
 * worse than no compaction at all.
 */

/** `K` — decimal thousand. Not 1024: provider token counts are decimal everywhere. */
export const TOKEN_BUDGET_THOUSAND = 1_000;

/** `M` — decimal million, for the same reason as {@link TOKEN_BUDGET_THOUSAND}. */
export const TOKEN_BUDGET_MILLION = 1_000_000;

/**
 * A parsed token budget: either an absolute count, or a fraction of a context window that is not
 * known until a model is resolved.
 *
 * The two stay distinct through parsing and are collapsed to one number by
 * {@link resolveTokenBudget}, because only the caller knows the window — and because a fraction
 * whose window is unknown must resolve to "no threshold" rather than to a guess.
 */
export type TokenBudget =
  { kind: 'tokens'; tokens: number } | { kind: 'fraction'; fraction: number };

/**
 * The error a malformed budget raises, carrying the offending text so the message can name it.
 *
 * A distinct class rather than a bare `Error` so config validation can recognise it and turn it
 * into a field-scoped validation issue without string-matching a message.
 */
export class TokenBudgetError extends Error {
  /** The text exactly as the user wrote it, for a message that quotes them back. */
  readonly offendingValue: string;

  constructor(offendingValue: string, detail: string) {
    super(`Invalid token budget ${JSON.stringify(offendingValue)}: ${detail}`);
    this.name = 'TokenBudgetError';
    this.offendingValue = offendingValue;
  }
}

/**
 * The accepted grammar, as one expression: a decimal number with an optional `K`/`M` multiplier or
 * a `%` sign. Whitespace around the whole value and between the number and its suffix is
 * insignificant; the suffix is case-insensitive.
 *
 * A leading-dot number (`.9M`) is accepted because it is the same number as `0.9M` and rejecting it
 * would be a distinction the user cannot see the reason for. Exponent notation (`1e5`) is NOT
 * accepted: it is not a form anyone writes a context window in, and admitting it would mean
 * admitting `Infinity` and `1e-5` at the same time.
 */
const TOKEN_BUDGET_PATTERN = /^(\d+(?:\.\d+)?|\.\d+)\s*([km%])?$/i;

/** The human-readable list of accepted forms, appended to every rejection so the fix is on screen. */
export const TOKEN_BUDGET_FORMS =
  'expected a token count (300000), a suffixed count (300K, 0.9M) or a ' +
  'percentage of the model context window (80%)';

/**
 * Parse a configured token budget into a {@link TokenBudget}.
 *
 * Accepts a `number` (an absolute count) or a `string` in any of the documented forms. Throws a
 * {@link TokenBudgetError} naming the offending text for everything else — including the values
 * that would otherwise slip through as numbers: `NaN`, `Infinity`, zero, a negative, and a bare
 * fraction like `0.8`.
 *
 * **A bare `0.8` is rejected on purpose, and this is the one rejection worth explaining.** It is
 * the obvious way to write "80% of the window", and it is also a perfectly well-formed token count
 * of under one token. Guessing which was meant would make the threshold depend on a rule the user
 * never read, so the error points at `80%` instead — the form that cannot be misread. That is why
 * an absolute count must be a whole number of at least 1.
 */
export function parseTokenBudget(raw: unknown): TokenBudget {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw new TokenBudgetError(String(raw), `not a finite number — ${TOKEN_BUDGET_FORMS}`);
    }
    if (!Number.isInteger(raw)) {
      throw new TokenBudgetError(
        String(raw),
        `a plain token count must be a whole number; to set a share of the context window write ` +
          `it as a percentage, e.g. "${Math.round(raw * 100)}%"`
      );
    }
    if (raw < 1) {
      throw new TokenBudgetError(String(raw), `a token count must be at least 1`);
    }
    return { kind: 'tokens', tokens: raw };
  }

  if (typeof raw !== 'string') {
    throw new TokenBudgetError(
      raw === null ? 'null' : typeof raw,
      `expected a number or a string — ${TOKEN_BUDGET_FORMS}`
    );
  }

  const text = raw.trim();
  if (text.length === 0) {
    throw new TokenBudgetError(raw, `the value is empty — ${TOKEN_BUDGET_FORMS}`);
  }

  const match = TOKEN_BUDGET_PATTERN.exec(text);
  if (!match) {
    throw new TokenBudgetError(raw, TOKEN_BUDGET_FORMS);
  }

  const magnitude = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  // The pattern already guarantees a parseable decimal, so this is a belt-and-braces guard rather
  // than a reachable branch — but it is the branch that would otherwise produce the silent `NaN`
  // this module exists to prevent, so it stays.
  if (!Number.isFinite(magnitude)) {
    throw new TokenBudgetError(raw, TOKEN_BUDGET_FORMS);
  }

  if (suffix === '%') {
    if (magnitude <= 0 || magnitude > 100) {
      throw new TokenBudgetError(
        raw,
        'a percentage of the context window must be greater than 0 and at most 100'
      );
    }
    return { kind: 'fraction', fraction: magnitude / 100 };
  }

  // An UNSUFFIXED value is a literal token count, so a fractional one is the ambiguous `0.8` case
  // the docblock explains — rejected before any arithmetic, pointing at the percentage form. A
  // fractional value WITH a multiplier (`0.9M`, `1.5k`) is unambiguous and goes through.
  if (suffix === undefined && !Number.isInteger(magnitude)) {
    throw new TokenBudgetError(
      raw,
      `a plain token count must be a whole number; to set a share of the context window write ` +
        `it as a percentage, e.g. "${Math.round(magnitude * 100)}%"`
    );
  }

  const multiplier =
    suffix === 'k' ? TOKEN_BUDGET_THOUSAND : suffix === 'm' ? TOKEN_BUDGET_MILLION : 1;
  // Rounded, not floored: `1.5k` is 1500 exactly, and a floor would silently shave a token off
  // every fractional multiplier for no reason a user could observe or predict.
  const tokens = Math.round(magnitude * multiplier);
  if (tokens < 1) {
    throw new TokenBudgetError(raw, 'a token count must be at least 1');
  }
  return { kind: 'tokens', tokens };
}

/**
 * Collapse a parsed budget to the absolute token count it means for one model.
 *
 * Returns `null` when the budget is a fraction and the window is unknown — the same "unknown means
 * no trigger" contract `contextWindow.ts` holds, and for the same reason: a percentage of a window
 * nobody could resolve is not a number, and inventing one is the failure this whole feature exists
 * to avoid. An absolute count needs no window and is returned as written.
 */
export function resolveTokenBudget(budget: TokenBudget, window: number | null): number | null {
  if (budget.kind === 'tokens') return budget.tokens;
  if (window === null || !Number.isFinite(window) || window <= 0) return null;
  return Math.max(1, Math.floor(window * budget.fraction));
}

/**
 * Render a budget the way it will be read back — an absolute count as a plain number, a fraction as
 * a percentage. Used by `/status` and `/autocompact` so what is echoed matches what was accepted.
 */
export function formatTokenBudget(budget: TokenBudget): string {
  if (budget.kind === 'tokens') return String(budget.tokens);
  // `Number()` drops a trailing `.0`, so 80% renders `80%` rather than `80.0%`.
  return `${Number((budget.fraction * 100).toFixed(4))}%`;
}
