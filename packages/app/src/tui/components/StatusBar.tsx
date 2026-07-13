import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

/**
 * Session status bar. While a turn is running it shows a spinner + interrupt hint;
 * otherwise it surfaces useful session context — the mode, the model/provider display name,
 * and a turn counter — on a single dim line. Streaming progress itself is shown by the live
 * turn, not here, so this bar stays stable (one line) and does not flicker.
 */
export function StatusBar({
  running,
  mode,
  modelDisplayName,
  turnCount,
  debugHint,
  autoApprove,
}: {
  running: boolean;
  mode: string;
  modelDisplayName?: string;
  turnCount?: number;
  /** When the docked debug panel is open but unfocused, surface how to step into it. */
  debugHint?: boolean;
  /**
   * EXT-12 — when session auto-approve is ON, surface a persistent, unmissable indicator so the
   * user always knows shell commands run without asking. Shown in both the running and idle
   * states (yellow, matching the warn tone of the /auto-approve ON notice).
   */
  autoApprove?: boolean;
}): React.ReactElement {
  // A single, always-visible badge so the user can never lose track of the fact that shell
  // commands are auto-approved (rendered next to the spinner while running, in the status line
  // when idle). Kept terse so it fits the one-line status bar.
  const autoApproveBadge = autoApprove ? (
    <Text color="yellow" bold>
      {' ⚡ auto-approve ON'}
    </Text>
  ) : null;

  if (running) {
    return (
      <Box>
        <Text color="yellow">
          <Spinner type="dots" /> Thinking… (Esc to interrupt)
        </Text>
        {autoApproveBadge}
      </Box>
    );
  }

  const segments = [
    mode,
    modelDisplayName ? `model: ${modelDisplayName}` : null,
    `turns: ${turnCount ?? 0}`,
    'ready',
  ].filter(Boolean);

  return (
    <Box>
      <Text dimColor>{segments.join('  ·  ')}</Text>
      {autoApproveBadge}
      {debugHint ? <Text dimColor>{'  ·  Tab: focus debug panel'}</Text> : null}
    </Box>
  );
}
