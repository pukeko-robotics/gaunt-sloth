/**
 * @module core/shell/approvalStop
 *
 * CFG-27 — the two ways the approvals gate **ends a run** rather than answering a tool call.
 * Both are thrown from `GthAgentRunner.decideToolApproval`, both carry the command and the reason
 * a person needs to see, and both are re-thrown UNCHANGED by `processMessages` (which otherwise
 * wraps failures as `Agent processing failed: …`) so the explanation reaches the user intact.
 *
 * They are errors rather than {@link ../types.js ToolApprovalDecision}s on purpose. A decision is
 * something the model observes as a `ToolMessage` and can respond to; these two are precisely the
 * cases where the spec says the model gets no move at all:
 *
 * - **{@link AttackHaltError}** (§4.2) — an `attack` outcome *halts the run*. "A halt ends the
 *   agent loop. It is not a rejection the model can respond to, and no rung except `bypass` can
 *   turn it into anything else."
 * - **{@link NonInteractiveEscalationError}** (§6.2) — where no human can answer, *every*
 *   escalation is an immediate non-zero exit carrying the command, the rating and its reason.
 *   There is no prompt, no waiting, and never a timeout into approval. Teams that need specific
 *   commands to run unattended declare them in `approvals.allow` (§3), which is consulted before
 *   the rater and therefore never escalates.
 *
 * Exit code: neither class sets one. The single-shot runtime (`runSingleShot`) already reports a
 * thrown run as `ok: false`, and each command entry point turns that into `setExitCode(1)` — so
 * "immediate non-zero exit carrying the explanation" is what a caller already gets, without a new
 * exit path that could diverge from the existing one.
 *
 * ## [[TUI-C71]] — a stop message is UNTRUSTED TEXT, and it is made safe in two places
 *
 * Every string a stop carries except this module's own sentences is written by something other
 * than the user: the command the agent proposed, the rater's outcome and reason, the
 * `approvals.escalate` entry that matched, and the whole §5 negotiation. On an `attack` verdict
 * that is the *worst* text in the system by construction — the rater judged the command's own
 * structure to evidence deception or obfuscation — so a stop is the one message most likely to
 * carry a payload crafted to forge terminal output, and the last one that may be printed raw.
 *
 * The defence [[TUI-C26]] built has two halves, and they belong at different times:
 *
 * 1. **Neutralisation is done HERE, at construction, unconditionally.** It needs no width and no
 *    screen, it is idempotent, and it is the half every consumer needs — a thrown stop reaches the
 *    Ink transcript, `--no-tui` stderr, a session log, the approvals archive (`record.error`), an
 *    eval turn record, AG-UI and a CI job's output, and only some of those are terminals. Doing it
 *    at each render site would mean every present and future consumer had to remember; doing it
 *    once here means none of them can forget. After it, `{@link message}` contains no control or
 *    format character at all: a carriage return is the five printable characters `\x0d`, and —
 *    because LF is a control character too — untrusted text cannot even open a new line, let alone
 *    reach column 0 on one.
 * 2. **The gutter and the width bound are done at RENDER, by the surface** ({@link
 *    approvalStopRows} for the plain surfaces, `<ApprovalStopMessage>` for the Ink TUI). They
 *    cannot be done here: framing is arithmetic against a terminal width, an `Error.message` has
 *    no width, and a block wrapped for an 80-column terminal is wrong for every other one. What
 *    they buy over neutralisation alone is the last case it cannot close — one very long
 *    neutralised line that the *terminal* wraps, whose continuation starts at column 0 carrying
 *    whatever the attacker chose to put at that offset. That route is measured, not theorised: on
 *    a 120-column terminal the neutralised `Command:` line of a hostile command is ~164 columns.
 *
 * **Because half of it is the surface's job, the surfaces are enumerated rather than assumed.**
 * Every place a stop is printed to a terminal calls {@link approvalStopRows} (or the Ink
 * component): `runtime/singleShot.ts`, `runtime/conversation.ts`,
 * `agent/modules/interactiveSessionModule.ts`, `review/modules/reviewModule.ts`,
 * `app/commands/prCommand.ts` (which catches what the PR-discovery agent throws) and
 * `app/tui/components/App.tsx`. **Adding a surface that prints a stop means adding it to that
 * list.** The rest of the consumers above take {@link message} and want the string: they are not
 * terminals, and the neutralisation they inherit is the whole of what they need.
 *
 * **The structured fields stay RAW; only the message is neutralised.** That is what answers the
 * obvious objection to construction-time work — that it stops the error being a faithful record of
 * what was proposed. `{@link ApprovalStopError.command}`, `reason`, `outcome`, `escalatedBy` and
 * `negotiation` are the command as the agent wrote it, byte for byte, for any consumer that needs
 * the truth rather than a screen; the message is the *presentation*, and a presentation that can
 * repaint the terminal is not one. The render path frames from those raw fields, so its gutter
 * numbers the command's real lines rather than one escaped line.
 *
 * **One parts list, two renderings** ({@link ApprovalStopPart}). The message string and the framed
 * block are both derived from {@link ApprovalStopError.parts}, so they cannot come to describe one
 * stop two ways — the same argument `renderNegotiationTranscript` makes for its own two surfaces.
 * A part is tagged with *who wrote it*, which is the only distinction any of this rests on: the
 * gate's own prose can be painted as it is because nothing can forge it, and everything else goes
 * through the shared renderer.
 */
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
  neutralizeUntrustedText,
} from '#src/core/shell/framing.js';

