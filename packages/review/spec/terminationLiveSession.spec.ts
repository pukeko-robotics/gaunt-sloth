/**
 * [[EXT-159]] — **the reason reaches the live session on the `review` / `pr` surface.**
 *
 * These verbs have exactly one moment in which they can tell anybody anything: they write a report
 * and exit. There is no prompt to come back to and no transcript to scroll, so a run that stopped
 * for a rate limit, a context overflow or a provider fault used to leave the user with the wrapped
 * error sentence and nothing that said which of those it was — and on the paths that end without
 * throwing, with nothing at all.
 *
 * The classification is asserted structurally, off the runner reading the surface performs, rather
 * than by matching the sentence: no user-facing string may be the only carrier of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import type { GthConfig } from '#src/config.js';
import type { AIMessageChunk } from '@langchain/core/messages';
import type {
  BaseChatModel,
  BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import { terminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import { TERMINATION_NOTICE_TITLE_PREFIX } from '@gaunt-sloth/core/core/terminationNotice.js';

const runnerInstanceMock = vi.hoisted(() => ({
  init: vi.fn(),
  processMessages: vi.fn(),
  getTerminationReason: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('#src/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return runnerInstanceMock;
  }),
}));

vi.mock('node:fs', () => ({ writeFileSync: vi.fn(), existsSync: vi.fn() }));

vi.mock('#src/utils/systemUtils.js', () => ({
  getCurrentWorkDir: vi.fn(),
  exit: vi.fn(),
  setExitCode: vi.fn(),
  execAsync: vi.fn(),
  stdout: { columns: 120, write: vi.fn() },
}));

const consoleUtilsMock = vi.hoisted(() => ({
  display: vi.fn(),
  displaySuccess: vi.fn(),
  displayError: vi.fn(),
  displayDebug: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  defaultStatusCallback: vi.fn(),
  initSessionLogging: vi.fn(),
  flushSessionLog: vi.fn(),
  stopSessionLogging: vi.fn(),
}));
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

vi.mock('#src/utils/fileUtils.js', () => ({
  getGslothFilePath: vi.fn(),
  gslothDirExists: vi.fn(() => false),
  getCommandOutputFilePath: vi.fn(() => null),
  toFileSafeString: vi.fn(),
  fileSafeLocalDate: vi.fn(),
  generateStandardFileName: vi.fn(),
  appendToFile: vi.fn(),
}));

vi.mock('#src/utils/ProgressIndicator.js', () => ({
  ProgressIndicator: vi.fn(function ProgressIndicatorMock() {
    return { stop: vi.fn(), indicate: vi.fn() };
  }),
}));

vi.mock('#src/state/artifactStore.js', () => ({
  getArtifact: vi.fn(() => undefined),
  deleteArtifact: vi.fn(),
}));

vi.mock('#src/utils/llmUtils.js', () => ({
  invoke: vi.fn(),
  getNewRunnableConfig: vi.fn(() => ({ configurable: { thread_id: 't' } })),
}));

vi.mock('#src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/config.js')>()),
  GthConfig: {},
}));

const mockConfig = {
  contentSource: 'file',
  requirementSource: 'file',
  streamOutput: false,
  commands: { pr: { contentSource: 'github', requirementSource: 'github' } },
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: false,
  streamSessionInferenceLog: false,
  canInterruptInferenceWithEsc: false,
  includeCurrentDateAfterGuidelines: false,
  llm: new FakeListChatModel({ responses: ['review'] }) as BaseChatModel<
    BaseChatModelCallOptions,
    AIMessageChunk
  >,
} as GthConfig;

/** Everything the surface put in front of a person. */
const saidToUser = (): string =>
  [
    ...consoleUtilsMock.displayWarning.mock.calls,
    ...consoleUtilsMock.display.mock.calls,
    ...consoleUtilsMock.displayError.mock.calls,
  ]
    .map((call) => String(call[0]))
    .join('\n');

describe('[[EXT-159]] SURFACE — the review / pr verb says why the run ended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runnerInstanceMock.init.mockResolvedValue(undefined);
    runnerInstanceMock.processMessages.mockResolvedValue('a review');
    runnerInstanceMock.cleanup.mockResolvedValue(undefined);
    runnerInstanceMock.getTerminationReason.mockReturnValue(null);
  });

  it('states the classification when the run ended for a reason worth reporting', async () => {
    runnerInstanceMock.processMessages.mockRejectedValue(new Error('context length exceeded'));
    const overflow = terminationReason('runner.stream-error', 'exception', 'context_overflow');
    runnerInstanceMock.getTerminationReason.mockReturnValue(overflow);
    const { review } = await import('#src/modules/reviewModule.js');

    await review('src', 'preamble', 'a diff', mockConfig);

    expect(saidToUser()).toContain(TERMINATION_NOTICE_TITLE_PREFIX);
    // Read off the runner, not the screen: the value is the carrier and the sentence is derived.
    expect(runnerInstanceMock.getTerminationReason).toHaveBeenCalled();
    expect(saidToUser()).toContain(`${overflow.category}@${overflow.site}`);
  });

  /**
   * The ending this surface could not report at all before: a turn that returns without throwing.
   * The report is written, the process exits `ok`, and nothing anywhere said the answer was cut off
   * against the output cap rather than finished.
   */
  it('states a non-throwing ending that used to look exactly like success', async () => {
    runnerInstanceMock.processMessages.mockResolvedValue('half a rev');
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('agent.stream-stop-metadata', 'metadata', {
        category: 'output_truncated',
        detail: 'length',
      })
    );
    const { review } = await import('#src/modules/reviewModule.js');

    await review('src', 'preamble', 'a diff', mockConfig);

    expect(saidToUser()).toContain('output_truncated@agent.stream-stop-metadata');
  });

  it('adds nothing to a review that simply finished', async () => {
    runnerInstanceMock.getTerminationReason.mockReturnValue(
      terminationReason('runner.completed', 'control', 'completed')
    );
    const { review } = await import('#src/modules/reviewModule.js');

    await review('src', 'preamble', 'a diff', mockConfig);

    expect(saidToUser()).not.toContain(TERMINATION_NOTICE_TITLE_PREFIX);
  });

  /** Explaining a run must never be what breaks it. */
  it('survives a runner that cannot answer why the run ended', async () => {
    runnerInstanceMock.getTerminationReason.mockImplementation(() => {
      throw new Error('no such method');
    });
    const { review } = await import('#src/modules/reviewModule.js');

    await expect(review('src', 'preamble', 'a diff', mockConfig)).resolves.not.toThrow();
  });
});
