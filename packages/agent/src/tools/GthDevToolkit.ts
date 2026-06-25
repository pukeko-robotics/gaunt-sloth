/**
 * @module GthDevToolkit
 */
import { BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn, spawnSync } from 'child_process';
import path from 'node:path';
import { displayInfo, displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  GthDevToolsConfig,
  getShellMaxOutputBytes,
  getShellTimeoutMs,
  isShellToolEnabled,
} from '@gaunt-sloth/core/config.js';
import type { GthCommand } from '@gaunt-sloth/core/core/types.js';
import { stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
import { checkHardline } from '#src/tools/shell/hardline.js';
import { buildScrubbedEnv } from '#src/tools/shell/env.js';
import { OutputBuffer } from '#src/tools/shell/outputBuffer.js';

// Grace period (ms) between SIGTERM and the escalation to SIGKILL when a command
// exceeds its timeout. Mirrors opencode's `forceKillAfter` (3s).
const KILL_GRACE_MS = 3_000;

/**
 * Kill the child AND its descendants on timeout.
 *
 * POSIX: the child is spawned `detached`, so it leads its own process group;
 * signalling the NEGATIVE pid (`-pid`) delivers to the whole group — otherwise a
 * shell's children (e.g. a spawned server) would be orphaned and keep running.
 *
 * Windows (EXT-15): there are no POSIX process groups — `process.kill(-pid)`
 * throws `EINVAL`, and `child.kill()` only terminates the `cmd.exe` wrapper while
 * grandchildren keep the piped stdio handles open, so `'close'` never fires and
 * the tool Promise hangs forever (silently cancelling Windows CI). Use `taskkill
 * /T` to kill the whole tree by pid; `/F` (force) mirrors POSIX SIGKILL, while a
 * graceful taskkill mirrors SIGTERM. Swallows the races where it has already exited.
 *
 * Exported for unit testing the platform branch without a Windows host.
 */
export function killProcessGroup(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals
): void {
  if (typeof child.pid !== 'number') return;

  if (process.platform === 'win32') {
    // No process groups on Windows; taskkill /T walks the whole tree by pid.
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    // IMPORTANT: spawnSync does NOT throw when it fails to spawn (e.g. ENOENT if taskkill is
    // missing from PATH) — unlike execSync, it returns an object with an `error` property. So a
    // try/catch would never reach the fallback. Inspect `res.error` explicitly and fall back to
    // the direct child kill (best effort). A non-zero exit (process already gone) is NOT a spawn
    // failure, so it correctly does not trigger the fallback. (`res?.` tolerates test mocks.)
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    if (res?.error) {
      try {
        child.kill(signal);
      } catch {
        // Already exited — nothing to do.
      }
    }
    return;
  }

  try {
    // Negative pid → signal the entire process group.
    process.kill(-child.pid, signal);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ESRCH: already gone. EPERM: group-kill not permitted — fall through to the
    // direct child kill below. Anything else: also fall back rather than throw.
    if (code === 'ESRCH') return;
  }
  // Fallback: kill just the child (best effort).
  try {
    child.kill(signal);
  } catch {
    // Already exited — nothing to do.
  }
}

// Helper function to create a tool with dev type
function createGthTool<T extends z.ZodSchema>(
  fn: (args: z.infer<T>) => Promise<string>,
  config: {
    name: string;
    description: string;
    schema: T;
  },
  gthDevType: 'execute'
): StructuredToolInterface {
  const toolInstance = tool(fn, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (toolInstance as any).gthDevType = gthDevType;
  return toolInstance;
}

// Schema definitions for built-in tools
const RunTestsArgsSchema = z.object({});
const RunLintArgsSchema = z.object({});
const RunBuildArgsSchema = z.object({});
const RunSingleTestArgsSchema = z.object({
  testPath: z.string().describe('Relative path to the test file to run'),
});
const RunShellCommandArgsSchema = z.object({
  command: z.string().describe('The shell command to run'),
});

const TEST_PATH_PLACEHOLDER = '${testPath}';

export default class GthDevToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private commands: GthDevToolsConfig;
  /**
   * The active command, threaded through so the EXT-12 absent-config default for the shell
   * tool (ON in `code`, OFF elsewhere) is resolved consistently with the deep agent's
   * interrupt wiring. Omitted → historical OFF-by-default behaviour.
   */
  private readonly command: GthCommand | undefined;

  constructor(commands: GthDevToolsConfig = {}, command?: GthCommand | undefined) {
    super();
    this.commands = commands;
    this.command = command;
    this.tools = this.createTools();
  }

  /**
   * Get tools filtered by operation type
   */
  getFilteredTools(allowedOperations: 'execute'[]): StructuredToolInterface[] {
    return this.tools.filter((tool) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolType = (tool as any).gthDevType;
      return allowedOperations.includes(toolType);
    });
  }

  /**
   * Validate parameter value to prevent security issues
   */
  validateParameterValue(paramValue: string, paramName: string): string {
    // Check for absolute paths
    if (path.isAbsolute(paramValue)) {
      throw new Error(`Absolute paths are not allowed for parameter '${paramName}'`);
    }

    // Check for directory traversal attempts
    if (paramValue.includes('..') || paramValue.includes('\\..\\') || paramValue.includes('/../')) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    // Check for pipe attempts and other shell injection
    if (
      paramValue.includes('|') ||
      paramValue.includes('&') ||
      paramValue.includes(';') ||
      paramValue.includes('`') ||
      paramValue.includes('$') ||
      paramValue.includes('$(') ||
      paramValue.includes('\n') ||
      paramValue.includes('\r')
    ) {
      throw new Error(`Shell injection attempts are not allowed in parameter '${paramName}'`);
    }

    // Check for null bytes
    if (paramValue.includes('\0')) {
      throw new Error(`Null bytes are not allowed in parameter '${paramName}'`);
    }

    // Normalize the path to remove any redundant separators
    const normalizedValue = path.normalize(paramValue);

    // Double-check after normalization
    if (normalizedValue.includes('..')) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    return normalizedValue;
  }

  /**
   * Build the command for running a single test file
   */
  private buildSingleTestCommand(testPath: string): string {
    if (this.commands.run_single_test) {
      if (this.commands.run_single_test.includes(TEST_PATH_PLACEHOLDER)) {
        // Interpolate if placeholder is available
        return this.commands.run_single_test.replace(TEST_PATH_PLACEHOLDER, testPath);
      } else {
        // Concatenate if no placeholder
        return `${this.commands.run_single_test} ${testPath}`;
      }
    } else {
      throw new Error('No test command configured');
    }
  }

  /**
   * Execute a shell command with the EXT-9 Tier-1 hardening applied:
   *  1. stdin closed + timeout + process-group kill (no hang on interactive
   *     commands; runaway commands are killed group-wide on timeout),
   *  2. output capped with a head/tail window + temp-file spillover,
   *  3. provider/LLM credentials scrubbed from the child env,
   *  4. an unbypassable hardline blocklist (refuses catastrophic commands BEFORE
   *     spawn — fires even when confirmation is bypassed by yolo).
   *
   * Resolves with a model-facing string. Timeouts resolve (not reject) so the
   * model sees the killed-after-N message and can continue.
   */
  private async executeCommand(command: string, toolName: string): Promise<string> {
    displayInfo(`\n🔧 Executing ${toolName}: ${command}`);

    // (4) Hardline blocklist — checked here so it fires regardless of yolo,
    // allow-lists, or any confirmation path. Refuse WITHOUT executing.
    const hardline = checkHardline(command);
    if (hardline) {
      const refusal =
        `Refusing to execute '${command}': blocked by hardline safety policy ` +
        `(${hardline.description}). This is a catastrophic, non-recoverable command ` +
        `and is blocked even when command confirmation is disabled.`;
      displayWarning(`\n⛔ ${refusal}`);
      return refusal;
    }

    const timeoutMs = getShellTimeoutMs(this.commands);
    const maxOutputBytes = getShellMaxOutputBytes(this.commands);

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        // (1) Never let the child block on stdin (e.g. git commit opening $EDITOR).
        stdio: ['ignore', 'pipe', 'pipe'],
        // (1) POSIX: own process group so we can kill the whole tree on timeout
        // (see killProcessGroup). No-op/harmful on Windows, which uses taskkill /T.
        detached: process.platform !== 'win32',
        // (3) Child env with provider/LLM credentials removed.
        env: buildScrubbedEnv(),
      });

      // (2) Bounded capture for the returned message; live streaming is uncapped.
      const buffer = new OutputBuffer(maxOutputBytes);
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, 'SIGTERM');
        // Escalate to SIGKILL after a short grace if it didn't die.
        killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS);
        // killTimer must not keep the event loop alive on its own.
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();

      const clearTimers = (): void => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          stdout.write(chunk);
          buffer.append(chunk);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          stdout.write(chunk);
          buffer.append(chunk);
        });
      }

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimers();

        const captured = buffer.finalize();
        const body =
          `Executing '${command}'...\n\n` +
          `<COMMAND_OUTPUT>\n` +
          captured.text +
          `</COMMAND_OUTPUT>\n`;

        if (timedOut) {
          resolve(
            body +
              `\n\nCommand '${command}' was killed after exceeding the ${Math.round(
                timeoutMs / 1000
              )}s timeout. ` +
              `If it legitimately needs longer, increase the shell timeout in config.`
          );
          return;
        }

        if (code === 0) {
          resolve(body + `\n\nCommand '${command}' completed successfully`);
        } else {
          resolve(body + `\n\nCommand '${command}' exited with code ${code}`);
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        const errorMsg = `Failed to execute command '${command}': ${error.message}`;
        displayError(errorMsg);
        reject(new Error(errorMsg));
      });
    });
  }

  private createTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [];

    if (this.commands.run_tests) {
      tools.push(
        createGthTool(
          async (_args: z.infer<typeof RunTestsArgsSchema>): Promise<string> => {
            return await this.executeCommand(this.commands.run_tests!, 'run_tests');
          },
          {
            name: 'run_tests',
            description:
              'Execute the test suite for this project. Runs the configured test command and returns the output.' +
              `\nThe configured command is [${this.commands.run_tests!}].`,
            schema: RunTestsArgsSchema,
          },
          'execute'
        )
      );
    }

    if (this.commands.run_single_test) {
      tools.push(
        createGthTool(
          async (args: z.infer<typeof RunSingleTestArgsSchema>): Promise<string> => {
            const validatedPath = this.validateParameterValue(args.testPath, 'testPath');
            const command = this.buildSingleTestCommand(validatedPath);
            return await this.executeCommand(command, 'run_single_test');
          },
          {
            name: 'run_single_test',
            description:
              'Execute a single test file. Runs the configured test command with the specified test file path. ' +
              'The test path must be relative and cannot contain directory traversal attempts or shell injection. ' +
              `\nThe base command is [${this.commands.run_single_test}].`,
            schema: RunSingleTestArgsSchema,
          },
          'execute'
        )
      );
    }

    if (this.commands.run_lint) {
      tools.push(
        createGthTool(
          async (_args: z.infer<typeof RunLintArgsSchema>): Promise<string> => {
            return await this.executeCommand(this.commands.run_lint!, 'run_lint');
          },
          {
            name: 'run_lint',
            description:
              'Run the linter on the project code. Executes the configured lint command and returns any linting errors or warnings.' +
              `\nThe configured command is [${this.commands.run_lint!}].`,
            schema: RunLintArgsSchema,
          },
          'execute'
        )
      );
    }

    if (this.commands.run_build) {
      tools.push(
        createGthTool(
          async (_args: z.infer<typeof RunBuildArgsSchema>): Promise<string> => {
            return await this.executeCommand(this.commands.run_build!, 'run_build');
          },
          {
            name: 'run_build',
            description:
              'Build the project. Executes the configured build command and returns the build output.' +
              `\nThe configured command is [${this.commands.run_build!}].`,
            schema: RunBuildArgsSchema,
          },
          'execute'
        )
      );
    }

    // Opt-in general-purpose shell tool. Unlike the fixed run_* commands, the model supplies
    // the command, so the guardrail is the per-command confirmation dialog wired by the deep
    // agent (createDeepAgent `interruptOn`), not a parameter sanitizer — a real shell command
    // legitimately contains pipes / `$` / `;`, so validateParameterValue must NOT be applied.
    if (isShellToolEnabled(this.commands, this.command)) {
      tools.push(
        createGthTool(
          async (args: z.infer<typeof RunShellCommandArgsSchema>): Promise<string> => {
            return await this.executeCommand(args.command, 'run_shell_command');
          },
          {
            name: 'run_shell_command',
            description:
              'Run an arbitrary shell command in the project working directory and return its ' +
              'combined stdout/stderr and exit status. Use for any task the fixed run_* tools do ' +
              'not cover (e.g. git, package managers, file inspection). Each call is subject to ' +
              'human approval before it runs unless approval has been disabled.',
            schema: RunShellCommandArgsSchema,
          },
          'execute'
        )
      );
    }

    return tools;
  }
}
