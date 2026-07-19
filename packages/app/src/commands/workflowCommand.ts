import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { display, displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';

interface WorkflowCommandOptions {
  /** `--args <json>` — a JSON value handed to the script as `ctx.args`. */
  args?: string;
}

/**
 * Parse `--args <json>` into the value handed to the script as `ctx.args`. `undefined` (flag
 * omitted) passes through as `undefined`; a malformed value throws a clear `Error` (never a raw
 * `SyntaxError`) so the command can fail with a readable message instead of a stack trace.
 */
export function parseWorkflowArgs(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid --args JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Adds the `workflow` command to the program.
 *
 * `gth workflow <script> [--args <json>]` — runs a local JS orchestration script that drives one or
 * more agent calls through the workflow host (`@gaunt-sloth/batch`). The workflow's return value is
 * its output: a string is printed as-is, anything else as pretty JSON.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function workflowCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('workflow')
    .description(
      'Run a local JS orchestration script (.mjs/.js) that drives one or more agent calls. ' +
        'The script is arbitrary local ESM run with full Node privileges (it can read files and ' +
        'spawn processes) — run only scripts you trust, as you would any local script.'
    )
    .argument(
      '<script>',
      'Path to the .mjs/.js workflow script (default export: async (ctx) => result)'
    )
    .option('--args <json>', 'A JSON value passed to the script as ctx.args')
    .action(async (script: string, options: WorkflowCommandOptions) => {
      let args: unknown;
      try {
        args = parseWorkflowArgs(options.args);
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
        return;
      }

      const baseConfig = await initConfig(commandLineConfigOverrides);

      // Specific `.js` subpath (not the bare package root) — matches the house convention that
      // vitest's workspace-import resolver recognizes and resolves straight to source.
      const { runWorkflow } = await import('@gaunt-sloth/batch/workflow/runWorkflow.js');

      // runWorkflow lets script errors propagate; the CLI is the layer that handles them — surface
      // a clean message + non-zero exit (consistent with the --args parse path above) instead of an
      // unhandled-rejection stack trace.
      let result: unknown;
      try {
        result = await runWorkflow(script, {
          baseConfig,
          commandLineConfigOverrides,
          args,
        });
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
        return;
      }

      // A workflow's return value IS its output: strings print as-is, anything else as pretty JSON.
      if (typeof result === 'string') {
        display(result);
      } else {
        display(JSON.stringify(result, null, 2));
      }
    });
}
