import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatOpenRouterConstructorMock = vi.fn();
vi.mock('@langchain/openrouter', () => {
  class ChatOpenRouter {
    constructor(config: unknown) {
      chatOpenRouterConstructorMock(config);
    }
  }
  return { ChatOpenRouter };
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

describe('openrouter provider — ChatOpenRouter adoption & attribution wiring', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.env = { OPEN_ROUTER_API_KEY: 'test-key' };
  });

  it('constructs ChatOpenRouter with default attribution fields', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig(buildConfig() as any);

    expect(chatOpenRouterConstructorMock).toHaveBeenCalledTimes(1);
    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.apiKey).toBe('test-key');
    expect(built.model).toBe('x-ai/grok');
    expect(built.siteUrl).toBe('https://gauntsloth.app/');
    expect(built.siteName).toBe('Gaunt Sloth');
  });

  it('honors custom siteUrl and siteName or configuration defaultHeaders fallback', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig(
      buildConfig({
        siteUrl: 'https://custom.app',
        siteName: 'Custom App',
      }) as any
    );

    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.siteUrl).toBe('https://custom.app');
    expect(built.siteName).toBe('Custom App');
  });

  it('respects OPENROUTER_API_KEY environment variable fallback', async () => {
    systemUtilsMock.env = { OPENROUTER_API_KEY: 'alt-env-key' };
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig({ type: 'openrouter', model: 'anthropic/claude-3.5-sonnet' } as any);

    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.apiKey).toBe('alt-env-key');
  });

  it('passes baseURL when specified in configuration', async () => {
    const { processJsonConfig } = await import('#src/providers/openrouter.js');

    await processJsonConfig(
      buildConfig({
        configuration: { baseURL: 'https://openrouter.example.com/api/v1' },
      }) as any
    );

    const built = chatOpenRouterConstructorMock.mock.calls[0][0];
    expect(built.baseURL).toBe('https://openrouter.example.com/api/v1');
  });
});
