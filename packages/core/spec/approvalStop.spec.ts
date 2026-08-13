import { describe, expect, it } from 'vitest';
import {
  approvalStopRows,
  AttackHaltError,
  NonInteractiveEscalationError,
  type ApprovalStopPart,
} from '#src/core/shell/approvalStop.js';
import { renderNegotiationTranscript } from '#src/core/shell/negotiation.js';
import { frameWidthFor } from '#src/core/shell/framing.js';
import { maxDisplayWidth } from '#src/utils/displayWidth.js';

/**
 * [[TUI-C71]] — **the run-ending approvals stops carry the most hostile text in the system, and
 * they used to interpolate it straight into a plain line.**
 *
 * An `attack` verdict means the rater judged the command's own *structure* to evidence compromise,
 * so the command on a halt is the string most likely to have been crafted to forge terminal
 * output — and it was the one string reaching the screen without the defence [[TUI-C26]] built for
 * exactly that. §6.2's escalation is worse again: five untrusted fields, and its message is the
 * only thing anyone sees on that path.
 *
 * The two halves of the fix are asserted separately here because they hold at different times:
 * neutralisation is a property of the MESSAGE (construction, every consumer), the gutter and the
 * width bound are a property of the ROWS (render, the surfaces that have a width). The PTY suite
 * (`packages/app/tui-e2e/approval-stop.tui.test.ts`) is what proves the composition of the two on a
 * real terminal; nothing here can see a screen.
 *
 * **Every invisible character is built from an explicit code point and never typed**, following
 * `tui-e2e/fixtures/framingCommands.mjs`: a rule about invisible characters must not depend on one
 * surviving an editor, a diff or a merge.
 */

const CR = String.fromCodePoint(0x0d);
const ESC = String.fromCodePoint(0x1b);
const LF = '\n';
/** Cursor-up: on a raw render it walks back over the chrome above and overwrites it. */
const CURSOR_UP = `${ESC}[A`;
/** Screen-clear: on a raw render the whole block above it disappears. */
const CLEAR_SCREEN = `${ESC}[2J`;

/** A line that reads like this gate's own menu. Newlines alone are enough to lay it down. */
const FORGED_MENU = 'Approve?  [o]nce   [s]ession   [a]lways   [N]o';
/** A line that reads like a verdict — the lie that matters most on a screen telling you to stop. */
const FORGED_VERDICT = '⚠ Auto-rater (safe): approved by rater';

/**
 * The command as the node describes it: a carriage return, a cursor-up, a screen-clear and a line
 * reading like a verdict, around markers that let an assertion find where each landed.
 */
const HOSTILE_COMMAND =
  `echo stop-command-start${CR}${FORGED_MENU}${CLEAR_SCREEN}${CURSOR_UP}` +
  `${LF}${FORGED_VERDICT}${LF}echo stop-command-end`;

const HOSTILE_REASON =
  `Fetches a remote script and pipes it into a shell.${CR}stop-reason-marker` +
  `${CLEAR_SCREEN}${CURSOR_UP}${LF}${FORGED_VERDICT}${LF}${FORGED_MENU}`;

const HOSTILE_OUTCOME = `catastrophic${CR}stop-outcome-marker${LF}${FORGED_MENU}`;

const HOSTILE_ESCALATED_BY =
  `{"type":"shell","matcher":"regex","pattern":"stop-escalate-marker"}` +
  `${CLEAR_SCREEN}${LF}${FORGED_MENU}`;

/**
 * The §5 transcript, built by its REAL producer rather than hand-written. That is the field the
 * node names as the one most likely to be forgotten, and a hand-written stand-in would prove
 * nothing about what `renderNegotiationTranscript` actually hands over.
 */
const HOSTILE_NEGOTIATION = renderNegotiationTranscript([
  {
    command: `git reset --hard${CR}${FORGED_MENU}`,
    justification: `stop-justification-marker${LF}${FORGED_VERDICT}`,
    outcome: 'reject',
    reason: `Discards uncommitted work.${CURSOR_UP}stop-round-reason-marker${LF}${FORGED_MENU}`,
  },
]) as string;

/** Every marker a hostile field carries, so an assertion can find where each one landed. */
const MARKERS = [
  'stop-command-start',
  'stop-command-end',
  'stop-reason-marker',
  'stop-outcome-marker',
  'stop-escalate-marker',
  'stop-justification-marker',
  'stop-round-reason-marker',
  FORGED_MENU,
  FORGED_VERDICT,
];

