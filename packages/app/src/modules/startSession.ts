import {
  hasAnyConfig,
  loadConfiguredTui,
  type CommandLineConfigOverrides,
} from '@gaunt-sloth/core/config.js';
import {
  createInteractiveSession,
  type InteractiveSessionOptions,
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
 * optional deps, or a TUI mount failure) degrades to readline — never a crash. A failure of
 * anything the readline path would ALSO have done is not such a thing, and propagates; see
 * the two narrow try blocks below and the note above them.
 *
 * Because non-TTY environments always resolve to readline, the existing interactive
 * integration tests (spawned with piped, non-TTY stdio) keep exercising the unchanged
 * readline path through this dispatcher.
 */
export async function startSession(
  sessionConfig: SessionConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  message?: string,
  // GS2-20 — `--resume <id>` travels here unchanged to whichever surface is chosen, so both
  // surfaces resume through the same seam with the same id.
  options: InteractiveSessionOptions = {}
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
    // CFG-56 — under `--global` the session reads global config only, so the dialog must write
    // there. Left to its project default it would write a config this run cannot see, fail the
    // re-check below, and report incomplete setup on every retry.
    // GS2-33 — likewise for `-i <profile>`: a run reading a named profile must have the dialog
    // write into that profile's config, not the unscoped project/global default it would then
    // refuse to see.
    await runFirstRunDialog(
      {},
      false,
      commandLineConfigOverrides.global ? 'global' : undefined,
      commandLineConfigOverrides.identityProfile
    );
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

  // CFG-37 — the persistent `tui` preference, layered project-over-global. Each surface loads its
  // own config further down, so there is no resolved config here to read it from; this reader is
  // the seam that supplies just this key, quietly and fail-soft, before the surface is chosen. It
  // runs alongside the hasAnyConfig detection above and before any initConfig, per GS2-11.
  const configuredTui = await loadConfiguredTui(commandLineConfigOverrides);

  // Cheap gates first (TTY/flags/env/config). Only probe the optional Ink deps when the
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
    configuredTui,
  });

  if (environmentFavoursTui && (await isInkAvailable())) {
    // CFG-36 found that a config failure under the TUI was being reported as the TUI being
    // unavailable, and fixed it by re-raising the two config error CLASSES from this catch.
    //
    // CFG-47 — a marker list is the wrong shape for that job, because it always trails the code: it
    // has to be extended every time a new kind of failure learns to reach here, and the only
    // evidence that it was not extended is a user being told the wrong thing. It already missed one
    // (`initConfig`'s "-c <path> does not exist", a plain `Error`).
    //
    // The general rule the list was approximating: **falling back can only help a failure the
    // readline path would not also have.** Everything `createTuiSession` does before it starts
    // taking over the terminal — load config, open the conversation, start session logging, build
    // the runner, `runner.init` (which validates config and warns about what it cannot honour, such
    // as a declared `subagents` list) — the readline
    // path does identically, so restarting under readline re-runs the same work and fails the same
    // way, having first printed a false diagnosis. Only two things here are the TUI's alone:
    //
    //   1. loading this module at all — it statically imports the optional `ink` / `react` / `chalk`
    //      subtree, so a genuinely incomplete install fails at the IMPORT, before `createTuiSession`
    //      is ever entered. That is why the import keeps a `try` of its own; narrowing the fallback
    //      back to "the render" alone would break the one case it is honestly for. Know what else
    //      is inside that net: `tuiSessionModule.tsx` also statically imports ~25 non-optional
    //      `@gaunt-sloth/core/*` and `@gaunt-sloth/agent/*` modules, so an ESM load failure in ANY
    //      of them is swallowed here into the same "TUI unavailable" notice and a silent readline
    //      restart. That is a known residual, not an oversight: `isInkAvailable()` probes only
    //      `ink` and `react`, so the `chalk` case genuinely needs this wrapper and it cannot be
    //      narrowed further without losing it;
    //   2. the render phase — the mouse/stdin plumbing and Ink's mount, which touch the terminal.
    //
    // So the fallback wraps exactly those two, and the default for everything else is to propagate.
    // A failure mode added to `createTuiSession`'s setup in future reaches the caller without anyone
    // having to remember to list it, which is the property the marker list could not have.
    let createTuiSession:
      Awaited<typeof import('#src/tui/tuiSessionModule.js')>['createTuiSession'] | undefined;
    try {
      ({ createTuiSession } = await import('#src/tui/tuiSessionModule.js'));
    } catch (err) {
      warnTuiUnavailable(err);
    }
    if (createTuiSession) {
      // False until `createTuiSession` reports that it has reached the render phase. Deliberately
      // this polarity: an unrecognised failure leaves it false and therefore propagates.
      let inRenderPhase = false;
      try {
        await createTuiSession(
          sessionConfig,
          commandLineConfigOverrides,
          message,
          () => {
            inRenderPhase = true;
          },
          options
        );
        return;
      } catch (err) {
        // Pre-render: readline cannot help, and saying "TUI unavailable" would be a false
        // diagnosis. The error reaches the CLI's top-level guard (`guardProgramConfigErrors`),
        // which prints a config failure once and exits 1, or the GS2-48 crash handler otherwise.
        if (!inRenderPhase) {
          throw err;
        }
        warnTuiUnavailable(err);
      }
    }
  }

  await createInteractiveSession(sessionConfig, commandLineConfigOverrides, message, options);
}

/** The one "the TUI itself could not run; use readline" notice, worded as it always has been. */
function warnTuiUnavailable(err: unknown): void {
  displayWarning(
    `TUI unavailable (${err instanceof Error ? err.message : String(err)}); ` +
      `falling back to the readline session.`
  );
}
