import React from 'react';
import { Box, Text } from 'ink';
import {
  buildToolBodyLines,
  buildToolExpansionText,
  buildToolPreviewLines,
  getToolGlyph,
  summariseToolCall,
  toolStatusDisplay,
  type ToolDisplayLine,
} from '@gaunt-sloth/core/core/toolDisplay.js';
import type {
  TurnViewModel,
  ToolCallViewModel,
  ChecklistItemViewModel,
} from '#src/tui/viewModel.js';
import { approvalOutcomeLine, displaySegments } from '#src/tui/viewModel.js';
import { renderMarkdown } from '#src/tui/markdown.js';
import { BlankRow } from '#src/tui/components/BlankRow.js';
import { ApprovalRequestPanel } from '#src/tui/components/ApprovalRequestPanel.js';

/**
 * Status glyph + word + colour for a tool call's compact summary line.
 *
 * **Every affordance here is driven from a real tool-result signal, never from sniffing the result
 * text** — legitimate output may simply begin with "Error handling…". `isError` is LangChain's
 * `ToolMessage.status === 'error'`; `raterClarification` is the approvals gate's own account of a
 * call it refused back to the agent as a §5 negotiation round ([[TUI-C69]]).
 *
 * The glyph/word/tone decision itself lives in core's {@link toolStatusDisplay}, shared with the
 * plain surface, so the two cannot come to describe one event two ways — which is the whole reason
 * a measured defect could sit on one surface and be invisible on the other. This function's own
 * job is only the `running` case, which is a TUI state (the plain surface prints nothing until the
 * result lands), and the tone → Ink colour mapping.
 */
