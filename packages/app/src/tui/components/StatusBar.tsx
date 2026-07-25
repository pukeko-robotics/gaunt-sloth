import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ApprovalMode } from '@gaunt-sloth/core/config.js';

/**
 * Session status bar. While a turn is running it shows a spinner + interrupt hint;
 * otherwise it surfaces useful session context — the mode, the model/provider display name,
 * and a turn counter — on a single dim line. Streaming progress itself is shown by the live
 * turn, not here, so this bar stays stable (one line) and does not flicker.
 */
export function StatusBar({
  running,
  mode,
  modelDisplayName,
  turnCount,
  debugHint,
  approvals,
}: {
  running: boolean;
  mode: string;
  modelDisplayName?: string;
  turnCount?: number;
  /** When the docked debug panel is open but unfocused, surface how to step into it. */
  debugHint?: boolean;
  /**
   * CFG-26 — the RESOLVED approvals posture, surfaced as a persistent badge so the user always
   * knows how tool calls are being handled. It renders the MODE, never a boolean.
   *
   * This replaced an `autoApprove?: boolean` seeded from the session bypass flag. Once the
   * interactive default became rater-mediated `auto`, that boolean read `false` while the rater
   * was approving safe commands with no prompt — the status bar actively told the user nothing
   * was being auto-approved. A safety indicator that under-reports is worse than none, so the
   * badge is now shown for EVERY mode and names it.
   *
   * Undefined = this session has no approvals surface (fixture agent / non-shell); the badge is
   * omitted rather than guessing a mode.
   */
  approvals?: { mode: ApprovalMode; raterEnabled: boolean; raterProfile?: string };
}): React.ReactElement {
  // A single, always-visible badge (next to the spinner while running, in the status line when
  // idle). Kept terse so it fits the one-line status bar.
  //
  // Only `bypass` is warn-styled: it is the one mode with NO gate at all. `auto` is dim like the
  // rest of the status line — it is the recommended posture, and shouting at the user about the
  // default trains them to ignore the colour that matters. `auto` names the rater so
  // `approvals.rater.profile` is visible at a glance (the spec's status-line requirement).
  const approvalsBadge = approvals ? (
    approvals.mode === 'bypass' ? (
      <Text color="yellow" bold>
        {' ⚡ bypass'}
      </Text>
    ) : (
      <Text dimColor>
        {approvals.mode === 'auto'
          ? `  ·  approvals: auto (${approvals.raterProfile ?? 'AI rater'})`
          : '  ·  approvals: ask'}
      </Text>
    )
  ) : null;

  if (running) {
    return (
      <Box>
        <Text color="yellow">
          <Spinner type="dots" /> Thinking… (Esc to interrupt)
        </Text>
        {approvalsBadge}
      </Box>
    );
  }

  const segments = [
    mode,
    modelDisplayName ? `model: ${modelDisplayName}` : null,
    `turns: ${turnCount ?? 0}`,
    'ready',
  ].filter(Boolean);

  return (
    <Box>
      <Text dimColor>{segments.join('  ·  ')}</Text>
      {approvalsBadge}
      {debugHint ? <Text dimColor>{'  ·  Tab: focus debug panel'}</Text> : null}
    </Box>
  );
}
