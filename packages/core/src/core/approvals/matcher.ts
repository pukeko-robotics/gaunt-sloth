/**
 * @module core/approvals/matcher
 *
 * EXT-71 (spec §3.1, §3.2, §3.3) — **the one comparison engine** over {@link ApprovalEntry}, and
 * the three-list resolution built on top of it. Every approvals decision that is not the rung's own
 * default runs through {@link resolveApprovalRules}; there is no second matcher anywhere.
 *
 * ## What an entry compares against
 *
 * `exact` / `glob` / `regexp` compare against the **normalized command** for a `shell` entry and
 * against the **tool name** for `tool` / `mcpTool`. The normalization is
 * {@link import('../shell/normalize.js').normalizeCommand} — the same one the command classifier and
 * the §8 floor already use, never a second one of this module's own, because a second normalization
 * is how a matcher and a floor come to disagree about what a command is.
 *
 * `hint` is valid only on tool subjects and reads the call's **effective** annotations through
 * {@link EffectiveToolAnnotationSource}, which `core/approvals/annotations.ts` builds from the user's
 * per-server trust (§4.7.1). A caller that wires no source gets {@link failClosedToolAnnotations}:
 * the MCP fail-closed defaults, which describe a tool that writes, destroys, is not idempotent and
 * reaches the open world.
 *
 * ## The asymmetry (§3.1 "Compound commands"), which is the whole point of this module
 *
 * **No allow entry of any matcher matches a command that does not statically resolve.** If
 * {@link classifyCommand} cannot resolve it — composition, substitution, redirection — it is a
 * non-match for `exact`, `glob` and `regexp` alike, so a glob can never span a command separator and
 * `git *` never grants `git status && curl x | sh`.
 *
 * **A deny (or escalate) entry MAY match a compound command**, and is matched against every segment
 * a shell would run as well as against the whole string, because a prohibition that catches
 * something unresolvable errs in the direction that costs nothing.
 *
 * The same split governs a match the engine cannot decide (a regexp over its run-time budget, or an
 * annotation set nothing can supply): **undecidable is a non-match on the allow side and a match on
 * the restrictive side.** Each fails toward a prompt, never toward an execution.
 *
 * ## Resolution
 *
 * `deny` > `escalate` > `allow`, most-restrictive-wins: every deny entry is consulted before any
 * escalate entry and every escalate entry before any allow entry, so **author order and merge order
 * cannot change the outcome** and an appended entry can never perturb an existing one. Within a
 * list the first match is reported, which decides only the provenance shown to the user.
 *
 * ## Case
 *
 * Shell `exact` / `glob` comparisons on the restrictive lists fold case, matching the established
 * deny behaviour (`core/shell/denylist.ts`) — broader on a list whose breadth is fail-safe. Allow
 * comparisons, tool names, and **every `regexp` on every list** are compared as written: silently
 * adding an `i` flag to a pattern the user authored would make it mean something they did not write.
 */
import {
  type ApprovalEntry,
  type ApprovalHintPattern,
  type ShellApprovalEntry,
  type ShellApprovalGateNotice,
} from '#src/config/shell-policy.js';
import { classifyCommand } from '#src/core/shell/arity.js';
import { normalizeCommand } from '#src/core/shell/normalize.js';
import { commandSegments } from '#src/core/shell/denylist.js';
import { StatusLevel } from '#src/core/types.js';

/* -------------------------------------------------------------------------------------------- *
 * Subjects — what a gated call looks like to the matcher.
 * -------------------------------------------------------------------------------------------- */

/** A gated `run_shell_command` call: the command exactly as the model proposed it. */
export interface ShellApprovalSubject {
  kind: 'shell';
  /** RAW command. Normalization happens here so no caller can normalize differently. */
  command: string;
}

/** A gated built-in / custom in-process tool call. */
export interface ToolApprovalSubject {
  kind: 'tool';
  name: string;
  /** §4.7.4 — the host this call reaches, where it has one. */
  host?: string;
}

/**
 * A gated MCP tool call. `server` is the user's own key in `mcpServers` (§4.7.5) — the only identity
 * a server has that is stable, unique and user-authored, and the key its trust and its rule entries
 * are both written against. Nothing a server declares about its own name ever participates.
 */
