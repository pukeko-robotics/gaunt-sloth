import type { CustomToolsConfig, GthConfig, ServerTool } from '@gaunt-sloth/core/config.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import {
  defaultStatusCallback,
  displayInfo,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { buildSystemMessages, readPromptFile } from '@gaunt-sloth/core/utils/llmUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { HumanMessage } from '@langchain/core/messages';
import { type BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResolvers } from '@gaunt-sloth/agent/resolvers.js';
import { get as getGhPrDiff } from '@gaunt-sloth/review/sources/ghPrDiffSource.js';
import { get as getGhPrView } from '@gaunt-sloth/review/sources/ghPrViewSource.js';
import { get as getGhIssue } from '@gaunt-sloth/review/sources/ghIssueSource.js';
import { get as getJiraIssue } from '@gaunt-sloth/review/sources/jiraIssueSource.js';
import { get as getJiraIssueLegacy } from '@gaunt-sloth/review/sources/jiraIssueLegacySource.js';
import type { ProviderConfig } from '@gaunt-sloth/review/sources/types.js';

export const GSLOTH_PR_DISCOVERY_PROMPT = '.gsloth.pr-discovery.md';

// The assistant package root (src|dist/commands -> package root), where the packaged default
// .gsloth.pr-discovery.md ships.
const assistantPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PrDiscoveryConfig {
  /**
   * Enable change requirements discovery when neither PR id nor requirements id is provided.
   * @default true
   */
  enabled?: boolean;
  /**
   * Fetch the current-branch PR diff with `gh pr diff` before invoking the discovery agent.
   * The discovery agent can still replace it with the `set_diff` tool if needed.
   * @default true
   */
  deterministicDiff?: boolean;
  /**
   * Optional tool overrides used only while the discovery agent runs.
   * When omitted, the normal configured tools remain available.
   */
  filesystem?: string[] | 'all' | 'read' | 'none';
  builtInTools?: string[];
  customTools?: CustomToolsConfig | false;
  tools?: StructuredToolInterface[] | BaseToolkit[] | ServerTool[];
  /**
   * Restrict the discovery agent to this allow-list of tool names, applied after every tool
   * source (filesystem, built-in, custom, MCP, A2A, and `tools`) is resolved. Unlike
   * `builtInTools`/`customTools`/`filesystem` (which gate whole tool groups), this trims the
   * final tool set by exact name, so it can pare down MCP server tools
   * (e.g. "mcp__jira__getJiraIssue") and the discovery helper tools
   * ("gh_pr"/"gh_diff"/"gh_issue"/"set_diff") to the minimum needed.
   *
   * `set_requirements` is always retained regardless, since it is how the discovery agent
   * records the requirements it found. When omitted, all resolved tools remain available; an
   * empty array keeps only `set_requirements`. The discovery agent never inherits the
   * top-level {@link GthConfig.allowedTools}; this property is its only allow-list.
   */
  allowedTools?: string[];
}

// PR discovery is an assistant feature; its config type lives here and is merged into the
// core command config via module augmentation instead of leaking into @gaunt-sloth/core.
declare module '@gaunt-sloth/core/config.js' {
  interface PrCommandConfig {
    /** Change requirements discovery (`gth pr` with no arguments) configuration. */
    discovery?: PrDiscoveryConfig;
  }
}

/**
 * Read the PR discovery agent prompt, honouring project / identity-profile
 * overrides and falling back to the default prompt shipped with the assistant package.
 */
export function readPrDiscoveryPrompt(
  config: Pick<GthConfig, 'identityProfile' | 'noDefaultPrompts'>
): string {
  return readPromptFile(
    GSLOTH_PR_DISCOVERY_PROMPT,
    config.identityProfile,
    config.noDefaultPrompts,
    assistantPackageDir
  );
}

export interface PrDiscoveryResult {
  diff: string;
  requirements: string;
}

type PrDiscoveryToolState = PrDiscoveryResult & {
  prMetadata: string;
};

const SetDiffArgsSchema = z.object({
  diff: z.string().describe('Complete pull request diff text to use for the review.'),
});

const SetRequirementsArgsSchema = z.object({
  requirements: z.string().describe('Complete requirements text to use for the review.'),
});

const GhDiffArgsSchema = z.object({
  prId: z
    .string()
    .optional()
    .describe('GitHub PR number. Omit to fetch the PR diff for the current branch.'),
});

const GhPrArgsSchema = z.object({
  prId: z
    .string()
    .optional()
    .describe('GitHub PR number. Omit to fetch metadata for the current branch PR.'),
});

