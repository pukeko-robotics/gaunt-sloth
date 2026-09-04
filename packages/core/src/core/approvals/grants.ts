/**
 * @module core/approvals/grants
 *
 * EXT-71 (spec §3, §3.1, §6) — **what the escalation menu remembers**, in the one entry grammar.
 *
 * A grant is an {@link ApprovalEntry} plus the metadata §3 requires a list to be able to show:
 * **when** it was made and **at what scope**. Two kinds of store hold them — an in-memory
 * {@link ApprovalGrantStore} for the life of one runner instance, and a
 * {@link PersistedApprovalGrants} backed by a project JSON file for `always` — and neither decides
 * anything. They hold entries; `core/approvals/matcher.ts` compares them. There is exactly one
 * comparison engine and it is not here.
 *
 * **Both are list-agnostic, and that is what keeps the two sides symmetric.** The runner holds four
 * of them: a session and a persisted store for what the menu *approved*, and the same pair for what
 * it *refused* ([[EXT-107]]). A store never learns which list it is; the file path decides that, and
 * the runner decides which list it hands to the matcher. A second class for refusals would be the
 * same code with one string changed, free to drift from its twin on every later edit.
 *
 * ## The menu never widens
 *
 * §3.1/§6: *always approve* and *always reject* write **the command the human saw**, as a
 * fully-explicit `exact` entry ({@link shellGrantEntry}) — never a prefix, never a pattern, never a
 * generalization. Breadth is always something a human typed into a config file. The other half of
 * that rule is equally load-bearing: **there is no second-guessing layer on top of a match**, so a
 * user's own entry naming a flag someone once thought dangerous (`curl -o out.txt`) is honored like
 * any other. Overruling it would be a control offered and then refused.
 *
 * **A tool grant records identity, not arguments** ({@link toolGrantEntry}, §4.7.4) — the tool, its
 * server where it has one, and the host where the call carries one. That is knowingly broader than
 * the shell's exact-command grant, because a repeat shell command usually is identical and a repeat
 * tool call usually is not; the host is the bound that keeps "broader" from meaning "every
 * counterparty, forever". A tool grant additionally carries the effective annotation set it was made
 * under, and weakening that set invalidates it ({@link annotationWeakenings}).
 *
 * The one thing {@link shellGrantEntry} does to the command is {@link normalizeCommand} it, because
 * that is the form every comparison runs over (§3.1: *"spacing and quoting spellings of one command
 * are therefore one command"*). Storing the raw string instead would mean the most ordinary grant
 * imaginable — `always approve` on the `"npm test\n"` a tool argument routinely carries — never
 * matching the command that produced it, which is the same "offered and then refused" failure with
 * the evidence hidden.
 *
 * ## The persisted file
 *
 * ```jsonc
 * {
 *   "version": 2,
 *   "grants": [
 *     { "entry": { "type": "shell", "matcher": "exact", "pattern": "npm test" },
 *       "grantedAt": "2026-08-02T09:15:00.000Z", "scope": "always" },
 *     { "entry": { "type": "mcpTool", "server": "fetcher", "matcher": "exact",
 *                  "pattern": "fetch_url", "host": "docs.internal.example" },
 *       "grantedAt": "2026-08-02T09:16:00.000Z", "scope": "always",
 *       "annotations": { "readOnlyHint": true, "destructiveHint": false,
 *                        "idempotentHint": true, "openWorldHint": true } }
 *   ]
 * }
 * ```
 *
 * `annotations` is absent on a `shell` grant and on any grant written before it existed; a grant
 * without one simply has nothing to invalidate it and stands as it did.
 *
 * Reads never throw: a missing, unreadable, malformed or partly-malformed file yields fewer grants
 * (at worst none) rather than raising at a user mid-run. **Fewer grants is fail-closed on the allow
 * side only** — an empty allow-list means *prompt*, while an empty DENY list means nothing refuses,
 * so the same recovery loses safety on one side and buys it on the other.
 *
 * **Which is why a read that lost something says so** ([[EXT-143]]). Recovering quietly was
 * defensible while this class held one list; with two it hides a lost refusal, and this is a project
 * file people hand-edit and commit whose characteristic failure is a typo. A user who saved twenty
 * refusals and later broke the file has no other way to learn that none of them are in force — the
 * gate behaves exactly as though they had never been saved. So a whole file that cannot be read, and
 * an individual entry that cannot be read, are both reported at {@link StatusLevel.ERROR}
 * ({@link unreadableFileNotice}, {@link skippedEntriesNotice}), while the fallback stays exactly
 * what it was.
 *
 * **And a store that could not read its file does not write it** ([[EXT-144]]). A write here
 * rewrites the WHOLE file from what is held in memory, which after a failed load is nothing — so one
 * saved answer would replace twenty saved ones with itself, turning a trailing comma into permanent
 * loss. Reading fails soft; writing over what the reader could not parse is the one recovery that
 * cannot be undone, so {@link PersistedApprovalGrants.tryPersist} refuses it and says so
 * ({@link refusedWriteNotice}). The answer still holds for this session — the runner keeps its own
 * in-memory copy — it is simply not written down.
 *
 * ## What this store CLAIMS is what the file holds
 *
 * [[EXT-149]] — **the store holds only grants the file is believed to hold**, and every method that
 * answers a question about the file answers it from that. {@link PersistedApprovalGrants.add}
 * returns whether the grant reached disk and takes back one that did not;
 * {@link PersistedApprovalGrants.remove} returns whether the deletion reached disk. A write that
 * merely FAILED — an unwritable checkout, a directory that is gone — is reported
 * ({@link failedWriteNotice}) rather than swallowed, because the caller above stamps an answer
 * `always` or `session` from these returns and a surface renders them as *saved to this project*.
 *
 * The one imprecision is deliberate and is in the safe direction: `inSync` is store-level, so after
 * a failed write an `add` of a grant the file DOES already hold answers `false`. Under-claiming
 * costs a re-prompt; over-claiming is the defect.
 *
 * ## A rewrite gives back the keys it does not use
 *
 * [[EXT-151]] — this is a file people hand-edit, and a whole-file rewrite from a store that models
 * two keys would delete everything else in it. Top-level keys this version does not use are carried
 * across the read and written back ({@link preservedKeys}), so a rewrite touches `version` and
 * `grants` and nothing else. Deleting the parts of a user's file we do not recognise is the worst
 * of the available answers; reporting the deletion is only the second worst.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { approvalEntrySchema, renderApprovalEntryObject } from '#src/config/schema.js';
import type {
  ApprovalEntry,
  McpToolApprovalEntry,
  ShellApprovalEntry,
  ToolApprovalEntry,
  ToolAnnotationHint,
} from '#src/config/shell-policy.js';
import type { ShellApprovalGateNotice } from '#src/config/shell-policy.js';
import { TOOL_ANNOTATION_HINTS } from '#src/config/shell-policy.js';
import {
  describeApprovalEntry,
  type EffectiveToolAnnotations,
  MCP_FAIL_CLOSED_ANNOTATIONS,
  type McpToolApprovalSubject,
  type ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';
import { UNRESOLVED_MCP_SERVER } from '#src/core/approvals/mcpSubjects.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import { StatusLevel, type ToolApprovalScope } from '#src/core/types.js';

/**
 * The scopes a grant can be REMEMBERED at. `once` is absent by construction: it persists nothing,
 * so it never becomes a grant.
 */
export type ApprovalGrantScope = Exclude<ToolApprovalScope, 'once'>;

/**
 * §3 — one thing the human granted: the entry that will be matched, plus what the approvals UI
 * must be able to show about it (*what* was granted, *when*, and *at what scope*).
 *
 * The metadata is display only. The `entry` is the whole of what decides.
 */