export interface McpToolApprovalSubject {
  kind: 'mcpTool';
  server: string;
  name: string;
  host?: string;
}

/** Any subject the matcher can be asked about. */
export type ApprovalSubject = ShellApprovalSubject | ToolApprovalSubject | McpToolApprovalSubject;

/* -------------------------------------------------------------------------------------------- *
 * Effective tool annotations — the values a `hint` entry reads.
 * -------------------------------------------------------------------------------------------- */

/**
 * §4.7.1 — the four MCP `ToolAnnotations` booleans, as they **effectively** hold for a call after
 * provenance and trust have been applied. All four are present: a hint entry asks a yes/no question
 * of each name it uses, so "unknown" is expressed by the source returning `undefined` for the whole
 * set, never by a missing key.
 */
export interface EffectiveToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Resolves the effective annotations of a tool call, or `undefined` when they cannot be determined
 * — which the matcher treats as undecidable (non-match on allow, match on deny/escalate).
 *
 * This function type is the whole contract between the matcher and the trust model:
 * `createEffectiveToolAnnotationSource` (`core/approvals/annotations.ts`) is the one implementation
 * that applies per-server, per-hint trust (§4.7.1), and it is the ONLY place an effective set is
 * derived. Nothing in this module knows how trust is decided, which is what lets the two evolve
 * independently.
 */
export type EffectiveToolAnnotationSource = (
  subject: ToolApprovalSubject | McpToolApprovalSubject
) => EffectiveToolAnnotations | undefined;

/**
 * The MCP fail-closed defaults (spec §4.7.2): a tool that has said nothing about itself is assumed
 * to write, to destroy, to be non-idempotent and to reach the open world. These are the values the
 * MCP specification itself defines for absent annotations, so an entry written against them is
 * written against the protocol's own conservative reading.
 */
