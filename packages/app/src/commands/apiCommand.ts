import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { parseIntOption } from '#src/commands/cliOptionParsers.js';

export function apiCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  const api = program.command('api').description('Start an API server for Gaunt Sloth');

  api
    .command('ag-ui')
    .description('Start an AG-UI protocol HTTP server')
    // CFG-62: the strict parser, as on `batch -j`, so `--port abc` is refused at parse time instead
    // of `parseInt` handing the server `NaN`, and `--port 10abc` is refused instead of becoming 10.
    .option('--port <port>', 'Port to listen on', parseIntOption)
    .addHelpText(
      'after',
      '\n' + 'Examples:\n' + '  $ gth api ag-ui\n' + '  $ gth api ag-ui --port 4000\n'
    )
    .action(async (options: { port?: number }) => {
      try {
        const config = await initConfig(commandLineConfigOverrides);
        // `??`, not a truthiness check: the option is a number now, and `--port 0` (let the OS pick)
        // must stay port 0 rather than falling through to the configured port.
        const port = options.port ?? config.commands?.api?.port ?? 3000;

        const { startAgUiServer } = await import('@gaunt-sloth/agent/modules/apiAgUiModule.js');
        await startAgUiServer(config, port);
      } catch (error) {
        displayError(error instanceof Error ? error.message : String(error));
        setExitCode(1);
      }
    });
}
