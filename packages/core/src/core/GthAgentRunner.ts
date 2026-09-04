import {
  type AllowlistCounts,
  type ApprovalEntry,
  type ApprovalRefusal,
  type ApprovalRefusalLift,
  type ApprovalRefusalOrigin,
  type ApprovalRung,
  APPROVAL_RUNG_LABELS,
  DEFAULT_APPROVAL_RUNG,
  describeGrantedBuiltInTools,
  type GrantedToolSummary,
  GthConfig,
  isNegotiatingRung,
  isRatedRung,
  type McpAnnotationTrustChange,
  type McpAnnotationTrustView,
  type McpApprovalsConfig,
  type McpToolApprovalEntry,
  type ResolvedApprovals,
  commandCarriesUserProvenance,
  isToolGatedAtRung,
  resolveApprovals,
  resolveGatedToolNames,
  resolveShellApprovalGate,
  SHELL_TOOL_NAME,
  type ShellApprovalEntry,
  TOOL_ANNOTATION_HINTS,
  type ToolAnnotationHint,
} from '#src/config.js';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AgentResolvers,
  AgentStreamEvent,
  type ApprovalLifetime,
  type ApprovalOutcomeCallback,
  type AttackHaltCallback,
  GthAgentFactory,
  GthAgentInterface,
  GthCommand,
  GthRunStats,
  type GthTerminationReason,
  type GthTerminationSite,
  Message,
  PendingToolInterrupt,
  StatusLevel,
  StatusUpdateCallback,
  ToolApprovalCallback,
  ToolApprovalDecision,
  type ToolApprovalScope,
  type ToolRejectScope,
} from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';
import {
  annotationWeakenings,
  type ApprovalGrant,
  ApprovalGrantStore,
  type ApprovalGrantScope,
  describeWeakenedGrant,
  PersistedApprovalGrants,
  shellGrantEntry,
  toolGrantEntry,
  trustWithdrawalWeakens,
} from '#src/core/approvals/grants.js';
import { renderApprovalEntryObject } from '#src/config/schema.js';
import { classifyCommand } from '#src/core/shell/arity.js';
import { describeAbstention } from '#src/core/shell/abstention.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import {
  ApprovalStopError,
  AttackHaltError,
  NonInteractiveEscalationError,
} from '#src/core/shell/approvalStop.js';
import {
  attachTerminationReason,
  classifyThrownTermination,
  replaceTerminationReason,
  terminationPosture,
  terminationReason,
  terminationReasonOf,
  type GthFinishReasonObservation,
} from '#src/core/terminationReason.js';
import { terminationLogLine } from '#src/core/terminationNotice.js';
import {
  applyDestructiveFloor,
  effectivePreflightFloorFinding,
  isBelowDestructiveFloor,
  isNegotiableCall,
  isRaterTimeout,
  mapAllowMatchedVerdictToAction,
  mapVerdictToAction,
  openWorldToolFloorReason,
  preflightFloorFinding,
  RATER_DEFAULT_TIMEOUT_MS,
  rateShellCommand,
  type RaterAction,
  type RaterNegotiationRound,
  type ShellSafetyVerdict,
} from '#src/core/shell/rater.js';
import { RaterHealth } from '#src/core/shell/raterHealth.js';
import {
  type AlignmentDecision,
  alignmentApprovalNotice,
  type AlignmentSubject,
  isAlignmentFailClosed,
  runAlignmentCheck,
} from '#src/core/shell/alignment.js';
import {
  type ApprovalDecisionCapture,
  ApprovalCaptureLog,
  type ApprovalDecidingStage,
} from '#src/core/shell/approvalCapture.js';
import { buildHardlineRefusal, checkHardline } from '#src/core/shell/hardline.js';
import {
  NEGOTIATED_APPROVAL_COOLDOWN_MS,
  renderNegotiationTranscript,
  ShellNegotiationState,
  type LiveNegotiationRound,
  type NegotiationDisplay,
  type NegotiationVerdict,
} from '#src/core/shell/negotiation.js';
// [[EXT-106]] §4.6 — the user-provenance carve-out, read once per decision and handed to every
// reader of it (the floor, the negotiation test, the rating prompt, the archive and the warning).
import { carvedOpenWorldHosts } from '#src/core/shell/provenance.js';
import { buildRejectionMessage } from '#src/core/shell/rejection.js';
import {
  type ApprovalRuleDecision,
  type ApprovalRuleLists,
  type ApprovalSubject,
  describeApprovalEntry,
  type EffectiveToolAnnotations,
  type EffectiveToolAnnotationSource,
  type McpToolApprovalSubject,
  resolveApprovalRules,
  type ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';
import {
  createEffectiveToolAnnotationSource,
  trustedAnnotationHints,
} from '#src/core/approvals/annotations.js';
import { approvalSubjectForToolName } from '#src/core/approvals/mcpSubjects.js';
import { toolCallHosts } from '#src/core/approvals/toolHost.js';
import {
  builtInToolAnnotations,
  mcpDeclaredAnnotationLookup,
} from '#src/core/approvals/toolAnnotationSources.js';
import { resolveRaterModel } from '#src/core/shell/raterModel.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '#src/utils/systemUtils.js';
import { getGslothConfigWritePath } from '#src/utils/fileUtils.js';
import { SHELL_ALLOWLIST_FILE, SHELL_DENYLIST_FILE } from '#src/constants.js';
import { enhanceVertexUnauthorizedMessage } from '#src/utils/vertexaiUtils.js';
import { RunnableConfig } from '@langchain/core/runnables';
import { getNewRunnableConfig } from '#src/utils/llmUtils.js';
import {
  initDebugLogging,
  debugLog,
  debugLogError,
  debugLogObject,
} from '#src/utils/debugUtils.js';
import { updateCrashContext } from '#src/utils/crashHandler.js';
import { setToolDisplayConfig } from '#src/core/toolDisplay.js';
import {
  compactMessages,
  type CompactConversationOptions,
  type ConversationCompaction,
  conversationSize,
  createModelSummarizer,
  DEFAULT_KEEP_RECENT,
} from '#src/core/compaction.js';

/**
 * GS2-48 — how many trailing messages of the in-flight turn to hand the crash handler as the
 * transcript tail. A crash file is triage, not the full session, so only the last few messages are
 * kept; they are redacted (GS2-47) by the crash snapshot writer before anything reaches disk.
 */
const CRASH_TRANSCRIPT_TAIL_MESSAGES = 8;

/**
 * A private copy of a rule entry, for handing to a display. `pattern` is the one field that can be
 * an object (a `hint` pattern, §3.1), so it is copied too — a shallow spread alone would leave the
 * displayed entry sharing the very object the matcher compares against.
 */
function copyApprovalEntry(entry: ApprovalEntry): ApprovalEntry {
  if (entry.type === 'shell' || typeof entry.pattern === 'string') return { ...entry };
  return { ...entry, pattern: { ...entry.pattern } };
}

/**
 * [[EXT-29]] §5.1 — the `justification` argument of a `run_shell_command` call, when the model
 * supplied a usable one.
 *
 * Read defensively for the same reason `command` is: these are model-authored arguments arriving
 * through a schema the graph validated but that this method does not re-validate, so a non-string
 * or a whitespace-only value is *absent* rather than a second spelling of empty.
 *
 * **What the trim buys is the RECORDED ROUND, not the prompt.** The rating prompt is already safe
 * without it — `buildNegotiationContextBlock` drops a blank justification before it renders a fence,
 * and `renderNegotiationTranscript` drops one before it renders a line. What only this can do is
 * keep the round itself honest at the point it is written: a round carrying a whitespace-only
 * justification asserts that the agent argued something it did not, to everything that later reads
 * the transcript rather than a rendering of it. Both downstream guards then stay defence in depth
 * instead of being the only thing between a blank string and that claim.
 */
function shellJustification(args: Record<string, unknown> | undefined): string | undefined {
  const value = args?.justification;
  if (typeof value !== 'string') return undefined;
  return value.trim().length === 0 ? undefined : value;
}

/**
 * §3.1 — **the one `approvals.allow` entry that would cover this shell command**, or `undefined`
 * when the grammar cannot hold one.
 *
 * Two readers, one answer: what the escalation menu's *always approve* control would store
 * ({@link GthAgentRunner.stickyGrantFor}), and what [[EXT-106]] §4's refusal tells a user to add to
 * their config. Those are the same entry, and deriving it twice is how a menu and a message come to
 * promise different things about one command.
 *
 * **`exact`, never a pattern.** The entry has to be correct enough to paste, and a `glob` inferred
 * from a command is a guess about which part of it may vary: widened one token too far it grants
 * more than the user was ever shown. A subtly-too-broad pasteable entry is worse than none, so the
 * breadth stays where {@link shellGrantEntry} puts it — this command, and only this command.
 *
 * `undefined` for a command the allow classifier cannot resolve, because **no allow entry of any
 * matcher would match it**: rendering one would hand someone a line that changes nothing and looks
 * as though it should.
 */
function shellApprovalEntryFor(command: string): ShellApprovalEntry | undefined {
  if (classifyCommand(command, normalizeCommand) === null) return undefined;
  return shellGrantEntry(command);
}

/**
 * [[EXT-29]] §5.1 — the text of the human messages in a turn's input, for the rater's last-5 window.
 *
 * Structural and fail-soft, like `runStats`'s accumulator: the runner is handed `BaseMessage`s from
 * several surfaces (readline, TUI, ACP, AG-UI) and a multimodal turn's `content` is an array of
 * blocks rather than a string. Only the text of a `human` message is taken, and the filter beside
 * the loop is why: a multimodal turn's non-text blocks (an image) contribute nothing.
 *
 * **What this does NOT do is exclude file contents, tool output or fetched pages, and the
 * distinction matters.** §4.3 admits none of those *as messages of their own*, and none of them
 * arrives as one — but a `human` message's own text is taken whole, whatever put it there. On the
 * file-fed verbs that is a great deal: `exec` reads a prompt FILE from disk, `ask -f` reads a file
 * and piped stdin, and `review`/`pr` carry the entire diff — all of them as `human` messages, all of
 * them therefore in this window. Anything that treats these strings as *"what the user typed"* is
 * treating a file the agent was pointed at as the user's own words; [[EXT-106]] §4.6's provenance
 * carve-out does exactly that, deliberately and only at `auto`, and it is documented as such in
 * `docs/guides/shell-tool-and-approvals.md`.
 */
function humanMessageTexts(messages: readonly Message[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    try {
      const type = message?.getType?.();
      if (type !== 'human') continue;
      const content: unknown = message.content;
      if (typeof content === 'string') {
        texts.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      const parts = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: unknown }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
        )
        .map((block) => block.text);
      if (parts.length > 0) texts.push(parts.join('\n'));
    } catch {
      /* fail-soft: an odd message shape just means that message contributes nothing */
    }
  }
  return texts;
}

/**
 * EXT-114 — the page describing the `subagents` config key, pointed at rather than paraphrased in
 * the notice itself.
 *
 * **A GitHub blob URL, matching the other user-facing runtime doc links in this repo** (the
 * approvals-protection pointer in `config/shell-policy.ts` and the 2.0 migration pointer in
 * `config/schema.ts`) — a running CLI's user has no checkout for a relative path to resolve in.
 * `subagentScope.spec.ts` pins that this URL's anchor still resolves to a real heading in the page
 * it names, because a doc link that silently rots is worse than no link.
 */
export const SUBAGENTS_DOCS_URL =
  'https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/configuration/profiles.md#named-profile-subagents-subagents';

/** Options for {@link GthAgentRunner#init} that qualify the run without changing how it behaves. */
export interface GthAgentRunnerInitOptions {
  /**
   * GS2-81 — the CLI verb this run belongs to, for messages only, when `command` is deliberately
   * `undefined`. It is a SEPARATE input from `command` because `command` is not a label: it selects
   * the mode prompt (`readModePrompt`), the per-command approvals posture (`resolveApprovals`) and
   * the command-specific filesystem config, so a helper agent that must run on the chat prompt —
   * the `gth pr` change-requirements discovery agent — cannot borrow it to say which verb it serves.
   *
   * **It is read for the wording of a notice, and for one safety decision.** [[EXT-106]] §4.6 asks
   * whether this run's human messages are the user's own words, and answers it from
   * `command ?? owningCommand` ({@link import('../config/shell-policy.js').commandCarriesUserProvenance}
   * at the top of {@link GthAgentRunner#init}) — precisely because a command-less helper agent whose
   * human turn is content the product FETCHED must not be classified by the absence of a verb. The
   * key has to be out-of-band metadata like this field: a marker inside the message would be
   * forgeable by the attacker-controlled text it is supposed to classify. Both that predicate and
   * the provenance window itself fail closed, so leaving this unset never widens anything.
   */
  owningCommand?: GthCommand;

  /**
   * GS2-95 — the name of the command the USER typed, for the run header only (`eval`, `batch`,
   * `workflow`, `gth-batch`). Forwarded verbatim to the agent's own `displayCommand` init option;
   * the runner reads nothing from it.
   *
   * Separate from `command` for the same reason `owningCommand` is, and a distinct field from it:
   * `owningCommand` says which verb a command-less helper agent serves, this says what to CALL a
   * run that does have a verb but does not go by its name.
   */
  displayCommand?: string;

  /**
   * GS2-20 — the LangGraph thread this run drives, instead of the fresh one `init` would mint.
   *
   * It is what makes a durable checkpointer useful in both directions: a session supplies the id it
   * has already recorded against its conversation row, so the state it writes can be found again;
   * and a resume supplies a stored id, so the graph comes back holding what it held. Omitted, the
   * runner mints a fresh thread exactly as before.
   *
   * Note that `/clear` ({@link GthAgentRunner#resetThread}) deliberately rotates to a NEW thread, so
   * after one the id recorded against the conversation names the state from before the clear — which
   * is the correct thing for it to name, since that is the state the user asked to leave behind.
   */
  threadId?: string;
}

/**
 * Agent simplifies interaction with LLM and reduces it to calling a few methods
 * {@link GthAgentRunner#init} and {@link GthAgentRunner#processMessages}.
 */
export class GthAgentRunner {
  private statusUpdate: StatusUpdateCallback;
  private resolvers: AgentResolvers | undefined;
  private agent: GthAgentInterface | null = null;
  private config: GthConfig | null = null;
  private runConfig: RunnableConfig | null = null;
  private agentFactory: GthAgentFactory;
  /**
   * Consumer hook invoked when a run suspends on a tool-approval interrupt (e.g. the opt-in
   * `run_shell_command` confirmation). Set via {@link setToolApprovalCallback}; when unset the
   * runner REJECTS pending tool calls rather than hanging or auto-approving — the safe default
   * for non-interactive entrypoints (a scripted `exec` run with no TTY to prompt on).
   */
  private toolApprovalCallback: ToolApprovalCallback | null = null;

  /**
   * [[EXT-150]] — consumer hook invoked once per human-answered approval, AFTER the answer has been
   * recorded, carrying the lifetime it landed with. Set via {@link setApprovalOutcomeCallback}; when
   * unset the outcome is simply not reported, which is where every surface was before this existed.
   */
  private approvalOutcomeCallback: ApprovalOutcomeCallback | null = null;

  /**
   * [[TUI-C68]] §6.1 — consumer hook invoked when the rater rates a command an `attack`, so an
   * interactive surface can show the red banner before the run ends. Set via
   * {@link setAttackHaltCallback}; **when unset the runner halts immediately**, which is the
   * behaviour every surface had before a banner existed. A surface that forgets to wire it
   * therefore keeps the halt rather than losing it.
   */
  private attackHaltCallback: AttackHaltCallback | null = null;

  /**
   * [[TUI-C69]] §5.4/§5.5 — **the surface showing this negotiation while it happens**, when one
   * is. Set via {@link setNegotiationDisplay}.
   *
   * Its presence is the answer to *"is anyone watching?"*, and BOTH halves of the visible
   * negotiation are keyed on it: the rounds are handed over as they are decided, and a negotiated
   * approval is held on screen for {@link NEGOTIATED_APPROVAL_COOLDOWN_MS} before it takes effect.
   *
   * **`null` means neither happens, and that is the point.** An `exec` or CI run has nobody to
   * show an approval to, so an 800 ms hold there would tax every headless run and every gate for a
   * display that does not exist. Deliberately NOT keyed on {@link toolApprovalCallback}: that one
   * answers *"is there a human to ASK"*, a different question with a different answer — a piped
   * readline session can have one wired and no live display, and the §6.2 non-interactive path has
   * a display and no one to ask.
   */
  private negotiationDisplay: NegotiationDisplay | null = null;

  /** The command the runner was initialized for; selects which `devTools` config applies. */
  private command: GthCommand | undefined = undefined;

  /**
   * GS2-16 — snapshot of the last turn's analytics (token usage + invoked tools), captured from
   * the agent at {@link cleanup} time. Needed because {@link runSingleShot} reads stats AFTER it
   * has already called `cleanup()` (which nulls the agent); interactive callers read live via
   * {@link getRunStats} before cleanup. Defaults to an empty tally.
   */
  private lastRunStats: GthRunStats = { tools: [] };

  /**
   * [[EXT-159]] — why the current turn ended, as classified by the sites the RUNNER owns (the two
   * exception wrappers, the approvals re-throws, the empty-response throws, the ordinary end of a
   * turn). The agent owns the sites inside it and its answer outranks this one; see
   * {@link getTerminationReason}.
   */
  private terminationReason: GthTerminationReason | null = null;

  /**
   * [[EXT-159]] — snapshot of the agent's own termination reason, for the same reason
   * {@link lastRunStats} exists: {@link cleanup} nulls the agent, and the single-shot path reads
   * the reason afterwards.
   */
  private agentTerminationReason: GthTerminationReason | null = null;

  /**
   * [[EXT-159]] — snapshot of the agent's per-message `finish_reason` observations, kept for the
   * same reason {@link agentTerminationReason} is: `/debug-dump` and the non-interactive verbs ask
   * after {@link cleanup} has already dropped the agent.
   */
  private agentFinishReasons: readonly GthFinishReasonObservation[] = [];

  /**
   * GS2-23 — how many turns are being driven right now, through either driver. Read by
   * {@link compactConversation}, which refuses to rewrite the thread underneath a running turn:
   * the graph would be writing checkpoints for the turn while the compaction wrote a competing one.
   */
  private turnsInFlight = 0;

  /**
   * CFG-27 — the runtime, session-scoped approvals posture, seeded at {@link init} from
   * {@link resolveApprovals} and thereafter switchable for the session by `/approvals <rung>`.
   * **This field, not the interrupt wiring, is where the rung lives.** The agent wires the
   * interrupt rung-independently, so every tool any rung could gate arrives at the top of
   * {@link decideToolApproval} and is judged against the rung recorded here — which is what makes
   * `/approvals manual` take effect mid-session, and what keeps a config that pre-selects
   * `bypass` switchable back. Never persisted.
   *
   * It does NOT disable the hardline floor — catastrophic commands are still refused at exec time
   * in `GthDevToolkit.executeCommand` under every rung.
   */
  private sessionApprovals: ResolvedApprovals = {
    rung: DEFAULT_APPROVAL_RUNG,
    allow: [],
    deny: [],
    escalate: [],
  };

  /**
   * CFG-26 — the model the AI rater rates with, when `approvals.rater.profile` names an identity
   * profile. Resolved ONCE at {@link init} (never mid-turn) and handed to `rateShellCommand`;
   * `undefined` means no profile is configured and the rater uses the session model.
   */
  private raterModel: BaseChatModel | undefined;

  /**
   * [[EXT-127]] — the model the ALIGNMENT CHECKER runs on, when `approvals.alignmentChecker` (or, by
   * its read-site default, `approvals.rater`) names an identity profile. Resolved ONCE at
   * {@link init}, exactly as {@link raterModel} is; `undefined` means the session model.
   */
  private alignmentCheckerModel: BaseChatModel | undefined;

  /**
   * EXT-66 — how many rating calls this session gave up on. Counted so the notice can say "3 times
   * this session" rather than repeating an identical line, and so a silent drift toward
   * escalate-everything has a number attached to it.
   */
  private raterTimeouts = 0;

  /**
   * [[EXT-82]] — the consecutive-failure tracker behind the session-level signal, per runner and
   * therefore per session (the ACP surface runs several at once). See
   * {@link import('#src/core/shell/raterHealth.js').RaterHealth}.
   */
  private readonly raterHealth = new RaterHealth();

  /**
   * EXT-71 §3.1/§6 — what the escalation menu granted at run time, for the life of THIS runner
   * instance: {@link ApprovalEntry} objects, never prefixes, and never anything from config (the
   * declared lists are read-only input consulted straight from the posture). Instance-scoped so
   * concurrent sessions (ACP / AG-UI multi-session) cannot stomp each other's approvals.
   */
  private readonly sessionGrants = new ApprovalGrantStore();

  /**
   * CFG-27 §3 — what the escalation menu's *always reject* choice adds at run time, in the same
   * grammar ([[TUI-C26]] wires that writer; the store speaks it already). The entries DECLARED in
   * `approvals.deny` are not here — they are read-only config input, matched from the posture — and
   * both are handed to the same matcher, so a runtime refusal and a declared one are one list.
   */
  private denyGrants = new ApprovalGrantStore();

  /**
   * The persisted (`always`) grant store, loaded lazily on first use from
   * `.gsloth/.gsloth-settings/shell-allowlist.json`. Null until a gated call actually needs it, and
   * null when the file cannot be loaded at all (in which case `always` grants degrade to session).
   */
  private persistedGrants: PersistedApprovalGrants | null = null;
  private persistedGrantsLoaded = false;

  /**
   * [[EXT-107]] — the persisted (`always`) **refusal** store, from
   * `.gsloth/.gsloth-settings/shell-denylist.json`. The mirror of {@link persistedGrants}, and the
   * reason the menu's most emphatic answer is no longer its most forgetful one.
   *
   * Null when the file cannot be loaded at all, in which case an `always` refusal degrades to a
   * session one. **Not "a re-prompt next session, never an execution":** nothing in the unreadable
   * file applies to any call, so next session a call it covered is left to the rest of the gate — it
   * may be refused by another rule, it may be prompted for, or it may run without asking, under
   * `bypass` or a matching saved allow. The user is told at load time.
   */
  private persistedDenials: PersistedApprovalGrants | null = null;
  private persistedDenialsLoaded = false;

  /**
   * [[EXT-29]] §5 — the state of the agent↔rater negotiation at `auto`: the transcript, §5.3's
   * consecutive-rejection counter and the reachability bound. Instance-scoped for the same reason
   * the grant stores are — a concurrent ACP / AG-UI session must not inherit another's argument.
   */
  private readonly negotiation = new ShellNegotiationState();

  /**
   * [[TUI-C27]] — the diagnostic record of every gated decision this session made, for
   * `/debug-dump`. Instance-scoped for the same reason the negotiation and the grant stores are: a
   * concurrent ACP / AG-UI session must not inherit another's approvals history, and a dump taken
   * in one must not describe the other.
   */
  private readonly approvalCaptures = new ApprovalCaptureLog();

