import { afterEach, describe, expect, it } from 'vitest';
import { ToolMessage } from '@langchain/core/messages';
import { loadMcpTools } from '@langchain/mcp-adapters';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { MCP_TOOL_NAME_PREFIX } from '@gaunt-sloth/core/constants.js';
import {
  approvalSubjectForToolName,
  bindMcpToolsets,
  mcpToolRegisteredName,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import {
  MCP_STRUCTURED_CONTENT_ARTIFACT,
  mcpToolErrorMessagePrefix,
} from '@gaunt-sloth/core/core/mcpErrorPayload.js';

/**
 * BATCH-43 / EXT-211 — **the tripwire on the shape `@langchain/mcp-adapters` gives an errored MCP
 * tool result.**
 *
 * `core/mcpErrorPayload.ts` recovers the server's own error body from what the adapter hands back,
 * and it depends on two shapes that are upstream's to change:
 *
 * - **Invoked as a tool call** — how the agent's tool node always invokes a tool — the adapter
 *   returns a `ToolMessage` with `status: 'error'`, the server's text as its content with nothing
 *   added, and the result's `structuredContent` and `_meta` in its artifact. The capture reads the
 *   artifact entry by its type, so a renamed entry would silently stop structured bodies being
 *   graded.
 * - **Invoked with plain arguments** it throws a `ToolException` whose message is a fixed prefix
 *   followed by the server's text, and the capture strips a prefix it rebuilds itself. A reworded
 *   template would silently stop that recovery.
 *
 * Either break leaves every other test green, because the observed payload is the same and only the
 * extra field disappears. So this drives the **real adapter** against a **real MCP server** over an
 * in-memory transport. Where it compares against production, one operand comes from the adapter and
 * one from production's own constant or builder, which is what makes it a tripwire rather than a
 * tautology.
 *
 * A failure here means the recovery has stopped working, not that the spec is stale — read the
 * adapter's `convertCallToolError` and update the capture, do not relax the assertion.
 */

const SERVER_KEY = 'unimarket';
const BARE_TOOL_NAME = 'contract_search';
const SERVER_ERROR_BODY = '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';
const STRUCTURED_BODY = { code: 'forbidden', scopes: ['contracts:read'] };
const META = { 'example.com/trace': 'batch-43' };

let open: { client: Client; server: McpServer } | undefined;

/**
 * A live MCP server whose only tool answers with `isError: true` — a JSON text body, plus
 * `structuredContent` and `_meta` — paired to a real client.
 */
async function connectFixture(): Promise<Client> {
  const server = new McpServer({ name: 'batch-43-fixture', version: '0.0.0' });
  server.registerTool(
    BARE_TOOL_NAME,
    { description: 'Fixture tool. Always refuses, with a JSON error body.' },
    async () => ({
      content: [{ type: 'text' as const, text: SERVER_ERROR_BODY }],
      structuredContent: STRUCTURED_BODY,
      _meta: META,
      isError: true,
    })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'batch-43-spec', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  open = { client, server };
  return client;
}

async function loadFixtureTool() {
  const client = await connectFixture();
  const tools = await loadMcpTools(SERVER_KEY, client, {
    throwOnLoadError: true,
    prefixToolNameWithServerName: true,
    additionalToolNamePrefix: MCP_TOOL_NAME_PREFIX,
  });
  const tool = tools.find((t) => t.name === mcpToolRegisteredName(SERVER_KEY, BARE_TOOL_NAME));
  expect(tool, 'the fixture tool should be registered under its bound name').toBeDefined();
  return { tool: tool!, tools };
}

afterEach(async () => {
  await open?.client.close();
  await open?.server.close();
  open = undefined;
});

describe('@langchain/mcp-adapters errored-result shape (BATCH-43 / EXT-211 tripwire)', () => {
  it('returns an error ToolMessage with the bare server text and the structured artifact, for a tool call', async () => {
    const { tool } = await loadFixtureTool();
    const name = mcpToolRegisteredName(SERVER_KEY, BARE_TOOL_NAME);

    const result: unknown = await tool.invoke({
      name,
      args: {},
      id: 'call-1',
      type: 'tool_call',
    });

    expect(ToolMessage.isInstance(result)).toBe(true);
    const message = result as ToolMessage;
    expect(message.status).toBe('error');
    expect(message.name).toBe(name);
    expect(message.tool_call_id).toBe('call-1');
    // Bare: no prefix from the adapter, and none from us.
    expect(message.content).toBe(SERVER_ERROR_BODY);
    expect(message.artifact).toEqual(
      expect.arrayContaining([
        { type: MCP_STRUCTURED_CONTENT_ARTIFACT, data: STRUCTURED_BODY },
        { type: 'mcp_meta', data: META },
      ])
    );
  });

  it('throws exactly the prefix production rebuilds, followed by the server text, for plain arguments', async () => {
    const { tool } = await loadFixtureTool();

    let thrown: unknown;
    try {
      await tool.invoke({});
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

  it('registers the tool under the name the bindings resolve back to that same pair', async () => {
    // The adapter names the server by its configured key and the tool by its BARE name, while the
    // model calls the namespaced one. The recovery is only correct if resolving the registered name
    // through the bindings recorded from the adapter's own per-server tools returns the very pair
    // the adapter's message was built from — a separate claim from the shapes above, and the one
    // that breaks if the naming convention changes rather than the wording.
    const { tools } = await loadFixtureTool();

    expect(
      approvalSubjectForToolName(
        mcpToolRegisteredName(SERVER_KEY, BARE_TOOL_NAME),
        bindMcpToolsets([[SERVER_KEY, tools]])
      )
    ).toEqual({ kind: 'mcpTool', server: SERVER_KEY, name: BARE_TOOL_NAME });
  });
});
