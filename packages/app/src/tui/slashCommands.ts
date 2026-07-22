/**
 * GS2-8 — the slash-command layer is shared between the Ink TUI and the readline (`--no-tui`)
 * session, so the single source of truth now lives in `@gaunt-sloth/agent` (the package that
 * hosts the readline surface; the dependency arrow points app → agent, so the shared module
 * must sit below the TUI). This re-export keeps the TUI's historical
 * `#src/tui/slashCommands.js` import path working unchanged.
 */
export * from '@gaunt-sloth/agent/modules/slashCommands.js';