/**
 * One piece of a stop message, tagged with who wrote it.
 *
 * - `own` — this module's own sentence. Nothing outside it can influence the text, so a surface
 *   may paint it as it is and let the terminal wrap it.
 * - `command` — the command the agent proposed. Framed with the site extraction, because its
 *   composition boundaries and substitutions are the decision-relevant positions in it.
 * - `value` — one untrusted single value (the rater's outcome or reason, the matched
 *   `approvals.escalate` entry). Framed as prose; there are no sites to point at.
 * - `block` — an untrusted block whose LINE STRUCTURE is a renderer's, not the model's: the §5
 *   negotiation transcript, whose rows `core/shell/negotiation` builds and whose leaves it has
 *   already collapsed to one line each. Its breaks survive into the message where a `value`'s
 *   would be escaped, because they are the thing that makes it readable at all.
 *
 * **A `block` is still neutralised line by line here, and that is deliberate defence in depth.**
 * Its one production producer (`renderNegotiationTranscript`) has already cleaned every leaf, so
 * on today's paths this arm changes nothing — but these constructors are public, and a caller
 * handing one a raw multi-line string must not be the thing that decides whether a cursor can
 * move. `approvalStop.spec.ts` builds exactly that string so the arm is falsifiable rather than
 * merely reassuring.
 *
 * **The §5.4 VOICE distinction is deliberately not carried here**, and the trade is worth stating
 * because `negotiation.ts` documents voice preservation as a rule: `renderNegotiationRows` tags
 * each row `chrome`/`agent`/`rater` so a surface can colour the rater's turns apart from the
 * agent's. A stop renders the transcript as one undifferentiated untrusted block instead. Framing
 * a mixed-trust block wholly as untrusted is the safe direction (nothing in it is promoted to the
 * gate's own voice), the row prefixes still name the speaker in text, and an `Error` carries no
 * colour to any of the non-terminal consumers anyway. Colouring by voice here would mean
 * re-deriving the tags from a string that no longer has them.
 */
export type ApprovalStopPart =
  | { kind: 'own'; text: string }
  | { kind: 'command'; label: string; text: string }
  | { kind: 'value'; label: string; text: string }
  | { kind: 'block'; text: string };

