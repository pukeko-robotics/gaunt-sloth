import React from 'react';
import { Box, Static, Text } from 'ink';
import type { TranscriptItem } from '#src/tui/types.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';

/**
 * Committed scrollback. Ink's `<Static>` writes each item exactly once, above the live
 * region, so finished turns are never re-rendered (no flicker, native terminal scrollback).
 */
export function Transcript({ items }: { items: TranscriptItem[] }): React.ReactElement {
  return (
    <Static items={items}>
      {(item) => {
        switch (item.kind) {
          case 'user':
            return (
              <Box key={item.id}>
                <Text color="green">{'You › '}</Text>
                <Text>{item.text}</Text>
              </Box>
            );
          case 'assistant':
            return (
              <Box key={item.id} flexDirection="column">
                <LiveTurn turn={item.turn} />
              </Box>
            );
          case 'system':
            return (
              <Box key={item.id}>
                <Text dimColor>
                  [{item.level}] {item.text}
                </Text>
              </Box>
            );
        }
      }}
    </Static>
  );
}
