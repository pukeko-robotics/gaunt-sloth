import { CommandLineConfigOverrides, GthConfig, initConfig } from '@gaunt-sloth/core/config.js';
import {
  defaultStatusCallback,
  display,
  displayDialogLine,
  displayInfo,
  displayLaunchBanner,
  displayWarning,
  flushSessionLog,
  formatInputPrompt,
  initSessionLogging,
  stopSessionLogging,
  type DialogTone,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { GthAgentRunner } from '@gaunt-sloth/core/core/GthAgentRunner.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { launchBannerFields, launchBannerText } from '@gaunt-sloth/core/core/launchBanner.js';
import { buildRejectionMessage } from '@gaunt-sloth/core/core/shell/rejection.js';
import { renderNegotiationRows } from '@gaunt-sloth/core/core/shell/negotiation.js';
import {
  attackBannerCopy,
  describeRaterOutcome,
  grantsRunAnyway,
  RATER_REASON_LABEL,
} from '@gaunt-sloth/core/core/shell/escalationSeverity.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
  STICKY_PREVIEW_MAX_ROWS,
} from '@gaunt-sloth/core/core/shell/framing.js';
import { approvalPromptHeader } from '@gaunt-sloth/core/core/approvals/promptHeader.js';
import { ApprovalStopError, approvalStopRows } from '@gaunt-sloth/core/core/shell/approvalStop.js';
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

/**
 * [[TUI-C26]] §6 / [[EXT-105]] — **every line of an escalation dialog goes through
 * {@link displayDialogLine}, and no line of one goes anywhere else.**
 *
 * That writer puts the line on **stderr** whatever its severity, and takes the severity as a
 * separate argument. Both halves matter here. The ordinary `display*` helpers bind colour to
 * stream — `displayWarning` is yellow AND stderr, `displayError` is red AND stdout — so a dialog
 * that used them to colour its lines was written across both streams, and only writes to the SAME
 * stream are delivered in the order they were made. On a terminal the two arrive in call order and
 * the dialog reads top to bottom; piped or redirected they need not, and a reader can be shown a
 * rater's answer above the command it answers. A gate whose line order holds only on a terminal is
 * not a gate.
 *
 * So the rule for this file is mechanical: **inside the approval dialog and the attack banner, use
 * `displayDialogLine` and pass the tone.** A `display`/`displayInfo`/`displayWarning`/`displayError`
 * call added among them is the defect coming back, and the stream test covering these two callbacks
 * is what catches it. Everything OUTSIDE them — notices, banners, the session's own chatter — keeps
 * the ordinary helpers.
 *
 * The tone is the observable an assertion can bite on, too: a change that made `catastrophic` look
 * like `destructive` would have to pass both the same tone, which a test can see.
 *
 * This helper is the multi-line form — a framed block, a list of notices, the banner's controls —
 * since every such block is one tone throughout. A single line calls the writer directly.
 */
