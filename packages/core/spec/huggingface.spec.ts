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
  writeConfigFileWithMessages: vi.fn(),
};
vi.mock('#src/utils/fileUtils.js', () => fileUtilsMock);

const HF_ROUTER_BASE_URL = 'https://router.huggingface.co/v1';

function buildConfig(overrides: Record<string, unknown> = {}) {
  return { type: 'huggingface', ...overrides };
}

describe('huggingface provider processJsonConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('builds a ChatOpenAI pointed at the HF Inference Providers router base URL', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_test' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b' }));

    expect(chatOpenAIConstructorMock).toHaveBeenCalledTimes(1);
    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.configuration.baseURL).toBe(HF_ROUTER_BASE_URL);
    expect(builtConfig.model).toBe('openai/gpt-oss-120b');
  });

  it('resolves the token from HF_TOKEN (canonical)', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_canonical' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.apiKey).toBe('hf_canonical');
  });

  it('accepts HUGGINGFACEHUB_API_TOKEN as an alias when HF_TOKEN is unset', async () => {
    systemUtilsMock.env = { HUGGINGFACEHUB_API_TOKEN: 'hf_hub_alias' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.apiKey).toBe('hf_hub_alias');
  });

  it('accepts HF_API_KEY as an alias when the others are unset', async () => {
    systemUtilsMock.env = { HF_API_KEY: 'hf_api_alias' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.apiKey).toBe('hf_api_alias');
  });

  it('honors an explicitly configured apiKey over the environment token', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_from_env' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(
      buildConfig({ apiKey: 'hf_from_config', model: 'openai/gpt-oss-120b' })
    );

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    // Config apiKey takes precedence over the fallback env token (mirrors openrouter).
    expect(builtConfig.apiKey).toBe('hf_from_config');
  });

  it('reads the token from a custom apiKeyEnvironmentVariable when provided', async () => {
    systemUtilsMock.env = { MY_HF_TOKEN: 'hf_custom_var' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(
      buildConfig({ apiKeyEnvironmentVariable: 'MY_HF_TOKEN', model: 'openai/gpt-oss-120b' })
    );

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.apiKey).toBe('hf_custom_var');
  });

  it('falls back to the curated default model when none is configured', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_test' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');
    const { getCuratedFallbackModel } = await import('#src/providers/modelDiscovery.js');

    await processJsonConfig(buildConfig());

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.model).toBe(getCuratedFallbackModel('huggingface'));
  });

  it('throws a helpful error when no token is available', async () => {
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await expect(processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b' }))).rejects.toThrow(
      'HF_TOKEN'
    );
    expect(chatOpenAIConstructorMock).not.toHaveBeenCalled();
  });

  it('strips internal config keys (type, apiKeyEnvironmentVariable) from the built model', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_test' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(
      buildConfig({ apiKeyEnvironmentVariable: 'HF_TOKEN', model: 'openai/gpt-oss-120b' })
    );

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect('type' in builtConfig).toBe(false);
    expect('apiKeyEnvironmentVariable' in builtConfig).toBe(false);
  });

  it('preserves a user-supplied configuration alongside the default baseURL', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_test' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(
      buildConfig({ model: 'openai/gpt-oss-120b', configuration: { timeout: 5000 } })
    );

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.configuration.baseURL).toBe(HF_ROUTER_BASE_URL);
    expect(builtConfig.configuration.timeout).toBe(5000);
  });

  it('passes a routing-suffixed model id (e.g. :groq) straight through', async () => {
    systemUtilsMock.env = { HF_TOKEN: 'hf_test' };
    const { processJsonConfig } = await import('#src/providers/huggingface.js');

    await processJsonConfig(buildConfig({ model: 'openai/gpt-oss-120b:groq' }));

    const builtConfig = chatOpenAIConstructorMock.mock.calls[0][0];
    expect(builtConfig.model).toBe('openai/gpt-oss-120b:groq');
  });
});

describe('huggingface provider init', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = {};
  });

  it('writes the default JSON config and warns the user', async () => {
    const { init } = await import('#src/providers/huggingface.js');

    init('.gsloth.config.json');

    expect(fileUtilsMock.writeConfigFileWithMessages).toHaveBeenCalledTimes(1);
    const [fileName, content, force] = fileUtilsMock.writeConfigFileWithMessages.mock.calls[0];
    expect(fileName).toBe('.gsloth.config.json');
    expect(content).toContain('"type": "huggingface"');
    expect(force).toBe(false);
    expect(consoleUtilsMock.displayWarning).toHaveBeenCalledTimes(1);
  });

  it('overwrites the config when called with force', async () => {
    const { init } = await import('#src/providers/huggingface.js');

    init('.gsloth.config.json', true);

    expect(fileUtilsMock.writeConfigFileWithMessages).toHaveBeenCalledTimes(1);
    const [, , force] = fileUtilsMock.writeConfigFileWithMessages.mock.calls[0];
    expect(force).toBe(true);
  });

  it('rejects non-JSON config file names', async () => {
    const { init } = await import('#src/providers/huggingface.js');

    expect(() => init('.gsloth.config.js')).toThrow('Only JSON config is supported.');
  });
});
