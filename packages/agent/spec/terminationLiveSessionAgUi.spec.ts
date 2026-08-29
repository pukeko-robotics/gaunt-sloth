/**
 * [[EXT-159]] — **the reason reaches the live session on the AG-UI surface** (a browser client).
 *
 * This surface is the one an enumeration built from the runner's callers would have missed: it
 * drives `agent.streamWithEvents` directly and holds no `GthAgentRunner` at all. It is also the
 * surface where the flattening was most complete — a fault reached the browser as `RUN_ERROR` with
 * the provider's sentence and nothing else, and a turn that ended without throwing reached it as an
 * ordinary `RUN_FINISHED`.
 *
 * Both channels here are structured protocol fields rather than prose: `RUN_FINISHED.result`, which
 * the protocol leaves open, and `RUN_ERROR.code`. A client reads the classification without parsing
 * a sentence, which is the acceptance clause about no user-facing string being the only carrier.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GthConfig } from '#src/config.js';
import {
  attachTerminationReason,
  terminationReason,
} from '@gaunt-sloth/core/core/terminationReason.js';

vi.mock('#src/utils/consoleUtils.js', () => ({
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  defaultStatusCallback: vi.fn(),
}));

vi.mock('#src/utils/llmUtils.js', () => ({
  getNewRunnableConfig: vi.fn().mockReturnValue({}),
  buildSystemMessages: vi.fn().mockReturnValue([]),
  readChatPrompt: vi.fn().mockReturnValue(''),
}));

vi.mock('@langchain/langgraph', () => ({ MemorySaver: vi.fn() }));

const initMock = vi.hoisted(() => vi.fn());
const streamWithEventsMock = vi.hoisted(() => vi.fn());
const getTerminationReasonMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/core/GthLangChainAgent.js', () => {
  const GthLangChainAgent = vi.fn(function () {});
  GthLangChainAgent.prototype.init = initMock;
  GthLangChainAgent.prototype.streamWithEvents = streamWithEventsMock;
  GthLangChainAgent.prototype.streamWithEventsResume = vi.fn();
  GthLangChainAgent.prototype.getTerminationReason = getTerminationReasonMock;
  return { GthLangChainAgent };
});

const mockPostFn = vi.hoisted(() => vi.fn());
vi.mock('express', () => {
  // `listen` must invoke its callback: `startAgUiServer` awaits it, and a mock that never calls
  // back leaves every cell here hanging on a promise that cannot settle.
  const app = {
    use: vi.fn(),
    post: mockPostFn,
    get: vi.fn(),
    listen: vi.fn((_port: number, cb: () => void) => cb()),
  };
  const express = Object.assign(
    vi.fn(() => app),
    { json: vi.fn(() => 'json-middleware') }
  );
  return { default: express };
});

const encoded = vi.hoisted(() => [] as unknown[]);
vi.mock('@ag-ui/encoder', () => ({
  EventEncoder: vi.fn(function () {
    return {
      getContentType: vi.fn(() => 'text/event-stream'),
      encode: vi.fn((event: unknown) => {
        encoded.push(event);
        return JSON.stringify(event);
      }),
    };
  }),
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

vi.mock('@langchain/core/messages', () => ({
  HumanMessage: vi.fn(function (this: Record<string, unknown>, content: string) {
    this.role = 'user';
    this.content = content;
  }),
  AIMessage: vi.fn(function () {}),
  SystemMessage: vi.fn(function () {}),
  ToolMessage: vi.fn(function () {}),
}));

const baseConfig = { commands: { api: { port: 3000 } } } as Partial<GthConfig> as GthConfig;

function makeRes() {
  return {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
    on: vi.fn(),
  };
}

const req = () => ({
  body: { threadId: 't1', runId: 'r1', messages: [] },
  headers: { accept: 'text/event-stream' },
  method: 'POST',
});

async function runHandler() {
  const { startAgUiServer } = await import('#src/modules/apiAgUiModule.js');
  await startAgUiServer(baseConfig, 3000);
  const handler = mockPostFn.mock.calls[0][1] as (r: unknown, s: unknown) => Promise<void>;
  await handler(req(), makeRes());
}

const eventOfType = (type: string) =>
  encoded.find((event) => (event as { type?: string }).type === type) as
    Record<string, unknown> | undefined;

describe('[[EXT-159]] SURFACE — AG-UI carries the reason to the browser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encoded.length = 0;
    initMock.mockResolvedValue(undefined);
    streamWithEventsMock.mockReturnValue((async function* () {})());
    getTerminationReasonMock.mockReturnValue(null);
  });

  it('puts the reason on RUN_FINISHED for a turn that ended without throwing', async () => {
    getTerminationReasonMock.mockReturnValue(
      terminationReason('agent.events-stop-metadata', 'metadata', {
        category: 'output_truncated',
        detail: 'length',
      })
    );

    await runHandler();

    expect(eventOfType('RUN_FINISHED')).toMatchObject({
      result: {
        termination: {
          reason: { category: 'output_truncated', site: 'agent.events-stop-metadata' },
        },
      },
    });
  });

  it('leaves RUN_FINISHED alone when the model simply finished', async () => {
    getTerminationReasonMock.mockReturnValue(
      terminationReason('runner.events-completed', 'control', 'completed')
    );

    await runHandler();

    expect(eventOfType('RUN_FINISHED')).not.toHaveProperty('result');
  });

  /**
   * The reason is read off the ERROR before the agent is asked. It was attached there by the site
   * that classified the failure, and that inner site's answer outranks anything a later reader can
   * derive — the same first-write-wins precedence the carrier is built on.
   */
  it('puts the quotable code on RUN_ERROR, taken from the error the site classified', async () => {
    const failure = attachTerminationReason(
      new Error('429 Too Many Requests'),
      terminationReason('runner.events-error', 'exception', { category: 'rate_limited' })
    );
    streamWithEventsMock.mockReturnValue(
      (async function* () {
        throw failure;
      })()
    );

    await runHandler();

    expect(eventOfType('RUN_ERROR')).toMatchObject({
      message: expect.stringContaining('429'),
      code: 'rate_limited@runner.events-error',
    });
  });

  it('sends no code at all when nothing classified the failure', async () => {
    streamWithEventsMock.mockReturnValue(
      (async function* () {
        throw new Error('something');
      })()
    );

    await runHandler();

    expect(eventOfType('RUN_ERROR')).not.toHaveProperty('code');
  });
});
