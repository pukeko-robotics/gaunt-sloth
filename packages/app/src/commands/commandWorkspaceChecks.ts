/**
 * BATCH-59 — the file-system half of a `command` case's workspace assertions: `file_contains` and
 * `must_not_exist`, read from the case's workspace after its command finished and before the
 * directory is removed. The `after` steps are run by `commandEvalRunner.ts`, which owns the spawn
 * seam. The parse-time half (the path guard and the glob dialect) is the batch package's
 * `workspaceChecks.ts`.
 *
 * Each function returns one reason per assertion that did not hold, and nothing for one that did.
 * A reason is an assertion FAILURE: what the agent left in its workspace is the agent's result. An
 * entry the check could not look at is the one exception, thrown as a
 * {@link WorkspaceUnreadableError} and graded as a harness error.
 *
 * @module
 */
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { WorkspaceFileContainsCheck, WorkspaceMustNotExistCheck } from '@gaunt-sloth/batch';
import { matchesWorkspaceGlob } from '@gaunt-sloth/batch/workspaceChecks.js';

/** How many matching entries a `must_not_exist` reason names before it summarises the rest. */
const MAX_LISTED_MATCHES = 5;

/**
 * A workspace entry that the check could not look at: a permission error, or any other read error
 * that is not "it is not there". Thrown out of {@link checkFileContains} and
 * {@link checkMustNotExist}, and graded by the runner as a HARNESS error, never an assertion
 * failure.
 *
 * ## Why a harness error
 *
 * A check that could not look is not evidence about the agent. Reporting it as a FAIL would charge
 * the agent with a file it may have written correctly; reporting it as a pass, or as "missing",
 * would be worse, because the check never saw the entry at all. So it is `ok: false` (exit 2 when
 * every case is like that), the same class as an `after` step that cannot start, and the reason
 * names the path and the error code so the author can see which entry the harness tripped on.
 */
export class WorkspaceUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceUnreadableError';
  }
}

/** Whether `error` means "the entry is not there" rather than "it could not be looked at". */
function isAbsentError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function unreadable(label: string, error: unknown): WorkspaceUnreadableError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
  const message = error instanceof Error ? error.message : String(error);
  return new WorkspaceUnreadableError(
    `${label}: the workspace entry could not be read (${code}), so the check could not look: ${message}`
  );
}

/** What a non-regular entry is, for a reason: "a directory", "a named pipe (FIFO)", … */
function describeEntryType(stats: Stats): string {
  if (stats.isDirectory()) return 'a directory';
  if (stats.isFIFO()) return 'a named pipe (FIFO)';
  if (stats.isSocket()) return 'a socket';
  if (stats.isCharacterDevice()) return 'a character device';
  if (stats.isBlockDevice()) return 'a block device';
  return 'not a regular file';
}

/** Whether `candidate` is `root` or inside it. Both must be canonical (realpath) paths. */
export function isInsideDir(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  // `..` alone, or `..` followed by a separator, leaves `root`; a name such as `..cache` does not.
  // An absolute `rel` happens on win32 when the two are on different drives.
  return rel === '' || (!(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel));
}

/**
 * Grade `file_contains`. A file that does not exist fails with its own reason, distinct from one
 * that exists and lacks a string, because "the agent deleted it" and "the agent wrote the wrong
 * thing" are different findings.
 *
 * ## The run-time containment check
 *
 * The parser already refuses a path that names something outside the workspace. That cannot stop
 * a symbolic link: the agent (or the template) can make `src/greet.mjs` a link to any file on the
 * machine, and reading through it would grade a file the agent never had to touch, or quote a
 * stranger's file into a report. So the path is resolved through every link with `realpath`, and a
 * file that lands outside the workspace's own realpath is a failure that is never read.
 */
export function checkFileContains(
  workspaceDir: string,
  checks: readonly WorkspaceFileContainsCheck[]
): string[] {
  if (checks.length === 0) return [];
  const root = realpathSync.native(workspaceDir);
  const failures: string[] = [];
  for (const check of checks) {
    const label = `file_contains "${check.path}"`;
    const full = resolve(root, ...check.path.split('/'));
    try {
      lstatSync(full);
    } catch (error) {
      if (!isAbsentError(error)) throw unreadable(label, error);
      failures.push(`${label}: the file does not exist in the workspace`);
      continue;
    }
    let real: string;
    try {
      real = realpathSync.native(full);
    } catch (error) {
      if (!isAbsentError(error)) throw unreadable(label, error);
      failures.push(`${label}: it is a symbolic link whose target does not exist`);
      continue;
    }
    if (!isInsideDir(root, real)) {
      failures.push(
        `${label}: it resolves outside the workspace (to ${real}) through a symbolic link, so it ` +
          'was not read'
      );
      continue;
    }
    // Only a REGULAR file is ever opened. A named pipe the agent left at the path would block the
    // synchronous read below forever (no writer, no deadline: the case's timeout covers its
    // processes, not this read), and a starved event loop never runs gth's SIGINT handler, so even
    // Ctrl+C could not stop the run. A socket or a device is no better. So every other entry type is
    // a failure naming what was there, and is never opened.
    let text: string;
    try {
      const stats = statSync(real);
      if (!stats.isFile()) {
        failures.push(`${label}: it is ${describeEntryType(stats)}, not a regular file`);
        continue;
      }
      text = readFileSync(real, 'utf8');
    } catch (error) {
      throw unreadable(label, error);
    }
    for (const substring of check.substrings) {
      if (!text.includes(substring)) {
        failures.push(`${label}: the file does not contain ${JSON.stringify(substring)}`);
      }
    }
  }
  return failures;
}

/**
 * Every entry under `workspaceDir`, as a workspace-relative path joined with `/` on every platform
 * (so a glob reads the same on Windows). Symbolic links are listed and never followed: a link to a
 * directory is one entry, so a link to `/` cannot make the walk read the whole machine, and nothing
 * outside the workspace can match a glob.
 */
export function listWorkspaceEntries(workspaceDir: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw unreadable(`must_not_exist could not list "${prefix || '.'}"`, error);
    }
    for (const dirent of dirents) {
      const rel = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
      entries.push(rel);
      if (dirent.isDirectory()) walk(join(dir, dirent.name), rel);
    }
  };
  walk(workspaceDir, '');
  return entries.sort();
}

/**
 * Grade `must_not_exist`: one reason per glob that matched anything, naming what it matched. Dot
 * entries are matched like any other (see `workspaceChecks.ts` for the dialect), so `notes/*`
 * catches `notes/.hidden`.
 */
export function checkMustNotExist(
  workspaceDir: string,
  checks: readonly WorkspaceMustNotExistCheck[]
): string[] {
  if (checks.length === 0) return [];
  const entries = listWorkspaceEntries(workspaceDir);
  const failures: string[] = [];
  for (const check of checks) {
    const matched = entries.filter((entry) => matchesWorkspaceGlob(check.segments, entry));
    if (matched.length === 0) continue;
    const listed = matched.slice(0, MAX_LISTED_MATCHES).join(', ');
    const more =
      matched.length > MAX_LISTED_MATCHES ? ` and ${matched.length - MAX_LISTED_MATCHES} more` : '';
    failures.push(`must_not_exist "${check.pattern}": the workspace has ${listed}${more}`);
  }
  return failures;
}
