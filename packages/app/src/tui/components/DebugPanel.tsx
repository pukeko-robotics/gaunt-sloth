import React from 'react';
import { Box, Text } from 'ink';
import type { SubagentTreeViewModel } from '#src/tui/viewModel.js';

/** The selectable sections of the docked panel, in tab order. */
export const DEBUG_TABS = ['subagents', 'history', 'request', 'response'] as const;
export type DebugTab = (typeof DEBUG_TABS)[number];

const TAB_LABELS: Record<DebugTab, string> = {
  subagents: 'Subagents',
  history: 'Sent to model (chat history)',
  request: 'Sent to model (system + tools)',
  response: 'Raw model response',
};

export interface DebugPanelProps {
  /** Subagent tree folded from `task` tool-call events. */
  subagents: SubagentTreeViewModel;
  /** Rendered lines for "Sent to model (chat history)" (already split on newlines). */
  historyLines: string[];
  /** Rendered lines for "Sent to model (system + tools)" — system/tools/params (split on newlines). */
  requestLines: string[];
  /** Rendered lines for "Raw model response" (already split on newlines). */
  responseLines: string[];
  /** Which tab is shown. */
  activeTab: DebugTab;
  /** Top line of the windowed slice (PageUp/PageDown moves this while focused). */
  scrollOffset: number;
  /** Whether the panel currently owns keyboard focus (changes the border colour + hint). */
  focused: boolean;
  /** Height (in rows) of the bounded, clipping viewport. */
  viewportHeight: number;
  /** Whether the pane is maximised (grown to most of the terminal height). */
  maximized: boolean;
}

/** The data a debug section needs to resolve into renderable lines. */
export interface DebugPanelLinesInput {
  subagents: SubagentTreeViewModel;
  historyLines: string[];
  requestLines: string[];
  responseLines: string[];
  activeTab: DebugTab;
}

/**
 * The exact lines the active section renders, including the empty-state placeholders. Exported
 * (and pure) so `<App>` can compute the active section's length to clamp the scroll offset to
 * its real maximum — keeping keyboard scrolling and the rendered viewport in agreement (TUI-C11).
 */
export function debugPanelLines({
  subagents,
  historyLines,
  requestLines,
  responseLines,
  activeTab,
}: DebugPanelLinesInput): string[] {
  return activeTab === 'subagents'
    ? subagentLines(subagents)
    : activeTab === 'history'
      ? historyLines.length
        ? historyLines
        : ['(no model call captured yet)']
      : activeTab === 'request'
        ? requestLines.length
          ? requestLines
          : ['(no request details captured yet)']
        : responseLines.length
          ? responseLines
          : ['(no model response captured yet)'];
}

/** Flatten the subagent tree into renderable lines for the bounded viewport. */
function subagentLines(tree: SubagentTreeViewModel): string[] {
  if (tree.nodes.length === 0) return ['(no subagents spawned yet)'];
  const lines: string[] = [];
  for (const node of tree.nodes) {
    const marker = node.status === 'done' ? '✓' : '⋯';
    lines.push(`${marker} ${node.type}`);
    if (node.description) lines.push(`    ↳ ${node.description}`);
    if (node.result) {
      // Indent each line of a (possibly multi-line) result under the node.
      for (const r of node.result.split('\n')) lines.push(`      ${r}`);
    }
  }
  return lines;
}

/**
 * Full-width docked panel below the transcript / above the status bar (lives in the live,
 * non-static frame so it coexists with `<Static>` scrollback). Tabs select a section; the
 * body is a bounded viewport — `<Box height={n} overflow="hidden">` over a windowed slice of
 * the section's lines, with the window moved by `scrollOffset` (PageUp/PageDown while focused).
 * Pure presentational: all state (tab, offset, focus) is owned by `<App>`.
 */
export function DebugPanel({
  subagents,
  historyLines,
  requestLines,
  responseLines,
  activeTab,
  scrollOffset,
  focused,
  viewportHeight,
  maximized,
}: DebugPanelProps): React.ReactElement {
  const lines = debugPanelLines({
    subagents,
    historyLines,
    requestLines,
    responseLines,
    activeTab,
  });

  // Clamp the window into range so an offset left over from a longer section never blanks
  // the viewport when switching to a shorter one.
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const top = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = lines.slice(top, top + viewportHeight);

  const overflow = lines.length > viewportHeight;
  const bottom = Math.min(top + viewportHeight, lines.length);
  const hasAbove = top > 0;
  const hasBelow = bottom < lines.length;
  // Bottom-of-pane status so it is always clear whether more content lies beyond the window —
  // a short last page (trailing blank space) otherwise reads as "this is the end". Shows the
  // line range, an "N more below" / "— end —" marker, and an "▲ above" marker when scrolled.
  const footer = overflow
    ? `${top + 1}-${bottom}/${lines.length}` +
      (hasBelow ? `  ▼ ${lines.length - bottom} more below (↓)` : '  — end —') +
      (hasAbove ? '  ▲ above (↑)' : '')
    : `${lines.length} line${lines.length === 1 ? '' : 's'}`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'}>
      <Box>
        <Text>
          {DEBUG_TABS.map((tab) => {
            const label = TAB_LABELS[tab];
            return tab === activeTab ? (
              <Text key={tab} color="cyan" bold>
                {` ${label} `}
              </Text>
            ) : (
              <Text key={tab} dimColor>
                {` ${label} `}
              </Text>
            );
          })}
        </Text>
      </Box>
      {/* Hint on its own row so it never competes with the (now four) tab labels for width
          and wraps mid-phrase. */}
      <Box>
        <Text dimColor>
          {focused
            ? `[Tab: section · ↑/↓: scroll · m: ${
                maximized ? 'restore' : 'maximise'
              } · Esc: unfocus]`
            : '[/debug to hide]'}
        </Text>
      </Box>
      <Box height={viewportHeight} overflow="hidden" flexDirection="column">
        {visible.map((line, i) => (
          <Text key={top + i}>{line}</Text>
        ))}
      </Box>
      {/* Always-present bottom status: makes "is there more below?" unambiguous. */}
      <Box>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}
