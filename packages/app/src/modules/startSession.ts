import { hasAnyConfig, type CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import {
  createInteractiveSession,
  type SessionConfig,
} from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import {
  displayInfo,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { env, stdin, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { shouldUseTui } from '#src/tui/shouldUseTui.js';
import { isInkAvailable } from '#src/tui/loadInk.js';

/**
 * Entry point for the `chat`/`code` interactive sessions. Decides between the Ink TUI and
 * the readline session, then hands off the SAME `SessionConfig`/overrides/message either
 * way. Anything that prevents the TUI (non-TTY, `--no-tui`/`GTH_NO_TUI`, CI, missing
 * optional deps, or a TUI mount failure) degrades to readline — never a crash.
 *
 * Because non-TTY environments always resolve to readline, the existing interactive
 * integration tests (spawned with piped, non-TTY stdio) keep exercising the unchanged
 * readline path through this dispatcher.
 */
export async function startSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message?: string
): Promise<void> {
  // CFG-10 — when no configuration exists anywhere (no project AND no global config),
  // run the interactive first-run setup instead of letting initConfig die with
  // "No configuration file found". CFG-8 guarantees a valid global-only config is NOT
  // treated as "no config", so this only fires on a genuinely unconfigured machine.
  //
  // Only do this on an interactive TTY: piped / non-TTY runs (the integration tests, CI,
  // scripts) must NOT block waiting on stdin — they fall through to the normal initConfig
  // path, which surfaces the existing error.
  if (stdin.isTTY && stdout.isTTY && !(await hasAnyConfig(commandLineConfigOverrides))) {
    displayInfo('No configuration found — starting first-run setup.');
    // Imported lazily so the first-run dialog (and its provider-discovery/Ink deps) never
    // load on the normal configured path.
    const { runFirstRunDialog } = await import('#src/commands/firstRunDialog.js');
    await runFirstRunDialog();
    if (!(await hasAnyConfig(commandLineConfigOverrides))) {
      // The user aborted the dialog without writing a config; nothing to run.
      displayWarning('Setup was not completed. Re-run gth once a configuration exists.');
      return;
    }
    // CFG-16 — setup succeeded, so continue straight into the interactive session in THIS process
    // instead of telling the user to re-run `gth` (a dead-end). The first-run dialog cleans up its
    // own terminal owner before returning — the Ink selector fully unmounts (waitUntilExit) and the
    // readline fallback is closed in its `finally` — so by the time we fall through, stdin/raw-mode
    // is free for the session's TUI/readline to claim. The freshly written config is picked up
    // cleanly below: `initConfig` re-reads from disk on every call (it resets projectDir first and
    // caches nothing), so the session sees exactly what the dialog just wrote.
    displaySuccess('Setup complete — starting your session.');
    // Fall through to the normal dispatch with the same `sessionConfig` (code mode for bare `gth`).
  }

  // Cheap gates first (TTY/flags/env). Only probe the optional Ink deps when the
  // environment actually favours the TUI, so we never load React/Ink for a readline run.
  const environmentFavoursTui = shouldUseTui({
    stdoutIsTTY: !!stdout.isTTY,
    stdinIsTTY: !!stdin.isTTY,
    noTuiFlag: commandLineConfigOverrides.tui === false,
    tuiFlag: commandLineConfigOverrides.tui === true,
    term: env.TERM,
    ci: !!env.CI,
    gthNoTui: !!env.GTH_NO_TUI,
    inkAvailable: true,
  });

  if (environmentFavoursTui && (await isInkAvailable())) {
    try {
      const { createTuiSession } = await import('#src/tui/tuiSessionModule.js');
      await createTuiSession(sessionConfig, commandLineConfigOverrides, message);
      return;
    } catch (err) {
      displayWarning(
        `TUI unavailable (${err instanceof Error ? err.message : String(err)}); ` +
          `falling back to the readline session.`
      );
    }
  }

  await createInteractiveSession(sessionConfig, commandLineConfigOverrides, message);
}
