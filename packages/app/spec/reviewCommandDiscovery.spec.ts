import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * CFG-80 — `gth review` and requirements discovery, driven through commander the way a user
 * drives it. The review module is mocked so each cell can read the exact content the review would
 * be given; `git`, `gh`, the Jira source and the discovery agent runner are mocked at their own
 * seams so `reviewCommand` and `runReviewDiscovery` run for real between them.
 */

const {
  initConfigMock,
  reviewMock,
  gthAgentRunnerMock,
  runnerInstance,
  runGitMock,
  ghPrViewMock,
  jiraIssueMock,
  gitDiffGetMock,
  ghPrDiffGetMock,
  writeReviewFailureReportMock,
  setExitCodeMock,
  consoleUtilsMock,
} = vi.hoisted(() => {
  const runnerInstance = {
    init: vi.fn(),
    processMessages: vi.fn(),
    cleanup: vi.fn(),
    getTerminationReason: vi.fn(),
  };
  return {
    initConfigMock: vi.fn(),
    reviewMock: vi.fn(),
    gthAgentRunnerMock: vi.fn(),
    runnerInstance,
    runGitMock: vi.fn(),
    ghPrViewMock: vi.fn(),
    jiraIssueMock: vi.fn(),
    gitDiffGetMock: vi.fn(),
    ghPrDiffGetMock: vi.fn(),
    writeReviewFailureReportMock: vi.fn(),
    setExitCodeMock: vi.fn(),
    consoleUtilsMock: {
      display: vi.fn(),
      displayError: vi.fn(),
      displayInfo: vi.fn(),
      displayNotice: vi.fn(),
      displayWarning: vi.fn(),
      displaySuccess: vi.fn(),
      displayDebug: vi.fn(),
      defaultStatusCallback: vi.fn(),
    },
  };
});

vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleUtilsMock,
}));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  setExitCode: setExitCodeMock,
  getStringFromStdin: () => '',
}));
vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({ GthAgentRunner: gthAgentRunnerMock }));
vi.mock('@gaunt-sloth/review/modules/reviewModule.js', () => ({ review: reviewMock }));
vi.mock('@gaunt-sloth/review/modules/reviewFailureReport.js', () => ({
  writeReviewFailureReport: writeReviewFailureReportMock,
}));
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({ createResolvers: () => ({}) }));
vi.mock('@gaunt-sloth/review/utils/git.js', () => ({ runGit: runGitMock }));
vi.mock('@gaunt-sloth/review/sources/ghPrViewSource.js', () => ({ get: ghPrViewMock }));
vi.mock('@gaunt-sloth/review/sources/jiraIssueSource.js', () => ({ get: jiraIssueMock }));
vi.mock('@gaunt-sloth/review/sources/gitDiffSource.js', () => ({ get: gitDiffGetMock }));
vi.mock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({ get: ghPrDiffGetMock }));

const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n+changed';

