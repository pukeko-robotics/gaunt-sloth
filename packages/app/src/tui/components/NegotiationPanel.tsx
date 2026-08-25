import React from 'react';
import { Box, Text, useStdout } from 'ink';
import {
  renderNegotiationRows,
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
 * **Rendered through core's shared `renderNegotiationRows`, one round at a time**, at this
 * terminal's framing width. It is the same renderer, the same labels and the same row bound the
 * escalation prompt draws, so the exchange a person watched and the exchange they are later asked
 * to rule on cannot be two different accounts of one argument. The width matters for the same
 * reason it does there: a long justification left to Ink's own wrap continues at column 0, which
 * is the flush-left forgery the framing exists to prevent.
 */
export function NegotiationPanel({
  rounds,
}: {
  rounds: readonly LiveNegotiationRound[];
}): React.ReactElement | null {
  const { stdout } = useStdout();
  const width = frameWidthFor(stdout?.columns);
  if (rounds.length === 0) return null;
  return (
    <Box flexDirection="column">
      {rounds.map(({ round, position, agreed }, index) =>
        renderNegotiationRows([round], {
          width,
          mode: 'live',
          from: position,
          ...(agreed ? { agreed } : {}),
        }).map((row, r) => (
          <Text key={`${index}-${r}`} color={voiceColour(row.voice)}>
            {row.text}
          </Text>
        ))
      )}
    </Box>
  );
}
