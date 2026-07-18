import type {
  AgentStreamEvent,
  PendingToolInterrupt,
  ToolApprovalDecision,
  McpConnectionFailure,
} from '@gaunt-sloth/core/core/types.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';
import type { CommandNoticeTone } from '#src/tui/components/CommandNotice.js';
import type { DebugDumpInput } from '#src/tui/slashCommands.js';

/**
 * One in-flight tool-approval request bridged from the runner into the mounted `<App>`
 * (EXT-9 Phase B2): the {@link PendingToolInterrupt} the runner suspended on, plus a `resolve`
 * that hands the human's {@link ToolApprovalDecision} back to the awaiting runner callback.
 * Idempotent — calling `resolve` more than once is a no-op (the first decision wins).
 */
export interface PendingApproval {
  pending: PendingToolInterrupt;
  resolve: (decision: ToolApprovalDecision) => void;
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
   * Reset the agent's conversation thread so subsequent turns start from an empty model
   * context — wired to the TUI's `/clear`, which only clears the on-screen transcript.
   * Optional so the fixture agent (no real checkpointer thread) may omit it.
   */
  resetThread?(): void;
  /**
   * EXT-12 — apply a change to the runner's session-scoped auto-approve flag (shell auto-approval)
   * and return the NEW state, so the App can render a state-aware notice and status indicator.
   * `'on'`/`'off'` set it explicitly, `'toggle'` flips it. Wired to the `/auto-approve` slash
   * command. Optional so the fixture agent (no runner) may omit it.
   */
  setAutoApprove?(action: 'on' | 'off' | 'toggle'): boolean;
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

/** A committed line in the scrollback (rendered via Ink `<Static>`). */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; turn: TurnViewModel }
  | { kind: 'system'; id: number; level: string; text: string }
  // A structured command-feedback notice (TUI-C14), rendered via <CommandNotice>: a coloured
  // title that states WHAT happened plus body lines explaining HOW it affects the user.
  | { kind: 'notice'; id: number; title: string; lines: string[]; tone: CommandNoticeTone }
  // TUI-C18 — a committed turn's thinking reprinted by `/reasoning`. Rendered via the shared
  // TUI-C15 <ReasoningPanel> (expanded) so a recalled block matches the original 💭/gutter styling;
  // `turnNumber` is the 1-based transcript turn it was recalled from.
  | { kind: 'reasoning'; id: number; reasoning: string; turnNumber: number };

/** Props for the root `<App>`; the real session wires these to a `GthAgentRunner`. */
export interface TuiAppProps {
  agent: TuiAgent;
  mode: string;
  /** Model/provider display name for the status bar and `/model` (from `config.modelDisplayName`). */
  modelDisplayName?: string;
  /**
   * EXT-12 — initial state of the session auto-approve flag, so the status bar shows the
   * indicator from the first frame when `run_shell_command.yolo` pre-enabled it in config. The App
   * keeps its own state after this; the session module seeds it from `runner.isSessionYolo()`.
   * Defaults to off (undefined) — the fixture / non-shell sessions omit it.
   */
  initialAutoApprove?: boolean;
  /**
   * Pre-rendered, secret-free summary lines of the resolved config for the read-only `/config`
   * slash command (GS2-1). Built once by the session module via `formatConfigSummary`; omitted by
   * the fixture agent (no config loaded), where `/config` shows an "unavailable" notice.
   */
  configSummary?: string[];
  /**
   * GS2-7 (B20) — pre-rendered recent-session lines for `/history` and analytics lines for
   * `/insights`, plus a fail-soft search provider for `/search`. All built by the session module
   * from the local, opt-in history store; omitted when no store is available (history off / DB
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
   * When non-empty, the chrome shows a standing "config has problems" line OUTSIDE `<Static>` (so
   * it never scrolls away) and `/config` renders the actual warning text. Kept a generic string
   * list so other non-fatal startup advisories can post here later without a schema change; the
   * fixture/AG-UI paths omit it. Absent/empty ⇒ no standing line and `/config` shows no warnings.
   */
  advisories?: string[];
  /**
   * Per-server MCP connection failures captured during agent init (resolveTools). When non-empty,
   * the chrome shows a standing line naming the unavailable server(s) OUTSIDE `<Static>` — a
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
   * Subscribe to debug captures from the deep agent's `wrapModelCall` middleware: the full
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
  /** Called once a turn finishes, with the user input and the final assistant text. */
  onTurnComplete?: (userInput: string, assistantText: string) => void;
  /**
   * Reset Ink's frame accounting after `/clear` has scrolled the viewport (production wires this
   * to the `render()` instance's `clear()`). The app writes the scroll/clear escapes itself, then
   * calls this so Ink forgets its last-rendered output and re-renders cleanly at the top — without
   * it Ink would diff against a now-stale frame and leave artifacts. Optional (tests / fixtures).
   */
  onResetFrame?: () => void;
  /** Called on `exit`/`/exit` (or quit) for cleanup before the app unmounts. */
  onExit?: () => void | Promise<void>;
}