/** Control, format and separator characters — the whole class the neutraliser covers. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The row shapes untrusted text is allowed to arrive on: a numbered body row, a wrap continuation,
 * an elision row, and the extracted-site notice.
 *
 * **The gutter, not merely a leading space.** A stop that was neutralised and indented under its
 * own `  Command:` label satisfies a leading-space check while never having been framed at all —
 * so that weaker form would stay green through the exact regression this suite exists to catch.
 * (The site-notice row is `framing.ts`'s one deliberate exception: untrusted text outside the
 * gutter, bounded by two clips instead. It is admitted here for that reason, not to make room.)
 */
const GUTTERED = /^ +(?:\d+ │|┊|⋯|line \d+ ·) /u;

const escalation = (): NonInteractiveEscalationError =>
  new NonInteractiveEscalationError(
    HOSTILE_COMMAND,
    HOSTILE_OUTCOME,
    HOSTILE_REASON,
    HOSTILE_ESCALATED_BY,
    HOSTILE_NEGOTIATION
  );

/** The gate's own sentences in a stop — the rows a surface may paint as they are. */
const ownTexts = (parts: readonly ApprovalStopPart[]): string[] =>
  parts.filter((part) => part.kind === 'own').map((part) => part.text);

describe('[[TUI-C71]] the stop MESSAGE is neutralised at construction', () => {
  /**
   * The property, stated over the whole class rather than over the escapes we happen to expect: a
   * message that still holds one control character can still move a cursor. Split on the newlines
   * the message OWNS — those are this module's own line structure, and they are the one thing a
   * surface is allowed to break rows on.
   */
  it('leaves no control, format or separator character anywhere in an attack halt', () => {
    const error = new AttackHaltError(HOSTILE_COMMAND, HOSTILE_REASON);
    for (const line of error.message.split('\n')) {
      expect(line, `a raw unprintable survived in: ${JSON.stringify(line)}`).not.toMatch(
        UNPRINTABLE
      );
    }
  });

  it('leaves none in a §6.2 escalation carrying ALL FIVE untrusted fields', () => {
    const error = escalation();
    // The five are really there — an assertion about a field that was never populated is one that
    // cannot fail, and the transcript is the one the node names as easiest to forget.
    expect(error.message).toContain('stop-command-start');
    expect(error.message).toContain('stop-outcome-marker');
    expect(error.message).toContain('stop-reason-marker');
    expect(error.message).toContain('stop-escalate-marker');
    expect(error.message).toContain('stop-justification-marker');
    expect(error.message).toContain('stop-round-reason-marker');
    for (const line of error.message.split('\n')) {
      expect(line, `a raw unprintable survived in: ${JSON.stringify(line)}`).not.toMatch(
        UNPRINTABLE
      );
    }
  });

  /**
   * Neutralised, never sanitised: what was in the string is still in it, as printable escapes, so
   * the reader can see that a carriage return was there at all.
   */
  it('shows the escapes rather than dropping what they hid', () => {
    const error = new AttackHaltError(HOSTILE_COMMAND, HOSTILE_REASON);
    expect(error.message).toContain('\\x0d');
    expect(error.message).toContain('\\x1b[2J');
    expect(error.message).toContain('\\x1b[A');
    expect(error.message).toContain('stop-command-end');
  });

  /**
   * **LF is a control character too**, which is what makes this the half that needs no width: an
   * untrusted value cannot open a line, so it cannot put a forged menu at the start of one. Only
   * the gate's own parts contribute a line break.
   */
  it('lets no untrusted value start a line of its own', () => {
    const error = escalation();
    for (const line of error.message.split('\n')) {
      expect(line.startsWith(FORGED_MENU)).toBe(false);
      expect(line.startsWith(FORGED_VERDICT)).toBe(false);
    }
  });

  /**
   * The §5 transcript's line structure is the NEGOTIATION RENDERER's, not the model's, and it is
   * what makes the block readable at all — so it survives where a value's would be escaped. Its
   * content still cannot introduce one, which the line-by-line check above already pinned.
   */
  it('keeps the negotiation transcript on more than one line', () => {
    const error = escalation();
    const rounds = error.message.split('\n').filter((line) => line.includes('Round 1'));
    expect(rounds).toHaveLength(1);
    expect(error.message.split('\n').some((line) => line.includes('rater answered'))).toBe(true);
  });

  /**
   * **The block arm neutralises too, and this is what makes that falsifiable.**
   *
   * Every other case feeds the negotiation built by `renderNegotiationTranscript`, whose leaves have
   * already been through `neutralizeToOneLine` — so the block arm receives text that is *already*
   * clean and removing its neutralisation changes nothing anywhere in the suite. A guard no test can
   * fail is one an optimising reader deletes, and this constructor is **public**: nothing stops a
   * caller (a future surface, a different negotiation renderer, a test) handing it a raw multi-line
   * string. So the string here is hand-built and hostile, and it is what pins the arm.
   *
   * The two halves are asserted separately because they are different promises: the renderer-owned
   * `\n` between rows SURVIVES, and everything the model could have put on those rows does not.
   */
  it('neutralises a raw multi-line negotiation handed straight to the constructor', () => {
    const raw =
      `The agent argued with the auto-rater 2 times before this:\n` +
      `  Round 1: echo one${CR}${FORGED_MENU}\n` +
      `    rater answered: destructive — ${CLEAR_SCREEN}${CURSOR_UP}raw-block-marker`;
    const error = new NonInteractiveEscalationError(
      'npm test',
      undefined,
      undefined,
      undefined,
      raw
    );

    // The renderer's own line structure is intact: three rows in, three rows out.
    const rows = error.message
      .split('\n')
      .filter(
        (line) =>
          line.includes('argued with the auto-rater') ||
          line.includes('Round 1') ||
          line.includes('rater answered')
      );
    expect(rows).toHaveLength(3);
    // ...and nothing on any of them can still move a cursor.
    for (const line of error.message.split('\n')) {
      expect(line, `a raw unprintable survived in: ${JSON.stringify(line)}`).not.toMatch(
        UNPRINTABLE
      );
    }
    expect(error.message).toContain('\\x0d');
    expect(error.message).toContain('\\x1b[2J');
    expect(error.message).toContain('raw-block-marker');
  });

  /**
   * **The composition production can actually emit, which nothing else here covers.**
   *
   * `GthAgentRunner` skips the rating call entirely on an `approvals.escalate` match, so
   * `escalatedBy` mechanically excludes `outcome` and `reason` — the all-five shape asserted above
   * is a property of the class, not something the runner emits. What the runner CAN emit is this:
   * a `destructive` rejection at `auto` leaves rounds on the negotiation transcript, and a later
   * call matching an escalate entry then throws with the command, the entry and those rounds, and
   * no rating at all. It also selects the other recovery tail, which no other case exercises.
   */
  it('neutralises the reachable shape: command, escalate entry and transcript, no rating', () => {
    const error = new NonInteractiveEscalationError(
      HOSTILE_COMMAND,
      undefined,
      undefined,
      HOSTILE_ESCALATED_BY,
      HOSTILE_NEGOTIATION
    );
    expect(error.outcome).toBeUndefined();
    expect(error.reason).toBeUndefined();
    expect(error.message).toContain('stop-command-start');
    expect(error.message).toContain('stop-escalate-marker');
    expect(error.message).toContain('stop-round-reason-marker');
    // Neither label of the rating it never had.
    expect(error.message).not.toContain('  Rating:');
    expect(error.message).not.toContain('  Reason:');
    // The escalate-entry recovery, not the allow-list one: pointing someone at approvals.allow when
    // they wrote the escalate entry themselves sends them to a list that cannot win.
    expect(error.message).toContain('An escalate entry always asks a human');
    expect(error.message).not.toContain('Declare the commands this run is allowed to execute');
    for (const line of error.message.split('\n')) {
      expect(line, `a raw unprintable survived in: ${JSON.stringify(line)}`).not.toMatch(
        UNPRINTABLE
      );
    }
  });

  /**
   * **The error stays a faithful record.** Only the presentation is neutralised; a consumer that
   * needs to know what was actually proposed — the approvals archive, a test, an audit — reads the
   * fields, and they are byte-for-byte what the agent wrote.
   */
  it('keeps the structured fields RAW', () => {
    const error = escalation();
    expect(error.command).toBe(HOSTILE_COMMAND);
    expect(error.reason).toBe(HOSTILE_REASON);
    expect(error.outcome).toBe(HOSTILE_OUTCOME);
    expect(error.escalatedBy).toBe(HOSTILE_ESCALATED_BY);
    expect(error.negotiation).toBe(HOSTILE_NEGOTIATION);
    expect(new AttackHaltError(HOSTILE_COMMAND, HOSTILE_REASON).command).toBe(HOSTILE_COMMAND);
  });

  /** The wording every surface has always shown is unchanged for an ordinary, inert stop. */
  it('composes the same message it always did when nothing needs neutralising', () => {
    expect(new AttackHaltError('npm test', 'no reason to worry').message).toBe(
      'Run halted: the auto-rater rated this command as an attack, which ends the run.\n' +
        '  Command: npm test\n' +
        '  Reason: no reason to worry\n' +
        'This is not negotiable. If this command is legitimate and you need it to run, declare ' +
        'it in approvals.allow — that list is consulted before the auto-rater, so it never ' +
        'reaches a halt. Dropping to approvals "bypass" also works, but it turns off the rater, ' +
        'the prompts and the halt for every command in the run.'
    );
    expect(new NonInteractiveEscalationError('npm test', 'destructive', 'it deletes').message).toBe(
      'Approval required, but this session has no one to ask.\n' +
        '  Command: npm test\n' +
        '  Rating: destructive\n' +
        '  Reason: it deletes\n' +
        'Declare the commands this run is allowed to execute in approvals.allow — write each ' +
        'one as an explicit entry, for example { "type": "shell", "matcher": "exact", ' +
        '"pattern": "npm test" }. That list is consulted before the auto-rater and never ' +
        'escalates.'
    );
  });
});

