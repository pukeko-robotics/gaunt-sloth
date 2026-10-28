import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { EventType } from '@ag-ui/core';
// The schemas live behind their own subpath: `@ag-ui/core`'s main entry is deliberately zod-free
// (zod is an optional peer), so the root export carries the types and the enum but no schema.
import { AgentCapabilitiesSchema } from '@ag-ui/core/schemas';
import type { GthConfig } from '#src/config.js';
import type { GthAdvertisedTools } from '@gaunt-sloth/core/core/types.js';
import {
  bindMcpToolsets,
  mcpToolRegisteredName,
} from '@gaunt-sloth/core/core/approvals/mcpSubjects.js';

/**
 * [[EXT-166]] — `GET /agents/:agentId/capabilities`.
 *
 * **`@ag-ui/core` is deliberately NOT mocked here**, unlike in `apiAgUiModule.spec.ts`, which
 * stubs it with a hand-written `EventType` map. That stub is why the existing suite would stay
 * green through a renamed event or a changed schema, and the one assertion that would not is the
 * one below: the body parsed by the **shipped** `AgentCapabilitiesSchema`.
 */

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  defaultStatusCallback: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const llmUtilsMock = {
  getNewRunnableConfig: vi.fn().mockReturnValue({}),
  buildSystemMessages: vi.fn().mockReturnValue([]),
  readChatPrompt: vi.fn().mockReturnValue(''),
};
vi.mock('#src/utils/llmUtils.js', () => llmUtilsMock);

const agentInitMock = vi.fn();
const agentAdvertisedToolsMock = vi.fn();
const agentStreamWithEventsMock = vi.fn();
vi.mock('@gaunt-sloth/core/core/GthLangChainAgent.js', () => {
  const GthLangChainAgent = vi.fn();
  GthLangChainAgent.prototype.init = agentInitMock;
  GthLangChainAgent.prototype.getAdvertisedTools = agentAdvertisedToolsMock;
  GthLangChainAgent.prototype.streamWithEvents = agentStreamWithEventsMock;
  return { GthLangChainAgent };
});

const mockUseFn = vi.fn();
const mockPostFn = vi.fn();
const mockGetFn = vi.fn();
const mockListenFn = vi.fn();
const mockExpressApp = { use: mockUseFn, post: mockPostFn, get: mockGetFn, listen: mockListenFn };
const expressMock = Object.assign(
  vi.fn(() => mockExpressApp),
  { json: vi.fn(() => 'json-middleware') }
);
vi.mock('express', () => ({ default: expressMock }));

type RouteHandler = (_req: unknown, _res: unknown) => unknown;

function makeRes() {
  return {
    json: vi.fn(),
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn().mockReturnThis(),
    on: vi.fn(),
  };
}

/** A server that never binds a socket: the boot promise settles off this fake, as in the sibling spec. */
function fakeServer(port: number) {
  return {
    listening: true,
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port }),
    on() {
      return this;
    },
  };
}

/**
 * The handler the MOST RECENT boot registered at `path`.
 *
 * Most recent, not first: a cell that boots two servers to compare their answers appends a second
 * registration to the same mock, and taking the first would hand it the previous config's handler —
 * two calls returning one server's answer, which reads as "the response does not follow the config"
 * when the response follows it perfectly.
 */
function handlerFor(path: string): RouteHandler {
  const calls = mockGetFn.mock.calls.filter(([registered]) => registered === path);
  expect(calls.length, `no GET route registered at ${path}`).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as RouteHandler;
}

/** Boot a server on the mocked express app and return what the capabilities route answers. */
async function capabilitiesOf(config: Partial<GthConfig>) {
  const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
  await startAgUiServer(config as GthConfig, 3000);
  const res = makeRes();
  handlerFor('/agents/:agentId/capabilities')({ params: { agentId: 'default' } }, res);
  expect(res.json).toHaveBeenCalledTimes(1);
  return res.json.mock.calls[0][0] as Record<string, unknown>;
}

/** A tool as `config.tools` holds one — name, description and a schema, nothing else is read. */
function fakeTool(name: string, description: string, schema?: unknown, client = false) {
  return {
    name,
    description,
    ...(schema ? { schema } : {}),
    ...(client ? { metadata: { client: true } } : {}),
  };
}

