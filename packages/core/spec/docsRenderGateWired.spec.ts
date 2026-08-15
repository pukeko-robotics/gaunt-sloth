import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * OPS-67 — the docs render gate must stay wired into CI, and stay after the build.
 *
 * `pnpm typedoc` exits 0 with hundreds of warnings, so `scripts/check-docs-render.mjs` is what
 * turns a broken anchor, a link to a page that does not exist, or a page delivered as a raw
 * download into a red build. It reaches CI through two strings — a `package.json` script and a
 * step in a workflow file — and neither is type-checked, executed by the unit suite, or referenced
 * from any code path, so both can be dropped in a refactor with no signal at all. That is the same
 * "preserved by nothing" problem `lintGateFailsOnWarnings.spec.ts` exists to solve for
 * `--max-warnings 0`.
 *
 * The ordering assertion is not decoration. TypeDoc resolves the cross-package imports through
 * each package's built `dist/*.d.ts`, so on an unbuilt tree the render dies in TS2307 errors
 * instead of checking anything; `pnpm test` is what builds. Today only a workflow comment says so.
 *
 * This asserts facts about the *files*, not a model of the pipeline — what the render itself does
 * is proven by running it, which is what the gate is. A spec that re-implemented the render would
 * be the very defect OPS-67 was filed about.
 */

const ROOT_PACKAGE_JSON = new URL('../../../package.json', import.meta.url);
const UNIT_TESTS_WORKFLOW = new URL('../../../.github/workflows/unit-tests.yml', import.meta.url);
const CHECK_SCRIPT = new URL('../../../scripts/check-docs-render.mjs', import.meta.url);

const GATE_SCRIPT = 'docs:check';
const GATE_SCRIPT_BODY = 'node scripts/check-docs-render.mjs';
const GATE_COMMAND = 'pnpm run docs:check';
const BUILD_AND_TEST_COMMAND = 'pnpm test';
const GATE_JOB = 'test-and-lint';

/**
 * A run step, not merely the text of one. `^[ \t]*run:` admits only whitespace before the key, so a
 * `#`-commented-out step cannot match — which a substring search cannot tell apart from a live
 * step, and commenting a step out is how a CI step usually gets "temporarily" removed.
 */
function runStep(command: string): RegExp {
  return new RegExp(`^[ \\t]*run:[ \\t]*${command}[ \\t]*$`, 'm');
}

function rootScripts(): Record<string, string | undefined> {
  const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  return (pkg.scripts ?? {}) as Record<string, string | undefined>;
}

/**
 * Only the gate's own job. Ordering is meaningless across jobs — they run in parallel — so a step
 * that moved to `test-platforms` must read as missing here rather than as "later in the file".
 */
function gateJob(): string {
  const text = readFileSync(UNIT_TESTS_WORKFLOW, 'utf8');
  const start = text.indexOf(`\n  ${GATE_JOB}:`);
  if (start === -1) return '';
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z][\w-]*:/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('OPS-67 the docs render gate is wired into CI', () => {
  it('has the script, and it is exactly the render check', () => {
    // Exact equality, not `toContain`: an `|| true` suffix, a leading `echo skipped &&`, or a
    // trailing comment all leave the substring intact while making the command unable to fail —
    // measured, and the same "registered but not effective" shape OPS-67 exists to stop. Any
    // legitimate change to this line should update this constant with it.
    const script = rootScripts()[GATE_SCRIPT];
    expect(script, `root package.json is missing the "${GATE_SCRIPT}" script`).toBeDefined();
    expect(
      script,
      `the "${GATE_SCRIPT}" script must be exactly "${GATE_SCRIPT_BODY}" — anything wrapped ` +
        'around it can swallow the failure and leave CI green on a broken docs render.'
    ).toBe(GATE_SCRIPT_BODY);
    expect(existsSync(CHECK_SCRIPT), 'scripts/check-docs-render.mjs is missing').toBe(true);
  });

  it('runs that script as a step of the unit-tests workflow', () => {
    expect(
      runStep(GATE_COMMAND).test(gateJob()),
      `the "${GATE_JOB}" job in .github/workflows/unit-tests.yml must have a step running ` +
        `"${GATE_COMMAND}" — commented out or moved to another job, nothing in CI renders the ` +
        'docs site, which is the gap OPS-67 closed.'
    ).toBe(true);
  });

  it('runs it after the build, never before', () => {
    const job = gateJob();
    const build = job.search(runStep(BUILD_AND_TEST_COMMAND));
    const gate = job.search(runStep(GATE_COMMAND));
    // Control: if either step stopped existing, the comparison below would silently compare
    // against -1 and could pass for the wrong reason.
    expect(build, `"${BUILD_AND_TEST_COMMAND}" is no longer a step of ${GATE_JOB}`).toBeGreaterThan(
      -1
    );
    expect(gate, `"${GATE_COMMAND}" is no longer a step of ${GATE_JOB}`).toBeGreaterThan(-1);
    expect(
      gate,
      `"${GATE_COMMAND}" must come after "${BUILD_AND_TEST_COMMAND}": TypeDoc reads each ` +
        "package's built dist/*.d.ts, so on an unbuilt tree the render dies in TS2307 errors."
    ).toBeGreaterThan(build);
  });
});