export const MCP_FAIL_CLOSED_ANNOTATIONS: EffectiveToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * The {@link EffectiveToolAnnotationSource} a caller gets when it wires none: every tool reads as
 * {@link MCP_FAIL_CLOSED_ANNOTATIONS}.
 *
 * It is the safe default and not a stub — it is what a fully distrustful configuration computes
 * anyway (§4.7.1: an untrusted server's effective set IS this constant), so a call site that has no
 * annotations to offer behaves exactly like one whose user believes nothing. Deliberately NOT a
 * trust model: trust needs config, and config belongs to `core/approvals/annotations.ts`.
 */
export const failClosedToolAnnotations: EffectiveToolAnnotationSource = () =>
  MCP_FAIL_CLOSED_ANNOTATIONS;

/* -------------------------------------------------------------------------------------------- *
 * The engine.
 * -------------------------------------------------------------------------------------------- */

/**
 * §3.1 — the run-time budget for ONE `regexp` entry evaluation, in milliseconds.
 *
 * It is a **backstop reported rather than swallowed**, not the primary defence: a pattern is
 * length-capped and compile-checked when the config loads (`approvalEntrySchema`), and a short
 * pattern can still backtrack catastrophically. What this bounds is the damage — and, more
 * importantly, it makes a pattern that stopped deciding *visible*, so a session in which one quietly
 * fell out of use cannot be mistaken for one in which it works.
 */
export const REGEXP_MATCH_BUDGET_MS = 50;

/** Whether an entry matched, did not, or could not be decided (§3.1 "When the matcher cannot decide"). */
type EntryMatch = 'match' | 'no-match' | 'undecidable';

/**
 * How a list's matches fail. `allow` grants, so it fails toward *not* matching; `restrictive`
 * (deny and escalate) fails toward matching, and additionally sees compound commands segment by
 * segment.
 */
type MatchMode = 'allow' | 'restrictive';

/** Everything the matcher needs beyond the entry and the subject. */
interface MatchContext {
  annotations: EffectiveToolAnnotationSource;
  onNotice: ((notice: ShellApprovalGateNotice) => void) | undefined;
  regexpBudgetMs: number;
  now: () => number;
}

/** Tuning + seams for {@link resolveApprovalRules}. All optional; the defaults are the product's. */
export interface ApprovalMatcherOptions {
  /**
   * Where a `hint` entry reads its effective values (§4.7.1). Build it with
   * `createEffectiveToolAnnotationSource`; defaults to {@link failClosedToolAnnotations}.
   */
  annotations?: EffectiveToolAnnotationSource;
  /**
   * Where a run-time report goes — the established {@link ShellApprovalGateNotice} shape, which the
   * runner forwards to `statusUpdate`. Absent means the report is dropped, which is why the runner
   * always passes one.
   */
  onNotice?: (notice: ShellApprovalGateNotice) => void;
  /** Override {@link REGEXP_MATCH_BUDGET_MS}. */
  regexpBudgetMs?: number;
  /** Clock, injectable so the budget backstop is testable without a pathological pattern. */
  now?: () => number;
}

function contextFrom(options: ApprovalMatcherOptions | undefined): MatchContext {
  return {
    annotations: options?.annotations ?? failClosedToolAnnotations,
    onNotice: options?.onNotice,
    regexpBudgetMs: options?.regexpBudgetMs ?? REGEXP_MATCH_BUDGET_MS,
    now: options?.now ?? Date.now,
  };
}

/** Every regexp metacharacter EXCEPT `*`, which the glob translation owns. */
const GLOB_METACHARACTERS = /[.+?^${}()|[\]\\]/g;

/**
 * §3.1 — compile a glob pattern. `*` matches any run of characters **including none**, matched
 * against the **whole** string rather than token by token; everything else is literal.
 *
 * The consequence worth stating, because it is the first thing anyone gets wrong: `npm publish *`
 * does NOT match a bare `npm publish` — the space before the `*` is part of the pattern.
 * `npm publish*` matches both, and is almost always what was meant.
 *
 * The `s` flag is deliberate: a normalized compound command contains real line breaks (EXT-55 keeps
 * them, because a line break is a command separator), and on the restrictive lists a `*` must be
 * able to cross one. It can never do so on the allow side, where a command containing a separator
 * has already been refused as unresolvable.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(GLOB_METACHARACTERS, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

/**
 * Evaluate a `regexp` entry against one candidate string, under the run-time budget.
 *
 * The pattern compiles as written — no flags are added. Silently making a user's pattern
 * case-insensitive would make it mean something they did not write, on a list where breadth has
 * consequences in both directions.
 */
function testRegexpPattern(pattern: string, candidate: string, ctx: MatchContext): EntryMatch {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
    // Unreachable via config (the schema compile-checks every pattern at load) and deliberately not
    // an exception: a pattern that cannot be compiled cannot be decided, which the caller already
    // knows how to fail safely on.
    return 'undecidable';
  }
  const started = ctx.now();
  const matched = compiled.test(candidate);
  const elapsed = ctx.now() - started;
  if (elapsed > ctx.regexpBudgetMs) {
    ctx.onNotice?.({
      level: StatusLevel.WARNING,
      message:
        `An approvals regexp entry took ${elapsed}ms to evaluate, over its ${ctx.regexpBudgetMs}ms ` +
        `budget, so it was treated as undecided for this call: ${pattern}. An allow entry that ` +
        'cannot be decided does not approve, and a deny or escalate entry that cannot be decided ' +
        'still applies. Simplify the pattern if this repeats.',
    });
    return 'undecidable';
  }
  return matched ? 'match' : 'no-match';
}

/** Compare one candidate string against a string-patterned entry. */
function comparePattern(
  matcher: 'exact' | 'glob' | 'regexp',
  pattern: string,
  candidate: string,
  foldCase: boolean,
  ctx: MatchContext
): EntryMatch {
  if (matcher === 'regexp') return testRegexpPattern(pattern, candidate, ctx);
  const left = foldCase ? candidate.toLowerCase() : candidate;
  const right = foldCase ? pattern.toLowerCase() : pattern;
  if (matcher === 'exact') return left === right ? 'match' : 'no-match';
  return globToRegExp(right).test(left) ? 'match' : 'no-match';
}

