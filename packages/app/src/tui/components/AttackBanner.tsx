import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { FramedLines } from '#src/tui/components/FramedLines.js';
import {
  attackBannerCopy,
  RATER_REASON_LABEL,
} from '@gaunt-sloth/core/core/shell/escalationSeverity.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
} from '@gaunt-sloth/core/core/shell/framing.js';
import type { PendingAttackHalt } from '@gaunt-sloth/core/core/types.js';

/**
 * [[TUI-C68]] §6.1 — **the attack banner**: the way a human gets past an `attack` verdict.
 *
 * An `attack` outcome means the command's own *structure* evidenced compromise (§4.1.1 — credential
 * targeting, privilege escalation, persistence, deception, obfuscation), and it ends the run. This
 * is the one way through, and without it recovery costs a restart, which §12 forbids.
 *
 * **It is not an approval prompt and must not look like one.** That is the design rather than a
 * styling preference: the approval dialog is a routine question with a menu of legitimate answers,
 * and a banner that borrows its shape invites the answer that shape has trained. So this is red, it
 * has no menu, no scope and no key — one typed phrase runs one command.
 *
 * **The safe action stays the FALLTHROUGH, and the buffer is what threatens it.** An approval
 * prompt grants only on an offered key and treats every other keystroke as a rejection; a text
 * buffer inverts that by accumulating keystrokes instead of rejecting them. It is put back by the
 * matcher rather than by the buffer: `grantsRunAnyway` accepts exactly one value, so the buffer may
 * hold anything at all and only that one value runs the command — a bare Enter, a near miss, a
 * prefix and a cat on the keyboard all stop the run. The keys are `<App>`'s (see its `useInput`),
 * as the approval dialog's are.
 *
 * Everything model-authored on it — the command and the rater's reason — is painted through
 * `core/shell/framing`, never raw. This banner is the last thing between the user and the action,
 * so a banner whose chrome could be forged by the string it is warning about is worse than none.
 */
export function AttackBanner({
  halt,
  typed,
}: {
  halt: PendingAttackHalt;
  /** What the human has typed so far. Echoed so they can see the phrase they are committing to. */
  typed: string;
}): React.ReactElement {
  const copy = attackBannerCopy();
  // Framed to the terminal ITSELF, one gutter per physical row, so Ink never re-wraps a row: a
  // terminal's own wrap starts the continuation at column 0, which is the flush-left forgery the
  // gutter exists to prevent. Core resolves the width for both surfaces so they cannot disagree
  // about how much of a command a human was shown.
  const { stdout } = useStdout();
  const width = frameWidthFor(stdout?.columns);
  const tooNarrow = narrowTerminalNotice(stdout?.columns);
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color="red">
        {copy.title}
      </Text>
      {tooNarrow ? <Text color="yellow">{tooNarrow}</Text> : null}
      <FramedLines framed={frameUntrustedCommand(halt.command, { width })} colour="red" notices />
      {/* The heading is the gate's own sentence — what `attack` MEANS — so the verdict survives a
          monochrome terminal, where the red carries nothing. The label under it keeps the
          attribution honest: the prose below is the rater's, not the gate's. */}
      <Text color="red">{copy.heading}</Text>
      <Text dimColor>{RATER_REASON_LABEL}</Text>
      <FramedLines framed={frameUntrustedText(halt.reason, { width })} colour="red" />
      {/* UNCONDITIONAL, on every attack banner regardless of what the rating said. */}
      <Text bold color="red">
        {copy.irreversible}
      </Text>
      {copy.controls.map((line, index) => (
        <Text key={`attack-control-${index}`} dimColor>
          {line}
        </Text>
      ))}
      {/* This surface's OWN keyboard, composed here rather than added to the shared copy: the
          readline session reads a line in cooked mode and has no `q` or `Esc` to bind, so a shared
          line naming them would be false there (the GS2-87 split). All three abort with text
          already typed — nobody who starts typing and thinks better of it is trapped. */}
      <Text dimColor>{ABORT_KEYS_HINT}</Text>
      {/* The echo. Without it the human cannot see the phrase they are about to commit, and the one
          control on this banner would be answered blind. */}
      <Text color="red">{`${copy.prompt}${typed}`}</Text>
    </Box>
  );
}

/**
 * §6.1 — the abort keys, and they are the Ink TUI's alone.
 *
 * `q` costs nothing to bind because the phrase contains no `q`. `Esc` is this banner's own here
 * (the App's other `Esc` meanings sit after the banner's early return). **Ctrl+C is deliberately
 * left alone**: ending the program is the terminal's own contract, and a program that swallows the
 * one byte every user knows is not one they can trust to let go — so Ink claims it before any
 * `useInput` subscriber and unmounts.
 *
 * All three stop the command, and **they do not cost the same** — which is why the line names the
 * difference instead of listing them together. `q` and `Esc` hand the session back; Ctrl+C ends it,
 * costing exactly the restart §12 forbids and this banner exists to remove. Grouped as equivalents
 * they read as three spellings of one key, so a reader who is alarmed — the reader this screen is
 * written for — pays the expensive one for the cheap one's outcome, having been told they were the
 * same.
 *
 * Exported so the unit spec can check that this line reaches the rendered banner at all without
 * transcribing it. That is PLUMBING and nothing more: an assertion made against the very constant
 * that painted the line passes for any value of it, the empty one included. Whether the wording is
 * right — and whether it still names the two different costs — is owned by the PTY suite's own
 * literals, which is why that suite spells them out instead of importing this.
 */
export const ABORT_KEYS_HINT =
  'To stop, even mid-phrase: q or Esc return to the session, Ctrl+C exits gth.';
