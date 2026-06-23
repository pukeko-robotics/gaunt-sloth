/**
 * Integration tests for the EXT-9 Tier-1 shell hardening. These run REAL shell
 * commands (no child_process mock) on a POSIX host, exercising the spawn-path
 * behavior: timeout + process-group kill, stdin-closed, output cap + temp-file
 * spillover, credential env scrub, and the unbypassable hardline blocklist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Keep terminal noise out of the test output but let env (real process.env)
// flow through so the credential-scrub test is meaningful.
vi.mock('#src/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, stdout: { write: vi.fn() } };
});

const isPosix = process.platform !== 'win32';
const d = isPosix ? describe : describe.skip;

d('GthDevToolkit shell hardening (real spawn)', () => {
  let GthDevToolkit: typeof import('#src/tools/GthDevToolkit.js').default;

  beforeEach(async () => {
    ({ default: GthDevToolkit } = await import('#src/tools/GthDevToolkit.js'));
  });

  afterEach(() => {
    delete process.env.GSLOTH_FAKE_ANTHROPIC_PROBE;
    delete process.env.ANTHROPIC_API_KEY;
  });

  // Helper: invoke the private executeCommand with a given dev-tools config.
  const run = (command: string, commands = {}) => {
    const toolkit = new GthDevToolkit(commands);
    return (
      toolkit as unknown as { executeCommand(_c: string, _n: string): Promise<string> }
    ).executeCommand(command, 'run_shell_command');
  };

  it('kills a long-running command after the configured timeout', async () => {
    const start = Date.now();
    const result = await run('sleep 30', { shell: { enabled: true, timeout: 300 } });
    const elapsed = Date.now() - start;
    expect(result).toContain('was killed after exceeding');
    // Should be killed quickly (well before sleep 30 finishes).
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('does not hang on a command that would read stdin (stdin is closed)', async () => {
    // `cat` with no args reads stdin; with stdin=ignore it gets EOF and exits.
    const result = await run('cat', { shell: { enabled: true, timeout: 5000 } });
    expect(result).toContain('completed successfully');
  }, 10_000);

  it('caps output and spills the full output to a temp file', async () => {
    // Print ~50KB; cap at 2KB so it must truncate.
    const result = await run('for i in $(seq 1 2000); do echo "line-$i-padding-xxxxxxxxxx"; done', {
      shell: { enabled: true, maxOutputBytes: 2000 },
    });
    expect(result).toContain('output truncated');
    expect(result).toContain('read_file');
    const match = result.match(/Full output written to (\S+\.log)/);
    expect(match).not.toBeNull();
    const onDisk = readFileSync(match![1], 'utf8');
    // The spilled file holds far more than the 2KB preview budget.
    expect(onDisk.length).toBeGreaterThan(10_000);
    expect(onDisk).toContain('line-2000-padding');
  }, 15_000);

  it('scrubs a provider credential from the child env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    const result = await run('printf "KEY=[%s]" "$ANTHROPIC_API_KEY"', {
      shell: { enabled: true, timeout: 5000 },
    });
    expect(result).toContain('KEY=[]');
    expect(result).not.toContain('sk-should-not-leak');
  }, 10_000);

  it('preserves generic env (PATH) for the child', async () => {
    const result = await run('test -n "$PATH" && echo HAVE_PATH', {
      shell: { enabled: true, timeout: 5000 },
    });
    expect(result).toContain('HAVE_PATH');
  }, 10_000);

  it('refuses a hardline command WITHOUT executing, even under yolo', async () => {
    // shellYolo bypasses confirmation but must NOT bypass the hardline floor.
    // Use a sentinel file path that the command would touch if it actually ran.
    const result = await run('rm -rf /', {
      shell: { enabled: true },
      shellYolo: true,
    });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).toContain('even when command confirmation is disabled');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('refuses a hardline command at exec time regardless of HOW it was approved (EXT-12 /yolo)', async () => {
    // EXT-12's runtime `/yolo` flag only changes the APPROVAL decision (auto-approve without
    // prompting) in GthAgentRunner; the tool body is unchanged, so the unbypassable hardline
    // floor still fires at exec time exactly as it does under the static shellYolo. This asserts
    // the floor is a property of executeCommand itself, not of any particular approval path.
    const result = await run('mkfs.ext4 /dev/sda', { shell: { enabled: true } });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('refuses an OBFUSCATED hardline command (normalization works)', async () => {
    const result = await run('r\\m -rf /', { shell: { enabled: true }, shellYolo: true });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('still runs a benign command normally', async () => {
    const result = await run('echo hello-world', { shell: { enabled: true } });
    expect(result).toContain('hello-world');
    expect(result).toContain('completed successfully');
  }, 10_000);
});
