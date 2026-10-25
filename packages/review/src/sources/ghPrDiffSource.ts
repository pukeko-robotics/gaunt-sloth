import type { ProviderConfig } from './types.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import {
  isGhReadFileDiffToolEnabled,
  isGhReadFileToolEnabled,
  type GhReadFileCommand,
} from '@gaunt-sloth/core/config.js';
import { resolveContextWindow } from '@gaunt-sloth/core/core/contextWindow.js';
import { execAsync } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  fetchPrFilesListing,
  resolvePrBaseBinding,
  type LargePrListing,
} from '#src/utils/prFilesListing.js';
import {
  diffBudgetBytes,
  triagePrFiles,
  UNKNOWN_WINDOW_FALLBACK_TOKENS,
} from '#src/utils/prDiffTriage.js';

// PR IDs may be supplied by LLM-driven tools and are interpolated into a shell command.
// Keep the accepted shape strict to prevent shell metacharacters from reaching execAsync.
const PR_ID_PATTERN = /^\d+$/;

/**
 * What the `github` content source needs beyond its own config slice, to size a large PR.
 *
 * Optional throughout: a caller that passes nothing gets the plain `gh pr diff` route, plus the
 * REST fallback with the {@link UNKNOWN_WINDOW_FALLBACK_TOKENS} budget when GitHub refuses the diff.
 */
export interface GhPrDiffSourceContext {
  /** The resolved config: its `llm` sizes the budget, `commands.pr` carries the elision list. */
  config?: GthConfig;
  /**
   * The content budget in bytes, overriding the one derived from the model's window; `null` means
   * "unknown". For embedders that size their own context, and for hermetic tests.
   */
  budgetBytes?: number | null;
  /**
   * REL-6 — the command this content is for, which selects the `builtInTools` registry the
   * manifest's closing sentence consults. `review()` registers the tools from the same registry, so
   * the content never names a tool the run does not get. Defaults to `pr`, which the CI bin and
   * discovery are.
   */
  command?: GhReadFileCommand;
  /**
   * REL-6 — called once, before `get` resolves, when the triage named files without their diff. The
   * caller passes the value on as `ReviewContext.largePr`, which is what gives the review agent the
   * per-file diff tool. Not called for a PR that fits.
   */
  onLargePr?: (_listing: LargePrListing) => void;
}

/**
 * The `gh` rejection for a PR whose diff GitHub will not render. Measured verbatim (gh 2.102.1, on
 * microsoft/TypeScript#64122): exit 1, stderr
 * `could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files
 * (300). … PullRequest.diff too_large`. Keyed on the status plus GitHub's "diff exceeded the
 * maximum" / `too_large` wording rather than on "files", so the line-count variant of the same
 * refusal takes the same route (that variant is not measured).
 */
export function isDiffTooLargeError(message: string): boolean {
  return /HTTP 406/.test(message) && /diff exceeded the maximum|too_large/i.test(message);
}

/**
 * The content budget for this run, in bytes, or `null` when the window is unknown. Never throws: a
 * budget that cannot be resolved is an unknown one.
 */
async function resolveBudgetBytes(
  context: GhPrDiffSourceContext | undefined
): Promise<number | null> {
  if (context?.budgetBytes !== undefined) return context.budgetBytes;
  const config = context?.config;
  if (!config?.llm) return null;
  try {
    const window = await resolveContextWindow(config.llm, {
      providerId: config.modelProviderType,
      modelId: (config.llm as { model?: string }).model ?? config.modelDisplayName,
    }).source();
    return diffBudgetBytes(window);
  } catch {
    return null;
  }
}

/**
 * Gets PR diff using GitHub CLI.
 *
 * **Route (REL-21): fall back, don't preflight.** `gh pr diff` stays the first call, so a PR that
 * fits makes the same calls as before and returns byte-identical content. The REST files listing
 * (`prFilesListing.ts`) is used only when GitHub refuses the diff with HTTP 406 (more than 300
 * files), or when the fetched diff is over the budget, since fitting it needs the per-file status
 * and sizes only the listing carries. Always-REST would be one code path, but it would change every
 * small review's content and add a paginated call to each.
 *
 * **Unknown window:** a diff that fetched cleanly is passed through untouched, because nothing can
 * say it is too large; after a 406 the fallback budget in `prDiffTriage.ts` applies.
 *
 * @param _ config slice (unused in this source)
 * @param prId GitHub PR number. When omitted, GitHub CLI resolves the PR for the current branch.
 * @param context the resolved config (or an explicit budget), used only to size a large PR
 * @returns GitHub PR diff content or null if not found
 */
