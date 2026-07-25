import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import type { ProviderConfig } from './types.js';
import { execAsync } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';

// Either a bare issue number or a full issue URL. The strict shape matters because the value
// is interpolated into a shell command; URLs with a loose charset could smuggle shell
// metacharacters (issue references may originate from untrusted PR descriptions).
const ISSUE_REF_PATTERN = /^(?:\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)$/;

/**
 * Gets GitHub issue using GitHub CLI
 * @param _ config (unused in this source)
 * @param issueId GitHub issue number or full issue URL (for issues in other repositories)
 * @returns GitHub issue content or null if not found
 */
export async function get(
  _: ProviderConfig | null,
  issueId: string | undefined
): Promise<string | null> {
  if (!issueId) {
    displayWarning('No GitHub issue number provided');
    return null;
  }

  if (!ISSUE_REF_PATTERN.test(issueId)) {
    displayWarning(
      `Invalid GitHub issue reference "${issueId}"; expected an issue number or a full https://github.com/<owner>/<repo>/issues/<number> URL.`
    );
    return null;
  }

  const issueLabel = /^\d+$/.test(issueId) ? `#${issueId}` : issueId;

  // EXT-53: the indicator is constructed OUTSIDE the try and cleared in a `finally`. It owns a 1s
  // setInterval — an active libuv handle — so a `stop()` reachable only on the success path leaves
  // the event loop un-drainable and the process never exits. This is especially nasty here because
  // a failed issue fetch is a SOFT failure (returns null, the review proceeds), so the hang is
  // invisible: the command succeeds and then simply never returns.
  const progress = new ProgressIndicator(`Fetching GitHub issue ${issueLabel}`);
  let issueContent: string;
  try {
    // Use the GitHub CLI to fetch issue details
    issueContent = await execAsync(`gh issue view ${issueId}`);
  } catch (error) {
    displayWarning(`
Failed to get GitHub issue ${issueLabel}: ${error instanceof Error ? error.message : String(error)}
Consider checking if gh cli (https://cli.github.com/) is installed and authenticated.
    `);
    return null;
  } finally {
    progress.stop();
  }

  if (!issueContent) {
    displayWarning(`No content found for GitHub issue ${issueLabel}`);
    return null;
  }

  return `GitHub Issue: ${issueLabel}\n\n${issueContent}`;
}