/** Fold several candidate results: any match wins; otherwise any undecidable wins. */
function foldMatches(results: readonly EntryMatch[]): EntryMatch {
  if (results.includes('match')) return 'match';
  if (results.includes('undecidable')) return 'undecidable';
  return 'no-match';
}

/**
 * A `shell` entry against a shell subject.
 *
 * On the **allow** side the command must statically resolve (§3.1) — that check comes FIRST and
 * applies to every matcher, which is what stops a glob spanning a command separator — and the
 * comparison is against the whole normalized command, as written.
 *
 * On the **restrictive** side the entry is compared against the whole normalized command AND
 * against every segment a shell would run (`a; b`, `a && b`, the body of a `$(…)`), with case
 * folded for `exact`/`glob`.
 */
function matchShellEntry(
  entry: ShellApprovalEntry,
  command: string,
  mode: MatchMode,
  ctx: MatchContext
): EntryMatch {
  if (mode === 'allow') {
    // §3.1 — no allow entry of ANY matcher matches a command that does not statically resolve.
    if (classifyCommand(command, normalizeCommand) === null) return 'no-match';
    return comparePattern(entry.matcher, entry.pattern, normalizeCommand(command), false, ctx);
  }
  const candidates = [normalizeCommand(command), ...commandSegments(command)];
  const foldCase = entry.matcher !== 'regexp';
  return foldMatches(
    candidates.map((candidate) =>
      comparePattern(entry.matcher, entry.pattern, candidate, foldCase, ctx)
    )
  );
}

/**
 * §3.1 — a `hint` pattern holds when **every** annotation it names holds effectively (AND within
 * the entry; alternatives are separate entries). Hints it does not name are unconstrained. An empty
 * pattern is a config error, so it cannot reach here as a match-everything.
 */
function matchHintPattern(
  pattern: ApprovalHintPattern,
  subject: ToolApprovalSubject | McpToolApprovalSubject,
  ctx: MatchContext
): EntryMatch {
  const effective = ctx.annotations(subject);
  if (!effective) return 'undecidable';
  for (const [name, required] of Object.entries(pattern) as [
    keyof EffectiveToolAnnotations,
    boolean | undefined,
  ][]) {
    if (required === undefined) continue;
    if (effective[name] !== required) return 'no-match';
  }
  return 'match';
}

/** One entry against one subject, in one list's fail-direction. */
function matchEntry(
  entry: ApprovalEntry,
  subject: ApprovalSubject,
  mode: MatchMode,
  ctx: MatchContext
): EntryMatch {
  if (entry.type === 'shell') {
    // A `shell` entry is about a command, so it says nothing about a tool call. `run_shell_command`
    // is deliberately NOT also matchable as a `tool` subject — see `approvalSubjectFor` in the
    // runner and [[EXT-30]].
    return subject.kind === 'shell'
      ? matchShellEntry(entry, subject.command, mode, ctx)
      : 'no-match';
  }
  if (subject.kind === 'shell') return 'no-match';
  if (entry.type !== subject.kind) return 'no-match';
  if (entry.type === 'mcpTool' && subject.kind === 'mcpTool') {
    // §3.1 — `*` is the reserved literal meaning every server, and a configured server may not be
    // named it (validated at load).
    if (entry.server !== '*' && entry.server !== subject.server) return 'no-match';
  }
  // §4.7.4 — `host`, where present, is an additional exact-match condition. A call with no host
  // never matches an entry that specifies one.
  if (entry.host !== undefined) {
    if (subject.host === undefined || subject.host !== entry.host) return 'no-match';
  }
  if (entry.matcher === 'hint') {
    return matchHintPattern(entry.pattern as ApprovalHintPattern, subject, ctx);
  }
  return comparePattern(entry.matcher, entry.pattern as string, subject.name, false, ctx);
}

/**
 * §3.2 — whether the rater still reviews a call this entry matched. Honored at the rater rungs and
 * inert at the deterministic ones; a per-entry `rate` wins in **both** directions.
 *
 * The default derives from one principle: *an entry skips the rater only to the extent that it
 * recorded what the rater would have seen.* A `shell` + `exact` entry recorded the whole command, so
 * it needs no rating; a pattern recorded a shape, and a tool entry recorded identity (never
 * arguments), so both keep the rater.
 */
