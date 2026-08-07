import React from 'react';
import { Text } from 'ink';
import { ruleWidth } from '#src/tui/ruleWidth.js';
import { useTerminalSize } from '#src/tui/useTerminalSize.js';

/**
 * A dim, full-width horizontal rule. Single-sourced so the two places that delimit regions
 * stay visually identical: between committed turns in the transcript viewport, and bracketing
 * the input dock at the terminal floor (status bar + prompt + hint) so the controls read as a
 * distinct zone rather than blending into the conversation.
 *
 * The rule spans the live terminal width via {@link useTerminalSize} and re-renders on resize —
 * through the frame's single shared subscription, not one of its own, because a rule is rendered
 * per separator and per notice, which would make the stdout listener count a function of how much
 * conversation is on screen. Callers may pass an explicit `width` (e.g. when they already measure
 * one); otherwise it auto-fills the current terminal.
 */
export function Rule({ width }: { width?: number } = {}): React.ReactElement {
  const { columns } = useTerminalSize();
  const count = ruleWidth(width ?? columns);
  return <Text dimColor>{'─'.repeat(count)}</Text>;
}
