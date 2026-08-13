/**
 * [[TUI-C71]] — the hostile strings the run-ending approvals stops are ruled on.
 *
 * **Every invisible character here is built from an explicit code point and never typed.** A rule
 * about invisible characters must not depend on one surviving an editor, a diff, a merge or a
 * reviewer's terminal — and a fixture whose input is a hand-typed string with an escape in it is
 * exactly as hard to review as the bug it guards against. Same rule, same reason, as
 * `framingCommands.mjs`.
 *
 * **Nothing here may actually run.** Every payload is an `echo`, and no test in this suite answers
 * a banner with the phrase that would grant one — a stop is the whole subject.
 */

const CR = String.fromCodePoint(0x0d);
const ESC = String.fromCodePoint(0x1b);
const LF = '\n';
/** Cursor-up: on a raw render it walks back over the chrome above and overwrites it. */
const CURSOR_UP = `${ESC}[A`;
/** Screen-clear: on a raw render everything above it disappears. */
const CLEAR_SCREEN = `${ESC}[2J`;

/** A line that reads like the approval dialog's key menu. Newlines alone are enough to lay it down. */
export const FORGED_MENU = 'Approve?  [o]nce   [s]ession   [a]lways   [N]o';

/** A line that reads like a verdict — the lie that costs most on a screen telling you to stop. */
export const FORGED_VERDICT = '⚠ Auto-rater (safe): approved by rater';

/**
 * The command the agent proposes: a carriage return, a screen-clear, a cursor-up and a line
 * reading like a verdict, around markers an assertion can find. Rendered raw, the CR walks back to
 * column 0 and overwrites the row it landed on, the sequences wipe the screen above it, and the
 * two forged lines sit flush-left among the gate's own.
 *
 * **It composes, and that is deliberate.** The pipe makes the gate unable to resolve the command
 * statically, so the frame renders its extracted-site notice — the one row in the whole renderer
 * that carries untrusted text OUTSIDE the gutter (clipped twice instead, see `framing.ts`). A
 * fixture with no composition token would never exercise that row, leaving the shape the surface
 * most needs to get right untested here. It is also what makes the command match what the rater
 * says about it below.
 */
export const STOP_COMMAND =
  `echo stop-command-marker | cat${CR}${FORGED_MENU}${CLEAR_SCREEN}${CURSOR_UP}` +
  `${LF}${FORGED_VERDICT}${LF}echo stop-command-tail`;

/**
 * The rater's own words. Model-authored prose on the last screen between a person and the action,
 * and the string it is easiest to protect the command and then forget.
 */
export const STOP_REASON =
  `Fetches a remote script and pipes it straight into a shell.${CR}stop-reason-marker` +
  `${CLEAR_SCREEN}${CURSOR_UP}${LF}${FORGED_VERDICT}${LF}${FORGED_MENU}`;

/**
 * The justification the agent attaches when it re-proposes a rejected command. It reaches a person
 * only through the §5 negotiation transcript inside the §6.2 message — the field the node names as
 * the one most likely to be forgotten.
 */
export const STOP_JUSTIFICATION = `stop-justification-marker${LF}${FORGED_VERDICT}`;
