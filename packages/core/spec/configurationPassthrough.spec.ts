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
    // The escape hatch has to be followable from the terminal alone: the "openai" provider reads
    // OPENAI_API_KEY, so a user who switches to it for the headers and stops reading here hits a
    // missing-key error. The doc carries this half; the message must too.
    expect(warning).toContain('apiKeyEnvironmentVariable');
    expect(warning).toContain('XAI_API_KEY');
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

/**
 * CFG-44 — the reason clause each provider PRINTS, pinned to that provider.
 *
 * The per-provider cells above check that a warning fires, that it names every dropped path, and
 * that its guidance points at the right replacement. None of them looks at the middle of the
 * sentence, so a clause could migrate to a provider it is false of and the whole suite would stay
 * green while a user was told something untrue about their own provider — which is the same defect
 * as the silence this node exists to end, printed instead of withheld.
 *
 * Each row pins two properties, and both are load-bearing:
 *   - the clause appears IN ITS SLOT — `the "<provider>" provider <reason>.` — not merely somewhere
 *     in the message. A bare `toContain(reason)` cannot tell the reason slot from the guidance slot,
 *     so it stays green with the two transposed: the rendered string still contains both sentences
 *     and only their order is wrong. The named-field call shape makes that transposition visible
 *     where it is written; this is what catches it if it is written anyway.
 *   - no OTHER provider's clause appears at all, so one sentence cannot quietly serve two meanings.
 *
 * The expected sentences are written out here rather than imported from the source constants, and
 * the duplication is the point: editing `NATIVE_CLIENT_REASON` reddens all six rows that pass it,
 * which is exactly the moment someone has to re-check that sentence against each of those providers.
 */
const NATIVE_CLIENT_REASON_TEXT =
  'does not build an OpenAI client, so a "configuration" block is not passed through to one';
const XAI_OWN_REASON_TEXT =
  'builds its OpenAI client with a "configuration" block of its own, replacing anything set here';
const ALL_REASON_TEXTS = [NATIVE_CLIENT_REASON_TEXT, XAI_OWN_REASON_TEXT];

/** The providers whose factory hands the user's block to a client that keeps it — see the controls. */
const PROVIDERS_THAT_CONSUME_THE_BLOCK = ['openai', 'huggingface', 'deepseek'];

type ProviderModule = { processJsonConfig: (llmConfig: never) => unknown };

