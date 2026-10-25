import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

/**
 * REL-21 — the `github` content source on a PR that `gh pr diff` cannot serve (HTTP 406) or that
 * does not fit the budget. `execAsync` is the only boundary: each spec scripts the exact `gh`
 * commands the source runs and what they print.
 */
const execAsyncMock = vi.fn();
const displayWarningMock = vi.fn();

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayWarning: displayWarningMock,
}));
vi.mock('@gaunt-sloth/core/utils/ProgressIndicator.js', () => {
  const ProgressIndicator = vi.fn();
  ProgressIndicator.prototype.stop = vi.fn();
  return { ProgressIndicator };
});

const read = (name: string): string =>
  readFileSync(new URL(`./fixtures/rel21/${name}`, import.meta.url), 'utf8');

/** The rejection `execAsync` produced for `gh pr diff` on microsoft/TypeScript#64122, verbatim. */
const MEASURED_406 =
  'Command failed: gh pr diff 64122\n' +
  "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (https://api.github.com/repos/microsoft/TypeScript/pulls/64122)\n" +
  'PullRequest.diff too_large\n';

const VIEW_COMMAND = 'gh pr view 64122 --json number,url,changedFiles';
const LIST_COMMAND =
  "gh api 'repos/microsoft/TypeScript/pulls/64122/files?per_page=100' --paginate --jq '.[]'";
// The head of #64122 is a fork; the files endpoint must be addressed on the base repository.
const VIEW_OUTPUT = JSON.stringify({
  number: 64122,
  url: 'https://github.com/microsoft/TypeScript/pull/64122',
  changedFiles: 45,
});

function scriptGh(responses: Record<string, string | Error>): void {
  execAsyncMock.mockImplementation(async (command: string) => {
    const response = responses[command];
    if (response === undefined) throw new Error(`unexpected command: ${command}`);
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('ghPrDiffSource — large PRs (REL-21)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('recognises the measured 406 and nothing else', async () => {
    const { isDiffTooLargeError } = await import('#src/sources/ghPrDiffSource.js');
    expect(isDiffTooLargeError(MEASURED_406)).toBe(true);
    expect(isDiffTooLargeError('HTTP 404: Not Found')).toBe(false);
    expect(isDiffTooLargeError('HTTP 406: Not Acceptable')).toBe(false);
  });

  it('keeps a small PR byte-identical and never touches REST', async () => {
    const diff = read('small-pr.diff').trim();
    scriptGh({ 'gh pr diff 7': diff });
    const { get } = await import('#src/sources/ghPrDiffSource.js');

    const expected = `GitHub PR Diff: #7\n\n${diff}`;
    expect(await get(null, '7')).toBe(expected);
    expect(await get(null, '7', { budgetBytes: 1_000_000 })).toBe(expected);
    expect(await get(null, '7', { budgetBytes: null })).toBe(expected);
    expect(execAsyncMock.mock.calls.map((c) => c[0])).toEqual([
      'gh pr diff 7',
      'gh pr diff 7',
      'gh pr diff 7',
    ]);
  });

  it('falls back to the files listing on the 406, bound to the base repository', async () => {
    scriptGh({
      'gh pr diff 64122': new Error(MEASURED_406),
      [VIEW_COMMAND]: VIEW_OUTPUT,
      [LIST_COMMAND]: read('mass-removal.files.ndjson'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');

    const content = await get(null, '64122', { budgetBytes: 1_000_000 });

    expect(execAsyncMock.mock.calls.map((c) => c[0])).toEqual([
      'gh pr diff 64122',
      VIEW_COMMAND,
      LIST_COMMAND,
    ]);
    expect(content).toMatch(
      /^GitHub PR Diff: #64122\n\nThis pull request is large: GitHub would not serve/
    );
    expect(content).toContain('Files not shown in full (42):');
    expect(displayWarningMock).toHaveBeenCalledWith(expect.stringContaining('42 named only'));
  });

  it('uses the fallback budget after a 406 when no window is known', async () => {
    scriptGh({
      'gh pr diff 64122': new Error(MEASURED_406),
      [VIEW_COMMAND]: VIEW_OUTPUT,
      [LIST_COMMAND]: read('mass-addition.files.ndjson'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');
    const content = await get(null, '64122');
    // 128k tokens at half the window is far above this small fixture: everything that may be
    // shown is shown, and only the pattern match is named.
    expect(content).toContain('Files not shown in full (1):');
  });

  it('triages a diff that fetched but is over the budget', async () => {
    scriptGh({
      'gh pr diff 64122': 'x'.repeat(20_000),
      [VIEW_COMMAND]: VIEW_OUTPUT,
      [LIST_COMMAND]: read('mass-addition.files.ndjson'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');

    const content = (await get(null, '64122', { budgetBytes: 6_000 })) ?? '';

    expect(content).toContain('the diff does not fit the model context');
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(6_000);
  });

  it('reviews an over-budget diff whole when the listing cannot be fetched', async () => {
    scriptGh({
      'gh pr diff 64122': 'whole diff',
      [VIEW_COMMAND]: new Error('gh: HTTP 502'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');

    expect(await get(null, '64122', { budgetBytes: 5 })).toBe(
      'GitHub PR Diff: #64122\n\nwhole diff'
    );
    expect(displayWarningMock).toHaveBeenCalledWith(
      expect.stringContaining('could not be triaged')
    );
  });

  it('reads the elision list from commands.pr', async () => {
    scriptGh({
      'gh pr diff 64122': new Error(MEASURED_406),
      [VIEW_COMMAND]: VIEW_OUTPUT,
      [LIST_COMMAND]: read('mass-removal.files.ndjson'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');
    const config = { commands: { pr: { elidePatterns: [] } } } as unknown as GthConfig;

    const content = (await get(null, '64122', { config, budgetBytes: 1_000_000 })) ?? '';

    expect(content).toContain('Files not shown in full (41):');
    expect(content).toContain('+++ b/pnpm-lock.yaml');
  });

  it('resolves the PR number through gh pr view in discovery mode', async () => {
    scriptGh({
      'gh pr diff': new Error(MEASURED_406),
      'gh pr view --json number,url,changedFiles': VIEW_OUTPUT,
      [LIST_COMMAND]: read('mass-removal.files.ndjson'),
    });
    const { get } = await import('#src/sources/ghPrDiffSource.js');
    const content = await get(null, undefined, { budgetBytes: 1_000_000 });
    expect(content).toMatch(/^GitHub PR Diff: for current branch\n\n/);
  });

  it('keeps the existing error for any other gh failure', async () => {
    scriptGh({ 'gh pr diff 9': new Error('gh: HTTP 404') });
    const { get } = await import('#src/sources/ghPrDiffSource.js');
    await expect(get(null, '9')).rejects.toThrow(
      'Failed to get GitHub PR diff #9: gh: HTTP 404\nConsider checking if gh cli'
    );
  });
});
