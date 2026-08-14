/**
 * @module reviewHeading
 * REL-12 — the two lines every `gth review` / `gth pr` run opens with, so a reader of the output
 * knows whose review it is.
 *
 * User-facing CLI feedback, so it is governed by `maintenance/ux-guidelines.md` § Review
 * attribution, and it serves three of the Design Language principles: **DL-4** (transparency — a
 * reader of the output knows what produced it), **DL-6** (cross-surface consistency — the model half
 * reuses the launch banner's one `model (provider)` spelling rather than a second one), and **DL-7**
 * (graceful degradation — drop the label rather than mislead, exactly as the banner drops a version
 * that will not fit).
 *
 * ## Why the product emits this and not the workflow
 *
 * The review is usually read somewhere the command is not visible: a PR comment posted by a bot
 * account, a `review.md` attached to a ticket, a CI log. Stripped of the invocation, an unlabelled
 * AI review on a pull request is simply assumed to be whichever AI reviewer the reader already
 * knows. Putting the attribution in the CLI's own output means any workflow that runs `gth` and
 * posts what it produced carries it, with no wiring of its own.
 *
 * ## Why the heading is a constant and the mode is not in it
 *
 * {@link REVIEW_HEADING} is the same string on every run, because its one job is to be recognisable
 * to someone who has never heard of this tool. The MODE lives on the attribution line below it
 * instead: a heading that named the mode would have to change when a second review mode landed,
 * turning the constant into a branch, and the reader gains nothing from a distinction they cannot
 * make. The attribution line is dynamic anyway — it renders the live model.
 *
 * ## Why it is deliberately two lines and no more
 *
 * A review is read for its findings. Everything above the first finding pushes that finding down,
 * so the block is a heading plus one line: no rule, no box, no timestamp, no version, no restated
 * repo/branch/PR. The cost of a bigger banner is paid by every reader of every review.
 */
import { modelProviderLabel } from '@gaunt-sloth/core/core/launchBanner.js';

/**
 * The heading, verbatim. Markdown `##` because the primary surfaces — a PR comment and the
 * `writeOutputToFile` report — are markdown; the terminal shows it literally, exactly as it already
 * shows every markdown heading a model writes.
 */
export const REVIEW_HEADING = '## Gaunt Sloth: Code Review';

/**
 * The review mode, as the attribution line names it. `review` / `pr` are one-shot: the diff goes in,
 * the verdict comes out, and nothing carries over between runs — which is what makes a verdict
 * impossible to argue down across a conversation, and why the mode is worth naming.
 */
export const REVIEW_MODE_LABEL = 'stateless review';

/** Separates the mode from the model on the attribution line. */
const ATTRIBUTION_SEPARATOR = ' · ';

/**
 * Build the heading block: the heading, a blank line, the attribution line, and a trailing newline
 * so the review body does not start flush against it.
 *
 * The model half is the SHARED `model (provider)` spelling ({@link modelProviderLabel}), the same
 * one the launch banner renders, rather than a second spelling of the same fact.
 *
 * Both halves of the model are allowed to be missing, and neither prints a placeholder:
 *
 * - **No provider** — a `.gsloth.config.js` module config hands the loader an already-built
 *   `BaseChatModel` and legitimately has no provider string. The bare model prints; there is no
 *   `(unknown)` and no empty `()`.
 * - **No model** — the label is dropped entirely and the line is just the mode. A provider name on
 *   its own would sit exactly where a model name sits and read as one, and a misidentified model in
 *   a review someone later quotes is worse than an absent one. That is the same drop-rather-than-
 *   mislead rule the banner applies to a version that does not fit.
 */
export function reviewHeadingBlock(model?: string, provider?: string): string {
  const label = model?.trim() ? modelProviderLabel(model, provider) : undefined;
  const attribution = label ? REVIEW_MODE_LABEL + ATTRIBUTION_SEPARATOR + label : REVIEW_MODE_LABEL;
  return `${REVIEW_HEADING}\n\n${attribution}\n`;
}
