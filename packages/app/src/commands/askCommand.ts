import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getAskSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/core/utils/fileUtils.js';

interface AskCommandOptions {
  file?: string[];
  /**
   * Opt `ask` into "do-the-job" mode: enable the same full filesystem + dev tools that
   * `exec`/`code` get, so the question can act (read/write files, run commands) rather than
   * just chat. Off by default; loud when active because it grants write access.
   */
  write?: boolean;
}

/**
 * When `ask --write` is set, upgrade the effective config so the `ask` run gets the same
 * "do-the-job" capabilities as `exec`/`code`: full (`all`) filesystem access plus dev tools.
 *
 * Filesystem mode is overridden on the per-command `commands.ask` slice (where
 * `getEffectiveConfig` reads it from), and `askWriteMode` is set so the agent's tool resolution
 * enables dev tools for `ask`. CFG-18: the dev/shell tools live in the unified `builtInTools`
 * registry, so `ask --write` reuses exec's (falling back to code's) `builtInTools` config — copied
 * onto `commands.ask.builtInTools` — rather than a separate `devTools` key. Returns the config
 * untouched when `--write` is not set.
 *
 * Exported for unit testing.
 */
export function applyAskWriteMode(config: GthConfig, options: AskCommandOptions): GthConfig {
  if (!options.write) {
    return config;
  }
  displayWarning(
    'ask --write: filesystem and dev tools enabled — this run can read/write files and run commands.'
  );
  const askBuiltInTools =
    config.commands?.exec?.builtInTools ?? config.commands?.code?.builtInTools;
  return {
    ...config,
    askWriteMode: true,
    commands: {
      ...config.commands,
      ask: {
        ...config.commands?.ask,
        filesystem: 'all',
        ...(askBuiltInTools ? { builtInTools: askBuiltInTools } : {}),
      },
    },
  };
}

/**
 * Adds the ask command to the program
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function askCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('ask')
    .description('Ask a question')
    .argument('[message]', 'A message')
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the message'
    )
    .option(
      '--write',
      'Let ask act, not just chat: enable full filesystem + dev tools (like exec/code) so it can ' +
        'read/write files and run commands. Grants write access — use with care.'
    )
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth ask "which types of primitives are available in JavaScript?"\n' +
        '  $ gth ask "Please explain this code" -f index.js\n' +
        '  $ cat error.log | gth ask "What might be causing these errors?"\n'
    )
    .action(async (message: string, options: AskCommandOptions) => {
      const config = applyAskWriteMode(await initConfig(commandLineConfigOverrides), options);
      const content = [];
      if (options.file) {
        content.push(readMultipleFilesFromProjectDir(options.file));
      }
      const stringFromStdin = getStringFromStdin();
      if (stringFromStdin) {
        content.push(wrapContent(stringFromStdin, 'stdin-content'));
      }
      if (message) {
        content.push(wrapContent(message, 'message', 'user message'));
      }

      // Validate that at least one input source is provided
      if (content.length === 0) {
        throw new Error('At least one of the following is required: file, stdin, or message');
      }

      const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
      const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
      const { resolveAgentFactory } =
        await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');
      let ok = false;
      try {
        ({ ok } = await runSingleShot(
          'ASK',
          getAskSystemPrompt(config),
          content.join('\n'),
          config,
          createResolvers(),
          'ask',
          // ask defaults to the lean backend; an explicit config.agent.backend overrides it.
          resolveAgentFactory(config, 'lean')
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
