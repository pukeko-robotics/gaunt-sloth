import React from 'react';
import { Box, Text, useStdout } from 'ink';
import {
  renderLiveNegotiationRows,
  type LiveNegotiationRound,
  type NegotiationVoice,
} from '@gaunt-sloth/core/core/shell/negotiation.js';
import { frameWidthFor } from '@gaunt-sloth/core/core/shell/framing.js';

/**
 * §5.4 — the two voices of a negotiation, kept apart by colour. The rater's turns are yellow
 * *because the spec says so*: an exchange painted in one colour asks the reader to work out who
 * said what before they can follow it.
 *
 * **Colour is the second signal, never the only one.** Each row also NAMES its speaker
 * (`agent justified:` / `rater answered:`), which is the half that survives a monochrome terminal,
 * `NO_COLOR`, a pipe, and a reader who cannot tell yellow from white. The identical mapping is
 * applied by the readline surface, from the identical rows.
 */
const voiceColour = (voice: NegotiationVoice): string | undefined =>
  voice === 'rater' ? 'yellow' : voice === 'chrome' ? 'cyan' : undefined;

/**
 * [[TUI-C69]] §5.4 — **the agent arguing with the auto-rater, on screen while it happens.**
 *
 * The whole justification for letting the agent argue with the rater at all is that a human can
 * watch it: *an argument conducted in the dark is a different thing from one that can be
 * interrupted.* Until this existed the exchange reached a person only at an escalation — that is,
 * only in the runs where the argument FAILED — so a negotiation that converged was invisible, and
 * the one thing on screen was a red row saying a tool had errored.
 *
 * It sits in the pinned dock rather than in the scrolling transcript because it is the state of
 * the run happening now: the rounds accumulate while the turn is in flight and the panel is
 * cleared when the next turn starts. The record survives independently — each refused round is
 * also a tool-call panel in the transcript, carrying the rater's own words beneath the command.
 *
 * **Rendered through core's shared `renderLiveNegotiationRows`, as a LIST**, at this terminal's
 * framing width. It is the same row bodies, the same labels and the same row bound the escalation
 * prompt draws, so the exchange a person watched and the exchange they are later asked to rule on
 * cannot be two different accounts of one argument. The width matters for the same reason it does
 * there: a long justification left to Ink's own wrap continues at column 0, which is the flush-left
 * forgery the framing exists to prevent.
 *
 * **The whole accumulated exchange goes in on every draw, and that is load-bearing rather than
 * incidental.** Handing the renderer one round at a time turned its `NEGOTIATION_MAX_ROUNDS_SHOWN`
 * cap into a no-op — a slice of a one-element array — and this panel sits in a dock that cannot
 * give up rows, so an unbounded exchange here is taken out of the conversation and eventually out
 * of the input prompt. Passing the list is what lets the bound bind.
 */
/**
 * TUI-C92 — the rows the panel occupies at `columns`: one per rendered row of the exchange, and
 * none while there is no exchange. The same rows the render draws, from the same renderer at the
 * same framing width, so `<App>` can take them off the slash menu's budget without a second model
 * of the panel.
 */
export function negotiationPanelRows(
  rounds: readonly LiveNegotiationRound[],
  columns: number | undefined
): number {
  if (rounds.length === 0) return 0;
  return renderLiveNegotiationRows(rounds, { width: frameWidthFor(columns) }).length;
}

export function NegotiationPanel({
  rounds,
}: {
  rounds: readonly LiveNegotiationRound[];
}): React.ReactElement | null {
  // Before the early return, deliberately: a hook must not sit behind a condition, or Ink's hook
  // order changes on the render where the exchange starts.
  const { stdout } = useStdout();
  const width = frameWidthFor(stdout?.columns);
  if (rounds.length === 0) return null;
  return (
    <Box flexDirection="column">
      {renderLiveNegotiationRows(rounds, { width }).map((row, index) => (
        <Text key={index} color={voiceColour(row.voice)}>
          {row.text}
        </Text>
      ))}
    </Box>
  );
}
