import React from 'react';
import { Box, Text } from 'ink';
import type { TurnViewModel } from '#src/tui/viewModel.js';

/**
 * Renders one assistant turn from the pure {@link TurnViewModel}: a dim reasoning region,
 * one line per tool call, then the assistant text. Used both for the in-progress live turn
 * and (frozen) for committed turns in the transcript, so the look is identical once done.
 */
export function LiveTurn({ turn }: { turn: TurnViewModel }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {turn.reasoning ? <Text dimColor>{turn.reasoning}</Text> : null}
      {turn.toolCalls.map((tc) => (
        <Text key={tc.id} color="magenta">
          {tc.status === 'done' ? '✓' : '⋯'} {tc.name || '(tool)'}
          {tc.argsText ? ` ${tc.argsText}` : ''}
        </Text>
      ))}
      {turn.text ? <Text>{turn.text}</Text> : null}
    </Box>
  );
}
