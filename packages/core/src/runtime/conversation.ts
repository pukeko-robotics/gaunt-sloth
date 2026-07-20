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
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Message } from '#src/core/types.js';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';
import type { AgentResolvers, GthAgentFactory, GthCommand } from '#src/core/types.js';
import { recordSessionSafe } from '#src/history/recordSession.js';
import type { GthRunStats } from '#src/core/types.js';
import { getProjectDir } from '#src/utils/systemUtils.js';

/**
 * One turn's result inside a {@link runConversation} run: the per-turn `ok`/`answer` plus that
 * turn's run stats (GS2-16 {@link GthRunStats} — token usage + invoked tools), captured PER TURN (a
 * per-invoke delta, not the cumulative conversation total). `ok` is `false` when that turn's agent
 * invocation failed (`error` set, `answer` empty). Extends `GthRunStats` rather than restating its
 * fields — same shape {@link ../runtime/singleShot.js SingleShotResult} uses.
 */
export interface ConversationTurnResult extends GthRunStats {
  /** `true` when this turn completed without error, `false` when it failed. */
  ok: boolean;
  /** This turn's full answer text (`runner.processMessages()`'s return value). Empty on failure. */
  answer: string;
  /** Set when `ok` is `false`: why this turn failed. */
  error?: string;
}

/**
 * Run a scripted MULTI-TURN conversation and return one {@link ConversationTurnResult} per turn.
 *
 * This is the **conversational** counterpart to {@link ../runtime/singleShot.js runSingleShot}
 * (which is stateless — a fresh agent per call). It builds the agent + resolves tools ONCE, then
 * runs each turn against the ACCUMULATED message history so cross-turn "memory" / identity behaviour
 * is real, and cleans up ONCE at the end (reusing runSingleShot's cleanup discipline — the resolvers
 * are the caller's to tear down, exactly as with runSingleShot).
 *
 * **History mechanism = stateless replay of the growing message array.** Messages accumulate as
 * `[SystemMessage(preamble)]` then, per turn, a `HumanMessage(user)` is appended, the agent runs on
 * the WHOLE array, and its answer is appended as an `AIMessage` so the next turn sees it. Before each
 * turn the runner's thread is rotated ({@link GthAgentRunner.resetThread}) so the checkpointer starts
 * empty and the replayed array is the sole history (no `add_messages` double-append). This mirrors
 * the AG-UI server's "client is the source of truth for history — it sends the full message list
 * every turn" model and reuses the existing `processMessages` + `resetThread` machinery with no new
 * agent surface. **Known limitation (unverified pending a live pass):** replay carries prior
 * *answers* (as `AIMessage` text) but NOT prior tool-call / tool-result messages — a checkpointer-
 * thread approach (send only the new message, let `add_messages` accumulate) would preserve those.
 *
 * **Per-turn tool capture (GS2-16):** `processMessages` resets the analytics tally at its top, so
 * `getRunStats()` read right after each turn returns THAT turn's tool/token delta (not cumulative).
 *
 * A turn that fails is recorded (`ok:false`, `error`) and the conversation STOPS (later turns depend
 * on the broken context), so the returned array may be shorter than `userMessages` — the caller
 * (`gth eval`'s runner) fails the un-run turns.
 *
 * @param source - The source label (used for output/session-file naming), e.g. `EVAL-<cellId>`.
 * @param preamble - The system preamble sent once as the conversation's `SystemMessage`.
 * @param userMessages - The ordered user turns to send (one conversation).
 * @param config - The resolved config.
 * @param resolvers - Optional agent resolvers (tools/middleware); the caller owns their cleanup.
 * @param command - The originating command (defaults to `ask`); selects the agent mode prompt.
 * @param agentFactory - Optional backend factory (B5); omitted = the runner's lean default.
 * @returns One {@link ConversationTurnResult} per turn attempted, in turn order.
 */
export async function runConversation(
  source: string,
  preamble: string,
  userMessages: string[],
  config: GthConfig,
  resolvers?: AgentResolvers,
  command: GthCommand = 'ask',
  agentFactory?: GthAgentFactory
): Promise<ConversationTurnResult[]> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Thinking.');

  // Resolve output path and initialize session logging if enabled (same discipline as runSingleShot;
  // a no-op when `writeOutputToFile` is off, as `gth eval` forces it — getCommandOutputFilePath null).
  const filePath = getCommandOutputFilePath(config, source);
  if (filePath) {
    initSessionLogging(filePath, config.streamSessionInferenceLog);
  }

  // Build the agent + resolve tools ONCE for the whole conversation (the MCP connection / any OAuth /
  // the toolset must persist across turns so cross-turn memory is real). Cleaned up once, in finally.
  const runner = new GthAgentRunner(defaultStatusCallback, resolvers, agentFactory);
  const results: ConversationTurnResult[] = [];
  // The accumulated conversation: [system, user1, ai1, user2, ai2, …]. Each turn replays the whole
  // array against a freshly-rotated thread (see the doc block).
  const messages: Message[] = [new SystemMessage(preamble)];

  try {
    await runner.init(command, config, new MemorySaver());

    for (const userMessage of userMessages) {
      // Rotate to a fresh (empty) checkpointer thread so this turn's replay of the full `messages`
      // array is the sole history the agent sees — no double-append from a prior turn's checkpoint.
      runner.resetThread();
      messages.push(new HumanMessage(userMessage));

      const startedAt = Date.now();
      let answer = '';
      let ok = true;
      let error: string | undefined;
      try {
        answer = await runner.processMessages(messages);
        // Append this turn's answer so the NEXT turn's replay includes it (cross-turn memory).
        messages.push(new AIMessage(answer));
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : String(err);
        displayError(`Failed to get answer: ${error}`);
      }

      // GS2-16: read this turn's token/tool delta from the live agent (before cleanup). Fail-soft —
      // analytics must never affect the run. `processMessages` reset the tally at its top, so this is
      // THIS turn's usage, not the conversation's cumulative total.
      let runStats: GthRunStats = { tools: [] };
      try {
        const s = runner.getRunStats?.();
        if (s) runStats = s;
      } catch {
        /* fail-soft */
      }

      // GS2-7 (B20): opt-in, fail-soft per-turn session history. A no-op unless `history.enabled`.
      recordSessionSafe(config, {
        command,
        project: getProjectDir(),
        model: config.modelDisplayName,
        prompt: userMessage,
        response: answer,
        tokensInput: runStats.tokensInput,
        tokensOutput: runStats.tokensOutput,
        tools: runStats.tools.length > 0 ? runStats.tools : undefined,
        durationMs: Date.now() - startedAt,
      });

      results.push({ ok, answer, error, ...runStats });

      // A failed turn breaks the conversation's context — stop rather than run later turns on it.
      if (!ok) break;
    }
  } finally {
    await runner.cleanup();
  }

  progressIndicator?.stop();

  if (config.writeOutputToFile === false) {
    display('\n'); // something going on in some terminals, they swallow last line of output
  }
  if (filePath) {
    try {
      flushSessionLog();
      stopSessionLogging();
      displaySuccess(`\n\nThis report can be found in ${filePath}`);
    } catch (err) {
      displayError(`Failed to write answer to file: ${filePath}`);
      displayError(err instanceof Error ? err.message : String(err));
    }
  }

  return results;
}
