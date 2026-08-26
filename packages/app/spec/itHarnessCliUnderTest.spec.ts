import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_DIR,
  CLI_UNDER_TEST,
  assertCliUnderTest,
  gthSpawnSpec,
  reportedCliVersion,
  workspaceCliVersion,
} from '../integration-tests/support/cliUnderTest.mjs';

/**
 * QA-12 — the integration-test harness must run the code under test, and must keep running it.
 *
 * The harness itself only executes under `pnpm run it <provider>`, which needs a provider and, for
 * most tiers, a real model. This file pins the parts that can be checked for free, so they are
 * covered by the ordinary unit matrix on every platform instead of by a gate almost nobody runs.
 *
 * Spawning specs need the app build, as the other `*.e2e.spec.ts` files here do; `pnpm test` builds
 * before vitest runs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const IT_ROOT = resolve(here, '..', 'integration-tests');

/**
 * The launcher commands that must never come back into the harness.
 *
 * They resolve a BARE NAME and, on a miss, download and execute whatever the public registry
 * answers with — which is how the suite came to run a different binary from the one the branch
 * builds. This list, not the version check in `cliUnderTest.mjs`, is what covers the case where a
 * foreign binary happens to share the workspace's version number.
 */
const FORBIDDEN_LAUNCHERS = ['npx', 'bunx', 'dlx'];

/**
 * Harness sources only. `workdir/` and `workdir-with-profiles/` are excluded on purpose: they hold
 * fixtures and the session files the CLI writes during a run, so their contents are partly written
 * by a model and a static scan of them would be reporting on model output rather than on the
 * harness. Nothing under them invokes anything.
 */
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md'];
const SKIPPED_DIRS = new Set(['node_modules', 'workdir', 'workdir-with-profiles']);

function harnessSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found;
}

describe('integration-test harness: no package-runner launchers', () => {
  const files = harnessSourceFiles(IT_ROOT);

  /**
   * The guard's own discrimination check. A scan that resolves its root from the cwd, or that
   * quietly visits nothing, passes green on every platform and is indistinguishable from a clean
   * tree — so assert the scan actually reached the harness before trusting what it did not find.
   */
  it('scans the harness tree it claims to scan', () => {
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain(join(IT_ROOT, 'support', 'commandRunner.ts'));
    expect(files).toContain(join(IT_ROOT, 'support', 'cliUnderTest.mjs'));
    expect(files.filter((f) => f.endsWith('.it.ts')).length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_LAUNCHERS)('never invokes %s anywhere under integration-tests', (launcher) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(launcher));
    expect(
      offenders,
      `${launcher} resolves a bare name and falls back to the public registry. The harness must ` +
        `spawn the resolved packages/app/cli.js instead — see ` +
        `packages/app/integration-tests/support/cliUnderTest.mjs.`
    ).toEqual([]);
  });
});

describe('integration-test harness: resolution', () => {
  it('resolves the CLI by an absolute path anchored on the harness, not by a name', () => {
    expect(isAbsolute(CLI_UNDER_TEST)).toBe(true);
    expect(CLI_UNDER_TEST).toBe(join(APP_DIR, 'cli.js'));
    expect(APP_DIR.endsWith(join('packages', 'app'))).toBe(true);
  });

  it('spawns this process node binary with the resolved entry point as its first argument', () => {
    const spec = gthSpawnSpec(['ask', 'hello'], join(tmpdir(), 'anywhere'));
    expect(spec.command).toBe(process.execPath);
    expect(spec.argv).toEqual([CLI_UNDER_TEST, 'ask', 'hello']);
  });
});

