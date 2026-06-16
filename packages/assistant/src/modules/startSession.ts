import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import {
  createInteractiveSession,
  type SessionConfig,
} from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
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
