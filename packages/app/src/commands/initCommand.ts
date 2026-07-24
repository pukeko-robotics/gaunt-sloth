import type { ConfigType } from '@gaunt-sloth/core/config.js';
import { availableDefaultConfigs } from '@gaunt-sloth/core/config.js';
import { createProjectConfig } from '#src/commands/configSetup.js';
import { runFirstRunDialog } from '#src/commands/firstRunDialog.js';
import { Argument, Command } from 'commander';

/**
 * Adds the init command to the program.
 *
 * With an explicit `[type]` it writes a project config for that provider (the
 * scriptable path). Without arguments it runs the CFG-2 first-run dialog, which
 * detects usable providers, lets the user pick a provider + model and choose
 * whether to store the config for this project or globally.
 *
 * `--force` overwrites an existing config: on the scriptable path it skips the
 * warn-and-keep guard, and in the interactive dialog it skips the overwrite prompt.
 *
 * @param program - The commander program
 */
export function initCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize Gaunt Sloth in your project. This will write necessary config files.')
    .addArgument(
      new Argument(
        '[type]',
        'Config type (optional, runs the interactive dialog if omitted)'
      ).choices(availableDefaultConfigs)
    )
    .option('-f, --force', 'Overwrite an existing config file')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth init              # Auto-detect API keys and prompt for provider\n' +
        '  $ gth init vertexai\n'
    )
    .action(async (config: ConfigType | undefined, options: { force?: boolean }) => {
      const force = !!options.force;
      if (config) {
        await createProjectConfig(config, force);
      } else {
        await runFirstRunDialog({}, force);
      }
    });
}
