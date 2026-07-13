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
import { ShellCommandFailedError } from '@gaunt-sloth/core/core/shell/ShellCommandFailedError.js';
import { checkHardline } from '#src/tools/shell/hardline.js';
import { buildScrubbedEnv } from '#src/tools/shell/env.js';
import { OutputBuffer } from '#src/tools/shell/outputBuffer.js';
import { getShellWorkDir } from '#src/tools/shell/workDir.js';

// EXT-21: `ShellCommandFailedError` moved to core so BOTH agents can recognise a shell failure
// without breaking the agent→core dependency direction (the lean `GthLangChainAgent` lives in core
// and cannot import from agent). Re-exported here so the historical import site
// (`#src/tools/GthDevToolkit.js`) — GthDeepAgent + the existing GthDevToolkit specs — keeps working
// and every throw below is one and the same core type both agents' softeners catch.
export { ShellCommandFailedError } from '@gaunt-sloth/core/core/shell/ShellCommandFailedError.js';

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

/**
 * The name of the forced acknowledgement parameter added to `run_shell_command` when the deep
 * agent's filesystem tools run in virtualMode. Intentionally a long, self-describing name: the
 * model reads it on every shell call as a reminder that the fs-tool `/` root and the shell's real
 * paths are two different namespaces.
 */
export const VIRTUAL_FS_SHELL_ACK_PARAM =
  'i_acknowledge_that_fs_tools_are_in_virtual_mode_and_paths_could_be_different_from_shell';

/**
 * virtualMode variant of {@link RunShellCommandArgsSchema}. In addition to `command` it carries a
 * FORCED acknowledgement flag ({@link VIRTUAL_FS_SHELL_ACK_PARAM}) so the model cannot call the
 * shell tool without first consciously acknowledging that a filesystem-tool `/`-rooted path is NOT
 * necessarily a valid path for this real-OS shell.
 *
 * The flag is a plain required `z.boolean()`, NOT `z.literal(true)`: a literal emits a JSON-Schema
 * `const`, which Gemini/Vertex AI's function-declaration schema dialect rejects ("Unknown name
 * `const`"), poisoning the whole request. Keeping it a bare boolean produces only `{"type":
 * "boolean"}`, which every provider accepts. The "only true is allowed" constraint is enforced at
 * RUNTIME instead (see the tool body in `createTools`), which returns a recoverable message rather
 * than aborting when the model passes anything but `true`.
 */
const RunShellCommandVirtualArgsSchema = z.object({
  command: z.string().describe('The shell command to run'),
  [VIRTUAL_FS_SHELL_ACK_PARAM]: z
    .boolean()
    .describe(
      'Required — you MUST pass true. By setting this to true you confirm you understand that the ' +
        'filesystem tools (ls/read_file/write_file/edit_file/glob/grep) address a VIRTUAL "/" root ' +
        '(a leading "/" means the working directory) which can differ from the real native paths ' +
        'this shell uses, and that you have verified — or will verify — the real working directory ' +
        'before relying on any path in the command. The command will NOT run unless this is true.'
    ),
});

const TEST_PATH_PLACEHOLDER = '${testPath}';

/**
 * The command that prints the real working directory in the shell `run_shell_command` spawns
 * (`cmd.exe` on Windows, `/bin/sh` on POSIX). Used in the virtualMode shell-tool description so the
 * model is told exactly how to confirm where it really is before trusting a path.
 */
function printWorkDirCommand(): string {
  return process.platform === 'win32' ? '`cd` (with no arguments)' : '`pwd`';
}

/** Base description shared by both the plain and the virtualMode `run_shell_command` tool. */
const RUN_SHELL_COMMAND_BASE_DESCRIPTION =
  'Run an arbitrary shell command in the project working directory and return its ' +
  'combined stdout/stderr and exit status. Use for any task the fixed run_* tools do ' +
  'not cover (e.g. git, package managers, file inspection). Each call is subject to ' +
  'human approval before it runs unless approval has been disabled.';

/**
 * The virtualMode `run_shell_command` description. Appends a path-namespace warning to the base
 * description: the filesystem tools use a virtual `/` root while this shell uses real native OS
 * paths, so the model must verify the real working directory (`pwd` / `cd`) before putting any path
 * into a shell command and should prefer paths relative to the working directory.
 */
function buildVirtualShellDescription(): string {
  return (
    RUN_SHELL_COMMAND_BASE_DESCRIPTION +
    '\n\nIMPORTANT — path namespaces differ in this session: the filesystem tools ' +
    '(ls/read_file/write_file/edit_file/glob/grep) operate on a VIRTUAL "/" root, where a leading ' +
    '"/" means the working directory. This shell runs in the REAL operating system and uses real ' +
    'native paths, so a "/"-rooted path from the filesystem tools is NOT necessarily a valid path ' +
    `for this shell. Before putting any path into a command, confirm the real working directory ` +
    `first (run ${printWorkDirCommand()}), and prefer paths relative to the working directory over ` +
    'absolute ones. You must also pass ' +
    `\`${VIRTUAL_FS_SHELL_ACK_PARAM}: true\` on every call to acknowledge this.`
  );
}

