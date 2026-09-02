import fs from 'node:fs';

/**
 * [[GS2-20]] — removal of a per-suite throwaway `HOME`, safe on win32.
 *
 * **Why this is not a plain `fs.rmSync`.** A suite that clamps `HOME`/`USERPROFILE` to a `mkdtemp`
 * directory now has a real database inside it: a `gth` session records history and checkpoints its
 * graph state to `<HOME>/.gsloth/history.db`, and holds those connections open for the whole
 * session. The harness ends a test with `terminal.kill()`, which returns immediately without waiting
 * for the child to die, and only then removes the directory — from `runTest`, which runs the
 * previous suite's `afterAll` hooks before spawning the next terminal, and from `afterAllWorker` at
 * the end of the file.
 *
 * On POSIX that is fine: a directory whose file is still open unlinks anyway. **On win32 it is
 * `EPERM`** — a file with a live handle cannot be deleted, and the handle outlives the kill by
 * however long the OS takes to finish tearing the process down. The window is milliseconds, and the
 * removal succeeds on a second attempt a moment later, so the fix is to wait rather than to stop
 * opening the database, which would delete the only end-to-end coverage the checkpointer has.
 *
 * `maxRetries` is the built-in for exactly this: node retries `EPERM`/`EBUSY`/`ENOTEMPTY` with a
 * linear backoff of `retryDelay * attempt`, so the values below wait up to 5.5s in total. That is
 * far more than the observed need and still well inside the suite's 30s per-test timeout, which
 * matters because the hook that removes the directory is billed to the *next* test.
 *
 * **A removal that still fails warns instead of throwing, and the tradeoff is deliberate.** The
 * harness wraps these hooks in no error handling anywhere: `afterAllWorker` has no try/catch and
 * runs in a child process where its `unhandledRejection` guard is never registered, so a throw there
 * kills the worker, the run prints no report line, and the flake check fails as "could not read the
 * run report" — an opaque failure that says nothing about the directory that caused it. A stale
 * directory in the OS temp folder is harmless; losing the run's report is not.
 *
 * The cost is that the warning goes to **stderr, which nothing parses**. `run-tui-e2e.js` captures
 * stdout only, on purpose: folding stderr in would let an async write interleave mid-line and break
 * the line-anchored match it uses to find flakes. So a handle that genuinely never got released
 * would surface here as a warning a human has to read, not as a failed gate.
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
        `  Leaving it behind rather than failing the run. If this repeats, something in the ` +
        `session under test is holding a file open past process exit.\n`
    );
  }
}
