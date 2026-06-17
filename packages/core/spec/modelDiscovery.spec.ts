import { beforeEach, describe, expect, it, vi } from 'vitest';

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

// systemUtils exposes `env` (process.env) and `execAsync`. We mock both so the
// tests are hermetic with respect to the real machine's environment / binaries.
const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
  execAsync: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('modelDiscovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Fresh, empty environment per test.
    systemUtilsMock.env = {};
    // Default: no Ollama daemon and no CLI.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );
    systemUtilsMock.execAsync.mockRejectedValue(new Error('command not found: ollama'));
  });

  describe('findApiKeyEnvVar', () => {
    it('returns the first env var that is set and non-empty', async () => {
      systemUtilsMock.env.OPENROUTER_API_KEY = 'sk-or-123';
      const { findApiKeyEnvVar, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openrouter')!;
      // OPEN_ROUTER_API_KEY is checked before OPENROUTER_API_KEY; only the alias is set.
      expect(findApiKeyEnvVar(descriptor)).toBe('OPENROUTER_API_KEY');
    });

    it('treats whitespace-only values as unset', async () => {
      systemUtilsMock.env.ANTHROPIC_API_KEY = '   ';
      const { findApiKeyEnvVar, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'anthropic')!;
      expect(findApiKeyEnvVar(descriptor)).toBeUndefined();
    });
  });

  describe('parseOllamaList', () => {
    it('extracts model tags from `ollama ls` output and skips the header', async () => {
      const { parseOllamaList } = await import('#src/providers/modelDiscovery.js');
      const stdout = [
        'NAME             ID              SIZE      MODIFIED',
        'qwen3:latest     abc123          4.7 GB    2 days ago',
        'deepseek-r1:8b   def456          5.2 GB    1 week ago',
      ].join('\n');
      expect(parseOllamaList(stdout)).toEqual(['qwen3:latest', 'deepseek-r1:8b']);
    });

    it('returns an empty array for empty output', async () => {
      const { parseOllamaList } = await import('#src/providers/modelDiscovery.js');
      expect(parseOllamaList('')).toEqual([]);
    });
  });

  describe('buildModelList', () => {
    it('flags all curated models as preferred for cloud providers', async () => {
      const { buildModelList, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'anthropic')!;
      const models = buildModelList(descriptor);
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.preferred)).toBe(true);
      expect(models[0].id).toBe('claude-sonnet-4-5');
    });

    it('flags discovered ollama models preferred only when curated (ignoring :latest)', async () => {
      const { buildModelList, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'ollama')!;
      const models = buildModelList(descriptor, ['qwen3:latest', 'some-random-model:7b']);
      expect(models).toEqual([
        { id: 'qwen3:latest', preferred: true },
        { id: 'some-random-model:7b', preferred: false },
      ]);
    });
  });

  describe('detectOllama', () => {
    it('lists models from the HTTP /api/tags endpoint when reachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ models: [{ name: 'qwen3:latest' }, { name: 'gemma3:latest' }] }),
        }))
      );
      const { detectOllama } = await import('#src/providers/modelDiscovery.js');
      const result = await detectOllama();
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['qwen3:latest', 'gemma3:latest']);
      // CLI fallback must not be used when HTTP succeeds.
      expect(systemUtilsMock.execAsync).not.toHaveBeenCalled();
    });

    it('falls back to `ollama ls` when the HTTP probe fails', async () => {
      systemUtilsMock.execAsync.mockResolvedValue(
        ['NAME           ID       SIZE', 'qwen3:latest   abc      4.7 GB'].join('\n')
      );
      const { detectOllama } = await import('#src/providers/modelDiscovery.js');
      const result = await detectOllama();
      expect(systemUtilsMock.execAsync).toHaveBeenCalledWith('ollama ls');
      expect(result.available).toBe(true);
      expect(result.models).toEqual(['qwen3:latest']);
    });

    it('reports unavailable when neither HTTP nor CLI respond', async () => {
      const { detectOllama } = await import('#src/providers/modelDiscovery.js');
      const result = await detectOllama();
      expect(result).toEqual({ available: false, models: [] });
    });
  });

  describe('listModels', () => {
    it('returns the curated list for a cloud provider', async () => {
      const { listModels } = await import('#src/providers/modelDiscovery.js');
      const models = await listModels('groq');
      expect(models.every((m) => m.preferred)).toBe(true);
      expect(models.map((m) => m.id)).toContain('openai/gpt-oss-120b');
    });

    it('probes the daemon for ollama', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ models: [{ name: 'qwen3:latest' }] }),
        }))
      );
      const { listModels } = await import('#src/providers/modelDiscovery.js');
      const models = await listModels('ollama');
      expect(models).toEqual([{ id: 'qwen3:latest', preferred: true }]);
    });

    it('throws for an unknown provider', async () => {
      const { listModels } = await import('#src/providers/modelDiscovery.js');

      await expect(listModels('nope' as any)).rejects.toThrow('Unknown provider: nope');
    });
  });

  describe('detectProviders', () => {
    it('marks a provider available when its API key env var is set', async () => {
      systemUtilsMock.env.ANTHROPIC_API_KEY = 'sk-ant-123';
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');
      const providers = await detectProviders();
      const anthropic = providers.find((p) => p.id === 'anthropic')!;
      expect(anthropic.available).toBe(true);
      expect(anthropic.apiKeyEnvironmentVariable).toBe('ANTHROPIC_API_KEY');
      expect(anthropic.models.length).toBeGreaterThan(0);
    });

    it('marks vertexai as requiring external auth and not available via env', async () => {
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');
      const providers = await detectProviders();
      const vertex = providers.find((p) => p.id === 'vertexai')!;
      expect(vertex.requiresExternalAuth).toBe(true);
      expect(vertex.available).toBe(false);
    });

    it('reports ollama as available with its live model list when the daemon responds', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ models: [{ name: 'qwen3:latest' }] }),
        }))
      );
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');
      const providers = await detectProviders();
      const ollama = providers.find((p) => p.id === 'ollama')!;
      expect(ollama.available).toBe(true);
      expect(ollama.models).toEqual([{ id: 'qwen3:latest', preferred: true }]);
    });

    it('includes unavailable providers by default but can filter them out', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');

      const all = await detectProviders();
      expect(all.length).toBe(9); // all descriptors

      const availableOnly = await detectProviders({ includeUnavailable: false });
      expect(availableOnly.map((p) => p.id)).toEqual(['openai']);
    });
  });
});
