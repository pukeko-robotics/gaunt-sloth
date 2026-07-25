import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';

/**
 * The scoped tool-approval affordance (EXT-9 Phase B2) — the Ink TUI counterpart to the
 * readline `Approve? [o]nce / [s]ession / [a]lways / [N]o:` prompt. Shown when a
 * `run_shell_command` interrupt is pending; styled like a warn-tone {@link CommandNotice}
 * (yellow bold title + dim body bracketed by a rule) so it reads consistently in the
 * transcript dock. While it is mounted the parent `<App>` routes keyboard input here and
 * suspends the normal prompt, so the command can't be typed into the chat box.
 *
 * Pure/presentational: it only renders the pending command + the choices. The key handling
 * (o/s/a → approve, y → switch to rater-mediated auto, anything else → reject) lives in
 * `<App>`'s `useInput`, mirroring the way the debug panel's scroll keys are owned by the root
 * component.
 */
export function ApprovalPrompt({
  pending,
  raterEnabled,
}: {
  pending: PendingToolInterrupt;
  /**
   * CFG-26 — whether this session can rate at all (`approvals.rater.enabled`, the SAME signal the
   * runner's `decideToolApproval` uses, so the offer and the gate can never disagree). When false
   * the `[y]` affordance is omitted: offering "switch to auto-approve (AI rater)" in a session
   * with no rater would promise a mode that cannot exist here — the same class of lie as a status
   * badge that under-reports.
   */
  raterEnabled?: boolean;
}): React.ReactElement {
  const commandText =
    typeof pending.args.command === 'string'
      ? (pending.args.command as string)
      : JSON.stringify(pending.args);
  // CFG-26: when the AI rater escalated this command (rather than approving it or bouncing it
  // back to the model), show its tier + reason so the human has the rater's read before deciding.
  const verdict = pending.safetyVerdict;
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color="yellow">
        {`The agent wants to run a shell command via ${pending.name}`}
      </Text>
      <Text dimColor>{`    ${commandText}`}</Text>
      {verdict ? (
        <Text color="yellow">{`⚠ AI rater (${verdict.tier}): ${verdict.reason}`}</Text>
      ) : null}
      <Text dimColor>
        {raterEnabled
          ? 'Approve?  [o]nce   [s]ession   [a]lways   [y] switch to auto-approve (AI rater)   [N]o'
          : 'Approve?  [o]nce   [s]ession   [a]lways   [N]o'}
      </Text>
    </Box>
  );
}