export interface ApprovalGrant {
  /** §3.1 — the entry, in the one grammar. */
  entry: ApprovalEntry;
  /** ISO-8601 instant the grant was made. */
  grantedAt: string;
  /** `session` for the life of this runner instance, `always` for the persisted store. */
  scope: ApprovalGrantScope;
  /**
   * §4.7.4 — **the effective annotation set (§4.7.1) this tool grant was made under**, so a later
   * `tools/list` that weakens it can be seen to have done so ({@link annotationWeakenings}) and the
   * approvals UI can show what the user believed they were granting.
   *
   * Absent on a `shell` grant, which has no annotations, and on a tool grant restored from a file
   * written before this field existed — in both cases there is nothing to compare, so the grant
   * simply stands.
   *
   * **A private copy, always**, made on the way into the store: an effective set is something the
   * source may hand out afresh or a caller may hold, and a snapshot that aliased either would let
   * one grant's record be rewritten by something outside it — which is the same class of bug as a
   * source returning the shared fail-closed constant instead of a copy.
   */
  annotations?: EffectiveToolAnnotations;
}

/** On-disk shape of the persisted (`always`) grant store. */
interface PersistedGrantsFileV2 {
  version: 2;
  grants: ApprovalGrant[];
}

/**
 * [[EXT-144]] — **what a read found, as far as WRITING over the file is concerned.**
 *
 * - `readable` — the file was read, or is not there at all. A save may rewrite it.
 * - `holdsContent` — it could not be read AND holds something a human could get back by fixing it.
 *   A save would destroy that; this is the case the guard exists for.
 * - `holdsNothing` — it could not be read, and there is nothing in it to recover
 *   ({@link holdsRecoverableText}). A save would destroy nothing, and it is still refused: what
 *   counts as a failed load is {@link unreadableFileNotice}'s question, already settled by
 *   [[EXT-143]], and a write guard that disagreed with the reader about which files are broken would
 *   be a second definition free to drift from the first. It is also the shape a truncated write
 *   leaves behind, which is not a thing to overwrite on sight.
 *
 * It is a separate value from "may I write" because the two answers differ: `holdsNothing` forbids
 * the write like `holdsContent` does, but the user must not be told their entries are safe when the
 * file they are in holds none.
 *
 * **The line between the last two is drawn at recoverable TEXT, not at zero bytes** ([[EXT-149]]).
 * A file truncated to a lone brace has a byte in it and nothing to get back, and the promise written
 * for `holdsContent` — *the refusals you saved in it are still there* — is false of it.
 */
type StoreReadState = 'readable' | 'holdsContent' | 'holdsNothing';

/**
 * [[EXT-149]] — **does an unreadable file hold anything a human could get back by fixing it?**
 *
 * The write guard refuses either way ({@link StoreReadState}); this decides only what the user is
 * TOLD, and the two messages make opposite promises. The predicate is *is any text left once JSON's
 * own punctuation and whitespace are removed*: a file emptied by hand, one an editor left holding a
 * newline, and one truncated to `{` or `{"` all hold nothing, while a trailing comma inside a real
 * entry list leaves every entry's own text behind.
 *
 * **Every line ending counts as whitespace, and that is load-bearing.** `\s` matches `\r` as well as
 * `\n`, so a file written on a CRLF checkout classifies exactly as the same file written with LF. A
 * predicate that reached the same place by splitting on `'\n'` would leave a stray `\r` behind and
 * call an empty file full — with no crash, on Windows only.
 *
 * `undefined` means the read itself threw (a permission error, say), where the content is unknown
 * and the conservative answer is that there is something to protect.
 */
function holdsRecoverableText(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.replace(/[\s{}[\],:"]/g, '').length > 0;
}

/**
 * What one read of the persisted file produced: the grants recovered from it, whether that read
 * migrated a v1 file (and so owes it a rewrite), [[EXT-144]] — what it found in the file, which is
 * what forbids every later rewrite — and [[EXT-151]] — the top-level keys this version does not use,
 * which a rewrite has to give back.
 */
interface LoadedGrants {
  grants: ApprovalGrant[];
  migrated: boolean;
  readState: StoreReadState;
  preserved: Record<string, unknown>;
  /**
   * [[EXT-151]] — the v1 members the migration could not carry.
   *
   * Carried out of the read rather than reported inside it, because the sentence the reader gets is
   * that these are **gone from the file**, and that only becomes true when the migration's rewrite
   * lands. The read cannot know that yet; only the caller that performs the write does. Reporting it
   * here would rebuild, inside this node's own fix, the exact defect this node exists to remove.
   */
  dropped: readonly { position: number; value: unknown }[];
}

/** The top-level keys this version writes, and so the only ones a rewrite may replace. */
const OWN_KEYS_V2 = ['version', 'grants'] as const;

/** The v1 keys a migration consumes: `prefixes` becomes grants, `version` is rewritten. */
const OWN_KEYS_V1 = ['version', 'prefixes'] as const;

/**
 * [[EXT-151]] — **the top-level keys this version does not use**, kept so a rewrite gives them back
 * instead of deleting them.
 *
 * This is a file people hand-edit and commit, and a whole-file rewrite from an in-memory model of
 * two keys silently destroys every other one. The protection was already there for a file with no
 * `grants` key at all ([[EXT-144]] refuses to write it); a file with `grants` AND a key of the
 * user's own read cleanly and lost the second half on the next save — the same loss, guarded on one
 * side of a line the user cannot see.
 *
 * Preserving rather than merely reporting is the choice, because reporting a deletion is still a
 * deletion. Nothing here makes an unknown key mean anything: it is carried, not interpreted.
 */
function preservedKeys(parsed: object, consumed: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!consumed.includes(key)) kept[key] = value;
  }
  return kept;
}

/** The version this module writes. */
const PERSISTED_VERSION = 2 as const;

/**
 * §3.1/§6 — the entry the escalation menu writes for a shell command: **that command, and only
 * that command**.
 *
 * The single place a menu grant's entry is built, so the line the prompt shows the human ("this is
 * what will be stored") and the line that lands in the store cannot drift apart.
 */
export function shellGrantEntry(command: string): ShellApprovalEntry {
  return { type: 'shell', matcher: 'exact', pattern: normalizeCommand(command) };
}

/**
 * §4.7.4/§6 — the entry the escalation menu writes for a **tool** call: the tool's identity, plus
 * the host where the call carries one.
 *
 * The counterpart of {@link shellGrantEntry} and the single place a tool grant's entry is built, so
 * the line the prompt shows the human and the line that lands in the store cannot drift apart.
 *
 * **Identity, never arguments.** A grant recording a full argument signature would never match a
 * second time — not a narrower grant, a useless one. That is knowingly broader than the shell's
 * exact-command grant, with one bound: on the shell path §4.6's escape carries the host inside the
 * command string, so it is host-scoped by construction, while a tool-identity-only grant on a fetch
 * tool would be every host, forever.
 *
 * `server` on an `mcpTool` grant is the user's own `mcpServers` config key (§4.7.5). Nothing a
 * server declares about its own name participates, and a grant for one server's tool can never be
 * claimed by another server's same-named tool because the other server sits under a different key.
 *
 * **Returns `null` for a call whose server could not be resolved.** {@link UNRESOLVED_MCP_SERVER}
 * is the empty string, which `server` (`z.string().min(1)`) cannot hold: such an entry would be
 * written to the file and then silently dropped by the grammar's own validator on the next read, so
 * the human would be told their approval was remembered when it was not. A call nobody can attribute
 * to a server is not one anything can remember.
 */
export function toolGrantEntry(
  subject: ToolApprovalSubject | McpToolApprovalSubject
): ToolApprovalEntry | McpToolApprovalEntry | null {
  const host = subject.host !== undefined && subject.host.length > 0 ? subject.host : undefined;
  if (subject.kind === 'mcpTool') {
    if (subject.server === UNRESOLVED_MCP_SERVER) return null;
    return {
      type: 'mcpTool',
      server: subject.server,
      matcher: 'exact',
      pattern: subject.name,
      ...(host !== undefined ? { host } : {}),
    };
  }
  return {
    type: 'tool',
    matcher: 'exact',
    pattern: subject.name,
    ...(host !== undefined ? { host } : {}),
  };
}

/**
 * §4.7.4 — **the three moves that weaken an effective annotation set**, and the whole of what
 * invalidates a grant. Each names the hint and the transition, so the notice a human reads can say
 * which one moved.
 *
 * They are exactly the moves that make a tool a more dangerous proposition than the one that was
 * approved. The mirror images — a tool becoming read-only, closing to the open world, or ceasing to
 * destroy — are strengthenings and change nothing: a grant is a permission, and a tool that has
 * become safer is still covered by it.
 */
