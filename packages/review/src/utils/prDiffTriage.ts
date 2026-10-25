/**
 * @packageDocumentation
 * REL-21 — **fit a pull request's REST files listing into one review turn.**
 *
 * A review is one human message carrying the whole diff. Compaction cannot rescue that message,
 * because there is nothing earlier to fold, so a diff that does not fit the window has to be cut
 * down BEFORE inference. This module does the cutting, deterministically, from the structured
 * listing `prFilesListing.ts` fetches, and writes a manifest of what was cut so the model still
 * knows the shape of the whole PR.
 *
 * ## The rules, in order
 *
 * 1. **Removed files** are named only. For a deletion the review question is whether the file
 *    should be gone, and the name answers it; the `-` hunk costs bytes and attention for nothing.
 * 2. **Files with no `patch`** (binary, or too large for GitHub to inline) are named only, because
 *    there is nothing to show.
 * 3. **Files matching an elision pattern** (lockfiles, minified files, source maps, vendored and
 *    build output by default — {@link DEFAULT_PR_ELIDE_PATTERNS}) are named only.
 * 4. **Everything else goes in smallest first** until the budget is spent. The first file that does
 *    not fit ends the filling, so the largest files are the ones named only.
 *
 * ## Every listed path stays visible to `extractChangedPathsFromDiff`
 *
 * CFG-70's `prompts.paths` selection reads the changed paths from the content's `diff --git`
 * header lines alone. So the manifest writes each named-only file as its own `diff --git a/<p>
 * b/<p>` header followed by a one-line note and no hunks: every path in the listing reaches the
 * selector, and no caller had to change to receive a second list. Paths are quoted by git's own
 * rules ({@link quoteDiffPath}), which `diffPaths.ts` decodes — and which also keeps a hostile file
 * name from writing a line of its own into the content.
 */
import path from 'node:path';
import {
  neutralizeUntrustedMultilineText,
  neutralizeUntrustedText,
} from '@gaunt-sloth/core/core/shell/framing.js';
import type { PrFileEntry } from '#src/utils/prFilesListing.js';

/**
 * Named only, never patched, unless `commands.pr.elidePatterns` replaces the list. Glob semantics
 * follow `gh pr diff --exclude`: a pattern is tested against the full path and against the base
 * name, so a bare `*.min.js` applies at every depth while `dist/**` is anchored at the root.
 */
export const DEFAULT_PR_ELIDE_PATTERNS: readonly string[] = [
  // lockfiles
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Gemfile.lock',
  'composer.lock',
  // minified files and source maps
  '*.min.js',
  '*.min.css',
  '*.map',
  // vendored and build output
  'vendor/**',
  'node_modules/**',
  'dist/**',
];

/**
 * **The token heuristic: 4 bytes of content per token.** A byte count is provider-independent and
 * free; a provider `countTokens` preflight is neither — it differs per provider, several have none,
 * and it is one more network call in front of every review (EXT-176 weighed the same call and
 * declined it). The heuristic's error is absorbed by {@link DIFF_BUDGET_FRACTION_OF_WINDOW}.
 */
export const BYTES_PER_TOKEN = 4;

/**
 * **The share of the context window the PR content may take: one half.**
 *
 * The context guard fires below the window — at `window` minus the output reserve by default, and
 * at 0.8 of it (`DEFAULT_AUTOCOMPACT_SEED_FRACTION`) when `gth init` seeded the threshold —
 * and a first message over that line has nothing to compact, so the turn ends. The content must
 * therefore sit well under 0.8 of the window, leaving the rest for the system prompt (backstory,
 * guidelines, review instructions, path-scoped prompts), the requirements, the answer, and the
 * heuristic's underestimate: code tokenises denser than four bytes a token. Later
 * `gth_gh_read_file` reads are tool results, which compaction CAN fold, so they need no share here.
 * A spec pins this fraction below the seed fraction.
 */
