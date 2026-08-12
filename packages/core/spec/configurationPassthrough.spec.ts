import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CFG-34 — a `configuration` block a provider cannot use must be LOUD, and a block a provider CAN
 * use must stay silent and keep working.
 *
 * These two directions are asserted in one file on purpose. `configuration` is `ChatOpenAI`'s own
 * constructor field, so it is a supported passthrough for the providers that build one (openai
 * directly; huggingface composes the HF router base URL in FRONT of the user's block) and dead
 * weight for the providers on a native client (openrouter, ollama). A warning that fires for every
 * provider would be a regression, not a fix — so every silent cell here also asserts the user's
 * field actually reached the constructor, which a bare "did not warn" check would not catch.
 */

const chatOpenRouterConstructorMock = vi.fn();
vi.mock('@langchain/openrouter', () => {
  class ChatOpenRouter {
    constructor(config: unknown) {
      chatOpenRouterConstructorMock(config);
    }
  }
  return { ChatOpenRouter };
});

const chatOllamaConstructorMock = vi.fn();
vi.mock('@langchain/ollama', () => {
  class ChatOllama {
    constructor(config: unknown) {
      chatOllamaConstructorMock(config);
    }
  }
  return { ChatOllama };
});

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
  writeConfigFileWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

/** The single warning text, or a failure naming how many calls actually happened. */
function onlyWarning(): string {
  expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  return String(consoleUtilsMock.displayWarning.mock.calls[0][0]);
}

describe('CFG-34 — an unusable configuration block is loud (native-client providers)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('openrouter warns, naming the provider, the dropped key and the replacement', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: { timeout: 5000, maxRetries: 7 },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('openrouter');
    expect(warning).toContain('llm.configuration.timeout');
    expect(warning).toContain('llm.configuration.maxRetries');
    // Points at the replacement for BOTH halves: native top-level fields, and a process-wide proxy.
    expect(warning).toContain('top-level');
    expect(warning).toContain('HTTP_PROXY');
    // The block is dropped, never smuggled into the native constructor.
    expect(chatOpenRouterConstructorMock.mock.calls[0][0].configuration).toBeUndefined();
  });

  it('openrouter warns per unconsumed HEADER, not per header block', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: {
        defaultHeaders: { 'X-Title': 'Mine', Authorization: 'Bearer gateway-token' },
      },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('llm.configuration.defaultHeaders.Authorization');
    // `X-Title` IS read (it feeds siteName), so naming it here would be a false report.
    expect(warning).not.toContain('X-Title');
    expect(chatOpenRouterConstructorMock.mock.calls[0][0].siteName).toBe('Mine');
  });

  it('ollama warns, naming the provider, the dropped key and OLLAMA_HOST', async () => {
    const { processJsonConfig } = await import('#src/providers/ollama.js');

    await processJsonConfig({
      type: 'ollama',
      model: 'gemma4:12b',
      configuration: { baseURL: 'http://gpu-box:11434/v1' },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('ollama');
    expect(warning).toContain('llm.configuration.baseURL');
    expect(warning).toContain('OLLAMA_HOST');
    expect(chatOllamaConstructorMock.mock.calls[0][0].configuration).toBeUndefined();
  });
});

describe('CFG-34 control — a configuration block a provider CAN use stays silent and works', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('huggingface passes the user block through, composed after the router base URL, silently', async () => {
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig({
      type: 'huggingface',
      apiKey: 'hf-token',
      model: 'openai/gpt-oss-120b',
      configuration: { timeout: 5000, defaultHeaders: { 'X-Team': 'platform' } },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    const built = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(built.configuration.timeout).toBe(5000);
    expect(built.configuration.defaultHeaders).toEqual({ 'X-Team': 'platform' });
    expect(built.configuration.baseURL).toBe('https://router.huggingface.co/v1');
  });

  it('openai passes the user block through untouched, silently', async () => {
    const { processJsonConfig } = await import('#src/providers/openai.js');

    await processJsonConfig({
      type: 'openai',
      apiKey: 'sk-test',
      // gpt-4o deliberately: the gpt-5 / o-series ids trip this provider's OWN temperature warning,
      // which would confound a "did not warn" assertion.
      model: 'gpt-4o',
      configuration: { timeout: 5000, baseURL: 'http://127.0.0.1:1234/v1' },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    const built = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(built.configuration.timeout).toBe(5000);
    expect(built.configuration.baseURL).toBe('http://127.0.0.1:1234/v1');
  });

  it('openrouter stays silent for the paths it really does consume', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: {
        baseURL: 'https://openrouter.example.com/api/v1',
        defaultHeaders: { 'HTTP-Referer': 'https://mine.app', 'X-Title': 'Mine' },
      },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.baseURL).toBe('https://openrouter.example.com/api/v1');
    expect(built.siteUrl).toBe('https://mine.app');
    expect(built.siteName).toBe('Mine');
  });

  it('no provider warns when there is no configuration block at all', async () => {
    const { processJsonConfig: openrouter } = await import('#src/providers/openrouter.js');
    const { processJsonConfig: ollama } = await import('#src/providers/ollama.js');

    await openrouter({ type: 'openrouter', model: 'x-ai/grok' } as never);
    await ollama({ type: 'ollama', model: 'gemma4:12b', configuration: {} } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});

describe('CFG-34 — findUnusedConfigurationPaths', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports whole keys, partial sub-paths, and nothing for a fully consumed block', async () => {
    const { findUnusedConfigurationPaths } =
      await import('#src/providers/configurationPassthrough.js');

    expect(findUnusedConfigurationPaths({ timeout: 1 }, [])).toEqual(['timeout']);
    expect(findUnusedConfigurationPaths({ baseURL: 'x' }, ['baseURL'])).toEqual([]);
    expect(
      findUnusedConfigurationPaths({ defaultHeaders: { A: '1', B: '2' } }, ['defaultHeaders.A'])
    ).toEqual(['defaultHeaders.B']);
    // A non-record value under a partially-consumed key cannot be inspected: report the whole key
    // rather than silently passing it.
    expect(findUnusedConfigurationPaths({ defaultHeaders: 'oops' }, ['defaultHeaders.A'])).toEqual([
      'defaultHeaders',
    ]);
    // Not a block at all — nothing to report, and nothing to crash on.
    for (const notABlock of [undefined, null, 'string', 42, ['a']]) {
      expect(findUnusedConfigurationPaths(notABlock, [])).toEqual([]);
    }
  });
});