/**
 * The parts as the one string an `Error.message` has to be, with every untrusted part neutralised.
 *
 * A `block` is neutralised **line by line**, so the renderer-owned breaks that carry its meaning
 * survive while its content still cannot introduce one. Everything else is neutralised whole,
 * which — LF being a control character — is what collapses an untrusted value onto the single line
 * its label put it on.
 */
function composeMessage(parts: readonly ApprovalStopPart[]): string {
  return parts.map(messageLineFor).join('\n');
}

function messageLineFor(part: ApprovalStopPart): string {
  switch (part.kind) {
    case 'own':
      return part.text;
    case 'block':
      return part.text.split('\n').map(neutralizeUntrustedText).join('\n');
    default:
      return `  ${part.label}: ${neutralizeUntrustedText(part.text)}`;
  }
}

/**
 * The stop as terminal rows, for a surface that paints lines rather than components.
 *
 * Every row is painted **verbatim, one row per line, and never re-wrapped** — that is the
 * condition `core/shell/framing` states its column-0 guarantee over, and a caller that joins these
 * and hands them to something that wraps has undone the whole point.
 *
 * `columns` is what the surface reports (`stdout.columns`), not a frame width: it is resolved
 * through {@link frameWidthFor} here so the plain surfaces, the Ink TUI and the approval dialog
 * cannot come to disagree about how much of a command a human was shown. When it is below core's
 * floor the frame is wider than the terminal and the guarantee lapses — {@link narrowTerminalNotice}
 * leads the block in that case, so it lapses out loud.
 */
export function approvalStopRows(
  parts: readonly ApprovalStopPart[],
  options?: { columns?: number }
): string[] {
  const width = frameWidthFor(options?.columns);
  const rows: string[] = [];
  const tooNarrow = narrowTerminalNotice(options?.columns);
  if (tooNarrow) rows.push(tooNarrow);
  for (const part of parts) {
    if (part.kind === 'own') {
      rows.push(part.text);
      continue;
    }
    // The label is the gate's OWN word for what follows, and it stays on the gate's own row rather
    // than being prefixed to the first framed row — a label sharing a row with untrusted text is a
    // row a reader cannot tell apart from one the model wrote all of.
    if (part.kind !== 'block') rows.push(`  ${part.label}:`);
    const framed =
      part.kind === 'command'
        ? frameUntrustedCommand(part.text, { width })
        : frameUntrustedText(part.text, { width });
    rows.push(...framed.notices, ...framed.lines);
  }
  return rows;
}

/**
 * Base class for the two run-ending approvals outcomes, so a caller that wants to present them as
 * an ending rather than a crash can catch both with one `instanceof`.
 *
 * A surface that can frame should render {@link parts} (see {@link approvalStopRows}); one that
 * cannot shows {@link message}, which is already neutralised and is already the whole explanation.
 */
export abstract class ApprovalStopError extends Error {
  /** The command that ended the run, exactly as the agent proposed it. */
  readonly command: string;

  /** The message's pieces, tagged with who wrote each — see {@link ApprovalStopPart}. */
  readonly parts: readonly ApprovalStopPart[];

  protected constructor(parts: readonly ApprovalStopPart[], command: string) {
    super(composeMessage(parts));
    this.command = command;
    this.parts = parts;
    // Restore the prototype chain across the ES5 `extends Error` downlevel, so `instanceof` works.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * §4.2 — an `attack` outcome: the command's own **structure** evidenced compromise (§4.1.1 —
 * credential targeting, privilege escalation, persistence, deception, obfuscation). Ends the agent
 * loop; the model is told nothing and offered nothing.
 *
 * **This is what reaches a surface that cannot ask.** An interactive surface is offered [[TUI-C68]]
 * §6.1's red banner first — `GthAgentRunner.setAttackHaltCallback`, where typing `run anyway` runs
 * this one command and everything else stops the run — and this error is thrown when no banner is
 * wired, or when the banner is answered with anything but that phrase. A non-interactive session
 * wires nothing and so gets this message directly (§6.2).
 *
 * The recovery this message names is deliberately the **allow-list**, not `bypass`. §4.2 makes
 * `approvals.allow` the supported way to run such a command unattended (it is consulted before the
 * rater, so it never reaches a halt at all); `bypass` also works and is far blunter — it turns off
 * the rater, the escalation and the halt together, for every command, for the whole run. It is a
 * last resort, not the answer, and the wording says so in that order.
 */
export class AttackHaltError extends ApprovalStopError {
  /** The rater's explanation of what the command's structure showed. */
  readonly reason: string;

