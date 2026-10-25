import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { PrBaseBinding, PrFileEntry } from '#src/utils/prFilesListing.js';

/**
 * REL-6 — the per-file diff tool. `execAsync` is mocked so any `gh` call is visible: the tool must
 * serve from the listing it was handed, and fetch the listing (once) only when it was handed none.
 */
const execAsyncMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
}));

const BINDING: PrBaseBinding = {
  host: 'github.com',
  owner: 'microsoft',
  repo: 'TypeScript',
  number: '64122',
};

/** The path `gth_gh_read_file` rejected in REL-21's live run on microsoft/TypeScript#64122. */
const PAREN_PATH = 'tests/baselines/reference/typeAliasDeclarationEmit2(target=es2015).js';

const ENTRIES: PrFileEntry[] = [
  {
    path: 'src/compiler/checker.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+newer',
  },
  {
    path: PAREN_PATH,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+export {};',
  },
  {
    path: 'src/services/utilities.ts',
    status: 'modified',
    additions: 1,
    deletions: 1,
    // An attacker-controlled patch: a screen clear, a bidi override and a lone CR.
    patch: '@@ -1 +1 @@\n-a\n+b \u001b[2J‮\rOK\t\r\nend',
  },
  { path: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
  { path: 'gone/old.bin', status: 'removed', additions: 0, deletions: 0 },
  {
    path: 'src/compiler/renamed.ts',
    previousPath: 'src/compiler/original.ts',
    status: 'renamed',
    additions: 1,
    deletions: 1,
    patch: '@@ -1 +1 @@\n-x\n+y',
  },
  ...Array.from({ length: 20 }, (_, i) => ({
    path: `tests/cases/compiler/case${i}/checker.ts`,
    status: 'added' as const,
    additions: 1,
    deletions: 0,
    patch: '@@ -0,0 +1 @@\n+x',
  })),
];

describe('gth_gh_read_file_diff (REL-6)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('readFileDiffFromListing', () => {
    it('returns a listed file’s patch under its status and counts', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ path: 'src/compiler/checker.ts' }, ENTRIES);
      expect(out).toBe(
        'Diff of src/compiler/checker.ts: modified, +2 -1\n\n' +
          '@@ -1,2 +1,3 @@\n context\n-old\n+new\n+newer'
      );
    });

    it('serves a path with parentheses, which gth_gh_read_file refuses', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const { ghReadFileImpl } = await import('#src/tools/ghReadFileTool.js');
      expect(readFileDiffFromListing({ path: PAREN_PATH }, ENTRIES)).toBe(
        `Diff of ${PAREN_PATH}: added, +1 -0\n\n@@ -0,0 +1 @@\n+export {};`
      );
      // The control: the whole-file tool still refuses the same path, and runs nothing.
      expect(await ghReadFileImpl({ path: PAREN_PATH }, { owner: 'o', repo: 'r' })).toMatch(
        /^Invalid file path/
      );
      expect(execAsyncMock).not.toHaveBeenCalled();
    });

    it('escapes escape bytes in a patch and keeps its tabs and line breaks', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ path: 'src/services/utilities.ts' }, ENTRIES);
      expect(out).not.toMatch(/[\u001b‮]/);
      expect(out).toContain('+b \\x1b[2J\\u202e\\x0dOK\t\r\nend');
    });

    it('caps the patch at maxBytes with an explicit INCOMPLETE marker', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const big: PrFileEntry = {
        path: 'big.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+' + 'é'.repeat(1000),
      };
      const out = readFileDiffFromListing({ path: 'big.ts' }, [big], 400);
      // The cap is the WHOLE answer's, heading and marker included: the guard counts all of it.
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(400);
      const [heading, rest] = out.split('\n\n');
      expect(heading).toBe('Partial diff of big.ts: modified, +1 -0 (truncated)');
      const body = rest.slice(0, rest.indexOf('\n... ['));
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain('�');
      expect(out).toContain(
        "[gth_gh_read_file_diff: this diff was cut to 400 bytes to fit this model's context " +
          'window beside the rest of the review — it is INCOMPLETE'
      );
      // The marker points at the whole-file tool only when the run has it.
      expect(out).toContain('gth_gh_read_file reads the whole file');
      expect(readFileDiffFromListing({ path: 'big.ts' }, [big], 400, false)).not.toContain(
        'gth_gh_read_file reads'
      );
      // Under the cap, no marker.
      expect(readFileDiffFromListing({ path: 'big.ts' }, [big], 10_000)).not.toContain(
        'INCOMPLETE'
      );
    });

    it('counts the cap on the neutralised bytes the model receives', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const hostile: PrFileEntry = {
        path: 'h.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '\u001b'.repeat(200),
      };
      // 200 raw bytes would fit 600; 800 once each ESC is written as `\x1b` do not.
      const out = readFileDiffFromListing({ path: 'h.ts' }, [hostile], 600);
      expect(out).toContain('INCOMPLETE');
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(600);
      expect(out).not.toContain('\\x1b'.repeat(150));
    });

    it('answers an unlisted path with close matches and the listing size', async () => {
      const { readFileDiffFromListing, MAX_PATH_SUGGESTIONS } =
        await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ path: 'compiler/checker.ts' }, ENTRIES);
      expect(out).toMatch(
        new RegExp(`^"compiler/checker.ts" is not one of the ${ENTRIES.length} files`)
      );
      expect(out).toContain('"src/compiler/checker.ts"');
      // Bounded, however many rows share the base name.
      const suggested = out.match(/"[^"]+checker\.ts"/g) ?? [];
      expect(suggested.length - 1).toBe(MAX_PATH_SUGGESTIONS);
    });

    it('says so when nothing is close', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      expect(readFileDiffFromListing({ path: 'nowhere/zzz.qq' }, ENTRIES)).toContain(
        'No listed path is close to it.'
      );
    });

    it('neutralises and bounds a hostile path echoed in the error', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ path: `\u001b[2J${'a'.repeat(5000)}\n` }, ENTRIES);
      expect(out).not.toMatch(/[\u001b\n]/);
      expect(out.length).toBeLessThan(1000);
    });

    it('says a listed file has no patch and points at gth_gh_read_file', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ path: 'assets/logo.png' }, ENTRIES);
      expect(out).toMatch(/^No diff for assets\/logo.png: modified, \+0 -0\./);
      expect(out).toContain('binary');
      expect(out).toContain('too large for GitHub to render');
      expect(out).toContain('rename with no content change');
      expect(out).toContain('with gth_gh_read_file if you need its contents');
      // Not pointed at a tool the run does not have.
      expect(
        readFileDiffFromListing({ path: 'assets/logo.png' }, ENTRIES, 1000, false)
      ).not.toContain('gth_gh_read_file');
      // A removed file has nothing at the head to read.
      expect(readFileDiffFromListing({ path: 'gone/old.bin' }, ENTRIES)).toContain(
        'It was removed'
      );
    });

    it('serves a renamed file by its previous path and says what it is now', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      expect(readFileDiffFromListing({ path: 'src/compiler/original.ts' }, ENTRIES)).toBe(
        'Diff of src/compiler/renamed.ts (you asked for its previous path; it is now ' +
          'src/compiler/renamed.ts): renamed from src/compiler/original.ts, +1 -1\n\n' +
          '@@ -1 +1 @@\n-x\n+y'
      );
    });
  });

  describe('listing query', () => {
    it('lists the files a glob matches, with status and counts, and the total', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ pattern: 'src/compiler/*.ts' }, ENTRIES);
      expect(out.split('\n')[0]).toBe(
        `2 of the ${ENTRIES.length} files this pull request changes match "src/compiler/*.ts":`
      );
      expect(out).toContain('src/compiler/checker.ts: modified, +2 -1');
      expect(out).toContain(
        'src/compiler/renamed.ts: renamed from src/compiler/original.ts, +1 -1'
      );
      // A one-segment star does not cross a directory.
      expect(out).not.toContain('tests/cases');
      expect(out).not.toContain('@@');
    });

    it('treats a pattern without glob characters as a directory prefix', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const out = readFileDiffFromListing({ pattern: 'src/compiler' }, ENTRIES);
      expect(out).toMatch(/^2 of the/);
      // A prefix is a whole directory, not a string prefix of a sibling's name.
      expect(readFileDiffFromListing({ pattern: 'src/comp' }, ENTRIES)).toMatch(/^None of the/);
    });

    it('matches a slash-free glob against base names, and lists everything with no arguments', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      expect(readFileDiffFromListing({ pattern: '*.png' }, ENTRIES)).toContain(
        'assets/logo.png: modified, +0 -0'
      );
      expect(readFileDiffFromListing({}, ENTRIES).split('\n')[0]).toBe(
        `${ENTRIES.length} of the ${ENTRIES.length} files this pull request changes are listed:`
      );
    });

    it('returns at most 50 names, and says how many more matched', async () => {
      const { readFileDiffFromListing, MAX_LISTED_PATHS } =
        await import('#src/tools/ghReadFileDiffTool.js');
      const many: PrFileEntry[] = Array.from({ length: 120 }, (_, i) => ({
        path: `pkg/f${i}.ts`,
        status: 'added',
        additions: 1,
        deletions: 0,
      }));
      const out = readFileDiffFromListing({ pattern: 'pkg/' }, many);
      expect(MAX_LISTED_PATHS).toBe(50);
      expect(out.split('\n')[0]).toBe(
        '120 of the 120 files this pull request changes match "pkg/"; the first 50 are:'
      );
      expect(out.match(/^pkg\/f\d+\.ts: /gm)).toHaveLength(50);
      expect(out).toContain('70 more matched and are not shown; narrow the pattern to see them.');
    });

    it('drops names, never the count, to fit the cap', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const many: PrFileEntry[] = Array.from({ length: 60 }, (_, i) => ({
        path: `pkg/${'deep/'.repeat(10)}f${i}.ts`,
        status: 'added',
        additions: 1,
        deletions: 0,
      }));
      const out = readFileDiffFromListing({ pattern: 'pkg/**' }, many, 1000);
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(1000);
      expect(out).toMatch(/^60 of the 60 files .*; the first \d+ are:/);
      expect(out).toMatch(/\n\d+ more matched and are not shown/);
    });

    it('neutralises listed paths and refuses an over-long pattern', async () => {
      const { readFileDiffFromListing, MAX_PATTERN_CHARACTERS } =
        await import('#src/tools/ghReadFileDiffTool.js');
      const hostile: PrFileEntry[] = [
        { path: 'src/\u001b[2Jx.ts', status: 'added', additions: 1, deletions: 0 },
      ];
      const out = readFileDiffFromListing({ pattern: 'src/' }, hostile);
      expect(out).not.toContain('\u001b');
      expect(out).toContain('src/\\x1b[2Jx.ts');
      expect(
        readFileDiffFromListing({ pattern: 'a'.repeat(MAX_PATTERN_CHARACTERS + 1) }, ENTRIES)
      ).toMatch(/^That pattern is \d+ characters long/);
    });

    it('answers a pathological glob in bounded time', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      const rows: PrFileEntry[] = [
        { path: `pkg/${'a'.repeat(255)}/x.ts`, status: 'added', additions: 1, deletions: 0 },
      ];
      const started = Date.now();
      readFileDiffFromListing({ pattern: 'pkg/a*a*a*a*a*a*a*a*b/x.ts' }, rows);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it('prefers path when both are given', async () => {
      const { readFileDiffFromListing } = await import('#src/tools/ghReadFileDiffTool.js');
      expect(
        readFileDiffFromListing({ path: 'src/compiler/checker.ts', pattern: '*.png' }, ENTRIES)
      ).toMatch(/^Diff of src\/compiler\/checker.ts/);
    });
  });

  describe('get', () => {
    it('serves from the listing it was handed and runs nothing', async () => {
      const { get } = await import('#src/tools/ghReadFileDiffTool.js');
      const tool = get({} as GthConfig, { binding: BINDING, entries: ENTRIES });
      expect(tool.name).toBe('gth_gh_read_file_diff');
      expect(await tool.invoke({ path: PAREN_PATH })).toContain('+export {};');
      expect(execAsyncMock).not.toHaveBeenCalled();
    });

    it('fetches the listing once, on first use, when handed none', async () => {
      execAsyncMock.mockResolvedValue(
        ENTRIES.map((e) =>
          JSON.stringify({
            filename: e.path,
            previous_filename: e.previousPath,
            status: e.status,
            additions: e.additions,
            deletions: e.deletions,
            patch: e.patch,
          })
        ).join('\n')
      );
      const { get } = await import('#src/tools/ghReadFileDiffTool.js');
      const tool = get({} as GthConfig, { binding: BINDING });
      expect(execAsyncMock).not.toHaveBeenCalled();
      expect(await tool.invoke({ path: 'src/compiler/checker.ts' })).toContain('+newer');
      expect(await tool.invoke({ path: PAREN_PATH })).toContain('+export {};');
      expect(execAsyncMock).toHaveBeenCalledTimes(1);
      expect(execAsyncMock.mock.calls[0][0]).toBe(
        'gh api --hostname github.com "repos/microsoft/TypeScript/pulls/64122/files?per_page=100" --paginate --jq ".[]"'
      );
    });

    it('keeps each instance’s memo to itself', async () => {
      execAsyncMock
        .mockResolvedValueOnce(JSON.stringify({ filename: 'a.ts', status: 'added', patch: '+A' }))
        .mockResolvedValueOnce(JSON.stringify({ filename: 'b.ts', status: 'added', patch: '+B' }));
      const { get } = await import('#src/tools/ghReadFileDiffTool.js');
      const first = get({} as GthConfig, { binding: BINDING });
      const second = get({} as GthConfig, { binding: { ...BINDING, number: '1' } });
      expect(await first.invoke({ path: 'a.ts' })).toContain('+A');
      expect(await second.invoke({ path: 'a.ts' })).toMatch(/is not one of the 1 files/);
      expect(await second.invoke({ path: 'b.ts' })).toContain('+B');
      expect(execAsyncMock).toHaveBeenCalledTimes(2);
    });

    it('returns an explanation when the listing cannot be fetched', async () => {
      execAsyncMock.mockRejectedValue(new Error('gh: HTTP 502'));
      const { get } = await import('#src/tools/ghReadFileDiffTool.js');
      const tool = get({} as GthConfig, { binding: BINDING });
      expect(await tool.invoke({ path: 'a.ts' })).toMatch(
        /^Could not fetch the pull request's files listing: gh: HTTP 502/
      );
    });

    it('reads its cap from its own builtInTools entry, per command', async () => {
      const { get } = await import('#src/tools/ghReadFileDiffTool.js');
      const config = {
        builtInTools: { gth_gh_read_file: { maxBytes: 999_999 } },
        commands: { review: { builtInTools: { gth_gh_read_file_diff: { maxBytes: 300 } } } },
      } as unknown as GthConfig;
      const big = [{ ...ENTRIES[0], patch: '@@ -1 +1 @@\n+' + 'x'.repeat(5000) }];
      const asReview = get(config, { binding: BINDING, entries: big }, 'review');
      const asPr = get(config, { binding: BINDING, entries: big }, 'pr', true);
      expect(await asReview.invoke({ path: 'src/compiler/checker.ts' })).toContain(
        'cut to 300 bytes'
      );
      expect(asReview.description).toContain('At most 300 bytes');
      // The read-file tool's cap is not this tool's cap: pr has the 100 KiB default, and with no
      // budget handed over the window share of the unknown-window fallback budget is smaller.
      expect(asPr.description).toContain('At most 16000 bytes');
    });

    it('caps each answer at the smaller of maxBytes and the window share of the run budget', async () => {
      const { get, effectiveDiffReadCapBytes, READ_SHARE_OF_DIFF_BUDGET } =
        await import('#src/tools/ghReadFileDiffTool.js');
      const { diffBudgetBytes } = await import('#src/utils/prDiffTriage.js');
      const budget = diffBudgetBytes(32_768)!;
      const share = Math.floor(budget * READ_SHARE_OF_DIFF_BUDGET);
      expect(effectiveDiffReadCapBytes(102_400, budget)).toBe(share);
      expect(effectiveDiffReadCapBytes(100, budget)).toBe(100);
      // A 1M window's share is above the configured cap, which then governs.
      expect(effectiveDiffReadCapBytes(102_400, diffBudgetBytes(1_000_000)!)).toBe(102_400);

      const big = [{ ...ENTRIES[0], patch: '@@ -1 +1 @@\n+' + 'x'.repeat(50_000) }];
      const bound = get({} as GthConfig, { binding: BINDING, entries: big, budgetBytes: budget });
      const out = await bound.invoke({ path: 'src/compiler/checker.ts' });
      expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(share);
      expect(out).toContain(`cut to ${share} bytes`);
    });
  });
});