export default class GthDevToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private commands: GthDevToolsConfig;
  /**
   * The active command, threaded through so the EXT-12 absent-config default for the shell
   * tool (ON in `code`, OFF elsewhere) is resolved consistently with the deep agent's
   * interrupt wiring. Omitted → historical OFF-by-default behaviour.
   */
  private readonly command: GthCommand | undefined;
  /**
   * True when the deep agent's deepagents `FilesystemBackend` runs in virtualMode for this run, so
   * the fs tools address a virtual `/` root that can diverge from `run_shell_command`'s real OS
   * paths. When set, the shell tool advertises that divergence (augmented description + the forced
   * {@link VIRTUAL_FS_SHELL_ACK_PARAM} acknowledgement). Defaults to `false` (the lean path, whose
   * fs tools use real paths, and any non-deep caller) so the plain shell tool is unchanged.
   */
  private readonly virtualFs: boolean;

  constructor(
    commands: GthDevToolsConfig = {},
    command?: GthCommand | undefined,
    options?: { virtualFs?: boolean }
  ) {
    super();
    this.commands = commands;
    this.command = command;
    this.virtualFs = options?.virtualFs === true;
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
   * Resolves with a model-facing string on a CLEAN exit (`code === 0`). EXT-20: a non-zero exit
   * and a timeout-kill instead REJECT with a {@link ShellCommandFailedError} that carries the FULL
   * model-facing body — the deep-agent {@link GthDeepShellExitSoftening} middleware converts that
   * throw into an error `ToolMessage` (status:'error' → ✗) while preserving the output, so the
   * model still sees the killed-after-N / exit-code message and can continue. Spawn-level failures
   * (`child.on('error')`) still reject with a plain `Error`.
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
        // EXT-22 (S4) / EXT-23: spawn in the SAME directory the deepagents FilesystemBackend is
        // rooted at, so the shell tool and the fs tools (ls/read_file/write_file/edit_file/glob/grep)
        // operate on one path namespace instead of diverging. `getShellWorkDir()` returns
        // `getCurrentWorkDir()` on the local code/chat runner + AG-UI (where init() roots the backend
        // at `rootDir: getCurrentWorkDir()`), and the ACP session override on the ACP transport (where
        // `gthAcpServer` re-roots the per-session backend to `session/new.cwd` and updates the
        // override to match — see tools/shell/workDir.ts). Evaluated at call time.
        cwd: getShellWorkDir(),
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
          // EXT-20: a timeout-kill is a failure — reject so the deep-agent middleware flips the
          // tool result to status:'error' (✗). The FULL body is preserved on the error so the
          // model's observation is unchanged except for the status.
          reject(
            new ShellCommandFailedError({
              output:
                body +
                `\n\nCommand '${command}' was killed after exceeding the ${Math.round(
                  timeoutMs / 1000
                )}s timeout. ` +
                `If it legitimately needs longer, increase the shell timeout in config.`,
              exitCode: null,
              command,
              toolName,
            })
          );
          return;
        }

        if (code === 0) {
          resolve(body + `\n\nCommand '${command}' completed successfully`);
        } else {
          // EXT-20: a non-zero exit is a failure — reject (was resolve) so the softening
          // middleware surfaces the ✗ (isError) signal while preserving the full output body.
          reject(
            new ShellCommandFailedError({
              output: body + `\n\nCommand '${command}' exited with code ${code}`,
              exitCode: code,
              command,
              toolName,
            })
          );
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
      // In virtualMode the fs tools' `/` root diverges from this shell's real OS paths, so the
      // shell tool warns about it (description) AND forces an explicit per-call acknowledgement
      // (VIRTUAL_FS_SHELL_ACK_PARAM). The "only true is accepted" rule is enforced HERE at runtime
      // (not via a schema literal, which would emit a Vertex-incompatible `const`): a missing/false
      // ack returns a recoverable message so the model retries with it set, rather than aborting.
      // The plain (non-virtual) path keeps the original single-parameter tool unchanged.
      const virtualFs = this.virtualFs;
      const shellSchema = virtualFs ? RunShellCommandVirtualArgsSchema : RunShellCommandArgsSchema;
      tools.push(
        createGthTool(
          async (args: z.infer<typeof shellSchema>): Promise<string> => {
            if (
              virtualFs &&
              (args as Record<string, unknown>)[VIRTUAL_FS_SHELL_ACK_PARAM] !== true
            ) {
              return (
                `Command not run. You must set \`${VIRTUAL_FS_SHELL_ACK_PARAM}: true\` to ` +
                'acknowledge that the filesystem tools address a virtual "/" root that can differ ' +
                "from this shell's real paths. Confirm the real working directory first (run " +
                `${printWorkDirCommand()}), then retry this command with the acknowledgement set ` +
                'to true.'
              );
            }
            return await this.executeCommand(args.command, 'run_shell_command');
          },
          {
            name: 'run_shell_command',
            description: this.virtualFs
              ? buildVirtualShellDescription()
              : RUN_SHELL_COMMAND_BASE_DESCRIPTION,
            schema: shellSchema,
          },
          'execute'
        )
      );
    }

    return tools;
  }
}
