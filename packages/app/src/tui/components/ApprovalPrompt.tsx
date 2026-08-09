import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import { FramedLines } from '#src/tui/components/FramedLines.js';
import {
  renderNegotiationRows,
  type NegotiationVoice,
} from '@gaunt-sloth/core/core/shell/negotiation.js';
import {
  describeRaterOutcome,
  RATER_REASON_LABEL,
  type EscalationTone,
} from '@gaunt-sloth/core/core/shell/escalationSeverity.js';
import {
  frameUntrustedCommand,
  frameUntrustedText,
  frameWidthFor,
  narrowTerminalNotice,
  STICKY_PREVIEW_MAX_ROWS,
} from '@gaunt-sloth/core/core/shell/framing.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';

/**
 * §6 — how loud the dialog is about an outcome, in Ink's vocabulary.
 *
 * **Colour is the third signal here, never the only one.** The glyph and the sentence come from
 * core and arrive on a monochrome terminal, under `NO_COLOR` and through a pipe; this adds hue for
 * the reader who has it. `catastrophic` is red where `destructive` is yellow because those two must
 * not be able to look alike — but a change that made them the same colour would still leave the
 * words different, and that is the design rather than a happy accident.
 */
const toneColour = (tone: EscalationTone): string =>
  tone === 'danger' ? 'red' : tone === 'warn' ? 'yellow' : 'cyan';

/**
 * §5.4 — the two voices of a negotiation, kept apart by colour. The rater's turns are yellow
 * *because the spec says so*: the human is ruling on an argument, and an exchange painted in one
 * colour asks them to work out who said what before they can start.
 */
const voiceColour = (voice: NegotiationVoice): string | undefined =>
  voice === 'rater' ? 'yellow' : undefined;

