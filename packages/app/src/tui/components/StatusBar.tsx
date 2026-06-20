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
}: {
  running: boolean;
  mode: string;
  modelDisplayName?: string;
  turnCount?: number;
  /** When the docked debug panel is open but unfocused, surface how to step into it. */
  debugHint?: boolean;
}): React.ReactElement {
  if (running) {
    return (
      <Box>
        <Text color="yellow">
          <Spinner type="dots" /> Thinking… (Esc to interrupt)
        </Text>
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
      {debugHint ? <Text dimColor>{'  ·  Tab: focus debug panel'}</Text> : null}
    </Box>
  );
}
