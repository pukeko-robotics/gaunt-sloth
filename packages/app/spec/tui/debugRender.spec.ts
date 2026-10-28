import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  bindMcpToolsets,
  mcpToolRegisteredName,
  NO_MCP_TOOL_BINDINGS,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import { MCP_SERVER_SEPARATOR } from '@gaunt-sloth/core/constants.js';

describe('tui/debugRender', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renderHistory serializes the message list as readable JSON (type + content)', async () => {
    const { renderHistory } = await import('#src/tui/debugRender.js');
    const out = renderHistory([new SystemMessage('sys'), new HumanMessage('hello')]);
    // TUI-C16: a leading description scrolls with the content; the JSON body follows it.
    const parsed = JSON.parse(out.slice(out.indexOf('[')));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    // mapChatMessagesToStoredMessages tags each entry with its type and a data.content field.
    expect(out).toContain('system');
    expect(out).toContain('human');
    expect(out).toContain('hello');
  });

  it('renderResponse serializes an AIMessage response', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const out = renderResponse(new AIMessage('the answer'));
    expect(out).toContain('the answer');
    expect(out).toContain('ai');
  });

  it('renderResponse falls back to plain JSON for a non-message value', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const out = renderResponse({ foo: 'bar' });
    expect(JSON.parse(out)).toEqual({ foo: 'bar' });
  });

  it('renderResponse degrades gracefully on a non-serializable value (never throws)', async () => {
    const { renderResponse } = await import('#src/tui/debugRender.js');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = renderResponse(circular);
    expect(out).toContain('could not render response');
  });

  it('renderSystemDetails surfaces model params, tool-choice and the system prompt (no tool defs)', async () => {
    const { renderSystemDetails } = await import('#src/tui/debugRender.js');
    const out = renderSystemDetails({
      systemPrompt: 'You are a careful sloth.',
      toolChoice: 'auto',
      modelParams: { model: 'claude-opus-4', temperature: 0.3 },
      tools: [{ name: 'read_file', description: 'Reads a file', schema: { type: 'object' } }],
    });

    expect(out).toContain('MODEL PARAMS');
    expect(out).toContain('claude-opus-4');
    expect(out).toContain('TOOL CHOICE');
    expect(out).toContain('SYSTEM PROMPT');
    expect(out).toContain('You are a careful sloth.');
    // TUI-C16: the tool catalogue lives on its own tab, not in the system view.
    expect(out).not.toContain('TOOL DEFINITIONS');
    expect(out).not.toContain('read_file');
  });

  it('renderToolDetails leads with a name list, then the full per-tool descriptors', async () => {
    const { renderToolDetails } = await import('#src/tui/debugRender.js');
    const out = renderToolDetails({
      tools: [
        { name: 'read_file', description: 'Reads a file', schema: { type: 'object' } },
        { name: 'write_file', description: 'Writes a file' },
      ],
    });

    expect(out).toContain('TOOLS (2)');
    expect(out).toContain('TOOL DEFINITIONS');
    expect(out).toContain('read_file');
    expect(out).toContain('write_file');
    // (3) the compact name list precedes the full definitions block.
    expect(out.indexOf('• read_file')).toBeLessThan(out.indexOf('TOOL DEFINITIONS'));
    // The schema is rendered under the tool that has one.
    expect(out).toContain('params:');
  });

  it('renderToolDetails converts a Zod tool schema to JSON schema', async () => {
    const { z } = await import('zod');
    const { renderToolDetails } = await import('#src/tui/debugRender.js');
    const out = renderToolDetails({
      tools: [{ name: 'do_thing', schema: z.object({ count: z.number() }) }],
    });
    expect(out).toContain('do_thing');
    // zodToJsonSchema yields a JSON-schema object with the property name.
    expect(out).toContain('count');
    expect(out).toContain('"type"');
  });

  it('renderSystemDetails / renderToolDetails show a clear empty state when nothing was captured', async () => {
    const { renderSystemDetails, renderToolDetails } = await import('#src/tui/debugRender.js');
    expect(renderSystemDetails(undefined)).toContain('no request details captured');
    expect(renderToolDetails(undefined)).toContain('no request details captured');
  });

  // ── TUI-C20: the MCP overview tab ────────────────────────────────────────────
  it('renderMcpDetails lists each server, its instructions and its bound tools, and names the Tools tab', async () => {
    const { renderMcpDetails } = await import('#src/tui/debugRender.js');
    const getDocs = mcpToolRegisteredName('ctx7', 'get_docs');
    const resolveId = mcpToolRegisteredName('ctx7', 'resolve_id');
    const out = renderMcpDetails(
      {
        tools: [
          { name: getDocs, description: 'Fetch docs for a library\n(second line ignored)' },
          { name: resolveId, description: 'Resolve a library id' },
          // … a non-MCP built-in tool has no binding and must NOT be grouped under any server.
          { name: 'read_file', description: 'Reads a file' },
        ],
      },
      ['ctx7'],
      [{ server: 'ctx7', instructions: 'Use resolve_id before get_docs.' }],
      [],
      bindMcpToolsets([['ctx7', [{ name: getDocs }, { name: resolveId }]]])
    );

    // Intro points at the Tools tab for the full definitions (this is the overview, not the schemas).
    expect(out).toContain('Tools tab');
    // The server heading and its captured instructions.
    expect(out).toContain('ctx7');
    expect(out).toContain('Use resolve_id before get_docs.');
    // Its tools, by their registered name + a one-line description (first line only).
    expect(out).toContain(`${getDocs}: Fetch docs for a library`);
    expect(out).toContain(`${resolveId}: Resolve a library id`);
    expect(out).not.toContain('second line ignored');
    // A built-in tool is not attributed to the server.
    expect(out).not.toContain('read_file');
    // Instruction text renders ABOVE the tool list under each server.
    expect(out.indexOf('Use resolve_id')).toBeLessThan(out.indexOf(getDocs));
  });

  it('renderMcpDetails groups by binding, so a nested server key does not swallow its sibling’s tools', async () => {
    // EXT-211: every `github_enterprise` tool name starts with `github`'s prefix as well, so a
    // prefix grouping would list them under both servers.
    const { renderMcpDetails } = await import('#src/tui/debugRender.js');
    const nested = `github${MCP_SERVER_SEPARATOR}enterprise`;
    const ghSearch = mcpToolRegisteredName('github', 'search');
    const gheList = mcpToolRegisteredName(nested, 'list_repos');
    const out = renderMcpDetails(
      { tools: [{ name: ghSearch }, { name: gheList }] },
      ['github', nested],
      [],
      [],
      bindMcpToolsets([
        ['github', [{ name: ghSearch }]],
        [nested, [{ name: gheList }]],
      ])
    );
    const githubSection = out.slice(out.indexOf('── github ──'), out.indexOf(`── ${nested} ──`));
    expect(githubSection).toContain(ghSearch);
    expect(githubSection).not.toContain(gheList);
    expect(out.slice(out.indexOf(`── ${nested} ──`))).toContain(gheList);
  });

  it('renderMcpDetails shows a neutral line for a server that supplied no instructions', async () => {
    const { renderMcpDetails } = await import('#src/tui/debugRender.js');
    // `github` is in the server list but absent from the captured instructions array.
    const listPrs = mcpToolRegisteredName('github', 'list_prs');
    const out = renderMcpDetails(
      { tools: [{ name: listPrs, description: 'List PRs' }] },
      ['github'],
      [],
      [],
      bindMcpToolsets([['github', [{ name: listPrs }]]])
    );
    expect(out).toContain('github');
    expect(out).toContain('(no instructions provided)');
    // The tool list still renders even without instructions.
    expect(out).toContain(listPrs);
  });

  it('renderMcpDetails renders a neutral empty state (no crash) when no MCP servers are configured', async () => {
    const { renderMcpDetails } = await import('#src/tui/debugRender.js');
    const out = renderMcpDetails(undefined, [], []);
    expect(out).toContain('MCP SERVERS (0)');
    expect(out).toContain('(no MCP servers configured)');
    // Still names the Tools tab so the tab reads consistently even when empty.
    expect(out).toContain('Tools tab');
  });

  it('collectMcpOverview sources instructions from the EXT-32 getMcpServerInstructions accessor', async () => {
    const { collectMcpOverview } = await import('#src/tui/debugRender.js');
    const captured = [{ server: 'ctx7', instructions: 'Use library IDs.' }];
    const getMcpServerInstructions = vi.fn(() => captured);

    const out = collectMcpOverview({ mcpServers: { ctx7: {}, github: {} } } as never, {
      getMcpServerInstructions,
    });

    // The tab's instructions come from the accessor (called once), not a re-capture.
    expect(getMcpServerInstructions).toHaveBeenCalledTimes(1);
    expect(out.instructions).toEqual(captured);
    // The server list is the full configured set (both connected servers), from config.mcpServers.
    expect(out.servers).toEqual(['ctx7', 'github']);
  });

  it('collectMcpOverview is defensive: no config / no accessor yields an empty overview', async () => {
    const { collectMcpOverview } = await import('#src/tui/debugRender.js');
    expect(collectMcpOverview(undefined, undefined)).toEqual({
      servers: [],
      instructions: [],
      failures: [],
      bindings: NO_MCP_TOOL_BINDINGS,
    });
    expect(collectMcpOverview({ mcpServers: undefined } as never, {})).toEqual({
      servers: [],
      instructions: [],
      failures: [],
      bindings: NO_MCP_TOOL_BINDINGS,
    });
  });

  it('collectMcpOverview sources connection failures from the getMcpConnectionFailures accessor', async () => {
    const { collectMcpOverview } = await import('#src/tui/debugRender.js');
    const failures = [{ server: 'orgname', reason: 'fetch failed' }];
    const getMcpConnectionFailures = vi.fn(() => failures);

    const out = collectMcpOverview({ mcpServers: { orgname: {} } } as never, {
      getMcpConnectionFailures,
    });

    expect(getMcpConnectionFailures).toHaveBeenCalledTimes(1);
    expect(out.failures).toEqual(failures);
  });

  it('renderMcpDetails names a failed server with its reason instead of a bare "no tools" line', async () => {
    const { renderMcpDetails } = await import('#src/tui/debugRender.js');
    const out = renderMcpDetails(
      { tools: [] },
      ['orgname'],
      [],
      [{ server: 'orgname', reason: 'TypeError: fetch failed' }]
    );
    // The failure is surfaced with its reason …
    expect(out).toContain('connection failed: TypeError: fetch failed');
    // … and the misleading "connected but empty" wording is not used for a failed server.
    expect(out).not.toContain('(no tools loaded for this server)');
    expect(out).toContain('server unavailable');
  });
});
