import React from 'react';
import { Box, Text } from 'ink';
import {
  buildToolBodyLines,
  buildToolPreviewLines,
  getToolGlyph,
  summariseToolCall,
  type ToolDisplayLine,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import type {
  TurnViewModel,
  ToolCallViewModel,
  ChecklistItemViewModel,
} from '#src/tui/viewModel.js';
import { CHECKLIST_TOOL_NAME } from '#src/tui/viewModel.js';
import { renderMarkdown } from '#src/tui/markdown.js';

/** Status glyph + word for a tool call's compact summary line. */
function toolStatus(tc: ToolCallViewModel): { glyph: string; label: string; color: string } {
  if (tc.status === 'done') {
    // Drive the error affordance from the real tool-result signal (LangChain
    // `ToolMessage.status === 'error'`, threaded through as `isError`), never from sniffing
    // the result text — legitimate output may simply begin with "Error handling…".
    return tc.isError
      ? { glyph: '✗', label: 'error', color: 'red' }
      : { glyph: '✓', label: 'done', color: 'magenta' };
  }
  return { glyph: '⋯', label: 'running', color: 'yellow' };
}

/**
 * TUI-C30 — map one registry-styled body/preview line onto Ink `<Text>` props: `dim` = greyed
 * preview text, `added`/`removed` = diff green/red (DL-8 colour semantics). The 4-space indent
 * keeps the body visually nested under the call line.
 */
function ToolBodyLine({ line }: { line: ToolDisplayLine }): React.ReactElement {
  if (line.style === 'added') return <Text color="green">{`    ${line.text}`}</Text>;
  if (line.style === 'removed') return <Text color="red">{`    ${line.text}`}</Text>;
  return <Text dimColor>{`    ${line.text}`}</Text>;
}

/**
 * One tool call rendered as a collapsible panel (TUI-C30 rendering, via the surface-agnostic
 * registry in `@gaunt-sloth/core/core/toolDisplay.js` — shared with the plain surface):
 *
 * - The call line shows the params INLINE, shortened + secret-redacted:
 *   `▸ ✓ 📁 read_file(path=README.md)  [done]` (DL-4 transparency without a raw JSON dump).
 * - Collapsed (default) it still previews up to the canonical 10 lines of the tool's output as
 *   greyed text with a `… (+N more lines)` overflow marker — inspectable without expanding
 *   (DL-2 progressive disclosure with the head of the story visible).
 * - `write_file`/`edit_file` render their change as a diff (added green / removed red) derived
 *   from the args instead of an args/output dump.
 * - Expanded (`/tools` / Ctrl+T, unchanged) shows the FULL body: raw args, the routed
 *   "Executing" notice, and the uncapped formatter output (deduped for shell calls whose
 *   result repeats the live output).
 *
 * The whole turn's tool calls expand together via the App-level toggle.
 */
function ToolCallPanel({
  tc,
  expanded,
  live,
}: {
  tc: ToolCallViewModel;
  expanded: boolean;
  /** True for the in-progress turn, where Ctrl+T can toggle the detail in place. */
  live: boolean;
}): React.ReactElement {
  const { glyph, label, color } = toolStatus(tc);
  // Inline shortened params (summariseToolCall handles the empty/unparsable-args fallbacks).
  const summary = summariseToolCall(tc.name, tc.argsText);
  const caret = expanded ? '▾' : '▸';
  const hasDetail = !!tc.argsText || !!tc.result || !!tc.output || !!tc.notice;
  const displayInput = {
    name: tc.name,
    argsText: tc.argsText,
    result: tc.result,
    output: tc.output,
    isError: tc.isError,
  };
  // Collapsed: the canonical 10-line capped preview. Expanded: the full uncapped body.
  const body = expanded ? buildToolBodyLines(displayInput) : buildToolPreviewLines(displayInput);
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {`${caret} ${glyph} ${getToolGlyph(tc.name)} ${summary}`}
        <Text dimColor>{`  [${label}]`}</Text>
        {live && !expanded && hasDetail ? <Text dimColor>{'  (Ctrl+T to expand)'}</Text> : null}
      </Text>
      {expanded && tc.argsText ? (
        <Box>
          <Text dimColor>{'    args: '}</Text>
          <Text dimColor>{tc.argsText}</Text>
        </Box>
      ) : null}
      {/* The routed "🔧 Executing …" notice (TUI-C17), kept out of the output preview
          (TUI-C30 folds it on the separate `notice` field) and shown only with the full
          detail body. */}
      {expanded && tc.notice
        ? tc.notice.split('\n').map((line, i) => (
            <Text key={`n${i}`} dimColor>
              {`    ${line}`}
            </Text>
          ))
        : null}
      {body.map((line, i) => (
        <ToolBodyLine key={i} line={line} />
      ))}
    </Box>
  );
}