const WEAKENING_MOVES: readonly { hint: ToolAnnotationHint; from: boolean; to: boolean }[] = [
  { hint: 'readOnlyHint', from: true, to: false },
  { hint: 'openWorldHint', from: false, to: true },
  { hint: 'destructiveHint', from: false, to: true },
];

/**
 * §4.7.4 — which hints moved in the weakening direction between the set a grant was made under and
 * the set that holds now. Empty means the grant still stands.
 *
 * **Only the four booleans are compared, so schema and description changes invalidate nothing** —
 * not by a rule that exempts them, but because a snapshot is four booleans and a description is not
 * one of them. Descriptions churn on every server release, and a grant that dissolved on churn
 * would teach users that grants are worthless.
 *
 * **An untrusted server's declaration change likewise invalidates nothing**, again by construction:
 * §4.7.1 makes an untrusted server's effective set the constant fail-closed default, so both sides
 * of this comparison are that constant however the server re-declares itself. Only a **trusted**
 * server can move an effective value — which is exactly where invalidation matters, since the
 * trusted server is the one whose rug-pull would otherwise ride an existing grant.
 */
export function annotationWeakenings(
  snapshot: EffectiveToolAnnotations,
  current: EffectiveToolAnnotations
): ToolAnnotationHint[] {
  return WEAKENING_MOVES.filter(
    ({ hint, from, to }) => snapshot[hint] === from && current[hint] === to
  ).map(({ hint }) => hint);
}

/**
 * §4.7.1/§4.7.4 — **can WITHDRAWING trust in this hint weaken an effective set?**
 *
 * Withdrawing trust pushes a hint back to its MCP fail-closed default, and every weakening move
 * *ends* at that default, so the answer does not depend on what a server declared: it is exactly
 * whether the move (not-the-default → the default) is one of {@link WEAKENING_MOVES}. Three of the
 * four hints answer yes — `readOnlyHint`, `openWorldHint` and `destructiveHint`, whose fail-closed
 * default is `true`, so a server whose `destructiveHint: false` was believed becomes destructive
 * again the moment it is not. `idempotentHint` is the only one that answers no, because no
 * weakening move names it.
 *
 * **It asks {@link annotationWeakenings} rather than restating the table.** A second statement of
 * which moves weaken is how a warning comes to describe a rule the gate no longer has — which
 * matters most here, since this decides whether the human is told their saved approvals are about
 * to be withdrawn.
 */
export function trustWithdrawalWeakens(hint: ToolAnnotationHint): boolean {
  const untrusted: EffectiveToolAnnotations = { ...MCP_FAIL_CLOSED_ANNOTATIONS };
  const trusted: EffectiveToolAnnotations = { ...untrusted, [hint]: !untrusted[hint] };
  return annotationWeakenings(trusted, untrusted).includes(hint);
}

/**
 * §4.7.4 — the notice a weakened grant is removed with. **It names the tool, the server and the
 * hint that moved**, because the human approved a tool *as annotated*: a tool that re-annotates
 * itself into a more dangerous shape is a different proposition wearing the same name, and a notice
 * that did not say which name changed would be indistinguishable from the gate malfunctioning.
 *
 * It takes the **entry** rather than the call's subject, so it describes the grant that was actually
 * withdrawn — including its host bound, where it had one. One call may withdraw both a host-bound
 * grant and a tool-only one, and two notices that could not be told apart would be worse than one.
 * The entry is rendered by {@link describeApprovalEntry}, the same one-liner every other provenance
 * message uses.
 */
export function describeWeakenedGrant(
  entry: ApprovalEntry,
  weakened: readonly ToolAnnotationHint[],
  snapshot: EffectiveToolAnnotations,
  current: EffectiveToolAnnotations
): string {
  const moves = weakened
    .map((hint) => `${hint} changed from ${snapshot[hint]} to ${current[hint]}`)
    .join(', ');
  return (
    `Your saved approval for ${describeApprovalEntry(entry)} was removed: the tool now describes ` +
    `itself as more dangerous than when you approved it (${moves}). You will be asked about the ` +
    'next call.'
  );
}

/**
 * Identity of an entry, for **de-duplication only** — never a match decision. Two grants are the
 * same grant when they would be the same line in a config file; whether an entry matches a call is
 * `resolveApprovalRules`'s alone, and nothing in this module may answer that question.
 */
function grantKey(entry: ApprovalEntry): string {
  return renderApprovalEntryObject(entry);
}

/**
 * The `always` timestamp for entries migrated from the v1 file, which recorded none: the file's own
 * last-write time, which is when the last of those grants was actually made. Falls back to now when
 * the file cannot be stat'd.
 */
