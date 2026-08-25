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
 * Reads stay fail-closed-on-auto-approval: a missing, unreadable, malformed or partly-malformed
 * file yields fewer grants (at worst none) rather than throwing, because an empty allow-list only
 * ever means *prompt*.
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
function readGrant(value: unknown, fallbackTime: string): ApprovalGrant | null {
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

  constructor(filePath: string, options?: PersistedApprovalGrantsOptions) {
    this.filePath = filePath;
    const { grants, migrated } = PersistedApprovalGrants.load(
      filePath,
      options?.onNotice,
      options?.legacyPrefixMigration ?? true
    );
    this.store = new ApprovalGrantStore(grants);
    if (migrated) this.tryPersist();
  }

  private static load(
    filePath: string,
    onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined,
    legacyPrefixMigration: boolean
  ): { grants: ApprovalGrant[]; migrated: boolean } {
    try {
      if (!existsSync(filePath)) return { grants: [], migrated: false };
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { grants: [], migrated: false };
      const record = parsed as { version?: unknown; grants?: unknown; prefixes?: unknown };

      if (Array.isArray(record.grants)) {
        const fallbackTime = fileWriteTime(filePath);
        const grants = record.grants
          .map((value) => readGrant(value, fallbackTime))
          .filter((grant): grant is ApprovalGrant => grant !== null);
        return { grants, migrated: false };
      }

      if (legacyPrefixMigration && Array.isArray(record.prefixes)) {
        return PersistedApprovalGrants.migrateFromV1(record.prefixes, filePath, onNotice);
      }

      return { grants: [], migrated: false };
    } catch {
      // Corrupt / unreadable → behave as empty. Fail-closed on auto-approval: an empty store only
      // ever means "prompt", so there is nothing to gain by throwing at a user mid-run.
      return { grants: [], migrated: false };
    }
  }

  /** Each v1 prefix → an `exact` entry for the same string, with ONE notice naming the file. */
  private static migrateFromV1(
    prefixes: readonly unknown[],
    filePath: string,
    onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined
  ): { grants: ApprovalGrant[]; migrated: boolean } {
    const grantedAt = fileWriteTime(filePath);
    const migrated = new ApprovalGrantStore();
    for (const prefix of prefixes) {
      if (typeof prefix !== 'string') continue;
      const entry = shellGrantEntry(prefix);
      if (entry.pattern.length === 0) continue;
      migrated.add({ entry, grantedAt, scope: 'always' });
    }
    if (migrated.size() > 0) {
      // ONE notice for the whole file, not one per entry: the user needs to know their saved
      // approvals changed meaning, once, and a line per entry would bury that in its own repetition.
      onNotice?.({
        level: StatusLevel.INFO,
        message:
          `Your saved shell approvals (${filePath}) were stored in an older format that remembered ` +
          'a command PREFIX, which also approved longer commands starting with it. Each is now ' +
          'remembered as exactly the command it was, so a variant with extra arguments will ask ' +
          'again. Nothing was removed; some commands may prompt once more.',
      });
    }
    return { grants: migrated.list(), migrated: true };
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

  /** Add a grant and persist the whole store. A duplicate entry rewrites nothing. */
  add(grant: ApprovalGrant): void {
    if (!this.store.add(grant)) return;
    this.tryPersist();
  }

  /** The grant held under this entry's identity, or `undefined`. */
  find(entry: ApprovalEntry): ApprovalGrant | undefined {
    return this.store.find(entry);
  }

  /**
   * Drop the grant held under this entry's identity and rewrite the file. Returns whether one was
   * there.
   *
   * The write is what makes §4.7.4's invalidation a one-time event: a removal held only in memory
   * would be undone by the next session reloading the same stale snapshot, so the user would be
   * told their grant had been withdrawn once per session, forever.
   */
  remove(entry: ApprovalEntry): boolean {
    if (!this.store.remove(entry)) return false;
    this.tryPersist();
    return true;
  }

  /**
   * Write the file. Never throws: the grants are already in force for this session, and a
   * read-only checkout must not end a run over a bookkeeping write.
   */
  private tryPersist(): void {
    const file: PersistedGrantsFileV2 = {
      version: PERSISTED_VERSION,
      grants: this.store.list(),
    };
    try {
      writeFileSync(this.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8');
    } catch {
      // Intentionally swallowed — see the doc comment.
    }
  }
}
