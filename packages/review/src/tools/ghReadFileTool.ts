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
 * The tool is OPTIONAL and self-guarding:
 * - Inputs are strictly validated so nothing user/LLM-supplied can inject shell metacharacters
 *   into the `gh api` invocation.
 * - When `gh` is missing/unauthenticated, or there is no PR/GitHub context, the call fails
 *   gracefully and returns an explanatory string instead of throwing, so the agent can simply
 *   continue with the (truncated) diff it already has.
 */

const TOOL_NAME = 'gth_gh_read_file';

// owner/repo segments: GitHub login/repo naming, conservative allow-list (no shell metachars).
const OWNER_PATTERN = /^[A-Za-z0-9-_.]+$/;
const REPO_PATTERN = /^[A-Za-z0-9-_.]+$/;
// A git ref (branch, tag, or commit SHA). Disallow shell metacharacters and whitespace.
const REF_PATTERN = /^[A-Za-z0-9-_./]+$/;
// Repo-relative path. Allow slashes and common filename characters, but no shell metachars,
// no whitespace, and no parent-directory traversal.
const PATH_PATTERN = /^[A-Za-z0-9-_./]+$/;

const toolSchema = z.object({
  owner: z.string().describe('Repository owner (GitHub login or organisation), e.g. "octocat"'),
  repo: z.string().describe('Repository name, e.g. "hello-world"'),
  path: z
    .string()
    .describe('Repository-relative path to the file, e.g. "src/index.ts" (no leading slash)'),
  ref: z
    .string()
    .optional()
    .describe(
      'Optional git ref (branch, tag, or commit SHA) to read the file at. ' +
        'Defaults to the repository default branch. For PR reviews pass the PR head ref/SHA.'
    ),
});

type GhReadFileArgs = z.infer<typeof toolSchema>;

interface GhContentsResponse {
  type?: string;
  encoding?: string;
  content?: string;
  path?: string;
  size?: number;
}

/**
 * Fetches the full contents of a single file from GitHub via the `gh api` CLI and decodes it.
 * Returns the decoded text, or a human/agent-readable explanation string on any failure
 * (graceful skip — never throws).
 */
export async function ghReadFileImpl(args: GhReadFileArgs): Promise<string> {
  const { owner, repo, path, ref } = args;

  if (!OWNER_PATTERN.test(owner)) {
    return `Invalid repository owner "${owner}"; expected a GitHub login/organisation name.`;
  }
  if (!REPO_PATTERN.test(repo)) {
    return `Invalid repository name "${repo}".`;
  }
  if (!PATH_PATTERN.test(path) || path.includes('..')) {
    return `Invalid file path "${path}"; expected a repository-relative path without traversal.`;
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
 */
export function get(_: GthConfig): StructuredToolInterface {
  return tool(ghReadFileImpl, {
    name: TOOL_NAME,
    description:
      'Read the FULL contents of a single file from a GitHub repository via the GitHub API ' +
      '(gh api /repos/{owner}/{repo}/contents/{path}). Use this when the PR diff is truncated ' +
      'and you need to see the complete file. Reads through the GitHub API, not the local ' +
      'filesystem, so it is safe in pull_request_target CI.',
    schema: toolSchema,
  }) as StructuredToolInterface;
}

export const GTH_GH_READ_FILE_TOOL_NAME = TOOL_NAME;
