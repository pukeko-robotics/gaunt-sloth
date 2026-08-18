import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';

describe('CLI -g / --global option parsing', () => {
  const parseCli = (argv: string[]): CommandLineConfigOverrides => {
    const program = new Command();
    program
      .name('gth')
      .option('-c, --config <path>', 'Path to custom configuration file')
      .option('-g, --global', 'Run with global configuration, bypassing project-level config')
      .option('-i, --identity-profile <identity>', 'Identity profile')
      .option('--profile <name>', 'Named config profile');

    const cliConfigOverrides: CommandLineConfigOverrides = {};
    program.parseOptions(argv);

    if (program.getOptionValue('config')) {
      cliConfigOverrides.customConfigPath = program.getOptionValue('config');
    }
    if (program.getOptionValue('global')) {
      cliConfigOverrides.global = true;
    }
    const profile = program.getOptionValue('profile') ?? program.getOptionValue('identityProfile');
    if (profile) {
      cliConfigOverrides.identityProfile = profile;
    }
    return cliConfigOverrides;
  };

  it('sets global = true when -g is passed', () => {
    const overrides = parseCli(['node', 'gth', '-g', 'config', 'print']);
    expect(overrides.global).toBe(true);
  });

  it('sets global = true when --global is passed', () => {
    const overrides = parseCli(['node', 'gth', '--global', 'config', 'validate']);
    expect(overrides.global).toBe(true);
  });

  it('leaves global undefined when neither flag is passed', () => {
    const overrides = parseCli(['node', 'gth', 'config', 'print']);
    expect(overrides.global).toBeUndefined();
  });

  it('composes --global with -i / --profile', () => {
    const overrides = parseCli(['node', 'gth', '-g', '-i', 'myprofile', 'ask', 'hello']);
    expect(overrides.global).toBe(true);
    expect(overrides.identityProfile).toBe('myprofile');
  });
});
