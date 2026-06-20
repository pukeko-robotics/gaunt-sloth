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
 * @param program - The commander program
 */
export function initCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Initialize the Gaunt Sloth Assistant in your project. This will write necessary config files.'
    )
    .addArgument(
      new Argument(
        '[type]',
        'Config type (optional, runs the interactive dialog if omitted)'
      ).choices(availableDefaultConfigs)
    )
    .action(async (config?: ConfigType) => {
      if (config) {
        await createProjectConfig(config);
      } else {
        await runFirstRunDialog();
      }
    });
}
