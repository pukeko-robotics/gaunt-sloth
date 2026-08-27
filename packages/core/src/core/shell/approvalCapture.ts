/**
 * @module core/shell/approvalCapture
 *
 * [[TUI-C27]] — **what the approvals gate DID, recorded while it was doing it**, for the
 * `/debug-dump` archive.
 *
 * ## The two gaps this exists to close
 *
 * 1. **An approval used to leave no trace at all.** A rejection is legible in a dump only as a
 *    byproduct of the negotiation — the protocol has to hand the reason back to the agent, so it
 *    lands in the transcript. An approval relays nothing to anyone: the tool simply runs. So the
 *    archive was at its most detailed about the decisions that STOPPED something and silent about
 *    the one decision that let something happen, which is exactly backwards for an incident review.
 *    Everything here is written on both branches.
 * 2. **Every field anyone had was a rater OUTPUT; its INPUT was never recorded.** Rung, outcome,
 *    reason, which preflight, whether the floor fired — all of them describe what the rater
 *    *answered*, and none records what it was *shown*. The question that actually failed in the
 *    field — *"were the user's messages in view on round 2?"* — needs the input of an approving
 *    round, the one combination the dump had neither half of.
 *
 * ## The one rule that shapes the whole module: CAPTURE, NEVER RE-RENDER
 *
 * {@link RaterCallCapture.prompt} holds the exact `{system, user}` strings handed to the model, taken
 * inside `rateShellCommand` at the send site — not rebuilt afterwards from the state that produced
 * them. A dump that can disagree with what actually happened is worse than no dump: it invites a
 * confident wrong conclusion from the only evidence there is, which is the failure mode this node
 * was filed over. The same rule is why {@link RaterCallCapture.rawResponse} keeps the model's answer
 * *before* it is mapped to an outcome — a malformed or surprising answer stays visible rather than
 * being smoothed into a verdict.
 *
 * ## The records are pushed EARLY and mutated in place, deliberately
 *
 * {@link ApprovalCaptureLog.begin} appends the record the moment a gated call arrives, and the gate
 * fills fields in as they are decided. The alternative — assemble the whole record, push it at the
 * end — loses exactly the events worth keeping: an `attack` verdict throws `AttackHaltError` out of
 * the decision, so a run that halted would carry no record of the rating that halted it. Pushing
 * first makes survival a property of the structure rather than of someone remembering to write the
 * record before each `throw`.
 *
 * ## Redaction
 *
 * Nothing is redacted here. The archive writer routes this artifact through the SAME
 * [[GS2-47]]/[[GS2-54]] pass as `transcript.json` and `model-messages.json`
 * (`renderStructured` → `redactText`, over the literal secret values `collectSecretValues`
 * harvested from env + config). Redacting twice, in two places, is how two policies come to exist.
 */
import type { ApprovalRung } from '#src/config.js';
import type { ToolApprovalScope } from '#src/core/types.js';
import type { AbstentionDefect } from '#src/core/shell/abstention.js';
import type { AlignmentCallCapture } from '#src/core/shell/alignment.js';
import type { NegotiationCounters } from '#src/core/shell/negotiation.js';
import type {
  FailClosedCause,
  PreflightFloorKind,
  RaterCallFailure,
  ShellSafetyVerdict,
} from '#src/core/shell/rater.js';

/**
 * How many gated decisions one session keeps. A ring buffer for the same reason the debug-log one
 * is: each record carries a full rating prompt (a few KB), and a long `auto` session makes a lot of
 * them. The newest are the ones a bug report is about, so the oldest are evicted.
 */
export const APPROVAL_CAPTURE_MAX = 50;

