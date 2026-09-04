#!/usr/bin/env node

/**
 * CLI for gaunt-sloth-api.
 * Usage: gaunt-sloth-api [api-type] [--port <port>] [--config <path>]
 *
 * Starts an API server. Currently supports 'ag-ui' type.
 *
 * Port precedence is the flag, then `commands.api.port` from the config file, then 3000. `--config`
 * names the configuration outright: it reaches `initConfig` as `customConfigPath`, which skips
 * discovery from the working directory and raises when the named file is not there. A named config
 * that is not readable is a refusal and never a fallback — falling back hands the caller a working
 * server running a configuration they did not ask for, and says nothing about it (CFG-62).
 *
 * Parsing is `node:util`'s `parseArgs` rather than commander: commander is a devDependency of the
 * workspace root and not of this package, so importing it here would ship an undeclared dependency
 * to anyone who installs `@gaunt-sloth/agent`.
 *
 * `strict: true`, so an unrecognised flag stops the boot. A flag nothing reads is indistinguishable
 * from a flag that works, which is the failure this door exists to prevent, so it has to be refused
 * out loud rather than accepted and dropped. `--help` is the other half of that: a bin that rejects
 * an unknown flag has to be able to say which ones it knows.
 */

import { parseArgs } from 'node:util';
import { initConfig } from '@gaunt-sloth/core/config.js';
import { startAgUiServer } from '#src/modules/apiAgUiModule.js';
import { displayError, displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';

/** The port used when neither `--port` nor `commands.api.port` says otherwise. */
const DEFAULT_PORT = 3000;

const USAGE = `Usage: gaunt-sloth-api [api-type] [--port <port>] [--config <path>]

Starts an API server. The only api-type is 'ag-ui', which is also the default.

Options:
  --port <port>        Port to listen on (1-65535).
  -c, --config <path>  Path to a configuration file. The file must exist; naming one skips
                       discovery from the working directory rather than falling back to it.
  -h, --help           Show this message.

Port precedence: --port, then commands.api.port from the config file, then ${DEFAULT_PORT}.

Examples:
  $ gaunt-sloth-api
  $ gaunt-sloth-api ag-ui --port 4000
  $ gaunt-sloth-api ag-ui --port 4000 --config ./.gsloth.config.json`;

/**
 * Read `--port` as a port number, or exit 1 naming what was passed.
 *
 * A validating parse rather than `parseInt`: `parseInt('abc', 10)` is `NaN` and `listen(NaN)`
 * binds an arbitrary free port, which would replace the dropped flag this node fixes with a
 * different silent wrong answer.
 */
function parsePort(raw) {
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    displayError(`Invalid --port "${raw}". Expected an integer between 1 and 65535.`);
    process.exit(1);
  }
  return port;
}

/** Parse argv, or exit 1 with the parser's own message and the usage text. */
function parseCliArgs() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        config: { type: 'string', short: 'c' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    displayError(err instanceof Error ? err.message : String(err));
    displayInfo(USAGE);
    process.exit(1);
  }
}

async function main() {
  const { values, positionals } = parseCliArgs();

  if (values.help) {
    displayInfo(USAGE);
    return;
  }

  const apiType = positionals[0] || 'ag-ui';
  const portFromFlag = values.port === undefined ? undefined : parsePort(values.port);

  try {
    // `customConfigPath` is what makes `--config` mean anything: the loader resolves that file
    // outright instead of walking up from the working directory, and raises a
    // ConfigDiscoveryError naming the path when it does not exist. That error lands in the catch
    // below, so an unreadable `--config` exits non-zero with the path in the message instead of
    // silently running the discovered config. The check is the loader's, not a second one here.
    const config = await initConfig({ customConfigPath: values.config });

    // Precedence: the flag, then the config file, then the default. A flag the caller typed on
    // this run is the most specific statement of intent there is, so it wins over both.
    const port = portFromFlag ?? config.commands?.api?.port ?? DEFAULT_PORT;

    if (apiType === 'ag-ui') {
      displayInfo('Starting AG-UI API server...');
      await startAgUiServer(config, port);
    } else {
      displayError(`Unknown API type: ${apiType}. Supported types: ag-ui`);
      process.exit(1);
    }
  } catch (err) {
    displayError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
