import type { GthConfig } from '#src/config.js';
import {
  defaultStatusCallback,
  display,
  displayError,
  displaySuccess,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '#src/utils/consoleUtils.js';
import { getCommandOutputFilePath } from '#src/utils/fileUtils.js';
import { GthAgentRunner } from '#src/core/GthAgentRunner.js';
import { HumanMessage } from '@langchain/core/messages';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';
import type { AgentResolvers, GthAgentFactory, GthCommand } from '#src/core/types.js';
import { recordSessionTurnSafe } from '#src/history/recordSession.js';
import {
  openSessionCheckpointerSafe,
  type SessionCheckpointer,
} from '#src/history/sessionCheckpointer.js';
import type { GthAdvertisedTools, GthRunStats } from '#src/core/types.js';
import { getProjectDir, stdout } from '#src/utils/systemUtils.js';
import { ApprovalStopError, approvalStopRows } from '#src/core/shell/approvalStop.js';
import { displayTermination } from '#src/core/terminationNotice.js';
import { displayRunEndReport, runEndReport, type GthRunRecap } from '#src/core/runRecap.js';
import type { GthTerminationReason } from '#src/core/terminationReason.js';

/**
 * Result of a {@link runSingleShot} run: the pass/fail contract callers such as `ask`/`exec` have
 * always used (`ok`), plus the SUT's answer text and run stats (GS2-16's {@link GthRunStats}) that
 * were already computed internally but previously discarded. Extends `GthRunStats` rather than
 * restating `tokensInput`/`tokensOutput`/`tools` as parallel fields.
 */
export interface SingleShotResult extends GthRunStats {
  /** `true` when the run completed without error, `false` when it failed. */
  ok: boolean;
  /**
   * BATCH-32 — what the agent ADVERTISED to the model for this run: the full pre-`allowedTools`
   * inventory, the tools the allow-list removed, and the count of nameless ones.
   *
   * A sibling of the run stats rather than a field inside them: `GthRunStats` is the per-turn tally
   * the accumulator folds messages into, and this is fixed at `init`. `undefined` means no
   * inventory was observed (an agent that does not report one), which is a different answer from an
   * inventory listing no tools.
   */
  advertisedTools?: GthAdvertisedTools;
  /** The SUT's full answer text (`runner.processMessages()`'s return value). Empty on failure. */
  answer: string;
  /**
   * [[EXT-159]] — why the run ended, as a value.
   *
   * The structural twin of the line this runtime prints: a caller (and a test) reads the
   * classification here rather than matching the prose on the console, so no user-facing string is
   * the only carrier of it. `null` means no site classified the ending, which by this taxonomy's
   * contract is a site we missed — never a stand-in for an ordinary finish, which is recorded as
   * `completed`.
   */
  terminationReason: GthTerminationReason | null;
  /**
   * [[EXT-178]] — the end-of-run recap, when one was requested and produced; `null` otherwise.
   *
   * **The fact, not the prose.** The same principle [[EXT-159]] states for the termination reason
   * and [[EXT-158]] for the outstanding-work value: the classification a caller (and a test) reads
   * is this object, so no user-facing string is the only carrier of it. An embedder that wants to
   * render a recap its own way — or to ask whether the run reported itself complete — reads
   * `recap.complete` and `recap.work` rather than matching the sentence on the console.
   *
   * `null` collapses every "no recap" outcome deliberately; see `requestRunRecap` for why the
   * failures are a maintainer's question and not a user's.
   */
  recap: GthRunRecap | null;
  /**
   * GS2-106 — the conversation this run was recorded under, with its stable run id; absent when the
   * run was not recorded (history off, or the store could not be written). What a caller needs to
   * tell a person how to come back to this run. Nothing prints it yet.
   */
  conversation?: { conversationId: number; runId: string | null };
}

/** Options that qualify a {@link runSingleShot} run without changing how it behaves. */
export interface SingleShotOptions {
  /**
   * GS2-95 — the name of the command the USER typed, for the run header (`eval`, `batch`,
   * `workflow`, `gth-batch`). Omit it and the header names `command`, which is right for every
   * caller whose verb IS its name (`ask`, `exec`).
   *
   * It is deliberately NOT `command`: that argument selects the agent's mode prompt, so a caller
   * that renamed itself through it would change which system prompt its runs execute under.
   */
  displayCommand?: string;

  /**
   * [[EXT-158]] — announce, at the end of the run, that the agent's own checklist still had
   * non-completed items. **Scope (d), decided here rather than in a red cell.**
   *
   * ## WHY THIS IS OPT-IN, AND WHY THE DEFAULT IS THE QUIET ONE
   *
   * This runtime has two very different classes of caller. `gth ask` and `gth exec` are a person
   * running a verb and reading what comes back — the surface this notice exists for, and they set
   * this. `gth batch`, `gth eval` and `gth workflow` drive it as a HARNESS, hundreds of cells at a
   * time, folding each run into a report; a per-cell sentence about an unfinished checklist is
   * noise to a reader who is looking at aggregate outcomes, and it appears on precisely the cells
   * that PASSED, since the notice speaks only for the `completed` ending.
   *
   * A default-on flag with an opt-out would have put that output into every harness whose author
   * never heard of this node, and the first anyone would know of it is a changed report. Default-off
   * means the failure direction is a surface that stays silent until someone adds one line — which
   * is a missing notice rather than a changed contract, and it is recoverable by the person who
   * notices.
   *
   * **This is about the notice, never the detection.** The fact is recorded on every run through
   * every path; `runner.getOutstandingWork()` answers for a batch cell exactly as it does for
   * `gth ask`. Only whether a sentence is printed is what this decides.
   *
   * Note also that {@link displayRunEndReport}, which draws this notice, writes through
   * `displayNotice` and so goes to **stderr** — so even switched on it cannot change the stdout a
   * caller parses, nor the `answer` this function returns, which is what `gth batch`'s cases assert
   * on.
   */
  announceOutstandingWork?: boolean;

  /**
   * [[EXT-178]] — request an end-of-run recap on this run, subject to the user's `recap` rung.
   *
   * ## SCOPE (4), DECIDED HERE AND NOT IN A RED CELL — AND WHY IT IS A SECOND FLAG
   *
   * The surface table is the one {@link announceOutstandingWork} sets out, with the same split:
   * `gth ask` and `gth exec` are a person running a verb and reading what comes back, and they set
   * this; `gth batch`, `gth eval` and `gth workflow` drive this runtime as a harness and do not.
   *
   * **It is a separate flag rather than a second meaning for that one, because the two differ in
   * the thing that matters most about a default.** The notice is deterministic, free and bounded; a
   * recap is a model call — the user's tokens, the user's latency, the user's money — per cell.
   * Folding them together would mean a harness author who once opted into a free sentence had
   * thereby opted a thousand-cell suite into a thousand extra model calls, with no line in their
   * own code to point at. Two flags make the expensive one its own, visible decision.
   *
   * Excluded elsewhere by the same structure — a surface that does not ask does not get one:
   *
   * - `review` / `pr` end with a full written verdict that already says what was examined and what
   *   was found. A recap *of* a review is the banner problem in its purest form.
   * - ACP and AG-UI are embedders whose client owns the end-of-turn surface. Spending a model call
   *   server-side for a paragraph the protocol has no field for, and that the client may already be
   *   writing itself, is not ours to decide; [[EXT-158]]'s notice travels there as structured data,
   *   which is the right shape for a protocol.
   *
   * **Neither the rung nor this flag changes what a caller parses.** The recap is rendered through
   * `displayNotice`, which writes to **stderr**, and the `answer` this function returns is
   * untouched — the property [[EXT-158]] was careful to keep and that `gth batch`'s cases assert
   * on. The value itself reaches a caller as `SingleShotResult.recap`.
   */
  announceRunRecap?: boolean;
}

/**
 * Ask a question and get an answer from the LLM.
 *
 * This is the shared, non-interactive single-shot runtime behind both the conversational
 * `ask` command and the scripted `exec` command (prompt-as-script). The `command` argument
 * is forwarded to the agent so it can pick the right mode prompt (e.g. exec-mode for `exec`).
 *
 * @param source - The source of the question (used for file naming)
 * @param _preamble - Deprecated/ignored (BATCH-13): the agent composes the system prompt itself;
 *   see the body comment. Retained positionally so existing callers need no change.
 * @param content - The content of the question
 * @param config - The resolved config
 * @param resolvers - Optional agent resolvers (tools/middleware)
 * @param command - The originating command (defaults to `ask`); selects the agent mode prompt
 * @param agentFactory - Optional backend factory (B5). When omitted the runner uses its built-in
 *   lean {@link @gaunt-sloth/core!core/GthLangChainAgent.GthLangChainAgent | GthLangChainAgent} default. The app layer passes `resolveAgentFactory(config,
 *   'lean')`, which resolves to the same agent through the shared backend seam.
 * @param options - GS2-95: `displayCommand` names the run in the header when the caller's own name
 *   differs from the `command` it runs under (`gth eval` runs cases in `ask` mode). Header only —
 *   it never reaches the mode prompt.
 * @returns A {@link SingleShotResult}: `ok` is `true` when the run completed without error, `false`
 *   when it failed (so callers such as `exec` can set a non-zero exit code); `answer`/`tokensInput`/
 *   `tokensOutput`/`tools` carry the SUT's answer text and run stats for callers that need them
 *   (e.g. `gth batch`/`gth eval`).
 */
export async function runSingleShot(
  source: string,
  // BATCH-13: `_preamble` is retained for signature stability but is NO LONGER injected as a
  // SystemMessage. The agent (lean `GthLangChainAgent`, since GS2-21) COMPOSES the full system
  // prompt itself from the config — backstory + guidelines +
  // per-command mode prompt + system prompt, PLUS the model-identity (GS2-34) and MCP-instructions
  // (EXT-32) notes — and hand it to `createAgent` as `systemPrompt`. Also passing this preamble as a
  // leading SystemMessage produced TWO system messages, which `@langchain/anthropic` rejects
  // ("System messages are only permitted as the first passed message"), breaking EVERY single-shot
  // run (ask/exec/batch/eval) on Anthropic on BOTH backends (Google/OpenAI silently merged them).
  // The agent's composed prompt is a superset of this preamble, so dropping it is content-preserving.
  _preamble: string,
  content: string,
  config: GthConfig,
  resolvers?: AgentResolvers,
  command: GthCommand = 'ask',
  agentFactory?: GthAgentFactory,
  options?: SingleShotOptions
): Promise<SingleShotResult> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Thinking.');
  // Opened in the outer `try` and closed in its `finally`, AFTER the run is recorded: the close is
  // what runs retention, and it has to see the conversation row that names this run's thread.
  let checkpointer: SessionCheckpointer | undefined;
  try {
    // Only the human turn: the agent supplies the system prompt via `createAgent({ systemPrompt })`.
    const messages = [new HumanMessage(content)];

    // Resolve output path and initialize session logging if enabled
    const filePath = getCommandOutputFilePath(config, source);
    if (filePath) {
      initSessionLogging(filePath, config.streamSessionInferenceLog);
    }

    // GS2-106 — a single-shot run checkpoints DURABLY whenever it will be recorded, through the
    // same saver, the same thread-per-conversation link and the same degrade policy as an
    // interactive session. Andrew's ruling of 2026-09-26 on GS2-106, replacing GS2-20's decision to
    // keep this path in memory.
    //
    // **Why.** Resuming a non-interactive run must go through ONE mechanism, the one interactive
    // resume already uses: re-entering the graph from its checkpoint. The alternative — replaying
    // the recorded prompt and answer into a fresh agent — restores a transcript, and a transcript is
    // not what the next turn builds on. What an `ask`/`exec` run actually produced is mostly TOOL
    // RESULTS: files it read, commands it ran, what an MCP server returned. None of that is in the
    // recorded answer, so a replayed run would continue with the evidence gone and the conclusions
    // kept. Only the checkpoint has it.
    //
    // **What does not change.** With `history.enabled: false` this is a `MemorySaver` exactly as
    // before, silently, and nothing is written. A store that will not open falls back to a
    // `MemorySaver` with a notice on stderr, and the conversation is recorded with no thread; a
    // checkpoint write that fails mid-run drops the write, lets the run finish, and cuts the link
    // once the row exists (`bindConversation` below applies a failure that came first). None of it
    // can change what the run prints on stdout or the answer returned from here.
    //
    // **Retention.** GS2-107's automatic pass deletes only threads NO conversation row names, so a
    // linked single-shot thread is kept exactly as long as an interactive one, and only
    // `gth history prune` removes it. The thread is unnamed for the length of the run, until the
    // row below is written; the saver's own write set and the grace window cover that gap, as they
    // do for an interactive session after `/clear`.
    checkpointer = openSessionCheckpointerSafe(config);

    // Run via Agent Runner (consistent with interactive session)
    const runner = new GthAgentRunner(defaultStatusCallback, resolvers, agentFactory);
    let succeeded = true;
    let responseText = '';
    const startedAt = Date.now();
    try {
      await runner.init(command, config, checkpointer.saver, {
        displayCommand: options?.displayCommand,
        // Only a durable saver has a thread worth naming: in memory the runner mints its own, as
        // it always has.
        ...(checkpointer.durable ? { threadId: checkpointer.threadId } : {}),
      });
      responseText = await runner.processMessages(messages);
    } catch (err) {
      succeeded = false;
      // [[TUI-C71]] — §6.2's escalation and §4.2's halt reach a person HERE and nowhere else on
      // this path: there is no prompt to attach anything to, so this message is the whole
      // explanation and it is built almost entirely out of model-authored text. Its untrusted
      // halves go through the [[TUI-C26]] gutter, one row per line, so a payload crafted to forge
      // terminal chrome cannot reach column 0 even on a line the terminal would have wrapped. The
      // rows are printed on the same channel as the wrapper so a redirected stderr still carries
      // the whole thing.
      if (err instanceof ApprovalStopError) {
        displayError('Failed to get answer:');
        for (const row of approvalStopRows(err.parts, { columns: stdout.columns })) {
          displayError(row);
        }
      } else {
        displayError(`Failed to get answer: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      await runner.cleanup();
    }

    // [[EXT-159]] — say why the run ended, on the surface the user is actually looking at.
    //
    // This is the non-interactive verb's live session: there is no prompt to come back to and no
    // transcript to scroll, so the moment the process is about to print its last line is the only
    // moment this can reach anyone. Read post-cleanup for the same reason the stats below are — the
    // runner snapshots the agent's answer at `cleanup()`, which the `finally` above has already run.
    //
    // Placed AFTER the catch's own message rather than instead of it: [[EXT-92]] owns rendering a
    // provider error as prose, and this node supplies the classification that prose has never
    // carried. On the success path an ordinary completion says nothing, so a run that worked looks
    // exactly as it did.
    let terminationReason: GthTerminationReason | null = null;
    try {
      terminationReason = runner.getTerminationReason();
    } catch {
      /* fail-soft: explaining a run must never be what breaks it */
    }
    displayTermination(terminationReason);
    // [[EXT-158]] + [[EXT-178]] — and, for the callers that asked for it, what the clean stop left
    // behind: a recap when one was requested and produced, otherwise the unfinished-checklist
    // notice. Never both — `runEndReport` is the single place that decides, and it decides with the
    // recap already in hand, so a run whose recap timed out still gets the notice.
    //
    // The recap is awaited HERE rather than before `cleanup()` because the gate needs the
    // termination reason, which is read post-cleanup for the reason given above; the runner keeps
    // the inputs and (only when a rung is set) the config alive across that boundary for exactly
    // this call.
    //
    // TWO catches rather than one, and the split is load-bearing: a recap that threw must still
    // leave the notice standing. A single `try` around both would let any failure of the paid,
    // network-facing half silently take the free, deterministic half down with it — which is the
    // subsumption turning into a regression by accident rather than by decision.
    let recap: GthRunRecap | null = null;
    if (options?.announceRunRecap) {
      try {
        recap = await runner.requestRunRecap(terminationReason);
      } catch {
        /* fail-soft: the notice below is the floor and still speaks */
      }
    }
    if (options?.announceOutstandingWork || options?.announceRunRecap) {
      try {
        displayRunEndReport(runEndReport(recap, runner.getOutstandingWork(), terminationReason));
      } catch {
        /* fail-soft: explaining a run must never be what breaks it */
      }
    }

    // GS2-16: live token usage + invoked tool names for this run (fail-soft; empty when the
    // provider reported no usage / the runner has no stats). Read post-cleanup — the runner
    // snapshots stats at cleanup() so this still reflects the finished run.
    let runStats: GthRunStats = { tools: [] };
    try {
      const s = runner.getRunStats?.();
      if (s) runStats = s;
    } catch {
      /* fail-soft: analytics must never affect this run */
    }

    // BATCH-32: what this run's agent advertised to the model — `gth eval`'s coverage denominator.
    // Read post-cleanup alongside the stats above, from the snapshot the runner took before it
    // dropped the agent.
    let advertisedTools: GthAdvertisedTools | undefined;
    try {
      advertisedTools = runner.getAdvertisedTools?.();
    } catch {
      /* fail-soft: reporting what was advertised must never affect this run */
    }

    // GS2-7 (B20): local, fail-soft session history. A no-op when `history.enabled` is false; never
    // throws (recordSessionTurnSafe is fully guarded) so a DB problem can't abort or alter this run.
    // GS2-16 threads token/tool analytics; costUsd is intentionally left unset (no reliable price).
    //
    // GS2-106: the row this opens carries the run's thread, so the checkpointed state is reachable
    // from the conversation id and its run id.
    const recorded = recordSessionTurnSafe(config, {
      threadId: checkpointer.durable ? checkpointer.threadId : undefined,
      command,
      // The run's PROJECT ROOT, not the directory this run is in: `getProjectDir()` is the
      // discovered config root whenever one was found above us. Nothing may render it as where
      // the user was.
      project: getProjectDir(),
      model: config.modelDisplayName,
      prompt: content,
      response: responseText,
      tokensInput: runStats.tokensInput,
      tokensOutput: runStats.tokensOutput,
      tools: runStats.tools.length > 0 ? runStats.tools : undefined,
      durationMs: Date.now() - startedAt,
    });
    // GS2-20's degrade half, now for this path too: name the row a failed checkpoint write must mark
    // unresumable. A failure that happened during the run is applied here, cutting the link that
    // was just written.
    checkpointer.bindConversation?.(recorded?.conversationId);

    progressIndicator?.stop();

    if (config.writeOutputToFile === false) {
      display('\n'); // something going on in some terminals, they swallow last line of output
    }
    if (filePath) {
      try {
        flushSessionLog();
        stopSessionLogging();
        displaySuccess(`\n\nThis report can be found in ${filePath}`);
      } catch (error) {
        displayError(`Failed to write answer to file: ${filePath}`);
        displayError(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      ok: succeeded,
      answer: responseText,
      terminationReason,
      recap,
      ...runStats,
      ...(advertisedTools ? { advertisedTools } : {}),
      ...(recorded
        ? { conversation: { conversationId: recorded.conversationId, runId: recorded.runId } }
        : {}),
    };
  } finally {
    // GS2-106 — release the checkpoint connection. After the record on the normal path, so the
    // retention pass the close runs sees this run's thread named; on a throw it simply closes.
    checkpointer?.close();
    // EXT-53: the indicator owns a 1s setInterval — an active libuv handle that keeps Node's event
    // loop from ever draining, so leaking it hangs the CLI forever after the work is done. The
    // `stop()` above sits where it does for output ordering (before the trailing newline / the
    // "report can be found in …" line); this `finally` guarantees the handle is also released when
    // anything above throws — notably `runner.cleanup()`, which is outside the inner catch.
    // `stop()` is idempotent, so the normal path's second call is a no-op.
    progressIndicator?.stop();
  }
}
