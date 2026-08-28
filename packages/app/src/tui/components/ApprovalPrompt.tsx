import React from 'react';
import { Box, Text } from 'ink';
import { Rule } from '#src/tui/components/Rule.js';
import {
  APPROVAL_ASK_LINE,
  APPROVAL_DETAILS_ABOVE_LINE,
  approvalCategoryLine,
} from '@gaunt-sloth/core/core/approvals/approvalRequest.js';
import type { PendingToolInterrupt } from '@gaunt-sloth/core/core/types.js';

/**
 * The scoped tool-approval affordance (EXT-9 Phase B2) — the Ink TUI counterpart to the readline
 * escalation prompt. Shown whenever the gate suspends on a call a human must answer: a shell
 * command, a built-in write tool, an MCP tool or a custom one. While it is mounted the parent
 * `<App>` routes keyboard input here and suspends the normal prompt, so the command can't be typed
 * into the chat box.
 *
 * ## [[EXT-137]] — this block carries only text WE wrote, and that is structural
 *
 * It is pinned in the dock, which never scrolls, so anything it holds is bounded by the terminal
 * rather than by the text. Four lines, and every one of them is a constant or one of four
 * enumerated sentences:
 *
 * 1. `APPROVAL_ASK_LINE` — Gaunt Sloth is asking, and this is what it is waiting on.
 * 2. the CATEGORY — one of `APPROVAL_CATEGORY_LINES`, chosen by looking at the call and never
 *    built from it.
 * 3. `APPROVAL_DETAILS_ABOVE_LINE` — where the call itself went.
 * 4. the menu, assembled from *which controls are on offer* — two booleans, not two strings.
 *
 * **Nothing model-authored, server-authored or user-authored is interpolated into any of them.**
 * The predecessor rendered the gate's note here, which reproduced a host "only when it could do so
 * safely and in full" — a hundred characters — so padding a URL's path past the bound degraded the
 * one line a person reads to `(1 not shown here)`, and the author of a hostile URL chose whether
 * this block named a host at all. Every repair that keeps the text moves the boundary; removing the
 * text leaves the boundary nothing to bound. **A pull request that interpolates one call-derived
 * character back into this component reopens that, however short the value looks** —
 * `approvalFixedBlockBytes.spec.tsx` fails on it.
 *
 * **The category is what keeps this block worth reading.** A fixed block reading only *Gaunt Sloth
 * has a message for you* would trade a truncation problem for an attention problem: it gives the
 * reader no reason to look up before pressing a key, and the failure mode becomes a reflexive
 * keystroke rather than a missing hostname.
 *
 * Everything else — the rating, the `approvals.escalate` entry, the §5 negotiation, what a sticky
 * answer would store, the command and the hosts — is painted by `<ApprovalRequestPanel>`, where the
 * conversation scrolls. [[TUI-C99]] — while the question is open that block is a child of the
 * viewport, drawn under the live turn; once it is answered the call's own row carries a one-line
 * outcome and Ctrl+T reopens the block there. It is not committed as an `approval` transcript item
 * on the ask: that item kind is the FALLBACK for an answer that could not be attributed to a row,
 * and `types.ts` says when it is reached. **That block is the destination wherever it is drawn, and
 * the prohibition above holds whichever of the two it is** — nothing call-derived is interpolated
 * into these four lines.
 *
 * ## The keyboard model, which this component does not own
 *
 * The key handling (`o` → approve once, `s`/`a` → approve with that scope, `d` → refuse and save
 * it, anything else → refuse once) lives in `<App>`'s `useInput`, mirroring the way the debug
 * panel's scroll keys are owned by the root component.
 *
 * **The safe action is the FALLTHROUGH, and adding a key must not erode that.** `o` grants once;
 * `s`/`a` grant and `d` refuses for good, each *only where that control is on offer*; and
 * everything else — Enter, Esc, a stray keystroke, any letter with Ctrl held — refuses once and
 * records nothing. Withdrawing a control from this menu withdraws its key with it, or the
 * withdrawal is cosmetic and the command runs anyway. Doing nothing in particular stays safe.
 *
 * **Each sticky control is SHOWN only where the gate would actually store something**, and the two
 * are not the same condition: a command the gate cannot statically resolve can be refused for good
 * though it can never be approved for one call, and a `catastrophic` verdict withdraws the grants
 * while leaving the refusal (§4.2 is about what may be allowed, never about what may be refused).
 * Absent, never disabled — §6 calls a control offered and then refused a bug.
 *
 * There is no rung-switching key — the ladder has no "turn the gate down from here" action, so
 * binding one would mean inventing it — and §6's *ask to explain* is deliberately absent until it
 * exists (it has no decision type, no explanation field and no path for a suspended run to ask its
 * own model anything; it is filed as EXT-104). A menu control that does nothing is worse than an
 * absent one.
 */
export function ApprovalPrompt({ pending }: { pending: PendingToolInterrupt }): React.ReactElement {
  // Built from parts rather than nested ternaries: the menu is two independent choices (a grant on
  // offer, a refusal on offer) and spelling out all four combinations by hand is how a menu line
  // nobody asserted reaches a terminal. The two conditions are the PRESENCE of a preview, never its
  // text — which is what keeps this line, like the three above it, un-paddable.
  const menu = [
    '[o]nce',
    ...(pending.grantPreview !== undefined ? ['[s]ession', '[a]lways'] : []),
    '[N]o',
    ...(pending.denyPreview !== undefined ? ['[d]eny always'] : []),
  ].join('   ');
  return (
    <Box flexDirection="column">
      <Rule />
      <Text bold color="yellow">
        {APPROVAL_ASK_LINE}
      </Text>
      <Text color="yellow">{approvalCategoryLine(pending)}</Text>
      <Text dimColor>{APPROVAL_DETAILS_ABOVE_LINE}</Text>
      <Text dimColor>{`Approve?  ${menu}`}</Text>
    </Box>
  );
}
