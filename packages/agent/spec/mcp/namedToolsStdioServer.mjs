/**
 * EXT-211 spec fixture: a real MCP server over stdio whose tools come from argv.
 *
 * Run as `node namedToolsStdioServer.mjs <tool> [<tool> ...]`. Each tool takes no arguments. A bare
 * name answers successfully with its own name. `<name>=<mode>` makes that tool refuse every call
 * with `isError: true`, shaped by the mode:
 *
 * - `text-error` — only a text block, holding the JSON body `{"code":"TEXT_DENIED"}`;
 * - `structured-error` — only `structuredContent` `{ code: 'STRUCTURED_DENIED' }`, with no text;
 * - `text-and-structured-error` — both of the above, plus `_meta`, so the two bodies disagree and a
 *   spec can tell which one was graded.
 *
 * It writes nothing to stdout except the protocol, and nothing to stderr at all: the transport
 * shares the child's stderr with the test runner.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const TEXT_BODY = { type: 'text', text: '{"code":"TEXT_DENIED"}' };
const STRUCTURED_BODY = { code: 'STRUCTURED_DENIED' };

const RESULTS = {
  'text-error': { content: [TEXT_BODY], isError: true },
  'structured-error': { content: [], structuredContent: STRUCTURED_BODY, isError: true },
  'text-and-structured-error': {
    content: [TEXT_BODY],
    structuredContent: STRUCTURED_BODY,
    _meta: { 'example.com/trace': 'fixture' },
    isError: true,
  },
};

const server = new McpServer({ name: 'ext-211-named-tools', version: '0.0.0' });
for (const arg of process.argv.slice(2)) {
  const [name, mode] = arg.split('=');
  const result = mode === undefined ? { content: [{ type: 'text', text: name }] } : RESULTS[mode];
  if (!result) throw new Error(`unknown fixture mode: ${mode}`);
  server.registerTool(name, { description: `Fixture tool ${name}.` }, async () => result);
}
await server.connect(new StdioServerTransport());
