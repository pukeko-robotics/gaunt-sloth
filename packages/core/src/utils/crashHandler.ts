import { writeSync } from 'node:fs';
import { writeCrashSnapshot } from '#src/utils/debugDump.js';

/**
 * @packageDocumentation
 * GS2-48 — a process-level crash handler that writes an unattended, GS2-47-redacted debug snapshot
 * when the process DIES, then exits — the counterpart to GS2-46's `/debug-dump`, which only helps
 * while the process is alive to run the slash command. Most real failures are the process dying, at
 * which point a slash command can't help, so this fires unconditionally, regardless of whether
 * `debugLog` was ever turned on for the session (the snapshot draws on the always-on in-memory
 * ring buffer — see {@link file://./debugUtils.ts}).
 *
 * SCOPE (deliberate): only `uncaughtException` and `unhandledRejection` are handled. Fatal SIGNALS
 * are intentionally left to a follow-up — `SIGINT`/`SIGTERM` are already GRACEFUL-exit paths
 * ({@link file://./systemUtils.ts} closes the log stream and exits 0), the TUI owns raw-mode Ctrl-C,
 * and dumping a crash file on every Ctrl-C would be noise, not signal. Adding signal capture without
 * fighting those handlers is a separate, careful piece of work.
 *
 * Exiting on these two events is NOT a behavioural regression: Node's default for an unhandled
 * rejection is already to throw (terminate), and its default for an uncaught exception is to print
 * the error and exit(1). This handler replicates that terminal behaviour (it still prints the
 * ORIGINAL error) and only ADDS the snapshot — an uncaughtException LISTENER suppresses Node's own
 * auto-print, which is exactly why the handler prints the error itself.
 *
 * CRASH-SAFETY invariants (the whole point of the node):
 *  - The handler is fully SYNCHRONOUS — no `async`/`await`, returns no promise. An async handler that
 *    rejected would raise a fresh `unhandledRejection` and re-enter, the exact loop the brief forbids.
 *  - A module-level {@link handling} guard is set BEFORE any work, so a throw anywhere inside cannot
 *    re-enter the handler and loop; a genuine re-entry short-circuits straight to exit.
 *  - Snapshotting is wrapped in try/catch; if it fails, the handler DEGRADES to printing the original
 *    error plus a one-line "failed to write crash snapshot" reason and still exits — it never masks
 *    the original error and never re-enters.
 *  - stderr is written with `fs.writeSync(2, …)`, NOT the async `consoleUtils`/`systemUtils` stream:
 *    `process.exit()` truncates pending async pipe writes, so the printed snapshot path (asserted by
 *    the e2e over a pipe) could be lost. This is a conscious, documented deviation from the
 *    "use consoleUtils for output" rule — that path is unsafe at crash time.
 */

/**
 * Session-supplied context folded into the snapshot when a crash fires. All optional: a crash before
 * a session registers anything still produces a useful snapshot (error + stack + debugLog buffer +
 * env), just without config/transcript.
 */
export interface CrashContext {
  /** The effective resolved config. */
  config?: unknown;
  /** Model display name. */
  modelDisplayName?: string;
  /** The in-flight turn's transcript tail. */
  transcriptTail?: unknown;
}

/** The live context read at crash time. Updated in place by the running session (see below). */
let crashContext: CrashContext = {};

/** Replace the crash context wholesale. */
export function setCrashContext(ctx: CrashContext): void {
  crashContext = ctx ?? {};
}

/**
 * Merge a partial update into the crash context. The running agent calls this as it learns things
 * (config at init, transcript tail before each turn) so a crash mid-run captures the latest state.
 */
export function updateCrashContext(patch: Partial<CrashContext>): void {
  crashContext = { ...crashContext, ...patch };
}

/** Clear the crash context (e.g. when a session ends). */
export function clearCrashContext(): void {
  crashContext = {};
}

/** Read the current crash context (used as the default context source by the installed handler). */
export function getCrashContext(): CrashContext {
  return crashContext;
}

/**
 * Re-entry guard. Module-level so it survives across the two listeners and any nested failure: once
 * we are handling a crash, a second crash (including one thrown by the handler itself) must NOT
 * re-run the snapshot logic — it goes straight to exit.
 */
let handling = false;

