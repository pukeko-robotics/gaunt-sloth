import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';
import type { CommandNoticeTone } from '#src/tui/components/CommandNotice.js';

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
}

/**
 * One debug capture from the deep agent's `wrapModelCall` middleware. `kind: 'request'`
 * carries the full message history sent to the model plus, in `details`, the non-message
 * request parts (system prompt, tool definitions, model params) rendered for the dedicated
 * "Sent to model (system + tools)" tab; `kind: 'response'` carries the resolved raw model response.
 * All arrive pre-rendered as strings so the panel just slices lines.
 */
export type TuiDebugCapture =
  | { kind: 'request'; text: string; details: string }
  | { kind: 'response'; text: string };

/** A committed line in the scrollback (rendered via Ink `<Static>`). */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; turn: TurnViewModel }
  | { kind: 'system'; id: number; level: string; text: string }
  // A structured command-feedback notice (TUI-C14), rendered via <CommandNotice>: a coloured
  // title that states WHAT happened plus body lines explaining HOW it affects the user.
  | { kind: 'notice'; id: number; title: string; lines: string[]; tone: CommandNoticeTone };

/** Props for the root `<App>`; the real session wires these to a `GthAgentRunner`. */
export interface TuiAppProps {
  agent: TuiAgent;
  mode: string;
  /** Model/provider display name for the status bar and `/model` (from `config.modelDisplayName`). */
  modelDisplayName?: string;
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