describe('integration-test harness: the version tripwire', () => {
  it('the resolved CLI reports the version this workspace builds', () => {
    expect(assertCliUnderTest()).toBe(workspaceCliVersion());
  });

  /**
   * The discriminating control. Pointed at another binary the check must FAIL — that is the whole
   * point of it, and a green run against the right binary proves nothing on its own.
   */
  it('FAILS when pointed at a different binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gth-foreign-cli-'));
    try {
      const foreign = join(dir, 'cli.js');
      writeFileSync(foreign, "console.log('0.0.0-a-different-binary');\n", 'utf8');
      expect(reportedCliVersion(foreign).version).toBe('0.0.0-a-different-binary');
      expect(() => assertCliUnderTest({ cliPath: foreign })).toThrowError(
        /not running the code under test/
      );
      expect(() => assertCliUnderTest({ cliPath: foreign })).toThrowError(
        new RegExp(workspaceCliVersion())
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * An unbuilt workspace must say so. Probed by starting the CLI rather than by looking for
   * `dist/cli.js`, because several packages are built and the entry point dies on its first import
   * when any one of them is missing. The real worktree is never touched to produce this: the
   * fixture is a temp package whose entry point imports a `dist/` that was never built.
   */
  it('asks for a build when the entry point cannot start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gth-unbuilt-app-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        '{"name":"gaunt-sloth","version":"9.9.9"}\n',
        'utf8'
      );
      writeFileSync(join(dir, 'cli.js'), "await import('./dist/cli.js');\n", 'utf8');
      const probe = reportedCliVersion(join(dir, 'cli.js'));
      expect(probe.status).not.toBe(0);
      expect(() => assertCliUnderTest({ cliPath: join(dir, 'cli.js'), appDir: dir })).toThrowError(
        /pnpm run build/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('integration-test harness: INIT_CWD', () => {
  /**
   * `getCurrentWorkDir()` in core reads `INIT_CWD` and only falls back to `process.cwd()`, so the
   * value the harness passes is what up-tree config discovery walks from. It must come from the
   * test's own working directory rather than being inherited — under pnpm the inherited value is
   * the repository root.
   */
  it('sets INIT_CWD to the spawn working directory, overriding an inherited one', () => {
    const inherited = process.env.INIT_CWD;
    process.env.INIT_CWD = join(tmpdir(), 'inherited-from-the-parent');
    try {
      const workDir = join(tmpdir(), 'the-tests-own-working-directory');
      expect(gthSpawnSpec([], workDir).env.INIT_CWD).toBe(workDir);
    } finally {
      if (inherited === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = inherited;
    }
  });

  it('forces the plain readline surface on every spawn', () => {
    expect(gthSpawnSpec([], tmpdir()).env.GTH_NO_TUI).toBe('1');
  });

  /**
   * The mechanism itself, end to end and without a model: config discovery follows `INIT_CWD`, not
   * the process working directory. Two directories each hold a config; the CLI runs with its cwd in
   * one and `INIT_CWD` in the other, and reports the one `INIT_CWD` names. Then the topology the
   * suite really uses — `INIT_CWD` at a case subdir with no config — reports the nearest ancestor
   * that has one, over both the cwd's and a further-up one.
   *
   * This is what makes `markerSynthesis.xx-small.it.ts` able to find `workdir/.gsloth.config.json`
   * from a case subdir, and it is deterministic, key-free and runs on every platform, so the
   * contract is pinned here rather than only in a gate that needs a GPU. It matters beyond finding
   * the right file: an inherited `INIT_CWD` walks up to the repository's own developer config and
   * silently runs the suite on the provider that names, which is a green run reporting on a
   * provider nobody selected.
   */
  it('config discovery follows INIT_CWD rather than the process working directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'gth-initcwd-'));
    try {
      const primary = join(base, 'gth-init-cwd-primary');
      const secondary = join(base, 'gth-init-cwd-secondary');
      // A case subdir with no config of its own, the shape every marker/synthesis case runs in.
      const caseSubdir = join(secondary, 'gth-init-cwd-case');
      // A throwaway home, so whatever global config the machine happens to carry cannot join the
      // report and change what is asserted here. homedir() reads HOME on POSIX and USERPROFILE on
      // Windows, so both are set.
      const home = join(base, 'home');
      mkdirSync(primary);
      mkdirSync(secondary);
      mkdirSync(caseSubdir);
      mkdirSync(home);
      writeFileSync(join(primary, '.gsloth.config.json'), '{"llm":{"type":"openai"}}\n', 'utf8');
      writeFileSync(join(secondary, '.gsloth.config.json'), '{"llm":{"type":"openai"}}\n', 'utf8');
      // One more, further up than either, so "the nearest ancestor wins" has something to beat.
      writeFileSync(join(base, '.gsloth.config.json'), '{"llm":{"type":"openai"}}\n', 'utf8');

      const validateFrom = (initCwd: string): string => {
        const result = spawnSync(
          process.execPath,
          [CLI_UNDER_TEST, '--nopipe', 'config', 'validate'],
          {
            encoding: 'utf8',
            cwd: primary,
            env: { ...process.env, INIT_CWD: initCwd, HOME: home, USERPROFILE: home },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        return `${result.stdout ?? ''}${result.stderr ?? ''}`;
      };

      const fromSecondary = validateFrom(secondary);
      expect(fromSecondary).toContain(`gth-init-cwd-secondary${sep}.gsloth.config.json`);
      expect(fromSecondary).not.toContain(`gth-init-cwd-primary${sep}.gsloth.config.json`);

      // The control: only INIT_CWD moved, and the answer moved with it.
      const fromPrimary = validateFrom(primary);
      expect(fromPrimary).toContain(`gth-init-cwd-primary${sep}.gsloth.config.json`);
      expect(fromPrimary).not.toContain(`gth-init-cwd-secondary${sep}.gsloth.config.json`);

      // And the topology the marker/synthesis cases actually run in: INIT_CWD is a case subdir
      // holding no config, and the walk up from it stops at the nearest ancestor that has one —
      // not at the process working directory's, and not at the one further up in `base`.
      const fromCaseSubdir = validateFrom(caseSubdir);
      expect(fromCaseSubdir).toContain(`gth-init-cwd-secondary${sep}.gsloth.config.json`);
      expect(fromCaseSubdir).not.toContain(`gth-init-cwd-primary${sep}.gsloth.config.json`);
      expect(fromCaseSubdir).not.toContain(`${basename(base)}${sep}.gsloth.config.json`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
