import React from 'react';
import { Box, Text } from 'ink';
import type { McpConnectionFailure } from '@gaunt-sloth/core/core/types.js';

/**
 * TUI-C19 — a persistent, single-line advisory bar for non-fatal startup advisories.
 *
 * Rendered in the pinned dock next to the status bar (see `App.tsx`), so — unlike a transient
 * `displayWarning` that scrolls away the moment Ink takes over — it stays on screen and survives
 * transcript growth (DL-1: no important thing is silent). It shows ONLY when there is at
 * least one advisory; a clean startup renders nothing (returns `null`), so the chrome is unchanged
 * when there's nothing to say.
 *
 * The advisory list is intentionally generic (a plain string list) so other non-fatal startup
 * advisories can post here later. Today the only producer is config validation (unknown keys /
 * deprecated names captured around `initConfig`), so the standing line points at `/config`, which
 * renders the actual warning text (DL-2 progressive disclosure: the pointer here, the detail there).
 * Yellow + `⚠` matches the warn tone used elsewhere in the chrome (DL-8 meaningful colour).
 */
export function NoticeBar({ advisories }: { advisories?: string[] }): React.ReactElement | null {
  if (!advisories || advisories.length === 0) return null;
  // TUI-C92 — one row by construction: the dock's row budget in `App.tsx` charges this bar one
  // row, so it truncates with `…` rather than wrapping (DL-7). The `/config` pointer sits before
  // the tail that would go first.
  return (
    <Box>
      <Text color="yellow" wrap="truncate-end">
        {'⚠ Your config has problems · type /config to see details'}
      </Text>
    </Box>
  );
}

/**
 * A sibling of {@link NoticeBar} for MCP connection failures captured during agent init. Kept
 * separate from the config-advisory bar on purpose: a server that failed to connect is not a config
 * problem and its detail lives in the `/debug` MCP tab, not `/config`. Same persistence rationale —
 * without this pinned line the only signal is a `displayWarning` the Ink TUI immediately paints
 * over, so a failed MCP server would look identical to a healthy one with no tools. Names the
 * server(s) here (the pointer); the tab carries the full reason (DL-2 progressive disclosure).
 * Renders nothing when every configured server connected.
 */
export function McpFailureBar({
  failures,
}: {
  failures?: McpConnectionFailure[];
}): React.ReactElement | null {
  if (!failures || failures.length === 0) return null;
  const names = failures.map((f) => f.server).join(', ');
  const noun = failures.length === 1 ? 'server' : 'servers';
  // TUI-C92 — one row by construction, for the same reason as `NoticeBar`: the budget charges it
  // one row, and with a single server the row is already 84 cells, two rows at 80 columns. It
  // truncates with `…` (DL-7); what goes first is the END of the `/debug` pointer, then — with
  // enough failed servers — the pointer itself, while the server names at the front survive. The
  // full reason for each failure is in the MCP tab regardless (DL-2).
  return (
    <Box>
      <Text color="yellow" wrap="truncate-end">
        {`⚠ MCP ${noun} unavailable: ${names} · type /debug and open the MCP tab for details`}
      </Text>
    </Box>
  );
}
