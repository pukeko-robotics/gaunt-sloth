import { beforeEach, describe, expect, it, vi } from 'vitest';

// TUI-C22 — capture the config object ChatOpenAI is constructed with so we can assert the
// OpenRouter provider enables __includeRawResponse (the only supported way to reach a top-level
// `reasoning` field the ChatOpenAI completions converter otherwise drops).
const chatOpenAIConstructorMock = vi.fn();
vi.mock('@langchain/openai', () => {
  class ChatOpenAI {
    constructor(config: unknown) {
      chatOpenAIConstructorMock(config);
    }
  }
  return { ChatOpenAI };
});

const consoleUtilsMock = {
  displayWarning: vi.fn(),
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

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { type: 'openrouter', apiKey: 'test-key', model: 'x-ai/grok', ...overrides };
}

describe('openrouter provider — TUI-C22 raw-response reasoning wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('enables __includeRawResponse by default so a top-level `reasoning` field is reachable', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig(buildConfig() as any);

    expect(chatOpenAIConstructorMock).toHaveBeenCalledTimes(1);
    const built = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(built.__includeRawResponse).toBe(true);
    // The OpenRouter base URL wiring is untouched by this change.
    expect(built.configuration.baseURL).toBe('https://openrouter.ai/api/v1');
  });

  it('honours an explicit __includeRawResponse: false override', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig(buildConfig({ __includeRawResponse: false }) as any);

    const built = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(built.__includeRawResponse).toBe(false);
  });
});