export function approvalEntryRatesCall(entry: ApprovalEntry): boolean {
  if (entry.rate !== undefined) return entry.rate;
  return !(entry.type === 'shell' && entry.matcher === 'exact');
}

/** The three declared lists, as one argument. */
export interface ApprovalRuleLists {
  allow: readonly ApprovalEntry[];
  deny: readonly ApprovalEntry[];
  escalate: readonly ApprovalEntry[];
}

/** What the rule lists decided about a call, or `null` when no entry matched. */
export interface ApprovalRuleDecision {
  /** §3 — most-restrictive-wins: `deny` over `escalate` over `allow`. */
  action: 'deny' | 'escalate' | 'allow';
  /** The entry that fired, for the provenance the prompt and the refusal message must show. */
  entry: ApprovalEntry;
  /**
   * §3.2 — for an `allow` action, whether the rater still reviews the call as a **tripwire**.
   * Always `false` for `deny` (nothing to rate) and for `escalate` (which goes straight to the
   * human with no rating call, because the user pre-decided that a human answers).
   */
  rate: boolean;
}

/** The first entry of a list that matches, honoring the list's fail-direction. */
function firstMatch(
  entries: readonly ApprovalEntry[],
  subject: ApprovalSubject,
  mode: MatchMode,
  ctx: MatchContext
): ApprovalEntry | null {
  for (const entry of entries) {
    const result = matchEntry(entry, subject, mode, ctx);
    if (result === 'match') return entry;
    // §3.1 — an allow match that cannot be decided is NOT a match (escalate); a deny match that
    // cannot be decided IS one (refuse). Escalate follows deny: it fails toward a prompt, which is
    // never an execution.
    if (result === 'undecidable' && mode === 'restrictive') return entry;
  }
  return null;
}

/**
 * §3.3 — resolve a call against all three lists, most-restrictive-wins.
 *
 * **Every** deny entry is consulted before **any** escalate entry, and every escalate entry before
 * any allow entry. That ordering is the whole property: author order within a list, and the order
 * in which lists were concatenated, cannot change the outcome, and appending an entry can never
 * perturb an existing one. The first match inside a list decides only which entry is reported.
 *
 * Returns `null` when nothing matched — the rung then decides on its own.
 */
export function resolveApprovalRules(
  subject: ApprovalSubject,
  lists: ApprovalRuleLists,
  options?: ApprovalMatcherOptions
): ApprovalRuleDecision | null {
  const ctx = contextFrom(options);

  const denied = firstMatch(lists.deny, subject, 'restrictive', ctx);
  if (denied) return { action: 'deny', entry: denied, rate: false };

  const escalated = firstMatch(lists.escalate, subject, 'restrictive', ctx);
  if (escalated) return { action: 'escalate', entry: escalated, rate: false };

  const allowed = firstMatch(lists.allow, subject, 'allow', ctx);
  if (allowed) return { action: 'allow', entry: allowed, rate: approvalEntryRatesCall(allowed) };

  return null;
}

/**
 * A one-line rendering of an entry, for the provenance a refusal message and an escalation prompt
 * must carry (§3, §3.2) and for the `/approvals` list display.
 *
 * A `shell` + `exact` entry renders as its bare pattern — that is the command the user wrote, and
 * decorating it would only get between them and the line they are looking for. Everything else says
 * what kind of thing it is, because a pattern that is not the command needs to be readable as one.
 */
export function describeApprovalEntry(entry: ApprovalEntry): string {
  const pattern = typeof entry.pattern === 'string' ? entry.pattern : JSON.stringify(entry.pattern);
  const host = entry.type !== 'shell' && entry.host ? ` (host ${entry.host})` : '';
  if (entry.type === 'shell') {
    return entry.matcher === 'exact' ? pattern : `${pattern} (${entry.matcher})`;
  }
  const matcher = entry.matcher === 'exact' ? '' : ` (${entry.matcher})`;
  const subject =
    entry.type === 'mcpTool' ? `mcpTool ${entry.server}/${pattern}` : `tool ${pattern}`;
  return `${subject}${matcher}${host}`;
}
