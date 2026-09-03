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
import type {
  ConversationMeta,
  ConversationSummary,
  SessionRecord,
} from '#src/history/historyStore.js';
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

/** GS2-20 — what a resume needs to know about a stored conversation before re-entering it. */
export interface StoredConversation {
  /** The listing row: when it started, which command and model recorded it, its workspace. */
  summary: ConversationSummary;
  /** Its recorded turns, oldest first — what the surface replays as restored turns. */
  turns: SessionRecord[];
}

/**
 * GS2-20 — the conversation row and its recorded turns, or `null` when history is off, the store
 * cannot be opened, or no conversation has that id.
 *
 * This is the *display and policy* half of a resume — the workspace the conversation belongs to,
 * the command it was recorded under, the turns to show — and deliberately not the thread decision:
 * whether the conversation can be re-entered is answered by {@link lookupConversationThreadSafe},
 * whose exact-match-never-fallback contract is the one a resume rests on. Fail-soft, never throws.
 */
export function lookupConversationSafe(
  config: HistoryConfigView,
  conversationId: number
): StoredConversation | null {
  try {
    if (!isHistoryEnabled(config)) return null;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return null;
    try {
      const summary = store.getConversation(conversationId);
      if (!summary) return null;
      return { summary, turns: store.getConversationThread(conversationId) };
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}

/**
 * GS2-20 — the conversations a `/resume` picker may offer: the most recent ones that carry a thread
 * (so a resume could actually re-enter them), minus the one the session is already in. `[]` when
 * history is off or the store cannot be opened, which the caller renders as "nothing to resume".
 * Fail-soft, never throws.
 */
export function listResumableConversationsSafe(
  config: HistoryConfigView,
  options: { limit?: number; exclude?: number } = {}
): ConversationSummary[] {
  try {
    if (!isHistoryEnabled(config)) return [];
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return [];
    try {
      // Over-fetch so the filter below still yields up to `limit` rows when recent conversations
      // are single-shot runs (no thread) or the excluded one.
      const limit = options.limit ?? 20;
      return store
        .listConversations(limit * 3)
        .filter((c) => c.threadId !== undefined && c.id !== options.exclude)
        .slice(0, limit);
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
}

/**
 * GS2-20 — the stored approval-grants document of one conversation, as the opaque JSON string the
 * approvals layer wrote (`core/approvals/conversationGrants.ts` owns the format), or `null` when
 * there is none. Governed by the same switch as everything else here. Fail-soft, never throws.
 */
export function readConversationGrantsSafe(
  config: HistoryConfigView,
  conversationId: number
): string | null {
  try {
    if (!isHistoryEnabled(config)) return null;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return null;
    try {
      return store.getConversationGrants(conversationId);
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}

/**
 * GS2-20 — replace one conversation's stored approval-grants document. Called whenever the session's
 * grants change, so the row always holds the current set and a resume restores exactly what the
 * conversation had. Returns whether the row was written. Fail-soft, never throws — a grant that
 * could not be recorded costs one re-prompt after a resume, and must never cost the turn.
 */
export function writeConversationGrantsSafe(
  config: HistoryConfigView,
  conversationId: number,
  grantsJson: string | null
): boolean {
  try {
    if (!isHistoryEnabled(config)) return false;
    const dbPath = resolveHistoryDbPath(config.history?.dbPath);
    const store = openHistoryStore(dbPath, { create: false });
    if (!store) return false;
    try {
      return store.setConversationGrants(conversationId, grantsJson);
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}
