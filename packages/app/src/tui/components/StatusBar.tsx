import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { ApprovalRung } from '@gaunt-sloth/core/config.js';
import { APPROVAL_RUNG_LABELS, isRatedRung } from '@gaunt-sloth/core/config.js';
import { modelProviderLabel } from '@gaunt-sloth/core/core/modelLabel.js';
import { displayWidth } from '@gaunt-sloth/core/utils/displayWidth.js';

/** Separates the bar's segments, and the unit the width budget is spent in. */
const SEPARATOR = '  ·  ';

/** The trailing hint, as its own sibling `<Text>`; a constant so its width can be reserved. */
const DEBUG_HINT_TEXT = '  ·  Tab: focus debug panel';

/** Width assumed when the terminal width is unknown (non-TTY / tests) — as in `ruleWidth`. */
const DEFAULT_COLUMNS = 80;

/**
 * CFG-38 — assemble the idle bar's dim segment run, and make the ONE width decision this bar has.
 *
 * Pure, and exported, for the reason `ruleWidth` and `launchBannerRows` are: the decision below is
 * width-conditional, and a rule that only exists inside a React render can only be tested by
 * driving a terminal. `columns` is a parameter rather than a `useStdout()` read for the same
 * reason `ApprovalStopMessage` takes one.
 *
 * ## Why the PROVIDER is the half that goes
 *
 * This is the one surface where `model (provider)` has a real cost: a single line already carrying
 * the mode, a turn counter, an approvals badge and sometimes a debug hint, all competing for the
 * terminal's width. Every other surface in this node renders into a block that can afford the
 * extra columns; this one cannot, so it is the one place a width-conditional omission is right.
 *
 * When the full line does not fit, the **provider** is dropped and the model is kept — never the
 * other way round, and neither is ever truncated. The model is the more informative half (it is
 * what the user chose), and a clipped `openrou…` or `claude-sonnet-4…` is misleading rather than
 * merely terse, which is the same reason the launch banner DROPS a version it cannot fit instead
 * of clipping it. Dropping the provider costs the disambiguation this node adds; clipping either
 * half would cost correctness.
 *
 * Below the budget the bar still overflows if the bare model alone is too wide. That is untouched
 * pre-existing behaviour: this function only guarantees that ADDING the provider cannot be what
 * pushes the line over.
 */
export function statusBarSegments(input: {
  mode: string;
  modelDisplayName?: string;
  modelProviderType?: string;
  turnCount?: number;
  /**
   * Columns already spoken for by the sibling `<Text>` nodes on this same line (the approvals
   * badge, the debug hint). They are separate nodes so they can carry their own colour, but the
   * terminal wraps the row as a whole, so the budget has to know about them.
   */
  reservedColumns?: number;
  /** Live `stdout.columns`; `undefined` (non-TTY / tests) falls back to 80, as `ruleWidth` does. */
  columns?: number;
}): string {
  const columns =
    typeof input.columns === 'number' && Number.isFinite(input.columns)
      ? Math.floor(input.columns)
      : DEFAULT_COLUMNS;
  const budget = columns - (input.reservedColumns ?? 0);

  const build = (modelSegment: string | null): string =>
    [input.mode, modelSegment, `turns: ${input.turnCount ?? 0}`, 'ready']
      .filter(Boolean)
      .join(SEPARATOR);

  const model = input.modelDisplayName?.trim();
  if (!model) return build(null);

  // The shared `model (provider)` spelling (DL-6) — never a second local template.
  const withProvider = build(`model: ${modelProviderLabel(model, input.modelProviderType)}`);
  // Nothing to drop when no provider resolved: the label is already the bare model.
  if (!input.modelProviderType?.trim()) return withProvider;
  return displayWidth(withProvider) <= budget ? withProvider : build(`model: ${model}`);
}

/**
 * Session status bar. While a turn is running it shows a spinner + interrupt hint;
 * otherwise it surfaces useful session context — the mode, the model and the provider serving it,
 * and a turn counter — on a single dim line. Streaming progress itself is shown by the live
 * turn, not here, so this bar stays stable (one line) and does not flicker.
 */
export function StatusBar({
  running,
  mode,
  modelDisplayName,
  modelProviderType,
  turnCount,
  debugHint,
  approvals,
  columns,
}: {
  running: boolean;
  mode: string;
  modelDisplayName?: string;
  /**
   * CFG-38 — `config.modelProviderType`, rendered as `model: <model> (<provider>)`. Absent for a
   * module config (which hands the loader an already-built model), and dropped on a terminal too
   * narrow to carry it — see {@link statusBarSegments}.
   */
  modelProviderType?: string;
  /** Live terminal width, for the provider's fit decision. Unknown falls back to 80 columns. */
  columns?: number;
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
  // CFG-38 — the badge's TEXT is built first and its element second, so the width budget below can
  // measure what this sibling node will occupy. Rendering it straight into JSX (as before) left the
  // string unavailable to anything but the terminal.
  const approvalsBadgeText = approvals
    ? approvals.rung === 'bypass'
      ? ' ⚡ Bypass'
      : isRatedRung(approvals.rung)
        ? `  ·  approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]} (${approvals.raterProfile ?? 'auto-rater'})`
        : `  ·  approvals: ${APPROVAL_RUNG_LABELS[approvals.rung]}`
    : undefined;

  const approvalsBadge = approvals ? (
    approvals.rung === 'bypass' ? (
      <Text color="yellow" bold>
        {approvalsBadgeText}
      </Text>
    ) : (
      <Text dimColor>{approvalsBadgeText}</Text>
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

  const segments = statusBarSegments({
    mode,
    modelDisplayName,
    modelProviderType,
    turnCount,
    reservedColumns:
      displayWidth(approvalsBadgeText ?? '') + (debugHint ? displayWidth(DEBUG_HINT_TEXT) : 0),
    columns,
  });

  return (
    <Box>
      <Text dimColor>{segments}</Text>
      {approvalsBadge}
      {debugHint ? <Text dimColor>{DEBUG_HINT_TEXT}</Text> : null}
    </Box>
  );
}
