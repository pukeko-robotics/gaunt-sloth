#!/usr/bin/env node

/**
 * ACP (Agent Client Protocol) server entry.
 * Usage: gaunt-sloth-acp
 *
 * Serves ACP over stdio, for an editor that spawns the agent as a subprocess (Zed, and any other
 * ACP client). The protocol version comes from the host's own `initialize` — v1 and v2 are both
 * served — and the whole startup, including redirecting ordinary console output away from stdout
 * which the protocol owns, lives in `startAcpServer`, shared with `gaunt-sloth --acp-agent` so the
 * two doors cannot drift.
 *
 * A failure before the transport is up is written to stderr, never stdout: to a host, stdout is
 * the JSON-RPC framing channel, so prose there is a protocol error rather than a message anyone
 * reads.
 */

import { setEntryPoint } from '@gaunt-sloth/core/utils/systemUtils.js';
import { startAcpServer } from '#src/modules/acp/acpStdio.js';

// The install dir is what `getSlothVersion()` reads, and the initialize handshake reports the
// version. Set from THIS file so it resolves the agent package's own manifest.
setEntryPoint(import.meta.url);

try {
  await startAcpServer();
} catch (err) {
  process.stderr.write(
    `Gaunt Sloth ACP agent failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
  );
  process.exit(1);
}