/**
 * The scoped tool-approval affordance (EXT-9 Phase B2) — the Ink TUI counterpart to the readline
 * escalation prompt. Shown when a `run_shell_command` interrupt is pending; styled like a warn-tone
 * {@link CommandNotice} (yellow bold title + dim body bracketed by a rule) so it reads consistently
 * in the transcript dock. While it is mounted the parent `<App>` routes keyboard input here and
 * suspends the normal prompt, so the command can't be typed into the chat box.
 *
 * Pure/presentational: it only renders the pending command + the choices. The key handling
 * (`o` → approve once, `s`/`a` → approve with that scope, `d` → refuse for the session, anything
 * else → refuse once) lives in `<App>`'s `useInput`, mirroring the way the debug panel's scroll
 * keys are owned by the root component.
 *
 * The menu is `[o]nce`, `[s]ession`, `[a]lways`, `[N]o` and `[d]eny always`. There is no
 * rung-switching key — the ladder has no "turn the gate down from here" action, so binding one
 * would mean inventing it — and §6's *ask to explain* is deliberately absent until it exists (it
 * has no decision type, no explanation field and no path for a suspended run to ask its own model
 * anything; it is filed as EXT-104). A menu control that does nothing is worse than an absent one.
 *
 * **The safe action is the FALLTHROUGH, and adding a key must not erode that.** `o` grants once;
 * `s`/`a` grant and `d` refuses for the session, each *only where that control is on offer*; and
 * everything else — Enter, Esc, a stray keystroke, any letter with Ctrl held — refuses once and
 * records nothing. Withdrawing a control from this menu withdraws its key with it, or the
 * withdrawal is cosmetic and the command runs anyway. Doing nothing in particular stays safe.
 *
 * **Each sticky control is SHOWN only where the gate would actually store something**, and the two
 * are not the same condition: a command the gate cannot statically resolve can be refused for the
 * session though it can never be approved for it, and a `catastrophic` verdict withdraws the
 * grants while leaving the refusal (§4.2 is about what may be allowed, never about what may be
 * refused). Absent, never disabled — §6 calls a control offered and then refused a bug.
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
  // so no two surfaces describe one exchange differently. Empty whenever there were no rounds
  // (`catastrophic`, a declared escalate entry, an unrated rung), so nothing draws a heading over
  // an argument that never happened.
  //
  // [[TUI-C26]] §5.4 — rows, not one string. The rater's turns are yellow so the two voices are
  // never confused, which a single joined string cannot express: painted as one block, the agent's
  // justification and the rater's answer were the same colour. The width is passed for the same
  // reason the command's is — a long justification left to Ink's own wrap continues at column 0,
  // which is the forgery the framing exists to prevent, reached through the one block that was not
  // framed.
  const negotiation = renderNegotiationRows(pending.negotiationRounds ?? [], { width });
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
  // [[TUI-C26]] §6 — the deny mirror, and it is a DIFFERENT condition. The runner computes it from
  // the entry an *always reject* would record, which exists in cases where no grant does: the
  // matcher's rule is undecidable → no match on the allow side, a match on the deny side, so a
  // command the gate could not resolve can be refused for the session though it can never be
  // approved for one. Reading this off `grantPreview` would withdraw the control from exactly the
  // prompts it is most useful on.
  const denyPreview = pending.denyPreview;
  const denySummary = pending.denySummary;
  // §6 — the verdict's severity in the gate's own words, glyph and tone: `catastrophic` must not be
  // able to look like `destructive`, and it must say so for a reader who has no colour at all.
  const severity = verdict ? describeRaterOutcome(verdict.outcome) : undefined;
  // Built from parts rather than nested ternaries: the menu is two independent choices (a grant on
  // offer, a refusal on offer) and spelling out all four combinations by hand is how a menu line
  // nobody asserted reaches a terminal.
  const menu = [
    '[o]nce',
    ...(grantPreview ? ['[s]ession', '[a]lways'] : []),
    '[N]o',
    ...(denyPreview ? ['[d]eny always'] : []),
  ].join('   ');
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
      {verdict && severity ? (
        <>
          {/* The heading is the gate's own sentence — the outcome, and what that outcome MEANS for
              undoing it — so the severity survives a monochrome terminal. The reason beneath it is
              model-authored prose, framed exactly like the command: protecting one and not the
              other would leave the dialog forgeable through the string that is meant to explain it.
              The label between them keeps the attribution honest now that the line above is ours. */}
          <Text color={toneColour(severity.tone)}>{severity.heading}</Text>
          <Text dimColor>{RATER_REASON_LABEL}</Text>
          <FramedLines
            framed={frameUntrustedText(verdict.reason, { width })}
            colour={toneColour(severity.tone)}
          />
        </>
      ) : null}
      {escalatedBy ? (
        <>
          {/* [[TUI-C26]] — framed, not interpolated. The ordinary escalate entry is something the
              user wrote, but an MCP entry can carry server-supplied names, and this line is one
              string away from the dialog's own chrome. The label stays this component's line. */}
          <Text color="yellow">{'⚠ Your approvals.escalate list matched this call:'}</Text>
          <FramedLines framed={frameUntrustedText(escalatedBy, { width })} colour="yellow" />
        </>
      ) : null}
      {negotiation.map((row, index) => (
        <Text
          key={`negotiation-${index}`}
          color={voiceColour(row.voice)}
          dimColor={row.voice === 'chrome'}
        >
          {row.text}
        </Text>
      ))}
      {grantPreview ? (
        <>
          {/* §6/EXT-70 — the sticky lines carry the command as typed, so they inherit the identical
              problem in less space: a trailing `approved by rater` fits on one line untouched. They
              are framed too, and the label is the renderer's own line so the untrusted half can
              never be mistaken for it. */}
          {/* Bounded to a few rows: for a shell call these carry the command as typed, which is
              already on screen above in full — so an unbounded copy of a long command here (twice
              over, since the entry repeats it) pushes the MENU off the bottom of the terminal, and
              a control the human cannot see is not a control they were offered. */}
          <Text dimColor>{'[s]/[a] will remember:'}</Text>
          <FramedLines
            framed={frameUntrustedText(grantSummary ?? grantPreview, {
              width,
              maxRows: STICKY_PREVIEW_MAX_ROWS,
            })}
          />
          <Text dimColor>{'    stored as:'}</Text>
          <FramedLines
            framed={frameUntrustedText(grantPreview, { width, maxRows: STICKY_PREVIEW_MAX_ROWS })}
          />
        </>
      ) : null}
      {denyPreview ? (
        <>
          {/* §6 requires the menu to display what it is about to store for BOTH sticky choices, in
              the words the control is written in. Framed like the grant lines and for the identical
              reason — they carry the command as typed.

              `recorded as:` rather than a second `stored as:`: two identical labels on one dialog
              are ambiguous to a reader and, positionally, to anything that looks one up. The label
              also says the lifetime out loud, because there is no persisted deny store and a
              control that implied one would be promising something the gate does not do. */}
          <Text dimColor>{'[d] will refuse, for the rest of this session:'}</Text>
          <FramedLines
            framed={frameUntrustedText(denySummary ?? denyPreview, {
              width,
              maxRows: STICKY_PREVIEW_MAX_ROWS,
            })}
          />
          <Text dimColor>{'    recorded as:'}</Text>
          <FramedLines
            framed={frameUntrustedText(denyPreview, { width, maxRows: STICKY_PREVIEW_MAX_ROWS })}
          />
        </>
      ) : null}
      <Text dimColor>{`Approve?  ${menu}`}</Text>
    </Box>
  );
}
