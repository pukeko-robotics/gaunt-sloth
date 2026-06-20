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
    exitMessage: "Type 'exit' or hit Ctrl+C to exit chat\n",
  };
  // Chat command (REL-3: the no-subcommand default is now `code`, registered in codeCommand)
  program
    .command('chat')
    .description('Start an interactive chat session with Gaunt Sloth')
    .argument('[message]', 'Initial message to start the chat')
    .action(async (message: string) => {
      await startSession(sessionConfig, commandLineConfigOverrides, message);
    });
}
