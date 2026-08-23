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

  it('Should call createProjectConfig with the provided config type (no force by default)', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init', 'vertexai']);
    expect(createProjectConfig).toHaveBeenCalledWith('vertexai', false, {
      global: undefined,
      identityProfile: undefined,
    });
    expect(runFirstRunDialog).not.toHaveBeenCalled();
  });

  it('Should pass force through to createProjectConfig with --force', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init', 'vertexai', '--force']);
    expect(createProjectConfig).toHaveBeenCalledWith('vertexai', true, {
      global: undefined,
      identityProfile: undefined,
    });
    expect(runFirstRunDialog).not.toHaveBeenCalled();
  });

  it('Should run the first-run dialog when called without a type (no force by default)', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init']);
    expect(runFirstRunDialog).toHaveBeenCalledTimes(1);
    expect(runFirstRunDialog).toHaveBeenCalledWith({}, false, undefined, undefined);
    expect(createProjectConfig).not.toHaveBeenCalled();
  });

  it('Should pass force through to the first-run dialog with --force', async () => {
    const { initCommand } = await import('#src/commands/initCommand.js');
    const program = new Command();
    initCommand(program);
    await program.parseAsync(['na', 'na', 'init', '--force']);
    expect(runFirstRunDialog).toHaveBeenCalledWith({}, true, undefined, undefined);
    expect(createProjectConfig).not.toHaveBeenCalled();
  });

  // GS2-33 — `gth -g` / `gth -i <name>` (root flags, threaded through as `commandLineConfigOverrides`).
  describe('with commandLineConfigOverrides', () => {
    it('init -g runs the dialog with the global scope forced and no profile', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { global: true });
      await program.parseAsync(['na', 'na', 'init']);
      expect(runFirstRunDialog).toHaveBeenCalledWith({}, false, 'global', undefined);
      expect(createProjectConfig).not.toHaveBeenCalled();
    });

    it('init -g -i test2 runs the dialog with the global scope forced and the profile', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { global: true, identityProfile: 'test2' });
      await program.parseAsync(['na', 'na', 'init']);
      expect(runFirstRunDialog).toHaveBeenCalledWith({}, false, 'global', 'test2');
    });

    it('init -i test2 runs the dialog with the profile and no forced scope', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { identityProfile: 'test2' });
      await program.parseAsync(['na', 'na', 'init']);
      expect(runFirstRunDialog).toHaveBeenCalledWith({}, false, undefined, 'test2');
    });

    it('init -g vertexai writes the global scriptable config, no profile', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { global: true });
      await program.parseAsync(['na', 'na', 'init', 'vertexai']);
      expect(createProjectConfig).toHaveBeenCalledWith('vertexai', false, {
        global: true,
        identityProfile: undefined,
      });
      expect(runFirstRunDialog).not.toHaveBeenCalled();
    });

    it('init -g -i test2 vertexai writes the global profile scriptable config', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { global: true, identityProfile: 'test2' });
      await program.parseAsync(['na', 'na', 'init', 'vertexai']);
      expect(createProjectConfig).toHaveBeenCalledWith('vertexai', false, {
        global: true,
        identityProfile: 'test2',
      });
    });

    it('init -i test2 vertexai writes the project profile scriptable config', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { identityProfile: 'test2' });
      await program.parseAsync(['na', 'na', 'init', 'vertexai']);
      expect(createProjectConfig).toHaveBeenCalledWith('vertexai', false, {
        global: undefined,
        identityProfile: 'test2',
      });
    });

    it('still threads --force through with overrides set', async () => {
      const { initCommand } = await import('#src/commands/initCommand.js');
      const program = new Command();
      initCommand(program, { global: true, identityProfile: 'test2' });
      await program.parseAsync(['na', 'na', 'init', 'vertexai', '--force']);
      expect(createProjectConfig).toHaveBeenCalledWith('vertexai', true, {
        global: true,
        identityProfile: 'test2',
      });
    });
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
