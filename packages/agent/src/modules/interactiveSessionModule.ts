import { CommandLineConfigOverrides, GthConfig, initConfig } from '@gaunt-sloth/core/config.js';
import {
  defaultStatusCallback,
  display,
  displayInfo,
  displayWarning,
  flushSessionLog,
  formatInputPrompt,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import {
  createInterface,
  error,
  exit,
  setRawMode,
  stdin as input,
  stdout as output,
} from '@gaunt-sloth/core/utils/systemUtils.js';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createResolvers } from '#src/resolvers.js';
import { gthDeepAgentFactory } from '#src/core/gthDeepAgentFactory.js';

export interface SessionConfig {
  mode: 'chat' | 'code';
  readModePrompt: (config: Pick<GthConfig, 'identityProfile'>) => string | null;
  description: string;
  readyMessage: string;
  exitMessage: string;
}

export async function createInteractiveSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message?: string
) {
  const config = { ...(await initConfig(commandLineConfigOverrides)) };
  const checkpointSaver = new MemorySaver();
  // Initialize Runner

  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }
  const runner = new GthAgentRunner(defaultStatusCallback, createResolvers(), gthDeepAgentFactory);

  try {
    await runner.init(sessionConfig.mode, config, checkpointSaver);
    const rl = createInterface({ input, output });
    let shouldExit = false;

    // Tool-approval (human-in-the-loop) prompt for gated tools — currently the opt-in
    // `run_shell_command`. When a run suspends on such a tool call, the runner calls this with
    // the pending command. EXT-9 Tier-2: instead of a bare y/N, offer a scoped choice so the
    // human can stop re-prompting for an operation they trust:
    //   [o]nce    — approve this single invocation only (persists nothing),
    //   [s]ession — auto-approve this command's classified prefix for the rest of the session,
    //   [a]lways  — additionally persist it to the project allow-list,
    //   anything else → reject (fail-closed).
    // The runner consults the allow-list BEFORE calling this, so trusted commands never reach
    // this prompt at all. (The Ink TUI surfaces the same scoped prompt via an approval bridge —
    // see tuiSessionModule's createApprovalBridge + the <ApprovalPrompt> component.)
    runner.setToolApprovalCallback(async (pending) => {
      const commandText =
        typeof pending.args.command === 'string'
          ? (pending.args.command as string)
          : JSON.stringify(pending.args);
      displayWarning(`\nThe agent wants to run a shell command via ${pending.name}:`);
      display(`\n    ${commandText}\n`);
      // EXT-10: if the LLM-as-judge gate escalated (rather than auto-approving) this command, show
      // its flag + reason before the human decides.
      if (pending.safetyVerdict) {
        displayWarning(
          `⚠ safety judge (${pending.safetyVerdict.risk}): ${pending.safetyVerdict.reason}`
        );
      }
      setRawMode(false); // ensure typed input is echoed for this confirm
      const answer = (
        await rl.question(formatInputPrompt('Approve? [o]nce / [s]ession / [a]lways / [N]o: '))
      )
        .trim()
        .toLowerCase();
      if (answer === 'o' || answer === 'once') {
        return { type: 'approve', scope: 'once' };
      }
      if (answer === 's' || answer === 'session') {
        displayInfo('Approved for this session — future variants will not re-prompt.');
        return { type: 'approve', scope: 'session' };
      }
      if (answer === 'a' || answer === 'always') {
        displayInfo('Approved and remembered — saved to the project allow-list.');
        return { type: 'approve', scope: 'always' };
      }
      displayInfo('Command rejected.');
      return { type: 'reject', message: 'User rejected the shell command.' };
    });

    if (logFileName) {
      displayInfo(`${sessionConfig.mode} session will be logged to ${logFileName}\n`);
    }

    const processMessage = async (userInput: string) => {
      const logEntry = `## User\n\n${userInput}\n\n## Assistant\n\n`;
      if (logFileName) {
        appendToFile(logFileName, logEntry);
      }
      flushSessionLog(); // Ensure user input is immediately written to file
      // The system prompt (backstory + guidelines + mode prompt + identity) now lives in the
      // deep-agent graph via createDeepAgent({ systemPrompt }) — see GthDeepAgent — so it is no
      // longer injected here as a per-turn SystemMessage (which yielded a second, non-first system
      // message that Anthropic rejects).
      const messages: BaseMessage[] = [new HumanMessage(userInput)];

      await runner.processMessages(messages);
    };

    const askQuestion = async () => {
      while (!shouldExit) {
        setRawMode(true); // resume raw mode for user input (without it every user input is parroted)
        const userInput = await rl.question(formatInputPrompt('  > '));
        if (!userInput.trim()) {
          continue; // Skip inference if no input
        }
        const lowerInput = userInput.toLowerCase().trim();
        if (lowerInput === 'exit' || lowerInput === '/exit') {
          display('Exiting...');
          shouldExit = true;
          await runner.cleanup();
          stopSessionLogging();
          rl.close();
          break;
        }
        // EXT-12 — `/yolo` toggles session-wide shell auto-approval at the approval-decision
        // layer (the runner flag), distinct from the static `shellYolo` config. Session-scoped,
        // reversible, never persisted; the hardline floor still blocks catastrophic commands.
        if (lowerInput === '/yolo') {
          const enabled = runner.toggleSessionYolo();
          if (enabled) {
            displayWarning(
              'yolo ON — shell commands auto-approved this session (no per-command prompt). ' +
                'The hardline safety floor still blocks catastrophic commands. Run /yolo again to require approvals.'
            );
          } else {
            displayInfo('yolo OFF — approvals required before each shell command.');
          }
          continue; // do not send the command to the model
        }

        let shouldRetry = false;

        do {
          try {
            await processMessage(userInput);
            shouldRetry = false;
          } catch (err) {
            display(
              `\n❌ Error processing message: ${err instanceof Error ? err.message : String(err)}\n`
            );
            const retryResponse = await rl.question(
              'Do you want to try again with the same prompt? (y/n): '
            );
            shouldRetry = retryResponse.toLowerCase().trim().startsWith('y');

            if (!shouldRetry) {
              display('\nSkipping to next prompt...');
            }
          }
        } while (shouldRetry && !shouldExit);

        if (!shouldExit) {
          display('\n\n');
          displayInfo(sessionConfig.exitMessage);
        }
      }
      rl.close();
    };

    if (message) {
      await processMessage(message);
    } else {
      display(sessionConfig.readyMessage);
      displayInfo(sessionConfig.exitMessage);
    }
    if (!shouldExit) await askQuestion();
    if (shouldExit) {
      setTimeout(() => {
        exit();
      }, 500);
    }
  } catch (err) {
    await runner.cleanup();
    stopSessionLogging();
    error(`Error in ${sessionConfig.mode} command: ${err}`);
    exit(1);
  }
}
