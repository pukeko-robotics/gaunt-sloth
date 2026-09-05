import React, { useState } from 'react';
import { Box, Text } from 'ink';
import type { SlashCommand } from '@gaunt-sloth/agent/modules/slashCommands.js';
import { windowWithinRows } from '#src/tui/listWindow.js';

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
 * TUI-C92 — **it is a bounded, scrolling viewport, and every entry is exactly one row.** The menu
 * sits in the dock, which is pinned to the terminal floor and never gives up rows, so a menu as
 * tall as it has matches pushes the prompt — and, through the chord door, the user's half-written
 * message — off the bottom of a short terminal. `maxRows` is the display rows it may occupy,
 * affordance rows included; the caller works that budget out from what else must stay on screen.
 * Inside it the window is sticky around `selectedIndex`, the way `<SelectList>` scrolls (CFG-15):
 * it moves only when the highlight crosses an edge, and the start is remembered across renders so
 * arrowing down does not re-centre the list on every step. Dim `↑ N more` / `↓ N more` rows, in
 * that widget's wording, say what is hidden; with fewer matches than rows none is drawn and nothing
 * differs from an unbounded list. `commands` and `selectedIndex` keep their meaning, so the
 * caller's arrow/Tab/Enter handling is untouched — Enter after scrolling still dispatches the
 * highlighted command.
 *
 * Windowing in entries is windowing in rows only because an entry cannot wrap: the `/name` column
 * is pinned at its natural width and the description is **truncated with `…`** at the width the
 * terminal leaves it (DL-7 — nothing wraps into the chrome). A wrapped menu row is worse to read
 * than a clipped one, and the full text is one `/help` away. The width comes from Ink's own layout
 * rather than from a prop: the row is as wide as the terminal, the label refuses to shrink, and the
 * description takes what is left.
 *
 * Colour follows the shared palette (DL-8): the highlighted `/name` is **cyan** (the informational
 * accent, matching SelectList's cursor) and every description is **dim** (secondary/contextual
 * text). Names are padded to a common width — measured over every match, not only the visible
 * slice, so the column does not shift as the window scrolls — so the descriptions line up.
 */
export function SlashCommandMenu({
  commands,
  selectedIndex,
  maxRows,
}: {
  commands: SlashCommand[];
  selectedIndex: number;
  /** Display rows the menu may occupy, the `↑ / ↓ N more` rows included. At least one. */
  maxRows: number;
}): React.ReactElement | null {
  // The remembered window start, which is what makes the window sticky. Held before the early
  // return: a hook behind a condition changes the hook order on the render the list empties.
  const [windowStart, setWindowStart] = useState(0);
  const count = commands.length;
  const cursor = count === 0 ? 0 : Math.min(Math.max(0, selectedIndex), count - 1);
  // Derived in render from the remembered start and the current highlight, so the window is valid
  // even when the highlight jumps (wraparound) or a narrowing filter leaves the remembered start
  // past the end of the list. Persisted during render rather than from an effect, exactly as
  // `<SelectList>` does: React re-runs the component with the new value before it commits, so
  // nothing is painted between; `windowWithinRows` is idempotent, so the second pass is the last.
  const view = windowWithinRows(windowStart, cursor, maxRows, count);
  if (view.start !== windowStart) setWindowStart(view.start);
  if (count === 0) return null;
  // Width of the widest "/name" so the description column aligns (the leading "/" is included).
  const nameWidth = commands.reduce((w, c) => Math.max(w, c.name.length + 1), 0);
  const visible = commands.slice(view.start, view.start + view.size);
  return (
    <Box flexDirection="column">
      {view.hiddenAbove > 0 ? <Text dimColor>{`  ↑ ${view.hiddenAbove} more`}</Text> : null}
      {visible.map((command, offset) => {
        const selected = view.start + offset === selectedIndex;
        const label = `/${command.name}`.padEnd(nameWidth);
        return (
          <Box key={command.name}>
            {/* Pinned at its natural width: Ink gives every child of a row `Box` `flexShrink: 1`,
                so on a description longer than the row Yoga would shrink — and wrap — the name
                column too. The description is the one thing that gives way. */}
            <Box flexShrink={0}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '❯ ' : '  '}
                {label}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {command.description}
            </Text>
          </Box>
        );
      })}
      {view.hiddenBelow > 0 ? <Text dimColor>{`  ↓ ${view.hiddenBelow} more`}</Text> : null}
    </Box>
  );
}
