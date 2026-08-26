/**
 * @packageDocumentation
 * Middleware responsible for generating review ratings after the agent finishes.
 *
 * The middleware runs an additional model call that summarizes the review outcome
 * and stores the structured result inside the global artifact store.
 */

import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createAgent, createMiddleware, type AgentMiddleware } from 'langchain';
import * as z from 'zod';

import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
import { setArtifact, deleteArtifact, getArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import { debugLog, debugLogError } from '@gaunt-sloth/core/utils/debugUtils.js';
import { displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getNewRunnableConfig } from '@gaunt-sloth/core/utils/llmUtils.js';

/**
 * Schema describing the result of the review rating step.
 */
export const RateSchema = z.object({
  rate: z.number().min(0).max(10).describe('Review rating from 0 to 10'),
  comment: z.string().describe('Comment explaining the rating'),
});

/**
 * Type representing a review rating response.
 */
export type RateResponse = z.infer<typeof RateSchema>;

export interface ReviewRatingArtifact extends RateResponse {
  passThreshold: number;
  minRating: number;
  maxRating: number;
}

export const REVIEW_RATE_ARTIFACT_KEY = 'gsloth.review.rate';

const DEFAULT_MIN_RATING = 0;
const DEFAULT_MAX_RATING = 10;
const DEFAULT_PASS_THRESHOLD = 6;

interface NormalizedRatingConfig {
  minRating: number;
  maxRating: number;
  passThreshold: number;
}

export type ReviewRateMiddlewareSettings = RatingConfig & {
  name?: 'review-rate';
};

export function normalizeRatingConfig(config: RatingConfig | undefined): NormalizedRatingConfig {
  const min = config?.minRating ?? DEFAULT_MIN_RATING;
  const max = config?.maxRating ?? DEFAULT_MAX_RATING;
  const [minRating, maxRating] = min <= max ? [min, max] : [max, min];
  const threshold = config?.passThreshold ?? DEFAULT_PASS_THRESHOLD;

  return {
    minRating,
    maxRating,
    passThreshold: clamp(threshold, minRating, maxRating),
  };
}

const REVIEW_RATE_TOOL_NAME = 'gth_review_rate';

/**
 * GS2-105 — default wall-clock budget for the one rating call, in milliseconds.
 *
 * A healthy rating call against a local `gemma4:12b` was measured at ~50 s; a runaway at ~485 s.
 * 120 s sits above the former with headroom and well below the latter, and below the integration
 * suite's own 300 s per-test ceiling — which matters, because a budget above that ceiling would let
 * the harness give up first and leave the generation running, which is the behaviour this replaces.
 * Override per command with `commands.<review|pr>.rating.timeoutMs`.
 */
export const DEFAULT_REVIEW_RATE_TIMEOUT_MS = 120_000;

export function createReviewRateMiddleware(
  settings: ReviewRateMiddlewareSettings,
  gthConfig: GthConfig
): Promise<AgentMiddleware> {
  const normalizedConfig = normalizeRatingConfig(settings);

  const rateTool = tool(
    (input: RateResponse) => {
      const artifact: ReviewRatingArtifact = {
        ...input,
        ...normalizedConfig,
      };
      setArtifact(REVIEW_RATE_ARTIFACT_KEY, artifact);

      return `Stored rating ${input.rate}/${normalizedConfig.maxRating}`;
    },
    {
      name: REVIEW_RATE_TOOL_NAME,
      description: 'Stores the final review rating and summary comment.',
      schema: RateSchema,
    }
  );

  const ratingAgent = createAgent({
    model: gthConfig.llm,
    tools: [rateTool],
  });

  // The budget is read here, from the caller's own rating config, and NOT folded into
  // `normalizedConfig` — that object is spread into the stored artifact, and adding a field to it
  // would change the artifact's shape for every reader.
  const timeoutMs = settings?.timeoutMs ?? DEFAULT_REVIEW_RATE_TIMEOUT_MS;

  return Promise.resolve(
    createMiddleware({
      name: 'review-rate',
      afterAgent: async (state) => {
        if (!Array.isArray(state.messages) || state.messages.length === 0) {
          return state;
        }

        deleteArtifact(REVIEW_RATE_ARTIFACT_KEY);

        const ratingPrompt = buildRatingInstructions(normalizedConfig);

        debugLog('ReviewRateMiddleware: requesting rating evaluation');

        // GS2-105, DL-1 (no action is silent) — this is a SECOND model call, fired after the review
        // prose is already on screen. Without this line the user sees a finished review followed by
        // an unexplained pause, with nothing to say a call is still in flight.
        displayInfo('\nScoring the review…');

        try {
          const ratingMessages = [...state.messages, new HumanMessage(ratingPrompt)];

          await ratingAgent.invoke(
            {
              messages: ratingMessages,
            },
            // `timeout` is a standard `RunnableConfig` field that LangChain turns into an
            // AbortSignal, so the request is genuinely cancelled rather than merely abandoned.
            // Abandoning is what let a still-running generation hold the queue while the harness
            // retried behind it.
            { ...getNewRunnableConfig(), timeout: timeoutMs }
          );

          const artifact = getArtifact(REVIEW_RATE_ARTIFACT_KEY);
          if (!artifact) {
            displayWarning(
              'ReviewRateMiddleware: rating agent completed but did not call the rating tool. ' +
                'The model may not have followed instructions to call ' +
                REVIEW_RATE_TOOL_NAME +
                '.'
            );
          }
        } catch (error) {
          // A budget overrun and a provider error are different events and must read differently:
          // one says the model never answered in time, the other carries the provider's own reason.
          // Collapsing them would make a hung local model look like a broken configuration.
          displayWarning(
            isAbortError(error)
              ? `ReviewRateMiddleware: the rating call did not finish within ${timeoutMs}ms and was ` +
                  'cancelled. No score was produced.'
              : 'ReviewRateMiddleware: rating agent failed — ' +
                  (error instanceof Error ? error.message : String(error))
          );
          debugLogError('ReviewRateMiddleware.invoke', error);
        }

        return state;
      },
    })
  );
}

function buildRatingInstructions(config: NormalizedRatingConfig): string {
  const formattedThreshold = formatScore(config.passThreshold);
  const formattedMax = formatScore(config.maxRating);
  const formattedMin = formatScore(config.minRating);
  const middle = formatScore((config.passThreshold + config.maxRating) / 2);

  return [
    'A reviewer just finished assessing a code change.',
    'Your job is to inspect the entire conversation above, focus on the code being discussed (not the review quality),',
    'and call the ' + REVIEW_RATE_TOOL_NAME + ' tool exactly once.',
    `Assign a score between ${formattedMin}-${formattedMax} that reflects the code quality only.`,
    `Pass threshold is ${formattedThreshold}, everything below will be considered a fail.`,
    '',
    'Additional guidelines:',
    `- Never give ${formattedThreshold}/${formattedMax} or more to code which would explode with syntax error.`,
    `- Rate excellent code as ${formattedMax}/${formattedMax}`,
    `- Rate code needing improvements as ${middle}/${formattedMax}`,
    '- Use the comment field of the tool call for a concise summary referencing the code state.',
  ].join('\n');
}

/**
 * Whether a thrown value is an abort — i.e. our own budget cancelled the call.
 *
 * Deliberately tolerant about the shape. An abort surfaces as a `DOMException` named `AbortError`
 * in some runtimes, as a plain `Error` named `AbortError` or `TimeoutError` in others, and provider
 * SDKs re-wrap it; matching only one of those would silently route a real timeout into the generic
 * branch and report it as a provider failure.
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
