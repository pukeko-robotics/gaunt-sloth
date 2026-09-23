import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (_error: Error | null, _stdout: string, _stderr: string) => void;

const execFileMock = vi.fn();
const progressIndicatorStopMock = vi.fn();
const displayWarningMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayWarning: displayWarningMock,
}));
vi.mock('@gaunt-sloth/core/utils/ProgressIndicator.js', () => {
  const ProgressIndicator = vi.fn();
  ProgressIndicator.prototype.stop = progressIndicatorStopMock;
  return { ProgressIndicator };
});

function mockGitResult(error: Error | null, stdout: string, stderr: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: ExecFileCallback) => {
      cb(error, stdout, stderr);
    }
  );
}

describe('gitDiffSource', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('gets the working tree diff when no ref range is provided', async () => {
    mockGitResult(null, 'diff body', '');

    const { get } = await import('#src/sources/gitDiffSource.js');
    const result = await get(null, undefined);

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['--no-pager', 'diff'],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );
    expect(result).toBe('Local git diff for the working tree\n\ndiff body');
  });

  it('passes a ref range through to git diff as a single argument', async () => {
    mockGitResult(null, 'range diff body', '');

    const { get } = await import('#src/sources/gitDiffSource.js');
    const result = await get(null, 'origin/main...HEAD');

    expect(execFileMock).toHaveBeenCalledWith(
      'git',
      ['--no-pager', 'diff', 'origin/main...HEAD'],
      expect.objectContaining({ maxBuffer: expect.any(Number) }),
      expect.any(Function)
    );
    expect(result).toBe('Local git diff for "origin/main...HEAD"\n\nrange diff body');
  });

  it('ignores benign stderr chatter when git exits zero', async () => {
    mockGitResult(null, 'diff body', 'warning: CRLF will be replaced by LF');

    const { get } = await import('#src/sources/gitDiffSource.js');
    const result = await get(null, undefined);

    expect(result).toBe('Local git diff for the working tree\n\ndiff body');
  });

  it('rejects option-shaped arguments without invoking git', async () => {
    const { get } = await import('#src/sources/gitDiffSource.js');

    await expect(get(null, '--output=/tmp/pwned')).rejects.toThrow(
      'Invalid git diff argument "--output=/tmp/pwned"'
    );
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when the diff is empty', async () => {
    mockGitResult(null, '  \n', '');

    const { get } = await import('#src/sources/gitDiffSource.js');

    await expect(get(null, undefined)).rejects.toThrow(
      'No changes found in git diff for the working tree; nothing to review.'
    );
  });

  it('throws a clear error outside a git repository', async () => {
    mockGitResult(
      new Error('Command failed: git --no-pager diff'),
      '',
      'fatal: not a git repository (or any of the parent directories): .git'
    );

    const { get } = await import('#src/sources/gitDiffSource.js');

    await expect(get(null, undefined)).rejects.toThrow(
      /Failed to get git diff for the working tree: fatal: not a git repository/
    );
  });

  it('trims git usage-screen noise from stderr down to the meaningful line', async () => {
    mockGitResult(
      new Error('Command failed'),
      '',
      'warning: Not a git repository. Use --no-index to compare two paths outside a working tree\n' +
        'usage: git diff --no-index [<options>] <path> <path> [<pathspec>...]\n\n' +
        'Diff output format options\n    -p, --patch           generate patch\n'
    );

    const { get } = await import('#src/sources/gitDiffSource.js');

    const error = await get(null, undefined).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('warning: Not a git repository.');
    expect((error as Error).message).not.toContain('usage: git diff');
    expect((error as Error).message).not.toContain('--patch');
  });

  describe('contentSourceConfig.git.mergeBase', () => {
    const SHA = 'a'.repeat(40);

    function mockMergeBaseThenDiff(diff: string): void {
      execFileMock.mockImplementation(
        (_cmd: string, args: string[], _opts: object, cb: ExecFileCallback) => {
          cb(null, args[0] === 'merge-base' ? `${SHA}\n` : diff, '');
        }
      );
    }

    it('resolves the base with git merge-base, then diffs the working tree against that sha', async () => {
      mockMergeBaseThenDiff('merge base diff body');

      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = await get({ mergeBase: 'origin/main' }, undefined);

      expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
        ['merge-base', 'origin/main', 'HEAD'],
        ['--no-pager', 'diff', SHA, '--'],
      ]);
      expect(result).toBe(
        `Local git diff against the merge base of "origin/main" and HEAD (${SHA})\n\nmerge base diff body`
      );
    });

    it('leaves an explicit contentId untouched and never resolves the base', async () => {
      mockMergeBaseThenDiff('range diff body');

      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = await get({ mergeBase: 'origin/main' }, 'origin/main...HEAD');

      expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([
        ['--no-pager', 'diff', 'origin/main...HEAD'],
      ]);
      expect(result).toBe('Local git diff for "origin/main...HEAD"\n\nrange diff body');
    });

    it('rejects an option-shaped base, naming the setting, without invoking git', async () => {
      const { get } = await import('#src/sources/gitDiffSource.js');

      await expect(get({ mergeBase: '--output=/tmp/pwned' }, undefined)).rejects.toThrow(
        'Invalid contentSourceConfig.git.mergeBase "--output=/tmp/pwned"'
      );
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a number', 42, '42'],
      ['a boolean', true, 'true'],
      ['an object', { ref: 'main' }, '{"ref":"main"}'],
      ['null', null, 'null'],
      ['an empty string', '', '""'],
    ])('rejects %s rather than ignoring it, without invoking git', async (_, value, shown) => {
      const { get } = await import('#src/sources/gitDiffSource.js');

      await expect(get({ mergeBase: value }, undefined)).rejects.toThrow(
        `Invalid contentSourceConfig.git.mergeBase ${shown}; expected a non-empty string`
      );
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('rejects a malformed base even when an explicit contentId means it would not be used', async () => {
      const { get } = await import('#src/sources/gitDiffSource.js');

      await expect(get({ mergeBase: 42 }, 'origin/main...HEAD')).rejects.toThrow(
        'Invalid contentSourceConfig.git.mergeBase 42'
      );
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('rejects a git config block that is not an object', async () => {
      const { get } = await import('#src/sources/gitDiffSource.js');

      await expect(
        get('origin/main' as unknown as Record<string, unknown>, undefined)
      ).rejects.toThrow('Invalid contentSourceConfig.git; expected an object');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the block has no mergeBase', async () => {
      mockGitResult(null, 'diff body', '');

      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = await get({}, undefined);

      expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([['--no-pager', 'diff']]);
      expect(result).toBe('Local git diff for the working tree\n\ndiff body');
      expect(displayWarningMock).not.toHaveBeenCalled();
    });

    it('warns about a mistyped key, naming it and the known key, and still reviews', async () => {
      mockGitResult(null, 'diff body', '');

      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = await get({ mergebase: 'origin/main' }, undefined);

      expect(displayWarningMock).toHaveBeenCalledTimes(1);
      expect(displayWarningMock).toHaveBeenCalledWith(
        'contentSourceConfig.git: unknown key "mergebase" is ignored; known keys: mergeBase.'
      );
      expect(execFileMock.mock.calls.map((call) => call[1])).toEqual([['--no-pager', 'diff']]);
      expect(result).toBe('Local git diff for the working tree\n\ndiff body');
    });

    it('names every unknown key in one warning and still honours mergeBase', async () => {
      mockMergeBaseThenDiff('merge base diff body');

      const { get } = await import('#src/sources/gitDiffSource.js');
      const result = await get(
        { mergeBase: 'origin/main', untracked: true, base: 'main' },
        undefined
      );

      expect(displayWarningMock).toHaveBeenCalledTimes(1);
      expect(displayWarningMock).toHaveBeenCalledWith(
        'contentSourceConfig.git: unknown keys "untracked", "base" are ignored; known keys: mergeBase.'
      );
      expect(result).toBe(
        `Local git diff against the merge base of "origin/main" and HEAD (${SHA})\n\nmerge base diff body`
      );
    });

    it('does not warn when the block holds only mergeBase', async () => {
      mockMergeBaseThenDiff('merge base diff body');

      const { get } = await import('#src/sources/gitDiffSource.js');
      await get({ mergeBase: 'origin/main' }, undefined);

      expect(displayWarningMock).not.toHaveBeenCalled();
    });

    it('reports an empty merge-base diff with the base in the message', async () => {
      mockMergeBaseThenDiff('\n');

      const { get } = await import('#src/sources/gitDiffSource.js');

      await expect(get({ mergeBase: 'origin/main' }, undefined)).rejects.toThrow(
        `No changes found in git diff against the merge base of "origin/main" and HEAD (${SHA}); nothing to review.`
      );
    });
  });

  it('surfaces a bad ref error with the ref range in the message', async () => {
    mockGitResult(
      new Error('Command failed'),
      '',
      "fatal: ambiguous argument 'nope...HEAD': unknown revision or path not in the working tree."
    );

    const { get } = await import('#src/sources/gitDiffSource.js');

    await expect(get(null, 'nope...HEAD')).rejects.toThrow(
      /Failed to get git diff for "nope\.\.\.HEAD": fatal: ambiguous argument/
    );
  });
});
