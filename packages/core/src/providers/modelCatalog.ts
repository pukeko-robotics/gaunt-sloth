/**
 * @packageDocumentation
 * Model catalog (GS2-6 / B16) — enriches CLOUD model entries with cost, context-limit and
 * capability metadata sourced from {@link https://models.dev | models.dev} (MIT-licensed).
 *
 * ## What this is (and is not)
 * This is an **enrichment** layer, never a gate. The authoritative set of callable models stays
 * `/v1/models` live discovery (see `modelDiscovery.ts`). models.dev only decorates cloud model
 * ids with `{ cost, limit, modalities, reasoning, toolCall }` where a match exists; a cloud model
 * that models.dev has never heard of is still listed and still callable, just unenriched. If
 * models.dev is unreachable (offline / on-prem no-egress / down) every model keeps working — it
 * simply carries no metadata until the cache fills. Nothing here ever blocks model use.
 *
 * ## Fetch / cache shape
 * models.dev publishes a **single** dataset at {@link MODELS_DEV_URL} (`api.json`, ~3 MB); there is
 * no per-provider endpoint. So "lazy, per-provider" is realised on the **cache side**: on a miss for
 * provider *X* we fetch `api.json` once, **slice out just X's models**, and persist that slice to a
 * per-provider cache file (`~/.gsloth/model-catalog/<providerKey>.json`). Subsequent reads are served
 * **cache-first** from that per-provider file and never touch the network within the {@link CATALOG_TTL_MS}
 * TTL. A stale cache is refreshed on read, or on demand via `gth models --refresh`. If a refresh fetch
 * fails but a stale slice exists, the stale slice is returned (degrade, don't blank).
 *
 * ## Local / self-hosted
 * Only cloud providers have a models.dev key (see {@link MODELS_DEV_PROVIDER_KEY}). `ollama` and any
 * other local/self-hosted provider return `null` from {@link getProviderCatalog} **without any network
 * call** — they rely solely on `/v1/models` discovery.
 *
 * ## Attribution
 * Wherever enriched prices/metadata are shown, surface {@link CATALOG_ATTRIBUTION}. models.dev is MIT
 * licensed; we do not bundle or redistribute a seed dataset here, so no license file needs shipping.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGlobalGslothDir } from '#src/utils/globalConfigUtils.js';
import { displayDebug } from '#src/utils/consoleUtils.js';
import type { ProviderId } from '#src/providers/modelDiscovery.js';

/** The single models.dev dataset endpoint (whole catalog; sliced per-provider on our side). */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * Cache freshness window. Pricing/limit metadata is near-static, so a day between refreshes is
 * plenty; `gth models --refresh` is the manual escape hatch when a newer number is needed sooner.
 */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Catalog fetch timeout. Deliberately generous (and separate from `/v1/models` discovery's 2 s
 * interactive-path probe): `api.json` is a few MB and this fetch runs off the explicit `gth models`
 * cache-fill path, not a first-run keystroke, so latency headroom matters more than snappiness.
 */
export const CATALOG_TIMEOUT_MS = 10_000;

/** Shown next to any enriched price/metadata. Costs from models.dev are US$ per 1M tokens. */
export const CATALOG_ATTRIBUTION = '* model prices provided by models.dev';

/**
 * Map a Gaunt Sloth {@link ProviderId} to its models.dev top-level provider key. Cloud providers
 * only; local/self-hosted providers (`ollama`) are intentionally absent so they get NO catalog
 * lookup. Returns `undefined` for any provider without a models.dev slice.
 */
export const MODELS_DEV_PROVIDER_KEY: Partial<Record<ProviderId, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'google-genai': 'google',
  vertexai: 'google-vertex',
  groq: 'groq',
  deepseek: 'deepseek',
  xai: 'xai',
  openrouter: 'openrouter',
  huggingface: 'huggingface',
  // ollama — local, no models.dev entry (excluded on purpose).
};

/** Per-token cost metadata (US$ per 1M tokens), as published by models.dev. */
export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Context / output token limits. */
export interface ModelLimit {
  context?: number;
  output?: number;
}

/** Input/output modalities (e.g. `text`, `image`, `pdf`). */
export interface ModelModalities {
  input?: string[];
  output?: string[];
}

/**
 * Normalised catalog metadata for one model id — the models.dev fields we surface, camelCased and
 * detached from models.dev's raw JSON shape so a schema change there is absorbed in the parser.
 */
