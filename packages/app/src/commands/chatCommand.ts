import { Command } from 'commander';
import type { SessionConfig } from '@gaunt-sloth/agent/modules/interactiveSessionModule.js';
import { startSession } from '#src/modules/startSession.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { readChatPrompt } from '@gaunt-sloth/core/utils/llmUtils.js';

export function chatCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
) {
  const sessionConfig: SessionConfig = {
    mode: 'chat',
    readModePrompt: readChatPrompt,
    description: 'Start an interactive chat session with Gaunt Sloth',
    readyMessage: '\nGaunt Sloth is ready to chat. Type your prompt.',
    // [[TUI-C79]] — this row is shared by BOTH surfaces (the Ink dock composes it with
    // TUI_HINT_SUFFIX; the readline session prints it as-is), so every clause has to be true on
    // both. `exit` is: it needs no condition on either surface, in any state. `Ctrl+C` no longer
    // is — on the TUI it scraps a draft first and stops a turn second, and it only leaves from the
    // bottom of that ladder — and no accurate short wording exists for a fixed row, so the clause
    // is dropped rather than qualified. `/help` is the reference, and lists Ctrl+C per context.
    exitMessage: "Type 'exit' to leave chat · /help for commands\n",
  };
  // Chat command (REL-3: the no-subcommand default is now `code`, registered in codeCommand)
  program
    .command('chat')
    .description('Start an interactive chat session with Gaunt Sloth')
    .argument('[message]', 'Initial message to start the chat')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth chat\n' +
        '  $ gth chat "Let\'s discuss the architecture of this project"\n'
    )
    .action(async (message: string) => {
      await startSession(sessionConfig, commandLineConfigOverrides, message);
    });
}
