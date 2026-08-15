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
const GATE_COMMAND = 'pnpm run docs:check';
const BUILD_AND_TEST_COMMAND = 'pnpm test';

function rootScripts(): Record<string, string | undefined> {
  const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  return (pkg.scripts ?? {}) as Record<string, string | undefined>;
}

function workflow(): string {
  return readFileSync(UNIT_TESTS_WORKFLOW, 'utf8');
}

describe('OPS-67 the docs render gate is wired into CI', () => {
  it('has the script, and it runs the render check', () => {
    // Anti-vacuity: a renamed script would leave every assertion below matching a command that
    // exists in the workflow but no longer does anything.
    const script = rootScripts()[GATE_SCRIPT];
    expect(script, `root package.json is missing the "${GATE_SCRIPT}" script`).toBeDefined();
    expect(script).toContain('scripts/check-docs-render.mjs');
    expect(existsSync(CHECK_SCRIPT), 'scripts/check-docs-render.mjs is missing').toBe(true);
  });

  it('runs that script in the unit-tests workflow', () => {
    expect(
      workflow(),
      `.github/workflows/unit-tests.yml must run "${GATE_COMMAND}" — without it nothing in CI ` +
        'renders the docs site, which is the gap OPS-67 closed.'
    ).toContain(GATE_COMMAND);
  });

  it('runs it after the build, never before', () => {
    const text = workflow();
    const build = text.indexOf(BUILD_AND_TEST_COMMAND);
    const gate = text.indexOf(GATE_COMMAND);
    // Control: if either command stopped appearing, the comparison below would silently compare
    // against -1 and could pass for the wrong reason.
    expect(build, `"${BUILD_AND_TEST_COMMAND}" is no longer in the workflow`).toBeGreaterThan(-1);
    expect(gate, `"${GATE_COMMAND}" is no longer in the workflow`).toBeGreaterThan(-1);
    expect(
      gate,
      `"${GATE_COMMAND}" must come after "${BUILD_AND_TEST_COMMAND}": TypeDoc reads each ` +
        "package's built dist/*.d.ts, so on an unbuilt tree the render dies in TS2307 errors."
    ).toBeGreaterThan(build);
  });
});