/**
 * The server each MCP tool in these cells was bound from. Taken from bindings, as production does,
 * because the registered name alone cannot be split back into a server key.
 */
const MCP_BINDINGS = bindMcpToolsets([
  ['unimarket', [{ name: mcpToolRegisteredName('unimarket', 'search') }]],
]);

function inventory(tools: string[], filteredOut: string[] = []): GthAdvertisedTools {
  const describe = (name: string) => {
    const binding = MCP_BINDINGS.get(name);
    return binding ? { name, server: binding.server } : { name };
  };
  return {
    tools: tools.map(describe),
    filteredOut: filteredOut.map(describe),
    unnamed: 0,
  };
}

const baseConfig = { commands: { api: { port: 3000 } } } as Partial<GthConfig>;

describe('apiAgUiModule capabilities endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentInitMock.mockResolvedValue(undefined);
    agentAdvertisedToolsMock.mockReturnValue(undefined);
    agentStreamWithEventsMock.mockReturnValue((async function* () {})());
    mockListenFn.mockImplementation((port: number, _host: string, cb: () => void) => {
      queueMicrotask(cb);
      return fakeServer(port);
    });
  });

  // ─── the route, and a control that tells it apart from the run route ───────

  it('registers the capabilities route without disturbing the run route', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig as GthConfig, 3000);

    const getPaths = mockGetFn.mock.calls.map(([path]) => path);
    expect(getPaths).toContain('/agents/:agentId/capabilities');

    const runRegistrations = mockPostFn.mock.calls.filter(
      ([path]) => path === '/agents/:agentId/run'
    );
    expect(runRegistrations).toHaveLength(1);
    expect(mockPostFn.mock.calls).toHaveLength(1);
    expect(runRegistrations[0][1]).not.toBe(handlerFor('/agents/:agentId/capabilities'));
  });

  it('does not answer a run request with a capability declaration', async () => {
    // The control for every cell below: they read `res.json`, so they must be able to fail when
    // the declaration is wired into the wrong handler. The run route streams and never calls it.
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig as GthConfig, 3000);

    const runHandler = mockPostFn.mock.calls[0][1] as RouteHandler;
    const res = makeRes();
    await runHandler(
      { body: { threadId: 't', runId: 'r', messages: [] }, headers: {}, method: 'POST' },
      res
    );

    expect(res.json).not.toHaveBeenCalled();
    const written = res.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(written).not.toContain('clientProvided');
    expect(written).not.toContain('langgraph');
  });

  it('serves the ADK-derived alias path from the very same handler', async () => {
    // `ADKAgent.capabilitiesUrl()` appends `/capabilities` to the RUN url, so a stock ag-ui client
    // pointed at our run endpoint asks for `/agents/:agentId/run/capabilities`. That alias is
    // registered so such a client finds us without subclassing; the shorter path stays canonical.
    //
    // The identity check is the load-bearing half. Two handlers built from the same builder would
    // agree today and satisfy an equal-bodies assertion forever, which is precisely the
    // second-source-of-truth failure this node exists to prevent — so this pins ONE function object
    // bound twice, not two that happen to match.
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(
      { ...baseConfig, tools: [fakeTool('read_file', 'Read a file')] } as GthConfig,
      3000
    );

    const canonical = handlerFor('/agents/:agentId/capabilities');
    const alias = handlerFor('/agents/:agentId/run/capabilities');
    expect(alias).toBe(canonical);

    const viaCanonical = makeRes();
    canonical({ params: { agentId: 'default' } }, viaCanonical);
    const viaAlias = makeRes();
    alias({ params: { agentId: 'default' } }, viaAlias);

    expect(viaCanonical.json).toHaveBeenCalledTimes(1);
    expect(viaAlias.json).toHaveBeenCalledTimes(1);
    const canonicalBody = viaCanonical.json.mock.calls[0][0] as Record<string, unknown>;
    expect(viaAlias.json.mock.calls[0][0]).toEqual(canonicalBody);
    // Not two empty objects agreeing: the shared body is a real declaration.
    expect((canonicalBody.tools as { items: unknown[] }).items).toHaveLength(1);
    expect(AgentCapabilitiesSchema.safeParse(canonicalBody).success).toBe(true);
  });

  it('serves the route under the default CORS headers, with no cors config at all', async () => {
    // The node's acceptance names reachability with the DEFAULT config, so `baseConfig` carries no
    // `cors` key: this is the untouched default path, not a widened one. Two things have to hold —
    // the default `allowMethods` admits GET, and the middleware is registered BEFORE the routes, or
    // the headers never reach this response.
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig as GthConfig, 3000);

    const corsIndex = mockUseFn.mock.calls.findIndex(([fn]) => typeof fn === 'function');
    expect(corsIndex, 'no CORS middleware registered').toBeGreaterThanOrEqual(0);
    const cors = mockUseFn.mock.calls[corsIndex][0] as (
      _req: unknown,
      _res: unknown,
      _next: () => void
    ) => void;

    const res = makeRes();
    const next = vi.fn();
    cors({ method: 'GET' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const headers = Object.fromEntries(res.setHeader.mock.calls as [string, string][]);
    expect(headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(headers['Access-Control-Allow-Origin']).toBeTruthy();

    // BOTH paths, not just the canonical one. The alias is the path a stock ag-ui client derives,
    // and that client is a browser — so it is the registration whose CORS reachability actually
    // matters. Checking only the canonical path would stay green through a regression that moved
    // the alias registration above the middleware.
    for (const path of ['/agents/:agentId/capabilities', '/agents/:agentId/run/capabilities']) {
      const capIndex = mockGetFn.mock.calls.findIndex(([registered]) => registered === path);
      expect(capIndex, `no GET route registered at ${path}`).toBeGreaterThanOrEqual(0);
      expect(
        mockUseFn.mock.invocationCallOrder[corsIndex],
        `CORS middleware is registered after ${path}`
      ).toBeLessThan(mockGetFn.mock.invocationCallOrder[capIndex]);
    }
  });

  it('answers the same declaration whatever :agentId is asked for', async () => {
    // The run route never reads `req.params.agentId`, and this route must not diverge from it: an
    // id nothing is registered under is answered, not refused. The third request carries no `params`
    // object at all — a handler that had started reading the id would throw on it, which is what
    // makes this an invariance check rather than two equal bodies by coincidence.
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(
      { ...baseConfig, tools: [fakeTool('read_file', 'Read a file')] } as GthConfig,
      3000
    );
    const handler = handlerFor('/agents/:agentId/capabilities');

    const known = makeRes();
    handler({ params: { agentId: 'default' } }, known);
    const unknown = makeRes();
    handler({ params: { agentId: 'no-such-agent-42' } }, unknown);
    const bare = makeRes();
    handler({}, bare);

    const bodyOf = (res: ReturnType<typeof makeRes>) => {
      expect(res.json).toHaveBeenCalledTimes(1);
      return res.json.mock.calls[0][0] as Record<string, unknown>;
    };
    expect(bodyOf(unknown)).toEqual(bodyOf(known));
    expect(bodyOf(bare)).toEqual(bodyOf(known));
    expect(unknown.status).not.toHaveBeenCalled();
    // Not vacuously equal: the shared body is a real declaration.
    expect((bodyOf(known).tools as { items: unknown[] }).items).toHaveLength(1);
  });

  // ─── the shipped schema, not a stand-in ───────────────────────────────────

  it('answers a body the real AgentCapabilitiesSchema accepts', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'mcp__unimarket_search']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file', z.object({ path: z.string() }))],
      modelDisplayName: 'claude-sonnet-5',
    } as Partial<GthConfig>);

    const parsed = AgentCapabilitiesSchema.safeParse(body);
    expect(parsed.success ? null : parsed.error.issues).toBeNull();
  });

  // ─── derived from the live configuration ──────────────────────────────────

  it('reports the model and provider the config resolves, not a fixed pair', async () => {
    // Keyed on a pure config read with no mocked intermediary: two configs, two answers. Both
    // fixtures carry an `invoke`, because that is what `isUsableModel` tests and a model that never
    // resolved has its name omitted — see the omission cell below.
    const ollama = await capabilitiesOf({
      ...baseConfig,
      llm: { invoke: () => undefined, _llmType: () => 'ollama', model: 'gemma4:12b' },
    } as unknown as Partial<GthConfig>);
    const anthropic = await capabilitiesOf({
      ...baseConfig,
      llm: { invoke: () => undefined, _llmType: () => 'anthropic' },
      modelDisplayName: 'claude-sonnet-5',
    } as unknown as Partial<GthConfig>);

    const identityOf = (body: Record<string, unknown>) =>
      (body.identity as { metadata: Record<string, unknown> }).metadata;
    expect(identityOf(ollama)).toMatchObject({ llmProvider: 'ollama', model: 'gemma4:12b' });
    expect(identityOf(anthropic)).toMatchObject({
      llmProvider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(identityOf(ollama)).not.toEqual(identityOf(anthropic));
  });

  it('declares the command the server started its agent as', async () => {
    const body = await capabilitiesOf(baseConfig);
    const metadata = (body.identity as { metadata: Record<string, unknown> }).metadata;
    expect(metadata.command).toBe('api');
    expect(agentInitMock).toHaveBeenCalledWith('api', expect.anything(), expect.anything());
  });

  it('describes the tools the configuration holds, not a fixed list', async () => {
    const withGrep = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('grep', 'Search the tree', z.object({ pattern: z.string() }))],
    } as Partial<GthConfig>);
    const withFetch = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('fetch', 'Fetch a URL')],
    } as Partial<GthConfig>);

    const itemsOf = (body: Record<string, unknown>) =>
      (body.tools as { items: { name: string; description: string; parameters?: unknown }[] })
        .items;
    expect(itemsOf(withGrep)).toEqual([
      {
        name: 'grep',
        description: 'Search the tree',
        parameters: expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ pattern: expect.anything() }),
        }),
      },
    ]);
    expect(itemsOf(withFetch)).toEqual([{ name: 'fetch', description: 'Fetch a URL' }]);
    expect(itemsOf(withGrep)).not.toEqual(itemsOf(withFetch));
  });

  it('takes the tool list from the agent inventory, not from config.tools alone', async () => {
    // The inventory is the whole point: `config.tools` is a strict subset of what the run path
    // binds, so a declaration built from it alone omits every resolver-loaded tool. The two halves
    // of this cell must DIFFER, or the inventory path is untested and only the fallback ships.
    const config = {
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file')],
    } as Partial<GthConfig>;

    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'mcp__unimarket_search']));
    const withInventory = await capabilitiesOf(config);

    agentAdvertisedToolsMock.mockReturnValue(undefined);
    const withoutInventory = await capabilitiesOf(config);

    const itemsOf = (body: Record<string, unknown>) =>
      (body.tools as { items: { name: string; description: string; metadata?: unknown }[] }).items;
    expect(itemsOf(withInventory)).toEqual([
      { name: 'read_file', description: 'Read a file' },
      { name: 'mcp__unimarket_search', description: '', metadata: { server: 'unimarket' } },
    ]);
    expect(itemsOf(withoutInventory)).toEqual([{ name: 'read_file', description: 'Read a file' }]);
    expect(itemsOf(withInventory)).not.toEqual(itemsOf(withoutInventory));
  });

  it('does not offer a tool the allowedTools filter removed', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'run_shell'], ['run_shell']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file'), fakeTool('run_shell', 'Run a command')],
    } as Partial<GthConfig>);

    const items = (body.tools as { items: { name: string }[] }).items;
    expect(items.map((item) => item.name)).toEqual(['read_file']);
  });

  it('declares a client-fulfilled tool through clientProvided, never as a tool it provides', async () => {
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file', 'drive_robot']));
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [
        fakeTool('read_file', 'Read a file'),
        fakeTool('drive_robot', 'Drive the robot', undefined, true),
      ],
    } as Partial<GthConfig>);

    const tools = body.tools as { items: { name: string }[]; clientProvided: boolean };
    expect(tools.items.map((item) => item.name)).toEqual(['read_file']);
    expect(tools.clientProvided).toBe(true);
  });

  it('publishes no server metadata for a tool whose MCP server could not be named', async () => {
    // `approvalSubjectForToolName` resolves an `mcp__` name through the bindings recorded at tool
    // load and yields UNRESOLVED_MCP_SERVER — the EMPTY STRING — for a name it has no binding for. That value
    // is an internal "we cannot attribute this call", not a server anyone can be told about, so the
    // declaration carries no `metadata` for such a tool. The resolvable sibling in the same
    // inventory is the differential: metadata is omitted HERE, not never emitted.
    agentAdvertisedToolsMock.mockReturnValue({
      tools: [
        { name: 'mcp__unimarket_search', server: 'unimarket' },
        { name: 'mcp__mystery_do', server: '' },
      ],
      filteredOut: [],
      unnamed: 0,
    } as GthAdvertisedTools);

    const body = await capabilitiesOf(baseConfig);
    const items = (body.tools as { items: { name: string; metadata?: unknown }[] }).items;
    expect(items.find((item) => item.name === 'mcp__mystery_do')).toEqual({
      name: 'mcp__mystery_do',
      description: '',
    });
    expect(items.find((item) => item.name === 'mcp__unimarket_search')).toMatchObject({
      metadata: { server: 'unimarket' },
    });
    expect(AgentCapabilitiesSchema.safeParse(body).success).toBe(true);
  });

  it('answers a full declaration on a server whose model never resolved', async () => {
    // Capability discovery is not a readiness check. CFG-61 made `/health` answer 503 and `/info`
    // answer `{status:'error'}` when `isUsableModel(config.llm)` is false; this route deliberately
    // does NOT follow, because the declaration says what this agent is built to do, not whether it
    // can serve a request this second. So a raw, unrouted `{ type, model }` spec — the config an
    // embedder reaches `startAgUiServer` with — still gets the normal body.
    //
    // What this cell does NOT pin is what `identity.metadata.model` says in that state; that one is
    // open, and is recorded on `describeConfiguredModel`.
    agentAdvertisedToolsMock.mockReturnValue(inventory(['read_file']));
    const body = await capabilitiesOf({
      ...baseConfig,
      llm: { type: 'ollama', model: 'gemma4:12b' },
      tools: [fakeTool('read_file', 'Read a file')],
    } as unknown as Partial<GthConfig>);

    expect(AgentCapabilitiesSchema.safeParse(body).success).toBe(true);
    expect(body.status).toBeUndefined();
    expect((body.tools as { items: { name: string }[] }).items.map((item) => item.name)).toEqual([
      'read_file',
    ]);
    expect(body.transport).toEqual({ streaming: true });
  });

  it('omits the model entirely when none resolved, rather than declaring a name nothing built', async () => {
    // `modelDisplayName` and a raw spec's `model` are the name the user ASKED for. On a server where
    // `isUsableModel(config.llm)` is false nothing was built from it, so declaring it would be a
    // false statement of fact — the report CFG-61 removed from `/info`, one door down. Absent means
    // undeclared, the same rule that leaves `humanInTheLoop` out, so the key goes rather than
    // turning null.
    //
    // The CONTROL is the second half: the identical config with a usable `llm` must still declare
    // the model, or this cell would pass just as well against a build that never emits the key.
    const withoutModel = await capabilitiesOf({
      ...baseConfig,
      llm: { type: 'ollama', model: 'gemma4:12b' },
      modelDisplayName: 'gemma4:12b',
    } as unknown as Partial<GthConfig>);
    const withModel = await capabilitiesOf({
      ...baseConfig,
      llm: { invoke: () => undefined, _llmType: () => 'ollama', model: 'gemma4:12b' },
      modelDisplayName: 'gemma4:12b',
    } as unknown as Partial<GthConfig>);

    const metadataOf = (body: Record<string, unknown>) =>
      (body.identity as { metadata: Record<string, unknown> }).metadata;

    expect('model' in metadataOf(withoutModel)).toBe(false);
    expect(Object.keys(metadataOf(withoutModel))).not.toContain('model');
    // Not silently replaced by a readiness marker either: this object says what the agent is built
    // to do, and `/health` is what answers whether it can serve right now.
    expect(Object.keys(metadataOf(withoutModel))).not.toContain('modelResolved');

    expect(metadataOf(withModel).model).toBe('gemma4:12b');
    expect(metadataOf(withoutModel)).not.toEqual(metadataOf(withModel));
    expect(AgentCapabilitiesSchema.safeParse(withoutModel).success).toBe(true);
  });

  // ─── what is deliberately absent, and what is deliberately false ──────────

  it('leaves humanInTheLoop undeclared', async () => {
    // Pinned so a later edit cannot "complete" the block: this surface wires no tool-approval
    // callback, and `approvals: true` would promise a human review that nothing performs.
    const body = await capabilitiesOf(baseConfig);
    expect('humanInTheLoop' in body).toBe(false);
    expect(Object.keys(body)).not.toContain('humanInTheLoop');
  });

  it('declares the state categories false, because the run path emits no state events', async () => {
    const body = await capabilitiesOf(baseConfig);
    expect(body.state).toEqual({ snapshots: false, deltas: false });
    expect(body.reasoning).toEqual({ supported: true, streaming: true });
    expect(body.transport).toEqual({ streaming: true });
    expect((body.tools as { supported: boolean }).supported).toBe(true);
  });

  it('takes its identity from the shipped package manifest', async () => {
    // The fail-soft manifest read degrades to omitted fields, so an identity that quietly stopped
    // resolving would look like a deliberate silence. This is what tells the two apart — and what
    // stops the block being replaced by hand-written strings that drift from the package.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
    ) as { name: string; version: string; description: string; homepage: string; author: string };

    const body = await capabilitiesOf(baseConfig);
    const identity = body.identity as Record<string, unknown>;
    expect(identity.name).toBe(manifest.name);
    expect(identity.version).toBe(manifest.version);
    expect(identity.description).toBe(manifest.description);
    expect(identity.documentationUrl).toBe(manifest.homepage);
    expect(identity.provider).toBe(manifest.author);
  });

  it('still answers when the agent cannot report its inventory', async () => {
    agentAdvertisedToolsMock.mockImplementation(() => {
      throw new Error('inventory unavailable');
    });
    const body = await capabilitiesOf({
      ...baseConfig,
      tools: [fakeTool('read_file', 'Read a file')],
    } as Partial<GthConfig>);

    expect(AgentCapabilitiesSchema.safeParse(body).success).toBe(true);
    expect((body.tools as { items: { name: string }[] }).items.map((i) => i.name)).toEqual([
      'read_file',
    ]);
  });

  // ─── the tripwire under the event-derived categories ──────────────────────

  it('holds AG_UI_EMITTED_EVENT_TYPES equal to what the run path actually emits', async () => {
    // `transport`, `tools.supported`, `state` and `reasoning` are projections of that constant, so
    // it is the one place the server's emissions are written down twice. Equality, not containment:
    // the drift worth catching is an emission the run path gained and the constant never heard of.
    const source = fileURLToPath(new URL('../src/modules/apiAgUiModule.ts', import.meta.url));
    expect(existsSync(source), `run path source not found at ${source}`).toBe(true);

    const emitted = new Set(
      [...readFileSync(source, 'utf8').matchAll(/type:\s*EventType\.([A-Z_]+)/g)].map(
        ([, name]) => name
      )
    );
    // An unreadable file, or a scan that matches nothing, would compare two empty sets and pass
    // vacuously — the exact failure this cell exists to prevent elsewhere.
    expect(emitted.size).toBeGreaterThan(0);

    const { AG_UI_EMITTED_EVENT_TYPES } = await import('#src/modules/agUiCapabilities.js');
    expect([...emitted].sort()).toEqual([...AG_UI_EMITTED_EVENT_TYPES].sort());
    expect(AG_UI_EMITTED_EVENT_TYPES.has(EventType.STATE_SNAPSHOT)).toBe(false);
    expect(AG_UI_EMITTED_EVENT_TYPES.has(EventType.STATE_DELTA)).toBe(false);
  });
});