/**
 * Screen ROWS of reasoning a STREAMING turn shows while collapsed.
 *
 * **This is deliberately not the canonical ten-line tool-output preview, and the two must not be
 * harmonised.** Tool output is a discrete artefact you go and inspect: it arrives complete, it is
 * the evidence for what the agent did, and ten lines is how much of it is worth having in front of
 * you. Reasoning is ambient and continuous — it streams for as long as the model thinks, it is
 * superseded by the answer, and its value while collapsed is only "something is happening, and it
 * is about this". Two rows carry that; ten would let thinking take over the screen it is meant to
 * stay out of, which is the whole reason the panel collapses by default.
 *
 * **Rows, not logical lines, and the difference is the whole cap.** Reasoning streams as prose
 * paragraphs and the newline arrives at the end of one, so two logical lines are routinely two
 * paragraphs: at 80 columns two 600-character paragraphs wrap to seventeen rows, more of the screen
 * than the ten-line tool preview this number exists to be smaller than. Each previewed line is
 * therefore drawn on exactly one row, truncated at its START so the window stays on the newest
 * text the model has produced rather than freezing on the opening of a paragraph.
 *
 * It applies only while the turn streams. A committed turn's collapsed panel is its header alone,
 * unchanged, so what the transcript holds after the fact is unaffected.
 */
export const LIVE_REASONING_PREVIEW_ROWS = 2;

/**
 * The `💭 Thinking` region: the model's reasoning/chain-of-thought, rendered as a distinct
 * *layer* from the answer. Collapsible like {@link ToolCallPanel} (shares the turn's Ctrl+T
 * detail toggle) and collapsed by default, so ephemeral thinking never competes with the answer
 * — worst case a lone 👍 answer drowned by paragraphs of thought. When expanded, each line is
 * drawn behind a `│ ` gutter. The label + gutter are **cyan** (DL-8 "informational") rather than
 * dim-only: dim is the least reliably-rendered ANSI attribute and vanishes on many themes, so a
 * dim-only region reads as the answer. Cyan carries the layer boundary as colour; the body stays
 * dim+italic underneath the coloured gutter.
 *
 * While a turn is STREAMING and collapsed it keeps up to
 * {@link LIVE_REASONING_PREVIEW_ROWS} of its newest rows on screen, in the same gutter styling, so
 * a thinking model shows what it is thinking about instead of a bare header. One row per trailing
 * logical line, so a single streaming paragraph draws one. The preview follows the stream: it is
 * always the newest lines, and a line longer than the terminal is truncated at its start, so it
 * reads as a window onto the tail rather than as a frozen opening.
 */
