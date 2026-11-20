import { beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the REAL `@langchain/anthropic` ChatAnthropic: only its SDK client is replaced, through the
// `createClient` seam, so the assertions read the request body ChatAnthropic would send.

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const fileUtilsMock = {
  writeConfigFileWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

// A model that is not adaptive-only, so ChatAnthropic itself would put a configured sampling value on
// the request. On an adaptive-only model it strips them on its own and these specs could not fail.
const MODEL = 'claude-haiku-4-5-20251001';

const SAMPLING_KEYS = ['temperature', 'top_p', 'top_k', 'topP', 'topK'];

const capturedBodies: Record<string, unknown>[] = [];

function fakeCreateClient() {
  return {
    messages: {
      create: async (body: Record<string, unknown>) => {
        capturedBodies.push(body);
        return {
          id: 'msg_fake',
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
}

function buildConfig(overrides: Record<string, unknown>) {
  return {
    type: 'anthropic',
    apiKey: 'test-key',
    model: MODEL,
    createClient: fakeCreateClient,
    ...overrides,
  };
}

async function sendThroughProvider(overrides: Record<string, unknown>) {
  const { processJsonConfig } = await import('#src/providers/anthropic.js');

  const llm = await processJsonConfig(buildConfig(overrides) as any);
  await llm.invoke('hi');
  expect(capturedBodies).toHaveLength(1);
  return { llm, body: capturedBodies[0] };
}

function samplingKeysIn(body: Record<string, unknown>): string[] {
  return SAMPLING_KEYS.filter((key) => key in body);
}

describe('anthropic provider drops sampling settings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    capturedBodies.length = 0;
    systemUtilsMock.env = {};
  });

  it('the capture can see a sampling field: an unfiltered ChatAnthropic sends temperature 0', async () => {
    // Positive control for every absence assertion below.
    const { ChatAnthropic } = await import('@langchain/anthropic');
    const llm = new ChatAnthropic({
      apiKey: 'test-key',
      model: MODEL,
      temperature: 0,
      topP: 0.5,
      topK: 3,
      invocationKwargs: { top_p: 0.25 },

      createClient: fakeCreateClient as any,
    });
    await llm.invoke('hi');
    expect(capturedBodies[0].temperature).toBe(0);
    expect(capturedBodies[0].top_k).toBe(3);
    expect(capturedBodies[0].top_p).toBe(0.25);
  });

  it.each([
    ['temperature', { temperature: 0 }, 'temperature 0'],
    ['the default temperature', { temperature: 1 }, 'temperature 1'],
    ['topP', { topP: 0.9 }, 'topP 0.9'],
    ['topK', { topK: 5 }, 'topK 5'],
    [
      'invocationKwargs.temperature',
      { invocationKwargs: { temperature: 0 } },
      'invocationKwargs.temperature 0',
    ],
    ['invocationKwargs.top_p', { invocationKwargs: { top_p: 0.5 } }, 'invocationKwargs.top_p 0.5'],
    ['invocationKwargs.top_k', { invocationKwargs: { top_k: 7 } }, 'invocationKwargs.top_k 7'],
  ])('drops %s from the request and warns once naming it', async (_label, setting, named) => {
    const { body } = await sendThroughProvider(setting);

    expect(samplingKeysIn(body)).toEqual([]);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const warning = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    expect(warning).toContain(named);
    expect(warning).toContain(MODEL);
  });

  it('names every dropped setting in one warning and keeps other invocationKwargs', async () => {
    const { body } = await sendThroughProvider({
      temperature: 0,
      topP: 0.9,
      topK: 5,
      invocationKwargs: { top_p: 0.5, metadata: { user_id: 'u1' } },
    });

    expect(samplingKeysIn(body)).toEqual([]);
    expect(body.metadata).toEqual({ user_id: 'u1' });
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    const warning = consoleUtilsMock.displayWarning.mock.calls[0][0] as string;
    for (const named of ['temperature 0', 'topP 0.9', 'topK 5', 'invocationKwargs.top_p 0.5']) {
      expect(warning).toContain(named);
    }
  });

  it('without any sampling setting: no warning, and ChatAnthropic adds no default', async () => {
    const { body } = await sendThroughProvider({ maxTokens: 64 });

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(samplingKeysIn(body)).toEqual([]);
    expect(body.model).toBe(MODEL);
    expect(body.max_tokens).toBe(64);
  });

  it('does not mutate the config object it was given', async () => {
    const { processJsonConfig } = await import('#src/providers/anthropic.js');
    const config = buildConfig({ temperature: 0, invocationKwargs: { top_k: 2 } });

    await processJsonConfig(config as any);

    expect(config.temperature).toBe(0);
    expect(config.invocationKwargs).toEqual({ top_k: 2 });
  });

  it('spellings ChatAnthropic never reads reach no request and raise no warning', async () => {
    // Pins the routes this fix deliberately leaves alone: a top-level snake_case spelling and a
    // `modelKwargs` block. If a future ChatAnthropic starts reading one, this goes red.
    const { body } = await sendThroughProvider({
      top_p: 0.5,
      top_k: 3,
      modelKwargs: { temperature: 0, top_p: 0.5 },
    });

    expect(samplingKeysIn(body)).toEqual([]);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('a built ChatAnthropic is recognised, and its temperature field reaches the request', async () => {
    // The premise of the `exec -t` guard: the field is an own property even when unset, so an
    // `in` check passes and an assignment after the build goes straight onto the request.
    const { isAnthropicChatModel } = await import('#src/providers/anthropicSampling.js');
    const { llm } = await sendThroughProvider({});
    capturedBodies.length = 0;

    expect(isAnthropicChatModel(llm)).toBe(true);
    expect('temperature' in llm).toBe(true);
    (llm as unknown as { temperature: number }).temperature = 0;
    await llm.invoke('hi');
    expect(capturedBodies[0].temperature).toBe(0);
  });

  it('isAnthropicChatModel is false for other models and non-models', async () => {
    const { isAnthropicChatModel } = await import('#src/providers/anthropicSampling.js');
    expect(isAnthropicChatModel({ _llmType: () => 'openai' })).toBe(false);
    expect(isAnthropicChatModel({ temperature: 0 })).toBe(false);
    expect(isAnthropicChatModel(undefined)).toBe(false);
  });
});
