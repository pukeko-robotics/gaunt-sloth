import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GthConfig } from '@gaunt-sloth/core/config.js';

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displaySuccess: vi.fn(),
  displayWarning: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  setExitCode: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', async () => {
  const actual = await vi.importActual<typeof import('#src/utils/systemUtils.js')>(
    '#src/utils/systemUtils.js'
  );
  return { ...actual, setExitCode: systemUtilsMock.setExitCode };
});

const configMock = {
  initConfig: vi.fn(),
  hasAnyConfig: vi.fn(),
  validateConfig: vi.fn(),
  createNamedProfile: vi.fn(),
};
vi.mock('#src/config.js', () => configMock);

const run = async (...args: string[]): Promise<void> => {
  const { configCommand } = await import('#src/commands/configCommand.js');
  const program = new Command();
  configCommand(program, {});
  await program.parseAsync(['na', 'na', 'config', ...args]);
};

describe('configCommand', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  describe('redactConfigForPrint', () => {
    it('redacts secret-looking keys at any depth and hides live instances', async () => {
      const { redactConfigForPrint } = await import('#src/commands/configCommand.js');
      const config = {
        llm: { invoke: vi.fn() } as unknown as BaseChatModel,
        modelDisplayName: 'gpt-5.5',
        streamOutput: true,
        llmConfig: {
          apiKey: 'sk-super-secret',
          configuration: { authToken: 'bearer-xyz', temperature: 0.7 },
        },
        tools: [{}, {}],
        middleware: [{}],
      } as unknown as GthConfig;

      const out = redactConfigForPrint(config);
      const json = JSON.stringify(out);

      expect(json).not.toContain('sk-super-secret');
      expect(json).not.toContain('bearer-xyz');
      expect(json).toContain('***REDACTED***');
      // Non-secret sibling survives.
      expect(
        (out.llmConfig as Record<string, Record<string, unknown>>).configuration.temperature
      ).toBe(0.7);
      // Live objects rendered as descriptors, never the instances.
      expect(out.llm).toBe('[chat model: gpt-5.5]');
      expect(out.tools).toBe('[2 tool instance(s)]');
      expect(out.middleware).toBe('[1 middleware]');
    });

    it('does not mutate the input config', async () => {
      const { redactConfigForPrint } = await import('#src/commands/configCommand.js');
      const config = {
        llm: {} as unknown as BaseChatModel,
        apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
      } as unknown as GthConfig;
      redactConfigForPrint(config);
      expect(config.apiKeyEnvironmentVariable).toBe('OPENAI_API_KEY');
    });
  });

  describe('config print', () => {
    it('prints the resolved config (redacted) with a header', async () => {
      configMock.initConfig.mockResolvedValue({
        llm: {} as unknown as BaseChatModel,
        modelDisplayName: 'claude-x',
        streamOutput: true,
      });

      await run('print');

      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledTimes(1);
      expect(consoleUtilsMock.display).toHaveBeenCalledTimes(1);
      const printed = consoleUtilsMock.display.mock.calls[0][0] as string;
      expect(printed).toContain('claude-x');
      expect(printed).toContain('"streamOutput": true');
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('--json omits the header', async () => {
      configMock.initConfig.mockResolvedValue({ llm: {}, modelDisplayName: 'm' });
      await run('print', '--json');
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
      expect(consoleUtilsMock.display).toHaveBeenCalledTimes(1);
    });

    it('sets a non-zero exit code when resolution throws', async () => {
      configMock.initConfig.mockRejectedValue(new Error('boom'));
      await run('print');
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith('boom');
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    });
  });

  describe('config validate', () => {
    it('exits 0 (no exit code set) on a valid config', async () => {
      configMock.validateConfig.mockResolvedValue({
        found: true,
        ok: true,
        layers: [{ sourceLabel: '/proj/.gsloth.config.json', ok: true, warnings: [] }],
      });

      await run('validate');

      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
        'Configuration is valid: /proj/.gsloth.config.json'
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('exits non-zero with a path-scoped message on an invalid config', async () => {
      configMock.validateConfig.mockResolvedValue({
        found: true,
        ok: false,
        layers: [
          {
            sourceLabel: '.gsloth.config.json',
            ok: false,
            warnings: [],
            errorMessage: '  - streamOutput: Invalid input: expected boolean',
          },
        ],
      });

      await run('validate');

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('streamOutput')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
    });

    it('GS2-29: names the offending layer when the GLOBAL layer is invalid but the project is clean', async () => {
      configMock.validateConfig.mockResolvedValue({
        found: true,
        ok: false,
        layers: [
          { sourceLabel: '/proj/.gsloth.config.json', ok: true, warnings: [] },
          {
            sourceLabel: '.gsloth.config.json (global)',
            ok: false,
            warnings: [],
            errorMessage: '  - contentProvider: Config property "contentProvider" was renamed…',
          },
        ],
      });

      await run('validate');

      // The error must name the GLOBAL layer (so the user knows which file to fix), not the project.
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('.gsloth.config.json (global)')
      );
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('contentProvider')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
    });

    it('emits each warning, prefixed with its source layer, before the verdict', async () => {
      configMock.validateConfig.mockResolvedValue({
        found: true,
        ok: true,
        layers: [
          { sourceLabel: 'x', ok: true, warnings: ['Unknown top-level config key: foo (…).'] },
        ],
      });
      await run('validate');
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'x: Unknown top-level config key: foo (…).'
      );
    });

    it('exits non-zero when no config is found', async () => {
      configMock.validateConfig.mockResolvedValue({ found: false, ok: false, layers: [] });
      await run('validate');
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('No configuration file found')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    });

    it('surfaces a parse failure as an invalid-config error with non-zero exit', async () => {
      configMock.validateConfig.mockRejectedValue(
        new SyntaxError('Invalid JSON/JSONC at offset 5.')
      );
      await run('validate');
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read configuration')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    });
  });

  describe('profile create (GS2-33)', () => {
    beforeEach(() => {
      // Default the create tests to the happy path: a config resolves, so the command seeds from it
      // via initConfig. The no-config template branch is exercised explicitly below by overriding
      // hasAnyConfig to false. (Parent beforeEach runs vi.resetAllMocks() first, so this re-applies
      // per test.)
      configMock.hasAnyConfig.mockResolvedValue(true);
    });

    it('scaffolds a profile seeded from the current config, threading --model', async () => {
      configMock.initConfig.mockResolvedValue({
        modelProviderType: 'anthropic',
        modelDisplayName: 'claude-sonnet-4-5',
      });
      configMock.createNamedProfile.mockReturnValue({
        path: '/proj/.gsloth/.gsloth-settings/cheap/.gsloth.config.json',
        llm: { type: 'anthropic', model: 'gemini-2.0-flash-lite' },
      });

      await run('profile', 'create', 'cheap', '--model', 'gemini-2.0-flash-lite');

      expect(configMock.createNamedProfile).toHaveBeenCalledWith('cheap', {
        seedType: 'anthropic',
        seedModel: 'claude-sonnet-4-5',
        modelOverride: 'gemini-2.0-flash-lite',
        force: undefined,
      });
      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
        expect.stringContaining('Created profile "cheap"')
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('scaffolds from the template when no config resolves — WITHOUT calling the exiting seed path', async () => {
      // GS2-33 review Important #1/#2: in production, when no config resolves initConfig calls
      // `exit(1)` (a real process.exit, not a throw), so the old mockRejectedValue test was a false
      // green — it "proved" a reject path that never happens. Exercise the REAL branch instead: no
      // config resolves (hasAnyConfig -> false), so the command must take the template path WITHOUT
      // ever calling the process-exiting initConfig, and still write a profile (exit 0).
      configMock.hasAnyConfig.mockResolvedValue(false);
      configMock.createNamedProfile.mockReturnValue({
        path: '/proj/.gsloth/.gsloth-settings/blank/.gsloth.config.json',
        llm: { type: 'anthropic', model: 'gemini-2.0-flash-lite' },
      });

      await run('profile', 'create', 'blank', '--model', 'gemini-2.0-flash-lite');

      // The exiting seed path is never touched — this is the crux of the fix.
      expect(configMock.initConfig).not.toHaveBeenCalled();
      // Scaffolded from the template (no seed), with --model still applied on top of the template.
      expect(configMock.createNamedProfile).toHaveBeenCalledWith('blank', {
        seedType: undefined,
        seedModel: undefined,
        modelOverride: 'gemini-2.0-flash-lite',
        force: undefined,
      });
      // Create SUCCEEDS (not a mocked reject), and exits clean.
      expect(consoleUtilsMock.displaySuccess).toHaveBeenCalledWith(
        expect.stringContaining('Created profile "blank"')
      );
      expect(systemUtilsMock.setExitCode).not.toHaveBeenCalled();
    });

    it('reports a create failure (bad name / existing profile) with a non-zero exit', async () => {
      configMock.initConfig.mockResolvedValue({});
      configMock.createNamedProfile.mockImplementation(() => {
        throw new Error('Profile "cheap" already exists at /p. Pass --force to overwrite it.');
      });

      await run('profile', 'create', 'cheap');

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('already exists')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
    });

    it('passes --force through to the scaffolder', async () => {
      configMock.initConfig.mockResolvedValue({});
      configMock.createNamedProfile.mockReturnValue({
        path: '/p',
        llm: { type: 'anthropic', model: 'm' },
      });

      await run('profile', 'create', 'cheap', '--force');

      expect(configMock.createNamedProfile).toHaveBeenCalledWith(
        'cheap',
        expect.objectContaining({ force: true })
      );
    });
  });
});
