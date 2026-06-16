import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

/**
 * One-line status: a spinner + interrupt hint while a turn is running, otherwise a dim
 * idle line. Streaming progress itself is shown by the live turn, not here.
 */
export function StatusBar({
  running,
  mode,
}: {
  running: boolean;
  mode: string;
}): React.ReactElement {
  return (
    <Box>
      {running ? (
        <Text color="yellow">
          <Spinner type="dots" /> Thinking… (Esc to interrupt)
        </Text>
      ) : (
        <Text dimColor>{mode} — ready</Text>
      )}
    </Box>
  );
}
