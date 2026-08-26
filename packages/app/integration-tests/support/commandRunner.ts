import { spawn } from 'child_process';
import path from 'path';
import type { ChildProcess } from 'node:child_process';
import { assertCliUnderTestOnce, gthSpawnSpec } from './cliUnderTest.mjs';

/**
 * Every helper here spawns THIS checkout's CLI: `process.execPath` running the `packages/app/cli.js`
 * that `support/cliUnderTest.mjs` resolves by an anchored path. That file carries the reasoning —
 * why a launcher resolving a bare name is not usable here, why `INIT_CWD` is set explicitly, and
 * what the version tripwire does and does not prove. Read it before changing how a spawn is made.
 *
 * Two things the move away from a launcher removed rather than replaced:
 *
 * - The `npm_config_loglevel=warn` workaround is gone. It existed only because npm 12 printed a run
 *   notice to stderr on every launcher invocation, and several tests here treat any stderr byte as
 *   a failure. No npm process is involved any more, so there is no notice to suppress.
 * - So is the Windows-only `shell: true`. It was needed because the launcher is a `.cmd` there.
 *   Spawning an absolute executable needs no shell, and going through cmd.exe would now be wrong:
 *   `process.execPath` on Windows is normally under `C:\Program Files\nodejs`, and cmd.exe splits
 *   that at the space.
 */

function isVerboseCommandRunnerEnabled(): boolean {
  const value = process.env.GSLOTH_IT_VERBOSE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function writeVerboseOutput(stream: NodeJS.WriteStream, data: Buffer): void {
  if (isVerboseCommandRunnerEnabled()) {
    stream.write(data);
  }
}

function resolveTestDir(workDir?: string): string {
  return path.resolve(workDir ? workDir : './packages/app/integration-tests/workdir');
}

/**
 * Runs the CLI under test in the integration-tests working directory using spawn.
 * This prevents stdin from being treated as a pipe.
 * @param args - The CLI arguments (no launcher and no package name — see cliUnderTest.mjs)
 * @param endOutput - Output which will terminate the execution
 * @param workDir - The working directory for the command
 * @returns The command output as a string
 */
export async function runGth(
  args: string[],
  endOutput?: string,
  workDir?: string
): Promise<string> {
  assertCliUnderTestOnce();
  const testDir = resolveTestDir(workDir);
  const { command, argv, env } = gthSpawnSpec(args, testDir);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childProcess = spawn(command, argv, {
      cwd: testDir,
      env,
      // Explicitly ignore stdin, otherwise the app switches to pipe mode
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    childProcess.stdout.on('data', (data) => {
      writeVerboseOutput(process.stdout, data);
      stdout += data.toString();
      if (endOutput && data.toString().includes(endOutput)) {
        childProcess.kill();
        resolve(stdout.trim());
        return;
      }
    });

    childProcess.stderr.on('data', (data) => {
      writeVerboseOutput(process.stderr, data);
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command failed with code ${code}\n${stderr}\n${stdout}`));
      }
    });
  });
}

/**
 * Runs the CLI under test expecting it to exit with a specific code
 * @param args - The CLI arguments (no launcher and no package name — see cliUnderTest.mjs)
 * @param expectedExitCode - The expected exit code
 * @param workDir - The working directory for the command
 * @returns Object containing output and exit code
 */
export async function runGthExpectingExitCode(
  args: string[],
  expectedExitCode: number,
  workDir?: string
): Promise<{ output: string; exitCode: number }> {
  assertCliUnderTestOnce();
  const testDir = resolveTestDir(workDir);
  const { command, argv, env } = gthSpawnSpec(args, testDir);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childProcess = spawn(command, argv, {
      cwd: testDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    childProcess.stdout.on('data', (data) => {
      writeVerboseOutput(process.stdout, data);
      stdout += data.toString();
    });

    childProcess.stderr.on('data', (data) => {
      writeVerboseOutput(process.stderr, data);
      stderr += data.toString();
    });

    childProcess.on('close', (code) => {
      if (code === expectedExitCode) {
        resolve({ output: stdout.trim(), exitCode: code });
      } else {
        reject(
          new Error(
            `Command exited with code ${code}, expected ${expectedExitCode}\n${stderr}\n${stdout}`
          )
        );
      }
    });
  });
}

/**
 * Starts the CLI under test and hands back the live child (servers, interactive sessions).
 * @param args - The CLI arguments (no launcher and no package name — see cliUnderTest.mjs)
 * @param stdin - Whether the child's stdin is a pipe or ignored
 * @param workDir - The working directory for the command
 */
export function startGth(args: string[], stdin: 'ignore' | 'pipe', workDir?: string) {
  assertCliUnderTestOnce();
  const testDir = resolveTestDir(workDir);
  const { command, argv, env } = gthSpawnSpec(args, testDir);
  const childProcess = spawn(command, argv, {
    cwd: testDir,
    env,
    stdio: [stdin, 'pipe', 'pipe'],
  });

  childProcess.stdout.on('data', (data) => {
    writeVerboseOutput(process.stdout, data);
  });

  childProcess.stderr.on('data', (data) => {
    writeVerboseOutput(process.stderr, data);
  });

  return childProcess;
}

/**
 * Accumulates a child's stderr so a test can assert on it *after* the interaction and see the
 * offending text verbatim in the failure diff.
 *
 * Replaces the `child.stderr.on('data', d => { throw new Error(d.toString()) })` these tests used
 * to do, which was broken two ways: a throw from inside an async 'data' handler can never fail
 * the test — vitest reports it as an *unhandled error*, so the run exits non-zero while the test
 * itself still reports "passed" — and the text lands buried in a stack trace instead of the
 * assertion output. Accumulating also shows *all* the stderr rather than whichever chunk arrived
 * first, which is what makes the culprit obvious at a glance (a node deprecation warning, a real
 * agent error) rather than something to reconstruct from a repro run.
 */
export function collectStderr(child: ChildProcess): () => string {
  let acc = '';
  child.stderr.on('data', (data) => {
    acc += data.toString();
  });
  return () => acc;
}

export function waitForCursor(child: ChildProcess): Promise<string> {
  return new Promise((resolve, _reject) => {
    let inputPromptListener = getInputPromptListener(child, resolve);
    child.stdout.on('data', inputPromptListener);
  });
}

export function getInputPromptListener(child, resolve) {
  let acc = '';
  const inputPromptListener = (data) => {
    acc += data.toString();
    if (data.toString().includes('>')) {
      resolve(acc);
      child.stdout.removeListener('data', inputPromptListener);
      return;
    }
  };
  return inputPromptListener;
}