/** Whether {@link installCrashHandler} has already registered listeners (idempotent install). */
let installed = false;

let onUncaughtException: ((error: unknown) => void) | undefined;
let onUnhandledRejection: ((reason: unknown) => void) | undefined;

/** A short, never-throwing, single-block rendering of the original error for stderr. */
function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      return error.stack ?? `${error.name}: ${error.message}`;
    }
    return String(error);
  } catch {
    return '<unprintable error>';
  }
}

/** Write a line to fd 2 (stderr) synchronously, swallowing any failure — last-resort output. */
function writeStderr(line: string): void {
  try {
    writeSync(2, line);
  } catch {
    // Nothing more we can safely do if even fd 2 is gone.
  }
}

/**
 * The crash-handling body. Exported (rather than only closed over by the listeners) so it can be
 * unit-tested directly with an injected `exit` and `getContext`, without registering real process
 * listeners or killing the test runner.
 *
 * @param error the thrown value / rejection reason
 * @param origin `'uncaughtException'` | `'unhandledRejection'`
 * @param exit terminator (default {@link process.exit}); injectable so tests capture the code
 * @param getContext source of the snapshot context (default the module context)
 */
export function handleCrash(
  error: unknown,
  origin: string,
  exit: (code: number) => void = (code) => process.exit(code),
  getContext: () => CrashContext = getCrashContext
): void {
  // GUARD FIRST — before touching anything that could throw — so a failure below (or a crash raised
  // WHILE handling) can never re-enter and loop.
  if (handling) {
    writeStderr(`\n[gaunt-sloth] crash handler re-entered while handling ${origin}; exiting.\n`);
    exit(1);
    return;
  }
  handling = true;

  const original = describeError(error);
  try {
    const ctx = getContext();
    const { crashDir } = writeCrashSnapshot({
      error,
      origin,
      config: ctx.config,
      modelDisplayName: ctx.modelDisplayName,
      transcriptTail: ctx.transcriptTail,
    });
    // Surface the ORIGINAL error first (Node's own auto-print is suppressed by our listener), then
    // the snapshot path. writeSync so the path is not truncated by the imminent process.exit.
    writeStderr(`\n[gaunt-sloth] fatal ${origin}:\n${original}\n`);
    writeStderr(`[gaunt-sloth] crash snapshot written to: ${crashDir}\n`);
  } catch (snapErr) {
    // Snapshotting itself failed — DEGRADE: still surface the original error + a short reason, never
    // mask it, never re-enter.
    const reason = snapErr instanceof Error ? snapErr.message : String(snapErr);
    writeStderr(`\n[gaunt-sloth] fatal ${origin}:\n${original}\n`);
    writeStderr(`[gaunt-sloth] failed to write crash snapshot: ${reason}\n`);
  }
  exit(1);
}

/** Options for {@link installCrashHandler}. */
export interface InstallCrashHandlerOptions {
  /** Terminator (default {@link process.exit}). Injectable for tests. */
  exit?: (code: number) => void;
  /** Snapshot-context source (default the module crash context). */
  getContext?: () => CrashContext;
}

/**
 * Install the process-level crash handler (idempotent). Registers `uncaughtException` and
 * `unhandledRejection` listeners that write a redacted snapshot and exit. Inert on a normal exit —
 * no `exit`/`beforeExit` hook is registered, so a clean run behaves exactly as before.
 */
export function installCrashHandler(options: InstallCrashHandlerOptions = {}): void {
  if (installed) return;
  installed = true;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const getContext = options.getContext ?? getCrashContext;
  onUncaughtException = (error: unknown) =>
    handleCrash(error, 'uncaughtException', exit, getContext);
  onUnhandledRejection = (reason: unknown) =>
    handleCrash(reason, 'unhandledRejection', exit, getContext);
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
}

/**
 * Remove the crash-handler listeners and reset internal state. Primarily for tests (so the module
 * singleton's `handling`/`installed` flags don't leak between cases); harmless in production.
 */
export function uninstallCrashHandler(): void {
  if (onUncaughtException) process.removeListener('uncaughtException', onUncaughtException);
  if (onUnhandledRejection) process.removeListener('unhandledRejection', onUnhandledRejection);
  onUncaughtException = undefined;
  onUnhandledRejection = undefined;
  installed = false;
  handling = false;
}
