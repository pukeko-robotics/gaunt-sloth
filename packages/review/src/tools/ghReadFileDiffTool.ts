/**
 * @packageDocumentation
 * REL-6 — **one changed file's diff, for a pull request too large to show whole.**
 *
 * On a PR whose triage named files without their diff (`prDiffTriage.ts`), the review agent gets
 * this tool and reads the diffs it needs one path at a time. What it returns is the `patch` of one
 * row of the REST files listing — the result of
 * `gh api repos/{o}/{r}/pulls/{n}/files --jq '.[] | select(.filename == "<path>") | .patch'`, which
 * describes WHAT the tool returns, not how. Called with a `pattern` instead of a `path`, it lists the
 * changed files that match, so a model whose manifest was folded away by compaction can still find
 * what there is to read.
 *
 * **The path never reaches a shell.** The listing is fetched once per run (normally it is the
 * listing the source already fetched for the triage, handed over in `LargePrListing`) and the path
 * is matched against it in JS by exact membership; a pattern is matched in JS by core's linear glob
 * matcher. That is why this tool takes any path the listing holds, parentheses included, where
 * `gth_gh_read_file` — which puts the path into a command — has to refuse them.
 *
 * Owner, repository and PR number are the run's own binding, never the model's. The patch bytes are
 * attacker-controlled under `pull_request_target`, so the output is neutralised the way the triaged
 * content is, and capped — see {@link READ_SHARE_OF_DIFF_BUDGET} for why the cap is a share of the
 * window and not only this tool's `builtInTools` entry.
 */
import path from 'node:path';
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import {
  GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES,
  GH_READ_FILE_DIFF_TOOL_NAME,
  GH_READ_FILE_TOOL_NAME,
  getGhReadFileDiffMaxBytes,
  type GhReadFileCommand,
} from '@gaunt-sloth/core/config.js';
import {
  neutralizeUntrustedMultilineText,
  neutralizeUntrustedText,
} from '@gaunt-sloth/core/core/shell/framing.js';
import { compileGlob } from '@gaunt-sloth/core/utils/globMatch.js';
import {
  fetchPrFilesListing,
  type PrBaseBinding,
  type PrFileEntry,
} from '#src/utils/prFilesListing.js';
import { diffBudgetBytes, UNKNOWN_WINDOW_FALLBACK_TOKENS } from '#src/utils/prDiffTriage.js';

const TOOL_NAME = GH_READ_FILE_DIFF_TOOL_NAME;

/**
 * How many close matches an unknown path's error names. Enough to recover from a typo or a path
 * the model half remembers after compaction folded the manifest away; few enough that the error
 * stays a short message on a PR of a thousand files.
 */
export const MAX_PATH_SUGGESTIONS = 5;

/** The most file names one listing query returns; the total is always stated beside them. */
export const MAX_LISTED_PATHS = 50;

/**
 * The longest listing pattern accepted, in characters. The matcher is linear, so this is not a
 * backtracking guard; it keeps a pattern that is really a pasted diff from being echoed back.
 */
export const MAX_PATTERN_CHARACTERS = 500;

/** Longest path, in characters, an error message echoes before cutting it with an ellipsis. */
const MAX_ECHOED_PATH_CHARACTERS = 300;

/**
 * **The share of the triage's content budget one answer from this tool may take: one sixteenth.**
 * The effective cap is the smaller of this share and `builtInTools.gth_gh_read_file_diff.maxBytes`.
 *
 * The cap exists so the review loop's arithmetic closes without the guard having to fold what it
 * cannot. Compaction keeps the last `DEFAULT_KEEP_RECENT` (6) conversation messages verbatim and
 * folds nothing while the conversation is no longer than that, so with one read per turn (an AI
 * call and its tool result, two messages) up to 6 / 2 = **3 whole results sit unfolded**: two
 * beside the first message before anything can fold, three in the kept tail after every fold. The
 * request that must fit is therefore the first message plus three answers, plus the system prompt.
 *
 * In the estimator's units (core's `estimatePromptTokens`: characters / 3.5 × 1.1), with W the
 * window and B = `diffBudgetBytes(W)` = 0.5 × W × 4 = 2W bytes, the first message is at most B, so
 * it costs up to 2W / 3.5 × 1.1 ≈ 0.629W — more than REL-21's "half the window", because the
 * triage counts 4 bytes a token and the guard counts 3.5. The threshold the guard uses is
 * W − min(2048, W / 4) by default, or 0.8W when `gth init` seeded it; the lower of the two is 0.8W
 * from W = 10240 up, so that is the bound:
 *
 *     (B + 3 × B / 16) / 3.5 × 1.1  =  0.629W × 1.1875  ≈  0.746W   ≤   0.8W
 *
 * leaving 0.054W for the system prompt and the AI turns (6.9k tokens on a 128k window, about 21k
 * characters; the default review prompts are about 4.5k). A sixth would leave 0.014W, which a
 * project's own guidelines can exhaust on a 128k window. It closes from a 32k window up against
 * either threshold; at 16k only against the runtime default (W − 2048), and at 8k not at all,
 * because the first message and the system prompt alone already exceed it.
 *
 * Pinned against the real constants in `ghReadFileDiffToolWindowShare.spec.ts`, so a change to
 * `DEFAULT_KEEP_RECENT`, the estimator or the triage budget turns that spec red instead of silently
 * reopening the overflow.
 *
 * **It assumes one read per turn.** A model that calls this tool several times in one turn puts
 * all of those results in one AI-plus-tools group, and compaction widens its kept tail to keep a
 * group whole, so more than three results can then sit unfolded.
 */
