import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getExecSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';

interface ExecCommandOptions {
  file?: string[];
  /** Override the LLM sampling temperature for this run (determinism knob). */
  temperature?: number;
  /** Write the run output to a md file as well as stdout. Off by default for pipe ergonomics. */
  writeOutputToFile?: boolean | string;
}

/**
 * Build the effective, non-interactive config for an `exec` run.
 *
 * `exec` is the prompt-as-script sibling of `ask`: it shares the same single-shot agent runtime
 * but tunes the config for reproducible, pipe-friendly "do-the-job" runs:
 * - the result is streamed to stdout and is NOT written to a md report by default (so it pipes
 *   cleanly), unless the user explicitly asks for a file via `-w`;
 * - inference cannot be interrupted with ESC (there is no interactive user);
 * - if a temperature is supplied it is applied to the LLM for near-deterministic output.
 *
 * Exposed (and unit-tested) separately so the runtime is reusable across the Pukeko impls.
 */
export function buildExecConfig(config: GthConfig, options: ExecCommandOptions): GthConfig {
  const execConfig: GthConfig = {
    ...config,
    // Non-interactive: ESC-to-interrupt only makes sense in a TTY session.
    canInterruptInferenceWithEsc: false,
    // Default to stdout-only so the run output can be piped; honor an explicit -w.
    writeOutputToFile: options.writeOutputToFile ?? false,
  };

  // Best-effort determinism knob. LangChain chat models expose `temperature` as a mutable field;
  // setting it to 0 (the recommended exec default) makes runs as reproducible as the provider
  // allows. Guard with `in` so providers without the field are left untouched.
  if (options.temperature !== undefined && execConfig.llm && 'temperature' in execConfig.llm) {
    (execConfig.llm as unknown as { temperature: number }).temperature = options.temperature;
  }

  return execConfig;
}

/**
 * Adds the `exec` command to the program.
 *
 * `gth exec <script.md>` runs a markdown "prompt-executable" (prose + code/command snippets)
 * reliably and near-deterministically — "AI as a normal terminal technology". The script can be
 * a path argument, piped on stdin, or supplied via `-f`; extra `-f` files are prepended as
 * context. Output goes to stdout (suitable for piping); a non-zero exit code signals failure.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function execCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('exec')
    .description(
      'Run a markdown prompt-executable (prose + code snippets) reliably and near-deterministically'
    )
    .argument('[script]', 'Path to the .md script to execute')
    .option(
      '-f, --file [files...]',
      'Additional context files. Their content is added BEFORE the script.'
    )
    .option(
      '-t, --temperature <number>',
      'LLM sampling temperature for this run (0 = most deterministic)',
      parseFloat
    )
    .action(async (script: string | undefined, options: ExecCommandOptions) => {
      const config = await initConfig(commandLineConfigOverrides);

      const content: string[] = [];

      // Extra context files are prepended (same convention as `ask`).
      if (options.file) {
        const fileContent = readMultipleFilesFromProjectDir(options.file);
        if (fileContent) {
          content.push(fileContent);
        }
      }

      // The script itself: a file path argument wins; otherwise read it from stdin (pipe).
      const stringFromStdin = getStringFromStdin();
      if (script) {
        const scriptContent = readMultipleFilesFromProjectDir([script]);
        content.push(wrapContent(scriptContent, 'script', 'prompt-executable script', true));
      } else if (stringFromStdin) {
        content.push(wrapContent(stringFromStdin, 'script', 'prompt-executable script', true));
      }

      if (content.length === 0) {
        throw new Error(
          'A script is required: pass a .md path, pipe it on stdin, or supply it with -f'
        );
      }

      const execConfig = buildExecConfig(config, options);

      const { askQuestion } =
        await import('@gaunt-sloth/review/modules/questionAnsweringModule.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');

      let ok = false;
      try {
        ok = await askQuestion(
          'EXEC',
          getExecSystemPrompt(execConfig),
          content.join('\n'),
          execConfig,
          createResolvers(),
          'exec'
        );
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        ok = false;
      }

      if (!ok) {
        setExitCode(1);
      }
    });
}
