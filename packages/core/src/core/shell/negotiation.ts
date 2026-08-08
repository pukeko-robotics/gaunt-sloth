/**
 * @module core/shell/negotiation
 *
 * [[EXT-29]] (spec §5) — **the bounded, visible argument between the agent and the rater** that
 * `auto` conducts where `assisted` interrupts a person.
 *
 * A `destructive` rating at `auto` does not go to the human. It goes back to the *agent* as the
 * refused call's tool result (§7), naming what would make the command acceptable (§5.2); the agent
 * may narrow the command or justify the one it chose; the next call is rated again with the
 * exchange in view (§5.1). This module holds the state that makes that a bounded exchange rather
 * than a loop: the transcript, and the two counters that end it at a person.
 *
 * **It decides nothing about safety.** Every round is a full, independent rating by
 * {@link import('./rater.js').mapVerdictToAction}; this only answers *"may another round be
 * served, or is it a human's turn?"*.
 *
 * ## The lifetimes, which are the whole design
 *
 * - **The transcript and the consecutive counter have ONE lifetime, by construction** (§5.3). A
 *   successful intervening tool call resets the counter *and clears the transcript with it*, so the
 *   rating right after a reset is a round-1 context — the command alone, no transcript and no user
 *   messages. They are one field's worth of state precisely because the spec warns that an
 *   implementation clearing the counter alone *"looks correct and passes any obvious test"* while
 *   letting justification text accumulate across unbounded attempts.
 * - **The reachability bound is monotonic and a reset does not refill it.** See
 *   {@link MAX_REJECTIONS_BEFORE_HUMAN}.
 */
import type { RaterNegotiationContext, RaterNegotiationRound } from '#src/core/shell/rater.js';

/**
 * §5.3 — **three CONSECUTIVE rejections end the negotiation** and escalate to the human: the agent
 * and the rater cannot agree, and that is a human's call, not a machine's.
 *
 * Consecutive, not total: a successful intervening tool call — the agent going away to gather
 * information and returning better informed — resets it, because that is progress, not ping-pong.
 */
export const MAX_CONSECUTIVE_REJECTIONS = 3;

/**
 * [[EXT-29]] — **the reachability bound: total rejections since a human was last involved.** A
 * reset of {@link MAX_CONSECUTIVE_REJECTIONS} does not refill it; only actually reaching a person
 * clears it ({@link ShellNegotiationState.humanReached}).
 *
 * ## Why this exists, and why §5.3 does not answer it
 *
 * §5.3 says *"no total ceiling is added here, and none is needed"*, and tells the next reader not to
 * add one without a fresh decision. **This is that decision (Andrew, EXT-29), and it answers a
 * different question than the one §5.3 asked.**
 *
 * §5.3's argument is about **safety**, and it is sound and untouched: every attempt is rated
 * independently, the rater does not weaken with repetition, and — because a reset also clears the
 * transcript — a gamed reset approves nothing that would not have been approved on the first try.
 * Nothing here contradicts that, and this bound must never be described as a security control.
 *
 * The question §5.3 never asked is **reachability**: does the human terminus fire at all? Under its
 * own reset predicate it does not. An agent that alternates one approved `ls` with one rejection
 * never accumulates three *consecutive* rejections, so *"three rejections escalate to the human"* —
 * §7's promise that the model is never left to silently give up on a legitimate task — is
 * unreachable for that agent, for any number of rejections. The same shape was measured live on the
 * shipped EXT-65 retry budget, where a human's "No" and a deny-list match each refilled the budget.
 *
 * **`recursionLimit` is not the answer either.** It bounds the *run* at 1000 steps; it does not
 * escalate to a *person*. §5.3's *"that is a human's call"* names an event, and a dying run does not
 * produce it: the user gets a step-limit failure rather than the question they were promised.
 *
 * Nine — three times the consecutive cap — so an agent making genuine progress between rejections
 * still gets several full negotiations before a person is asked, while one making none is in front
 * of a human within a bounded number of rounds.
 *
 * **The shape and the number are Andrew's to change** (a progress-only reset predicate is the
 * standing alternative). What is not negotiable is that some bound ends at a person, so this stays
 * ONE constant and ONE predicate — {@link ShellNegotiationState.recordRejection} — and swapping it
 * is local.
 */
