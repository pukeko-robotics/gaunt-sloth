import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { execAsync } from '@gaunt-sloth/core/utils/systemUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

/**
 * Optional `gh api` file-read tool for the `review`/`pr` flow.
 *
 * When a PR diff truncates large changes, the review agent can use this tool to fetch the
 * FULL contents of a file straight from the GitHub REST contents endpoint
 * (`/repos/{owner}/{repo}/contents/{path}`) via the authenticated `gh` CLI, decode the
 * base64 payload, and read it as text.
 *
 * This deliberately reads through the GitHub API rather than the workspace filesystem, which
 * makes it safe to use under `pull_request_target` CI: the untrusted PR head is never checked
 * out, and no local fs access is required to inspect the changed files.
 *
 * The agent only supplies the repo-relative `path`. The owner/repo and the ref to read at are
 * bound to the PR under review (resolved from `gh pr view`), NOT supplied by the model — an
 * earlier version let the LLM pass owner/repo and it hallucinated them (e.g. reading
 * `pulumi/pulumi` for an integration-tests workflow), returning plausible-but-wrong content
 * into the review. Binding them to the PR context also closes the footgun of reading arbitrary
 * files from any public repo the model can name.
 *
 * The tool is OPTIONAL and self-guarding:
 * - The path is strictly validated so nothing LLM-supplied can inject shell metacharacters
 *   into the `gh api` invocation; the resolved owner/repo/ref are validated too.
 * - When `gh` is missing/unauthenticated, or there is no PR/GitHub context, the call fails
 *   gracefully and returns an explanatory string instead of throwing, so the agent can simply
 *   continue with the (truncated) diff it already has.
 */

const TOOL_NAME = 'gth_gh_read_file';

// PR ids reach us from the CLI; keep strict so nothing but a number can reach execAsync.
const PR_ID_PATTERN = /^\d+$/;
// owner/repo segments: GitHub login/repo naming, conservative allow-list (no shell metachars).
const OWNER_PATTERN = /^[A-Za-z0-9-_.]+$/;
const REPO_PATTERN = /^[A-Za-z0-9-_.]+$/;
// A git ref (branch, tag, or commit SHA). Disallow shell metacharacters and whitespace.
const REF_PATTERN = /^[A-Za-z0-9-_./]+$/;
// Repo-relative path. Allow slashes and common filename characters, but no shell metachars,
// no whitespace, and no parent-directory traversal.
const PATH_PATTERN = /^[A-Za-z0-9-_./]+$/;

const toolSchema = z.object({
  path: z
    .string()
    .describe('Repository-relative path to the file, e.g. "src/index.ts" (no leading slash)'),
});

type GhReadFileArgs = z.infer<typeof toolSchema>;

/** owner/repo/ref of the PR under review — the binding the model is NOT allowed to supply. */
export interface PrRepoContext {
  owner: string;
  repo: string;
  ref?: string;
}

interface GhPrViewRepoResponse {
  headRefName?: string;
  headRepository?: { name?: string };
  headRepositoryOwner?: { login?: string };
}

interface GhContentsResponse {
  type?: string;
  encoding?: string;
  content?: string;
  path?: string;
  size?: number;
}

/**
 * Resolves the owner/repo and head ref of the PR under review from the GitHub CLI, so the file
 * read is bound to the PR's own repository rather than anything the model supplies. With a prId
 * the PR is addressed explicitly; without one `gh pr view` resolves the current branch's PR
 * (the `gth pr` discovery mode). Returns the context, or an explanatory string on any failure.
 */
export async function resolvePrRepoContext(
  prId: string | undefined
): Promise<PrRepoContext | string> {
  if (prId !== undefined && !PR_ID_PATTERN.test(prId)) {
    return `Invalid pull request id "${prId}"; expected a numeric string.`;
  }

  const prSelector = prId ? ` ${prId}` : '';
  const ghCommand = `gh pr view${prSelector} --json headRefName,headRepository,headRepositoryOwner`;

  let raw: string;
  try {
    raw = await execAsync(ghCommand);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return (
      `Could not resolve the pull request repository via the GitHub API: ${reason}\n` +
      `This tool needs an authenticated gh CLI (https://cli.github.com/) with access to the repository. ` +
      `Continue the review using the diff you already have.`
    );
  }

  if (!raw) {
    return `No pull request metadata returned${prId ? ` for #${prId}` : ' for the current branch'}.`;
  }

  let parsed: GhPrViewRepoResponse;
  try {
    parsed = JSON.parse(raw) as GhPrViewRepoResponse;
  } catch (parseError) {
    debugLog(`Failed to parse gh pr view output as JSON:\n${raw}`);
    return `Failed to parse GitHub PR metadata: ${
      parseError instanceof Error ? parseError.message : String(parseError)
    }`;
  }

  const owner = parsed.headRepositoryOwner?.login;
  const repo = parsed.headRepository?.name;
  if (!owner || !repo) {
    return `GitHub PR metadata did not include the head repository owner/name; cannot read files for this PR.`;
  }

  return { owner, repo, ref: parsed.headRefName };
}

