import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOCOMPACT_SEED_FRACTION } from '@gaunt-sloth/core/core/compactionThreshold.js';
import { extractChangedPathsFromDiff } from '#src/utils/diffPaths.js';
import { parsePrFilesListing, type PrFileEntry } from '#src/utils/prFilesListing.js';
import {
  BYTES_PER_TOKEN,
  DEFAULT_PR_ELIDE_PATTERNS,
  DIFF_BUDGET_FRACTION_OF_WINDOW,
  diffBudgetBytes,
  matchesElidePattern,
  quoteDiffPath,
  triagePrFiles,
  type TriageOptions,
} from '#src/utils/prDiffTriage.js';

/**
 * REL-21 — the triage that fits a REST files listing into one review turn. The fixtures under
 * `fixtures/rel21/` are small synthetic listings in the `gh api --paginate --jq '.[]'` shape.
 */
const fixture = (name: string): PrFileEntry[] =>
  parsePrFilesListing(readFileSync(new URL(`./fixtures/rel21/${name}`, import.meta.url), 'utf8'));

const options = (overrides: Partial<TriageOptions> = {}): TriageOptions => ({
  budgetBytes: 1_000_000,
  prLabel: '#7',
  readFileToolEnabled: true,
  route: 'too-many-files',
  ...overrides,
});

/** The acceptance spec: no path in the listing is absent from both the diff and the manifest. */
function expectEveryListedPathVisible(entries: PrFileEntry[], content: string): void {
  const seen = new Set(extractChangedPathsFromDiff(content));
  const missing = entries
    .flatMap((entry) => [entry.path, ...(entry.previousPath ? [entry.previousPath] : [])])
    .filter((p) => !seen.has(p));
  expect(missing).toEqual([]);
}

describe('REL-21 budget heuristic', () => {
  it('is four bytes a token over half the window', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(DIFF_BUDGET_FRACTION_OF_WINDOW).toBe(0.5);
    expect(diffBudgetBytes(200_000)).toBe(400_000);
  });

  it('sits below the autocompact seed, so a first message never lands past the guard', () => {
    expect(DIFF_BUDGET_FRACTION_OF_WINDOW).toBeLessThan(DEFAULT_AUTOCOMPACT_SEED_FRACTION);
  });

  it('answers null for an unknown window rather than guessing', () => {
    expect(diffBudgetBytes(null)).toBeNull();
    expect(diffBudgetBytes(0)).toBeNull();
    expect(diffBudgetBytes(Number.NaN)).toBeNull();
  });
});

