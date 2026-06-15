#!/usr/bin/env node

/**
 * ACP (Agent Client Protocol) server entry for the Gaunt Sloth deep agent.
 * Usage: gaunt-sloth-acp
 *
 * Speaks ACP JSON-RPC over stdio, so an ACP host (Zed, JetBrains, a future Pukeko client)
 * can spawn this binary as a coding agent subprocess.
 *
 * stdout is the ACP protocol channel and must stay clean: any stray byte corrupts framing.
 * gsloth's console output (initConfig info, agent status) routes through console.log/info,
 * which write to stdout — so before doing anything we redirect those to stderr. The ACP SDK
 * writes the protocol via process.stdout.write directly and is unaffected; console.warn/error
 * already go to stderr.
 */

for (const method of ['log', 'info']) {
  console[method] = (...args) => process.stderr.write(args.join(' ') + '\n');
}

import { initConfig } from '@gaunt-sloth/core/config.js';
import { displayError } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { startAcpServer } from '#src/modules/acpModule.js';

async function main() {
  try {
    const config = await initConfig({});
    await startAcpServer(config);
  } catch (err) {
    displayError(`ACP server failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
