/**
 * @packageDocumentation
 * Middleware responsible for generating review ratings after the agent finishes.
 *
 * The middleware runs an additional model call that summarizes the review outcome
 * and stores the structured result inside the global artifact store.
 */

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createMiddleware, type AgentMiddleware } from 'langchain';
import * as z from 'zod';

import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
import { setArtifact, deleteArtifact, getArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import { debugLog, debugLogError } from '@gaunt-sloth/core/utils/debugUtils.js';
import { displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getNewRunnableConfig } from '@gaunt-sloth/core/utils/llmUtils.js';
import { isCompactionSummary } from '@gaunt-sloth/core/core/compaction.js';
import { estimatePromptTokens } from '@gaunt-sloth/core/core/GthLangChainAgent.js';

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

// [[EXT-183]] — the review GENERATION has no budget of its own. That is a decision deferred on a
// named measurement, not an oversight, and the asymmetry with the cap above is deliberate.
//
// The budget above bounds the rating call only. The generation that runs before it is bounded by
// nothing: its runnable config carries a recursion limit and a thread id, the agent adds only
// `streamFromInput`'s Esc `AbortController`, and gth sets no call timeout on any provider. Nor is a
// runaway there rare — across the recorded gate windows the runaways split about evenly between the
// two calls, and in the most recent one all three of them were generation.
//
// WHY NO NUMBER WAS CHOSEN. The seam exists: `wrapModelCall` wraps each model call individually, so
// a budget could bound ONE call without capping a legitimate many-turn review, and a value in the
// 120-240 s band would sit below the integration suite's 300 s per-test ceiling while clearing every
// healthy call measured here by a wide margin. What is missing is the measurement that would set it.
// Every healthy sample is a sub-kilobyte fixture reviewed by a local `gemma4:12b` at ~31.5 tokens a
// second, and none is the case a default has to survive: one call, a real diff, a remote provider,
// thinking enabled. Wall clock does not carry across providers — the same number is a few thousand
// tokens locally and something else entirely on a fast model with a large thinking budget — and
// GS2-105 could pick 120 s only because it had a healthy baseline for the call it was bounding.
// Truncating a real review is the failure a review tool can least afford, so the number waits for
// its measurement: legitimate single-call durations for `review` and `pr` across the providers
// people actually run, at real diff sizes.
//
// WHY THE GAP IS TOLERABLE MEANWHILE. What makes an unbounded RATING call the failure GS2-105 exists
// to prevent is that it renders NOTHING while it runs — a finished review followed by an unexplained
// pause. The generation is the opposite: it streams token by token (`streamOutput` defaults true),
// so a user watching it can see what it is doing and judge when it has gone wrong, and on a TTY
// `streamFromInput` has Esc armed to stop it.
//
// Two cases that reasoning does not cover, neither of them claimed harmless: `streamOutput: false`,
// whose non-streaming `invoke` path arms no Esc at all and so IS the silent shape described above;
// and any caller whose stdin is not a TTY — CI, a piped diff, the batch pipeline — where Esc is off
// by construction.

/** REL-6 — what the rating step needs from the run beyond its settings and config. */
export interface ReviewRateMiddlewareOptions {
  /**
   * The context guard's threshold for this run, in the estimator's tokens, or `null` when nothing
   * fires. Read when the rating is requested, so it is the number the guard was enforcing. Absent
   * or `null`, the rating request is sent exactly as it always was.
   */
  thresholdSource?: () => Promise<number | null>;
}

export function createReviewRateMiddleware(
  settings: ReviewRateMiddlewareSettings,
  gthConfig: GthConfig,
  options: ReviewRateMiddlewareOptions = {}
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

  // GS2-105 — ONE bound model call, not an agent loop.
  //
  // Rating is a single round trip by nature: read the conversation, emit one tool call carrying the
  // score. Running it through an agent loop adds turns it has no use for, and a small model exploits
  // every one of them — measured on `gemma4:12b`, the model called the rating tool and the loop fed
  // the result back and asked again, four times, never emitting a final answer. The loop, not the
  // model, is what has no terminating condition here: the score is already stored after the first
  // call, so every later turn is pure cost.
  const boundModel =
    typeof gthConfig.llm?.bindTools === 'function'
      ? gthConfig.llm.bindTools([rateTool])
      : undefined;

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

        if (!boundModel) {
          displayWarning(
            'ReviewRateMiddleware: the configured model cannot be given tools, so no rating ' +
              'could be requested.'
          );
          return state;
        }

        try {
          const threshold = await readThreshold(options.thresholdSource);
          const basis =
            threshold === null
              ? (state.messages as BaseMessage[])
              : reduceRatingBasis(state.messages as BaseMessage[], ratingPrompt, threshold)
                  .messages;
          const ratingMessages = [...basis, new HumanMessage(ratingPrompt)];

          // ONE call, bounded TWICE, and the second bound is not redundant.
          //
          // `timeout` on the runnable config is the good bound: it is honoured at this layer (though
          // `ChatOllama` ignores a model-level timeout) and it ABORTS the request rather than
          // abandoning it. But it is someone else's implementation, and a middleware that owns no
          // bound of its own cannot be tested for one — a spec could only assert that the field was
          // passed, which stays green even if the field stops being honoured.
          //
          // So the deadline below is this module's own guarantee: whatever the provider or the
          // runnable layer does, `afterAgent` settles within the budget. It races rather than
          // cancels, so on this path the generation may still be running when we stop waiting —
          // that is why it is the backstop and `timeout` is the primary.
          let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_resolve, reject) => {
            deadlineTimer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error('rating budget exhausted'), { name: 'TimeoutError' })
                ),
              timeoutMs
            );
            // Never hold the process open for a budget that is only a backstop.
            deadlineTimer.unref?.();
          });
          let answer;
          try {
            answer = await Promise.race([
              boundModel.invoke(ratingMessages, {
                ...getNewRunnableConfig(),
                timeout: timeoutMs,
              }),
              deadline,
            ]);
          } finally {
            // Not tidiness — correctness. A losing `Promise.race` entrant still settles, so a
            // deadline left armed after a fast rating would reject into nobody, and an unhandled
            // rejection is fatal on modern Node: the guard against a hang would become a way to
            // crash a healthy run. This runs on the continuation, ahead of any macrotask timer, so
            // the deadline never fires and never rejects.
            clearTimeout(deadlineTimer);
          }

          // Run whichever rating call the model made. Extra calls in one response are ignored
          // rather than replayed — the score is settled by the first, and honouring the rest is
          // how a scoring step turns into an argument with itself.
          const calls = (answer?.tool_calls ?? []).filter(
            (call) => call.name === REVIEW_RATE_TOOL_NAME
          );
          if (calls[0]) {
            await rateTool.invoke(calls[0].args as RateResponse);
          }

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

