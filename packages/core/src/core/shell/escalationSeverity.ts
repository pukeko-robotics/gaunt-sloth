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
 * `attack` is present for that totality and **not because the approval prompt renders it**. An
 * `attack` verdict halts the run (`AttackHaltError`) on both rating paths, so it never reaches an
 * approval dialog: it is answered at [[TUI-C68]]'s §6.1 banner, whose copy is
 * {@link attackBannerCopy} — here, beside the heading it reuses, so the two cannot come to describe
 * one verdict two ways.
 *
 * `attack` shares the `danger` tone and glyph with `catastrophic` deliberately: the two are not
 * ranked against each other (they answer different questions — *can this be undone?* versus *is
 * something hostile acting here?*), so distinguishing them by loudness would assert an ordering the
 * rater's own schema refuses. They are distinguished where it matters, in what they say.
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

/**
 * [[TUI-C68]] §6.1 — **the phrase that runs an `attack`-rated command anyway.** The only string on
 * the banner that is not a refusal.
 *
 * A typed phrase rather than a key, because an irreversible decision must not be reachable by the
 * muscle memory built answering routine prompts. A key merely *disjoint from today's menu* stops
 * being disjoint the moment someone binds one; a phrase is immune to any future binding. `run`
 * alone was considered and rejected as the leading token of half of what anyone types into a
 * terminal.
 *
 * The label is never `bypass`: that is a rung (§2.5) and a far broader thing — it turns off the
 * rater, the escalation and the halt together, for every command, for the whole run — and a user
 * must never read this banner as switching to it.
 */
export const RUN_ANYWAY_PHRASE = 'run anyway';

/**
 * §6.1 — does what the human typed grant this one command?
 *
 * **The whole matching rule, in one place both surfaces call**, so what the banner *says* is
 * answerable and what a surface *accepts* cannot drift. Trimmed, lower-cased, compared whole:
 * `RUN ANYWAY` and a phrase with surrounding spaces grant; `run`, `runanyway`, `run anyway please`
 * and the phrase with a doubled inner space do not. No prefix, no initial, no `y`, no alias.
 *
 * **Everything that is not the phrase is a refusal, and that is the property the banner rests on.**
 * An approval prompt grants only on an offered key and treats every other keystroke as a rejection;
 * a text buffer inverts that by accumulating keystrokes instead of rejecting them, and a matcher
 * this narrow is what puts it back — the buffer may hold anything at all, and only one value of it
 * runs the command.
 *
 * Deliberately NOT whitespace-normalising the middle: a rule that repairs what the user typed is a
 * rule that grants on something they did not type, and retyping a phrase costs nothing next to
 * running this command by accident.
 */
export function grantsRunAnyway(typed: string): boolean {
  return typed.trim().toLowerCase() === RUN_ANYWAY_PHRASE;
}

/**
 * §6.1 — the banner's own words, shared so no surface invents its own.
 *
 * It carries what every surface must say and nothing about how any one of them is driven: the
 * readline prompt reads a line in cooked mode and has no `q` or `Esc` to bind, so a keyboard line
 * here would be false on one of the two surfaces. A surface adds its own keys beside these.
 */
export interface AttackBannerCopy {
  /** The banner's title row — what happened, above everything else. */
  title: string;
  /** The `attack` heading from {@link describeRaterOutcome}, glyph and consequence included. */
  heading: string;
  /**
   * **The irreversibility line, and it is UNCONDITIONAL** — on every attack banner, whatever the
   * rating said, and not only where the command was also rated `catastrophic`.
   *
   * The banner is rare by construction (§4.1.1 forbids `attack` firing on ordinary work), so the
   * line cannot become noise; and a static string cannot fail the way a model's explanation can. It
   * is the last thing between a human and an action nothing else will stop.
   */
  irreversible: string;
  /** What each control does, in the phrase's own words. */
  controls: readonly string[];
  /** The label a surface puts in front of the buffer the human types into. */
  prompt: string;
  /**
   * What a surface says once the phrase has been accepted.
   *
   * It states the scope of what was just granted, because that is the half a user cannot observe:
   * the command running is visible, and *only this one running* is not. Shared so neither surface
   * can promise a persistence the runner does not perform.
   */
  granted: string;
}

/**
 * §6.1 — the banner copy. A function rather than an exported object so one surface cannot mutate
 * the strings another is about to paint.
 */
export function attackBannerCopy(): AttackBannerCopy {
  return {
    title: '⛔ RUN HALTED — the auto-rater rated this command an ATTACK',
    heading: OUTCOME_DISPLAY.attack.heading,
    irreversible: 'If you run it anyway, the consequences may be IRREVERSIBLE.',
    controls: [
      `To run this ONE command: type   ${RUN_ANYWAY_PHRASE}   and press Enter.`,
      'Anything else stops the run: any other text, or Enter on its own.',
      'Nothing is remembered either way — this command is rated again next time.',
    ],
    prompt: 'Your answer: ',
    granted:
      'Running this ONE command. The rung is unchanged, nothing was added to the allow-list, ' +
      'and the next identical command is rated and halted again.',
  };
}
