/**
 * @packageDocumentation
 * GS2-7 (B20) — the opt-in bridge from a finished run to the {@link HistoryStore}.
 *
 * {@link recordSessionSafe} is the ONE entry point the run path calls. It is a no-op unless
 * `history.enabled` is true, and it swallows every error, so:
 * - a **default run** (history absent/false) opens nothing, writes nothing, and behaves exactly
 *   as before — the stateless identity is preserved; and
 * - even with history **on**, a DB problem (locked/corrupt/read-only fs) can never abort or alter
 *   the run: the worst case is that one session isn't recorded.
 */
import type { ConversationMeta, SessionRecord } from '#src/history/historyStore.js';
import { openHistoryStore, resolveHistoryDbPath } from '#src/history/historyStore.js';

/** The subset of the resolved config the recorder reads (structural, to avoid a hard type dep). */
export interface HistoryConfigView {
  history?: { enabled?: boolean; dbPath?: string };
}

/**
 * Record one finished session IFF `history.enabled` is true. Returns the new row id, or `null`
 * when history is disabled or anything went wrong (both are non-events for the caller).
 *
 * Deliberately fully guarded: opening the store, ensuring the global dir, and the insert all run
 * behind a single try/catch, and the store itself is fail-soft. Callers put this in a `finally`
 * (or after a run) without a try/catch of their own.
 */
export function recordSessionSafe(config: HistoryConfigView, record: SessionRecord): number | null {
  try {
    if (!config?.history?.enabled) return null;
    const dbPath = resolveHistoryDbPath(config.history.dbPath, /* ensureDir */ true);
    const store = openHistoryStore(dbPath, { create: true });
    if (!store) return null;
    try {
      return store.record(record);
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}

/**
 * GS2-19 — open one conversation for an interactive session IFF `history.enabled`, returning its id
 * (or `null` when disabled / anything failed). The session passes that id on every
 * {@link recordSessionSafe} so all its turns group under one conversation. Same guarantees as the
 * recorder: a no-op by default, fully fail-soft, never throws. When it returns `null` under an
 * enabled store (a rare open failure), turns simply fall back to per-turn 1-turn conversations —
 * grouping is lost but nothing is dropped or crashed.
 */
export function openConversationSafe(
  config: HistoryConfigView,
  meta: ConversationMeta
): number | null {
  try {
    if (!config?.history?.enabled) return null;
    const dbPath = resolveHistoryDbPath(config.history.dbPath, /* ensureDir */ true);
    const store = openHistoryStore(dbPath, { create: true });
    if (!store) return null;
    try {
      return store.openConversation(meta);
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}
