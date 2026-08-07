import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { launchBannerFields, launchBannerRows } from '@gaunt-sloth/core/core/launchBanner.js';
import type { SlothAnimation } from '@gaunt-sloth/core/core/launchBanner.js';
import { useHitRegion } from '#src/tui/useMouse.js';
import { useSlothAnimation } from '#src/tui/useSlothAnimation.js';
import { useTerminalSize } from '#src/tui/useTerminalSize.js';

/**
 * TUI-C33 — the ASCII-art launch banner at the top of an interactive TUI session: a magenta sloth
 * face beside the `GAUNT SLOTH` wordmark, the version, the model/provider and the working
 * directory. It is an INTRO, not a fixture: `<App>` renders it under the same `showIntro` condition
 * as the ready message, so it disappears once the first exchange is underway and stops padding the
 * dock.
 *
 * All the geometry — the column-21 split, the per-field truncation budgets, the narrow-terminal
 * fallback — lives in the shared pure module `@gaunt-sloth/core/core/launchBanner.js`, which the
 * plain `--no-tui` surface renders from too, so the two surfaces cannot drift. This component only
 * turns rows into `<Text>`: the face half gets `color="magenta"` (Ink's own colour-support
 * detection handles NO_COLOR / dumb terminals, the counterpart of `getUseColour()` on the plain
 * surface) and the right half gets no colour at all.
 *
 * Like {@link import('#src/tui/components/Rule.js').Rule} it tracks the live terminal width and
 * re-renders on resize, because the truncation budgets are a function of it; callers may pass an
 * explicit `columns` instead (tests, or a caller that already measured).
 *
 * The TTY gate lives in the session module (next to TUI-C13's viewport bump), not here: production
 * only mounts `<App>` with `showLaunchBanner` when stdout is a real terminal.
 */
export function LaunchBanner({
  model,
  provider,
  columns,
  pickAnimation,
}: {
  /** `config.modelDisplayName`; absent in the fixture/e2e branch, where the line is omitted. */
  model?: string;
  /** `config.modelProviderType`; rendered as `model (provider)` when both are known. */
  provider?: string;
  /** Override for the live terminal width. */
  columns?: number;
  /** TUI-C40 — pin which animation a click plays. Tests only; production takes the random pick. */
  pickAnimation?: () => SlothAnimation;
}): React.ReactElement {
  // Re-render on resize, exactly as <Rule> does: read the live width from the frame's single
  // shared subscription. Recomputing is only string maths, so this stays cheap.
  const { columns: liveColumns } = useTerminalSize();

  // Version / project dir / home dir are fixed for the life of the session, so resolve them once
  // (the version read touches the filesystem).
  const fields = useMemo(() => launchBannerFields(model, provider), [model, provider]);

  // TUI-C40 — the animation is a swap of the face only; every other input to the geometry is
  // unchanged, so the fields cannot move and the truncation budgets cannot shift mid-play.
  const { face, play } = useSlothAnimation(pickAnimation);
  const rows = launchBannerRows({ ...fields, columns: columns ?? liveColumns, face });

  // Claim the whole block as clickable. `useHitRegion` is inert when mouse is off or the surface has
  // no mouse layer, so this costs a keyboard-only session nothing. The banner shows only before
  // the first exchange and is unmounted once the conversation starts, so it stops being clickable
  // because it stops existing.
  const ref = useHitRegion('launch-banner', (event) => {
    if (event.type === 'press') play();
  });

  return (
    <Box flexDirection="column" ref={ref}>
      {rows.map((row, index) =>
        // Row index is a stable key: the banner is always the same seven rows in the same order.
        // TUI-C36's blank padding rows are rendered as an explicit one-line-high box rather than an
        // empty <Text>: a <Text> with no content measures zero-high in Yoga and the padding row
        // simply vanishes, whereas a sized box is a real line and needs no whitespace to hold it
        // open (which would leave the frame with a trailing space).
        row.face || row.right ? (
          <Text key={index}>
            <Text color="magenta">{row.face}</Text>
            {row.right}
          </Text>
        ) : (
          <Box key={index} height={1} />
        )
      )}
    </Box>
  );
}
