import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const displayInfoMock = vi.fn();
const displayWarningMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', () => ({
  displayInfo: displayInfoMock,
  displayWarning: displayWarningMock,
}));

// The provider's browser opener: mocked so no browser is ever launched.
const spawnSyncMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

// Storage is never the real ~/.gsloth/.gsloth-auth: every spec points it at its own temp dir.
const getOAuthStoragePathMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/globalConfigUtils.js', () => ({
  getOAuthStoragePath: getOAuthStoragePathMock,
}));

type RefreshAnswer = 'unauthorized_client' | 'invalid_grant' | 'ok';

interface StubAuthServer {
  origin: string;
  requests: { method: string; path: string; grantType?: string }[];
  setRefreshAnswer: (answer: RefreshAnswer) => void;
  close: () => Promise<void>;
}

/**
 * One loopback server playing both the MCP resource and its authorization server. It publishes no
 * protected-resource metadata, so the SDK falls back to the origin as the authorization server,
 * serves RFC 8414 metadata, dynamic registration, and a token endpoint whose refresh grant answers
 * as told. Its MCP endpoint answers every request 401, as a resource does once the access token is
 * no longer accepted.
 */
async function startStubAuthServer(initialRefreshAnswer: RefreshAnswer): Promise<StubAuthServer> {
  let refreshAnswer = initialRefreshAnswer;
  const requests: StubAuthServer['requests'] = [];
  let origin = '';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', origin).pathname;
      const body = Buffer.concat(chunks).toString('utf-8');
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        requests.push({ method: 'GET', path });
        json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (req.method === 'POST' && path === '/register') {
        requests.push({ method: 'POST', path });
        json(201, { ...JSON.parse(body), client_id: 'fresh-client' });
        return;
      }
      if (req.method === 'POST' && path === '/token') {
        const grantType = new URLSearchParams(body).get('grant_type') ?? undefined;
        requests.push({ method: 'POST', path, grantType });
        if (grantType !== 'refresh_token') {
          json(400, { error: 'unsupported_grant_type', error_description: 'stub' });
        } else if (refreshAnswer === 'ok') {
          json(200, { access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 });
        } else {
          json(400, { error: refreshAnswer, error_description: 'refresh_token is invalid' });
        }
        return;
      }
      requests.push({ method: req.method ?? 'GET', path });
      if (path === '/mcp') {
        json(401, {});
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    setRefreshAnswer: (answer) => {
      refreshAnswer = answer;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const REDIRECT_URL = 'http://localhost:1/oauth/callback';

let storageDir: string;
let storagePath: string;
let stub: StubAuthServer | undefined;

function readStorage(): Record<string, unknown> {
  // Read the file directly: a second provider's cold load would wipe a file holding a
  // registration without tokens.
  return JSON.parse(readFileSync(storagePath, 'utf-8'));
}

function seedStorage(issuer: string, registeredRedirectUrl: string = REDIRECT_URL) {
  writeFileSync(
    storagePath,
    JSON.stringify({
      clientInformation: {
        client_id: 'seeded-client',
        redirect_uris: [registeredRedirectUrl],
        token_endpoint_auth_method: 'none',
        issuer,
      },
      tokens: {
        access_token: 'old-access',
        token_type: 'Bearer',
        refresh_token: 'old-refresh',
        issuer,
      },
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  storageDir = mkdtempSync(join(tmpdir(), 'gsloth-ext213-'));
  storagePath = join(storageDir, 'server.json');
  getOAuthStoragePathMock.mockReturnValue(storagePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stub?.close();
  stub = undefined;
  rmSync(storageDir, { recursive: true, force: true });
});

describe('OAuthClientProviderImpl recovery through the real auth()', () => {
  async function runAuth(refreshAnswer: RefreshAnswer, registeredRedirectUrl?: string) {
    stub = await startStubAuthServer(refreshAnswer);
    seedStorage(stub.origin, registeredRedirectUrl);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { auth } = await import('@modelcontextprotocol/client');
    const { OAuthClientProviderImpl } = await import('#src/mcp/OAuthClientProviderImpl.js');
    const provider = new OAuthClientProviderImpl({
      redirectUrl: REDIRECT_URL,
      serverUrl: `${stub.origin}/mcp`,
    });
    // Stands in for the browser, so no browser opens.
    const redirectSpy = vi.spyOn(provider, 'redirectToAuthorization').mockResolvedValue();
    const outcome = await auth(provider, { serverUrl: `${stub.origin}/mcp` });
    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    return { outcome, redirectSpy, warnings, stub };
  }

  it('re-registers and reaches the browser login when the refresh is answered unauthorized_client', async () => {
    const { outcome, redirectSpy, warnings, stub } = await runAuth('unauthorized_client');

    expect(outcome).toBe('REDIRECT');
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes('invalidating the stored'))).toBe(true);
    expect(stub.requests.filter((r) => r.path === '/register')).toHaveLength(1);

    const stored = readStorage();
    expect(stored.tokens).toBeUndefined();
    expect((stored.clientInformation as { client_id: string }).client_id).toBe('fresh-client');
    expect(typeof stored.codeVerifier).toBe('string');
    const authUrl = redirectSpy.mock.calls[0][0] as URL;
    expect(authUrl.searchParams.get('client_id')).toBe('fresh-client');
  });

  it('keeps the registration and reaches the browser login when the refresh is answered invalid_grant', async () => {
    const { outcome, redirectSpy, warnings, stub } = await runAuth('invalid_grant');

    expect(outcome).toBe('REDIRECT');
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(warnings.some((w) => w.includes('invalidating the stored'))).toBe(true);
    expect(stub.requests.filter((r) => r.path === '/register')).toHaveLength(0);

    const stored = readStorage();
    expect(stored.tokens).toBeUndefined();
    expect((stored.clientInformation as { client_id: string }).client_id).toBe('seeded-client');
    expect(typeof stored.codeVerifier).toBe('string');
  });

  it('registers afresh on invalid_grant when the stored registration names another callback URL', async () => {
    const { outcome, redirectSpy, stub } = await runAuth(
      'invalid_grant',
      'http://localhost:2/oauth/callback'
    );

    expect(outcome).toBe('REDIRECT');
    expect(redirectSpy).toHaveBeenCalledTimes(1);
    expect(stub.requests.filter((r) => r.path === '/register')).toHaveLength(1);

    const stored = readStorage();
    expect(stored.tokens).toBeUndefined();
    expect(stored.clientInformation).toMatchObject({
      client_id: 'fresh-client',
      redirect_uris: [REDIRECT_URL],
    });
    const authUrl = redirectSpy.mock.calls[0][0] as URL;
    expect(authUrl.searchParams.get('client_id')).toBe('fresh-client');
  });

  it('saves the new tokens and clears nothing when the refresh succeeds', async () => {
    const { outcome, redirectSpy, warnings, stub } = await runAuth('ok');

    expect(outcome).toBe('AUTHORIZED');
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(warnings.some((w) => w.includes('invalidating the stored'))).toBe(false);
    expect(stub.requests.filter((r) => r.path === '/register')).toHaveLength(0);

    const stored = readStorage();
    expect(stored.tokens).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'old-refresh',
    });
    expect((stored.clientInformation as { client_id: string }).client_id).toBe('seeded-client');
  });
});

describe('OAuthClientProviderImpl.invalidateCredentials', () => {
  function seedFull() {
    writeFileSync(
      storagePath,
      JSON.stringify({
        clientInformation: { client_id: 'seeded-client', redirect_uris: [REDIRECT_URL] },
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
        codeVerifier: 'verifier',
      })
    );
  }

  async function makeProvider() {
    const { OAuthClientProviderImpl } = await import('#src/mcp/OAuthClientProviderImpl.js');
    return new OAuthClientProviderImpl({
      redirectUrl: REDIRECT_URL,
      serverUrl: 'https://mcp.example.com/mcp',
    });
  }

  it('tokens: removes only the tokens and keeps a registration that lists this redirect URL', async () => {
    seedFull();
    const provider = await makeProvider();

    await provider.invalidateCredentials('tokens');

    expect(provider.tokens()).toBeUndefined();
    expect((await provider.clientInformation())?.client_id).toBe('seeded-client');
    expect(readStorage()).toEqual({
      clientInformation: { client_id: 'seeded-client', redirect_uris: [REDIRECT_URL] },
      codeVerifier: 'verifier',
    });
  });

  it('tokens: also removes a registration that does not list this redirect URL', async () => {
    writeFileSync(
      storagePath,
      JSON.stringify({
        clientInformation: {
          client_id: 'seeded-client',
          redirect_uris: ['http://localhost:2/oauth/callback'],
        },
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r' },
        codeVerifier: 'verifier',
      })
    );
    const provider = await makeProvider();

    await provider.invalidateCredentials('tokens');

    expect(provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeUndefined();
    expect(readStorage()).toEqual({ codeVerifier: 'verifier' });
  });

  it('client: removes only the client registration', async () => {
    seedFull();
    const provider = await makeProvider();

    await provider.invalidateCredentials('client');

    expect(await provider.clientInformation()).toBeUndefined();
    const stored = readStorage();
    expect(stored.clientInformation).toBeUndefined();
    expect(stored.tokens).toEqual({ access_token: 'a', token_type: 'Bearer', refresh_token: 'r' });
    expect(stored.codeVerifier).toBe('verifier');
  });

  it('verifier: removes only the code verifier', async () => {
    seedFull();
    const provider = await makeProvider();

    await provider.invalidateCredentials('verifier');

    expect(() => provider.codeVerifier()).toThrow('No code verifier stored');
    const stored = readStorage();
    expect(stored.codeVerifier).toBeUndefined();
    expect(stored.tokens).toBeDefined();
    expect(stored.clientInformation).toBeDefined();
  });

  it('discovery: changes nothing, since no discovery state is stored', async () => {
    seedFull();
    const before = readFileSync(storagePath, 'utf-8');
    const provider = await makeProvider();

    await provider.invalidateCredentials('discovery');

    expect(readFileSync(storagePath, 'utf-8')).toBe(before);
    expect(provider.tokens()).toBeDefined();
  });

  it('all: removes the whole storage entry, on disk and in memory', async () => {
    seedFull();
    const provider = await makeProvider();
    expect(provider.tokens()).toBeDefined(); // warm the cache first

    await provider.invalidateCredentials('all');

    expect(existsSync(storagePath)).toBe(false);
    expect(provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation()).toBeUndefined();
  });
});

describe('OAuthClientProviderImpl after the startup handshake', () => {
  /** Runs the startup handshake the way the MCP resolver does, against the stub. */
  async function handshake(callbackTimeoutMs = 5_000) {
    const { createAuthProviderAndAuthenticate } =
      await import('#src/mcp/OAuthClientProviderImpl.js');
    return createAuthProviderAndAuthenticate(
      { url: `${stub!.origin}/mcp` } as Parameters<typeof createAuthProviderAndAuthenticate>[0],
      callbackTimeoutMs
    );
  }

  it('control: a refresh rejected during the startup handshake still opens the browser login', async () => {
    stub = await startStubAuthServer('invalid_grant');
    seedStorage(stub.origin);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Nobody completes the login, so the handshake gives up after its (short) callback timeout.
    await expect(handshake(200)).rejects.toThrow('was not completed');

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const openerArgs = spawnSyncMock.mock.calls[0][1] as string[];
    expect(openerArgs.some((arg) => arg.startsWith(`${stub!.origin}/authorize?`))).toBe(true);
    expect(displayWarningMock).not.toHaveBeenCalled();
  });

  describe.each(['unauthorized_client', 'invalid_grant'] as const)(
    'mid-session refresh answered %s',
    (refreshError) => {
      it('opens no browser and tells the user the sign-in reopens on the next start', async () => {
        stub = await startStubAuthServer('ok');
        seedStorage(stub.origin);
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const provider = await handshake();
        expect(stub.requests.filter((r) => r.grantType === 'refresh_token')).toHaveLength(1);
        expect(spawnSyncMock).not.toHaveBeenCalled();

        // Later in the session the resource rejects the access token and the refresh token has
        // been revoked: the transport's 401 handler runs the full auth() with this provider.
        stub.setRefreshAnswer(refreshError);
        const { Client, StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/client');
        const transport = new StreamableHTTPClientTransport(new URL(`${stub.origin}/mcp`), {
          authProvider: provider,
        });
        const client = new Client({ name: 'ext213-spec', version: '0' });
        await expect(client.connect(transport)).rejects.toBeDefined();

        expect(stub.requests.filter((r) => r.grantType === 'refresh_token')).toHaveLength(2);
        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(displayWarningMock).toHaveBeenCalledTimes(1);
        const message = displayWarningMock.mock.calls[0][0] as string;
        expect(message).toContain(`${stub.origin}/mcp`);
        expect(message).toContain('expired or was revoked');
        expect(message).toContain('next start');
        expect(readStorage().tokens).toBeUndefined();
      });

      it('warns once however many later requests are refused', async () => {
        stub = await startStubAuthServer('ok');
        seedStorage(stub.origin);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const provider = await handshake();
        // Calls through to the real method, so the guard runs.
        const redirectSpy = vi.spyOn(provider, 'redirectToAuthorization');
        stub.setRefreshAnswer(refreshError);
        const { Client, StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/client');

        for (let attempt = 0; attempt < 3; attempt++) {
          const transport = new StreamableHTTPClientTransport(new URL(`${stub.origin}/mcp`), {
            authProvider: provider,
          });
          const client = new Client({ name: 'ext213-spec', version: '0' });
          await expect(client.connect(transport)).rejects.toBeDefined();
        }

        // Each of the three 401s reached the guard; only the first one printed.
        expect(redirectSpy).toHaveBeenCalledTimes(3);
        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(displayWarningMock).toHaveBeenCalledTimes(1);
      });
    }
  );
});
