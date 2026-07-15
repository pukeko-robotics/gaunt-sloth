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

    it('resolves the huggingface key from HF_TOKEN first, then its aliases in order', async () => {
      const { findApiKeyEnvVar, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'huggingface')!;

      // HF_TOKEN is canonical and wins when set.
      systemUtilsMock.env.HF_TOKEN = 'hf_canonical';
      systemUtilsMock.env.HUGGINGFACEHUB_API_TOKEN = 'hf_hub';
      expect(findApiKeyEnvVar(descriptor)).toBe('HF_TOKEN');

      // HUGGINGFACEHUB_API_TOKEN is the next alias when HF_TOKEN is unset.
      systemUtilsMock.env.HF_TOKEN = undefined;
      expect(findApiKeyEnvVar(descriptor)).toBe('HUGGINGFACEHUB_API_TOKEN');

      // HF_API_KEY is the final alias.
      systemUtilsMock.env.HUGGINGFACEHUB_API_TOKEN = undefined;
      systemUtilsMock.env.HF_API_KEY = 'hf_api';
      expect(findApiKeyEnvVar(descriptor)).toBe('HF_API_KEY');
    });
  });

  describe('huggingface descriptor', () => {
    it('carries the curated preferred models', async () => {
      const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'huggingface')!;
      expect(descriptor.apiKeyEnvironmentVariables).toEqual([
        'HF_TOKEN',
        'HUGGINGFACEHUB_API_TOKEN',
        'HF_API_KEY',
      ]);
      expect(descriptor.preferredModels).toEqual([
        'openai/gpt-oss-120b',
        'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      ]);
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

    it('orders discovered models: preferred (curated order) first, then the rest alphabetically', async () => {
      const { buildModelList, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'anthropic')!;
      const [p0, p1] = descriptor.preferredModels;
      // Discovered in a deliberately scrambled order (p1 before p0, non-preferred unsorted).
      const models = buildModelList(descriptor, ['zeta-model', p1, 'alpha-model', p0]);
      // p0, p1 in CURATED order (not discovered order), then non-preferred alphabetically.
      expect(models.map((m) => m.id)).toEqual([p0, p1, 'alpha-model', 'zeta-model']);
      expect(models.slice(0, 2).every((m) => m.preferred)).toBe(true);
      expect(models.slice(2).every((m) => !m.preferred)).toBe(true);
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

    it('overlays preferred flags and sorts preferred-first then alphabetically', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      const { PROVIDER_DESCRIPTORS } = await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;
      const preferred = descriptor.preferredModels[0];

      // Live list in arbitrary API order, preferred model buried between two others.
      vi.stubGlobal(
        'fetch',
        okJson({ data: [{ id: 'zzz-model' }, { id: preferred }, { id: 'aaa-model' }] })
      );
      const { discoverModels } = await import('#src/providers/modelDiscovery.js');
      const models = await discoverModels('openai');

      // Preferred first (pre-selected on top), then the rest alphabetically — not live order.
      expect(models.map((m) => m.id)).toEqual([preferred, 'aaa-model', 'zzz-model']);
      expect(models.find((m) => m.id === preferred)!.preferred).toBe(true);
      expect(models.find((m) => m.id === 'aaa-model')!.preferred).toBe(false);
      expect(models.find((m) => m.id === 'zzz-model')!.preferred).toBe(false);
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
      expect(all.length).toBe(10); // all descriptors

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
      // The pointer is the hosted, major-pinned schema URL (resolves for global/npx/local installs,
      // unlike a relative node_modules path). Kept in sync via websites/.../schema (PLAT-9).
      expect(CONFIG_SCHEMA_POINTER).toBe(
        'https://gauntsloth.app/schema/v2/gsloth-config.schema.json'
      );
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

  // CFG-21 — provenance (live | fallback | curated) + a per-call timeout, so the interactive
  // first-run dialog can wait longer AND tell an honest "couldn't reach" degrade apart from a
  // by-design curated list, while the background probes keep the short 2s timeout.
  describe('discoverModelsWithProvenance + interactive timeout (CFG-21)', () => {
    it('exposes a generous interactive timeout constant, longer than the 2s probe', async () => {
      const { INTERACTIVE_MODEL_FETCH_TIMEOUT_MS } =
        await import('#src/providers/modelDiscovery.js');
      expect(INTERACTIVE_MODEL_FETCH_TIMEOUT_MS).toBe(12_000);
    });

    it('status "live" for a successful, non-empty live query', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-live-chat' }] }));
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');

      const { models, status } = await discoverModelsWithProvenance('openai');
      expect(status).toBe('live');
      expect(models.map((m) => m.id)).toContain('gpt-live-chat');
    });

    it('status "fallback" when a live query was ATTEMPTED and failed (network error)', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('timeout');
        })
      );
      const { discoverModelsWithProvenance, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const { models, status } = await discoverModelsWithProvenance('openai');
      // Attempted-and-failed → the "couldn't reach" case; models are the curated stub.
      expect(status).toBe('fallback');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
    });

    it('status "fallback" on a non-2xx response', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }))
      );
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');
      expect((await discoverModelsWithProvenance('openai')).status).toBe('fallback');
    });

    it('status "fallback" on an empty live catalog', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [] }));
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');
      expect((await discoverModelsWithProvenance('openai')).status).toBe('fallback');
    });

    it('status "curated" (NOT fallback) for a cloud provider with no API key — no fetch attempted', async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');

      const { status } = await discoverModelsWithProvenance('openai');
      expect(status).toBe('curated');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('status "curated" (NOT fallback) for a kind:"none" provider even with a key set — no fetch', async () => {
      systemUtilsMock.env.GOOGLE_API_KEY = 'g-123';
      const fetchMock = vi.fn(async () => {
        throw new Error('should not be called');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');

      const { status } = await discoverModelsWithProvenance('google-genai');
      expect(status).toBe('curated');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('threads the interactive timeout to the live fetch while the default stays 2s', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-live-chat' }] }));
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const { discoverModelsWithProvenance, discoverModels, INTERACTIVE_MODEL_FETCH_TIMEOUT_MS } =
        await import('#src/providers/modelDiscovery.js');

      await discoverModelsWithProvenance('openai', {
        timeoutMs: INTERACTIVE_MODEL_FETCH_TIMEOUT_MS,
      });
      expect(timeoutSpy).toHaveBeenLastCalledWith(INTERACTIVE_MODEL_FETCH_TIMEOUT_MS);

      await discoverModels('openai'); // no options → the short default probe timeout
      expect(timeoutSpy).toHaveBeenLastCalledWith(2000);

      timeoutSpy.mockRestore();
    });

    it('detectProviders keeps the short 2s probe (never the long interactive timeout)', async () => {
      // Only ollama actually fetches here (no cloud keys set), so its liveness probe is what must
      // stay short — a long global would hang the provider step when the daemon is down.
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'qwen3:latest' }] }));
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const { detectProviders, INTERACTIVE_MODEL_FETCH_TIMEOUT_MS } =
        await import('#src/providers/modelDiscovery.js');

      await detectProviders();
      expect(timeoutSpy).toHaveBeenCalledWith(2000);
      expect(timeoutSpy).not.toHaveBeenCalledWith(INTERACTIVE_MODEL_FETCH_TIMEOUT_MS);

      timeoutSpy.mockRestore();
    });

    it('behaviorally: a never-resolving fetch falls back under a short timeout', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      // A fetch that NEVER resolves on its own — it settles only by rejecting when the caller's
      // AbortSignal fires. The outcome is therefore decided purely by whether the timeout elapses.
      const abortableFetch = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      );
      vi.stubGlobal('fetch', abortableFetch);
      const { discoverModelsWithProvenance, PROVIDER_DESCRIPTORS } =
        await import('#src/providers/modelDiscovery.js');
      const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === 'openai')!;

      const { models, status } = await discoverModelsWithProvenance('openai', { timeoutMs: 5 });
      expect(status).toBe('fallback');
      expect(models.map((m) => m.id)).toEqual(descriptor.preferredModels);
    });

    it('behaviorally: a fast fetch returns live under the long interactive timeout', async () => {
      systemUtilsMock.env.OPENAI_API_KEY = 'sk-openai-123';
      // Resolves immediately, well before the 12s interactive timeout → the live catalog wins.
      vi.stubGlobal('fetch', okJson({ data: [{ id: 'gpt-live-chat' }] }));
      const { discoverModelsWithProvenance, INTERACTIVE_MODEL_FETCH_TIMEOUT_MS } =
        await import('#src/providers/modelDiscovery.js');

      const { models, status } = await discoverModelsWithProvenance('openai', {
        timeoutMs: INTERACTIVE_MODEL_FETCH_TIMEOUT_MS,
      });
      expect(status).toBe('live');
      expect(models.map((m) => m.id)).toContain('gpt-live-chat');
    });

    it('throws for an unknown provider (mirrors discoverModels)', async () => {
      const { discoverModelsWithProvenance } = await import('#src/providers/modelDiscovery.js');
      await expect(discoverModelsWithProvenance('nope' as any)).rejects.toThrow(
        'Unknown provider: nope'
      );
    });
  });
});
