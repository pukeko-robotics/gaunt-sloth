import { CommandLineConfigOverrides, GthConfig, initConfig } from '@gaunt-sloth/core/config.js';
import {
  defaultStatusCallback,
  display,
  displayInfo,
  displayLaunchBanner,
  displayWarning,
  flushSessionLog,
  formatInputPrompt,
  initSessionLogging,
  stopSessionLogging,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { launchBannerFields, launchBannerText } from '@gaunt-sloth/core/core/launchBanner.js';
import { buildRejectionMessage } from '@gaunt-sloth/core/core/shell/rejection.js';
import { renderNegotiationTranscript } from '@gaunt-sloth/core/core/shell/negotiation.js';
import {
  DEFAULT_FRAME_WIDTH,
  frameUntrustedCommand,
  frameUntrustedText,
} from '@gaunt-sloth/core/core/shell/framing.js';
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
  getUseColour,
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
  approvalsRungNotice,
  approvalsStatusNotice,
  approvalsTrustNotice,
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
      // [[TUI-C26]] §6 — the command is model-authored text going to a terminal, where it is not
      // inert: a carriage return reaches column 0, an escape sequence clears the screen, and a
      // newline alone lays down a line that looks exactly like this prompt's own chrome. It is
      // painted through core's framing renderer — neutralised, inside a line-number gutter, with
      // its command-substitution and composition sites listed above it — the SAME renderer the Ink
      // prompt uses, so the two surfaces cannot differ about how much of a command a human saw.
      // Nothing is clamped to one line: the command that motivated this hid its payload fifteen
      // lines into a commit message, and a clamp discards exactly what the human must rule on.
      const frameWidth = Math.max(20, (output.columns ?? DEFAULT_FRAME_WIDTH) - 1);
      const framedCommand = frameUntrustedCommand(commandText, { width: frameWidth });
      displayWarning(`\nThe agent wants to run a shell command via ${pending.name}:`);
      for (const notice of framedCommand.notices) displayWarning(notice);
      display('');
      for (const line of framedCommand.lines) display(line);
      display('');
      // CFG-27: when the auto-rater escalated this command (rather than approving it), show its
      // outcome + reason before the human decides. §6 makes that explanation mandatory whenever a
      // rating exists; at the unrated rungs there is none and the prompt shows the command alone.
      // The outcome is a schema enum; the reason is model-authored prose and is framed exactly like
      // the command, because a dialog forgeable through the string that explains it is not a gate.
      if (pending.safetyVerdict) {
        displayWarning(`⚠ Auto-rater (${pending.safetyVerdict.outcome}):`);
        for (const line of frameUntrustedText(pending.safetyVerdict.reason, { width: frameWidth })
          .lines) {
          displayWarning(line);
        }
      }
      // EXT-71 §3.2 — when a declared `approvals.escalate` entry is what brought this call here,
      // the prompt shows THE ENTRY THAT FIRED. Without it the user is asked about a command their
      // rung would have approved, with nothing on screen tying the question to the line they wrote
      // — which reads as the gate malfunctioning rather than as their own rule working.
      if (pending.escalatedBy) {
        displayWarning(`⚠ Your approvals.escalate list matched this call: ${pending.escalatedBy}`);
      }
      // [[EXT-29]] §6 — when a §5 negotiation preceded this escalation, the human is shown ALL of
      // it. The user is not asked to rule on the final command in isolation: that the agent
      // proposed the same command three times unchanged, against two rejections that each told it
      // what to fix, is the most important thing on the screen and is invisible if only the last
      // attempt is shown. Rendered through core's shared renderer, so the surfaces cannot describe
      // one exchange two ways.
      const negotiation = renderNegotiationTranscript(pending.negotiationRounds ?? []);
      if (negotiation) {
        displayWarning(negotiation);
      }
      // EXT-71/EXT-70 §6 — the menu MUST show what a sticky choice will store, at the moment of
      // the choice, and it names it in the words the control is written in: the command itself for
      // a shell call, the tool (with its server and host bound) for a tool call, since for a tool
      // "the stored thing is the tool, not the arguments" (§4.7.4). The exact entry follows it, so
      // the user sees the thing they are agreeing to rather than a generalization of it.
      const sticky = pending.grantPreview !== undefined;
      if (sticky) {
        // [[TUI-C26]] — these two lines carry the command as typed (§3.1 stores it exactly, never a
        // widened pattern), so they inherit the command's problem in less space: an in-line
        // `approved by rater` fits on one line untouched. Framed like everything else, with the
        // label kept as this surface's OWN line so the untrusted half can never be read as chrome.
        displayInfo('[s]/[a] will remember:');
        for (const line of frameUntrustedText(pending.grantSummary ?? pending.grantPreview!, {
          width: frameWidth,
        }).lines) {
          displayInfo(line);
        }
        displayInfo('    stored as:');
        for (const line of frameUntrustedText(pending.grantPreview!, { width: frameWidth }).lines) {
          displayInfo(line);
        }
      }
      setRawMode(false); // ensure typed input is echoed for this confirm
      // EXT-18: wrap the prompt in try/finally so the raw-mode/ref state is not left wedged if
      // rl.question throws. The subsequent streamResume run re-establishes raw mode + ref, but be
      // defensive. askLine() refs stdin first so the prompt actually waits for input (the run just
      // suspended on the tool interrupt, whose stream-end unref'd stdin).
      let answer: string;
      try {
        // §6 — a sticky control is SHOWN only where a sticky grant is actually on offer. Where
        // nothing would be remembered — a `catastrophic` outcome (§4.2), a command that does not
        // statically resolve, a tool call nothing can attribute — the menu simply does not offer
        // the choice, because "a control that is offered and then refused reads as a bug rather
        // than as a policy". Hiding it, never disabling it: a disabled control invites the user to
        // hunt for why.
        answer = (
          await askLine(
            formatInputPrompt(
              sticky
                ? 'Approve? [o]nce / [s]ession / [a]lways / [N]o: '
                : 'Approve? [o]nce / [N]o: '
            )
          )
        )
          .trim()
          .toLowerCase();
      } finally {
        refStdin();
      }
      if (answer === 'o' || answer === 'once') {
        return { type: 'approve', scope: 'once' };
      }
      // CFG-28 (§4.2) — a `catastrophic` approval is NEVER sticky. The runner clamps the
      // allow-list write, so `[s]` and `[a]` grant exactly this one invocation and the next
      // variant prompts again. The decision is still returned unchanged: that clamp is the single
      // chokepoint, in core, so the policy does not depend on which surface asked. What must change
      // HERE is only the confirmation — §6 rejects "a control that is offered and then refused",
      // and a confirmation that promises a persistence the gate has already discarded is that same
      // failure with the evidence hidden. Withdrawing the key itself is [[TUI-C26]]'s.
      // The confirmation must name what actually happened, and the condition for that is the SAME
      // one that decides whether the control was shown: no grant on offer means no grant written,
      // whatever key was typed. `catastrophic` keeps its own wording because the reason matters to
      // the reader, but it is one case of the general one rather than the only one — the other
      // cases (a command that does not statically resolve, an unattributable tool call) used to be
      // confirmed as remembered while the runner stored nothing.
      const notRemembered =
        pending.safetyVerdict?.outcome === 'catastrophic'
          ? 'Approved this once — a command rated catastrophic is never remembered, so the next ' +
            'one like it will ask again.'
          : 'Approved this once — there is nothing about this call that can be remembered, so the ' +
            'next one like it will ask again.';
      if (answer === 's' || answer === 'session') {
        displayInfo(
          sticky ? 'Approved — this exact command will not ask again this session.' : notRemembered
        );
        return { type: 'approve', scope: 'session' };
      }
      if (answer === 'a' || answer === 'always') {
        displayInfo(
          sticky
            ? 'Approved and remembered — this exact command is saved to the project allow-list.'
            : notRemembered
        );
        return { type: 'approve', scope: 'always' };
      }
      displayInfo('Command rejected.');
      // EXT-58 (§7): the model is told the moves it has — re-call with a justification, call a
      // different command, or ask the user — and, when the rater named an already-granted
      // alternative (§4.4), that tool plus the clause saying it needs no approval. A bare "user
      // rejected" leaves the model to guess, which it does by repeating itself or giving up.
      return {
        type: 'reject',
        message: buildRejectionMessage({
          source: 'user',
          toolName: pending.name,
          verdict: pending.safetyVerdict,
        }),
      };
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
            // CFG-25 — pass the session command so the panel prints the EFFECTIVE per-command
            // filesystem value (e.g. `all` for `code`), not the top-level default.
            configSummary: formatConfigSummary(config, sessionConfig.mode),
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
          if (result.approvals) {
            // CFG-27 — `/approvals <rung>` sets the session rung at the approval-decision layer
            // (the runner posture). Session-scoped, reversible, never persisted. With no argument
            // the command DISPLAYS the posture instead of changing it.
            if ('show' in result.approvals) {
              printNotice(
                approvalsStatusNotice(
                  runner.getSessionApprovals(),
                  runner.getAllowlistCounts(),
                  runner.getDenylist(),
                  runner.getGrants(),
                  runner.getMcpAnnotationTrust()
                )
              );
            } else if ('trust' in result.approvals) {
              // EXT-70 §4.7.1 — believe (or stop believing) specific hints from one server, for
              // this session. The notice is built from what the runner RETURNS, so it can only
              // describe the trust actually in force — including §4.7.4's consequence when the
              // withdrawal is a weakening.
              const { server, hints, believe } = result.approvals.trust;
              printNotice(
                approvalsTrustNotice(runner.setMcpAnnotationTrust(server, hints, believe))
              );
            } else {
              runner.setSessionApprovalRung(result.approvals.rung);
              // Report the posture the runner actually LANDED on, not the one requested.
              printNotice(approvalsRungNotice(runner.getSessionApprovals()));
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
      // TUI-C33 — the ASCII-art launch banner, ABOVE the untouched ready message. Only on this
      // branch: an `-m` run goes straight to work, which is the readline twin of the TUI hiding
      // its intro when it mounts with an initialMessage.
      //
      // Gated on `stdout.isTTY` (as the TUI's viewport bump is) so piped, redirected and non-TTY
      // runs stay clean, and on `getUseColour()` for the escapes, so a monochrome session degrades
      // the banner to plain text instead of dropping it. `stdout.columns` is what every field is
      // truncated against — see launchBanner.ts on why a wrapped line would shatter the art.
      if (output.isTTY) {
        displayLaunchBanner(
          launchBannerText({
            ...launchBannerFields(config.modelDisplayName, config.modelProviderType),
            columns: output.columns,
            colour: getUseColour(),
          })
        );
      }
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
