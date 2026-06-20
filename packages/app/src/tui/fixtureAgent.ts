import { readFileSync } from 'node:fs';
import type { AgentStreamEvent } from '@gaunt-sloth/core/core/types.js';
import type { TuiAgent } from '#src/tui/types.js';

/** One scripted turn: a sequence of events replayed with `delayMs` spacing. */
interface FixtureTurn {
  events: AgentStreamEvent[];
  /** Per-event delay (ms) so streaming is observable / interruptible. */
  delayMs?: number;
}

interface Fixture {
  turns: FixtureTurn[];
  /** Fallback per-event delay when a turn omits its own. */
  defaultDelayMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Test-only deterministic agent. Replays recorded {@link AgentStreamEvent}s from a JSON
 * fixture instead of calling a model, so the PTY e2e (Stage D) drives the *real* TUI — the
 * `<App>` component, the `foldEvents` reducer, and Ink's renderer — with hermetic, key-free,
 * fully reproducible output. Selected by {@link import('#src/tui/tuiSessionModule.js')}'s
 * `createTuiSession` only when `GTH_TUI_E2E_FIXTURE` points at a fixture file; the production
 * path never loads this module.
 *
 * Turns are consumed in order (the last turn repeats if the user submits more prompts than
 * the fixture scripts). The replay honours the abort signal — Esc throws mid-stream, mirroring
 * the way the real `streamWithEvents` path surfaces a cancelled run.
 */
export function createFixtureTuiAgent(fixturePath: string): TuiAgent {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  const turns = fixture.turns ?? [];
  let index = 0;

  return {
    async *runTurn(_userInput: string, signal: AbortSignal): AsyncGenerator<AgentStreamEvent> {
      const turn = turns.length > 0 ? turns[Math.min(index, turns.length - 1)] : { events: [] };
      index += 1;
      const gap = turn.delayMs ?? fixture.defaultDelayMs ?? 10;
      for (const event of turn.events) {
        if (signal.aborted) throw new Error('Interrupted');
        await delay(gap);
        if (signal.aborted) throw new Error('Interrupted');
        yield event;
      }
    },
  };
}