export interface ModelCatalogEntry {
  /** models.dev display name (e.g. "Claude Opus 4.5"). */
  name?: string;
  cost?: ModelCost;
  limit?: ModelLimit;
  modalities?: ModelModalities;
  /** True when the model exposes an extended-reasoning / thinking mode. */
  reasoning?: boolean;
  /** True when the model supports tool/function calling. */
  toolCall?: boolean;
}

/** A provider's catalog slice: model-id → metadata, plus provenance for TTL / display. */
export interface ProviderCatalog {
  /** Gaunt Sloth provider id this slice belongs to. */
  providerId: ProviderId;
  /** models.dev provider key it was sliced from. */
  providerKey: string;
  /** Epoch ms the slice was fetched (drives TTL freshness). */
  fetchedAt: number;
  /** Metadata keyed by model id, exactly as models.dev keys them. */
  models: Record<string, ModelCatalogEntry>;
}

/** Options shared by catalog reads; every field is injectable for hermetic tests. */
export interface CatalogOptions {
  /** Force a network refresh even when a fresh cache exists (backs `gth models --refresh`). */
  refresh?: boolean;
  /** Override the cache directory (defaults to `~/.gsloth/model-catalog`). */
  cacheDir?: string;
  /** Override "now" for TTL math (defaults to `Date.now()`). */
  now?: number;
  /** Override the fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Override the TTL window in ms (defaults to {@link CATALOG_TTL_MS}). */
  ttlMs?: number;
}

/** Resolve the per-provider cache directory. */
function catalogCacheDir(options: CatalogOptions): string {
  return options.cacheDir ?? resolve(getGlobalGslothDir(), 'model-catalog');
}

/** Resolve the cache file path for one models.dev provider key. */
function catalogCacheFile(providerKey: string, options: CatalogOptions): string {
  return resolve(catalogCacheDir(options), `${providerKey}.json`);
}

/**
 * Coerce one models.dev raw model object into a {@link ModelCatalogEntry}, keeping only the fields
 * we surface and only when they are the expected type (defensive against dataset drift).
 */
function normaliseEntry(raw: unknown): ModelCatalogEntry {
  const m = (raw ?? {}) as Record<string, unknown>;
  const entry: ModelCatalogEntry = {};

  if (typeof m.name === 'string') entry.name = m.name;
  if (typeof m.reasoning === 'boolean') entry.reasoning = m.reasoning;
  if (typeof m.tool_call === 'boolean') entry.toolCall = m.tool_call;

  const cost = m.cost as Record<string, unknown> | undefined;
  if (cost && typeof cost === 'object') {
    const c: ModelCost = {};
    if (typeof cost.input === 'number') c.input = cost.input;
    if (typeof cost.output === 'number') c.output = cost.output;
    if (typeof cost.cache_read === 'number') c.cacheRead = cost.cache_read;
    if (typeof cost.cache_write === 'number') c.cacheWrite = cost.cache_write;
    if (Object.keys(c).length > 0) entry.cost = c;
  }

  const limit = m.limit as Record<string, unknown> | undefined;
  if (limit && typeof limit === 'object') {
    const l: ModelLimit = {};
    if (typeof limit.context === 'number') l.context = limit.context;
    if (typeof limit.output === 'number') l.output = limit.output;
    if (Object.keys(l).length > 0) entry.limit = l;
  }

  const modalities = m.modalities as Record<string, unknown> | undefined;
  if (modalities && typeof modalities === 'object') {
    const mod: ModelModalities = {};
    if (Array.isArray(modalities.input))
      mod.input = modalities.input.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(modalities.output))
      mod.output = modalities.output.filter((x): x is string => typeof x === 'string');
    if ((mod.input?.length ?? 0) > 0 || (mod.output?.length ?? 0) > 0) entry.modalities = mod;
  }

  return entry;
}

/**
 * Slice one provider's models out of the full models.dev `api.json` payload and normalise them.
 * Returns `{}` when the provider key is absent or malformed — an empty-but-present slice, which the
 * caller still caches (models.dev simply has no data for that provider yet).
 */
function sliceProvider(payload: unknown, providerKey: string): Record<string, ModelCatalogEntry> {
  const providerBlock = (payload as Record<string, unknown> | null)?.[providerKey] as
    | { models?: Record<string, unknown> }
    | undefined;
  const models = providerBlock?.models;
  if (!models || typeof models !== 'object') return {};
  const out: Record<string, ModelCatalogEntry> = {};
  for (const [id, raw] of Object.entries(models)) {
    out[id] = normaliseEntry(raw);
  }
  return out;
}

