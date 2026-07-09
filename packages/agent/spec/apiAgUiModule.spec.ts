import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';

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

const memorySaverMock = vi.fn();
vi.mock('@langchain/langgraph', () => ({
  MemorySaver: memorySaverMock,
}));

const gthDeepAgentCtorMock = vi.fn();
const gthDeepAgentInitMock = vi.fn();
const gthDeepAgentStreamMock = vi.fn();
const gthDeepAgentStreamWithEventsMock = vi.fn();
const gthDeepAgentStreamWithEventsResumeMock = vi.fn();
vi.mock('#src/core/GthDeepAgent.js', () => {
  const GthDeepAgent = vi.fn(function (this: unknown, ...args: unknown[]) {
    gthDeepAgentCtorMock(...args);
  });
  GthDeepAgent.prototype.init = gthDeepAgentInitMock;
  GthDeepAgent.prototype.stream = gthDeepAgentStreamMock;
  GthDeepAgent.prototype.streamWithEvents = gthDeepAgentStreamWithEventsMock;
  GthDeepAgent.prototype.streamWithEventsResume = gthDeepAgentStreamWithEventsResumeMock;
  return {
    GthDeepAgent,
  };
});

// B5: the lean backend. createConfiguredAgent constructs this instead of GthDeepAgent
// when config.agent.backend === 'lean'. Mirror the same init/stream surface so a lean run
// flows through the AG-UI handler unchanged.
const gthLangChainAgentCtorMock = vi.fn();
const gthLangChainAgentInitMock = vi.fn();
const gthLangChainAgentStreamWithEventsMock = vi.fn();
const gthLangChainAgentStreamWithEventsResumeMock = vi.fn();
vi.mock('@gaunt-sloth/core/core/GthLangChainAgent.js', () => {
  const GthLangChainAgent = vi.fn(function (this: unknown, ...args: unknown[]) {
    gthLangChainAgentCtorMock(...args);
  });
  GthLangChainAgent.prototype.init = gthLangChainAgentInitMock;
  GthLangChainAgent.prototype.streamWithEvents = gthLangChainAgentStreamWithEventsMock;
  GthLangChainAgent.prototype.streamWithEventsResume = gthLangChainAgentStreamWithEventsResumeMock;
  return {
    GthLangChainAgent,
  };
});

const mockUseFn = vi.fn();
const mockPostFn = vi.fn();
const mockGetFn = vi.fn();
const mockListenFn = vi.fn();
const mockExpressApp = {
  use: mockUseFn,
  post: mockPostFn,
  get: mockGetFn,
  listen: mockListenFn,
};
const expressJsonMock = vi.fn(() => 'json-middleware');
const expressMock = Object.assign(
  vi.fn(() => mockExpressApp),
  {
    json: expressJsonMock,
  }
);
vi.mock('express', () => ({
  default: expressMock,
}));

// Shared encoder instance — replaced in beforeEach
let mockEncoderInstance: {
  getContentType: ReturnType<typeof vi.fn>;
  encode: ReturnType<typeof vi.fn>;
};

const EventEncoderMock = vi.fn();
vi.mock('@ag-ui/encoder', () => ({
  EventEncoder: EventEncoderMock,
}));

vi.mock('@ag-ui/core', () => ({
  EventType: {
    RUN_STARTED: 'RUN_STARTED',
    TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
    TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
    TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
    RUN_FINISHED: 'RUN_FINISHED',
    RUN_ERROR: 'RUN_ERROR',
    TOOL_CALL_START: 'TOOL_CALL_START',
    TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
    TOOL_CALL_END: 'TOOL_CALL_END',
    TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  },
}));

// Regular functions required — arrow functions cannot be used with `new`
vi.mock('@langchain/core/messages', () => ({
  HumanMessage: vi.fn(function (this: Record<string, unknown>, content: string) {
    this.role = 'user';
    this.content = content;
  }),
  AIMessage: vi.fn(function (this: Record<string, unknown>, content: string) {
    this.role = 'assistant';
    this.content = content;
  }),
  SystemMessage: vi.fn(function (this: Record<string, unknown>, content: string) {
    this.role = 'system';
    this.content = content;
  }),
  ToolMessage: vi.fn(function (
    this: Record<string, unknown>,
    opts: { content: string; tool_call_id: string }
  ) {
    this.role = 'tool';
    this.content = opts.content;
    this.tool_call_id = opts.tool_call_id;
  }),
}));

