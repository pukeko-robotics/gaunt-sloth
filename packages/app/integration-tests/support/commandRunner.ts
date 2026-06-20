import { spawn } from 'child_process';
import path from 'path';
import { platform } from 'node:os';
import type { ChildProcess } from 'node:child_process';

function isVerboseCommandRunnerEnabled(): boolean {
  const value = process.env.GSLOTH_IT_VERBOSE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function writeVerboseOutput(stream: NodeJS.WriteStream, data: Buffer): void {
  if (isVerboseCommandRunnerEnabled()) {
    stream.write(data);
  }
}

/**
 * Runs a command in the integration-tests directory using spawn
 * This prevents stdin from being treated as a pipe
 * @param command - The main command to run
 * @param args - The command arguments
 * @param endOutput - Output which will terminate the execution
 * @param workDir - The working directory for the command
 * @returns The command output as a string
 */
export async function runCommandWithArgs(
  command: string,
  args: string[],
  endOutput?: string,
  workDir?: string
): Promise<string> {
  const testDir = path.resolve(workDir ? workDir : './packages/app/integration-tests/workdir');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const conf = {
      cwd: testDir,
      env: {
        ...process.env,
        // Belt-and-suspenders: ITs already spawn non-TTY (so the TUI auto-falls back to the
        // readline path), but force it off explicitly so the interactive ITs can never select
        // the Ink TUI regardless of how they are launched. Same assertions, readline path.
        GTH_NO_TUI: '1',
      },
      shell: platform().includes('win') && !platform().includes('darwin'),
      // Explicitly ignore stdin, otherwise the app switches to pipe mode
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const childProcess = spawn(command, args, conf);

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
 * Runs a command expecting it to exit with a specific code
 * @param command - The main command to run
 * @param args - The command arguments
 * @param expectedExitCode - The expected exit code
 * @param workDir - The working directory for the command
 * @returns Object containing output and exit code
 */
export async function runCommandExpectingExitCode(
  command: string,
  args: string[],
  expectedExitCode: number,
  workDir?: string
): Promise<{ output: string; exitCode: number }> {
  const testDir = path.resolve(workDir ? workDir : './packages/app/integration-tests/workdir');
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const childProcess = spawn(command, args, {
      cwd: testDir,
      env: {
        ...process.env,
        // Belt-and-suspenders: ITs already spawn non-TTY (so the TUI auto-falls back to the
        // readline path), but force it off explicitly so the interactive ITs can never select
        // the Ink TUI regardless of how they are launched. Same assertions, readline path.
        GTH_NO_TUI: '1',
      },
      shell: platform().includes('win') && !platform().includes('darwin'),
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

export function startChildProcess(
  command: string,
  args: string[],
  stdin: 'ignore' | 'pipe',
  workDir?: string
) {
  const testDir = path.resolve(workDir ? workDir : './packages/app/integration-tests/workdir');
  const childProcess = spawn(command, args, {
    cwd: testDir,
    env: {
      ...process.env,
    },
    shell: platform().includes('win') && !platform().includes('darwin'),
    // Explicitly ignore stdin, otherwise the app switches to pipe mode
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
