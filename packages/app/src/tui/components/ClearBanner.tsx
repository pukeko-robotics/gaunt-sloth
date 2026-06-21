import React from 'react';
import { CommandNotice } from '#src/tui/components/CommandNotice.js';

/**
 * Visible feedback for `/clear`. Rendered in the live (non-`<Static>`) frame rather than as a
 * committed transcript line, which sidesteps the known quirk where `setTranscript([])` resets
 * `<Static>`'s internal index and swallows the next pushed item (TUI-C12). Built on the shared
 * {@link CommandNotice} so it matches every other command's feedback (TUI-C14): a title plus the
 * line that the model no longer sees the prior conversation, and a hint that the earlier messages
 * are still reachable by scrolling up in the terminal's scrollback.
 */
export function ClearBanner(): React.ReactElement {
  return (
    <CommandNotice
      title="History cleared"
      lines={[
        'The model no longer sees the prior conversation.',
        'Scroll up to revisit the earlier conversation in your terminal.',
      ]}
    />
  );
}
