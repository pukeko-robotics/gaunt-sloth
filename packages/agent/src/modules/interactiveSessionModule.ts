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
  grantsRunAnyway,
  RATER_REASON_LABEL,
} from '@gaunt-sloth/core/core/shell/escalationSeverity.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
} from '@gaunt-sloth/core/core/shell/framing.js';
import {
  APPROVAL_ASK_LINE,
  APPROVAL_ROW_DIALOG_TONES,
  approvalCategoryLine,
  approvalRequestRows,
} from '@gaunt-sloth/core/core/approvals/approvalRequest.js';
import { ApprovalStopError, approvalStopRows } from '@gaunt-sloth/core/core/shell/approvalStop.js';
import { displayTermination } from '@gaunt-sloth/core/core/terminationNotice.js';
import { readTermination, writeDebugDump } from '@gaunt-sloth/core/utils/debugDump.js';
import { appendToFile, getCommandOutputFilePath } from '@gaunt-sloth/core/utils/fileUtils.js';
import {
  openConversationSafe,
  recordSessionSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
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
import type {
  ApprovalLifetime,
  GthRunStats,
  PendingToolInterrupt,
} from '@gaunt-sloth/core/core/types.js';
import { type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { createResolvers } from '#src/resolvers.js';
import { resolveAgentFactory } from '#src/core/resolveAgentFactory.js';
import {
  approvalsRefusalsNotice,
  approvalsRungNotice,
  approvalsStatusNotice,
  approvalsTrustNotice,
  approvalsUndenyNotice,
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

/**
 * [[EXT-154]] — **the sentence a remembering answer earns, written from the lifetime the runner
 * recorded rather than from the key that was pressed.**
 *
 * `maintenance/ux-guidelines.md` (DL-4): a confirmation states what LANDED. The two answers this
 * covers — `[a]` and `[d]` — ask for a project file, and [[EXT-149]] degrades an `always` whose write
 * did not reach disk to the session answer it really is. That is decided inside the runner AFTER the
 * approval callback has returned, so these lines cannot be written where they are chosen; they are
 * written where the outcome arrives, once, and only then.
 *
 * **Binary on this surface, and that is a property rather than a simplification.** `[a]` and `[d]`
 * are shown only where `grantPreview`/`denyPreview` are attached, which is exactly where the runner
 * has an entry to record — so an answer here always records something and `once` is unreachable.
 * (The ACP surface offers its remembering options unconditionally and therefore does need the third
 * case; see `acpPermissions.ts`.)
 *
 * `/approvals undeny` is named on the refusal branch whichever way the write went, because it lists
 * and lifts a session refusal too, so the line is true on both.
 */
const rememberedAnswerLine = (decision: 'approve' | 'reject', landed: ApprovalLifetime): string => {
  const savedToProject = landed === 'always';
  if (decision === 'approve') {
    return savedToProject
      ? 'Approved and remembered — this exact command is saved to the project allow-list.'
      : 'Approved for this session only — it was not written to the project allow-list.';
  }
  return savedToProject
    ? 'Refused — this exact call will not run and will not ask again. It is saved to this ' +
        'project, so it stays refused in new sessions; lift it with /approvals undeny.'
    : 'Refused — this exact call will not run and will not ask again this session. It was not ' +
        'written to the project, so a new session will ask about it again; lift it with ' +
        '/approvals undeny.';
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

  // GS2-20: the session's checkpointer. Durable (SQLite, in the same file as the history store) when
  // history is on and the DB opens, so the LangGraph state this session builds outlives the process
  // and the conversation can be resumed with its tools and pending work intact; a MemorySaver — with
  // a notice — when it cannot be. Never no saver: with a tool-approval interrupt installed, the
  // absence of one throws MISSING_CHECKPOINTER mid-turn.
  const checkpointer = openSessionCheckpointerSafe(config);

  // GS2-19: open ONE conversation for this interactive session up-front; every turn below is stamped
  // with its id so a multi-turn chat groups under one conversation (not N unrelated rows). Fail-soft:
  // a no-op returning undefined when `history.enabled: false`, in which case turns fall back to
  // per-turn 1-turn conversations.
  //
  // GS2-20: it also carries the thread id, which is the link a resume travels — from the id
  // `gth history list` prints, to the checkpoint holding this session's state. Written HERE, before
  // the runner exists, because `runner.init` can throw partway and a conversation whose thread was
  // never recorded is an entry that can never be resumed.
  const conversationId =
    openConversationSafe(config, {
      command: sessionConfig.mode,
      project: getProjectDir(),
      model: config.modelDisplayName,
      threadId: checkpointer.threadId,
    }) ?? undefined;

  // Initialize Runner

  const logFileName = getCommandOutputFilePath(config, sessionConfig.mode);
  if (logFileName) {
    initSessionLogging(logFileName, config.streamSessionInferenceLog);
  }
  // B5: interactive code/chat ask for the LEAN backend, the only one Gaunt Sloth ships —
  // config.agent.backend names no other. createResolvers() is unchanged, so the session keeps the
  // full toolset (filesystem + hardened dev/shell).
  const runner = new GthAgentRunner(
    defaultStatusCallback,
    createResolvers(),
    resolveAgentFactory(config, 'lean')
  );

  try {
    await runner.init(sessionConfig.mode, config, checkpointer.saver, {
      threadId: checkpointer.threadId,
    });
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
        // [[EXT-159]] — why the last turn ended, and the provider's own stop tokens for it. Read at
        // CALL time like everything above, and threaded whenever it can be read at all: a `null`
        // REASON is the archive's record that no site classified the ending, which is the reading a
        // maintainer most needs. A failed READ is a third thing and omits the section instead, so
        // "nobody classified this turn" and "this session could not report it" stay distinguishable
        // — and a diagnostics field can never be what stops the diagnostics being written.
        termination: readTermination(runner),
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
    // [[EXT-154]] — the interrupts whose answer asked for a PROJECT FILE, waiting to be told what
    // they got. Only `[a]` and `[d]` land here; every other answer records nothing and is confirmed
    // where it is chosen.
    //
    // **Keyed by the interrupt object, the correlation the seam documents**, rather than by "the
    // one that is outstanding". This surface does prompt strictly one at a time, but that is a
    // property of the runner's drain loop, not of this module — and holding a claim about someone
    // else's loop here is how one call's persistence ends up confirmed on another call's dialog.
    // Emptied as each is consumed, so nothing accumulates over a long session.
    const rememberAsked = new Set<PendingToolInterrupt>();

    runner.setToolApprovalCallback(async (pending) => {
      // [[EXT-137]] — **the request block, rendered by core and printed linearly here.**
      //
      // This surface has no dock: it prints and it scrolls, so what a person reads immediately
      // before pressing a key is whatever happened to be printed last. That makes the ORDER the
      // whole mitigation, and the order is core's rather than this module's —
      // `approvalRequestRows` puts the explanation first, the call after it and the HOSTS last, so
      // the counterparty's identity is adjacent to the menu however long the note above it ran.
      // The Ink TUI commits the identical rows into its transcript and `transcriptWindow` budgets
      // them, so the three cannot come to disagree about what a human was shown.
      //
      // [[TUI-C26]] §6 — every untrusted half in those rows arrives already framed: neutralised,
      // inside a line-number gutter, with its command-substitution and composition sites listed
      // above it. Model-authored text going to a terminal is not inert — a carriage return reaches
      // column 0, an escape sequence clears the screen, and a newline alone lays down a line that
      // looks exactly like this dialog's own chrome. Nothing is clamped to one line: the command
      // that motivated the framing hid its payload fifteen lines into a commit message, and a clamp
      // discards exactly what the human must rule on.
      displayDialogLine('');
      for (const row of approvalRequestRows(pending, { columns: output.columns })) {
        displayDialogLine(row.text, APPROVAL_ROW_DIALOG_TONES[row.tone]);
      }
      // [[EXT-137]] — the two lines the Ink dock pins, printed here in this surface's equivalent
      // position: immediately above the menu, which is the last thing read before a key is pressed.
      // Both are ours — a constant, and one of four enumerated category sentences — so no amount of
      // padding anywhere in the call can change a byte of either. The category is what makes the
      // line worth reading: it says which CLASS of thing is about to be allowed, which a bare "an
      // answer is needed" cannot, and a reader who is told nothing has no reason to look up.
      displayDialogLine('');
      displayDialogLine(APPROVAL_ASK_LINE, 'warn');
      displayDialogLine(approvalCategoryLine(pending), 'warn');
      // §6/EXT-70 — which sticky controls the gate would actually store something for. The menu
      // below is assembled from these two booleans, never from what they would store.
      const sticky = pending.grantPreview !== undefined;
      const stickyDeny = pending.denyPreview !== undefined;
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
        // [[EXT-154]] — **no sentence here.** This answer asks for a project file and the write has
        // not been attempted yet, so anything written on this line would be a claim about a file
        // nobody has tried to make. Recorded instead, and confirmed by the outcome callback below
        // once the runner says what it landed as. The approve twin of the `[d]` branch, and the one
        // [[EXT-150]] found telling the identical lie beside the reject branch its node named.
        rememberAsked.add(pending);
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
      // [[EXT-154]] — the ORDINARY refusal is confirmed here and the remembered one is not, and the
      // split is the whole fix. This line records nothing, so it is true the instant it is written;
      // *always reject* asks for a project file, which [[EXT-107]] makes real and [[EXT-149]] can fail
      // to write, and neither is known until the runner has tried. So the remembering answer is
      // noted and the sentence it earns is committed by the outcome callback below — once, when it
      // is known, never optimistically and then corrected.
      if (stickyRejected) rememberAsked.add(pending);
      else displayDialogLine('Command rejected.', 'notice');
      // EXT-58 (§7): the model is told the moves it has — re-call with a justification, or call a
      // different command — and, when the rater named an already-granted alternative (§4.4), that
      // tool plus the clause saying it needs no approval. A bare "user rejected" leaves the model
      // to guess, which it does by repeating itself or giving up.
      return {
        type: 'reject',
        // [[EXT-107]] — `always`, which is what the label above promised. The lifetime that
        // actually lands is core's to decide (a project file that cannot be written degrades to a
        // session refusal), so this surface asks for the scope and never assumes the outcome.
        ...(stickyRejected ? { scope: 'always' as const } : {}),
        message: buildRejectionMessage({
          source: 'user',
          toolName: pending.name,
          verdict: pending.safetyVerdict,
        }),
      };
    });

    // [[EXT-154]] — **the return leg**, and the reason the two sentences above moved. The runner
    // records a remembering answer only after the callback that gave it has returned, so this is
    // the first moment either one can be described truthfully; written any earlier, the *saved to
    // this project* line sits on screen beside core's own ERROR naming the file it could not write.
    //
    // Nothing here decides anything — by the time it fires the answer is made and the record is
    // written — and an outcome for an interrupt this surface did not note is dropped, which is what
    // keeps `[o]`, `[s]` and the ordinary refusal from being confirmed twice.
    runner.setApprovalOutcomeCallback((outcome) => {
      if (!rememberAsked.delete(outcome.pending)) return;
      displayDialogLine(rememberedAnswerLine(outcome.decision, outcome.lifetime), 'notice');
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

    // [[TUI-C69]] §5.4/§5.5 — **this session has a live display, so the negotiation is watched
    // rather than only reported.** Wiring it opts this surface into both halves: each round is
    // drawn the moment the gate decides it, and a negotiated approval is held visible for the
    // minimum interval before it takes effect. A surface that wires nothing — an `exec` run, CI —
    // neither draws nor sleeps, which is why one seam carries both.
    //
    // Rendered through core's shared `renderNegotiationRows`, with this surface's own existing
    // voice → tone mapping: the rater's turns `warn` (yellow) as §5.4 requires, the agent's plain,
    // the chrome as a notice. The rows also NAME their speaker, which is the half of the
    // distinction that survives a terminal with no colour at all. The Ink TUI renders the same
    // rows, so the two surfaces cannot describe one exchange differently.
    runner.setNegotiationDisplay({
      round: ({ round, position, agreed, revised }) => {
        // One round at a time, and on THIS surface that is correct: scrollback is append-only, so
        // each round is printed once as it happens and nothing redraws. The Ink dock is the one that
        // needs the whole list (`renderLiveNegotiationRows`), because there the accumulated rounds
        // are re-rendered into a region that cannot scroll and must therefore be bounded.
        for (const row of renderNegotiationRows([round], {
          width: frameWidthFor(output.columns),
          mode: 'live',
          from: position,
          ...(agreed ? { agreed } : {}),
          ...(revised ? { revised } : {}),
        })) {
          if (row.voice === 'rater') displayDialogLine(row.text, 'warn');
          else if (row.voice === 'agent') displayDialogLine(row.text);
          else displayDialogLine(row.text, 'notice');
        }
      },
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

      // GS2-18: wire the readline (`--no-tui`) interactive path into the local history recorder
      // at its turn boundary, matching the single-shot and Ink-TUI paths. Fail-soft, and a no-op
      // when `history.enabled` is false. GS2-16 threads live token/tool/duration analytics; costUsd
      // stays unset.
      const startedAt = Date.now();
      const responseText = await runner.processMessages(messages);
      // [[EXT-159]] — say why the turn ended, before the prompt comes back.
      //
      // The plain/readline surface is where a user lands whenever the Ink TUI cannot run, and it
      // showed exactly what the TUI did about a stop: the wrapped error string, or on a silent
      // ending nothing at all. Read from the runner rather than inferred from `responseText`,
      // because the endings this exists for — a cancellation, an exhausted approval drain, an empty
      // turn — are the ones that return normally with nothing to infer from.
      try {
        displayTermination(runner.getTerminationReason());
      } catch {
        /* fail-soft: explaining a turn must never be what ends the session */
      }
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
      checkpointer.close();
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
              const refusals = runner.getRefusals();
              printNotice(
                approvalsStatusNotice(
                  runner.getSessionApprovals(),
                  runner.getAllowlistCounts(),
                  refusals,
                  runner.getGrants(),
                  runner.getMcpAnnotationTrust()
                )
              );
              // [[EXT-107]] — the refusals as their own notice, after the posture and nearest the
              // prompt: it is the block the user acts on, and it carries the number `undeny` takes.
              const refused = approvalsRefusalsNotice(refusals);
              if (refused) printNotice(refused);
            } else if ('undeny' in result.approvals) {
              // [[EXT-107]] — lift a refusal by its number. The notice is built from what the
              // runner RETURNS, so it can only describe the refusal actually lifted — including the
              // case where a config entry goes on refusing the call after a saved one is removed.
              printNotice(approvalsUndenyNotice(runner.liftRefusal(result.approvals.undeny.index)));
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
    checkpointer.close();
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
  } finally {
    // GS2-20: the backstop, not the usual door. `endSession` closes the connection as soon as the
    // session ends, which is what releases the file promptly; this is here so that a future exit
    // path added to the loop cannot silently stop closing it. Closing twice is safe — the saver's
    // close swallows, and `sessionCheckpointer.spec.ts` pins that.
    checkpointer.close();
  }
}