export const MAX_REJECTIONS_BEFORE_HUMAN = 9;

/** What {@link ShellNegotiationState.recordRejection} decides: serve another round, or ask a human. */
export type NegotiationVerdict = 'reject' | 'escalate';

/**
 * §5.1 — how many of the user's most recent messages the runner keeps for the rater. The prompt
 * builder takes the last 5 of whatever it is handed and truncates each; this is the runner's own
 * retention bound, so an unbounded conversation does not accumulate here.
 *
 * Deliberately larger than the builder's window: the builder drops blank messages *before* taking
 * its five, and it can only drop what it was given, so keeping a little slack is what stops a run of
 * empty turns from spending the budget that carries the mandate.
 */
export const NEGOTIATION_USER_MESSAGE_RETENTION = 10;

/**
 * The per-session state of §5's negotiation: one instance per {@link
 * import('../GthAgentRunner.js').GthAgentRunner}.
 *
 * Every mutation is one of four events, and naming them is what keeps the two bounds from being
 * confused with each other:
 *
 * | event | transcript | consecutive | since-human |
 * |---|---|---|---|
 * | a rejection ({@link recordRejection}) | append | +1 | +1 |
 * | the gate approved a call ({@link noteProgress}) | **cleared** | 0 | unchanged |
 * | a human was reached ({@link humanReached}) | cleared | 0 | **0** |
 * | the run halted ({@link humanReached}) | cleared | 0 | 0 |
 */
export class ShellNegotiationState {
  /** §5.1's transcript: every round of the CURRENT negotiation, oldest first. */
  private rounds: RaterNegotiationRound[] = [];
  /** §5.3's consecutive-rejection count. Shares the transcript's lifetime, by construction. */
  private consecutive = 0;
  /** The reachability bound's count. Cleared ONLY by {@link humanReached}. */
  private sinceHuman = 0;
  /** §5.1's last user messages, oldest first, capped at {@link NEGOTIATION_USER_MESSAGE_RETENTION}. */
  private userMessages: string[] = [];

  /**
   * §5.1 — the context for the rating about to be made: the justification the agent supplied for
   * *this* command, the user messages, and the rounds so far.
   *
   * Handed over raw. The prompt builder owns every bound and every transform (last 5, truncation,
   * home-folding, one-lining, tag neutralisation), so a caller that pre-processes anything here is
   * doing the work twice and differently.
   *
   * An empty negotiation has no privileged spelling on the builder's side, so this always returns an
   * object and never `undefined`: a cleared transcript IS the round-1 case, with no `if` at the call
   * site — which is exactly what makes §5.6's *"a cleared transcript means a round-1 context"* fall
   * out of the reset rather than out of a second branch that could disagree with it.
   *
   * **The user messages are admitted from round 2, never at round 1**, and the transcript is what
   * decides which round this is. §5.1 is unambiguous — *"Round 1 sees the command alone — nothing
   * else"* — and §5.6 spells out the consequence for the round right after a reset: *"the command
   * and nothing else — no transcript, no user messages, because that is what round 1 means"*.
   *
   * Keying them on the transcript rather than on a flag is what makes those two sentences the same
   * fact. The messages themselves are NOT cleared by the reset (they are the conversation, not the
   * argument), so §5.6's convergence still works: the reply *"just the last two"* is out of view for
   * the round-1 rating after the reset and in view for the round-2 rating that follows it — which is
   * exactly the row the spec's table shows it arriving on.
   */
  contextFor(justification?: string): RaterNegotiationContext {
    return {
      justification,
      userMessages: this.rounds.length === 0 ? [] : [...this.userMessages],
      priorRounds: [...this.rounds],
    };
  }

  /**
   * Record a rejected round and decide whether another may be served.
   *
   * **The round is appended BEFORE either bound is tested**, so the rating that escalates is itself
   * on the transcript the human sees. §5.6's escalation example turns on this: what matters on the
   * screen is that the agent proposed the same command three times, and the third proposal is the
   * one being escalated.
   */
  recordRejection(round: RaterNegotiationRound): NegotiationVerdict {
    this.rounds.push(round);
    this.consecutive += 1;
    this.sinceHuman += 1;
    if (this.consecutive >= MAX_CONSECUTIVE_REJECTIONS) return 'escalate';
    if (this.sinceHuman >= MAX_REJECTIONS_BEFORE_HUMAN) return 'escalate';
    return 'reject';
  }

