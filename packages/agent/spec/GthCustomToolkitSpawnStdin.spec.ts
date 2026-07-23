import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * EXT-39 (part 2) — regression test for the nested-`gth` spawn-stdin hang.
 *
 * Unlike GthCustomToolkit.spec.ts (which mocks `child_process` wholesale), this file spawns a
 * REAL child so it exercises the actual `stdio` option. It proves that a command run through
 * `GthCustomToolkit.executeCommand` reads EOF on stdin immediately instead of blocking forever on
 * an inherited-but-never-written pipe. The probe is a small node script that reads stdin to `'end'`
 * and echoes a marker; with the fix (`stdio: ['ignore','pipe','pipe']`) `'end'` fires at once and
 * the command completes promptly. Without the fix the child would block on stdin and the command
 * would be killed by the timeout ("timed out"), never emitting the marker.
 */
describe('GthCustomToolkit executeCommand child stdin (EXT-39 part 2, real spawn)', () => {
  let tmpDir: string;
  let probeScript: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gth-ext39-stdin-'));
    probeScript = path.join(tmpDir, 'stdin-probe.cjs');
    // Reads all of stdin, then on EOF ('end') echoes a marker with the captured input.
    // With child stdin = /dev/null the input is empty and 'end' fires immediately.
    writeFileSync(
      probeScript,
      [
        "let data = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { data += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('STDIN_EOF_MARKER:' + JSON.stringify(data));",
        '});',
        '',
      ].join('\n')
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sees EOF on stdin immediately and completes without hanging', async () => {
    const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
    const { default: GthCustomToolkit } = await import('#src/tools/GthCustomToolkit.js');
    const toolkit = new GthCustomToolkit({});

    // Subscribe to keep the live notice/output chunks off the real console during the test.
    const unsubscribe = subscribeToolOutput(() => {});
    try {
      // Quote the path so a temp dir with spaces (or backslashes on Windows) survives the shell.
      // A generous timeout: on a healthy run the child EOFs and exits in well under a second, so
      // the timeout only fires if the fix regresses and the child blocks on stdin.
      const result = await toolkit['executeCommand'](`node "${probeScript}"`, 'stdin_probe', 20);

      // Proof of EOF: the child's 'end' handler ran with empty stdin.
      expect(result).toContain('STDIN_EOF_MARKER:""');
      // Proof of no hang: it exited cleanly rather than being killed by the timeout.
      expect(result).toContain('completed successfully');
      expect(result).not.toContain('timed out');
    } finally {
      unsubscribe();
    }
  }, 30_000);
});
