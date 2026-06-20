import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

const processMessagesMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());
const cleanupMock = vi.hoisted(() => vi.fn());
const ghDiffMock = vi.hoisted(() => vi.fn());
const ghPrViewMock = vi.hoisted(() => vi.fn());
const ghIssueMock = vi.hoisted(() => vi.fn());
const jiraIssueMock = vi.hoisted(() => vi.fn());
const jiraIssueLegacyMock = vi.hoisted(() => vi.fn());
const displayInfoMock = vi.hoisted(() => vi.fn());
const displayWarningMock = vi.hoisted(() => vi.fn());
const debugLogMock = vi.hoisted(() => vi.fn());

vi.mock('@gaunt-sloth/core/core/GthAgentRunner.js', () => ({
  GthAgentRunner: vi.fn(function GthAgentRunnerMock() {
    return {
      init: initMock,
      processMessages: processMessagesMock,
      cleanup: cleanupMock,
    };
  }),
}));

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  defaultStatusCallback: vi.fn(),
  displayInfo: displayInfoMock,
  displayWarning: displayWarningMock,
}));

vi.mock('@gaunt-sloth/core/utils/debugUtils.js', () => ({
  debugLog: debugLogMock,
}));

vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({
  createResolvers: vi.fn(() => ({})),
}));

vi.mock('@gaunt-sloth/review/sources/ghPrDiffSource.js', () => ({
  get: ghDiffMock,
}));

vi.mock('@gaunt-sloth/review/sources/ghPrViewSource.js', () => ({
  get: ghPrViewMock,
}));

vi.mock('@gaunt-sloth/review/sources/ghIssueSource.js', () => ({
  get: ghIssueMock,
}));

vi.mock('@gaunt-sloth/review/sources/jiraIssueSource.js', () => ({
  get: jiraIssueMock,
}));

vi.mock('@gaunt-sloth/review/sources/jiraIssueLegacySource.js', () => ({
  get: jiraIssueLegacyMock,
}));