const baseConfig = {
  commands: { api: { port: 3000 } },
} as Partial<GthConfig> as GthConfig;

function makeMockRes() {
  // `on` captures the 'close' listener the handler registers to abort inference
  // on client disconnect. `emitClose` lets a test fire it.
  const listeners: Record<string, Array<(..._args: unknown[]) => void>> = {};
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
    on: vi.fn((eventName: string, cb: (..._args: unknown[]) => void) => {
      (listeners[eventName] ??= []).push(cb);
    }),
    emitClose: () => {
      for (const cb of listeners['close'] ?? []) cb();
    },
  };
}

function makeRunReq(overrides: Record<string, unknown> = {}) {
  return {
    body: { threadId: 'thread-1', runId: 'run-1', messages: [], ...overrides },
    headers: { accept: 'text/event-stream' },
    method: 'POST',
  };
}

function emptyStream() {
  return (async function* () {})();
}

function textStream(...deltas: string[]) {
  return (async function* () {
    for (const delta of deltas) {
      yield { type: 'text' as const, delta };
    }
  })();
}

describe('apiAgUiModule', () => {
  beforeEach(() => {
    // clearAllMocks keeps implementations intact (e.g. HumanMessage/AIMessage constructor mocks).
    // resetAllMocks would strip them, breaking `new HumanMessage()` calls inside the handler.
    vi.clearAllMocks();
    gthDeepAgentInitMock.mockResolvedValue(undefined);
    gthLangChainAgentInitMock.mockResolvedValue(undefined);
    gthLangChainAgentStreamWithEventsMock.mockReturnValue(emptyStream());
    gthLangChainAgentStreamWithEventsResumeMock.mockReturnValue(emptyStream());
    mockListenFn.mockImplementation((_port: number, cb: () => void) => {
      cb();
    });
    mockEncoderInstance = {
      getContentType: vi.fn().mockReturnValue('text/event-stream'),
      encode: vi.fn((event) => JSON.stringify(event)),
    };
    // Must be a regular function (not arrow) — arrow functions cannot be called with `new`
    EventEncoderMock.mockImplementation(function () {
      return mockEncoderInstance;
    });
    gthDeepAgentStreamMock.mockReturnValue(emptyStream());
    gthDeepAgentStreamWithEventsMock.mockReturnValue(emptyStream());
    gthDeepAgentStreamWithEventsResumeMock.mockReturnValue(emptyStream());
    // Reset to default so tests that override it don't bleed into the next test
    llmUtilsMock.buildSystemMessages.mockReturnValue([]);
  });

  // ─── CORS ──────────────────────────────────────────────────────────────────

  it('should use CORS values from config', async () => {
    const config = {
      commands: {
        api: {
          port: 4000,
          cors: {
            allowOrigin: 'http://example.com',
            allowMethods: 'POST, OPTIONS',
            allowHeaders: 'Content-Type',
          },
        },
      },
    } as Partial<GthConfig> as GthConfig;

    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(config, 4000);

    // The second app.use call should be the CORS middleware (first is express.json())
    expect(mockUseFn).toHaveBeenCalledTimes(2);

    const corsMiddleware = mockUseFn.mock.calls[1][0];
    const mockRes = makeMockRes();
    const mockNext = vi.fn();

    // Test non-OPTIONS request
    corsMiddleware({ method: 'POST' }, mockRes, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'http://example.com'
    );
    expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'POST, OPTIONS');
    expect(mockRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'Content-Type');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should use default CORS values when config does not specify cors', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig, 3000);

    const corsMiddleware = mockUseFn.mock.calls[1][0];
    const mockRes = makeMockRes();
    const mockNext = vi.fn();

    corsMiddleware({ method: 'GET' }, mockRes, mockNext);

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'http://localhost:3000'
    );
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Methods',
      'POST, GET, OPTIONS'
    );
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept'
    );
    expect(mockNext).toHaveBeenCalled();
  });

  it('should respond with 204 for OPTIONS requests', async () => {
    const config = {
      commands: {
        api: {
          port: 3000,
          cors: {
            allowOrigin: 'http://localhost:5000',
            allowMethods: 'POST, GET, OPTIONS',
            allowHeaders: 'Content-Type, Accept',
          },
        },
      },
    } as Partial<GthConfig> as GthConfig;

    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(config, 3000);

    const corsMiddleware = mockUseFn.mock.calls[1][0];
    const mockRes = makeMockRes();
    const mockNext = vi.fn();

    corsMiddleware({ method: 'OPTIONS' }, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(204);
    expect(mockRes.end).toHaveBeenCalled();
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should display local-only warning on startup', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig, 3000);

    expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(
      expect.stringContaining('local clients only')
    );
  });

  // ─── /agents/:agentId/run endpoint ─────────────────────────────────────────

  describe('/agents/:agentId/run', () => {
    async function getRunHandler() {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(baseConfig, 3000);
      // app.post('/agents/:agentId/run', handler) — first post() call
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    it('should emit RUN_STARTED, message events, and RUN_FINISHED for a successful run', async () => {
      gthDeepAgentStreamWithEventsMock.mockReturnValue(textStream('Hello', ' world'));

      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'run-success', runId: 'run-id-1' });
      const res = makeMockRes();

      await handler(req, res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]);

      expect(events[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 'run-success' });
      expect(events[1]).toMatchObject({ type: 'TEXT_MESSAGE_START', role: 'assistant' });
      expect(events[2]).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello' });
      expect(events[3]).toMatchObject({ type: 'TEXT_MESSAGE_CONTENT', delta: ' world' });
      expect(events[4]).toMatchObject({ type: 'TEXT_MESSAGE_END' });
      expect(events[5]).toMatchObject({ type: 'RUN_FINISHED', threadId: 'run-success' });
      expect(res.end).toHaveBeenCalled();
    });

    it('GS2-22: delimits text runs around tool calls so post-tool text is not swallowed', async () => {
      // A single assistant turn that interleaves text -> tool -> text (the swallow case):
      // before the fix the second text delta rode the same, never-ended messageId and the
      // client dropped it once the tool call began.
      gthDeepAgentStreamWithEventsMock.mockReturnValue(
        (async function* () {
          yield { type: 'text' as const, delta: 'Body center (0.2, 0.3). Let me calibrate.' };
          yield { type: 'tool_start' as const, id: 'tc-1', name: 'turn_right' };
          yield { type: 'tool_end' as const, id: 'tc-1' };
          yield { type: 'text' as const, delta: 'Distance reads 25.8cm. Turning more.' };
        })()
      );

      const handler = await getRunHandler();
      const res = makeMockRes();
      await handler(makeRunReq({ threadId: 'delimit-thread', runId: 'delimit-run' }), res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]) as Array<
        Record<string, unknown>
      >;
      const types = events.map((e) => e.type);

      // The first text run is ENDED before the tool call starts (not left open).
      const firstEnd = types.indexOf('TEXT_MESSAGE_END');
      const toolStart = types.indexOf('TOOL_CALL_START');
      expect(firstEnd).toBeGreaterThan(-1);
      expect(toolStart).toBeGreaterThan(firstEnd);

      // The text that resumes AFTER the tool call is present (previously swallowed)...
      const afterContent = events.find(
        (e) =>
          e.type === 'TEXT_MESSAGE_CONTENT' && String(e.delta).includes('Distance reads 25.8cm')
      );
      expect(afterContent).toBeDefined();

      // ...on a NEW text message id, with each run properly START/END-paired.
      const startIds = events
        .filter((e) => e.type === 'TEXT_MESSAGE_START')
        .map((e) => e.messageId);
      const endIds = events.filter((e) => e.type === 'TEXT_MESSAGE_END').map((e) => e.messageId);
      expect(startIds.length).toBe(2);
      expect(new Set(startIds).size).toBe(2);
      expect([...endIds].sort()).toEqual([...startIds].sort());
      expect(afterContent!.messageId).toBe(startIds[1]);
    });

    it('should set SSE headers on the response', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'headers-thread' });
      const res = makeMockRes();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    });

    it('should use provided runId and threadId in events', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'my-thread', runId: 'my-run' });
      const res = makeMockRes();

      await handler(req, res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]);
      expect(events[0]).toMatchObject({ threadId: 'my-thread', runId: 'my-run' });
      expect(events[events.length - 1]).toMatchObject({ threadId: 'my-thread', runId: 'my-run' });
    });

    it('should generate UUIDs when threadId and runId are not provided', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: undefined, runId: undefined });
      const res = makeMockRes();

      await handler(req, res);

      const runStarted = mockEncoderInstance.encode.mock.calls[0][0];
      expect(runStarted.threadId).toBeTruthy();
      expect(runStarted.runId).toBeTruthy();
    });

    it('should emit RUN_ERROR and end response when stream throws', async () => {
      gthDeepAgentStreamWithEventsMock.mockImplementation(() => {
        throw new Error('Stream failed');
      });

      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'error-thread' });
      const res = makeMockRes();

      await handler(req, res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]);
      const errorEvent = events.find((e) => e.type === 'RUN_ERROR');
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toBe('Stream failed');
      expect(res.end).toHaveBeenCalled();
    });

    it('should emit RUN_ERROR with string message for non-Error throws', async () => {
      gthDeepAgentStreamWithEventsMock.mockImplementation(() => {
        throw 'something went wrong';
      });

      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'error-string-thread' });
      const res = makeMockRes();

      await handler(req, res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]);
      const errorEvent = events.find((e) => e.type === 'RUN_ERROR');
      expect(errorEvent!.message).toBe('something went wrong');
    });

    // ─── Client disconnect / abort ─────────────────────────────────────────

    it('should register a response close listener and pass an AbortSignal to streamWithEvents', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'abort-signal-thread' });
      const res = makeMockRes();

      await handler(req, res);

      // Must listen on the response, not the request: req 'close' fires as soon
      // as the POST body is consumed and would abort every run instantly.
      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
      const [, , signal] = gthDeepAgentStreamWithEventsMock.mock.calls[0];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    });

    it('should NOT abort the run on a normal completion (close after finish)', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'normal-complete-thread' });
      const res = makeMockRes();

      await handler(req, res);
      // Connection closes after the response finished — must not abort.
      res.emitClose();

      const [, , signal] = gthDeepAgentStreamWithEventsMock.mock.calls[0];
      expect(signal.aborted).toBe(false);
    });

    it('should pass an AbortSignal to streamWithEventsResume', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'abort-resume-thread',
        forwardedProps: { command: { resume: 'val' } },
      });

      await handler(req, makeMockRes());

      const [, , , signal] = gthDeepAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('should NOT emit RUN_ERROR when the run is aborted by client disconnect', async () => {
      const res = makeMockRes();
      // Simulate the client going away mid-stream: fire response 'close' (aborts
      // the signal) then surface the resulting AbortError out of the stream.
      gthDeepAgentStreamWithEventsMock.mockImplementation(() =>
        (async function* () {
          res.emitClose();
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        })()
      );

      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'aborted-run-thread' });

      await handler(req, res);

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]);
      expect(events.find((e) => e.type === 'RUN_ERROR')).toBeUndefined();
    });

    it('should emit TEXT_MESSAGE_CONTENT for each text event in the stream', async () => {
      gthDeepAgentStreamWithEventsMock.mockReturnValue(textStream('real', 'content'));

      const handler = await getRunHandler();
      const req = makeRunReq({ threadId: 'text-events-thread' });
      const res = makeMockRes();

      await handler(req, res);

      const contentEvents = mockEncoderInstance.encode.mock.calls
        .map((c) => c[0])
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');

      expect(contentEvents).toHaveLength(2);
      expect(contentEvents[0].delta).toBe('real');
      expect(contentEvents[1].delta).toBe('content');
    });

    it('should convert incoming messages to LangChain types', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'convert-msg-thread',
        messages: [
          { role: 'user', content: 'Hello', id: '1' },
          { role: 'assistant', content: 'Hi', id: '2' },
        ],
      });
      const res = makeMockRes();

      await handler(req, res);

      const [passedMessages] = gthDeepAgentStreamWithEventsMock.mock.calls[0];
      const roles = passedMessages.map((m: { role: string }) => m.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');
    });

    // ─── System prompt lives in the graph, not the request ─────────────────

    it('should NOT prepend a system message — the prompt lives in the deep-agent graph', async () => {
      // The system prompt (backstory + guidelines + mode prompt + identity) is set on the
      // deep-agent graph via createDeepAgent({ systemPrompt }); AG-UI must not inject a second,
      // non-first SystemMessage (Anthropic rejects that). The module no longer calls
      // buildSystemMessages at all.
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'fresh-thread-abc',
        messages: [{ role: 'user', content: 'Hey', id: '1' }],
      });

      await handler(req, makeMockRes());

      const [passedMessages] = gthDeepAgentStreamWithEventsMock.mock.calls[0];
      expect(passedMessages[0]).toMatchObject({ role: 'user' });
      expect(passedMessages.some((m: { role?: string }) => m.role === 'system')).toBe(false);
      expect(llmUtilsMock.buildSystemMessages).not.toHaveBeenCalled();
    });

    // ─── Frontend-fulfilled tool resume ────────────────────────────────────

    it('should route to streamWithEventsResume when forwardedProps.command.resume is present', async () => {
      gthDeepAgentStreamWithEventsResumeMock.mockReturnValue(textStream('resumed'));

      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'resume-thread',
        forwardedProps: {
          command: {
            resume: '{"mimeType":"image/jpeg","data":"AAA"}',
            interruptEvent: { toolCallId: 'tc-1', runId: 'run-1' },
          },
        },
      });
      const res = makeMockRes();

      await handler(req, res);

      expect(gthDeepAgentStreamWithEventsResumeMock).toHaveBeenCalledOnce();
      const [resumeValue] = gthDeepAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(resumeValue).toBe('{"mimeType":"image/jpeg","data":"AAA"}');
      expect(gthDeepAgentStreamWithEventsMock).not.toHaveBeenCalled();
    });

    it('should skip message conversion on resume (routes straight to resume)', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'fresh-resume-thread',
        // Even though messages are present, the resume branch must not convert/stream them.
        messages: [{ role: 'user', content: 'should be ignored', id: '1' }],
        forwardedProps: { command: { resume: 'value', interruptEvent: { toolCallId: 'tc-2' } } },
      });
      const res = makeMockRes();

      await handler(req, res);

      expect(gthDeepAgentStreamWithEventsMock).not.toHaveBeenCalled();
      expect(gthDeepAgentStreamWithEventsResumeMock).toHaveBeenCalledOnce();
    });

    it('should pass runConfig with thread_id to streamWithEventsResume', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'resume-thread-42',
        forwardedProps: { command: { resume: 'val' } },
      });

      await handler(req, makeMockRes());

      const [, runConfig] = gthDeepAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(runConfig.configurable).toMatchObject({ thread_id: 'resume-thread-42' });
    });

    it('should forward string queued messages as HumanMessages', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'queue-thread',
        forwardedProps: {
          command: { resume: 'val', queuedMessages: ['turn around', 'go slower'] },
        },
      });

      await handler(req, makeMockRes());

      const [, , queuedMessages] = gthDeepAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(queuedMessages).toHaveLength(2);
      expect(queuedMessages[0]).toMatchObject({ role: 'user', content: 'turn around' });
      expect(queuedMessages[1]).toMatchObject({ role: 'user', content: 'go slower' });
    });

    it('should pass an empty array when command.queuedMessages is absent', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'no-queue-thread',
        forwardedProps: { command: { resume: 'val' } },
      });

      await handler(req, makeMockRes());

      const [, , queuedMessages] = gthDeepAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(queuedMessages).toEqual([]);
    });
  });

  // ─── Client-tool dedup (run-input tools are authoritative) ─────────────────
  //
  // A server config may declare the same (client-fulfilled) tools the browser
  // sends as run-input — pukeko's robot tools do exactly this. Registering two
  // same-name client-tool instances makes LangChain v1's AgentNode throw
  // ("You have modified a tool ..."). getAgentForTools must drop the colliding
  // config.tools entry and keep only the run-input stub.

  describe('client-tool dedup', () => {
    async function startWithConfig(config: GthConfig) {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(config, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    // The per-toolset agent's init receives the merged config; find that call by
    // its tools array containing a client stub (flagged metadata.client). The
    // startup agent's init carries the raw config.tools (no client flag) and is skipped.
    function mergedToolsFromInit(): Array<{ name?: string; metadata?: { client?: boolean } }> {
      const reqInit = gthDeepAgentInitMock.mock.calls.find(
        ([, cfg]) =>
          Array.isArray((cfg as { tools?: unknown[] })?.tools) &&
          (cfg as { tools: Array<{ metadata?: { client?: boolean } }> }).tools.some(
            (t) => t?.metadata?.client
          )
      );
      expect(reqInit).toBeDefined();
      return (reqInit![1] as { tools: Array<{ name?: string; metadata?: { client?: boolean } }> })
        .tools;
    }

    it('drops the config.tools entry that collides with a run-input client tool', async () => {
      const config = {
        commands: { api: { port: 3000 } },
        tools: [
          { name: 'move_forward', description: 'server-declared' },
          { name: 'read_status', description: 'server-only' },
        ],
      } as unknown as GthConfig;

      const handler = await startWithConfig(config);
      const req = makeRunReq({
        threadId: 'dedup-thread',
        tools: [{ name: 'move_forward', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      const merged = mergedToolsFromInit();
      const names = merged.map((t) => t.name);

      // move_forward survives exactly once — the colliding server entry was dropped.
      expect(names.filter((n) => n === 'move_forward')).toHaveLength(1);
      // …and the survivor is the client stub, not the server-declared object.
      expect(merged.find((t) => t.name === 'move_forward')?.metadata?.client).toBe(true);
      // The non-colliding server tool is retained.
      expect(names).toContain('read_status');
    });

    it('keeps all server tools when the run-input tools do not collide', async () => {
      const config = {
        commands: { api: { port: 3000 } },
        tools: [{ name: 'read_status', description: 'server-only' }],
      } as unknown as GthConfig;

      const handler = await startWithConfig(config);
      const req = makeRunReq({
        threadId: 'no-collision-thread',
        tools: [{ name: 'capture_image', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      const names = mergedToolsFromInit().map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['read_status', 'capture_image']));
      expect(names).toHaveLength(2);
    });
  });

  // ─── B5: config-selectable agent backend ─────────────────────────────────────

  describe('agent backend selection (B5)', () => {
    async function startAndGetHandler(config: GthConfig) {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(config, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    it('uses the deep backend when agent.backend is undefined (default)', async () => {
      await startAndGetHandler(baseConfig);

      // The static server agent is constructed + initialized as a GthDeepAgent.
      expect(gthDeepAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(gthDeepAgentInitMock).toHaveBeenCalledWith('api', baseConfig, expect.anything());
      expect(gthLangChainAgentCtorMock).not.toHaveBeenCalled();
      expect(gthLangChainAgentInitMock).not.toHaveBeenCalled();
    });

    it("uses the deep backend for agent.backend: 'deep'", async () => {
      const config = {
        commands: { api: { port: 3000 } },
        agent: { backend: 'deep' },
      } as unknown as GthConfig;

      await startAndGetHandler(config);

      expect(gthDeepAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(gthDeepAgentInitMock).toHaveBeenCalledWith('api', config, expect.anything());
      expect(gthLangChainAgentCtorMock).not.toHaveBeenCalled();
    });

    it("uses the lean backend (GthLangChainAgent) for agent.backend: 'lean'", async () => {
      const config = {
        commands: { api: { port: 3000 } },
        agent: { backend: 'lean' },
      } as unknown as GthConfig;

      await startAndGetHandler(config);

      // The static server agent is now a GthLangChainAgent; the deep agent is never built.
      expect(gthLangChainAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(gthLangChainAgentInitMock).toHaveBeenCalledWith('api', config, expect.anything());
      expect(gthDeepAgentCtorMock).not.toHaveBeenCalled();
      expect(gthDeepAgentInitMock).not.toHaveBeenCalled();
    });

    it('routes the per-tool-set agent through the lean backend too', async () => {
      const config = {
        commands: { api: { port: 3000 } },
        agent: { backend: 'lean' },
      } as unknown as GthConfig;

      const handler = await startAndGetHandler(config);
      // A run that declares client tools builds a second, per-toolset agent via getAgentForTools.
      const req = makeRunReq({
        threadId: 'lean-tools-thread',
        tools: [{ name: 'capture_image', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      // Static agent + per-toolset agent — both lean, deep never constructed.
      expect(gthLangChainAgentCtorMock).toHaveBeenCalledTimes(2);
      expect(gthDeepAgentCtorMock).not.toHaveBeenCalled();
    });

    it('routes the per-tool-set agent through the deep backend by default', async () => {
      const handler = await startAndGetHandler(baseConfig);
      const req = makeRunReq({
        threadId: 'deep-tools-thread',
        tools: [{ name: 'capture_image', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      expect(gthDeepAgentCtorMock).toHaveBeenCalledTimes(2);
      expect(gthLangChainAgentCtorMock).not.toHaveBeenCalled();
    });
  });

  // ─── express.json body limit ─────────────────────────────────────────────

  it('should configure express.json with 5mb body limit', async () => {
    const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
    await startAgUiServer(baseConfig, 3000);

    expect(expressJsonMock).toHaveBeenCalledWith({ limit: '5mb' });
  });

  // ─── /health endpoint ──────────────────────────────────────────────────────

  describe('/health', () => {
    it('should respond with { status: ok }', async () => {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(baseConfig, 3000);

      // app.get('/health', handler) — first get() call
      const getHandler = mockGetFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => void;
      const res = makeMockRes();

      getHandler({}, res);

      expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
    });
  });
});
