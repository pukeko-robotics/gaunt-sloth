/**
 * EXT-211 spec fixture: a real MCP server over stdio whose tools come from argv.
 *
 * Run as `node namedToolsStdioServer.mjs <tool> [<tool> ...]`. Each tool takes no arguments. A bare
 * name answers successfully with its own name. `<name>=<mode>` shapes that tool's answer:
 *
 * - `text-error` — `isError: true` with only a text block, holding `{"code":"TEXT_DENIED"}`;
 * - `structured-error` — `isError: true` with only `structuredContent` `{ code: 'STRUCTURED_DENIED' }`;
 * - `text-and-structured-error` — both of the above, plus `_meta`, so the two bodies disagree and a
 *   spec can tell which one was graded;
 * - `elicit` — asks the client to confirm (in-band elicitation) before answering.
 *
 * It is served through `serveStdio`, which answers whichever protocol era the client opens with, as
 * a current server does; the 2.x client's default mode then negotiates the modern era.
 *
 * It writes nothing to stdout except the protocol, and nothing to stderr at all: the transport
 * shares the child's stderr with the test runner.
 */
import { acceptedContent, inputRequired, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

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

// A tool registered with no input schema receives only the request context.
const elicit = (name) => async (ctx) =>
  acceptedContent(ctx.mcpReq.inputResponses, 'confirm')
    ? { content: [{ type: 'text', text: `${name} confirmed` }] }
    : inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Proceed with ${name}?`,
            requestedSchema: {
              type: 'object',
              properties: { confirm: { type: 'boolean' } },
              required: ['confirm'],
            },
          }),
        },
      });

const tools = process.argv.slice(2).map((arg) => {
  const [name, mode] = arg.split('=');
  if (mode === 'elicit') return [name, elicit(name)];
  const result = mode === undefined ? { content: [{ type: 'text', text: name }] } : RESULTS[mode];
  if (!result) throw new Error(`unknown fixture mode: ${mode}`);
  return [name, async () => result];
});

serveStdio(() => {
  const server = new McpServer({ name: 'ext-211-named-tools', version: '0.0.0' });
  for (const [name, handler] of tools) {
    server.registerTool(name, { description: `Fixture tool ${name}.` }, handler);
  }
  return server;
});
