import React from 'react';
import { Box, Text } from 'ink';
import { FramedLines } from '#src/tui/components/FramedLines.js';
import type { ApprovalStopPart } from '@gaunt-sloth/core/core/shell/approvalStop.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
} from '@gaunt-sloth/core/core/shell/framing.js';

/**
 * [[TUI-C71]] — **a run-ending approvals stop, in the transcript.**
 *
 * The message this replaces was pushed as an ordinary `system` item and painted as one dim
 * `<Text>`, which is the one shape untrusted text must never be given: Ink re-wraps a long run,
 * and a re-wrapped row starts at column 0 — where this surface's own chrome lives. It is the same
 * defect the approval dialog and the §6.1 banner were hardened against by [[TUI-C26]], reached
 * through the path that carries the *most* hostile text of the three: an `attack` verdict means
 * the rater judged the command's own structure to evidence compromise.
 *
 * The stop is neutralised at construction (`core/shell/approvalStop`), so nothing here can move a
 * cursor whatever this component does. What this adds is the other half — the gutter and the width
 * bound — and it adds it through the SAME renderer the dialog and the banner paint with, so the
 * three cannot come to disagree about how much of a command a human was shown.
 *
 * `columns` is a prop rather than a `useStdout()` read because the windowing estimator
 * (`transcriptWindow.estimateItemRows`) has to count these rows from the same width the component
 * frames at. A component that resolved its own width could be framing at one number while the
 * estimator counted at another, and an estimator that over-counts leaves a blank band above the
 * conversation with nothing to report it.
 */
export function ApprovalStopMessage({
  parts,
  columns,
}: {
  parts: readonly ApprovalStopPart[];
  /** The terminal width, as the viewport knows it. */
  columns: number;
}): React.ReactElement {
  const width = frameWidthFor(columns);
  const tooNarrow = narrowTerminalNotice(columns);
  return (
    <Box flexDirection="column">
      {tooNarrow ? <Text color="yellow">{tooNarrow}</Text> : null}
      {parts.map((part, index) => {
        // The gate's own sentences: nothing can forge them, so they are painted as they are and
        // Ink may wrap them. Red, because a stop is an ending rather than a notice — and the two
        // are told apart without colour by the sentences themselves, which say so.
        if (part.kind === 'own') {
          return (
            <Text key={`stop-own-${index}`} color="red">
              {part.text}
            </Text>
          );
        }
        return (
          <React.Fragment key={`stop-part-${index}`}>
            {/* The label stays on the gate's own row. Sharing a row with untrusted text would
                make it a row the reader cannot attribute. A `block` has no label: its first row
                is the negotiation renderer's own heading. */}
            {part.kind === 'block' ? null : <Text dimColor>{`  ${part.label}:`}</Text>}
            <FramedLines
              framed={
                part.kind === 'command'
                  ? frameUntrustedCommand(part.text, { width })
                  : frameUntrustedText(part.text, { width })
              }
              colour="red"
              notices={part.kind === 'command'}
            />
          </React.Fragment>
        );
      })}
    </Box>
  );
}
