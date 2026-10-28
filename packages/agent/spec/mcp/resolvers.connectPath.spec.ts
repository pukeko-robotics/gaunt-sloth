import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AgentResolvers } from '@gaunt-sloth/core/core/types.js';
import type { GthConfig } from '#src/config.js';

/**
 * EXT-211 — the MCP connect path on `@langchain/mcp-adapters` 2.x, through the production
 * `createResolvers().resolveTools` and the real adapter. No fakes of the adapter or the SDK.
 *
 * - **A failed connect keeps its cause chain.** The adapter attaches the transport's error as the
 *   `cause` of the error it reports, so the warning can name the network failure from the error
 *   itself. The `undici` diagnostics capture that once supplied it is neutralised here, so a green
 *   cell can only come from the error's own chain.
 * - **One stale key drops every MCP tool.** The adapter validates server entries strictly and
 *   rejects the whole configuration in its constructor, so a key it does not know on one server
 *   costs the tools of every server. That is accepted behaviour, documented for users; these cells
 *   pin it so a change in either direction is seen.
 */

const warnings: string[] = [];
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  displayInfo: vi.fn(),
  displayWarning: (message: string) => warnings.push(message),
}));

// The diagnostics-channel capture is the fallback source of a cause; with it silenced, any cause
// in the warning came from the adapter's error.
vi.mock('#src/mcp/fetchErrorCapture.js', () => ({
  captureFetchErrors: () => ({ errorFor: () => undefined, stop: () => {} }),
}));

// Built-in tools are irrelevant here and would otherwise touch the real fs/tool config.
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([]),
}));

const FIXTURE = fileURLToPath(new URL('./namedToolsStdioServer.mjs', import.meta.url));
const SPAWN_TIMEOUT_MS = 30_000;

let open: AgentResolvers | undefined;

beforeEach(() => {
  warnings.length = 0;
});

afterEach(async () => {
  await open?.cleanupTools?.();
  open = undefined;
});

async function resolve(mcpServers: Record<string, unknown>) {
  const { createResolvers } = await import('#src/resolvers.js');
  const resolvers = createResolvers();
  open = resolvers;
  const tools = await resolvers.resolveTools!({ llm: {}, mcpServers } as unknown as GthConfig);
  return {
    names: tools.map((tool) => tool.name).sort(),
    failures: resolvers.getMcpConnectionFailures!(),
  };
}

/** A local port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  return address.port;
}

function stdioServer(...toolNames: string[]) {
  return { transport: 'stdio', command: process.execPath, args: [FIXTURE, ...toolNames] };
}

describe('MCP connect path on the 2.x adapter (EXT-211)', () => {
  it(
    'names the network cause of a refused connection from the error itself',
    async () => {
      const port = await closedPort();
      const { names, failures } = await resolve({
        refused: { url: `http://127.0.0.1:${port}/mcp` },
      });

      expect(names).toEqual([]);
      expect(failures.map((failure) => failure.server)).toEqual(['refused']);
      const warning = warnings.find((w) => w.includes('"refused"'));
      expect(warning, warnings.join('\n')).toBeDefined();
      expect(warning).toContain('not an authentication error');
      expect(warning).toMatch(/Caused by: .*ECONNREFUSED/);
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'drops every MCP tool when one server entry carries a key the adapter does not know',
    async () => {
      const port = await closedPort();
      const { names, failures } = await resolve({
        good: stdioServer('search'),
        stale: { url: `http://127.0.0.1:${port}/mcp`, automaticSSEFallback: true },
      });

      expect(names).toEqual([]);
      expect(failures.map((failure) => failure.server).sort()).toEqual(['good', 'stale']);
      expect(warnings.join('\n')).toContain('automaticSSEFallback');
    },
    SPAWN_TIMEOUT_MS
  );

  it(
    'control: loads the good server when the other entry carries only known keys',
    async () => {
      const { names, failures } = await resolve({
        good: stdioServer('search'),
        other: stdioServer('list'),
      });

      expect(failures).toEqual([]);
      expect(names).toEqual(['mcp__good_search', 'mcp__other_list']);
    },
    SPAWN_TIMEOUT_MS
  );
});
