import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { StreamableHTTPConnection } from '@langchain/mcp-adapters';

const displayInfoMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayInfo: displayInfoMock,
}));

const getOAuthStoragePathMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/globalConfigUtils.js', () => ({
  getOAuthStoragePath: getOAuthStoragePathMock,
}));

const authMock = vi.fn();
vi.mock('@modelcontextprotocol/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/client')>()),
  auth: authMock,
}));

const server = { url: 'https://mcp.example.com/v2/mcp' } as StreamableHTTPConnection;

describe('createAuthProviderAndAuthenticate', () => {
  let closeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    getOAuthStoragePathMock.mockReturnValue('/nonexistent/gsloth-oauth-spec.json');
    closeSpy = vi.spyOn(http.Server.prototype, 'close');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for an uncompressed body on every OAuth request', async () => {
    authMock.mockResolvedValue('AUTHORIZED');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const { createAuthProviderAndAuthenticate } =
      await import('#src/mcp/OAuthClientProviderImpl.js');

    await createAuthProviderAndAuthenticate(server);

    const { fetchFn } = authMock.mock.calls[0][1];
    await fetchFn('https://auth.example.com/oauth/token', {
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    const sentHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(sentHeaders.get('accept-encoding')).toBe('identity');
    expect(sentHeaders.get('accept')).toBe('application/json');
  });

  it('closes the callback server when authorization succeeds without a login', async () => {
    authMock.mockResolvedValue('AUTHORIZED');
    const { createAuthProviderAndAuthenticate } =
      await import('#src/mcp/OAuthClientProviderImpl.js');

    await createAuthProviderAndAuthenticate(server);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the callback server when authorization throws', async () => {
    authMock.mockRejectedValue(new Error('token exchange failed'));
    const { createAuthProviderAndAuthenticate } =
      await import('#src/mcp/OAuthClientProviderImpl.js');

    await expect(createAuthProviderAndAuthenticate(server)).rejects.toThrow(
      'token exchange failed'
    );

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up and closes the callback server when the login is never completed', async () => {
    authMock.mockResolvedValue('REDIRECT');
    const { createAuthProviderAndAuthenticate } =
      await import('#src/mcp/OAuthClientProviderImpl.js');

    await expect(createAuthProviderAndAuthenticate(server, 20)).rejects.toThrow(
      'was not completed within'
    );

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
