import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { renderNegotiationTranscript } from '@gaunt-sloth/core/core/shell/negotiation.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
  type FramedUntrustedText,
} from '@gaunt-sloth/core/core/shell/framing.js';
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
 *
 * [[TUI-C26]] — **every model-authored string on this dialog is painted through
 * `core/shell/framing`**, never raw: the command, the rater's reason, and what a sticky choice
 * would store. That module owns the neutralisation, the line-number gutter, the extracted
 * substitution/composition sites and the elision; this component owns only colour and order. The
 * split is EXT-29's — one renderer, two surfaces — and here it is what stops the Ink prompt and the
 * readline prompt disagreeing about how much of a command a human was actually shown.
 */
export function ApprovalPrompt({ pending }: { pending: PendingToolInterrupt }): React.ReactElement {
  const commandText =
    typeof pending.args.command === 'string'
      ? (pending.args.command as string)
      : JSON.stringify(pending.args);
  // The framing wraps to the terminal ITSELF, one gutter per physical row, so Ink never has to.
  // A terminal's own wrap starts the continuation at column 0, which is exactly the flush-left
  // forgery the gutter exists to prevent — so the width has to be known here rather than left to
  // the renderer. Core resolves it (and the column it holds back) for both surfaces, so the Ink
  // and readline prompts cannot come to disagree about how much of a command a human was shown.
  const { stdout } = useStdout();
  const width = frameWidthFor(stdout?.columns);
  // Below core's floor the frame is wider than the terminal, so the terminal wraps it and untrusted
  // text reaches the left edge. The frame is still rendered — dropping it would hide the text the
  // human is ruling on — but the guarantee has lapsed, and a lapsed guarantee is said out loud.
  const tooNarrow = narrowTerminalNotice(stdout?.columns);
  const framedCommand = frameUntrustedCommand(commandText, { width });
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
      {tooNarrow ? <Text color="yellow">{tooNarrow}</Text> : null}
      {/* Rule 3 — the flagged sites go ABOVE the body, in the warn tone, because their whole job is
          to land the eye on the span the human is ruling on rather than on line one of a paragraph. */}
      {framedCommand.notices.map((line, index) => (
        <Text key={`command-notice-${index}`} color="yellow">
          {line}
        </Text>
      ))}
      {framedCommand.lines.map((line, index) => (
        <Text key={`command-line-${index}`} dimColor>
          {line}
        </Text>
      ))}
      {verdict ? (
        <>
          {/* The outcome is a schema enum and is renderer-owned; the reason is model-authored prose
              and is framed exactly like the command. Protecting one and not the other would leave
              the dialog forgeable through the string that is meant to explain it. */}
          <Text color="yellow">{`⚠ Auto-rater (${verdict.outcome}):`}</Text>
          <FramedLines framed={frameUntrustedText(verdict.reason, { width })} colour="yellow" />
        </>
      ) : null}
      {escalatedBy ? (
        <Text color="yellow">{`⚠ Your approvals.escalate list matched this call: ${escalatedBy}`}</Text>
      ) : null}
      {negotiation ? <Text color="yellow">{negotiation}</Text> : null}
      {grantPreview ? (
        <>
          {/* §6/EXT-70 — the sticky lines carry the command as typed, so they inherit the identical
              problem in less space: a trailing `approved by rater` fits on one line untouched. They
              are framed too, and the label is the renderer's own line so the untrusted half can
              never be mistaken for it. */}
          <Text dimColor>{'[s]/[a] will remember:'}</Text>
          <FramedLines framed={frameUntrustedText(grantSummary ?? grantPreview, { width })} />
          <Text dimColor>{'    stored as:'}</Text>
          <FramedLines framed={frameUntrustedText(grantPreview, { width })} />
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

/**
 * Paint an already-framed block, one Ink `<Text>` per physical row.
 *
 * **One row per element is the point, not a style.** A single `<Text>` holding the joined block
 * would be re-wrapped by Ink at the box width, and a re-wrapped row starts at column 0 — undoing
 * the gutter the framing exists to guarantee.
 */
function FramedLines({
  framed,
  colour,
}: {
  framed: FramedUntrustedText;
  colour?: string;
}): React.ReactElement {
  return (
    <>
      {framed.lines.map((line, index) =>
        colour ? (
          <Text key={`framed-${index}`} color={colour}>
            {line}
          </Text>
        ) : (
          <Text key={`framed-${index}`} dimColor>
            {line}
          </Text>
        )
      )}
    </>
  );
}
