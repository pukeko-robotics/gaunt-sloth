import type { CommandLineConfigOverrides, ConfigType } from '@gaunt-sloth/core/config.js';
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
 * GS2-33 — `commandLineConfigOverrides` carries the root `-g/--global` and
 * `-i/--identity-profile`/`--profile` flags (parsed by `cli.ts` before any subcommand
 * binds). `init` does not re-declare either flag itself: `-g` skips the project-vs-global
 * question (writing straight into the chosen scope, or `~/.gsloth/` on the scriptable path),
 * and `-i <name>` targets a named profile under `.gsloth-settings/<name>/` in whichever scope
 * is chosen — the interactive dialog's folder labels spell out that subdirectory.
 *
 * @param program - The commander program
 * @param commandLineConfigOverrides - Global CLI overrides (`--global`, `--identity-profile`/
 *   `--profile`), parsed once in `cli.ts` before any subcommand is bound.
 */
export function initCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides = {}
): void {
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
        '  $ gth init vertexai\n' +
        '  $ gth init -g            # Create/overwrite the global config (~/.gsloth), skipping the scope question\n' +
        '  $ gth init -i test2      # Create a named profile through the dialog (.gsloth/.gsloth-settings/test2)\n' +
        '  $ gth init -g -i test2   # Create a named profile under ~/.gsloth/.gsloth-settings/test2\n'
    )
    .action(async (config: ConfigType | undefined, options: { force?: boolean }) => {
      const force = !!options.force;
      const identityProfile = commandLineConfigOverrides.identityProfile;
      if (config) {
        await createProjectConfig(config, force, {
          global: commandLineConfigOverrides.global,
          identityProfile,
        });
      } else {
        const forcedScope = commandLineConfigOverrides.global ? 'global' : undefined;
        await runFirstRunDialog({}, force, forcedScope, identityProfile);
      }
    });
}
