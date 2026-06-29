import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import {
  getCommandSourceInput,
  getCommandSystemPrompt,
  type PromptCommandType,
  type SourceCommandType,
  type SourceInputType,
} from '#src/commands/commandIntrospection.js';
import { display, displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';

const PROMPT_COMMANDS = ['ask', 'review', 'pr', 'pr-discovery', 'chat', 'code', 'exec'] as const;
const SOURCE_COMMANDS = ['review', 'pr'] as const;
const INPUT_TYPES = ['content', 'requirements'] as const;

export function getCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('get')
    .description('Print the effective prompt or source-backed command input')
    .argument('<command>', 'Command to introspect')
    .argument('<subject>', 'Either prompt, content, or requirements')
    .argument('[id]', 'Source-backed content identifier')
    .action(async (command: string, subject: string, id: string | undefined) => {
      try {
        const config = await initConfig(commandLineConfigOverrides);

        if (subject === 'prompt') {
          if (id) {
            throw new Error('Prompt subject does not accept an ID.');
          }
          if (!PROMPT_COMMANDS.includes(command as PromptCommandType)) {
            throw new Error(`Unsupported prompt command: ${command}.`);
          }

          display(getCommandSystemPrompt(command as PromptCommandType, config));
          return;
        }

        if (!INPUT_TYPES.includes(subject as SourceInputType)) {
          throw new Error(`Unsupported subject: ${subject}.`);
        }
        if (!SOURCE_COMMANDS.includes(command as SourceCommandType)) {
          throw new Error(`Unsupported source-backed command: ${command}.`);
        }
        if (!id) {
          throw new Error(`Subject "${subject}" requires an ID.`);
        }

        display(
          await getCommandSourceInput(
            command as SourceCommandType,
            subject as SourceInputType,
            id,
            config
          )
        );
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
      }
    });
}
