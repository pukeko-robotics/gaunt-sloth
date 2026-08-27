import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * OPS-77 — the docs render gate must fail on a *new* TypeDoc warning, not merely count them.
 *
 * `pnpm run docs:check` reported "0 errors, N warnings" and exited 0 whatever N was, so the warning
 * count was a number nobody compared against anything — every lane and reviewer reported the gate as
 * "docs:check 0", meaning zero *errors*. Merging [[EXT-141]] took N from 424 to 426 and both new
 * warnings were real defects in published output: `{@link}` references to non-exported symbols,
 * which render as dead text in the API reference. That branch had green gates, a PASS/PASS peer
 * review and a 10/10 `review-node` rating; none of those looks at the warning count. It was caught
 * only because one reviewer's remark happened to be fresh in someone's mind.
 *
 * The comparison is against a recorded **set** rather than a count, because a count cannot see a
 * swap — one warning fixed and one introduced leaves the total unchanged while the new defect
 * lands.
 *
 * What is unprotected, and therefore what this asserts, is that the baseline file still exists and
 * still holds something. **A missing or empty baseline reds the gate at runtime** — that is the
 * fail-closed branch in `check-docs-render.mjs` — but the gate runs only in the `test-and-lint` CI
 * job and locally on demand, whereas deleting a data file is the cheapest way to silence a gate that
 * has found something. This spec puts that failure in the unit suite, where it is seen first and on
 * every platform.
 *
 * It deliberately asserts on the *files* rather than by running the render: what the render does is
 * proven by running it, which is what the gate is. A spec that re-implemented the comparison would
 * be the very defect [[OPS-67]] was filed about.
 */

const BASELINE = new URL('../../../scripts/docs-warnings.baseline.txt', import.meta.url);
const CHECK_SCRIPT = new URL('../../../scripts/check-docs-render.mjs', import.meta.url);

/** The flag the gate's own failure message tells the reader to use. */
const UPDATE_FLAG = '--update-baseline';

/** The baseline's recorded warnings — `#` comments and blank lines are not data. */
function recordedWarnings(): string[] {
  return readFileSync(BASELINE, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('OPS-77 the docs render gate holds a warning baseline', () => {
  it('has a baseline file, and it records warnings', () => {
    expect(
      existsSync(BASELINE),
      'scripts/docs-warnings.baseline.txt is missing. Without it `docs:check` cannot tell a new ' +
        'warning from a known one; deleting it is the cheapest way to silence the gate.'
    ).toBe(true);
    expect(
      recordedWarnings().length,
      'the baseline records no warnings. An empty baseline would make every warning read as new ' +
        'if the gate failed closed, or every warning read as known if it did not — regenerate it ' +
        `with \`node scripts/check-docs-render.mjs ${UPDATE_FLAG}\`.`
    ).toBeGreaterThan(0);
  });

  it('records warning text as the render prints it, without the log prefix', () => {
    // A hand-pasted line that kept its `[warning] ` prefix can never match what the render
    // reports, so it would sit in the baseline claiming to account for a warning that is in fact
    // reported as new on every run. Loud, but for a reason nobody would guess from the output.
    const prefixed = recordedWarnings().filter((line) => line.startsWith('[warning]'));
    expect(
      prefixed,
      'baseline lines must be the warning text alone — the `[warning] ` prefix is stripped when ' +
        'the render is read, so a line that keeps it matches nothing.'
    ).toEqual([]);
  });

  it("does not record TypeDoc's own tally, which changes whenever any other line does", () => {
    // The tally is printed as a warning like any other. Recorded, it would change on every
    // baseline update, so the single reviewable line a legitimate new warning costs would always
    // be two — and the second would restate what the diff already shows.
    const tallies = recordedWarnings().filter((line) =>
      /^Found \d+ errors? and \d+ warnings?$/.test(line)
    );
    expect(tallies, "TypeDoc's summary line must not be recorded in the baseline").toEqual([]);
  });

  it('is read by the check script, which offers the flag its failure message advertises', () => {
    const script = readFileSync(CHECK_SCRIPT, 'utf8');
    expect(
      script.includes('docs-warnings.baseline.txt'),
      'scripts/check-docs-render.mjs no longer names the baseline file, so the committed baseline ' +
        'is data nothing reads and a new warning would land green again.'
    ).toBe(true);
    expect(
      script.includes(UPDATE_FLAG),
      `the failure message points the reader at \`${UPDATE_FLAG}\`; the script must still accept ` +
        'it, or the one documented way to accept a legitimate new warning does not exist.'
    ).toBe(true);
  });
});
