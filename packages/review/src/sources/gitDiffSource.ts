import type { ProviderConfig } from './types.js';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';

/**
 * `git diff` can emit multi-megabyte output for large changes; the node default (1 MiB)
 * would truncate-and-fail such runs.
 */
const MAX_DIFF_BUFFER = 32 * 1024 * 1024;

/**
 * Gets a local diff via `git --no-pager diff [refRange]` — review the working tree (or a
 * ref range) without GitHub and without piping a diff through stdin.
 *
 * @param _ config (unused in this source)
 * @param refRange optional revision selection passed to `git diff`, e.g. `origin/main...HEAD`
 *   or `HEAD~3`. When omitted, diffs the working tree against the index (plain `git diff`).
 * @returns the diff content; throws with a clear message outside a git repository, on a bad
 *   ref, or when the diff is empty (an empty review would otherwise run against no content).
 */
export async function get(
  _: ProviderConfig | null,
  refRange: string | undefined
): Promise<string | null> {
  // Args go to execFile (no shell), so shell metacharacters are inert; still reject
  // option-shaped input so an id can never become a git flag (e.g. `--output=<file>`).
  if (refRange && refRange.startsWith('-')) {
    throw new Error(
      `Invalid git diff argument "${refRange}"; expected a ref or ref range (e.g. "origin/main...HEAD"), not an option.`
    );
  }

  const label = refRange ? `for "${refRange}"` : 'for the working tree';
  const gitArgs = ['--no-pager', 'diff', ...(refRange ? [refRange] : [])];

  const progress = new ProgressIndicator(`Getting local git diff ${label}`);
  try {
    const diffContent = await runGit(gitArgs);
    progress.stop();

    if (!diffContent.trim()) {
      throw new Error(`No changes found in git diff ${label}; nothing to review.`);
    }

    return `Local git diff ${label}\n\n${diffContent}`;
  } catch (error) {
    progress.stop();
    const reason = error instanceof Error ? error.message : String(error);
    if (reason.startsWith('No changes found')) {
      throw new Error(reason);
    }
    throw new Error(
      `Failed to get git diff ${label}: ${reason}\nConsider checking that you are inside a git repository and the ref range is valid.`
    );
  }
}

/**
 * Run git with an args array (execFile, no shell). Rejects on a non-zero exit or spawn
 * failure with git's stderr as the reason; benign stderr chatter on a zero exit is ignored
 * (unlike systemUtils.execAsync, which rejects on any stderr output).
 */
async function runGit(args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('git', args, { maxBuffer: MAX_DIFF_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(extractGitError(stderr ?? '', error.message)));
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
