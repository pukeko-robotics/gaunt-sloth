import React from 'react';
import { Box, Text, type DOMElement } from 'ink';
import type { TranscriptItem } from '#src/tui/types.js';
import { LiveTurn, ReasoningPanel } from '#src/tui/components/LiveTurn.js';
import { Rule } from '#src/tui/components/Rule.js';
import { CommandNotice } from '#src/tui/components/CommandNotice.js';
import { transcriptWindowEnd, transcriptWindowStart } from '#src/tui/transcriptWindow.js';
import type { TranscriptScroll } from '#src/tui/transcriptScroll.js';
import type { TranscriptGeometry } from '#src/tui/useTranscriptScroll.js';

/**
 * TUI-C48 — the conversation region of the full-screen dock: a viewport we own, showing the tail
 * of the transcript above the pinned dock, or an older part of it once the reader scrolls back.
 *
 * **Only a region's worth is mounted.** A committed turn is an ordinary component here, not
 * something written once and forgotten, so a several-hundred-turn session would otherwise pay for
 * its whole history on every frame. {@link transcriptWindowStart} and {@link transcriptWindowEnd}
 * cut the list to the items around the visible region; everything else is unmounted, which is both
 * the DL-10 defence and what makes a committed turn able to re-render at all. The cut is taken
 * around the **scroll anchor**, not around the end of the conversation, so the mounted set stays a
 * function of the region's height however far back the reader has gone.
 *
 * **The slice is keyed by `item.id`, and that is load-bearing.** Keyed by index, React would keep
 * one component per slot and merely swap its props as the window advances, so nothing scrolling
 * out would ever unmount — the cost would grow with the number of *distinct* slots rather than
 * staying flat, and the unmount guarantee above would be false while looking true.
 *
 * **Where the bottom edge sits is a clip, never a calculation.** The region pins its content to its
 * bottom edge and clips the overflow off its top; the last visible block sits in a fixed-height
 * clip that shows its first `visibleRows` rows and hides the rest, along with everything below it.
 * So no height estimate decides where a row is drawn — the estimates only decide how much to mount,
 * and over-mounting merely costs a component the layout throws away.
 *
 * The inner boxes are `flexShrink: 0` because a flex child in a height-constrained column is
 * otherwise *squeezed* — which shows up as every other row silently missing rather than as an
 * overflow.
 */
export function TranscriptViewport({
  items,
  budgetRows,
  columns,
  toolsExpanded = false,
  scroll = null,
  geometry,
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
  /** Where the bottom edge sits, or null while the region follows the newest output. */
  scroll?: TranscriptScroll | null;
  /** Where the region publishes its measured layout for the scroll gestures to read. */
  geometry?: TranscriptGeometry;
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
  // Block numbering: transcript items keep their own index, and the tail block — the intro chrome
  // and the streaming turn — is the one past the end. One numbering for both is what lets the
  // reader scroll into a streaming turn rather than past it in a single jump.
  const tailIndex = items.length;
  const bottomIndex = scroll ? Math.min(scroll.bottomIndex, tailIndex) : tailIndex;
  // The walk covers the budget in rows ABOVE the block the edge cuts through, not including it:
  // the edge may be one row into a forty-row turn, and a walk that counted that turn's whole height
  // would stop with barely a row of conversation above the edge and leave a blank band. Stuck, this
  // is exactly the walk from the newest item.
  const start = transcriptWindowStart(
    items,
    budgetRows,
    columns,
    toolsExpanded,
    Math.min(bottomIndex, tailIndex) - 1
  );
  const end = scroll
    ? transcriptWindowEnd(items, budgetRows, columns, toolsExpanded, bottomIndex)
    : tailIndex - 1;
  // The tail block is mounted when the slice reaches it, and skipped when the reader is further
  // back than that — a streaming turn that nobody is looking at costs nothing to leave out.
  const showTail = !scroll || end >= tailIndex - 1;
  const clipEnd = Math.min(end, tailIndex - 1);

  const viewportRef = React.useRef<DOMElement | null>(null);
  const tailRef = React.useRef<DOMElement | null>(null);
  React.useLayoutEffect(() => {
    geometry?.commit({
      viewport: viewportRef.current,
      tail: showTail ? tailRef.current : null,
      region: { tailIndex, atStart: start === 0, atEnd: showTail },
    });
  });

  const row = (index: number): React.ReactElement => (
    <TranscriptRow
      key={items[index].id}
      index={index}
      item={items[index]}
      toolsExpanded={toolsExpanded}
      columns={columns}
      geometry={geometry}
      separator={items[index].kind === 'user' && index !== firstUserIndex}
    />
  );

  const above: React.ReactElement[] = [];
  for (let index = start; index < Math.min(bottomIndex, tailIndex); index += 1)
    above.push(row(index));
  const below: React.ReactElement[] = [];
  for (let index = bottomIndex; index <= clipEnd; index += 1) below.push(row(index));

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      overflow="hidden"
      justifyContent="flex-end"
    >
      <Box flexDirection="column" flexShrink={0}>
        {above}
        {/* The clip. It is here on every frame, not only while scrolled, so that the block the
            edge cuts through does not change parent — and so unmount as a side effect of a
            gesture — the moment the reader scrolls. Its height is the whole scroll position: a
            measured value never reaches this render, so the edge cannot drift with an estimate.
            At least one row, because a zero-height clip collapses its children's measurements to
            zero and would leave the next gesture with no geometry to move by. */}
        <Box
          flexDirection="column"
          flexShrink={0}
          overflow="hidden"
          height={scroll ? Math.max(1, scroll.visibleRows) : undefined}
        >
          {below}
          {showTail ? (
            <Box ref={tailRef} flexDirection="column" flexShrink={0}>
              {children}
            </Box>
          ) : null}
        </Box>
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
  index,
  item,
  toolsExpanded,
  separator,
  geometry,
}: {
  /** The item's position in the whole transcript — stable for a committed item, so the geometry
   *  claim below survives this component being memoised out of a re-render. */
  index: number;
  item: TranscriptItem;
  toolsExpanded: boolean;
  /** Not read here — it is a memo input, see the note above. */
  columns: number;
  separator: boolean;
  geometry?: TranscriptGeometry;
}): React.ReactElement {
  const ref = React.useRef<DOMElement | null>(null);
  React.useLayoutEffect(() => geometry?.registerRow(index, ref.current), [geometry, index]);
  return (
    <Box ref={ref} flexDirection="column" flexShrink={0}>
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
