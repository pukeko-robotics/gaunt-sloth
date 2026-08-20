import React from 'react';
import { Box } from 'ink';

/**
 * TUI-C90 — one empty row of vertical separation between two blocks.
 *
 * **It is a sized `<Box>`, never an empty `<Text>`.** A `<Text>` with no content measures
 * zero-high in Yoga and the row simply vanishes, so an empty string is not a blank line on this
 * surface — the same fact `transcriptWindow.ts` states from the counting side ("a sibling `<Text>`
 * holding the empty string collapses to nothing in a column, so an empty body line counts 0"), and
 * the same trap TUI-C36 hit padding the launch banner. A `<Text>` holding a space would hold the
 * row open but leave trailing whitespace on the line; a one-line-high box needs no content to
 * occupy its row and emits none.
 *
 * Every use of this is a row the terminal really draws, which means `transcriptWindow.ts` has to
 * charge for it: that module's estimates are a deliberate lower bound whose failure direction is a
 * blank band above the conversation, so painting rows it does not count degrades the bound by
 * exactly the number of blocks on screen.
 */
export function BlankRow(): React.ReactElement {
  return <Box height={1} />;
}
