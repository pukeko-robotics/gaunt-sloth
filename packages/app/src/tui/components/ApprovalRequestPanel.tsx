import React from 'react';
import { Box, Text } from 'ink';
import {
  approvalRequestRows,
  type ApprovalRowTone,
} from '@gaunt-sloth/core/core/approvals/approvalRequest.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';

/**
 * [[EXT-137]] §6 — how one row of the request block is painted, in Ink's vocabulary.
 *
 * **Colour is the third signal here, never the only one.** Every row's meaning is in its words and
 * reaches a monochrome terminal, `NO_COLOR` and a pipe unchanged; this adds hue for the reader who
 * has it. `danger` is red where `warn` is yellow because a `catastrophic` outcome and a
 * `destructive` one must not be able to look alike — and a change that made them the same colour
 * would still leave the words different, which is the design rather than a happy accident.
 *
 * `quoted` is dim rather than uncoloured: it is untrusted text reproduced verbatim, and the
 * dialog's own rows must not be the ones that recede. `aside` is NOT dim here for the same reason —
 * this surface dims what is quoted rather than what is subordinate, so a sticky preview keeps the
 * weight it had inside its labelled block. Core's tone list carries why the two are separate.
 */
const rowStyle = (tone: ApprovalRowTone): { color?: string; dimColor?: boolean } => {
  switch (tone) {
    case 'danger':
      return { color: 'red' };
    case 'warn':
      return { color: 'yellow' };
    case 'info':
      return { color: 'cyan' };
    case 'chrome':
    case 'quoted':
      return { dimColor: true };
    case 'plain':
    case 'aside':
      return {};
  }
};

/**
 * [[EXT-137]] — **the scrollable half of an approval request, committed into the transcript.**
 *
 * The gate's question has two halves and they live in different places. The half that must be
 * answered without scrolling is `<ApprovalPrompt>`, pinned in the dock, and it carries only text we
 * wrote. Everything the model, a third-party server or a hostile URL contributed — the rating, the
 * negotiation, what a sticky answer would store, the command and the hosts — is this half, and it
 * belongs in the conversation, where a reader can scroll and nothing needs a cap.
 *
 * Rendered from `core/approvals/approvalRequest`'s row list rather than laid out here: the readline
 * surface prints the identical rows and `transcriptWindow.estimateItemRows` counts them, so the
 * three cannot come to disagree about what a human was shown. This component owns only colour.
 *
 * **One `<Text>` per row, never re-wrapped.** The rows arrive already wrapped to the terminal by
 * `core/shell/framing`, one row per physical line, each carrying its gutter — that gutter IS the
 * column-0 guarantee, and letting Ink wrap them a second time would put untrusted bytes back at
 * column 0. `columns` is threaded in for the same reason the estimator takes it: the block is
 * budgeted against the very width it is framed at.
 *
 * It stays in the transcript after the answer, followed by the decision notice `<App>` commits — so
 * the pair reads as a record of what was asked and what was answered.
 */
export function ApprovalRequestPanel({
  pending,
  columns,
}: {
  pending: PendingToolInterrupt;
  columns: number;
}): React.ReactElement {
  const rows = approvalRequestRows(pending, { columns });
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Text key={`approval-row-${index}`} {...rowStyle(row.tone)}>
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
