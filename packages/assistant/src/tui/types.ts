import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TurnViewModel } from '#src/tui/viewModel.js';

/**
 * The minimal agent surface the Ink `<App>` drives. Decoupling the component from
 * `GthAgentRunner` keeps the UI unit-testable with a scripted fake (a generator that
 * yields {@link AgentStreamEvent}s) — see the component spec.
 */
export interface TuiAgent {
  /** Run one user turn, yielding typed events; aborts when `signal` fires (Esc). */
  runTurn(userInput: string, signal: AbortSignal): AsyncGenerator<AgentStreamEvent>;
}

/** A committed line in the scrollback (rendered via Ink `<Static>`). */
export type TranscriptItem =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; turn: TurnViewModel }
  | { kind: 'system'; id: number; level: string; text: string };

/** Props for the root `<App>`; the real session wires these to a `GthAgentRunner`. */
export interface TuiAppProps {
  agent: TuiAgent;
  mode: string;
  /** Greeting shown before the first prompt (mirrors the readline `readyMessage`). */
  readyMessage: string;
  /** Hint shown in the status bar / on start (mirrors the readline `exitMessage`). */
  exitMessage: string;
  /** Optional initial message to run immediately on mount. */
  initialMessage?: string;
  /** Subscribe to agent status updates (warnings/info routed out of the event stream). */
  subscribeStatus?: (cb: (level: string, message: string) => void) => () => void;
  /** Called once a turn finishes, with the user input and the final assistant text. */
  onTurnComplete?: (userInput: string, assistantText: string) => void;
  /** Called on `exit`/`/exit` (or quit) for cleanup before the app unmounts. */
  onExit?: () => void | Promise<void>;
}
