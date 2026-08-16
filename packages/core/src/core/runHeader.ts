/**
 * @module runHeader
 * GS2-95 — the ONE spelling of the run header, the single line every command opens with.
 *
 * Two unrelated writers render it: the agent's `compact` rung
 * (`GthAbstractAgent#compactHeaderStatus`) and the review document's opening line
 * (`@gaunt-sloth/review`'s `reviewHeadingBlock`). They emit at different moments, through different
 * helpers, into different sinks — so the only thing that can keep them saying the same thing is a
 * shared builder rather than two templates that happen to match today.
 *
 * It is a leaf with **no imports at all**, for the reason `modelLabel` is: the agent reaches it
 * during module load, and pulling console/filesystem helpers in to format one line would drag that
 * graph along.
 *
 * The header carries no markdown, in any mode. The honest condition for a `##` prefix is not "this
 * run is under GitHub Actions" but "the consumer renders markdown", and those differ in both
 * directions — the Ink TUI renders markdown, a GHA *job log* does not while a GHA *step summary*
 * does. That property belongs to the SINK, and one run has several at once (the TUI on screen, a
 * posted PR comment, a session log on disk), so no single flag can be right for all of them.
 * Formatting a header is not worth a per-sink capability, so there is no prefix anywhere.
 */

/** The product name the header opens with — the part a reader is meant to recognise across runs. */
export const RUN_HEADER_NAME = 'Gaunt Sloth';

/** Separates the header's parts: U+00B7 MIDDLE DOT, padded with a space on each side. */
export const RUN_HEADER_SEPARATOR = ' · ';

/**
 * Build the run header: `Gaunt Sloth · <command> · <model> (<provider>)`.
 *
 * `command` is the name of the command the USER typed (`review`, `exec`, `eval`), never the init
 * verb that selects the agent's mode prompt — the two differ for every command that runs its work
 * through another verb's prompt, and a header naming the verb misnames the run.
 *
 * `label` is the caller's already-resolved `model (provider)` half — `modelProviderLabel`'s one
 * spelling of "which model served this run" (DL-6). It is resolved by the caller rather than here
 * because the two writers gate it differently, and it is **dropped rather than faked** when nothing
 * resolves (DL-7): the line then ends after the command, with no placeholder and no empty `()`.
 */
export function runHeaderLine(command: string, label?: string): string {
  const head = RUN_HEADER_NAME + RUN_HEADER_SEPARATOR + command;
  return label ? head + RUN_HEADER_SEPARATOR + label : head;
}
