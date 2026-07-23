import { Command, Option } from 'commander';
import { askCommand } from '#src/commands/askCommand.js';
import { execCommand } from '#src/commands/execCommand.js';
import { batchCommand } from '#src/commands/batchCommand.js';
import { evalCommand } from '#src/commands/evalCommand.js';
import { workflowCommand } from '#src/commands/workflowCommand.js';
import { initCommand } from '#src/commands/initCommand.js';
import { reviewCommand } from '#src/commands/reviewCommand.js';
import { prCommand } from '#src/commands/prCommand.js';
import { chatCommand } from '#src/commands/chatCommand.js';
import { codeCommand } from '#src/commands/codeCommand.js';
import { apiCommand } from '#src/commands/apiCommand.js';
import { getCommand } from '#src/commands/getCommand.js';
import { configCommand } from '#src/commands/configCommand.js';
import { historyCommand } from '#src/commands/historyCommand.js';
import { insightsCommand } from '#src/commands/insightsCommand.js';
import { modelsCommand } from '#src/commands/modelsCommand.js';
import { argv, exit, getSlothVersion, readStdin } from '@gaunt-sloth/core/utils/systemUtils.js';
import { commandSkipsStdin, resolveInvokedCommandName } from '#src/utils/stdinPolicy.js';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

import { coerceBooleanOrString, displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { installCrashHandler } from '@gaunt-sloth/core/utils/crashHandler.js';

// GS2-48 — install the process-level crash handler as early as possible, so an uncaughtException /
// unhandledRejection anywhere in the run writes a redacted debug snapshot to ~/.gsloth/debug-dumps/
// before the process dies. Idempotent and inert on a normal exit.
installCrashHandler();

const program = new Command();

program
  .name('gth')
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
    '--profile <name>',
    'Named config profile to run under (alias of --identity-profile; ' +
      'create one with `gth config profile create <name>`)'
  )
  .option(
    '-w, --write-output-to-file <value>',
    'Write output to file. Accepts true/false or a filename. Shortcuts: -wn or -w0 for false.'
  )
  .option('--tui', 'Force the interactive Ink TUI for chat/code sessions (overrides CI auto-off)')
  .option('--no-tui', 'Force the plain readline session for chat/code (disable the TUI)')
  .addOption(new Option('--nopipe').hideHelp(true))
  .addOption(new Option('--no-pipe').hideHelp(true));

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
// `--profile` (GS2-33) is the friendly alias of `-i/--identity-profile`: both select a named profile
// block (`.gsloth/.gsloth-settings/<name>/`). If BOTH are given and disagree, that is a mistake worth
// surfacing rather than silently picking one; identical values are harmless.
const identityProfileOpt = program.getOptionValue('identityProfile');
const profileOpt = program.getOptionValue('profile');
if (identityProfileOpt && profileOpt && identityProfileOpt !== profileOpt) {
  displayError(
    `Conflicting profiles: --identity-profile "${identityProfileOpt}" and --profile "${profileOpt}". ` +
      'Pass only one (they are aliases).'
  );
  exit(1);
}
if (profileOpt ?? identityProfileOpt) {
  cliConfigOverrides.identityProfile = profileOpt ?? identityProfileOpt;
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
batchCommand(program, cliConfigOverrides);
evalCommand(program, cliConfigOverrides);
workflowCommand(program, cliConfigOverrides);
chatCommand(program, cliConfigOverrides);
codeCommand(program, cliConfigOverrides);
apiCommand(program, cliConfigOverrides);
getCommand(program, cliConfigOverrides);
configCommand(program, cliConfigOverrides);
// GS2-7 (B20) — read-only, local history/insights surfaces. They resolve their own DB path (global
// default or --db) and do not build the LLM, so they stay decoupled from config/provider setup.
historyCommand(program);
insightsCommand(program);
// GS2-6 (B16) — model catalog: lists providers/models enriched with models.dev cost/limit metadata.
// Read-only; enrichment never gates what `/v1/models` reports as callable.
modelsCommand(program);

// BATCH-11 (#405 gotcha #5): `eval`/`batch` never consume piped stdin, so they must not block
// waiting for stdin EOF before dispatch — a scripted/CI `gth eval suite.yaml` inherits a non-TTY,
// non-closing stdin and would otherwise hang until EOF (or need `</dev/null`). Resolve the invoked
// subcommand from argv via commander's own operand parsing (so a `-c <path>` value or a file
// argument is never mistaken for the command name) and, for those commands, imply the existing
// `--no-pipe` fast path in readStdin. ask/review/pr etc. are untouched and still block-and-read a
// piped diff.
const invokedCommand = resolveInvokedCommandName(
  program.commands.map((command) => command.name()),
  program.parseOptions(argv).operands
);
if (commandSkipsStdin(invokedCommand)) {
  program.setOptionValue('nopipe', true);
}

await readStdin(program);
