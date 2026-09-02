import type {
  AgentStreamEvent,
  ApprovalOutcome,
  AttackHaltAnswer,
  PendingAttackHalt,
  PendingToolInterrupt,
  ToolApprovalDecision,
  McpConnectionFailure,
} from '@gaunt-sloth/core/core/types.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';
import type {
  AllowlistCounts,
  ApprovalRefusal,
  ApprovalRefusalLift,
  ApprovalRung,
  McpAnnotationTrustChange,
  McpAnnotationTrustView,
  ResolvedApprovals,
  ToolAnnotationHint,
} from '@gaunt-sloth/core/config.js';
import type { ApprovalGrant } from '@gaunt-sloth/core/core/approvals/grants.js';
import type { ApprovalStopPart } from '@gaunt-sloth/core/core/shell/approvalStop.js';
import type { GthTerminationReason } from '@gaunt-sloth/core/core/terminationReason.js';
import type { LiveNegotiationRound } from '@gaunt-sloth/core/core/shell/negotiation.js';
import type { CommandNoticeTone } from '#src/tui/components/CommandNotice.js';
import type { DebugDumpInput } from '@gaunt-sloth/agent/modules/slashCommands.js';
import type { MouseSubscribe } from '#src/tui/useMouse.js';

/**
 * One in-flight tool-approval request bridged from the runner into the mounted `<App>`
 * (EXT-9 Phase B2): the {@link PendingToolInterrupt} the runner suspended on, plus a `resolve`
 * that hands the human's {@link ToolApprovalDecision} back to the awaiting runner callback.
 * Idempotent — calling `resolve` more than once is a no-op (the first decision wins).
 *
 * [[EXT-150]] — **`resolve` answers back.** It returns the {@link ApprovalOutcome} the runner
 * reports once it has recorded the answer, which is the only way this surface can learn whether an
 * `always` reached the project file: [[EXT-149]] decides that inside the runner, after the decision
 * has already been handed back. `null` means no outcome will arrive — the session ended with the
 * approval still in flight — and a surface must then claim no persistence at all.
 *
 * The return type is deliberately not optional. A field a surface may omit would let one keep
 * compiling while it went on confirming the key that was pressed, which is the defect [[EXT-150]]
 * exists to remove; a required promise makes every implementer say where its answer comes from.
 */
export interface PendingApproval {
  pending: PendingToolInterrupt;
  resolve: (decision: ToolApprovalDecision) => Promise<ApprovalOutcome | null>;
}

/**
 * [[TUI-C68]] §6.1 — one in-flight **attack halt** bridged from the runner into the mounted
 * `<App>`: the {@link PendingAttackHalt} the rater produced, plus a `resolve` that hands the
 * human's {@link AttackHaltAnswer} back to the awaiting runner callback. Idempotent, like
 * {@link PendingApproval} — the first answer wins.
 *
 * Deliberately NOT a {@link PendingApproval} with a special decision. The banner is a different
 * kind of object from the approval dialog and must not be able to grow the dialog's controls: there
 * is no scope to return here, so no surface can accidentally make an attack grant sticky.
 */
export interface PendingAttackBanner {
  halt: PendingAttackHalt;
  resolve: (answer: AttackHaltAnswer) => void;
}

/**
 * The minimal agent surface the Ink `<App>` drives. Decoupling the component from
 * `GthAgentRunner` keeps the UI unit-testable with a scripted fake (a generator that
 * yields {@link AgentStreamEvent}s) — see the component spec.
 */
