import { afterEach, describe, expect, it } from 'vitest';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { MCP_TOOL_NAME_PREFIX } from '@gaunt-sloth/core/constants.js';
import {
  approvalSubjectForToolName,
  bindMcpToolsets,
  mcpToolRegisteredName,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import { mcpToolErrorMessagePrefix } from '@gaunt-sloth/core/core/mcpErrorPayload.js';

/**
 * BATCH-43 — **the tripwire on the upstream error-message template.**
 *
 * An errored MCP tool's payload reaches `gth eval` as the message `@langchain/mcp-adapters` throws,
 * and the server's own error body is recovered from it by rebuilding that message's fixed prefix
 * and stripping it. The prefix is an upstream template literal: if a dependency bump rewords it, the
 * recovery silently stops happening — no error, no changed capture, every other test still green,
 * because the observed payload is identical either way and only the extra field disappears. Exactly
 * the class of failure a deepagents release once caused by blanking its system prompt.
 *
 * So this drives the **real adapter** against a **real MCP server** over an in-memory transport and
 * compares the thrown message to what production would build. One operand comes from the adapter
 * and one from `mcpToolErrorMessagePrefix`, which is what makes it a tripwire rather than a
 * tautology: a literal retyped on both sides would only pin this file against itself.
 *
 * A failure here means the recovery has stopped working, not that the spec is stale — read the
 * adapter's `_convertCallToolResult` and update the builder, do not relax the assertion.
 */

const SERVER_KEY = 'unimarket';
const BARE_TOOL_NAME = 'contract_search';
const SERVER_ERROR_BODY = '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';

let open: { client: Client; server: McpServer } | undefined;

/** A live MCP server whose only tool answers with `isError: true`, paired to a real SDK client. */
async function connectFixture(): Promise<Client> {
  const server = new McpServer({ name: 'batch-43-fixture', version: '0.0.0' });
  server.registerTool(
    BARE_TOOL_NAME,
    { description: 'Fixture tool. Always refuses, with a JSON error body.', inputSchema: {} },
    async () => ({ content: [{ type: 'text' as const, text: SERVER_ERROR_BODY }], isError: true })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'batch-43-spec', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open = { client, server };
  return client;
}

afterEach(async () => {
  await open?.client.close();
  await open?.server.close();
  open = undefined;
});

describe('@langchain/mcp-adapters error-message shape (BATCH-43 tripwire)', () => {
  it('throws exactly the prefix production rebuilds, followed by the server error body', async () => {
    const client = await connectFixture();
    const tools = await loadMcpTools(SERVER_KEY, client, {
      throwOnLoadError: true,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: MCP_TOOL_NAME_PREFIX,
    });

    const tool = tools.find((t) => t.name.endsWith(BARE_TOOL_NAME));
    expect(tool, 'the fixture tool should be registered').toBeDefined();

    let thrown: unknown;
    try {
      await tool!.invoke({});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('ToolException');
    // The whole point: production's builder + the server's body, character for character.
    expect((thrown as Error).message).toBe(
      `${mcpToolErrorMessagePrefix(SERVER_KEY, BARE_TOOL_NAME)}${SERVER_ERROR_BODY}`
    );
  });

  it('registers the tool under the name the server resolver reverses back to that same pair', async () => {
    // The adapter names the server by its configured key and the tool by its BARE name, while the
    // model calls the namespaced one. The recovery is only correct if resolving the registered name
    // through the bindings recorded from the adapter's own per-server tools returns the very pair
    // the adapter's message was built from — a
    // separate claim from the message shape above, and the one that breaks if the naming convention
    // changes rather than the wording.
    const client = await connectFixture();
    const tools = await loadMcpTools(SERVER_KEY, client, {
      throwOnLoadError: true,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: MCP_TOOL_NAME_PREFIX,
    });

    const registered = tools.map((t) => t.name);
    expect(registered).toContain(mcpToolRegisteredName(SERVER_KEY, BARE_TOOL_NAME));
    expect(
      approvalSubjectForToolName(
        mcpToolRegisteredName(SERVER_KEY, BARE_TOOL_NAME),
        bindMcpToolsets([[SERVER_KEY, tools]])
      )
    ).toEqual({ kind: 'mcpTool', server: SERVER_KEY, name: BARE_TOOL_NAME });
  });
});
