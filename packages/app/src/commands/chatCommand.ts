import { Command } from 'commander';
import { startSession } from '#src/modules/startSession.js';
import { CHAT_SESSION_CONFIG } from '#src/modules/sessionConfigs.js';
import { resumeOption, sessionOptionsFor } from '#src/commands/resumeOption.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

export function chatCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
) {
  // Chat command (REL-3: the no-subcommand default is now `code`, registered in codeCommand)
  program
    .command('chat')
    .description('Start an interactive chat session with Gaunt Sloth')
    .argument('[message]', 'Initial message to start the chat')
    // GS2-20 — re-enter a recorded conversation in chat mode.
    .addOption(resumeOption())
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth chat\n' +
        '  $ gth chat "Let\'s discuss the architecture of this project"\n' +
        '  $ gth chat --resume 42\n'
    )
    .action(async (message: string, options: { resume?: number }) => {
      await startSession(
        CHAT_SESSION_CONFIG,
        commandLineConfigOverrides,
        message,
        sessionOptionsFor(program, options)
      );
    });
}
