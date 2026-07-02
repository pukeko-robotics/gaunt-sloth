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

// systemUtils exposes `env` (process.env). We mock it so the tests are hermetic
// with respect to the real machine's environment.
const systemUtilsMock = {
  env: {} as Record<string, string | undefined>,
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

/** Build a fetch mock that returns an OpenAI-shaped `{ data: [{ id }] }` body. */
function okJson(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  }));
}

describe('modelDiscovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Fresh, empty environment per test.
    systemUtilsMock.env = {};
    // Default: every network call fails (no daemon, no provider reachable).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );
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

  describe('buildModelList', () => {
    it('flags all curated models as preferred for cloud providers', async () => {
      const { buildModelList, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'anthropic')!;
      const models = buildModelList(descriptor);
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.preferred)).toBe(true);
      expect(models[0].id).toBe(descriptor.preferredModels[0]);
    });

    it('flags discovered models preferred only when curated (ignoring :latest)', async () => {
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

  describe('discoverModels', () => {
    it('throws for an unknown provider', async () => {
      const { discoverModels } = await import('#src/providers/modelDiscovery.js');
      await expect(discoverModels('nope' as any)).rejects.toThrow('Unknown provider: nope');
    });

    it('queries the OpenAI-style endpoint and returns live ids with chat filtering', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      const fetchMock = okJson({
        data: [
          { id: 'gpt-live-chat' },
          { id: 'text-embedding-3-large' }, // dropped by chat filter
          { id: 'whisper-1' }, // dropped by chat filter
          { id: 'dall-e-3' }, // dropped by chat filter
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');

      const models = await discoverModels('openai');

      // Correct URL + bearer auth used.
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/models');
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer sk-openai-123',
      });
      // Only the chat model survives the filter.
      expect(models.map((m) => m.id)).toEqual(['gpt-live-chat']);
      // Live id not in curated preferredModels → not flagged preferred.
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;
      expect(descriptor.preferredModels).not.toContain('gpt-live-chat');
      expect(models[0].preferred).toBe(false);
    });

    it('overlays preferred flags and preserves live ordering', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;
      const preferred = descriptor.preferredModels[0];

      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-other' }, { id: preferred }] }));
      const { discoverModels } = await import('#src/providers/modelDiscovery.js');
      const models = await discoverModels('openai');

      // Order follows the live list, not the curated list.
      expect(models.map((m) => m.id)).toEqual(['gpt-other', preferred]);
      expect(models.find((m) => m.id === 'gpt-other')!.preferred).toBe(false);
      expect(models.find((m) => m.id === preferred)!.preferred).toBe(true);
    });

    it('falls back to the curated list on a network error', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('timeout');
        })
      );
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const models = await discoverModels('openai');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
      expect(models.every((m) => m.preferred)).toBe(true);
      expect(consoleUtilsMock.displayDebug).toHaveBeenCalled();
    });

    it('falls back to the curated list on a non-2xx response', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
      );
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const models = await discoverModels('openai');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
    });

    it('falls back to the curated list on a malformed / empty payload', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [] }));
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const models = await discoverModels('openai');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
    });

    it('returns the curated list without any network call when no key is present', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const models = await discoverModels('openai');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the curated list for a kind:"none" provider (google-genai) without fetching', async () => {
      systemUtilsMock.env.GOOGLE_API_KEY = 'g-123';
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModels, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'google-genai')!;

      const models = await discoverModels('google-genai');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('discovers ollama via the local /v1/models endpoint (no auth header)', async () => {
      const fetchMock = okJson({
        data: [{ id: 'qwen3:latest' }, { id: 'some-random-model:7b' }],
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModels } = await import('#src/providers/modelDiscovery.js');

      const models = await discoverModels('ollama');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://127.0.0.1:11434/v1/models');
      // No Authorization header for the local daemon.
      expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
      expect(models).toEqual([
        { id: 'qwen3:latest', preferred: true },
        { id: 'some-random-model:7b', preferred: false },
      ]);
    });

    it('parses the Anthropic native models envelope with x-api-key auth', async () => {
      systemUtilsMock.env.ANTHROPIC_API_KEY = 'sk-ant-123';
      const fetchMock = okJson({
        data: [
          { type: 'model', id: 'claude-live-1', display_name: 'Claude Live 1' },
          { type: 'model', id: 'claude-live-2', display_name: 'Claude Live 2' },
        ],
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModels } = await import('#src/providers/modelDiscovery.js');

      const models = await discoverModels('anthropic');

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/models');
      expect((init as RequestInit).headers).toMatchObject({
        'x-api-key': 'sk-ant-123',
        'anthropic-version': '2023-06-01',
      });
      expect(models.map((m) => m.id)).toEqual(['claude-live-1', 'claude-live-2']);
    });
  });

  describe('listModels', () => {
    it('delegates to discoverModels (curated fallback when offline)', async () => {
      systemUtilsMock.env.GROQ_API_KEY = 'gsk-123';
      const { listModels, PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'groq')!;
      const models = await listModels('groq');
      // fetch throws by default → curated fallback.
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
      expect(models.every((m) => m.preferred)).toBe(true);
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

    it('reports ollama available with its live model list when the daemon responds', async () => {
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'qwen3:latest' }] }));
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');
      const providers = await detectProviders();
      const ollama = providers.find((p) => p.id === 'ollama')!;
      expect(ollama.available).toBe(true);
      expect(ollama.models).toEqual([{ id: 'qwen3:latest', preferred: true }]);
    });

    it('reports ollama unavailable when the daemon does not respond', async () => {
      const { detectProviders } = await import('#src/providers/modelDiscovery.js');
      const providers = await detectProviders();
      const ollama = providers.find((p) => p.id === 'ollama')!;
      expect(ollama.available).toBe(false);
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

  // CFG-14 — the single fallback source of truth.
  describe('getCuratedFallbackModel', () => {
    it('returns the top curated preferredModels entry for every registered provider', async () => {
      const { getCuratedFallbackModel, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      for (const descriptor of PROVIDER_DESCRIPTORS) {
        expect(getCuratedFallbackModel(descriptor.id)).toBe(descriptor.preferredModels[0]);
        expect(getCuratedFallbackModel(descriptor.id)).toBeTruthy();
      }
    });

    it('throws for an unknown provider (invariant: the fallback source must be complete)', async () => {
      const { getCuratedFallbackModel } = await import('#src/providers/modelDiscovery.js');

      expect(() => getCuratedFallbackModel('nope' as any)).toThrow('No curated fallback model');
    });
  });

  // CFG-14 — the init template builder that omits `model` unless a verified id is supplied.
  describe('buildInitConfigContent', () => {
    it('omits the model key entirely when no model is provided (defers to run-time fallback)', async () => {
      const { buildInitConfigContent } = await import('#src/providers/modelDiscovery.js');
      const { CONFIG_SCHEMA_POINTER } = await import('#src/constants.js');
      const parsed = JSON.parse(buildInitConfigContent('openai'));
      expect(parsed).toEqual({ $schema: CONFIG_SCHEMA_POINTER, llm: { type: 'openai' } });
      expect('model' in parsed.llm).toBe(false);
    });

    it('includes the model when a resolved id is supplied', async () => {
      const { buildInitConfigContent } = await import('#src/providers/modelDiscovery.js');
      const { CONFIG_SCHEMA_POINTER } = await import('#src/constants.js');
      const parsed = JSON.parse(buildInitConfigContent('openai', 'gpt-live-42'));
      expect(parsed).toEqual({
        $schema: CONFIG_SCHEMA_POINTER,
        llm: { type: 'openai', model: 'gpt-live-42' },
      });
    });

    it('writes a $schema pointer first so editors validate the generated config (GS2-1)', async () => {
      const { buildInitConfigContent } = await import('#src/providers/modelDiscovery.js');
      const { CONFIG_SCHEMA_POINTER } = await import('#src/constants.js');
      const body = buildInitConfigContent('anthropic');
      // The pointer resolves to the schema shipped inside the published core package.
      expect(CONFIG_SCHEMA_POINTER).toContain('@gaunt-sloth/core/schema/gsloth-config.schema.json');
      // Written as the FIRST key so it is visible at the top of the file.
      expect(body.indexOf('"$schema"')).toBeLessThan(body.indexOf('"llm"'));
      expect(JSON.parse(body).$schema).toBe(CONFIG_SCHEMA_POINTER);
    });
  });

  // CFG-14 — (a) live resolution and (b) the omit-when-impossible fallback.
  describe('resolveInitModel', () => {
    it('(a) key present: prefers the highest-ranked curated id that is actually live', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      const { resolveInitModel, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;
      const top = descriptor.preferredModels[0];
      const second = descriptor.preferredModels[1];
      // Both a lower-ranked and the top curated id are live, alongside a non-curated one.
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-other' }, { id: second }, { id: top }] }));

      expect(await resolveInitModel('openai')).toBe(top);
    });

    it('(a) key present: falls back to the first live id when no curated id is present', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-alpha' }, { id: 'gpt-beta' }] }));
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('openai')).toBe('gpt-alpha');
    });

    it('(a) matches a curated id tolerant of an :latest suffix (ollama qwen3 -> qwen3:latest)', async () => {
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'random:7b' }, { id: 'qwen3:latest' }] }));
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      // curated `qwen3` is present as the live `qwen3:latest`; the LIVE id is returned.
      expect(await resolveInitModel('ollama')).toBe('qwen3:latest');
    });

    it('(b) no key: returns undefined without any network call (only speculative path is omit)', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('openai')).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('(b) kind:"none" provider returns undefined even with a key present', async () => {
      systemUtilsMock.env.GOOGLE_API_KEY = 'g-123';
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('google-genai')).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('(b) returns undefined on a network error (never invents a literal)', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('timeout');
        })
      );
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('openai')).toBeUndefined();
    });

    it('(b) returns undefined on an empty live catalog', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [] }));
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('openai')).toBeUndefined();
    });

    it('returns undefined for an unknown provider (never throws)', async () => {
      const { resolveInitModel } = await import('#src/providers/modelDiscovery.js');

      expect(await resolveInitModel('nope' as any)).toBeUndefined();
    });
  });
});
