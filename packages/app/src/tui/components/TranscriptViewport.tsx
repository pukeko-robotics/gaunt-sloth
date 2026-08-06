import React from 'react';
import { Box, Text } from 'ink';
import type { TranscriptItem } from '#src/tui/types.js';
import { LiveTurn, ReasoningPanel } from '#src/tui/components/LiveTurn.js';
import { Rule } from '#src/tui/components/Rule.js';
import { CommandNotice } from '#src/tui/components/CommandNotice.js';
import { transcriptWindowStart } from '#src/tui/transcriptWindow.js';

/**
 * TUI-C48 — the conversation region of the full-screen dock: a viewport we own, showing the tail
 * of the transcript above the pinned dock.
 *
 * **Only the tail is mounted.** A committed turn is an ordinary component here, not something
 * written once and forgotten, so a several-hundred-turn session would otherwise pay for its whole
 * history on every frame. {@link transcriptWindowStart} cuts the list to the items that can reach
 * the visible region; everything older is unmounted, which is both the DL-10 defence and what
 * makes a committed turn able to re-render at all.
 *
 * **The slice is keyed by `item.id`, and that is load-bearing.** Keyed by index, React would keep
 * one component per slot and merely swap its props as the window advances, so nothing scrolling
 * out would ever unmount — the cost would grow with the number of *distinct* slots rather than
 * staying flat, and the unmount guarantee above would be false while looking true.
 *
 * **Nothing here decides where a row is drawn.** The region pins its content to its bottom edge
 * and clips the overflow off its top, so the newest line is always against the dock no matter how
 * far the estimate in {@link transcriptWindowStart} is from the real height. The inner box is
 * `flexShrink: 0` because a flex child in a height-constrained column is otherwise *squeezed* —
 * which shows up as every other row silently missing rather than as an overflow.
 */
export function TranscriptViewport({
  items,
  budgetRows,
  columns,
  toolsExpanded = false,
  children,
}: {
  items: TranscriptItem[];
  /** Row budget for the slice — the terminal height (see {@link transcriptWindowStart}). */
  budgetRows: number;
  /**
   * The terminal width. It decides how many rows an item wraps to, and it is also what tells a
   * memoised committed item that it has to re-render: the markdown renderer draws fence and
   * horizontal rules at the full terminal width, so an item that skipped the re-render would keep
   * the rules it was first drawn with.
   */
  columns: number;
  /** Whether committed tool-call panels show their args/result body (App-level Ctrl+T). */
  toolsExpanded?: boolean;
  /**
   * The bottom of the conversation region: the streaming turn and the pre-first-exchange intro.
   * They live inside the viewport because they are conversation, not dock chrome, and they sit
   * last so the newest output is the row against the dock.
   */
  children?: React.ReactNode;
}): React.ReactElement {
  // Index of the first 'user' item; the separator above it is suppressed so the transcript does
  // not open with a stray rule.
  const firstUserIndex = items.findIndex((i) => i.kind === 'user');
  const start = transcriptWindowStart(items, budgetRows, columns, toolsExpanded);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      justifyContent="flex-end"
    >
      <Box flexDirection="column" flexShrink={0}>
        {items.slice(start).map((item, offset) => (
          <TranscriptRow
            key={item.id}
            item={item}
            toolsExpanded={toolsExpanded}
            columns={columns}
            separator={item.kind === 'user' && start + offset !== firstUserIndex}
          />
        ))}
        {children}
      </Box>
    </Box>
  );
}

/**
 * One committed item. Memoised on its props so an unrelated frame (a spinner tick, a keystroke)
 * re-renders the dock without re-rendering every item still in the window — the transcript items
 * are the expensive half, and their props only change when the item itself does.
 *
 * `columns` is among the props precisely because of that: width IS an input to how an item renders
 * (the markdown renderer reads it for fence and horizontal rules), so leaving it out would memoise
 * away the reflow and strand a committed turn at its old width.
 */
const TranscriptRow = React.memo(function TranscriptRow({
  item,
  toolsExpanded,
  separator,
}: {
  item: TranscriptItem;
  toolsExpanded: boolean;
  /** Not read here — it is a memo input, see the note above. */
  columns: number;
  separator: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {separator ? <Rule /> : null}
      {renderItem(item, toolsExpanded)}
    </Box>
  );
});

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
    case 'notice':
      // Structured command feedback (TUI-C14): a noticeable title + explanatory body lines.
      return <CommandNotice title={item.title} lines={item.lines} tone={item.tone} />;
    case 'reasoning':
      // TUI-C18 — `/reasoning` reprint: a dim Rule brackets it like a notice, then the shared
      // TUI-C15 ReasoningPanel (expanded, non-live) reuses the 💭/gutter styling, tagged with the
      // turn it was recalled from so the block is self-describing.
      return (
        <Box flexDirection="column">
          <Rule />
          <ReasoningPanel
            reasoning={item.reasoning}
            expanded
            live={false}
            label={`Thinking · turn ${item.turnNumber} (recalled)`}
          />
        </Box>
      );
  }
}
