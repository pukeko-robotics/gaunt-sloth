import {
  auth,
  type FetchLike,
  type OAuthClientInformationFull,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import express from 'express';
import * as crypto from 'node:crypto';
import { platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AddressInfo } from 'net';
import { displayInfo } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { StreamableHTTPConnection } from '@langchain/mcp-adapters';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { getOAuthStoragePath } from '@gaunt-sloth/core/utils/globalConfigUtils.js';
import http from 'http';

interface OAuthClientProviderConfig {
  redirectUrl: string;
  serverUrl: string;
}

interface OAuthStorageData {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationFull;
}

/**
 * Please note most of these "unused" methods are part of `OAuthClientProvider`
 */
export class OAuthClientProviderImpl implements OAuthClientProvider {
  private config: OAuthClientProviderConfig;
  private innerState: string;
  private storagePath: string;
  private storageCache?: OAuthStorageData;

  constructor(config: OAuthClientProviderConfig) {
    this.config = config as OAuthClientProviderConfig;
    this.innerState = crypto.randomUUID();
    if (!this.config.redirectUrl) {
      throw new Error('No redirect URL provided');
    }
    if (!this.config.serverUrl) {
      throw new Error('No server URL provided');
    }
    this.storagePath = getOAuthStoragePath(this.config.serverUrl);
  }

  private loadStorageData(): OAuthStorageData {
    // Return cached data if available
    if (this.storageCache !== undefined) {
      return this.storageCache;
    }

    // Read from file if cache is empty
    if (existsSync(this.storagePath)) {
      try {
        const data = readFileSync(this.storagePath, 'utf-8');
        const parsedData: OAuthStorageData = JSON.parse(data);

        // Wipe data if the in-memory cache is empty and file info is missing tokens
        if (parsedData.clientInformation && !parsedData.tokens) {
          try {
            unlinkSync(this.storagePath);
            displayInfo('Deleted OAuth storage file (missing tokens)');
            this.storageCache = {};
            return this.storageCache;
          } catch (error) {
            displayInfo('Failed to delete OAuth storage file: ' + error);
          }
        }

        // Cache the loaded data
        this.storageCache = parsedData;
        return parsedData;
      } catch (error) {
        displayInfo('Failed to load OAuth storage data: ' + error);
        this.storageCache = {};
        return this.storageCache;
      }
    }

    // No file exists, cache empty object
    this.storageCache = {};
    return this.storageCache;
  }

  private saveStorageData(data: OAuthStorageData): void {
    try {
      writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf-8');
      // Update the cache when saving
      this.storageCache = data;
    } catch (error) {
      console.error('Failed to save OAuth storage data:', error);
    }
  }

  state(): string | Promise<string> {
    return this.innerState;
  }

  // noinspection JSUnusedGlobalSymbols
  get redirectUrl() {
    return this.config.redirectUrl;
  }

  // noinspection JSUnusedGlobalSymbols
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.config.redirectUrl],
      client_name: 'Gaunt Sloth',
      client_uri: 'https://gauntsloth.app/',
      software_id: '1dd38b83-946b-4631-8855-66ee467bfd68',
      scope: 'mcp:read mcp:write',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /** Stores the client registration in this server's OAuth storage file. */
  // noinspection JSUnusedGlobalSymbols
  saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    const data = this.loadStorageData();
    data.clientInformation = clientInformation;
    this.saveStorageData(data);
    return Promise.resolve();
  }

  /** Returns the client registration stored for this server, if there is one. */
  // noinspection JSUnusedGlobalSymbols
  async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
    const data = this.loadStorageData();
    return Promise.resolve(data.clientInformation);
  }

  /** Stores the tokens, unchanged, in this server's OAuth storage file. */
  // noinspection JSUnusedGlobalSymbols
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = this.loadStorageData();
    data.tokens = tokens;
    this.saveStorageData(data);
  }

  // noinspection JSUnusedGlobalSymbols
  tokens(): OAuthTokens | undefined {
    const data = this.loadStorageData();
    return data.tokens;
  }

  // noinspection JSUnusedGlobalSymbols
  saveCodeVerifier(codeVerifier: string): Promise<void> {
    const data = this.loadStorageData();
    data.codeVerifier = codeVerifier;
    this.saveStorageData(data);
    return Promise.resolve();
  }

  // noinspection JSUnusedGlobalSymbols
  codeVerifier(): Promise<string> {
    const data = this.loadStorageData();
    if (!data.codeVerifier) {
      throw new Error('No code verifier stored');
    }
    return Promise.resolve(data.codeVerifier);
  }

  /**
   * Called by the MCP client's `auth()` when the authorization server rejects what is stored (a
   * revoked or expired refresh token, an unknown client), so its retry starts a fresh browser login
   * instead of reusing the dead credentials. Each scope clears exactly its part of this server's
   * storage file: `all` removes the file, `client` the registration, `tokens` the tokens, `verifier`
   * the PKCE code verifier. `discovery` is a no-op, because this provider stores no discovery state.
   */
  // noinspection JSUnusedGlobalSymbols
  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> {
    if (scope === 'discovery') {
      return Promise.resolve();
    }
    if (scope === 'all') {
      this.storageCache = {};
      try {
        if (existsSync(this.storagePath)) {
          unlinkSync(this.storagePath);
        }
      } catch (error) {
        displayInfo('Failed to delete OAuth storage file: ' + error);
      }
      return Promise.resolve();
    }
    const data = this.loadStorageData();
    if (scope === 'client') {
      delete data.clientInformation;
    } else if (scope === 'tokens') {
      delete data.tokens;
    } else if (scope === 'verifier') {
      delete data.codeVerifier;
    }
    this.saveStorageData(data);
    return Promise.resolve();
  }

  // noinspection JSUnusedGlobalSymbols
  async redirectToAuthorization(authUrl: URL): Promise<void> {
    displayInfo('Auth url: ' + authUrl.toString());
    try {
      const url = authUrl.toString();
      displayInfo('Trying to open browser');

      // Handle different platforms
      const platformName = platform();
      if (platformName === 'win32') {
        // Windows - 'start' is a cmd.exe built-in, so we must invoke it via cmd
        spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      } else if (platformName === 'darwin') {
        // macOS
        spawnSync('open', [url], { stdio: 'ignore' });
      } else {
        // Linux and others
        spawnSync('xdg-open', [url], { stdio: 'ignore' });
      }
    } catch (error) {
      displayInfo(`Failed to open browser: ${error}`);
      displayInfo(`Please open ${authUrl.toString()} in your browser`);
    }
  }
}

