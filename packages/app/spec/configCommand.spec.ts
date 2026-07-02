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
  validateConfig: vi.fn(),
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
        warnings: [],
        sourceLabel: '/proj/.gsloth.config.json',
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
        warnings: [],
        sourceLabel: '.gsloth.config.json',
        errorMessage: '  - streamOutput: Invalid input: expected boolean',
      });

      await run('validate');

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(
        expect.stringContaining('streamOutput')
      );
      expect(systemUtilsMock.setExitCode).toHaveBeenCalledWith(1);
      expect(consoleUtilsMock.displaySuccess).not.toHaveBeenCalled();
    });

    it('emits each warning before the verdict', async () => {
      configMock.validateConfig.mockResolvedValue({
        found: true,
        ok: true,
        warnings: ['Unknown top-level config key: foo (…).'],
        sourceLabel: 'x',
      });
      await run('validate');
      expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
        'Unknown top-level config key: foo (…).'
      );
    });

    it('exits non-zero when no config is found', async () => {
      configMock.validateConfig.mockResolvedValue({ found: false, ok: false, warnings: [] });
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
});
