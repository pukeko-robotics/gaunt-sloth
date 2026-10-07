import { channel } from 'node:diagnostics_channel';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

const requestErrorChannel = channel('undici:request:error');

/**
 * EXT-31 — resolveTools must SURFACE an integration's expired/invalid auth (naming it + suggesting
 * re-auth) instead of silently dropping its tools, while degrading gracefully: other servers' and
 * built-in tools keep loading. Driven through the real resolveTools by stubbing the MCP client so a
 * "failed" server invokes the onConnectionError callback (as the adapter does) and contributes no
 * tools, and a healthy server contributes tools.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => consoleUtilsMock);

// Built-in tools: a single sentinel so we can assert built-ins survive an MCP auth failure.
const BUILTIN_TOOL = { name: 'builtin__read' } as unknown;
vi.mock('#src/builtInToolsConfig.js', () => ({
  getDefaultTools: vi.fn().mockResolvedValue([BUILTIN_TOOL]),
}));

// prepareMcpTools: pass the raw tools through unchanged (transform is out of scope here).
vi.mock('#src/utils/mcpUtils.js', () => ({
  prepareMcpTools: vi.fn((_cb: unknown, _config: unknown, raw: unknown[]) => raw),
}));

// OAuth: default resolves; a test drives a rejection to exercise the OAuth surfacing site.
const createAuthProviderAndAuthenticateMock = vi.fn();
vi.mock('#src/mcp/OAuthClientProviderImpl.js', () => ({
  createAuthProviderAndAuthenticate: createAuthProviderAndAuthenticateMock,
}));

/**
 * Per-server behaviour for the fake client, keyed by server name:
 *  - `fail`: invoke onConnectionError({ serverName, error }) and contribute no tools (adapter's
 *    function-form onConnectionError semantics: surface + skip, do not throw).
 *  - `requestError`: first publish it on undici's request-error channel for `origin`, as undici
 *    does before `fetch` rejects with only `fetch failed`.
 *  - otherwise: contribute the given tools (default one synthetic tool).
 */
let serverBehaviors: Record<
  string,
  { fail?: Error; requestError?: { origin: string; error: Error }; tools?: unknown[] }
> = {};

class MultiServerMCPClientStub {
  constructor(
    public _config: { mcpServers: Record<string, unknown>; onConnectionError?: unknown }
  ) {}
  getTools = async () => {
    const tools: unknown[] = [];
    for (const name of Object.keys(this._config.mcpServers)) {
      const behavior = serverBehaviors[name];
      if (behavior?.requestError) {
        const { origin, error } = behavior.requestError;
        requestErrorChannel.publish({ request: { origin }, error });
      }
      if (behavior?.fail) {
        const cb = this._config.onConnectionError as
          ((_a: { serverName: string; error: unknown }) => void) | undefined;
        cb?.({ serverName: name, error: behavior.fail });
        continue; // failed server contributes no tools
      }
      tools.push(...(behavior?.tools ?? [{ name: `mcp__${name}__tool` }]));
    }
    return tools;
  };
  getClient = async (name: string) =>
    serverBehaviors[name]?.fail ? undefined : { getInstructions: () => undefined };
  close = vi.fn().mockResolvedValue(undefined);
}
vi.mock('@langchain/mcp-adapters', () => ({
  MultiServerMCPClient: MultiServerMCPClientStub,
}));

function makeConfig(mcpServers: Record<string, unknown>): GthConfig {
  return { llm: {}, mcpServers } as unknown as GthConfig;
}

function toolNames(tools: unknown[]): string[] {
  return tools.map((t) => (t as { name: string }).name);
}

