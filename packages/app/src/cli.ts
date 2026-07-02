import { Command, Option } from 'commander';
import { askCommand } from '#src/commands/askCommand.js';
import { execCommand } from '#src/commands/execCommand.js';
import { initCommand } from '#src/commands/initCommand.js';
import { reviewCommand } from '#src/commands/reviewCommand.js';
import { prCommand } from '#src/commands/prCommand.js';
import { chatCommand } from '#src/commands/chatCommand.js';
import { codeCommand } from '#src/commands/codeCommand.js';
import { apiCommand } from '#src/commands/apiCommand.js';
import { getCommand } from '#src/commands/getCommand.js';
import { configCommand } from '#src/commands/configCommand.js';
import { argv, getSlothVersion, readStdin } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

import { coerceBooleanOrString } from '@gaunt-sloth/core/utils/consoleUtils.js';

const program = new Command();

program
  .name('gsloth')
  .description('Gaunt Sloth reviewing your PRs')
  .version(getSlothVersion())
  .option(
    '--verbose',
    'Set LangChain/LangGraph to verbose mode, ' +
      'causing LangChain/LangGraph to log many details to the console. ' +
      'Consider using debugLog from config.ts for less intrusive debug logging.'
  )
  .option('-c, --config <path>', 'Path to custom configuration file')
  .option('-i, --identity-profile <identity>', 'Identity profile (separate config and prompts)')
  .option(
    '-w, --write-output-to-file <value>',
    'Write output to file. Accepts true/false or a filename. Shortcuts: -wn or -w0 for false.'
  )
  .option('--tui', 'Force the interactive Ink TUI for chat/code sessions (overrides CI auto-off)')
  .option('--no-tui', 'Force the plain readline session for chat/code (disable the TUI)')
  .addOption(new Option('--nopipe').hideHelp(true));

const cliConfigOverrides: CommandLineConfigOverrides = {};

// Parse global options before binding any commands
program.parseOptions(argv);
if (program.getOptionValue('verbose')) {
  /**
   * Set LangChain/LangGraph to verbose mode,
   * causing LangChain/LangGraph to log many details to the console.
   * debugLog from config.ts may be a less intrusive option.
   */
  cliConfigOverrides.verbose = true;
}
if (program.getOptionValue('config')) {
  // Set a custom config path
  cliConfigOverrides.customConfigPath = program.getOptionValue('config');
}
if (program.getOptionValue('identityProfile')) {
  cliConfigOverrides.identityProfile = program.getOptionValue('identityProfile');
}

// Tri-state TUI flag: leave `tui` undefined (auto-detect) unless the user explicitly passed
// `--tui` or `--no-tui`. Commander's `--no-tui` defaults the value to `true`, so we key off
// the value *source* rather than the value to tell "auto" from an explicit choice.
if (program.getOptionValueSource('tui') === 'cli') {
  cliConfigOverrides.tui = program.getOptionValue('tui');
}

const writeToFile = program.getOptionValue('writeOutputToFile');

// Commander does an interesting thing: if a shortcut like -w exists,
// everything after this shortcut without a space becomes the value.
// Examples: -wn comes with value 'n', -w0 => '0', -wreview.md => 'review.md'
const coerced = coerceBooleanOrString(writeToFile);
if (coerced !== undefined) {
  cliConfigOverrides.writeOutputToFile = coerced;
}

// Initialize all commands - they will handle their own config loading
initCommand(program);
reviewCommand(program, cliConfigOverrides);
prCommand(program, cliConfigOverrides);
askCommand(program, cliConfigOverrides);
execCommand(program, cliConfigOverrides);
chatCommand(program, cliConfigOverrides);
codeCommand(program, cliConfigOverrides);
apiCommand(program, cliConfigOverrides);
getCommand(program, cliConfigOverrides);
configCommand(program, cliConfigOverrides);

await readStdin(program);
