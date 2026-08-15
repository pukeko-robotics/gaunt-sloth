/**
 * @packageDocumentation
 * Picks the ACP dialect a connection gets, from the connection itself.
 *
 * ## The problem, and why the SDK solves it rather than us
 *
 * There is one stdio connection and the protocol version is knowable only from the first
 * `initialize` — which is also the first thing the chosen app has to handle. So a dispatcher has to
 * read a message it is not allowed to consume, and pushing it back onto a `ReadableStream` is the
 * part that is awkward to do correctly.
 *
 * `@agentclientprotocol/sdk` already does exactly this. {@link acp.agentProtocolRouter} takes the
 * first wire item, requires it to be an `initialize`, selects the highest configured version that
 * does not exceed the client's requested one, and re-enqueues the request into a fresh readable in
 * front of the rest of the stream. Nothing later is touched. Using it means the sniff, the pushback
 * and the not-configured / not-an-initialize error paths are the SDK's problem, on the same pinned
 * version as the two apps it routes between.
 *
 * It is exported from the `experimental/v2` entry point rather than from `experimental/server` —
 * `AcpServer` there is an HTTP/WebSocket transport and does not route by version.
 *
 * ## What each side gets
 *
 * A client asking for **1** reaches the v1 app; a client asking for **2 or higher** reaches the v2
 * app. Neither app sees the other's traffic and neither is a translation layer over the other:
 * `acpAgentAppV1.ts` and `acpAgentApp.ts` implement their own dialects, which differ in more than
 * naming (see either module's doc).
 *
 * A version below 1 gets the SDK's `unsupported ACP protocol version` error, which is the honest
 * answer — there is no ACP dialect this agent could serve such a client in.
 */

import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpAgentApp } from '#src/modules/acp/acpAgentApp.js';
import { createAcpV1AgentApp } from '#src/modules/acp/acpAgentAppV1.js';
import type { AcpAgentAppOptions } from '#src/modules/acp/acpCommon.js';

/**
 * Builds the version-dispatching front door: both apps, wired behind one connector.
 *
 * `options` reaches both apps unchanged, so a caller cannot end up with a configured v2 surface and
 * a default v1 one — a divergence that would show up only against whichever client the tests do not
 * use.
 */
export function createAcpAgentRouter(options: AcpAgentAppOptions = {}): acp.AgentProtocolRouter {
  return acp
    .agentProtocolRouter()
    .withV1(createAcpV1AgentApp(options))
    .withV2(createAcpAgentApp(options));
}