const GhIssueArgsSchema = z.object({
  issueId: z
    .string()
    .describe(
      'GitHub issue number or full issue URL to retrieve. Use the full URL for issues in other repositories.'
    ),
});

export async function runPrDiscovery(config: GthConfig): Promise<PrDiscoveryResult> {
  const discoveryConfig = config.commands?.pr?.discovery;
  const state: PrDiscoveryToolState = {
    diff: '',
    requirements: '',
    prMetadata: '',
  };

  const contentSource = config.commands?.pr?.contentSource ?? config.contentSource;
  if (discoveryConfig?.deterministicDiff !== false) {
    if (contentSource !== 'github') {
      // The deterministic fast path uses `gh pr diff`, which only makes sense for the GitHub
      // content source. For any other source, skip it (rather than emitting a spurious gh
      // failure warning) and let the discovery agent fetch the diff via its tools.
      debugLog(
        `Skipped the deterministic gh diff fetch because the content source is "${contentSource}", not "github".`
      );
    } else {
      try {
        const diff = await getGhPrDiff(getGithubContentSourceConfig(config), undefined);
        state.diff = diff ?? '';
        if (state.diff) {
          displayInfo('Retrieved current-branch PR diff with gh.');
        }
      } catch (error) {
        displayWarning(
          `Could not deterministically retrieve current-branch PR diff: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  try {
    const prMetadata = await getGhPrView(getGithubContentSourceConfig(config), undefined);
    state.prMetadata = prMetadata ?? '';
    if (state.prMetadata) {
      const prNumber = extractGithubPrNumber(state.prMetadata);
      displayInfo(
        prNumber
          ? `Retrieved current-branch PR #${prNumber} metadata with gh.`
          : 'Retrieved current-branch PR metadata with gh.'
      );
      state.requirements = await discoverRequirementsFromPrMetadata(config, state.prMetadata);
    }
  } catch (error) {
    const message = `Could not retrieve current-branch PR metadata: ${error instanceof Error ? error.message : String(error)}`;
    // The metadata fetch (gh pr view) still runs for non-github content sources, because a
    // GitHub PR can legitimately be reviewed with a non-github diff source. But in a fully
    // non-github setup a failure here is expected noise, so log it at debug level rather than
    // warning - mirroring how the deterministic diff path stays quiet off GitHub.
    if (contentSource === 'github') {
      displayWarning(message);
    } else {
      debugLog(message);
    }
  }

  if (state.diff.trim() && state.requirements.trim()) {
    displayInfo(
      'Resolved the PR diff and requirements deterministically; skipping the discovery agent.'
    );
    return {
      diff: state.diff.trim(),
      requirements: state.requirements.trim(),
    };
  }

  // If the discovery agent is our only chance to obtain a diff (none was set deterministically)
  // but the allow-list filters out every diff tool, it can never set one and the command is
  // guaranteed to fail later with "Change requirements discovery did not produce a diff". Warn early so the
  // misconfiguration is obvious rather than surfacing as an opaque downstream failure.
  if (
    !state.diff.trim() &&
    discoveryConfig?.allowedTools &&
    !discoveryConfig.allowedTools.includes('gh_diff') &&
    !discoveryConfig.allowedTools.includes('set_diff')
  ) {
    displayWarning(
      'No diff yet and commands.pr.discovery.allowedTools excludes both "gh_diff" and "set_diff", so the discovery agent cannot set one. Add "gh_diff" (or "set_diff") to the allow-list, or enable deterministicDiff.'
    );
  }

  const runner = new GthAgentRunner(
    defaultStatusCallback,
    createPrDiscoveryResolvers(config, state)
  );
  try {
    await runner.init(undefined, getPrDiscoveryAgentConfig(config, discoveryConfig), undefined);
    await runner.processMessages([
      ...buildSystemMessages(config, readPrDiscoveryPrompt(config)),
      new HumanMessage(buildPrDiscoveryUserMessage(state)),
    ]);
  } finally {
    await runner.cleanup();
  }

  // The discovery agent streams its final text without a trailing newline, so emit a
  // blank line to separate it from the review agent's output that follows.
  displayInfo('');

  return {
    diff: state.diff.trim(),
    requirements: state.requirements.trim(),
  };
}

function getPrDiscoveryAgentConfig(
  config: GthConfig,
  discoveryConfig: PrDiscoveryConfig | undefined
): GthConfig {
  const baseTools = discoveryConfig?.tools ?? config.tools ?? [];
  const customTools =
    discoveryConfig && 'customTools' in discoveryConfig
      ? discoveryConfig.customTools
      : config.customTools;
  return {
    ...config,
    filesystem: discoveryConfig?.filesystem ?? config.filesystem,
    builtInTools: discoveryConfig?.builtInTools ?? config.builtInTools,
    customTools: customTools === false ? undefined : customTools,
    tools: baseTools,
    // The discovery agent must never inherit the top-level allow-list (e.g. a global
    // `allowedTools: []` meant to keep review agents tool-free would strip set_requirements
    // and silently neuter discovery). Only `commands.pr.discovery.allowedTools` applies here,
    // always augmented with set_requirements so the agent can record what it found. The
    // agent applies this list after every tool source is resolved, so it also gates tools
    // supplied via `tools` in config.
    allowedTools: discoveryConfig?.allowedTools
      ? [...new Set([...discoveryConfig.allowedTools, 'set_requirements'])]
      : undefined,
  };
}

function createPrDiscoveryResolvers(
  config: GthConfig,
  state: PrDiscoveryToolState
): AgentResolvers {
  const baseResolvers = createResolvers();
  return {
    ...baseResolvers,
    resolveTools: async (effectiveConfig, command) => {
      const baseTools = baseResolvers.resolveTools
        ? await baseResolvers.resolveTools(effectiveConfig, command)
        : [];
      return [...baseTools, ...createPrDiscoveryTools(config, state)];
    },
  };
}

function createPrDiscoveryTools(
  config: GthConfig,
  state: PrDiscoveryToolState
): StructuredToolInterface[] {
  const setDiff = tool(
    async ({ diff }: z.infer<typeof SetDiffArgsSchema>): Promise<string> => {
      state.diff = diff;
      return 'Diff set for PR review.';
    },
    {
      name: 'set_diff',
      description: 'Set the exact pull request diff text that the PR review should use.',
      schema: SetDiffArgsSchema,
    }
  );

  const setRequirements = tool(
    async ({ requirements }: z.infer<typeof SetRequirementsArgsSchema>): Promise<string> => {
      state.requirements = requirements;
      return 'Requirements set for PR review.';
    },
    {
      name: 'set_requirements',
      description: 'Set the exact requirements text that the PR review should use.',
      schema: SetRequirementsArgsSchema,
    }
  );

  const ghPr = tool(
    async ({ prId }: z.infer<typeof GhPrArgsSchema>): Promise<string> => {
      try {
        return (await getGhPrView(getGithubContentSourceConfig(config), prId)) ?? '';
      } catch (error) {
        // Return the failure as text rather than throwing, so a single failed fetch (e.g. no PR
        // for the current branch) lets the model adapt instead of aborting the whole discovery
        // run - consistent with gh_issue's actionable-message behaviour.
        return `Could not fetch GitHub PR metadata: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    {
      name: 'gh_pr',
      description:
        'Fetch GitHub pull request metadata including title, branch names, URL, and description/body. Omit prId to fetch the current branch PR.',
      schema: GhPrArgsSchema,
    }
  );

  const ghDiff = tool(
    async ({ prId }: z.infer<typeof GhDiffArgsSchema>): Promise<string> => {
      let diff: string;
      try {
        diff = (await getGhPrDiff(getGithubContentSourceConfig(config), prId)) ?? '';
      } catch (error) {
        // Surface the failure as text instead of throwing so the discovery run continues and the
        // model can try another approach - consistent with gh_pr/gh_issue.
        return `Could not fetch the GitHub PR diff: ${error instanceof Error ? error.message : String(error)}; the review diff was not changed.`;
      }
      if (!diff) {
        return 'No diff content was returned by GitHub CLI; the review diff was not changed.';
      }
      // Store the diff directly instead of returning it: echoing a large diff into the
      // model context just so the model can copy it verbatim into set_diff doubles token
      // cost and lets weaker models truncate or corrupt the diff on the way through.
      state.diff = diff;
      const preview = diff.split('\n').slice(0, 10).join('\n');
      return `Retrieved the PR diff (${diff.length} characters) and set it as the review diff; no need to call set_diff. Preview:\n${preview}`;
    },
    {
      name: 'gh_diff',
      description:
        'Fetch a GitHub pull request diff using GitHub CLI and set it as the review diff. ' +
        'Omit prId to fetch the PR for the current branch. ' +
        'Returns a confirmation with a short preview; the full diff is stored without needing set_diff.',
      schema: GhDiffArgsSchema,
    }
  );

  const ghIssue = tool(
    async ({ issueId }: z.infer<typeof GhIssueArgsSchema>): Promise<string> => {
      const issue = await getGhIssue(getGithubRequirementSourceConfig(config), issueId);
      if (issue) {
        return issue;
      }
      // The source returns null on a rejected reference (only a bare number or a full
      // https://github.com/<owner>/<repo>/issues/<number> URL is accepted - note http:// and
      // other hosts are rejected), or when the issue has no content. Surface an actionable
      // reason instead of an empty string so the model can self-correct rather than stall.
      return `No issue content was returned for "${issueId}". The reference may be invalid (expected an issue number or a full https://github.com/<owner>/<repo>/issues/<number> URL) or the issue may not exist.`;
    },
    {
      name: 'gh_issue',
      description: 'Fetch a GitHub issue description using GitHub CLI.',
      schema: GhIssueArgsSchema,
    }
  );

  return [setDiff, setRequirements, ghPr, ghDiff, ghIssue];
}

function getSourceConfig(config: unknown): ProviderConfig | null {
  return config && typeof config === 'object' ? (config as ProviderConfig) : null;
}

function getGithubContentSourceConfig(config: GthConfig): ProviderConfig | null {
  return getSourceConfig(config.contentSourceConfig?.github);
}

function getGithubRequirementSourceConfig(config: GthConfig): ProviderConfig | null {
  return getSourceConfig(config.requirementSourceConfig?.github);
}

function getJiraRequirementSourceConfig(config: GthConfig): ProviderConfig | null {
  // builtInToolsConfig.jira takes precedence because it is the canonical Jira credential location
  // (shared with the Jira MCP/built-in tooling); the requirementSource entry is the older
  // source-scoped fallback. If a user sets both with different cloudIds, the deterministic fast
  // path uses the built-in config - keep them in sync to avoid surprises.
  return getSourceConfig(config.builtInToolsConfig?.jira ?? config.requirementSourceConfig?.jira);
}

/**
 * Deterministically resolve requirements from PR metadata, using a fast path that matches
 * the configured requirement source. Falls back to '' when nothing is found, leaving the
 * discovery agent to resolve requirements.
 */
async function discoverRequirementsFromPrMetadata(
  config: GthConfig,
  prMetadata: string
): Promise<string> {
  const requirementSource = config.commands?.pr?.requirementSource ?? config.requirementSource;

  if (requirementSource === 'jira' || requirementSource === 'jira-legacy') {
    const issueKey = extractJiraIssueKey(prMetadata);
    if (!issueKey) {
      return '';
    }
    const jiraConfig = getJiraRequirementSourceConfig(config);
    try {
      const requirements =
        (requirementSource === 'jira-legacy'
          ? await getJiraIssueLegacy(jiraConfig, issueKey)
          : await getJiraIssue(jiraConfig, issueKey)) ?? '';
      if (requirements) {
        displayInfo(
          `Discovered requirements from Jira issue ${issueKey} linked in the PR description.`
        );
      }
      return requirements;
    } catch (error) {
      // The deterministic Jira fast path uses the Jira REST API, which needs its own
      // credentials (PAT / base64 token) that are independent of any Jira MCP OAuth. When
      // those aren't configured - e.g. an MCP-only setup - skip quietly and let the discovery
      // agent resolve requirements via its tools (e.g. the Jira MCP server).
      debugLog(
        `Skipped the deterministic Jira REST lookup for ${issueKey}: ${error instanceof Error ? error.message : String(error)}`
      );
      return '';
    }
  }

  const requirementsIssueRef = extractRequirementsGithubIssueRef(prMetadata);
  if (!requirementsIssueRef) {
    return '';
  }
  const requirements =
    (await getGhIssue(getGithubRequirementSourceConfig(config), requirementsIssueRef)) ?? '';
  if (requirements) {
    displayInfo(
      `Discovered requirements from GitHub issue ${formatGithubIssueRef(requirementsIssueRef)} linked in the PR description.`
    );
  }
  return requirements;
}

// Match an explicit "Requirements:" label (singular or plural) rather than any line that merely
// mentions the word. Prose like "This tightens the requirements validation, see #42" must not be
// treated as a requirements pointer; only a labelled line (e.g. "Requirements: <link>") is.
const REQUIREMENTS_LABEL_PATTERN = /requirements?\s*:/i;
// Owner/repo segments are restricted to GitHub's name charset; anything looser would let a
// crafted PR description smuggle shell metacharacters into the `gh issue view` command line.
const GITHUB_ISSUE_URL_PATTERN = /(?:https?:\/\/)?github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/i;
// GitHub closing keywords (https://docs.github.com/en/issues/tracking-your-work-with-issues/linking-a-pull-request-to-an-issue)
const GITHUB_CLOSING_KEYWORD_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)\b/i;

/**
 * Return just the PR description body - the lines after the "Description:" marker emitted by
 * {@link formatPrView}. The requirements-line scan must not see the structured header fields
 * (notably "Title:"), or a title like "Clarify requirements doc, see #42" would be misread as a
 * requirements pointer. Falls back to the full text when no marker is present.
 */
function getPrDescriptionBody(prMetadata: string): string {
  const lines = prMetadata.split('\n');
  const descriptionIndex = lines.findIndex((line) => line.trim() === 'Description:');
  return descriptionIndex === -1 ? prMetadata : lines.slice(descriptionIndex + 1).join('\n');
}

/**
 * Return just the structured header that {@link formatPrView} emits before the "Description:"
 * marker (PR number, Title, URL, branches). Scans for structured fields (e.g. "Head branch:")
 * must use this rather than the full text, or a body line mimicking a header label could spoof
 * a value. Falls back to the full text when no marker is present.
 */
function getPrMetadataHeader(prMetadata: string): string {
  const lines = prMetadata.split('\n');
  const descriptionIndex = lines.findIndex((line) => line.trim() === 'Description:');
  return descriptionIndex === -1 ? prMetadata : lines.slice(0, descriptionIndex).join('\n');
}

/**
 * Extract a GitHub issue reference (a full issue URL or a bare issue number) that the PR
 * description explicitly designates as requirements. URLs are returned whole rather than as
 * extracted numbers, because a cross-repo issue URL reduced to its number would make
 * `gh issue view` fetch the same-numbered issue from the wrong (current) repository.
 */
function extractRequirementsGithubIssueRef(prMetadata: string): string | undefined {
  const requirementsLine = getPrDescriptionBody(prMetadata)
    .split('\n')
    .find((line) => REQUIREMENTS_LABEL_PATTERN.test(line));

  if (requirementsLine) {
    const urlMatch = requirementsLine.match(GITHUB_ISSUE_URL_PATTERN);
    if (urlMatch) {
      return normalizeGithubIssueUrl(urlMatch[0]);
    }
    const hashIssueMatch = requirementsLine.match(/#(\d+)/);
    if (hashIssueMatch?.[1]) {
      return hashIssueMatch[1];
    }
  }

  // A closing keyword ("Closes #123", "Fixes #123") is an explicit statement that the PR
  // implements that issue, so it is a reliable requirements pointer. Searching the full
  // formatted metadata is intentional: non-description fields are structured labels emitted by
  // formatPrView, and a closing-keyword phrase in the title is still an explicit PR signal.
  const closingMatch = prMetadata.match(GITHUB_CLOSING_KEYWORD_PATTERN);
  if (closingMatch?.[1]) {
    return closingMatch[1];
  }

  // Otherwise fall back to an issue URL anywhere in the body, but only when it is
  // unambiguous: with several distinct issue links (e.g. "see also" references) picking one
  // would silently review against the wrong requirements, so leave it to the discovery agent.
  // Scan only the description body (not the structured header), consistent with the
  // requirements-line scan above - a lone issue URL in the Title is not a requirements pointer.
  const bodyUrls = new Set(
    Array.from(
      getPrDescriptionBody(prMetadata).matchAll(new RegExp(GITHUB_ISSUE_URL_PATTERN, 'gi'))
    ).map((match) => normalizeGithubIssueUrl(match[0]))
  );
  if (bodyUrls.size === 1) {
    return bodyUrls.values().next().value;
  }

  return undefined;
}

function normalizeGithubIssueUrl(url: string): string {
  // Lowercase the host and the "/issues/" path segment so a copied "GITHUB.COM/.../ISSUES/77"
  // URL still satisfies the case-sensitive issue-reference check in ghIssueSource. Owner/repo
  // segments are left untouched because they are case-sensitive on GitHub.
  const withoutProtocol = url.replace(/^https?:\/\//i, '');
  return `https://${withoutProtocol
    .replace(/^github\.com/i, 'github.com')
    .replace(/\/issues\//i, '/issues/')}`;
}

function formatGithubIssueRef(ref: string): string {
  return /^\d+$/.test(ref) ? `#${ref}` : ref;
}

function extractGithubPrNumber(prMetadata: string): string | undefined {
  // formatPrView emits "GitHub PR: #<number>" as the first line when the number is known. Anchor
  // to that first line so a PR body that merely contains the literal "GitHub PR: #123" cannot
  // spoof the number shown in the info message.
  return prMetadata.split('\n', 1)[0].match(/^GitHub PR:\s*#(\d+)/)?.[1];
}

// Jira project keys are at least two letters followed by letters/digits (e.g. ABC-123,
// never A-1). Kept case-sensitive for bare keys: lowercase look-alikes in branch names or
// prose ("fix-123") are too ambiguous for the deterministic path.
const JIRA_ISSUE_KEY_PATTERN = /\b([A-Z]{2}[A-Z0-9]*-\d+)\b/;
// Atlassian browse URL, e.g. https://company.atlassian.net/browse/ABC-123. Unlike bare keys,
// URL-extracted keys are matched case-insensitively and normalized because the structured
// /browse/<key> path makes the intent clear while copied URLs can vary in casing.
const ATLASSIAN_BROWSE_URL_PATTERN = /atlassian\.net\/browse\/([A-Z]{2}[A-Z0-9]*-\d+)/i;

function extractJiraIssueKey(prMetadata: string): string | undefined {
  const requirementsLine = getPrDescriptionBody(prMetadata)
    .split('\n')
    .find((line) => REQUIREMENTS_LABEL_PATTERN.test(line));

  if (requirementsLine) {
    const urlMatch = requirementsLine.match(ATLASSIAN_BROWSE_URL_PATTERN);
    if (urlMatch?.[1]) {
      return urlMatch[1].toUpperCase();
    }
    // Bare ticket key on a requirements line, e.g. "Requirements: ABC-123"
    const keyMatch = requirementsLine.match(JIRA_ISSUE_KEY_PATTERN);
    if (keyMatch?.[1]) {
      return keyMatch[1];
    }
  }

  // A key in the head branch name (feature/ABC-123-description convention) is an explicit
  // statement of which issue the branch implements. Scan only the structured header so a body
  // line mimicking "Head branch: feature/XX-1-..." cannot inject a key when headRefName is absent.
  const headBranchLine = getPrMetadataHeader(prMetadata)
    .split('\n')
    .find((line) => line.startsWith('Head branch:'));
  const branchKeyMatch = headBranchLine?.match(JIRA_ISSUE_KEY_PATTERN);
  if (branchKeyMatch?.[1]) {
    return branchKeyMatch[1];
  }

  // Otherwise fall back to an Atlassian browse URL anywhere in the body, but - mirroring the
  // GitHub path - only when it is unambiguous: with several distinct links (e.g. "see also"
  // references) picking one would silently review against the wrong requirements. Scan only the
  // description body (not the structured header), consistent with the requirements-line scan.
  const bodyKeys = new Set(
    Array.from(
      getPrDescriptionBody(prMetadata).matchAll(new RegExp(ATLASSIAN_BROWSE_URL_PATTERN, 'gi'))
    ).map((match) => match[1].toUpperCase())
  );
  if (bodyKeys.size === 1) {
    return bodyKeys.values().next().value;
  }

  return undefined;
}

function buildPrDiscoveryUserMessage(state: PrDiscoveryToolState): string {
  const diffStatus = state.diff
    ? 'A current-branch PR diff has already been deterministically retrieved and set. Verify whether it is sufficient; replace it (gh_diff sets it automatically, or use set_diff) only if you find a better exact diff.'
    : 'No PR diff has been set yet. Retrieve the PR diff with gh_diff, which stores it automatically; use set_diff only for a diff obtained some other way.';

  const requirementsStatus = state.requirements
    ? 'Requirements have already been retrieved from the PR description. Verify whether they are sufficient; replace them with set_requirements only if you find better exact requirements.'
    : 'Requirements have not been set yet. First inspect the PR description below for an explicit requirements link before trying issue-number guesses.';

  const prMetadataBlock = state.prMetadata
    ? `\n\nCurrent PR metadata already fetched with gh_pr:\n<pr-metadata>\n${state.prMetadata}\n</pr-metadata>`
    : '';

  return `${diffStatus}\n\n${requirementsStatus}${prMetadataBlock}

Discover the requirements for the current PR, then call set_requirements. Prefer an explicit requirements link from the PR description over searching nearby issue numbers. You may inspect linked GitHub issues, Jira MCP tools, and any other configured tools. Finish only after the diff and requirements have both been set.`;
}
