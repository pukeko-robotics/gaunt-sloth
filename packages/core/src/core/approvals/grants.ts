/**
 * @module core/approvals/grants
 *
 * EXT-71 (spec §3, §3.1, §6) — **what the escalation menu remembers**, in the one entry grammar.
 *
 * A grant is an {@link ApprovalEntry} plus the metadata §3 requires a list to be able to show:
 * **when** it was made and **at what scope**. Two stores hold them — an in-memory
 * {@link ApprovalGrantStore} for the life of one runner instance, and a
 * {@link PersistedApprovalGrants} backed by the project's JSON file for `always` — and neither
 * decides anything. They hold entries; `core/approvals/matcher.ts` compares them. There is exactly
 * one comparison engine and it is not here.
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
 *       "grantedAt": "2026-08-02T09:15:00.000Z", "scope": "always" }
 *   ]
 * }
 * ```
 *
 * Reads stay fail-closed-on-auto-approval: a missing, unreadable, malformed or partly-malformed
 * file yields fewer grants (at worst none) rather than throwing, because an empty allow-list only
 * ever means *prompt*.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { approvalEntrySchema, renderApprovalEntryObject } from '#src/config/schema.js';
import type { ApprovalEntry, ShellApprovalEntry } from '#src/config/shell-policy.js';
import type { ShellApprovalGateNotice } from '#src/config/shell-policy.js';
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
 * Read one persisted grant defensively. The **entry is validated by the config grammar's own
 * schema** — one grammar, one validator — so a malformed entry is dropped here and can never reach
 * the matcher. Metadata is coerced rather than validated: it decides nothing, and discarding a real
 * grant over a missing timestamp would cost an approval the human already gave.
 */
function readGrant(value: unknown, fallbackTime: string): ApprovalGrant | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { entry?: unknown; grantedAt?: unknown; scope?: unknown };
  const parsed = approvalEntrySchema.safeParse(record.entry);
  if (!parsed.success) return null;
  return {
    entry: parsed.data as ApprovalEntry,
    grantedAt: typeof record.grantedAt === 'string' ? record.grantedAt : fallbackTime,
    scope: record.scope === 'session' ? 'session' : 'always',
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

  /** Add a grant. Returns whether it was new — an identical entry is not stored twice. */
  add(grant: ApprovalGrant): boolean {
    const key = grantKey(grant.entry);
    if (this.grants.some((held) => grantKey(held.entry) === key)) return false;
    this.grants.push(grant);
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
}

/**
 * The persisted (`always`) grant store, backed by a JSON file whose path is injected (the runner
 * resolves it via fileUtils → `.gsloth/.gsloth-settings/shell-allowlist.json`) so tests can point it
 * at a temp dir.
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
    const { grants, migrated } = PersistedApprovalGrants.load(filePath, options?.onNotice);
    this.store = new ApprovalGrantStore(grants);
    if (migrated) this.tryPersist();
  }

  private static load(
    filePath: string,
    onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined
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

      if (Array.isArray(record.prefixes)) {
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
