/**
 * [[EXT-159]] — **the reason reaches the LIVE SESSION**, on core's two non-interactive surfaces.
 *
 * This is the half of the node the tempting cheap answer ("the dump already has it") does not
 * cover, and the reasoning is not about tidiness: most people never make a dump; the ones most
 * likely to hit a silent stop have already quit, and a `/debug-dump` is assembled from live session
 * state that quitting destroys; and reading a dump is a skill that fails — the maintainer read his
 * own two dumps of this exact bug and did not see the errors in them. So a run that stops has to
 * say why **where the person is looking**, at the moment it happens.
 *
 * Two surfaces live here, and neither is the interactive one:
 *
 * - `runSingleShot` — the non-interactive verbs (`ask`, `exec`, and every `batch`/`workflow` cell
 *   that runs through it). There is no prompt to come back to; the process prints and exits.
 * - `runConversation` — the scripted multi-turn runtime behind `gth eval`. It reports a failed turn
 *   on the same console, and a person watching a suite run watches these lines.
 *
 * **Every cell reads the classification structurally.** The console assertions are about a line
 * having been produced at all; the classification is asserted off the returned value, because no
 * user-facing string may be the only carrier of it. A cell that matched the sentence would go green
 * on a build that printed the right words from the wrong fact.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { GthConfig } from '#src/config.js';
import { terminationReason } from '#src/core/terminationReason.js';
import { TERMINATION_NOTICE_TITLE_PREFIX } from '#src/core/terminationNotice.js';

const runnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  resetThread: vi.fn(),
  getRunStats: vi.fn(() => ({ tools: [] })),
  getTerminationReason: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

const consoleUtilsMock = vi.hoisted(() => ({
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  // [[EXT-165]] — the ONE writer a termination notice goes through. It has to be here for the
  // same reason `getTerminationReason` has to be on the runner double: `displayTermination` is
  // fail-soft, so an omitted export is not a loud missing-mock error but a swallowed throw, and
  // every cell below would then pass with nothing in front of the user.
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
}));
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

vi.mock('#src/utils/systemUtils.js', () => ({
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(() => '/project'),
  // The progress indicator writes to it; a fixed width keeps any framing arithmetic off the
  // terminal the suite happens to run in.
  stdout: { columns: 120, write: vi.fn() },
}));

vi.mock('#src/utils/fileUtils.js', () => ({
  getCommandOutputFilePath: vi.fn(() => null),
  appendToFile: vi.fn(),
}));

vi.mock('#src/history/recordSession.js', () => ({
  recordSessionSafe: vi.fn(),
}));

const config = {
  contentSource: 'file',
  requirementSource: 'file',
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: false,
  streamOutput: false,
} as Partial<GthConfig> as GthConfig;

/** The reason under test: a rate limit is the [[EXT-92]] cause #433 itself reports. */
const rateLimited = terminationReason('runner.stream-error', 'exception', {
  category: 'rate_limited',
  provider: 'openai',
  detail: '429',
});

/**
 * The NOTICES the surface put in front of a person — each one flattened title-then-body, from the
 * single call that carried both.
 *
 * [[EXT-165]] — read only from `displayNotice`, never from the per-line helpers, and that is the
 * point rather than a detail. A notice rendered the old way (`displayWarning(title)` then
 * `display('  ' + line)`) makes no call here at all, so a regression that put the two halves back
 * on two streams reds these cells; a reader that also scanned `display`/`displayWarning` would go
 * green on exactly that regression, which is the assertion-that-cannot-fail this project keeps
 * finding.
 */
const noticesShown = (): string[] =>
  consoleUtilsMock.displayNotice.mock.calls.map((call) =>
    [String(call[0]), ...(call[1] as readonly string[])].join('\n')
  );

/** The lines the surface put in front of a person through the ordinary PER-LINE helpers. */
const saidToUser = (): string[] => [
  ...consoleUtilsMock.displayWarning.mock.calls.map((call) => String(call[0])),
  ...consoleUtilsMock.display.mock.calls.map((call) => String(call[0])),
];