/**
 * **Which layer of the gate decided this call.** The diagnostic value of the whole record is
 * precisely here: a bug report that says "escalated" does not distinguish a rater verdict from a
 * floor match from a timeout from a deny-list hit, and those need four different answers.
 *
 * The names follow the numbered steps of `GthAgentRunner.decideToolApprovalInner`:
 *
 * - `not-gated` — the rung in force does not gate this tool at all.
 * - `deny-list` — a declared `approvals.deny` entry, or an *always reject* the human chose earlier.
 * - `bypass` — the gate is off for the session.
 * - `hardline-floor` — §8's deterministic floor matched, before any rating or prompt.
 * - `escalate-entry` — a declared `approvals.escalate` entry; a human answers, with no rating call.
 * - `allow-list` — an allow entry settled it with no rating (`rate: false`, or an unrated rung).
 * - `allow-tripwire` — an allow entry that kept the rater involved (§3.2's `rate: true`).
 * - `rater` — the ordinary rating path.
 * - `tool-open-world-floor` — §4.7.3's floor on a non-shell call whose effective `openWorldHint`
 *   is true. No rater sees it while §4.3's scope boundary stands.
 * - `unrated-rung` — nothing but the rung itself: `manual` and `write` consult no model, so a call
 *   no rule claimed goes to the human on the rung's say-so. It is its own value rather than an
 *   absent one, because "the rung requires a person" is an answer and a blank field reads as the
 *   recorder having failed.
 */
export type ApprovalDecidingStage =
  | 'not-gated'
  | 'deny-list'
  | 'bypass'
  | 'hardline-floor'
  | 'escalate-entry'
  | 'allow-list'
  | 'allow-tripwire'
  | 'rater'
  | 'tool-open-world-floor'
  | 'unrated-rung';

/**
 * What became of the call, as the agent experienced it. `error` is its own value rather than an
 * absence: a decision that threw something other than a halt is a fact about the gate, and a record
 * left with no action at all would read as one that never finished being written.
 */
export type ApprovalCaptureAction = 'approve' | 'reject' | 'escalate' | 'halt' | 'error';

/** How an escalation ended once it reached (or failed to reach) a person. */
export type ApprovalHumanAnswer = 'approve' | 'reject' | 'no-human';

/**
 * One rating call: what the rater was SHOWN and what it ANSWERED, captured at the send site.
 *
 * Every field is filled by `rateShellCommand` itself. `prompt` is set before the call and the rest
 * as the answer arrives, so a rater that never answers still leaves a record of what it was asked.
 */
export interface RaterCallCapture {
  /** ISO timestamp of the moment the call was sent. */
  at: string;
  /** Wall-clock ms the call took, once it has returned (or timed out). */
  durationMs?: number;
  /** The rater model's own label — an id and a provider type, never the instance. */
  model?: string;
  /** `approvals.rater` — the identity profile the rater model came from, when one is configured. */
  profile?: string;
  /** The budget this call was raced against ([[EXT-66]]). */
  timeoutMs: number;
  /** §5.2 — whether a rejection would be handed back to the AGENT rather than to a person. */
  negotiable: boolean;
  /**
   * **The exact strings sent.** Captured, never re-rendered.
   *
   * [[EXT-127]] — and there is no longer a negotiation record beside them, because there is no
   * longer a negotiation in this call: the classifier is handed one command and nothing else, so
   * *"were the user's messages in view for this rating?"* has one answer at every round, and it is
   * no. That question moved with the context it was about, to {@link AlignmentCallCapture}.
   */
  prompt: { system: string; user: string };
  /** The model's answer BEFORE it is parsed or mapped, so a malformed one stays visible. */
  rawResponse?: unknown;
  /** The verdict this call resolved to, including a fail-closed one. */
  verdict?: ShellSafetyVerdict;
  /** Set when the verdict is the gate failing closed rather than the model judging ([[EXT-66]]). */
  failClosed?: FailClosedCause;
  /**
   * [[EXT-82]] — the provider's own account of a call that never reached the model, when the
   * `threw` arm carried one. Already sanitised where it was built ({@link RaterCallFailure}), which
   * is not an exemption from the archive's redaction pass but a consequence of the same value being
   * carried into the verdict a user reads live, where no such pass runs.
   */
  providerError?: RaterCallFailure;
}

