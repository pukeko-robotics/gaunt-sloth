import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Keep debug output quiet and the module hermetic w.r.t. the real console.
vi.mock('#src/utils/consoleUtils.js', () => ({
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
}));

/**
 * A trimmed models.dev `api.json` payload: two cloud providers (anthropic, openai) each with a
 * couple of models, plus an unrelated provider to prove per-provider slicing keeps others out.
 */
const MODELS_DEV_PAYLOAD = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus-4-5': {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        tool_call: true,
        limit: { context: 200000, output: 32000 },
        cost: { input: 1, output: 5 },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', tool_call: true, cost: { input: 2, output: 8 } },
    },
  },
  requesty: {
    id: 'requesty',
    name: 'Requesty',
    models: { 'xai/grok-4': { id: 'xai/grok-4', name: 'Grok 4' } },
  },
};

/** A fetch stub that resolves with the models.dev payload; call count is assertable. */
function okFetch() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => MODELS_DEV_PAYLOAD,
  })) as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

describe('modelCatalog', () => {
  let cacheDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheDir = mkdtempSync(resolve(tmpdir(), 'gth-catalog-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('lazily fetches a provider slice, caches it per-provider, and serves the cache on re-read', async () => {
    const { getProviderCatalog } = await import('#src/providers/modelCatalog.js');
    const fetchImpl = okFetch();
    const now = 1_000_000;

    const first = await getProviderCatalog('anthropic', { cacheDir, fetchImpl, now });
    expect(first).not.toBeNull();
    // Only anthropic's models landed in the slice — not openai's, not requesty's.
    expect(Object.keys(first!.models).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-5']);
    expect(first!.models['gpt-5.5' as keyof typeof first.models]).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A per-provider cache file was written and contains ONLY anthropic's slice.
    const cacheFile = resolve(cacheDir, 'anthropic.json');
    expect(existsSync(cacheFile)).toBe(true);
    const onDisk = JSON.parse(readFileSync(cacheFile, 'utf8'));
    expect(onDisk.providerKey).toBe('anthropic');
    expect(Object.keys(onDisk.models).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-5']);
    expect(onDisk.models['gpt-5.5']).toBeUndefined();

    // Second read within TTL is served cache-first: no additional network call.
    const second = await getProviderCatalog('anthropic', { cacheDir, fetchImpl, now });
    expect(second!.models['claude-opus-4-5'].cost).toEqual({
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1 — no re-fetch.
  });

  it('enriches known cloud models but never gates: an unknown model stays listed, unenriched', async () => {
    const { enrichModels } = await import('#src/providers/modelCatalog.js');
    const fetchImpl = okFetch();

    const input = [
      { id: 'claude-opus-4-5', preferred: true }, // present in models.dev
      { id: 'claude-some-future-model', preferred: false }, // absent from models.dev
    ];
    const enriched = await enrichModels('anthropic', input, { cacheDir, fetchImpl });

    // Both models are still listed (order preserved) — /v1/models stays authoritative.
    expect(enriched.map((m) => m.id)).toEqual(['claude-opus-4-5', 'claude-some-future-model']);
    // Known model gained metadata.
    expect(enriched[0].enrichment?.limit?.context).toBe(200000);
    expect(enriched[0].enrichment?.toolCall).toBe(true);
    // Unknown model is present but carries NO enrichment (callable-but-unenriched).
    expect(enriched[1].enrichment).toBeUndefined();
  });

  it('degrades gracefully when models.dev is unreachable: models still list, just unenriched', async () => {
    const { getProviderCatalog, enrichModels } = await import('#src/providers/modelCatalog.js');
    const throwingFetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND models.dev');
    }) as unknown as typeof fetch;

    // No cache yet + fetch throws → null catalog, no crash.
    const catalog = await getProviderCatalog('anthropic', { cacheDir, fetchImpl: throwingFetch });
    expect(catalog).toBeNull();

    // enrichModels tolerates the outage: every model passes through unchanged, unenriched.
    const enriched = await enrichModels('anthropic', [{ id: 'claude-opus-4-5', preferred: true }], {
      cacheDir,
      fetchImpl: throwingFetch,
    });
    expect(enriched).toEqual([{ id: 'claude-opus-4-5', preferred: true }]);
  });

  it('--refresh forces a re-fetch past the TTL even when a fresh cache exists', async () => {
    const { getProviderCatalog } = await import('#src/providers/modelCatalog.js');
    const fetchImpl = okFetch();
    const now = 2_000_000;

    // Prime the cache.
    await getProviderCatalog('anthropic', { cacheDir, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Same `now` → cache is fresh, so a plain read must NOT re-fetch.
    await getProviderCatalog('anthropic', { cacheDir, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // refresh:true bypasses the TTL and re-fetches.
    await getProviderCatalog('anthropic', { cacheDir, fetchImpl, now, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('excludes local/self-hosted providers: ollama gets no models.dev lookup at all', async () => {
    const { getProviderCatalog, enrichModels } = await import('#src/providers/modelCatalog.js');
    const fetchImpl = okFetch();

    const catalog = await getProviderCatalog('ollama', { cacheDir, fetchImpl });
    expect(catalog).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // never hit the network for a local provider.

    // A local model still lists (via /v1/models upstream), just never enriched.
    const enriched = await enrichModels('ollama', [{ id: 'qwen3-coder', preferred: true }], {
      cacheDir,
      fetchImpl,
    });
    expect(enriched).toEqual([{ id: 'qwen3-coder', preferred: true }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours a stale cache: past-TTL read re-fetches, and a failed refresh keeps the stale slice', async () => {
    const { getProviderCatalog } = await import('#src/providers/modelCatalog.js');
    const okFetchImpl = okFetch();

    // Seed the cache at t0.
    await getProviderCatalog('anthropic', { cacheDir, fetchImpl: okFetchImpl, now: 0 });
    expect(okFetchImpl).toHaveBeenCalledTimes(1);

    // Well past the TTL, but the refresh fetch fails → the stale slice is still returned.
    const failing = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const stale = await getProviderCatalog('anthropic', {
      cacheDir,
      fetchImpl: failing,
      now: 999_999_999_999,
    });
    expect(stale).not.toBeNull();
    expect(stale!.models['claude-opus-4-5']).toBeDefined();
  });
});
