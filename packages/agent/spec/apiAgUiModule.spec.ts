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
      gthLangChainAgentStreamWithEventsMock.mockReturnValue(textStream('Hello', ' world'));

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
      gthLangChainAgentStreamWithEventsMock.mockReturnValue(
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
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => {
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
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => {
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
      const [, , signal] = gthLangChainAgentStreamWithEventsMock.mock.calls[0];
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

      const [, , signal] = gthLangChainAgentStreamWithEventsMock.mock.calls[0];
      expect(signal.aborted).toBe(false);
    });

    it('should pass an AbortSignal to streamWithEventsResume', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'abort-resume-thread',
        forwardedProps: { command: { resume: 'val' } },
      });

      await handler(req, makeMockRes());

      const [, , , signal] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(signal).toBeInstanceOf(AbortSignal);
    });

    it('should NOT emit RUN_ERROR when the run is aborted by client disconnect', async () => {
      const res = makeMockRes();
      // Simulate the client going away mid-stream: fire response 'close' (aborts
      // the signal) then surface the resulting AbortError out of the stream.
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() =>
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
      gthLangChainAgentStreamWithEventsMock.mockReturnValue(textStream('real', 'content'));

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

      const [passedMessages] = gthLangChainAgentStreamWithEventsMock.mock.calls[0];
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

      const [passedMessages] = gthLangChainAgentStreamWithEventsMock.mock.calls[0];
      expect(passedMessages[0]).toMatchObject({ role: 'user' });
      expect(passedMessages.some((m: { role?: string }) => m.role === 'system')).toBe(false);
      expect(llmUtilsMock.buildSystemMessages).not.toHaveBeenCalled();
    });

    // ─── Frontend-fulfilled tool resume ────────────────────────────────────

    it('should route to streamWithEventsResume when forwardedProps.command.resume is present', async () => {
      gthLangChainAgentStreamWithEventsResumeMock.mockReturnValue(textStream('resumed'));

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

      expect(gthLangChainAgentStreamWithEventsResumeMock).toHaveBeenCalledOnce();
      const [resumeValue] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(resumeValue).toBe('{"mimeType":"image/jpeg","data":"AAA"}');
      expect(gthLangChainAgentStreamWithEventsMock).not.toHaveBeenCalled();
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

      expect(gthLangChainAgentStreamWithEventsMock).not.toHaveBeenCalled();
      expect(gthLangChainAgentStreamWithEventsResumeMock).toHaveBeenCalledOnce();
    });

    it('should pass runConfig with thread_id to streamWithEventsResume', async () => {
      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'resume-thread-42',
        forwardedProps: { command: { resume: 'val' } },
      });

      await handler(req, makeMockRes());

      const [, runConfig] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls[0];
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

      const [, , queuedMessages] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls[0];
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

      const [, , queuedMessages] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls[0];
      expect(queuedMessages).toEqual([]);
    });
  });

  // ─── Checkpoint thread rotation ────────────────────────────────────────────
  //
  // The client replays its whole history every turn, and a replayed message carries no id the
  // checkpoint recognises, so `add_messages` mints one and appends rather than reconciling.
  // Sharing a single checkpoint thread across turns therefore stacks each turn's replay onto the
  // previous turn's state; once that history contains a tool result the duplicate puts two
  // `tool_result` blocks under one `tool_use` id, which the provider rejects and which kills the
  // thread permanently. A fresh run must get a fresh checkpoint thread. A resume must NOT — it has
  // to reach the graph that is actually suspended.

  describe('checkpoint thread rotation', () => {
    async function getHandler() {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(baseConfig, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    function configurableOf(call: unknown[]): { thread_id: string } {
      return (call[1] as { configurable: { thread_id: string } }).configurable;
    }

    function runThreadIds(): string[] {
      return gthLangChainAgentStreamWithEventsMock.mock.calls.map(
        (c) => configurableOf(c).thread_id
      );
    }

    it('gives two fresh runs on one client thread different checkpoint threads', async () => {
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => emptyStream());
      const handler = await getHandler();

      await handler(makeRunReq({ threadId: 'chat-1', runId: 'r1' }), makeMockRes());
      await handler(makeRunReq({ threadId: 'chat-1', runId: 'r2' }), makeMockRes());

      const [first, second] = runThreadIds();
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      // Keying both turns on 'chat-1' is the defect: turn 2's replay lands on turn 1's state.
      expect(second).not.toBe(first);
      expect([first, second]).not.toContain('chat-1');
    });

    it('resumes onto the checkpoint thread its interrupted run used', async () => {
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => emptyStream());
      gthLangChainAgentStreamWithEventsResumeMock.mockImplementation(() => emptyStream());
      const handler = await getHandler();

      // The run that suspends at a client tool, then the client's resume carrying its result.
      await handler(makeRunReq({ threadId: 'chat-2', runId: 'r1' }), makeMockRes());
      await handler(
        makeRunReq({
          threadId: 'chat-2',
          runId: 'r2',
          forwardedProps: { command: { resume: '{"mimeType":"image/jpeg","data":"AAA"}' } },
        }),
        makeMockRes()
      );

      // Rotating on a resume would strand it on an empty thread with no suspended graph, so this
      // is the constraint that stops the rotation being "simplified" to a per-request id.
      const [resumeCall] = gthLangChainAgentStreamWithEventsResumeMock.mock.calls;
      expect(configurableOf(resumeCall).thread_id).toBe(runThreadIds()[0]);
    });

    it('rotates again for the turn that follows a resume', async () => {
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => emptyStream());
      gthLangChainAgentStreamWithEventsResumeMock.mockImplementation(() => emptyStream());
      const handler = await getHandler();

      // The live sequence behind the bug: capture turn, its resume, then the next user message
      // replaying a history that now contains the capture's tool result.
      await handler(makeRunReq({ threadId: 'chat-3', runId: 'r1' }), makeMockRes());
      await handler(
        makeRunReq({
          threadId: 'chat-3',
          runId: 'r2',
          forwardedProps: { command: { resume: 'ok' } },
        }),
        makeMockRes()
      );
      await handler(
        makeRunReq({
          threadId: 'chat-3',
          runId: 'r3',
          messages: [{ role: 'user', content: 'save it to the desktop', id: 'm1' }],
        }),
        makeMockRes()
      );

      const [capture, followUp] = runThreadIds();
      expect(followUp).not.toBe(capture);
    });

    it('keeps the client threadId as the protocol identity the events report', async () => {
      gthLangChainAgentStreamWithEventsMock.mockImplementation(() => emptyStream());
      const handler = await getHandler();

      await handler(makeRunReq({ threadId: 'chat-4', runId: 'r1' }), makeMockRes());

      const events = mockEncoderInstance.encode.mock.calls.map((c) => c[0]) as Array<
        Record<string, unknown>
      >;
      // Only the checkpoint key rotates; the client must still recognise its own thread.
      expect(events.find((e) => e.type === 'RUN_STARTED')).toMatchObject({ threadId: 'chat-4' });
      expect(events.find((e) => e.type === 'RUN_FINISHED')).toMatchObject({ threadId: 'chat-4' });
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
      const reqInit = gthLangChainAgentInitMock.mock.calls.find(
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

  // ─── RC-33: never echo a tool result the client itself supplied ────────────
  //
  // `@ag-ui/client` splices a TOOL_CALL_RESULT into its history without checking whether a tool
  // message for that toolCallId is already there, so echoing back a client-fulfilled tool's result
  // leaves the client holding two results under one tool_use id — and the provider 400s on the
  // next turn. A server-side tool's result must still be echoed: that is the client's only way to
  // learn it.

  describe('client-fulfilled tool result echo (RC-33)', () => {
    const CLIENT_TOOLS = [
      { name: 'capture_image', parameters: { type: 'object', properties: {} } },
    ];

    function toolResultStream(...ids: string[]) {
      return (async function* () {
        for (const id of ids) {
          yield { type: 'tool_result' as const, id, content: `result of ${id}` };
        }
      })();
    }

    function resultIds() {
      return mockEncoderInstance.encode.mock.calls
        .map((c) => c[0])
        .filter((e) => e.type === 'TOOL_CALL_RESULT')
        .map((e) => e.toolCallId);
    }

    async function getRunHandler() {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(baseConfig, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    /** The CopilotKit implicit-resume shape: full history, trailing client-fulfilled tool result. */
    function resumeReq(threadId: string) {
      return makeRunReq({
        threadId,
        tools: CLIENT_TOOLS,
        messages: [
          { id: 'm1', role: 'user', content: 'Take a photo.' },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call-client',
                type: 'function',
                function: { name: 'capture_image', arguments: '{}' },
              },
            ],
          },
          {
            id: 'm3',
            role: 'tool',
            toolCallId: 'call-client',
            content: '{"mimeType":"image/png","data":"QUFBQg=="}',
          },
        ],
      });
    }

    it('does not echo the result of the tool call the client fulfilled', async () => {
      gthLangChainAgentStreamWithEventsResumeMock.mockReturnValue(toolResultStream('call-client'));

      const handler = await getRunHandler();
      await handler(resumeReq('rc33-suppress'), makeMockRes());

      expect(resultIds()).not.toContain('call-client');
    });

    it('still echoes a server-side tool result in the same resumed run', async () => {
      gthLangChainAgentStreamWithEventsResumeMock.mockReturnValue(
        toolResultStream('call-client', 'call-server')
      );

      const handler = await getRunHandler();
      await handler(resumeReq('rc33-mixed'), makeMockRes());

      // Exactly the server-side one survives — the suppression is targeted, not a blanket mute.
      expect(resultIds()).toEqual(['call-server']);
    });

    it('echoes every tool result on a fresh run, where the client holds none of them', async () => {
      gthLangChainAgentStreamWithEventsMock.mockReturnValue(toolResultStream('call-a', 'call-b'));

      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'rc33-fresh',
        messages: [{ id: 'm1', role: 'user', content: 'List the files.' }],
      });
      await handler(req, makeMockRes());

      expect(resultIds()).toEqual(['call-a', 'call-b']);
    });

    it('suppresses by the id the client sent, not by position in the history', async () => {
      // A history whose client-held result sits mid-conversation rather than last: the guard is
      // keyed on the ids present in the request, so it holds wherever they appear.
      gthLangChainAgentStreamWithEventsMock.mockReturnValue(
        toolResultStream('call-old', 'call-new')
      );

      const handler = await getRunHandler();
      const req = makeRunReq({
        threadId: 'rc33-midhistory',
        tools: CLIENT_TOOLS,
        messages: [
          { id: 'm1', role: 'user', content: 'Take a photo.' },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'call-old',
                type: 'function',
                function: { name: 'capture_image', arguments: '{}' },
              },
            ],
          },
          {
            id: 'm3',
            role: 'tool',
            toolCallId: 'call-old',
            content: '{"mimeType":"image/png","data":"QQ=="}',
          },
          { id: 'm4', role: 'assistant', content: 'Got the photo.' },
          { id: 'm5', role: 'user', content: 'save to downloads' },
        ],
      });
      await handler(req, makeMockRes());

      expect(resultIds()).toEqual(['call-new']);
    });
  });

  // ─── RC-22: config.middleware reaches the per-toolset (client-tool) agent ───
  //
  // `capture_image` runs ONLY on the per-request client-tool agent that getAgentForTools builds
  // (reqConfig = { ...config, tools: [...] }). The frontend-image-injection middleware therefore
  // only fires there if the `{ ...config }` spread carries `config.middleware` into that agent's
  // init. This asserts the spread survives; that the middleware then actually fires and reaches the
  // model input is proven hermetically in frontendImageInjectionWiring.spec.ts.

  describe('client-tool agent middleware spread (RC-22)', () => {
    async function startWithConfig(config: GthConfig) {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(config, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    it('spreads config.middleware into the per-toolset agent init for a capture_image client tool', async () => {
      const config = {
        commands: { api: { port: 3000 } },
        middleware: ['frontend-image-injection'],
      } as unknown as GthConfig;

      const handler = await startWithConfig(config);
      const req = makeRunReq({
        threadId: 'mw-spread-thread',
        tools: [{ name: 'capture_image', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      // The per-toolset agent's init is the one whose config.tools carries a client-flagged stub;
      // the static startup agent's init carries the raw config.tools (no client flag).
      const reqInit = gthLangChainAgentInitMock.mock.calls.find(
        ([, cfg]) =>
          Array.isArray((cfg as { tools?: unknown[] })?.tools) &&
          (cfg as { tools: Array<{ metadata?: { client?: boolean } }> }).tools.some(
            (t) => t?.metadata?.client
          )
      );
      expect(reqInit).toBeDefined();
      expect((reqInit![1] as { middleware?: unknown[] }).middleware).toContain(
        'frontend-image-injection'
      );
    });
  });

  // ─── B5: config-selectable agent backend ─────────────────────────────────────

  describe('agent backend selection (B5)', () => {
    async function startAndGetHandler(config: GthConfig) {
      const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
      await startAgUiServer(config, 3000);
      return mockPostFn.mock.calls[0][1] as (_req: unknown, _res: unknown) => Promise<void>;
    }

    it('uses the lean backend when agent.backend is undefined (default)', async () => {
      await startAndGetHandler(baseConfig);

      // Lean is the default: the static server agent is a GthLangChainAgent; deep is never built.
      expect(gthLangChainAgentCtorMock).toHaveBeenCalledTimes(1);
      expect(gthLangChainAgentInitMock).toHaveBeenCalledWith('api', baseConfig, expect.anything());
      expect(gthDeepAgentCtorMock).not.toHaveBeenCalled();
      expect(gthDeepAgentInitMock).not.toHaveBeenCalled();
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

    it('routes the per-tool-set agent through the lean backend by default', async () => {
      const handler = await startAndGetHandler(baseConfig);
      const req = makeRunReq({
        threadId: 'default-tools-thread',
        tools: [{ name: 'capture_image', parameters: { type: 'object', properties: {} } }],
      });

      await handler(req, makeMockRes());

      // Static agent + per-toolset agent — both lean by default, deep never constructed.
      expect(gthLangChainAgentCtorMock).toHaveBeenCalledTimes(2);
      expect(gthDeepAgentCtorMock).not.toHaveBeenCalled();
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
