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
import { MIN_CONTENT_WIDTH, neutralizeToOneLine, wrapToWidth } from '#src/core/shell/framing.js';
import type { RaterNegotiationContext, RaterNegotiationRound } from '#src/core/shell/rater.js';
import { maxDisplayWidth } from '#src/utils/displayWidth.js';

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
 * Where a negotiation stands against its two bounds, as a plain readable projection.
 *
 * The caps travel WITH the counts on purpose: "2 consecutive rejections" says nothing on its own,
 * and a reader of a `/debug-dump` archive has no way to look {@link MAX_CONSECUTIVE_REJECTIONS} up.
 * "2 of 3" is the same fact and is actionable.
 */
export interface NegotiationCounters {
  /** §5.3's consecutive-rejection count. Cleared by an approved call and by reaching a human. */
  consecutiveRejections: number;
  /** The reachability bound's count: total rejections since a person was last involved. */
  rejectionsSinceHuman: number;
  /** {@link MAX_CONSECUTIVE_REJECTIONS}. */
  maxConsecutive: number;
  /** {@link MAX_REJECTIONS_BEFORE_HUMAN}. */
  maxBeforeHuman: number;
}

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
   * **Everything except the command is admitted from round 2, never at round 1**, and the transcript
   * is what decides which round this is. §5.1 is unambiguous — *"Round 1 sees the command alone —
   * nothing else"* — and §5.6 spells out the consequence for the round right after a reset: *"the
   * command and nothing else — no transcript, no user messages, because that is what round 1 means"*.
   *
   * Keying them on the transcript rather than on a flag is what makes those two sentences the same
   * fact, and it is why the justification is withheld by the same test rather than passed straight
   * through. §5.1 lists the justification under what *"from round 2 the rater additionally sees"*,
   * and it is the one channel the design allows to LOWER an outcome — so a justification volunteered
   * before any rejection has happened would open that channel on the first attempt, pre-emptively,
   * for the agent or for anything that has injected into the agent's context. Withholding it until
   * round 2 is what the spec's ordering buys, and a round-1 context is byte-identical to a plain
   * rating because of it.
   *
   * The messages and the volunteered justification are NOT destroyed by a reset (they are the
   * conversation and the pending call's own argument, not the exchange), so §5.6's convergence still
   * works: the reply *"just the last two"* is out of view for the round-1 rating after the reset and
   * in view for the round-2 rating that follows it — which is exactly the row the spec's table shows
   * it arriving on. A justification the agent supplies again with its next attempt is admitted then,
   * because by then there is a rejection for it to answer.
   */
  contextFor(justification?: string): RaterNegotiationContext {
    const roundOne = this.rounds.length === 0;
    return {
      justification: roundOne ? undefined : justification,
      userMessages: roundOne ? [] : [...this.userMessages],
      priorRounds: [...this.rounds],
    };
  }

  /**
   * Record a rejected round and decide whether another may be served.
   *
   * **The round is appended BEFORE either bound is tested**, so the rating that escalates is itself
   * on the transcript the human sees. §5.6's escalation example turns on this: what matters on the
   * screen is that the agent proposed the same command three times, and the third proposal is the
   * one being escalated. {@link renderNegotiationRows} marks that last round as the pending request
   * rather than as a prior one, which is the half of this the reader needs and cannot derive.
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
   * **What it must NOT truncate is the human's record of how hard the agent pushed.** The counter's
   * reset is §5.3's and is sound; the reader at an escalation is asking a different question, and
   * the answer to theirs is {@link NegotiationCounters.rejectionsSinceHuman}, which this leaves
   * standing. {@link renderNegotiationRows} reports that count rather than the surviving rounds, so
   * an argument this erased is still declared even though its rounds are gone; every erased round
   * itself survives whole in [[TUI-C27]]'s archive, which captures per RATING CALL and so is not
   * truncated by anything here.
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
   *
   * **A message already retained moves to the newest position rather than being stored twice**, and
   * that is not tidiness. The runner cannot tell "this turn's new message" from "the whole
   * conversation replayed", because both arrive as the same argument — `runtime/conversation.ts`
   * replays the accumulated array on every turn, while the TUI and the readline session pass the one
   * new message. Appending blindly would fill §5.1's five-message window with repeats of the same
   * sentence for the replaying caller, starving the rater of the one context it is allowed. Keeping
   * the newest position is also the right answer when a user genuinely repeats themselves: it is one
   * thing they said, and it was said most recently.
   */
  noteUserMessages(messages: readonly string[]): void {
    for (const message of messages) {
      if (message.trim().length === 0) continue;
      const seen = this.userMessages.indexOf(message);
      if (seen !== -1) this.userMessages.splice(seen, 1);
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

  /**
   * [[TUI-C27]] — where this negotiation stands against both bounds, for the `/debug-dump` archive.
   *
   * **There is a real reader for this now, which is what changed.** `sinceHuman` had no accessor
   * because the only thing that wanted it was a spec, and a getter in production for a spec-only
   * reader is a widened class with nothing behind it (`shellNegotiation.spec.ts` reaches it through
   * a cast for exactly that reason, and still does). The archive is a production reader: *"the call
   * was rejected"* and *"the call was the third consecutive rejection, so the next one goes to a
   * person"* are different facts, and a bug report carrying only the first invites the wrong
   * conclusion about why a session started interrupting.
   *
   * **`rejectionsSinceHuman` is also what the escalation prompt COUNTS**, and that is the one place
   * it faces a person rather than a debugging archive. It is read at the escalation site before
   * {@link humanReached} spends it; reading it after would report zero.
   */
  counters(): NegotiationCounters {
    return {
      consecutiveRejections: this.consecutive,
      rejectionsSinceHuman: this.sinceHuman,
      maxConsecutive: MAX_CONSECUTIVE_REJECTIONS,
      maxBeforeHuman: MAX_REJECTIONS_BEFORE_HUMAN,
    };
  }

  /** Drop everything, including the user messages — the TUI's `/clear` rotates the thread. */
  clear(): void {
    this.humanReached();
    this.userMessages = [];
  }
}

/**
 * §5.4 — **who is speaking on one row of the transcript**, so a surface can colour the two voices
 * apart. §5.4 requires the rater's turns to be yellow *precisely so the two are never confused*,
 * and a renderer that hands back one joined string cannot express that: both surfaces painted the
 * whole exchange in a single colour, which is the thing the spec forbids.
 *
 * - `chrome` — this renderer's own words (the heading).
 * - `agent`  — what the agent proposed, and the justification it gave for it.
 * - `rater`  — the rating that answered.
 */
export type NegotiationVoice = 'chrome' | 'agent' | 'rater';

/** One terminal row of a rendered negotiation, tagged with whose turn it is. */
export interface NegotiationRow {
  voice: NegotiationVoice;
  text: string;
}

/**
 * The prefix a row too wide for the terminal is continued with.
 *
 * **A continuation is where this block could be forged, and an indent alone does not stop it.** The
 * rows carry agent-authored text after this renderer's own `Round N:` / `agent justified:` /
 * `rater answered:` labels, so a long command left to the terminal's own wrap continues at column 0
 * — the flush-left forgery `core/shell/framing` exists to prevent, reached through the one block
 * that was not framed. Wrapping here fixes the column, and a marker no label starts with fixes the
 * rest: a continuation cannot be read as a turn that was never taken, whatever it contains.
 */
const CONTINUATION_PREFIX = '      ┊ ';

/**
 * Terminal rows one element of a round — the command, the justification, the rater's answer — may
 * occupy on a screen before the rest of it is elided.
 *
 * **MEASURED, and it is the height bound this block needs rather than a cap on rounds.** At 80
 * columns three rounds of paragraph-length argument cost 37 rows, of which one round was 12; the
 * whole prompt was 64 rows against a 20-row budget, so the human saw the command and the verdict
 * and neither the later rounds nor the menu line. A cap on the NUMBER of rounds would have changed
 * none of that — §5.3 already bounds the transcript at
 * {@link MAX_CONSECUTIVE_REJECTIONS} — because the cost is per row, not per round. Bounding each
 * element keeps every round structurally on the screen, which is what §5.6 calls the most important
 * thing on it, and pays for it out of the tail of a paragraph the reader was never going to need in
 * full: the archive keeps every round whole ([[TUI-C27]]'s capture is per rating call).
 *
 * Two rather than one so a wrapped command keeps the continuation that shows how it differs from
 * the round above it — the comparison the block exists to make.
 */
export const NEGOTIATION_MAX_ROWS_PER_ELEMENT = 2;

/**
 * Rounds a screen shows, newest last. A backstop rather than today's binding constraint: §5.3
 * escalates at {@link MAX_CONSECUTIVE_REJECTIONS}, so a transcript reaching a human is never longer
 * than this — and an unscrollable prompt must not acquire an unbounded section the moment that
 * number is raised. What is dropped is said out loud in the heading, which carries the true count.
 */
export const NEGOTIATION_MAX_ROUNDS_SHOWN = 3;

/**
 * §6/§5.4 — render a negotiation for the human being asked to rule on it, one terminal row per
 * element, each tagged with the voice speaking it.
 *
 * **The whole exchange is shown, never only the last attempt.** *That the agent proposed
 * `git reset --hard origin/main` three times unchanged, against two rejections that each told it
 * what to fix, is itself the most important thing on the screen, and it is invisible if only the
 * last attempt is shown.* A prompt that shows the final command alone asks the user to rule on a
 * command; this asks them to rule on an argument, which is the decision they actually have.
 *
 * Empty when there are no rounds, so a surface renders no heading over an argument that never
 * happened (`catastrophic`, a declared escalate entry, an unrated rung).
 *
 * **`width` is optional and means "bind the rows to this terminal".** Given one, every row returned
 * fits it under either ambiguous-width policy — measured with the same conservative ruler
 * `core/shell/framing` budgets with, never `.length`, because a row measured as fitting that does
 * not fit is a row the terminal wraps back to column 0. Omitted, rows are returned unwrapped, which
 * is what the §6.2 non-interactive message wants: it is prose in an exception, not a screen.
 *
 * A wrapped row keeps the voice of the row it continues. A continuation painted as chrome would put
 * the rater's words in the agent's colour at exactly the width where a long argument is hardest to
 * read, which is the confusion §5.4 exists to remove.
 *
 * ## The three things this block must not get wrong about its own exchange
 *
 * Every label here sits over data that is already correct, so a label that lies does so silently —
 * and each of these lied toward approving, at the moment a human was deciding whether to overrule
 * a refusal.
 *
 * - **`attempts` is the count, and it is not `rounds.length`.** §5.3 clears the transcript on an
 *   approved call, so the rounds handed over are the attempts since the last *approval*, while the
 *   fact the reader is weighing is how hard the agent pushed since the last *human* — the caller's
 *   `rejectionsSinceHuman`. A measured escalation attempted the same command five times and
 *   rendered three. Omit it and this falls back to `rounds.length`, which is the honest reading of
 *   a caller that has no better number rather than a claim that none were erased.
 * - **The last round IS the pending rating, not a prior one.** {@link
 *   ShellNegotiationState.recordRejection} appends before either bound is tested, deliberately, so
 *   that the rating being escalated is on the transcript the human sees. The old heading called
 *   them all prior rounds, which both under-reported the argument and put the pending command on
 *   the screen twice with nothing saying they were the same call.
 * - **The first round was rated on the command alone.** A cleared transcript IS the round-1 case
 *   (see {@link ShellNegotiationState.contextFor}), so §5.1 withheld the justification and the user
 *   messages from that rating — while {@link ShellNegotiationState.recordRejection} stores the
 *   justification the agent supplied whatever the round. Printed unmarked, the round reads as a
 *   rater brushing past a direct answer to its own objection, which is the opposite of what
 *   happened and makes the rater look stubborn exactly where the reader is deciding whether to
 *   overrule it. The withholding is correct and is not what this marks. The same marker answers
 *   *"were the user's own words in view when this was rated?"* — a justification claiming the user
 *   asked for a command is exactly what a round-1 rating cannot check, and the user's messages are
 *   several rows on a surface with none to spare.
 *
 * **The prompt this feeds does not scroll and nothing else on it can give up rows**, so the height
 * bound is {@link NEGOTIATION_MAX_ROWS_PER_ELEMENT} and every fact above is carried by a row that
 * already exists.
 */
export function renderNegotiationRows(
  rounds: readonly RaterNegotiationRound[],
  options?: {
    width?: number;
    /**
     * Rejected attempts since a human was last involved — `rejectionsSinceHuman` from {@link
     * ShellNegotiationState.counters}, read BEFORE the escalation spends it.
     */
    attempts?: number;
  }
): NegotiationRow[] {
  if (rounds.length === 0) return [];
  const width = options?.width;
  // A screen shows the newest rounds; a consumer with no screen (§6.2's exception message) shows
  // them all, for the same reason it is handed no width.
  const shown = width === undefined ? rounds : rounds.slice(-NEGOTIATION_MAX_ROUNDS_SHOWN);
  // Never fewer attempts than rounds on the screen: a caller that passes a stale or smaller number
  // must not be able to make this block claim less argument than it is about to print.
  const attempts = Math.max(options?.attempts ?? rounds.length, rounds.length);
  // The shown rounds are the most recent ones, so they are attempts `attempts - shown + 1` … N.
  // Numbering them by their true attempt number is what stops the heading's count and the rounds
  // beneath it describing two different exchanges.
  const firstNumber = attempts - shown.length + 1;
  // How many of the transcript's own rounds this screen had to drop, so a marker keyed on a
  // POSITION IN THE TRANSCRIPT (round one, the pending round) stays keyed on it after the slice.
  const dropped = rounds.length - shown.length;
  const rows: NegotiationRow[] = [
    {
      voice: 'chrome',
      text:
        attempts > shown.length
          ? `The agent argued with the auto-rater ${attempts} times; the last ${shown.length} of them:`
          : `The agent argued with the auto-rater ${attempts} ${attempts === 1 ? 'time' : 'times'}:`,
    },
  ];
  shown.forEach((round, index) => {
    // **Each marker rides the row whose reading it corrects, and no other.** Put on the `Round`
    // row they would be paid for in the one thing that row is for — the command, and how it
    // compares with the round above it — which at a narrow width is most of what fits on it.
    const pending = dropped + index === rounds.length - 1 ? ' (this request)' : '';
    // A cleared transcript IS the round-1 case, so the transcript's FIRST round is the one §5.1
    // rated on the command alone. Derived from the position rather than carried on the round
    // because it is a property of the transcript, not of the rating — but that makes it a fact a
    // reset could quietly invalidate, so it is pinned against a real run rather than by reading.
    const roundOne = dropped + index === 0;
    rows.push({
      voice: 'agent',
      text: `  Round ${firstNumber + index}${pending}: ${oneLine(round.command)}`,
    });
    const justification = round.justification?.trim();
    if (justification) {
      rows.push({
        voice: 'agent',
        text: `    agent justified${roundOne ? ' (not shown to the rater)' : ''}: ${oneLine(justification)}`,
      });
    }
    const reason = round.reason.trim();
    rows.push({
      voice: 'rater',
      text: `    rater answered${roundOne ? ' (on the command alone)' : ''}: ${round.outcome}${reason ? ` — ${oneLine(reason)}` : ''}`,
    });
  });
  if (width === undefined) return rows;
  return rows.flatMap((row) => wrapRow(row, width));
}

/**
 * One logical row as the terminal rows it needs, continuations marked and voice preserved — and
 * never more than {@link NEGOTIATION_MAX_ROWS_PER_ELEMENT} of them.
 *
 * The elision is stated on the last row it keeps rather than on one of its own: a row spent saying
 * a row was dropped saves nothing on a surface whose whole problem is rows.
 */
function wrapRow(row: NegotiationRow, width: number): NegotiationRow[] {
  const budget = Math.max(MIN_CONTENT_WIDTH, width - maxDisplayWidth(CONTINUATION_PREFIX));
  const lines = wrapToWidth(row.text, budget);
  // **The heading WRAPS but is never clamped, and the distinction is the same one
  // `approvalStop`'s rows make**: the row bound exists to stop agent-authored prose spending a
  // screen that cannot scroll, and the heading is this renderer's own sentence — nothing can forge
  // it, so it may wrap like ordinary prose, and clamping it buys nothing. It costs, though: the
  // heading is where the attempt count lives, and at {@link MIN_FRAME_WIDTH} a clamp lands inside
  // the number, deleting the single most decision-relevant fact on the block to save one row.
  const kept =
    row.voice === 'chrome' ? [...lines] : lines.slice(0, NEGOTIATION_MAX_ROWS_PER_ELEMENT);
  const hidden = lines.length - kept.length;
  if (hidden > 0 && kept.length > 0) {
    const marker = ` … +${hidden} ${hidden === 1 ? 'row' : 'rows'}`;
    const last = kept.length - 1;
    // **The marker is the fact; the tail of the sentence it truncates is not.** On a frame too
    // narrow to hold both, the content gives way rather than the row overrunning — and the joined
    // row is re-bound afterwards, because `wrapToWidth` can only bind text it was given, and it was
    // never given these two pieces joined. A row measured as fitting that does not fit is a row the
    // terminal wraps back to column 0, which is the one thing every row here is bound to prevent.
    const room = budget - maxDisplayWidth(marker);
    const head = room >= MIN_CONTENT_WIDTH ? (wrapToWidth(kept[last], room)[0] ?? '') : '';
    const composed = `${head}${marker}`;
    kept[last] =
      maxDisplayWidth(composed) <= budget ? composed : (wrapToWidth(composed, budget)[0] ?? '');
  }
  const [head, ...rest] = kept;
  return [
    { voice: row.voice, text: head },
    ...rest.map((text) => ({ voice: row.voice, text: `${CONTINUATION_PREFIX}${text}` })),
  ];
}

/**
 * The same transcript as one string, for a consumer with no screen to lay it out on: §6.2's
 * non-interactive escalation message, where the exchange goes into an exception because that
 * message is the only thing anyone sees on that path.
 *
 * Defined as {@link renderNegotiationRows} joined, so the string and the rows can never come to
 * describe one exchange two ways — the whole reason there is one renderer and two surfaces.
 * `null` when there is nothing to show.
 *
 * `attempts` carries the same fact it carries on a screen. It is the one thing a caller must pass
 * for this message to be true, because the count it defaults to is the one an approved call
 * truncated.
 */
export function renderNegotiationTranscript(
  rounds: readonly RaterNegotiationRound[],
  attempts?: number
): string | null {
  const rows = renderNegotiationRows(rounds, attempts === undefined ? undefined : { attempts });
  if (rows.length === 0) return null;
  return rows.map((row) => row.text).join('\n');
}

/**
 * Collapse a value onto one line before it is rendered into a line-structured block.
 *
 * Every value here is agent-authored or agent-influenced, and this block's meaning is carried by its
 * line structure: a newline inside a command or a justification would otherwise let it forge a
 * `Round N` heading and an answer that was never given. The rating prompt's own transcript builder
 * has the identical rule for the identical reason.
 *
 * [[TUI-C26]] — collapsing whitespace is **not** on its own enough for a value bound for a terminal.
 * JavaScript's `\s` covers LF, CR and TAB and covers neither ESC nor the C1 range, so a rater
 * `reason` carrying a screen-clear sequence used to reach the approval dialog intact on a line that
 * merely looked tidy. Neutralisation runs first, and the collapse then only has ordinary spaces left
 * to fold.
 */
function oneLine(text: string): string {
  return neutralizeToOneLine(text);
}