export function ReasoningPanel({
  reasoning,
  expanded,
  live,
  label = 'Thinking',
}: {
  reasoning: string;
  expanded: boolean;
  /** True for the in-progress turn, where Ctrl+T can toggle the detail in place. */
  live: boolean;
  /**
   * Header text after the `💭` glyph. Defaults to `Thinking` for the in-turn region; the
   * `/reasoning` reprint (TUI-C18) passes a turn-tagged label so a recalled block is single-sourced
   * with the live styling yet says which committed turn it came from.
   */
  label?: string;
}): React.ReactElement {
  const caret = expanded ? '▾' : '▸';
  // Expanded shows everything; collapsed-and-live shows the newest few lines; collapsed on a
  // committed turn shows the header alone. Trailing newlines are dropped first so a chunk that
  // happens to arrive ending in one does not spend a preview line on a blank row.
  const preview = live ? reasoning.replace(/\n+$/, '') : '';
  const lines = expanded
    ? reasoning.split('\n')
    : preview === ''
      ? []
      : preview.split('\n').slice(-LIVE_REASONING_PREVIEW_ROWS);
  return (
    <Box flexDirection="column">
      <Text color="cyan">
        {`${caret} 💭 ${label}`}
        {live && !expanded ? <Text dimColor>{'  (Ctrl+T to expand)'}</Text> : null}
      </Text>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="cyan">{'│ '}</Text>
          {/* Expanded shows the thought in full and wraps as ordinary text. The collapsed preview
              is capped in ROWS, so each previewed line gets exactly one — Ink measures the width
              itself, which keeps the cap true at any terminal size without a width calculation
              here. Truncating at the START keeps the newest text visible, which is what makes the
              two rows a window that follows the stream. */}
          <Text wrap={expanded ? undefined : 'truncate-start'} dimColor italic>
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

/** Glyph + colour for one checklist row's status (DL colour semantics). */
function checklistRow(status: ChecklistItemViewModel['status']): { glyph: string; color: string } {
  switch (status) {
    case 'completed':
      return { glyph: '[x]', color: 'green' };
    case 'in_progress':
      return { glyph: '[~]', color: 'yellow' };
    default:
      return { glyph: '[ ]', color: 'gray' };
  }
}

/**
 * A `gth_checklist` tool call rendered as a live plan: a `📋 Checklist (done/total)` header and one
 * checkbox row per item, coloured by status. Shown expanded (unlike generic tool panels) because
 * the plan is meant to be seen — it is the lean agent's answer to deepagents' `write_todos`. The
 * caller only routes here once {@link parseChecklistArgs} yields rows; a still-streaming/partial
 * args buffer falls back to the generic {@link ToolCallPanel}.
 */
export function ChecklistPanel({ items }: { items: ChecklistItemViewModel[] }): React.ReactElement {
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <Box flexDirection="column">
      <Text color="cyan">{`📋 Checklist (${done}/${items.length})`}</Text>
      {items.map((item, i) => {
        const { glyph, color } = checklistRow(item.status);
        return (
          <Box key={i}>
            <Text color={color}>{`  ${glyph} `}</Text>
            <Text
              dimColor={item.status === 'completed'}
              strikethrough={item.status === 'completed'}
            >
              {item.content}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Renders one assistant turn from the pure {@link TurnViewModel}: a collapsible `💭 Thinking`
 * reasoning region, one collapsible panel per tool call, then the assistant text. Used both for
 * the in-progress live turn and (frozen) for committed turns in the transcript, so the look is
 * identical once done.
 *
 * Assistant text is rendered as terminal **markdown** once the segment is complete; while a
 * turn is still streaming (`streaming` true) we render it as plain text so the live region
 * never reflows mid-chunk or garbles a half-arrived markdown construct. `renderMarkdown`
 * falls back to the raw text whenever the content is not markdown-meaningful or rendering
 * fails, so plain prose always reads correctly.
 */
export function LiveTurn({
  turn,
  toolsExpanded = false,
  streaming = false,
}: {
  turn: TurnViewModel;
  /** Whether tool-call panels show their args/result body (App-level Ctrl+T toggle). */
  toolsExpanded?: boolean;
  /** True while the turn is still streaming; suppresses markdown reflow until complete. */
  streaming?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {turn.reasoning ? (
        <ReasoningPanel reasoning={turn.reasoning} expanded={toolsExpanded} live={streaming} />
      ) : null}
      {turn.toolCalls.map((tc) => {
        if (tc.name === CHECKLIST_TOOL_NAME) {
          return null;
        }
        return <ToolCallPanel key={tc.id} tc={tc} expanded={toolsExpanded} live={streaming} />;
      })}
      {turn.text ? <Text>{streaming ? turn.text : renderMarkdown(turn.text)}</Text> : null}
    </Box>
  );
}
