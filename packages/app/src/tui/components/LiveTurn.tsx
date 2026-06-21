import React from 'react';
import { Box, Text } from 'ink';
import type { TurnViewModel, ToolCallViewModel } from '#src/tui/viewModel.js';
import { renderMarkdown } from '#src/tui/markdown.js';

/** Status glyph + word for a tool call's compact summary line. */
function toolStatus(tc: ToolCallViewModel): { glyph: string; label: string; color: string } {
  if (tc.status === 'done') {
    // A tool whose result text looks like an error gets the error affordance.
    const errored = !!tc.result && /^\s*(error|err:|exception|failed)/i.test(tc.result);
    return errored
      ? { glyph: '✗', label: 'error', color: 'red' }
      : { glyph: '✓', label: 'done', color: 'magenta' };
  }
  return { glyph: '⋯', label: 'running', color: 'yellow' };
}

/**
 * One tool call rendered as a collapsible panel: a compact summary line (glyph + name +
 * status) that, when `expanded`, also shows the streamed args and the result. Collapsed by
 * default so the transcript stays readable; the whole turn's tool calls expand together via
 * the App-level toggle (Ctrl+T), mirroring the docked debug panel's single-key detail flip.
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
  const name = tc.name || '(tool)';
  // Collapsed-state affordance: a ▸/▾ caret so it reads as foldable, plus a hint there is
  // detail to expand. Expanded shows ▾ and the args/result body. The Ctrl+T hint only shows
  // on the live turn — committed turns are frozen in Ink's <Static> and cannot re-fold.
  const caret = expanded ? '▾' : '▸';
  const hasDetail = !!tc.argsText || !!tc.result;
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {`${caret} ${glyph} ${name}`}
        <Text dimColor>{`  [${label}]`}</Text>
        {live && !expanded && hasDetail ? <Text dimColor>{'  (Ctrl+T to expand)'}</Text> : null}
      </Text>
      {expanded && tc.argsText ? (
        <Box>
          <Text dimColor>{'    args: '}</Text>
          <Text dimColor>{tc.argsText}</Text>
        </Box>
      ) : null}
      {expanded && tc.result ? (
        <Box flexDirection="column">
          {tc.result.split('\n').map((line, i) => (
            <Text key={i} dimColor>
              {`    ${line}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Renders one assistant turn from the pure {@link TurnViewModel}: a dim reasoning region,
 * one collapsible panel per tool call, then the assistant text. Used both for the in-progress
 * live turn and (frozen) for committed turns in the transcript, so the look is identical once
 * done.
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
      {turn.reasoning ? <Text dimColor>{turn.reasoning}</Text> : null}
      {turn.toolCalls.map((tc) => (
        <ToolCallPanel key={tc.id} tc={tc} expanded={toolsExpanded} live={streaming} />
      ))}
      {turn.text ? <Text>{streaming ? turn.text : renderMarkdown(turn.text)}</Text> : null}
    </Box>
  );
}
