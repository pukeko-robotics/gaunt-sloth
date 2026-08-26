/**
 * BATCH-13 — live authorization MCP server for the `gth eval` identity-matrix integration suite.
 *
 * A real HTTP (Streamable) MCP server built on the official `@modelcontextprotocol/sdk`. It maps a
 * per-request `Authorization: Bearer <token>` to one of three identities and enforces two distinct
 * authorization mechanisms so the eval matrix can assert each the RIGHT way (see README):
 *
 *   1. TOOL VISIBILITY — a tool an identity may not use is simply absent from that identity's
 *      `tools/list` (HIDDEN). The eval asserts `must_not_call` for these (the tool literally cannot
 *      appear in the trace).
 *   2. SERVER-SIDE DENIAL — `delete_order` is VISIBLE to everyone but the server returns an
 *      authorization error for non-admin callers. The agent WILL call it, so the eval must NOT
 *      `must_not_call`; it asserts the answer (no success marker) + a judge instead.
 *   3. DATA ISOLATION — `list_my_orders` is visible to all but returns ONLY the caller's own order,
 *      so the truth ("you can't see other users' orders") comes from the server's results.
 *
 * The identity is bound at the MCP `initialize` handshake (stateful session, id per connection);
 * an unknown/absent bearer is rejected with 401 before any session is created. This is a synthetic
 * target we fully control — it validates the `gth eval` mechanism end-to-end, it does not stand in
 * for any production MCP.
 *
 * Runs directly under Node's native TypeScript type-stripping (Node >= 24): `node authz-mcp-server.ts`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// --- Identities, tokens, scopes (the shared source of truth the profile configs mirror) ----------

type IdentityName = 'admin' | 'alice' | 'bob';

interface Identity {
  name: IdentityName;
  /** Human role, echoed by `whoami` and denial messages. */
  role: string;
  /** Verbatim, paraphrase-proof identity marker for `whoami` answer assertions. */
  uid: string;
  /** Verbatim, paraphrase-proof order marker owned by this identity. */
  orderId: string;
}

/**
 * Bearer token -> identity. The profile CONFIG files carry the literal `Bearer <token>` string in
 * their `mcpServers.authz.headers.Authorization`; this map is the server side of the same contract.
 * `alice-broken` is not here on purpose — its config deliberately sends `admin-token` to prove the
 * eval suite discriminates (see README / the broken suite).
 */
const TOKENS: Record<string, IdentityName> = {
  'admin-token': 'admin',
  'alice-token': 'alice',
  'bob-token': 'bob',
};

const IDENTITIES: Record<IdentityName, Identity> = {
  admin: { name: 'admin', role: 'administrator', uid: 'UID-ADMIN', orderId: 'ORD-ADMIN-1' },
  alice: { name: 'alice', role: 'procurement', uid: 'UID-ALICE', orderId: 'ORD-ALICE-1' },
  bob: { name: 'bob', role: 'inventory', uid: 'UID-BOB', orderId: 'ORD-BOB-1' },
};

/** Distinctive verbatim markers so answer assertions are paraphrase-proof. */
const CATALOG_MARKER = 'CAT-WODGET-1';
const INVENTORY_MARKER = 'INV-SKU42';
const DELETE_SUCCESS_MARKER = 'DELETE-OK';
const DELETE_DENIED_MARKER = 'DELETE-DENIED';

/**
 * Which tools each identity SEES in `tools/list`. A tool absent here is HIDDEN for that identity.
 * `delete_order` is visible to everyone (it is denied at call time for non-admin, not hidden).
 */
const VISIBILITY: Record<IdentityName, ReadonlySet<string>> = {
  admin: new Set([
    'whoami',
    'list_my_orders',
    'search_catalog',
    'list_inventory',
    'list_all_orders',
    'delete_order',
  ]),
  alice: new Set(['whoami', 'list_my_orders', 'search_catalog', 'delete_order']),
  bob: new Set(['whoami', 'list_my_orders', 'list_inventory', 'delete_order']),
};

// --- MCP server construction, scoped to one resolved identity ------------------------------------

/** Wrap a plain string as an MCP text tool result. */
function text(t: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: t }] };
}

/**
 * Build a fresh {@link McpServer} exposing ONLY the tools the given identity may see, with handlers
 * closed over that identity so results are correctly scoped (own-orders isolation, admin-only
 * cross-scope read, and the visible-but-denied delete).
 */
