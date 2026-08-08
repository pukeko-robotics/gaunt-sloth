import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { renderNegotiationTranscript } from '@gaunt-sloth/core/core/shell/negotiation.js';
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
  // [[EXT-29]] §6 — when a §5 negotiation preceded this escalation, the human is shown ALL of it.
  // The question is never "may this command run": that the agent proposed the same command three
  // times unchanged, against two rejections that each told it what to fix, is the most important
  // thing on the screen, and a prompt showing the final attempt alone asks the user to rule on a
  // command when the decision they actually have is about an argument. Rendered through core's
  // shared renderer — the same one the readline prompt and the §6.2 non-interactive message use —
  // so no two surfaces describe one exchange differently. `null` whenever there were no rounds
  // (`catastrophic`, a declared escalate entry, an unrated rung), so nothing draws a heading over
  // an argument that never happened.
  const negotiation = renderNegotiationTranscript(pending.negotiationRounds ?? []);
  // EXT-71/EXT-70 §6 — what a sticky choice will store, shown at the moment of the choice on every
  // surface. Under §3.1 a shell grant is the command itself as a fully-explicit exact entry, not a
  // pattern derived from it; for a tool call the stored thing is the TOOL, its server and the host
  // bound, never the arguments (§4.7.4) — which is the one place a grant is deliberately broader
  // than what the human was shown, and therefore the one place the display carries most weight.
  //
  // `grantSummary` names it in the words the control is written in, through the same one-liner the
  // §4.7.4 withdrawal notice uses, so the menu and that notice can never describe one grant two
  // ways. `grantPreview` is the exact entry that lands in the store.
  //
  // **Absent means the control is not offered at all**, never offered-and-disabled: a disabled
  // control invites the user to hunt for why, and §6 calls a control that is offered and then
  // refused a bug rather than a policy. Absent covers a `catastrophic` outcome (§4.2), a command
  // that does not statically resolve, a call naming several hosts, and a call whose MCP server
  // could not be attributed.
  const grantPreview = pending.grantPreview;
  const grantSummary = pending.grantSummary;
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
      {negotiation ? <Text color="yellow">{negotiation}</Text> : null}
      {grantPreview ? (
        <>
          <Text dimColor>{`[s]/[a] will remember ${grantSummary ?? grantPreview}`}</Text>
          <Text dimColor>{`    stored as ${grantPreview}`}</Text>
        </>
      ) : null}
      <Text dimColor>
        {grantPreview
          ? 'Approve?  [o]nce   [s]ession   [a]lways   [N]o'
          : 'Approve?  [o]nce   [N]o'}
      </Text>
    </Box>
  );
}