describe('[[EXT-159]] the reason reaches the live session — core’s non-interactive surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.getRunStats.mockReturnValue({ tools: [] });
    runnerInstanceMock.getTerminationReason.mockReturnValue(null);
  });

  describe('SURFACE — runSingleShot (the non-interactive verbs)', () => {
    it('says why the run ended, on the console, when the turn failed', async () => {
      runnerInstanceMock.processMessages.mockRejectedValue(new Error('429 Too Many Requests'));
      runnerInstanceMock.getTerminationReason.mockReturnValue(rateLimited);
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      await runSingleShot('s', '', 'go', config);

      // One notice, carrying its title AND the quotable code — not two halves a redirect could
      // separate. The per-line helpers must have received none of it.
      expect(noticesShown()).toHaveLength(1);
      expect(noticesShown()[0]).toContain(TERMINATION_NOTICE_TITLE_PREFIX);
      expect(noticesShown()[0]).toContain('rate_limited@runner.stream-error');
      expect(saidToUser().join('\n')).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
    });

    /**
     * The acceptance clause: no user-facing string is the ONLY carrier. A caller — and this cell —
     * reads the classification off the result rather than parsing the sentence.
     */
    it('returns the reason as a value, not only as words on the console', async () => {
      runnerInstanceMock.processMessages.mockRejectedValue(new Error('429 Too Many Requests'));
      runnerInstanceMock.getTerminationReason.mockReturnValue(rateLimited);
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot('s', '', 'go', config);

      expect(result.terminationReason).toMatchObject({
        category: 'rate_limited',
        site: 'runner.stream-error',
        retryableAsIs: false,
        retryableAfterRemedy: true,
        remedy: 'back-off',
      });
    });

    it('says nothing extra when the model simply finished', async () => {
      runnerInstanceMock.processMessages.mockResolvedValue('an answer');
      runnerInstanceMock.getTerminationReason.mockReturnValue(
        terminationReason('runner.completed', 'control', 'completed')
      );
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot('s', '', 'go', config);

      expect(noticesShown()).toEqual([]);
      expect(saidToUser().join('\n')).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
      // Recorded even so: an ordinary completion IS a termination, and recording it is what makes
      // an absent reason mean "a site we missed" rather than "nothing went wrong".
      expect(result.terminationReason).toMatchObject({ category: 'completed' });
    });

    /**
     * **The absence stays an absence.** A surface that filled in `completed` here would put a false
     * statement where the taxonomy's only defect detector lives, and a surface that invented
     * `unknown` would claim a site looked and could not tell.
     */
    it('reports an unclassified ending as null, never as a category', async () => {
      runnerInstanceMock.processMessages.mockResolvedValue('an answer');
      runnerInstanceMock.getTerminationReason.mockReturnValue(null);
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot('s', '', 'go', config);

      expect(result.terminationReason).toBeNull();
      expect(noticesShown()).toEqual([]);
      expect(saidToUser().join('\n')).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
    });

    /** Explaining a run must never become a second failure. */
    it('survives a runner that throws when asked why the run ended', async () => {
      runnerInstanceMock.processMessages.mockResolvedValue('an answer');
      runnerInstanceMock.getTerminationReason.mockImplementation(() => {
        throw new Error('no such method');
      });
      const { runSingleShot } = await import('#src/runtime/singleShot.js');

      const result = await runSingleShot('s', '', 'go', config);

      expect(result.ok).toBe(true);
      expect(result.terminationReason).toBeNull();
    });
  });

  describe('SURFACE — runConversation (the scripted multi-turn runtime)', () => {
    it('says why the turn ended and carries the reason on the turn record', async () => {
      runnerInstanceMock.processMessages.mockRejectedValue(new Error('429 Too Many Requests'));
      runnerInstanceMock.getTerminationReason.mockReturnValue(rateLimited);
      const { runConversation } = await import('#src/runtime/conversation.js');

      const turns = await runConversation('ask', 'c', ['first'], config);

      expect(noticesShown()).toHaveLength(1);
      expect(noticesShown()[0]).toContain(TERMINATION_NOTICE_TITLE_PREFIX);
      expect(noticesShown()[0]).toContain('rate_limited@runner.stream-error');
      expect(saidToUser().join('\n')).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
      expect(turns).toHaveLength(1);
      expect(turns[0].terminationReason).toMatchObject({
        category: 'rate_limited',
        site: 'runner.stream-error',
      });
    });

    /**
     * Per TURN, which is the whole reason it is on the turn record rather than on the run. A
     * conversation stops at its first failed turn, so the reason for the turn that stopped is the
     * only one anybody can act on — and a run-level field would be answered by whichever turn
     * happened to be last.
     */
    it('records a reason per turn, not once for the conversation', async () => {
      runnerInstanceMock.processMessages
        .mockResolvedValueOnce('fine')
        .mockRejectedValueOnce(new Error('boom'));
      runnerInstanceMock.getTerminationReason
        .mockReturnValueOnce(terminationReason('runner.completed', 'control', 'completed'))
        .mockReturnValueOnce(
          terminationReason('runner.stream-error', 'exception', 'provider_error')
        );
      const { runConversation } = await import('#src/runtime/conversation.js');

      const turns = await runConversation('ask', 'c', ['first', 'second'], config);

      expect(turns.map((turn) => turn.terminationReason?.category)).toEqual([
        'completed',
        'provider_error',
      ]);
      // The message the human turn was built from is unaffected by any of this.
      expect(runnerInstanceMock.processMessages).toHaveBeenCalledWith([
        expect.any(HumanMessage),
        expect.anything(),
        expect.any(HumanMessage),
      ]);
    });
  });
});