export const DIFF_BUDGET_FRACTION_OF_WINDOW = 0.5;

/**
 * **The window assumed when the model's window is unknown AND the diff route has already failed.**
 *
 * This is deliberately not the `?? DEFAULT` that `contextWindow.ts` forbids. There, a guessed window
 * turns into a confident wrong compaction threshold. Here the only thing it decides is how many
 * files are named rather than shown, and a manifest name is recoverable — the model can fetch the
 * file. It is used only after `gh pr diff` refused the PR; a diff that fetched cleanly against an
 * unknown window is passed through untouched, because nothing can say it is too large. 128k tokens
 * is the floor of the hosted models in common use for review.
 */
export const UNKNOWN_WINDOW_FALLBACK_TOKENS = 128_000;

/** The content budget in bytes for a window of `windowTokens`, or `null` for an unknown window. */
export function diffBudgetBytes(windowTokens: number | null): number | null {
  if (windowTokens === null || !Number.isFinite(windowTokens) || windowTokens <= 0) return null;
  return Math.floor(windowTokens * DIFF_BUDGET_FRACTION_OF_WINDOW * BYTES_PER_TOKEN);
}

/** Whether `filePath` matches one of `patterns`, by `gh pr diff --exclude`'s rule. */
export function matchesElidePattern(filePath: string, patterns: readonly string[]): boolean {
  const base = path.posix.basename(filePath);
  return patterns.some((pattern) => {
    try {
      return path.posix.matchesGlob(filePath, pattern) || path.posix.matchesGlob(base, pattern);
    } catch {
      return false;
    }
  });
}

const C_ESCAPE_OUT: Readonly<Record<number, string>> = {
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0b: '\\v',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
};

function needsQuoting(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f || byte === 0x22 || byte === 0x5c || byte >= 0x80;
}

/**
 * Write a prefixed path (`a/…` or `b/…`) the way git writes it in a `diff --git` header: verbatim
 * when every byte is printable ASCII other than `"` and `\`, otherwise as a C-style quoted string
 * with octal escapes for each UTF-8 byte (git's `core.quotePath=true` default). `diffPaths.ts` reads
 * exactly that form back. `force` quotes a path that would not need it, for the other side of a
 * header whose first side does.
 */
