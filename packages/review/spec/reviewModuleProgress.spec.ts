import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

/**
 * EXT-53 regression for `reviewModule.review()` — the `pr` / `review` command path.
 *
 * This is the site the original sweep missed. The `ProgressIndicator` (1s `setInterval` — an active
 * libuv handle) is constructed at the very top of `review()`, but its `stop()` was a plain statement
 * sitting AFTER the runner's try/catch/finally. Everything in between ran unguarded, so a throw from
 * any of it skipped the `stop()` and left the handle alive — the CLI finishes its work and then
 * hangs forever, exactly as `gh pr` did in the original report.
 *
 * The two realistic throw sites, both exercised below:
 *   - `await createReviewRateMiddleware(...)` — awaited outside any catch;
 *   - `await runner.cleanup()` — sits in the inner `finally`, so it rethrows straight past `stop()`.
 *
 * Like the sibling EXT-53 specs (and unlike `reviewModule.spec.ts`, which mocks `stdout` away),
 * this uses the REAL `ProgressIndicator` under fake timers so `vi.getTimerCount()` pins the actual
 * handle rather than merely asserting that `stop()` was called.
 */
const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  }),
}));

const createReviewRateMiddlewareMock = vi.hoisted(() => vi.fn());
vi.mock('#src/middleware/reviewRateMiddleware.js', () => ({
  createReviewRateMiddleware: createReviewRateMiddlewareMock,
  REVIEW_RATE_ARTIFACT_KEY: 'review-rate',
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  display: vi.fn(),
  displayDebug: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
  flushSessionLog: vi.fn(),
  initSessionLogging: vi.fn(),
  stopSessionLogging: vi.fn(),
}));

vi.mock('#src/utils/fileUtils.js', () => ({
  getCommandOutputFilePath: vi.fn(() => null),
}));

vi.mock('@gaunt-sloth/core/state/artifactStore.js', () => ({
  deleteArtifact: vi.fn(),
  getArtifact: vi.fn(() => undefined),
}));

// The real ProgressIndicator writes through this wrapper; keep `stdout` so it is not mocked away.
const stdoutWriteMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  setExitCode: vi.fn(),
  stdout: { write: stdoutWriteMock },
}));

// streamOutput:false is what makes the indicator exist at all.
const baseConfig = {
  streamOutput: false,
  writeOutputToFile: false,
} as Partial<GthConfig> as GthConfig;

describe('reviewModule progress-indicator cleanup on error paths (EXT-53)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('a review');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
    createReviewRateMiddlewareMock.mockResolvedValue({ name: 'review-rate' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the progress interval when createReviewRateMiddleware() throws', async () => {
    createReviewRateMiddlewareMock.mockRejectedValue(new Error('rating middleware exploded'));

    const { review } = await import('#src/modules/reviewModule.js');
    await expect(
      review('src', 'preamble', 'diff', {
        ...baseConfig,
        commands: { review: { rating: { enabled: true } } },
      } as unknown as GthConfig)
    ).rejects.toThrow('rating middleware exploded');

    // The point of the ticket: NO timer handle survives the error path.
    expect(vi.getTimerCount()).toBe(0);

    // And nothing keeps writing dots after the failure.
    stdoutWriteMock.mockClear();
    vi.advanceTimersByTime(10000);
    expect(stdoutWriteMock).not.toHaveBeenCalled();
  });

  it('clears the progress interval when runner.cleanup() throws', async () => {
    gthAgentRunnerInstanceMock.cleanup.mockRejectedValue(new Error('MCP teardown exploded'));

    const { review } = await import('#src/modules/reviewModule.js');
    await expect(review('src', 'preamble', 'diff', baseConfig)).rejects.toThrow(
      'MCP teardown exploded'
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('still clears it — and writes exactly one newline — on the normal path', async () => {
    const { review } = await import('#src/modules/reviewModule.js');
    await review('src', 'preamble', 'diff', baseConfig);

    expect(vi.getTimerCount()).toBe(0);
    expect(stdoutWriteMock).toHaveBeenCalledWith('Reviewing.');
    expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
  });
});
