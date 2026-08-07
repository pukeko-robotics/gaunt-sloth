/**
 * TUI-C48 — how many committed transcript items the owned viewport has to mount.
 *
 * The viewport pins the tail of the conversation to its bottom edge and clips whatever does not
 * fit off its top (`justifyContent: 'flex-end'` + `overflow: 'hidden'`), so **this module never
 * decides where anything is drawn** — the layout does. All it decides is where to cut the item
 * list, which is what keeps a several-hundred-turn session from mounting a component per turn.
 *
 * That split is what makes the arithmetic safe. Every estimate here is a deliberate **lower
 * bound** on the rows an item really occupies:
 *
 * - it counts wrapped rows as `ceil(displayWidth(line) / columns)`, which is what the terminal
 *   draws when a line is cut at the column edge; real word-wrapping breaks EARLIER, at a space,
 *   so it can only ever produce more rows than this;
 * - a sibling `<Text>` holding the empty string collapses to nothing in a column, so an empty
 *   body line counts 0 — charging it a row would be an over-count;
 * - it reuses the app's own builders (`renderMarkdown`, `summariseToolCall`,
 *   `buildToolPreviewLines` / `buildToolBodyLines`) rather than a second model of what a turn
 *   looks like, so a change to what is rendered changes what is counted.
 *
 * An under-count costs a few extra mounted items. An **over-count** would cut the list too high
 * and leave a blank band above the conversation, which is why the direction is pinned by a spec
 * (`transcriptWindow.spec.ts`) that measures every item kind with Ink's own `renderToString` and
 * asserts the estimate never exceeds it.
 */

