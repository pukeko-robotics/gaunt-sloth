/**
 * Strict Commander option parser for a non-negative integer CLI flag (`-j/--concurrency`,
 * `--retry`, …). Shared by `batchCommand.ts` and `evalCommand.ts`.
 *
 * Unlike a bare `parseInt(value, 10)`, this rejects trailing-garbage input such as `"10abc"` —
 * `parseInt` stops at the first non-digit and returns `10`, and `Number.isFinite` on that result
 * is still `true`, so the garbage silently passed through undetected. A regex pre-check (only
 * ASCII digits, at least one) rejects that case, plus other loose inputs a bare `Number()`
 * coercion would let through (`""` → `0`, `"1e3"` → `1000`, `" 5 "` → `5`, `"0x10"` → `16`) or
 * that don't make sense for a concurrency/retry count (negative, fractional).
 */
export function parseIntOption(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected an integer, got "${value}"`);
  }
  return parseInt(value, 10);
}