/** A declared entry or runtime grant that decided the call, rendered as the user would read it. */
export interface ApprovalRuleMatchCapture {
  action: 'allow' | 'deny' | 'escalate';
  /** The entry in the words the menu and the notices use (`describeApprovalEntry`). */
  entry: string;
  /** §3.2 — whether an allow entry kept the rater involved as a tripwire. */
  rate?: boolean;
}

/**
 * §8's deterministic floor, when it matched.
 *
 * **This block NAMES THE MATCHED PATTERN, and that is a decision taken rather than an oversight.**
 * §8.1 says the floor is never advertised, and [[CFG-31]] binds user-facing rung copy to that rule.
 * The resolution taken for [[TUI-C27]] is that §8.1 governs **rung descriptions and promotional
 * copy** — text that invites a user to feel safe — and not a diagnostic archive a user opens about
 * their own session. "A floor matched" without saying which one leaves nobody able to act on it;
 * the refusal the *user* sees ({@link import('./hardline.js').buildHardlineRefusal}) is unchanged
 * and still names only the description.
 */
export interface HardlineFloorCapture {
  /** The human-readable description, as the refusal message carries it. */
  description: string;
  /** The matched pattern's source, or the stable token of the non-pattern arm. */
  pattern: string;
}

/** A deterministic preflight finding, and whether it actually rewrote the rater's outcome. */
export interface PreflightFloorCapture {
  kind: PreflightFloorKind;
  reason: string;
  /**
   * Whether the floor changed the outcome. A preflight only ever RAISES, and only `safe` sits below
   * the floor — so a finding on a `destructive` verdict is the floor AGREEING with the rater, not
   * overriding it, and reporting those two the same way would misattribute the decision.
   *
   * Read together with {@link floorApplied}: this says whether the rating SAT below the floor, and
   * that says whether the floor was applied to the call at all.
   */
  rewroteRating: boolean;
  /**
   * [[EXT-106]] §4.6 — **whether the decision readers actually applied the finding above.** `false`
   * when the user-provenance carve-out lifted it, i.e. the preflight fired on the command and the
   * floor, the negotiation test and the action all ignored it because the user had named every host
   * themselves.
   *
   * **The finding is still reported when this is `false`, and that is the point.** This block is a
   * diagnostic archive a user opens about their own session, and a command that reached the open
   * world without anyone confirming it is exactly the one they most need to find in it. Nulling the
   * record out on a carve would delete the audit trail for the whole of the new behaviour.
   *
   * **Written from the decision's own reader** (`effectivePreflightFloorFinding`), never derived a
   * second time from the carved hosts: the floor has two arms, only that function resolves which of
   * them wins, and a command tripping both is floored by the script-env-leak arm while the
   * open-world arm would have carved. A second derivation says "carved, not floored" about a call
   * that was floored and did reach a human.
   */
  floorApplied: boolean;
  /**
   * [[EXT-106]] §4.6 — the host literals the carve-out matched, present only when
   * {@link floorApplied} is `false`. Every host in the command is here, because the carve-out
   * requires every one of them to have been named by the user.
   */
  carvedHosts?: string[];
}

