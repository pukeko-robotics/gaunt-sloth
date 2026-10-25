/**
 * @packageDocumentation
 * REL-6 — **one changed file's diff, for a pull request too large to show whole.**
 *
 * On a PR whose triage named files without their diff (`prDiffTriage.ts`), the review agent gets
 * this tool and reads the diffs it needs one path at a time. What it returns is the `patch` of one
 * row of the REST files listing — the result of
 * `gh api repos/{o}/{r}/pulls/{n}/files --jq '.[] | select(.filename == "<path>") | .patch'`, which
 * describes WHAT the tool returns, not how.
 *
 * **The path never reaches a shell.** The listing is fetched once per run (normally it is the
 * listing the source already fetched for the triage, handed over in `LargePrListing`) and the path
 * is matched against it in JS by exact membership. That is why this tool takes any path the listing
 * holds, parentheses included, where `gth_gh_read_file` — which puts the path into a command — has
 * to refuse them.
 *
 * Owner, repository and PR number are the run's own binding, never the model's. The patch bytes are
 * attacker-controlled under `pull_request_target`, so the output is neutralised the way the triaged
 * content is, and capped by this tool's own `builtInTools` entry.
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
import {
  fetchPrFilesListing,
  type PrBaseBinding,
  type PrFileEntry,
} from '#src/utils/prFilesListing.js';

const TOOL_NAME = GH_READ_FILE_DIFF_TOOL_NAME;

/**
 * How many close matches an unknown path's error names. Enough to recover from a typo or a path
 * the model half remembers after compaction folded the manifest away; few enough that the error
 * stays a short message on a PR of a thousand files.
 */
export const MAX_PATH_SUGGESTIONS = 5;

/** Longest path, in characters, an error message echoes before cutting it with an ellipsis. */
const MAX_ECHOED_PATH_CHARACTERS = 300;

const toolSchema = z.object({
  path: z
    .string()
    .describe(
      'Repository-relative path of one changed file, exactly as the pull request lists it, e.g. "src/index.ts"'
    ),
});

type GhReadFileDiffArgs = z.infer<typeof toolSchema>;

/** Where the tool's rows come from: the listing in hand, or the binding to fetch it from once. */
export interface FileDiffListingSource {
  binding: PrBaseBinding;
  /** The listing the run already holds. Absent, it is fetched once on the first call. */
  entries?: readonly PrFileEntry[];
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
  let out = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

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

/**
 * Answer one call against the listing. Pure: the listing, the path and the cap in, the text the
 * model reads out. Never throws.
 */
export function readFileDiffFromListing(
  args: GhReadFileDiffArgs,
  entries: readonly PrFileEntry[],
  maxBytes: number = GH_READ_FILE_DIFF_DEFAULT_MAX_BYTES,
  readFileToolEnabled = true
): string {
  const wanted = typeof args.path === 'string' ? args.path : '';
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
    return (
      `"${echo(wanted)}" is not one of the ${entries.length} files this pull request changes, ` +
      `so there is no diff to read.${hint} Ask again with a path exactly as the pull request lists it.`
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
    return (
      `No diff for ${heading}. The GitHub files listing carries none for this file: it is binary, ` +
      `its diff is too large for GitHub to render, or it is a rename with no content change. ${next}`
    );
  }

  const patch = neutralizeUntrustedMultilineText(entry.patch);
  if (Buffer.byteLength(patch, 'utf8') <= maxBytes) {
    return `Diff of ${heading}\n\n${patch}`;
  }
  return (
    `Partial diff of ${heading} (truncated)\n\n${truncateToBytes(patch, maxBytes)}` +
    `\n... [${TOOL_NAME}: diff truncated at the ${maxBytes}-byte cap ` +
    `(builtInTools.${TOOL_NAME}.maxBytes) — this diff is INCOMPLETE, the rest was not returned] ...`
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
  const maxBytes = getGhReadFileDiffMaxBytes(config, command);
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
        `matches. At most ${maxBytes} bytes of diff are returned: a larger diff comes back ` +
        'truncated and says so.' +
        (readFileToolEnabled
          ? ` For the whole file rather than its changes, use ${GH_READ_FILE_TOOL_NAME}.`
          : ''),
      schema: toolSchema,
    }
  ) as StructuredToolInterface;
}

export const GTH_GH_READ_FILE_DIFF_TOOL_NAME = TOOL_NAME;