describe('[[TUI-C71]] the stop ROWS are framed at render', () => {
  const COLUMNS = 100;
  const width = frameWidthFor(COLUMNS);

  /**
   * **The column-0 guarantee, which is the half neutralisation cannot buy.** A neutralised value is
   * one long line, and a terminal wraps a long line back to column 0 with whatever bytes the
   * attacker chose to put at that offset. Every row carrying untrusted text is inside the gutter,
   * so none of them begins at the left edge where this surface's own chrome lives.
   */
  it('never puts untrusted text at column 0', () => {
    const rows = approvalStopRows(escalation().parts, { columns: COLUMNS });
    const own = ownTexts(escalation().parts);
    for (const row of rows) {
      if (own.includes(row)) continue;
      for (const marker of MARKERS) {
        if (!row.includes(marker)) continue;
        expect(row, `untrusted text is not inside the gutter: ${JSON.stringify(row)}`).toMatch(
          GUTTERED
        );
      }
    }
  });

  /** ...and specifically, nothing that could be mistaken for the gate's own chrome. */
  it('lets no row be mistaken for the gate’s own chrome', () => {
    for (const parts of [
      escalation().parts,
      new AttackHaltError(HOSTILE_COMMAND, HOSTILE_REASON).parts,
    ]) {
      for (const row of approvalStopRows(parts, { columns: COLUMNS })) {
        expect(row.trimEnd()).not.toMatch(/^Approve\?/u);
        expect(row.trimEnd()).not.toMatch(/^⚠ Auto-rater/u);
      }
    }
  });

  /**
   * Every untrusted row fits the terminal, measured with the same conservative ruler the framing
   * module budgets with — a row measured as fitting that does not fit is a row the terminal wraps
   * back to column 0, which is the whole failure this prevents. The gate's OWN sentences are
   * exempt and deliberately so: nothing can forge them, so they may wrap like ordinary prose.
   */
  it('bounds every untrusted row to the terminal width', () => {
    const parts = escalation().parts;
    const own = ownTexts(parts);
    for (const row of approvalStopRows(parts, { columns: COLUMNS })) {
      if (own.includes(row)) continue;
      expect(
        maxDisplayWidth(row),
        `row overruns the frame: ${JSON.stringify(row)}`
      ).toBeLessThanOrEqual(width);
    }
  });

  /** The rows carry everything the message does — framing hides nothing a person needs. */
  it('carries all five untrusted fields into the rows', () => {
    const rendered = approvalStopRows(escalation().parts, { columns: COLUMNS }).join('\n');
    expect(rendered).toContain('stop-command-start');
    expect(rendered).toContain('stop-outcome-marker');
    expect(rendered).toContain('stop-reason-marker');
    expect(rendered).toContain('stop-escalate-marker');
    expect(rendered).toContain('stop-round-reason-marker');
  });

  /**
   * A terminal too narrow for the gutter to fit gets the frame anyway — hiding what the reader must
   * rule on would be worse — and it is TOLD, rather than left with a guarantee that quietly stopped
   * holding.
   */
  it('announces a terminal too narrow for the guarantee to hold', () => {
    const narrow = approvalStopRows(escalation().parts, { columns: 12 });
    expect(narrow[0]).toContain('too narrow');
    expect(approvalStopRows(escalation().parts, { columns: 100 })[0]).not.toContain('too narrow');
  });
});