describe('resolveTools MCP auth surfacing (EXT-31)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverBehaviors = {};
  });

  it('surfaces (not swallows) a named re-auth warning when a server fails with an auth error', async () => {
    serverBehaviors = {
      jira: {
        fail: new Error(
          'Authentication failed for HTTP server "jira" at https://jira.example/mcp. Original error: HTTP 401'
        ),
      },
    };

    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    await resolvers.resolveTools!(makeConfig({ jira: { url: 'https://jira.example/mcp' } }));

    // Assert on the SURFACED MESSAGE, not merely that nothing threw.
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const surfaced = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    expect(surfaced).toContain('"jira"');
    expect(surfaced).toContain('authentication failed');
    expect(surfaced).toContain('expired or invalid');
    expect(surfaced).toContain('re-authenticate');
    expect(surfaced).toContain('mcpServers in your gth config');
  });

  it('does not misclassify: non-auth transient is surfaced without re-auth; never-configured is silent', async () => {
    // (a) generic transient connect error → surfaced, but NOT as an auth/re-auth problem.
    serverBehaviors = {
      flaky: {
        fail: new Error('Failed to connect to streamable HTTP server "flaky": ECONNREFUSED'),
      },
    };
    const { createResolvers } = await import('#src/resolvers.js');
    let resolvers = createResolvers();
    await resolvers.resolveTools!(makeConfig({ flaky: { url: 'https://flaky.example/mcp' } }));

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const surfaced = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    expect(surfaced).toContain('"flaky"');
    expect(surfaced).toContain('not an authentication error');
    expect(surfaced).not.toContain('re-authenticate');
    expect(surfaced).not.toContain('expired or invalid');

    // (b) never configured → no MCP client, no spurious auth warning at all.
    consoleUtilsMock.displayWarning.mockClear();
    resolvers = createResolvers();
    await resolvers.resolveTools!(makeConfig({}));
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  // EXT-207: the adapter rebuilds the connect error from its text, so the TLS cause reaches the
  // warning only through the request errors captured while the tools load.
  it('names the network error captured for the failed server, and only for its origin', async () => {
    const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    const otherError = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    serverBehaviors = {
      other: { requestError: { origin: 'https://other.example', error: otherError } },
      internal: {
        requestError: { origin: 'https://internal.example', error: tlsError },
        fail: new Error('Failed to connect to streamable HTTP server "internal": fetch failed'),
      },
      unrelated: {
        fail: new Error('Failed to connect to streamable HTTP server "unrelated": fetch failed'),
      },
    };

    const { createResolvers } = await import('#src/resolvers.js');
    await createResolvers().resolveTools!(
      makeConfig({
        other: { url: 'https://other.example/mcp' },
        internal: { url: 'https://internal.example/mcp' },
        unrelated: { url: 'https://unrelated.example/mcp' },
      })
    );

    const warnings = consoleUtilsMock.displayWarning.mock.calls.map((c) => c[0] as string);
    const internal = warnings.find((w) => w.includes('"internal"'));
    const unrelated = warnings.find((w) => w.includes('"unrelated"'));
    expect(internal).toContain(
      'Caused by: SELF_SIGNED_CERT_IN_CHAIN (self-signed certificate in certificate chain)'
    );
    expect(unrelated).toBeDefined();
    expect(unrelated).not.toContain('Caused by');
    // The capture is released once the tools have loaded.
    expect(requestErrorChannel.hasSubscribers).toBe(false);
  });

  it('surfaces an AUTH message for a keyword-less OAuth handshake failure (not "not an auth error")', async () => {
    // createAuthProviderAndAuthenticate throws BEFORE the MCP client exists, so this exercises the
    // OAuth catch site, not the onConnectionError callback. A keyword-less error (canonical
    // invalid_grant/expired refresh token surfaced with no auth wording) must still read as auth.
    createAuthProviderAndAuthenticateMock.mockRejectedValueOnce(
      new Error('token endpoint returned status the client could not use')
    );

    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    await resolvers.resolveTools!(
      makeConfig({ jira: { url: 'https://jira.example/mcp', authProvider: 'OAuth' } })
    );

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const surfaced = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    expect(surfaced).toContain('"jira"');
    expect(surfaced).toContain('expired or invalid');
    expect(surfaced).toContain('re-authenticate');
    expect(surfaced).toContain('OAuth login flow');
    expect(surfaced).not.toContain('not an authentication error');
  });

  it('degrades gracefully: one server auth failure keeps the healthy server and built-in tools', async () => {
    serverBehaviors = {
      jira: { fail: new Error('HTTP 401 Unauthorized: token expired') },
      github: { tools: [{ name: 'mcp__github__search' }] },
    };

    const { createResolvers } = await import('#src/resolvers.js');
    const resolvers = createResolvers();
    const tools = await resolvers.resolveTools!(
      makeConfig({
        jira: { url: 'https://jira.example/mcp' },
        github: { url: 'https://github.example/mcp' },
      })
    );

    const names = toolNames(tools);
    // Healthy server's tools survive the sibling's auth failure...
    expect(names).toContain('mcp__github__search');
    // ...and built-in tools are untouched...
    expect(names).toContain('builtin__read');
    // ...while the failed integration contributes nothing.
    expect(names).not.toContain('mcp__jira__tool');
    // The failure was still surfaced (named), and resolveTools did not throw.
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    expect(consoleUtilsMock.displayWarning.mock.calls[0][0]).toContain('"jira"');
  });
});
