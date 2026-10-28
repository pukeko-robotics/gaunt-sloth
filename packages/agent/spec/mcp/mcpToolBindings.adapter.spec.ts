import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import type { GthConfig } from '#src/config.js';
import { approvalSubjectForToolName } from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';
import { resolveApprovalRules } from '@gaunt-sloth/core/core/approvals/matcher.js';
import type { ApprovalEntry } from '@gaunt-sloth/core/config/shell-policy.js';

/**
 * EXT-211 — which server an MCP tool belongs to, driven through the **real** adapter.
 *
 * `@langchain/mcp-adapters` 2.x registers a server's tool as `mcp__<server>_<tool>`, with a single
 * underscore between the server key and the tool, and server keys commonly contain underscores
 * themselves. So with the keys `github` and `github_enterprise`, the name
 * `mcp__github_enterprise_search` is `github`'s tool `enterprise_search` or `github_enterprise`'s
 * tool `search`, and nothing in the string says which. Any parser of the name picks one reading
 * and is wrong for the other: a longest-prefix parser hands `github`'s tool to `github_enterprise`,
 * and a shortest-prefix parser hands `github_enterprise`'s tools to `github`. An approval rule
 * scoped to one server would then govern the other server's tools.
 *
 * The resolver records each tool's server from the adapter's per-server grouping when tools load,
 * and the approval subject is read from that record. These cells spawn real MCP servers over stdio
 * (`namedToolsStdioServer.mjs`, tool names from argv), resolve them through the production
 * `createResolvers().resolveTools`, and judge the subject `approvalSubjectForToolName` builds from
 * the resolver's own bindings — so the adapter's naming, the resolver's recording and the subject
 * construction are all the production code.
 */

// Built-in tools are irrelevant here and would otherwise touch the real fs/tool config.
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([]),
}));

const FIXTURE = fileURLToPath(new URL('./namedToolsStdioServer.mjs', import.meta.url));
const SPAWN_TIMEOUT_MS = 30_000;

let open: AgentResolvers | undefined;

afterEach(async () => {
  await open?.cleanupTools?.();
  open = undefined;
});

/** A stdio server entry that serves exactly the given tool names. */
function stdioServer(...toolNames: string[]) {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE, ...toolNames] };
}

async function resolve(mcpServers: Record<string, unknown>) {
  const { createResolvers } = await import('#src/resolvers.js');
  const resolvers = createResolvers();
  open = resolvers;
  const tools = await resolvers.resolveTools!({ llm: {}, mcpServers } as unknown as GthConfig);
  return {
    names: tools.map((tool) => tool.name).sort(),
    bindings: resolvers.getMcpToolBindings!(),
    failures: resolvers.getMcpConnectionFailures!(),
  };
}

/** Deny every tool of one server, as a user writes it in config. */
function denyServer(server: string): ApprovalEntry {
  return { type: 'mcpTool', server, matcher: 'glob', pattern: '*' };
}

function deniedBy(
  entry: ApprovalEntry,
  toolName: string,
  bindings: Parameters<typeof approvalSubjectForToolName>[1]
) {
  const decision = resolveApprovalRules(approvalSubjectForToolName(toolName, bindings), {
    allow: [],
    deny: [entry],
    escalate: [],
  });
  return decision?.action === 'deny';
}

describe('MCP tool server attribution through the real adapter (EXT-211)', () => {
  it(
    'names each tool mcp__<server>_<tool> and attributes it to its true server when one key nests in another',
    async () => {
      const { names, bindings, failures } = await resolve({
        github: stdioServer('enterprise_search'),
        github_enterprise: stdioServer('list_repos'),
      });

      expect(failures).toEqual([]);
      // Literal names on purpose: this pins the adapter's naming, which a name built by our own
      // helper would only compare against itself.
      expect(names).toEqual(['mcp__github_enterprise_list_repos', 'mcp__github_enterprise_search']);

      expect(approvalSubjectForToolName('mcp__github_enterprise_search', bindings)).toEqual({
        kind: 'mcpTool',
        server: 'github',
        name: 'enterprise_search',
      });
      expect(approvalSubjectForToolName('mcp__github_enterprise_list_repos', bindings)).toEqual({
        kind: 'mcpTool',
        server: 'github_enterprise',
        name: 'list_repos',
      });
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    "keeps a server-scoped deny rule off the other server's tools when one key nests in another",
    async () => {
      const { bindings } = await resolve({
        github: stdioServer('enterprise_search'),
        github_enterprise: stdioServer('list_repos'),
      });

      expect(deniedBy(denyServer('github'), 'mcp__github_enterprise_search', bindings)).toBe(true);
      expect(deniedBy(denyServer('github'), 'mcp__github_enterprise_list_repos', bindings)).toBe(
        false
      );
      expect(
        deniedBy(denyServer('github_enterprise'), 'mcp__github_enterprise_list_repos', bindings)
      ).toBe(true);
      expect(
        deniedBy(denyServer('github_enterprise'), 'mcp__github_enterprise_search', bindings)
      ).toBe(false);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'control: attributes tools and scopes deny rules when no key is a prefix of another',
    async () => {
      // Every reading of these names agrees, so a name parser passes this cell too. It stays green
      // under the prefix-parser mutations, which is what shows the cells above fail on the nested
      // key itself rather than on the harness.
      const { names, bindings } = await resolve({
        github: stdioServer('search'),
        gitlab: stdioServer('list_repos'),
      });

      expect(names).toEqual(['mcp__github_search', 'mcp__gitlab_list_repos']);
      expect(approvalSubjectForToolName('mcp__github_search', bindings)).toEqual({
        kind: 'mcpTool',
        server: 'github',
        name: 'search',
      });
      expect(deniedBy(denyServer('github'), 'mcp__github_search', bindings)).toBe(true);
      expect(deniedBy(denyServer('github'), 'mcp__gitlab_list_repos', bindings)).toBe(false);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'drops every MCP tool when two servers register the same name, and records why for each',
    async () => {
      // `a_b`'s tool `c` and `a`'s tool `b_c` both register as `mcp__a_b_c`. One binding cannot
      // name two servers, so the resolver refuses the toolset rather than let either win.
      const { names, bindings, failures } = await resolve({
        a_b: stdioServer('c', 'only_in_a_b'),
        a: stdioServer('b_c'),
      });

      expect(names).toEqual([]);
      expect(bindings.size).toBe(0);
      expect(failures.map((failure) => failure.server).sort()).toEqual(['a', 'a_b']);
      expect(failures[0].reason).toContain('mcp__a_b_c');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'control: loads both servers when their tool names stay distinct',
    async () => {
      const { names, failures } = await resolve({
        a_b: stdioServer('c', 'only_in_a_b'),
        a: stdioServer('d'),
      });

      expect(failures).toEqual([]);
      expect(names).toEqual(['mcp__a_b_c', 'mcp__a_b_only_in_a_b', 'mcp__a_d']);
    },
    SPAWN_TIMEOUT_MS
  );
});
