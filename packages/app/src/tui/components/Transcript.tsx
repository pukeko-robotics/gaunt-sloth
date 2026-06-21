import React from 'react';
import { Box, Static, Text } from 'ink';
import type { TranscriptItem } from '#src/tui/types.js';
import { LiveTurn } from '#src/tui/components/LiveTurn.js';
import { Rule } from '#src/tui/components/Rule.js';

/**
 * Committed scrollback. Ink's `<Static>` writes each item exactly once, above the live
 * region, so finished turns are never re-rendered (no flicker, native terminal scrollback).
 *
 * A dim separator rule is drawn before every `user` line except the first, so each
 * user/assistant exchange is visually delimited. Separators are a pure render concern here —
 * the view-model event contract is untouched.
 */
export function Transcript({
  items,
  toolsExpanded = false,
}: {
  items: TranscriptItem[];
  /** Whether committed tool-call panels show their args/result body (App-level Ctrl+T). */
  toolsExpanded?: boolean;
}): React.ReactElement {
  // Index of the first 'user' item; we suppress the separator above it so the transcript
  // does not open with a stray rule.
  const firstUserIndex = items.findIndex((i) => i.kind === 'user');

  return (
    <Static items={items.map((item, index) => ({ item, index }))}>
      {({ item, index }) => {
        const separator = item.kind === 'user' && index !== firstUserIndex;
        return (
          <Box key={item.id} flexDirection="column">
            {separator ? <Rule /> : null}
            {renderItem(item, toolsExpanded)}
          </Box>
        );
      }}
    </Static>
  );
}

function renderItem(item: TranscriptItem, toolsExpanded: boolean): React.ReactElement {
  switch (item.kind) {
    case 'user':
      return (
        <Box>
          <Text color="green">{'You › '}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      // Committed turns are complete, so they render markdown (streaming=false default).
      return (
        <Box flexDirection="column">
          <LiveTurn turn={item.turn} toolsExpanded={toolsExpanded} />
        </Box>
      );
    case 'system':
      return (
        <Box>
          <Text dimColor>
            [{item.level}] {item.text}
          </Text>
        </Box>
      );
  }
}