function toolStatus(tc: ToolCallViewModel): { glyph: string; label: string; color: string } {
  if (tc.status === 'done') {
    const status = toolStatusDisplay({
      isError: tc.isError,
      raterClarification: tc.raterClarification,
    });
    // `success` is magenta rather than green here: this surface reserves green for a diff's added
    // lines, and a done row is not a diff.
    const color = status.tone === 'error' ? 'red' : status.tone === 'warn' ? 'yellow' : 'magenta';
    return { glyph: status.glyph, label: status.label, color };
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
  columns,
}: {
  tc: ToolCallViewModel;
  expanded: boolean;
  /** True for the in-progress turn, where Ctrl+T can toggle the detail in place. */
  live: boolean;
  /**
   * [[TUI-C99]] — the frame width the approval request block is framed at, when this call carries
   * one. Threaded rather than read from the terminal-size context because `transcriptWindow`'s row
   * oracle takes it as an argument: the two count the same block only if they are handed the same
   * width, and a component measuring for itself is free to be handed a different one.
   *
   * **Required, all the way up the chain**, for the reason `ApprovalRequestPanel` states on its own
   * prop: a missing width is not an absent frame but an 80-column one, which on a narrower terminal
   * puts untrusted bytes back at column 0. A call carrying no approval never reads it, and that is
   * not a reason to let it be forgotten by the one that does.
   */
  columns: number;
}): React.ReactElement {
  const { glyph, label, color } = toolStatus(tc);
  // Inline shortened params (summariseToolCall handles the empty/unparsable-args fallbacks).
  const summary = summariseToolCall(tc.name, tc.argsText);
  const caret = expanded ? '▾' : '▸';
  const hasDetail = !!tc.argsText || !!tc.result || !!tc.output || !!tc.notice;
  // Collapsed: the canonical 10-line capped preview. Expanded: the full uncapped body.
  //
  // MEMOISED, because this is a render body and the work is not small: building a preview
  // width-slices every line of a tool's output, and a tool's output is unbounded. Unmemoised it is
  // redone on every frame — a streaming turn repaints many times a second while this call's own
  // inputs have not changed since the result landed — so the cost is paid per FRAME rather than
  // per tool call.
  //
  // The key is every input the lines depend on: the five fields the formatters read, `tc.notice`
  // (which only the expansion draws), and `expanded`, which selects between two different
  // formatters. The redaction secret set is the remaining input and is deliberately not keyed —
  // core caches it, and the only thing that recomputes it registers the live config when the agent
  // runner starts, which is before any tool call exists to render.
  //
  // [[TUI-C102]] — the expansion's args/notice strings are built HERE, in the same memo, for the
  // same reason: neutralising walks every code point of an unbounded args string, and doing that
  // in the render body would pay it per frame.
  const { body, expansion } = React.useMemo(() => {
    const displayInput = {
      name: tc.name,
      argsText: tc.argsText,
      result: tc.result,
      output: tc.output,
      isError: tc.isError,
    };
    return {
      body: expanded ? buildToolBodyLines(displayInput) : buildToolPreviewLines(displayInput),
      expansion: expanded
        ? buildToolExpansionText({ argsText: tc.argsText, notice: tc.notice })
        : null,
    };
  }, [tc.name, tc.argsText, tc.result, tc.output, tc.isError, tc.notice, expanded]);
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {`${caret} ${glyph} ${getToolGlyph(tc.name)} ${summary}`}
        <Text dimColor>{`  [${label}]`}</Text>
        {live && !expanded && hasDetail ? <Text dimColor>{'  (Ctrl+T to expand)'}</Text> : null}
      </Text>
      {/* [[TUI-C99]] — the answer this call got at the approval gate, BELOW the call it was about
          and carrying the decision alone. Its whole text comes from `approvalOutcomeLine`, which
          `transcriptWindow` counts through as well. */}
      {tc.approval ? (
        <Text dimColor>{`    ${approvalOutcomeLine(tc.approval, expanded)}`}</Text>
      ) : null}
      {/* The detail Ctrl+T promises: the very rows the dialog showed, from core's own renderer, so
          the audit [[EXT-137]] put in the conversation survives the block ceasing to stand there.
          Un-indented, because each row already carries the [[TUI-C26]] gutter that holds column 0
          and is framed to `columns` — indenting them would re-wrap what must never be re-wrapped. */}
      {tc.approval && expanded ? (
        <ApprovalRequestPanel pending={tc.approval.request} columns={columns} />
      ) : null}
      {/* [[TUI-C102]] — both of these are painted from `buildToolExpansionText`, never from the
          raw view-model fields: the args text is whatever the model streamed and the notice quotes
          the command back, so both are untrusted, and `transcriptWindow`'s row oracle counts the
          very same strings. */}
      {expansion?.args ? (
        <Box>
          <Text dimColor>{'    args: '}</Text>
          <Text dimColor>{expansion.args}</Text>
        </Box>
      ) : null}
      {/* The routed "🔧 Executing …" notice (TUI-C17), kept out of the output preview
          (TUI-C30 folds it on the separate `notice` field) and shown only with the full
          detail body. */}
      {(expansion?.noticeLines ?? []).map((line, i) => (
        <Text key={`n${i}`} dimColor>
          {`    ${line}`}
        </Text>
      ))}
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
 * While the thought is still being WRITTEN and collapsed it keeps up to
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
  previewTail = live,
  label = 'Thinking',
}: {
  reasoning: string;
  expanded: boolean;
  /** True for the in-progress turn, where Ctrl+T can toggle the detail in place. */
  live: boolean;
  /**
   * True for the thought currently being WRITTEN — the last drawn segment of a streaming turn.
   *
   * Separate from {@link live} because a turn can hold several thoughts and they answer different
   * questions. Ctrl+T toggles every panel of a live turn, so the hint belongs on all of them; the
   * tail preview says "this is what the model is thinking about right now", which is true of one.
   * A finished thought that kept previewing its tail would claim the model is still on it.
   */
  previewTail?: boolean;
  /**
   * Header text after the `💭` glyph. Defaults to `Thinking` for the in-turn region; the
   * `/reasoning` reprint (TUI-C18) passes a turn-tagged label so a recalled block is single-sourced
   * with the live styling yet says which committed turn it came from.
   */
  label?: string;
}): React.ReactElement {
  const caret = expanded ? '▾' : '▸';
  // Expanded shows everything; collapsed while the thought is still being written shows the newest
  // few lines; collapsed on a committed or finished thought shows the header alone. Trailing
  // newlines are dropped first so a chunk that happens to arrive ending in one does not spend a
  // preview line on a blank row.
  const preview = previewTail ? reasoning.replace(/\n+$/, '') : '';
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
 * TUI-C92 — the rows the pinned {@link ChecklistPanel} occupies: its header and one row per item.
 * Beside the render so the two cannot drift; `<App>` takes them off the slash menu's budget. A
 * lower bound — an item long enough to wrap takes more.
 */
export function checklistPanelRows(items: readonly ChecklistItemViewModel[]): number {
  return 1 + items.length;
}

/**
 * A `gth_checklist` tool call rendered as a live plan: a `📋 Checklist (done/total)` header and one
 * checkbox row per item, coloured by status. Shown expanded (unlike generic tool panels) because
 * the plan is meant to be seen — it is the lean agent's answer to deepagents' `write_todos`. The
 * caller only routes here once {@link parseChecklistArgs} yields rows; a still-streaming/partial
 * args buffer falls back to the generic {@link ToolCallPanel}.
 *
 * Row text arrives already neutralised — the parser owns that, and `ChecklistItemViewModel.content`
 * states it — so it is painted verbatim here and needs no second treatment.
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
 * Renders one assistant turn from the pure {@link TurnViewModel}: its segments **in the order they
 * arrived** — a thought, a text run, a tool panel, the next thought, and so on. Used both for the
 * in-progress live turn and (frozen) for committed turns in the transcript, so the look is
 * identical once done.
 *
 * Order is the whole contract here. A turn that ran `text → tool → text → tool` reads as an
 * explanation around its actions; drawn as every tool followed by all of the text it reads as
 * forty-three panels and then a paragraph that no longer refers to anything nearby. The `💭
 * Thinking` panel is in the list for the same reason and not an exception to it: a model that
 * thinks, acts, then thinks again had two thoughts at two points in the turn, and hoisting both to
 * the top puts the reasoning that produced the last tool call above the first one.
 *
 * Each text segment is rendered **independently**: a markdown construct split across a tool call
 * renders as two blocks rather than one. `renderMarkdown` is stateless by design (fence state is
 * per call), and threading that state across segments would be a renderer refactor; two honest
 * blocks beat a construct silently re-joined across an action that happened between them.
 *
 * Assistant text is rendered as terminal **markdown** once the turn is complete; while it is still
 * streaming (`streaming` true) every run renders as plain text so the live region never reflows
 * mid-chunk or garbles a half-arrived construct. `renderMarkdown` falls back to the raw text
 * whenever the content is not markdown-meaningful or rendering fails, so plain prose always reads
 * correctly.
 */
export function LiveTurn({
  turn,
  toolsExpanded = false,
  streaming = false,
  columns,
}: {
  turn: TurnViewModel;
  /** Whether tool-call panels show their args/result body (App-level Ctrl+T toggle). */
  toolsExpanded?: boolean;
  /** True while the turn is still streaming; suppresses markdown reflow until complete. */
  streaming?: boolean;
  /**
   * [[TUI-C99]] — the frame width an answered call's approval request block is framed at. Only that
   * block reads it; every other part of a turn is laid out by Ink itself.
   *
   * **Required**, because the omission it would otherwise permit is silent: it reaches
   * `ApprovalRequestPanel` as the 80-column default and re-wraps untrusted rows on a narrower
   * terminal. Both production callers hold the terminal width already; a test rendering a turn with
   * no approval in it passes any number.
   */
  columns: number;
}): React.ReactElement {
  // `displaySegments` decides what is drawn — it drops the segments that paint nothing (the
  // checklist tool, which is the pinned dock panel) and re-joins the runs around them, so a call
  // the reader cannot see never breaks a paragraph. The row-count oracle in `transcriptWindow.ts`
  // walks the SAME function, which is what keeps the two in lockstep.
  const drawn = displaySegments(turn);
  return (
    <Box flexDirection="column">
      {/* Keyed by position: these components hold no state, so an index key can only affect how
          React diffs them, never what they show. */}
      {drawn.map((segment, i) => {
        const body =
          segment.kind === 'text' ? (
            <Text>{streaming ? segment.text : renderMarkdown(segment.text)}</Text>
          ) : segment.kind === 'reasoning' ? (
            // Only the thought at the BOTTOM of a still-streaming turn is the one being written,
            // so it is the only one that previews its newest rows. Once text or a tool call
            // follows it the thought is finished. The expand hint stays on every panel of a live
            // turn, because Ctrl+T toggles all of them.
            <ReasoningPanel
              reasoning={segment.text}
              expanded={toolsExpanded}
              live={streaming}
              previewTail={streaming && i === drawn.length - 1}
            />
          ) : (
            <ToolCallPanel
              tc={segment.tool}
              expanded={toolsExpanded}
              live={streaming}
              columns={columns}
            />
          );
        // TUI-C90 — one blank row BETWEEN blocks, never around them. A leading row would push a
        // turn off its own separator, and a trailing one would make a streaming turn jump the
        // moment its first segment arrives; the row below the last block belongs to the item
        // wrapper in `TranscriptViewport`, which is what separates one item from the next.
        return (
          <React.Fragment key={i}>
            {i > 0 ? <BlankRow /> : null}
            {body}
          </React.Fragment>
        );
      })}
    </Box>
  );
}
