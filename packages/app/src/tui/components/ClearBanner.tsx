import React from 'react';
import { CommandNotice } from '#src/tui/components/CommandNotice.js';

/**
 * Visible feedback for `/clear`, built on the shared {@link CommandNotice} so it matches every
 * other command's feedback (TUI-C14).
 *
 * It says what the clear actually did, and the second line is the part that changed with the
 * full-screen dock: the transcript is a buffer this app owns rather than the terminal's own
 * scrollback, so clearing it is a deletion. Telling the user to scroll up and revisit the earlier
 * conversation would now be false, and a confirmation of something that did not happen is worse
 * than saying nothing.
 */
export function ClearBanner(): React.ReactElement {
  return (
    <CommandNotice
      title="History cleared"
      lines={[
        'The model no longer sees the prior conversation.',
        'The earlier messages are gone from this session too.',
      ]}
    />
  );
}
