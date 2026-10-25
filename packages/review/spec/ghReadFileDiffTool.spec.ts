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
        patch: '@@ -1 +1 @@\n+' + 'é'.repeat(100),
      };
      const out = readFileDiffFromListing({ path: 'big.ts' }, [big], 51);
      const [heading, rest] = out.split('\n\n');
      expect(heading).toBe('Partial diff of big.ts: modified, +1 -0 (truncated)');
      const body = rest.slice(0, rest.indexOf('\n... ['));
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(51);
      expect(body).not.toContain('�');
      expect(out).toContain(
        '[gth_gh_read_file_diff: diff truncated at the 51-byte cap ' +
          '(builtInTools.gth_gh_read_file_diff.maxBytes) — this diff is INCOMPLETE'
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
        patch: '\u001b'.repeat(20),
      };
      // 20 raw bytes, 80 once each ESC is written as `\x1b`.
      const out = readFileDiffFromListing({ path: 'h.ts' }, [hostile], 40);
      expect(out).toContain('INCOMPLETE');
      expect(out).toContain('\\x1b'.repeat(10));
      expect(out).not.toContain('\\x1b'.repeat(11));
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
        commands: { review: { builtInTools: { gth_gh_read_file_diff: { maxBytes: 10 } } } },
      } as unknown as GthConfig;
      const asReview = get(config, { binding: BINDING, entries: ENTRIES }, 'review');
      const asPr = get(config, { binding: BINDING, entries: ENTRIES }, 'pr');
      expect(await asReview.invoke({ path: 'src/compiler/checker.ts' })).toContain(
        'the 10-byte cap'
      );
      // The read-file tool's cap is not this tool's cap: pr falls back to the 100 KiB default.
      expect(asPr.description).toContain('At most 102400 bytes');
    });
  });
});
