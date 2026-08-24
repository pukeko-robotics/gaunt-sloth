import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {
  APPROVAL_RUNGS,
  resolveShellApprovalGate,
  type ApprovalRung,
  type GthConfig,
  type ResolvedApprovals,
} from '@gaunt-sloth/core/config.js';
import {
  approvalPostureChoices,
  approvalPostureLines,
  approvalsRungNotice,
  approvalsStatusNotice,
} from '@gaunt-sloth/agent/modules/slashCommands.js';
import { StatusBar } from '#src/tui/components/StatusBar.js';

/**
 * [[TUI-C69]] §10 rule 4 — **the resolved rung is rendered in its DISPLAY spelling wherever the
 * mode is displayed**: *Manual*, *Write*, *Assisted*, *Auto*, *Bypass*. The §9.1 identifiers are
 * lower-case single words because the same token has to survive a config file, a slash-command
 * argument and a CLI flag; they are not what a sentence about the live posture puts on the screen.
 *
 * ## Why this sweeps the sites and not the prose
 *
 * The obvious test — *"the rendered output contains no lower-case rung identifier"* — is a MEASURED
 * trap, and it fails in both directions:
 *
 * - `write` occurs inside **"rewrite"**, which appears in a shipped rung description, so the sweep
 *   fails on correct code;
 * - a word-boundary match on `auto` also matches the **"auto-rater"** the product ships, so a sweep
 *   careless enough to allow it passes by accident.
 *
 * So every case below extracts the token that IS the rendered rung and asserts on that alone.
 *
 * ## Why the expected spellings are written out here
 *
 * {@link DISPLAY} restates §10's five words rather than reading `APPROVAL_RUNG_LABELS`. Reading the
 * production map would make each assertion agree with whatever that map currently says — including
 * a map someone had lower-cased, which is exactly the regression this exists to catch.
 *
 * ## The sites
 *
 * Derived from the code rather than from memory: every consumer of the resolved rung that reaches a
 * surface. Two independent sweeps found them — the type-directed one (what reads an `ApprovalRung`
 * or a `ResolvedApprovals` and produces a string) and a literal one (the five identifiers appearing
 * inside a string across `packages/*​/src`). The `/approvals` USAGE lines are deliberately not here:
 * they name the argument a user types, which is the identifier and must stay one.
 */
const DISPLAY: Record<ApprovalRung, string> = {
  manual: 'Manual',
  write: 'Write',
  assisted: 'Assisted',
  auto: 'Auto',
  bypass: 'Bypass',
};

const approvals = (rung: ApprovalRung): ResolvedApprovals =>
  ({ rung, allow: [], deny: [], escalate: [] }) as ResolvedApprovals;

/** The rung token as a site rendered it: whatever follows `approvals: ` / `Approvals: `. */
const rungTokenAfterLabel = (text: string): string | undefined =>
  /(?:^|[\s(])[Aa]pprovals: ([^\s).;]+)/u.exec(text)?.[1];

describe('[[TUI-C69]] §10 rule 4 — the rung is rendered in its display spelling', () => {
  /**
   * The precondition the whole sweep rests on. Without it a bug that made every site render an
   * empty string would satisfy "no lower-case identifier appears" everywhere.
   */
  it('CONTROL: the extractor finds the rung token, and would see a lower-case one', () => {
    expect(rungTokenAfterLabel('  ·  approvals: Assisted')).toBe('Assisted');
    expect(rungTokenAfterLabel('… per-command approval (approvals: write).')).toBe('write');
    expect(rungTokenAfterLabel('nothing to find here')).toBeUndefined();
  });

  /** Site 1 — the Ink status bar, where the mode is on screen for the whole session. */
  it.each(APPROVAL_RUNGS)('the TUI status bar renders %s in the display spelling', (rung) => {
    const { lastFrame, unmount } = render(
      <StatusBar running={false} mode="code" turnCount={0} approvals={{ rung }} />
    );
    const frame = stripAnsi(lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(rungTokenAfterLabel(frame) ?? frame).toContain(DISPLAY[rung]);
    unmount();
  });

  /** Site 2 — the notice `/approvals <rung>` commits after a switch. */
  it.each(APPROVAL_RUNGS)(
    'the /approvals switch notice titles %s in the display spelling',
    (rung) => {
      expect(approvalsRungNotice(approvals(rung)).title).toBe(`Approvals: ${DISPLAY[rung]}`);
    }
  );

  /** Site 3 — the `/approvals` display, on every surface that has a slash-command layer. */
  it.each(APPROVAL_RUNGS)(
    'the /approvals status notice titles %s in the display spelling',
    (rung) => {
      const notice = approvalsStatusNotice(
        approvals(rung),
        { session: 0, project: 0, always: undefined },
        [],
        [],
        { defaults: [], servers: [] }
      );
      expect(notice.title).toBe(`Approvals: ${DISPLAY[rung]}`);
    }
  );

  /**
   * Site 4 — the picker rows (the Ink `<ApprovalsPicker>`) and their text fallback, which is what
   * every `--no-tui`, piped, non-TTY and CI run gets instead.
   *
   * `write` has no row of its own — CFG-39 made it a modifier of Manual rather than a fifth posture
   * — so this walks the postures the picker actually offers.
   */
  it('the /approvals picker labels every posture in the display spelling, in both renderings', () => {
    for (const choice of approvalPostureChoices('assisted')) {
      expect(choice.label).toBe(DISPLAY[choice.rung]);
    }
    const lines = approvalPostureLines('assisted');
    for (const choice of approvalPostureChoices('assisted')) {
      expect(lines.some((line) => line.includes(`${DISPLAY[choice.rung]} —`))).toBe(true);
    }
  });

  /**
   * Site 5 — the startup notice both surfaces print when the shell tool is gated. It is the notice
   * a user meets while working out what their config does, and it stated the mode in the §9.1
   * identifier on all three of its arms.
   */
  it.each(APPROVAL_RUNGS)(
    'the shell-gate startup notice names %s in the display spelling',
    (rung) => {
      const config = {
        approvals: rung,
        commands: { code: { builtInTools: { run_shell_command: { enabled: true } } } },
      } as unknown as GthConfig;
      const message = resolveShellApprovalGate(config, 'code').notice?.message ?? '';
      expect(message).not.toBe('');
      expect(rungTokenAfterLabel(message)).toBe(DISPLAY[rung]);
    }
  );
});