export function quoteDiffPath(prefixedPath: string, force = false): string {
  const bytes = Buffer.from(prefixedPath, 'utf8');
  if (!force && !bytes.some(needsQuoting)) return prefixedPath;
  let out = '"';
  for (const byte of bytes) {
    const single = C_ESCAPE_OUT[byte];
    if (single) out += single;
    else if (needsQuoting(byte)) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

/**
 * The `diff --git` header for an entry. Git quotes both sides when either needs it, and the reader
 * relies on that, so the pair is quoted together.
 */
function diffGitHeader(entry: PrFileEntry): string {
  const left = `a/${entry.previousPath ?? entry.path}`;
  const right = `b/${entry.path}`;
  const quoted = quoteDiffPath(left) !== left || quoteDiffPath(right) !== right;
  const write = (p: string): string => (quoted ? quoteDiffPath(p, true) : p);
  return `diff --git ${write(left)} ${write(right)}`;
}

/** A complete diff block for an entry with a patch: header, rename lines, file lines, hunks. */
/**
 * The entry as it may be rendered: every path and patch byte passed through core's untrusted-text
 * neutraliser, so a large PR gets the same posture as `gh pr diff`, which neutralises terminal
 * escape sequences by default. The bytes are attacker-controlled under `pull_request_target`, and
 * the model's review — which may quote them — is printed, written to the report and posted. Paths
 * use the single-line form (no file name has a legitimate TAB or line break to keep); the patch
 * keeps its TABs, LFs and CRLFs. Applied at render time only, so the listing itself stays exact.
 */
function renderable(entry: PrFileEntry): PrFileEntry {
  const safe: PrFileEntry = { ...entry, path: neutralizeUntrustedText(entry.path) };
  if (entry.previousPath !== undefined)
    safe.previousPath = neutralizeUntrustedText(entry.previousPath);
  if (entry.patch !== undefined) safe.patch = neutralizeUntrustedMultilineText(entry.patch);
  return safe;
}

function fullBlock(raw: PrFileEntry): string {
  const entry = renderable(raw);
  const lines = [diffGitHeader(entry)];
  if (entry.previousPath !== undefined && entry.status === 'renamed') {
    lines.push(`rename from ${quoteDiffPath(entry.previousPath)}`);
    lines.push(`rename to ${quoteDiffPath(entry.path)}`);
  }
  const from =
    entry.status === 'added' ? '/dev/null' : quoteDiffPath(`a/${entry.previousPath ?? entry.path}`);
  const to = entry.status === 'removed' ? '/dev/null' : quoteDiffPath(`b/${entry.path}`);
  lines.push(`--- ${from}`, `+++ ${to}`, entry.patch ?? '');
  return lines.join('\n');
}

/** Why a file is named rather than shown. */
export type ElisionReason = 'removed' | 'no-patch' | 'pattern' | 'budget';

/**
 * The manifest's groups, in the order they are written, each under one heading that says why its
 * files are named only. The reason is stated once per group rather than once per file because the
 * manifest is paid for per file: on a 1105-file PR the names alone are a quarter of a megabyte.
 */
const REASON_ORDER: readonly ElisionReason[] = ['budget', 'pattern', 'no-patch', 'removed'];

const REASON_HEADING: Readonly<Record<ElisionReason, string>> = {
  budget: 'Did not fit the context budget',
  pattern: 'Generated, lockfile or vendored (matches an elision pattern)',
  'no-patch': 'GitHub sent no patch (binary or too large)',
  removed: 'Removed (named only; the review question is whether each should be gone)',
};

/** The two lines a named-only file takes in the manifest: its header and one short note. */
function manifestBlock(raw: PrFileEntry): string {
  const entry = renderable(raw);
  const renamed =
    entry.previousPath !== undefined ? ` from ${quoteDiffPath(entry.previousPath)}` : '';
  return (
    `${diffGitHeader(entry)}\n` +
    `[${entry.status}${renamed}, +${entry.additions} -${entry.deletions}]`
  );
}

export interface TriageOptions {
  /** The budget for the whole assembled content, in bytes. */
  budgetBytes: number;
  /** Patterns named only; {@link DEFAULT_PR_ELIDE_PATTERNS} when omitted. */
  elidePatterns?: readonly string[];
  /** The label after `GitHub PR Diff: `, e.g. `#42`. */
  prLabel: string;
  /** Whether `gth_gh_read_file` is on for this run, which decides the manifest's closing sentence. */
  readFileToolEnabled: boolean;
  /** The PR's file count per `gh pr view`; a shorter listing is called out in the content. */
  changedFiles?: number;
  /** Why the REST route was taken, for the content's first line. */
  route: 'too-many-files' | 'over-budget';
}

export interface ElidedFile {
  entry: PrFileEntry;
  reason: ElisionReason;
}

export interface TriageResult {
  /** The content the model reads. */
  content: string;
  /** Files shown with their patch, in listing order. */
  shown: PrFileEntry[];
  /** Files named only, in listing order. */
  elided: ElidedFile[];
  /** Byte length of `content` (UTF-8). */
  bytes: number;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Assemble a unified diff plus manifest from a REST files listing, fitted to `budgetBytes`.
 *
 * The manifest is never dropped to make room: a path missing from the content would be invisible
 * both to the model and to `prompts.paths`. So when the names alone exceed the budget, the content
 * is still every name — the overrun is the smallest content that keeps every path visible.
 */
export function triagePrFiles(
  entries: readonly PrFileEntry[],
  options: TriageOptions
): TriageResult {
  const patterns = options.elidePatterns ?? DEFAULT_PR_ELIDE_PATTERNS;
  const reasons = new Map<PrFileEntry, ElisionReason>();
  const candidates: PrFileEntry[] = [];

  for (const entry of entries) {
    if (entry.status === 'removed') reasons.set(entry, 'removed');
    else if (entry.patch === undefined || entry.patch.length === 0) reasons.set(entry, 'no-patch');
    else if (matchesElidePattern(entry.path, patterns)) reasons.set(entry, 'pattern');
    else candidates.push(entry);
  }

  // Start from "every candidate named only" and switch candidates to full, smallest first, while
  // the total still fits. The frame (heading, notes, closing sentence) is sized at its widest.
  const frame = renderFrame(options, entries.length, entries.length, entries.length);
  let total = bytesOf(frame);
  for (const entry of entries) {
    total += bytesOf(manifestBlock(entry)) + 1;
  }

  const shownSet = new Set<PrFileEntry>();
  const bySize = [...candidates].sort((a, b) => bytesOf(a.patch ?? '') - bytesOf(b.patch ?? ''));
  for (const entry of bySize) {
    const delta = bytesOf(fullBlock(entry)) - bytesOf(manifestBlock(entry));
    if (total + delta > options.budgetBytes) break;
    total += delta;
    shownSet.add(entry);
  }

  const shown: PrFileEntry[] = [];
  const elided: ElidedFile[] = [];
  for (const entry of entries) {
    if (shownSet.has(entry)) shown.push(entry);
    else elided.push({ entry, reason: reasons.get(entry) ?? 'budget' });
  }

  const [head, manifestHeading, closing] = renderFrameParts(
    options,
    entries.length,
    shown.length,
    elided.length
  );
  const sections = [head];
  if (shown.length > 0) sections.push(shown.map(fullBlock).join('\n'));
  if (elided.length > 0) {
    sections.push(manifestHeading);
    for (const reason of REASON_ORDER) {
      const group = elided.filter((file) => file.reason === reason);
      if (group.length === 0) continue;
      sections.push(
        `${REASON_HEADING[reason]} (${group.length}):\n` +
          group.map(({ entry }) => manifestBlock(entry)).join('\n')
      );
    }
    sections.push(closing);
  }
  const content = sections.join('\n\n');
  return { content, shown, elided, bytes: bytesOf(content) };
}

function renderFrameParts(
  options: TriageOptions,
  listed: number,
  shown: number,
  elided: number
): [string, string, string] {
  const why =
    options.route === 'too-many-files'
      ? 'GitHub would not serve this diff (more than 300 files)'
      : 'the diff does not fit the model context';
  const short =
    options.changedFiles !== undefined && options.changedFiles > listed
      ? ` GitHub reports ${options.changedFiles} changed files but listed only ${listed}; the rest are not shown or named.`
      : '';
  const head =
    `GitHub PR Diff: ${options.prLabel}\n\n` +
    `This pull request is large: ${why}, so it was assembled from the GitHub files listing. ` +
    `${listed} files changed: ${shown} shown in full, ${elided} named only in the list at the end.${short}`;
  const manifestHeading = `Files not shown in full (${elided}):`;
  const closing = options.readFileToolEnabled
    ? 'Any file named above that still exists at the PR head can be read in full with the gth_gh_read_file tool; removed files cannot, and need only their names.'
    : 'These files are named only; judge the pull request on what is shown and on these names.';
  return [head, manifestHeading, closing];
}

function renderFrame(
  options: TriageOptions,
  listed: number,
  shown: number,
  elided: number
): string {
  // Every group heading at its widest count, plus the separators between sections.
  const groups = REASON_ORDER.map((reason) => `${REASON_HEADING[reason]} (${listed}):\n\n\n`);
  return (
    renderFrameParts(options, listed, shown, elided).join('\n\n') + groups.join('') + '\n\n\n\n'
  );
}
