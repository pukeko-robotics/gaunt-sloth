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
 * - it counts the rows a component renders **without** word-wrapping, and wrapping can only ever
 *   add rows;
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

/** Rows a string occupies inside ONE `<Text>`: newlines split rows, a trailing one does not. */
function textRows(text: string): number {
  return text.replace(/\n+$/, '').split('\n').length;
}

/** Rows a string occupies as its OWN `<Text>` among siblings — the empty string collapses away. */
function siblingRows(text: string): number {
  return text === '' ? 0 : textRows(text);
}

/** Rows one `<ToolCallPanel>` occupies: the summary line, then the detail the fold state shows. */
function toolCallRows(tc: ToolCallViewModel, expanded: boolean): number {
  // The summary line carries the caret, status glyph, tool glyph and the shortened params, and the
  // live "(Ctrl+T to expand)" hint sits on the same line — one row before wrapping.
  const display = {
    name: tc.name,
    argsText: tc.argsText,
    result: tc.result,
    output: tc.output,
    isError: tc.isError,
  };
  let rows = textRows(summariseToolCall(tc.name, tc.argsText));
  if (expanded && tc.argsText) rows += textRows(tc.argsText);
  // Each notice line is drawn behind a four-space indent, so none of them can collapse.
  if (expanded && tc.notice) rows += tc.notice.split('\n').length;
  rows += (expanded ? buildToolBodyLines(display) : buildToolPreviewLines(display)).length;
  return rows;
}

/** Rows one `<ReasoningPanel>` occupies: its header, plus a gutter row per line when expanded. */
function reasoningPanelRows(reasoning: string, expanded: boolean): number {
  // Every body line is drawn behind a `│ ` gutter, so an empty line still occupies a row.
  return 1 + (expanded ? reasoning.split('\n').length : 0);
}

/** Rows one committed assistant turn occupies (`<LiveTurn>` with `streaming` false). */
function turnRows(turn: TurnViewModel, toolsExpanded: boolean): number {
  let rows = turn.reasoning ? reasoningPanelRows(turn.reasoning, toolsExpanded) : 0;
  for (const tc of turn.toolCalls) {
    // The checklist tool renders as the pinned dock panel, never inside the turn.
    if (tc.name === CHECKLIST_TOOL_NAME) continue;
    rows += toolCallRows(tc, toolsExpanded);
  }
  if (turn.text) rows += textRows(renderMarkdown(turn.text));
  return rows;
}

/** A lower bound on the rows one committed transcript item occupies. */
export function estimateItemRows(
  item: TranscriptItem,
  options: { toolsExpanded: boolean; separator: boolean }
): number {
  // The dim separator rule drawn above every user line except the first.
  let rows = options.separator ? 1 : 0;
  switch (item.kind) {
    case 'user':
      // The prompt marker and the text share one row Box, so they wrap as one run of text.
      rows += textRows(`You › ${item.text}`);
      break;
    case 'assistant':
      rows += turnRows(item.turn, options.toolsExpanded);
      break;
    case 'system':
      rows += textRows(`[${item.level}] ${item.text}`);
      break;
    case 'notice':
      // <CommandNotice>: a bracketing rule, the title, then one sibling <Text> per body line.
      rows += 1 + siblingRows(item.title);
      for (const line of item.lines) rows += siblingRows(line);
      break;
    case 'reasoning':
      // The `/reasoning` reprint: a bracketing rule, then an always-expanded panel.
      rows += 1 + reasoningPanelRows(item.reasoning, true);
      break;
  }
  return rows;
}

/**
 * Index of the first transcript item the viewport needs to mount, walking back from the newest
 * until the row budget is covered.
 *
 * `budgetRows` is the terminal height rather than the measured viewport, deliberately: the dock
 * and the live turn take rows out of the region, and over-shooting the slice only costs a mounted
 * component the layout then clips, while under-shooting would show as missing conversation.
 */
export function transcriptWindowStart(
  items: TranscriptItem[],
  budgetRows: number,
  toolsExpanded: boolean
): number {
  if (items.length === 0) return 0;
  const budget = Math.max(1, budgetRows);
  const firstUserIndex = items.findIndex((i) => i.kind === 'user');
  let rows = 0;
  let start = items.length;
  while (start > 0 && rows < budget) {
    start -= 1;
    rows += estimateItemRows(items[start], {
      toolsExpanded,
      separator: items[start].kind === 'user' && start !== firstUserIndex,
    });
  }
  return Math.max(0, start - TRANSCRIPT_WINDOW_SLACK_ITEMS);
}