const WARNED_PROVIDERS: ReadonlyArray<{
  provider: string;
  reason: string;
  load: () => Promise<ProviderModule>;
  llmConfig: Record<string, unknown>;
}> = [
  {
    provider: 'anthropic',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/anthropic.js'),
    llmConfig: { type: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5' },
  },
  {
    provider: 'groq',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/groq.js'),
    llmConfig: { type: 'groq', apiKey: 'gsk-test', model: 'llama-3.3-70b-versatile' },
  },
  {
    provider: 'google-genai',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/google-genai.js'),
    llmConfig: { type: 'google-genai', apiKey: 'goog-test', model: 'gemini-3-pro-preview' },
  },
  {
    provider: 'vertexai',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/vertexai.js'),
    llmConfig: { type: 'vertexai', model: 'gemini-3-pro-preview' },
  },
  {
    provider: 'ollama',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/ollama.js'),
    llmConfig: { type: 'ollama', model: 'gemma4:12b' },
  },
  {
    // openrouter reads `baseURL` and two attribution headers out of the block, so it is warned for
    // the REST of it. The clause it prints is the shared one all the same.
    provider: 'openrouter',
    reason: NATIVE_CLIENT_REASON_TEXT,
    load: () => import('#src/providers/openrouter.js'),
    llmConfig: { type: 'openrouter', model: 'x-ai/grok' },
  },
  {
    // xai is the one provider that DOES build an OpenAI client and drops the block anyway, so the
    // shared sentence would be false for it and it carries its own.
    provider: 'xai',
    reason: XAI_OWN_REASON_TEXT,
    load: () => import('#src/providers/xai.js'),
    llmConfig: { type: 'xai', apiKey: 'xai-test', model: 'grok-4' },
  },
];

describe('CFG-44 — every warned provider prints the reason clause that is true of IT', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  for (const row of WARNED_PROVIDERS) {
    it(`${row.provider} states its own reason, in the reason slot`, async () => {
      const { processJsonConfig } = await row.load();

      await processJsonConfig({ ...row.llmConfig, configuration: UNUSABLE } as never);

      const warning = onlyWarning();
      expect(warning).toContain(`the "${row.provider}" provider ${row.reason}.`);
      for (const otherReason of ALL_REASON_TEXTS.filter((text) => text !== row.reason)) {
        expect(warning).not.toContain(otherReason);
      }
    });
  }

  // A hand-written table silently covers six of seven the moment someone deletes a row, and covers
  // ten of eleven the moment a provider is added. Partitioning the shipped provider list over
  // "warns" and "consumes the block" turns either into a red cell that names the missing provider.
  it('classifies every selectable provider as one or the other', async () => {
    const { availableDefaultConfigs } = await import('#src/config/types.js');

    expect(
      [...WARNED_PROVIDERS.map((row) => row.provider), ...PROVIDERS_THAT_CONSUME_THE_BLOCK].sort()
    ).toEqual([...availableDefaultConfigs].sort());
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

/**
 * CFG-46 — `warnShadowedField`, and the transposition its named fields do NOT prevent.
 *
 * The lesson this module already paid for: moving to an object with named fields did not make a
 * swap a compile error, because two strings type-check in two string fields either way round. Both
 * pairs here are transposable, and the message would still contain every path and read exactly
 * backwards. So the paths are pinned in their SLOTS in the rendered sentence, and the values by
 * the pair around the empty-value guard — an empty LOSER is nothing to warn about, an empty winner
 * is not the same statement.
 */
describe('CFG-46 — warnShadowedField says which of two honoured locations wins', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('puts the losing path and the winning path in their own slots', async () => {
    const { warnShadowedField } = await import('#src/providers/configurationPassthrough.js');

    warnShadowedField({
      provider: 'openrouter',
      ignoredPath: 'alpha',
      appliedPath: 'beta.gamma',
      ignoredValue: 'https://loser.example.com/',
      appliedValue: 'https://winner.example.com/',
    });

    const warning = onlyWarning();
    // The whole sentence, not two independent `toContain`s: with the two paths transposed the
    // message still mentions both and only their roles are wrong, which is the mistake the named
    // fields cannot catch on their own.
    expect(warning).toContain(
      'Ignoring llm.alpha — the "openrouter" provider also has llm.beta.gamma set, and that one takes precedence.'
    );
    expect(warning).not.toContain('Ignoring llm.beta.gamma');
    // Neither value is quoted back: either can carry a credential.
    expect(warning).not.toContain('loser.example.com');
    expect(warning).not.toContain('winner.example.com');
  });

  it('is silent when the losing location carries nothing, and speaks when the winner does not', async () => {
    const { warnShadowedField } = await import('#src/providers/configurationPassthrough.js');

    // Nothing is lost when the loser is empty, so there is nothing to say.
    for (const ignoredValue of [undefined, null, '']) {
      warnShadowedField({
        provider: 'openrouter',
        ignoredPath: 'alpha',
        appliedPath: 'beta',
        ignoredValue,
        appliedValue: 'applied',
      });
    }
    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();

    // The same pair the other way round is a different statement and is NOT silent — which is what
    // makes the cell above discriminate a value transposition rather than merely describe one.
    warnShadowedField({
      provider: 'openrouter',
      ignoredPath: 'alpha',
      appliedPath: 'beta',
      ignoredValue: 'applied',
      appliedValue: '',
    });
    expect(onlyWarning()).toContain('Ignoring llm.alpha');
  });

  it('says nothing when the two locations agree, or when the winner was never applied', async () => {
    const { warnShadowedField } = await import('#src/providers/configurationPassthrough.js');

    warnShadowedField({
      provider: 'openrouter',
      ignoredPath: 'alpha',
      appliedPath: 'beta',
      ignoredValue: 'same',
      appliedValue: 'same',
    });
    for (const appliedValue of [undefined, null]) {
      warnShadowedField({
        provider: 'openrouter',
        ignoredPath: 'alpha',
        appliedPath: 'beta',
        ignoredValue: 'set',
        appliedValue,
      });
    }

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });
});

/**
 * CFG-46 — the attribution headers, whose precedence runs OPPOSITE to `baseURL`'s.
 *
 * `configuration.baseURL` beats the top-level `baseURL`, and that has been announced. The
 * attribution headers go the other way — the block feeds `siteUrl`/`siteName` only as a fallback,
 * so a top-level value wins — and that direction said nothing at all, which left the user unable to
 * work out from either the behaviour or the messages which level wins. The precedence itself is
 * deliberately unchanged here; what ends is the asymmetry in what is said about it.
 */
describe('CFG-46 — openrouter announces the top level beating the block, too', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('names both attribution headers, in the losing slot, when the top level beats them', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      siteUrl: 'https://top-level.example.com/',
      siteName: 'Top Level Name',
      configuration: {
        defaultHeaders: {
          'HTTP-Referer': 'https://from-block.example.com/',
          'X-Title': 'Block Name',
        },
      },
    } as never);

    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(2);
    const warnings = consoleUtilsMock.displayWarning.mock.calls.map((call) => String(call[0]));
    expect(warnings[0]).toContain(
      'Ignoring llm.configuration.defaultHeaders.HTTP-Referer — the "openrouter" provider also has llm.siteUrl set, and that one takes precedence.'
    );
    expect(warnings[1]).toContain(
      'Ignoring llm.configuration.defaultHeaders.X-Title — the "openrouter" provider also has llm.siteName set, and that one takes precedence.'
    );
    // No value from either location is printed.
    for (const warning of warnings) {
      expect(warning).not.toContain('example.com');
      expect(warning).not.toContain('Block Name');
    }
    // Precedence is described, not altered.
    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.siteUrl).toBe('https://top-level.example.com/');
    expect(built.siteName).toBe('Top Level Name');
  });

  it('stays silent — and applies the block — when nothing beats it', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      configuration: {
        defaultHeaders: {
          'HTTP-Referer': 'https://from-block.example.com/',
          'X-Title': 'Block Name',
        },
      },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.siteUrl).toBe('https://from-block.example.com/');
    expect(built.siteName).toBe('Block Name');
  });

  it('stays silent when the two locations carry the same attribution', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      siteUrl: 'https://same.example.com/',
      configuration: { defaultHeaders: { 'HTTP-Referer': 'https://same.example.com/' } },
    } as never);

    expect(consoleUtilsMock.displayWarning).not.toHaveBeenCalled();
  });

  it('does not ALSO report the beaten header as an unusable configuration path', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({
      type: 'openrouter',
      model: 'x-ai/grok',
      siteUrl: 'https://top-level.example.com/',
      configuration: { defaultHeaders: { 'HTTP-Referer': 'https://from-block.example.com/' } },
    } as never);

    // `defaultHeaders.HTTP-Referer` is a path this factory DOES consume, so the orphaned-config
    // message must keep its hands off it: the header is not unusable, it was outranked, and those
    // are different things to tell a user.
    const warning = onlyWarning();
    expect(warning).toContain('takes precedence');
    expect(warning).not.toContain('is not passed through');
    expect(warning).not.toContain('no usable value');
  });
});