async function readThreshold(
  source: (() => Promise<number | null>) | undefined
): Promise<number | null> {
  if (!source) return null;
  try {
    const threshold = await source();
    return typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0
      ? threshold
      : null;
  } catch {
    return null;
  }
}

/**
 * REL-6 — the first message of a rating basis whose earlier context was dropped and that has no
 * compaction summary to open with. Providers expect the conversation to open with a user turn.
 */
export const RATING_BASIS_OMISSION_NOTE =
  'Earlier parts of this review conversation (the original request and the oldest file reads) ' +
  'were left out so the scoring request fits the model context window. The review below is whole.';

/** What {@link reduceRatingBasis} decided, for the caller and the specs. */
export interface RatingBasis {
  messages: BaseMessage[];
  /** `false` when the basis is `state.messages` itself, unchanged. */
  reduced: boolean;
  /** How many tool-call groups (an AI call with its results) were kept, when reduced. */
  keptReads: number;
  /** How many were left out, when reduced. */
  droppedReads: number;
}

/**
 * An AI message without its usage numbers, for ESTIMATING a reduced basis only. The estimator
 * anchors on the newest reported input count, and the final review's count is the size of the
 * whole request it answered — exactly what a reduced basis no longer holds.
 */
function forEstimate(message: BaseMessage): BaseMessage {
  if (!AIMessage.isInstance(message)) return message;
  return new AIMessage({
    content: message.content,
    tool_calls: message.tool_calls,
    id: message.id,
  });
}