export async function get(
  _: ProviderConfig | null,
  prId: string | undefined,
  context?: GhPrDiffSourceContext
): Promise<string | null> {
  if (prId && !PR_ID_PATTERN.test(prId)) {
    displayWarning(`Invalid GitHub PR number "${prId}"; expected a numeric string.`);
    return null;
  }

  const prLabel = prId ? `#${prId}` : 'for current branch';
  const ghCommand = prId ? `gh pr diff ${prId}` : 'gh pr diff';

  // Use the GitHub CLI to fetch PR diff
  const progress = new ProgressIndicator(`Fetching GitHub PR ${prLabel} diff`);
  let prDiffContent: string;
  try {
    prDiffContent = await execAsync(ghCommand);
    progress.stop();
  } catch (error) {
    progress.stop();
    const message = error instanceof Error ? error.message : String(error);
    if (isDiffTooLargeError(message)) {
      const budget =
        (await resolveBudgetBytes(context)) ?? diffBudgetBytes(UNKNOWN_WINDOW_FALLBACK_TOKENS)!;
      return getFromFilesListing(prId, prLabel, budget, 'too-many-files', context);
    }
    throw new Error(`Failed to get GitHub PR diff ${prLabel}: ${message}
Consider checking if gh cli (https://cli.github.com/) is installed and authenticated.`);
  }

  if (!prDiffContent) {
    throw new Error(`Failed to get GitHub PR diff ${prLabel}: No diff content found for GitHub PR ${prLabel}
Consider checking if gh cli (https://cli.github.com/) is installed and authenticated.`);
  }

  const content = `GitHub PR Diff: ${prLabel}\n\n${prDiffContent}`;
  const budget = await resolveBudgetBytes(context);
  if (budget === null || Buffer.byteLength(content, 'utf8') <= budget) {
    return content;
  }
  // The diff is in hand, so a listing that cannot be fetched is not a reason to fail the run: the
  // review proceeds on the whole diff, which is what it did before the triage existed.
  try {
    return await getFromFilesListing(prId, prLabel, budget, 'over-budget', context);
  } catch (error) {
    displayWarning(
      `GitHub PR ${prLabel} diff is over the context budget and could not be triaged; reviewing it whole. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return content;
  }
}

async function getFromFilesListing(
  prId: string | undefined,
  prLabel: string,
  budgetBytes: number,
  route: 'too-many-files' | 'over-budget',
  context: GhPrDiffSourceContext | undefined
): Promise<string> {
  const progress = new ProgressIndicator(`Listing GitHub PR ${prLabel} files`);
  try {
    const binding = await resolvePrBaseBinding(prId);
    const entries = await fetchPrFilesListing(binding);
    progress.stop();
    if (entries.length === 0) {
      throw new Error(`the files listing for GitHub PR ${prLabel} was empty`);
    }
    const config = context?.config;
    const command = context?.command ?? 'pr';
    const result = triagePrFiles(entries, {
      budgetBytes,
      elidePatterns: config?.commands?.pr?.elidePatterns,
      prLabel,
      readFileToolEnabled: isGhReadFileToolEnabled(config, command),
      fileDiffToolEnabled: isGhReadFileDiffToolEnabled(config, command),
      changedFiles: binding.changedFiles,
      route,
    });
    if (result.elided.length > 0) {
      displayWarning(
        `GitHub PR ${prLabel} is large: ${result.shown.length} of ${entries.length} files shown in full, ` +
          `${result.elided.length} named only.`
      );
      context?.onLargePr?.({ binding, entries, elidedCount: result.elided.length });
    }
    return result.content;
  } catch (error) {
    progress.stop();
    throw new Error(`Failed to get GitHub PR diff ${prLabel} from the files listing: ${
      error instanceof Error ? error.message : String(error)
    }
Consider checking if gh cli (https://cli.github.com/) is installed and authenticated.`);
  }
}
