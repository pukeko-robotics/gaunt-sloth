import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ApprovalRung } from '@gaunt-sloth/core/config.js';
import { APPROVAL_RUNG_LABELS, isRatedRung } from '@gaunt-sloth/core/config.js';

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
   * default became a rated rung, that boolean read `false` while the rater was approving safe
   * commands with no prompt — the status bar actively told the user nothing was being
   * auto-approved. A safety indicator that under-reports is worse than none, so the badge is
   * shown at EVERY rung and names it.
   *
   * Undefined = this session has no approvals surface (fixture agent / non-shell); the badge is
   * omitted rather than guessing a rung.
   */
  approvals?: { rung: ApprovalRung; raterProfile?: string };
}): React.ReactElement {
  // A single, always-visible badge (next to the spinner while running, in the status line when
  // idle). Kept terse so it fits the one-line status bar.
  //
  // Only `bypass` is warn-styled: it is the one rung with NO gate at all. The rest are dim like
  // the rest of the status line — `assisted` is the default and recommended posture, and
  // shouting at the user about the default trains them to ignore the colour that matters. The
  // two RATED rungs name the rater profile so it is visible at a glance. §10 rule 4: the badge
  // uses the display spelling, never the kebab-case identifier.
  const approvalsBadge = approvals ? (
    approvals.rung === 'bypass' ? (
      <Text color="yellow" bold>
        {' ⚡ Bypass'}
      </Text>
    ) : (
      <Text dimColor>
        {isRatedRung(approvals.rung)
          ? `  ·  approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]} (${approvals.raterProfile ?? 'auto-rater'})`
          : `  ·  approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]}`}
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
