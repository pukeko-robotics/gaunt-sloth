import type { GthConfig } from '@gaunt-sloth/core/config.js';
import {
  defaultStatusCallback,
  display,
  displayError,
  displaySuccess,
  flushSessionLog,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getCommandOutputFilePath } from '#src/utils/fileUtils.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { MemorySaver } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ProgressIndicator } from '@gaunt-sloth/core/utils/ProgressIndicator.js';
import type { AgentResolvers, GthCommand } from '@gaunt-sloth/core/core/types.js';

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
 * @returns `true` when the run completed without error, `false` when it failed (so callers
 *   such as `exec` can set a non-zero exit code).
 */
export async function askQuestion(
  source: string,
  preamble: string,
  content: string,
  config: GthConfig,
  resolvers?: AgentResolvers,
  command: GthCommand = 'ask'
): Promise<boolean> {
  const progressIndicator = config.streamOutput ? undefined : new ProgressIndicator('Thinking.');
  const messages = [new SystemMessage(preamble), new HumanMessage(content)];

  // Resolve output path and initialize session logging if enabled
  const filePath = getCommandOutputFilePath(config, source);
  if (filePath) {
    initSessionLogging(filePath, config.streamSessionInferenceLog);
  }

  // Run via Agent Runner (consistent with interactive session)
  const runner = new GthAgentRunner(defaultStatusCallback, resolvers);
  let succeeded = true;
  try {
    await runner.init(command, config, new MemorySaver());
    await runner.processMessages(messages);
  } catch (err) {
    succeeded = false;
    displayError(`Failed to get answer: ${err instanceof Error ? err.message : String(err)}`);
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
    } catch (error) {
      displayError(`Failed to write answer to file: ${filePath}`);
      displayError(error instanceof Error ? error.message : String(error));
    }
  }

  return succeeded;
}