export const READ_SHARE_OF_DIFF_BUDGET = 1 / 16;

/**
 * The bytes one answer from this tool may take: the smaller of the configured `maxBytes` and
 * {@link READ_SHARE_OF_DIFF_BUDGET} of the budget the triage used. With no budget in hand, the
 * budget REL-21's triage falls back to on an unknown window is used, so the two agree.
 */
export function effectiveDiffReadCapBytes(maxBytes: number, budgetBytes?: number): number {
  const budget =
    budgetBytes !== undefined && Number.isFinite(budgetBytes) && budgetBytes > 0
      ? budgetBytes
      : diffBudgetBytes(UNKNOWN_WINDOW_FALLBACK_TOKENS)!;
  return Math.max(1, Math.min(maxBytes, Math.floor(budget * READ_SHARE_OF_DIFF_BUDGET)));
}

const toolSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      'Repository-relative path of one changed file to read the diff of, exactly as the pull request lists it, e.g. "src/index.ts"'
    ),
  pattern: z
    .string()
    .optional()
    .describe(
      'Instead of a path: a glob such as "src/**/*.ts" or "*.md", or a directory prefix such as "packages/core/", to list the changed files that match'
    ),
});

type GhReadFileDiffArgs = z.infer<typeof toolSchema>;

/** Where the tool's rows come from: the listing in hand, or the binding to fetch it from once. */
export interface FileDiffListingSource {
  binding: PrBaseBinding;
  /** The listing the run already holds. Absent, it is fetched once on the first call. */
  entries?: readonly PrFileEntry[];
  /**
   * The content budget, in bytes, the triage used for this run — what bounds the first message.
   * Absent, the unknown-window fallback budget is assumed. See {@link effectiveDiffReadCapBytes}.
   */
  budgetBytes?: number;
}

/** A path from the listing or from the model, safe to put on one line of a message. */
function echo(value: string): string {
  const safe = neutralizeUntrustedText(value);
  return safe.length > MAX_ECHOED_PATH_CHARACTERS
    ? `${safe.slice(0, MAX_ECHOED_PATH_CHARACTERS)}…`
    : safe;
}

/** Cut to at most `maxBytes` UTF-8 bytes, as `ghReadFileTool.ts` does: never on a split character. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Up to {@link MAX_PATH_SUGGESTIONS} listed paths close to `wanted`: the same base name first, then
 * a case-insensitive substring either way round, in listing order within each group.
 */
export function closePathMatches(
  wanted: string,
  entries: readonly PrFileEntry[],
  limit = MAX_PATH_SUGGESTIONS
): string[] {
  const needle = wanted.trim().toLowerCase();
  const base = path.posix.basename(needle);
  const out: string[] = [];
  const add = (candidate: string): void => {
    if (out.length < limit && !out.includes(candidate)) out.push(candidate);
  };
  if (base.length > 0) {
    for (const entry of entries) {
      if (path.posix.basename(entry.path.toLowerCase()) === base) add(entry.path);
    }
  }
  if (needle.length > 0) {
    for (const entry of entries) {
      const candidate = entry.path.toLowerCase();
      if (candidate.includes(needle) || (base.length > 0 && candidate.includes(base))) {
        add(entry.path);
      }
    }
  }
  return out;
}

