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
import { CHECKLIST_TOOL_NAME, parseChecklistArgs } from '#src/tui/viewModel.js';
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
 * The whole turn's tool calls expand together via the App-level toggle; committed turns are
 * frozen in Ink's `<Static>` and cannot re-fold.
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
 * The `💭 Thinking` region: the model's reasoning/chain-of-thought, rendered as a distinct
 * *layer* from the answer. Collapsible like {@link ToolCallPanel} (shares the turn's Ctrl+T
 * detail toggle) and collapsed by default, so ephemeral thinking never competes with the answer
 * — worst case a lone 👍 answer drowned by paragraphs of thought. When expanded, each line is
 * drawn behind a `│ ` gutter. The label + gutter are **cyan** (DL-8 "informational") rather than
 * dim-only: dim is the least reliably-rendered ANSI attribute and vanishes on many themes, so a
 * dim-only region reads as the answer. Cyan carries the layer boundary as colour; the body stays
 * dim+italic underneath the coloured gutter.
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
  return (
    <Box flexDirection="column">
      <Text color="cyan">
        {`${caret} 💭 ${label}`}
        {live && !expanded ? <Text dimColor>{'  (Ctrl+T to expand)'}</Text> : null}
      </Text>
      {expanded
        ? reasoning.split('\n').map((line, i) => (
            <Box key={i}>
              <Text color="cyan">{'│ '}</Text>
              <Text dimColor italic>
                {line}
              </Text>
            </Box>
          ))
        : null}
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
function ChecklistPanel({ items }: { items: ChecklistItemViewModel[] }): React.ReactElement {
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <Box flexDirection="column">
      <Text color="cyan">{`📋 Checklist (${done}/${items.length})`}</Text>
      {items.map((item, i) => {
        const { glyph, color } = checklistRow(item.status);
        return (
          <Box key={i}>
            <Text color={color}>{`  ${glyph} `}</Text>
            <Text dimColor={item.status === 'completed'} strikethrough={item.status === 'completed'}>
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
        // The checklist tool renders as a dedicated live plan panel once its args parse; until
        // then (or if it never parses) it falls back to the generic collapsible tool panel.
        if (tc.name === CHECKLIST_TOOL_NAME) {
          const items = parseChecklistArgs(tc.argsText);
          if (items) return <ChecklistPanel key={tc.id} items={items} />;
        }
        return <ToolCallPanel key={tc.id} tc={tc} expanded={toolsExpanded} live={streaming} />;
      })}
      {turn.text ? <Text>{streaming ? turn.text : renderMarkdown(turn.text)}</Text> : null}
    </Box>
  );
}
