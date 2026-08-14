import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { GTH_GH_READ_FILE_TOOL_NAME } from '@gaunt-sloth/review/tools/ghReadFileTool.js';

/**
 * CFG-53 — `gth review --content-source github` and the `gth_gh_read_file` gate.
 *
 * These cases drive the WHOLE path a user drives: commander parses the flag, `reviewCommand`
 * resolves it and initialises config, the real review module decides whether to inject the
 * GitHub file-read tool, and the config that decision lands in is captured off
 * `GthAgentRunner.init` — the object the agent is actually handed. Nothing between the flag and
 * the tool list is stubbed, which is the point: the defect this pins was a wiring gap, and every
 * component on its own was correct.
 *
 * The flag is the only input that varies within each pair, so a case cannot pass because some
 * other part of the fixture happens to select GitHub.
 */

// `vi.hoisted` because this spec statically imports the tool-name constant, which pulls core's
// config module in at hoist time — before a plain top-level `const` would be initialised.
const {
  gthAgentRunnerInstanceMock,
  gthAgentRunnerMock,
  initConfigMock,
  consoleUtilsMock,
  llmUtilsMock,
  resolversMock,
  ghPrDiffGetMock,
  gitDiffGetMock,
  fileSourceGetMock,
} = vi.hoisted(() => {
  const runnerInstance = {
    init: vi.fn(),
    processMessages: vi.fn(),
    cleanup: vi.fn(),
  };
  return {
    gthAgentRunnerInstanceMock: runnerInstance,
    gthAgentRunnerMock: vi.fn(function GthAgentRunnerMock() {
      return runnerInstance;
    }),
    initConfigMock: vi.fn(),
    consoleUtilsMock: {
      display: vi.fn(),
      displayError: vi.fn(),
      displayInfo: vi.fn(),
      displayWarning: vi.fn(),
      displaySuccess: vi.fn(),
      displayDebug: vi.fn(),
      defaultStatusCallback: vi.fn(),
      initSessionLogging: vi.fn(),
      flushSessionLog: vi.fn(),
      stopSessionLogging: vi.fn(),
    },
    llmUtilsMock: {
      readBackstory: vi.fn(),
      readGuidelines: vi.fn(),
      readReviewInstructions: vi.fn(),
      readSystemPrompt: vi.fn(),
    },
    resolversMock: { createResolvers: vi.fn() },
    ghPrDiffGetMock: vi.fn(),
    gitDiffGetMock: vi.fn(),
    fileSourceGetMock: vi.fn(),
  };
});

vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: gthAgentRunnerMock,
}));

// PARTIAL mock: the review module resolves the built-in tool registry through this same module
// (`isGhReadFileToolEnabled`), and these cases assert what config actually resolves to, so
// everything but `initConfig` has to be the real implementation.
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleUtilsMock,
}));

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  ...llmUtilsMock,
}));

vi.mock('@gaunt-sloth/agent/resolvers.js', () => resolversMock);

// The content sources are reached through a dynamic import of the path in CONTENT_SOURCES; mock
// them so no case shells out to `gh` or `git`.
vi.mock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({ get: ghPrDiffGetMock }));
vi.mock('@gaunt-sloth/review/sources/gitDiffSource.js', () => ({ get: gitDiffGetMock }));
vi.mock('@gaunt-sloth/review/sources/fileSource.js', () => ({ get: fileSourceGetMock }));

/**
 * A resolved config with NO GitHub anywhere: root content source `file`, and whatever the case
 * puts under `commands.review`. `output.header: 'none'` and `streamOutput` keep the run silent and
 * free of the progress indicator's interval; `writeOutputToFile: false` keeps it off the disk.
 */
function resolvedConfig(reviewCommandConfig: Record<string, unknown>): GthConfig {
  return {
    llm: {} as BaseChatModel,
    contentSource: 'file',
    requirementSource: 'file',
    streamOutput: true,
    writeOutputToFile: false,
    useColour: false,
    filesystem: 'none',
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    output: { header: 'none' },
    commands: { review: reviewCommandConfig },
  } as unknown as GthConfig;
}

/**
 * Run `gth review` with the given argv tail and return the config the agent runner was handed —
 * the same object the review module injects into, so the tool list on it is the tool list the
 * agent would get.
 */
