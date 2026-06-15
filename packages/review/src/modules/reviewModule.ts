import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
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