function fileWriteTime(filePath: string): string {
  try {
    return new Date(statSync(filePath).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Read a persisted {@link ApprovalGrant.annotations} snapshot.
 *
 * Three outcomes, and the middle one is the point: `undefined` when the field is absent (a `shell`
 * grant, or a tool grant written before the field existed — nothing to compare, so the grant
 * stands), the set when it is four booleans, and `null` when it is **present and malformed**, which
 * drops the whole grant.
 *
 * That last case is deliberately harsher than the rest of {@link readGrant}, and for a reason that
 * does not apply to the other metadata: **this field decides something.** `grantedAt` and `scope`
 * are display, so coercing them costs nothing; a snapshot is what invalidation compares against, so
 * a coerced one (a string `"true"` read as truthy) would feed a wrong comparison into the check and
 * could conclude that a weakened tool had not weakened. Between dropping the snapshot — which leaves
 * a rug-pull free to ride the grant — and dropping the grant, which costs a re-prompt, the field
 * exists to fail closed and so does this.
 */
function readAnnotationSnapshot(value: unknown): EffectiveToolAnnotations | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const snapshot: Record<string, boolean> = {};
  for (const hint of TOOL_ANNOTATION_HINTS) {
    if (typeof record[hint] !== 'boolean') return null;
    snapshot[hint] = record[hint] as boolean;
  }
  return snapshot as unknown as EffectiveToolAnnotations;
}

/**
 * Read one persisted grant defensively. The **entry is validated by the config grammar's own
 * schema** — one grammar, one validator — so a malformed entry is dropped here and can never reach
 * the matcher. Timestamp and scope are coerced rather than validated: they decide nothing, and
 * discarding a real grant over a missing timestamp would cost an approval the human already gave.
 * The annotation snapshot is the exception ({@link readAnnotationSnapshot}), because it decides.
 */
/**
 * Read one stored grant, or `null` when the value is not one: no readable entry, or an annotation
 * snapshot that is present and malformed (see `readAnnotationSnapshot`).
 *
 * Exported because the conversation-grants document a resume restores
 * (`core/approvals/conversationGrants.ts`) stores grants in this same shape, and one reader for
 * both files is what keeps the two from accepting different things.
 */
export function readGrant(value: unknown, fallbackTime: string): ApprovalGrant | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as {
    entry?: unknown;
    grantedAt?: unknown;
    scope?: unknown;
    annotations?: unknown;
  };
  const parsed = approvalEntrySchema.safeParse(record.entry);
  if (!parsed.success) return null;
  const annotations = readAnnotationSnapshot(record.annotations);
  if (annotations === null) return null;
  return {
    entry: parsed.data as ApprovalEntry,
    grantedAt: typeof record.grantedAt === 'string' ? record.grantedAt : fallbackTime,
    scope: record.scope === 'session' ? 'session' : 'always',
    ...(annotations !== undefined ? { annotations } : {}),
  };
}

/**
 * A set of grants with entry-identity semantics. Pure data + membership: it holds what the human
 * granted and answers *is this the same grant*, never *does this grant cover that command*.
 */
export class ApprovalGrantStore {
  private readonly grants: ApprovalGrant[] = [];

  constructor(initial: readonly ApprovalGrant[] = []) {
    for (const grant of initial) this.add(grant);
  }

  /**
   * Add a grant. Returns whether it was new — an identical entry is not stored twice.
   *
   * The {@link ApprovalGrant.annotations} snapshot is **copied on the way in**, so what the store
   * holds is private to this grant whatever the caller passed: the effective set may be a live
   * object the caller keeps, or (were a source ever to regress) the shared fail-closed constant, and
   * a store aliasing either would let one grant's record be rewritten from outside it. Copying here
   * rather than at each call site makes that structural instead of a habit every caller must keep.
   */
  add(grant: ApprovalGrant): boolean {
    const key = grantKey(grant.entry);
    if (this.grants.some((held) => grantKey(held.entry) === key)) return false;
    this.grants.push(
      grant.annotations ? { ...grant, annotations: { ...grant.annotations } } : grant
    );
    return true;
  }

  /**
   * The grant stored under this entry's identity, or `undefined`.
   *
   * **Identity, never a match decision** — the same de-duplication question {@link add} asks. It
   * answers *"is this the same grant"*, and whether a grant covers a call remains
   * `resolveApprovalRules`'s alone.
   */
  find(entry: ApprovalEntry): ApprovalGrant | undefined {
    const key = grantKey(entry);
    return this.grants.find((held) => grantKey(held.entry) === key);
  }

  /**
   * Drop the grant stored under this entry's identity. Returns whether one was there.
   *
   * §4.7.4's invalidation is a **removal** rather than a skip, and that is load-bearing: {@link add}
   * de-duplicates by entry identity, so a grant left in place while being ignored would silently
   * swallow the human's re-approval of the same tool — the grant would appear to be re-made and the
   * stale snapshot would keep invalidating it.
   */
  remove(entry: ApprovalEntry): boolean {
    const key = grantKey(entry);
    const index = this.grants.findIndex((held) => grantKey(held.entry) === key);
    if (index < 0) return false;
    this.grants.splice(index, 1);
    return true;
  }

  /** Every grant, in the order they were made. */
  list(): ApprovalGrant[] {
    return [...this.grants];
  }

  /** Just the entries, for handing to the matcher as one of its rule lists. */
  entries(): ApprovalEntry[] {
    return this.grants.map((grant) => grant.entry);
  }

  /** How many grants are held. */
  size(): number {
    return this.grants.length;
  }
}

/**
 * [[EXT-143]] — the words a load-failure notice uses for what the file holds
 * ({@link PersistedApprovalGrantsOptions.holds}), and what it says when the caller did not say.
 *
 * **The fallback is deliberately vague, and a confident default would be the bug.** These notices
 * exist to correct a false belief about a specific file; a default of `'approvals'` would put that
 * exact word into the message a *deny* store prints, so the one sentence written to stop a user
 * trusting something that is not in force would misname what they lost. A caller that says nothing
 * gets a sentence that is true of either file instead.
 */
function savedNoun(holds: 'approvals' | 'refusals' | undefined): string {
  return holds ?? 'decisions';
}

/** The reason clause for a file that parsed but holds no entry list this version can read. */
const UNRECOGNISED_SHAPE = 'the file holds no list of saved entries this version recognises';

/**
 * [[EXT-143]] — **did this shape lose something a human saved?**
 *
 * {@link unreadableFileNotice} asserts a loss, so it may only fire where there is one. A file whose
 * entry list is absent or empty — `{}`, a bare `{"version": 2}`, a v1 `{"prefixes": []}`, a JSON
 * `null` — holds nothing, and telling its owner every session that saved answers they do not have
 * are not in force is the same over-claim the consequence sentence had to drop, one level down.
 *
 * What counts as a loss is **a non-empty list under any key at all**, or **a value sitting where a
 * list belongs** — a `grants` key holding something other than an array, or a scalar where the store
 * object should be. Neither is what emptying the file by hand produces (that yields `{}`, or an empty
 * file, which fails to parse and is reported with the reader's own reason instead), so both are
 * content this version cannot read.
 *
 * **Any key, deliberately, and not just `grants`/`prefixes`.** Those two are the only keys a shipped
 * version ever wrote, so keying the test on them would be defensible — but the reader this notice
 * exists for is the one who hand-edits the file, and a list they typed under a name we do not know is
 * still a list we are not reading. Silence there would be the very trap the notice was added to
 * close: a file that looks full and holds nothing the gate can see.
 */
function holdsSavedEntries(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (parsed === null || typeof parsed !== 'object') return parsed !== null;
  const values = Object.values(parsed as Record<string, unknown>);
  if (values.some((value) => Array.isArray(value) && value.length > 0)) return true;
  const { grants, prefixes } = parsed as { grants?: unknown; prefixes?: unknown };
  return [grants, prefixes].some((list) => list !== undefined && !Array.isArray(list));
}

/** How much of one unreadable entry a notice quotes back, and how many it quotes at all. */
const SKIPPED_ENTRY_CHARS = 160;
const SKIPPED_ENTRIES_NAMED = 5;

/** Clip a quoted fragment so one enormous entry cannot become the whole message. */
function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The reason clause for a file that could not be opened, parsed or written, in its own words. */
function describeIoFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? clip(collapsed, 200) : 'the file could not be opened';
}

/**
 * [[EXT-143]] — **the whole file could not be read, so nothing saved in it is in force.**
 *
 * It names the file, the reason (a JSON parser's own message points a hand-editor straight at their
 * trailing comma) and the **consequence**, which is the part a user cannot infer. Saying only that
 * a file failed to parse would leave the reader to guess whether their saved answers still hold.
 *
 * **The consequence stops at what is certain, and a prompt is not certain.** A failed load empties
 * one rule list; it decides nothing. A call that list covered is then settled by whatever else the
 * gate holds, so at `bypass` — or under any allow entry matching the same command, with the gate
 * fully on — a saved refusal that broke does not come back as a question: the command runs, unasked.
 * A sentence promising a prompt would understate the loss in exactly the configuration the deny
 * store exists for, so this one names the possible outcomes and claims none of them.
 *
 * ## The level, for this notice and {@link skippedEntriesNotice} alike
 *
 * **{@link StatusLevel.ERROR}, not a warning**, and the axis is **filterability**. `consoleLevel` is
 * user-configurable down to `error`, at which a WARNING is dropped entirely while the session runs
 * on and an ERROR is still shown — and the whole defect being fixed is a user not being told. How
 * much was lost is deliberately *not* the axis: bounded scope is a real argument about prominence,
 * but a loss filtered to nothing is silence whatever its size, and silence is the thing this exists
 * to end. Two supporting reasons apply to both notices equally: the state is one the user did not
 * choose and cannot otherwise discover, unlike the `bypass` advisory (a WARNING) which describes
 * something they just did; and it is time-limited, because the next saved entry rewrites this file
 * from a store that never held what could not be read.
 *
 * Two bounds on that argument, so a later reader does not over-read it. ERROR is not unmissable —
 * `consoleLevel: 'stream'` (6) filters ERROR (5) too, and the true claim is only that ERROR
 * dominates WARNING at every setting. And it is an argument about the **console** surface: the Ink
 * TUI does not consult `consoleLevel` at all, dropping only INFO/DEBUG from the transcript, so there
 * a WARNING and an ERROR are equally visible and this reasoning buys nothing.
 *
 * It is **not** fatal. The session continues on whatever rules remain, because a refusal to start
 * over a bookkeeping file would be a worse answer than any of them.
 */
function unreadableFileNotice(
  filePath: string,
  holds: 'approvals' | 'refusals' | undefined,
  reason: string
): ShellApprovalGateNotice {
  return {
    level: StatusLevel.ERROR,
    message:
      `Your saved shell ${savedNoun(holds)} could not be read from ${filePath} (${reason}). ` +
      'None of them are in force in this session — nothing in this file applies to any call, so a ' +
      'call it covered is left to the rest of the gate: it may be refused by another rule, it may ' +
      'run without asking, or you may be prompted. Fix the file to restore them. Until you do, the ' +
      'file is left as it is and answers you save are not written to it.',
  };
}

