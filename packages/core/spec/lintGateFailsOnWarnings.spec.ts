import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * OPS-39 — the lint gate must fail on warnings, not merely report them.
 *
 * ESLint exits 0 when it finds only warnings. Without `--max-warnings 0` every warn-severity rule
 * in `eslint.config.js` is therefore decorative: it prints, nobody is blocked, and the finding
 * survives indefinitely under a green gate. That is not hypothetical — adopting
 * `eslint-plugin-react-hooks`'s recommended set (which ships `exhaustive-deps` as a *warning*)
 * would have silently demoted the one hook rule this repo already enforced, and lint would have
 * stayed green while the rule reported. [[OPS-38]] caught that one by hand; this makes the whole
 * class impossible.
 *
 * The flag lives in a package.json script, which is a string nothing else type-checks or executes
 * in the unit suite, so it can be dropped in a refactor with no signal at all — the same
 * "preserved by nothing" problem [[OPS-31]]'s coverage guard exists to solve. Hence this spec.
 *
 * It deliberately asserts on the script *text* rather than by running ESLint: running it would
 * prove today's tree is clean, which is a different claim and one `pnpm run lint` already makes.
 * What is unprotected is the flag itself.
 */

/**
 * Resolved as a URL and handed to `readFileSync` as one. Going through a native path here is what
 * broke the first attempt on win32: a `D:\…` string is not a valid URL, so re-wrapping it in
 * `new URL(…, 'file:')` produced nonsense on Windows and worked everywhere else — the exact shape
 * the repo's Windows-cell rule exists to catch.
 */
const ROOT_PACKAGE_JSON = new URL('../../../package.json', import.meta.url);

interface PackageScripts {
  [script: string]: string | undefined;
}

function rootScripts(): PackageScripts {
  const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
  return (pkg.scripts ?? {}) as PackageScripts;
}

/** Both spellings ESLint accepts. A trailing digit guard stops `--max-warnings 10` matching. */
function failsOnWarnings(script: string): boolean {
  return /--max-warnings[= ]0(?!\d)/.test(script);
}

/** The scripts that run ESLint over the repo and are therefore gates. */
const GATE_SCRIPTS = ['lint', 'lint-n-fix'];

describe('OPS-39 the lint gate fails on warnings', () => {
  it('detects the flag only when it is really there', () => {
    // Control: without this, `failsOnWarnings` could return true for everything and the assertions
    // below would pass no matter what the scripts said.
    expect(failsOnWarnings('eslint . --ext .js,.ts --max-warnings 0')).toBe(true);
    expect(failsOnWarnings('eslint . --ext .js,.ts --max-warnings=0')).toBe(true);
    expect(failsOnWarnings('eslint . --ext .js,.ts')).toBe(false);
    expect(failsOnWarnings('eslint . --ext .js,.ts --max-warnings 10')).toBe(false);
  });

  it('still has the gate scripts, and they still run eslint', () => {
    // Anti-vacuity: a renamed or deleted script would otherwise make every assertion below vacuous
    // by iterating over nothing, or pass `undefined` into a regex that simply says "no flag".
    const scripts = rootScripts();
    for (const name of GATE_SCRIPTS) {
      expect(scripts[name], `root package.json is missing the "${name}" script`).toBeDefined();
      expect(scripts[name]).toContain('eslint');
    }
  });

  it.each(GATE_SCRIPTS)('%s refuses to pass with warnings', (name) => {
    const script = rootScripts()[name] ?? '';
    expect(
      failsOnWarnings(script),
      `"${name}" must carry --max-warnings 0, or every warn-severity rule in eslint.config.js ` +
        `becomes decorative — eslint exits 0 on warnings. Script is: ${script}`
    ).toBe(true);
  });
});
