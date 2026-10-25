/**
 * @packageDocumentation
 * REL-21 — **a pull request's changed files, as the GitHub REST files listing reports them.**
 *
 * `gh pr diff` cannot serve a PR of more than 300 files: GitHub answers the diff request with
 * HTTP 406, and `gh pr diff --name-only` dies with it because it derives the names from the same
 * diff. `gh pr view --json files` returns one page of 100 and says nothing about the rest. The
 * paginated `GET /repos/{owner}/{repo}/pulls/{n}/files` endpoint is the only route measured to list
 * every file past that limit, and it reports `status`, `additions` and `deletions` per file before a
 * patch byte has to be read — which is what the triage in `prDiffTriage.ts` needs.
 *
 * The listing is held as structured {@link PrFileEntry} rows, not flattened into text, so a later
 * per-file diff read (REL-6) can serve one file's `patch` from the same listing.
 *
 * ## Binding: the BASE repository, never the head
 *
 * The files endpoint lives on the repository the PR was opened against. For a PR from a fork the
 * head repository (the binding `gth_gh_read_file` uses for whole-file reads at the head ref) is the
 * fork, and `repos/<fork>/pulls/<n>/files` is a 404 — measured on microsoft/TypeScript#64122,
 * whose head is `camc314/TypeScript`. So the owner and repo are parsed from the PR's own `url`
 * (`https://<host>/<owner>/<repo>/pull/<n>`), which `gh pr view` resolves exactly as `gh pr diff`
 * resolves the PR. They are never taken from model output.
 *
 * ## Pagination: one JSON object per line
 *
 * `gh api --paginate` merges the pages into one array on current `gh`, but older releases emit the
 * pages back to back (`][`), and `--slurp` is newer still. `--jq '.[]'` prints one compact object
 * per line on every version, so that is the shape parsed here.
 */
import { execAsync } from '@gaunt-sloth/core/utils/systemUtils.js';

/** The `status` values the REST files listing documents. Anything else is read as `modified`. */
export const PR_FILE_STATUSES = [
  'added',
  'removed',
  'modified',
  'renamed',
  'copied',
  'changed',
  'unchanged',
] as const;

export type PrFileStatus = (typeof PR_FILE_STATUSES)[number];

/** One changed file of a pull request, as the REST files listing reports it. */
export interface PrFileEntry {
  /** Repository-relative POSIX path at the PR head (`filename`). */
  path: string;
  /** The path before a rename or copy (`previous_filename`); absent otherwise. */
  previousPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /**
   * The file's unified-diff hunks, starting at the first `@@` line, with no `diff --git` / `---` /
   * `+++` header. **Absent** when GitHub sends none: a binary file, or a text file whose diff is too
   * large for the listing to carry.
   */
  patch?: string;
}

/** The base repository a pull request was opened against, plus what the listing must account for. */
export interface PrBaseBinding {
  owner: string;
  repo: string;
  number: string;
  /** `changedFiles` as `gh pr view` reports it — the count a complete listing must reach. */
  changedFiles?: number;
}

// The same conservative allow-lists `ghReadFileTool.ts` applies: nothing that reaches the `gh api`
// command string may carry a shell metacharacter.
const OWNER_PATTERN = /^[A-Za-z0-9-_.]+$/;
const REPO_PATTERN = /^[A-Za-z0-9-_.]+$/;
const PR_NUMBER_PATTERN = /^\d+$/;
const PR_URL_PATTERN = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/;

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function toStatus(value: unknown): PrFileStatus {
  return (PR_FILE_STATUSES as readonly string[]).includes(value as string)
    ? (value as PrFileStatus)
    : 'modified';
}

/**
 * Parse one REST files-listing object into a {@link PrFileEntry}, or `undefined` when it carries no
 * usable path. Counts are coerced to non-negative integers and the status is checked against
 * {@link PR_FILE_STATUSES}, because both are later written into text the model reads.
 */
export function toPrFileEntry(raw: unknown): PrFileEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.filename !== 'string' || record.filename.length === 0) return undefined;
  const entry: PrFileEntry = {
    path: record.filename,
    status: toStatus(record.status),
    additions: toCount(record.additions),
    deletions: toCount(record.deletions),
  };
  if (typeof record.previous_filename === 'string' && record.previous_filename.length > 0) {
    entry.previousPath = record.previous_filename;
  }
  if (typeof record.patch === 'string') {
    entry.patch = record.patch;
  }
  return entry;
}

/** Split `[…][…]` into its top-level arrays, tracking JSON string state so brackets in text don't count. */
function splitTopLevelArrays(text: string): string[] {
  const pages: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[' || character === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (character === ']' || character === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        pages.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new Error('the files listing is not complete JSON');
  return pages;
}

/**
 * Parse the output of `gh api … --paginate --jq '.[]'`: one JSON object per line. A whole JSON
 * array (or several back to back on one line) is accepted too, so a caller that fetched the listing
 * some other way can hand it in unchanged.
 */
export function parsePrFilesListing(raw: string): PrFileEntry[] {
  const entries: PrFileEntry[] = [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return entries;

  if (trimmed.startsWith('[')) {
    // Pages emitted back to back by an older `gh` (`][`) are split at the top level, outside any
    // string, so a patch that happens to contain `][` is never cut.
    for (const page of splitTopLevelArrays(trimmed)) {
      const parsed = JSON.parse(page) as unknown;
      for (const item of Array.isArray(parsed) ? parsed : []) {
        const entry = toPrFileEntry(item);
        if (entry) entries.push(entry);
      }
    }
    return entries;
  }

  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const entry = toPrFileEntry(JSON.parse(line) as unknown);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Resolve the base repository and number of a PR through `gh pr view`. With `prId` the PR is
 * addressed explicitly; without it `gh` resolves the current branch's PR, as `gh pr diff` does.
 */
export async function resolvePrBaseBinding(prId: string | undefined): Promise<PrBaseBinding> {
  if (prId !== undefined && !PR_NUMBER_PATTERN.test(prId)) {
    throw new Error(`Invalid GitHub PR number "${prId}"; expected a numeric string.`);
  }
  const selector = prId ? ` ${prId}` : '';
  const raw = await execAsync(`gh pr view${selector} --json number,url,changedFiles`);
  const parsed = JSON.parse(raw) as { number?: unknown; url?: unknown; changedFiles?: unknown };
  const match = typeof parsed.url === 'string' ? PR_URL_PATTERN.exec(parsed.url) : null;
  if (!match) {
    throw new Error(`gh pr view did not return a pull request URL to bind the files listing to.`);
  }
  const [, owner, repo, number] = match;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    throw new Error(`Unexpected repository "${owner}/${repo}" in the pull request URL.`);
  }
  const binding: PrBaseBinding = { owner, repo, number };
  if (typeof parsed.changedFiles === 'number' && Number.isFinite(parsed.changedFiles)) {
    binding.changedFiles = parsed.changedFiles;
  }
  return binding;
}

/**
 * Fetch the whole files listing of a PR through the paginated REST endpoint, as structured rows.
 * Read-only: one `GET` per page of 100.
 */
export async function fetchPrFilesListing(binding: PrBaseBinding): Promise<PrFileEntry[]> {
  const { owner, repo, number } = binding;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !PR_NUMBER_PATTERN.test(number)) {
    throw new Error(`Refusing to list files for an unvalidated repository or PR number.`);
  }
  const raw = await execAsync(
    `gh api 'repos/${owner}/${repo}/pulls/${number}/files?per_page=100' --paginate --jq '.[]'`
  );
  return parsePrFilesListing(raw);
}