describe('REL-21 elision patterns (gh pr diff --exclude semantics)', () => {
  it('matches a bare pattern by base name at any depth', () => {
    expect(matchesElidePattern('pnpm-lock.yaml', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
    expect(matchesElidePattern('apps/web/package-lock.json', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
    expect(matchesElidePattern('a/b/c/bundle.min.js', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
    expect(matchesElidePattern('a/b/c/index.js.map', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
  });

  it('anchors a pattern with a separator at the root', () => {
    expect(matchesElidePattern('dist/index.js', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
    expect(matchesElidePattern('vendor/x/y/z.go', DEFAULT_PR_ELIDE_PATTERNS)).toBe(true);
    expect(matchesElidePattern('packages/core/dist/index.js', DEFAULT_PR_ELIDE_PATTERNS)).toBe(
      false
    );
  });

  it('leaves ordinary source alone', () => {
    expect(matchesElidePattern('src/index.ts', DEFAULT_PR_ELIDE_PATTERNS)).toBe(false);
    expect(matchesElidePattern('src/lockfile.ts', DEFAULT_PR_ELIDE_PATTERNS)).toBe(false);
  });
});

describe('REL-21 mass-removal listing', () => {
  const entries = fixture('mass-removal.files.ndjson');
  const result = triagePrFiles(entries, options());

  it('names every removed file and shows none of their hunks', () => {
    const removed = entries.filter((e) => e.status === 'removed');
    expect(removed).toHaveLength(40);
    expect(result.elided.filter((e) => e.reason === 'removed')).toHaveLength(40);
    // Each removed patch is a run of `-x<n>` lines; not one of them reaches the content.
    expect(result.content).not.toMatch(/^-x\d+$/m);
    for (const entry of removed) {
      expect(result.content).toContain(
        `diff --git a/${entry.path} b/${entry.path}\n[not shown: removed, +0 -${entry.deletions}; removed files are named only]`
      );
    }
  });

  it('reviews what remains, and names the lockfile and the binary', () => {
    expect(result.shown.map((e) => e.path)).toEqual(['src/app.ts', 'src/routes.ts', 'README.md']);
    expect(result.content).toContain('+new src/app.ts');
    const reasons = Object.fromEntries(result.elided.map((e) => [e.entry.path, e.reason]));
    expect(reasons['pnpm-lock.yaml']).toBe('pattern');
    expect(reasons['assets/logo.png']).toBe('no-patch');
    expect(result.content).toContain(
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n[not shown: modified, +400 -380; matches an elision pattern'
    );
  });

  it('keeps every listed path visible', () => {
    expectEveryListedPathVisible(entries, result.content);
  });
});

describe('REL-21 mass-addition listing over a small budget', () => {
  const entries = fixture('mass-addition.files.ndjson');
  const budgetBytes = 6_000;
  const result = triagePrFiles(entries, options({ budgetBytes }));
  const patchBytes = (e: PrFileEntry) => Buffer.byteLength(e.patch ?? '', 'utf8');

  it('fills the budget and stays within it', () => {
    expect(result.shown.length).toBeGreaterThan(0);
    expect(result.elided.some((e) => e.reason === 'budget')).toBe(true);
    expect(result.bytes).toBe(Buffer.byteLength(result.content, 'utf8'));
    expect(result.bytes).toBeLessThanOrEqual(budgetBytes);
  });

  it('puts the smallest in and names the largest', () => {
    const largestShown = Math.max(...result.shown.map(patchBytes));
    const smallestBudgetElided = Math.min(
      ...result.elided.filter((e) => e.reason === 'budget').map((e) => patchBytes(e.entry))
    );
    expect(largestShown).toBeLessThanOrEqual(smallestBudgetElided);
  });

  it('names the minified bundle by pattern, not by budget', () => {
    const bundle = result.elided.find((e) => e.entry.path.endsWith('bundle.min.js'));
    expect(bundle?.reason).toBe('pattern');
  });

  it('names every elided file with status and counts', () => {
    for (const { entry } of result.elided) {
      expect(result.content).toContain(
        `[not shown: ${entry.status}, +${entry.additions} -${entry.deletions};`
      );
    }
    expect(result.content).toContain(`Files not shown in full (${result.elided.length}):`);
  });

  it('keeps every listed path visible', () => {
    expectEveryListedPathVisible(entries, result.content);
  });

  it('still names every path when the names alone exceed the budget', () => {
    const tiny = triagePrFiles(entries, options({ budgetBytes: 10 }));
    expect(tiny.shown).toEqual([]);
    expectEveryListedPathVisible(entries, tiny.content);
  });
});

describe('REL-21 assembled headers round-trip through extractChangedPathsFromDiff', () => {
  const entries = fixture('awkward-paths.files.ndjson');
  const result = triagePrFiles(entries, options());

  it('recovers every path and previous path, quoting included', () => {
    expectEveryListedPathVisible(entries, result.content);
  });

  it('writes a hostile newline in a path as an escape, never as a line of its own', () => {
    expect(result.content).toContain('"a/src/new\\nline.ts"');
    expect(result.content.split('\n')).not.toContain('line.ts b/src/new');
  });

  it('quotes by git’s rules', () => {
    expect(quoteDiffPath('a/plain/path.ts')).toBe('a/plain/path.ts');
    expect(quoteDiffPath('a/with space.ts')).toBe('a/with space.ts');
    expect(quoteDiffPath('a/café')).toBe('"a/caf\\303\\251"');
    expect(quoteDiffPath('a/q"b\\c\td')).toBe('"a/q\\"b\\\\c\\td"');
    expect(quoteDiffPath('a/plain.ts', true)).toBe('"a/plain.ts"');
  });

  it('writes rename lines from the previous path', () => {
    expect(result.content).toContain(
      'diff --git a/src/old/source.ts b/src/renamed/target.ts\n[not shown: renamed, from src/old/source.ts, +0 -0;'
    );
  });
});

describe('REL-21 manifest closing sentence', () => {
  const entries = fixture('mass-removal.files.ndjson');

  it('points at gth_gh_read_file when the tool is on', () => {
    expect(triagePrFiles(entries, options()).content).toMatch(/gth_gh_read_file/);
  });

  it('does not promise the tool when it is off', () => {
    expect(triagePrFiles(entries, options({ readFileToolEnabled: false })).content).not.toMatch(
      /gth_gh_read_file/
    );
  });

  it('says so when the listing is shorter than the PR', () => {
    expect(triagePrFiles(entries, options({ changedFiles: 4000 })).content).toContain(
      `GitHub reports 4000 changed files but listed only ${entries.length}`
    );
  });

  it('honours a replaced elision list', () => {
    const result = triagePrFiles(entries, options({ elidePatterns: [] }));
    expect(result.shown.map((e) => e.path)).toContain('pnpm-lock.yaml');
  });
});

describe('REL-21 listing parser', () => {
  const row = (filename: string) => ({ filename, status: 'added', additions: 1, deletions: 0 });

  it('reads one object per line', () => {
    const raw = [row('a'), row('b')].map((r) => JSON.stringify(r)).join('\n');
    expect(parsePrFilesListing(raw).map((e) => e.path)).toEqual(['a', 'b']);
  });

  it('reads a merged array and pages emitted back to back', () => {
    expect(parsePrFilesListing(JSON.stringify([row('a'), row('b')])).map((e) => e.path)).toEqual([
      'a',
      'b',
    ]);
    const pages = JSON.stringify([row('a')]) + JSON.stringify([row('b')]);
    expect(parsePrFilesListing(pages).map((e) => e.path)).toEqual(['a', 'b']);
  });

  it('does not cut a patch that contains the page separator', () => {
    const tricky = { ...row('a'), patch: '@@ -1 +1 @@\n+x = y][z;' };
    const pages = JSON.stringify([tricky]) + JSON.stringify([row('b')]);
    const parsed = parsePrFilesListing(pages);
    expect(parsed.map((e) => e.path)).toEqual(['a', 'b']);
    expect(parsed[0].patch).toBe(tricky.patch);
  });

  it('coerces counts and status before they reach text the model reads', () => {
    const [entry] = parsePrFilesListing(
      JSON.stringify({ filename: 'x', status: 'evil\n', additions: '9', deletions: -1 })
    );
    expect(entry).toEqual({ path: 'x', status: 'modified', additions: 0, deletions: 0 });
  });
});
