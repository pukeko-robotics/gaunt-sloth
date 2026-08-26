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

const setArtifactMock = vi.fn();
const getArtifactMock = vi.fn();
vi.mock('@gaunt-sloth/core/state/artifactStore.js', () => ({
  setArtifact: setArtifactMock,
  deleteArtifact: vi.fn(),
  getArtifact: getArtifactMock,
}));

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', () => ({
  getNewRunnableConfig: () => ({ recursionLimit: 42 }),
}));

import { HumanMessage } from '@langchain/core/messages';

const invokeMock = vi.fn();
const bindToolsMock = vi.fn(() => ({ invoke: invokeMock }));
const config = { llm: { bindTools: bindToolsMock } } as unknown as GthConfig;
const state = { messages: [new HumanMessage('a review')] };

/** A model response carrying `n` rating tool calls. */
function withRatingCalls(n: number) {
  return {
    tool_calls: Array.from({ length: n }, (_, i) => ({
      name: 'gth_review_rate',
      args: { rate: 7 + i, comment: `call ${i}` },
      id: `call-${i}`,
    })),
  };
}

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

describe('GS2-105 — the review rating call is one bounded, visible round trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindToolsMock.mockReturnValue({ invoke: invokeMock });
    invokeMock.mockResolvedValue(withRatingCalls(1));
    getArtifactMock.mockReturnValue({ rate: 8 });
  });

  describe('exactly one round trip', () => {
    it('asks the model once, rather than running an agent loop', async () => {
      await runAfterAgent();

      // The measured defect: an agent loop fed the tool result back and the model scored again,
      // four times over, long after the score was settled.
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    it('stores one rating even when the model emits several calls in that response', async () => {
      invokeMock.mockResolvedValue(withRatingCalls(3));

      await runAfterAgent();

      expect(setArtifactMock).toHaveBeenCalledTimes(1);
    });

    it('picks the rating call out of a response that leads with another tool', async () => {
      // Order matters, and this is the case that discriminates. Selecting `tool_calls[0]` blindly
      // would take `something_else`, whose args fail the rating schema — so the rating would be
      // lost to the catch block rather than stored. Asserting only that nothing was stored would
      // pass either way and prove nothing.
      invokeMock.mockResolvedValue({
        tool_calls: [
          { name: 'something_else', args: { nonsense: true }, id: 'x' },
          { name: 'gth_review_rate', args: { rate: 7, comment: 'the real one' }, id: 'y' },
        ],
      });

      await runAfterAgent();

      expect(setArtifactMock).toHaveBeenCalledTimes(1);
      expect(setArtifactMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rate: 7, comment: 'the real one' })
      );
    });
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

    it('binds the tools to a derived model rather than mutating the shared one', async () => {
      await runAfterAgent();

      // If the rating bound itself onto `config.llm`, the main review agent would inherit it.
      expect(bindToolsMock).toHaveBeenCalledTimes(1);
      expect(config.llm).toEqual({ bindTools: bindToolsMock });
    });
  });

  describe('what a failed rating round reports', () => {
    it('settles within the budget even when the call never returns at all', async () => {
      // THE BEHAVIOURAL TEST, and the one that earns its place. Asserting that `timeout` was passed
      // in the config proves plumbing, not behaviour: it stays green even if the runnable layer
      // stops honouring the field. Here the mocked call never settles — exactly what a provider
      // that ignores the timeout looks like — so only a bound this module owns can end it.
      invokeMock.mockReturnValue(new Promise(() => {}));

      const started = Date.now();
      await runAfterAgent({ timeoutMs: 60 });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2000);
      expect(displayWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('did not finish within 60ms')
      );
    });

    it('leaves nothing behind to fire after a call that succeeded in time', async () => {
      // The guard must not become a way to crash a healthy run. A losing `Promise.race` entrant
      // still settles, so a deadline left armed after a fast, successful rating would reject into
      // nobody — and an unhandled rejection is fatal on modern Node. Wait past the budget and
      // require silence; vitest fails the test if a rejection surfaces.
      await runAfterAgent({ timeoutMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(displayWarningMock).not.toHaveBeenCalled();
    });

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
      invokeMock.mockResolvedValue({ tool_calls: [] });
      getArtifactMock.mockReturnValue(undefined);

      await runAfterAgent();

      expect(displayWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('did not call the rating tool')
      );
    });

    it('says so when the configured model cannot take tools at all', async () => {
      const { createReviewRateMiddleware } =
        await import('#src/middleware/reviewRateMiddleware.js');
      const middleware = await createReviewRateMiddleware({}, { llm: {} } as GthConfig);
      await (middleware as unknown as { afterAgent: (s: unknown) => Promise<unknown> }).afterAgent(
        state
      );

      expect(displayWarningMock).toHaveBeenCalledWith(
        expect.stringContaining('cannot be given tools')
      );
      expect(invokeMock).not.toHaveBeenCalled();
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
