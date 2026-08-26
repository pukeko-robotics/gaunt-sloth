import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QA-21 — the live eval beds under `evals/` share one lifecycle script, and each contributes only
 * its own `bed.conf`. The lifecycle is shell and needs a real SUT, real keys and, for one bed, a
 * local Python environment, so it cannot run in the unit matrix. What CAN be checked for free is
 * the configuration the lifecycle reads — and that is where a bed silently stops being a test.
 *
 * THE ONE THAT MATTERS IS THE DISCRIMINATION SUITE. Every bed ships a `-broken` suite whose whole
 * job is to exit 1: it is the evidence that the bed's green means something, because a suite that
 * cannot fail proves nothing. Consolidating three scripts into one turned that convention into a
 * configuration value, and a configuration value can go missing. `run-bed.sh` therefore refuses to
 * start — before it builds or spawns anything — when a bed does not declare a broken suite or
 * declares one that is not there. This file pins the declarations themselves, on every platform,
 * so the refusal has nothing left to catch.
 *
 * Everything here is plain file reading: no shell is spawned, so it behaves the same on Windows.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const EVALS = join(ROOT, 'evals');
const HARNESS = join(EVALS, 'harness', 'run-bed.sh');

/** A directory under `evals/` is a bed when it carries a `bed.conf`. */
function bedDirectories(): string[] {
  return readdirSync(EVALS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(EVALS, name, 'bed.conf')))
    .sort();
}

/**
 * The `BED_*` settings a `bed.conf` assigns. It is sourced by bash, so this reads the assignments
 * rather than interpreting the file: a scalar keeps its value with one layer of quotes removed, an
 * array keeps the raw text between its parentheses. That is enough for what is asserted below and
 * avoids pretending to be a shell.
 */
function bedSettings(bed: string): Map<string, string> {
  const text = readFileSync(join(EVALS, bed, 'bed.conf'), 'utf8');
  const settings = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^(BED_[A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('('))
      value = value
        .slice(1)
        .replace(/\)\s*$/, '')
        .trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    settings.set(match[1], value);
  }
  return settings;
}

const BEDS = bedDirectories();

describe('eval beds: the scan reaches the beds it claims to scan', () => {
  /**
   * The guard's own discrimination check. A scan that resolves its root wrongly, or that quietly
   * visits nothing, is green on every platform and indistinguishable from a clean tree — so prove
   * the scan found the beds before trusting anything it did not find.
   */
  it('finds every bed that exists, including the three live ones', () => {
    expect(BEDS.length).toBeGreaterThanOrEqual(3);
    expect(BEDS).toEqual(expect.arrayContaining(['adk', 'ag-ui', 'mcp-authz']));
    expect(existsSync(HARNESS)).toBe(true);
  });
});

describe('eval beds: every bed declares a suite that proves it can fail', () => {
  it.each(BEDS)('%s declares both suites, and both are in its workdir', (bed) => {
    const settings = bedSettings(bed);
    const workdir = join(EVALS, bed, settings.get('BED_WORKDIR') ?? 'workdir');

    const real = settings.get('BED_REAL_SUITE');
    const broken = settings.get('BED_BROKEN_SUITE');

    expect(real, `${bed}/bed.conf must set BED_REAL_SUITE`).toBeTruthy();
    expect(
      broken,
      `${bed}/bed.conf must set BED_BROKEN_SUITE — the suite that exits 1 and so shows that this ` +
        `bed's green run could have gone red. A bed with no discrimination suite is not a test.`
    ).toBeTruthy();

    expect(existsSync(join(workdir, real as string))).toBe(true);
    expect(existsSync(join(workdir, broken as string))).toBe(true);

    // Pointing both at one file would satisfy every check above and discriminate nothing.
    expect(real).not.toEqual(broken);
  });
});

describe('eval beds: the shared harness stays the only lifecycle', () => {
  /**
   * A bed whose `run.sh` grew its own build/start/wait/teardown again would put the estate straight
   * back where it started, and nothing else would notice. Delegation plus a small size budget is
   * what keeps that visible.
   */
  it.each(BEDS)('%s delegates its lifecycle to the shared harness', (bed) => {
    const runner = join(EVALS, bed, 'run.sh');
    expect(existsSync(runner)).toBe(true);
    const text = readFileSync(runner, 'utf8');
    expect(text).toContain('run-bed.sh');
    const code = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(code.length).toBeLessThanOrEqual(6);
  });

  /**
   * Every `BED_*` key a bed sets must be one the harness actually reads. A misspelled key is
   * otherwise assigned, ignored, and silently replaced by the harness default — which for a port
   * or a readiness path means grading nothing and reporting it as a startup fault.
   */
  it.each(BEDS)('%s sets no key the harness does not read', (bed) => {
    const harness = readFileSync(HARNESS, 'utf8');
    const unknown = [...bedSettings(bed).keys()].filter((key) => !harness.includes(key));
    expect(unknown).toEqual([]);
  });

  /**
   * The refusal itself lives in shell and cannot be executed here. What is pinned is that the
   * harness still has both halves of it — a bed that declares no broken suite, and a bed that
   * declares one that is not on disk — so neither can be dropped without this going red. The
   * behaviour behind them is proven by running the harness against a deliberately broken bed.
   */
  it('the harness refuses an undeclared or missing discrimination suite', () => {
    const harness = readFileSync(HARNESS, 'utf8');
    const refusals = harness
      .split('\n')
      .filter((line) => line.includes('BED_BROKEN_SUITE') && line.includes('fail_config'));
    expect(refusals.length).toBe(2);
    expect(harness).toContain('exit 3');
  });
});