/**
 * [[EXT-144]] — **the answer was not saved, and the file it would have been saved to is untouched.**
 *
 * The write side of {@link unreadableFileNotice}, and the reason it can be worded as flatly as it
 * is: nothing is lost by the time this is read. A persist rewrites the whole file from the store,
 * and a store whose load failed holds nothing, so writing would have replaced everything the user
 * saved with the one entry they just answered — a recoverable syntax error made permanent by the
 * keystroke most likely to follow the notice that reported it.
 *
 * It says three things, and each is one the reader cannot infer:
 *
 * - **The answer was not saved**, which contradicts what the surface that took the answer already
 *   told them — a menu label promising `always` is written before this code runs, so silence here
 *   would leave a false claim standing as the last word.
 * - **The file was left as it is**, which is the whole recovery wherever there is something to
 *   recover: the entries are still on disk and come back when the file parses. Nothing has to have
 *   been copied in advance, and nothing new was put beside it to reconcile. **An empty file is the
 *   exception and is worded separately**, because it holds no entries that could still be there and
 *   none that could come back — a sentence promising both would be this node's own defect, told
 *   rather than done.
 * - **What to do** — fix the error the load already quoted, then answer again **in a new session**.
 *
 * **"In a new session" is load-bearing and must not be trimmed.** A store reads its file once and
 * keeps what it found: the runner caches the instance for the life of the runner
 * (`persistedGrantsLoaded` / `persistedDenialsLoaded`, set once and never reset), so a user who
 * repairs the file and answers again in the same session is refused by the same cached state and
 * gets this identical message in a loop. Telling them to answer again *now* would make the one
 * sentence that exists to correct a false belief about their file into another one.
 *
 * {@link StatusLevel.ERROR}, on the same filterability axis argued in {@link unreadableFileNotice}:
 * `consoleLevel` is user-configurable down to `error`, at which a WARNING is dropped entirely, and a
 * user who believes an answer was saved when it was not is exactly who this exists for.
 *
 * **One per refused answer, deliberately not de-duplicated.** Each answer is a separate thing the
 * user believes they have written down, and collapsing the second and third would leave two of those
 * beliefs uncorrected.
 */
function refusedWriteNotice(
  filePath: string,
  holds: 'approvals' | 'refusals' | undefined,
  state: Exclude<StoreReadState, 'readable'>
): ShellApprovalGateNotice {
  // A file with nothing recoverable in it has nothing to preserve, so the recovery sentence written
  // for the case this guard exists for would be a false promise here: there is nothing still there
  // and nothing that comes back. It is still not overwritten — see {@link StoreReadState} — so what
  // the reader needs instead is the one action that makes the file readable again.
  const recovery =
    state === 'holdsNothing'
      ? `It has been left exactly as it is, and there is nothing in it to recover: it holds no ` +
        `saved shell ${savedNoun(holds)} — only empty space, or the punctuation of a file that was ` +
        'cut short. Delete it, or put an empty pair of braces in it, and answer again in a new ' +
        'session to save this one.'
      : `Saving would have replaced everything in it with this one entry, so it has been left ` +
        `exactly as it is and the shell ${savedNoun(holds)} you saved in it are still there. Fix ` +
        'the error reported when it was read and they come back; then answer again in a new ' +
        'session to add this one.';
  return {
    level: StatusLevel.ERROR,
    message:
      `This answer was NOT saved to ${filePath}, because that file could not be read when this ` +
      // GS2-20 — an unsaved answer is held with the CONVERSATION (recorded in the history store and
      // installed again on a resume), so the fallback lifetime is the conversation's.
      `session started. ${recovery} For now the answer applies to this conversation only: ` +
      'resuming it keeps the answer, and any other conversation will ask again.',
  };
}

/**
 * Why {@link PersistedApprovalGrants.tryPersist} is writing, which is the whole of what the user
 * needs to be told when it cannot. The three have different consequences and one wording could not
 * be true of all of them: an unsaved answer is absent next session, an unsaved lift is *present*
 * next session, and an unperformed migration changes nothing at all.
 */
type WritePurpose = 'save' | 'lift' | 'migrate';

/**
 * [[EXT-149]] — **the file could be read, and could not be written.**
 *
 * The sibling of {@link refusedWriteNotice} and a different case from it. There the file holds
 * somebody else's content and the store declines to touch it; here the store was entitled to write
 * and the write threw — an unwritable checkout, a settings directory that has since gone, a full
 * disk. Nothing was lost either way, which is why both can be worded this flatly.
 *
 * **It exists because this outcome used to be silent.** The throw is swallowed so a bookkeeping
 * write can never end a run, and swallowing it left the one surface that had already promised the
 * user something — a menu label reading `always`, a notice reading *removed from this project's
 * saved refusals* — as the last word on a file that never changed.
 *
 * It names the file, the reason in the operating system's own words (which is what points a reader
 * at a permission bit or a missing directory), and the consequence, which is the half nobody can
 * infer and the half that differs per {@link WritePurpose}.
 *
 * {@link StatusLevel.ERROR} for the two the user answered for, on the filterability axis argued in
 * {@link unreadableFileNotice}: `consoleLevel` is configurable down to `error`, where a WARNING is
 * dropped entirely, and a user who believes an answer was written down when it was not is exactly
 * who this exists for. A failed MIGRATION is a WARNING instead, and the difference is the axis
 * itself: nobody was told anything about it, nothing they hold is wrong, and the whole consequence
 * is that the same INFO notice appears again next session.
 */
function failedWriteNotice(
  filePath: string,
  holds: 'approvals' | 'refusals' | undefined,
  purpose: WritePurpose,
  reason: string
): ShellApprovalGateNotice {
  if (purpose === 'lift') {
    return {
      level: StatusLevel.ERROR,
      message:
        `${filePath} could NOT be updated (${reason}), so this entry is still saved in it. It is ` +
        // GS2-20 — the lift, like a grant, is held with the conversation.
        'lifted for the rest of this conversation and it will be back in any other, until that ' +
        'file can be written or you remove the entry from it by hand.',
    };
  }
  if (purpose === 'migrate') {
    return {
      level: StatusLevel.WARNING,
      message:
        `Your saved shell ${savedNoun(holds)} (${filePath}) could not be rewritten in the current ` +
        `format (${reason}). They are in force for this session and the file is unchanged, so this ` +
        'is reported again in your next session until that file can be written.',
    };
  }
  return {
    level: StatusLevel.ERROR,
    message:
      `This answer was NOT saved to ${filePath}, because that file could not be written ` +
      `(${reason}). Nothing in it was lost — it was read normally and is left exactly as it is. ` +
      // GS2-20 — the fallback lifetime is the conversation's: kept in the history store, back on
      // a resume, absent from any other conversation.
      'The answer applies to this conversation only; resuming it keeps the answer, and any other ' +
      'conversation will not have it.',
  };
}

/**
 * [[EXT-143]] — **the entries that could not be read, each named where it sits in the file.**
 *
 * A position and the text itself, because the point of the message is that the user can go and find
 * the thing: this is a file they may have committed, and "one of your entries is malformed" sends
 * them reading forty of them. One notice per file rather than one per entry, the same choice the
 * migration notice makes — a line each would bury the count in its own repetition.
 *
 * **The same {@link StatusLevel.ERROR} the whole-file case gets**, on the same filterability axis,
 * argued once in {@link unreadableFileNotice}. Bounded scope was the obvious reason to go quieter
 * here and is the wrong axis: at `consoleLevel: error` a WARNING is filtered to nothing, and this
 * case emits no file-level notice to fall back on, so the one refusal the human typed would be lost
 * in exactly the silence the whole notice exists to end. The bound is still worth saying, and the
 * message says it — the rest of the file is in force — which is a statement to the reader, not a
 * reason to make it easier to miss.
 *
 * The level is the same on both sides for a second reason: raising it only for a broken *deny* entry
 * would make {@link PersistedApprovalGrantsOptions.holds} decide something, and it is a noun. A
 * per-side level means reopening that seam deliberately, not arriving there by wording.
 */
