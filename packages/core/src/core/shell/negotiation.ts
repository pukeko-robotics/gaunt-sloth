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
 * - **The transcript outlives the consecutive counter** ([[EXT-108]]). A successful intervening
 *   tool call resets §5.3's counter and leaves the rounds standing, so the retry after it is rated
 *   as round 2 with the argument so far in view. §5.3's reset bounds a *stalled* negotiation, and a
 *   command run *because the rater asked for it* is that argument continuing rather than a new one:
 *   clearing the rounds there made the agent's compliance erase the record of the advice it was
 *   complying with, and demoted the retry to a round-1 rating whose explanation §5.1 withholds.
 *   The spec's warning about justification text accumulating across unbounded attempts is answered
 *   by the reachability bound rather than by the reset — the attempts are not unbounded.
 * - **Only reaching a person clears the transcript** ({@link ShellNegotiationState.humanReached}),
 *   which is also the only thing that clears the reachability bound. The rounds a rating can see
 *   and the rejections counted against that bound are therefore the same set, always.
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
 * §5.3's argument is about **safety**, and its core is untouched: every attempt is rated
 * independently, the rater does not weaken with repetition, and every deterministic floor is
 * recomputed from the RAW command each round, so no amount of argument unlocks one. What
 * [[EXT-108]] changed is that a reset no longer clears the rounds with the counter, so the
 * justification channel §5.1 opens at round 2 stays open across an approved call — deliberately,
 * because the round after a call the rater itself asked for is the same argument continuing. That
 * is the one channel able to LOWER an outcome, which is why what bounds it matters: this count,
 * which no reset refills, is what ends an argument nobody is winning. Nothing here contradicts
 * §5.3, and this bound must never be described as a security control.
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
 * | the gate approved a call ({@link noteProgress}) | **kept** | 0 | unchanged |
 * | a human was reached ({@link humanReached}) | cleared | 0 | **0** |
 * | the run halted ({@link humanReached}) | cleared | 0 | 0 |
 */
export class ShellNegotiationState {
  /** §5.1's transcript: every round since a person was last involved, oldest first. */
  private rounds: RaterNegotiationRound[] = [];
  /**
   * §5.3's consecutive-rejection count. Reset by an approved call, which [[EXT-108]] stopped taking
   * the rounds with it — so this is the shorter of the two lifetimes, not a shared one.
   */
  private consecutive = 0;
  /** The reachability bound's count. Cleared ONLY by {@link humanReached}. */
  private sinceHuman = 0;
  /** §5.1's last user messages, oldest first, capped at {@link NEGOTIATION_USER_MESSAGE_RETENTION}. */
  private userMessages: string[] = [];
  /**
   * [[EXT-106]] §4.6 — whether {@link retainedUserMessages} may hand this session's human turns out
   * as **the user's own words**. See {@link admitUserProvenance}; `false` until something positively
   * establishes otherwise, which is the whole of its safety.
   */
  private userProvenanceAdmitted = false;

