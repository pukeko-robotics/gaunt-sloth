import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { getAskSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin } from '@gaunt-sloth/core/utils/systemUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/review/utils/fileUtils.js';

interface AskCommandOptions {
  file?: string[];
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
    .action(async (message: string, options: AskCommandOptions) => {
      const config = await initConfig(commandLineConfigOverrides);
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
      await runSingleShot(
        'ASK',
        getAskSystemPrompt(config),
        content.join('\n'),
        config,
        createResolvers()
      );
    });
}
