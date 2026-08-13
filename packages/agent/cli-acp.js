#!/usr/bin/env node

/**
 * ACP (Agent Client Protocol) server entry — currently a stub.
 * Usage: gaunt-sloth-acp
 *
 * The bin resolves and exits non-zero with an explanation. See src/core/acpStub.ts for why the
 * command is kept rather than removed.
 *
 * Writes to stderr, never stdout: an ACP host treats stdout as the JSON-RPC framing channel, and a
 * plain-text byte there is a protocol error rather than a message the user reads.
 */

import { ACP_STUB_MESSAGE } from '#src/core/acpStub.js';

process.stderr.write(`${ACP_STUB_MESSAGE}\n`);
process.exit(1);
