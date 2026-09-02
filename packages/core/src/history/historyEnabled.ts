/**
 * @packageDocumentation
 * GS2-7 (B20) / GS2-20 — the ONE switch governing everything the local history feature persists:
 * the per-turn session records and the durable LangGraph checkpoints a resume reads back.
 *
 * They share a switch rather than getting one each because they are two halves of one promise. A
 * conversation listed by `gth history list` that cannot be resumed, or a resumable thread with no
 * listing to find it from, is a state a user has no way to reason about — and a second key would
 * make both reachable.
 */

/** The subset of the resolved config history reads (structural, to avoid a hard type dep). */
export interface HistoryConfigView {
  history?: { enabled?: boolean; dbPath?: string };
}

/**
 * Whether this run persists history. **Absent means ON**: a default run records its turns to the
 * local store and checkpoints its graph state, both under the user's own `~/.gsloth` dir and
 * neither leaving the machine.
 *
 * `history.enabled: false` is the opt-out and is the only value that turns it off, which is why
 * this tests against `false` rather than for truthiness — the difference between "absent" and
 * "explicitly off" is the whole behaviour.
 */
export function isHistoryEnabled(config: HistoryConfigView | undefined): boolean {
  return config?.history?.enabled !== false;
}
