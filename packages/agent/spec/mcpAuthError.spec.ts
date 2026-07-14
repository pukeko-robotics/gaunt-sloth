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
