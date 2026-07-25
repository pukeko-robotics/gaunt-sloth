import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

/**
 * EXT-53 regression for the two non-streaming runtime entry points.
 *
 * `runSingleShot` and `runConversation` both create a `ProgressIndicator` (1s `setInterval` — an
 * active libuv handle) and used to call `progressIndicator?.stop()` on a plain statement AFTER their
 * try/finally. Anything that threw past that point — `runner.cleanup()` in either, or `runner.init()`
 * in `runConversation`, which has no catch — skipped the `stop()` and left the handle alive, so the
 * process could never exit.
 *
 * Unlike `singleShot.spec.ts` / `conversation.spec.ts` (which mock the indicator away), this spec
 * exercises the REAL `ProgressIndicator` under fake timers, so `vi.getTimerCount()` pins the handle.
 */
const gthAgentRunnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getRunStats: vi.fn(),
  resetThread: vi.fn(),
  cleanup: vi.fn(),
}));
const gthAgentRunnerMock = vi.hoisted(() =>
  vi.fn(function GthAgentRunnerMock() {
    return gthAgentRunnerInstanceMock;
  })
);
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

const consoleUtilsMock = {
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const fileUtilsMock = {
  getCommandOutputFilePath: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

// The real ProgressIndicator writes through this wrapper; keep `stdout` so it is not mocked away.
const stdoutWriteMock = vi.fn();
const systemUtilsMock = {
  getProjectDir: vi.fn(() => '/project'),
  stdout: { write: stdoutWriteMock },
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const recordSessionMock = {
  recordSessionSafe: vi.fn(),
};
vi.mock('#src/history/recordSession.js', () => recordSessionMock);

vi.mock('#src/config.js', () => ({ GthConfig: {} }));

// streamOutput:false is what makes the indicator exist at all.
const mockConfig = {
  streamOutput: false,
  writeOutputToFile: false,
  modelDisplayName: 'test-model',
} as Partial<GthConfig> as GthConfig;

describe('runtime progress-indicator cleanup on error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    systemUtilsMock.getProjectDir.mockReturnValue('/project');
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('an answer');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    fileUtilsMock.getCommandOutputFilePath.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('runSingleShot', () => {
    it('clears the progress interval when runner.cleanup() throws', async () => {
      gthAgentRunnerInstanceMock.cleanup.mockRejectedValue(new Error('MCP teardown exploded'));

      const { runSingleShot } = await import('#src/runtime/singleShot.js');
      await expect(runSingleShot('src', 'preamble', 'question', mockConfig)).rejects.toThrow(
        'MCP teardown exploded'
      );

      expect(vi.getTimerCount()).toBe(0);

      stdoutWriteMock.mockClear();
      vi.advanceTimersByTime(10000);
      expect(stdoutWriteMock).not.toHaveBeenCalled();
    });

    it('still clears it — and writes exactly one newline — on the normal path', async () => {
      const { runSingleShot } = await import('#src/runtime/singleShot.js');
      const result = await runSingleShot('src', 'preamble', 'question', mockConfig);

      expect(result.ok).toBe(true);
      expect(result.answer).toBe('an answer');
      expect(vi.getTimerCount()).toBe(0);
      expect(stdoutWriteMock).toHaveBeenCalledWith('Thinking.');
      expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
    });
  });

  describe('runConversation', () => {
    it('clears the progress interval when runner.init() throws', async () => {
      gthAgentRunnerInstanceMock.init.mockRejectedValue(new Error('agent init exploded'));

      const { runConversation } = await import('#src/runtime/conversation.js');
      await expect(runConversation('EVAL-c', 'preamble', ['u1'], mockConfig)).rejects.toThrow(
        'agent init exploded'
      );

      expect(vi.getTimerCount()).toBe(0);

      stdoutWriteMock.mockClear();
      vi.advanceTimersByTime(10000);
      expect(stdoutWriteMock).not.toHaveBeenCalled();
    });

    it('clears the progress interval when runner.cleanup() throws', async () => {
      gthAgentRunnerInstanceMock.cleanup.mockRejectedValue(new Error('MCP teardown exploded'));

      const { runConversation } = await import('#src/runtime/conversation.js');
      await expect(runConversation('EVAL-c', 'preamble', ['u1'], mockConfig)).rejects.toThrow(
        'MCP teardown exploded'
      );

      expect(vi.getTimerCount()).toBe(0);
    });

    it('still clears it — and writes exactly one newline — on the normal path', async () => {
      const { runConversation } = await import('#src/runtime/conversation.js');
      const results = await runConversation('EVAL-c', 'preamble', ['u1', 'u2'], mockConfig);

      expect(results.map((r) => r.answer)).toEqual(['an answer', 'an answer']);
      expect(vi.getTimerCount()).toBe(0);
      expect(stdoutWriteMock).toHaveBeenCalledWith('Thinking.');
      expect(stdoutWriteMock.mock.calls.filter((c) => c[0] === '\n')).toHaveLength(1);
    });
  });
});
