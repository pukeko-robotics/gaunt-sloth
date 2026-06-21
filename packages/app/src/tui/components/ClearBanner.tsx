import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';

/**
 * Visible feedback for `/clear`. Rendered in the live (non-`<Static>`) frame rather than as a
 * committed transcript line, which sidesteps the known quirk where `setTranscript([])` resets
 * `<Static>`'s internal index and swallows the next pushed item (TUI-C12). A short, ~3-line
 * banner: a dim rule, the line that the model no longer sees the prior conversation, and a hint
 * that the earlier messages are still reachable by scrolling up in the terminal's scrollback.
 */
export function ClearBanner(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Rule />
      <Text dimColor>History cleared — the model no longer sees the prior conversation.</Text>
      <Text dimColor>Scroll up to revisit the earlier conversation in your terminal.</Text>
    </Box>
  );
}
