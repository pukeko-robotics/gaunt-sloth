import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * OPS-31 — every tracked JavaScript/TypeScript file must have at least one ESLint rule applied.
 *
 * `pnpm run lint` exits 0 for a file that no config block in `eslint.config.js` matches: ESLint
 * walks it, applies nothing, and reports no problems. A green lint run is therefore not evidence
 * that a file is checked — it is only evidence that the files which happen to be checked are
 * clean. Whole directories of source can sit outside every `files` glob and nothing says so. This
 * spec is what reads the denominator: it asks ESLint, per file, how many rules it would apply, and
 * fails naming any file that would get none.
 *
 * `rules > 0` is deliberately a floor of *one*, so it is only as strong as the config keeping
 * narrow overlay blocks narrow. The `react-hooks` block at the end of `eslint.config.js` is scoped
 * to where hooks actually live rather than to every .tsx in the repo for exactly this reason: a
 * repo-wide overlay would hand an otherwise-unconfigured file its single rule and hide it from
 * this check. Widening any overlay to a bare extension glob defeats the guard silently.
 *
 * **Ignored is not the same as unconfigured, and `isPathIgnored` alone cannot tell them apart.**
 * Measured on the ESLint in this repo, `isPathIgnored` returns `true` both for a file matched by
 * `globalIgnores` and for a file matched by no config block at all — that is, for precisely the
 * files this spec exists to catch. Using it on its own as the skip filter would drop every
 * offender before the assertion and the spec could never fail. The two are separated structurally,
 * by asking ESLint's own ignore machinery twice: a second instance built with `ignore: false`
 * stops honouring `globalIgnores` but still reports an unmatched file as ignored. A file ignored
 * by both is unconfigured; a file ignored only by the first is deliberately excluded. No ignore
 * list is copied here — a duplicated one would drift from the config it mirrors.
 *
 * The file list comes from `git ls-files`, so this covers every tracked file in every package and
 * build output can never trip it. Paths are reported exactly as git prints them (always
 * forward-slashed), so a failure reads identically on Windows.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The extensions the lint gate claims to cover; they are also its `--ext` list. */
const LINTABLE_EXTENSION = /\.(?:js|mjs|ts|tsx)$/;

/**
 * A path under a directory that no config block matches. It intentionally does not exist: both
 * ESLint APIs used here answer from the path alone, so proving the detector discriminates costs
 * no fixture file and leaves nothing to clean up. Do not create one.
 */
const UNCONFIGURED_PATH = 'eslint-coverage-probe/unconfigured.ts';
/** A path every reader can check by eye: ordinary package source, matched by a `files` glob. */
const COVERED_PATH = 'packages/core/src/config.ts';
/** Deliberately bad code, kept unlintable on purpose — an integration-test fixture workdir. */
const DELIBERATELY_IGNORED_PATH = 'packages/app/integration-tests/workdir/filewithgoodcode.js';

const respectingIgnores = new ESLint({ cwd: REPO_ROOT });
const disregardingIgnores = new ESLint({ cwd: REPO_ROOT, ignore: false });

/**
 * True only for a file excluded on purpose by `globalIgnores`, never for an unmatched one.
 *
 * The two categories are not a perfect partition: a path that is in `globalIgnores` *and* matched
 * by no `files` glob once ignores are dropped answers `true` to both questions, so it is reported
 * as an offender rather than skipped. That errs loud instead of silent, which is the safe
 * direction for a guard — a red here means "give this path a config block or explain it", not
 * "the guard is broken".
 */
async function isDeliberatelyIgnored(file: string): Promise<boolean> {
  const absolute = join(REPO_ROOT, file);
  return (
    (await respectingIgnores.isPathIgnored(absolute)) &&
    !(await disregardingIgnores.isPathIgnored(absolute))
  );
}

/** How many rules ESLint would apply to this path. Zero means nothing checks the file. */
async function rulesAppliedTo(file: string): Promise<number> {
  const absolute = join(REPO_ROOT, file);
  const config = await respectingIgnores.calculateConfigForFile(absolute);
  return Object.keys(config?.rules ?? {}).length;
}

let cachedFiles: string[] | undefined;

/** Memoised: the list is identical for every test here, and the Windows cells pay for each spawn. */
function trackedLintableFiles(): string[] {
  if (cachedFiles) return cachedFiles;
  // -z: NUL-separated, so a path containing a newline cannot split one entry into two.
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  cachedFiles = out
    .split(String.fromCharCode(0))
    .filter(Boolean)
    .filter((file) => LINTABLE_EXTENSION.test(file));
  return cachedFiles;
}

interface Coverage {
  /** Files deliberately excluded by `globalIgnores`, and so not asserted on. */
  ignored: string[];
  /** Files actually put to the rule-count assertion. */
  checked: string[];
  /** Checked files ESLint would apply no rule to. Must be empty. */
  offenders: string[];
}

let cachedCoverage: Promise<Coverage> | undefined;

function coverage(): Promise<Coverage> {
  cachedCoverage ??= (async () => {
    const result: Coverage = { ignored: [], checked: [], offenders: [] };
    for (const file of trackedLintableFiles()) {
      if (await isDeliberatelyIgnored(file)) {
        result.ignored.push(file);
        continue;
      }
      result.checked.push(file);
      if ((await rulesAppliedTo(file)) === 0) result.offenders.push(file);
    }
    return result;
  })();
  return cachedCoverage;
}

describe('OPS-31 every tracked source file is covered by the lint gate', () => {
  it('tells a covered file, an ignored file and an unconfigured file apart', async () => {
    // Control: without this the assertion below could be satisfied by a detector that never
    // returns zero, or by a skip filter that quietly swallows every unmatched file.
    expect(await rulesAppliedTo(COVERED_PATH)).toBeGreaterThan(0);
    expect(await isDeliberatelyIgnored(COVERED_PATH)).toBe(false);

    expect(await rulesAppliedTo(UNCONFIGURED_PATH)).toBe(0);
    expect(await isDeliberatelyIgnored(UNCONFIGURED_PATH)).toBe(false);

    expect(await isDeliberatelyIgnored(DELIBERATELY_IGNORED_PATH)).toBe(true);
    // This test triggers the cold load of eslint.config.js and its plugin graph, so it gets the
    // same generous timeout as the two below rather than the suite's default.
  }, 60_000);

  it('enumerates and checks a plausible number of tracked source files', async () => {
    // Anti-vacuity, two ways. A failed git call or a wrong cwd yields an empty list and every
    // per-file assertion passes by scanning nothing; a broad new entry in `globalIgnores` would
    // instead move the whole repo into the skip set, which the enumerated count alone cannot see.
    const files = trackedLintableFiles();
    expect(files.length).toBeGreaterThan(400);
    expect(files).toContain(COVERED_PATH);

    const { checked } = await coverage();
    expect(checked.length).toBeGreaterThan(400);
  }, 60_000);

  it('applies at least one ESLint rule to every tracked source file', async () => {
    const { offenders } = await coverage();
    expect(offenders).toEqual([]);
  }, 60_000);
});
