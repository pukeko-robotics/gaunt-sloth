import { describe, expect, it } from 'vitest';
import { mcpToolErrorMessagePrefix, mcpToolErrorPayload } from '#src/core/mcpErrorPayload.js';
import { TOOL_RESULT_CONTENT_CAP } from '#src/core/runStats.js';
import {
  bindMcpToolsets,
  mcpToolRegisteredName,
  NO_MCP_TOOL_BINDINGS,
  type McpToolBindings,
} from '#src/core/approvals/mcpSubjects.js';

/** Bindings for `(server, tool)` pairs, recorded by the production builder. */
const bound = (...pairs: [server: string, tool: string][]): McpToolBindings =>
  bindMcpToolsets(
    pairs.map(([server, tool]) => [server, [{ name: mcpToolRegisteredName(server, tool) }]])
  );

const UNIMARKET_SEARCH = mcpToolRegisteredName('unimarket', 'contract_search');
const UNIMARKET_BOUND = bound(['unimarket', 'contract_search']);

/**
 * BATCH-43 — recovering an errored MCP tool's own error body from the adapter's prose-prefixed
 * message, so `gth eval`'s `tool_result_json_path` can grade what a denial said.
 *
 * The rules under test are all refusals, and each of them is load-bearing: the field is recorded
 * only when the message provably came from the adapter's error template for *this* tool on *this*
 * server and the remainder is JSON that fits the capture cap. Anything else records nothing, so the
 * grading check falls back to the observed payload and its existing reason rather than to a guess.
 *
 * **The separator-in-a-server-key cases are the ones that discriminate.** Every other case here
 * passes under an implementation that splits the registered name on the separator, which is exactly
 * the shortcut `approvalSubjectForToolName` exists to prevent: the server comes from the binding
 * recorded at tool load, and a prefix built from a server read off the name would not match.
 */
describe('core/mcpErrorPayload', () => {
  const body = '{"code":"forbidden","reason":"identity lacks scope contracts:read"}';

  /** The message `@langchain/mcp-adapters` throws for an `isError: true` result. */
  const adapterMessage = (server: string, tool: string, text: string): string =>
    `${mcpToolErrorMessagePrefix(server, tool)}${text}`;

  it('builds the adapter prefix with the bare tool name and the configured server key', () => {
    expect(mcpToolErrorMessagePrefix('unimarket', 'contract_search')).toBe(
      "MCP tool 'contract_search' on server 'unimarket' returned an error: "
    );
  });

  it('recovers the server error body from a softened MCP tool error', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('unimarket', 'contract_search', body),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBe(body);
    expect(JSON.parse(payload!)).toEqual({
      code: 'forbidden',
      reason: 'identity lacks scope contracts:read',
    });
  });

  it('resolves a server key that CONTAINS the separator (a name split would attribute it wrongly)', () => {
    // A split of the registered name would read a shorter server, whose computed prefix matches
    // nothing; the binding names 'uni__market'.
    const payload = mcpToolErrorPayload(
      {
        name: mcpToolRegisteredName('uni__market', 'contract__search'),
        isError: true,
        content: adapterMessage('uni__market', 'contract__search', body),
      },
      bound(['uni__market', 'contract__search']),
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBe(body);
  });

  it('builds the prefix from the BOUND server, so a binding naming another server recovers nothing', () => {
    // The same registered name, bound to a different server: the prefix is computed from the
    // binding, so it is not the one the message carries. Nothing is read off the name.
    const name = mcpToolRegisteredName('uni__market', 'contract_search');
    const payload = mcpToolErrorPayload(
      { name, isError: true, content: adapterMessage('uni__market', 'contract_search', body) },
      new Map([[name, { server: 'uni', tool: 'market__contract_search' }]]),
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing when the name has no binding', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('unimarket', 'contract_search', body),
      },
      NO_MCP_TOOL_BINDINGS,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing for a tool outside the MCP namespace', () => {
    const payload = mcpToolErrorPayload(
      {
        name: 'run_shell_command',
        isError: true,
        content: adapterMessage('unimarket', 'run_shell_command', body),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing when the message does not start with the COMPUTED prefix', () => {
    // The same tool, but the message names a different server — so the prefix this call computes
    // is not the one the message carries. This is also the shape an upstream reword would take.
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('other', 'contract_search', body),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing for the adapter OTHER messages about the same tool', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content:
          "MCP tool 'contract_search' on server 'unimarket' returned an invalid result - " +
          'tool call response was undefined',
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing when the server formatted its error as prose rather than JSON', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('unimarket', 'contract_search', 'you are not allowed to do that'),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing rather than a TRUNCATED body when the payload exceeds the cap', () => {
    // A JSON document cut at the cap does not parse, so recording one would break the
    // present-implies-parseable contract and fail the check anyway, while reading as a success.
    const huge = `{"reason":"${'x'.repeat(TOOL_RESULT_CONTENT_CAP)}"}`;
    expect(huge.length).toBeGreaterThan(TOOL_RESULT_CONTENT_CAP);
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('unimarket', 'contract_search', huge),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records the body when it sits exactly ON the cap', () => {
    const filler = 'x'.repeat(TOOL_RESULT_CONTENT_CAP - '{"reason":""}'.length);
    const exact = `{"reason":"${filler}"}`;
    expect(Buffer.byteLength(exact)).toBe(TOOL_RESULT_CONTENT_CAP);
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: adapterMessage('unimarket', 'contract_search', exact),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBe(exact);
  });

  it('records nothing for a result that is not an error', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: false,
        content: adapterMessage('unimarket', 'contract_search', body),
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });

  it('records nothing when the content is not a plain string', () => {
    const payload = mcpToolErrorPayload(
      {
        name: UNIMARKET_SEARCH,
        isError: true,
        content: [{ type: 'text', text: adapterMessage('unimarket', 'contract_search', body) }],
      },
      UNIMARKET_BOUND,
      TOOL_RESULT_CONTENT_CAP
    );
    expect(payload).toBeUndefined();
  });
});
