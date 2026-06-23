/**
 * @module core/shell/allowlist
 *
 * EXT-9 Tier-2: the persisted + session-scoped allow-list engine for the opt-in
 * `run_shell_command` tool. Once a human approves a command at `session` or `always`
 * scope, future commands with the same classified prefix ({@link classifyCommand}) are
 * auto-approved without re-prompting — the ergonomics improvement mature agents
 * (opencode/openclaw/hermes) ship.
 *
 * SECURITY — a naive "remember the prefix" allow-list is an injection vector. Two layers
 * guard it:
 *  1. **Classification fail-closed** (arity.ts): any command with shell composition,
 *     substitution, or redirection returns `null` and can NEVER match, so
 *     `git checkout x; rm -rf /` does not ride an approved `git checkout *`.
 *  2. **Safe-bin anti-widening re-validation** (here, after opencode/openclaw): a stored
 *     approval is matched ONLY if the candidate command's first non-flag operand region
 *     does not introduce a flag that *widens or redirects* the approved operation. The
 *     exact rule is documented on {@link matchesApproval} / {@link hasWideningFlag}.
 *
 * No module-global mutable state: the session store is a per-instance class so concurrent
 * sessions (ACP / AG-UI multi-session) cannot stomp each other. The persisted (`always`)
 * store is a small JSON file the runner loads once per instance.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { classifyCommand, tokenize } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import type { ToolApprovalScope } from '#src/core/types.js';

/**
 * Approval persistence scopes, widest-lived last. Alias of the canonical
 * {@link ToolApprovalScope} so the allow-list engine and the decision vocabulary stay in sync.
 */
export type ApprovalScope = ToolApprovalScope;

/** On-disk shape of the persisted (`always`) allow-list. Versioned for forward migration. */
interface PersistedAllowlistFile {
  version: 1;
  /** Approved classified prefixes (e.g. `"git checkout"`, `"ls"`). */
  prefixes: string[];
}

const PERSISTED_VERSION = 1 as const;

/**
 * Flags that, if present in a candidate command but not implied by the approved prefix,
 * could change the *operation* the human approved (point it at a different transport,
 * exec a hook, follow an attacker-controlled URL). Approving `git clone` must not
 * green-light `git clone --upload-pack=evil`. This list is intentionally conservative:
 * it is the openclaw "safe-bin" idea reduced to a deny-set of operation-changing flags
 * that commonly appear in shell-injection / supply-chain abuse.
 *
 * Matched against the flag token with any `=value` stripped, case-insensitively.
 */
const WIDENING_FLAGS: ReadonlySet<string> = new Set([
  // git: remote command / hook overrides.
  '--upload-pack',
  '--receive-pack',
  '--exec',
  '-u', // git clone -u <upload-pack>
  '--config', // git -c is the short form; --config can inject core.sshCommand etc.
  '-c', // git -c core.sshCommand='...' — arbitrary command execution
  // generic "run this program" escape hatches across tools.
  '--exec-path',
  '-exec', // find -exec <cmd>
  '--use-askpass',
  '--ssh-command',
  // package managers: lifecycle-script / arbitrary-script toggles.
  '--unsafe-perm',
  '--ignore-scripts=false',
  '--allow-scripts',
  // curl/wget style follow/exec (in case a bare binary is approved).
  '-o', // write to arbitrary path
  '--output',
  '-T', // upload
  '--upload-file',
]);

/**
 * Decide whether a candidate argv contains a flag that *widens* the approved operation.
 *
 * Rule implemented (documented for the coordinator):
 *  - Re-derive the meaningful prefix from the candidate's actual argv.
 *  - Inspect every token of the candidate that is a flag (starts with `-`).
 *  - If any flag token — normalized by stripping a trailing `=value` and lowercasing —
 *    is in {@link WIDENING_FLAGS}, the command is considered a widening of the approved
 *    operation and the match is REFUSED (returns true).
 *
 * This is purposely a deny-list of operation-changing flags rather than an allow-list of
 * benign flags: benign flag variants (`-b`, `--oneline`, `-la`) are exactly what we WANT
 * to keep auto-approving, while the handful of "run-an-arbitrary-program / redirect-the-
 * transport" flags are what an injected approval must never silently enable.
 */
