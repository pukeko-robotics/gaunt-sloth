import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * EXT-53 regression: `ghIssueSource` used to construct its `ProgressIndicator` INSIDE the `try` and
 * `stop()` it only on the success path, so any `gh issue view` failure left the indicator's 1s
 * `setInterval` running. That interval is an active libuv handle, so the CLI printed dots forever
 * and never exited — and because a failed issue fetch is a SOFT failure (returns `null`, the review
 * proceeds and prints its verdict) the hang was completely invisible.
 *
 * These tests deliberately use the REAL `ProgressIndicator` (the sibling `ghIssueSource.spec.ts`
 * mocks it) plus fake timers, so `vi.getTimerCount()` pins the actual handle rather than merely
 * asserting `stop()` was called.
 */
const execAsyncMock = vi.fn();
const displayWarningMock = vi.fn();
const stdoutWriteMock = vi.fn();

vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
  stdout: { write: stdoutWriteMock },
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayWarning: displayWarningMock,
}));

describe('ghIssueSource progress-indicator lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the progress interval when gh issue view FAILS (the CLI must still be able to exit)', async () => {
    execAsyncMock.mockRejectedValue(
      new Error('GraphQL: Field "projectCards" does not exist on type "Issue"')
    );

    const { get } = await import('#src/sources/ghIssueSource.js');
    const result = await get(null, '133');

    // Soft failure semantics are unchanged.
    expect(result).toBeNull();
    expect(displayWarningMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get GitHub issue #133')
    );

    // The point of the ticket: NO timer handle survives the error path.
    expect(vi.getTimerCount()).toBe(0);

    // And nothing keeps writing dots after the failure.
    stdoutWriteMock.mockClear();
    vi.advanceTimersByTime(10000);
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  it('clears the progress interval when gh issue view returns empty content', async () => {
    execAsyncMock.mockResolvedValue('');

    const { get } = await import('#src/sources/ghIssueSource.js');
    const result = await get(null, '133');

    expect(result).toBeNull();
    expect(displayWarningMock).toHaveBeenCalledWith('No content found for GitHub issue #133');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the success path unchanged: same string, one terminating newline, no timer left', async () => {
    execAsyncMock.mockResolvedValue('issue body');

    const { get } = await import('#src/sources/ghIssueSource.js');
    const result = await get(null, '133');

    expect(result).toBe('GitHub Issue: #133\n\nissue body');
    expect(displayWarningMock).not.toHaveBeenCalled();
    expect(stdoutWriteMock).toHaveBeenCalledWith('Fetching GitHub issue #133');
    expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