/** One gated tool call, from arrival to outcome. */
export interface ApprovalDecisionCapture {
  /** ISO timestamp of the moment the call arrived at the gate. */
  at: string;
  /** The tool that was called. */
  tool: string;
  /** The command, for a `run_shell_command` call whose argument was a readable string. */
  command?: string;
  /** The rung in force for THIS decision (`/approvals <rung>` moves it mid-session). */
  rung: ApprovalRung;
  /** The stage that decided. `undefined` only if the decision threw before reaching one. */
  stage?: ApprovalDecidingStage;
  /** What became of the call. Always set by the time the decision returns or throws. */
  action?: ApprovalCaptureAction;
  /** The scope an approval was granted at, when one was. */
  scope?: ToolApprovalScope;
  /** Whether a person was actually asked, and what they said. */
  humanAnswer?: ApprovalHumanAnswer;
  /** §8's floor, when it matched. */
  hardline?: HardlineFloorCapture;
  /** The declared entry or runtime grant that decided the call, when one did. */
  ruleMatch?: ApprovalRuleMatchCapture;
  /** The deterministic preflight finding on this command, when there was one. */
  preflight?: PreflightFloorCapture;
  /**
   * [[EXT-81]] — whether the gate's own parser could not statically resolve the command, so the
   * rating carried a neutral note about the shape it saw.
   *
   * **This is what remains of "was the call an ABSTAIN".** `abstain` was an ACTION of its own until
   * [[EXT-81]] retired it: a parser reporting that it could not read a string has detected nothing,
   * so it no longer earns an action, and the command is now rated like any other. The observable
   * that survived is this shape report, and the budget position that used to accompany it is
   * {@link budget}.
   */
  parserUnresolved?: AbstentionDefect;
  /** Where this call sat in §5.3's consecutive bound and the reachability bound, on arrival. */
  budget: NegotiationCounters;
  /** The rating, when one was made. Absent for every stage that decided without a model. */
  rating?: RaterCallCapture;
  /**
   * [[EXT-127]] — the alignment check, when the classifier declined and a checker was consulted.
   *
   * **It is a SECOND record beside {@link rating}, not a field inside it**, because the two are two
   * model calls with two contexts and often two models. Collapsing them would make the archive
   * unable to answer the question the split exists to let a reader ask: what did each of them see,
   * and which of them decided this?
   */
  alignment?: AlignmentCallCapture;
  /** The error that ended the decision, when one did. */
  error?: string;
}

/**
 * The per-session log of gated decisions.
 *
 * **Instance-scoped, on the runner, and never a module singleton** — the same reason
 * `ShellNegotiationState` and the grant stores are: a concurrent ACP / AG-UI session must not
 * inherit another session's approvals history, and a dump taken in one must not describe the other.
 */
export class ApprovalCaptureLog {
  private records: ApprovalDecisionCapture[] = [];

  /**
   * Open a record for a gated call and return it LIVE, already in the buffer.
   *
   * The caller mutates the returned object as the decision is made. See the module docblock for why
   * the push happens here rather than at the end: a halt throws out of the decision, and a record
   * assembled at the end would be lost on exactly the calls most worth keeping.
   */
  begin(record: ApprovalDecisionCapture): ApprovalDecisionCapture {
    this.records.push(record);
    if (this.records.length > APPROVAL_CAPTURE_MAX) this.records.shift();
    return record;
  }

  /**
   * The records so far, oldest first. A copy of the ARRAY: the records themselves are handed over
   * live, because a decision still in flight is one the archive should show as it stands rather
   * than not at all.
   */
  snapshot(): ApprovalDecisionCapture[] {
    return [...this.records];
  }

  /** Drop everything — the TUI's `/clear` rotates the thread. */
  clear(): void {
    this.records = [];
  }
}

/**
 * A short, KEY-FREE label for the rater model: its id and its provider type, and nothing else.
 *
 * Deliberately not a param dump. A live `BaseChatModel` carries an `apiKey` and a client instance,
 * and this string goes into an archive people attach to bug reports — so it reads a fixed handful of
 * scalar fields through guards, exactly as `debugDump`'s own live-model descriptor does, rather than
 * serialising anything of the instance.
 */
export function raterModelLabel(model: unknown): string | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const m = model as {
    _llmType?: () => string;
    model?: unknown;
    modelName?: unknown;
    modelId?: unknown;
  };
  let type: string | undefined;
  try {
    type = typeof m._llmType === 'function' ? m._llmType() : undefined;
  } catch {
    type = undefined;
  }
  const id = [m.model, m.modelName, m.modelId].find((value) => typeof value === 'string') as
    string | undefined;
  if (id && type) return `${type}/${id}`;
  return id ?? type;
}
