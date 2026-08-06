import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CFG-35 — the `gth` CLI's deliberate termination point for a config load that found no API key.
 *
 * The loader throws so programmatic callers can classify the failure; the CLI still has to end the
 * run with a plain message and exit 1. Both halves are asserted here, along with the thing that
 * makes the guard safe to put on the parse path at all: any OTHER failure propagates untouched, so
 * the crash handler still sees genuine crashes.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  exit: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => systemUtilsMock);

const MISSING_KEY_MESSAGE = 'Error processing LLM config: Groq API key not found.';

/**
 * The REAL error the loader raises. Built through a dynamic import — a static one would pull the
 * config barrel (and the loader with it) in before the mocks above are initialised.
 */
async function missingKeyError(): Promise<Error> {
  const { MissingProviderKeyError } = await import('@gaunt-sloth/core/config.js');
  return new MissingProviderKeyError(MISSING_KEY_MESSAGE, {
    provider: 'groq',
    envVar: 'GROQ_API_KEY',
    envVars: ['GROQ_API_KEY'],
  });
}

describe('configErrorGuard', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe('handleMissingProviderKey', () => {
    it('prints the message and exits 1', async () => {
      const { handleMissingProviderKey } = await import('#src/utils/configErrorGuard.js');

      expect(handleMissingProviderKey(await missingKeyError())).toBe(true);

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(MISSING_KEY_MESSAGE);
      expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('leaves any other failure alone', async () => {
      const { handleMissingProviderKey } = await import('#src/utils/configErrorGuard.js');

      expect(handleMissingProviderKey(new Error('something else'))).toBe(false);

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });
  });

  describe('guardProgramConfigErrors', () => {
    it('ends the run cleanly when parsing hits a missing provider key', async () => {
      const { guardProgramConfigErrors } = await import('#src/utils/configErrorGuard.js');
      const program = {
        getOptionValue: vi.fn(),
        parseAsync: vi.fn().mockRejectedValue(await missingKeyError()),
      };

      await expect(guardProgramConfigErrors(program).parseAsync()).resolves.toBeUndefined();

      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(MISSING_KEY_MESSAGE);
      expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    });

    it('re-throws every other failure, so the crash handler still sees it', async () => {
      const { guardProgramConfigErrors } = await import('#src/utils/configErrorGuard.js');
      const boom = new Error('boom');
      const program = {
        getOptionValue: vi.fn(),
        parseAsync: vi.fn().mockRejectedValue(boom),
      };

      await expect(guardProgramConfigErrors(program).parseAsync()).rejects.toBe(boom);

      expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });

    it('passes arguments and option lookups straight through', async () => {
      const { guardProgramConfigErrors } = await import('#src/utils/configErrorGuard.js');
      const program = {
        getOptionValue: vi.fn().mockReturnValue('the-value'),
        parseAsync: vi.fn().mockResolvedValue('parsed'),
      };

      const guarded = guardProgramConfigErrors(program);

      await expect(guarded.parseAsync(['node', 'gth', 'ask'])).resolves.toBe('parsed');
      expect(program.parseAsync).toHaveBeenCalledWith(['node', 'gth', 'ask']);
      // readStdin reads `nopipe`/`pipe` off the program it is handed, so the wrapper must not
      // hide option state set on the real one.
      expect(guarded.getOptionValue('nopipe')).toBe('the-value');
      expect(program.getOptionValue).toHaveBeenCalledWith('nopipe');
      expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    });
  });
});
