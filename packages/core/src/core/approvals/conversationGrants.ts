/**
 * @packageDocumentation
 * GS2-20 — **a conversation keeps its approval grants, so a resumed one gets them back.**
 *
 * The ruling this implements: from the agent's side a resume must look as though no interruption
 * happened, and that covers what the session may already do without asking, not only what it can
 * remember. So the grants a person made at the escalation menu — *approve for the session*, *deny
 * always* whose project write did not land — are written against the conversation in the history
 * store and loaded again when the conversation is resumed.
 *
 * **State the widening plainly, because a widening nobody notices is the failure mode:** a grant's
 * lifetime is the CONVERSATION, not the process. Under `history.enabled: false` nothing is stored,
 * so a grant then lives exactly as long as the process — which is also how long the conversation
 * can live, since it cannot be resumed.
 *
 * **Only session-scoped grants travel this way.** An `always` grant is already in the project's
 * allow-list / deny-list file and comes back from there on every run; storing it here too would
 * make one decision two records that could disagree. The declared config lists are never grants and
 * are never here.
 *
 * The document is one JSON object per conversation, in the same grant shape the project files use
 * and read by the same {@link readGrant}, so a malformed entry is skipped the same way in both.
 */
import type { HistoryConfigView } from '#src/history/historyEnabled.js';
import {
  readConversationGrantsSafe,
  writeConversationGrantsSafe,
} from '#src/history/recordSession.js';
import { readGrant, type ApprovalGrant } from '#src/core/approvals/grants.js';

/** The session-scoped grants of one conversation: what it may run unasked, and what it refuses. */
export interface ConversationGrants {
  /** Escalation-menu approvals — `[s]ession`, and an `[a]lways` whose file write did not land. */
  allow: ApprovalGrant[];
  /** Escalation-menu refusals — a `[d]eny always` whose file write did not land. */
  deny: ApprovalGrant[];
}

/** The on-disk document; versioned so a later shape can be told from this one. */
interface ConversationGrantsDocumentV1 {
  version: 1;
  allow: ApprovalGrant[];
  deny: ApprovalGrant[];
}

/** A document with nothing in it, which is also what an absent or unreadable one reads as. */
export const NO_CONVERSATION_GRANTS: Readonly<ConversationGrants> = Object.freeze({
  allow: [],
  deny: [],
});

/**
 * Serialise the grants for storage. `null` when there is nothing to store, so a conversation that
 * never granted anything keeps a NULL column rather than an empty document.
 */
export function encodeConversationGrants(grants: ConversationGrants): string | null {
  if (grants.allow.length === 0 && grants.deny.length === 0) return null;
  const document: ConversationGrantsDocumentV1 = {
    version: 1,
    allow: grants.allow,
    deny: grants.deny,
  };
  return JSON.stringify(document);
}

/**
 * Parse a stored document. Anything that is not a readable v1 document — corrupt JSON, another
 * shape, a future version — reads as no grants: a resume that cannot read them costs a re-prompt,
 * never a grant the person did not make. A malformed entry inside a readable document is skipped
 * on its own ({@link readGrant}), and every stored scope is forced back to `session`: that is the
 * only scope this document holds, and a file that claimed otherwise would be describing the project
 * store, which is not consulted here.
 */
export function decodeConversationGrants(json: string | null): ConversationGrants {
  if (json === null) return { allow: [], deny: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { allow: [], deny: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { allow: [], deny: [] };
  const record = parsed as { version?: unknown; allow?: unknown; deny?: unknown };
  if (record.version !== 1) return { allow: [], deny: [] };
  const fallbackTime = new Date().toISOString();
  const readList = (value: unknown): ApprovalGrant[] =>
    Array.isArray(value)
      ? value
          .map((entry) => readGrant(entry, fallbackTime))
          .filter((grant): grant is ApprovalGrant => grant !== null)
          .map((grant) => ({ ...grant, scope: 'session' as const }))
      : [];
  return { allow: readList(record.allow), deny: readList(record.deny) };
}

/**
 * Load the grants a conversation had, for a resume to restore. Empty when history is off, the
 * store cannot be opened, the conversation has none, or the document cannot be read. Never throws.
 */
export function loadConversationGrantsSafe(
  config: HistoryConfigView,
  conversationId: number
): ConversationGrants {
  return decodeConversationGrants(readConversationGrantsSafe(config, conversationId));
}

/**
 * Store the grants a conversation has now. Called by the session on every change to the runner's
 * session-scoped grants, so the row is always the current set. A `conversationId` of `undefined`
 * (history off, or the row could not be opened) is a no-op — there is nowhere to write, and that is
 * the case where a grant correctly ends with the process. Never throws.
 */
export function saveConversationGrantsSafe(
  config: HistoryConfigView,
  conversationId: number | undefined,
  grants: ConversationGrants
): void {
  if (conversationId === undefined) return;
  try {
    writeConversationGrantsSafe(config, conversationId, encodeConversationGrants(grants));
  } catch {
    /* fail-soft: recording a grant must never be what breaks the turn that made it */
  }
}
