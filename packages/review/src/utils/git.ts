/**
 * `git diff` can emit multi-megabyte output for large changes; the node default (1 MiB)
 * would truncate-and-fail such runs.
 */
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

/** The config key that names the base a branch is reviewed against. */
export const MERGE_BASE_SETTING = 'contentSourceConfig.git.mergeBase';

/**
 * A git invocation that failed. `exitCode` is git's own exit status when git ran and exited
 * non-zero, and `undefined` when it could not be spawned at all; callers use it to tell apart
 * failures that print nothing (`git merge-base` exits 1 silently when there is no common
 * ancestor) from the ones that print a `fatal:` line.
 */
export class GitCommandError extends Error {
  readonly exitCode: number | undefined;

  constructor(message: string, exitCode: number | undefined) {
    super(message);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
  }
}

/**
 * Run git with an args array (execFile, no shell) in the current working directory. Rejects
 * with a {@link GitCommandError} on a non-zero exit or spawn failure, with git's stderr reduced
 * to its meaningful line as the message; benign stderr chatter on a zero exit is ignored (unlike
 * systemUtils.execAsync, which rejects on any stderr output).
 */
export async function runGit(args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: MAX_GIT_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as { code?: unknown }).code;
        reject(
          new GitCommandError(
            extractGitError(stderr ?? '', error.message),
            typeof code === 'number' ? code : undefined
          )
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Reduce git's stderr to the one meaningful line. Outside a repository `git diff` appends
 * its entire `--no-index` usage screen after the warning line; that wall of text is noise
 * in a CLI error. Prefer the `fatal:` line when present, else the first non-empty line.
 */
function extractGitError(stderr: string, fallback: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return fallback;
  }
  return lines.find((line) => line.startsWith('fatal:')) ?? lines[0];
}

/** A full object name as `git merge-base` prints it: SHA-1 (40) or SHA-256 (64) hex. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Resolve the merge base of `base` and `HEAD` to a commit sha, with `git merge-base <base> HEAD`.
 *
 * This is the ONE place the merge base is computed, and it is shared on purpose: the git content
 * source diffs against it, and a later reader that lists the branch's commits (as requirements
 * evidence) must compute its range from this same function. Two resolvers are how a reviewed
 * diff and the evidence beside it would come to describe different branches.
 *
 * Why a sha rather than `git diff --merge-base <base>`: that flag needs git 2.30+, and it would
 * put a flag on git's command line that came from the caller's side of the seam. Resolving first
 * works on any git, and what reaches `git diff` afterwards is a validated object name, never
 * something option-shaped.
 *
 * An unresolvable base throws; it never falls back to some other diff. A fallback (the plain
 * working-tree diff, say) would silently review LESS than the user configured, which is worse
 * than stopping. The messages name `origin` (by default the config key) so the user knows which
 * setting to fix.
 *
 * @param base the configured ref, e.g. `origin/main`; rejected if it starts with `-`, so a value
 *   from config can never become a git flag.
 * @param origin what to call the value in error messages.
 * @returns the full merge-base commit sha.
 */
export async function resolveMergeBase(
  base: string,
  origin: string = MERGE_BASE_SETTING
): Promise<string> {
  if (base.startsWith('-')) {
    throw new Error(
      `Invalid ${origin} "${base}"; expected a ref (e.g. "origin/main"), not an option.`
    );
  }

  let output: string;
  try {
    output = await runGit(['merge-base', base, 'HEAD']);
  } catch (error) {
    // `git merge-base` exits 1 and prints nothing when the two commits share no history.
    if (error instanceof GitCommandError && error.exitCode === 1) {
      throw new Error(
        `${origin} "${base}" has no common ancestor with HEAD, so there is no merge base to review against.`
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${origin} "${base}" could not be resolved to a merge base: ${reason}`);
  }

  const sha = output.trim();
  if (!OBJECT_NAME.test(sha)) {
    throw new Error(
      `${origin} "${base}" could not be resolved to a merge base: git merge-base printed "${sha}".`
    );
  }
  return sha;
}
