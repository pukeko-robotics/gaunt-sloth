import React from 'react';
import { Text } from 'ink';
import type { FramedUntrustedText } from '@gaunt-sloth/core/core/shell/framing.js';

/**
 * Paint an already-framed block, one Ink `<Text>` per physical row.
 *
 * **One row per element is the point, not a style.** A single `<Text>` holding the joined block
 * would be re-wrapped by Ink at the box width, and a re-wrapped row starts at column 0 — undoing
 * the gutter the framing exists to guarantee.
 *
 * **Single-sourced for exactly that reason.** This is the renderer every surface paints untrusted,
 * model-authored text through — the approval dialog and the §6.1 attack banner both — and the
 * mistake it exists to prevent is silent: a joined block looks like ordinary output right up to the
 * row that reaches column 0 and forges the chrome around it. A second copy is a second place for
 * that to be got wrong, on the screens where being wrong costs the most.
 *
 * `colour` paints the body rows; unset means dim, which is what a surface uses for text it is
 * quoting rather than warning about.
 */
export function FramedLines({
  framed,
  colour,
  notices,
}: {
  framed: FramedUntrustedText;
  /** The colour for the body rows. Unset paints them dim. */
  colour?: string;
  /** Paint the renderer's flagged-site notices above the body (a command has them; prose does not). */
  notices?: boolean;
}): React.ReactElement {
  return (
    <>
      {notices
        ? framed.notices.map((line, index) => (
            <Text key={`framed-notice-${index}`} color="yellow">
              {line}
            </Text>
          ))
        : null}
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
