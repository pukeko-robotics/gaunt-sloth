import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * REL-20 — the belt to the product fix's braces: the review workflow must not die on a missing
 * `review.md`.
 *
 * `gaunt-sloth-review` now writes the report even when the run ends before inference, so the
 * ordinary failure arrives at the comment step as a file that explains itself. This guard covers
 * what is left — a run that produced no file at all — and it matters because of WHERE the crash
 * lands without it: `github-script` throws `ENOENT ... 'review.md'` from a step several removed
 * from the one that failed, so the run reports a missing file instead of the reason there is one.
 *
 * Both halves are asserted, because dropping the file is only half a fix. The run must still FAIL,
 * and it does through "Check review step result", which fails on the review step's own outcome —
 * a result worth reading, unlike the ENOENT. A guard added without that step still standing would
 * turn a failed review into a green build, which is strictly worse than the crash.
 *
 * Asserted against the workflow text: nothing executes this file in the unit suite, nothing
 * type-checks it, and no code path references it, so a refactor can drop either half with no
 * signal at all. Same reasoning as `core/spec/docsRenderGateWired.spec.ts`.
 */
const WORKFLOW = new URL('../../../.github/workflows/review.yml', import.meta.url);

const REPORT_GUARD = "if: hashFiles('review.md') != ''";
const REVIEW_STEP_ID = 'id: review';
const FAIL_ON_REVIEW_OUTCOME = "if: steps.review.outcome == 'failure'";

/**
 * The workflow's steps, split on the `- name:` that opens each one. A step's text therefore
 * carries its own `if:` and nobody else's, which is what lets the assertions below say "this step
 * is guarded" rather than "the guard appears somewhere in the file" — the latter passes with the
 * guard attached to the wrong step, which is the mistake worth catching.
 */
function steps(): string[] {
  const text = readFileSync(WORKFLOW, 'utf8');
  const parts = text.split(/^ {6}- (?=name:|uses:)/m);
  return parts.slice(1);
}

function stepThatReadsTheReport(): string {
  const found = steps().filter((step) => step.includes("readFileSync('review.md'"));
  // Exactly one, so a second reader added later cannot hide behind the first one's guard.
  expect(found, 'expected exactly one step to read review.md').toHaveLength(1);
  return found[0];
}

function stepNamed(name: string): string {
  const found = steps().filter((step) => step.startsWith(`name: ${name}`));
  expect(found, `expected one step named ${name}`).toHaveLength(1);
  return found[0];
}

describe('review.yml guards the report file', () => {
  it('does not run the comment step when no report file was produced', () => {
    expect(stepThatReadsTheReport()).toContain(REPORT_GUARD);
  });

  it('still fails the run on the review step, so a skipped comment is not a green build', () => {
    expect(stepNamed('Perform code review')).toContain(REVIEW_STEP_ID);

    const check = stepNamed('Check review step result');
    expect(check).toContain(FAIL_ON_REVIEW_OUTCOME);
    expect(check).toContain('exit 1');
  });
});