/**
 * REL-6 — **bound the rating request by the run's guard threshold, never cutting the review.**
 *
 * The rating is a direct `invoke` after the agent finishes, so the context guard never sees it,
 * and it carries everything the last guarded call did plus the final review and the rating
 * prompt. Over the threshold that is a request the provider may reject or silently truncate.
 *
 * Under the threshold, `messages` is returned as it is — the same array, so a small review's rating
 * request is unchanged. Over it, the basis is rebuilt to keep, in this order: (1) the final review,
 * whole; (2) the compaction summary, when the run folded; (3) the most recent tool-call groups,
 * newest first, until the next one would not fit. The original request and older reads go. Kept
 * reads stay in their original order, each AI call with all of its results, so the request remains
 * a valid conversation. When even the review alone is over the threshold it is sent anyway: the
 * rater must see the whole verdict.
 *
 * DECISION — **a deterministic reduction, not core's `compactMessages`.** Compaction cannot meet
 * this bound: it takes no budget, it keeps the last `DEFAULT_KEEP_RECENT` messages verbatim, and
 * that tail (the final review and the reads before it) is what overflows; with a summary and six
 * or fewer messages it folds nothing at all. It would also cost a second model call over the
 * folded span, which nothing guards either. The estimate is core's own `estimatePromptTokens`, so
 * this and the guard agree about what "full" means.
 */
export function reduceRatingBasis(
  messages: readonly BaseMessage[],
  ratingPrompt: string,
  threshold: number
): RatingBasis {
  const prompt = new HumanMessage(ratingPrompt);
  const unchanged: RatingBasis = {
    messages: messages as BaseMessage[],
    reduced: false,
    keptReads: 0,
    droppedReads: 0,
  };
  if (estimatePromptTokens([...messages, prompt]) <= threshold) return unchanged;

  let finalIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!AIMessage.isInstance(message)) continue;
    if (finalIndex === -1) finalIndex = i;
    if ((message.tool_calls ?? []).length === 0) {
      finalIndex = i;
      break;
    }
  }
  if (finalIndex === -1) return unchanged;
  const finalReview = messages[finalIndex];

  const summary = messages.slice(0, finalIndex).find((message) => isCompactionSummary(message));
  const head = summary ?? new HumanMessage(RATING_BASIS_OMISSION_NOTE);

  // Tool-call groups before the review, oldest first: an AI message that called tools and the tool
  // results that follow it.
  const groups: BaseMessage[][] = [];
  for (let i = 0; i < finalIndex; i++) {
    const message = messages[i];
    if (AIMessage.isInstance(message) && (message.tool_calls ?? []).length > 0) {
      groups.push([message]);
    } else if (ToolMessage.isInstance(message) && groups.length > 0) {
      groups[groups.length - 1].push(message);
    }
  }

  const build = (kept: BaseMessage[][]): BaseMessage[] => [head, ...kept.flat(), finalReview];
  const fits = (candidate: BaseMessage[]): boolean =>
    estimatePromptTokens([...candidate, prompt].map(forEstimate)) <= threshold;

  const kept: BaseMessage[][] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    const next = [groups[g], ...kept];
    if (!fits(build(next))) break;
    kept.unshift(groups[g]);
  }
  const reduced = build(kept);
  if (!fits(reduced)) {
    debugLog(
      `ReviewRateMiddleware: the final review alone is past the ${threshold}-token threshold; ` +
        'sending it whole anyway, because the rater must see the whole verdict.'
    );
  }
  debugLog(
    `ReviewRateMiddleware: the rating request was past the ${threshold}-token threshold, so its ` +
      `basis was reduced to the review${summary ? ', the compaction summary' : ''} and ` +
      `${kept.length} of ${groups.length} file reads.`
  );
  return {
    messages: reduced,
    reduced: true,
    keptReads: kept.length,
    droppedReads: groups.length - kept.length,
  };
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
