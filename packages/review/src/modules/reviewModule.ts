import type { GthConfig, RatingConfig } from '@gaunt-sloth/core/config.js';
import {
  isGhReadFileDiffToolEnabled,
  isGhReadFileToolEnabled,
  selectScopedPrompts,
} from '@gaunt-sloth/core/config.js';
import {
  measureScopedPrompts,
  SCOPED_PROMPT_BUDGET_BYTES,
} from '@gaunt-sloth/core/utils/llmUtils.js';
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
import { displayTermination } from '@gaunt-sloth/core/core/terminationNotice.js';
import { displayOutstandingWork } from '@gaunt-sloth/core/core/outstandingWork.js';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import { get as getGhReadFileTool, GTH_GH_READ_FILE_TOOL_NAME } from '#src/tools/ghReadFileTool.js';
import {
  get as getGhReadFileDiffTool,
  GTH_GH_READ_FILE_DIFF_TOOL_NAME,
} from '#src/tools/ghReadFileDiffTool.js';
import type { LargePrListing } from '#src/utils/prFilesListing.js';

/** Extra context about the review, used to bind GitHub-only tools to the PR under review. */
export interface ReviewContext {
  /** PR number under review; undefined in `gth pr` discovery mode (current branch's PR). */
  prId?: string;
  /**
   * CFG-70 — the paths this run's diff touches, for selecting `prompts.paths` entries.
   *
   * **Extracted from the content-source output alone**, never from the whole message: `review()`
   * is handed requirements + the diff + `--file` contents + stdin + `--message` joined together,
   * and a requirements document that quotes a diff would otherwise inject paths no change went
   * near — attaching one module's guidelines to another module's review, silently.
   *
   * An embedder populates it itself with `extractChangedPathsFromDiff`, exported from this
   * package's barrel for exactly that. An empty array and an absent one are treated alike: both
   * mean no path was found, and both are worth saying out loud when entries are configured.
   */
  changedPaths?: string[];
  /**
   * REL-6 — present when the `github` source's triage named files without their diff, as its
   * `onLargePr` callback reported it. Its presence is what gives the agent the per-file diff tool,
   * which serves patches from the listing carried here. Absent, the run is exactly what it was
   * before the tool existed. A caller that fetches content through the source must pass this on,
   * because the content it got tells the model the tool exists.
   */
  largePr?: LargePrListing;
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
  // SystemMessage. The agent COMPOSES the full system prompt itself — backstory +
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
    // REL-6: on a PR too large to show whole, a per-file diff read served from the listing the
    // source already fetched. Only when the triage named files without their diff.
    maybeAddGhReadFileDiffTool(config, command, reviewContext?.largePr);

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
    // rung that strips the preamble — and on that rung it IS the run header, which is why the agent
    // emits none of its own for `review`/`pr` (GS2-95: both render the same line, so a second
    // emission would print the header twice on one screen).
    //
    // GS2-93: `none` is the one rung that reaches it, and it silences the block outright. That
    // deliberately reverses REL-12 for a user who asks for it: a caller piping a review into their
    // own template or diffing captured stdout needs a byte-clean stream, and nobody loses
    // attribution without setting this key.

    // CFG-70 — select the path-scoped prompt entries this diff activates, BEFORE the agent below
    // composes its system prompt from the same config object. Mutating the resolved config inside
    // `review()` is the established shape here: `maybeAddGhReadFileTool` above does it too.
    //
    // Placed after `initSessionLogging` so its diagnostics reach the report file as well as the
    // terminal, and before the heading guard so the report line can join the heading inside it.
    const scopedPromptsReport = applyScopedPrompts(config, reviewContext?.changedPaths);

