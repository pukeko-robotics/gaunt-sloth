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
import { MemorySaver } from '@langchain/langgraph';
import { HumanMessage } from '@langchain/core/messages';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';
import type { AgentResolvers, GthAgentFactory, GthCommand } from '#src/core/types.js';
import { recordSessionSafe } from '#src/history/recordSession.js';
import type { GthRunStats } from '#src/core/types.js';
import { getProjectDir, stdout } from '#src/utils/systemUtils.js';
import { ApprovalStopError, approvalStopRows } from '#src/core/shell/approvalStop.js';

/**
 * Result of a {@link runSingleShot} run: the pass/fail contract callers such as `ask`/`exec` have
 * always used (`ok`), plus the SUT's answer text and run stats (GS2-16's {@link GthRunStats}) that
 * were already computed internally but previously discarded. Extends `GthRunStats` rather than
 * restating `tokensInput`/`tokensOutput`/`tools` as parallel fields.
 */
export interface SingleShotResult extends GthRunStats {
  /** `true` when the run completed without error, `false` when it failed. */
  ok: boolean;
  /** The SUT's full answer text (`runner.processMessages()`'s return value). Empty on failure. */
  answer: string;
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
 *   lean {@link GthLangChainAgent} default. The app layer passes `resolveAgentFactory(config,
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
  try {
    // Only the human turn: the agent supplies the system prompt via `createAgent({ systemPrompt })`.
    const messages = [new HumanMessage(content)];

    // Resolve output path and initialize session logging if enabled
    const filePath = getCommandOutputFilePath(config, source);
    if (filePath) {
      initSessionLogging(filePath, config.streamSessionInferenceLog);
    }

    // Run via Agent Runner (consistent with interactive session)
    const runner = new GthAgentRunner(defaultStatusCallback, resolvers, agentFactory);
    let succeeded = true;
    let responseText = '';
    const startedAt = Date.now();
    try {
      await runner.init(command, config, new MemorySaver(), {
        displayCommand: options?.displayCommand,
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

    // GS2-7 (B20): opt-in, fail-soft session history. A no-op unless `history.enabled`; never throws
    // (recordSessionSafe is fully guarded) so a DB problem can't abort or alter this run.
    // GS2-16 threads token/tool analytics; costUsd is intentionally left unset (no reliable price).
    recordSessionSafe(config, {
      command,
      project: getProjectDir(),
      model: config.modelDisplayName,
      prompt: content,
      response: responseText,
      tokensInput: runStats.tokensInput,
      tokensOutput: runStats.tokensOutput,
      tools: runStats.tools.length > 0 ? runStats.tools : undefined,
      durationMs: Date.now() - startedAt,
    });

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

    return { ok: succeeded, answer: responseText, ...runStats };
  } finally {
    // EXT-53: the indicator owns a 1s setInterval — an active libuv handle that keeps Node's event
    // loop from ever draining, so leaking it hangs the CLI forever after the work is done. The
    // `stop()` above sits where it does for output ordering (before the trailing newline / the
    // "report can be found in …" line); this `finally` guarantees the handle is also released when
    // anything above throws — notably `runner.cleanup()`, which is outside the inner catch.
    // `stop()` is idempotent, so the normal path's second call is a no-op.
    progressIndicator?.stop();
  }
}