import {
  buildToolBodyLines,
  buildToolPreviewLines,
  summariseToolCall,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import { displayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';
import { renderMarkdown } from '#src/tui/markdown.js';
import {
  CHECKLIST_TOOL_NAME,
  type ToolCallViewModel,
  type TurnViewModel,
} from '#src/tui/viewModel.js';
import type { TranscriptItem } from '#src/tui/types.js';

/**
 * Items mounted above the ones the budget accounted for.
 *
 * The estimates are lower bounds, so the slice already covers the viewport without this — it is
 * insurance against an estimator that drifts as a component changes, and it is what absorbs the
 * rows the live turn and the intro chrome share the region with (they are not counted here,
 * because they always sit at the bottom where nothing can clip them).
 */
export const TRANSCRIPT_WINDOW_SLACK_ITEMS = 1;

/** Rows one line occupies once wrapped at `columns`. `displayWidth` is ANSI- and CJK-aware. */
function lineRows(line: string, columns: number): number {
  return Math.max(1, Math.ceil(displayWidth(line) / columns));
}

/** Rows a string occupies inside ONE `<Text>`: newlines split rows, a trailing one does not. */
function textRows(text: string, columns: number): number {
  return text
    .replace(/\n+$/, '')
    .split('\n')
    .reduce((rows, line) => rows + lineRows(line, columns), 0);
}

/** Rows a string occupies as its OWN `<Text>` among siblings — the empty string collapses away. */
function siblingRows(text: string, columns: number): number {
  return text === '' ? 0 : textRows(text, columns);
}

/** Rows one `<ToolCallPanel>` occupies: the summary line, then the detail the fold state shows. */
function toolCallRows(tc: ToolCallViewModel, expanded: boolean, columns: number): number {
  // The summary line carries the caret, status glyph, tool glyph and the shortened params, and the
  // live "(Ctrl+T to expand)" hint sits on the same line — one row before wrapping.
  const display = {
    name: tc.name,
    argsText: tc.argsText,
    result: tc.result,
    output: tc.output,
    isError: tc.isError,
  };
  // The summary is measured without the caret/status/tool glyphs that precede it and without the
  // trailing status word, so the count stays under what the line really occupies.
  let rows = textRows(summariseToolCall(tc.name, tc.argsText), columns);
  if (expanded && tc.argsText) rows += textRows(tc.argsText, columns);
  // Each body and notice line is drawn behind a four-space indent, so none of them can collapse.
  if (expanded && tc.notice) {
    for (const line of tc.notice.split('\n')) rows += lineRows(`    ${line}`, columns);
  }
  for (const line of expanded ? buildToolBodyLines(display) : buildToolPreviewLines(display)) {
    rows += lineRows(`    ${line.text}`, columns);
  }
  return rows;
}

/** Rows one `<ReasoningPanel>` occupies: its header, plus a gutter row per line when expanded. */
function reasoningPanelRows(reasoning: string, expanded: boolean, columns: number): number {
  // Every body line is drawn behind a `│ ` gutter, so an empty line still occupies a row.
  let rows = 1;
  if (expanded) {
    for (const line of reasoning.split('\n')) rows += lineRows(`│ ${line}`, columns);
  }
  return rows;
}

/** Rows one committed assistant turn occupies (`<LiveTurn>` with `streaming` false). */
function turnRows(turn: TurnViewModel, toolsExpanded: boolean, columns: number): number {
  let rows = turn.reasoning ? reasoningPanelRows(turn.reasoning, toolsExpanded, columns) : 0;
  for (const tc of turn.toolCalls) {
    // The checklist tool renders as the pinned dock panel, never inside the turn.
    if (tc.name === CHECKLIST_TOOL_NAME) continue;
    rows += toolCallRows(tc, toolsExpanded, columns);
  }
  // Measured from the RENDERED markdown, not the raw text: a fence becomes two rules plus an
  // indented body, so the raw line count is not a bound on either side of it.
  if (turn.text) rows += textRows(renderMarkdown(turn.text, { columns }), columns);
  return rows;
}

/** A lower bound on the rows one committed transcript item occupies. */
export function estimateItemRows(
  item: TranscriptItem,
  options: { columns: number; toolsExpanded: boolean; separator: boolean }
): number {
  const columns = Math.max(1, options.columns);
  // The dim separator rule drawn above every user line except the first.
  let rows = options.separator ? 1 : 0;
  switch (item.kind) {
    case 'user':
      // The prompt marker and the text share one row Box, so they wrap as one run of text.
      rows += textRows(`You › ${item.text}`, columns);
      break;
    case 'assistant':
      rows += turnRows(item.turn, options.toolsExpanded, columns);
      break;
    case 'system':
      rows += textRows(`[${item.level}] ${item.text}`, columns);
      break;
    case 'notice':
      // <CommandNotice>: a bracketing rule, the title, then one sibling <Text> per body line.
      rows += 1 + siblingRows(item.title, columns);
      for (const line of item.lines) rows += siblingRows(line, columns);
      break;
    case 'reasoning':
      // The `/reasoning` reprint: a bracketing rule, then an always-expanded panel.
      rows += 1 + reasoningPanelRows(item.reasoning, true, columns);
      break;
  }
  return rows;
}

/**
 * Index of the first transcript item the viewport needs to mount, walking back from `bottomIndex`
 * until the row budget is covered.
 *
 * `bottomIndex` is the item the viewport's bottom edge cuts through; it defaults to the newest, so
 * a viewport following the conversation asks for exactly what it always did. Walking from the edge
 * rather than from the end is what keeps the mounted set bounded by the region's height however far
 * back the reader has scrolled.
 *
 * `budgetRows` is the terminal height rather than the measured viewport, deliberately: the dock
 * and the live turn take rows out of the region, and over-shooting the slice only costs a mounted
 * component the layout then clips, while under-shooting would show as missing conversation.
 *
 * `columns` is not optional and is not cosmetic. Counted without it — as logical lines — a wall of
 * unbroken prose is ONE row where the terminal draws two dozen, so the walk keeps taking items
 * long after the screen is full: measured at 80 columns, a 40-row viewport mounted 28 items and
 * ~210 rows of content where 4 items would have covered it.
 */
export function transcriptWindowStart(
  items: TranscriptItem[],
  budgetRows: number,
  columns: number,
  toolsExpanded: boolean,
  bottomIndex: number = items.length - 1
): number {
  if (items.length === 0) return 0;
  const budget = Math.max(1, budgetRows);
  const firstUserIndex = items.findIndex((i) => i.kind === 'user');
  let rows = 0;
  let start = Math.min(items.length, Math.max(0, bottomIndex + 1));
  while (start > 0 && rows < budget) {
    start -= 1;
    rows += estimateItemRows(items[start], {
      columns,
      toolsExpanded,
      separator: items[start].kind === 'user' && start !== firstUserIndex,
    });
  }
  return Math.max(0, start - TRANSCRIPT_WINDOW_SLACK_ITEMS);
}

/**
 * Index of the last transcript item the viewport needs to mount when it is scrolled back — the
 * mirror of {@link transcriptWindowStart}, walking forwards from `bottomIndex`.
 *
 * Scrolling back DOWN has to know how tall the items below the edge are, and a height is only
 * knowable by measuring something that is mounted. So a scrolled viewport mounts a region's worth
 * of conversation below the edge as well as above it, drawn nowhere (the clip swallows it) and
 * measured on demand. That is what keeps every scroll position exact instead of estimated, and it
 * costs a mounted set that is still a function of the region's height rather than of the
 * transcript's length.
 *
 * The budget is spent against the same lower-bound estimates, so the real rows mounted below the
 * edge are always at least `budgetRows` — one gesture can never ask for geometry that is not there.
 */
export function transcriptWindowEnd(
  items: TranscriptItem[],
  budgetRows: number,
  columns: number,
  toolsExpanded: boolean,
  bottomIndex: number
): number {
  if (items.length === 0) return -1;
  const budget = Math.max(1, budgetRows);
  const firstUserIndex = items.findIndex((i) => i.kind === 'user');
  let rows = 0;
  let end = Math.max(-1, Math.min(items.length - 1, bottomIndex));
  while (end < items.length - 1 && rows < budget) {
    end += 1;
    rows += estimateItemRows(items[end], {
      columns,
      toolsExpanded,
      separator: items[end].kind === 'user' && end !== firstUserIndex,
    });
  }
  return Math.min(items.length - 1, end + TRANSCRIPT_WINDOW_SLACK_ITEMS);
}
