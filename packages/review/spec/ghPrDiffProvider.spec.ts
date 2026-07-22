import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from '#src/sources/ghPrDiffSource.js';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';

// Mock dependencies
const stopMock = vi.hoisted(() => vi.fn());
const ProgressIndicatorMock = vi.hoisted(() =>
  vi.fn(function ProgressIndicatorMock() {
    return {
      stop: stopMock,
    };
  })
);
const execAsyncMock = vi.hoisted(() => vi.fn());

vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: ProgressIndicatorMock,
}));
vi.mock('#src/utils/systemUtils.js', () => ({
  execAsync: execAsyncMock,
}));
vi.mock('#src/utils/consoleUtils.js', () => ({
  displayWarning: vi.fn(),
}));

describe('ghPrDiffProvider', () => {
  beforeEach(() => {
    stopMock.mockReset();
    ProgressIndicatorMock.mockClear();
    execAsyncMock.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should stop progress indicator and throw error when execAsync throws an error', async () => {
    // Arrange
    const error = new Error('GitHub CLI failed');
    execAsyncMock.mockRejectedValue(error);

    // Act & Assert
    await expect(get(null, '123')).rejects.toThrow(
      'Failed to get GitHub PR diff #123: GitHub CLI failed'
    );
    expect(ProgressIndicator).toHaveBeenCalledWith('Fetching GitHub PR #123 diff');
    expect(stopMock).toHaveBeenCalled();
  });

  it('should stop progress indicator when successful', async () => {
    // Arrange
    execAsyncMock.mockResolvedValue('diff content');

    // Act
    await get(null, '123');

    // Assert
    expect(ProgressIndicator).toHaveBeenCalledWith('Fetching GitHub PR #123 diff');
    expect(stopMock).toHaveBeenCalled();
  });
});
