import type { DeterministicCheckResult, EvalCase } from '#src/evalTypes.js';

/**
 * Case-insensitive substring checks over an SUT answer. Ported, not reinvented, from the field
 * user's proven `deterministic()` function (`docs/batch-eval-user-requirements.md` Appendix A):
 *
 * - `mustContain` — every entry must appear (case-insensitive substring); each miss is reported.
 * - `mustNotContain` — no entry may appear; each hit is reported.
 * - `shouldContainAny` — at least one entry must appear; reported as a single combined failure
 *   (not one per missing option — the check is "at least one", so there is only one way to fail
 *   it) when none do.
 *
 * A case with all three arrays empty trivially passes (no checks to fail) — the suite parser
 * (`#src/evalSuite.js`) is what enforces that a case has *some* check or a judge rubric; this
 * function itself has no opinion on that.
 */
export function runDeterministicChecks(
  answer: string,
  evalCase: Pick<EvalCase, 'mustContain' | 'mustNotContain' | 'shouldContainAny'>
): DeterministicCheckResult {
  const text = answer.toLowerCase();
  const failures: string[] = [];

  for (const needle of evalCase.mustContain) {
    if (!text.includes(needle.toLowerCase())) {
      failures.push(`missing "${needle}"`);
    }
  }

  for (const needle of evalCase.mustNotContain) {
    if (text.includes(needle.toLowerCase())) {
      failures.push(`forbidden "${needle}"`);
    }
  }

  if (
    evalCase.shouldContainAny.length > 0 &&
    !evalCase.shouldContainAny.some((needle) => text.includes(needle.toLowerCase()))
  ) {
    failures.push(`none of [${evalCase.shouldContainAny.join(' | ')}]`);
  }

  return { passed: failures.length === 0, failures };
}
