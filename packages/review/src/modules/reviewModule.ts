import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  defaultStatusCallback,
  displayDebug,
  displayError,
  displayInfo,
  displaySuccess,
  displayWarning,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getCommandOutputFilePath } from '#src/utils/fileUtils.js';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { MemorySaver } from '@langchain/langgraph';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';
import {
  createReviewRateMiddleware,
  REVIEW_RATE_ARTIFACT_KEY,
  type ReviewRatingArtifact,
} from '#src/middleware/reviewRateMiddleware.js';
import { deleteArtifact, getArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { get as getGhReadFileTool, GTH_GH_READ_FILE_TOOL_NAME } from '#src/tools/ghReadFileTool.js';

export async function review(
  source: string,
  preamble: string,
  diff: string,
  config: GthConfig,
  command: 'pr' | 'review' = 'review',
  resolvers?: AgentResolvers
): Promise<void> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Reviewing.');
  const messages = [new SystemMessage(preamble), new HumanMessage(diff)];

  // REL-2: optionally give the review agent a `gh api` file-read tool so it can fetch the FULL
  // contents of a file when the PR diff truncates large changes. Only added in a GitHub PR
  // context (the content source resolves to GitHub); a graceful no-op otherwise. Reads through
  // the GitHub API rather than the workspace filesystem, so it is safe under pull_request_target.
  maybeAddGhReadFileTool(config, command);

  // Prepare logging path (if enabled by config)
  const filePath = getCommandOutputFilePath(config, source);
  if (filePath) {
    initSessionLogging(filePath, config.streamSessionInferenceLog);
  }

  const rateConfig = config.commands?.[command]?.rating;
  if (rateConfig && rateConfig.enabled !== false) {
    const confMiddleware = config.middleware || [];
    const middlewareWithoutReviewRate = confMiddleware.filter((mw) => {
      return !(
        typeof mw === 'object' &&
        mw !== null &&
        'name' in mw &&
        (mw as { name?: string }).name === 'review-rate'
      );
    });

    // Resolve review-rate middleware directly rather than going through the registry
    const reviewRateMiddleware = await createReviewRateMiddleware(rateConfig, config);
    config.middleware = [...middlewareWithoutReviewRate, reviewRateMiddleware];
  }

  // When no resolvers are provided (e.g. standalone review CLI, without @gaunt-sloth/agent's
  // resolvers), supply a minimal middleware resolver that passes through already-resolved
  // middleware. The full `gaunt-sloth` CLI injects @gaunt-sloth/agent's resolvers instead.
  const effectiveResolvers: AgentResolvers = resolvers ?? {
    resolveMiddleware: async (middleware) => middleware ?? [],
  };
  const runner = new GthAgentRunner(defaultStatusCallback, effectiveResolvers);
  try {
    await runner.init(command, config, new MemorySaver());
    await runner.processMessages(messages);
  } catch (error) {
    displayDebug(error instanceof Error ? error : String(error));
    const reason = error instanceof Error ? error.message : String(error);
    displayError(
      reason ? `Failed to run review with agent.\n\n${reason}` : 'Failed to run review with agent.'
    );
  } finally {
    await runner.cleanup();
  }

  progressIndicator?.stop();

  handleRatingResult(rateConfig, command);

  // Close the file AFTER rating is written
  if (filePath) {
    try {
      flushSessionLog();
      stopSessionLogging();
      displaySuccess(`\n\nThis report can be found in ${filePath}`);
    } catch (error) {
      displayDebug(error instanceof Error ? error : String(error));
      displayError(`Failed to write review to file: ${filePath}`);
    }
  }

  deleteArtifact(REVIEW_RATE_ARTIFACT_KEY);
}

/**
 * REL-2: conditionally inject the optional `gh api` file-read tool into the review agent's tools.
 *
 * Guarded so it is only active in a GitHub PR context, i.e. when the command's content source
 * resolves to GitHub. For local/file/text reviews this is a no-op, keeping the tool optional and
 * avoiding adding a GitHub-only capability where it cannot apply.
 *
 * The tool reads file contents via the GitHub API (`gh api`), never the workspace filesystem, so
 * it remains safe under `pull_request_target` CI where the untrusted PR head is not checked out.
 */
function maybeAddGhReadFileTool(config: GthConfig, command: 'pr' | 'review'): void {
  const commandConfig = config.commands?.[command];
  // Honor deprecated alias too: contentProvider.
  const contentSource =
    commandConfig?.contentSource ??
    commandConfig?.contentProvider ??
    config.contentSource ??
    config.contentProvider;

  if (contentSource !== 'github') {
    return;
  }

  // config.tools is a union (StructuredToolInterface[] | BaseToolkit[] | ServerTool[]); the
  // gh read-file tool is a StructuredToolInterface, so we only append into a structured-tool list.
  const existingTools = (
    Array.isArray(config.tools) ? config.tools : []
  ) as StructuredToolInterface[];
  // Avoid duplicate registration if the tool is already present (e.g. via custom config).
  const alreadyPresent = existingTools.some(
    (t) =>
      typeof t === 'object' && t !== null && 'name' in t && t.name === GTH_GH_READ_FILE_TOOL_NAME
  );
  if (alreadyPresent) {
    return;
  }

  config.tools = [...existingTools, getGhReadFileTool(config)];
}

function handleRatingResult(rateConfig: RatingConfig | undefined, command: 'pr' | 'review'): void {
  if (!rateConfig || rateConfig.enabled === false) {
    // No rating enabled - no need to handle the result
    return;
  }

  const rating = getArtifact<ReviewRatingArtifact>(REVIEW_RATE_ARTIFACT_KEY);
  if (!rating) {
    displayWarning(`Rating middleware did not return a score for ${command} command.`);
    setExitCode(1); // Build should fail if rating is enabled, but no rating artifact is present
    return;
  }

  const threshold = rateConfig.passThreshold ?? rating.passThreshold;
  const maxRating = rateConfig.maxRating ?? rating.maxRating;
  const verdictText = `${rating.rate}/${maxRating} (threshold: ${threshold})`;
  displayInfo('\nREVIEW RATING');

  if (rating.rate >= threshold) {
    displaySuccess(`PASS ${verdictText}`);
  } else {
    displayError(`FAIL ${verdictText}`);
    if (rateConfig.errorOnReviewFail ?? true) {
      setExitCode(1);
    }
  }

  if (rating.comment) {
    displayInfo(rating.comment);
  }
}
