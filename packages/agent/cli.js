#!/usr/bin/env node

/**
 * Simple CLI for gaunt-sloth-api
 * Usage: gaunt-sloth-api [api-type]
 *
 * Starts an API server. Currently supports 'ag-ui' type.
 */

import { initConfig } from '@gaunt-sloth/core/config.js';
import { startAgUiServer } from '#src/modules/apiAgUiModule.js';
import { displayError, displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';

const args = process.argv.slice(2);
const apiType = args[0] || 'ag-ui';

async function main() {
  try {
    const config = await initConfig({});
    const port = config.commands?.api?.port ?? 3000;

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
