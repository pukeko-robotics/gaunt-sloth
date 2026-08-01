import { describe, expect, it } from 'vitest';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';

/**
 * EXT-70 §4.7.1 — the ONE place a `tools/list` annotation enters the approvals stack: the shared
 * tool-registration hook both backends call with their final tool array.
 *
 * The tools here are built the way `@langchain/mcp-adapters` builds them — a
 * `DynamicStructuredTool` carrying `metadata: { annotations }` copied verbatim from the server's
 * response — so this pins the actual shape the recorder reads, not a hand-rolled stand-in of it.
 */

/** Exposes the protected registration hook so a spec can drive it directly. */
class TestAgent extends GthAbstractAgent {
  async init(): Promise<void> {
    /* not used */
  }
  register(tools: DynamicStructuredTool[], additionalToolNames: string[] = []): void {
    this.registerApprovalsAwareTools(tools, {
      rung: 'write',
      gatedTools: ['run_shell_command'],
      additionalToolNames,
    });
  }
}

const toolWith = (name: string, annotations?: unknown) =>
  new DynamicStructuredTool({
    name,
    description: 'a tool',
    schema: z.object({}),
    metadata: annotations === undefined ? undefined : { annotations },
    func: async () => 'ok',
  });

describe('GthAbstractAgent records what MCP servers declared (EXT-70 §4.7.1)', () => {
  it('is empty before any registration', () => {
    expect(new TestAgent(() => {}).getDeclaredMcpToolAnnotations().size).toBe(0);
  });

  it('records an MCP tool’s declaration, keyed by its registered name', () => {
    const agent = new TestAgent(() => {});
    agent.register([toolWith('mcp__jira__search', { readOnlyHint: true, openWorldHint: true })]);

    expect(agent.getDeclaredMcpToolAnnotations().get('mcp__jira__search')).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('does NOT record one of our own tools, whatever metadata it carries', () => {
    // A built-in's annotations come from our authored table; nothing here may reach the
    // per-hint-trusted MCP path, and a custom tool's own metadata is not ours to believe either.
    const agent = new TestAgent(() => {});
    agent.register([
      toolWith('gth_grep', { readOnlyHint: true }),
      toolWith('mcp__jira__search', { readOnlyHint: true }),
    ]);

    const declared = agent.getDeclaredMcpToolAnnotations();
    expect(declared.has('gth_grep')).toBe(false);
    // CONTROL: the MCP sibling registered in the same call WAS recorded, so this is about the
    // namespace rather than about recording being broken.
    expect(declared.has('mcp__jira__search')).toBe(true);
  });

  it('re-registration REPLACES the record rather than accumulating across inits', () => {
    // An MCP client caches its tool objects, and a re-init re-resolves the list. A stale record
    // would keep a declaration alive for a server that is no longer connected.
    const agent = new TestAgent(() => {});
    agent.register([toolWith('mcp__jira__search', { readOnlyHint: true })]);
    agent.register([toolWith('mcp__github__create_pr', { readOnlyHint: true })]);

    const declared = agent.getDeclaredMcpToolAnnotations();
    expect(declared.has('mcp__jira__search')).toBe(false);
    expect(declared.has('mcp__github__create_pr')).toBe(true);
  });

  it('a tool that declares nothing is not recorded as declaring nothing', () => {
    const agent = new TestAgent(() => {});
    agent.register([toolWith('mcp__jira__search'), toolWith('mcp__jira__delete', {})]);

    expect(agent.getDeclaredMcpToolAnnotations().size).toBe(0);
  });

  it('still records the registered tool NAMES, which share this hook', () => {
    // The hook does three things; this pins that adding the third did not disturb the second.
    const agent = new TestAgent(() => {});
    agent.register(
      [toolWith('mcp__jira__search', { readOnlyHint: true }), toolWith('gth_grep')],
      ['ls']
    );

    expect(agent.getRegisteredToolNames()).toEqual(['mcp__jira__search', 'gth_grep', 'ls']);
  });
});
