import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExecFileCallback = (_error: Error | null, _stdout: string, _stderr: string) => void;

const execFileMock = vi.fn();
const progressIndicatorStopMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
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
