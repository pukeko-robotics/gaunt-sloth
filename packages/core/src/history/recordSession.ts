/**
 * @packageDocumentation
 * GS2-7 (B20) — the bridge from a finished run to the {@link HistoryStore}.
 *
 * {@link recordSessionSafe} is the ONE entry point the run path calls. It writes unless
 * `history.enabled` is `false`, and it swallows every error, so:
 * - a **default run** records its turns locally, under the user's own `~/.gsloth` dir, and
 *   `history.enabled: false` is the opt-out that restores the stateless identity; and
 * - with history on, a DB problem (locked/corrupt/read-only fs) can never abort or alter
 *   the run: the worst case is that one session isn't recorded.
 */
import type { ConversationMeta, SessionRecord } from '#src/history/historyStore.js';
import { openHistoryStore, resolveHistoryDbPath } from '#src/history/historyStore.js';
import { isHistoryEnabled } from '#src/history/historyEnabled.js';

export type { HistoryConfigView } from '#src/history/historyEnabled.js';
import type { HistoryConfigView } from '#src/history/historyEnabled.js';

/**
 * Record one finished session unless `history.enabled` is `false`. Returns the new row id, or
 * `null` when history is turned off or anything went wrong (both are non-events for the caller).
 *
 * Deliberately fully guarded: opening the store, ensuring the global dir, and the insert all run
 * behind a single try/catch, and the store itself is fail-soft. Callers put this in a `finally`
 * (or after a run) without a try/catch of their own.
 */
export function recordSessionSafe(config: HistoryConfigView, record: SessionRecord): number | null {
  try {
    if (!isHistoryEnabled(config)) return null;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath, /* ensureDir */ true);
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
 * GS2-19 — open one conversation for an interactive session unless `history.enabled` is `false`,
 * returning its id (or `null` when turned off / anything failed). The session passes that id on
 * every {@link recordSessionSafe} so all its turns group under one conversation. Same guarantees as
 * the recorder: fully fail-soft, never throws. When it returns `null` under an enabled store (a
 * rare open failure), turns simply fall back to per-turn 1-turn conversations — grouping is lost
 * but nothing is dropped or crashed.
 *
 * GS2-20 — `meta.threadId` is what makes the conversation resumable: it names the LangGraph thread
 * whose durable checkpoint holds the session's graph state.
 */
export function openConversationSafe(
  config: HistoryConfigView,
  meta: ConversationMeta
): number | null {
  try {
    if (!isHistoryEnabled(config)) return null;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath, /* ensureDir */ true);
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

/**
 * GS2-20 — record, ON DISK, that a conversation can no longer be resumed, by clearing its thread
 * link. Called once per session, the first time a checkpoint write fails after the store opened.
 *
 * The session itself keeps running and the user is told; this is the half that has to outlive the
 * process. A checkpoint chain that stopped growing mid-conversation is still a well-formed chain,
 * so nothing a later `--resume` could inspect would reveal that it is truncated — the refusal has
 * to be written down at the moment the writing broke.
 *
 * Fail-soft, like its neighbours: the session is already degraded, and a failure here must not turn
 * that into a second error.
 */
export function markConversationUnresumableSafe(
  config: HistoryConfigView,
  conversationId: number
): void {
  try {
    if (!isHistoryEnabled(config)) return;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return;
    try {
      store.clearConversationThread(conversationId);
    } finally {
      store.close();
    }
  } catch {
    /* ignore */
  }
}

/**
 * GS2-20 — the reverse trip: from a conversation id (what `gth history list` prints and a user
 * types) to the LangGraph thread whose checkpoint holds its state, or `null` when there isn't one.
 *
 * `null` covers every way this can come up empty — history turned off, no store, an id that names
 * nothing, or a conversation recorded without a checkpointer — and never a neighbouring
 * conversation. A caller resuming on this must treat `null` as a refusal to resume and say so;
 * quietly starting a fresh session, or picking the most recent conversation instead, would hand
 * someone another conversation's state under the id they typed.
 */
export function lookupConversationThreadSafe(
  config: HistoryConfigView,
  conversationId: number
): string | null {
  try {
    if (!isHistoryEnabled(config)) return null;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return null;
    try {
      return store.getConversationThreadId(conversationId);
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}