function skippedEntriesNotice(
  filePath: string,
  holds: 'approvals' | 'refusals' | undefined,
  skipped: readonly { position: number; value: unknown }[]
): ShellApprovalGateNotice {
  const named = skipped
    .slice(0, SKIPPED_ENTRIES_NAMED)
    .map(({ position, value }) => {
      const rendered = JSON.stringify(value) ?? String(value);
      return `entry ${position} — ${clip(rendered, SKIPPED_ENTRY_CHARS)}`;
    })
    .join('; ');
  const unnamed = skipped.length - SKIPPED_ENTRIES_NAMED;
  const rest = unnamed > 0 ? `; and ${unnamed} more` : '';
  const one = skipped.length === 1;
  return {
    level: StatusLevel.ERROR,
    message:
      `${skipped.length} ${one ? 'entry' : 'entries'} in your saved shell ${savedNoun(holds)} ` +
      `(${filePath}) could not be read and ${one ? 'was' : 'were'} skipped: ${named}${rest}. ` +
      `${one ? 'It is' : 'They are'} not in force; the rest of the file is.`,
  };
}

/**
 * [[EXT-151]] — **the v1 members the migration could not carry, and the rewrite therefore DELETED.**
 *
 * The migration's twin of {@link skippedEntriesNotice}, and a separate message because the two
 * outcomes differ in the one way the reader cares about: a skipped v2 entry is still in their file
 * and can be fixed, and a dropped v1 prefix is gone from it the moment the migration writes. Saying
 * so is the whole point — this path used to be the one place a loss happened with a sentence beside
 * it claiming that nothing had been removed.
 *
 * Same shape as its twin — a position and the text itself, capped at {@link SKIPPED_ENTRIES_NAMED}
 * with a count for the rest — because the reader's job is the same: find the thing in a file they
 * may have committed. Same {@link StatusLevel.ERROR}, on the filterability axis argued in
 * {@link unreadableFileNotice}.
 *
 * **Only the caller that performed the rewrite may send this**, and only when the rewrite landed:
 * every sentence in it is about a file that has already changed. The constructor is that caller, and
 * the read hands it the dropped members rather than reporting them from inside itself.
 */
function droppedPrefixesNotice(
  filePath: string,
  holds: 'approvals' | 'refusals' | undefined,
  dropped: readonly { position: number; value: unknown }[]
): ShellApprovalGateNotice {
  const named = dropped
    .slice(0, SKIPPED_ENTRIES_NAMED)
    .map(({ position, value }) => {
      const rendered = JSON.stringify(value) ?? String(value);
      return `entry ${position} — ${clip(rendered, SKIPPED_ENTRY_CHARS)}`;
    })
    .join('; ');
  const unnamed = dropped.length - SKIPPED_ENTRIES_NAMED;
  const rest = unnamed > 0 ? `; and ${unnamed} more` : '';
  const one = dropped.length === 1;
  return {
    level: StatusLevel.ERROR,
    message:
      `${dropped.length} ${one ? 'entry' : 'entries'} in your saved shell ${savedNoun(holds)} ` +
      `(${filePath}) could not be carried into the current format and ${one ? 'has' : 'have'} been ` +
      `REMOVED from the file: ${named}${rest}. ${one ? 'It is' : 'They are'} not in force and the ` +
      `file no longer holds ${one ? 'it' : 'them'}; add ${one ? 'it' : 'them'} back as a command ` +
      'if you still want it.',
  };
}

/** Optional seams for {@link PersistedApprovalGrants}. */
export interface PersistedApprovalGrantsOptions {
  /**
   * Where the v1→v2 migration notice goes — the established {@link ShellApprovalGateNotice} shape
   * the runner forwards to `statusUpdate`. Absent means the migration happens silently, which is
   * why the runner always passes one.
   */
  onNotice?: (notice: ShellApprovalGateNotice) => void;
  /**
   * Whether a file holding the v1 `prefixes` array is migrated to `exact` entries. **True by
   * default, and set false by the deny store** ([[EXT-107]]), for two independent reasons:
   *
   * - **`prefixes` was never a format on the deny side.** A deny file carrying one was hand-written
   *   by analogy, and turning a guess into standing refusals — with a notice worded for saved
   *   *approvals*, which is the only notice there is — would report a migration that did not
   *   describe what happened.
   * - **A migration WRITES.** The deny store is read at every rung, `bypass` included, because a
   *   refusal is resolved before the bypass return; the allow store is not read there precisely so
   *   that a session with the gate switched off never rewrites the project's grant file. Leaving
   *   this on would give the deny store the one load path that writes.
   */
  legacyPrefixMigration?: boolean;
  /**
   * [[EXT-143]] — **what this file holds, in the noun a user reads** in a load-failure notice
   * ({@link unreadableFileNotice}, {@link skippedEntriesNotice}). The allow store passes
   * `'approvals'` and the deny store `'refusals'`.
   *
   * It is a word, not a behaviour, and that is what keeps the class list-agnostic: nothing here
   * reads it, compares against it or decides by it. A store still never learns which list it is —
   * the file path decides that and the runner decides which list it hands to the matcher — but a
   * message that could not name what was lost would be a message the reader cannot act on, since
   * the two files fail in opposite directions.
   *
   * Omitting it is safe: {@link savedNoun} then says something true of either file rather than
   * guessing. What is NOT safe is defaulting it to one side, so it does not.
   */
  holds?: 'approvals' | 'refusals';
}

/**
 * The persisted (`always`) grant store, backed by a JSON file whose path is injected (the runner
 * resolves it via fileUtils → `.gsloth/.gsloth-settings/shell-allowlist.json` for approvals and
 * `…/shell-denylist.json` for refusals) so tests can point it at a temp dir.
 *
 * **One class, two files.** Which list a store's entries belong to is the caller's question, not
 * this class's: it holds {@link ApprovalGrant} records and writes them back. The only thing either
 * side configures is {@link PersistedApprovalGrantsOptions.legacyPrefixMigration}, which the deny
 * store turns off.
 *
 * ## The v1 migration, and the direction it goes
 *
 * The shipped v1 file held `prefixes: string[]` — classified command PREFIXES, so a stored
 * `npm test` also auto-approved `npm test --watch`. Each prefix migrates to an **`exact` entry for
 * the same string**, with **one** notice naming the file.
 *
 * That narrows what the file grants, on purpose: a v1 prefix was broader than what the human was
 * actually shown when they answered the prompt, so narrowing it costs at worst a re-prompt and
 * never an execution — the direction every ambiguity in this design resolves. The migrated file is
 * rewritten as v2 immediately, so the notice is a one-time event rather than a per-session one; a
 * write that fails (read-only checkout) is not fatal — the grants are in force for this session and
 * the notice simply appears again next time.
 */
export class PersistedApprovalGrants {
  private readonly store: ApprovalGrantStore;
  private readonly filePath: string;
  private readonly onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined;
  private readonly holds: 'approvals' | 'refusals' | undefined;
  /**
   * [[EXT-144]] — **what the load found in the file**, which decides whether it may ever be
   * rewritten ({@link StoreReadState}). Anything but `readable` is a file whose load failed, exactly
   * the outcomes {@link unreadableFileNotice} reports, and none of them may be written over.
   *
   * **An entry-level loss is deliberately not one of them.** A file whose `grants` array parsed but
   * held one malformed member is a file this version *can* read: the rest of it is in force, which
   * {@link skippedEntriesNotice} states to the user as a promise, and blocking every future save
   * over one cosmetic typo would disable a working feature to protect an entry the reader has
   * already been pointed at — by position and quoted text for the first
   * {@link SKIPPED_ENTRIES_NAMED}, and by a count of the rest beyond that.
   */
  private readonly readState: StoreReadState;
  /**
   * [[EXT-151]] — the top-level keys the read found and this version does not use, written back on
   * every rewrite so a save cannot delete the parts of a user's file we do not recognise.
   */
  private readonly preserved: Record<string, unknown>;
  /**
   * Whether the file is believed to hold what this store holds — true after a read that succeeded
   * or a write that landed, false after one that was refused or threw.
   *
   * It exists so {@link add} can answer honestly for an entry it did not have to write: "already
   * held" is only "already in the file" if the file ever received it, and on a read-only checkout it
   * did not.
   */
  private inSync: boolean;