const dialogLines = (lines: readonly string[], tone: DialogTone = 'plain'): void => {
  for (const line of lines) displayDialogLine(line, tone);
};

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
        // [[TUI-C27]] — the approvals gate's record of every gated decision, read from the live
        // runner at CALL time for the same reason the model request is.
        approvals: runner.getApprovalCaptures(),
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

    // Tool-approval (human-in-the-loop) prompt for gated tools — the shell tool, and at `manual`
    // and `write` the built-in write tools, MCP tools and custom tools (EXT-80). When a run
    // suspends on such a tool call, the runner calls this with the pending call. The opening
    // sentence therefore has to say which kind it is, which is [[TUI-C67]] and core's to render.
    // EXT-9 Tier-2: instead of a bare y/N, offer a scoped choice so the
    // human can stop re-prompting for an operation they trust:
    //   [o]nce        — approve this single invocation only (persists nothing),
    //   [s]ession     — auto-approve this exact command for the rest of the session,
    //   [a]lways      — additionally persist it to the project allow-list,
    //   [d]eny always — refuse it AND record a deny entry for the rest of the session,
    //   anything else → reject this one call (fail-closed, and it stays the fallthrough).
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
      const frameWidth = frameWidthFor(output.columns);
      const framedCommand = frameUntrustedCommand(commandText, { width: frameWidth });
      // [[TUI-C67]] — the opening sentence is core's, branched on the `ApprovalSubject` kind the
      // gate itself decided on, so a file write, an MCP call or a custom tool is announced as what
      // it is rather than as a shell command. The Ink prompt renders the identical call; this
      // surface owns only the leading blank line and the trailing colon, which is what keeps the
      // two from describing one call two ways.
      displayDialogLine(`\n${approvalPromptHeader(pending)}:`, 'warn');
      // Below core's floor the frame is wider than the terminal, which wraps it and puts untrusted
      // text at the left edge. The frame is still shown — hiding what the human must rule on would
      // be worse — but the guarantee has lapsed, and it says so instead of lapsing silently.
      const tooNarrow = narrowTerminalNotice(output.columns);
      if (tooNarrow) displayDialogLine(tooNarrow, 'warn');
      dialogLines(framedCommand.notices, 'warn');
      displayDialogLine('');
      dialogLines(framedCommand.lines);
      displayDialogLine('');
      // CFG-27: when the auto-rater escalated this command (rather than approving it), show its
      // outcome + reason before the human decides. §6 makes that explanation mandatory whenever a
      // rating exists; at the unrated rungs there is none and the prompt shows the command alone.
      // The outcome is a schema enum; the reason is model-authored prose and is framed exactly like
      // the command, because a dialog forgeable through the string that explains it is not a gate.
      // [[TUI-C26]] §6 — the severity is legible in three independent ways: a glyph, a sentence of
      // the gate's own naming what the outcome MEANS, and the tone it is painted in. The tone is
      // this surface's colour: `catastrophic` is painted `danger` (red) where `destructive` is
      // `warn` (yellow), so the two cannot look alike — and the sentence carries it anyway for a
      // terminal with no colour at all, which is the one that must not be left out.
      if (pending.safetyVerdict) {
        const severity = describeRaterOutcome(pending.safetyVerdict.outcome);
        displayDialogLine(severity.heading, severity.tone);
        // The reason is the RATER's, and now that the line above it is the gate's own sentence the
        // attribution has to be said rather than implied.
        displayDialogLine(RATER_REASON_LABEL, 'notice');
        dialogLines(
          frameUntrustedText(pending.safetyVerdict.reason, { width: frameWidth }).lines,
          severity.tone
        );
      }
      // EXT-71 §3.2 — when a declared `approvals.escalate` entry is what brought this call here,
      // the prompt shows THE ENTRY THAT FIRED. Without it the user is asked about a command their
      // rung would have approved, with nothing on screen tying the question to the line they wrote
      // — which reads as the gate malfunctioning rather than as their own rule working.
      // [[TUI-C26]] — framed rather than interpolated. The entry is usually something the user
      // wrote, but an MCP entry can carry server-supplied names, and this line sits one string away
      // from the prompt's own chrome. The label stays this surface's own line.
      if (pending.escalatedBy) {
        displayDialogLine('⚠ Your approvals.escalate list matched this call:', 'warn');
        dialogLines(frameUntrustedText(pending.escalatedBy, { width: frameWidth }).lines, 'warn');
      }
      // [[EXT-29]] §6 — when a §5 negotiation preceded this escalation, the human is shown ALL of
      // it. The user is not asked to rule on the final command in isolation: that the agent
      // proposed the same command three times unchanged, against two rejections that each told it
      // what to fix, is the most important thing on the screen and is invisible if only the last
      // attempt is shown. Rendered through core's shared renderer, so the surfaces cannot describe
      // one exchange two ways.
      //
      // [[TUI-C26]] §5.4 — rendered as ROWS, so the two voices are told apart: the rater's turns are
      // painted `warn` (yellow) and the agent's plain, which is what the spec asks for and what one
      // joined string could not express — the whole exchange used to arrive in a single colour. Each
      // row also NAMES its speaker (`rater answered:` / `agent justified:`), which is the half that
      // survives a monochrome terminal. The rows are bound to the terminal width for the same reason
      // the command is: a long justification left to the terminal's own wrap continues at column 0.
      //
      // [[TUI-C75]] — the count comes from `negotiationAttempts`, not from the array: §5.3 clears
      // the transcript on an approved call, so the rounds that survive to here are the attempts
      // since the last approval and not the attempts the human is being asked to weigh.
      for (const row of renderNegotiationRows(pending.negotiationRounds ?? [], {
        width: frameWidth,
        ...(pending.negotiationAttempts !== undefined
          ? { attempts: pending.negotiationAttempts }
          : {}),
      })) {
        if (row.voice === 'rater') displayDialogLine(row.text, 'warn');
        else if (row.voice === 'agent') displayDialogLine(row.text);
        else displayDialogLine(row.text, 'notice');
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
        // Bounded to a few rows: for a shell call these carry the command as typed, which is
        // already printed in full above — so an unbounded copy of a long command here (twice over,
        // since the entry repeats it) scrolls the MENU off the screen, and a control the human
        // cannot see is not one they were offered.
        displayDialogLine('[s]/[a] will remember:', 'notice');
        dialogLines(
          frameUntrustedText(pending.grantSummary ?? pending.grantPreview!, {
            width: frameWidth,
            maxRows: STICKY_PREVIEW_MAX_ROWS,
          }).lines,
          'notice'
        );
        displayDialogLine('    stored as:', 'notice');
        dialogLines(
          frameUntrustedText(pending.grantPreview!, {
            width: frameWidth,
            maxRows: STICKY_PREVIEW_MAX_ROWS,
          }).lines,
          'notice'
        );
      }
      // [[TUI-C26]] §6 — the same requirement for the OTHER sticky choice, and its availability is
      // a different question: the runner offers a deny entry in cases where no grant exists at all
      // (a command that does not statically resolve, every `catastrophic` verdict), because a
      // refusal that cannot be decided still refuses. `recorded as:` rather than a second
      // `stored as:` — one dialog, two labels that read alike, is how a reader loses track of which
      // block they are looking at. The label states the lifetime because there is no persisted deny
      // store and the control must not imply one.
      const stickyDeny = pending.denyPreview !== undefined;
      if (stickyDeny) {
        displayDialogLine('[d] will refuse, for the rest of this session:', 'notice');
        dialogLines(
          frameUntrustedText(pending.denySummary ?? pending.denyPreview!, {
            width: frameWidth,
            maxRows: STICKY_PREVIEW_MAX_ROWS,
          }).lines,
          'notice'
        );
        displayDialogLine('    recorded as:', 'notice');
        dialogLines(
          frameUntrustedText(pending.denyPreview!, {
            width: frameWidth,
            maxRows: STICKY_PREVIEW_MAX_ROWS,
          }).lines,
          'notice'
        );
      }
      setRawMode(false); // ensure typed input is echoed for this confirm
      // EXT-18: wrap the prompt in try/finally so the raw-mode/ref state is not left wedged if
      // rl.question throws. The subsequent streamResume run re-establishes raw mode + ref, but be
      // defensive. askLine() refs stdin first so the prompt actually waits for input (the run just
      // suspended on the tool interrupt, whose stream-end unref'd stdin).
      let answer: string;
      try {
        // §6 — a sticky control is SHOWN only where the gate would actually store something. Where
        // nothing would be remembered — a `catastrophic` outcome (§4.2), a command that does not
        // statically resolve, a tool call nothing can attribute — the menu simply does not offer
        // the choice, because "a control that is offered and then refused reads as a bug rather
        // than as a policy". Hiding it, never disabling it: a disabled control invites the user to
        // hunt for why. The two sticky controls are judged SEPARATELY: the deny entry exists in
        // cases where no grant does, which is the whole reason it is a second condition.
        //
        // Assembled from parts rather than by enumerating the four combinations, so a menu spelling
        // nobody wrote down cannot reach a terminal.
        const controls = [
          '[o]nce',
          ...(sticky ? ['[s]ession', '[a]lways'] : []),
          '[N]o',
          ...(stickyDeny ? ['[d]eny always'] : []),
        ];
        // [[EXT-105]] — the menu is a LINE OF THE DIALOG, so it is written like the rest of it and
        // readline is handed an empty prompt. Left to `rl.question(menu)` it would go to readline's
        // own output — stdout — which is the one line of the dialog it would be worst to lose from a
        // capture and worst to have arrive out of order: the question, below the answer. The cost is
        // one row: readline redraws the line it is editing, so a menu written beside it would be
        // erased on a terminal, and the answer is therefore typed on the row below the menu.
        displayDialogLine(`Approve? ${controls.join(' / ')}:`, 'prompt');
        answer = (await askLine('')).trim().toLowerCase();
      } finally {
        refStdin();
      }
      if (answer === 'o' || answer === 'once') {
        return { type: 'approve', scope: 'once' };
      }
      // CFG-28 (§4.2) / [[TUI-C26]] §1.1 — **a sticky approve is answerable only where the control
      // was OFFERED**, on the same condition that decides whether it was shown. `catastrophic` is
      // one case of it: the runner clamps the allow-list write for that outcome, so a grant is
      // never stored and no grant is on offer — and the others are a command that does not
      // statically resolve and a call nothing can attribute. Typed on a menu that does not carry
      // them, `s` and `a` are unbound answers like any other and fall through to the one-shot
      // refusal below.
      //
      // **The gate has to be on the key, not only on the confirmation.** Bound anywhere else, `a`
      // at a `catastrophic` prompt approves and RUNS the command — nothing between this callback
      // and execution re-reads the verdict — off a menu that has already withdrawn the choice,
      // which is §6's "a control that is offered and then refused" with the withdrawal made
      // cosmetic. The scope is still returned exactly as typed: the clamp on what gets STORED is
      // core's, the single chokepoint for every surface, and this must not start deciding
      // persistence for itself.
      if (sticky && (answer === 's' || answer === 'session')) {
        displayDialogLine(
          'Approved — this exact command will not ask again this session.',
          'notice'
        );
        return { type: 'approve', scope: 'session' };
      }
      if (sticky && (answer === 'a' || answer === 'always')) {
        displayDialogLine(
          'Approved and remembered — this exact command is saved to the project allow-list.',
          'notice'
        );
        return { type: 'approve', scope: 'always' };
      }
      // [[TUI-C26]] §6 — *always reject*: a refusal that is also recorded, so the next identical
      // call is refused by rule without reaching a person. Answered only where the control was
      // OFFERED; typed anywhere else it is an unbound answer like any other and falls through to
      // the one-shot refusal below, which is what keeps the safe action the fallthrough.
      //
      // **One spelling for the control this work adds** — `d`, the one the menu prints. A second
      // that the menu never advertises is how this surface starts drifting from the Ink one, which
      // has no aliases at all.
      //
      // That rule governs what is ADDED here, and the long forms `once`, `session` and `always`
      // accepted above are not exceptions to it: they predate this work and they stay. Each is
      // gated by exactly the condition that gates its own letter — `session`/`always` inside the
      // same `sticky` test as `s`/`a`, `once` on a control that is always offered — so none of them
      // widens what is answerable at any prompt. Read this as the reason not to add a fourth alias,
      // never as licence to delete the three that are here.
      const stickyRejected = stickyDeny && answer === 'd';
      // The confirmation says what actually happened and stops there. There is no persisted deny
      // store, so a line implying one would be the same failure §6 names when it calls a control
      // offered and then refused a bug — with the evidence hidden, which is worse.
      displayDialogLine(
        stickyRejected
          ? 'Refused — this call will not run for the rest of this session, and will not ask ' +
              'again. Nothing was saved to the project, so a new session will ask about it again.'
          : 'Command rejected.',
        'notice'
      );
      // EXT-58 (§7): the model is told the moves it has — re-call with a justification, call a
      // different command, or ask the user — and, when the rater named an already-granted
      // alternative (§4.4), that tool plus the clause saying it needs no approval. A bare "user
      // rejected" leaves the model to guess, which it does by repeating itself or giving up.
      return {
        type: 'reject',
        ...(stickyRejected ? { scope: 'session' as const } : {}),
        message: buildRejectionMessage({
          source: 'user',
          toolName: pending.name,
          verdict: pending.safetyVerdict,
        }),
      };
    });

    // [[TUI-C68]] §6.1 — the ATTACK BANNER on the plain surface. An `attack` verdict says the
    // command's own structure evidenced compromise, and it ends the run; without this the only
    // recovery is a restart, which §12 forbids. Wiring the callback is what opts this session into
    // being asked — every surface that does not wire it keeps the halt (§6.2), so forgetting fails
    // safe rather than opening a hole.
    //
    // **It is not the approval prompt and must not read like one.** No menu, no scope, no key: one
    // typed phrase runs one command, and everything else stops the run — including a bare Enter and
    // any near miss. There is no second attempt on purpose: a re-prompt turns a typo into another
    // chance at an irreversible action.
    //
    // On this surface `rl.question` reads a whole LINE in cooked mode, so `q` and `Esc` are not
    // keystrokes it can intercept — they are simply text that is not the phrase, and stop the run
    // like any other. That is why the shared copy carries no keyboard line: the Ink TUI adds its own
    // keys beside these, and a line here naming keys this surface cannot honour would be false.
    runner.setAttackHaltCallback(async (halt) => {
      const copy = attackBannerCopy();
      const frameWidth = frameWidthFor(output.columns);
      displayDialogLine(`\n${copy.title}`, 'danger');
      const tooNarrow = narrowTerminalNotice(output.columns);
      if (tooNarrow) displayDialogLine(tooNarrow, 'warn');
      // The command and the rater's reason are model-authored text on the last screen between a
      // human and the action. They go through the SAME framing renderer as the approval dialog —
      // neutralised, gutter-numbered, substitution and composition sites listed above — because a
      // banner whose own chrome can be forged by the string it is warning about is worse than none.
      const framedCommand = frameUntrustedCommand(halt.command, { width: frameWidth });
      dialogLines(framedCommand.notices, 'warn');
      displayDialogLine('');
      dialogLines(framedCommand.lines);
      displayDialogLine('');
      displayDialogLine(copy.heading, 'danger');
      displayDialogLine(RATER_REASON_LABEL, 'notice');
      dialogLines(frameUntrustedText(halt.reason, { width: frameWidth }).lines, 'danger');
      // UNCONDITIONAL, on every attack banner whatever the rating said. The banner is rare by
      // construction, so the line cannot become noise, and a static string cannot fail the way a
      // model's explanation can.
      displayDialogLine(copy.irreversible, 'danger');
      dialogLines(copy.controls, 'notice');
      setRawMode(false); // ensure the typed phrase is echoed
      let answer: string;
      try {
        // [[EXT-105]] — the label goes out like every other line of the banner, and readline is
        // handed an empty prompt; see the approval menu above for why the prompt cannot stay on
        // readline's own stream.
        displayDialogLine(copy.prompt, 'prompt');
        answer = await askLine('');
      } finally {
        refStdin();
      }
      // One shot. The matcher is core's, so what the banner SAYS is answerable and what this
      // surface ACCEPTS cannot drift, and every value of the line that is not the phrase is a
      // refusal — which is what keeps the safe answer the fallthrough on a control that otherwise
      // accumulates keystrokes instead of rejecting them.
      if (!grantsRunAnyway(answer)) return 'stop';
      displayDialogLine(copy.granted, 'warn');
      return 'run-anyway';
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
      // The system prompt (backstory + guidelines + mode prompt + identity) is composed by the
      // agent and handed to its graph, so it is not injected here as a per-turn SystemMessage
      // (which yielded a second, non-first system message that Anthropic rejects).
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
            // [[TUI-C71]] — a run-ending approvals stop carries the command the rater called an
            // attack, and the rater's own words about it. Both are model-authored text on a
            // terminal, so they are painted through the SAME framing renderer as this surface's
            // approval dialog and §6.1 banner — one row per line, each inside the gutter — rather
            // than interpolated into a line the terminal is free to wrap back to column 0.
            if (err instanceof ApprovalStopError) {
              display('\n❌ Error processing message:');
              for (const row of approvalStopRows(err.parts, { columns: output.columns })) {
                display(row);
              }
              display('');
            } else {
              display(
                `\n❌ Error processing message: ${err instanceof Error ? err.message : String(err)}\n`
              );
            }
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
    // [[TUI-C71]] — **the `-m` path lands here, not on the loop's handler.** `processMessage` is
    // called once directly for `gth chat -m …` / `gth code -m …`, outside the interactive loop's
    // try/catch, so a run-ending approvals stop on that invocation reaches this outermost catch
    // with nothing between it and the terminal. It is the same untrusted text and it gets the same
    // framed renderer; only the channel differs, since this one writes to stderr.
    if (err instanceof ApprovalStopError) {
      error(`Error in ${sessionConfig.mode} command:`);
      for (const row of approvalStopRows(err.parts, { columns: output.columns })) error(row);
    } else {
      error(`Error in ${sessionConfig.mode} command: ${err}`);
    }
    exit(1);
  }
}