  constructor(command: string, reason: string) {
    super(
      [
        {
          kind: 'own',
          text: 'Run halted: the auto-rater rated this command as an attack, which ends the run.',
        },
        { kind: 'command', label: 'Command', text: command },
        { kind: 'value', label: 'Reason', text: reason },
        {
          kind: 'own',
          text:
            `This is not negotiable. If this command is legitimate and you need it to run, declare ` +
            `it in approvals.allow — that list is consulted before the auto-rater, so it never ` +
            `reaches a halt. Dropping to approvals "bypass" also works, but it turns off the rater, ` +
            `the prompts and the halt for every command in the run.`,
        },
      ],
      command
    );
    this.reason = reason;
  }
}

/**
 * §6.2 — an escalation with nobody to ask (CI, one-shot runs, servers). Fails the build loudly,
 * with everything a person needs in order to see why.
 */
export class NonInteractiveEscalationError extends ApprovalStopError {
  /** The rater's outcome, when a rating existed (the unrated rungs have none). */
  readonly outcome: string | undefined;
  /** The rater's explanation, when a rating existed. */
  readonly reason: string | undefined;
  /**
   * EXT-71 §3.2 — the declared `approvals.escalate` entry that sent this call to a human, when one
   * did. It changes the recovery the message names: pointing someone at `approvals.allow` when they
   * themselves wrote an escalate entry sends them to a list that cannot win, since a match on
   * `escalate` outranks a match on `allow`.
   */
  readonly escalatedBy: string | undefined;

  /**
   * [[EXT-29]] §6 — the §5 negotiation that preceded this escalation, rendered, when there was one.
   *
   * §6.2's message is the ONLY thing a person sees on this path — there is no prompt to attach a
   * transcript to — so an unattended run that ended after three rejections would otherwise report
   * the last command and give no hint that the agent had already been told twice what to fix.
   */
  readonly negotiation: string | undefined;

  constructor(
    command: string,
    outcome?: string,
    reason?: string,
    escalatedBy?: string,
    negotiation?: string
  ) {
    const parts: ApprovalStopPart[] = [
      { kind: 'own', text: 'Approval required, but this session has no one to ask.' },
      { kind: 'command', label: 'Command', text: command },
    ];
    if (outcome) parts.push({ kind: 'value', label: 'Rating', text: outcome });
    if (reason) parts.push({ kind: 'value', label: 'Reason', text: reason });
    if (negotiation) parts.push({ kind: 'block', text: negotiation });
    if (escalatedBy) {
      parts.push({ kind: 'value', label: 'Matched approvals.escalate', text: escalatedBy });
      parts.push({
        kind: 'own',
        text:
          `An escalate entry always asks a human, whatever the rung would have done, so no ` +
          `entry in approvals.allow can answer it. Remove the escalate entry if this command ` +
          `should run unattended.`,
      });
    } else {
      parts.push({
        kind: 'own',
        text:
          `Declare the commands this run is allowed to execute in approvals.allow — write each ` +
          `one as an explicit entry, for example { "type": "shell", "matcher": "exact", ` +
          `"pattern": "npm test" }. That list is consulted before the auto-rater and never ` +
          `escalates.`,
      });
    }
    super(parts, command);
    this.outcome = outcome;
    this.reason = reason;
    this.escalatedBy = escalatedBy;
    this.negotiation = negotiation;
  }
}