  /**
   * §5.1 — the context for the rating about to be made: the justification the agent supplied for
   * *this* command, the user messages, and the rounds so far.
   *
   * Handed over raw. The prompt builder owns every bound and every transform (last 5, truncation,
   * home-folding, one-lining, tag neutralisation), so a caller that pre-processes anything here is
   * doing the work twice and differently.
   *
   * An empty negotiation has no privileged spelling on the builder's side, so this always returns an
   * object and never `undefined`: an EMPTY transcript is the round-1 case, with no `if` at the call
   * site — which is what makes *"an empty transcript means a round-1 context"* fall out of the one
   * array rather than out of a second branch that could disagree with it.
   *
   * **Everything except the command is admitted from round 2, never at round 1**, and the transcript
   * is what decides which round this is. §5.1 is unambiguous — *"Round 1 sees the command alone —
   * nothing else"* — and after [[EXT-108]] the transcript empties only when a person is reached, so
   * round 1 is the first rating of a negotiation and nothing else is.
   *
   * Keying them on the transcript rather than on a flag is what keeps that one fact in one place,
   * and it is why the justification is withheld by the same test rather than passed straight
   * through. §5.1 lists the justification under what *"from round 2 the rater additionally sees"*,
   * and it is the one channel the design allows to LOWER an outcome — so a justification volunteered
   * before any rejection has happened would open that channel on the first attempt, pre-emptively,
   * for the agent or for anything that has injected into the agent's context. Withholding it until
   * round 2 is what the spec's ordering buys, and a round-1 context is byte-identical to a plain
   * rating because of it.
   *
   * The messages and the volunteered justification are the conversation and the pending call's own
   * argument, not the exchange, so nothing here destroys them; they are withheld at round 1 and
   * admitted afterwards. [[EXT-108]] is what decides when "afterwards" starts in §5.6's convergence
   * case: an approved call between two attempts no longer empties the transcript, so the reply
   * *"just the last two"* and the agent's own answer to the rejection are both in view for the very
   * next rating. That round has a rejection to answer — the one the approved call was made in
   * response to — which is the condition round 2 was ever about.
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
   * §5.3 — a tool call the gate let through. Resets the consecutive counter and **nothing else**:
   * the rounds stand, and so does the reachability bound.
   *
   * **The counter reset is §5.3's and is sound; taking the rounds with it was not** ([[EXT-108]]).
   * The reset exists to bound a *stalled* negotiation — an agent that went away, gathered
   * information and came back better informed is making progress, not ping-pong. But the approved
   * call is very often the agent doing exactly what the rejection told it to do, and clearing the
   * rounds there makes that compliance erase the record of the advice: the retry is then rated with
   * an empty transcript, which {@link contextFor} correctly reads as round 1 and so withholds the
   * justification and the user messages from. **Measured**: the rater refused `git reset --hard`
   * advising a stash first, the agent stashed, and the rater then advised a stash twice more —
   * recommending a thing already done, because on the evidence it was given it could not know.
   *
   * **What replaces the clearing as a bound is the count this deliberately leaves standing.** Every
   * appended round increments {@link NegotiationCounters.rejectionsSinceHuman}, which no reset
   * refills, so a transcript still cannot grow past {@link MAX_REJECTIONS_BEFORE_HUMAN} rounds
   * before {@link humanReached} clears the lot. A cap on the retained rounds would bound something
   * that is already bounded, and would re-introduce the erasure on a longer fuse.
   *
   * **"Approved" is what the gate can observe, and it is not quite §5.3's "successful".** The
   * decision site sees whether a call was allowed to run, never whether it then exited zero — and
   * the honest alternatives were worse: a tool-result stream carries the *rejected* call's own
   * result too, so counting results would let a rejection reset the counter that exists to bound it.
   * Erring here is permissive on this bound alone, which is precisely what
   * {@link MAX_REJECTIONS_BEFORE_HUMAN} is monotonic for.
   */
  noteProgress(): void {
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
   * [[EXT-106]] §4.6 — **the user's own words, for the provenance carve-out that lifts the
   * open-world floor.** A snapshot, oldest first, of the whole retained window.
   *
   * **This is deliberately NOT {@link contextFor}, and the difference is the point.** That function
   * returns `userMessages: []` at round 1 by design — §5.1's *"round 1 sees the command alone"* —
   * and round 1 is exactly the round the carve-out exists to act on: the user asks for a fetch, the
   * agent proposes it, and there has been no rejection for a round 2 to exist. §5.1 bounds what the
   * **rater** may see, and the floor is not the rater. Reading `contextFor()` here would make the
   * carve-out fire only after the command had already been refused once, i.e. never in the case it
   * was built for.
   *
   * The window is cumulative across the turns of a thread (capped and de-duplicated by
   * {@link noteUserMessages}), so a host named in an earlier turn still carves a command proposed in
   * a later one. {@link clear} drops it with the thread.
   *
   * **Empty until {@link admitUserProvenance} says otherwise**, which is why this is the provenance
   * window rather than {@link noteUserMessages}'s store: the store also feeds §5.1's negotiation
   * context, a different question with a different reader, and one that a command's fetched content
   * is legitimately part of. What must never be answered *"yes, the human said this"* is this
   * accessor, so the gate lives on it and defaults to refusing.
   */
  retainedUserMessages(): readonly string[] {
    if (!this.userProvenanceAdmitted) return [];
    return [...this.userMessages];
  }

  /**
   * [[EXT-106]] §4.6 — **declare whether this session's human turns are the user's own words**, and
   * therefore whether {@link retainedUserMessages} may return them at all.
   *
   * A human message the product SYNTHESISED from content it fetched must never enter the provenance
   * window: `review` and `pr` hand the agent a diff and a PR description that gaunt-sloth went and
   * got, and the review prompt tells the agent to examine them. Reading the same bytes as the user's
   * verbatim words would make the product contradict itself about identical input — and the words
   * are written by whoever opened the pull request.
   *
   * **It defaults to `false` and the caller must positively establish otherwise**, so a surface that
   * never calls this — or a future driver nobody has classified — floors exactly as it did before
   * the carve-out existed. The one caller is
   * {@link import('../GthAgentRunner.js').GthAgentRunner.init}, which decides it from the CLI verb
   * ({@link import('../../config/shell-policy.js').commandCarriesUserProvenance}) and never from
   * anything inside a message: those bytes are attacker-controlled, so a marker in them can be
   * forged by the text it is supposed to classify.
   */
  admitUserProvenance(admitted: boolean): void {
    this.userProvenanceAdmitted = admitted;
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
 * §5.4 — **one round of the argument, handed to a surface the moment it happens.**
 *
 * The round travels raw rather than rendered, so each surface lays it out with
 * {@link renderNegotiationRows} at its own terminal width — the same renderer, and the same
 * voice-tagged rows, that the escalation prompt draws. A pre-rendered string would be the second
 * renderer §5.4 exists to prevent, and it could not be bound to a width the runner cannot know.
 */
export interface LiveNegotiationRound {
  /** The round: the command proposed, the agent's justification, the rater's outcome and reason. */
  round: RaterNegotiationRound;
  /**
   * **How many rounds of the transcript precede this one, counting from zero.**
   *
   * It is passed rather than derived because the two facts {@link renderNegotiationRows} marks —
   * *this was rated on the command alone* (§5.1's round 1) and *this is round N* — are properties
   * of a POSITION IN THE TRANSCRIPT, and a caller handing over one round at a time has taken the
   * array's length away as a source for them. A live block that derived them would call every
   * round the first one.
   *
   * For a rejection this is its own index: the k-th rejection is at `k - 1`, which numbers it
   * `Round k`. For {@link agreed} it is the whole rejection count, because the approving round
   * follows all of them — but it is NOT numbered from it; see {@link agreed}.
   */
  position: number;
  /**
   * [[TUI-C69]] §5.4 — **the rater agreed, so this round ends the argument rather than continuing
   * it, and it takes no round number.**
   *
   * **A number here would be a number two different commands answer to.** The transcript holds
   * rejections and nothing else — {@link ShellNegotiationState.recordRejection} is its only writer
   * — so an approved call never joins it, and the next rejection takes the position this round was
   * displayed at. Numbered, the live view would show two `Round 2` rows, and the escalation prompt
   * (which renders that same transcript) would give `Round 2` to a third command again. The two
   * views exist to be one account of one argument, so the number belongs to whatever the transcript
   * says it belongs to, and the round that is not in the transcript is labelled instead of counted.
   *
   * Left unset for a rejection.
   */
  agreed?: boolean;
  /**
   * [[TUI-C69]] §5.4 — **the command that ended the argument is not the command that started it**,
   * so the row says the rater ACCEPTED a revision rather than AGREED to what it refused.
   *
   * Both are ways an argument ends and both are held, because §5.3 counts either as progress. They
   * are not the same claim, and only one of them can be made about a given command:
   *
   * - unset — the rater refused this exact command and has now passed it. *Agreed.*
   * - set — the approved command is not one the transcript holds. The agent narrowed
   *   `git reset --hard origin/main` to `git reset --soft HEAD~2` and the rater passed the new one;
   *   or it went off to run something else entirely first. *Accepted*, which says what happened
   *   without claiming the rater ever argued about this command.
   *
   * The distinction is the whole of the wrong-output half of the defect this fixes: the label used
   * to read `Agreed: ls src` over a command nobody had refused, which is a false statement about
   * the auto-rater printed in the chrome of the thing asking the user to trust it.
   *
   * Meaningful only with {@link agreed}; ignored on a rejection, which is numbered.
   */
  revised?: boolean;
}

/**
 * §5.4/§5.5 — **the surface that is showing this negotiation while it happens.**
 *
 * Wiring one is a surface saying *"I have a live display, and a person is looking at it"*, and it
 * is what both halves of the visible negotiation are keyed on:
 *
 * - each round is handed to {@link round} as it is decided, rather than only at an escalation;
 * - a negotiated approval is held for {@link NEGOTIATED_APPROVAL_COOLDOWN_MS} before it takes
 *   effect.
 *
 * **A surface that wires nothing neither renders nor sleeps**, which is the whole reason the two
 * are one seam. An `exec` or CI run has nobody to show an approval to, so an 800 ms hold there
 * would tax every headless run and every gate to display something to no one.
 */
export interface NegotiationDisplay {
  /** One round of the exchange, the moment the gate decided it. */
  round(event: LiveNegotiationRound): void;
  /**
   * **The exchange is over** — a person was reached, the run halted, the turn ended, or a new one
   * began. Called wherever {@link ShellNegotiationState.humanReached} is spent, and also at the end
   * of a turn, so a surface holding the rounds drops them whenever there is no longer a live
   * argument for them to be the state of.
   *
   * **The turn-end call is the one a converging negotiation depends on.** An escalation clears
   * itself, because a person is reached; a negotiation that SUCCEEDS reaches nobody, so without it
   * the rounds stay pinned through the idle period after the turn — the period in which the user is
   * reading the result and typing the next thing.
   *
   * It matters most at an ESCALATION, where the prompt is about to render the whole argument
   * itself: a live copy left standing above it puts the same exchange on an unscrollable screen
   * twice, and the rows it spends are rows the dialog needs.
   *
   * **Optional, because an append-only surface cannot honour it.** The readline session prints each
   * round as a line of scrollback; there is nothing to clear, and a surface that implements nothing
   * simply keeps what it printed.
   *
   * *That is a limitation rather than a justification*, and the difference is visible at an
   * escalation: the readline prompt re-renders the whole transcript, so a user who has just watched
   * rounds 1-3 scroll past is shown rounds 1-3 again inside the prompt. Nothing here can prevent
   * that — you cannot unprint scrollback — and the duplicate is the cheaper half of the trade,
   * since the prompt must show what it is asking about. Recorded so the next reader meets the cost
   * rather than the excuse.
   */
  end?(): void;
}

/**
 * §5.5 — **the minimum interval a negotiated approval is visible before it takes effect.**
 *
 * It must never be described or relied upon as an opportunity to evaluate the command: nobody
 * reads a command in 800 ms, and a design that assumed they did would be resting a safety property
 * on a glance. What it buys is that the approving round exists on screen as its own event, rather
 * than being drawn and overwritten by the tool's own output in the same frame.
 *
 * **It is NOT a guaranteed abort window on either surface**, and the claim must not be restored
 * without the mechanism: on the event/TUI path an abort during the interval does stop the tool,
 * but because LangGraph refuses an already-aborted signal rather than because this code re-checks
 * one; on the plain/readline path no signal is threaded and the Esc handler is torn down before
 * the interval begins, so the command runs. See `GthAgentRunner.showNegotiatedApproval`, which
 * carries the full statement of what is true where.
 *
 * **A minimum visible interval, not a delay added to a finished decision.** The real window is
 * longer at both ends — the rater call's own latency precedes it, and the tool takes time to start
 * after it — so this bounds the short end of a window that mostly already exists.
 */
export const NEGOTIATED_APPROVAL_COOLDOWN_MS = 800;

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
 * and neither the later rounds nor the menu line. A cap on the NUMBER of rounds does not answer
 * that — the measured case was three rounds, exactly what {@link NEGOTIATION_MAX_ROUNDS_SHOWN}
 * allows a screen, and it still cost 37 rows — because the cost is per row, not per round. Bounding
 * each element keeps every round structurally on the screen, which is what §5.6 calls the most important
 * thing on it, and pays for it out of the tail of a paragraph the reader was never going to need in
 * full: the archive keeps every round whole ([[TUI-C27]]'s capture is per rating call).
 *
 * Two rather than one so a wrapped command keeps the continuation that shows how it differs from
 * the round above it — the comparison the block exists to make.
 */
export const NEGOTIATION_MAX_ROWS_PER_ELEMENT = 2;

/**
 * Rounds a screen shows, newest last. **Binding rather than a backstop, since [[EXT-108]]**: an
 * approved call no longer clears the transcript, so an agent that makes progress between refusals
 * reaches a person carrying every round since the last one — up to
 * {@link MAX_REJECTIONS_BEFORE_HUMAN} of them — and an unscrollable prompt cannot grow a section
 * that long. What is dropped is said out loud in the heading, which carries the true count, and the
 * markers keyed on a position in the transcript stay keyed on it across the slice.
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
 * - **`attempts` counts the argument; the rounds below it are a slice of that argument.** A screen
 *   shows at most {@link NEGOTIATION_MAX_ROUNDS_SHOWN} of them, so the heading has to report what
 *   happened rather than what fits, and the rounds have to be numbered from the true attempt
 *   number. The caller's `rejectionsSinceHuman` is that count. [[EXT-108]] brought it into
 *   agreement with `rounds.length` for a caller holding the whole transcript — an approved call no
 *   longer erases rounds, and one event clears both — so what this parameter still guards is the
 *   slice, plus the `Math.max` below, which stops a stale or smaller number making the block claim
 *   less argument than it is about to print. Omit it and this falls back to `rounds.length`, the
 *   honest reading of a caller that has no better number.
 * - **The last round IS the pending rating, not a prior one.** {@link
 *   ShellNegotiationState.recordRejection} appends before either bound is tested, deliberately, so
 *   that the rating being escalated is on the transcript the human sees. The old heading called
 *   them all prior rounds, which both under-reported the argument and put the pending command on
 *   the screen twice with nothing saying they were the same call.
 * - **The first round was rated on the command alone.** An EMPTY transcript IS the round-1 case
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
    /**
     * [[TUI-C69]] §5.4 — **which block this is, and it changes three things.**
     *
     * - `escalation` (the default, and every caller that predates §5.4's live render) — the whole
     *   transcript, put in front of a person who is about to rule on it. It opens with the heading
     *   that counts the argument, and its last round IS the request being ruled on.
     * - `live` — one round, drawn the moment it happened. **Nobody has been asked anything**, so
     *   the `(this request)` marker would be a lie, and a heading counting the argument would be
     *   re-printed on every round. The context sentence is drawn once, over the round that opens
     *   the exchange.
     *
     * What does NOT change is everything the rows say: the same labels, the same voices, the same
     * width binding and the same row bound. The live view and the escalation prompt are one
     * renderer precisely so the exchange a person watched and the exchange they are shown cannot
     * be two different accounts of it.
     */
    mode?: 'escalation' | 'live';
    /**
     * [[TUI-C69]] §5.4 — the transcript position of `rounds[0]`, counting from zero, when the
     * CALLER took the slice. Omitted, this block takes the slice itself and knows the answer.
     *
     * It exists because the markers below are properties of a position in the transcript rather
     * than of a rating, and `rounds.length` stops being able to supply one the moment a caller
     * hands over a single round.
     */
    from?: number;
    /**
     * [[TUI-C69]] §5.4 — **this live round is the rater AGREEING**, which ends the argument
     * instead of being another attempt in it, so it is labelled rather than numbered.
     *
     * See {@link LiveNegotiationRound.agreed} for why it takes no number: the approved call never
     * joins the transcript, so any number it were given is the one the next rejection then takes —
     * and the escalation prompt, which renders the transcript, would hand that number to a
     * different command. `live` only; the escalation block renders the transcript, which contains
     * no approved rounds to label.
     */
    agreed?: boolean;
    /**
     * [[TUI-C69]] §5.4 — with {@link agreed}, whether the approved command is one the transcript
     * never held, which changes the label from *Agreed* to *Accepted*. See
     * {@link LiveNegotiationRound.revised}. `live` + `agreed` only.
     */
    revised?: boolean;
  }
): NegotiationRow[] {
  if (rounds.length === 0) return [];
  const width = options?.width;
  const live = options?.mode === 'live';
  // The rater agreeing ends the argument; it is not another numbered attempt in it. Only a live
  // block can carry one — the escalation block renders the transcript, and the transcript holds
  // rejections alone.
  const agreed = live && options?.agreed === true;
  // A screen shows the newest rounds; a consumer with no screen (§6.2's exception message) shows
  // them all, for the same reason it is handed no width.
  const shown = width === undefined ? rounds : rounds.slice(-NEGOTIATION_MAX_ROUNDS_SHOWN);
  // Never fewer attempts than rounds on the screen: a caller that passes a stale or smaller number
  // must not be able to make this block claim less argument than it is about to print.
  const attempts = Math.max(options?.attempts ?? rounds.length, rounds.length);
  // How many of the transcript's own rounds precede the first one shown, so a marker keyed on a
  // POSITION IN THE TRANSCRIPT (round one, the pending round) stays keyed on it after the slice.
  // A caller that took its own slice says so; otherwise this block took it and knows.
  const dropped = options?.from ?? rounds.length - shown.length;
  // The shown rounds are the most recent ones, so they are attempts `attempts - shown + 1` … N.
  // Numbering them by their true attempt number is what stops the heading's count and the rounds
  // beneath it describing two different exchanges. A live block has no such heading to agree with
  // and knows exactly where its round sits, so it numbers from the position itself.
  const firstNumber = live ? dropped + 1 : attempts - shown.length + 1;
  const rows: NegotiationRow[] = [];
  if (!live) {
    rows.push({
      voice: 'chrome',
      text:
        attempts > shown.length
          ? `The agent argued with the auto-rater ${attempts} times; the last ${shown.length} of them:`
          : `The agent argued with the auto-rater ${attempts} ${attempts === 1 ? 'time' : 'times'}:`,
    });
  } else if (dropped === 0) {
    // §5.4 — one context sentence per exchange, over the round that opens it. Repeating it on
    // every round would spend a row per round saying the same thing, and saying nothing at all
    // leaves a bare `Round 1:` with no account of what is talking to what.
    rows.push({ voice: 'chrome', text: 'The agent is negotiating with the auto-rater:' });
  }
  shown.forEach((round, index) => {
    // **Each marker rides the row whose reading it corrects, and no other.** Put on the `Round`
    // row they would be paid for in the one thing that row is for — the command, and how it
    // compares with the round above it — which at a narrow width is most of what fits on it.
    //
    // §5.4 — a LIVE round is never the pending request: nothing is being ruled on yet, and the
    // marker means *this is the call you are being asked about*.
    const pending = !live && dropped + index === rounds.length - 1 ? ' (this request)' : '';
    // **The round that ENDS the argument is labelled, not numbered.** Numbering it would spend a
    // number the transcript is about to reuse — the approved call never joins the transcript, so
    // the next rejection sits at the very position this round was drawn at, and the escalation
    // prompt then gives that number to a third command. A label cannot collide with a count.
    rows.push(
      ...negotiationRoundRows(
        round,
        agreed ? endingLabel(options?.revised) : `Round ${firstNumber + index}${pending}`,
        // An EMPTY transcript IS the round-1 case, so the transcript's FIRST round is the one §5.1
        // rated on the command alone. Derived from the position rather than carried on the round
        // because it is a property of the transcript, not of the rating.
        //
        // An `agreed` round is never it, and that is a fact about the transcript rather than about
        // today's call sites: the approved call is not ON the transcript, so it cannot be the first
        // thing on it whatever position it is drawn at. Said here rather than left to the caller's
        // arithmetic so no future emitter can make the §5.1 marker lie by drawing an agreement at
        // position zero.
        !agreed && dropped + index === 0
      )
    );
  });
  if (width === undefined) return rows;
  return rows.flatMap((row) => wrapRow(row, width));
}

/**
 * [[TUI-C69]] §5.4 — the label over the round that ENDS an argument, in the one place both the live
 * list and the single-round live render read it from, so the two surfaces cannot say different
 * things about the same event.
 *
 * *Agreed* is a claim about the rater's opinion of THIS command; *Accepted* is a claim only about
 * what it let through. Using the first where the second is true prints a false statement about the
 * auto-rater, which is worse than the vaguer word.
 */
const endingLabel = (revised: boolean | undefined): string =>
  revised === true ? 'Accepted' : 'Agreed';

/**
 * The three rows one round of the argument occupies — the command, the agent's justification if it
 * gave one, and the rater's answer — with the label already decided by the caller.
 *
 * **Extracted so the live panel and the escalation prompt cannot drift.** They differ in what they
 * put ABOVE the rounds (a heading, a context sentence) and in how many rounds they show; they must
 * not differ by so much as a colon in the rounds themselves, because the whole claim §5.4 rests on
 * is that the exchange a person watched and the exchange they are later asked to rule on are one
 * account of one argument. Two copies of this body is precisely how that claim would rot.
 */
function negotiationRoundRows(
  round: RaterNegotiationRound,
  label: string,
  roundOne: boolean
): NegotiationRow[] {
  const rows: NegotiationRow[] = [
    { voice: 'agent', text: `  ${label}: ${oneLine(round.command)}` },
  ];
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
  return rows;
}

/**
 * [[TUI-C69]] §5.4 — **the whole live exchange as a bounded screen**, for a surface that redraws a
 * pinned region rather than appending to scrollback.
 *
 * ## Why this exists rather than the caller looping over {@link renderNegotiationRows}
 *
 * **A cap applied one round at a time is not a cap.** The escalation prompt hands the renderer its
 * whole transcript, so `slice(-NEGOTIATION_MAX_ROUNDS_SHOWN)` bounds it; a live surface that
 * rendered each round as it arrived and kept the output handed the renderer a ONE-element array
 * every time, where that slice is an identity operation, and then accumulated the results. The
 * bound was still in the code and applied to nothing. **Measured**: a nine-round argument cost 46
 * rows at 80 columns that way, against 16 for the same argument in the prompt.
 *
 * That is not a tidiness problem. The Ink surface pins this inside a `flexShrink={0}` dock —
 * [[TUI-C75]]'s governing constraint is that the dialog does not scroll, so rows spent here are
 * taken from the conversation, and past a couple of dozen they push the input prompt off the
 * bottom of an 80×24 terminal. Every other occupant of that dock is bounded; this was the one that
 * was not.
 *
 * ## What it shows
 *
 * The newest {@link NEGOTIATION_MAX_ROUNDS_SHOWN} rounds, **unconditionally** — a screen is what
 * this is for, so unlike {@link renderNegotiationRows} it does not let an absent `width` mean "show
 * everything". A caller that wants the whole exchange unbounded wants the escalation renderer.
 *
 * Each round keeps the number of its own position in the transcript, so the numbers a watcher sees
 * are the numbers the escalation prompt will use for the same rounds even after the earlier ones
 * scroll out of this window — and an `agreed` round is labelled rather than numbered, for the
 * reason {@link LiveNegotiationRound.agreed} gives.
 *
 * The context sentence is drawn **every time** rather than only over round one. Once the window
 * slides, the round that carried it is gone, and the alternative is a bare `Round 7:` heading
 * nothing — an unattributed command sitting in the chrome of a tool that is asking the user to
 * trust it. One row is the right price for saying whose argument this is.
 */
export function renderLiveNegotiationRows(
  rounds: readonly LiveNegotiationRound[],
  options?: { width?: number }
): NegotiationRow[] {
  if (rounds.length === 0) return [];
  const width = options?.width;
  const shown = rounds.slice(-NEGOTIATION_MAX_ROUNDS_SHOWN);
  const rows: NegotiationRow[] = [
    { voice: 'chrome', text: 'The agent is negotiating with the auto-rater:' },
  ];
  for (const entry of shown) {
    rows.push(
      ...negotiationRoundRows(
        entry.round,
        entry.agreed === true ? endingLabel(entry.revised) : `Round ${entry.position + 1}`,
        entry.agreed !== true && entry.position === 0
      )
    );
  }
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
