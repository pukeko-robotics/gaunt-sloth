import fs from 'node:fs';

/**
 * [[GS2-20]] — the per-suite throwaway `HOME`: settling the session that owns it, then removing it.
 *
 * **Why this is not a plain `fs.rmSync`.** A suite that clamps `HOME`/`USERPROFILE` to a `mkdtemp`
 * directory now has a real database inside it: a `gth` session records history and checkpoints its
 * graph state to `<HOME>/.gsloth/history.db`, and holds that connection open for the whole session.
 * On POSIX a directory whose file is still open unlinks anyway; **on win32 it is `EPERM`**, because
 * a file with a live handle cannot be deleted. So the removal is only safe once the session that
 * held the handle is gone, and the harness does not guarantee that.
 *
 * **What the harness actually does.** `runTest` ends a test with `terminal.kill()`, which is
 * `process.kill(pid, 9)` and returns immediately — it does not wait for the process to die. The
 * directory is then removed from an `afterAll` hook, which runs either at the START OF THE NEXT
 * TEST (the exit hooks of the outgoing suite, before the next terminal is spawned) or from
 * `afterAllWorker` at the end of the file. Both are a race against a process that was asked to die
 * a moment ago and may not have.
 *
 * **So the wait belongs on the process, not on the removal.** {@link settleSessionsAfterEach}
 * registers one file-level `afterEach` that kills this test's session and then waits for the pty to
 * report its exit — `Terminal.onExit`, which is public API and fires immediately when the process
 * has already gone. By the time any `afterAll` runs, the pty has reported an exit for every session
 * in the file, or the absence of one has been recorded. Retrying a removal until it happens to
 * succeed would be a proxy for that, and a poor one: it passes or fails on timing and cannot tell a
 * live process apart from a stuck handle.
 *
 * **What that signal is, stated exactly, because the difference matters on win32.** On Windows
 * node-pty emits `exit` from its conout socket's `close` handler, not from a direct observation of
 * the process dying. Whether the socket closing precedes, coincides with or follows the kernel
 * releasing that process's file handles is not established here — and that window is precisely
 * where an `EPERM` on the directory would live. So a reported exit is strong evidence and not a
 * proof, which is why {@link settleSessionsAfterEach} also records how long each wait took: a run
 * where every session "exited" in about a millisecond and the removals still failed indicts the
 * signal, where hundreds of milliseconds would exonerate it.
 *
 * The `maxRetries` on the removal below stays, and is not the same thing. Once the process is
 * confirmed dead it covers only the OS's own handle rundown, which is short and bounded. It is not
 * there to outlast a running session, and it must not be lengthened to make a failure go away.
 *
 * **A removal that still fails warns instead of throwing, and the tradeoff is deliberate.** The
 * harness wraps these hooks in no error handling anywhere: `afterAllWorker` has no try/catch and
 * runs in a child process where its `unhandledRejection` guard is never registered, so a throw there
 * kills the worker, the run prints no report line, and the flake check fails as "could not read the
 * run report" — an opaque failure that says nothing about the directory that caused it. A stale
 * directory in the OS temp folder is harmless; losing the run's report is not.
 *
 * **Not throwing must not mean not failing, and a stream cannot carry that news. Measured:** these
 * hooks run in a workerpool CHILD PROCESS, and although the pool is configured `stdio: 'inherit'`
 * it also sets `emitStdStreams`, so workerpool captures both of the worker's streams and hands them
 * to the pool owner as per-test payloads. The ListReporter prints a test's captured `stdout` only
 * for a test it is already REPORTING (`base.js` `_printFailures`), and `afterAllWorker`'s output is
 * attached to no test at all. So a `process.stderr.write` from here reaches neither the run's log
 * nor a human: it is discarded. A probe writing to both streams from this function, with a
 * filesystem control proving the function ran, produced ZERO hits in the runner's captured output.
 *
 * So the report travels by FILE. `run-tui-e2e.js` — which runs in the parent process and owns the
 * child's environment — points {@link GTH_E2E_LEAK_REPORT} at a scratch path before spawning, and
 * fails the run on anything written there. That is a hard gate with no worker-level crash and no
 * stream to interleave. The stderr line is kept for a run driven by hand, where it does reach a
 * terminal.
 *
 * With no such variable set the behaviour is exactly what it was, so any other caller of the
 * harness still works.
 */

/**
 * How long to wait for a killed session to report its exit.
 *
 * Generous on purpose: the expected value is single-digit milliseconds, so this is a bound on a
 * pathology rather than a budget anything normal spends. It has to stay comfortably inside the
 * suite's 30s per-test timeout, because this hook is billed to the test it follows.
 */
const EXIT_WAIT_MS = 5_000;