  /**
   * @param agentFactory Produces the {@link GthAgentInterface} the runner drives.
   *   Defaults to the lean {@link GthLangChainAgent} (core). The seam stays parameterised so a
   *   caller can drive the runner with a different graph builder without core depending on it.
   */
  constructor(
    statusUpdate: StatusUpdateCallback,
    resolvers?: AgentResolvers,
    agentFactory?: GthAgentFactory
  ) {
    this.statusUpdate = statusUpdate;
    this.resolvers = resolvers;
    this.agentFactory =
      agentFactory ?? ((status, agentResolvers) => new GthLangChainAgent(status, agentResolvers));
  }

  /**
   * Register the tool-approval handler the runner calls when a run suspends on a tool-approval
   * interrupt (the interactive readline session wires a y/n prompt here). Pass `null` to clear.
   * Without a handler the runner rejects pending tool calls (see {@link toolApprovalCallback}).
   */
  public setToolApprovalCallback(callback: ToolApprovalCallback | null): void {
    this.toolApprovalCallback = callback;
  }

  /**
   * [[EXT-150]] — register the handler that is told **what a human's answer actually landed as**.
   * Pass `null` to clear.
   *
   * Separate from {@link setToolApprovalCallback} for the reason {@link setAttackHaltCallback} is
   * separate: it is a different question asked at a different moment. The approval callback is
   * consulted *before* anything is written and returns the human's REQUEST; the scope that survives
   * is decided here afterwards, because [[EXT-149]] degrades an `always` whose write did not reach
   * disk to the `session` answer it really is. A surface with no way to hear that can only confirm
   * the key that was pressed — and core's own ERROR naming the unwritten file then contradicts it.
   *
   * It reports; it never decides. Nothing downstream reads it, so a surface that ignores it, or
   * never wires it, changes no behaviour of the gate.
   */
  public setApprovalOutcomeCallback(callback: ApprovalOutcomeCallback | null): void {
    this.approvalOutcomeCallback = callback;
  }

  /**
   * [[TUI-C68]] §6.1 — register the handler that shows the **attack banner**, the one way a human
   * gets past an `attack` verdict. Pass `null` to clear.
   *
   * Separate from {@link setToolApprovalCallback} because it is a separate question with an
   * inverted default: an absent approval callback means *this session has nobody to ask*, and an
   * absent one here means *end the run*. Wiring it is what an interactive surface opts into; every
   * other surface keeps the halt (see {@link attackHaltCallback}).
   */
  public setAttackHaltCallback(callback: AttackHaltCallback | null): void {
    this.attackHaltCallback = callback;
  }

  /**
   * [[TUI-C69]] §5.4/§5.5 — **declare that this surface is showing the negotiation as it happens.**
   * Pass `null` to clear.
   *
   * §5.4's requirement is not decoration: *"the spec's own justification for letting the agent
   * argue with the rater at all is that a human can watch it, and an argument conducted in the dark
   * is a different thing from one that can be interrupted."* Wiring this is a surface saying it
   * has somewhere to draw that, which is also what makes §5.5's hold meaningful — see
   * {@link negotiationDisplay} for why one seam carries both.
   */
  public setNegotiationDisplay(display: NegotiationDisplay | null): void {
    this.negotiationDisplay = display;
  }

  /**
   * §6.1 — **the single seam between an `attack` verdict and the end of the run.** Both rating
   * paths — the §3.2 allow-match tripwire and the ordinary rater decision — go through here, so the
   * banner cannot be present on one and missing on the other, which is the shape of bug that leaves
   * a halt answerable in some sessions and not others with nothing on screen to tell them apart.
   *
   * It returns a decision for the one answer that grants and throws for everything else:
   *
   * - **no callback → throw**, immediately and unchanged. §6.2's rule is that a run with nobody to
   *   ask never blocks and never times out into a grant; the way that is guaranteed is that waiting
   *   is something only a wired surface can cause.
   * - **`run-anyway` → approve, scope `once`.** Exactly one command runs. `once` is not a default
   *   restated: it is what keeps §6.1's three "never"s true. Returning here is also returning from
   *   *before* the block that records a sticky grant, so no allow-list entry and no session grant
   *   can be written on this path — the next identical call is rated again and reaches this banner
   *   again. Nothing here touches the rung, and nothing disables the rater, the escalation or the
   *   halt for anything else.
   * - **anything else → throw.** `stop`, and equally a value a surface invents or forgets to
   *   return: the grant is one exact answer and everything else is a refusal.
   */
  private async haltOrRunAnyway(
    command: string,
    reason: string,
    /** [[TUI-C27]] — this decision's record; the banner's answer is a HUMAN's answer. */
    record: ApprovalDecisionCapture,
    /**
     * [[EXT-115]] — the subject the gate decided this call on, so the halt names what it actually
     * halted rather than calling everything a `Command`. **Required, not optional**: both call
     * sites hold the decision's own subject, and the type system is what keeps a future one from
     * quietly reaching the class's hand-built fallback. Today every caller is on the shell arm —
     * §4.3 keeps the rater on the shell until [[EXT-30]] — so this changes no message that exists
     * yet; what it changes is that the halt stays correct when that arm widens.
     */
    subject: ApprovalSubject
  ): Promise<ToolApprovalDecision> {
    if (this.attackHaltCallback) {
      const answer = await this.attackHaltCallback({ command, reason });
      // [[TUI-C27]] — **recorded here, or a run-anyway is indistinguishable from a `safe`
      // rating.** The banner returns an ordinary approval, so without this line the archive would
      // show `approve` at the `rater` stage with nobody named — i.e. the rater appearing to have
      // approved a command it called an attack. That is precisely the misattribution this node
      // exists to remove, on the branch where it costs the most.
      record.humanAnswer = answer === 'run-anyway' ? 'approve' : 'reject';
      if (answer === 'run-anyway') return { type: 'approve', scope: 'once' };
    } else {
      // §6.2 — no surface wired the banner, so nobody was asked and the run ends.
      record.humanAnswer = 'no-human';
    }
    throw new AttackHaltError(command, reason, subject);
  }

  /**
   * CFG-27 — switch the session-scoped rung (`/approvals <rung>`). Idempotent; returns the NEW
   * rung so the caller can render a notice. Session-scoped only — nothing is written to config,
   * and the declared allow/deny lists are unaffected (they are config input, not session state).
   */
  public setSessionApprovalRung(rung: ApprovalRung): ApprovalRung {
    this.sessionApprovals = { ...this.sessionApprovals, rung };
    return this.sessionApprovals.rung;
  }

  /** CFG-27 — the session's current approvals posture (rung + rater profile + declared lists). */
  public getSessionApprovals(): ResolvedApprovals {
    return this.sessionApprovals;
  }

  /**
   * [[TUI-C27]] — every gated decision this session made, oldest first, for the `/debug-dump`
   * archive.
   *
   * Threaded by each surface into `writeDebugDump`, exactly as `agent.lastModelRequest` is: the
   * writer redacts it with the same pass it applies to every other artifact, and a surface that
   * does not thread it simply omits the file.
   */
  public getApprovalCaptures(): ApprovalDecisionCapture[] {
    return this.approvalCaptures.snapshot();
  }

  /**
   * CFG-26 — the allow-list sizes for the `/approvals` display: how many command prefixes the
   * human has trusted this session, and how many are persisted in the project file.
   *
   * READ-ONLY BY CONSTRUCTION: it reports the persisted count only when the store has ALREADY
   * been loaded (or persistence is on and it can be read), and never through a path that would
   * CREATE the store as a side effect of showing a display — a status command must not mutate
   * session state. `always: undefined` therefore means "not loaded / persistence off", which the
   * caller renders as `—` rather than a misleading `0`.
   */
  public getAllowlistCounts(): AllowlistCounts {
    const always = this.persistedGrantsLoaded
      ? (this.persistedGrants?.size() ?? undefined)
      : undefined;
    // EXT-71 §3 — every list MUST be inspectable, and the declared entries are in force for this
    // session exactly as the human's own grants are. They are counted alongside them rather than
    // hidden, which is what the count meant before the declared lists stopped seeding the store.
    const session = this.sessionGrants.size() + this.sessionApprovals.allow.length;
    return { session, always };
  }

  /**
   * CFG-27/[[EXT-107]] — **every refusal in force, and which of the three lists holds it**: the
   * declared `approvals.deny` entries, the escalation menu's session-scoped refusals, and the ones
   * saved to the project's deny file.
   *
   * The origins are kept apart rather than concatenated into one list of strings, because they have
   * different lifetimes and different owners and only two of the three can be lifted from here.
   * A merged list makes {@link liftRefusal} impossible to describe honestly.
   *
   * **This is the one list.** {@link liftRefusal} resolves its argument against exactly this
   * sequence, so the number a user reads and the number they type cannot name different entries.
   *
   * Numbering is 1-based, and the order is config → saved → session: the entries a user cannot lift
   * here come first and stay put, so the numbers of the ones they can are not reshuffled by a
   * config edit between two renderings.
   */
  public getRefusals(): ApprovalRefusal[] {
    return this.refusalRecords().map((held, position) => ({
      index: position + 1,
      description: describeApprovalEntry(held.entry),
      origin: held.origin,
      ...(held.recordedAt !== undefined ? { recordedAt: held.recordedAt } : {}),
    }));
  }

  /**
   * [[EXT-107]] — the refusals in force with their entries attached, which is what
   * {@link liftRefusal} needs and {@link getRefusals} renders. ONE builder, so the displayed order
   * and the removal order are the same order by construction rather than by two functions agreeing.
   *
   * A saved refusal is held in both runtime stores ({@link recordDenial} writes both), so the
   * session list is filtered against the saved one by entry identity — the same de-duplication
   * {@link getGrants} does. A configured entry is NOT de-duplicated against them: it is a different
   * thing with a different owner, and hiding it would let a lift report success while the config
   * line went on refusing the call.
   */
  private refusalRecords(): {
    entry: ApprovalEntry;
    origin: ApprovalRefusalOrigin;
    recordedAt?: string;
  }[] {
    const saved = this.getPersistedDenials()?.list() ?? [];
    const savedKeys = new Set(saved.map((grant) => renderApprovalEntryObject(grant.entry)));
    return [
      ...this.sessionApprovals.deny.map((entry) => ({ entry, origin: 'config' as const })),
      ...saved.map((grant) => ({
        entry: grant.entry,
        origin: 'persisted' as const,
        recordedAt: grant.grantedAt,
      })),
      ...this.denyGrants
        .list()
        .filter((grant) => !savedKeys.has(renderApprovalEntryObject(grant.entry)))
        .map((grant) => ({
          entry: grant.entry,
          origin: 'session' as const,
          recordedAt: grant.grantedAt,
        })),
    ];
  }

  /**
   * [[EXT-107]] — **lift one refusal**, by its number in {@link getRefusals}. The escape hatch, and
   * the reason persisting a refusal is safe to ship: a saved refusal the user cannot find or undo
   * is a trap, and the person who hits it first is whoever pressed `[d]` by reflex and needed the
   * command an hour later. Telling them to delete a file they have not been told exists is not an
   * answer.
   *
   * A saved refusal is removed from the file AND from the in-memory store, because it is in both —
   * dropping only the file would leave the call refused for the rest of the session by a rule the
   * display no longer shows.
   *
   * **A configured entry is reported, never removed.** `approvals.deny` is something the user
   * wrote; rewriting their config file out from under them is not a thing a session command may do,
   * and silently no-oping would be worse. They are told where it lives.
   *
   * **`stillSaved` is the deletion that did not reach disk** ([[EXT-149]]). The file rewrite can
   * fail after the in-memory removal has succeeded — a checkout that is not writable, a settings
   * directory that has gone — and the entry then comes back in the next session. The store now
   * answers that question ({@link PersistedApprovalGrants.remove}) instead of reporting every
   * removal as landed, so the notice can stop promising *it will not come back*.
   */
  public liftRefusal(index: number): ApprovalRefusalLift {
    const held = this.refusalRecords();
    const target = held[index - 1];
    if (!target || !Number.isInteger(index)) {
      return { outcome: 'unknown', index, count: held.length };
    }
    const description = describeApprovalEntry(target.entry);
    if (target.origin === 'config') return { outcome: 'configured', description };
    this.denyGrants.remove(target.entry);
    const removedFromFile =
      target.origin === 'persisted'
        ? (this.getPersistedDenials()?.remove(target.entry) ?? false)
        : false;
    const key = renderApprovalEntryObject(target.entry);
    return {
      outcome: 'lifted',
      description,
      origin: target.origin,
      // A session refusal was never in a file, so there is nothing left there — the flag is about
      // the file keeping an entry the user was told had gone, and only a saved one can.
      stillSaved: target.origin === 'persisted' && !removedFromFile,
      // The other half of not de-duplicating config entries above: a call refused by BOTH a saved
      // entry and a config line is still refused after this, and a notice that did not say so would
      // report a lift the gate did not perform.
      stillConfigured: this.sessionApprovals.deny.some(
        (entry) => renderApprovalEntryObject(entry) === key
      ),
    };
  }

  /**
   * §3/§4.7.4 — **the grants themselves**, for an approvals view that shows *what* was granted,
   * *when*, and *under which effective annotations*. The counterpart of {@link getAllowlistCounts},
   * which answers only how many.
   *
   * The declared config lists are deliberately NOT here. They are something a human wrote and
   * reviewed, they carry no `grantedAt` and no scope, and `getAllowlistCounts` already counts them
   * alongside these; mixing them in would present a config line as something the session granted.
   *
   * **Read-only in both senses.** It never loads the persisted store — same rule as
   * {@link getAllowlistCounts}: a display must not create the store in order to show it, so a
   * session that has not yet needed the file lists its session grants alone. And every grant is
   * **deep-copied on the way out**, because the stores hand back their live records: the copy on the
   * way in is what makes a snapshot private to its grant, and handing the same object to a renderer
   * would put what the gate matches against one property assignment away from any consumer.
   */
  public getGrants(): ApprovalGrant[] {
    const held = [
      ...this.sessionGrants.list(),
      ...(this.persistedGrantsLoaded ? (this.persistedGrants?.list() ?? []) : []),
    ];
    const seen = new Set<string>();
    const grants: ApprovalGrant[] = [];
    for (const grant of held) {
      // An `always` grant is written to BOTH stores, so identity de-duplication is what keeps it
      // from being displayed twice. The same question `ApprovalGrantStore.add` asks.
      const key = renderApprovalEntryObject(grant.entry);
      if (seen.has(key)) continue;
      seen.add(key);
      grants.push({
        ...grant,
        entry: copyApprovalEntry(grant.entry),
        ...(grant.annotations ? { annotations: { ...grant.annotations } } : {}),
      });
    }
    return grants;
  }

  /**
   * §4.7.1 — **which of each server's annotation hints this session believes**, for display.
   *
   * Every key either side names is listed: a configured `mcpServers` key with no policy of its own
   * (which resolves through `defaults`), and a policy key naming a server the config does not have
   * (which is what a typo looks like). Resolution is {@link trustedAnnotationHints}, the same
   * function the gate derives effective annotations through, so the display cannot claim a
   * relationship the gate does not act on.
   */
  public getMcpAnnotationTrust(): McpAnnotationTrustView {
    const mcp = this.sessionApprovals.mcp;
    const configured = new Set(this.configuredMcpServerKeys());
    const named = Object.keys(mcp?.servers ?? {});
    const keys = [...new Set([...configured, ...named])];
    return {
      defaults: [...(mcp?.defaults?.trustAnnotations ?? [])],
      servers: keys.map((server) => ({
        server,
        trusted: [...trustedAnnotationHints(mcp, server)],
        configured: configured.has(server),
      })),
    };
  }

  /**
   * §4.7.1 — **believe, or stop believing, specific hints from one server**, for the life of this
   * session. The runtime half of `approvals.mcp.servers.<key>.trustAnnotations` (§9), so a user can
   * do from the TUI what they can do in config.
   *
   * **Per hint, never per server.** `hints` names the hints this call moves and leaves every other
   * hint of that server's exactly as it was, because believing a server's `readOnlyHint` while
   * disbelieving its `openWorldHint` is a coherent position and the common one. A "trust this
   * server" flag is the design §4.7.1 rejects.
   *
   * **The previous set is what was IN FORCE, resolved through `defaults`.** A server not named
   * under `servers` inherits `defaults`, and naming it makes it state its relationship in full (§9)
   * — so seeding from the empty set would mean that believing one more hint silently withdrew every
   * hint `defaults` had granted, which is a weakening the user did not ask for and would invalidate
   * their grants.
   *
   * **Session-scoped only.** Nothing is written to config: the declared block is read-only input
   * (§9.1), exactly as the rung is.
   *
   * A trusted external annotation still never grants more than the same annotation grants one of
   * our own built-ins — that holds in `core/approvals/annotations.ts` by construction, and this
   * changes only which hints are read.
   */
  public setMcpAnnotationTrust(
    server: string,
    hints: readonly ToolAnnotationHint[],
    believe: boolean
  ): McpAnnotationTrustChange {
    const mcp = this.sessionApprovals.mcp;
    const before = trustedAnnotationHints(mcp, server);
    const requested = new Set(hints);
    const after = believe
      ? TOOL_ANNOTATION_HINTS.filter((hint) => before.includes(hint) || requested.has(hint))
      : TOOL_ANNOTATION_HINTS.filter((hint) => before.includes(hint) && !requested.has(hint));
    const added = after.filter((hint) => !before.includes(hint));
    const removed = before.filter((hint) => !after.includes(hint));

    const nextMcp: McpApprovalsConfig = {
      ...mcp,
      servers: {
        ...mcp?.servers,
        [server]: { ...mcp?.servers?.[server], trustAnnotations: after },
      },
    };
    // A fresh posture object, and fresh nested ones above: the resolved posture may share its `mcp`
    // block with the loaded config, and a session change must not rewrite what the user configured.
    this.sessionApprovals = { ...this.sessionApprovals, mcp: nextMcp };

    return {
      server,
      configured: this.configuredMcpServerKeys().includes(server),
      trusted: [...after],
      added,
      removed,
      weakening: removed.filter(trustWithdrawalWeakens),
      invalidates: this.grantsWeakenedByCurrentTrust(server),
    };
  }

  /**
   * §4.7.4 — which of this server's saved approvals the trust now in force weakens, for the notice
   * that reports a trust change. **It predicts; it never removes.** The removal stays where Task
   * 4 put it — at the call being decided — because that is the only moment the tool's declaration
   * can be read for certain; here a server that is merely offline declares nothing and would read
   * as having weakened everything.
   *
   * It compares through the same two functions the gate does: the effective-annotation source built
   * from the posture as it stands *after* the change, and `annotationWeakenings`. A second
   * comparison written for the display is how a warning comes to describe a rule the gate does not
   * have.
   */
  private grantsWeakenedByCurrentTrust(server: string): string[] {
    const source = this.effectiveToolAnnotationSource();
    return this.getGrants()
      .filter(
        (
          grant
        ): grant is ApprovalGrant & {
          entry: McpToolApprovalEntry & { pattern: string };
          annotations: EffectiveToolAnnotations;
        } =>
          grant.entry.type === 'mcpTool' &&
          grant.entry.server === server &&
          typeof grant.entry.pattern === 'string' &&
          grant.annotations !== undefined
      )
      .filter((grant) => {
        // `EffectiveToolAnnotationSource` admits `undefined` for a source that genuinely cannot
        // answer; `createEffectiveToolAnnotationSource` never returns it — a tool nothing has
        // declared for resolves to the fail-closed constant, which for a grant made under anything
        // softer reads as a weakening. The guard is therefore a type-level obligation and not a
        // live branch: it discharges the union the contract declares, and nothing reaches it.
        const current = source({
          kind: 'mcpTool',
          server,
          name: grant.entry.pattern,
          ...(grant.entry.host !== undefined ? { host: grant.entry.host } : {}),
        });
        return current !== undefined && annotationWeakenings(grant.annotations, current).length > 0;
      })
      .map((grant) => describeApprovalEntry(grant.entry));
  }

