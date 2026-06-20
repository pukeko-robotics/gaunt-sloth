import React from 'react';
import { Box, Text } from 'ink';
import type { SubagentTreeViewModel } from '#src/tui/viewModel.js';

/** The selectable sections of the docked panel, in tab order. */
export const DEBUG_TABS = ['subagents', 'history', 'request', 'response'] as const;
export type DebugTab = (typeof DEBUG_TABS)[number];

const TAB_LABELS: Record<DebugTab, string> = {
  subagents: 'Subagents',
  history: 'Sent to model (full history)',
  request: 'Sent to model (request)',
  response: 'Raw model response',
};

export interface DebugPanelProps {
  /** Subagent tree folded from `task` tool-call events. */
  subagents: SubagentTreeViewModel;
  /** Rendered lines for "Sent to model (full history)" (already split on newlines). */
  historyLines: string[];
  /** Rendered lines for "Sent to model (request)" — tools/system/params (split on newlines). */
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
  const lines =
    activeTab === 'subagents'
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

  // Clamp the window into range so an offset left over from a longer section never blanks
  // the viewport when switching to a shorter one.
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const top = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = lines.slice(top, top + viewportHeight);

  const more = lines.length > viewportHeight;
  const scrollHint = more
    ? ` ${top + 1}-${Math.min(top + viewportHeight, lines.length)}/${lines.length}`
    : '';

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
            ? `[Tab: section · PgUp/PgDn: scroll · m: ${
                maximized ? 'restore' : 'maximise'
              } · Esc: unfocus]`
            : '[/debug to hide]'}
          {scrollHint}
        </Text>
      </Box>
      <Box height={viewportHeight} overflow="hidden" flexDirection="column">
        {visible.map((line, i) => (
          <Text key={top + i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