/**
 * The bound once a session has already failed to exit in time. A run where every session outlives
 * its kill would otherwise pay {@link EXIT_WAIT_MS} a hundred times over and turn a diagnosis into
 * a global timeout. The first occurrence is what carries the information; the rest only need
 * counting.
 */
const EXIT_WAIT_MS_DEGRADED = 250;

/** Set once a session has outlived its kill, to shorten every later wait. Per worker process. */
let sawSessionOutliveKill = false;

/**
 * How long each session in this worker took to report its exit, in milliseconds.
 *
 * Carried on an `unremovable` record so the two readings of "the pty said it exited, and the
 * directory still would not go" can be told apart without another CI round. See the win32 caveat in
 * the docblock above: if every one of these is about a millisecond, the exit signal is running ahead
 * of the kernel and is itself the suspect; hundreds of milliseconds mean the wait did real work and
 * the handle outlived the process that opened it.
 */
const settleWaits = [];

/** A compact digest of {@link settleWaits}, or null when nothing settled in this worker. */
function exitWaitSummary() {
  if (settleWaits.length === 0) return null;
  return {
    n: settleWaits.length,
    minMs: Math.min(...settleWaits),
    maxMs: Math.max(...settleWaits),
  };
}

/** Append one JSON record to the report file, if the parent asked for one. Never throws. */
function report(record) {
  // Its own try/catch, and deliberately so: a failure to REPORT must not become the worker-killing
  // throw that all of this exists to avoid. A lost report is a quieter gate; a thrown one costs the
  // whole run's report.
  try {
    const path = process.env.GTH_E2E_LEAK_REPORT;
    if (path) fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    /* ignore */
  }
}

/**
 * Kill this test's session and wait for the pty to confirm it exited.
 *
 * Killing here rather than leaving it to the harness is deliberate and safe: `runTest` kills again
 * in a `finally` that already tolerates an -already-dead terminal ("terminal can pre-terminate if
 * program is provided"). Doing it here is what lets the wait happen inside the window of the test
 * that owns the session, instead of being billed to whichever test follows.
 *
 * @param {{ kill(): void, onExit(cb: (exit: unknown) => void): void }} terminal
 * @returns {Promise<void>}
 */
async function settleSession(terminal) {
  if (!terminal || typeof terminal.kill !== 'function' || typeof terminal.onExit !== 'function') {
    return;
  }
  const budget = sawSessionOutliveKill ? EXIT_WAIT_MS_DEGRADED : EXIT_WAIT_MS;
  const started = Date.now();
  try {
    terminal.kill();
  } catch {
    // Already gone — `onExit` below will settle immediately.
  }
  const exited = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // Fires synchronously when the process has already exited, so the ordinary case never waits.
    try {
      terminal.onExit(() => finish(true));
    } catch {
      finish(false);
    }
    const timer = setTimeout(() => finish(false), budget);
    // Never hold the worker's event loop open on this timer alone.
    if (typeof timer.unref === 'function') timer.unref();
  });
  if (exited) {
    settleWaits.push(Date.now() - started);
  } else {
    sawSessionOutliveKill = true;
    report({ kind: 'still-running', waitedMs: Date.now() - started });
  }
}

/**
 * Register the settle hook for every test in the calling file.
 *
 * Call this ONCE at the top level of a `*.tui.test.ts` that clamps `HOME` — not inside a
 * `test.describe`. A hook registered at file scope lands on the file's root suite, and `runTest`
 * walks `test.suite.parentSuites()` when it runs `afterEach`, so one registration covers every
 * describe in the file (measured: a two-test file fired it twice). Registering it per-describe
 * would work too and is simply more lines to forget.
 *
 * @param {{ afterEach(fn: (args: { terminal: unknown }) => unknown): void }} test the imported
 *   tui-test `test` object, passed in rather than imported here so this fixture keeps no dependency
 *   on the harness's module resolution from the transpiled cache.
 */
export function settleSessionsAfterEach(test) {
  test.afterEach(async ({ terminal }) => {
    await settleSession(terminal);
  });
}

/**
 * Remove a suite's throwaway `HOME`.
 *
 * By the time this runs, the pty has reported an exit for every session in the file — or
 * {@link settleSessionsAfterEach} has recorded that one never came, which the run's gate reports
 * separately. So a failure here is no longer the ambiguity it was: it is not a removal that simply
 * ran too soon after a kill. What it is instead depends on how far the exit signal can be trusted on
 * the platform, which is what the recorded wait times are for.
 *
 * @param {string} dir the throwaway home to remove
 */
export function removeTmpHome(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `\n⚠ tui-e2e could not remove the throwaway HOME at ${dir} after retrying: ${reason}\n` +
        `  Leaving it behind rather than failing the run.\n`
    );
    report({ kind: 'unremovable', dir, reason, exitWaits: exitWaitSummary() });
  }
}
