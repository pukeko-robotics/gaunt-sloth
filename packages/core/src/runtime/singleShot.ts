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
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';
import type { AgentResolvers, GthAgentFactory, GthCommand } from '#src/core/types.js';
import { recordSessionSafe } from '#src/history/recordSession.js';
import type { GthRunStats } from '#src/core/types.js';
import { getProjectDir } from '#src/utils/systemUtils.js';

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

/**
 * Ask a question and get an answer from the LLM.
 *
 * This is the shared, non-interactive single-shot runtime behind both the conversational
 * `ask` command and the scripted `exec` command (prompt-as-script). The `command` argument
 * is forwarded to the agent so it can pick the right mode prompt (e.g. exec-mode for `exec`).
 *
 * @param source - The source of the question (used for file naming)
 * @param preamble - The preamble to send to the LLM
 * @param content - The content of the question
 * @param config - The resolved config
 * @param resolvers - Optional agent resolvers (tools/middleware)
 * @param command - The originating command (defaults to `ask`); selects the agent mode prompt
 * @param agentFactory - Optional backend factory (B5). When omitted the runner uses its built-in
 *   lean {@link GthLangChainAgent} default (unchanged behavior for existing callers). The app
 *   layer passes `resolveAgentFactory(config, 'lean')` so an explicit `agent.backend` is honored.
 * @returns A {@link SingleShotResult}: `ok` is `true` when the run completed without error, `false`
 *   when it failed (so callers such as `exec` can set a non-zero exit code); `answer`/`tokensInput`/
 *   `tokensOutput`/`tools` carry the SUT's answer text and run stats for callers that need them
 *   (e.g. `gth batch`/`gth eval`).
 */
export async function runSingleShot(
  source: string,
  preamble: string,
  content: string,
  config: GthConfig,
  resolvers?: AgentResolvers,
  command: GthCommand = 'ask',
  agentFactory?: GthAgentFactory
): Promise<SingleShotResult> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Thinking.');
  const messages = [new SystemMessage(preamble), new HumanMessage(content)];

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
    await runner.init(command, config, new MemorySaver());
    responseText = await runner.processMessages(messages);
  } catch (err) {
    succeeded = false;
    displayError(`Failed to get answer: ${err instanceof Error ? err.message : String(err)}`);
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
}
