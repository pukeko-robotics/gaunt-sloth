import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';

/** Tone of a command notice; drives the title colour (info = cyan, warn = yellow). */
export type CommandNoticeTone = 'info' | 'warn';

/**
 * A consistent, noticeable ~3-line feedback block for slash-command output (TUI-C14). Every
 * command renders one so none reads as "does nothing": a coloured + bold title line that states
 * WHAT happened, followed by dim body lines explaining HOW it affects the user. A dim rule
 * brackets the block so it stands apart from the conversation.
 *
 * Single-sourced so committed notices (rendered from a `notice` transcript item) and the
 * live-frame `/clear` banner share the exact same look.
 */
export function CommandNotice({
  title,
  lines,
  tone = 'info',
}: {
  title: string;
  lines: string[];
  tone?: CommandNoticeTone;
}): React.ReactElement {
  const titleColor = tone === 'warn' ? 'yellow' : 'cyan';
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color={titleColor}>
        {title}
      </Text>
      {lines.map((line, i) => (
        <Text key={i} dimColor>
          {line}
        </Text>
      ))}
    </Box>
  );
}
