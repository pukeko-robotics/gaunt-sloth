import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * GS2-48 acceptance e2e — spawns a REAL Node process that installs the crash handler (from the built
 * `dist`) and then dies, proving the end-to-end contract that the in-process unit tests mock around:
 *  1. a forced `uncaughtException` writes a REDACTED `crash.json` at the predictable
 *     `~/.gsloth/debug-dumps/crash-<ts>/` path, prints that path to stderr, and exits non-zero;
 *  2. when the snapshot write itself fails (an unwritable `~/.gsloth`), the process still exits
 *     cleanly with the ORIGINAL error surfaced and a failure reason — no infinite loop (a loop would
 *     hang and trip the spawn timeout).
 *
 * The fixture imports the built file by absolute file: URL (not a bare `@gaunt-sloth/core` specifier)
 * so it resolves without workspace node_modules; its transitive `#src/*` imports resolve via core's
 * own package.json `imports` map because the file lives inside packages/core.
 */
const here = dirname(fileURLToPath(import.meta.url));
const crashHandlerDist = resolve(here, '../dist/utils/crashHandler.js');
const SECRET = 'topsecret-crash-value-abc123'; // NAME ends with _SECRET below → collected literal

/** A secret-named env var whose value must be scrubbed from the crash file (GS2-47 technique 1). */
const SECRET_ENV = 'GS2_48_FAKE_SECRET';

function runFixture(
  body: string,
  homeDir: string
): { status: number | null; signal: string | null; stdout: string; stderr: string } {
  const script = `
import { installCrashHandler, updateCrashContext } from ${JSON.stringify(
    pathToFileURL(crashHandlerDist).href
  )};
installCrashHandler();
${body}
`;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: tmpdir(),
    env: {
      ...process.env,
      HOME: homeDir, // POSIX homedir()
      USERPROFILE: homeDir, // Windows homedir() (the TUI-C28 trap: os.homedir() reads %USERPROFILE%)
      [SECRET_ENV]: SECRET,
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('crash handler — process-level e2e (GS2-48)', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(resolve(tmpdir(), 'gsloth-crash-e2e-home-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('forced uncaughtException → redacted crash.json at ~/.gsloth/debug-dumps/, path on stderr, exit 1', () => {
    const { status, signal, stderr } = runFixture(
      `updateCrashContext({
         config: { llm: { type: 'anthropic', apiKey: process.env.${SECRET_ENV} } },
         modelDisplayName: 'test-model',
       });
       // Throw asynchronously so it lands as a clean uncaughtException after setup.
       setTimeout(() => { throw new Error('boom leaking ' + process.env.${SECRET_ENV}); }, 0);`,
      homeDir
    );

    // Clean, non-zero exit (not a timeout / signal kill).
    expect(signal).toBeNull();
    expect(status).toBe(1);
    // Path printed to stderr before exit.
    expect(stderr).toContain('crash snapshot written to:');
    expect(stderr).toContain('fatal uncaughtException');

    // Locate the crash dir under the temp HOME.
    const dumpsDir = resolve(homeDir, '.gsloth', 'debug-dumps');
    expect(existsSync(dumpsDir)).toBe(true);
    const crashDirs = readdirSync(dumpsDir).filter((d) => d.startsWith('crash-'));
    expect(crashDirs.length).toBe(1);
    const crashFile = resolve(dumpsDir, crashDirs[0], 'crash.json');
    expect(existsSync(crashFile)).toBe(true);

    const raw = readFileSync(crashFile, 'utf8');
    // The secret is scrubbed everywhere (config field AND the error message it leaked into).
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('<redacted>');

    const parsed = JSON.parse(raw);
    expect(parsed.origin).toBe('uncaughtException');
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toContain('boom leaking');
    expect(parsed.error.message).toContain('<redacted>');
    expect(parsed.error.stack).toContain('Error:');
    expect(parsed.config.llm.apiKey).toBe('<redacted>');
    expect(parsed.env.model).toBe('test-model');
  });

  it('unwritable ~/.gsloth → exits 1 with the original error + failure reason, no infinite loop', () => {
    // Make ~/.gsloth a FILE so mkdirSync under it throws ENOTDIR — a root-proof way to force the
    // writer to fail (chmod 000 is bypassed when CI runs as root).
    writeFileSync(resolve(homeDir, '.gsloth'), 'not a directory');

    const { status, signal, stderr } = runFixture(
      `setTimeout(() => { throw new Error('original boom'); }, 0);`,
      homeDir
    );

    // Terminated cleanly with the crash exit code — a loop would have hung until the 30s timeout
    // (status null + a signal), which these assertions would catch.
    expect(signal).toBeNull();
    expect(status).toBe(1);
    // Original error surfaced, plus a one-line snapshot-failure reason (never masked).
    expect(stderr).toContain('original boom');
    expect(stderr).toContain('failed to write crash snapshot');
    // No crash file was produced (the dir could not be created).
    expect(existsSync(resolve(homeDir, '.gsloth', 'debug-dumps'))).toBe(false);
  });

  it('is inert on a NORMAL exit — no crash file, nothing on stderr', () => {
    const { status, signal, stderr } = runFixture(
      `// install (done above) then just finish cleanly.
       process.exitCode = 0;`,
      homeDir
    );

    expect(signal).toBeNull();
    expect(status).toBe(0);
    // The handler wrote nothing and printed nothing — a clean run is untouched.
    expect(stderr).toBe('');
    expect(existsSync(resolve(homeDir, '.gsloth', 'debug-dumps'))).toBe(false);
  });
});
