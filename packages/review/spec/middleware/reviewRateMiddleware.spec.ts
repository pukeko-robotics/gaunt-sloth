import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayInfo: displayInfoMock,
  displayWarning: displayWarningMock,
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: vi.fn(),
  debugLogError: vi.fn(),
}));

const getArtifactMock = vi.fn();
vi.mock('@gaunt-sloth/core/state/artifactStore.js', () => ({
  setArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  getArtifact: getArtifactMock,
}));

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  getNewRunnableConfig: () => ({ recursionLimit: 42 }),
}));

const invokeMock = vi.hoisted(() => vi.fn());
const createAgentMock = vi.hoisted(() => vi.fn(() => ({ invoke: invokeMock })));
vi.mock('langchain', async () => {
  const actual = await vi.importActual<typeof import('langchain')>('langchain');
  return { ...actual, createAgent: createAgentMock };
});

import { HumanMessage } from '@langchain/core/messages';

const config = { llm: {} } as GthConfig;
const state = { messages: [new HumanMessage('a review')] };

/** Build the middleware and run its `afterAgent` hook once. */
async function runAfterAgent(settings: Record<string, unknown> = {}) {
  const { createReviewRateMiddleware } = await import('#src/middleware/reviewRateMiddleware.js');
  const middleware = await createReviewRateMiddleware(settings, config);
  const afterAgent = (middleware as unknown as { afterAgent: (s: unknown) => Promise<unknown> })
    .afterAgent;
  return afterAgent(state);
}

/** The second argument of the single `invoke` call — the runnable config. */
function invokedConfig(): Record<string, unknown> {
  expect(invokeMock).toHaveBeenCalledTimes(1);
  return invokeMock.mock.calls[0][1] as Record<string, unknown>;
}

describe('GS2-105 — the review rating call is bounded and visible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAgentMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockResolvedValue({ messages: [] });
    getArtifactMock.mockReturnValue({ rate: 8 });
  });

  describe('the wall-clock budget', () => {
    it('passes the default budget to the rating call', async () => {
      const { DEFAULT_REVIEW_RATE_TIMEOUT_MS } =
        await import('#src/middleware/reviewRateMiddleware.js');

      await runAfterAgent();

      expect(invokedConfig().timeout).toBe(DEFAULT_REVIEW_RATE_TIMEOUT_MS);
    });

    it('lets the rating config override the budget', async () => {
      await runAfterAgent({ timeoutMs: 5000 });

      expect(invokedConfig().timeout).toBe(5000);
    });

    it('keeps the rest of the runnable config rather than replacing it', async () => {
      await runAfterAgent();

      // A budget added by clobbering the config would drop the recursion limit with it.
      expect(invokedConfig().recursionLimit).toBe(42);
    });

    it('bounds the call without capping the shared model the review itself uses', async () => {
      await runAfterAgent();

      // The budget belongs to the rating CALL. If it were applied by mutating `config.llm`, the
      // main review agent would silently inherit it and its prose would be truncated.
      expect(config.llm).toEqual({});
      expect(createAgentMock).toHaveBeenCalledWith(expect.objectContaining({ model: config.llm }));
    });
  });

  describe('what a failed rating round reports', () => {
    it('says the call was cancelled when the budget aborts it', async () => {
      invokeMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

      await runAfterAgent({ timeoutMs: 5000 });

      expect(displayWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('did not finish within 5000ms')
      );
    });

    it('reports a provider error as a provider error, not as a timeout', async () => {
      invokeMock.mockRejectedValue(new Error('provider exploded'));

      await runAfterAgent();

      // The discriminating half: collapsing these two would make a hung local model
      // indistinguishable from a broken configuration.
      const message = displayWarningMock.mock.calls[0][0] as string;
      expect(message).toContain('provider exploded');
      expect(message).not.toContain('did not finish within');
    });

    it('still warns when the model answers but never calls the rating tool', async () => {
      getArtifactMock.mockReturnValue(undefined);

      await runAfterAgent();

      expect(displayWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('did not call the rating tool')
      );
    });
  });

  describe('visibility', () => {
    it('announces the rating round before making the call', async () => {
      await runAfterAgent();

      expect(displayInfoMock).toHaveBeenCalledWith(expect.stringContaining('Scoring the review'));
      // Announced BEFORE, not after — the whole point is that the pause is explained while it lasts.
      expect(displayInfoMock.mock.invocationCallOrder[0]).toBeLessThan(
        invokeMock.mock.invocationCallOrder[0]
      );
    });
  });
});
