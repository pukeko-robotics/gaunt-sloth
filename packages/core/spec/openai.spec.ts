import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the config object ChatOpenAI is constructed with so we can assert on the built model.
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
  writeFileIfNotExistsWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

function buildConfig(overrides: Record<string, unknown>) {
  return { type: 'openai', apiKey: 'test-key', ...overrides };
}

describe('openai provider processJsonConfig temperature handling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPENAI_API_KEY: 'test-key' };
  });

  it('drops a custom temperature for a temperature-restricted model (gpt-5.x) and warns', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-5.5', temperature: 0 }));

    expect(chatOpenAIConstructorMock).toHaveBeenCalledTimes(1);
    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect('temperature' in builtConfig).toBe(false);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('gpt-5.5')
    );
  });

  it('drops a custom temperature for an o-series model (o4-mini) and warns', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'o4-mini', temperature: 0 }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect('temperature' in builtConfig).toBe(false);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  });

  it('keeps a custom temperature for a temperature-supporting model (gpt-4o)', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-4o', temperature: 0 }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.temperature).toBe(0);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('leaves a temperature-restricted model unaffected when no temperature is set', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-5.5' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect('temperature' in builtConfig).toBe(false);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('keeps the supported default temperature (1) on a restricted model without warning', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-5.5', temperature: 1 }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.temperature).toBe(1);
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});

describe('openai provider processJsonConfig useResponsesApi routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPENAI_API_KEY: 'test-key' };
  });

  it('forces useResponsesApi for a reasoning model (gpt-5.6-luna) with reasoningEffort set', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-5.6-luna', reasoningEffort: 'medium' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.useResponsesApi).toBe(true);
  });

  it('forces useResponsesApi for an o-series model (o3) with a reasoning object set', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'o3', reasoning: { effort: 'high' } }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.useResponsesApi).toBe(true);
  });

  it('leaves useResponsesApi unset for a reasoning model with no reasoning configured', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-5.6-luna' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.useResponsesApi).toBeUndefined();
  });

  it('leaves useResponsesApi unset for a non-reasoning model (gpt-4o) even with reasoningEffort', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(buildConfig({ model: 'gpt-4o', reasoningEffort: 'medium' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.useResponsesApi).toBeUndefined();
  });

  it('respects an explicit useResponsesApi:false on a reasoning model with reasoning configured', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig(
      buildConfig({ model: 'gpt-5.6-luna', reasoningEffort: 'medium', useResponsesApi: false })
    );

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.useResponsesApi).toBe(false);
  });
});
