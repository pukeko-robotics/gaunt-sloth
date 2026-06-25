/**
 * EXT-15 — Windows real-spawn reap test. The companion
 * `GthDevToolkit.shell.integration.spec.ts` is POSIX-only (`describe.skip` on
 * win32), so the actual Windows timeout-reap path had ZERO real coverage — which
 * is how the `process.kill(-pid)` EINVAL hang reached release CI undetected.
 *
 * This spec runs ONLY on win32 and exercises a REAL `spawn` + the `taskkill /T`
 * reap. Pre-fix, the timeout case never resolves and this test hits its own
 * timeout (a hard FAIL, not a silent CI cancel); post-fix it resolves in seconds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('#src/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, stdout: { write: vi.fn() } };
});

const isWin = process.platform === 'win32';
const d = isWin ? describe : describe.skip;

d('GthDevToolkit shell hardening on Windows (real spawn)', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  const run = async (command: string, commands = {}) => {
    const { default: GthDevToolkit } = await import('#src/tools/GthDevToolkit.js');
    const toolkit = new GthDevToolkit(commands);
    return (
      toolkit as unknown as { executeCommand(_c: string, _n: string): Promise<string> }
    ).executeCommand(command, 'run_shell_command');
  };

  it('reaps a long-running command after the timeout instead of hanging', async () => {
    const start = Date.now();
    // `ping -n 60` runs ~59s (1s between echoes); a 300ms tool timeout must reap
    // it via taskkill. `timeout`/`pause` read stdin (ignored) so ping is safer.
    const result = await run('ping -n 60 127.0.0.1', { shell: { enabled: true, timeout: 300 } });
    const elapsed = Date.now() - start;
    expect(result).toContain('was killed after exceeding');
    // Resolves well before the 59s command (timeout + the 3s SIGKILL grace).
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('runs a benign command to completion', async () => {
    const result = await run('echo hello-world', { shell: { enabled: true } });
    expect(result).toContain('hello-world');
    expect(result).toContain('completed successfully');
  }, 20_000);

  it('does not hang on a command that reads stdin (stdin is closed → EOF)', async () => {
    // `sort` with no file arg reads stdin; with stdin=ignore it gets EOF and exits
    // rather than blocking forever (the pre-EXT-9 stdin foot-gun, re-checked on win32).
    const result = await run('sort', { shell: { enabled: true, timeout: 10_000 } });
    expect(result).toContain('completed successfully');
  }, 20_000);
});