/**
 * Fetches the full contents of a single file from GitHub via the `gh api` CLI and decodes it.
 * Returns the decoded text, or a human/agent-readable explanation string on any failure
 * (graceful skip — never throws). owner/repo/ref come from the resolved PR context, not the LLM.
 */
export async function ghReadFileImpl(
  args: GhReadFileArgs,
  context: PrRepoContext
): Promise<string> {
  const { path } = args;
  const { owner, repo, ref } = context;

  if (!PATH_PATTERN.test(path) || path.includes('..')) {
    return `Invalid file path "${path}"; expected a repository-relative path without traversal.`;
  }
  // Defence-in-depth: the resolved owner/repo/ref are interpolated into the gh command too.
  if (!OWNER_PATTERN.test(owner)) {
    return `Invalid repository owner "${owner}"; expected a GitHub login/organisation name.`;
  }
  if (!REPO_PATTERN.test(repo)) {
    return `Invalid repository name "${repo}".`;
  }
  if (ref !== undefined && !REF_PATTERN.test(ref)) {
    return `Invalid git ref "${ref}".`;
  }

  // -q is intentionally avoided so we can decode base64 ourselves and keep behaviour explicit.
  const refQuery = ref ? `?ref=${ref}` : '';
  const ghCommand = `gh api /repos/${owner}/${repo}/contents/${path}${refQuery}`;

  try {
    const raw = await execAsync(ghCommand);
    if (!raw) {
      return `No content returned for ${owner}/${repo}/${path}${ref ? `@${ref}` : ''}.`;
    }

    let parsed: GhContentsResponse;
    try {
      parsed = JSON.parse(raw) as GhContentsResponse;
    } catch (parseError) {
      debugLog(`Failed to parse gh api contents output as JSON:\n${raw}`);
      return `Failed to parse GitHub API response for ${owner}/${repo}/${path}: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`;
    }

    if (Array.isArray(parsed)) {
      return `"${path}" is a directory, not a file. Provide a path to a single file.`;
    }
    if (parsed.type && parsed.type !== 'file') {
      return `"${path}" is not a regular file (type: ${parsed.type}).`;
    }
    if (parsed.encoding !== 'base64' || typeof parsed.content !== 'string') {
      // Large files (>1MB) are not returned inline by the contents endpoint.
      return `GitHub did not return inline base64 content for "${path}" (it may be too large to read via the contents endpoint).`;
    }

    const decoded = Buffer.from(parsed.content, 'base64').toString('utf8');
    const label = `${owner}/${repo}/${path}${ref ? `@${ref}` : ''}`;
    return `Full contents of ${label}:\n\n${decoded}`;
  } catch (error) {
    // Graceful skip: gh missing/unauthenticated, file not found, or no GitHub context.
    const reason = error instanceof Error ? error.message : String(error);
    return (
      `Could not read "${owner}/${repo}/${path}" via the GitHub API: ${reason}\n` +
      `This tool needs an authenticated gh CLI (https://cli.github.com/) with access to the repository. ` +
      `Continue the review using the diff you already have.`
    );
  }
}

/**
 * Built-in tool factory matching the repo's `get(config)` tool idiom (see gthWebFetchTool).
 *
 * `prId` identifies the PR under review (undefined in `gth pr` discovery mode → current branch).
 * The owner/repo/ref are resolved from it once, lazily, and memoised for the run, so the agent
 * cannot read files from any repo other than the one being reviewed.
 */
export function get(_: GthConfig, prId?: string): StructuredToolInterface {
  let contextPromise: Promise<PrRepoContext | string> | undefined;
  const getContext = (): Promise<PrRepoContext | string> => {
    if (!contextPromise) {
      contextPromise = resolvePrRepoContext(prId);
    }
    return contextPromise;
  };

  return tool(
    async (args: GhReadFileArgs) => {
      const context = await getContext();
      if (typeof context === 'string') {
        return context; // resolution failed — return the explanation as a graceful skip.
      }
      return ghReadFileImpl(args, context);
    },
    {
      name: TOOL_NAME,
      description:
        'Read the FULL contents of a single file from the pull request under review via the ' +
        'GitHub API. Use this when the PR diff is truncated and you need to see the complete ' +
        'file. Supply only the repository-relative path; the repository and ref are bound to ' +
        'the PR automatically. Reads through the GitHub API, not the local filesystem, so it is ' +
        'safe in pull_request_target CI.',
      schema: toolSchema,
    }
  ) as StructuredToolInterface;
}

export const GTH_GH_READ_FILE_TOOL_NAME = TOOL_NAME;