  /**
   * Init is split into a separate method. This may create a number of connections,
   * and we'd better have an instance by that moment, for the case things will go wrong,
   * so we can wrap init into try-catch and then call {@link #cleanup} within finally.
   */
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointSaver?: BaseCheckpointSaver | undefined,
    options?: GthAgentRunnerInitOptions
  ): Promise<void> {
    this.config = configIn;
    this.command = command;

    // GS2-48 — register the effective config with the crash handler so an uncaughtException /
    // unhandledRejection mid-run captures it in the (redacted) snapshot. Pure data hand-off; no
    // behaviour change.
    updateCrashContext({ config: configIn, modelDisplayName: configIn.modelDisplayName });

    // TUI-C32 residual a — register the live config with the shared tool-display redactor so its
    // secret-literal collection walks INLINE config secrets (a pasted `apiKey`/`token` value), not
    // only env-derived ones. Both surfaces (plain observer + Ink TUI) render through this module.
    setToolDisplayConfig(configIn);

    // CFG-27 — seed the session posture from config, so a config that pre-selects `bypass` starts
    // there while the shell tool stays gated (see `resolveShellApprovalGate`) and therefore
    // remains switchable (`/approvals write`). Resolved per-command, mirroring where the shell
    // tool is actually emitted; no effect where the tool is ungated.
    this.sessionApprovals = resolveApprovals(configIn, command);

    // [[EXT-106]] §4.6 — **whose words this session's human messages are.** The provenance carve-out
    // reads the retained human turns as *"the user's own verbatim words"*, and on `review` and `pr`
    // they are nothing of the kind: the product itself fetched the diff and the PR description and
    // then framed them as a human message, and the review prompt tells the agent to EXAMINE that
    // content. Material under examination is not the voice of the person who asked for the
    // examination, so admitting it would make the product contradict itself about identical input.
    //
    // **Decided from the VERB and never from anything inside a message.** Those bytes are
    // attacker-controlled, so a marker in them can be forged by the text it is meant to classify;
    // out-of-band metadata is the only admissible key. `owningCommand` is the fallback because a
    // command-less helper agent — the `gth pr` discovery run — must be classified by the verb it
    // serves rather than by the absence of one. Both the predicate and the window's own default
    // fail closed, so a driver nobody has classified floors exactly as it did before the carve-out.
    this.negotiation.admitUserProvenance(
      commandCarriesUserProvenance(command ?? options?.owningCommand)
    );

    // §3/§9.1 — the DECLARED lists are read-only config input, consulted through the EXT-71 rule
    // matcher (`core/approvals/matcher.ts`) and NEVER copied into the runtime stores, which hold
    // only what the escalation menu grants at run time. Both are handed to the same matcher, so
    // there is one grammar and one comparison, not a config path and a runtime path.
    this.denyGrants = new ApprovalGrantStore();

    // CFG-26 — resolve the rater's own model when a profile is named, so the documented mitigation
    // for a weak model ("point approvals.rater at a stronger one") actually takes effect.
    //
    // EAGERLY, here, rather than lazily at first use: `initConfig` re-runs discovery and prints
    // "Activating profile: …", which mid-turn would write raw over the Ink TUI's managed frame,
    // and a broken profile should fail at startup rather than three turns in. It deliberately does
    // NOT catch — a named-but-unusable rater profile is an error, never a silent fallback to the
    // session model (GS2-62).
    //
    // Loaded whenever a profile is NAMED, without a second "will the rater actually run?" gate:
    // naming a rater profile at an unrated rung is a config the user can hold (they may switch to
    // `assisted` mid-session with `/approvals`), and a broken profile should still fail loudly at
    // startup rather than at the moment they switch.
    const raterProfile = this.sessionApprovals.rater;
    this.raterModel = raterProfile
      ? await resolveRaterModel(raterProfile, 'approvals.rater')
      : undefined;

    // [[EXT-127]] — and the same for the alignment checker, which is a second model with a second
    // profile. `resolveApprovals` has already defaulted the key to the rater's profile, so the
    // common case resolves the SAME name twice rather than branching here: two loads of one profile
    // at startup is cheaper than a shortcut that would silently stop working the moment the two
    // names differ, which is the configuration the key exists for.
    const checkerProfile = this.sessionApprovals.alignmentChecker;
    this.alignmentCheckerModel = checkerProfile
      ? await resolveRaterModel(checkerProfile, 'approvals.alignmentChecker')
      : undefined;

    // Initialize debug logging
    initDebugLogging(configIn.debugLog ?? false);
    debugLog(`Initializing GthAgentRunner with command: ${command || 'default'}`);

    this.runConfig = getNewRunnableConfig();
    // GS2-20 — drive a caller-supplied thread when there is one, so the durable checkpointer writes
    // under the id the session has already recorded against its conversation (and, on a resume,
    // reads back the state stored there). Overlaid on the minted config rather than replacing it, so
    // the recursion limit and anything else `getNewRunnableConfig` sets survive.
    if (options?.threadId) {
      this.runConfig = {
        ...this.runConfig,
        configurable: { ...this.runConfig.configurable, thread_id: options.threadId },
      };
    }

    debugLogObject('Runnable Config', this.runConfig);

    this.warnIfSubagentsCannotBeHonored(configIn, command ?? options?.owningCommand);

    this.agent = this.agentFactory(this.statusUpdate, this.resolvers);

    // Initialize the agent
    debugLog('Initializing agent...');
    await this.agent.init(command, configIn, checkpointSaver, {
      displayCommand: options?.displayCommand,
    });

    debugLog('Agent initialization complete');
  }

  /**
   * EXT-114 — `subagents` is configurable but not yet dispatched, and a run that declares them must
   * say so rather than start with a quietly smaller toolset than the config describes.
   *
   * The `task` tool that spawned them belonged to the deepagents runtime, which is gone; the lean
   * primitive that replaces it is GS2-25. Until then a declared subagent is inert. Keeping the key
   * valid is deliberate — a config written for GS2-25 should not have to be un-written and
   * re-written — but inert-and-silent is the failure this notice exists to prevent: the parent
   * simply does the work itself, on the parent's model, and the only visible symptom is the bill.
   *
   * Fires on EVERY run rather than only where a backend could once have honoured it, because there
   * is no longer any run that can.
   */
  private warnIfSubagentsCannotBeHonored(config: GthConfig, command: GthCommand | undefined): void {
    if (!config.subagents || config.subagents.length === 0) {
      return;
    }
    const scope = command ? `the ${command} command` : 'this run';
    const names = config.subagents.map((spec) => spec.name).join(', ');
    this.statusUpdate(
      StatusLevel.WARNING,
      `Config declares subagents (${names}), but no agent backend dispatches subagents yet, so ` +
        `${scope} runs without them. See ` +
        SUBAGENTS_DOCS_URL
    );
  }

  /**
   * processMessages deals with both streaming and non-streaming approaches.
   */
  async processMessages(messages: Message[]): Promise<string> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }

    // GS2-16: start this turn's analytics tally from zero (the runner is reused across turns).
    this.resetRunStats();
    // [[EXT-159]] — the previous turn's termination reason goes with the previous turn's tally.
    this.resetTerminationReason();
    // GS2-48 — record this turn's transcript tail for the crash handler.
    updateCrashContext({ transcriptTail: messages.slice(-CRASH_TRANSCRIPT_TAIL_MESSAGES) });
    // [[EXT-29]] §5 — a new user turn is the human being reached, so it ends any negotiation still
    // standing from the previous one and clears BOTH bounds. The turn's own messages then enter
    // §5.1's last-5 window, which is what makes "just the last two" reach the rater at all — the
    // reply that narrows what the agent proposes is worthless to the gate if only the agent hears it.
    this.endNegotiation();
    // [[TUI-C69]] §5.4 — and the tone hints go with it. The ids matter only while the results
    // carrying them are on screen; the previous turn's are spent, and an id that outlived its turn
    // could only ever mis-tone a later row.
    this.clearRaterClarifications();
    this.negotiation.noteUserMessages(humanMessageTexts(messages));

    debugLog('Processing messages...');
    debugLogObject('Input Messages', messages);

    return this.runTurn(messages, 0);
  }

  /**
   * The turn itself, separated from the per-turn bookkeeping above so [[EXT-160]] can run it twice.
   *
   * `attempt` is 0 for the turn the user asked for and 1 for the single retry that follows a
   * compaction; nothing else calls this. The retry passes an EMPTY message list, because the user's
   * message is already in the graph's state — the input step commits before the model step throws
   * (measured), so re-sending it would append a second copy of the same turn.
   *
   * The preamble is deliberately NOT repeated on the retry: resetting the analytics tally, ending
   * the negotiation and re-recording the crash transcript are things a NEW user turn does, and a
   * retry is the same turn being attempted again.
   */
  private async runTurn(messages: Message[], attempt: number): Promise<string> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    this.turnsInFlight++;
    try {
      // Decision: Use streaming or non-streaming based on config
      if (this.config.streamOutput) {
        // Use streaming
        debugLog('Using streaming mode');
        const stream = await this.agent.stream(messages, this.runConfig);
        let result = '';
        try {
          result = await this.drainTextStream(stream);
          // A run may suspend on one or more tool-approval interrupts (run_shell_command).
          // Resolve them in a loop: each resume can itself suspend again on the next gated
          // tool call, so keep going until the graph completes with no pending interrupts.
          result += await this.resolveToolInterrupts();
        } catch (streamError) {
          // CFG-27 — an approvals STOP is not a stream failure: it is the gate deliberately
          // ending the run, and its message IS the explanation the spec requires it to carry.
          // Re-thrown unchanged (the outer catch does the same) so nothing buries it.
          if (streamError instanceof ApprovalStopError) {
            this.noteApprovalStop('runner.stream-approval-stop', streamError);
            throw streamError;
          }
          // Handle streaming-specific errors
          debugLogError('Stream processing', streamError);
          // [[EXT-159]] — classify the ORIGINAL error, not the wrapper built from it: the wrapper's
          // message is where the diagnosis was being thrown away. The one reason is attached to the
          // wrapper as well, so a catcher that only ever sees the re-thrown error still reads it.
          const reason = this.classifyThrownAt('runner.stream-error', streamError);
          throw attachTerminationReason(
            new Error(
              `Stream processing failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`
            ),
            reason
          );
        }
        debugLog(`Stream completed. Total response length: ${result.length}`);
        // EXT-37: a content-policy refusal (OpenAI content_filter / Anthropic stop_reason=refusal /
        // Bedrock guardrail_intervened) is detected one layer down in GthAbstractAgent — the only
        // place a message's response_metadata is visible — and surfaced there as a clear, non-empty
        // terminal answer. That non-empty result intentionally bypasses this empty-response retry:
        // a refusal is deterministic, so re-invoking the SAME model would only burn a paid call and
        // fail identically. Only a genuinely empty turn reaches the retry below.
        //
        // Fallback-model EXTENSION POINT: hermes tries a *different* model once on refusal (a
        // different model may not refuse). gaunt-sloth has no runtime fallback-model config today
        // (`getCuratedFallbackModel` is init-time per-provider defaulting, not runtime failover), so
        // per YAGNI none is built. When such a config is added, the one-shot fallback belongs where
        // the refusal is detected (GthAbstractAgent.surfaceRefusal): try the fallback model ONCE
        // before surfacing, and never retry the same model.
        // GS2-72: the GS2-36 retry-budget's terminal notice — injected via a jumpTo:'end' STATE
        // update on the lean createAgent graph — is streamed as an AIMessage chunk under
        // streamMode:'messages' (verified on langchain 1.5.x), so it already arrives as a NON-empty
        // `result` above and does NOT reach this fallback. Only a genuinely empty model turn falls
        // through here, where the single retry invoke is the intended recovery. (If a future
        // langchain stops streaming jumpTo-injected messages, the budget notice would drain empty
        // and hit this fallback; GthAbstractAgentTerminalNotice.spec pins the current behaviour.)
        if (result.trim().length === 0) {
          debugLog('Stream produced empty response, retrying once with non-streaming invoke.');
          const fallback = await this.agent.invoke(messages, this.runConfig);
          debugLog(`Fallback non-stream response length: ${fallback.length}`);
          if (fallback.trim().length === 0) {
            // [[EXT-159]] — the retry has already been spent here, so this is the terminal empty
            // turn rather than the first one.
            const reason = terminationReason(
              'runner.empty-after-fallback',
              'control',
              'empty_response'
            );
            this.noteTermination(reason);
            throw attachTerminationReason(
              new Error(
                'Model returned an empty response after tool execution. Try again or switch to a more stable model.'
              ),
              reason
            );
          }
          this.noteCompleted('runner.completed');
          return fallback;
        }
        this.noteCompleted('runner.completed');
        return result;
      } else {
        // Use non-streaming
        debugLog('Using non-streaming mode');
        let result = await this.agent.invoke(messages, this.runConfig);
        // EXT-52 — the SAME interrupt drain the streaming branch does above. A gated
        // `run_shell_command` suspends the graph, so `invoke` returns with the tool-calling
        // AIMessage (empty content) as the last message and the command not yet run. Draining here
        // — BEFORE the empty-response check — is what makes the approval prompt fire and the
        // approved command's output reach the caller on `streamOutput: false`; without it the turn
        // died with the misleading empty-response error, so the check may only see a genuinely
        // empty turn.
        result += await this.resolveToolInterrupts();
        debugLog(`Non-stream response length: ${result.length}`);
        if (result.trim().length === 0) {
          // [[EXT-159]] — the non-streaming path has no retry to spend, so an empty turn is
          // terminal here at once.
          const reason = terminationReason('runner.empty-invoke', 'control', 'empty_response');
          this.noteTermination(reason);
          throw attachTerminationReason(
            new Error(
              'Model returned an empty response. Try again or switch to a more stable model.'
            ),
            reason
          );
        }
        this.noteCompleted('runner.completed');
        return result;
      }
    } catch (error) {
      // CFG-27 §4.2/§6.2 — an approvals STOP is not an agent failure and must reach the user with
      // its own words: the command, the rating and its reason are the whole point of it. Wrapping
      // it as "Agent processing failed: …" would bury the explanation the spec requires it to
      // carry, so it is re-thrown unchanged.
      if (error instanceof ApprovalStopError) {
        this.noteApprovalStop('runner.turn-approval-stop', error);
        throw error;
      }
      // [[EXT-160]] — **the reactive seam: catch, classify, compact, retry once.**
      //
      // Here rather than in the streaming branch's inner `catch` because BOTH paths reach this one
      // and only one of them has an inner catch — and because the streaming path does not always
      // use it: an overflow raised while the stream is being CREATED (`await this.agent.stream(…)`,
      // above the inner `try`) lands here too, which is exactly what the local measurement showed.
      // One seam, both paths, once each.
      const retryAfterCompaction = await this.handleContextOverflow(error, attempt);
      if (retryAfterCompaction) {
        const answer = await this.runTurn([], attempt + 1);
        return answer;
      }
      // Handle agent invocation errors
      debugLogError('Agent processing', error);
      // [[EXT-159]] — the OUTER of two nested wrappers. On the streaming path the inner one has
      // already classified this same failure and re-thrown, so `noteTermination`'s first-write-wins
      // keeps the inner, truer site; on the non-streaming path this is the only classification
      // there is. Both are reachable, so both classify.
      const reason = this.classifyThrownAt('runner.turn-error', error);
      const originalMessage = error instanceof Error ? error.message : String(error);
      const enhancedMessage = enhanceVertexUnauthorizedMessage(originalMessage, this.config?.llm);
      throw attachTerminationReason(
        new Error(
          `Agent processing failed: ${enhancedMessage}`,
          error instanceof Error ? { cause: error } : undefined
        ),
        reason
      );
    } finally {
      // [[TUI-C69]] §5.4 — the turn is over, so the argument is over. The reasoning is the same as
      // in {@link processMessagesWithEvents}; it is here too so the seam is a property of *ending a
      // turn* rather than of the event path, and a string-path surface that grows an `end` is not
      // the one place the panel outlives its turn. Display-only, and a no-op on today's readline
      // surface, which appends to scrollback and implements no `end`.
      this.clearNegotiationDisplay();
      this.turnsInFlight--;
    }
  }

  /**
   * Accumulate a text stream into a single string. Extracted so {@link processMessages} and
   * the interrupt-resume loop ({@link resolveToolInterrupts}) drain streams identically.
   */
  private async drainTextStream(stream: AsyncIterable<string>): Promise<string> {
    let result = '';
    for await (const chunk of stream) {
      debugLogObject('Stream chunk', chunk);
      result += chunk;
    }
    return result;
  }

  /**
   * After a streamed run ends, resolve any tool-approval interrupts it suspended on. For each
   * pending tool call the {@link toolApprovalCallback} is consulted (defaulting to REJECT when
   * no handler is wired, so a non-interactive run never hangs or auto-approves); the collected
   * decisions are then sent back via the agent's `streamResume` as a LangChain HITL resume
   * (`{ decisions }`). Because a resumed run can suspend again on the next gated tool call, this
   * loops until the graph completes with no pending interrupts. Returns the concatenated text
   * streamed across all resume turns (empty when nothing was resumed).
   *
   * No-ops (returns '') when the agent does not support interrupts (`getPendingToolInterrupts`/
   * `streamResume` absent) — that is the only exemption. As of EXT-52 the shipped agent gates
   * `run_shell_command` and exposes the interrupt surface, so the lean agent is exactly the agent
   * this loop serves; only an agent implementation without those methods (e.g. a test double)
   * skips it.
   */
  private async resolveToolInterrupts(): Promise<string> {
    const agent = this.agent;
    const runConfig = this.runConfig;
    if (!agent || !runConfig) return '';
    if (!agent.getPendingToolInterrupts || !agent.streamResume) return '';

    let resumedText = '';
    // [[EXT-159]] — which way the loop left decides what ended the turn, and only the loop knows.
    // Falling out of the bound and draining cleanly are different endings; a caller sees the same
    // returned string either way, so a caller cannot tell them apart.
    let drained = false;
    // Bound the loop defensively so a misbehaving graph that re-suspends forever cannot spin.
    for (let guard = 0; guard < 100; guard++) {
      const pending = await agent.getPendingToolInterrupts(runConfig);
      if (pending.length === 0) {
        drained = true;
        break;
      }

      const decisions: ToolApprovalDecision[] = [];
      for (const tool of pending) {
        decisions.push(await this.decideToolApproval(tool));
      }

      const stream = await agent.streamResume({ decisions }, runConfig);
      resumedText += await this.drainTextStream(stream);
    }
    // [[EXT-159]] — the runtime gave up, and the turn ends here because of that. It still returns
    // into `processMessages`, which then reports an ordinary completion (or an empty turn) at its
    // own site — so routing to an enumerated site is no defence: that site would state a category
    // that is affirmatively false. Noting it HERE, before those sites run, is what makes
    // first-write-wins keep the one fact they cannot see.
    if (!drained) {
      this.noteTermination(
        terminationReason('runner.interrupt-guard-exhausted', 'control', 'interrupt_drain_guard')
      );
    }
    return resumedText;
  }

  /**
   * EXT-71 §3.1/§3.2, EXT-70 §4.7.5 — the subject a pending tool call presents to the rule matcher.
   *
   * A gated `run_shell_command` is a **shell** subject and nothing else: it is matched by `shell`
   * entries, against the command. It is deliberately NOT also offered as a `tool` subject named
   * `run_shell_command`, which would create a second allow path to every shell command carrying a
   * different §3.2 `rate` default and a match that never saw the command it was approving.
   *
   * **Everything else splits by provenance**, which is the distinction §4.7.1 rests on: `tool` is
   * the TRUSTED provenance, read verbatim, so an MCP tool arriving as one would be asking the
   * trusted path for a third party's annotations — a gate any server can opt itself out of. Every
   * MCP-namespaced name therefore becomes an `mcpTool` subject carrying the user's own `mcpServers`
   * key, and one whose server cannot be resolved stays an `mcpTool` subject under an unnameable
   * server rather than falling back to `tool` (see `approvalSubjectForToolName`).
   *
   * **The host (§4.7.4)** is attached here, so the one subject the whole decision runs on carries
   * it: the rule matcher treats a `host` on an entry as an additional exact-match condition, and a
   * grant the menu writes records it. A call naming no single host has none, which fails toward a
   * prompt at both sites.
   *
   * Widening which tools the gate actually suspends on is still [[EXT-30]]; this decides what a
   * suspended call *is* whenever one arrives.
   *
   * @param hosts Every distinct host the call's arguments name ({@link toolCallHosts}).
   */
  private approvalSubjectFor(
    tool: PendingToolInterrupt,
    command: string | null,
    hosts: readonly string[]
  ): ApprovalSubject {
    if (tool.name === SHELL_TOOL_NAME && command !== null) return { kind: 'shell', command };
    const subject = approvalSubjectForToolName(tool.name, this.configuredMcpServerKeys());
    return hosts.length === 1 ? { ...subject, host: hosts[0] } : subject;
  }

  /**
   * §4.7.5 — the user's own `mcpServers` keys, the only identity a server has here. Own enumerable
   * keys via `Object.keys`, so nothing inherited can pose as a configured server.
   */
  private configuredMcpServerKeys(): string[] {
    const servers = this.config?.mcpServers;
    return servers && typeof servers === 'object' ? Object.keys(servers) : [];
  }

  /**
   * EXT-70 §4.7.1 — the source a `hint` entry reads a call's EFFECTIVE annotations through, built
   * from the session's `approvals.mcp` block and the two declared-annotation lookups.
   *
   * Built per decision rather than cached at {@link init}, for two reasons that both bite: the
   * agent registers its tools *inside* `agent.init()`, so an init-time snapshot would be empty; and
   * a re-init re-resolves the tool list, which for MCP may hand back different declarations.
   *
   * The two lookups are deliberately different in kind. `builtIn` reads OUR OWN authored table and
   * never the bound tool list — the bound list contains every server's tools, and a `builtIn`
   * lookup over it would read a third party's declaration through the trusted-verbatim path.
   * `mcp` reads what the servers declared, keyed by the registered tool name so the server key is
   * never split apart and re-joined differently.
   */
  private effectiveToolAnnotationSource(): EffectiveToolAnnotationSource {
    return createEffectiveToolAnnotationSource({
      mcp: this.sessionApprovals.mcp,
      declared: {
        builtIn: builtInToolAnnotations,
        mcp: mcpDeclaredAnnotationLookup(this.agent?.getDeclaredMcpToolAnnotations?.()),
      },
    });
  }

  /**
   * Decide a single pending tool call. Spec order — **deny → bypass → escalate → allow → rater →
   * human prompt**, with the hardline floor at exec time regardless. The two adjacencies that carry
   * the design are that deny comes BEFORE `bypass` and escalate comes AFTER it:
   *
   * 1. **deny** (§3) — a declared entry or a runtime *always reject* grant is refused with no
   *    prompt and no rating call. It is consulted FIRST, and it is the one
   *    check that **still applies under `bypass`**: choosing `bypass` says *"stop asking me"*, not
   *    *"forget what I told you never to do"*. A deny entry MAY match a compound command, because a
   *    prohibition that catches something unresolvable errs in the direction that costs nothing.
   * 2. **`bypass`** — the gate is off for this session; approve at scope `once`.
   * 3. **escalate** (§3.2) — a declared entry always asks the human, whatever the rung would have
   *    done, **including outranking the automatic grants of `manual` and `write`** and any allow
   *    entry that also matched. It goes straight to the human with **no rating call**, and it never
   *    enters the `auto` negotiation. It is **inert at `bypass`**, which is why it sits below
   *    the rung check: the rung chosen for this session wins, and a stop that must survive `bypass`
   *    is a deny entry and only that.
   * 4. **allow** (§3, §3.2) — a declared entry or a grant the human made at an earlier prompt this
   *    session (or persisted), matched against the whole normalized command and only when that
   *    command statically resolves. An allow match settles the human's part: no prompt. Whether the rater
   *    still reviews the call is the entry's own `rate` (§3.2) — honored at the rater rungs and
   *    inert at the deterministic ones, so no entry can smuggle a model call into `manual` or
   *    `write` — and a rated allow match is a TRIPWIRE, not a re-adjudication
   *    ({@link mapAllowMatchedVerdictToAction}).
   * 5. **auto-rater** (`assisted` / `auto` only) — `safe` approves, `destructive` and
   *    `catastrophic` escalate, and `attack` HALTS the run ({@link AttackHaltError}). The other
   *    three rungs consult no model at all. A command whose target the gate cannot statically
   *    resolve is rated **exactly like any other** ([[EXT-81]]), with a neutral note in the rating
   *    prompt naming the shape the parser saw. It used to skip the call and be refused straight
   *    back to the model instead; §6.1's rule is that a deterministic layer fires only where it is
   *    confident something is a threat, and a parser reporting it could not read a string has
   *    detected nothing. At those same two rungs a **tool**
   *    call is instead floored deterministically by §4.7.3's open-world rule
   *    ({@link openWorldToolFloorReason} into {@link applyDestructiveFloor} — the one floor the
   *    shell path also reaches): a call whose effective `openWorldHint` is true is `destructive`,
   *    whatever its `readOnlyHint` says.
   * 6. **human prompt** — the approval callback; when the human grants `session`/`always` scope,
   *    **that command** is recorded as an `exact` entry (§3.1/§6 — the menu never widens), so the
   *    same command stops re-prompting and a longer variant of it still asks.
   *
   * §6.2 — where no human can answer (CI, a one-shot run, a server), an escalation is **not** a
   * rejection handed back to the model: it is an immediate non-zero exit
   * ({@link NonInteractiveEscalationError}) carrying the command, the rating and its reason. No
   * prompt, no waiting, and never a timeout into approval. Declaring commands in `approvals.allow`
   * is the supported way to make a pipeline pass.
   *
   * Hardline catastrophic commands remain refused at exec time regardless of any approval here
   * (defense in depth in `GthDevToolkit.executeCommand`), so an allow-listed `rm -rf /` still
   * cannot run.
   *
   * **Step 0 is the rung.** The agent wires the interrupt over every tool ANY rung could gate,
   * because the graph is built once and `/approvals <rung>` moves the rung under it for the rest of
   * the session. So a call arriving here has not yet been judged against the rung in force: this is
   * where that happens, on `sessionApprovals.rung`, which a mid-session switch has already updated.
   * A call the live rung does not gate is approved on the spot — no rule matching, no rating, no
   * prompt — which is what keeps `assisted`, `auto` and `bypass` behaving exactly as they did
   * when the interrupt held the shell alone. It sits ABOVE the deny check for the same reason: an
   * ungated call never reached this method at all before, so a deny entry could not fire on one, and
   * a security fix for two rungs is not the place to change that. (The shell is gated at every rung
   * whenever the shell gate is on, so §2.5's rule that the deny list survives `bypass` is untouched.)
   */
  private async decideToolApproval(tool: PendingToolInterrupt): Promise<ToolApprovalDecision> {
    // [[TUI-C27]] — the record is opened (and already in the log) BEFORE the decision runs, and
    // filled in as it goes. Assembling it at the end would lose the calls most worth keeping: an
    // `attack` verdict throws `AttackHaltError` out of the decision, so a halted run would carry no
    // record of the rating that halted it — and an approval, which relays nothing to anyone, is
    // exactly the branch that used to leave no trace at all.
    const record = this.approvalCaptures.begin({
      at: new Date().toISOString(),
      tool: tool.name,
      ...(typeof tool.args?.command === 'string' ? { command: tool.args.command } : {}),
      rung: this.sessionApprovals.rung,
      budget: this.negotiation.counters(),
    });
    const decision = await this.recordedDecision(tool, record);
    // [[EXT-29]] §5.3 — **the reset, at the one site that sees every approval.** "A successful
    // intervening tool call — the agent going away to gather information and returning better
    // informed — resets [the count], because that is progress, not ping-pong." Every way a call can
    // be let through arrives here: the rung not gating it, an allow entry, the §3.2 tripwire, a
    // `safe` rating, the human saying yes. Wrapping is what makes that exhaustive — an approval
    // added below cannot forget to reset, and the alternative (a call at each of the six `approve`
    // returns) is a §5.3 hole that is invisible the day it opens.
    //
    // Nothing else resets: a `reject` (the negotiation's own rounds, and the §8 floor's refusal)
    // must not, or the bound it is counted against could never be reached.
    if (decision.type === 'approve') this.negotiation.noteProgress();
    return decision;
  }

  /**
   * [[EXT-29]] §5.3 / [[TUI-C69]] §5.4 — **a person was reached, so the exchange is over**: the
   * gate's own transcript is spent and the surface showing it is told, on the same event.
   *
   * Every direct `humanReached()` in this class goes through here, which is what keeps the two from
   * drifting: a new site that spent the transcript without telling the display would leave a
   * finished argument standing on screen, and at an escalation it would put the same exchange on an
   * unscrollable dialog twice — once live, once in the prompt about to render all of it.
   */
  private endNegotiation(): void {
    this.negotiation.humanReached();
    this.clearNegotiationDisplay();
  }

  /**
   * [[TUI-C69]] §5.4 — **take the finished argument off the screen WITHOUT spending the gate's
   * transcript.**
   *
   * The two are separate on purpose. `humanReached()` clears the rounds *and* the reachability
   * bound, which is correct only when a person was actually reached; calling it merely to tidy the
   * panel would hand the agent a fresh {@link MAX_REJECTIONS_BEFORE_HUMAN} budget it had already
   * spent, turning a display concern into a way to argue indefinitely. [[EXT-108]] made an approved
   * call stop clearing the transcript for exactly this reason, so the tidy-up cannot be the thing
   * that puts it back.
   *
   * Guarded, like {@link showNegotiationRound}: a surface that throws while clearing must never
   * change what the gate decided, or become the reason a turn ends.
   */
  private clearNegotiationDisplay(): void {
    try {
      this.negotiationDisplay?.end?.();
    } catch (e) {
      debugLogError('negotiation display end', e);
    }
  }

  /**
   * [[TUI-C69]] §5.4 — **tell the agent to forget the tool-call ids the rater bounced**, on every
   * event that ends a turn's display state: a new turn, and `/clear`.
   *
   * The runner decides *when* because it owns the turn boundary; the agent holds the set because it
   * owns the rendering. Fail-soft in the shape {@link resetRunStats} uses — an agent without the
   * method (a test double, a renderer-less agent) is simply skipped, and a tone hint must never be
   * the reason a turn fails to start.
   */
  private clearRaterClarifications(): void {
    try {
      this.agent?.clearRaterClarifications?.();
    } catch (e) {
      debugLogError('clear rater clarifications', e);
    }
  }

  /**
   * [[TUI-C69]] §5.4 — **hand one round of the argument to the surface that is showing it**, the
   * moment the gate decided it.
   *
   * The round travels raw. Every surface lays it out from the SAME rows the escalation prompt
   * draws, at its own terminal width, so the rounds a person watches and the rounds they later rule
   * on cannot be two different renderings of one exchange — and the rater's turns are yellow in
   * both because the rows carry the voice rather than a colour.
   *
   * No-ops when no surface is watching, which is the §5.5 seam as well as this one.
   */
  private showNegotiationRound(event: LiveNegotiationRound): void {
    const display = this.negotiationDisplay;
    if (!display) return;
    try {
      display.round(event);
    } catch (e) {
      // A surface that throws while drawing must never change what the gate decided.
      debugLogError('negotiation display round', e);
    }
  }

  /**
   * [[TUI-C69]] §5.4/§5.5 — **the rater agreeing is the last round of the argument, and it is held
   * on screen before it takes effect.**
   *
   * Two things, in this order, because the order is the requirement: the approving round is drawn,
   * and only then does the minimum visible interval run. A hold before the draw would be a pause
   * over nothing.
   *
   * **It is a visibility pause, not a reading window**, and it must never be relied on as an
   * opportunity to evaluate the command — nobody reads a command in 800 ms. What it buys is that
   * the approving round is on screen as its own event instead of being overwritten by the tool
   * output that follows it immediately.
   *
   * **What it is NOT, on either surface, is a guaranteed abort window — do not restore that claim
   * without building the mechanism.** Stated precisely, because the previous wording asserted a
   * mechanism that is not here and a comment like that stops the next reader checking:
   *
   * - **Event/TUI path.** An abort raised during the hold does end the run with the tool unrun, but
   *   *this code is not why*. The runner never re-checks the signal after the hold — it issues the
   *   approving resume regardless — and what stops the tool is that LangGraph refuses an
   *   already-aborted signal downstream. True today, and true by someone else's invariant.
   * - **Plain/readline path.** Not true at all. `resolveToolInterrupts` threads no signal, and
   *   `waitForEscape` is armed inside `streamFromInput` and torn down before the hold begins — the
   *   hold happens *between* streams. Esc during it is not handled, so the command runs. The pause
   *   still buys the visibility above, which is why it is not conditioned on the surface.
   *
   * Making the affordance real by construction — checking the signal here, and threading one into
   * the readline path so there is something to check — is deliberately left out of scope rather
   * than half-built, since a window honoured on one surface and not the other is the more dangerous
   * shape: it is what teaches the user the gesture that then silently fails.
   *
   * **Both halves are gated on a surface being wired**, so a headless `exec`/CI run neither draws
   * nor sleeps and pays nothing. See {@link negotiationDisplay}.
   */
  private async showNegotiatedApproval(
    command: string,
    justification: string | undefined,
    verdict: ShellSafetyVerdict | undefined
  ): Promise<void> {
    if (!this.negotiationDisplay) return;
    // **A negotiated approval is one that ANSWERS A REFUSAL THAT IS STILL STANDING** — not merely
    // one that happens later in a turn where something was refused.
    //
    // `consecutiveRejections` is exactly that question, already maintained for §5.3: it counts
    // rejections since the last approval, so it is non-zero only while the argument is unanswered
    // and `noteProgress()` puts it back to zero the moment any call gets through. Testing the
    // TRANSCRIPT instead is what made this wrong — since [[EXT-108]] an approved call deliberately
    // leaves the rounds standing, so a transcript test stays true for the whole rest of the turn,
    // and the six read-only commands an agent runs after one refusal each got a hold and a row
    // claiming the rater had agreed to them.
    //
    // Not cosmetic: it inverts §5.5. The hold exists to give the approval an argument produced its
    // own salience, and a window that opens on everything marks nothing.
    //
    // **Deliberately NOT "the transcript contains this exact command".** That reads well and is
    // wrong: the case this node exists for is a negotiation that CONVERGES, and an agent converges
    // by narrowing — `git reset --hard origin/main` becomes `git reset --soft HEAD~2`, which the
    // transcript has never held. Gating on an exact match would make the node's own canonical
    // scenario draw nothing at all. The exact match decides the LABEL below, where being wrong
    // costs a word instead of the feature.
    //
    // A first attempt rated `safe` is not a negotiated approval either: nothing was refused, so
    // there is no argument for a person to have watched, and the counter is zero.
    if (this.negotiation.counters().consecutiveRejections === 0) return;
    const transcript = this.negotiation.transcript();
    const rejections = transcript.length;
    // Did the rater refuse THIS command and then pass it, or pass something else? Only the first is
    // the rater agreeing; the second is it accepting a different command. Saying "Agreed" over a
    // command nobody argued about prints a false statement about the auto-rater.
    const revised = !transcript.some((round) => round.command === command);
    // The approving round sits AFTER every rejection, so the whole transcript precedes it — but it
    // is `agreed`, so it is LABELLED rather than numbered. A number here would be the very one the
    // next rejection takes: this call never joins the transcript, and the escalation prompt renders
    // that transcript, so the two views would give one number to two different commands.
    this.showNegotiationRound({
      round: {
        command,
        ...(justification ? { justification } : {}),
        outcome: verdict?.outcome ?? 'safe',
        reason: verdict?.reason ?? '',
      },
      position: rejections,
      agreed: true,
      ...(revised ? { revised: true } : {}),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, NEGOTIATED_APPROVAL_COOLDOWN_MS));
  }

  /**
   * [[TUI-C27]] — {@link decideToolApprovalInner} with the record closed off on EVERY exit.
   *
   * The final action is written here rather than at each of the decision's many returns, because
   * "what became of the call" is one fact with one source: what this method returns or throws. A
   * per-return assignment is a list that a new branch joins without noticing, and the branch that
   * would be forgotten is the one that ends the run.
   */
  private async recordedDecision(
    tool: PendingToolInterrupt,
    record: ApprovalDecisionCapture
  ): Promise<ToolApprovalDecision> {
    try {
      const decision = await this.decideToolApprovalInner(tool, record);
      record.action = decision.type === 'approve' ? 'approve' : 'reject';
      if (decision.type === 'approve' && decision.scope) record.scope = decision.scope;
      return decision;
    } catch (error) {
      if (error instanceof AttackHaltError) {
        record.action = 'halt';
      } else if (error instanceof NonInteractiveEscalationError) {
        // §6.2 — there was nobody to ask, so the escalation ended the run instead of reaching one.
        record.action = 'escalate';
        record.humanAnswer = 'no-human';
      } else {
        record.action = 'error';
      }
      record.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    }
  }

  /** The decision itself; {@link decideToolApproval} wraps it with §5.3's reset. */
  private async decideToolApprovalInner(
    tool: PendingToolInterrupt,
    record: ApprovalDecisionCapture
  ): Promise<ToolApprovalDecision> {
    const command = typeof tool.args?.command === 'string' ? (tool.args.command as string) : null;
    const isShellCommand = tool.name === SHELL_TOOL_NAME && command !== null;
    const approvals = this.sessionApprovals;

    // (0) Does the rung IN FORCE gate this tool at all? Same shared predicate the agent built the
    // interrupt from, asked about this one call, so the wiring and the decision cannot disagree.
    // Scope `once`, so nothing is written to any allow-list: this is not a grant, it is the absence
    // of a gate.
    const { gateShell } = resolveShellApprovalGate(this.config ?? undefined, this.command);
    if (!isToolGatedAtRung({ toolName: tool.name, rung: approvals.rung, gateShell })) {
      return this.stage(record, 'not-gated', { type: 'approve', scope: 'once' });
    }
    // [[TUI-C27]] — [[EXT-81]]'s surviving observable: what the gate's own parser made of the
    // command, recorded whether or not a rating follows. Computed once here rather than at the
    // rating site, so a call the floor or a list settles still says whether the command was one the
    // parser could resolve.
    if (isShellCommand && command !== null) {
      const defect = describeAbstention(command);
      if (defect) record.parserUnresolved = defect;
    }

    // ONE subject and ONE annotation source per decision, shared by the rule matcher and the
    // §4.7.3 floor below. Building a second source for the floor would let a `hint` entry and the
    // floor read different effective values for the same call — the two-derivations-disagreeing
    // failure `core/approvals/annotations.ts` exists to prevent.
    // §4.7.4 — the hosts this call names, read ONCE. The subject carries the single host where
    // there is exactly one; the sticky-grant decision needs the count as well, because "named no
    // host" and "named several" are the same absent `host` on the subject and are not the same
    // question for the menu.
    const hosts = tool.name === SHELL_TOOL_NAME && command !== null ? [] : toolCallHosts(tool.args);
    const subject = this.approvalSubjectFor(tool, command, hosts);
    const annotationSource = this.effectiveToolAnnotationSource();
    // ONE read of that source per decision as well, so the §4.7.4 invalidation below, the §4.7.3
    // floor and the snapshot a grant records are all the same set. A shell subject has none — a
    // command carries no tool annotations.
    const effective = subject.kind === 'shell' ? undefined : annotationSource(subject);

    // §4.7.4 — **before any rule is resolved**, so a grant the tool has since weakened out from
    // under cannot auto-approve the very call that revealed the weakening.
    if (subject.kind !== 'shell' && effective) this.invalidateWeakenedGrants(subject, effective);

    // The declared lists AND the runtime grant stores, resolved most-restrictive-wins in ONE pass
    // through the ONE comparison engine, so author order and the order the lists were concatenated
    // in cannot change the outcome — and a grant the menu wrote is compared exactly as a line the
    // user typed into their config is.
    const rule: ApprovalRuleDecision | null = resolveApprovalRules(
      subject,
      this.approvalRuleLists(),
      {
        // EXT-70 §4.7.1 — a `hint` entry reads EFFECTIVE annotations, which is where per-server,
        // per-hint trust is applied. Without this the matcher falls back to the fail-closed source,
        // where no tool is ever read-only and a `hint` entry could only ever describe the default.
        annotations: annotationSource,
        onNotice: (notice) => this.statusUpdate(notice.level, notice.message),
      }
    );

    // (1) Deny — before everything, including `bypass`.
    if (rule?.action === 'deny') {
      // [[TUI-C26]] §6/[[EXT-107]] — the message names the refusal the user actually made, and each
      // of the three authors is undone somewhere different: a line in `approvals.deny` is edited
      // out of a config file, a saved refusal is lifted from the project's deny file, and a session
      // one simply ends with the session. Telling the model (and, through it, the user) to edit a
      // file the refusal was never written to is the same class of wrongness as confirming a
      // persistence that did not happen. The declared list is checked FIRST so an entry a user
      // wrote is described as theirs even when the menu recorded the identical one.
      const described = describeApprovalEntry(rule.entry);
      const key = renderApprovalEntryObject(rule.entry);
      const declared = this.sessionApprovals.deny.some(
        (entry) => renderApprovalEntryObject(entry) === key
      );
      const saved =
        !declared &&
        (this.getPersistedDenials()?.list() ?? []).some(
          (grant) => renderApprovalEntryObject(grant.entry) === key
        );
      record.ruleMatch = { action: 'deny', entry: described };
      const message = declared
        ? `Refused: your deny list forbids this call (matched "${described}"). ` +
          'Remove the entry from approvals.deny if you want it to run.'
        : saved
          ? `Refused: the user chose to always refuse this, and it was saved to this project ` +
            `(matched "${described}"). The refusal stands in new sessions too; ask the user if ` +
            'you believe it should be lifted, which they can do with the /approvals command.'
          : `Refused: the user chose to always refuse this earlier in this session (matched ` +
            `"${described}"). That refusal lasts until the session ends; ask the user if you ` +
            'believe it should be lifted.';
      return this.stage(record, 'deny-list', { type: 'reject', message });
    }

    // (2) `bypass` (config or `/approvals bypass`): approve a gated shell command WITHOUT
    // prompting or rating. Scope `once` so nothing is written to the allow-list (the bypass is
    // intentionally ephemeral and reversible). The hardline floor is NOT bypassed here — it is
    // enforced at exec time in GthDevToolkit.executeCommand regardless of this decision.
    if (isShellCommand && approvals.rung === 'bypass') {
      return this.stage(record, 'bypass', { type: 'approve', scope: 'once' });
    }

    // (2b) [[EXT-29]] §4.2/§8 — **the hardline floor, consulted BEFORE anything opens.** "If the
    // deterministic floor matches, the command is refused at execution regardless of rating, rung,
    // or approval — so it MUST NOT be negotiated and SHOULD NOT be escalated."
    //
    // **This is a second call site, not the exec-time one, and the promise is different.** The
    // toolkit's check guarantees such a command never RUNS; it does nothing about what happens on
    // the way there, so without this line `auto` spends three rating calls and a human dialog
    // arguing about a fork bomb that was never going to run, and `manual` puts a wipe-the-disk
    // command in front of a person who answers it — and "asking a human to approve something that
    // is then refused anyway teaches them their answer does not count, which is worse than a flat
    // refusal". The exec-time check stays exactly where it is: it is the guarantee, this is the
    // courtesy of not wasting a decision on it.
    //
    // It sits above the allow branch because the floor is unappealable — an allow entry cannot buy
    // past it — and below the deny check because a deny match refuses the same call for the user's
    // own reason.
    //
    // **`checkHardline` is asked, not `catastrophic`.** They are different predicates and the
    // difference is measured: EXT-60 recorded `chown -R /` as missing from the floor, so "the floor
    // matched" and "the rater said catastrophic" name overlapping, non-identical sets. A
    // `catastrophic` rating still escalates (§4.2 settled that deliberately); only a floor match
    // refuses here.
    //
    // **A floor match refuses; it never halts, whichever of §8's two subsets matched.** The floor is
    // a lexical test with no notion of direction or role, so it fires on ordinary work — the deploy
    // authenticated by an identity file, the fetch that writes a credential INBOUND — and ending the
    // session on one leaves a restart as the only recovery. The run-ending halt stays where a model
    // has actually said the command is an attack (the rating path below): a floor match is a
    // model-free assertion, and the model-free consequence is the floor's own refusal, reached
    // earlier here than at exec and without spending a prompt on it.
    //
    // **Every rung that reaches this line, deliberately** — `assisted` and `auto`, and the two
    // deterministic rungs alike (`bypass` returned above). §4.2 is a statement about the COMMAND,
    // not about who was going to be asked about it: `assisted` gets the refusal without a prompt
    // for the same reason `auto` gets it without a round, and `manual`/`write` for the same reason
    // again. Those two are where the harm bites hardest, because they are the rungs a user picks in
    // order to answer every call themselves — so they are the rungs whose answers a refusal after
    // the fact teaches them not to trust.
    if (isShellCommand && command !== null) {
      const floor = checkHardline(command);
      if (floor) {
        // [[TUI-C27]] — **the archive names the matched pattern; the refusal below does not.**
        // §8.1 ("the floor is never advertised") and [[CFG-31]] bind USER-FACING rung copy —
        // text inviting someone to feel safe — and the resolution taken here is that a diagnostic
        // archive a user opens about their own session is not that surface: "a floor matched"
        // without saying which rule leaves nobody able to act on it. `buildHardlineRefusal` is
        // untouched and still carries only the description.
        record.hardline = { description: floor.description, pattern: floor.pattern };
        const refusal = buildHardlineRefusal(command, floor);
        // Visible, because the exec-time refusal is: a refusal the user never sees reads as the
        // agent quietly deciding not to do what it was asked.
        this.statusUpdate(StatusLevel.WARNING, `\n⛔ ${refusal}`);
        // §7's moves are deliberately absent — see `buildHardlineRefusal`. Neither bound moves
        // either: this refusal opens no round, so counting it would walk an unappealable refusal
        // toward the human escalation §4.2 says it must not reach. It follows that a model spamming
        // a floor-matching command is bounded only by the tool-loop guard and `recursionLimit`,
        // which is the right place for "the model did something unproductive" to end and the wrong
        // place for a fork bomb to acquire an audience.
        return this.stage(record, 'hardline-floor', { type: 'reject', message: refusal });
      }
    }

    // (3) Escalate — §3.2 sends it straight to the human with no rating call, outranking any allow
    // entry that also matched.
    //
    // The `bypass` term is deliberate and not redundant with the early return above. That return
    // only covers a SHELL call, so without this term a non-shell subject would still carry an
    // escalate match into the prompt at `bypass`, and §2.5's rule is about the rung, not about which
    // tool asked. Non-shell subjects do reach this line — the deterministic rungs gate the write
    // built-ins, MCP and custom tools — so the term is doing work rather than guarding a hypothesis.
    const escalatedBy =
      rule?.action === 'escalate' && approvals.rung !== 'bypass'
        ? describeApprovalEntry(rule.entry)
        : undefined;
    if (escalatedBy) {
      record.ruleMatch = { action: 'escalate', entry: escalatedBy };
      record.stage = 'escalate-entry';
    }

    // (4) Approve from the allow list without prompting. It ALWAYS wins over the rater — a
    // human-trusted call shouldn't pay for an LLM call on every variant — but never over escalate.
    const allowlistApplies = approvals.rung !== 'bypass' && escalatedBy === undefined;
    let safetyVerdict: ShellSafetyVerdict | undefined;
    if (allowlistApplies && rule?.action === 'allow') {
      record.ruleMatch = {
        action: 'allow',
        entry: describeApprovalEntry(rule.entry),
        rate: rule.rate === true,
      };
      // §3.2 — `rate` is honored at the rater rungs and INERT at the deterministic ones, so an
      // entry can never smuggle a model call into `manual` or `write`. A tool subject is not
      // rated either: the rater's first implementation covers the shell only (§4.3, [[EXT-30]]).
      if (!rule.rate || !isRatedRung(approvals.rung) || !isShellCommand || command === null) {
        return this.stage(record, 'allow-list', { type: 'approve', scope: 'session' });
      }
      // Attributed once, before the call, for the reason the rater path below is: the tripwire's
      // own `attack` arm throws, and a second writer on the return would make this one unfalsifiable.
      record.stage = 'allow-tripwire';
      const verdict = await this.rateCommand(command, { allowMatched: true }, record);
      const tripwire = mapAllowMatchedVerdictToAction(verdict);
      if (tripwire.action === 'approve') {
        return { type: 'approve', scope: 'session' };
      }
      if (tripwire.action === 'halt') {
        // §3.2/§4.2 — `attack` halts exactly as it would have without the match. A standing human
        // grant answers "may this run"; it does not answer "is this command's structure hostile".
        //
        // §6.1 — and it halts through the SAME seam as the rater's own path below, so an allow
        // entry does not decide whether the banner appears. The entry has already been overruled by
        // the time this line is reached; letting it also silence the one way out would make the
        // recovery depend on a match the human cannot see from the banner.
        return await this.haltOrRunAnyway(command, tripwire.verdict?.reason ?? '', record, subject);
      }
      // `catastrophic` — the one outcome the tripwire escalates. Fall through to the human.
      safetyVerdict = tripwire.verdict;
    }

    // (5) What the gate makes of the call itself, at the two rated rungs only. Skipped entirely
    // for an escalate match (§3.2: the user pre-decided that a human answers, so a rating would
    // decorate a mandatory prompt) and for a call the tripwire above already rated. The rung test
    // is the SAME one `mapVerdictToAction` applies, so both arms below floor exactly where the
    // shell does and nowhere else: `bypass` and the two deterministic rungs consult neither the
    // rater nor a preflight, and at those rungs the human is asked regardless.
    if (isRatedRung(approvals.rung) && escalatedBy === undefined && safetyVerdict === undefined) {
      // **The SUBJECT is what splits the two arms, not a second reading of the tool name.**
      // `approvalSubjectFor` returns `kind: 'shell'` under exactly the condition `isShellCommand`
      // states, so branching on the discriminant says the same thing once instead of twice — and
      // any future divergence in that function sends the call to the FLOOR (fail-closed) rather
      // than silently past it. It is also what carries the command as a non-null string.
      if (subject.kind === 'shell') {
        // The auto-rater. `safe` is approved (the fatigue reducer), `destructive` and
        // `catastrophic` fall through to the human with the verdict attached, and `attack` ends the
        // run outright. §4.6's deterministic preflights are applied inside `mapVerdictToAction`,
        // ahead of the `safe` check.
        //
        // **[[EXT-81]] — EVERY shell command reaches this call, including the ones the gate's own
        // parser cannot resolve.** There used to be a branch above it that skipped the rating for a
        // composed, substituting or redirecting command and refused the call instead. Two things
        // followed from that skip, and both are gone with it: `attack` and `catastrophic` were
        // UNREACHABLE for that entire class (nobody rated, so nobody could say worse than
        // `destructive`), and the party that heard about it was the parser's, not the rater's — a
        // component that has just announced it could not read a command is in no position to say
        // how to rewrite it, and the rewrite it named turned `cd src && ls` into a no-op plus a
        // listing of the wrong directory, both exit 0. The parser's finding is now a neutral note
        // in the rating prompt (`buildRaterPrompt`) and nothing else.
        // [[EXT-29]] §5.1 — the negotiation this rating is a round of. At `assisted` the context is
        // empty and `negotiable` is false, so the whole call is byte-identical to what it was.
        //
        // [[EXT-106]] §3 — and it is false at `auto` too for a command §4.6's preflight floors,
        // through the SAME `isNegotiableCall` the decision below reads. Telling the rater to word a
        // rejection "for an agent that may answer it" is simply FALSE there: nothing it writes can
        // move an outcome the floor recomputes from the raw command every round. Two writers of one
        // fact is what this shares a function to avoid.
        //
        // **It also withholds the justification and the transcript from that rating**, and that
        // follows rather than being a side effect: both exist so a rating can be revised in the
        // light of an argument, and there is no argument on this path — the call goes to a person
        // on its first round instead.
        //
        // [[EXT-106]] §4.6 — **the provenance is read ONCE here, and every reader of the carve-out
        // is given that one snapshot.** `this.negotiation` is mutable and the rating below is
        // awaited, so three separate reads of it — the negotiability test before the call, the
        // decision after it, the archive after that — would be the two-writer hazard these doc
        // blocks exist to prevent, rebuilt around an await. One read fixes the input; the derivation
        // itself is then a pure function of (rung, raw command, snapshot) that each reader runs
        // through the one shared helper, exactly as both readers already recompute the preflight
        // from the raw command rather than being handed a result to trust. That is also what makes
        // the rung scope unforgeable: `carvedOpenWorldHosts` enforces `auto` itself, so this call
        // site cannot widen it by forgetting.
        //
        // **NOT `contextFor()`.** That returns no user messages at round 1 by design (§5.1), and
        // round 1 — the user asks, the agent proposes, nothing has been refused yet — is the round
        // the carve-out exists to act on. §5.1 bounds what the RATER may see; the floor is not the
        // rater.
        //
        // **And "was this call carved?" is asked of the DECISION's own reader, once.** The carve is
        // one arm of a floor with two, and only `effectivePreflightFloorFinding` resolves which arm
        // wins: a command that trips the script-env-leak arm as well is floored by that one and is
        // not carved at all, whatever the open-world arm would have said on its own. Reading
        // `carvedOpenWorldHosts` directly for the archive, the prompt or the warning is a SECOND
        // derivation of the same fact that does not know about arm precedence — so those three would
        // report a carve on a command that was floored and did go to a human. Deriving the hosts
        // from the effective finding keeps them empty whenever the floor stood, which is what makes
        // "carved" mean the same thing to every reader of it.
        const provenance = this.negotiation.retainedUserMessages();
        const effectiveFloor = effectivePreflightFloorFinding(subject.command, {
          rung: approvals.rung,
          provenance,
        });
        const carvedHosts =
          effectiveFloor === null
            ? carvedOpenWorldHosts(approvals.rung, subject.command, provenance)
            : [];
        const negotiable = isNegotiableCall(approvals.rung, subject.command, provenance);
        const justification = negotiable ? shellJustification(tool.args) : undefined;
        // [[EXT-127]] — **the checker gets the justification whatever the rung said**, because it is
        // a different reader with a different framing. §5.1's gate above existed to keep the one
        // channel that can LOWER a rating out of a round-1 rating; the classifier can no longer see
        // it at any round, so that gate now protects nothing there. The checker reads it as what it
        // is — agent-authored text in the tool-result role — where nothing about it is trusted.
        // Kept as a separate read so the variable the ROUND RECORD and the negotiated-approval
        // display use is byte-for-byte what it was.
        const agentJustification = shellJustification(tool.args);
        // [[TUI-C27]] — attributed BEFORE the call, and ONCE. Before, because `attack` throws out
        // of the decision below and a record left unattributed would say a halt came from nowhere.
        // Once, because a second assignment on each `return` would make the first unfalsifiable:
        // deleting either would leave the other still writing 'rater', and a fact with two writers
        // is one no test can pin.
        record.stage = 'rater';
        const verdict = await this.rateCommand(
          subject.command,
          {
            allowMatched: false,
            negotiable,
            // [[EXT-106]] §4.6 — the rating PROMPT has to know too. Two of its blocks assert that
            // §4.6's floor already fired and that the rater's hostname judgement is therefore not
            // what decides; on a carved command both are backwards, and on this one command the
            // rater's assessment really is the last line.
            carved: carvedHosts.length > 0,
          },
          record
        );
        const decision = mapVerdictToAction(subject.command, verdict, {
          rung: approvals.rung,
          provenance,
        });
        // [[TUI-C27]] — WHICH deterministic preflight fired, and whether it actually rewrote the
        // rating. The two are separate facts: a preflight only ever RAISES, and only `safe` sits
        // below the floor, so a finding on a `destructive` verdict is the floor AGREEING with the
        // rater rather than overriding it — and attributing the decision to the floor in that case
        // would be wrong. Recomputed from the same raw command `mapVerdictToAction` recomputes it
        // from, through the same one function, so the two cannot disagree.
        //
        // [[EXT-106]] §4.6 — **the PURE finding, deliberately, so a carve does not empty the
        // archive.** The decision above reads the carve-aware form; this reads what the preflights
        // found in the string, and the carve is recorded BESIDE it as its own two facts. A user
        // opening a dump of their own session most needs to find the case where an open-world
        // command ran with nobody asked, and a record nulled out by the carve is precisely the one
        // that would be missing.
        //
        // **`floorApplied` is read off the decision's own reader, not derived a second time.** It
        // answers "did the readers act on this finding?", which is `effectivePreflightFloorFinding`
        // and nothing else: computing it from the carved hosts instead would say "carved, not
        // floored" about a command whose script-env-leak arm floored it and sent it to a human. Both
        // fields therefore come from `effectiveFloor`, which is also what the decision, the
        // negotiability test and the prompt above were built from.
        const preflight = preflightFloorFinding(subject.command);
        if (preflight) {
          record.preflight = {
            ...preflight,
            rewroteRating: isBelowDestructiveFloor(verdict.outcome),
            floorApplied: effectiveFloor !== null,
            ...(carvedHosts.length > 0 ? { carvedHosts: [...carvedHosts] } : {}),
          };
        }
        // [[EXT-127]] — **THE ALIGNMENT CHECK: a second model, reached only once the classifier has
        // declined.** The classifier rated the command; this asks the different question the
        // classifier can no longer see the context for — *is this what the user asked for?*
        //
        // **It is a stage AFTER `mapVerdictToAction`, never a branch inside it, and that placement
        // is the design.** The classifier's mapping stays a pure function of the rung, the raw
        // command and the outcome, so the eval target, the corpus and every unit assertion keep
        // measuring the same thing they measured before; what the check does is take that decision
        // and, on exactly the outcomes the node grants it authority over, replace it.
        //
        // **What it is allowed to reach.** Only a `destructive` decision, and only at a negotiating
        // rung. `attack` has already halted above the return below; `catastrophic` returns its own
        // escalation from the mapping and is never offered here; and both are refused a second time
        // by the tool contract itself (`alignmentApprovalRefusal`), because a limit the rest of the
        // ladder relies on must not be reachable by a call site forgetting.
        //
        // **The floored arm is included, and it has to be.** §4.6's open-world floor is one of the
        // two things an aligned approval MAY lift, and a floored command reaches this line as an
        // `escalate` rather than a `reject` — so a check keyed on `reject` alone would make the
        // single largest piece of authority this feature has unreachable. The SCRIPT-ENV-LEAK arm is
        // deliberately not included: it is a fact about the command's own text (an interpreter
        // expanding a secret into a script), nothing about who asked for it speaks to it, and the
        // node grants no authority over it.
        let action: RaterAction = decision.action;
        let alignment: AlignmentDecision | undefined;
        const alignmentReachable =
          isNegotiatingRung(approvals.rung) &&
          decision.verdict?.outcome === 'destructive' &&
          (decision.action === 'reject' ||
            (decision.action === 'escalate' && effectiveFloor?.kind === 'open-world'));
        if (alignmentReachable) {
          alignment = await this.checkAlignment(
            {
              command: subject.command,
              outcome: 'destructive',
              reason: decision.verdict?.reason ?? '',
              ...(agentJustification ? { justification: agentJustification } : {}),
            },
            provenance,
            record
          );
          // The three tools ARE the three actions, which is why there is no fourth.
          //
          // **A check that never happened changes nothing**, which is a stronger contract than "it
          // fails closed" and is the one that matters here: the classifier's action stands, so a
          // missing or broken checker model leaves `auto` behaving exactly as it did before this
          // feature existed rather than quietly turning every negotiation into an interruption. See
          // {@link ALIGNMENT_FAIL_CLOSED}.
          if (!isAlignmentFailClosed(alignment)) {
            action =
              alignment.kind === 'approve'
                ? 'approve'
                : alignment.kind === 'suggest'
                  ? 'reject'
                  : 'escalate';
          } else {
            // Not recorded on the round either: a check that did not happen is not one the next
            // round should replay as its own earlier turn.
            alignment = undefined;
          }
        }
        if (action === 'approve') {
          // [[EXT-106]] §4.6 — **a carved command that RUNS is announced.** The carve-out removes
          // the confirmation dialog; it must never remove the visibility, or an open-world fetch
          // reaches the network with the user told nothing at all. Visible for the same reason the
          // hardline refusal above is: an event the user never sees reads as the agent quietly
          // deciding things on their behalf.
          //
          // **The trigger is carved AND approved AND not lifted by the alignment check.** This
          // sentence tells the user *"the auto-rater found nothing wrong with it"*, and the residual
          // risk it covers is exactly the one case the rater saw nothing in — so it is true of a
          // carved command the classifier itself cleared, and false of one the classifier rated
          // `destructive` and the check below lifted. [[EXT-127]] made that second path reachable,
          // so this branch now states the case it was always describing rather than assuming it.
          // The lifted path is announced ONCE, by the merged arm of `alignmentApprovalNotice`, which
          // names the same host this line would have.
          const alignmentLifted = alignment?.kind === 'approve';
          if (carvedHosts.length > 0 && !alignmentLifted) {
            this.statusUpdate(
              StatusLevel.WARNING,
              `\n⚠ Ran a command that reaches ${carvedHosts.join(', ')} without asking you, ` +
                'because your own message named that host and approvals is set to ' +
                // §10 rule 4 — the resolved rung is rendered in its DISPLAY spelling wherever the
                // mode is stated, never in the §9.1 identifier. This branch is reachable only at
                // that rung, so the label is read from the map rather than spelled here: a table
                // nobody has to remember to update is what keeps the two from drifting.
                `${APPROVAL_RUNG_LABELS.auto}. The auto-rater found nothing wrong with it. ` +
                'Check the host is the one you meant.'
            );
          }
          // [[EXT-127]] — **and an announcement whenever the ALIGNMENT CHECK is what let the
          // command run**, which is the other way a command now runs at `auto` with nobody asked.
          // The two notices are separate wherever the two causes are, because they are two
          // different claims about why nothing interrupted: the one above says the user typed the
          // host, this one says a second model read their messages and concluded the command
          // matches what they asked for. A user auditing their own session must be able to tell
          // those apart, and a shared sentence would let the weaker of the two stand in for the
          // stronger.
          //
          // **Where BOTH applied, one merged notice says both**, which is why the hosts are handed
          // to the renderer. `reachesNetwork` cannot carry them: it reads which FLOOR stood, and a
          // carved command is precisely one where none did — so a merged line keyed on it would drop
          // the host guidance on the one path where the user's own message authorised the fetch.
          //
          // **Both arms of it, not only the floored one.** A plain `destructive` lifted by the
          // checker is the COMMON case and reaches the screen through nothing else:
          // `showNegotiatedApproval` below gates on §5.3's `consecutiveRejections`, which is zero on
          // round 1 — the round most of these approvals happen on — so that path returns without
          // drawing. Announcing the rare floored arm and staying silent on the common one would put
          // the weaker guarantee on screen and leave the stronger one invisible.
          //
          // Rendered by the alignment module's own one renderer rather than spelled here, so the
          // two arms cannot come to describe one event two ways.
          if (alignmentLifted) {
            this.statusUpdate(
              StatusLevel.WARNING,
              alignmentApprovalNotice({
                command: subject.command,
                rungLabel: APPROVAL_RUNG_LABELS.auto,
                reachesNetwork: effectiveFloor?.kind === 'open-world',
                carvedHosts,
              })
            );
          }
          // [[TUI-C69]] §5.4/§5.5 — **the round that ENDS a negotiation is a round too**, and it
          // is the one §5.5 holds on screen. What makes an approval *negotiated* is that an
          // argument is STILL UNANSWERED when it arrives — `showNegotiatedApproval` gates on
          // §5.3's `consecutiveRejections` — and **not** that this exact command is on the
          // transcript. Read that method's docblock before changing anything here; the two
          // statements below are the ones people get wrong.
          //
          // **What is and is not held.** A first attempt rated `safe` is not held: nothing was
          // refused, so the counter is zero and there is no argument anyone could have watched.
          // But a command that merely follows someone else's argument **is** held and **is**
          // drawn — labelled `Accepted:` rather than `Agreed:`, because the rater never refused
          // that particular command. That is deliberate. The unit of the feature is the ARGUMENT,
          // and whichever call gets through is the one that ends it.
          //
          // **The exact-command rule was rejected on measurement, not taste.** An agent converges
          // by NARROWING, so the node's own canonical scenario is approved on a command the
          // transcript has never held (`git reset --hard origin/main` → `git reset --soft
          // HEAD~2`). Gating on a literal match would make that case draw nothing at all, firing
          // only when the agent FAILS to narrow — the inverse of what §5.5 is for. The match still
          // decides the LABEL below, where being wrong costs a word instead of the feature.
          //
          // **Read BEFORE `decideToolApproval`'s wrapper calls `noteProgress()` — this ordering is
          // REQUIRED, not defensive.** That wrapper resets §5.3's consecutive counter on every
          // approve, and this call site sits inside the decision it wraps, so the reset lands just
          // after the `approve` returned below. The counter it zeroes is the exact one the gate
          // reads: run it first and `showNegotiatedApproval` returns at that gate without drawing
          // or sleeping, so the hold never fires on any path — no row, no error, every surface.
          // The negotiation specs pin it (moving the reset above this call reds the §5.4/§5.5
          // cells), which is the only reason a silent, total failure is catchable here.
          await this.showNegotiatedApproval(subject.command, justification, decision.verdict);
          // Scope `once`: rater approvals are NEVER persisted to the allow-list.
          return { type: 'approve', scope: 'once' };
        }
        if (action === 'halt') {
          // §4.2 — not a rejection the model can respond to. It ends the agent loop.
          //
          // **`neg-04d`: a negotiation already in flight ends here too**, mid-way and without a
          // further round. `attack` is exempt from the whole mechanism (§5.1), so the counter, the
          // transcript and the loop all stop together rather than the argument continuing around a
          // halt that only ended one call.
          //
          // The reset itself is defence in depth: the throw ends `processMessages`, and a later
          // turn would clear the negotiation on its own first line anyway. **No PRODUCTION reader
          // sees this state again — which is not the same as it being unobservable**, and the
          // difference decides whether the line is pinned. `neg-04d` asserts both halves through
          // the spec harness's private-state cast: the cleared transcript, and `sinceHuman` back at
          // zero. Since [[EXT-108]] both halves distinguish this call from `noteProgress()`, which
          // resets the consecutive count alone and deliberately leaves the rounds and the
          // reachability bound standing.
          this.endNegotiation();
          // §6.1 — the banner, when an interactive surface wired one, and the halt otherwise. It
          // sits AFTER the reset above on purpose: a human is reached either way (that is what the
          // banner is), so the negotiation ends here whichever answer comes back, and neither
          // answer leaves a transcript behind for a later turn to argue from.
          return await this.haltOrRunAnyway(
            subject.command,
            decision.verdict?.reason ?? '',
            record,
            subject
          );
        }
        // §5 — the attempt just ruled on, as the transcript records it.
        //
        // **ONE builder for both of the paths that record a round**, because it is one fact: an
        // attempt was made, the gate refused to let it run, and this is what each party said about
        // it. Two literal copies would be two writers of the transcript's own shape, and the copy
        // that got forgotten would be the escalating one — which is exactly the round a person is
        // being asked to rule on.
        //
        // [[EXT-127]] — the checker's own decision rides on the round, so the NEXT round's check
        // can replay it as its own turn. Absent when no check was made, which is what keeps an
        // `assisted` rejection and a floored one out of the checker's replayed history.
        const negotiationRound = (): RaterNegotiationRound => ({
          command: subject.command,
          ...(justification ? { justification } : {}),
          outcome: decision.verdict?.outcome ?? 'destructive',
          reason: decision.verdict?.reason ?? '',
          ...(alignment ? { alignment } : {}),
        });
        /**
         * [[TUI-C69]] §5.4 — record the round and put it on the screen, in that order.
         *
         * The position is read AFTER `recordRejection`, so the count carries this round: the k-th
         * rejection sits at position k-1, which numbers it `Round k` on screen — the number the
         * escalation transcript would give the same round.
         *
         * **The round reaches the screen HERE, as it happens**, not only at the escalation this
         * argument may never reach. Emitted for the escalating round too: the exchange is rendered
         * as it happens, and the round that spends a bound is part of it. The prompt's own
         * transcript is then the summary a person rules on, which is a different job from watching
         * the argument run.
         */
        const recordAndShow = (round: RaterNegotiationRound): NegotiationVerdict => {
          const verdict = this.negotiation.recordRejection(round);
          this.showNegotiationRound({
            round,
            position: this.negotiation.counters().rejectionsSinceHuman - 1,
          });
          return verdict;
        };
        // [[EXT-127]] — **an escalation the CHECKER decided is a round, and is recorded as one.**
        //
        // `action` is `escalate` here, so the `reject` block below is skipped entirely and nothing
        // else on this path would record anything. Two things were lost with it, and both are the
        // reject path's stated reason for recording first: the attempt being ruled on was absent
        // from the transcript the human is shown (§5.6), and the checker's own decision — the
        // thing that ended the argument — was carried nowhere, so neither the next round, the
        // escalation prompt's payload nor the archive could say what it decided or why.
        //
        // **Only a check that actually ran and actually escalated.** A fail-closed check has
        // already been erased to `undefined` above, deliberately — a check that did not happen is
        // not a round the next one should replay as its own turn — and a floored `escalate` the
        // checker never lifted is the classifier's decision, not the checker's.
        //
        // **The verdict `recordRejection` returns is deliberately ignored**, which is the one way
        // this differs from the reject path. That return answers *"may another round be served?"*,
        // and the checker has just ruled that a person decides; letting a spare bound turn its
        // escalation back into another agent round would reverse the decision this line exists to
        // record.
        if (alignment?.kind === 'escalate') recordAndShow(negotiationRound());
        if (action === 'reject') {
          const outcome = recordAndShow(negotiationRound());
          if (outcome === 'reject') {
            // [[TUI-C69]] §5.4 — name the call the gate is about to refuse BACK TO THE AGENT, so
            // both surfaces tone its result row as a clarification request rather than as a failed
            // tool. Only this branch: an escalation, a human's "no", a deny entry and the §8
            // floor's refusal are all refusals rather than rounds of an argument.
            if (tool.id) this.agent?.noteRaterClarification?.(tool.id);
            // §7 — the refusal PLUS the moves the model actually has: re-call with a
            // justification (the tool argument exists for this), or call a different command.
            // Rendered through the one builder the human's own "no" uses, differing only in who
            // refused, so the model never meets two shapes of the same event.
            // [[EXT-127]] — **the checker's requested change is APPENDED to the rater's rejection,
            // never substituted for it.** The two say different things and the agent needs both:
            // the rater says what is wrong with the command, the checker says what would make it
            // match what the user asked for. Substituting would also silently change who the
            // rejection is attributed to on every surface that renders it, which is a display
            // decision this node deliberately does not make.
            const rejection = buildRejectionMessage({
              source: 'rater',
              toolName: tool.name,
              verdict: decision.verdict,
            });
            return {
              type: 'reject',
              message:
                alignment?.kind === 'suggest' && alignment.reason.trim().length > 0
                  ? `${rejection}\n\nThe alignment check also asked for a change: ${alignment.reason.trim()}${
                      alignment.suggestedCommand
                        ? `\nIt suggested: ${alignment.suggestedCommand.trim()}`
                        : ''
                    }`
                  : rejection,
            };
          }
          // A bound is spent — the agent and the rater cannot agree, and that is a human's call.
          // Falls through to the escalation below, carrying this last round's verdict.
        }
        // Escalate: carry the verdict (the honest one — see mapVerdictToAction) to the human.
        safetyVerdict = decision.verdict;
      } else {
        // EXT-70 §4.7.2/§4.7.3 — a tool call whose EFFECTIVE `openWorldHint` is true is floored at
        // `destructive`, through the SAME `applyDestructiveFloor` the shell path reaches via
        // `mapVerdictToAction`. No rating call: §4.3's scope boundary keeps the rater on the shell
        // until [[EXT-30]], and the floor is deterministic anyway — §4.6 states it as coming
        // *before* any model call, so it does not wait for one.
        //
        // **This is the branch a malformed `run_shell_command` lands in**, and it is the one shape
        // that reaches this floor under today's gate: a call with no `command` argument, or one
        // that is not a string, has nothing to rate, so it presents as a `tool` subject — and
        // `run_shell_command` carries no authored annotations, so its effective set is the
        // fail-closed one and it floors. That is the right direction: a shell call whose command
        // cannot even be read is not one anything can say something reassuring about.
        //
        // The annotations are the effective set (§4.7.1), read through the same source the `hint`
        // matcher just used, so an untrusted server's `openWorldHint: false` has already collapsed
        // to the fail-closed `true` and cannot buy its way past this.
        //
        // Reached only when no allow entry claimed the call: §4.6's fourth bullet makes an allow
        // match lift this floor, and step (4) above has already returned in that case.
        const toolFloor = openWorldToolFloorReason(effective);
        if (toolFloor !== null) record.stage = 'tool-open-world-floor';
        safetyVerdict = applyDestructiveFloor(safetyVerdict, toolFloor);
      }
    }

    // [[EXT-29]] §6 — **the human is shown the whole negotiation, not the last attempt.** Snapshot
    // it BEFORE the state is cleared, because "that the agent proposed the same command three times
    // unchanged, against two rejections that each told it what to fix, is itself the most important
    // thing on the screen". Empty for every escalation that had no negotiation — `catastrophic`
    // (which §4.2 gives no rounds at all), a declared escalate entry, an unrated rung, a tool
    // subject — so nothing renders a heading over an argument that never happened.
    // [[TUI-C27]] — everything that reaches a person has an attribution by now EXCEPT the plainest
    // case of all: a deterministic rung, no rule matched, no rating made. That is a decision the
    // rung itself made, so it is named rather than left blank — a record with no stage reads as the
    // recorder having failed, which is the opposite of what happened.
    record.stage ??= 'unrated-rung';
    const negotiationRounds: readonly RaterNegotiationRound[] = this.negotiation.transcript();
    // §5.3 — **the count the human is given: how hard the agent pushed since the last person.**
    // [[EXT-108]] brought it into agreement with the transcript's length, because an approved call
    // now erases no rounds and reaching a person clears both together. It is still passed rather
    // than left to the renderer's fallback: a screen too small for every round prints a slice, and
    // this is the number the heading over that slice has to carry. Read HERE, one line before
    // `humanReached()` spends it — after, it is zero.
    const negotiationAttempts = this.negotiation.counters().rejectionsSinceHuman;
    // Reaching a person ends the negotiation (§5.3) and is the ONE thing that clears the
    // reachability bound: an escalation the human is about to answer is exactly the event that
    // bound exists to make happen, so it is spent here rather than accumulated across it.
    this.endNegotiation();

    if (!this.toolApprovalCallback) {
      // §6.2 — no one to ask. Exit non-zero with everything a person needs, rather than handing
      // the model a rejection it would just work around. The transcript goes into the message
      // because that message is the only thing anyone sees on this path.
      //
      // [[EXT-106]] §4 — including the `approvals.allow` entry that would let this run, derived
      // HERE because only this scope knows the SUBJECT.
      //
      // [[EXT-115]] — **each kind through its own derivation, and both through the SAME ones the
      // escalation menu stores.** A shell command resolves to its normalized self; a tool or MCP
      // call resolves to the tool's identity plus the host it named, which is what §4.7.4 says a
      // grant for one records. Deriving a `shell` entry from a tool name — the shape this used to
      // be unable to avoid — would be a pasteable line that `matchEntry` refuses outright on the
      // type alone. `toolGrantEntry` answers `null` for a call whose MCP server could not be
      // attributed, which the ternary below already turns into the general form: an entry naming
      // the unresolved sentinel would be written and then dropped by the grammar's own validator.
      const allowEntry =
        subject.kind === 'shell' ? shellApprovalEntryFor(subject.command) : toolGrantEntry(subject);
      throw new NonInteractiveEscalationError(
        command ?? tool.name,
        safetyVerdict?.outcome,
        safetyVerdict?.reason,
        escalatedBy,
        renderNegotiationTranscript(negotiationRounds, negotiationAttempts) ?? undefined,
        allowEntry ? renderApprovalEntryObject(allowEntry) : undefined,
        // [[EXT-115]] — the discriminator the whole decision above ran on, so the message names
        // what it gated instead of calling a `write_file` or an MCP call a `Command`.
        subject
      );
    }

    // §4.2 — **a `catastrophic` approval is NEVER sticky.** "The human may approve this one
    // invocation, and only this one": no always-allow, and no session-scoped allow either. The
    // surface withdraws the affordance ([[TUI-C26]] drops `always approve` from the menu for this
    // outcome), but the allow-list WRITE is decided here, and §3 has the allow-list consulted
    // *before* the rater — so one sticky grant would remove the command from rating permanently,
    // and the next `terraform destroy` would never be rated at all. Clamping here means the policy
    // does not depend on which surface asked, or on a surface that has not been built yet.
    const catastrophic = safetyVerdict?.outcome === 'catastrophic';

    // §6 — **the menu must display what it is about to store**, at the moment of the choice, on
    // every surface. It is rendered from the very grant {@link recordApproval} will write, because a
    // menu that describes a grant one way and stores it another is the drift this design cannot
    // afford. Absent exactly where no sticky grant is available — a `catastrophic` outcome (§4.2
    // withdraws the persistent grants for EVERY subject, not only the shell one), or a call nothing
    // would remember — so the prompt never advertises a control that has already been withdrawn.
    const grant = catastrophic ? undefined : this.stickyGrantFor(subject, effective, hosts);
    const grantPreview = grant ? renderApprovalEntryObject(grant.entry) : undefined;
    // §6 — the same grant in the words the menu's *always approve* control is written in, through
    // the one-liner the §4.7.4 withdrawal notice also uses, so the two cannot describe one grant
    // two ways. For a tool call this is where "the stored thing is the tool, not the arguments"
    // becomes visible: it names the tool, its server and the host bound, and nothing else.
    const grantSummary = grant ? describeApprovalEntry(grant.entry) : undefined;

    // [[TUI-C26]] §6 — the deny half, computed SEPARATELY rather than read off the grant. The two
    // are available under different conditions and `grant === undefined` is the wrong test for
    // both: a command that does not statically resolve, and every `catastrophic` verdict, have no
    // grant on offer and a perfectly good deny entry.
    const denyEntry = this.denyEntryFor(subject);
    const denyPreview = denyEntry ? renderApprovalEntryObject(denyEntry) : undefined;
    const denySummary = denyEntry ? describeApprovalEntry(denyEntry) : undefined;

    // Surface the rater's verdict, the escalate entry that fired as provenance (§3.2), and what
    // each sticky choice would store (§6) — without mutating the original interrupt object the
    // caller holds.
    //
    // **`denyPreview` belongs in this condition, and leaving it out is a silent hole rather than a
    // tidiness question.** The most ordinary prompt in the system — a deterministic rung, no
    // rating, no escalate entry, no negotiation, a command that does not statically resolve — has
    // none of the other four, so without this term the interrupt would pass through unchanged and
    // the *always reject* control would vanish from exactly the case it exists for.
    //
    // [[TUI-C67]] — **the subject is attached unconditionally**, outside every optional term above,
    // because the terminal surfaces render the prompt's opening sentence from it and there is no
    // call this question does not have an answer for. (The ACP server does not read it yet, and
    // titles its permission request from its own classifier — [[TUI-C89]]. That narrows who
    // consumes the field, never whether it has to be set.) It cannot be one more
    // `...(x ? {x} : {})`:
    // an `mcpTool` call whose server could not be attributed has neither a grant nor a deny entry
    // (§4.7.4 / the entry grammar's non-empty `server`), so at an unrated rung with no escalate
    // entry it is exactly the call that would fall through to a bare `tool` — and it is exactly
    // the call the new header exists for.
    const pending: PendingToolInterrupt = {
      ...tool,
      subject,
      ...(safetyVerdict ? { safetyVerdict } : {}),
      ...(escalatedBy ? { escalatedBy } : {}),
      ...(grantPreview ? { grantPreview } : {}),
      ...(grantSummary ? { grantSummary } : {}),
      ...(denyPreview ? { denyPreview } : {}),
      ...(denySummary ? { denySummary } : {}),
      ...(negotiationRounds.length > 0 ? { negotiationRounds, negotiationAttempts } : {}),
    };
    const decision = await this.toolApprovalCallback(pending);
    // [[TUI-C27]] — a person was reached and answered. The STAGE stays whatever decided to ask
    // them (a rating, an escalate entry, an unrated rung): "who decided to interrupt" and "what
    // they said" are two different questions, and collapsing them into one field is what makes a
    // dump unable to tell a rater escalation from a declared one.
    record.humanAnswer = decision.type === 'approve' ? 'approve' : 'reject';

    // [[EXT-150]] — **what the answer landed as**, which is not what the answer asked for. It starts
    // at `once` and only a record that was actually made moves it, so the three paths that store
    // nothing report the one-shot answer they really are: an approve with no grant on offer (a
    // `catastrophic` verdict, a command that does not statically resolve, a call nothing can
    // attribute), a reject carrying no scope, and a reject at a scope for a call with no deny entry.
    let lifetime: ApprovalLifetime = 'once';
    // Record the human's scoped grant so the same call stops re-prompting.
    if (decision.type === 'approve' && grant) {
      lifetime = this.recordApproval(grant, decision.scope ?? 'once');
    }
    // §6 — and the mirror: *always reject* records the refusal, so the next identical call is
    // refused by rule at step (1) without reaching a person. [[EXT-107]] — at the scope the surface
    // asked for, which for every escalation menu's `[d]` is `always`; the lifetime that LANDS is
    // `recordDenial`'s to decide and to report.
    if (decision.type === 'reject' && decision.scope !== undefined && denyEntry) {
      lifetime = this.recordDenial(denyEntry, decision.scope);
    }
    return this.reportOutcome(pending, decision, lifetime);
  }

  /**
   * [[EXT-150]] — tell the surface what its own answer landed as, and hand the decision straight
   * back.
   *
   * A one-liner returning the decision, exactly as {@link stage} is, and for the identical reason:
   * the report happens ON the return that carries the decision rather than on the line above it, so
   * no early return can later be inserted between the two and leave a surface waiting for an answer
   * that never comes. There is one return out of {@link decideToolApprovalInner} after the callback
   * is awaited, and this is it.
   */
  private reportOutcome(
    pending: PendingToolInterrupt,
    decision: ToolApprovalDecision,
    lifetime: ApprovalLifetime
  ): ToolApprovalDecision {
    this.approvalOutcomeCallback?.({ pending, decision: decision.type, lifetime });
    return decision;
  }

  /**
   * [[TUI-C27]] — attribute the deciding stage and hand the decision straight back.
   *
   * A one-liner so a stage can be recorded ON the `return` that carries it rather than on the line
   * above: two statements let an early return be added between them, and the record would then name
   * a stage that did not decide.
   */
  private stage(
    record: ApprovalDecisionCapture,
    stage: ApprovalDecidingStage,
    decision: ToolApprovalDecision
  ): ToolApprovalDecision {
    record.stage = stage;
    return decision;
  }

  /**
   * One rating call, with EXT-66's timeout reporting attached. Extracted so the §3.2 tripwire (a
   * rated allow match) and the ordinary rater path cannot drift apart in WHAT they hand the rater —
   * only in what they do with the answer.
   */
  private async rateCommand(
    command: string,
    opts: {
      allowMatched: boolean;
      /** [[EXT-29]] §5.2 — whether the rejection will be handed back to the agent. */
      negotiable?: boolean;
      /**
       * [[EXT-106]] §4.6 — whether §4.6's open-world floor was lifted on this command because the
       * user named every host in it themselves. Never set on the tripwire path: an allow match
       * already lifts that floor by its own rule (§4.6's fourth bullet), so there is no carve to
       * report and nothing in the prompt to correct.
       */
      carved?: boolean;
    },
    /** [[TUI-C27]] — the decision's record; the rating attaches itself to it at the send site. */
    record: ApprovalDecisionCapture
  ): Promise<ShellSafetyVerdict> {
    const approvals = this.sessionApprovals;
    const verdict = await rateShellCommand(command, this.config as GthConfig, {
      home: env?.HOME,
      negotiable: opts.negotiable,
      carved: opts.carved,
      // [[TUI-C27]] — the sink fires BEFORE the model is invoked, with the prompt that is about to
      // be sent, so the record carries what the rater was SHOWN rather than a later re-render of
      // it. Assigning it here (rather than pushing a finished record afterwards) is what makes a
      // hung, timed-out or halting call still leave the question behind.
      onCapture: (capture) => {
        record.rating = capture;
      },
      raterProfile: approvals.rater,
      // The profile's model when one is configured; undefined lets rateShellCommand use the
      // session model. `init` throws rather than leaving this undefined for a NAMED profile, so
      // a configured profile can never silently degrade to the session model here.
      model: this.raterModel,
      // EXT-58 (§4.4) — the already-granted built-ins of the CURRENT rung, so a non-`safe`
      // outcome can name one the model could call for free instead. Computed per rating rather
      // than cached at init, because `/approvals <rung>` moves the rung mid-session and a stale
      // list would offer a tool that is no longer granted.
      grantedTools: this.getGrantedBuiltInTools(),
      // EXT-66 — the user-owned budget for ONE rating call, `undefined` when unset so
      // rateShellCommand applies RATER_DEFAULT_TIMEOUT_MS. 30s is a hosted-model number and a
      // local rater is knowably slower; without this a local `auto` session drifts toward
      // escalating everything, which is the failure the rung exists to prevent.
      timeoutMs: approvals.raterTimeoutMs,
    });
    // EXT-66 — a timeout is the gate giving up, not a judgement, and the two were previously
    // indistinguishable in the action column. Say it once per occurrence: the only symptom
    // otherwise is the gate becoming mysteriously more talkative, which reads as the rater
    // working rather than as the rater never being heard from.
    if (isRaterTimeout(verdict)) {
      this.raterTimeouts += 1;
      this.statusUpdate(
        StatusLevel.WARNING,
        `The command safety rater did not answer in time (${
          approvals.raterTimeoutMs ?? RATER_DEFAULT_TIMEOUT_MS
        }ms), so this command ` +
          // §3.2 — on an allow match the rating is a tripwire, so a timeout does not escalate: the
          // human's standing grant still stands and the call runs. Saying "escalated" there would
          // be simply false, and a notice that misreports the action it accompanies is worse than
          // none.
          (opts.allowMatched
            ? 'ran on its approvals.allow match alone, without the rating that entry asked for'
            : 'was escalated without being rated') +
          (this.raterTimeouts > 1 ? ` — ${this.raterTimeouts} times this session` : '') +
          '. Raise approvals.raterTimeoutMs if the rater is a local model.'
      );
    }
    // [[EXT-82]] — the RATE, not the call. EXT-66's notice above explains ONE occurrence and says
    // nothing about a session in which the rater never answers at all; this one says that, once,
    // and the tracker is what makes it a rate rather than a latch. The inputs come from the call's
    // own capture rather than from the verdict's wording: the rater is itself instructed to say it
    // could not assess a command, so a reason-prefix test would count a model that obeyed as a gate
    // that failed.
    const rating = record.rating;
    if (rating) {
      const signal = this.raterHealth.record({
        failClosed: rating.failClosed,
        failure: rating.providerError,
        model: rating.model,
        // §3.2 — an allow match already decided this call, so a failed tripwire rating did not make
        // a verdict default and must not be counted as though it had.
        countsTowardRate: !opts.allowMatched,
      });
      if (signal) this.statusUpdate(StatusLevel.WARNING, signal);
    }
    return verdict;
  }

  /**
   * [[EXT-127]] — **one alignment check**, with the `user` role fed from the settled provenance
   * channel and nothing else.
   *
   * **`provenance` is `ShellNegotiationState.retainedUserMessages()`, read ONCE by the caller and
   * handed down**, exactly as §4.6's floor reads it. Three things are true of it and only of it: it
   * is EMPTY until `admitUserProvenance` positively established that this session's human turns are
   * the user's own words (so `review` and `pr`, which fold a fetched diff into a human message,
   * contribute nothing); it is not `noteUserMessages`' raw store, which answers a different question
   * for a different reader; and it is not `humanMessageTexts`, the unfiltered upstream. Reading any
   * of the other three here would make the one place this design says provenance is structural the
   * one place it is not.
   *
   * The prior rounds come from the transcript's own alignment decisions, so the checker meets its
   * earlier turns as its own turns rather than as a quoted summary of them.
   */
  private async checkAlignment(
    subject: AlignmentSubject,
    provenance: readonly string[],
    record: ApprovalDecisionCapture
  ): Promise<AlignmentDecision> {
    const approvals = this.sessionApprovals;
    return await runAlignmentCheck(subject, this.config as GthConfig, {
      // The checker's own model when a profile resolved one; `undefined` falls back to the session
      // model, exactly as the classifier's does.
      model: this.alignmentCheckerModel,
      userMessages: provenance,
      priorRounds: this.negotiation.alignmentRounds(),
      home: env?.HOME,
      // ONE budget for ONE gate decision. There is deliberately no second timeout: `raterTimeoutMs`
      // is what the user owns, and a check is one call.
      timeoutMs: approvals.raterTimeoutMs,
      ...(approvals.alignmentChecker ? { profile: approvals.alignmentChecker } : {}),
      onCapture: (capture) => {
        record.alignment = capture;
      },
    });
  }

  /**
   * EXT-58 (§4.3/§4.4) — the built-in tools already granted at the session's CURRENT rung, as
   * names plus one-line locally-authored descriptions, for the rater prompt.
   *
   * Two filters make this safe to place outside the rater's fenced untrusted block:
   * - the names come from what the agent actually registered
   *   ({@link GthAgentInterface.getRegisteredToolNames}), so the rater can only ever offer a tool
   *   this session has;
   * - the descriptions come from core's own `BUILT_IN_TOOL_SUMMARIES` table, so no MCP, custom or
   *   A2A tool's own (attacker-influenceable) description can reach the prompt.
   *
   * Empty when the agent does not expose its tools — the rater then gets no list and, per the
   * prompt, offers nothing.
   */
  private getGrantedBuiltInTools(): GrantedToolSummary[] {
    const registered = this.agent?.getRegisteredToolNames?.() ?? [];
    if (registered.length === 0) return [];
    // The LIVE gated set, from the SAME shared policy `decideToolApproval` decides on and the
    // agent derives its interrupt from, so "granted" here means exactly what it means at
    // tool-registration time (§4.5) and at the gate.
    //
    // EXT-80 makes this non-drift property load-bearing rather than incidental. At `manual` the
    // write built-ins are gated, so they are NOT granted, and a summary still offering `write_file`
    // there would tell the model a tool is free while the gate stops and asks for it — the rater
    // suggesting the one thing guaranteed to interrupt the user. It is computed per rating from
    // `sessionApprovals.rung`, so it follows a mid-session `/approvals` change — unlike the
    // interrupt set, which is fixed when the graph is built and is rung-independent for exactly
    // that reason.
    const { gateShell } = resolveShellApprovalGate(this.config ?? undefined, this.command);
    const gatedTools = resolveGatedToolNames({
      rung: this.sessionApprovals.rung,
      gateShell,
      boundToolNames: registered,
    });
    return describeGrantedBuiltInTools(registered, this.sessionApprovals.rung, gatedTools);
  }

  /**
   * §3/§3.3 — the three rule lists this session decides by: the DECLARED entries from config
   * (read-only input) concatenated with the runtime grants the escalation menu made. One set of
   * lists, handed to the one comparison engine; the concatenation cannot change any outcome
   * because `resolveApprovalRules` consults every deny entry before any escalate entry and every
   * escalate entry before any allow entry.
   *
   * The persisted store is loaded here rather than at {@link init} — lazily, once per instance, and
   * NEVER at `bypass`, where the allow list is moot and a session that has switched the gate off
   * should not be reading or rewriting the project's grant file.
   */
  private approvalRuleLists(): ApprovalRuleLists {
    const approvals = this.sessionApprovals;
    const persisted = approvals.rung === 'bypass' ? null : this.getPersistedGrants();
    return {
      // [[EXT-107]] — three sources of refusal, and the persisted one is read at EVERY rung,
      // `bypass` included. That is not an oversight of the allow side's guard, it is the opposite
      // of it: deny is resolved at step (1) of `decideToolApprovalInner`, *before* the `bypass`
      // return, so a saved refusal that switched itself off at `bypass` would be a promise the file
      // stops keeping the moment someone relaxes the gate — the one direction this design never
      // fails in. Reading it there is also side-effect-free: the deny store runs no migration, so
      // its load never writes (see `PersistedApprovalGrantsOptions.legacyPrefixMigration`).
      //
      // Concatenation order decides nothing about deny-vs-allow — `resolveApprovalRules` consults
      // the whole deny list before any allow entry — so a command matching a saved allow AND a
      // saved deny is refused, whichever file was written first.
      deny: [
        ...approvals.deny,
        ...this.denyGrants.entries(),
        ...(this.getPersistedDenials()?.entries() ?? []),
      ],
      escalate: approvals.escalate,
      allow: [...approvals.allow, ...this.sessionGrants.entries(), ...(persisted?.entries() ?? [])],
    };
  }

  /**
   * Lazily load (once per instance) the persisted `always` grant store.
   *
   * CFG-27 removed the `persistAllowlist` switch: §3 makes persistence a per-decision choice in
   * the escalation menu (`approve` forgets, `always approve` persists), and a global "never
   * persist" setting would only duplicate a keystroke. Returns null when the store cannot be
   * loaded at all, in which case `always` grants degrade to `session` (in-memory only).
   *
   * The v1→v2 migration notice is routed to `statusUpdate` from here, which is the only place that
   * knows how to reach the user.
   */
  private getPersistedGrants(): PersistedApprovalGrants | null {
    if (this.persistedGrantsLoaded) return this.persistedGrants;
    this.persistedGrantsLoaded = true;
    try {
      const filePath = getGslothConfigWritePath(SHELL_ALLOWLIST_FILE);
      this.persistedGrants = new PersistedApprovalGrants(filePath, {
        onNotice: (notice) => this.statusUpdate(notice.level, notice.message),
        // [[EXT-143]] — the word a load-failure notice uses for what this file holds. The store is
        // list-agnostic and stays so; only the message needs to know, and only the caller can say.
        holds: 'approvals',
      });
    } catch (e) {
      // Path/IO failure → behave as no persisted store (still safe: just prompts more).
      debugLogError('Loading persisted shell approvals', e);
      this.persistedGrants = null;
    }
    return this.persistedGrants;
  }

  /**
   * [[EXT-107]] — lazily load (once per instance) the persisted **refusal** store, the mirror of
   * {@link getPersistedGrants}. Returns null when it cannot be loaded at all, in which case an
   * `always` refusal degrades to `session`.
   *
   * **No `bypass` guard, and no v1 migration**, and the two are the same decision. The allow side
   * skips the file at `bypass` so a session with the gate switched off neither reads nor *rewrites*
   * the project's grants; the only thing that rewrites on load is the v1 `prefixes` migration, and
   * turning it off here makes this store's load a pure read. That is what lets it be consulted at
   * every rung — which it must be, because a refusal is resolved before the `bypass` return and a
   * saved refusal that lapsed when the gate was relaxed would be worthless.
   *
   * It is also loaded by the `/approvals` DISPLAY, unlike its allow-side twin. The rule there — a
   * display must not create the store in order to show it — is a rule about writing, and this load
   * cannot write. The reason to break the symmetry is that the display is the escape hatch: a saved
   * refusal a user cannot see is one they cannot lift, and a fresh session has made no gated call
   * yet.
   */
  private getPersistedDenials(): PersistedApprovalGrants | null {
    if (this.persistedDenialsLoaded) return this.persistedDenials;
    this.persistedDenialsLoaded = true;
    try {
      const filePath = getGslothConfigWritePath(SHELL_DENYLIST_FILE);
      this.persistedDenials = new PersistedApprovalGrants(filePath, {
        onNotice: (notice) => this.statusUpdate(notice.level, notice.message),
        legacyPrefixMigration: false,
        // [[EXT-143]] — the mirror of the allow store's word, and the reason the store takes one at
        // all: a broken deny file loses refusals, and a message that said "approvals" would name
        // the wrong loss in the one place the user has to act on it.
        holds: 'refusals',
      });
    } catch (e) {
      // Path/IO failure → behave as no persisted refusals. This one is NOT safe in the way the
      // allow side's failure is: it loses refusals rather than approvals, so nothing here refuses
      // any more and the call falls to whatever else covers it — a prompt at most rungs, and no
      // prompt at all at `bypass` or under a matching allow entry, where it simply runs. It still
      // degrades rather than ending the run, and [[EXT-143]]'s notice is what makes it visible.
      debugLogError('Loading persisted shell refusals', e);
      this.persistedDenials = null;
    }
    return this.persistedDenials;
  }

  /**
   * §3.1/§4.7.4/§6 — **the grant a sticky choice would write for this call**, or `undefined` when
   * none is on offer. The one place that question is answered, so the menu's *this is what will be
   * stored* line (§6) and the store can never disagree.
   *
   * - **A shell call** records the command itself as an `exact` entry (§3.1) — never a prefix,
   *   never a pattern. One that does not statically resolve (composition, substitution,
   *   redirection) is not on offer: no allow entry of any matcher matches such a command, so the
   *   entry would be inert, and an inert entry sitting in a list §3 requires to be inspectable
   *   tells the user something is in force when nothing is.
   * - **A tool call** records identity — the tool, its server, and the host where the call carries
   *   one (§4.7.4, {@link toolGrantEntry}) — never arguments, which would produce a grant that
   *   never matches twice. A call naming no host records the tool alone, which is §6's own example
   *   (*always approve `mcp__jira__create_issue`*, where no host is involved); what keeps that from
   *   being unbounded is §3.2's default that a tool entry is still `rate: true`, so the rater goes
   *   on seeing every call's full arguments.
   *
   * Four cases have **no grant on offer at all**, each fail-closed:
   *
   * 1. **`bypass`** — the gate is off for this session and nothing is remembered from it.
   * 2. **`run_shell_command` arriving as a tool subject.** That is what a shell call with no
   *    readable `command` argument presents as, and it names no host, so without this it would take
   *    the tool-only arm and write a `{"type":"tool","pattern":"run_shell_command"}` grant that
   *    auto-approves every future call whose command cannot even be read. This exclusion is what
   *    stops that, not a side effect of anything else, and it must survive [[EXT-30]] widening the
   *    gate.
   * 3. **A call naming more than one distinct host.** The grammar has no entry for it. `host` is a
   *    single optional string on every tool arm of `approvalEntrySchema`, and every arm is a
   *    `z.strictObject`, so recording the *set* is not a policy this code may choose — a `hosts`
   *    array is an unrecognized-key error, and writing one would be a §3.1 grammar change. Of the
   *    two entries that would parse, the host-bound one displays a bound the grant does not have,
   *    which §6 forbids (the menu shows exactly what will be stored). And a grammar that did record
   *    the set, matching only when all of it recurred, would fail §4.7.4's opening test anyway: a
   *    tool whose host set varies per call would get a grant that never matches a second time — not
   *    a narrower grant, the useless one §4.7.4 rejects by name.
   *
   *    **What this arm does not claim.** It is not a narrowing. A hostless entry imposes no host
   *    condition at all (`resolveApprovalRules`), so the tool-only grant that any host-less call to
   *    the same tool produces already auto-approves a multi-host one. Refusing here withholds a
   *    grant; it does not close a hole, and the reason to keep it is the grammar above rather than
   *    any breadth it prevents. Asserted, so this cannot drift back into a claim the system does not
   *    support.
   * 4. **An MCP call whose server could not be resolved** ({@link toolGrantEntry} returns `null`) —
   *    a call nobody can attribute is not one anything can remember.
   */
  private stickyGrantFor(
    subject: ApprovalSubject,
    effective: EffectiveToolAnnotations | undefined,
    hosts: readonly string[]
  ): Omit<ApprovalGrant, 'grantedAt' | 'scope'> | undefined {
    if (this.sessionApprovals.rung === 'bypass') return undefined;
    if (subject.kind === 'shell') {
      const entry = shellApprovalEntryFor(subject.command);
      return entry ? { entry } : undefined;
    }
    if (subject.name === SHELL_TOOL_NAME) return undefined;
    // A snapshot is what invalidation compares against, so a grant with no readable effective set
    // is a grant nothing could ever invalidate.
    if (!effective) return undefined;
    if (hosts.length > 1) return undefined;
    const entry = toolGrantEntry(subject);
    if (!entry) return undefined;
    // §4.7.4 — the effective set the human approved this tool AS. `annotationWeakenings` compares a
    // later one against it, and the store copies it so the record is private to this grant.
    return { entry, annotations: effective };
  }

  /**
   * [[TUI-C26]] §6 — **the entry the escalation menu's *always reject* choice would record**, or
   * `undefined` when the grammar cannot hold one. The deny mirror of {@link stickyGrantFor}, and a
   * separate function rather than a flag on it, because the two answer different questions.
   *
   * **Nearly every reason an allow entry is withheld does not apply here.** §3 has one rule for
   * this and it runs the other way — *undecidable is a non-match on the allow side and a match on
   * the deny side* — so:
   *
   * - **A command that does not statically resolve gets an entry.** `stickyGrantFor` refuses one
   *   because no allow entry of any matcher would ever match it, making the entry inert; a deny
   *   entry for the same command is matched against the whole normalized command *and* every
   *   segment a shell would run, so it is the opposite of inert.
   * - **A `catastrophic` verdict changes nothing.** §4.2 withdraws the sticky grants there; it says
   *   nothing about refusals, and refusing more is never the direction that needs withdrawing.
   * - **`bypass` changes nothing either**, and that is a positive statement rather than a gap. Deny
   *   is resolved at step (1) of {@link decideToolApprovalInner}, *before* the `bypass` return, so
   *   a recorded refusal is in force at every rung — which is why this does not copy the allow
   *   side's `bypass` guard.
   * - **A call naming several hosts gets the host-less entry.** On the allow side that would show a
   *   bound the grant does not have; here the entry covers every host of that tool, which is
   *   broader than the call and safe in the direction breadth is safe. The menu shows exactly that
   *   entry, so the breadth is on screen rather than inferred.
   * - **`run_shell_command` arriving as a TOOL subject gets a tool entry** — a shell call whose
   *   `command` argument cannot even be read. On the allow side that entry would auto-approve every
   *   future unreadable shell call, which is why it is excluded there; as a refusal it stops the
   *   shell tool outright, and the dialog says so in the words the entry is written in.
   *
   * The one genuine exclusion is an **MCP call whose server could not be attributed**
   * ({@link toolGrantEntry} returns `null`): the grammar's `server` cannot be the empty string, so
   * the entry would be dropped by its own validator and the human would be told a refusal had been
   * recorded when none was. A shell command that normalizes to nothing is excluded for the same
   * reason — an empty `pattern` is not a legal entry.
   */
  private denyEntryFor(subject: ApprovalSubject): ApprovalEntry | undefined {
    if (subject.kind === 'shell') {
      const entry = shellGrantEntry(subject.command);
      return entry.pattern.length > 0 ? entry : undefined;
    }
    return toolGrantEntry(subject) ?? undefined;
  }

  /**
   * §6/[[EXT-107]] — record the menu's *always reject* choice at the given scope. `once` remembers
   * nothing; `session` holds the refusal for the life of this runner instance; `always` additionally
   * writes it to the project's deny file, so it is still in force after a restart.
   *
   * It lands in the same lists `approvals.deny` entries are matched from ({@link approvalRuleLists}
   * concatenates the three), so a refusal the human made at the prompt and one they wrote in their
   * config are one list to the matcher.
   *
   * **The recorded scope is derived from whether the entry REACHED THE FILE** ([[EXT-149]]) — what
   * {@link PersistedApprovalGrants.add} returns — and not from whether the store was allowed to try.
   * Those differ on a read-only checkout, where the file is simply absent, so the load did not fail,
   * `canPersist()` is true, and every write throws: asking permission stamped `always` on an answer
   * that reached no disk, and nothing told the user. **Do not describe that gap's cost as "one
   * re-prompt next session":** the entry is not on disk, so next session it applies to nothing and
   * the call is left to the rest of the gate — another rule may refuse it, it may be prompted for,
   * or it may run without asking under `bypass` or a matching saved allow.
   *
   * **Two records, not one patched afterwards.** {@link ApprovalGrantStore.add} holds the very
   * object it is handed whenever the grant carries no annotation snapshot — which every refusal
   * does, since {@link denyEntryFor} builds an entry and never a snapshot — so stamping one object
   * `always` and correcting it after the write would reach inside whatever {@link denyGrants}
   * already holds and whatever the display renders from it. The persisted store is handed the
   * `always` record it will hold if the write lands (and takes back if it does not); the session
   * store is handed its own record, stamped from the answer.
   *
   * The persisted store is still told even when it cannot write, because telling it is what reports
   * the refused or failed write to the user, and it declines to hold what it did not write.
   *
   * **It RETURNS the lifetime it recorded** ([[EXT-150]]) — the same value it stamps the record with,
   * handed back rather than left for a caller to re-derive. The surface that asked has to say what
   * happened, and re-deriving it there would put the "did the write land" question in two places
   * that could come to disagree, which is the whole failure this and [[EXT-149]] are about.
   */
  private recordDenial(entry: ApprovalEntry, scope: ToolRejectScope): ApprovalLifetime {
    if (scope === 'once') return 'once';
    const persisted = scope === 'always' ? this.getPersistedDenials() : null;
    const grantedAt = new Date().toISOString();
    const saved = persisted?.add({ entry, grantedAt, scope: 'always' }) ?? false;
    const landed: ApprovalGrantScope = saved ? 'always' : 'session';
    // Both stores, exactly as `recordApproval` writes both: the in-memory copy is what keeps the
    // refusal in force for this run even when the file cannot be written, and the display
    // de-duplicates by entry identity.
    this.denyGrants.add({ entry, grantedAt, scope: landed });
    return landed;
  }

  /**
   * §3.1/§6 — record a human-granted approval at the given scope. `once` remembers nothing.
   * `session` adds the entry to the in-memory store; `always` additionally persists it (falling
   * back to session-only when the file cannot be written).
   *
   * What is recorded was decided by {@link stickyGrantFor} and shown to the human before they
   * answered; this only stamps it with when and at what scope.
   *
   * **The stamped scope says whether this grant REACHED THE FILE**, the mirror of
   * {@link recordDenial} and derived the same way ([[EXT-149]]): an `always` whose store is absent,
   * whose file could not be read and so must not be rewritten ([[EXT-144]]), or whose write threw on
   * a checkout nothing can write, is recorded as the `session` grant it actually is — and the store
   * reports the last of those rather than swallowing it.
   *
   * Two records rather than one patched afterwards, for the reason argued in {@link recordDenial}:
   * {@link ApprovalGrantStore.add} holds the object it is handed for a grant with no annotation
   * snapshot — every shell grant — so a scope corrected after the write would be corrected inside
   * {@link sessionGrants}.
   *
   * The store is still loaded only for `always`, unchanged: a display must not create the file in
   * order to show it, and a `session` grant has no business opening it.
   *
   * **It RETURNS the lifetime it recorded** ([[EXT-150]]), the mirror of {@link recordDenial} and for
   * the same reason: the surface's confirmation is written from this value rather than from the key
   * the human pressed.
   */
  private recordApproval(
    grant: Omit<ApprovalGrant, 'grantedAt' | 'scope'>,
    scope: ToolApprovalScope
  ): ApprovalLifetime {
    if (scope === 'once') return 'once';
    const persisted = scope === 'always' ? this.getPersistedGrants() : null;
    const grantedAt = new Date().toISOString();
    const saved = persisted?.add({ ...grant, grantedAt, scope: 'always' }) ?? false;
    const grantScope: ApprovalGrantScope = saved ? 'always' : 'session';
    this.sessionGrants.add({ ...grant, grantedAt, scope: grantScope });
    return grantScope;
  }

  /**
   * §4.7.4 — **drop a tool grant the tool has since weakened out from under, with a notice naming
   * the tool, the server and the hint that moved.**
   *
   * The human approved a tool *as annotated*; a tool that re-annotates itself into a more dangerous
   * shape is a different proposition wearing the same name, so the grant is invalidated and the next
   * call prompts again. Only a **trusted** server can produce a weakening — an untrusted server's
   * effective set is the constant fail-closed default (§4.7.1) and cannot move — which is exactly
   * where it matters, since the trusted server is the one whose rug-pull would otherwise ride an
   * existing grant.
   *
   * **Scoped to the call being decided, never a sweep of the store.** A sweep would read every held
   * grant against a source that can only answer for the tools registered right now, so a server that
   * happened to be offline would read as having weakened everything it ever declared — and the
   * grants would be deleted for it.
   *
   * **The scope is every grant that could auto-approve THIS call, which is at most two.** A grant
   * with no `host` imposes no host condition, so it matches a call that carries one; looking up only
   * the entry this call would grant (`host` included) would miss the tool-only grant that is about
   * to auto-approve it, and the weakening would ride straight through — the exact failure §4.7.4
   * exists to stop. The host-bound entry of a DIFFERENT host is deliberately not a candidate: it
   * does not match this call either, so this call's annotations say nothing about it.
   *
   * **Only allow-side grants.** A weakening makes a tool more dangerous, so dropping an *always
   * reject* over one would be the unsafe direction: the reason to withdraw an approval is the reason
   * to keep a refusal.
   */
  private invalidateWeakenedGrants(
    subject: ToolApprovalSubject | McpToolApprovalSubject,
    effective: EffectiveToolAnnotations
  ): void {
    const candidates = [
      toolGrantEntry(subject),
      ...(subject.host !== undefined ? [toolGrantEntry({ ...subject, host: undefined })] : []),
    ].filter((entry) => entry !== null);
    if (candidates.length === 0) return;
    // Never at `bypass`, for the same reason `approvalRuleLists` does not read the file there: a
    // session that has switched the gate off should not be rewriting the project's grant file.
    const persisted = this.sessionApprovals.rung === 'bypass' ? null : this.getPersistedGrants();
    for (const entry of candidates) {
      // The session store wins, and a session grant with no snapshot therefore hides a persisted one
      // that has one. Safe only because all three of these hold, and each is a premise a later change
      // could break silently: (1) every tool grant this runner writes carries a snapshot — a call with
      // no readable effective set is refused a grant at all ({@link stickyGrantFor}); (2) a `shell`
      // subject, the one kind whose grant has no snapshot by design, never reaches this method; and
      // (3) a persisted grant already in force auto-approves the call, so no prompt happens and no
      // session grant is written over it. Break any one of them and this line starts skipping a
      // weakening it should have caught — check both stores then, rather than the first that answers.
      const held = this.sessionGrants.find(entry) ?? persisted?.find(entry);
      if (!held?.annotations) continue;
      const weakened = annotationWeakenings(held.annotations, effective);
      if (weakened.length === 0) continue;
      // Removed rather than skipped: the stores de-duplicate by entry identity, so a grant left in
      // place would silently swallow the human's re-approval of the same tool.
      this.sessionGrants.remove(entry);
      persisted?.remove(entry);
      this.statusUpdate(
        StatusLevel.WARNING,
        describeWeakenedGrant(entry, weakened, held.annotations, effective)
      );
    }
  }

  /**
   * Event-stream counterpart to {@link processMessages}: drives the agent's typed
   * {@link AgentStreamEvent} path using the runner's own thread-bound `runConfig`, so a
   * renderer (the Ink TUI) can present the same run the readline path renders via
   * `consoleUtils` while sharing the checkpointer thread for cross-turn memory.
   *
   * Cancellation is via the supplied `signal` (the TUI's Esc → `AbortController`); the
   * underlying `streamWithEvents` ends cleanly on abort or `interrupt()`. The string
   * path's empty-stream retry/`invoke` fallback is intentionally NOT duplicated here — the
   * TUI renders the live event stream directly; revisit if empty-stream retries are needed.
   *
   * Tool-approval round-trip (EXT-11): after the stream ends, a gated `run_shell_command`
   * leaves the graph suspended on a `humanInTheLoopMiddleware` interrupt rather than
   * completing. This is the event-stream counterpart to the readline path's
   * {@link resolveToolInterrupts}: it drains any pending interrupts through
   * {@link decideToolApproval} (bypass → allow-list → rater → bridged human prompt), resumes via
   * `streamWithEventsResume({ decisions })`, and loops until the graph completes with no
   * pending interrupts — so the executed command's output renders into the TUI. Without
   * this the TUI silently finalized an empty turn (approval gate was dead code on the
   * event-stream path).
   */
  async *processMessagesWithEvents(
    messages: Message[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    // GS2-16: start this turn's analytics tally from zero (the runner is reused across turns).
    this.resetRunStats();
    // [[EXT-159]] — the previous turn's termination reason goes with the previous turn's tally.
    this.resetTerminationReason();
    // GS2-48 — record this turn's transcript tail for the crash handler.
    updateCrashContext({ transcriptTail: messages.slice(-CRASH_TRANSCRIPT_TAIL_MESSAGES) });
    // [[EXT-29]] §5 — a new user turn is the human being reached, so it ends any negotiation still
    // standing from the previous one and clears BOTH bounds. The turn's own messages then enter
    // §5.1's last-5 window, which is what makes "just the last two" reach the rater at all — the
    // reply that narrows what the agent proposes is worthless to the gate if only the agent hears it.
    this.endNegotiation();
    // [[TUI-C69]] §5.4 — and the tone hints go with it. The ids matter only while the results
    // carrying them are on screen; the previous turn's are spent, and an id that outlived its turn
    // could only ever mis-tone a later row.
    this.clearRaterClarifications();
    this.negotiation.noteUserMessages(humanMessageTexts(messages));
    debugLog('Processing messages (event stream)...');
    debugLogObject('Input Messages', messages);
    this.turnsInFlight++;
    try {
      // [[TUI-C100]] — **a tool call that never produced a result is closed here, and nowhere
      // earlier.** `processEventStream` ends a call when its own result arrives and otherwise
      // leaves it open, because from inside a stream a call suspended at the approval gate looks
      // exactly like a terminal one: the graph interrupts, the stream returns, and the calls it
      // announced are still outstanding either way. The two only part company at THIS level — the
      // prompt is opened by `resolveToolInterruptsWithEvents` below, after the first stream has
      // finished — so closing anything before that point would tell the surface a call had
      // finished while the human was still being asked whether it may run at all.
      //
      // **Membership in this set at the drain IS "produced no result".** A call is forgotten on its
      // own `tool_end` or its own `tool_result`, and a call that actually ran always yields the
      // latter from its `ToolMessage` — so nothing that survives to the loop below has a result,
      // whatever the reason. The reasons are several and the surface cannot tell most of them
      // apart: the turn was abandoned; a refusal made the middleware jump back to the model and the
      // whole round's tool node was skipped; the call was terminal. They do not differ in the one
      // thing a row reports, so they are closed alike — as a call with no result, which is what an
      // error result says, and never with the tick and the word `done`, which no arm of this loop
      // could make true.
      const unendedToolCalls = new Set<string>();
      // [[EXT-159]] — did this turn produce an ANSWER? Grammar member (2), "the model produced
      // nothing", had two sites on the string path and none here, so an empty typed-event turn —
      // the node's own motivating symptom, on the surface users actually watch — reported
      // `completed`, i.e. a legitimate hand-back.
      //
      // `text` is the exact analogue of the string path's `result.trim().length === 0`: that path
      // enqueues only `answerTextOf(chunk.content)`, which drops reasoning segments, and this path
      // splits the same segments into `text` (answer) and `reasoning_delta` (not the answer). So a
      // reasoning-only turn is empty on BOTH surfaces, and they cannot disagree about one turn.
      // Testing each delta rather than the concatenation is equivalent: if every delta is blank
      // their join is blank, and one non-blank delta makes the join non-blank.
      //
      // This is CLASSIFICATION only. The string path's empty-stream retry / `invoke` fallback is
      // still deliberately not duplicated here (see this method's docblock) — naming what happened
      // is not fixing it.
      let sawAnswerText = false;
      const tracking = async function* (
        source: AsyncGenerator<AgentStreamEvent>
      ): AsyncGenerator<AgentStreamEvent> {
        for await (const event of source) {
          if (event.type === 'tool_start') unendedToolCalls.add(event.id);
          else if (event.type === 'tool_end' || event.type === 'tool_result')
            unendedToolCalls.delete(event.id);
          else if (event.type === 'text' && event.delta.trim().length > 0) sawAnswerText = true;
          yield event;
        }
      };
      yield* tracking(this.agent.streamWithEvents(messages, this.runConfig, signal));
      yield* tracking(this.resolveToolInterruptsWithEvents(signal));
      // The abort is the one case that IS distinguishable here, and it buys the wording rather than
      // a different outcome: a turn stopped part-way may have had a call in flight, so this says
      // what is certain — no result arrived — without claiming the command never started.
      const noResult = signal?.aborted
        ? 'Cancelled before this call produced a result.'
        : 'This call did not run.';
      // Deliberately at the end of the `try` rather than in the `finally`. Esc does NOT break out
      // of the consumer's loop — it aborts the signal, `streamWithEvents` catches the `AbortError`
      // and returns cleanly, and `resolveToolInterruptsWithEvents` returns at its own aborted
      // guard, so an abandoned turn reaches this line like any other and its rows are closed here
      // too. The case the placement is actually for is a consumer that stops consuming: breaking
      // out of a `for await`, or calling `return()` on this generator, closes it, and yielding
      // during that forced return suspends the generator again instead of finishing it — which
      // would leave `clearNegotiationDisplay()` below unreached. Rows abandoned that way keep
      // whatever they last said, which is the price of the `finally` still running.
      //
      // A close is not cosmetic either way: an unclosed row on the TUI sits at `running` for the
      // rest of the session, and a client is owed a terminal state for every call it was shown.
      for (const id of unendedToolCalls) {
        yield { type: 'tool_result', id, content: noResult, isError: true };
      }
      // [[EXT-159]] — the typed-event turn reached its own end. `signal?.aborted` is read again
      // rather than reused from `noResult` above because a turn can be cancelled with no tool call
      // outstanding, and that turn owes a reason just as much. First-write-wins keeps whatever the
      // agent's own sites already said (a refusal, a suspend, an earlier abort).
      if (signal?.aborted) {
        this.noteTermination(
          terminationReason('runner.events-cancelled', 'control', {
            category: 'cancelled',
            detail: 'signal',
          })
        );
      } else if (!sawAnswerText) {
        // A turn that ended having said nothing did NOT complete, and saying it did is worse than
        // saying nothing: this design defines an ABSENT reason as "a site we missed", and a
        // present-but-false one silences that detector at the one case it was built for.
        this.noteTermination(terminationReason('runner.events-empty', 'control', 'empty_response'));
      } else {
        this.noteCompleted('runner.events-completed');
      }
    } catch (error) {
      // [[EXT-159]] — the typed-event path had NO catch at all, so a provider fault on the surface
      // most users are looking at was the one termination nothing classified. Re-thrown UNCHANGED:
      // this site adds a reason and takes nothing away, and the consumer's own error rendering is
      // not this node's business.
      this.classifyThrownAt('runner.events-error', error);
      throw error;
    } finally {
      // [[TUI-C69]] §5.4 — **the turn is over, so the argument is over.** Until this existed the
      // panel was cleared only by the NEXT turn's `endNegotiation`, so a negotiation that CONVERGED
      // — the case this node exists to make visible — left its rounds pinned in the non-scrolling
      // dock across exactly the idle period in which the user is trying to type into a prompt those
      // rows have pushed off the screen. An escalation cleared itself; success did not.
      //
      // Display-only: see {@link clearNegotiationDisplay}. The gate's transcript belongs to the
      // negotiation, not to the screen, and the next turn spends it on the human being reached.
      //
      // In `finally` because an abort and a thrown stream end the turn just as much as a return
      // does, and those are the paths where rows left standing are least likely to be noticed.
      this.clearNegotiationDisplay();
      // [[EXT-159]] — the one ending that reaches NEITHER the end of the try NOR the catch: a
      // consumer that stops consuming (breaking out of its `for await`, or calling `return()` on
      // this generator). Nothing was wrong with the run and nothing failed, so no other site can
      // speak for it, and without this the turn would end with no reason at all — the state that
      // must mean "a site we missed".
      this.noteTermination(terminationReason('runner.events-abandoned', 'control', 'abandoned'));
      this.turnsInFlight--;
    }
  }

  /**
   * Event-stream counterpart to {@link resolveToolInterrupts}: after a streamed run ends,
   * resolve any tool-approval interrupts it suspended on, yielding the resumed run's typed
   * {@link AgentStreamEvent}s so the renderer (the Ink TUI) shows the executed command's
   * output. Each pending tool call is consulted via {@link decideToolApproval} — the SAME
   * gate the readline path uses (bypass → allow-list approve → CFG-26 AI rater →
   * bridged human callback, defaulting to REJECT when no handler is wired) — and the
   * collected decisions are sent back via `streamWithEventsResume` as a LangChain HITL
   * resume (`{ decisions }`). Because a resumed run can suspend again on the next gated
   * tool call, this loops until the graph completes with no pending interrupts.
   *
   * No-ops (yields nothing) when the agent does not support interrupts
   * (`getPendingToolInterrupts`/`streamWithEventsResume` absent) — that is the only exemption.
   * As of EXT-52 the shipped agent gates `run_shell_command` and exposes the interrupt surface, so
   * the lean agent is exactly the agent this loop serves; only an agent implementation without
   * those methods (e.g. a test double) skips it. Aborts (`signal`) propagate through the
   * resumed stream.
   */
  private async *resolveToolInterruptsWithEvents(
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    const agent = this.agent;
    const runConfig = this.runConfig;
    if (!agent || !runConfig) return;
    if (!agent.getPendingToolInterrupts || !agent.streamWithEventsResume) return;

    // [[EXT-159]] — see {@link resolveToolInterrupts}: which way the loop left is the fact that
    // distinguishes this ending, and it is discarded unless the loop itself records it. An abort
    // `return`s below and never reaches the note, which is right — a cancelled turn was stopped by
    // the user, not by this bound.
    let drained = false;
    // Bound the loop defensively so a misbehaving graph that re-suspends forever cannot spin.
    for (let guard = 0; guard < 100; guard++) {
      if (signal?.aborted) return;
      const pending = await agent.getPendingToolInterrupts(runConfig);
      if (pending.length === 0) {
        drained = true;
        break;
      }

      const decisions: ToolApprovalDecision[] = [];
      for (const tool of pending) {
        decisions.push(await this.decideToolApproval(tool));
      }

      yield* agent.streamWithEventsResume({ decisions }, runConfig, [], signal);
    }
    if (!drained) {
      this.noteTermination(
        terminationReason(
          'runner.events-interrupt-guard-exhausted',
          'control',
          'interrupt_drain_guard'
        )
      );
    }
  }

  // noinspection JSUnusedGlobalSymbols
  public getAgent(): GthAgentInterface | null {
    return this.agent;
  }

  /**
   * GS2-16 — reset the current turn's analytics tally on both the live agent and the runner's
   * cached snapshot, so a new turn starts clean. Fail-soft (an agent without stats support is a
   * no-op). Called at the top of each `processMessages` / `processMessagesWithEvents`.
   */
  private resetRunStats(): void {
    this.lastRunStats = { tools: [] };
    try {
      this.agent?.resetRunStats?.();
    } catch {
      /* fail-soft: analytics must never affect a run */
    }
  }

  /**
   * [[EXT-159]] — forget the previous turn's termination reason, on both this runner and the live
   * agent, so a new turn starts with none. Called at the top of each `processMessages` /
   * `processMessagesWithEvents`, alongside {@link resetRunStats}. Fail-soft.
   */
  private resetTerminationReason(): void {
    this.terminationReason = null;
    this.agentTerminationReason = null;
    this.agentFinishReasons = [];
    try {
      this.agent?.resetTerminationReason?.();
    } catch {
      /* fail-soft: classification must never affect a run */
    }
  }

  /**
   * [[EXT-159]] — record why the turn ended, **first-write-wins**.
   *
   * The runner's two exception wrappers are NESTED, not alternatives: a stream fault is classified
   * at the inner one, re-thrown, and caught again by the outer one. Under last-write-wins the outer
   * site would overwrite the inner classification on every streamed failure — the funnel this
   * taxonomy replaces, rebuilt one level up.
   */
  private noteTermination(reason: GthTerminationReason): void {
    try {
      if (this.terminationReason) return;
      this.terminationReason = reason;
      // [[EXT-159]] — the debug log carried the wrapped error string and never the classification.
      // Written at the decision so it survives a session whose surface never got to ask, and so a
      // dump taken after a kill still holds it (the ring buffer behind `debugLog` is always on).
      debugLog(terminationLogLine(reason));
    } catch {
      /* fail-soft */
    }
  }

  /**
   * [[EXT-159]] — classify a thrown value at a runner site: record it here AND attach it to the
   * error, then hand the error back so the throw reads as one expression.
   *
   * Both carriers matter. The runner's own field serves a caller holding the runner; the attached
   * value serves every layer above that only ever sees the error — and neither is the message, so
   * no user-facing string is the only carrier of the classification.
   */
  private classifyThrownAt(site: GthTerminationSite, error: unknown): GthTerminationReason {
    // A reason already on the error was attached by an INNER site that saw the failure first, and
    // that one is the truer classification — so it is inherited rather than replaced, and the two
    // carriers cannot end up disagreeing about the same failure.
    const existing = terminationReasonOf(error);
    const reason =
      existing ?? terminationReason(site, 'exception', classifyThrownTermination(error));
    this.noteTermination(reason);
    if (!existing) attachTerminationReason(error, reason);
    return reason;
  }

  /**
   * [[EXT-159]] — classify an approvals stop, which the generic classifier cannot see.
   *
   * The gate's errors are typed by their own subclass names, and their prose is the explanation
   * rather than a diagnosis, so nothing in the exception classifier's grammar recognises one. It
   * does not need to: this site reaches an `instanceof ApprovalStopError` branch, so it *knows*
   * what ended the run, and stating the category is more honest than pattern-matching for it.
   */
  private noteApprovalStop(site: GthTerminationSite, error: unknown): void {
    const reason = terminationReason(site, 'control', {
      category: 'approval_stop',
      detail: error instanceof Error ? error.name : undefined,
    });
    this.noteTermination(reason);
    attachTerminationReason(error, reason);
  }

  /**
   * [[EXT-159]] — record that the turn ended because the model finished.
   *
   * An ordinary completion is a termination too, and recording it is what makes "no reason" mean
   * *a site nobody classified* rather than *nothing went wrong*. First-write-wins keeps a deeper
   * site's answer — a refusal or a truncation is what really ended a turn that also returned text.
   */
  private noteCompleted(site: GthTerminationSite): void {
    this.noteTermination(terminationReason(site, 'control', 'completed'));
  }

  /**
   * [[EXT-159]] — why the just-finished turn ended, or `null` when nothing classified it.
   *
   * The agent's answer wins when it has one: its sites (the metadata reader, the cancellation and
   * suspend paths, the run-ending middlewares) sit INSIDE the runner's catches, so the innermost
   * classification is the true one. Never throws.
   */
  public getTerminationReason(): GthTerminationReason | null {
    return this.captureAgentTerminationReason() ?? this.terminationReason;
  }

  /** [[EXT-159]] — read the live agent's reason into the snapshot (fail-soft). */
  private captureAgentTerminationReason(): GthTerminationReason | null {
    try {
      const reason = this.agent?.getTerminationReason?.();
      if (reason) this.agentTerminationReason = reason;
    } catch {
      /* fail-soft */
    }
    return this.agentTerminationReason;
  }

  /**
   * [[EXT-159]] — what the provider said about why each model message stopped, this turn.
   *
   * Reads live from the agent while one is present and falls back to the {@link cleanup} snapshot
   * afterwards, the same way {@link getRunStats} does — `/debug-dump` on the readline surface and
   * the non-interactive verbs both ask once the agent has been dropped.
   */
  public getFinishReasonObservations(): readonly GthFinishReasonObservation[] {
    return this.captureFinishReasonObservations();
  }

  /** [[EXT-159]] — read the live agent's finish-reason observations into the snapshot (fail-soft). */
  private captureFinishReasonObservations(): readonly GthFinishReasonObservation[] {
    try {
      const observed = this.agent?.getFinishReasonObservations?.();
      if (observed) this.agentFinishReasons = observed;
    } catch {
      /* fail-soft */
    }
    return this.agentFinishReasons;
  }

  /** GS2-16 — read the live agent's run stats (fail-soft; empty tally if unavailable). */
  private captureRunStats(): GthRunStats {
    try {
      const stats = this.agent?.getRunStats?.();
      if (stats) return stats;
    } catch {
      /* fail-soft */
    }
    return { tools: [] };
  }

  /**
   * GS2-16 — the analytics harvested from the just-finished turn (token usage + invoked tools),
   * to thread into the local history recorder. Reads live from the agent when one is present,
   * otherwise the snapshot captured at {@link cleanup} (the single-shot path reads post-cleanup).
   * Never throws.
   */
  public getRunStats(): GthRunStats {
    if (this.agent) {
      this.lastRunStats = this.captureRunStats();
    }
    return this.lastRunStats;
  }

  /**
   * Rotate the thread the runner drives by minting a fresh `runConfig` (new `thread_id`),
   * so subsequent turns start from an empty checkpointer thread rather than retrieving the
   * prior conversation. Used by the TUI's `/clear`, which clears the on-screen transcript;
   * without this the model would still see the full history persisted under the old thread.
   *
   * Rotating the thread_id (rather than deleting from the checkpointer) keeps this independent
   * of any checkpointer-specific delete API, mirroring how `init()` mints the initial config.
   */
  public resetThread(): void {
    // [[EXT-29]] §5.1 — the negotiation goes with the thread, user messages included. The rater's
    // last-5 window is conversation context; leaving it behind a `/clear` would quote the user's
    // previous conversation into a rating made after they asked for it to be forgotten.
    this.negotiation.clear();
    this.clearNegotiationDisplay();
    // [[TUI-C69]] §5.4 — the noted tool-call ids are state from before the `/clear` too, and the
    // sentence above is the whole argument for dropping them: they would decide how rows are drawn
    // in a conversation the user has just asked to start fresh.
    this.clearRaterClarifications();
    this.runConfig = getNewRunnableConfig();
    debugLogObject('Reset Runnable Config', this.runConfig);
  }

  /**
   * GS2-23 — **fold the older conversation into a summary, in the live graph.** The idle,
   * user-invoked seam: what `/compact` calls between turns.
   *
   * It is not the seam for the involuntary paths. EXT-160's compact-and-retry runs inside the
   * driver's `try`, where a turn is in flight and this method refuses; that path composes
   * `compactMessages` with `replaceGraphMessages` (or the agent's `replaceConversationMessages`)
   * from inside the turn, or adds a guard-free internal when it needs one, rather than calling this.
   *
   * Reads the thread's messages from the graph, runs the shared `compactMessages` with the
   * summariser bound to the session model, and writes the replacement back through the graph's own
   * state update — so the compacted history is checkpointed and a later resume loads it compacted.
   * `after` is read back from the graph rather than computed, so the report describes what the
   * graph actually holds.
   *
   * Refuses while a turn is running (the two drivers count themselves in and out). Refuses a graph
   * suspended on a pending tool approval — idle, but not between turns: the state write lands on
   * such a graph and erases the interrupt payload (measured: one pending interrupt becomes none,
   * `next` preserved), so the approval could never be answered. A graph a THROWN turn left behind
   * is not refused: its checkpoint ends on the pending human turn with no interrupt, the write
   * lands, and the next turn runs from the compacted state. Invariant (c) is relative there — the
   * mechanism never creates a trailing assistant turn and the pending human stays last; having the
   * next human turn present before the model is invoked again is the caller's job. Does nothing on
   * a conversation no longer than the kept tail: `changed: false`, nothing written.
   */
  public async compactConversation(
    options: CompactConversationOptions = {}
  ): Promise<ConversationCompaction> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    if (this.turnsInFlight > 0) {
      throw new Error('A turn is still running; wait for it to finish before compacting.');
    }
    const agent = this.agent;
    if (!agent.getConversationMessages || !agent.replaceConversationMessages) {
      throw new Error(
        'This agent does not expose its conversation state, so it cannot be compacted.'
      );
    }
    const runConfig = this.runConfig;
    const pendingApprovals = (await agent.getPendingToolInterrupts?.(runConfig)) ?? [];
    if (pendingApprovals.length > 0) {
      throw new Error('A tool approval is still pending; answer it before compacting.');
    }
    return this.applyCompaction(options);
  }

  /**
   * [[EXT-160]] — the read-compact-write itself, with **no turn-state guards**: the shared internal
   * behind both the idle `/compact` above and the involuntary compact-and-retry inside a turn.
   *
   * It exists because {@link compactConversation}'s guards are exactly wrong for the involuntary
   * case. That method refuses while `turnsInFlight > 0`, and the overflow seam runs inside the
   * driver's `catch`, where the turn it is recovering is still counted in — so calling the public
   * method from there throws every time. The alternative was for the seam to compose
   * `compactMessages` with `replaceConversationMessages` itself, which is the same six steps written
   * twice: two places to keep the summariser, the keep-recent default, the read-back and the
   * `changed: false` shape in agreement. One implementation with the guards on the caller that needs
   * them is the version that cannot drift.
   */
  private async applyCompaction(
    options: CompactConversationOptions = {}
  ): Promise<ConversationCompaction> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    const agent = this.agent;
    if (!agent.getConversationMessages || !agent.replaceConversationMessages) {
      throw new Error(
        'This agent does not expose its conversation state, so it cannot be compacted.'
      );
    }
    const runConfig = this.runConfig;
    const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
    const messages = await agent.getConversationMessages(runConfig);
    const before = conversationSize(messages);
    const result = await compactMessages({
      messages,
      summarize: createModelSummarizer(this.config.llm),
      keepRecent,
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    });
    if (!result.changed) {
      return {
        changed: false,
        removedCount: 0,
        keptCount: messages.length,
        keepRecent,
        summaryText: '',
        before,
        after: before,
      };
    }
    await agent.replaceConversationMessages(runConfig, result.messages);
    const after = conversationSize(await agent.getConversationMessages(runConfig));
    debugLog(
      `Compacted the conversation: ${result.removedCount} folded, ${result.keptCount} kept, ` +
        `${before.messages}→${after.messages} messages, ${before.characters}→${after.characters} chars`
    );
    return {
      changed: true,
      removedCount: result.removedCount,
      keptCount: result.keptCount,
      keepRecent,
      summaryText: result.summaryText,
      before,
      after,
    };
  }

  /**
   * [[EXT-160]] — **decide what a thrown turn's context overflow means, and act on it once.**
   *
   * Returns `true` when the conversation was made smaller and the turn is worth attempting again;
   * `false` for everything else, including every failure that is not an overflow at all, in which
   * case the caller's existing error path runs untouched.
   *
   * **The predicate is the taxonomy's, never a private one.** The category comes from the reason an
   * inner site already attached, or failing that from `classifyThrownTermination`, and the decision
   * is `remedy === 'reduce-context'` read out of the one POSTURE table. That is what makes this the
   * same fact [[EXT-159]] surfaces rather than a second opinion about it — and it is why an
   * `output_truncated` turn is not compacted here: the answer was cut off against the output cap,
   * its remedy is `change-request`, and folding the history would not add a single token of room to
   * the part that ran out. `context_overflow` is also the one category whose posture separates the
   * two facts this method depends on: retrying the SAME prompt is hopeless (`retryableAsIs: false`,
   * which is what `ContextOverflowError.getRetryable()` says too) while retrying a SMALLER one is
   * the whole move (`retryableAfterRemedy: true`).
   *
   * **One retry, and the reasons a compaction can decline.** A second overflow after the history has
   * already been folded is not worth a second fold — the tail it just kept is what the next
   * compaction would have to eat — so `attempt > 0` terminates at its own site. So does a compaction
   * that had nothing to fold, could not get a summary, or found an agent with no conversation state:
   * each is "the automatic remedy was tried and had nothing to give", which is a different fact from
   * "the model said no" and deserves to be said in its own words.
   *
   * The original overflow error is what surfaces in every declining branch. A compaction that throws
   * has its own failure logged and dropped rather than re-thrown, because replacing a diagnosis the
   * whole node exists to preserve with a summariser's stack trace buries the one useful thing the
   * turn produced.
   */
  private async handleContextOverflow(error: unknown, attempt: number): Promise<boolean> {
    const category =
      terminationReasonOf(error)?.category ?? classifyThrownTermination(error).category;
    if (terminationPosture(category).remedy !== 'reduce-context') return false;

    if (attempt > 0) {
      this.overrideTerminationReason(
        error,
        terminationReason('runner.overflow-compact-exhausted', 'exception', {
          category: 'context_overflow',
          detail: 'overflowed again after compaction',
        })
      );
      this.statusUpdate(
        StatusLevel.WARNING,
        'The context overflowed again after compacting, so this turn was ended. Start a new ' +
          'conversation, or narrow what this turn is asking for.'
      );
      return false;
    }

    // An agent that exposes no conversation state cannot be compacted at ALL, which is a different
    // fact from a compaction that ran and had nothing to give — and only the second is something
    // this seam knows. So nothing is overridden here: the wrapper's own classification is the
    // truest thing anyone has, and claiming the remedy was tried would be false.
    const agent = this.agent;
    if (!agent?.getConversationMessages || !agent?.replaceConversationMessages) {
      debugLog(
        'Context overflow: this agent exposes no conversation state, so it cannot be compacted.'
      );
      return false;
    }

    let compaction: ConversationCompaction;
    try {
      compaction = await this.applyCompaction();
    } catch (compactionError) {
      debugLogError('Compacting after a context overflow', compactionError);
      compaction = { changed: false } as ConversationCompaction;
    }
    if (!compaction.changed) {
      this.overrideTerminationReason(
        error,
        terminationReason('runner.overflow-compact', 'exception', {
          category: 'context_overflow',
          detail: 'nothing left to compact',
        })
      );
      this.statusUpdate(
        StatusLevel.WARNING,
        'The context overflowed and there was nothing left to compact, so this turn was ended. ' +
          'Start a new conversation, or narrow what this turn is asking for.'
      );
      return false;
    }

    this.statusUpdate(
      StatusLevel.INFO,
      `The context overflowed, so ${compaction.removedCount} earlier messages were folded into a ` +
        `summary (${compaction.before.messages}→${compaction.after.messages} messages). Retrying.`
    );
    // The retry is a fresh attempt and owes its own reason: the FULL reset, so the failed attempt's
    // provider finish reasons go with it rather than being read later as the retry's.
    this.resetTerminationReason();
    return true;
  }

  /**
   * [[EXT-160]] — record a reason that OVERRIDES what an inner site already said, on both carriers.
   *
   * {@link noteTermination} is first-write-wins and {@link classifyThrownAt} inherits, which is
   * right for the nested wrappers they serve: the inner site saw the failure first. The overflow
   * seam is the one site that legitimately knows better — it has watched the same turn overflow
   * twice, or watched the remedy come back empty, and the wrapper that classified the throw saw
   * neither. Both carriers move together so the runner's field and the error can never disagree.
   */
  private overrideTerminationReason(error: unknown, reason: GthTerminationReason): void {
    try {
      this.terminationReason = reason;
      replaceTerminationReason(error, reason);
      debugLog(terminationLogLine(reason));
    } catch {
      /* fail-soft: classification must never affect a run */
    }
  }

  async cleanup(): Promise<void> {
    debugLog('Cleaning up GthAgentRunner...');
    // GS2-16: snapshot the agent's run stats BEFORE nulling it, so a post-cleanup reader
    // (runSingleShot records history after calling cleanup) still gets this turn's analytics.
    this.lastRunStats = this.captureRunStats();
    // [[EXT-159]] — and the agent's termination reason with it, for the same reason: the
    // single-shot path asks why the run ended after the agent has already been nulled.
    this.captureAgentTerminationReason();
    // [[EXT-159]] — likewise the provider's per-message finish reasons, which `/debug-dump` and the
    // non-interactive verbs read post-cleanup.
    this.captureFinishReasonObservations();
    if (this.agent && 'cleanup' in this.agent && typeof this.agent.cleanup === 'function') {
      await this.agent.cleanup();
    }
    this.agent = null;
    this.config = null;
    debugLog('GthAgentRunner cleanup complete');
  }
}
