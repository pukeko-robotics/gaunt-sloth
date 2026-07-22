import React from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '@gaunt-sloth/agent/modules/slashCommands.js';

/**
 * TUI-C10 — the slash-command discovery menu. A read-only, presentational list of the commands
 * that match what the user has typed so far (`/`, `/mo`, …), rendered just above the prompt line so
 * a beginner can *discover* commands instead of having to already know their names (DL-9).
 *
 * It deliberately owns **no** keyboard state: unlike {@link SelectList} (a self-contained blocking
 * dialog), this menu coexists with the live `<TextInput>` — the user keeps typing to filter — so
 * `<PromptInput>` owns the arrow/Tab/Enter/Esc handling and just tells this component which row is
 * highlighted. That keeps the selection logic in one place and this render trivially testable.
 *
 * Colour follows the shared palette (DL-8): the highlighted `/name` is **cyan** (the informational
 * accent, matching SelectList's cursor) and every description is **dim** (secondary/contextual
 * text). Names are padded to a common width so the descriptions line up into a readable column.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
}): React.ReactElement | null {
  if (commands.length === 0) return null;
  // Width of the widest "/name" so the description column aligns (the leading "/" is included).
  const nameWidth = commands.reduce((w, c) => Math.max(w, c.name.length + 1), 0);
  return (
    <Box flexDirection="column">
      {commands.map((command, index) => {
        const selected = index === selectedIndex;
        const label = `/${command.name}`.padEnd(nameWidth);
        return (
          <Box key={command.name}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {selected ? '❯ ' : '  '}
              {label}
            </Text>
            <Text dimColor>
              {'  '}
              {command.description}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