/** How long to wait for the user to finish the browser login before giving up. */
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Fetch for the OAuth calls that asks for an uncompressed body. The Atlassian token endpoint
 * (`auth.atlassian.com/oauth/token`) has been observed returning a gzipped body that reaches the
 * SDK still compressed, so its JSON parse fails and every token exchange and refresh is lost.
 * OAuth responses are small, so declining compression costs nothing.
 */
const oauthFetch: FetchLike = (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set('accept-encoding', 'identity');
  return fetch(url, { ...init, headers });
};

export async function createAuthProviderAndAuthenticate(
  mcpServer: StreamableHTTPConnection,
  callbackTimeoutMs: number = OAUTH_CALLBACK_TIMEOUT_MS
): Promise<OAuthClientProviderImpl> {
  const { port, server, callbackPromise } = await createOAuthRedirectServer('/oauth/callback');
  // The listening callback server keeps the process alive, so it is closed on every exit path.
  try {
    const authProvider = new OAuthClientProviderImpl({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      serverUrl: mcpServer.url,
    });
    const outcome = await auth(authProvider, { serverUrl: mcpServer.url, fetchFn: oauthFetch });
    if (outcome == 'REDIRECT') {
      const callback = await withTimeout(
        callbackPromise,
        callbackTimeoutMs,
        `OAuth login for ${mcpServer.url} was not completed within ${Math.round(callbackTimeoutMs / 1000)}s`
      );
      // The callback's `iss` goes to the SDK as received: it checks it against the authorization
      // server's issuer (RFC 9207) before redeeming the code, and refuses a server that advertises
      // the parameter when it is missing.
      await auth(authProvider, {
        serverUrl: mcpServer.url,
        authorizationCode: callback.code,
        iss: callback.iss,
        fetchFn: oauthFetch,
      });
    } else if (outcome == 'AUTHORIZED') {
      displayInfo('Authorized');
    } else {
      throw new Error(`Unexpected Auth outcome: ${outcome}`);
    }
    return authProvider;
  } finally {
    closeQuietly(server);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function closeQuietly(server: http.Server): void {
  if (!server.listening) {
    return;
  }
  try {
    server.close();
  } catch {}
}

/** What the authorization server sent back to the redirect URL. */
export interface OAuthCallback {
  code: string;
  /** The RFC 9207 `iss` parameter, when the authorization server sent one. */
  iss?: string;
}

export function createOAuthRedirectServer(
  path: string,
  portParam: number = 0
): Promise<{
  port: number;
  server: http.Server;
  callbackPromise: Promise<OAuthCallback>;
}> {
  const redirectApp = express();
  return new Promise((resolve, reject) => {
    const callbackPromise = new Promise<OAuthCallback>((resolveCode, rejectCode) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      redirectApp.get(path, (req: any, res: any) => {
        const code = req.query.code as string | undefined;
        const iss = typeof req.query.iss === 'string' ? req.query.iss : undefined;
        if (!code) {
          res.status(400).send('Error: No auth code received');
          rejectCode('Error: No auth code received');
          return;
        }
        res.send(`<div style="height: 80vh;text-align: center;display: flex;justify-content: center;align-items: center;">
            <div>
                <h1>Auth successful!</h1>
                You may close this window and return to the Gaunt Sloth.
                <div>
                    <img src="data:image/bmp;base64,Qk02AwAAAAAAADYAAAAoAAAAEAAAABAAAAABABgAAAAAAAADAAAAAAAAAAAAAAAAAAAAAAAAnD98ZBtDTQ8sey9YOQobRA8nZx9OdyxahzZrMwERdCtShjZqLQUVLwgZKwUWKQYXsFCRq06KciJPnEh/n0GEmjuClDl9lzl/uFGglz56dChOm0h0SBInLgQVKwgZKgUVgzZchDRfqEeLsUmavFWjvV6joEGFizFvsU+Yw2CowWCiu1qdbCRNKgEQMAofMAcebSRIgC9bt1KdqEqNnD6BokGJqEaOvVmjqEWMu12ftFeYwGCjpUOMUxc8KQIRLAQWhjVmo0qGs1CYqEmOqEmPmjyArk2UrEyQr02TsU2WwV6pvF2eo0CKlDl+OgsiJwQSijZthS9qnDuAo0GFqESMmz2BijZtpUOLnT2CuVicyWmtsVCUjDh0p0KQbiVYJAQSkzx3kzZ7iS5rv2mn3Y3Gq0+Pgi1laCFOfyxmmTx/slCVmT55eihemzyGjTd6NwgfgSxokzl9qkuY4pLR+Lvg1H3EjTRzZB1IjTV3cCNWmjmAgC1diCxpjC1ulDd8RhAtdihbljl/vmK1v2WuuWGgtVWdjDVwgS5ldCVZcydckjl5kzh3ynGwxHOooT6DSA8sQQwkpUeTyGrBlTp8eCNZkzh1rEeSmDx9ZB9JcyNYkzh2tlek5pjT8q3bqU2PPQokJgEPhTVxy2nBkDd6kDV2qEaOwGOvvWGxuViqoUSNlDd6nj6FvmKq13zKnkiJMgUZKwUWPg4poUaOkzp+kTh7nkCExG60033Jym7C03zKsVOdiC9tjjR10W7IeThrKAAOMAUYJgUULgUZdCZdqkqYu1ersk+fvFyww2q4z3fDqUmXhy5ulTp/yWi/Txo6JgEPLgYZLQUXKQUVJwkaSxExq1GTxWW3t1SpsU+gv1mvnUOLjTJ3izh3dTRkJwEQKgQWLQYaLAgcLQUYLQYZLAERezZaiTtmXyFJgjp0ijt1iTlqOAsjNQ0pKQASJwUVKQYYLgUZLAQZLAgcLgUZMAUYZyVRfCthPQoiIQAJOgcgYyBLKAIRLAUZNwsoMQcfKAQV"
                         width="16" height="16">
                </div>
            </div>
        </div>`);
        resolveCode({ code, iss });
        if (server) {
          displayInfo('Cleaning auth redirect server...');
          server.close();
        }
      });
    });

    const server = redirectApp.listen(portParam, () => {
      const addressInfo = server.address() as AddressInfo;
      const port = addressInfo.port;
      displayInfo(`OAuth callback server listening at ${port}`);
      resolve({ port, server, callbackPromise });
    });

    server.on('error', (err) => {
      // If the server fails to start, reject the outer promise.
      reject(err);
    });
  });
}
