import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CFG-34 — a `configuration` block a provider cannot use must be LOUD, and a block a provider CAN
 * use must stay silent and keep working.
 *
 * These two directions are asserted in one file on purpose. `configuration` is `ChatOpenAI`'s own
 * constructor field, so it is a supported passthrough for the providers that hand the user's block
 * to such a client (openai directly; huggingface composes the HF router base URL in FRONT of it;
 * deepseek spreads it over its own default) and dead weight everywhere else — both for providers on
 * a native client (openrouter, ollama, …) and for xai, which builds an OpenAI client and replaces
 * the block before handing it on. A warning that fires for every provider would be a regression,
 * not a fix — so every silent cell here also asserts the user's field actually reached the
 * constructor, which a bare "did not warn" check would not catch.
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

const chatAnthropicConstructorMock = vi.fn();
vi.mock('@langchain/anthropic', () => {
  class ChatAnthropic {
    constructor(config: unknown) {
      chatAnthropicConstructorMock(config);
    }
  }
  return { ChatAnthropic };
});

const chatGroqConstructorMock = vi.fn();
vi.mock('@langchain/groq', () => {
  class ChatGroq {
    constructor(config: unknown) {
      chatGroqConstructorMock(config);
    }
  }
  return { ChatGroq };
});

const chatGoogleConstructorMock = vi.fn();
vi.mock('@langchain/google/node', () => {
  class ChatGoogle {
    constructor(config: unknown) {
      chatGoogleConstructorMock(config);
    }
  }
  return { ChatGoogle };
});

const chatDeepSeekConstructorMock = vi.fn();
vi.mock('@langchain/deepseek', () => {
  class ChatDeepSeek {
    constructor(config: unknown) {
      chatDeepSeekConstructorMock(config);
    }
  }
  return { ChatDeepSeek };
});

const chatXAIConstructorMock = vi.fn();
vi.mock('@langchain/xai', () => {
  class ChatXAI {
    constructor(config: unknown) {
      chatXAIConstructorMock(config);
    }
  }
  return { ChatXAI };
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
    // The advice is SCOPED to the options that have a top-level home. `timeout` above is a
    // transport key: an unqualified "put it at the top level instead" would move it from a warned
    // location to an unwarned one, so the message must say transport has no top-level field either.
    expect(warning).toContain("OpenRouter's own options");
    expect(warning).toContain('Transport settings');
    expect(warning).toContain('no top-level field');
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

  it('openrouter warns when a CONSUMED path is present but empty, and is silent when it is real', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    // `baseURL` is declared consumed, so the unused-path warning correctly stays quiet about it —
    // and the factory's own guard skips an empty value, leaving the OpenRouter default in place.
    // Declared supported, in fact dropped, is exactly the silence this node exists to end.
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: { baseURL: '' },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('llm.configuration.baseURL');
    expect(warning).toContain('no usable value');
    expect(warning).toContain('https://openrouter.ai/api/v1');
    expect(chatOpenRouterConstructorMock.mock.calls[0][0].baseURL).toBeUndefined();

    // The discriminating half: the same key with a real value is applied and says nothing.
    consoleUtilsMock.displayWarning.mockClear();
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: { baseURL: 'https://openrouter.example.com/api/v1' },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(chatOpenRouterConstructorMock.mock.calls[1][0].baseURL).toBe(
      'https://openrouter.example.com/api/v1'
    );
  });

  it('openrouter warns for a consumed path present as null, and stays quiet when it is absent', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: { baseURL: null },
    } as never);

    expect(onlyWarning()).toContain('llm.configuration.baseURL');

    // Not setting `baseURL` at all is the normal case and must stay silent.
    consoleUtilsMock.displayWarning.mockClear();
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: { defaultHeaders: { 'X-Title': 'Mine' } },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
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

/**
 * CFG-44 — the same defect in the four providers CFG-34 left behind. Each was measured against the
 * built `dist/`: a `configuration` block reaches no client for any of them, so each gets one call
 * to the SAME helper, with the replacement field named for that provider's own client.
 */
/** One transport key, one endpoint and one header: three paths, none of which reaches a client. */
const UNUSABLE = {
  timeout: 5000,
  baseURL: 'https://gateway.example.com/v1',
  defaultHeaders: { Authorization: 'Bearer gateway-token' },
};

/** Every path in {@link UNUSABLE} must be named — a message that reports only the first is a
 * half-report, and the user would fix one key and keep the rest of the silence. */
function expectNamesEveryDroppedPath(warning: string): void {
  expect(warning).toContain('llm.configuration.timeout');
  expect(warning).toContain('llm.configuration.baseURL');
  expect(warning).toContain('llm.configuration.defaultHeaders');
}

