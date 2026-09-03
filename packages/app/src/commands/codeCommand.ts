import { Command } from 'commander';
import { startSession } from '#src/modules/startSession.js';
import { CODE_SESSION_CONFIG } from '#src/modules/sessionConfigs.js';
import { resolveResumeId, resumeOption } from '#src/commands/resumeOption.js';
import { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

export function codeCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  // REL-3: bare `gth` (no subcommand) now defaults to the agentic code session.
  // GS2-20 — `gth --resume <id>` is the root option (see cli.ts), read here because the bare form
  // has no subcommand of its own to carry it.
  program.action(async () => {
    await startSession(CODE_SESSION_CONFIG, commandLineConfigOverrides, undefined, {
      resumeConversationId: resolveResumeId(program, {}),
    });
  });

  program
    .command('code')
    .description(
      'Interactively write code with sloth (has full file system access within your project)'
    )
    .argument('[message]', 'Initial message to start the code session')
    // GS2-20 — re-enter a recorded conversation in code mode.
    .addOption(resumeOption())
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth code\n' +
        '  $ gth code "Help me refactor the authentication module"\n' +
        '  $ gth code --resume 42\n'
    )
    .action(async (message: string, options: { resume?: number }) => {
      await startSession(CODE_SESSION_CONFIG, commandLineConfigOverrides, message, {
        resumeConversationId: resolveResumeId(program, options),
      });
    });
}