async function runReview(
  reviewCommandConfig: Record<string, unknown>,
  argv: string[]
): Promise<GthConfig> {
  initConfigMock.mockResolvedValue(resolvedConfig(reviewCommandConfig));
  // Cases below run this twice; only the runner's call log is cleared, so the content-source
  // mocks can still be counted across both runs of a pair.
  gthAgentRunnerInstanceMock.init.mockClear();

  const { reviewCommand } = await import('#src/commands/reviewCommand.js');
  const program = new Command();
  reviewCommand(program, {});
  await program.parseAsync(['na', 'na', 'review', ...argv]);

  expect(gthAgentRunnerInstanceMock.init).toHaveBeenCalledTimes(1);
  return gthAgentRunnerInstanceMock.init.mock.calls[0][1] as GthConfig;
}

const hasGhReadFile = (config: GthConfig): boolean =>
  (config.tools ?? []).some(
    (t) =>
      typeof t === 'object' && t !== null && 'name' in t && t.name === GTH_GH_READ_FILE_TOOL_NAME
  );

describe('CFG-53 the --content-source flag and the gh read-file tool gate', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    gthAgentRunnerMock.mockImplementation(function () {
      return gthAgentRunnerInstanceMock;
    });
    gthAgentRunnerInstanceMock.init.mockResolvedValue(undefined);
    gthAgentRunnerInstanceMock.processMessages.mockResolvedValue('REVIEW');
    gthAgentRunnerInstanceMock.cleanup.mockResolvedValue(undefined);

    llmUtilsMock.readBackstory.mockReturnValue('BACKSTORY');
    llmUtilsMock.readGuidelines.mockReturnValue('GUIDELINES');
    llmUtilsMock.readReviewInstructions.mockReturnValue('REVIEW INSTRUCTIONS');
    llmUtilsMock.readSystemPrompt.mockReturnValue('');

    resolversMock.createResolvers.mockReturnValue({
      resolveMiddleware: vi.fn(async (m: unknown) => m ?? []),
    });

    ghPrDiffGetMock.mockResolvedValue('GITHUB PR DIFF');
    gitDiffGetMock.mockResolvedValue('LOCAL GIT DIFF');
    fileSourceGetMock.mockResolvedValue('FILE CONTENT');
  });

  it('injects the tool when the flag selects github, and not when the same fixture runs without it', async () => {
    // The defect: config names no GitHub anywhere, the flag is the only thing that does.
    expect(hasGhReadFile(await runReview({}, ['--content-source', 'github']))).toBe(true);

    // Control on the SAME fixture: without the flag nothing selects GitHub, so nothing is
    // injected. This is what makes the case above an assertion about the FLAG rather than about
    // something else in the fixture.
    expect(hasGhReadFile(await runReview({}, []))).toBe(false);
  });

  // The two directions are separate cases on purpose: a single case would stop at the first
  // assertion, and which direction broke is exactly what a failure needs to say.
  it('lets the flag turn the tool ON over a per-command content source that says otherwise', async () => {
    // `commands.review` says file, the flag says github. The flag decides where the diff comes
    // from, so it has to decide the tool too — and a top-level-only override would still lose to
    // this per-command value.
    expect(
      hasGhReadFile(await runReview({ contentSource: 'file' }, ['--content-source', 'github']))
    ).toBe(true);
  });

  it('lets the flag turn the tool OFF over a per-command content source of github', async () => {
    // The mirror image: `commands.review` says github, the flag says git. The run reviews a local
    // diff with no pull request behind it, so the GitHub file-read tool must not be there either.
    expect(
      hasGhReadFile(await runReview({ contentSource: 'github' }, ['--content-source', 'git']))
    ).toBe(false);
  });

  it('still injects the tool for a config-selected github review with no flag', async () => {
    expect(hasGhReadFile(await runReview({ contentSource: 'github' }, []))).toBe(true);
  });

  // The tool cases above would still pass if the flag were wired to the tool gate and nowhere
  // else. This pins the other half of the same invariant — the flag also names where the diff
  // comes from — so the two can never drift apart again without a test saying so.
  it('reads the diff from the source the flag names, over the per-command config', async () => {
    await runReview({ contentSource: 'file' }, ['--content-source', 'github']);
    expect(ghPrDiffGetMock).toHaveBeenCalled();
    expect(gitDiffGetMock).not.toHaveBeenCalled();

    await runReview({ contentSource: 'github' }, ['--content-source', 'git']);
    expect(gitDiffGetMock).toHaveBeenCalled();
    expect(ghPrDiffGetMock).toHaveBeenCalledTimes(1); // still just the first run's call
  });
});
