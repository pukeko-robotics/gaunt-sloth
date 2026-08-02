import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * QA-13 — the PTY e2e runner must not call `process.exit()`.
 *
 * On macOS `process.stdout` is **asynchronous when it is a pipe**, which is precisely what a GitHub
 * Actions step gives it. `process.exit()` terminates the process without draining pending writes,
 * so the flake block and the `::warning` annotations — written immediately before exiting — are
 * silently truncated on the macOS cell. The feature would appear to work everywhere it was tested
 * and quietly do nothing in one third of CI.
 *
 * This is close to untestable at runtime and invisible on inspection: `process.exit(code)` is the
 * obvious, idiomatic line, and a local run redirected to a file can never expose the difference
 * because file writes are always synchronous. That combination — subtle reason, obvious-looking
 * "fix", no signal when it regresses — is what this guard is for. It asserts the source, because
 * the property is about which API is called, not about what a run produces.
 *
 * Resolved as a URL, never through a native path: a `D:\…` string is not a valid URL (OPS-39).
 */
const RUNNER = new URL('../run-tui-e2e.js', import.meta.url);

const source = (): string => readFileSync(RUNNER, 'utf8');

/**
 * Whether the source really *calls* `process.exit(...)`.
 *
 * Comment lines are dropped first. The runner's own comment explains at length why the call is
 * forbidden, and naming the thing you are forbidding is the natural way to write that — a scanner
 * that read prose would flag the explanation and force the comment to be written around the guard,
 * which is exactly backwards. Whole-line comments are all this file has; a trailing comment
 * mentioning the call on a line of code would still be flagged, which is the safe direction to err.
 */
function callsProcessExit(text: string): boolean {
  const code = text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  return /process\.exit\s*\(/.test(code);
}

describe('QA-13 the tui-e2e runner lets stdout drain', () => {
  it('detects a process.exit call only when there is one', () => {
    // Control: without this, `callsProcessExit` could return false for everything and the
    // assertion below would pass no matter what the runner did.
    expect(callsProcessExit('process.exit(1)')).toBe(true);
    expect(callsProcessExit('process.exit(code ?? 1)')).toBe(true);
    expect(callsProcessExit('process.exit (0)')).toBe(true);
    expect(callsProcessExit('  process.exit(0);')).toBe(true);
    expect(callsProcessExit('process.exitCode = 1')).toBe(false);
    // The distinction that matters: the runner documents the forbidden call by name, so a scanner
    // that read comments would fail on its own explanation. It did, before this was fixed.
    expect(callsProcessExit('// do NOT call process.exit() here')).toBe(false);
    expect(callsProcessExit(' * so process.exit(code) would truncate it')).toBe(false);
    expect(callsProcessExit('/* process.exit(1) */')).toBe(false);
  });

  it('still reads a runner that writes to stdout at exit time', () => {
    // Anti-vacuity, and it has to look at the RIGHT writes. Checking the whole file for
    // `process.stdout.write` is not enough: the tee handler always contains one, so the assertion
    // would hold even if the close handler emitted nothing and there were no pending write to
    // lose. Only writes issued from the close handler — after the last chance to drain — are what
    // process.exit() would truncate, so scope the check to that handler's body.
    const text = source();
    const closeHandler = text.slice(text.indexOf("child.on('close'"));

    expect(text.length).toBeGreaterThan(1000);
    expect(closeHandler, "the runner no longer has a 'close' handler").not.toBe('');
    expect(closeHandler).toContain('process.stdout.write');
    expect(closeHandler).toContain('githubAnnotations(');
  });

  it('sets process.exitCode instead of calling process.exit', () => {
    const text = source();

    expect(text).toContain('process.exitCode');
    expect(
      callsProcessExit(text),
      'run-tui-e2e.js must not call process.exit(): on macOS process.stdout is asynchronous when ' +
        'it is a pipe (a GitHub Actions step), so exiting outright truncates the flaky-test block ' +
        'and the ::warning annotations written just before it. Set process.exitCode and return.'
    ).toBe(false);
  });
});
