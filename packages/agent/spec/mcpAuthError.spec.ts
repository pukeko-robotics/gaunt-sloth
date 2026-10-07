import { describe, expect, it } from 'vitest';
import {
  classifyMcpConnectError,
  formatMcpConnectFailureMessage,
} from '#src/utils/mcpAuthError.js';

/**
 * EXT-31 — the credential classifier and the surfaced-message formatter. The point of this module
 * is to tell an *expired/invalid auth* failure apart from a *generic transient* failure, so a stale
 * Jira token gets a named "re-authenticate" nudge while an unrelated network blip does not.
 */
describe('classifyMcpConnectError (EXT-31)', () => {
  it('classifies HTTP 401 (adapter-wrapped auth error) as auth', () => {
    const err = new Error(
      'Authentication failed for HTTP server "jira" at https://jira.example/mcp. Please check your credentials. Original error: HTTP 401'
    );
    expect(classifyMcpConnectError(err)).toBe('auth');
  });

  it('classifies HTTP 403 (forbidden / expired scope) as auth — the adapter does NOT', () => {
    // The adapter only tags 401; a 403 falls through to it as a generic "Failed to connect".
    const err = new Error(
      'Failed to connect to streamable HTTP server "jira": (HTTP 403) Forbidden'
    );
    expect(classifyMcpConnectError(err)).toBe('auth');
  });

  it('classifies a numeric error.code of 401 as auth', () => {
    const err = Object.assign(new Error('request failed'), { code: 401 });
    expect(classifyMcpConnectError(err)).toBe('auth');
  });

  it.each([
    'Unauthorized',
    'Error: token has expired, please re-authenticate',
    'Invalid token supplied',
    'invalid credentials',
    'Access denied',
    '403 Forbidden',
  ])('classifies credential phrasing as auth: %s', (msg) => {
    expect(classifyMcpConnectError(new Error(msg))).toBe('auth');
  });

  it.each([
    'invalid_grant', // expired/revoked OAuth refresh token
    'invalid_token',
    'unauthorized_client',
    'OAuth authorization failed',
    'oauth_error: consent revoked',
  ])('classifies OAuth error codes/phrasing as auth: %s', (msg) => {
    expect(classifyMcpConnectError(new Error(msg))).toBe('auth');
  });

  it.each([
    'Failed to connect to streamable HTTP server "jira": ECONNREFUSED',
    'connect ETIMEDOUT 10.0.0.1:443',
    'getaddrinfo ENOTFOUND jira.example',
    'Failed to connect: (HTTP 500) Internal Server Error',
    'socket hang up',
  ])('classifies non-credential failures as other: %s', (msg) => {
    expect(classifyMcpConnectError(new Error(msg))).toBe('other');
  });

  it('does not treat a bare "401" number without HTTP/status context as auth', () => {
    // Guards the "never configured" / unrelated-transient side: a 401-byte body etc. is not auth.
    expect(classifyMcpConnectError(new Error('read 401 bytes then the stream closed'))).toBe(
      'other'
    );
  });
});

describe('formatMcpConnectFailureMessage (EXT-31)', () => {
  const authErr = new Error('HTTP 401 Unauthorized');
  const netErr = new Error('ECONNREFUSED');

  it('auth message names the integration, states expired/invalid, and suggests re-auth + config', () => {
    const msg = formatMcpConnectFailureMessage('jira', authErr);
    expect(msg).toContain('"jira"');
    expect(msg).toContain('authentication failed');
    expect(msg).toContain('expired or invalid');
    expect(msg).toContain('re-authenticate');
    expect(msg).toContain('mcpServers in your gth config');
    expect(msg).toContain('apiKeyEnvironmentVariable');
  });

  it('oauth auth message suggests the OAuth login flow instead of an API token', () => {
    const msg = formatMcpConnectFailureMessage('jira', authErr, { oauth: true });
    expect(msg).toContain('OAuth login flow');
    expect(msg).not.toContain('apiKeyEnvironmentVariable');
  });

  it('forces the AUTH message on the oauth path even when the error text has no auth keywords', () => {
    // An OAuth handshake/refresh throw is an auth failure by construction, regardless of message.
    const keywordless = new Error('request to token endpoint returned a bad response');
    expect(classifyMcpConnectError(keywordless)).toBe('other'); // classifier alone would miss it
    const msg = formatMcpConnectFailureMessage('jira', keywordless, { oauth: true });
    expect(msg).toContain('"jira"');
    expect(msg).toContain('expired or invalid');
    expect(msg).toContain('re-authenticate');
    expect(msg).toContain('OAuth login flow');
    expect(msg).not.toContain('not an authentication error');
  });

  it('non-auth message says explicitly it is NOT an auth error and does not nudge re-auth', () => {
    const msg = formatMcpConnectFailureMessage('jira', netErr);
    expect(msg).toContain('"jira"');
    expect(msg).toContain('not an authentication error');
    expect(msg).not.toContain('re-authenticate');
    expect(msg).not.toContain('expired or invalid');
    expect(msg).toContain('ECONNREFUSED');
  });

  it('avoids AI em/en dashes in user-facing copy', () => {
    const msg = formatMcpConnectFailureMessage('jira', authErr);
    expect(msg).not.toMatch(/[—–]/);
    expect(msg).not.toMatch(/ - /);
  });
});

describe('formatMcpConnectFailureMessage causes', () => {
  const tlsError = Object.assign(new Error('self-signed certificate in certificate chain'), {
    code: 'SELF_SIGNED_CERT_IN_CHAIN',
  });

  it('names each cause in the error chain, with its code', () => {
    const fetchFailed = new TypeError('fetch failed', { cause: tlsError });
    const msg = formatMcpConnectFailureMessage('unimarket', fetchFailed);
    expect(msg).toContain(
      'Underlying error: fetch failed. Caused by: SELF_SIGNED_CERT_IN_CHAIN ' +
        '(self-signed certificate in certificate chain)'
    );
  });

  it('does not repeat a code the message already names', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4000'), {
      code: 'ECONNREFUSED',
    });
    const msg = formatMcpConnectFailureMessage('unimarket', new TypeError('fetch failed'), {
      cause: refused,
    });
    expect(msg).toContain('Caused by: connect ECONNREFUSED 127.0.0.1:4000');
    expect(msg).not.toContain('ECONNREFUSED (');
  });

  it('uses the given cause when the error carries none', () => {
    const adapterError = new Error(
      'Failed to connect to streamable HTTP server: TypeError: fetch failed'
    );
    const msg = formatMcpConnectFailureMessage('unimarket', adapterError, { cause: tlsError });
    expect(msg).toContain('Caused by: SELF_SIGNED_CERT_IN_CHAIN');
  });

  it("prefers the error's own cause over the given one", () => {
    const own = new Error('fetch failed', { cause: new Error('socket hang up') });
    const msg = formatMcpConnectFailureMessage('unimarket', own, { cause: tlsError });
    expect(msg).toContain('Caused by: socket hang up');
    expect(msg).not.toContain('SELF_SIGNED_CERT_IN_CHAIN');
  });

  it('stops at a cycle in the cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(formatMcpConnectFailureMessage('unimarket', a)).toContain('Caused by: b');
  });

  it('adds nothing when there is no cause', () => {
    expect(formatMcpConnectFailureMessage('unimarket', new Error('boom'))).not.toContain(
      'Caused by'
    );
  });
});
