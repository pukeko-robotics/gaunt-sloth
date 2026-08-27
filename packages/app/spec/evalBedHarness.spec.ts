import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
 * Two layers do that, because one of them cannot run everywhere. The refusal is proven by RUNNING
 * the harness against purpose-built broken beds and reading the exit code it answers with — real
 * behaviour rather than a description of it — and that needs bash, so it runs on POSIX only. The
 * declarations and the shape of the guard are pinned by plain file reading, which behaves the same
 * on every platform and is what covers the Windows cells.
 *
 * A note for whoever edits this next: an assertion ABOUT the text of a shell script is worth much
 * less than it looks. Counting lines that mention a variable cannot tell a live guard from one that
 * has been commented out, so the reading layer below strips comments first and proves that it does
 * — and the executing layer does not care about the text at all.
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
function parseBedSettings(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  // Split on both endings. Splitting on "\n" alone leaves a "\r" that `.` cannot match and `$`
  // cannot follow, so the line would not match AT ALL and every setting would read as absent
  // rather than fail. The repository's `.gitattributes` checks tracked files out as LF on every
  // platform, so this is defence in depth: a `bed.conf` can also be hand-written, generated, or
  // read from a clone made before that policy existed.
  for (const line of text.split(/\r?\n/)) {
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

function bedSettings(bed: string): Map<string, string> {
  return parseBedSettings(readFileSync(join(EVALS, bed, 'bed.conf'), 'utf8'));
}

/**
 * The lines of a shell script that bash would actually execute — everything that is not blank and
 * not a comment. Commenting a guard out is the cheapest possible way to disable it, and it leaves
 * every word of the guard on the line, so any assertion that searches the raw text is blind to
 * exactly the edit most likely to be made. `effectiveShellLines` is what makes the reading layer
 * below able to tell the difference, and the test directly under it is what stops this quietly
 * degrading into a function that strips nothing.
 */
function effectiveShellLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
}

/** The guards in `run-bed.sh` that refuse a bed over its discrimination suite, comments excluded. */
function brokenSuiteRefusals(harnessText: string): string[] {
  return effectiveShellLines(harnessText).filter(
    (line) => line.includes('BED_BROKEN_SUITE') && line.includes('fail_config')
  );
}

/**
 * The body of the harness's `fail_config` function. The guards above are only worth what this does:
 * a `fail_config` rewritten to warn and carry on would leave every guard in place, and searching
 * the whole file for "exit 3" would still find one, because the harness exits 3 from several other
 * places. Scoping the search to this body is what stops that passing.
 */
function failConfigBody(harnessText: string): string[] {
  const lines = effectiveShellLines(harnessText);
  const start = lines.findIndex((line) => /^fail_config\s*\(\)/.test(line.trim()));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && line.trim() === '}');
  return end < 0 ? [] : lines.slice(start + 1, end);
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

/**
 * The parser is fed BOTH line endings here, on every platform, because the bug it is standing in
 * for was invisible on the platform this is usually written on. A Windows checkout has no
 * `.gitattributes` to hold these files at LF, so `bed.conf` arrives with CRLF; splitting on "\n"
 * alone leaves a trailing "\r" that `.` will not match and `$` will not follow, so the assignment
 * does not match at all and every setting reads as ABSENT — which surfaced as three beds appearing
 * to declare no suites, on the two Windows cells only, while all three POSIX cells were green.
 *
 * Asserting the two endings parse identically is what makes that reproducible from a Linux desk.
 */
describe('eval beds: bed.conf parses the same on either line ending', () => {
  const conf = ['BED_NAME=ADK', 'BED_REAL_SUITE=adk.suite.yaml', '', '# a comment', ''];

  it('reads every setting from a CRLF file exactly as from an LF one', () => {
    const lf = parseBedSettings(conf.join('\n'));
    const crlf = parseBedSettings(conf.join('\r\n'));

    expect(lf.get('BED_REAL_SUITE')).toBe('adk.suite.yaml');
    expect(crlf.get('BED_REAL_SUITE')).toBe('adk.suite.yaml');
    expect([...crlf.entries()]).toEqual([...lf.entries()]);
  });

  it('strips comments from CRLF shell too', () => {
    expect(effectiveShellLines('a=1\r\n# comment\r\n\r\nb=2\r\n')).toEqual(['a=1', 'b=2']);
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
    expect(effectiveShellLines(text).length).toBeLessThanOrEqual(6);
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
   * Both halves of the refusal must still be LIVE in the harness — a bed that declares no broken
   * suite, and a bed that declares one that is not on disk. This is the layer that runs on Windows,
   * where the executing tests below are skipped, so it has to survive a guard being commented out
   * rather than deleted.
   */
  it('the harness refuses an undeclared or missing discrimination suite', () => {
    const harness = readFileSync(HARNESS, 'utf8');
    expect(brokenSuiteRefusals(harness).length).toBe(2);
    // And that the refusal still REFUSES. The harness exits 3 from several other places, so this
    // has to look inside `fail_config` itself rather than anywhere in the file.
    expect(failConfigBody(harness).join('\n')).toContain('exit 3');
  });

  /**
   * The discrimination check for the check above. If `effectiveShellLines` ever stopped stripping
   * comments, the assertion it feeds would go back to passing over a harness whose guard had been
   * commented out — which is precisely the false cover this pair replaced. So the stripper is shown
   * a guard in both states and must tell them apart.
   */
  it('a commented-out guard does not count as a guard', () => {
    const live = [
      '[[ -n "$BED_BROKEN_SUITE" ]] || fail_config \\',
      '  "BED_BROKEN_SUITE is not set."',
      '[[ -f "$WORKDIR/$BED_BROKEN_SUITE" ]] || fail_config \\',
      '  "BED_BROKEN_SUITE names a file that is not there."',
    ].join('\n');
    expect(brokenSuiteRefusals(live).length).toBe(2);

    const commented = live
      .split('\n')
      .map((line) => `# ${line}`)
      .join('\n');
    expect(brokenSuiteRefusals(commented).length).toBe(0);

    // Indented comments are still comments, and blank lines are not code.
    expect(brokenSuiteRefusals('   \n\t# [[ -n "$BED_BROKEN_SUITE" ]] || fail_config x\n')).toEqual(
      []
    );
  });

  /**
   * The same discrimination check for the other half. `failConfigBody` must read the function's own
   * body and nothing else, or a `fail_config` downgraded to a warning would still look like a
   * refusal because the harness exits 3 elsewhere.
   */
  it('reads exit 3 from the refusal itself, not from anywhere else in the file', () => {
    const refusing = 'fail_config() {\n  echo "$1" >&2\n  exit 3\n}\nready || exit 3\n';
    expect(failConfigBody(refusing).join('\n')).toContain('exit 3');

    const warningOnly = 'fail_config() {\n  echo "$1" >&2\n}\nready || exit 3\n';
    expect(failConfigBody(warningOnly).join('\n')).not.toContain('exit 3');
  });
});

/**
 * The refusal, executed. Everything above reads files; this runs `run-bed.sh` against beds built to
 * be wrong and asks what it actually did. It is the only layer that would notice the guard being
 * deleted, rewritten to warn instead of exit, or moved after the build — none of which any amount
 * of reading the text can see.
 *
 * POSIX only, because the harness is bash. Windows keeps the reading layer above, which is why that
 * layer had to be made comment-aware rather than deleted in favour of this one.
 *
 * Nothing here builds, provisions or spawns anything: the beds are temporary directories with a
 * one-line `bed_start_sut`, and every case asserts that neither it nor `bed_provision` ever ran.
 * That is what pins "refuses BEFORE it builds or spawns" as behaviour rather than as a claim in a
 * comment — a guard that moved below the build would still exit 3 and would still be wrong.
 */
describe('eval beds: the harness refuses, in fact, a bed that cannot fail', () => {
  const temporaryBeds: string[] = [];

  afterAll(() => {
    for (const bed of temporaryBeds) rmSync(bed, { recursive: true, force: true });
  });

  /**
   * A minimal bed that is valid in every respect the harness checks BEFORE the discrimination
   * suite, so whatever a case does or does not declare about that suite is the only thing left to
   * explain the outcome.
   */
  function makeBed(options: { broken?: string; brokenOnDisk?: boolean; requiredEnv?: string }): {
    dir: string;
    spawnMarker: string;
    provisionMarker: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'gth-eval-bed-'));
    temporaryBeds.push(dir);
    const workdir = join(dir, 'workdir');
    mkdirSync(workdir);
    writeFileSync(join(workdir, 'real.eval.yaml'), 'cases: []\n');
    if (options.broken && options.brokenOnDisk) {
      writeFileSync(join(workdir, options.broken), 'cases: []\n');
    }

    const spawnMarker = join(dir, 'SUT-WAS-STARTED');
    const provisionMarker = join(dir, 'BED-WAS-PROVISIONED');
    const conf = [
      'BED_NAME=spec-bed',
      'BED_PORT_VAR=GTH_SPEC_BED_PORT',
      // Port 1 is privileged and nothing here answers on it, so the harness's "already running"
      // probe cannot mistake some other process on this machine for this bed's SUT.
      'BED_PORT_DEFAULT=1',
      'BED_REAL_SUITE=real.eval.yaml',
      ...(options.broken === undefined ? [] : [`BED_BROKEN_SUITE=${options.broken}`]),
      ...(options.requiredEnv === undefined
        ? []
        : [`BED_REQUIRED_ENV=("${options.requiredEnv}:stops this run before it can build")`]),
      `bed_provision() { : > ${JSON.stringify(provisionMarker)}; }`,
      `bed_start_sut() { : > ${JSON.stringify(spawnMarker)}; exec sleep 30; }`,
      '',
    ].join('\n');
    writeFileSync(join(dir, 'bed.conf'), conf);
    return { dir, spawnMarker, provisionMarker };
  }

  function runHarness(bedDir: string) {
    return spawnSync('bash', [HARNESS, bedDir], { encoding: 'utf8', timeout: 60_000 });
  }

  /**
   * Conditioned on the platform, never a bare `.skip`, so it cannot quietly widen to POSIX later —
   * and each name below carries the reason, so a Windows run's own skip lines say why rather than
   * leaving three unexplained skips for whoever compares the cells.
   */
  const skipOnWindows = process.platform === 'win32';
  const because = ' [POSIX only: executes run-bed.sh, which is bash]';

  it.skipIf(skipOnWindows)(
    'exits 3 when a bed declares no discrimination suite at all' + because,
    () => {
      const bed = makeBed({});
      const run = runHarness(bed.dir);

      expect(run.status).toBe(3);
      expect(run.stderr).toContain('BED_BROKEN_SUITE');
      expect(existsSync(bed.spawnMarker)).toBe(false);
      expect(existsSync(bed.provisionMarker)).toBe(false);
      expect(run.stdout).not.toContain('building CLI');
    }
  );

  it.skipIf(skipOnWindows)(
    'exits 3 when the declared discrimination suite is not on disk' + because,
    () => {
      const bed = makeBed({ broken: 'broken.eval.yaml', brokenOnDisk: false });
      const run = runHarness(bed.dir);

      expect(run.status).toBe(3);
      expect(run.stderr).toContain('BED_BROKEN_SUITE');
      expect(existsSync(bed.spawnMarker)).toBe(false);
      expect(existsSync(bed.provisionMarker)).toBe(false);
      expect(run.stdout).not.toContain('building CLI');
    }
  );

  /**
   * The anti-vacuity control, and the reason the two cases above mean anything. A harness that
   * refused every bed would pass them both. This bed declares its discrimination suite properly, so
   * it must get PAST that gate — and it is stopped immediately after by a required environment
   * variable that is deliberately absent, which keeps the control as cheap as the refusals and
   * still off the build.
   */
  it.skipIf(skipOnWindows)(
    'lets a bed that declares both suites through that gate' + because,
    () => {
      const absent = 'GTH_SPEC_BED_DELIBERATELY_ABSENT';
      expect(process.env[absent]).toBeUndefined();

      const bed = makeBed({
        broken: 'broken.eval.yaml',
        brokenOnDisk: true,
        requiredEnv: absent,
      });
      const run = runHarness(bed.dir);

      expect(run.stderr).toContain(absent);
      expect(run.stderr).not.toContain('BED_BROKEN_SUITE');
      expect(existsSync(bed.spawnMarker)).toBe(false);
      expect(run.stdout).not.toContain('building CLI');
    }
  );
});
