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
import { displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import {
  CustomToolsConfig,
  CustomCommandConfig,
  CustomCommandParameter,
  ValidationCheck,
} from '@gaunt-sloth/core/config.js';
import { emitToolOutput } from '@gaunt-sloth/core/core/toolOutputChannel.js';
import { createInterface, stdin, stdout } from '@gaunt-sloth/core/utils/systemUtils.js';

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
      });

      let output = '';
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
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
        if (timer) clearTimeout(timer);
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
        if (timer) clearTimeout(timer);
        const errorMsg = `Failed to execute command '${command}': ${error.message}`;
        displayError(errorMsg);
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
