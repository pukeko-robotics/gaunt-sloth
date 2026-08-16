/**
 * @module reviewHeading
 * REL-12 — the line every `gth review` / `gth pr` run opens with, so a reader of the output knows
 * whose review it is and what produced it.
 *
 * User-facing CLI feedback, so it is governed by `maintenance/ux-guidelines.md` § The run header,
 * and it serves three of the Design Language principles: **DL-4** (transparency — a
 * reader of the output knows what produced it), **DL-6** (cross-surface consistency — it renders
 * through the shared `runHeaderLine`, so the review document and the agent's own run header are one
 * string and not two that happen to match), and **DL-7** (graceful degradation — drop the label
 * rather than mislead, exactly as the banner drops a version that will not fit).
 *
 * ## Why the product emits this and not the workflow
 *
 * The review is usually read somewhere the command is not visible: a PR comment posted by a bot
 * account, a `review.md` attached to a ticket, a CI log. Stripped of the invocation, an unlabelled
 * AI review on a pull request is simply assumed to be whichever AI reviewer the reader already
 * knows. Putting the attribution in the CLI's own output means any workflow that runs `gth` and
 * posts what it produced carries it, with no wiring of its own.
 *
 * ## Why it names the command, and why that is one line and no more
 *
 * The word after the product name is the command the USER typed — `review` or `pr` — which is the
 * one thing a reader of a detached review cannot recover for themselves. It is the same header
 * every other command opens with, so a reader who has seen one has seen all of them.
 *
 * A review is read for its findings. Everything above the first finding pushes that finding down,
 * so the header is one line: no markdown heading, no rule, no box, no timestamp, no version, no
 * restated repo/branch/PR. The cost of a bigger banner is paid by every reader of every review.
 *
 * It is not, however, unconditional. `output.header: none` drops it (the gate is at the emission
 * site in `reviewModule.ts`, not here — this module builds the line and does not decide whether it
 * is shown), because a caller piping a review into their own template needs a byte-clean stream.
 * That rung is opt-in precisely so the reasoning above survives for everyone who does not set it.
 */
import { modelProviderLabel } from '@gaunt-sloth/core/core/modelLabel.js';
import { runHeaderLine } from '@gaunt-sloth/core/core/runHeader.js';

/**
 * Build the review's opening header: `Gaunt Sloth · <command> · <model> (<provider>)`, plus a
 * trailing newline so the review body does not start flush against it.
 *
 * The line is assembled by the SHARED {@link runHeaderLine}, and the model half by the SHARED
 * `model (provider)` spelling ({@link modelProviderLabel}) — the same two the agent's own run
 * header uses, rather than a second spelling of the same facts.
 *
 * Both halves of the model are allowed to be missing, and neither prints a placeholder:
 *
 * - **No provider** — a `.gsloth.config.js` module config hands the loader an already-built
 *   `BaseChatModel` and legitimately has no provider string. The bare model prints; there is no
 *   `(unknown)` and no empty `()`.
 * - **No model** — the label is dropped entirely and the line ends after the command. A provider
 *   name on its own would sit exactly where a model name sits and read as one, and a misidentified
 *   model in a review someone later quotes is worse than an absent one. That is the same
 *   drop-rather-than-mislead rule the banner applies to a version that does not fit.
 */
export function reviewHeadingBlock(
  command: 'pr' | 'review',
  model?: string,
  provider?: string
): string {
  const label = model?.trim() ? modelProviderLabel(model, provider) : undefined;
  return `${runHeaderLine(command, label)}\n`;
}
