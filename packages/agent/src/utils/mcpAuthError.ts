/**
 * @packageDocumentation
 * EXT-31 — classify and format MCP integration connect/tool-load failures so an expired or invalid
 * credential is SURFACED (named + actionable) instead of silently dropping the integration's tools.
 *
 * The `@langchain/mcp-adapters` client only tags a bare HTTP 401 as an authentication error; a 403
 * (forbidden / expired scope) otherwise falls through as a generic "Failed to connect". This module
 * classifies auth failures independently (401/403 + credential keywords) so a stale token is not
 * mistaken for "this integration was never configured" or an unrelated transient error.
 *
 * Pure + side-effect free: callers do the surfacing (`displayWarning`) with the returned message.
 */

/** Coarse classification of an MCP connect/tool-load failure. */
export type McpConnectErrorKind =
  | 'auth' // credentials expired/invalid/refused (401/403, "Unauthorized", "token expired", …)
  | 'other'; // network/timeout/protocol/5xx — real failure, but NOT a credential problem

/** Options that tune the suggested fix path in the surfaced message. */
export interface McpConnectFailureOptions {
  /** The server uses OAuth (`authProvider: 'OAuth'`) — suggest re-running the OAuth login. */
  oauth?: boolean;
}

/** Extract a readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return String((error as { message?: unknown })?.message ?? error);
  } catch {
    return String(error);
  }
}

/** Read a numeric HTTP status from an error object or a `(HTTP NNN)` / `HTTP NNN` / `status NNN` message. */
function httpStatusOf(error: unknown, message: string): number | undefined {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d{3}$/.test(code)) return parseInt(code, 10);
  // Only treat 4xx/5xx numbers as a status when they carry HTTP/status context — never a bare "401"
  // substring (which could be a port, a byte count, an id, …) to avoid misclassifying transient errors.
  const m = message.match(/\b(?:HTTP|status(?:\s*code)?)[\s:]*\(?(\d{3})\)?/i);
  return m ? parseInt(m[1], 10) : undefined;
}

// Credential-failure phrasing across MCP adapter wrapping, transports, and common upstream servers.
const AUTH_KEYWORDS =
  /\b(unauthorized|forbidden|authentication failed|authenti[sc]ation (?:error|required)|authorization (?:error|failed|required)|invalid (?:token|credentials?|api[\s-]?key|authorization)|(?:token|credentials?|session|api[\s-]?key)s? (?:has |have )?(?:expired|is expired|are expired)|expired (?:token|credentials?|session)|access denied|401 unauthorized|403 forbidden)\b/i;

/**
 * Classify an MCP connect/tool-load failure as a credential problem (`auth`) or anything else
 * (`other`). Detection is independent of the adapter (which only tags 401), so a 403 or an
 * "expired token" surfaced by the upstream server is still recognised as auth.
 */
export function classifyMcpConnectError(error: unknown): McpConnectErrorKind {
  const message = errorMessage(error);
  const status = httpStatusOf(error, message);
  if (status === 401 || status === 403) return 'auth';
  if (AUTH_KEYWORDS.test(message)) return 'auth';
  return 'other';
}

/**
 * Build the user-facing message for a failed MCP integration. For `auth` failures it names the
 * integration, states the credential is expired/invalid, and points at the concrete fix path
 * (OAuth login or the API token / authorization header, plus the `mcpServers` entry in gth config).
 * For `other` failures it surfaces the failure plainly and explicitly says it is NOT an auth error,
 * so an unrelated transient never triggers a spurious "re-authenticate" nudge.
 *
 * Either way the caller degrades gracefully AFTER surfacing this — the integration's tools are
 * dropped for the session, but the user (and the log) now knows why.
 */
export function formatMcpConnectFailureMessage(
  serverName: string | undefined,
  error: unknown,
  options: McpConnectFailureOptions = {}
): string {
  const kind = classifyMcpConnectError(error);
  const name = serverName ? `"${serverName}"` : 'an MCP server';
  const configHint = serverName
    ? `check the ${name} entry under mcpServers in your gth config`
    : 'check the mcpServers entries in your gth config';

  if (kind === 'auth') {
    const reAuth = options.oauth
      ? 'complete the OAuth login flow again (clear the stored token first if needed)'
      : 'refresh its API token or key (the apiKeyEnvironmentVariable or authorization header it uses)';
    return (
      `Integration ${name} authentication failed: its credentials appear expired or invalid ` +
      `(the MCP server rejected the connection with an authorization error). Its tools are ` +
      `unavailable for this session. To restore them, re-authenticate this integration: ` +
      `${reAuth} and ${configHint}, then restart.`
    );
  }

  return (
    `Integration ${name} could not connect to its MCP server (this is not an authentication ` +
    `error). Its tools are unavailable for this session. Underlying error: ${errorMessage(error)}`
  );
}
