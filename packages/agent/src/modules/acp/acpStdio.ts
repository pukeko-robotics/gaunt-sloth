/**
 * @packageDocumentation
 * The stdio entry point both ACP doors go through — the standalone `gaunt-sloth-acp` bin and
 * `gaunt-sloth --acp-agent` — serving whichever protocol version the client speaks.
 *
 * **It is one function on purpose.** Two entry points spelling the same startup twice is how the
 * doors drift, and the thing that would drift here is not cosmetic: it is the stdout guarantee
 * below, which is invisible until an editor cannot parse a frame.
 *
 * ## stdout belongs to the protocol, and nothing else may touch it
 *
 * An ACP host reads JSON-RPC off the agent's stdout. Any other byte there is a framing error, not
 * a message someone reads — and this codebase writes to stdout constantly: `displayInfo` and
 * friends go through `console.log`/`console.info`, the streaming path writes to
 * `process.stdout` directly, and the dev/custom toolkits pipe a child process's stdout through.
 * A single status line would corrupt the stream.
 *
 * So the transport captures the REAL stdout writer first, and then `process.stdout.write` is
 * redirected to stderr for the life of the process. Everything that thought it was printing to the
 * user keeps working and lands on stderr, where a host shows it as agent output; the protocol
 * keeps the channel it needs. Redirecting rather than silencing is deliberate — a warning nobody
 * can see is how a misconfigured agent looks identical to a working one.
 */

import { Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { announceAcpStart } from '#src/modules/acp/acpCommon.js';
import type { AcpAgentAppOptions } from '#src/modules/acp/acpCommon.js';
import { createAcpAgentRouter } from '#src/modules/acp/acpRouter.js';

/** Seams for the tests; production passes nothing. */
export interface AcpStdioOptions extends AcpAgentAppOptions {
  /** Byte stream the client writes to. Defaults to the process's stdin. */
  input?: ReadableStream<Uint8Array>;
  /**
   * Byte sink the protocol writes to. Defaults to the process's real stdout, captured before the
   * redirect below so the redirect cannot swallow the protocol along with everything else.
   */
  output?: WritableStream<Uint8Array>;
}

/**
 * Sends everything written to `process.stdout` to stderr instead, and returns a sink holding the
 * ORIGINAL writer.
 *
 * The capture must happen before the redirect, and the sink must hold the captured function rather
 * than reach for `process.stdout.write` at write time — otherwise the transport's own frames go
 * through the redirect too and the agent talks to itself.
 */
function captureStdoutForProtocol(): WritableStream<Uint8Array> {
  const writeToRealStdout = process.stdout.write.bind(process.stdout);
  const writeToStderr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process.stdout.write = ((chunk: any, ...rest: any[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (writeToStderr as any)(chunk, ...rest)) as typeof process.stdout.write;
  return new WritableStream<Uint8Array>({
    write(chunk) {
      writeToRealStdout(chunk);
    },
  });
}

/**
 * Serves ACP over stdio until the client disconnects, in whichever protocol version the client
 * asks for on its first message.
 *
 * The dialect is not chosen here and is not configurable: `acpRouter.ts` reads it off the
 * `initialize` and hands the connection to the matching app. A flag would be the wrong shape —
 * an editor spawns this command with no arguments, so a version it had to be told would be a
 * version it never gets.
 *
 * Resolves when the connection closes, so a bin can `await` it and exit cleanly rather than
 * holding the event loop open on a socket nobody is reading.
 */
export async function startAcpServer(options: AcpStdioOptions = {}): Promise<void> {
  const { input, output, ...appOptions } = options;
  // Before anything can print. `announceAcpStart` below is the first thing that tries, and it is
  // there so the guarantee is exercised on every real start rather than only under test.
  const protocolOut = output ?? captureStdoutForProtocol();
  const protocolIn = input ?? (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

  const connection = createAcpAgentRouter(appOptions).connect(
    acp.ndJsonStream(protocolOut, protocolIn)
  );
  announceAcpStart();
  await connection.closed;
}
