import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { DeepAgentsServer } from 'deepagents-acp';
import type { GthConfig } from '#src/config.js';

/**
 * CFG-33 — the ACP front door must never print Gemini's thinking as the assistant's answer.
 *
 * `gaunt-sloth-acp` hands the constructed model straight to `deepagents-acp`, which routes content
 * blocks itself: a block typed `thinking` becomes an `agent_thought_chunk`, and EVERYTHING typed
 * `text` becomes an `agent_message_chunk`. Gemini's thought summary is typed `text` (it is marked
 * only by `thought: true`), so on that path the model's private reasoning would print into the IDE
 * as answer text on every turn. gsloth's own reasoning bridge cannot help — nothing on this path
 * goes through `GthAbstractAgent`.
 *
 * These assertions DRIVE that, rather than inferring it. A fake Gemini endpoint behaves like the
 * real API — it returns a thought part only when the request asked for one — so the whole mechanism
 * runs: the real preset builds the model, the real ACP entry hands it over, the real
 * `@langchain/google` builds the request and parses the response, and the real `DeepAgentsServer`
 * routes the resulting message. The assertion is on what an ACP client would actually receive.
 */

// The ACP server wrapper: capture the options the ACP entry hands it (which carry the model).
const startServerMock = vi.fn();
vi.mock('#src/core/gthAcpServer.js', () => ({
  startGthAcpServer: startServerMock,
}));

// GthDeepAgent: only its params matter here, and the model in them is the real one built below.
const buildDeepAgentParamsMock = vi.fn();
vi.mock('#src/core/GthDeepAgent.js', () => {
  const GthDeepAgent = vi.fn(function (this: unknown) {});
  GthDeepAgent.prototype.buildDeepAgentParams = buildDeepAgentParamsMock;
  return { GthDeepAgent };
});

vi.mock('#src/resolvers.js', () => ({
  createResolvers: () => ({ resolveTools: vi.fn() }),
}));

const THOUGHT_TEXT = 'MY PRIVATE THINKING about the user';
const ANSWER_TEXT = 'There are 9 sheep left.';

/** Request bodies the model actually put on the wire, in call order. */
type WireBody = {
  generationConfig?: { thinkingConfig?: Record<string, unknown> };
};

/**
 * A fake Gemini endpoint with the API's own contract: a thought summary comes back ONLY when
 * `generationConfig.thinkingConfig.includeThoughts` asked for one. That is what makes this test
 * measure the fix rather than a mock — asking or not asking is the whole difference.
 */
