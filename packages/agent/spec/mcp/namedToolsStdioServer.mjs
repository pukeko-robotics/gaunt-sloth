/**
 * EXT-211 spec fixture: a real MCP server over stdio whose tool names come from argv.
 *
 * Run as `node namedToolsStdioServer.mjs <tool> [<tool> ...]`. Each tool takes no arguments and
 * answers with its own name, so a spec can drive the real `@langchain/mcp-adapters` client through
 * a real handshake against any set of names it needs, without a fixture file per server.
 *
 * It writes nothing to stdout except the protocol, and nothing to stderr at all: the transport
 * shares the child's stderr with the test runner.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const toolNames = process.argv.slice(2);
const server = new McpServer({ name: 'ext-211-named-tools', version: '0.0.0' });
for (const name of toolNames) {
  server.registerTool(name, { description: `Fixture tool ${name}.` }, async () => ({
    content: [{ type: 'text', text: name }],
  }));
}
await server.connect(new StdioServerTransport());
