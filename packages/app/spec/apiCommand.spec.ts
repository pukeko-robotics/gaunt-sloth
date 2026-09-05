/**
 * CFG-62, taken in passing — `gth api ag-ui --port` goes through the strict integer parser.
 *
 * Before this, the option was a bare string run through `parseInt(value, 10)` inside the action, so
 * `--port abc` handed the server `NaN` and `--port 10abc` silently became port 10. The two garbage
 * cells below cannot pass on that code: `parseInt` never throws, so the server mock would be called.
 *
 * The command is driven through commander exactly as the CLI does, with the server module and the
 * config loader mocked, so nothing here binds a port.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const initConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

const startAgUiServerMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/agent/modules/apiAgUiModule.js', () => ({
  startAgUiServer: startAgUiServerMock,
}));

const displayErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  displayError: displayErrorMock,
}));

const setExitCodeMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  setExitCode: setExitCodeMock,
}));

import { apiCommand } from '#src/commands/apiCommand.js';

describe('gth api ag-ui --port (CFG-62)', () => {
  const config = { commands: { api: { port: 4100 } } };

  beforeEach(() => {
    vi.resetAllMocks();
    initConfigMock.mockResolvedValue(config);
    startAgUiServerMock.mockResolvedValue(undefined);
  });

  const run = async (...args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    apiCommand(program, {});
    await program.parseAsync(['node', 'gth', 'api', 'ag-ui', ...args]);
  };

  it('passes a numeric --port to the server as a number', async () => {
    await run('--port', '4000');
    expect(startAgUiServerMock).toHaveBeenCalledWith(config, 4000);
  });

  it('with no --port, uses the configured port, and 3000 when nothing is configured', async () => {
    await run();
    expect(startAgUiServerMock).toHaveBeenCalledWith(config, 4100);

    startAgUiServerMock.mockClear();
    const bare = {};
    initConfigMock.mockResolvedValue(bare);
    await run();
    expect(startAgUiServerMock).toHaveBeenCalledWith(bare, 3000);
  });

  it('--port 0 is port 0 (let the OS pick), not the configured port', async () => {
    await run('--port', '0');
    expect(startAgUiServerMock).toHaveBeenCalledWith(config, 0);
  });

  it('refuses --port abc at parse time, before the config is read or the server is started', async () => {
    await expect(run('--port', 'abc')).rejects.toThrow('Expected an integer, got "abc"');
    expect(initConfigMock).not.toHaveBeenCalled();
    expect(startAgUiServerMock).not.toHaveBeenCalled();
  });

  it('refuses trailing garbage rather than truncating it: --port 10abc is not port 10', async () => {
    await expect(run('--port', '10abc')).rejects.toThrow('Expected an integer, got "10abc"');
    expect(startAgUiServerMock).not.toHaveBeenCalled();
  });
});
