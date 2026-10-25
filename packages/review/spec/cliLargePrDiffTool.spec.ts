import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-6 — the CI bin `gaunt-sloth-review` hands the github source's large-PR signal to `review()`,
 * the way `gth pr` does. The bin runs `main()` on import, so each case sets `process.argv`, imports
 * it fresh and waits for the mocked `review()` to be reached. The real `getContentFromSource` sits
 * between the two mocks, so the callback is threaded by the code under test.
 */
const reviewMock = vi.fn();
const ghPrDiffGetMock = vi.fn();
const initConfigMock = vi.fn();

vi.mock('#src/modules/reviewModule.js', () => ({ review: reviewMock }));
vi.mock('#src/modules/reviewFailureReport.js', () => ({ writeReviewFailureReport: vi.fn() }));
vi.mock('#src/sources/ghPrDiffSource.js', () => ({ get: ghPrDiffGetMock }));
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  displayError: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  readBackstory: vi.fn(() => ''),
  readGuidelines: vi.fn(() => ''),
  readReviewInstructions: vi.fn(() => ''),
  readSystemPrompt: vi.fn(() => ''),
}));

const LISTING = {
  binding: { host: 'github.com', owner: 'o', repo: 'r', number: '64122' },
  entries: [{ path: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '+a' }],
  elidedCount: 1,
};

async function runBin(): Promise<unknown[]> {
  vi.resetModules();
  process.argv = ['node', 'gaunt-sloth-review', '64122'];
  await import('../cli.js');
  await vi.waitFor(() => expect(reviewMock).toHaveBeenCalled());
  return reviewMock.mock.calls[0];
}

describe('REL-6 the CI bin threads the large-PR signal', () => {
  const argv = process.argv;

  beforeEach(() => {
    vi.resetAllMocks();
    initConfigMock.mockResolvedValue({ contentSource: 'github', commands: {} });
    reviewMock.mockResolvedValue(undefined);
  });
  afterEach(() => {
    process.argv = argv;
  });

  it('passes the listing the source reported to review() as largePr', async () => {
    ghPrDiffGetMock.mockImplementation(async (_cfg, _id, context) => {
      context?.onLargePr?.(LISTING);
      return 'TRIAGED';
    });
    const call = await runBin();
    expect(call[4]).toBe('pr');
    expect(call[6]).toEqual({ prId: '64122', largePr: LISTING });
    expect(ghPrDiffGetMock.mock.calls[0][2]).toMatchObject({ command: 'pr' });
  });

  it('passes no signal for a PR that fits', async () => {
    ghPrDiffGetMock.mockResolvedValue('SMALL');
    const call = await runBin();
    expect(call[6]).toEqual({ prId: '64122', largePr: undefined });
  });
});
