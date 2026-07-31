import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { launchBannerFields, launchBannerRows } from '@gaunt-sloth/core/core/launchBanner.js';

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
}: {
  /** `config.modelDisplayName`; absent in the fixture/e2e branch, where the line is omitted. */
  model?: string;
  /** `config.modelProviderType`; rendered as `model (provider)` when both are known. */
  provider?: string;
  /** Override for the live terminal width. */
  columns?: number;
}): React.ReactElement {
  const { stdout } = useStdout();
  // Re-render on resize, exactly as <Rule> does: keep the live column count in state and refresh
  // it from stdout's 'resize' event. Recomputing is only string maths, so this stays cheap.
  const [liveColumns, setLiveColumns] = useState<number | undefined>(stdout?.columns);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setLiveColumns(stdout.columns);
    // Sync once in case columns changed between initial state and effect subscription.
    onResize();
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Version / project dir / home dir are fixed for the life of the session, so resolve them once
  // (the version read touches the filesystem).
  const fields = useMemo(() => launchBannerFields(model, provider), [model, provider]);
  const rows = launchBannerRows({ ...fields, columns: columns ?? liveColumns });

  return (
    <Box flexDirection="column">
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
