import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Define mocks at top level
const createProjectConfig = vi.fn();
const runFirstRunDialog = vi.fn();

// Mock the configSetup module (createProjectConfig lives here)
vi.mock('#src/commands/configSetup.js', () => ({
  createProjectConfig,
}));

// Mock the first-run dialog (CFG-2) — initCommand only routes to it
vi.mock('#src/commands/firstRunDialog.js', () => ({
  runFirstRunDialog,
}));

// Mock the config module
vi.mock('#src/config.js', () => ({
  availableDefaultConfigs: ['vertexai', 'anthropic', 'groq', 'openrouter'],
}));

describe('initCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('Should call createProjectConfig with the provided config type', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init', 'vertexai']);
    expect(createProjectConfig).toHaveBeenCalledWith('vertexai');
    expect(runFirstRunDialog).not.toHaveBeenCalled();
  });

  it('Should run the first-run dialog when called without a type', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init']);
    expect(runFirstRunDialog).toHaveBeenCalledTimes(1);
    expect(createProjectConfig).not.toHaveBeenCalled();
  });

  it('Should display available config types in help', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    const testOutput = { text: '' };

    program.configureOutput({
      writeOut: (str: string) => (testOutput.text += str),
      writeErr: (str: string) => (testOutput.text += str),
    });

    initCommand(program);

    const commandUnderTest = program.commands.find((c) => c.name() === 'init');
    expect(commandUnderTest).toBeDefined();
    commandUnderTest?.outputHelp();

    // Verify available config types are displayed (argument is now optional [type])
    expect(testOutput.text).toContain('[type]');
    expect(testOutput.text).toContain('vertexai');
    expect(testOutput.text).toContain('anthropic');
    expect(testOutput.text).toContain('groq');
    expect(testOutput.text).toContain('openrouter');
  });
});