  constructor(filePath: string, options?: PersistedApprovalGrantsOptions) {
    this.filePath = filePath;
    this.onNotice = options?.onNotice;
    this.holds = options?.holds;
    const { grants, migrated, readState, preserved, dropped } = PersistedApprovalGrants.load(
      filePath,
      options
    );
    this.readState = readState;
    this.preserved = preserved;
    this.inSync = readState === 'readable';
    this.store = new ApprovalGrantStore(grants);
    if (migrated) {
      // [[EXT-151]] — the loss is announced only once the rewrite that causes it has landed.
      // The notice tells the reader their entries are gone from the file, and if this write failed
      // the file is untouched: it still holds every prefix, still in the old format, and the next
      // session migrates it again. Announcing the loss anyway would be a sentence about a file that
      // contradicts the file — this node's whole subject.
      if (this.tryPersist('migrate') && dropped.length > 0) {
        this.onNotice?.(droppedPrefixesNotice(filePath, this.holds, dropped));
      }
    }
  }

  /**
   * Read the file, and **report anything it lost on the way** ([[EXT-143]]).
   *
   * Every outcome that drops something a human saved reaches {@link
   * PersistedApprovalGrantsOptions.onNotice}: an unreadable or unparseable file, a file whose shape
   * this version does not recognise — a v1 `prefixes` file on the deny side, where the migration is
   * deliberately off, is one — and any individual entry the grammar rejects. **Silence is reserved
   * for the outcomes that lost nothing**, of which there are three: a file that is not there, one
   * that reads cleanly, and one whose entry list is absent or empty ({@link holdsSavedEntries}).
   *
   * The recovery is unchanged and deliberately unchanged: a failure here yields fewer grants rather
   * than throwing. **What that degrades to is not the same on the two sides**, which is why the
   * notice describes the loss and not an outcome — a lost `always` approval means the human is asked
   * again, while a lost `always` refusal means nothing refuses, and at `bypass` the call simply runs.
   */
  private static load(
    filePath: string,
    options: PersistedApprovalGrantsOptions | undefined
  ): LoadedGrants {
    const onNotice = options?.onNotice;
    const holds = options?.holds;
    const empty = {
      grants: [] as ApprovalGrant[],
      migrated: false,
      readState: 'readable' as StoreReadState,
      preserved: {} as Record<string, unknown>,
      dropped: [] as readonly { position: number; value: unknown }[],
    };

    let parsed: unknown;
    /**
     * The file's own bytes, kept so a failed parse can tell an EMPTY file from a full one
     * ([[EXT-144]]). `undefined` means the read itself threw — a permission error, say — where the
     * content is unknown and the conservative answer is that there is something to protect.
     */
    let raw: string | undefined;

    /**
     * The unrecognised-shape notice — but only where something was actually lost.
     *
     * [[EXT-144]] — and the write guard asks this same question, so the notice and the guard can
     * never disagree about whether this file holds something we failed to read. A shape that holds
     * saved entries is content by definition, so it is never the `blank` case.
     */
    const reportLostToShape = (): LoadedGrants => {
      const lost = holdsSavedEntries(parsed);
      if (lost) onNotice?.(unreadableFileNotice(filePath, holds, UNRECOGNISED_SHAPE));
      // [[EXT-151]] — a shape that lost nothing is still WRITTEN later, so its keys are carried the
      // same way a readable file's are: `{"version": 2, "note": "…"}` holds no entry list and no
      // loss, and a rewrite that dropped the note would be this node's defect on a third path. A
      // shape that DID lose something is never rewritten, so it has nothing to carry.
      return {
        ...empty,
        readState: lost ? 'holdsContent' : 'readable',
        preserved:
          !lost && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? preservedKeys(parsed, OWN_KEYS_V2)
            : {},
      };
    };

    try {
      if (!existsSync(filePath)) return empty;
      raw = readFileSync(filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (e) {
      // Corrupt / unreadable → behave as empty. An empty store approves nothing by itself, so there
      // is nothing to gain by throwing at a user mid-run — but empty is NOT fail-closed on the deny
      // side, where it refuses nothing either and a lost refusal at `bypass` is a command that runs.
      // That asymmetry is the whole reason they are told rather than quietly degraded.
      onNotice?.(unreadableFileNotice(filePath, holds, describeIoFailure(e)));
      // [[EXT-144]] — the store is empty, so a persist from here would replace whatever the file
      // holds with what this session saves next. Which is the whole danger where the file holds
      // something a human could get back, and nothing at all where it holds nothing — a distinction
      // the user is told about, and the reason this is not one boolean. Nothing is preserved on this
      // path: the parse failed, so there are no keys to carry, and the file is not rewritten anyway.
      return {
        ...empty,
        readState: holdsRecoverableText(raw) ? 'holdsContent' : 'holdsNothing',
      };
    }

    if (!parsed || typeof parsed !== 'object') return reportLostToShape();
    const record = parsed as { version?: unknown; grants?: unknown; prefixes?: unknown };

    if (Array.isArray(record.grants)) {
      const fallbackTime = fileWriteTime(filePath);
      const grants: ApprovalGrant[] = [];
      const skipped: { position: number; value: unknown }[] = [];
      record.grants.forEach((value, index) => {
        const grant = readGrant(value, fallbackTime);
        // The position is the entry's place in the file's own list, 1-based, so the number in the
        // message is a number the reader can count to in their editor.
        if (grant === null) skipped.push({ position: index + 1, value });
        else grants.push(grant);
      });
      if (skipped.length > 0) onNotice?.(skippedEntriesNotice(filePath, holds, skipped));
      // Still `readable`, even with entries skipped: this file WAS read, and the entries around a
      // malformed one are in force. See {@link PersistedApprovalGrants.readState}.
      //
      // [[EXT-151]] — and this is the path where a rewrite used to delete the rest of the user's
      // file. It read cleanly, so nothing warned them; the next save wrote back `version` and
      // `grants` and dropped every other key they had typed.
      return {
        grants,
        migrated: false,
        readState: 'readable',
        preserved: preservedKeys(record, OWN_KEYS_V2),
        dropped: [],
      };
    }

    if ((options?.legacyPrefixMigration ?? true) && Array.isArray(record.prefixes)) {
      return PersistedApprovalGrants.migrateFromV1(
        record.prefixes,
        record,
        filePath,
        holds,
        onNotice
      );
    }

    return reportLostToShape();
  }

  /**
   * Each v1 prefix → an `exact` entry for the same string, with ONE notice naming the file.
   *
   * **A prefix this cannot migrate is REMOVED from the file, and is named** ([[EXT-151]]). A member
   * that is not a string, or that normalizes to nothing, becomes no entry — and the rewrite below is
   * what makes that permanent. That is a real loss on a path where nothing else reports one: the
   * skipped-entries notice belongs to the v2 reader and never fires here. It is reported at
   * {@link StatusLevel.ERROR} on the same filterability axis every other loss on this seam uses.
   *
   * **And the migration notice no longer claims that nothing was removed while removing something.**
   * That sentence is kept for the case where it is true — which is the ordinary case, and where the
   * reassurance is worth having — and dropped where a member went.
   */
  private static migrateFromV1(
    prefixes: readonly unknown[],
    record: object,
    filePath: string,
    holds: 'approvals' | 'refusals' | undefined,
    onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined
  ): LoadedGrants {
    const grantedAt = fileWriteTime(filePath);
    const migrated = new ApprovalGrantStore();
    const dropped: { position: number; value: unknown }[] = [];
    prefixes.forEach((prefix, index) => {
      // The position is the member's place in the file's own `prefixes` list, 1-based, so the number
      // in the message is a number the reader can count to in their editor.
      const entry = typeof prefix === 'string' ? shellGrantEntry(prefix) : null;
      if (entry === null || entry.pattern.length === 0) {
        dropped.push({ position: index + 1, value: prefix });
        return;
      }
      migrated.add({ entry, grantedAt, scope: 'always' });
    });
    if (migrated.size() > 0) {
      // ONE notice for the whole file, not one per entry: the user needs to know their saved
      // approvals changed meaning, once, and a line per entry would bury that in its own repetition.
      onNotice?.({
        level: StatusLevel.INFO,
        message:
          `Your saved shell approvals (${filePath}) were stored in an older format that remembered ` +
          'a command PREFIX, which also approved longer commands starting with it. Each is now ' +
          'remembered as exactly the command it was, so a variant with extra arguments will ask ' +
          `again.${dropped.length === 0 ? ' Nothing was removed;' : ''} some commands may prompt ` +
          'once more.',
      });
    }
    // The dropped members are NOT reported here. They are handed to the constructor, which reports
    // them only if its rewrite actually lands — see the dropped field on LoadedGrants.
    //
    // A v1 file parsed, so this is not the whole-file loss the write guard exists for, and the
    // migration rewrite goes ahead — carrying back every top-level key that is not the two this
    // migration consumes, so a user who kept a note beside their prefixes still has it afterwards.
    return {
      grants: migrated.list(),
      migrated: true,
      readState: 'readable',
      preserved: preservedKeys(record, OWN_KEYS_V1),
      dropped,
    };
  }

  /** Every grant. */
  list(): ApprovalGrant[] {
    return this.store.list();
  }

  /** Just the entries, for handing to the matcher as one of its rule lists. */
  entries(): ApprovalEntry[] {
    return this.store.entries();
  }

  /** How many grants are persisted. */
  size(): number {
    return this.store.size();
  }

  /**
   * [[EXT-144]] — **may this store write its file at all?** False when the load failed, in which
   * case every write is refused.
   *
   * Public because the caller has to know *before* it builds the record it is about to hand over:
   * a grant is stamped with the scope it actually got, the runner's in-memory stores can hold the
   * very object they are passed, and a scope corrected after the fact would be corrected inside
   * somebody else's store. Asking first is what lets an answer that cannot be written down be
   * recorded as the session-only thing it is.
   *
   * **It answers about the FILE being readable, never about a write succeeding.** A store whose
   * path cannot be written — a read-only checkout — still answers true here, because nothing was
   * lost by reading it and the next write may well land.
   */
  canPersist(): boolean {
    return this.readState === 'readable';
  }

  /**
   * Add a grant and persist the whole store. A duplicate entry rewrites nothing.
   *
   * **Returns whether the grant is now recorded in the file** ([[EXT-144]]), which is not the same
   * question as whether it is in force — it is in force either way, held here and in the runner's
   * session store. `false` says only that a restart will not find it.
   */
  add(grant: ApprovalGrant): boolean {
    // A duplicate wrote nothing, so the honest answer is whether the FILE already received what this
    // store holds. `canPersist()` would be the wrong question and a false promise: on a read-only
    // checkout it is true while every write has thrown, so re-answering an entry the store already
    // holds would report it as recorded in a file that never got it.
    if (!this.store.add(grant)) return this.inSync;
    if (this.tryPersist('save')) return true;
    // [[EXT-149]] — **a write that did not land must not leave this store claiming the grant**,
    // whether it was refused or merely failed. What this store holds is what the approvals display
    // labels as *saved to this project* (`getRefusals`) and counts as persisted
    // (`getAllowlistCounts`), and what {@link remove} offers to delete from a file — so a grant kept
    // here after a failed write would be rendered as written down, and then "lifted" out of a file
    // that never had it.
    //
    // [[EXT-144]] drew this line at the REFUSED write only, on the ground that a failed one leaves
    // the file this store's own and the next call may well succeed. What that argument misses is
    // that nothing is lost by dropping it: the runner holds every answer in its own session store,
    // so the human's answer stays in force for the session either way. What it costs is real and
    // small — a checkout that becomes writable mid-session writes only the answers given after that
    // — and a display that says `session` about a session-only answer is worth more.
    this.store.remove(grant.entry);
    return false;
  }

  /** The grant held under this entry's identity, or `undefined`. */
  find(entry: ApprovalEntry): ApprovalGrant | undefined {
    return this.store.find(entry);
  }

  /**
   * Drop the grant held under this entry's identity and rewrite the file.
   *
   * **Returns whether the deletion reached the FILE** ([[EXT-149]]) — the mirror of what {@link add}
   * answers, and not the same question as whether the entry is still in force here. The in-memory
   * removal happens either way and is what lifts the entry for this session; `false` says only that
   * a restart will find it again. It used to return `true` after a write that threw, which is how
   * the `/approvals` lift came to report a deletion that had not happened.
   *
   * `false` is also the answer when there was no such grant. The two are distinguishable with
   * {@link find} beforehand, and the caller that reports to a user has already established the entry
   * was there — it is offering to lift something it just listed.
   *
   * The write is what makes §4.7.4's invalidation a one-time event: a removal held only in memory
   * would be undone by the next session reloading the same stale snapshot, so the user would be
   * told their grant had been withdrawn once per session, forever.
   *
   * **The [[EXT-144]] refusal cannot strand a removal half-done, and by construction rather than by
   * a check here:** a store that could not read its file is empty — the load recovered nothing, and
   * {@link add} takes back what it could not write — so there is never a grant to remove, and this
   * returns before reaching the write. If that invariant is ever broken, restore it rather than
   * teaching this method to unwind.
   */
  remove(entry: ApprovalEntry): boolean {
    if (!this.store.remove(entry)) return false;
    return this.tryPersist('lift');
  }

  /**
   * Write the file, and **report whether the write landed**. Never throws: the grants are already
   * in force for this session, and a read-only checkout must not end a run over a bookkeeping
   * write.
   *
   * **Never throws is not never says.** [[EXT-149]] — a swallowed throw left the surfaces that had
   * already promised the user something as the last word on a file that never changed, so a failed
   * write is reported ({@link failedWriteNotice}) in the words of whichever {@link WritePurpose}
   * asked for it.
   *
   * ## [[EXT-144]] — it refuses to write over a file it could not read
   *
   * This is a WHOLE-FILE rewrite from what the store holds, and a store whose load failed holds
   * nothing. So without this guard one saved answer replaces every entry in the file with itself:
   * a trailing comma — the characteristic failure of a file people hand-edit and commit — becomes
   * unrecoverable loss at the next prompt, with no backup and nothing on disk to go back to.
   *
   * **The deny side is why it refuses rather than saving a copy first.** A user whose refusals have
   * silently stopped applying reaches for *always reject*, and that keystroke is what would make the
   * loss permanent. Refusing leaves the file exactly as they left it: fix the comma and all of it
   * comes back, with nothing to reconcile and nothing needing to have been copied in advance.
   *
   * **A sibling `.corrupt` copy was the alternative, and it is worse in this system**, because it
   * would leave the user holding a merge they cannot perform — the live file with the one entry they
   * just answered, a copy beside it with the twenty they had, and no tool to combine them. It would
   * also write a second file into a directory people commit, and it would make the file parse again,
   * so the load-time error that is the user's only signal would go quiet while nineteen refusals
   * stayed out of force. And its guarantee is conditional on a write that can itself fail, which is
   * the same read-only checkout this method already has to survive.
   *
   * The cost is a re-prompt and nothing else, which is the direction every ambiguity in this design
   * resolves — and it is the same degradation the load side already makes ([[EXT-107]]: a store that
   * cannot be read means `always` becomes `session`), now applied consistently to the write.
   */
  private tryPersist(purpose: WritePurpose): boolean {
    if (this.readState !== 'readable') {
      this.onNotice?.(refusedWriteNotice(this.filePath, this.holds, this.readState));
      this.inSync = false;
      return false;
    }
    const file: PersistedGrantsFileV2 = {
      version: PERSISTED_VERSION,
      grants: this.store.list(),
    };
    try {
      // [[EXT-151]] — the user's own keys FIRST, so `version` and `grants` cannot be displaced by a
      // preserved key of the same name. `preservedKeys` excludes both, so this is belt and braces —
      // and it is the ordering that keeps it so, which is why it is stated rather than assumed.
      const written = { ...this.preserved, ...file };
      writeFileSync(this.filePath, JSON.stringify(written, null, 2) + '\n', 'utf8');
      this.inSync = true;
      return true;
    } catch (e) {
      // The throw is swallowed — a bookkeeping write must not end a run — but it is not SILENT
      // ([[EXT-149]]). The file no longer holds what this store holds, which is what {@link add}
      // and {@link remove} report to their callers, and the user is told in the words of whatever
      // they were promised.
      this.onNotice?.(failedWriteNotice(this.filePath, this.holds, purpose, describeIoFailure(e)));
      this.inSync = false;
      return false;
    }
  }
}