function resolvedConfig(reviewCommandConfig: Record<string, unknown>): GthConfig {
  return {
    llm: {} as BaseChatModel,
    contentSource: 'git',
    requirementSource: 'jira',
    builtInToolsConfig: { jira: { cloudId: 'cloud-1' } },
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

/** Run `gth review <argv>` and return the content the review module was handed. */
async function runReview(
  reviewCommandConfig: Record<string, unknown>,
  argv: string[] = []
): Promise<string | undefined> {
  initConfigMock.mockResolvedValue(resolvedConfig(reviewCommandConfig));
  const { reviewCommand } = await import('#src/commands/reviewCommand.js');
  const program = new Command();
  reviewCommand(program, {});
  await program.parseAsync(['na', 'na', 'review', ...argv]);
  return reviewMock.mock.calls.at(-1)?.[2] as string | undefined;
}

describe('gth review with requirements discovery (CFG-80)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    gthAgentRunnerMock.mockImplementation(function GthAgentRunnerMock() {
      return runnerInstance;
    });
    runnerInstance.getTerminationReason.mockReturnValue(null);
    runnerInstance.processMessages.mockResolvedValue(undefined);
    gitDiffGetMock.mockResolvedValue(DIFF);
    ghPrDiffGetMock.mockResolvedValue(DIFF);
    runGitMock.mockResolvedValue('feature/ABC-123-add-thing\n');
    ghPrViewMock.mockRejectedValue(new Error('no pull requests found'));
    // Like the real source: no id, no issue.
    jiraIssueMock.mockImplementation(async (_config: unknown, id: string | undefined) =>
      id === 'ABC-123' ? 'ABC-123: the thing must be added' : null
    );
  });

  it('does not discover when commands.review.discovery is unset, exactly as before', async () => {
    const content = await runReview({});

    expect(runGitMock).not.toHaveBeenCalled();
    expect(ghPrViewMock).not.toHaveBeenCalled();
    // The configured requirement source is still consulted with no id, as it always was; what must
    // not happen is a lookup of the key discovery would have found in the branch name.
    expect(jiraIssueMock).toHaveBeenCalledTimes(1);
    expect(jiraIssueMock.mock.calls[0][1]).toBeUndefined();
    expect(gthAgentRunnerMock).not.toHaveBeenCalled();
    expect(content).not.toContain('discovered-requirements');
    expect(content).toContain(DIFF);
    expect(reviewMock).toHaveBeenCalledTimes(1);
  });

  it('does not discover when discovery is present but not enabled', async () => {
    await runReview({ discovery: { allowedTools: [] } });

    expect(runGitMock).not.toHaveBeenCalled();
    expect(gthAgentRunnerMock).not.toHaveBeenCalled();
  });

  it('skips discovery entirely when --requirements is given', async () => {
    jiraIssueMock.mockImplementation(async (_config: unknown, id: string | undefined) =>
      id === 'XYZ-9' ? 'XYZ-9: the explicit requirements' : null
    );

    const content = await runReview({ discovery: { enabled: true } }, ['-r', 'XYZ-9']);

    expect(runGitMock).not.toHaveBeenCalled();
    expect(ghPrViewMock).not.toHaveBeenCalled();
    expect(gthAgentRunnerMock).not.toHaveBeenCalled();
    expect(jiraIssueMock).toHaveBeenCalledTimes(1);
    expect(jiraIssueMock.mock.calls[0][1]).toBe('XYZ-9');
    expect(content).toContain('XYZ-9: the explicit requirements');
  });

  it('puts fast-path requirements ahead of the diff in what the review is given', async () => {
    const content = await runReview({ discovery: { enabled: true } });

    expect(gthAgentRunnerMock).not.toHaveBeenCalled();
    // Discovery replaces the id-less requirement-source lookup rather than adding to it.
    expect(jiraIssueMock.mock.calls.map((call) => call[1])).toEqual(['ABC-123']);
    expect(content).toBeDefined();
    const requirementsAt = content!.indexOf('ABC-123: the thing must be added');
    expect(requirementsAt).toBeGreaterThan(-1);
    expect(content!.indexOf(DIFF)).toBeGreaterThan(requirementsAt);
    expect(content).toContain('discovered-requirements');
  });

  it('gives the review what the discovery agent set with set_requirements', async () => {
    runGitMock.mockResolvedValue('feature/no-key\n');
    runnerInstance.processMessages.mockImplementation(async () => {
      const resolvers = gthAgentRunnerMock.mock.calls.at(-1)![1] as AgentResolvers;
      const agentConfig = runnerInstance.init.mock.calls.at(-1)![1] as GthConfig;
      const tools = await resolvers.resolveTools!(agentConfig, undefined);
      const setRequirements = tools.find(
        (t) => (t as StructuredToolInterface).name === 'set_requirements'
      ) as StructuredToolInterface;
      await setRequirements.invoke({ requirements: 'Requirements the agent found in Jira MCP' });
    });

    const content = await runReview({ discovery: { enabled: true } });

    expect(gthAgentRunnerMock).toHaveBeenCalledTimes(1);
    expect(content).toContain('Requirements the agent found in Jira MCP');
    expect(content!.indexOf(DIFF)).toBeGreaterThan(
      content!.indexOf('Requirements the agent found in Jira MCP')
    );
  });

  it('reviews without requirements when discovery finds none', async () => {
    runGitMock.mockResolvedValue('HEAD\n');

    const content = await runReview({ discovery: { enabled: true } });

    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(content).not.toContain('discovered-requirements');
    expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
      'Requirements discovery found no requirements; reviewing without them.'
    );
    expect(setExitCodeMock).not.toHaveBeenCalled();
  });

  it('fails the run, with a report, when the discovery agent throws', async () => {
    runGitMock.mockResolvedValue('feature/no-key\n');
    runnerInstance.processMessages.mockRejectedValue(new Error('Agent processing failed: 429'));

    await runReview({ discovery: { enabled: true } });

    expect(reviewMock).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayError).toHaveBeenCalledWith('Agent processing failed: 429');
    expect(writeReviewFailureReportMock).toHaveBeenCalledWith(
      expect.anything(),
      'REVIEW',
      'review',
      'Agent processing failed: 429'
    );
    expect(setExitCodeMock).toHaveBeenCalledWith(1);
  });

  it('takes the evidence from the PR under review, not the checked-out branch', async () => {
    // Checked out on a branch for ABC-123, reviewing PR 42, which is for XYZ-9.
    ghPrViewMock.mockResolvedValue(`GitHub PR: #42
Head branch: feature/XYZ-9-other-change
Description:
Something else entirely.`);
    jiraIssueMock.mockImplementation(async (_config: unknown, id: string | undefined) =>
      id ? `${id} requirements` : null
    );

    const content = await runReview({ discovery: { enabled: true } }, [
      '42',
      '--content-source',
      'github',
    ]);

    expect(ghPrViewMock).toHaveBeenCalledWith(null, '42');
    expect(runGitMock).not.toHaveBeenCalled();
    expect(jiraIssueMock.mock.calls.map((call) => call[1])).toEqual(['XYZ-9']);
    expect(content).toContain('XYZ-9 requirements');
    expect(content).not.toContain('ABC-123');
  });

  it('does not run discovery when the content fetch fails', async () => {
    gitDiffGetMock.mockRejectedValue(new Error('fatal: not a git repository'));

    await runReview({ discovery: { enabled: true } });

    expect(runGitMock).not.toHaveBeenCalled();
    expect(gthAgentRunnerMock).not.toHaveBeenCalled();
    expect(setExitCodeMock).toHaveBeenCalledWith(1);
  });
});
