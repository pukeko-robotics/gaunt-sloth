import type { ProviderConfig } from './types.js';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { MERGE_BASE_SETTING, resolveMergeBase, runGit } from '#src/utils/git.js';

/** The keys this source reads from `contentSourceConfig.git`. */
const KNOWN_GIT_CONFIG_KEYS = ['mergeBase'] as const;

/**
 * Gets a local diff via `git --no-pager diff` — review the working tree, a ref range, or a
 * branch against its merge base, without GitHub and without piping a diff through stdin.
 *
 * Which diff, in order:
 *
 * 1. An explicit `refRange` always wins and keeps its plain meaning, `git diff <refRange>`,
 *    whatever `mergeBase` says. It is the more specific request: the user typed it for this run,
 *    while `mergeBase` is a standing default from config.
 * 2. Otherwise, with `mergeBase` set, the working tree against the merge base of that ref and
 *    `HEAD` — what the branch's pull request would show, plus uncommitted edits to tracked files.
 *    The base is resolved to a sha by {@link resolveMergeBase} (see there for why a sha, and why
 *    an unresolvable base fails instead of falling back), and the diff is
 *    `git diff <sha> --`: the `--` stops git reading the sha as a path when a file of that name
 *    exists. Untracked files are not in it, as in any `git diff`.
 * 3. Otherwise the working tree against the index (plain `git diff`).
 *
 * `mergeBase` is validated here rather than in core's config schema, which keeps every
 * content source's block opaque (`z.record(z.string(), z.unknown())`) and leaves each source to
 * own its keys. It is validated on every call, even when an explicit `refRange` means it will not
 * be used: a malformed value is a config error that should surface on the first run, not on the
 * first run that happens to omit the id.
 *
 * @param config `contentSourceConfig.git`, if any. Recognised key: `mergeBase` (string); any
 *   other key is ignored with a warning, so a typo such as `mergebase` is reported.
 * @param refRange optional revision selection passed to `git diff`, e.g. `origin/main...HEAD`
 *   or `HEAD~3`.
 * @returns the diff content; throws with a clear message outside a git repository, on a bad
 *   ref or merge base, or when the diff is empty (an empty review would otherwise run against no
 *   content).
 */
export async function get(
  config: ProviderConfig | null,
  refRange: string | undefined
): Promise<string | null> {
  // Args go to execFile (no shell), so shell metacharacters are inert; still reject
  // option-shaped input so an id can never become a git flag (e.g. `--output=<file>`).
  if (refRange && refRange.startsWith('-')) {
    throw new Error(
      `Invalid git diff argument "${refRange}"; expected a ref or ref range (e.g. "origin/main...HEAD"), not an option.`
    );
  }

  const mergeBase = readMergeBase(config);

  if (!refRange && mergeBase !== undefined) {
    return getMergeBaseDiff(mergeBase);
  }

  const label = refRange ? `for "${refRange}"` : 'for the working tree';
  const gitArgs = ['--no-pager', 'diff', ...(refRange ? [refRange] : [])];

  const progress = new ProgressIndicator(`Getting local git diff ${label}`);
  return runDiff(progress, label, gitArgs, 'the ref range is valid');
}

/**
 * Read `mergeBase` from the git source's config block. `undefined` when unset; throws, naming
 * the setting, for anything that is set but is not a non-empty string (and for a block that is
 * not an object), so a mistyped value is reported instead of silently ignored.
 *
 * Any other key in the block gets a warning, not an error. A mistyped key such as `mergebase`
 * would otherwise review the plain working-tree diff with nothing said. It is not rejected
 * because a project config is shared by people on different gth versions: a key a later release
 * adds must not break an older one's reviews. That matches the top-level rule in core's config
 * schema, where unknown keys warn and only known deprecated names fail.
 */
function readMergeBase(config: ProviderConfig | null | undefined): string | undefined {
  if (config === null || config === undefined) {
    return undefined;
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(
      `Invalid contentSourceConfig.git; expected an object such as { "mergeBase": "origin/main" }.`
    );
  }
  const unknownKeys = Object.keys(config).filter(
    (key) => !(KNOWN_GIT_CONFIG_KEYS as readonly string[]).includes(key)
  );
  if (unknownKeys.length > 0) {
    const names = unknownKeys.map((key) => `"${key}"`).join(', ');
    const noun = unknownKeys.length === 1 ? 'key' : 'keys';
    const verb = unknownKeys.length === 1 ? 'is' : 'are';
    displayWarning(
      `contentSourceConfig.git: unknown ${noun} ${names} ${verb} ignored; known keys: ${KNOWN_GIT_CONFIG_KEYS.join(', ')}.`
    );
  }
  const value = config.mergeBase;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid ${MERGE_BASE_SETTING} ${JSON.stringify(value) ?? String(value)}; expected a non-empty string naming a ref, e.g. "origin/main".`
    );
  }
  return value;
}

/** The working tree against the merge base of `mergeBase` and `HEAD`. */
async function getMergeBaseDiff(mergeBase: string): Promise<string> {
  const target = `the merge base of "${mergeBase}" and HEAD`;
  const progress = new ProgressIndicator(`Getting local git diff against ${target}`);
  let sha: string;
  try {
    sha = await resolveMergeBase(mergeBase);
  } catch (error) {
    progress.stop();
    throw error;
  }
  return runDiff(
    progress,
    `against ${target} (${sha})`,
    ['--no-pager', 'diff', sha, '--'],
    `${MERGE_BASE_SETTING} names a ref in this repository`
  );
}

async function runDiff(
  progress: ProgressIndicator,
  label: string,
  gitArgs: string[],
  hint: string
): Promise<string> {
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
      `Failed to get git diff ${label}: ${reason}\nConsider checking that you are inside a git repository and ${hint}.`
    );
  }
}
