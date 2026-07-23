/**
 * @module GthCustomToolkit
 * Toolkit for user-defined custom shell commands.
 * Provides secure execution of shell commands with parameter validation.
 */
import { BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import type { ToolRunnableConfig } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn } from 'child_process';
import path from 'node:path';
// TUI-C31 (a): the spawn-error advisory travels the tool-output channel (see emitToolOutput) so it
// reaches the managed frame under the Ink TUI; the channel's default sink still renders it via
// displayError for headless surfaces. displayWarning stays for the interactive validation-override
// prompt below, which is a readline stdin flow (out of scope for the tool-output channel).
import { displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  CustomToolsConfig,
  CustomCommandConfig,
  CustomCommandParameter,
  ValidationCheck,
} from '@gaunt-sloth/core/config.js';
import { emitToolOutput } from '@gaunt-sloth/core/core/toolOutputChannel.js';
import { createInterface, stdin, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';
// EXT-42: reuse GthDevToolkit's OWN spawn-hardening helpers so the two toolkits share one
// implementation and cannot drift. `buildScrubbedEnv`/`getShellWorkDir` are the shell helpers the
// dev toolkit imports; `killProcessGroup` is exported from GthDevToolkit itself. Do NOT re-implement.
import { buildScrubbedEnv } from '#src/tools/shell/env.js';
import { getShellWorkDir } from '#src/tools/shell/workDir.js';
import { killProcessGroup } from '#src/tools/GthDevToolkit.js';

// Helper function to create a tool with execute type. The fn's second parameter is LangChain's
// ToolRunnableConfig — when the framework invokes the tool with a ToolCall, `config.toolCall.id`
// identifies the call, which TUI-C17 threads into the live-output channel for attribution.
function createCustomTool<T extends z.ZodSchema>(
  fn: (args: z.infer<T>, config?: ToolRunnableConfig) => Promise<string>,
  config: {
    name: string;
    description: string;
    schema: T;
  }
): StructuredToolInterface {
  const toolInstance = tool(fn, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (toolInstance as any).gthCustomType = 'execute';
  return toolInstance;
}

export default class GthCustomToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private customTools: CustomToolsConfig;

  constructor(customTools: CustomToolsConfig = {}) {
    super();
    this.customTools = customTools;
    this.tools = this.createTools();
  }

  /**
   * Validate parameter value to prevent security issues.
   * Checks can be selectively skipped via the `allow` list.
   */
  validateParameterValue(
    paramValue: string,
    paramName: string,
    allow: ValidationCheck[] = []
  ): string {
    const allowSet = new Set(allow);

    // Check for absolute paths
    if (!allowSet.has('absolute-paths') && path.isAbsolute(paramValue)) {
      throw new Error(`Absolute paths are not allowed for parameter '${paramName}'`);
    }

    // Check for directory traversal attempts
    if (
      !allowSet.has('directory-traversal') &&
      (paramValue.includes('..') || paramValue.includes('\\..\\') || paramValue.includes('/../'))
    ) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    // Check for pipe attempts and other shell injection
    if (
      !allowSet.has('shell-injection') &&
      (paramValue.includes('|') ||
        paramValue.includes('&') ||
        paramValue.includes(';') ||
        paramValue.includes('`') ||
        paramValue.includes("'") ||
        paramValue.includes('$') ||
        paramValue.includes('$(') ||
        paramValue.includes('\n') ||
        paramValue.includes('\r'))
    ) {
      throw new Error(
        `Shell injection attempts are not allowed in parameter '${paramName}'.` +
          'Disallowed symbols pipe, ampersand, semicolon, backtick, single quote, dollar sign, command substitution, newline, carriage return'
      );
    }

    // Check for null bytes
    if (!allowSet.has('null-bytes') && paramValue.includes('\0')) {
      throw new Error(`Null bytes are not allowed in parameter '${paramName}'`);
    }

    // Normalize the path to remove any redundant separators
    // Skip normalization when absolute paths are allowed, since normalize
    // would strip the leading separator context on some values
    if (allowSet.has('absolute-paths')) {
      // Still do the post-normalization traversal check when traversal is not allowed
      if (!allowSet.has('directory-traversal')) {
        const normalizedValue = path.normalize(paramValue);
        if (normalizedValue.includes('..')) {
          throw new Error(
            `Directory traversal attempts are not allowed in parameter '${paramName}'`
          );
        }
      }
      return paramValue;
    }

    const normalizedValue = path.normalize(paramValue);

    // Double-check after normalization
    if (!allowSet.has('directory-traversal') && normalizedValue.includes('..')) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    return normalizedValue;
  }

  /**
   * Build a custom command with parameter interpolation
   */
  buildCustomCommand(
    commandTemplate: string,
    parameters: Record<string, string>,
    parameterConfig?: Record<string, CustomCommandParameter>
  ): string {
    let command = commandTemplate;
    const paramNames = Object.keys(parameters);

    // Check if all provided parameters have placeholders or should be appended
    const hasPlaceholders = paramNames.some((name) => command.includes(`\${${name}}`));

    if (hasPlaceholders) {
      // Replace all placeholders with validated parameter values
      for (const [name, value] of Object.entries(parameters)) {
        const allow = parameterConfig?.[name]?.allow || [];
        const validatedValue = this.validateParameterValue(value, name, allow);
        const placeholder = '${' + name + '}';
        command = command.replace(
          new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          validatedValue
        );
      }
    } else if (paramNames.length > 0 && parameterConfig) {
      // Append parameters in the order defined in the config
      const orderedParams = Object.keys(parameterConfig);
      const appendValues: string[] = [];
      for (const name of orderedParams) {
        if (parameters[name] !== undefined) {
          const allow = parameterConfig[name]?.allow || [];
          const validatedValue = this.validateParameterValue(parameters[name], name, allow);
          appendValues.push(validatedValue);
        }
      }
      if (appendValues.length > 0) {
        command = `${command} ${appendValues.join(' ')}`;
      }
    }

    return command;
  }

  /**
   * Prompt the user to confirm execution of a command that failed validation.
   * Returns true if the user confirms, false otherwise.
   */
  async promptUserForValidationOverride(
    command: string,
    toolName: string,
    validationError: string
  ): Promise<boolean> {
    displayWarning(`\n⚠️  Validation failed for tool '${toolName}': ${validationError}`);
    displayWarning(`The agent is trying to execute: ${command}`);
    displayWarning(
      'You can add "allow" to this tool\'s configuration in .gsloth.config.json to skip this check (permanent). ' +
        'Available values: "absolute-paths", "directory-traversal", "shell-injection", "null-bytes"'
    );

    // The agent stream may have stdin in raw mode for Escape/Q interruption.
    // Readline needs canonical line mode for y/N to be delivered after Enter.
    const shouldRestoreRawMode = stdin.isTTY && stdin.isRaw;
    if (shouldRestoreRawMode) {
      stdin.setRawMode(false);
    }

    // Write prompt manually to avoid double-echo when readline echoes input
    stdout.write('Do you want to allow this execution (one-time)? (y/N): ');

    const rl = createInterface({ input: stdin });
    try {
      const answer = await rl.question('');
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    } finally {
      rl.close();
      if (shouldRestoreRawMode) {
        stdin.setRawMode(true);
      }
    }
  }

  private async executeCommand(
    command: string,
    toolName: string,
    timeoutSeconds?: number,
    toolCallId?: string
  ): Promise<string> {
    // TUI-C17: the "Executing" notice + live child output go through the tool-output channel.
    // With no subscriber (every non-TUI surface) the channel's default sink reproduces the
    // historical behaviour exactly (displayInfo notice, raw stdout chunks); under the Ink TUI
    // the session subscribes and folds them into the managed frame instead.
    emitToolOutput({
      toolCallId,
      toolName,
      kind: 'notice',
      text: `🔧 Executing ${toolName}: ${command}`,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        // EXT-42: spawn in the SAME working directory as GthDevToolkit's `run_shell_command`, via
        // the shared getShellWorkDir() helper, so custom-tool subprocesses and the agent's own shell
        // agree on one path namespace (the deepagents fs-backend root, tracking the ACP session cwd).
        cwd: getShellWorkDir(),
        // EXT-39 (part 2): give the child /dev/null on stdin so it reads EOF immediately instead
        // of inheriting an open-but-never-written `pipe` (spawn's default). Without this, a spawned
        // command that probes stdin — notably a nested `gth` invocation (a custom tool shelling out
        // to `gth -i graph-recall ask …`), whose stdin heuristic sees non-TTY stdin and waits on
        // `'end'` for piped input that never arrives — hangs forever, bounded only by this tool's
        // timeout. Custom tools are non-interactive one-shot commands that take input via
        // args/placeholders, never the inherited pipe, so closing child stdin is correct. stdout
        // and stderr stay piped so the tool still captures them (below). This mirrors
        // GthDevToolkit's `run_shell_command` spawn, which already sets the same stdio for the same
        // reason.
        stdio: ['ignore', 'pipe', 'pipe'],
        // EXT-42: POSIX own process group so a timeout can reap the WHOLE child tree via
        // killProcessGroup (negative pid), not just the shell. No-op/harmful on Windows, which uses
        // taskkill /T inside that shared helper. Mirrors GthDevToolkit's `run_shell_command` exactly.
        detached: process.platform !== 'win32',
        // EXT-42 (headline, security): child env with LLM/cloud credentials removed via the shared
        // buildScrubbedEnv(). Without this a user-defined custom tool that shells out inherits the
        // RAW parent env and can leak API keys / secrets to the subprocess and its logs. Closes the
        // parity gap with the agent's own `run_shell_command`, which already gets a scrubbed env.
        env: buildScrubbedEnv(),
      });

      let output = '';
      let timedOut = false;
      // TUI-C31 (a): a single-settle guard mirroring GthDevToolkit. The promise itself ignores a
      // second resolve/reject, but the 'error' handler's SIDE EFFECT (routing an error advisory
      // through the tool-output channel) would still run if 'error' fired after a successful
      // 'close' — surfacing a spurious error chunk in the managed frame. Guarding both handlers
      // makes 'close' and 'error' mutually exclusive, as they already are in GthDevToolkit.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // EXT-44: the second timer that escalates the timeout kill from SIGTERM to SIGKILL after a
      // short grace, mirroring GthDevToolkit. Cleared alongside `timer` on close/error below.
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          // EXT-42: reap the whole process GROUP (not just the shell) so a `detached` child's
          // descendants die too, via GthDevToolkit's exported killProcessGroup (negative-pid on
          // POSIX, taskkill /T on Windows). SIGTERM keeps the historical signal and the
          // "timed out after N seconds" message byte-for-byte unchanged — only the kill TARGET
          // widens from the lone shell to its group.
          killProcessGroup(child, 'SIGTERM');
          // EXT-44: escalate to SIGKILL after a short grace so a child that traps/ignores SIGTERM
          // is still force-killed — parity with GthDevToolkit's ladder. That toolkit uses a private
          // `KILL_GRACE_MS = 3_000` (not exported), so the same 3000ms literal is used here.
          killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 3000);
          // The escalation timer must not keep the event loop alive on its own.
          killTimer.unref?.();
        }, timeoutSeconds * 1000);
      }

      // Capture output if available (when stdio is not 'inherit')
      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          emitToolOutput({ toolCallId, toolName, kind: 'output', text: chunk });
          output += chunk;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          emitToolOutput({ toolCallId, toolName, kind: 'output', text: chunk });
          output += chunk;
        });
      }

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // EXT-44: cancel the pending SIGKILL escalation so a child that closes within the grace
        // (including a normal exit) never receives a stray SIGKILL and no timer leaks.
        if (killTimer) clearTimeout(killTimer);
        if (timedOut) {
          resolve(
            `Executing '${command}'...\n\n` +
              `<COMMAND_OUTPUT>\n` +
              output +
              `</COMMAND_OUTPUT>\n` +
              `\n\nCommand '${command}' timed out after ${timeoutSeconds} seconds`
          );
        } else if (code === 0) {
          resolve(
            `Executing '${command}'...\n\n` +
              `<COMMAND_OUTPUT>\n` +
              output +
              `</COMMAND_OUTPUT>\n` +
              `\n\nCommand '${command}' completed successfully`
          );
        } else {
          resolve(
            `Executing '${command}'...\n\n` +
              `<COMMAND_OUTPUT>\n` +
              output +
              `</COMMAND_OUTPUT>\n` +
              `\n\nCommand '${command}' exited with code ${code}`
          );
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // EXT-44: also cancel the pending SIGKILL escalation on a spawn/runtime error.
        if (killTimer) clearTimeout(killTimer);
        const errorMsg = `Failed to execute command '${command}': ${error.message}`;
        // TUI-C31 (a): route through the tool-output channel so the spawn-error advisory lands in
        // the managed frame under the TUI (headless still gets displayError via the default sink).
        emitToolOutput({ toolCallId, toolName, kind: 'error', text: errorMsg });
        reject(new Error(errorMsg));
      });
    });
  }

  /**
   * Create a Zod schema for a custom command's parameters
   */
  private createCustomCommandSchema(
    config: CustomCommandConfig
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): z.ZodObject<any> {
    if (!config.parameters || Object.keys(config.parameters).length === 0) {
      return z.object({});
    }

    const shape: Record<string, z.ZodString> = {};
    for (const [paramName, paramConfig] of Object.entries(config.parameters)) {
      shape[paramName] = z.string().describe(paramConfig.description);
    }

    return z.object(shape);
  }

  /**
   * Build command without validation (for display in the user prompt).
   * Simply interpolates parameters into the template without security checks.
   */
  private buildCommandForDisplay(
    commandTemplate: string,
    parameters: Record<string, string>,
    parameterConfig?: Record<string, CustomCommandParameter>
  ): string {
    let command = commandTemplate;
    const paramNames = Object.keys(parameters);
    const hasPlaceholders = paramNames.some((name) => command.includes(`\${${name}}`));

    if (hasPlaceholders) {
      for (const [name, value] of Object.entries(parameters)) {
        const placeholder = '${' + name + '}';
        command = command.replace(
          new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          value
        );
      }
    } else if (paramNames.length > 0 && parameterConfig) {
      const orderedParams = Object.keys(parameterConfig);
      const appendValues: string[] = [];
      for (const name of orderedParams) {
        if (parameters[name] !== undefined) {
          appendValues.push(parameters[name]);
        }
      }
      if (appendValues.length > 0) {
        command = `${command} ${appendValues.join(' ')}`;
      }
    }

    return command;
  }

  /**
   * Create a tool for a custom command
   */
  private createCustomCommandTool(
    name: string,
    config: CustomCommandConfig
  ): StructuredToolInterface {
    const schema = this.createCustomCommandSchema(config);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolFn = async (args: any, runnableConfig?: ToolRunnableConfig): Promise<string> => {
      // All parameters are strings, safe to cast
      const stringArgs = args as Record<string, string>;
      // TUI-C17: the invoking framework's tool call id, threaded into the live-output channel
      // so streamed chunks are attributed to this exact call.
      const toolCallId = runnableConfig?.toolCall?.id;

      try {
        const command = this.buildCustomCommand(config.command, stringArgs, config.parameters);
        return await this.executeCommand(command, name, config.timeout, toolCallId);
      } catch (validationError) {
        // If validation fails, prompt the user for confirmation
        const errorMessage =
          validationError instanceof Error ? validationError.message : String(validationError);
        const displayCommand = this.buildCommandForDisplay(
          config.command,
          stringArgs,
          config.parameters
        );

        const userConfirmed = await this.promptUserForValidationOverride(
          displayCommand,
          name,
          errorMessage
        );

        if (userConfirmed) {
          return await this.executeCommand(displayCommand, name, undefined, toolCallId);
        }

        throw new Error(
          `Execution of '${name}' was rejected by user. Validation error: ${errorMessage}`
        );
      }
    };

    return createCustomTool(toolFn, {
      name,
      description: config.description + `\nThe configured command is [${config.command}].`,
      schema,
    });
  }

  private createTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [];

    // Create tools for custom commands
    for (const [name, config] of Object.entries(this.customTools)) {
      tools.push(this.createCustomCommandTool(name, config));
    }

    return tools;
  }
}