export function hasWideningFlag(argv: string[]): boolean {
  for (const tok of argv) {
    if (!tok.startsWith('-')) continue;
    const bare = tok.split('=', 1)[0].toLowerCase();
    if (WIDENING_FLAGS.has(bare)) return true;
  }
  return false;
}

/**
 * A holder of approved prefixes with set semantics. Used for both the in-memory session
 * store and the loaded persisted store. Pure data + membership; persistence is layered on
 * top by {@link PersistedAllowlist}.
 */
export class AllowlistStore {
  private readonly prefixes: Set<string>;

  constructor(initial: Iterable<string> = []) {
    this.prefixes = new Set(initial);
  }

  has(prefix: string): boolean {
    return this.prefixes.has(prefix);
  }

  add(prefix: string): void {
    this.prefixes.add(prefix);
  }

  list(): string[] {
    return [...this.prefixes];
  }
}

/**
 * The persisted (`always`) allow-list, backed by a JSON file. The path is injected (the
 * runner resolves it via fileUtils → `.gsloth/.gsloth-settings/shell-allowlist.json`) so
 * tests can point it at a temp dir. Loads lazily/defensively: a missing or malformed file
 * yields an empty store rather than throwing (fail-open on READ is safe — an empty
 * allow-list just means "prompt"; it never auto-approves anything).
 */
export class PersistedAllowlist {
  private readonly store: AllowlistStore;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.store = new AllowlistStore(PersistedAllowlist.load(filePath));
  }

  private static load(filePath: string): string[] {
    try {
      if (!existsSync(filePath)) return [];
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedAllowlistFile>;
      if (!parsed || !Array.isArray(parsed.prefixes)) return [];
      return parsed.prefixes.filter((p): p is string => typeof p === 'string');
    } catch {
      // Corrupt/unreadable file → behave as empty (fail-closed on auto-approval).
      return [];
    }
  }

  has(prefix: string): boolean {
    return this.store.has(prefix);
  }

  list(): string[] {
    return this.store.list();
  }

  /** Add a prefix and persist the whole set to disk. */
  add(prefix: string): void {
    if (this.store.has(prefix)) return;
    this.store.add(prefix);
    this.persist();
  }

  private persist(): void {
    const file: PersistedAllowlistFile = {
      version: PERSISTED_VERSION,
      prefixes: this.store.list().sort(),
    };
    writeFileSync(this.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8');
  }
}

/**
 * Read-only view over the stores consulted for an auto-approval check. The runner passes
 * its per-instance session store and (optionally) the persisted store.
 */
export interface ApprovalStores {
  session: Pick<AllowlistStore, 'has'>;
  always?: Pick<PersistedAllowlist, 'has'>;
}

/**
 * Decide whether `command` is already approved by the given stores — the gate the runner
 * consults BEFORE prompting the human.
 *
 * Returns true ONLY when ALL of the following hold:
 *  1. {@link classifyCommand} returns a non-null classification (so composition /
 *     substitution / redirection commands can never match — anti-injection layer 1);
 *  2. the classified prefix is present in the session OR persisted (`always`) store; AND
 *  3. the safe-bin re-validation passes: the candidate's actual argv contains no
 *     operation-widening flag (anti-injection layer 2 — see {@link hasWideningFlag}).
 *
 * Anything else (unclassifiable, unknown prefix, or a widening flag) → false → the human
 * is prompted. Fail-closed by construction.
 */
export function matchesApproval(command: string, stores: ApprovalStores): boolean {
  const classification = classifyCommand(command, normalizeCommand);
  if (!classification) return false; // layer 1: composition/redirection/substitution.

  const approved =
    stores.session.has(classification.prefix) ||
    (stores.always?.has(classification.prefix) ?? false);
  if (!approved) return false;

  // Layer 2: re-derive argv from the normalized command and refuse if an operation-
  // widening flag is present that the human's prefix-level approval never implied.
  const argv = tokenize(normalizeCommand(command));
  if (!argv) return false; // unbalanced quoting → fail-closed.
  if (hasWideningFlag(argv)) return false;

  return true;
}