  /**
   * §5.3 — a tool call the gate let through. Resets the consecutive counter **and clears the
   * transcript with it**; the reachability bound is deliberately untouched.
   *
   * **"Approved" is what the gate can observe, and it is not quite §5.3's "successful".** The
   * decision site sees whether a call was allowed to run, never whether it then exited zero — and
   * the honest alternatives were worse: a tool-result stream carries the *rejected* call's own
   * result too, so counting results would let a rejection reset the counter that exists to bound it.
   * Erring here is permissive on this bound alone, which is precisely what
   * {@link MAX_REJECTIONS_BEFORE_HUMAN} is monotonic for.
   */
  noteProgress(): void {
    this.rounds = [];
    this.consecutive = 0;
  }

  /**
   * A human was actually reached — an escalation presented to them, a new user turn, or a run that
   * ended. Clears everything, including the reachability bound: §5.3's *"three rejections end the
   * negotiation"* means the exchange is over, not merely paused.
   */
  humanReached(): void {
    this.rounds = [];
    this.consecutive = 0;
    this.sinceHuman = 0;
  }

  /**
   * §5.1 — record what the user said, oldest first, for the ratings of this and later turns.
   *
   * Blank messages are dropped here as well as by the builder: an empty turn carries nothing a rater
   * can weigh, and keeping it would spend a retention slot that the message carrying the mandate
   * needs.
   */
  noteUserMessages(messages: readonly string[]): void {
    for (const message of messages) {
      if (message.trim().length === 0) continue;
      this.userMessages.push(message);
    }
    if (this.userMessages.length > NEGOTIATION_USER_MESSAGE_RETENTION) {
      this.userMessages = this.userMessages.slice(-NEGOTIATION_USER_MESSAGE_RETENTION);
    }
  }

  /**
   * §6 — the rounds to show the human, oldest first. A snapshot: the caller holds it across the
   * {@link humanReached} that immediately follows, and nothing it holds may change underneath it.
   */
  transcript(): readonly RaterNegotiationRound[] {
    return [...this.rounds];
  }

  /** Drop everything, including the user messages — the TUI's `/clear` rotates the thread. */
  clear(): void {
    this.humanReached();
    this.userMessages = [];
  }
}

/**
 * §6 — render a negotiation for the human being asked to rule on it.
 *
 * **The whole exchange is shown, never only the last attempt.** *That the agent proposed
 * `git reset --hard origin/main` three times unchanged, against two rejections that each told it
 * what to fix, is itself the most important thing on the screen, and it is invisible if only the
 * last attempt is shown.* A prompt that shows the final command alone asks the user to rule on a
 * command; this asks them to rule on an argument, which is the decision they actually have.
 *
 * Returns `null` when there is nothing to show — no rounds — so a surface renders no empty heading
 * for the escalations that had no negotiation at all (`catastrophic`, a declared escalate entry, an
 * unrated rung).
 *
 * Line-structured and plain: the surfaces own their own colour and framing ([[TUI-C26]] renders the
 * rater's turns in yellow), and a shared renderer is what stops two of them describing one exchange
 * two ways.
 */
export function renderNegotiationTranscript(
  rounds: readonly RaterNegotiationRound[]
): string | null {
  if (rounds.length === 0) return null;
  const lines: string[] = [
    `The agent argued with the auto-rater ${rounds.length} ${rounds.length === 1 ? 'time' : 'times'} before this:`,
  ];
  rounds.forEach((round, index) => {
    lines.push(`  Round ${index + 1}: ${oneLine(round.command)}`);
    const justification = round.justification?.trim();
    if (justification) lines.push(`    agent justified: ${oneLine(justification)}`);
    const reason = round.reason.trim();
    lines.push(`    rater answered: ${round.outcome}${reason ? ` — ${oneLine(reason)}` : ''}`);
  });
  return lines.join('\n');
}

/**
 * Collapse a value onto one line before it is rendered into a line-structured block.
 *
 * Every value here is agent-authored or agent-influenced, and this block's meaning is carried by its
 * line structure: a newline inside a command or a justification would otherwise let it forge a
 * `Round N` heading and an answer that was never given. The rating prompt's own transcript builder
 * has the identical rule for the identical reason.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
