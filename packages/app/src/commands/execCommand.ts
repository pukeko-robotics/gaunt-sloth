import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getExecSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';
import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/core/utils/fileUtils.js';

interface ExecCommandOptions {
  file?: string[];
  /**
   * Inline prompt text. When supplied, this is used as the prompt-executable directly instead of
   * reading the `[script]` file path. Mutually exclusive with the positional `[script]` (passing
   * both is an error — keeps the path-vs-text intent unambiguous).
   */
  message?: string;
  /** Override the LLM sampling temperature for this run (determinism knob). */
  temperature?: number;
  /** Write the run output to a md file as well as stdout. Off by default for pipe ergonomics. */
  writeOutputToFile?: boolean | string;
  /**
   * Extra filesystem roots to allow for this run, in addition to the cwd sandbox (repeatable).
   * Opt-in widening of `exec`'s default cwd-only sandbox; LOUD because it removes a guardrail.
   */
  allowDir?: string[];
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
    // Opt-in sandbox widening: extra allowed roots beyond cwd for this run only.
    ...(options.allowDir && options.allowDir.length > 0 ? { allowDirs: options.allowDir } : {}),
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
      '-m, --message <text>',
      'Inline prompt text to execute (instead of a script file path). Cannot be combined with [script].'
    )
    .option(
      '-f, --file [files...]',
      'Additional context files. Their content is added BEFORE the script.'
    )
    .option(
      '-t, --temperature <number>',
      'LLM sampling temperature for this run (0 = most deterministic)',
      parseFloat
    )
    .option(
      '--allow-dir <path>',
      'Allow filesystem access to an extra directory beyond cwd for this run (repeatable). ' +
        'Removes the default cwd sandbox guardrail — use with care.',
      (value: string, previous: string[] = []) => [...previous, value]
    )
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gsloth exec scripts/release-notes.md\n' +
        '  $ gsloth exec -m "Summarize CHANGELOG.md in three bullets" -t 0\n' +
        '  $ cat scripts/lint-summary.md | gsloth exec\n' +
        '  $ gsloth exec scripts/build-fix.md -f error.log package.json\n'
    )
    .action(async (script: string | undefined, options: ExecCommandOptions) => {
      // -m and a positional script path are mutually exclusive: keep path-vs-text unambiguous.
      if (script && options.message !== undefined) {
        throw new Error('Pass either a [script] path or -m/--message inline text, not both.');
      }

      const config = await initConfig(commandLineConfigOverrides);

      const content: string[] = [];

      // Extra context files are prepended (same convention as `ask`).
      if (options.file) {
        const fileContent = readMultipleFilesFromProjectDir(options.file);
        if (fileContent) {
          content.push(fileContent);
        }
      }

      // The script itself, in precedence order:
      //   1. -m/--message inline text (explicit; wins over stdin)
      //   2. a [script] file path argument
      //   3. stdin (pipe)
      const stringFromStdin = getStringFromStdin();
      if (options.message !== undefined) {
        content.push(wrapContent(options.message, 'script', 'prompt-executable script', true));
      } else if (script) {
        const scriptContent = readMultipleFilesFromProjectDir([script]);
        content.push(wrapContent(scriptContent, 'script', 'prompt-executable script', true));
      } else if (stringFromStdin) {
        content.push(wrapContent(stringFromStdin, 'script', 'prompt-executable script', true));
      }

      if (content.length === 0) {
        throw new Error(
          'A script is required: pass a .md path, inline text with -m, pipe it on stdin, or supply it with -f'
        );
      }

      if (options.allowDir && options.allowDir.length > 0) {
        displayWarning(
          `Filesystem sandbox widened beyond cwd for this run: ${options.allowDir.join(', ')}. ` +
            'The agent can read and write outside the project directory.'
        );
      }

      const execConfig = buildExecConfig(config, options);

      const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      const { resolveAgentFactory } =
        await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');

      let ok = false;
      try {
        ({ ok } = await runSingleShot(
          'EXEC',
          getExecSystemPrompt(execConfig),
          content.join('\n'),
          execConfig,
          createResolvers(),
          'exec',
          // exec defaults to the lean backend; an explicit config.agent.backend overrides it.
          resolveAgentFactory(execConfig, 'lean')
        ));
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        ok = false;
      }

      if (!ok) {
        setExitCode(1);
      }
    });
}