export interface TuiAgent {
  /** Run one user turn, yielding typed events; aborts when `signal` fires (Esc). */
  runTurn(userInput: string, signal: AbortSignal): AsyncGenerator<AgentStreamEvent>;
  /**
   * [[EXT-159]] — why the turn that just ended ended, or `null` when nothing classified it.
   *
   * Read once per turn, after the stream is done, and committed to the transcript as a value. It is
   * NOT an event on the stream: a turn abandoned by the consumer never finishes its generator, so
   * the one ending most in need of an explanation is the one an in-band event could not carry.
   *
   * Optional, so the scripted fixture agent may omit it — a surface with no reason to report says
   * nothing, exactly as it did before.
   */
  getTerminationReason?(): GthTerminationReason | null;
  /**
   * Reset the agent's conversation thread so subsequent turns start from an empty model
   * context — wired to the TUI's `/clear`, which only clears the on-screen transcript.
   * Optional so the fixture agent (no real checkpointer thread) may omit it.
   */
  resetThread?(): void;
  /**
   * CFG-27 — switch the session approvals RUNG and return the posture the runner LANDED on, so
   * the App can render a state-aware notice and the status-bar badge. Wired to `/approvals
   * <rung>`. Optional so the fixture agent (no runner) may omit it.
   *
   * It returns the landed {@link ResolvedApprovals} rather than the requested rung so the copy
   * can only ever describe the posture actually in force.
   */
  setApprovalRung?(rung: ApprovalRung): ResolvedApprovals;
  /**
   * CFG-27 — read the current posture, the allow-list counts and the refusals in force for the
   * `/approvals` display. Separate from {@link setApprovalRung} so showing status never mutates
   * session state.
   */
  getApprovals?(): {
    approvals: ResolvedApprovals;
    allowlist: AllowlistCounts;
    /**
     * [[EXT-107]] — every refusal in force, each carrying the list that holds it and the number
     * {@link liftRefusal} takes. Origin-tagged rather than a list of strings, because the three
     * sources have different lifetimes and only two of them can be lifted from here.
     */
    refusals: ApprovalRefusal[];
    /**
     * EXT-70 §3/§4.7.4 — the grants themselves (what was granted, when, and under which effective
     * annotations), not merely how many. Read-only copies; the runner never hands out its live
     * records.
     */
    grants: ApprovalGrant[];
    /** EXT-70 §4.7.1 — which of each MCP server's annotation hints this session believes. */
    trust: McpAnnotationTrustView;
  };
  /**
   * EXT-70 §4.7.1 — start or stop believing specific annotation hints from ONE MCP server, for
   * this session. The TUI counterpart of `approvals.mcp.servers.<key>.trustAnnotations` (§9).
   *
   * Per hint, never per server: `hints` moves exactly the hints it names. Returns what the runner
   * LANDED on — including whether the withdrawal weakens, which is what lets the surface tell the
   * user their saved approvals for that server are about to go with it (§4.7.4) rather than
   * letting them meet that as a surprise at the next call.
   *
   * Optional so the fixture agent (no runner) may omit it.
   */
  setMcpAnnotationTrust?(
    server: string,
    hints: ToolAnnotationHint[],
    believe: boolean
  ): McpAnnotationTrustChange;
  /**
   * [[EXT-107]] — lift one refusal by its number in {@link getApprovals}'s list. Wired to
   * `/approvals undeny <n>`, and the escape hatch that makes persisting a refusal safe to offer.
   *
   * Returns what the runner LANDED on, so the notice can only describe the refusal actually lifted
   * — including the case where the entry is the user's own config line and was therefore not
   * touched.
   *
   * Optional so the fixture agent (no runner) may omit it.
   */
  liftRefusal?(index: number): ApprovalRefusalLift;
}

/**
 * One debug capture from the agent's `wrapModelCall` middleware. `kind: 'request'`
 * carries the full message history (`text`) sent to the model plus the non-message request parts
 * pre-rendered for two dedicated tabs (TUI-C16): `system` (model params, tool-choice, system
 * prompt) and `tools` (the tool catalogue), plus `mcp` (TUI-C20: the per-server MCP overview —
 * instructions + server-prefixed tools). `kind: 'response'` carries the resolved raw model
 * response. All arrive pre-rendered as strings so the panel just slices lines.
 */
export type TuiDebugCapture =
  | { kind: 'request'; text: string; system: string; tools: string; mcp: string }
  | { kind: 'response'; text: string };

/** One committed line of the conversation, rendered by the transcript viewport we own. */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; turn: TurnViewModel }
  | { kind: 'system'; id: number; level: string; text: string }
  // A structured command-feedback notice (TUI-C14), rendered via <CommandNotice>: a coloured
  // title that states WHAT happened plus body lines explaining HOW it affects the user.
  | { kind: 'notice'; id: number; title: string; lines: string[]; tone: CommandNoticeTone }
  // [[TUI-C71]] — a run-ending approvals stop (an `attack` halt, or a §6.2 escalation with nobody
  // to ask), rendered via <ApprovalStopMessage>. It is NOT a `system` item, and the difference is
  // the whole node: a `system` item is one `<Text>` that Ink re-wraps, and the untrusted halves of
  // a stop have to reach the screen inside the [[TUI-C26]] gutter. The parts carry who wrote each
  // piece; the raw error's own fields stay the record.
  | { kind: 'stop'; id: number; parts: readonly ApprovalStopPart[] }
  // [[EXT-137]] — the scrollable half of a tool-approval request, rendered via
  // <ApprovalRequestPanel>. The dock's <ApprovalPrompt> carries only text we wrote, so everything
  // the model, a third-party server or a hostile URL contributed — the rating, the negotiation,
  // the command and the hosts — reaches the screen here instead, where the conversation scrolls and
  // nothing needs a cap. The whole pending call travels rather than pre-rendered lines: core's
  // renderer needs the terminal width, which is not known when the request arrives.
  //
  // [[TUI-C99]] — **it is a FALLBACK now, not the ordinary path, and never committed on the ask.**
  // Committed when the question was asked it landed above every tool row of the turn it
  // interrupted, because the viewport draws the whole committed list before its children and the
  // in-flight turn is a child. An open request is drawn under the live turn instead, and an
  // answered one is what Ctrl+T opens on the call's own row. This kind survives for the one case
  // that leaves: an interrupt carrying no `id`, or one naming a call this turn has no segment for,
  // has no row to hang an outcome on — so the block is committed after the turn, where EXT-137's
  // audit record is preserved without inverting.
  | { kind: 'approval'; id: number; pending: PendingToolInterrupt }
  // TUI-C18 — a committed turn's thinking reprinted by `/reasoning`. Rendered via the shared
  // TUI-C15 <ReasoningPanel> (expanded) so a recalled block matches the original 💭/gutter styling;
  // `turnNumber` is the 1-based transcript turn it was recalled from.
  | { kind: 'reasoning'; id: number; reasoning: string; turnNumber: number }
  // [[EXT-159]] — why the turn ended, when that is not simply "the model finished". Its own kind
  // rather than a `system` line or a pre-rendered `notice`, because **the classification travels as
  // the VALUE and the words are derived from it at render time**: a `notice` would commit prose to
  // the transcript and leave the fact recoverable only by parsing it back, which is the funnel this
  // whole node exists to remove. It is the surface half of the same reason the dump and the debug
  // log record — one taxonomy, four consumers, no second vocabulary.
  | { kind: 'termination'; id: number; reason: GthTerminationReason };

