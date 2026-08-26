/**
 * QA-12 — how the integration-test harness finds the CLI it is supposed to be testing.
 *
 * The harness used to spawn the CLI through npm's package runner, by name. A package runner
 * resolves a BARE NAME: it walks `node_modules/.bin` upward from the spawn cwd, then falls through
 * to `PATH`, and on a miss it downloads and executes whatever the public registry answers with.
 * Two things follow, and both were measured rather than reasoned about.
 *
 * (The runner's own name, and its bun and pnpm siblings, are absent from this whole directory on
 * purpose: `packages/app/spec/itHarnessCliUnderTest.spec.ts` enumerates them and fails if one comes
 * back. That is why this file describes the mechanism instead of naming the commands.)
 *
 * 1. There is no `gaunt-sloth` bin link anywhere in this workspace — the package is nobody's
 *    dependency, so pnpm never links it. Every `.bin` from the test working directory up to the
 *    repository root lacks it. So on a developer machine the lookup reached the GLOBAL npm
 *    install, and the suite exercised the LAST PUBLISHED CLI while the branch's own build sat
 *    unused beside it. On a fresh CI runner there is no global install either, and the same lookup
 *    reached the registry.
 * 2. That made the gate unable to fail for the reason it exists. A pre-merge gate that runs
 *    yesterday's published binary reports on yesterday's code.
 *
 * The replacement is deliberately dull: resolve `packages/app/cli.js` by a path anchored on THIS
 * file, and spawn it with `process.execPath`. `packages/app/run-tui-e2e.js` and
 * `packages/app/spec/cliGlobalFlag.spec.ts` already do exactly this. Anchoring on `import.meta.url`
 * is what makes the answer identical from every working directory the suite uses, and it is the
 * property that actually proves the harness runs the code under test — the version check below is
 * a tripwire on top of it, not the proof.
 *
 * WHAT THE VERSION CHECK IS AND IS NOT. `--version` makes the CLI read the `package.json` sitting
 * beside the `cli.js` it was started from, which under path anchoring is the very file this module
 * reads. So when resolution is healthy the comparison cannot fail, and it is not evidence that
 * `dist/` was rebuilt from the current source. Its job is narrower and worth the four hundred
 * milliseconds: it is a TRIPWIRE that fires the moment anything reintroduces launcher- or
 * PATH-based resolution, because a stranger's binary answers with a different number. It has one
 * blind spot to keep in mind — it goes quiet whenever the foreign binary happens to share the
 * workspace version, which for a global install is one release away. The static guard in
 * `packages/app/spec/itHarnessCliUnderTest.spec.ts` covers that gap by forbidding the launcher
 * names outright.
 *
 * INIT_CWD IS A CONTRACT HERE, NOT A SIDE EFFECT. `getCurrentWorkDir()` in core reads `INIT_CWD`
 * and only falls back to `process.cwd()`, so `INIT_CWD` is where up-tree config discovery starts
 * and what the file toolkit takes as its allowed root. The package runner happened to reset it to
 * the spawn cwd; a bare `node cli.js` inherits it instead, and under pnpm the inherited value is
 * the REPOSITORY ROOT.
 *
 * Measured, an inherited value does not fail loudly, which is the whole reason the assignment is
 * explicit here. Discovery starting at the repository root selects the repository's own developer
 * config — a different provider, on a real key — while the run still announces the provider it was
 * asked for; and the toolkit's allowed root widens from one case directory to the entire
 * repository, so a test that meant to prove the agent read the file beside it can pass by having
 * searched the tree. `gthSpawnSpec` therefore sets `INIT_CWD` explicitly, after the `process.env`
 * spread so the inherited value loses. An emergent property of a launcher is not a contract; an
 * explicit assignment is, and only the explicit one can be tested —
 * `packages/app/spec/itHarnessCliUnderTest.spec.ts` pins the value, the precedence over an
 * inherited one, and the discovery behaviour itself.
 *
 * This is a plain `.mjs` rather than part of `commandRunner.ts` because `it.js` — plain JS, run
 * before vitest exists — imports it for the run-level preflight. `support/ollamaLock.mjs` is the
 * same shape for the same reason.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The CLI package root, `packages/app`, anchored on this file so it never depends on the cwd. */
export const APP_DIR = path.resolve(here, '..', '..');

/** The CLI entry point the whole suite spawns: `packages/app/cli.js`. */
export const CLI_UNDER_TEST = path.join(APP_DIR, 'cli.js');

/** The version this workspace builds, read from `packages/app/package.json`. */
export function workspaceCliVersion(appDir = APP_DIR) {
  return JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
}

/**
 * Ask a CLI entry point which version it is. `stdio` ignores stdin so the probe can never block on
 * the CLI's stdin policy.
 */
export function reportedCliVersion(cliPath = CLI_UNDER_TEST) {
  const result = spawnSync(process.execPath, [cliPath, '--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    version: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/**
 * Refuse to run the suite unless the CLI we resolved starts and reports the workspace version.
 *
 * A non-zero exit is the unbuilt-tree case and is reported as one. Deliberately probed by running
 * the CLI rather than by looking for `dist/cli.js`: seven packages are built, and `cli.js` dies on
 * its `@gaunt-sloth/core` import when core alone is missing, which a single existence check would
 * wave through.
 */
export function assertCliUnderTest({ cliPath = CLI_UNDER_TEST, appDir = APP_DIR } = {}) {
  const expected = workspaceCliVersion(appDir);
  const probe = reportedCliVersion(cliPath);
  if (probe.status !== 0) {
    throw new Error(
      `The integration-test harness could not start the CLI it is meant to test.\n` +
        `  entry point: ${cliPath}\n` +
        `  exit code:   ${probe.status}\n` +
        `Build the workspace first, from the repository root: pnpm run build\n` +
        `The entry point reported:\n${probe.stderr || '(no output)'}`
    );
  }
  if (probe.version !== expected) {
    throw new Error(
      `The integration-test harness is not running the code under test.\n` +
        `  entry point:        ${cliPath}\n` +
        `  it reports version: ${probe.version}\n` +
        `  this workspace is:  ${expected}\n` +
        `A mismatch means the spawned binary is not this checkout's build — the failure QA-12 ` +
        `exists to prevent. Rebuild with pnpm run build, and if the harness has started resolving ` +
        `the CLI by name again, put it back on the anchored path in ` +
        `packages/app/integration-tests/support/cliUnderTest.mjs.`
    );
  }
  return probe.version;
}

let asserted = false;

/** The same check, run at most once per process, for callers on a per-spawn path. */
export function assertCliUnderTestOnce() {
  if (asserted) return;
  assertCliUnderTest();
  asserted = true;
}

/**
 * Everything needed to spawn the CLI under test: the node binary running this process, the
 * anchored entry point, and the environment.
 *
 * Every spawn in the harness goes through here, which is what lets
 * `packages/app/spec/itHarnessCliUnderTest.spec.ts` assert the harness spawns a resolved path
 * rather than a name, and that `INIT_CWD` points at the test's own working directory.
 *
 * `GTH_NO_TUI` is set for every spawn, servers and interactive sessions alike. The suite is always
 * non-TTY, so the plain readline path is already what gets selected; forcing it means no test can
 * start rendering the Ink TUI because of how it happened to be launched.
 */
export function gthSpawnSpec(args, workDir) {
  return {
    command: process.execPath,
    argv: [CLI_UNDER_TEST, ...args],
    env: {
      ...process.env,
      GTH_NO_TUI: '1',
      INIT_CWD: workDir,
    },
  };
}
