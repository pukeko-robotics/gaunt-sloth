/**
 * [[TUI-C88]] PTY e2e fixture: **a real MCP server over stdio, written from nothing.**
 *
 * The `mcpTool` arm of the approval prompt is the only one whose sentence a no-subject fallback
 * cannot forge, and the tool names the interrupt is wired over are the **bound** ones — so proving
 * that arm end to end needs a tool a real MCP client actually registered from a real handshake. A
 * config entry alone registers nothing.
 *
 * **Zero dependencies, deliberately.** `@modelcontextprotocol/sdk` is a dependency of
 * `packages/agent` and does not resolve from this folder; reaching for it here would mean adding a
 * dependency to `packages/app` for a test fixture, and a lockfile change is the one class of change
 * a warm local checkout cannot validate. The wire format this has to speak is small and stable:
 * newline-delimited JSON-RPC 2.0 on stdin/stdout, which is all `StdioClientTransport` does.
 *
 * ## What it answers, and what it must never do
 *
 * - `initialize` — echoes the client's own `protocolVersion` back. The client rejects any version
 *   outside its supported set, and the version it just sent is by construction inside it, so
 *   echoing negotiates correctly against every SDK release without pinning a literal here.
 * - `tools/list` — exactly one tool, so the registered name is `mcp__<server key>__ping`.
 * - `tools/call` — answered, though the e2e case refuses the call and never reaches it.
 * - anything else with an `id` — a JSON-RPC "method not found" error, never a silent hang.
 * - anything without an `id` is a notification and gets **no** reply, per JSON-RPC.
 *
 * **`capabilities` advertises `tools` and nothing else.** Advertising `resources` would make
 * `resolvers.ts` synthesize two more agent-callable tools against this server, widening the bound
 * toolset the test reasons about for no gain.
 *
 * **Both streams stay silent.** The transport leaves the child's stderr `inherit`ed, so a stray log
 * or an uncaught throw would paint into the terminal the assertions are read off. Every message is
 * handled inside a `try`, and a message that cannot be parsed is dropped rather than reported.
 *
 * It exits when stdin closes, which is how the transport shuts a server down — so no child outlives
 * the run that spawned it.
 */

/** Written as one line each; the client frames on `\n` and tolerates a trailing `\r`. */
const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });

/** The tool this server exposes. Short on purpose: the prompt sentence naming it must fit one row. */
const TOOL = {
  name: 'ping',
  description: 'Fixture MCP tool. Answers with a fixed string and touches nothing.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const handle = (message) => {
  const { id, method, params } = message;
  // A notification carries no id and must never be answered.
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      if (isRequest) {
        result(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'gth-tui-e2e-fixture', version: '0.0.0' },
        });
      }
      return;
    case 'tools/list':
      if (isRequest) result(id, { tools: [TOOL] });
      return;
    case 'tools/call':
      if (isRequest) {
        result(id, { content: [{ type: 'text', text: 'pong' }], isError: false });
      }
      return;
    case 'ping':
      if (isRequest) result(id, {});
      return;
    default:
      if (isRequest) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
  }
};

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (line.trim().length > 0) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed or unanswerable line is dropped in silence: this process shares the terminal
        // under assertion, so there is nowhere here that a diagnostic could go without corrupting
        // the thing being measured.
      }
    }
    newline = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