function buildServerForIdentity(identity: Identity): McpServer {
  const server = new McpServer({ name: 'authz-mcp', version: '1.0.0' });
  const visible = VISIBILITY[identity.name];

  if (visible.has('whoami')) {
    server.registerTool(
      'whoami',
      { description: 'Return the authenticated identity and its role.' },
      async () =>
        text(
          `You are authenticated as '${identity.name}' (uid: ${identity.uid}, role: ${identity.role}).`
        )
    );
  }

  if (visible.has('list_my_orders')) {
    server.registerTool(
      'list_my_orders',
      {
        description: "List the caller's OWN orders (data-isolated to the authenticated identity).",
      },
      async () => text(`Your orders:\n- ${identity.orderId} (status: open)`)
    );
  }

  if (visible.has('search_catalog')) {
    server.registerTool(
      'search_catalog',
      {
        description: 'Search the product catalog (procurement scope).',
        inputSchema: { query: z.string().describe('search terms') },
      },
      async ({ query }) =>
        text(`Catalog results for "${query}":\n- ${CATALOG_MARKER} (Standard Wodget, $4.20)`)
    );
  }

  if (visible.has('list_inventory')) {
    server.registerTool(
      'list_inventory',
      {
        description: 'Report the inventory level for a SKU (inventory scope).',
        inputSchema: { sku: z.string().describe('the SKU to look up, e.g. SKU-42') },
      },
      async ({ sku }) => text(`Inventory for ${sku}:\n- ${INVENTORY_MARKER}: 137 units in stock`)
    );
  }

  if (visible.has('list_all_orders')) {
    server.registerTool(
      'list_all_orders',
      { description: 'List EVERY order across all users (admin-only cross-scope read).' },
      async () =>
        text(
          `All orders (admin cross-scope read):\n- ${IDENTITIES.admin.orderId}\n- ${IDENTITIES.alice.orderId}\n- ${IDENTITIES.bob.orderId}`
        )
    );
  }

  if (visible.has('delete_order')) {
    server.registerTool(
      'delete_order',
      {
        description: 'Delete an order by id (privileged; admin only).',
        inputSchema: { order_id: z.string().describe('the order id to delete') },
      },
      async ({ order_id }) => {
        if (identity.name !== 'admin') {
          // VISIBLE-BUT-DENIED: the server refuses. Returned as an error result so the agent
          // observes the denial and explains it (never a success).
          return {
            ...text(
              `${DELETE_DENIED_MARKER}: identity '${identity.name}' (role: ${identity.role}) is NOT ` +
                `authorized to delete orders. This action requires the admin role.`
            ),
            isError: true,
          };
        }
        return text(`${DELETE_SUCCESS_MARKER}: order ${order_id} deleted (txn DEL-TXN-1).`);
      }
    );
  }

  return server;
}

// --- HTTP transport wiring (stateful Streamable HTTP; identity bound at initialize) --------------

const PORT = Number(process.env.AUTHZ_MCP_PORT ?? 39405);
const MCP_PATH = '/mcp';

/** Live transports keyed by MCP session id. */
const transports: Record<string, StreamableHTTPServerTransport> = {};

/** Read + JSON-parse an HTTP request body. Resolves `undefined` for an empty body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      if (!data) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Map the request's `Authorization: Bearer <token>` header to an identity, or `null` if invalid. */
function identityFromAuth(req: IncomingMessage): Identity | null {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const name = TOKENS[match[1].trim()];
  return name ? IDENTITIES[name] : null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/** JSON-RPC-shaped error body (matches what MCP clients expect on a transport-level failure). */
function rpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: status === 401 ? -32001 : -32600, message },
    id: null,
  });
}

async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const sessionId = req.headers['mcp-session-id'];
  const existing = typeof sessionId === 'string' ? transports[sessionId] : undefined;

  let transport: StreamableHTTPServerTransport;
  if (existing) {
    transport = existing;
  } else if (typeof sessionId === 'string') {
    rpcError(res, 404, `Unknown MCP session '${sessionId}'.`);
    return;
  } else if (isInitializeRequest(body)) {
    // AUTHORIZATION GATE — bind the identity at the handshake. Unknown/absent bearer => 401, no
    // session created. This is the per-identity supply path ([[CFG-4]]): the bearer arrives in the
    // client's `headers.Authorization` and is never stripped.
    const identity = identityFromAuth(req);
    if (!identity) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="authz-mcp"');
      rpcError(res, 401, 'Missing or invalid Authorization bearer token.');
      return;
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) delete transports[sid];
    };
    const server = buildServerForIdentity(identity);
    await server.connect(transport);
    process.stderr.write(`[authz-mcp] session for identity '${identity.name}'\n`);
  } else {
    rpcError(res, 400, 'No valid MCP session and body is not an initialize request.');
    return;
  }

  await transport.handleRequest(req, res, body);
}

/** GET (SSE stream) and DELETE (session teardown) both require an established session. */
async function handleSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = req.headers['mcp-session-id'];
  const transport = typeof sessionId === 'string' ? transports[sessionId] : undefined;
  if (!transport) {
    rpcError(res, 400, 'Missing or unknown MCP session id.');
    return;
  }
  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (url.pathname !== MCP_PATH) {
        rpcError(res, 404, 'Not found.');
        return;
      }
      if (req.method === 'POST') {
        await handlePost(req, res);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        await handleSessionRequest(req, res);
        return;
      }
      rpcError(res, 405, 'Method not allowed.');
    } catch (err) {
      process.stderr.write(`[authz-mcp] request error: ${String(err)}\n`);
      if (!res.headersSent) rpcError(res, 500, 'Internal server error.');
    }
  })();
});

httpServer.on('error', (err) => {
  process.stderr.write(`[authz-mcp] server error: ${String(err)}\n`);
  process.exit(1);
});

httpServer.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(
    `[authz-mcp] listening on http://127.0.0.1:${PORT}${MCP_PATH} (health: /health)\n`
  );
});

// Clean shutdown so the run script's EXIT trap leaves no zombie on the port.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
  });
}