/** The status line every answer about a listed file opens with. */
function describe(entry: PrFileEntry, servedAs: 'path' | 'previous'): string {
  const from = entry.previousPath !== undefined ? ` from ${echo(entry.previousPath)}` : '';
  const note =
    servedAs === 'previous'
      ? ` (you asked for its previous path; it is now ${echo(entry.path)})`
      : '';
  return `${echo(entry.path)}${note}: ${entry.status}${from}, +${entry.additions} -${entry.deletions}`;
}

const GLOB_CHARACTERS = /[*?{]/;

/**
 * A listing query as a predicate over listed paths. A pattern with a glob character is a glob in
 * core's `prompts.paths` vocabulary, matched against the whole path and, when it has no `/`, the
 * base name too (the rule `--elide` patterns follow). Anything else is a directory prefix, or one
 * exact path. An empty pattern matches every file.
 */
function pathPredicate(pattern: string): (candidate: string) => boolean {
  const trimmed = pattern.trim().replace(/^\.\//, '');
  if (trimmed.length === 0) return () => true;
  if (GLOB_CHARACTERS.test(trimmed)) {
    const glob = compileGlob(trimmed);
    const againstBase = !glob.pattern.includes('/');
    return (candidate) => {
      const hit =
        glob.test(candidate) || (againstBase && glob.test(path.posix.basename(candidate)));
      return glob.negated ? !hit : hit;
    };
  }
  const prefix = trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
  return (candidate) => candidate === trimmed || candidate.startsWith(prefix);
}

/**
 * Answer a listing query: the listed files whose paths match `pattern`, each with its status and
 * counts, at most {@link MAX_LISTED_PATHS} of them and never more than `maxBytes`, always with the
 * total match count. Pure, and never throws.
 */
export function listFilesFromListing(
  pattern: string,
  entries: readonly PrFileEntry[],
  maxBytes: number = GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES
): string {
  if (pattern.length > MAX_PATTERN_CHARACTERS) {
    return (
      `That pattern is ${pattern.length} characters long; at most ${MAX_PATTERN_CHARACTERS} are ` +
      'accepted. Ask again with a shorter glob or directory prefix.'
    );
  }
  const matches = pathPredicate(pattern);
  const matched = entries.filter((entry) => matches(entry.path));
  const what = pattern.trim().length === 0 ? '' : ` match "${echo(pattern.trim())}"`;
  if (matched.length === 0) {
    return (
      `None of the ${entries.length} files this pull request changes${what}. A pattern is a glob ` +
      '("src/**/*.ts", "*.md") or a directory prefix ("packages/core/").'
    );
  }

  const lines = matched.slice(0, MAX_LISTED_PATHS).map((entry) => describe(entry, 'path'));
  const render = (shown: number): string => {
    const head =
      `${matched.length} of the ${entries.length} files this pull request changes` +
      `${what || ' are listed'}${shown < matched.length ? `; the first ${shown} are` : ''}:`;
    const more =
      shown < matched.length
        ? `\n${matched.length - shown} more matched and are not shown; narrow the pattern to see them.`
        : '';
    return `${head}\n${lines.slice(0, shown).join('\n')}${more}\nRead one with ${TOOL_NAME} and its path.`;
  };
  // Drop names, never the count, until the answer fits the cap: a listing is one of the results
  // that sits unfolded in the kept tail, so it is held to the same cap as a diff.
  let shown = lines.length;
  let out = render(shown);
  while (shown > 0 && bytes(out) > maxBytes) {
    shown--;
    out = render(shown);
  }
  return truncateToBytes(out, maxBytes);
}

/**
 * Answer one call against the listing. Pure: the listing, the arguments and the cap in, the text the
 * model reads out. A `path` reads that file's diff; a `pattern`, or neither, lists the matching
 * files. Never throws.
 */
export function readFileDiffFromListing(
  args: GhReadFileDiffArgs,
  entries: readonly PrFileEntry[],
  maxBytes: number = GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES,
  readFileToolEnabled = true
): string {
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  if (!hasPath) {
    return listFilesFromListing(
      typeof args.pattern === 'string' ? args.pattern : '',
      entries,
      maxBytes
    );
  }
  const wanted = args.path as string;
  let entry = entries.find((row) => row.path === wanted);
  let servedAs: 'path' | 'previous' = 'path';
  if (!entry) {
    entry = entries.find((row) => row.previousPath === wanted);
    servedAs = 'previous';
  }

  if (!entry) {
    const matches = closePathMatches(wanted, entries);
    const hint =
      matches.length > 0
        ? ` Close matches: ${matches.map((match) => `"${echo(match)}"`).join(', ')}.`
        : ' No listed path is close to it.';
    return truncateToBytes(
      `"${echo(wanted)}" is not one of the ${entries.length} files this pull request changes, ` +
        `so there is no diff to read.${hint} Ask again with a path exactly as the pull request ` +
        'lists it, or list the changed files with a pattern.',
      maxBytes
    );
  }

  const heading = describe(entry, servedAs);
  if (entry.patch === undefined || entry.patch.length === 0) {
    const removed = entry.status === 'removed';
    const next = removed
      ? 'It was removed, so there is no file at the PR head to read either.'
      : readFileToolEnabled
        ? `Read the file at the PR head with ${GH_READ_FILE_TOOL_NAME} if you need its contents.`
        : 'Judge it on its name and counts.';
    return truncateToBytes(
      `No diff for ${heading}. The GitHub files listing carries none for this file: it is binary, ` +
        `its diff is too large for GitHub to render, or it is a rename with no content change. ${next}`,
      maxBytes
    );
  }

  const patch = neutralizeUntrustedMultilineText(entry.patch);
  const whole = `Diff of ${heading}\n\n${patch}`;
  if (bytes(whole) <= maxBytes) {
    return whole;
  }
  // The cap covers the WHOLE answer, heading and marker included, because the guard's estimate
  // counts every character of it.
  const prefix = `Partial diff of ${heading} (truncated)\n\n`;
  const marker =
    `\n... [${TOOL_NAME}: this diff was cut to ${maxBytes} bytes to fit this model's context ` +
    'window beside the rest of the review — it is INCOMPLETE, the rest was not returned.' +
    (readFileToolEnabled
      ? ` ${GH_READ_FILE_TOOL_NAME} reads the whole file at the PR head if you need more.]`
      : ']') +
    ' ...';
  return truncateToBytes(
    `${prefix}${truncateToBytes(patch, maxBytes - bytes(prefix) - bytes(marker))}${marker}`,
    maxBytes
  );
}

/**
 * Built-in tool factory in the repo's `get(config)` idiom, bound to one run's listing.
 *
 * **The memo is this closure.** A fetched listing is held by the tool instance, and `review()`
 * builds a new instance on every call, so nothing a run fetched can reach another run.
 */
export function get(
  config: GthConfig,
  source: FileDiffListingSource,
  command: GhReadFileCommand = 'pr',
  readFileToolEnabled = true
): StructuredToolInterface {
  const maxBytes = effectiveDiffReadCapBytes(
    getGhReadFileDiffMaxBytes(config, command),
    source.budgetBytes
  );
  let listing: Promise<readonly PrFileEntry[] | string> | undefined = source.entries
    ? Promise.resolve(source.entries)
    : undefined;
  const getListing = (): Promise<readonly PrFileEntry[] | string> => {
    if (!listing) {
      listing = fetchPrFilesListing(source.binding).catch(
        (error: unknown) =>
          `Could not fetch the pull request's files listing: ${
            error instanceof Error ? error.message : String(error)
          }\nContinue the review with what you already have.`
      );
    }
    return listing;
  };

  return tool(
    async (args: GhReadFileDiffArgs) => {
      const entries = await getListing();
      if (typeof entries === 'string') return entries;
      return readFileDiffFromListing(args, entries, maxBytes, readFileToolEnabled);
    },
    {
      name: TOOL_NAME,
      description:
        'Read the diff of ONE file changed by the pull request under review. Use it on a very ' +
        'large pull request to look at the changes of the files you were not shown, choosing ' +
        'the ones that matter. Supply the repository-relative path exactly as the pull request ' +
        'lists it; the repository and PR are bound automatically. An unknown path returns close ' +
        'matches, and a pattern instead of a path lists the changed files that match it. At most ' +
        `${maxBytes} bytes are returned, sized to fit this model's context window: a larger diff ` +
        'comes back truncated and says so.' +
        (readFileToolEnabled
          ? ` For the whole file rather than its changes, use ${GH_READ_FILE_TOOL_NAME}.`
          : ''),
      schema: toolSchema,
    }
  ) as StructuredToolInterface;
}

export const GTH_GH_READ_FILE_DIFF_TOOL_NAME = TOOL_NAME;
