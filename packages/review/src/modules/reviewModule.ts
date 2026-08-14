import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
import { isGhReadFileToolEnabled } from '@gaunt-sloth/core/config.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  defaultStatusCallback,
  display,
  displayDebug,
  displayError,
  displayInfo,
  displaySuccess,
  displayWarning,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { reviewHeadingBlock } from '#src/modules/reviewHeading.js';
import { getCommandOutputFilePath } from '#src/utils/fileUtils.js';
import { HumanMessage } from '@langchain/core/messages';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { MemorySaver } from '@langchain/langgraph';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';
import {
  createReviewRateMiddleware,
  REVIEW_RATE_ARTIFACT_KEY,
  type ReviewRatingArtifact,
} from '#src/middleware/reviewRateMiddleware.js';
import { deleteArtifact, getArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import { setExitCode, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { ApprovalStopError, approvalStopRows } from '@gaunt-sloth/core/core/shell/approvalStop.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { get as getGhReadFileTool, GTH_GH_READ_FILE_TOOL_NAME } from '#src/tools/ghReadFileTool.js';

/** Extra context about the review, used to bind GitHub-only tools to the PR under review. */
export interface ReviewContext {
  /** PR number under review; undefined in `gth pr` discovery mode (current branch's PR). */
  prId?: string;
}

/**
 * Run a review of `diff` and print the verdict.
 *
 * @param source - Source label, used for the output file name.
 * @param _preamble - Ignored (GS2-79); see the body comment. Retained positionally so existing
 *   callers need no change, exactly as `runSingleShot` retains its own.
 * @param diff - The content under review.
 * @param config - The resolved config.
 * @param command - `review` or `pr`; selects the command config and the agent's mode prompt.
 * @param resolvers - Optional agent resolvers (tools/middleware).
 * @param reviewContext - Extra review context (binds GitHub-only tools to the PR under review).
 */
export async function review(
  source: string,
  // GS2-79: `_preamble` is retained for signature stability but is NO LONGER injected as a leading
  // SystemMessage. Both agent backends COMPOSE the full system prompt themselves — backstory +
  // guidelines + the per-command mode prompt + system prompt — and hand it to createAgent as
  // `systemPrompt`; for `review`/`pr` that mode prompt IS the review instructions (core's
  // `readModePrompt`). Passing this preamble as well produced TWO system messages, which
  // `@langchain/anthropic` rejects outright ("System messages are only permitted as the first
  // passed message"), breaking every `gth review` and `gth pr` run on Anthropic on both backends
  // (Google/OpenAI silently merged them, so only Anthropic showed it). The same removal was made in
  // `runSingleShot` and `conversation` for the same reason.
  //
  // Dropping it is content-preserving ONLY because the agent selects the review instructions for
  // `review`/`pr` itself; composing the CHAT prompt there and removing the preamble would silently
  // turn a review into a chat. `GthModePromptSelection.spec.ts` pins that.
  _preamble: string,
  diff: string,
  config: GthConfig,
  command: 'pr' | 'review' = 'review',
  resolvers?: AgentResolvers,
  reviewContext?: ReviewContext
): Promise<void> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Reviewing.');
  try {
    // Only the human turn: the agent supplies the system prompt via `createAgent({ systemPrompt })`.
    const messages = [new HumanMessage(diff)];

    // REL-2: optionally give the review agent a `gh api` file-read tool so it can fetch the FULL
    // contents of a file when the PR diff truncates large changes. Only added in a GitHub PR
    // context (the content source resolves to GitHub); a graceful no-op otherwise. Reads through
    // the GitHub API rather than the workspace filesystem, so it is safe under pull_request_target.
    maybeAddGhReadFileTool(config, command, reviewContext?.prId);

    // Prepare logging path (if enabled by config)
    const filePath = getCommandOutputFilePath(config, source);
    if (filePath) {
      initSessionLogging(filePath, config.streamSessionInferenceLog);
    }

    // REL-12: head the review with its attribution. It sits AFTER `initSessionLogging` on purpose —
    // the session log is a capture of console output, so this ordering is the whole reason one
    // emission covers both surfaces: the terminal AND the `writeOutputToFile` report a workflow
    // reads back and posts. Emitted BEFORE the agent runs so it is the first thing in both.
    //
    // Through the ordinary `display` helper, never `headerStatus`: this is not the agent's
    // technical preamble but the first line of the review document, so it survives the `compact`
    // rung that strips the preamble — and on that rung it IS the attribution, which is why the
    // agent emits no `Gaunt Sloth: <verb>` line for `review`/`pr`.
    //
    // GS2-93: `none` is the one rung that reaches it, and it silences the block outright. That
    // deliberately reverses REL-12 for a user who asks for it: a caller piping a review into their
    // own template or diffing captured stdout needs a byte-clean stream, and nobody loses
    // attribution without setting this key.
    if (config.output?.header !== 'none') {
      display(reviewHeadingBlock(config.modelDisplayName, config.modelProviderType));
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
    // GS2-81: no backend factory, so `review`/`pr` run the runner's built-in lean agent —
    // `@gaunt-sloth/review` is a leaf package that does not depend on `@gaunt-sloth/agent`. That is
    // the same agent every other command resolves to, so the layering costs nothing today; giving
    // this package a dependency on the agent package to reach a backend seam would invert it.
    const runner = new GthAgentRunner(defaultStatusCallback, effectiveResolvers);
    try {
      await runner.init(command, config, new MemorySaver());
      await runner.processMessages(messages);
    } catch (error) {
      displayDebug(error instanceof Error ? error : String(error));
      // [[TUI-C71]] — `review` and `pr` wire no tool-approval callback, so an escalation here is
      // always the §6.2 error and an `attack` verdict is always the halt: the untrusted text this
      // catch prints is model-authored by construction. It goes through the SAME framed renderer
      // as every other surface — one row per line, each inside the gutter — instead of being
      // interpolated into a line the terminal is free to wrap back to column 0.
      if (error instanceof ApprovalStopError) {
        displayError('Failed to run review with agent.\n');
        for (const row of approvalStopRows(error.parts, { columns: stdout.columns })) {
          displayError(row);
        }
      } else {
        const reason = error instanceof Error ? error.message : String(error);
        displayError(
          reason
            ? `Failed to run review with agent.\n\n${reason}`
            : 'Failed to run review with agent.'
        );
      }
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
  } finally {
    // EXT-53: the indicator owns a 1s setInterval — an active libuv handle that keeps Node's event
    // loop from ever draining, so leaking it hangs the CLI forever after the work is done. The
    // `stop()` above sits where it does for output ordering (before the rating result / the
    // "report can be found in …" line); this `finally` guarantees the handle is also released when
    // anything above throws — notably `createReviewRateMiddleware()`, which is awaited outside any
    // catch, and `runner.cleanup()`, whose own `finally` rethrows straight past the `stop()`.
    // `stop()` is idempotent, so the normal path's second call is a no-op.
    progressIndicator?.stop();
  }
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
 *
 * CFG-52 — it is also gated on the unified `builtInTools` registry, resolved per-command first and
 * then root by {@link isGhReadFileToolEnabled}. Absence means enabled, so this stays opt-OUT.
 */
function maybeAddGhReadFileTool(
  config: GthConfig,
  command: 'pr' | 'review',
  prId: string | undefined
): void {
  const commandConfig = config.commands?.[command];
  const contentSource = commandConfig?.contentSource ?? config.contentSource;

  if (contentSource !== 'github') {
    return;
  }

  if (!isGhReadFileToolEnabled(config, command)) {
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

  config.tools = [...existingTools, getGhReadFileTool(config, prId, command)];
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