function stubGeminiEndpoint(): WireBody[] {
  const bodies: WireBody[] = [];
  vi.stubGlobal('fetch', async (request: Request): Promise<Response> => {
    const body = JSON.parse(await request.text()) as WireBody;
    bodies.push(body);
    const includeThoughts = body.generationConfig?.thinkingConfig?.includeThoughts === true;
    const parts = includeThoughts
      ? [{ text: THOUGHT_TEXT, thought: true }, { text: ANSWER_TEXT }]
      : [{ text: ANSWER_TEXT }];
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 11,
          totalTokenCount: 23,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
  return bodies;
}

type InvokableModel = { invoke: (_input: string) => Promise<AIMessage> };

/**
 * Run the real ACP entry over a real google-genai model and return the model it handed to
 * `deepagents-acp` — i.e. exactly the object the third party will drive.
 */
async function modelHandedToAcp(llm: Record<string, unknown> = {}): Promise<InvokableModel> {
  const { processJsonConfig } = await import('@gaunt-sloth/core/providers/google-genai.js');
  const model = await processJsonConfig({
    apiKey: 'test-key',
    model: 'gemini-3.6-flash',
    ...llm,
  } as never);
  buildDeepAgentParamsMock.mockResolvedValue({
    model,
    tools: [],
    middleware: [],
    permissions: [],
    systemPrompt: 'SYSTEM PROMPT',
  });
  const { startAcpServer } = await import('#src/modules/acpModule.js');
  await startAcpServer({ llm: model, filesystem: 'all' } as unknown as GthConfig);
  return startServerMock.mock.calls[0][0].agents.model;
}

type SessionUpdate = {
  update: { sessionUpdate: string; content?: { type?: string; text?: string } };
};

/** Drive the REAL deepagents-acp server with a message and collect what the ACP client would see. */
async function routeThroughAcpServer(model: unknown, message: AIMessage): Promise<SessionUpdate[]> {
  const server = new DeepAgentsServer({
    agents: { name: 'gaunt-sloth', model, tools: [] },
  } as never);
  const updates: SessionUpdate[] = [];
  const conn = {
    sessionUpdate: async (notification: SessionUpdate) => {
      updates.push(notification);
    },
  };
  await (
    server as unknown as {
      handleAIMessage: (
        _session: unknown,
        _message: unknown,
        _activeToolCalls: Map<string, unknown>,
        _conn: unknown
      ) => Promise<void>;
    }
  ).handleAIMessage({ id: 'session-1' }, message, new Map(), conn);
  return updates;
}

function textOf(updates: SessionUpdate[], kind: string): string {
  return updates
    .filter((u) => u.update.sessionUpdate === kind)
    .map((u) => u.update.content?.text ?? '')
    .join('');
}

describe('gaunt-sloth-acp never renders Gemini thinking as the answer (CFG-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    startServerMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not send the thought summary to the ACP client as assistant text', async () => {
    const bodies = stubGeminiEndpoint();
    const model = await modelHandedToAcp();

    // The real model, the real request, the real response parsing.
    const message = (await model.invoke(
      'A farmer has 17 sheep and all but 9 run away. How many are left?'
    )) as AIMessage;

    const updates = await routeThroughAcpServer(model, message);

    // The harm: private thinking arriving as the assistant's answer in the IDE.
    expect(textOf(updates, 'agent_message_chunk')).not.toContain(THOUGHT_TEXT);
    // …while the answer still gets through, so this is not passing by sending nothing.
    expect(textOf(updates, 'agent_message_chunk')).toContain(ANSWER_TEXT);
    // Cheap corroboration of the mechanism: the request itself declined summaries.
    expect(bodies[0]?.generationConfig?.thinkingConfig).toMatchObject({ includeThoughts: false });
  });

  it('leaves thinking itself ON — it withholds the summary, it does not stop the model thinking', async () => {
    const bodies = stubGeminiEndpoint();
    const model = await modelHandedToAcp();
    await model.invoke('hi');

    const thinkingConfig = bodies[0]?.generationConfig?.thinkingConfig ?? {};
    expect(thinkingConfig.includeThoughts).toBe(false);
    // A zero/minimal budget would turn thinking OFF, which is a different (and unwanted) change.
    expect(thinkingConfig.thinkingBudget).toBeUndefined();
    expect(thinkingConfig.thinkingLevel).toBeUndefined();
  });

  it('honours a configured thinking level while still withholding the summary', async () => {
    const bodies = stubGeminiEndpoint();
    const model = await modelHandedToAcp({ thinkingLevel: 'low' });
    await model.invoke('hi');

    expect(bodies[0]?.generationConfig?.thinkingConfig).toMatchObject({
      includeThoughts: false,
      thinkingLevel: 'LOW',
    });
  });

  /**
   * CFG-42 — the families the ENABLE path skips are not families the disable path may skip.
   * `@langchain/google` sets `includeThoughts: true` itself for a 3.x image/tts model once a budget
   * is configured, so a shared "does this model produce summaries?" guard let exactly those
   * summaries reach the IDE as answer text. Driven end-to-end, like the case above.
   */
  it('withholds the summary on an image model, where the library asks for one itself', async () => {
    const bodies = stubGeminiEndpoint();
    const model = await modelHandedToAcp({
      model: 'gemini-3.6-flash-image',
      thinkingBudget: 8192,
    });

    const message = (await model.invoke('draw the sheep')) as AIMessage;
    const updates = await routeThroughAcpServer(model, message);

    expect(bodies[0]?.generationConfig?.thinkingConfig).toMatchObject({ includeThoughts: false });
    expect(textOf(updates, 'agent_message_chunk')).not.toContain(THOUGHT_TEXT);
    expect(textOf(updates, 'agent_message_chunk')).toContain(ANSWER_TEXT);
  });

  it('control: deepagents-acp DOES route a properly typed thinking block to the thought channel', async () => {
    stubGeminiEndpoint();
    const model = await modelHandedToAcp();
    // Anthropic's shape — the one the third party recognises. This proves the harness can see the
    // difference, so the assertion above is about the block shape and not about an inert harness.
    const message = new AIMessage({
      content: [
        { type: 'thinking', thinking: 'anthropic thoughts' },
        { type: 'text', text: 'anthropic answer' },
      ] as never,
    });

    const updates = await routeThroughAcpServer(model, message);

    expect(textOf(updates, 'agent_thought_chunk')).toContain('anthropic thoughts');
    expect(textOf(updates, 'agent_message_chunk')).toBe('anthropic answer');
  });
});