describe('CFG-44 — the remaining native-client providers warn too', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('anthropic warns, naming the provider, every dropped path and clientOptions', async () => {
    const { processJsonConfig } = await import('#src/providers/anthropic.js');

    await processJsonConfig({
      type: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-5',
      configuration: UNUSABLE,
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('anthropic');
    expectNamesEveryDroppedPath(warning);
    // The replacement is this client's own field, not a generic "move it to the top level":
    // ChatAnthropic builds its SDK client from `clientOptions`.
    expect(warning).toContain('clientOptions');
    // Warn, don't fail — the model is still built.
    expect(chatAnthropicConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatAnthropicConstructorMock.mock.calls[0][0].model).toBe('claude-sonnet-4-5');
  });

  it('groq warns, naming the provider, every dropped path and its top-level baseUrl', async () => {
    const { processJsonConfig } = await import('#src/providers/groq.js');

    await processJsonConfig({
      type: 'groq',
      apiKey: 'gsk-test',
      model: 'llama-3.3-70b-versatile',
      configuration: UNUSABLE,
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('groq');
    expectNamesEveryDroppedPath(warning);
    // Groq's transport settings DO have top-level homes, and the spelling differs from the one the
    // user just wrote (`baseUrl`, not `baseURL`) — which is precisely why naming it earns its place.
    expect(warning).toContain('"baseUrl"');
    expect(warning).toContain('defaultHeaders');
    expect(chatGroqConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatGroqConstructorMock.mock.calls[0][0].model).toBe('llama-3.3-70b-versatile');
  });

  it('google-genai warns, naming the provider, every dropped path and customHeaders', async () => {
    const { processJsonConfig } = await import('#src/providers/google-genai.js');

    await processJsonConfig({
      type: 'google-genai',
      apiKey: 'goog-test',
      model: 'gemini-3-pro-preview',
      configuration: UNUSABLE,
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('google-genai');
    expectNamesEveryDroppedPath(warning);
    expect(warning).toContain('customHeaders');
    expect(chatGoogleConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatGoogleConstructorMock.mock.calls[0][0].platformType).toBe('gai');
  });

  it('vertexai warns, naming the provider, every dropped path and its own top-level fields', async () => {
    const { processJsonConfig } = await import('#src/providers/vertexai.js');

    await processJsonConfig({
      type: 'vertexai',
      model: 'gemini-3-pro-preview',
      configuration: UNUSABLE,
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('vertexai');
    expectNamesEveryDroppedPath(warning);
    expect(warning).toContain('customHeaders');
    // `location` is a Vertex concern only, so the two ChatGoogle providers do NOT share one string.
    expect(warning).toContain('location');
    expect(chatGoogleConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatGoogleConstructorMock.mock.calls[0][0].vertexai).toBe(true);
  });

  it('none of the four says anything when there is no configuration block', async () => {
    const { processJsonConfig: anthropic } = await import('#src/providers/anthropic.js');
    const { processJsonConfig: groq } = await import('#src/providers/groq.js');
    const { processJsonConfig: googleGenai } = await import('#src/providers/google-genai.js');
    const { processJsonConfig: vertexai } = await import('#src/providers/vertexai.js');

    await anthropic({ type: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-5' } as never);
    await groq({ type: 'groq', apiKey: 'k', model: 'llama-3.3-70b-versatile' } as never);
    // An empty block is the other shape a user's config takes on the way to being deleted.
    await googleGenai({
      type: 'google-genai',
      apiKey: 'k',
      model: 'gemini-3-pro-preview',
      configuration: {},
    } as never);
    await vertexai({ type: 'vertexai', model: 'gemini-3-pro-preview' } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});

/**
 * CFG-44 — xai is NOT a fifth copy of the four above, and this file must not read as though it were.
 *
 * `ChatXAI` DOES build an OpenAI client — it descends from the OpenAI chat model — and it still
 * consumes nothing: its constructor passes `configuration: { baseURL: fields.baseURL ?? <default> }`
 * to `super`, replacing the user's block wholesale. So the same helper is used, with a reason clause
 * of its own; the shared native-client sentence would be a FALSE explanation printed next to a true
 * warning, which is the same defect as the silence it replaces.
 *
 * The guidance was measured against the real package rather than inferred from the type: a
 * top-level `baseURL` AND a top-level `timeout` both reach the built client, while extra headers
 * reach it by no route at all.
 */
describe('CFG-44 — xai builds an OpenAI client and drops the block anyway', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('xai warns with its OWN reason clause, not the shared native-client one', async () => {
    const { processJsonConfig } = await import('#src/providers/xai.js');

    await processJsonConfig({
      type: 'xai',
      apiKey: 'xai-test',
      model: 'grok-4',
      configuration: UNUSABLE,
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('xai');
    expectNamesEveryDroppedPath(warning);
    // The reason clause is the whole point of this cell: it must say what is TRUE for xai (a client
    // is built, and the block is replaced) and must NOT say what is true only of the other five.
    expect(warning).toContain('replacing anything set here');
    expect(warning).not.toContain('does not build an OpenAI client');
    // Replacement guidance, verified: `baseURL` and `timeout` at the TOP level both reach the
    // client. Headers are named as having nowhere to go rather than being quietly omitted — an
    // unqualified "move it to the top level" would send a header from a warned location to an
    // unwarned one.
    expect(warning).toContain('"baseURL" or "timeout" as top-level fields');
    expect(warning).toContain('Extra headers have no home');
    // Warn, don't fail — the model is still built.
    expect(chatXAIConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatXAIConstructorMock.mock.calls[0][0].model).toBe('grok-4');
  });

  it('xai says nothing when there is no configuration block', async () => {
    const { processJsonConfig } = await import('#src/providers/xai.js');

    await processJsonConfig({ type: 'xai', apiKey: 'xai-test', model: 'grok-4' } as never);
    await processJsonConfig({
      type: 'xai',
      apiKey: 'xai-test',
      model: 'grok-4',
      configuration: {},
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(chatXAIConstructorMock).toHaveBeenCalledTimes(2);
  });
});

describe('CFG-44 control — the provider that really does consume the block is left alone', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  // deepseek is the control, and it earns the place on evidence rather than on ancestry: unlike
  // `ChatXAI`, its constructor spreads `...fields.configuration` OVER its own default base URL, so
  // the user's block survives. Wiring this provider into the warn path must turn this cell red.
  it('deepseek passes the user block through untouched, silently', async () => {
    const { processJsonConfig } = await import('#src/providers/deepseek.js');

    await processJsonConfig({
      type: 'deepseek',
      apiKey: 'ds-test',
      model: 'deepseek-chat',
      configuration: { timeout: 5000, baseURL: 'https://gateway.example.com/v1' },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    const built = chatDeepSeekConstructorMock.mock.calls[0][0];
    expect(built.configuration.timeout).toBe(5000);
    expect(built.configuration.baseURL).toBe('https://gateway.example.com/v1');
  });
});

/**
 * CFG-44 — `configuration.baseURL` is spread AFTER the top-level fields, so when a user sets both it
 * wins. Both are honoured surfaces here (a top-level `baseURL` is a native `ChatOpenRouter` field),
 * so neither is dropped as unusable and the only defect is that the config reads as two settings and
 * behaves as one.
 */
describe('CFG-44 — a configuration path that quietly beats a top-level field', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('openrouter says which of the two base URLs takes effect', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      baseURL: 'https://top-level.example.com/api/v1',
      configuration: { baseURL: 'https://from-configuration.example.com/api/v1' },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('llm.baseURL');
    expect(warning).toContain('llm.configuration.baseURL');
    expect(warning).toContain('takes precedence');
    // No value is quoted back: a base URL can carry credentials.
    expect(warning).not.toContain('top-level.example.com');
    // Precedence itself is unchanged — the message describes what happens, it does not alter it.
    expect(chatOpenRouterConstructorMock.mock.calls[0][0].baseURL).toBe(
      'https://from-configuration.example.com/api/v1'
    );
  });

  it('openrouter stays silent when the two agree, and when only one of them is set', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    // The same endpoint written twice is redundant, not a conflict: nothing is lost, so warning
    // would only teach the user to ignore the message.
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      baseURL: 'https://same.example.com/api/v1',
      configuration: { baseURL: 'https://same.example.com/api/v1' },
    } as never);

    // A top-level `baseURL` on its own is applied, with nothing overriding it.
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      baseURL: 'https://top-level.example.com/api/v1',
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    expect(chatOpenRouterConstructorMock.mock.calls[1][0].baseURL).toBe(
      'https://top-level.example.com/api/v1'
    );
  });

  it('openrouter reports the unusable value case, not a precedence conflict, when the block is empty', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    // `configuration.baseURL` is present but empty, so the factory's guard skips it and the
    // top-level value survives. The user still needs to hear about the dead key — but calling that
    // an override would be a false report, since nothing was overridden.
    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      baseURL: 'https://top-level.example.com/api/v1',
      configuration: { baseURL: '' },
    } as never);

    const warning = onlyWarning();
    expect(warning).toContain('no usable value');
    expect(warning).not.toContain('takes precedence');
    expect(chatOpenRouterConstructorMock.mock.calls[0][0].baseURL).toBe(
      'https://top-level.example.com/api/v1'
    );
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
    // No block at all — nothing to report, and nothing to crash on.
    for (const absent of [undefined, null]) {
      expect(findUnusedConfigurationPaths(absent, [])).toEqual([]);
    }
    // A `configuration` that is not a record at all has no paths to report either. That is a
    // BOUNDARY, not a silent drop: such a value never reaches a provider factory, because the
    // schema refuses it first — which the next test pins rather than assumes.
    for (const notARecord of ['https://x/v1', 42, true, ['a']]) {
      expect(findUnusedConfigurationPaths(notARecord, ['baseURL'])).toEqual([]);
    }
  });

  it('leaves a non-record configuration to the schema, which refuses it before any factory runs', async () => {
    const { rawGthConfigSchema } = await import('#src/config/schema.js');

    for (const notARecord of ['https://x/v1', 42, true, ['a'], null]) {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openrouter', model: 'x-ai/grok', configuration: notARecord },
      });
      expect(result.success).toBe(false);
      const paths = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
      expect(paths).toContain('llm.configuration');
    }

    // The record form is the only one a factory can be handed, and the only one the path logic
    // above is asked to reason about.
    expect(
      rawGthConfigSchema.safeParse({
        llm: { type: 'openrouter', model: 'x-ai/grok', configuration: { timeout: 5000 } },
      }).success
    ).toBe(true);
  });
});