    if (config.output?.header !== 'none') {
      display(reviewHeadingBlock(command, config.modelDisplayName, config.modelProviderType));
      // CFG-70 — inside the GS2-93 guard, with the heading, because it is review-document
      // provenance of the same kind: which module guidelines this verdict was formed under. A
      // caller who silenced the header to diff captured stdout byte-for-byte would otherwise find
      // a line they did not ask for at the top of their stream.
      //
      // The WARNINGS `applyScopedPrompts` emits are deliberately NOT in here. They are diagnostics
      // about the run's configuration, not content of the review, and the one situation that most
      // needs them — a misspelled glob matching nothing — is indistinguishable from a working run
      // without them. `output.header: 'none'` asks for a clean document, not for silence about
      // config that did not do what it says.
      if (scopedPromptsReport) {
        display(scopedPromptsReport);
      }
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
      // GS2-20 — considered for the durable saver and deliberately kept in memory. A review is a
      // one-shot run over a diff, not a conversation: it ends with its verdict and there is no next
      // turn to come back to. Its output is already persisted, as the review file.
      await runner.init(command, config, new MemorySaver());
      await runner.processMessages(messages);
    } catch (error) {
      // REL-24 — the run failed, so the PROCESS says it failed. Reporting a failure is not the
      // same as signalling one: `_review-shared.yml` keys its "Check review step result" step on
      // the review step's OUTCOME, so a review that printed a provider error and exited 0 posted
      // what reads as a verdict on a build CI called green.
      //
      // Deliberately NOT gated on `commands.<cmd>.rating.errorOnReviewFail`. That flag governs a
      // VERDICT — exit 1 when the review scores below its threshold — and a run that never
      // reached a verdict has no score to configure. The rating path below already draws the same
      // line: its missing-artifact branch sets the code without consulting the flag, because a
      // rating that did not happen is a malfunction rather than a low score.
      //
      // Set before the branches, so an approvals stop and an ordinary agent error signal alike.
      setExitCode(1);
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

    // [[EXT-159]] — say why the run ended, on the one surface `review` and `pr` have.
    //
    // These verbs write a report and exit; there is no prompt to return to, so this line and the
    // catch above are everything the user gets. Read after `cleanup()` for the reason the runner
    // snapshots at cleanup: the agent is gone by here, and its own sites are the innermost ones.
    // A run that produced a review says nothing — an ordinary completion is not news.
    try {
      const reason = runner.getTerminationReason();
      displayTermination(reason);
      // [[EXT-158]] — and whether the run finished its own checklist. `review` and `pr` are
      // long multi-step runs with no prompt to come back to, so a review that stopped halfway
      // through its plan and wrote a partial report is exactly the silent ending this fills.
      displayOutstandingWork(runner.getOutstandingWork(), reason);
    } catch {
      /* fail-soft: explaining a run must never be what breaks it */
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
 * CFG-70 — a count and the noun it governs, agreeing. Every number below is routinely 1: a
 * one-file diff, a project with a single `prompts.paths` entry. "1 changed files" in a line the
 * review document carries reads as a bug in the tool, which is the wrong thing for a line whose
 * whole job is to be believed about what the review ran on.
 */
function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const ENTRY_NOUN = ['configured prompts.paths entry', 'configured prompts.paths entries'] as const;

/**
 * CFG-70 — match this run's changed paths against `prompts.paths`, set the runtime field the
 * prompt-reading layer reads, and say what happened.
 *
 * @returns the one-line report for the review document when at least one entry matched, else
 *   `undefined`. Warnings are emitted here directly; the report line is returned so the caller can
 *   place it inside the `output.header` guard, which the warnings are not subject to.
 *
 * A misspelled glob (`packages/vue-ui/*` where `/**` was meant), or `--content-source text`,
 * produces zero matches and a review that runs on the root guidelines alone — **indistinguishable
 * from a working run** unless the run says so. Hence three outcomes rather than one:
 *
 * - at least one entry matched → the report line;
 * - paths found, no entry matched → a warning naming how many paths were seen, because the number
 *   is what separates "my globs are wrong" from "the diff really is outside every module";
 * - no paths at all → a warning that the content source is not a unified diff, which is the actual
 *   cause when `--content-source text` or a file review reaches here.
 *
 * Nothing is said at all when no entries are configured: that is every run of every project not
 * using the feature.
 */
function applyScopedPrompts(
  config: GthConfig,
  changedPaths: string[] | undefined
): string | undefined {
  const entries = config.prompts?.paths;
  if (!entries?.length) {
    return undefined;
  }

  const paths = changedPaths ?? [];
  if (paths.length === 0) {
    displayWarning(
      `No "diff --git" header was found in the content under review, so the ` +
        `${countOf(entries.length, ...ENTRY_NOUN)} could not be selected from. Path-scoped ` +
        `prompts need a unified diff — check the content source for this run.`
    );
    return undefined;
  }

  const selected = selectScopedPrompts(paths, entries);
  if (selected.length === 0) {
    displayWarning(
      `${countOf(entries.length, ...ENTRY_NOUN)} matched none of the ` +
        `${countOf(paths.length, 'changed path')} in this diff, so no module prompts were ` +
        `attached. Check the match globs against the paths the diff actually touches.`
    );
    return undefined;
  }

  config.scopedPrompts = selected;

  // The budget check, once per run and from here: this is the only site that knows the final
  // selection, and a "have I warned yet" module flag would misbehave across the several agent
  // inits a single process performs. Warn, never truncate — a guideline cut mid-sentence is worse
  // than a long prompt, because the model then follows a rule whose exception was removed.
  const budget = measureScopedPrompts(selected, config);
  if (budget.overBudget) {
    displayWarning(
      `Path-scoped prompts add ${budget.totalBytes} bytes to this run's prompt ` +
        `(${budget.entryNames.join(', ')}), over the ${SCOPED_PROMPT_BUDGET_BYTES}-byte guide. ` +
        `Nothing was truncated; consider narrowing the match globs or shortening those files.`
    );
  }

  return (
    `Scoped prompts: ${selected.map((entry) => entry.name).join(', ')} ` +
    `(${selected.length} of ${countOf(entries.length, 'entry', 'entries')}, ` +
    `${countOf(paths.length, 'changed file')})`
  );
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

/**
 * REL-6: register `gth_gh_read_file_diff` for this run when, and only when, the triage named files
 * without their diff (`largePr` is the engagement signal; see {@link LargePrListing}).
 *
 * **Any instance already in `config.tools` is removed first**, unlike the read-file tool's
 * skip-if-present. `review()` mutates the config it is handed, and an embedder or the server may
 * hand the same object to the next review: an instance left behind would serve the previous PR's
 * listing to a PR that is not even large. Replacing it makes the tool, and the listing it holds,
 * belong to this run alone.
 */
function maybeAddGhReadFileDiffTool(
  config: GthConfig,
  command: 'pr' | 'review',
  largePr: LargePrListing | undefined
): void {
  const existingTools = (
    Array.isArray(config.tools) ? config.tools : []
  ) as StructuredToolInterface[];
  const isDiffTool = (t: StructuredToolInterface): boolean =>
    typeof t === 'object' &&
    t !== null &&
    'name' in t &&
    t.name === GTH_GH_READ_FILE_DIFF_TOOL_NAME;
  const others = existingTools.filter((t) => !isDiffTool(t));
  if (others.length !== existingTools.length) {
    config.tools = others;
  }

  if (!largePr || largePr.elidedCount <= 0) {
    return;
  }
  if (!isGhReadFileDiffToolEnabled(config, command)) {
    return;
  }

  // What the tool's own messages may point at: the read-file tool as this run actually has it.
  const readFileToolPresent = others.some(
    (t) =>
      typeof t === 'object' && t !== null && 'name' in t && t.name === GTH_GH_READ_FILE_TOOL_NAME
  );
  config.tools = [
    ...others,
    getGhReadFileDiffTool(
      config,
      { binding: largePr.binding, entries: largePr.entries },
      command,
      readFileToolPresent
    ),
  ];
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
