/**
 * BATCH-58 — the file-system and environment half of a `command` case's workspace: make the fresh
 * directory, copy the template into it, build the case's environment, and remove the directory.
 * The process half (running `setup`, then the command) is in `commandEvalRunner.ts`, which owns
 * the spawn seam, the tree kill and the exit hook.
 *
 * ## One directory per run of a case, never per case id
 *
 * {@link createWorkspaceDir} is called once per `RunCellFn` call, and nothing is cached by case id.
 * Two cases editing the same fixture file under `-j` each see only their own edit, and a future
 * repeat of one case (BATCH-60) gets a fresh copy each time rather than the previous run's leftovers.
 *
 * ## Choices that keep the fixture safe and the paths honest
 *
 * - **`mkdtemp` under `os.tmpdir()`, then `realpath`.** On macOS the temp directory sits behind
 *   the `/var` → `/private/var` symlink, and a Windows runner can hand back an 8.3 short path. The
 *   canonical path is what the child sees as its cwd, so it is the one `{{workspace}}` expands to.
 * - **`cpSync` with `verbatimSymlinks`.** Without it Node rewrites a RELATIVE symlink in the copy
 *   into an absolute one pointing back into the template, so an agent writing through the link
 *   would edit the committed fixture. `cpSync` keeps file modes on POSIX, so an executable stub in
 *   the template stays executable.
 * - **A junction in the template may arrive as a real directory on Windows.** Node 24's JS `cpSync`
 *   (`lib/internal/fs/cp/cp-sync.js`) hands a recursive copy with no `filter` to the native
 *   `cpSyncCopyDir`, whose source is not in this repository, so the JS does not say how it treats a
 *   junction. The Windows cells show a template junction to an outside directory arriving as
 *   something the containment check does not see as leading outside, which fits a copy of the
 *   directory's contents. That is acceptable: the template is the suite author's, and trusted. What
 *   the containment check guards against is a link the AGENT makes during its run, and the specs
 *   pin that case on every platform.
 * - **Removal retries.** On Windows a process that has just exited (or a virus scanner) can hold a
 *   handle for a moment, and `rm` fails with `EBUSY`/`EPERM`; Node's `maxRetries` backs off and
 *   tries again. A removal that still fails is reported by the caller and never fails the case: the
 *   case's result is already decided by then.
 *
 * @module
 */
import { cpSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CommandWorkspace } from '@gaunt-sloth/batch';
import { expandWorkspaceTemplate } from '@gaunt-sloth/batch/workspaceTemplate.js';
import { getProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/**
 * The absolute directory of a suite named by `readPath` (the path `gth eval` reads the suite by,
 * relative to the project directory). A workspace `template`, `{{suite_dir}}` and a custom
 * transcript decoder's path all resolve against it, through this one function, so they cannot
 * disagree about where the suite lives.
 */
export function resolveSuiteDir(readPath: string): string {
  return resolve(getProjectDir(), dirname(readPath));
}

/** Removal attempts for a busy directory, and the linear back-off step between them. */
const REMOVE_MAX_RETRIES = 10;
const REMOVE_RETRY_DELAY_MS = 100;

/**
 * Make a fresh, empty-or-templated directory for one run of `caseId` and return its canonical path.
 * Throws (with the directory already removed) when the template cannot be copied.
 */
export function createWorkspaceDir(caseId: string, spec: CommandWorkspace): string {
  const prefix = `gth-eval-${caseId.slice(0, 40)}-`;
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  if (spec.template !== undefined) {
    try {
      cpSync(spec.template, dir, { recursive: true, verbatimSymlinks: true });
    } catch (error) {
      removeWorkspaceDir(dir);
      throw new Error(
        `could not copy the workspace template "${spec.template}": ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }
  return dir;
}

/** Remove a workspace directory, retrying a busy one. Throws when it still cannot be removed. */
export function removeWorkspaceDir(dir: string): void {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_MAX_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}

/**
 * Read one variable from `base`. Windows names are case-insensitive, and `process.env` honours
 * that there, but a plain copy of it does not, so a non-`process.env` base is searched without
 * case on win32 (`{{env.PATH}}` must find `Path`).
 */
export function readEnvVar(
  base: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  const direct = base[name];
  if (direct !== undefined || platform !== 'win32') return direct;
  const upper = name.toUpperCase();
  const key = Object.keys(base).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : base[key];
}

/**
 * `overrides` set over a copy of `base`. On win32 a variable the suite sets REPLACES every
 * spelling of it in the base: a suite's `PATH` must not sit beside the inherited `Path`, where
 * which one the child and the executable lookup use is down to key order.
 */
export function mergeWorkspaceEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (platform === 'win32') {
      const upper = name.toUpperCase();
      for (const key of Object.keys(merged)) {
        if (key.toUpperCase() === upper) delete merged[key];
      }
    }
    merged[name] = value;
  }
  return merged;
}

/** The case's environment: the suite's `env`, its tokens expanded, merged over `base`. */
export function buildWorkspaceEnv(
  spec: CommandWorkspace,
  dir: string,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const values = {
    suiteDir: spec.suiteDir,
    workspace: dir,
    readEnv: (name: string) => readEnvVar(base, name),
  };
  const expanded = Object.fromEntries(
    Object.entries(spec.env).map(([name, value]) => [name, expandWorkspaceTemplate(value, values)])
  );
  return mergeWorkspaceEnv(base, expanded);
}

/** A setup step's argv with its tokens expanded, element by element (never re-split). */
export function expandSetupArgv(
  argv: readonly string[],
  spec: CommandWorkspace,
  dir: string,
  base: NodeJS.ProcessEnv
): string[] {
  const values = {
    suiteDir: spec.suiteDir,
    workspace: dir,
    readEnv: (name: string) => readEnvVar(base, name),
  };
  return argv.map((arg) => expandWorkspaceTemplate(arg, values));
}
