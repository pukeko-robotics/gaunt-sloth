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
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { writeDebugDump } from '@gaunt-sloth/core/utils/debugDump.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import {
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import {
  createInterface,
  error,
  exit,
  getProjectDir,
  refStdin,
  setRawMode,
  stdin as input,
  stdout as output,
} from '@gaunt-sloth/core/utils/systemUtils.js';
import type { GthRunStats } from '@gaunt-sloth/core/core/types.js';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createResolvers } from '#src/resolvers.js';
import { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';
import {
  createCommandRegistry,
  dispatchSlashCommand,
  formatConfigSummary,
  parseSlashCommand,
  type DebugDumpInput,
  type SlashCommandNotice,
} from '#src/modules/slashCommands.js';

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

  // GS2-19: open ONE conversation for this interactive session up-front; every turn below is stamped
  // with its id so a multi-turn chat groups under one conversation (not N unrelated rows). Opt-in /
  // fail-soft: a no-op returning undefined unless `history.enabled`, in which case turns fall back to
  // per-turn 1-turn conversations. Never affects a default run.
  const conversationId =
    openConversationSafe(config, {
      command: sessionConfig.mode,
      project: getProjectDir(),
      model: config.modelDisplayName,
    }) ?? undefined;

  // Initialize Runner

  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }
  // B5: interactive code/chat default to the LEAN backend; an explicit config.agent.backend
  // overrides it (deep is now opt-in / experimental). createResolvers() is unchanged, so a lean
  // session keeps the full toolset (filesystem + hardened dev/shell).
  const runner = new GthAgentRunner(
    defaultStatusCallback,
    createResolvers(),
    resolveAgentFactory(config, 'lean')
  );

  try {
    await runner.init(sessionConfig.mode, config, checkpointSaver);
    const rl = createInterface({ input, output });
    let shouldExit = false;
    // GS2-8 — the readline surface shares the SAME command registry as the Ink TUI (one source
    // of truth): every registered command parses, appears in /help, and dispatches here too.
    const registry = createCommandRegistry();
    // Committed-turn counter for the /status command (mirrors the TUI's status-bar counter).
    let turnCount = 0;

    // GS2-56 — wire `/debug-dump` on the readline (`--no-tui`) surface too. Previously this surface
    // injected no writer, so `/debug-dump` reported itself "unavailable" here; it now forwards to the
    // same core writer the TUI uses AND threads the agent's always-on last-model-request snapshot
    // (read at CALL time from the live agent), so the archive carries the full model input even
    // though this surface keeps no on-screen transcript. Fail-soft: no agent handle ⇒ the snapshot is
    // simply omitted (the other artifacts still write). `redact` is resolved by the shared command.
    const dumpDebugSession = (dumpInput: DebugDumpInput): { archiveDir: string } => {
      const agent = runner.getAgent();
      return writeDebugDump({
        transcript: dumpInput.transcript,
        config: dumpInput.config,
        modelDisplayName: dumpInput.modelDisplayName,
        redact: dumpInput.redact,
        modelRequest: agent instanceof GthAbstractAgent ? agent.lastModelRequest : undefined,
      });
    };

    // EXT-18: ref stdin before every rl.question() that can run AFTER an agent turn/stream end.
    // When a run suspends (tool-approval interrupt) or throws, the stream's finally calls
    // stopWaitingForEscape(), which unref's stdin so one-shot commands can exit. A prompt that
    // follows must re-ref stdin first, otherwise nothing keeps the event loop alive and the
    // process exits to the shell before the user can answer. The main `> ` loop is safe because
    // its setRawMode(true) already re-refs; these cooked-mode prompts do not, so they ref here.
    const askLine = (prompt: string): Promise<string> => {
      refStdin();
      return rl.question(prompt);
    };

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
      // EXT-18: wrap the prompt in try/finally so the raw-mode/ref state is not left wedged if
      // rl.question throws. The subsequent streamResume run re-establishes raw mode + ref, but be
      // defensive. askLine() refs stdin first so the prompt actually waits for input (the run just
      // suspended on the tool interrupt, whose stream-end unref'd stdin).
      let answer: string;
      try {
        answer = (
          await askLine(formatInputPrompt('Approve? [o]nce / [s]ession / [a]lways / [N]o: '))
        )
          .trim()
          .toLowerCase();
      } finally {
        refStdin();
      }
      if (answer === 'o' || answer === 'once') {
        return { type: 'approve', scope: 'once' };
      }
      if (answer === 's' || answer === 'session') {
        displayInfo('Approved for this session, future variants will not re-prompt.');
        return { type: 'approve', scope: 'session' };
      }
      if (answer === 'a' || answer === 'always') {
        displayInfo('Approved and remembered, saved to the project allow-list.');
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

      // GS2-18: wire the readline (`--no-tui`) interactive path into the opt-in history recorder
      // at its turn boundary, matching the single-shot and Ink-TUI paths. Fail-soft and
      // default-OFF (recordSessionSafe is a no-op unless `history.enabled`), so a default run is
      // unchanged. GS2-16 threads live token/tool/duration analytics; costUsd stays unset.
      const startedAt = Date.now();
      const responseText = await runner.processMessages(messages);
      let runStats: GthRunStats = { tools: [] };
      try {
        const s = runner.getRunStats?.();
        if (s) runStats = s;
      } catch {
        /* fail-soft: analytics must never affect the session */
      }
      recordSessionSafe(config, {
        conversationId, // GS2-19: group every turn under this session's conversation
        command: sessionConfig.mode,
        project: getProjectDir(),
        model: config.modelDisplayName,
        prompt: userInput,
        response: responseText,
        tokensInput: runStats.tokensInput,
        tokensOutput: runStats.tokensOutput,
        tools: runStats.tools.length > 0 ? runStats.tools : undefined,
        durationMs: Date.now() - startedAt,
      });
      turnCount += 1; // GS2-8 — feeds the /status turn counter
    };

    // GS2-8 — render a structured command notice on the plain-text surface: tone-matched title
    // (warn ⇒ yellow), then the body lines indented under it.
    const printNotice = (notice: SlashCommandNotice) => {
      if (notice.tone === 'warn') {
        displayWarning(notice.title);
      } else {
        displayInfo(notice.title);
      }
      for (const line of notice.lines) {
        display(`  ${line}`);
      }
    };

    const endSession = async () => {
      display('Exiting...');
      shouldExit = true;
      await runner.cleanup();
      stopSessionLogging();
      rl.close();
    };

    const askQuestion = async () => {
      while (!shouldExit) {
        setRawMode(true); // resume raw mode for user input (without it every user input is parroted)
        const userInput = await rl.question(formatInputPrompt('  > '));
        if (!userInput.trim()) {
          continue; // Skip inference if no input
        }
        // Legacy bare `exit` keyword still quits (parity with the TUI's plain-exit handling).
        if (userInput.toLowerCase().trim() === 'exit') {
          await endSession();
          break;
        }

        // GS2-8 — every `/command` dispatches through the SAME registry as the Ink TUI (single
        // source of truth). parseSlashCommand's `/`-vs-path heuristic means a pasted filesystem
        // path (`/usr/home/bob/test.md`) is NOT a command and falls through to the model below.
        const parsed = parseSlashCommand(userInput);
        if (parsed) {
          const result = dispatchSlashCommand(parsed, registry, {
            mode: sessionConfig.mode,
            modelDisplayName: config.modelDisplayName ?? '',
            turnCount,
            // No tool-detail panels or debug pane exist on this surface; their commands degrade
            // below rather than vanishing from the catalog.
            toolsExpanded: false,
            debugVisible: false,
            configSummary: formatConfigSummary(config),
            // GS2-56 — `/debug-dump` is now available here. This surface keeps no on-screen
            // transcript array, so `transcript` is empty; the real as-sent history lands in the
            // archive's model-messages.json from the always-on snapshot (that is the point).
            transcript: [],
            resolvedConfig: config,
            dumpDebugSession,
          });
          if (result.exit) {
            await endSession();
            break;
          }
          if (result.autoApprove) {
            // EXT-12 — `/auto-approve` (with the `/yolo` alias) sets session-wide shell
            // auto-approval at the approval-decision layer (the runner flag). Session-scoped,
            // reversible, never persisted; the hardline floor still blocks catastrophic commands.
            // The runner seeds this from the static `shellYolo` config, so `/auto-approve off`
            // also turns off a config-enabled auto-approval.
            const enabled =
              result.autoApprove === 'toggle'
                ? runner.toggleSessionYolo()
                : runner.setSessionYolo(result.autoApprove === 'on');
            if (enabled) {
              displayWarning(
                'Auto-approve ON — shell commands run this session without the per-command prompt. ' +
                  'The hardline safety floor still blocks catastrophic commands. Run /auto-approve off to require approvals.'
              );
            } else {
              displayInfo('Auto-approve OFF — approvals required before each shell command.');
            }
          } else if (
            result.clearTranscript ||
            result.toggleDebug ||
            result.toggleTools ||
            result.reprintReasoning
          ) {
            // TUI-only effects (transcript clear, debug pane, tool-detail fold, reasoning
            // reprint) have no equivalent on the plain readline surface — degrade with a clear
            // pointer instead of silently doing nothing (GS2-8).
            displayInfo(
              `/${parsed.name} is not available without the TUI — start the session on an ` +
                `interactive terminal without --no-tui/GTH_NO_TUI to use it.`
            );
          } else if (result.notice) {
            printNotice(result.notice);
          }
          if (result.message) {
            // Incidental system line (e.g. the /tools→/verbose deprecation pointer).
            if (result.level === 'warning') {
              displayWarning(result.message);
            } else {
              displayInfo(result.message);
            }
          }
          continue; // never send a slash command to the model
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
            // EXT-18: askLine() refs stdin first. This prompt runs in the catch after
            // processMessage threw, by which point the stream's finally has already unref'd
            // stdin (same exit as the approval prompt) - re-ref so it waits for input.
            const retryResponse = await askLine(
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