describe('runPrDiscovery', () => {
  const config = {
    llm: { invoke: vi.fn() } as unknown as BaseChatModel,
    projectGuidelines: '.gsloth.guidelines.md',
    projectReviewInstructions: '.gsloth.review.md',
    contentProvider: 'github',
    requirementsProvider: 'github',
    streamOutput: false,
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: true,
    writeBinaryOutputsToFile: true,
    streamSessionInferenceLog: true,
    canInterruptInferenceWithEsc: true,
    includeCurrentDateAfterGuidelines: false,
    contentSource: 'github',
    requirementSource: 'github',
    commands: {
      pr: {
        contentProvider: 'github',
        requirementsProvider: 'github',
        discovery: {
          enabled: true,
          deterministicDiff: true,
        },
      },
      review: {},
    },
  } as Partial<GthConfig> as GthConfig;

  const jiraConfig = {
    ...config,
    requirementsProvider: 'jira',
    requirementSource: 'jira',
    builtInToolsConfig: { jira: { cloudId: 'cloud-1' } },
    commands: {
      pr: {
        contentProvider: 'github',
        requirementsProvider: 'jira',
        discovery: { enabled: true, deterministicDiff: true },
      },
      review: {},
    },
  } as Partial<GthConfig> as GthConfig;

  beforeEach(() => {
    vi.resetAllMocks();
    ghDiffMock.mockResolvedValue('Diff from gh');
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant/issues/359`);
    ghIssueMock.mockResolvedValue('Issue #359 requirements');
    jiraIssueMock.mockResolvedValue('ABC-123 requirements');
    jiraIssueLegacyMock.mockResolvedValue('ABC-123 legacy requirements');
  });

  it('skips the discovery agent when diff and requirements are deterministically resolved', async () => {
    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(config);

    expect(result).toEqual({
      diff: 'Diff from gh',
      requirements: 'Issue #359 requirements',
    });
    expect(ghDiffMock).toHaveBeenCalledWith(null, undefined);
    expect(ghPrViewMock).toHaveBeenCalledWith(null, undefined);
    // The full URL is passed through so cross-repo issue links resolve in the right repo.
    expect(ghIssueMock).toHaveBeenCalledWith(
      null,
      'https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant/issues/359'
    );
    expect(initMock).not.toHaveBeenCalled();
    expect(processMessagesMock).not.toHaveBeenCalled();
    expect(cleanupMock).not.toHaveBeenCalled();
    expect(displayInfoMock).toHaveBeenCalledWith(
      'Retrieved current-branch PR #360 metadata with gh.'
    );
    expect(displayInfoMock).toHaveBeenCalledWith(
      'Resolved the PR diff and requirements deterministically; skipping the discovery agent.'
    );
  });

  it('lowercases the host of a GitHub issue URL so the issue source accepts it', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: HTTPS://GITHUB.COM/Galvanized-Pukeko/gaunt-sloth-assistant/issues/359`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(config);

    expect(result.requirements).toBe('Issue #359 requirements');
    // The host is normalized to lowercase so the case-sensitive issue-reference
    // check in ghIssueSource still accepts the copied URL.
    expect(ghIssueMock).toHaveBeenCalledWith(
      null,
      'https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant/issues/359'
    );
    expect(initMock).not.toHaveBeenCalled();
  });

  it('omits the PR number from the metadata message when it cannot be parsed', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: for current branch
Description:
No linked ticket`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(config);

    expect(displayInfoMock).toHaveBeenCalledWith('Retrieved current-branch PR metadata with gh.');
  });

  it('does not let a spoofed "GitHub PR: #" line in the body set the displayed PR number', async () => {
    // The PR number is taken from the first line only, so a body echoing the label cannot spoof it.
    ghPrViewMock.mockResolvedValue(`GitHub PR: for current branch
Description:
GitHub PR: #999 (this line is part of the body, not the header)`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(config);

    expect(displayInfoMock).toHaveBeenCalledWith('Retrieved current-branch PR metadata with gh.');
    expect(displayInfoMock).not.toHaveBeenCalledWith(
      'Retrieved current-branch PR #999 metadata with gh.'
    );
  });

  it('resolves Jira requirements from an Atlassian browse URL when the provider is jira', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: https://company.atlassian.net/browse/ABC-123`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(jiraConfig);

    expect(result).toEqual({
      diff: 'Diff from gh',
      requirements: 'ABC-123 requirements',
    });
    expect(jiraIssueMock).toHaveBeenCalledWith({ cloudId: 'cloud-1' }, 'ABC-123');
    expect(jiraIssueLegacyMock).not.toHaveBeenCalled();
    expect(ghIssueMock).not.toHaveBeenCalled();
    expect(initMock).not.toHaveBeenCalled();
    expect(displayInfoMock).toHaveBeenCalledWith(
      'Discovered requirements from Jira issue ABC-123 linked in the PR description.'
    );
  });

  it('resolves Jira requirements from a bare key on the requirements line', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirement: ABC-123 must be implemented`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(jiraConfig);

    expect(result.requirements).toBe('ABC-123 requirements');
    expect(jiraIssueMock).toHaveBeenCalledWith({ cloudId: 'cloud-1' }, 'ABC-123');
  });

  it('resolves a Jira key from the head branch name', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Head branch: feature/ABC-123-add-useful-feature
Description:
No explicit ticket link`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(jiraConfig);

    expect(result.requirements).toBe('ABC-123 requirements');
    expect(jiraIssueMock).toHaveBeenCalledWith({ cloudId: 'cloud-1' }, 'ABC-123');
    expect(initMock).not.toHaveBeenCalled();
  });

  it('does not pick up a "Head branch:" line from the body when the header has none', async () => {
    // The Head branch scan is scoped to the structured header; a body line mimicking the label
    // (e.g. when headRefName is absent) must not inject a Jira key into the deterministic path.
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Head branch: feature/AB-99-spoofed-in-body`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(jiraConfig);

    expect(jiraIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('does not treat single-letter or lowercase branch tokens as Jira keys', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Head branch: feature/fix-123-and-A-1-cleanup
Description:
No linked ticket here`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(jiraConfig);

    expect(jiraIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('uses a single Atlassian browse URL from the body when no requirements line exists', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Implements https://company.atlassian.net/browse/ABC-123`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(jiraConfig);

    expect(result.requirements).toBe('ABC-123 requirements');
    expect(jiraIssueMock).toHaveBeenCalledWith({ cloudId: 'cloud-1' }, 'ABC-123');
  });

  it('leaves requirements to the discovery agent when several distinct Jira links are present', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
See https://company.atlassian.net/browse/ABC-123 and https://company.atlassian.net/browse/XYZ-9`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(jiraConfig);

    // Picking one of several "see also" links would review against the wrong requirements.
    expect(jiraIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('uses the legacy Jira source when the provider is jira-legacy', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: https://company.atlassian.net/browse/ABC-123`);

    const legacyConfig = {
      ...jiraConfig,
      requirementsProvider: 'jira-legacy',
      commands: {
        pr: {
          contentProvider: 'github',
          requirementsProvider: 'jira-legacy',
          discovery: { enabled: true, deterministicDiff: true },
        },
        review: {},
      },
    } as Partial<GthConfig> as GthConfig;

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(legacyConfig);

    expect(result.requirements).toBe('ABC-123 legacy requirements');
    expect(jiraIssueLegacyMock).toHaveBeenCalledWith({ cloudId: 'cloud-1' }, 'ABC-123');
    expect(jiraIssueMock).not.toHaveBeenCalled();
  });

  it('falls back to the discovery agent quietly when the Jira REST API has no credentials', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: https://company.atlassian.net/browse/ABC-123`);
    // No REST PAT/token configured (e.g. MCP-only setup) -> getJiraCredentials throws.
    jiraIssueMock.mockRejectedValue(new Error('Missing JIRA username.'));
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    const result = await runPrDiscovery(jiraConfig);

    // Deterministic requirements were not resolved, so the discovery agent runs to find them.
    expect(result.requirements).toBe('');
    expect(initMock).toHaveBeenCalled();
    expect(processMessagesMock).toHaveBeenCalled();
    // The REST failure must not be mis-reported as a metadata-retrieval failure.
    expect(displayWarningMock).not.toHaveBeenCalledWith(
      expect.stringContaining('could not retrieve current-branch PR metadata')
    );
    expect(debugLogMock).toHaveBeenCalledWith(expect.stringContaining('ABC-123'));
  });

  describe('discovery agent configuration', () => {
    const noLinkMetadata = `GitHub PR: #360
Description:
No linked ticket here`;

    const withDiscoveryConfig = (
      discovery: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) =>
      ({
        ...config,
        ...extra,
        commands: {
          pr: { contentProvider: 'github', requirementsProvider: 'github', discovery },
          review: {},
        },
      }) as Partial<GthConfig> as GthConfig;

    it('augments the auto allow-list with set_requirements', async () => {
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      processMessagesMock.mockResolvedValue(undefined);

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(
        withDiscoveryConfig({ allowedTools: ['gh_pr', 'mcp__jira__getJiraIssue'] })
      );

      const agentConfig = initMock.mock.calls.at(-1)?.[1] as GthConfig;
      expect(agentConfig.allowedTools).toEqual([
        'gh_pr',
        'mcp__jira__getJiraIssue',
        'set_requirements',
      ]);
    });

    it('keeps only set_requirements for an empty auto allow-list', async () => {
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      processMessagesMock.mockResolvedValue(undefined);

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(withDiscoveryConfig({ allowedTools: [] }));

      const agentConfig = initMock.mock.calls.at(-1)?.[1] as GthConfig;
      expect(agentConfig.allowedTools).toEqual(['set_requirements']);
    });

    it('never inherits the top-level allowedTools allow-list', async () => {
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      processMessagesMock.mockResolvedValue(undefined);

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      // A global empty allow-list (e.g. keeping review agents tool-free) must not strip the
      // discovery agent's set_requirements/set_diff tools.
      await runPrDiscovery(withDiscoveryConfig({}, { allowedTools: [] }));

      const agentConfig = initMock.mock.calls.at(-1)?.[1] as GthConfig;
      expect(agentConfig.allowedTools).toBeUndefined();
    });

    it('warns when no diff is set and the allow-list excludes both diff tools', async () => {
      // Deterministic fetch yields no diff, and the allow-list filters out gh_diff/set_diff, so
      // the discovery agent can never set one - warn instead of failing opaquely downstream.
      ghDiffMock.mockReset();
      ghDiffMock.mockResolvedValue('');
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      processMessagesMock.mockResolvedValue(undefined);

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(
        withDiscoveryConfig({ deterministicDiff: false, allowedTools: ['gh_pr'] })
      );

      expect(displayWarningMock).toHaveBeenCalledWith(expect.stringContaining('cannot set one'));
    });

    it('does not warn about diff tools when gh_diff survives the allow-list', async () => {
      ghDiffMock.mockReset();
      ghDiffMock.mockResolvedValue('');
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      processMessagesMock.mockResolvedValue(undefined);

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(
        withDiscoveryConfig({ deterministicDiff: false, allowedTools: ['gh_pr', 'gh_diff'] })
      );

      expect(displayWarningMock).not.toHaveBeenCalledWith(
        expect.stringContaining('cannot set one')
      );
    });

    it('gh_diff stores the fetched diff directly instead of echoing it through the model', async () => {
      // Deterministic fetch fails, so the discovery agent has to use the gh_diff tool.
      ghDiffMock.mockReset();
      ghDiffMock.mockRejectedValueOnce(new Error('no PR for current branch'));
      ghDiffMock.mockResolvedValueOnce('GitHub PR Diff: #360\n\ndiff body');
      ghPrViewMock.mockResolvedValue(noLinkMetadata);

      processMessagesMock.mockImplementation(async () => {
        const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
        const resolvers = vi.mocked(GthAgentRunner).mock.calls.at(-1)?.[1] as AgentResolvers;
        const tools = await resolvers.resolveTools!(config, undefined);
        const ghDiffTool = tools.find((t) => t.name === 'gh_diff')!;

        const confirmation = (await ghDiffTool.invoke({})) as string;

        expect(confirmation).toContain('set it as the review diff');
        expect(confirmation).toContain('Preview');
      });

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      const result = await runPrDiscovery(config);

      expect(processMessagesMock).toHaveBeenCalled();
      expect(result.diff).toBe('GitHub PR Diff: #360\n\ndiff body');
    });

    it('gh_issue returns an actionable message instead of an empty string on a rejected ref', async () => {
      ghPrViewMock.mockResolvedValue(noLinkMetadata);
      // The source returns null for a rejected reference (e.g. an http:// URL) or missing issue.
      ghIssueMock.mockResolvedValue(null);

      let toolResult = '';
      processMessagesMock.mockImplementation(async () => {
        const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
        const resolvers = vi.mocked(GthAgentRunner).mock.calls.at(-1)?.[1] as AgentResolvers;
        const tools = await resolvers.resolveTools!(config, undefined);
        const ghIssueTool = tools.find((t) => t.name === 'gh_issue')!;

        toolResult = (await ghIssueTool.invoke({
          issueId: 'http://github.com/owner/repo/issues/1',
        })) as string;
      });

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(config);

      // The model gets a reason it can act on, not a silent empty result.
      expect(toolResult).not.toBe('');
      expect(toolResult).toContain('No issue content was returned');
      expect(toolResult).toContain('https://github.com');
    });

    it('gh_pr returns the error as text instead of throwing on a failed fetch', async () => {
      // Deterministic metadata fetch succeeds (so the agent runs), but the tool call fails.
      ghPrViewMock.mockResolvedValueOnce(noLinkMetadata);
      ghPrViewMock.mockRejectedValueOnce(new Error('no PR for the current branch'));

      let toolResult = '';
      processMessagesMock.mockImplementation(async () => {
        const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
        const resolvers = vi.mocked(GthAgentRunner).mock.calls.at(-1)?.[1] as AgentResolvers;
        const tools = await resolvers.resolveTools!(config, undefined);
        const ghPrTool = tools.find((t) => t.name === 'gh_pr')!;
        toolResult = (await ghPrTool.invoke({})) as string;
      });

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(config);

      expect(toolResult).toContain('Could not fetch GitHub PR metadata');
      expect(toolResult).toContain('no PR for the current branch');
    });

    it('gh_diff returns the error as text instead of throwing on a failed fetch', async () => {
      ghDiffMock.mockReset();
      // Both the deterministic fetch and the tool call fail; the tool must not throw.
      ghDiffMock.mockRejectedValue(new Error('gh exploded'));
      ghPrViewMock.mockResolvedValue(noLinkMetadata);

      let toolResult = '';
      processMessagesMock.mockImplementation(async () => {
        const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
        const resolvers = vi.mocked(GthAgentRunner).mock.calls.at(-1)?.[1] as AgentResolvers;
        const tools = await resolvers.resolveTools!(config, undefined);
        const ghDiffTool = tools.find((t) => t.name === 'gh_diff')!;
        toolResult = (await ghDiffTool.invoke({})) as string;
      });

      const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
      await runPrDiscovery(config);

      expect(toolResult).toContain('Could not fetch the GitHub PR diff');
      expect(toolResult).toContain('the review diff was not changed');
    });
  });

  it('normalizes the case of the /issues/ path segment so the issue source accepts the URL', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Requirements: https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant/ISSUES/77`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(config);

    // The host and the /issues/ segment are lowercased; the owner/repo case is preserved.
    expect(ghIssueMock).toHaveBeenCalledWith(
      null,
      'https://github.com/Galvanized-Pukeko/gaunt-sloth-assistant/issues/77'
    );
    expect(initMock).not.toHaveBeenCalled();
  });

  it('resolves requirements from a GitHub closing keyword reference', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
Closes #359`);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    const result = await runPrDiscovery(config);

    expect(ghIssueMock).toHaveBeenCalledWith(null, '359');
    expect(result.requirements).toBe('Issue #359 requirements');
    expect(initMock).not.toHaveBeenCalled();
  });

  it('does not extract a requirements ref from a "requirements" word in the Title line', async () => {
    // The Title line is structured metadata, not the description; a title that merely mentions
    // "requirements" must not be misread as a requirements pointer (it would pull #42 here).
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Title: Clarify requirements doc, see #42
Description:
No linked ticket here`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(config);

    expect(ghIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('does not treat a prose mention of "requirements" (no label) as a requirements pointer', async () => {
    // Only a labelled "Requirements:" line should drive the deterministic path; prose that merely
    // mentions the word must defer to the discovery agent rather than pulling the nearby issue.
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
This tightens the requirements validation, see #42`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(config);

    expect(ghIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('skips the deterministic gh diff fetch when the content provider is not github', async () => {
    const textContentConfig = {
      ...config,
      contentProvider: 'text',
      commands: {
        pr: { contentProvider: 'text', requirementsProvider: 'github', auto: { enabled: true } },
        review: {},
      },
    } as Partial<GthConfig> as GthConfig;
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
No linked ticket here`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(textContentConfig);

    // gh pr diff only makes sense for the github content provider; for others the discovery
    // agent fetches the diff via its tools instead.
    expect(ghDiffMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('downgrades the metadata-fetch failure to debug when the content provider is not github', async () => {
    const textContentConfig = {
      ...config,
      contentProvider: 'text',
      commands: {
        pr: { contentProvider: 'text', requirementsProvider: 'github', auto: { enabled: true } },
        review: {},
      },
    } as Partial<GthConfig> as GthConfig;
    ghPrViewMock.mockRejectedValue(new Error('gh: not a GitHub repository'));
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(textContentConfig);

    // The expected failure in a non-github setup is noise, so it is logged at debug, not warned.
    expect(displayWarningMock).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not retrieve current-branch PR metadata')
    );
    expect(debugLogMock).toHaveBeenCalledWith(
      expect.stringContaining('Could not retrieve current-branch PR metadata')
    );
    expect(initMock).toHaveBeenCalled();
  });

  it('does not pick up a lone issue URL from the Title via the body fallback scan', async () => {
    // The last-resort "single issue URL anywhere" fallback must scan only the description body,
    // not the structured Title line - otherwise an issue URL in the title would be misread as
    // requirements even though no requirements line or closing keyword designates it.
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Title: See https://github.com/owner/repo/issues/77 for background
Description:
No linked ticket here`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(config);

    expect(ghIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('leaves requirements to the discovery agent when several issue URLs are linked', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
See https://github.com/owner/repo/issues/1 and https://github.com/owner/repo/issues/2`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');
    await runPrDiscovery(config);

    // Picking one of several "see also" links would review against the wrong requirements.
    expect(ghIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
  });

  it('falls back to the discovery agent when no Jira key is present in the PR metadata', async () => {
    ghPrViewMock.mockResolvedValue(`GitHub PR: #360
Description:
No linked ticket here`);
    processMessagesMock.mockResolvedValue(undefined);

    const { runPrDiscovery } = await import('#src/commands/prDiscovery.js');

    await runPrDiscovery(jiraConfig);

    expect(jiraIssueMock).not.toHaveBeenCalled();
    expect(initMock).toHaveBeenCalled();
    expect(processMessagesMock).toHaveBeenCalled();
    expect(cleanupMock).toHaveBeenCalled();
  });
});
