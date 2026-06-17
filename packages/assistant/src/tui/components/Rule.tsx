import React from 'react';
import { Text } from 'ink';

/**
 * A dim horizontal rule. Single-sourced so the two places that delimit regions stay
 * visually identical: between committed turns in the {@link Transcript}, and bracketing
 * the input dock at the bottom of the screen (status bar + prompt + hint) so the controls
 * read as a distinct zone rather than blending into the scrollback.
 */
export function Rule(): React.ReactElement {
  return <Text dimColor>{'─'.repeat(40)}</Text>;
}