/** Props for the root `<App>`; the real session wires these to a `GthAgentRunner`. */
export interface TuiAppProps {
  agent: TuiAgent;
  mode: string;
  /** Model/provider display name for the status bar and `/model` (from `config.modelDisplayName`). */
  modelDisplayName?: string;
  /**
   * TUI-C33 — the configured provider type (`config.modelProviderType`, e.g. `google-genai`), for
   * the launch banner's `model (provider)` line. Threaded alongside {@link modelDisplayName}
   * because the banner names the provider the status bar does not. Absent for module configs (which
   * hand us an already-built model) and in the fixture branch, where the banner renders the model
   * half alone — or omits the line entirely when neither resolves.
   */
  modelProviderType?: string;
  /**
   * TUI-C33 — whether to render the ASCII-art launch banner above the ready message. Carries the
   * session module's `stdout.isTTY` gate (the same gate gutting the TUI-C13 viewport bump), so
   * piped/redirected/non-TTY runs and the component specs stay clean. Absent ⇒ no banner.
   */
  showLaunchBanner?: boolean;
  /**
   * TUI-C37 — whether terminal mouse reporting is on at session start, as resolved by
   * `config.useMouse`. Absent ⇒ this surface has no mouse layer at all, which is what makes
   * `/mouse` report itself unavailable instead of pretending to toggle something.
   */
  mouseEnabled?: boolean;
  /**
   * TUI-C37 — the decoded mouse-event source, bridged in like `subscribeStatus`. The App routes
   * events into the hit-region registry; components claim rectangles with `useHitRegion`.
   */
  subscribeMouse?: MouseSubscribe;
  /**
   * TUI-C37 — apply a `/mouse` toggle. The session module owns the escape sequences (writing them
   * is not something a pure component should do), so the App asks and the module acts.
   */
  onSetMouse?: (enabled: boolean) => void;
  /**
   * CFG-27 — the RESOLVED approvals posture at session start, so the status bar names the real
   * rung from the very first frame. The session module seeds it from
   * `runner.getSessionApprovals()`; the App keeps its own state after that.
   *
   * This replaced an `initialAutoApprove?: boolean` seeded from a session bypass flag, which read
   * "off" whenever a RATED rung was in force — the status bar said nothing was being
   * auto-approved while the rater was approving safe commands. A rung, not a boolean, is the only
   * shape that can tell the truth about five of them.
   *
   * Undefined = no approvals surface in this session (the fixture agent / non-shell sessions),
   * and the badge is then omitted entirely rather than guessing.
   */
  initialApprovals?: ResolvedApprovals;
  /**
   * Pre-rendered, secret-free summary lines of the resolved config for the read-only `/config`
   * slash command (GS2-1). Built once by the session module via `formatConfigSummary`; omitted by
   * the fixture agent (no config loaded), where `/config` shows an "unavailable" notice.
   */
  configSummary?: string[];
  /**
   * GS2-7 (B20) — pre-rendered recent-session lines for `/history` and analytics lines for
   * `/insights`, plus a fail-soft search provider for `/search`. All built by the session module
   * from the local history store; omitted when no store is available (history off / DB
   * missing), where the commands show an "unavailable" notice.
   */
  historySummary?: string[];
  insightsSummary?: string[];
  historySearch?: (query: string) => string[];
  /**
   * GS2-46 — the resolved config (the live `GthConfig`), for `/debug-dump`. Kept `unknown` here
   * (this component never inspects it — it just forwards it into `dumpDebugSession`) so the TUI
   * layer stays decoupled from the core config type. Omitted by the fixture agent, where
   * `/debug-dump` reports itself unavailable.
   */
  resolvedConfig?: unknown;
  /**
   * GS2-46 — fs-writing implementation for `/debug-dump` (an UNSANITIZED diagnostic archive:
   * transcript, resolved config, env/version info, the in-memory debugLog ring buffer, and
   * best-effort git repo state), wired to `packages/core/src/utils/debugDump.ts#writeDebugDump`
   * the same way `historySearch` wires to the local history store. Omitted by the fixture agent.
   */
  dumpDebugSession?: (input: DebugDumpInput) => { archiveDir: string };
  /**
   * TUI-C19 — non-fatal startup advisories to surface persistently (currently the load-time
   * config-validation warnings — unknown keys, deprecated names — captured around `initConfig`).
   * When non-empty, the chrome shows a standing "config has problems" line in the pinned dock (so
   * it never scrolls away) and `/config` renders the actual warning text. Kept a generic string
   * list so other non-fatal startup advisories can post here later without a schema change; the
   * fixture/AG-UI paths omit it. Absent/empty ⇒ no standing line and `/config` shows no warnings.
   */
  advisories?: string[];
  /**
   * Per-server MCP connection failures captured during agent init (resolveTools). When non-empty,
   * the chrome shows a standing line naming the unavailable server(s) in the pinned dock — a
   * connection failure is otherwise only a transient `displayWarning` that Ink paints over. Kept
   * separate from `advisories` because those are config-validation warnings pointing at `/config`;
   * an MCP failure is not a config problem and points at the `/debug` MCP tab instead. The
   * fixture/AG-UI paths omit it. Absent/empty ⇒ no standing line.
   */
  mcpFailures?: McpConnectionFailure[];
  /** Greeting shown before the first prompt (mirrors the readline `readyMessage`). */
  readyMessage: string;
  /** Hint shown in the status bar / on start (mirrors the readline `exitMessage`). */
  exitMessage: string;
  /** Optional initial message to run immediately on mount. */
  initialMessage?: string;
  /** Subscribe to agent status updates (warnings/info routed out of the event stream). */
  subscribeStatus?: (cb: (level: string, message: string) => void) => () => void;
  /**
   * Subscribe to debug captures from the agent's `wrapModelCall` middleware: the full
   * history sent to the model and the resolved raw response, for the `/debug` panel. Optional
   * so the readline/AG-UI paths and the fixture agent (which have no such sink) simply omit it.
   */
  subscribeDebug?: (cb: (capture: TuiDebugCapture) => void) => () => void;
  /**
   * Subscribe to tool-approval requests bridged from the runner (EXT-9 Phase B2): each
   * {@link PendingApproval} carries the pending `run_shell_command` interrupt and a `resolve`
   * the app calls with the human's scoped decision. Optional so the fixture/AG-UI paths (which
   * never surface approvals) simply omit it.
   */
  subscribeApproval?: (cb: (record: PendingApproval) => void) => () => void;
  /**
   * [[TUI-C68]] §6.1 — subscribe to attack halts bridged from the runner: each
   * {@link PendingAttackBanner} carries the halted command plus a `resolve` the app calls with the
   * human's answer. **Optional, and absent is what a surface with no banner means** — the runner
   * then halts the run itself, which is the behaviour every surface had before this existed. So the
   * fixture and AG-UI paths simply omit it and keep the halt.
   */
  subscribeAttackHalt?: (cb: (record: PendingAttackBanner) => void) => () => void;
  /**
   * [[TUI-C69]] §5.4 — subscribe to the §5 negotiation's rounds as the gate decides them, so the
   * argument between the agent and the auto-rater is watched rather than only reported at an
   * escalation.
   *
   * **Optional, and absent means this surface has no live display** — which is also what tells the
   * runner not to hold a negotiated approval on screen (§5.5). The fixture path omits it, so a
   * fixture session neither draws rounds nor pays the hold.
   *
   * `null` means the exchange ENDED — a person was reached, the run halted, or a new turn began —
   * so the panel drops what it was holding. It matters most at an escalation, where the prompt is
   * about to render the whole argument itself and a live copy above it would put one exchange on an
   * unscrollable screen twice.
   */
  subscribeNegotiation?: (cb: (event: LiveNegotiationRound | null) => void) => () => void;
  /** Called once a turn finishes, with the user input and the final assistant text. */
  onTurnComplete?: (userInput: string, assistantText: string) => void;
  /** Called on `exit`/`/exit` (or quit) for cleanup before the app unmounts. */
  onExit?: () => void | Promise<void>;
}
