/**
 * @module core/shell/escalationSeverity
 *
 * [[TUI-C26]] (spec §6) — **how severe the escalation is, said in words.**
 *
 * Every escalation used to look identical: the same yellow line, the same
 * `⚠ Auto-rater (<outcome>):`, on both surfaces. So `npm install lodash` and a typosquatted
 * `curl | bash` produced the same dialog, and a dialog that looks the same for everything trains
 * the reader to answer it the same way — which costs more than having no dialog at all.
 *
 * ## Why the words carry it, not the colour
 *
 * Colour is not reliably available. `NO_COLOR` is set on plenty of machines, output gets piped, a
 * monochrome or high-contrast terminal renders every tone identically, and a reader may simply not
 * be looking at hue. So each outcome carries **three** independent signals — a glyph, a tone and a
 * sentence — and the sentence is the one that always arrives. A change that makes two outcomes read
 * the same in words has removed the signal even if the colours still differ.
 *
 * **What the sentence says is the consequence, not the severity word again.** `catastrophic` is
 * defined by needing something from *outside* the session to undo (rescue media, a backup, a
 * re-provision), and that — not the adjective — is what a person can act on.
 *
 * ## The map is total, and `attack` is in it
 *
 * A `Record<RaterOutcome, …>` rather than a lookup with a default: an outcome added to
 * {@link RATER_OUTCOMES} must be given words here, and cannot silently inherit another outcome's.
 *
 * `attack` is present for that totality and **not because this prompt renders it**. An `attack`
 * verdict halts the run (`AttackHaltError`) on both rating paths, so it never reaches an approval
 * dialog; §6.1's banner is where it is answered, and that is [[TUI-C26]] task 3's. It shares the
 * `danger` tone and glyph with `catastrophic` deliberately: the two are not ranked against each
 * other (they answer different questions — *can this be undone?* versus *is something hostile
 * acting here?*), so distinguishing them by loudness would assert an ordering the rater's own
 * schema refuses. They are distinguished where it matters, in what they say.
 */
import type { RaterOutcome } from '#src/core/shell/rater.js';

/**
 * How loud a surface should be about an outcome. A surface maps this to its own vocabulary — Ink
 * colours on the TUI, the `display*` channel on the readline prompt — so neither has to hold its
 * own opinion about which outcome is worse than which.
 */
export type EscalationTone = 'notice' | 'warn' | 'danger';

/** Everything a surface needs to render one outcome, so no surface invents its own wording. */
export interface RaterOutcomeDisplay {
  /**
   * The heading a surface paints above the rater's reason, glyph and sentence included.
   *
   * It keeps the `Auto-rater (<outcome>):` opening the dialog has always had — that is the
   * attribution, and the reason underneath it is the rater's, not the gate's — and adds the
   * consequence after it.
   */
  heading: string;
  /** The tone the heading and the framed reason are painted in. */
  tone: EscalationTone;
}

/**
 * The label above the framed reason.
 *
 * The heading now carries a sentence of the gate's own, so without this the model-authored prose
 * beneath it could be read as a continuation of what the gate said. §6 wants the opposite: the
 * reason is the rater's, quoted, and it is framed exactly like the command for the same reason.
 */
export const RATER_REASON_LABEL = "    the rater's own words:";

const OUTCOME_DISPLAY: Record<RaterOutcome, RaterOutcomeDisplay> = {
  safe: {
    heading:
      '✓ Auto-rater (safe): no harmful effect found — you are being asked for another reason.',
    tone: 'notice',
  },
  destructive: {
    heading:
      '⚠ Auto-rater (destructive): this can destroy work or data, but undoing it is possible from ' +
      'inside this session.',
    tone: 'warn',
  },
  catastrophic: {
    heading:
      '⛔ Auto-rater (catastrophic): undoing this would need something OUTSIDE this session — ' +
      'rescue media, a backup, a re-provision, or a restore from someone else.',
    tone: 'danger',
  },
  attack: {
    heading:
      "⛔ Auto-rater (attack): this command's own STRUCTURE looks hostile — it is shaped to " +
      'deceive you, take credentials, weaken permissions or persist itself.',
    tone: 'danger',
  },
};

/** How to render {@link RaterOutcome} on an approval dialog. */
export function describeRaterOutcome(outcome: RaterOutcome): RaterOutcomeDisplay {
  return OUTCOME_DISPLAY[outcome];
}
