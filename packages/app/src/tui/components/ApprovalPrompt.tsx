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
 * (o/s/a → approve, anything else → reject) lives in `<App>`'s `useInput`, mirroring the way the
 * debug panel's scroll keys are owned by the root component.
 *
 * CFG-27 dropped the `[y]` affordance ("switch to auto-approve"). Spec §6 offers the human five
 * choices — ask to explain · approve · always approve · reject · always reject — and a per-prompt
 * change of RUNG is not among them: the ladder deliberately has no "turn the gate down from
 * here" action. [[TUI-C26]] owns building that five-choice menu (and the §6.1 attack banner, plus
 * withdrawing `always` for a `catastrophic` outcome); until it lands this stays the EXT-9 scoped
 * prompt, minus the choice the ladder no longer has.
 */
export function ApprovalPrompt({ pending }: { pending: PendingToolInterrupt }): React.ReactElement {
  const commandText =
    typeof pending.args.command === 'string'
      ? (pending.args.command as string)
      : JSON.stringify(pending.args);
  // CFG-27: when the auto-rater escalated this command (rather than approving it), show its
  // outcome + reason so the human has the rater's read before deciding. §6 makes the explanation
  // mandatory whenever a rating exists; at the unrated rungs there is none and the prompt shows
  // the command alone.
  const verdict = pending.safetyVerdict;
  // EXT-71 §3.2 — the declared `approvals.escalate` entry that brought this call here, when one
  // did. It is the provenance that makes the question traceable to the line the user wrote; an
  // escalation they cannot trace reads as the gate malfunctioning rather than as their own rule.
  const escalatedBy = pending.escalatedBy;
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color="yellow">
        {`The agent wants to run a shell command via ${pending.name}`}
      </Text>
      <Text dimColor>{`    ${commandText}`}</Text>
      {verdict ? (
        <Text color="yellow">{`⚠ Auto-rater (${verdict.outcome}): ${verdict.reason}`}</Text>
      ) : null}
      {escalatedBy ? (
        <Text color="yellow">{`⚠ Your approvals.escalate list matched this call: ${escalatedBy}`}</Text>
      ) : null}
      <Text dimColor>{'Approve?  [o]nce   [s]ession   [a]lways   [N]o'}</Text>
    </Box>
  );
}