/** Read and validate a cached per-provider slice; returns null on any miss / parse failure. */
function readCache(providerKey: string, options: CatalogOptions): ProviderCatalog | null {
  const file = catalogCacheFile(providerKey, options);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ProviderCatalog;
    if (parsed && typeof parsed.fetchedAt === 'number' && parsed.models) return parsed;
    return null;
  } catch (e) {
    displayDebug(`Model catalog cache for "${providerKey}" is unreadable: ${errMsg(e)}`);
    return null;
  }
}

/** Persist a per-provider slice to the cache (best-effort; a write failure is non-fatal). */
function writeCache(catalog: ProviderCatalog, options: CatalogOptions): void {
  try {
    const dir = catalogCacheDir(options);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(catalogCacheFile(catalog.providerKey, options), JSON.stringify(catalog), 'utf8');
  } catch (e) {
    displayDebug(`Failed to write model catalog cache for "${catalog.providerKey}": ${errMsg(e)}`);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** True when a cached slice is still within the TTL window. */
function isFresh(cache: ProviderCatalog, options: CatalogOptions): boolean {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? CATALOG_TTL_MS;
  return now - cache.fetchedAt < ttl;
}

/**
 * Get the models.dev catalog slice for one provider, cache-first.
 *
 * - **Local / self-hosted** (`ollama`, or any provider without a {@link MODELS_DEV_PROVIDER_KEY}):
 *   returns `null` immediately, with **no network call**.
 * - **Cloud, fresh cache** (and not `refresh`): returns the cached slice, no network call.
 * - **Cloud, missing / stale cache, or `refresh`**: fetches `api.json` once, slices this provider,
 *   writes the slice to the per-provider cache, and returns it.
 * - **Fetch fails**: returns the stale cached slice if one exists (degrade, don't blank), else `null`.
 *
 * NEVER throws — catalog availability must never block model use.
 */
export async function getProviderCatalog(
  providerId: ProviderId,
  options: CatalogOptions = {}
): Promise<ProviderCatalog | null> {
  const providerKey = MODELS_DEV_PROVIDER_KEY[providerId];
  if (!providerKey) return null; // local / unmapped provider → no catalog lookup at all.

  const cached = readCache(providerKey, options);
  if (cached && !options.refresh && isFresh(cached, options)) {
    return cached;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(MODELS_DEV_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) {
      displayDebug(`models.dev returned HTTP ${res.status}; using cached catalog if available.`);
      return cached; // may be stale; may be null.
    }
    const payload = await res.json();
    const catalog: ProviderCatalog = {
      providerId,
      providerKey,
      fetchedAt: options.now ?? Date.now(),
      models: sliceProvider(payload, providerKey),
    };
    writeCache(catalog, options);
    return catalog;
  } catch (e) {
    // Offline / on-prem no-egress / timeout / malformed — degrade to the stale slice or nothing.
    displayDebug(`models.dev fetch failed: ${errMsg(e)}; using cached catalog if available.`);
    return cached;
  }
}

/** A {@link ModelInfo}-shaped record decorated with optional catalog metadata. */
export interface EnrichedModel {
  id: string;
  preferred: boolean;
  /** models.dev metadata for this id, when the catalog has an entry; absent = unenriched. */
  enrichment?: ModelCatalogEntry;
}

/**
 * Enrich a provider's discovered model list with catalog metadata, cache-first.
 *
 * `/v1/models` stays authoritative: every input model is returned, in order, whether or not
 * models.dev knows it. Matched ids gain an `enrichment`; unmatched ids (and every model when the
 * catalog is unavailable or the provider is local) are returned untouched. NEVER throws.
 */
export async function enrichModels(
  providerId: ProviderId,
  models: ReadonlyArray<{ id: string; preferred: boolean }>,
  options: CatalogOptions = {}
): Promise<EnrichedModel[]> {
  let catalog: ProviderCatalog | null = null;
  try {
    catalog = await getProviderCatalog(providerId, options);
  } catch {
    catalog = null; // defensive: getProviderCatalog already swallows, but never let enrichment throw.
  }
  return models.map((m) => {
    const enrichment = catalog?.models[m.id];
    return enrichment ? { ...m, enrichment } : { id: m.id, preferred: m.preferred };
  });
}
