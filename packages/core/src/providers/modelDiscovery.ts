/**
 * @packageDocumentation
 * Provider / API-key detection and per-provider model listing.
 *
 * This is the data layer that powers the first-run configuration dialog (CFG-2),
 * ACP model selection (CFG-5) and downstream propagation (CFG-6). It answers two
 * questions without ever instantiating an LLM:
 *
 * 1. **Which providers are usable on this machine?** — by inspecting the
 *    environment (and config) for API keys, and by probing for a local Ollama.
 * 2. **What models does each usable provider offer?** — a live `GET /v1/models`
 *    query for providers that expose an OpenAI-compatible (or, for Anthropic, a
 *    native) models endpoint, falling back to a curated ⭐ "preferred" / tested
 *    list when the live query is unavailable, errors, or is empty.
 *
 * Live discovery (CFG-12) is best-effort and never fatal: a bad key, an offline
 * machine, or a malformed response simply degrades to the curated catalog so the
 * first-run dialog always has something to show. The curated `preferredModels`
 * therefore do double duty — the ⭐ ranking overlay over live ids **and** the
 * offline/timeout fallback.
 *
 * The provider ids here are the same strings used by {@link LLMConfig.type} and
 * the provider factory in `#src/providers/<type>.js`, so a selected
 * `{ providerId, model }` maps directly onto a `RawGthConfig.llm`.
 */
import { availableDefaultConfigs, type ConfigType } from '#src/config.js';
import { CONFIG_SCHEMA_POINTER } from '#src/constants.js';
import { displayDebug } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';

/**
 * Provider identifiers understood by model discovery. These match the provider
 * factory module names (`#src/providers/<id>.js`) and {@link LLMConfig.type},
 * plus `ollama` for locally-served models.
 */
export type ProviderId = ConfigType | 'ollama';

/**
 * A single model offered by a provider.
 */
export interface ModelInfo {
  /** Model id as it should be written into config (`llm.model`). */
  id: string;
  /**
   * Whether this is a ⭐ "preferred" / tested model. The first-run dialog
   * should surface preferred models first / pre-selected.
   */
  preferred: boolean;
}

/**
 * How a provider's live model catalog can be queried.
 *
 * - `openai`  — an OpenAI-compatible `GET /v1/models` (`{ data: [{ id }] }`).
 *   Covers openai, openrouter, groq, deepseek, xai and ollama (local).
 * - `anthropic` — Anthropic's native `GET /v1/models`
 *   (`{ data: [{ type, id, display_name }] }`) with `x-api-key` auth.
 * - `none`     — no cheap live endpoint; stay on the curated list
 *   (google-genai, vertexai).
 */
export type DiscoveryKind = 'openai' | 'anthropic' | 'none';

/**
 * Per-provider live-discovery adapter. Bundled on the {@link ProviderDescriptor}
 * so {@link discoverModels} can be fully data-driven.
 */
export interface DiscoveryConfig {
  kind: DiscoveryKind;
  /**
   * The models endpoint to fetch. `host` is supplied only for ollama (the
   * resolved daemon host); cloud providers ignore it and return a fixed URL.
   */
  modelsUrl?: (host?: string) => string;
  /** Build the auth headers from the resolved API key (may be empty for ollama). */
  authHeader?: (key: string) => Record<string, string>;
  /**
   * Keep only chat-capable model ids. Live endpoints return embeddings, TTS,
   * whisper, image, guard, etc. alongside chat models; this prunes them.
   * When omitted, all returned ids are kept.
   */
  filter?: (id: string) => boolean;
}

/**
 * Static description of a provider: how to detect its key, how to discover its
 * live models, and which models we recommend. Used to build
 * {@link DetectedProvider}s.
 */
export interface ProviderDescriptor {
  id: ProviderId;
  /** Human-friendly name for dialogs. */
  label: string;
  /**
   * Environment variables that, when set to a non-empty value, indicate this
   * provider has a usable API key. Checked in order; the first match wins.
   * Empty for providers that don't authenticate via an env var (`vertexai`,
   * which uses gcloud ADC, and `ollama`, which is local).
   */
  apiKeyEnvironmentVariables: string[];
  /**
   * Curated ⭐ "preferred" / tested models for this provider, most-recommended
   * first. Used as the ⭐ ranking overlay over live-discovered ids and as the
   * fallback catalog when live discovery is unavailable.
   */
  preferredModels: string[];
  /** Live-discovery adapter for this provider. */
  discovery: DiscoveryConfig;
  /**
   * True when usability cannot be determined from an env var alone.
   * `vertexai` relies on gcloud Application Default Credentials and `ollama`
   * on a running local daemon, so both are reported as `available: false` by
   * env inspection (ollama is then confirmed by a live probe in
   * {@link detectProviders}).
   */
  requiresExternalAuth?: boolean;
}

/** Default Ollama host, matching the Ollama CLI/library default. */
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

function resolveOllamaHost(): string {
  const host = env.OLLAMA_HOST;
  if (!host) return DEFAULT_OLLAMA_HOST;
  // OLLAMA_HOST may be a bare host:port; normalize to a URL.
  if (/^https?:\/\//.test(host)) return host.replace(/\/$/, '');
  return `http://${host}`.replace(/\/$/, '');
}

/** `Authorization: Bearer <key>` — the OpenAI-compatible auth scheme. */
const bearer = (key: string): Record<string, string> => ({ Authorization: `Bearer ${key}` });

/**
 * Chat-only filter for OpenAI-shaped catalogs. Drops the obvious non-chat model
 * classes (embeddings, audio/speech, image, moderation, guard) that the live
 * endpoints return alongside chat models. Deliberately permissive: anything not
 * recognised as non-chat is kept, so a new chat family is never hidden.
 */
const NON_CHAT_PATTERN =
  /(embed|moderation|whisper|tts|audio|transcribe|dall-e|image|imagine|guard|rerank|vision-ocr)/i;
const chatOnly = (id: string): boolean => !NON_CHAT_PATTERN.test(id);

/**
 * Provider registry. The curated `preferredModels` are the models we have
 * tested with Gaunt Sloth's agent loop; defaults mirror the `init` templates in
 * each `#src/providers/<id>.js` factory.
 */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    apiKeyEnvironmentVariables: ['ANTHROPIC_API_KEY'],
    preferredModels: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'],
    discovery: {
      kind: 'anthropic',
      modelsUrl: () => 'https://api.anthropic.com/v1/models',
      authHeader: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnvironmentVariables: ['OPENAI_API_KEY'],
    preferredModels: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.4-nano'],
    discovery: {
      kind: 'openai',
      modelsUrl: () => 'https://api.openai.com/v1/models',
      authHeader: bearer,
      filter: chatOnly,
    },
  },
  {
    id: 'google-genai',
    label: 'Google AI Studio (Gemini)',
    apiKeyEnvironmentVariables: ['GOOGLE_API_KEY'],
    // AI Studio exposes the 3.1 Pro tier only as a `-preview` slug.
    preferredModels: [
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
    discovery: { kind: 'none' },
  },
  {
    id: 'vertexai',
    label: 'Google Vertex AI (Gemini)',
    apiKeyEnvironmentVariables: [],
    // Vertex publishes the same family under bare (non-preview) slugs.
    preferredModels: ['gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    discovery: { kind: 'none' },
    requiresExternalAuth: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    apiKeyEnvironmentVariables: ['GROQ_API_KEY'],
    preferredModels: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    discovery: {
      kind: 'openai',
      // Groq's OpenAI-compatible surface lives under /openai/v1.
      modelsUrl: () => 'https://api.groq.com/openai/v1/models',
      authHeader: bearer,
      filter: chatOnly,
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnvironmentVariables: ['DEEPSEEK_API_KEY'],
    preferredModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    discovery: {
      kind: 'openai',
      modelsUrl: () => 'https://api.deepseek.com/v1/models',
      authHeader: bearer,
      filter: chatOnly,
    },
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    apiKeyEnvironmentVariables: ['XAI_API_KEY'],
    preferredModels: ['grok-4.3', 'grok-build-0.1'],
    discovery: {
      kind: 'openai',
      modelsUrl: () => 'https://api.x.ai/v1/models',
      authHeader: bearer,
      filter: chatOnly,
    },
  },
  {
    id: 'openrouter',
    // OpenRouter primarily reads OPEN_ROUTER_API_KEY (see providers/openrouter.ts),
    // OPENROUTER_API_KEY is accepted as an alias.
    label: 'OpenRouter',
    apiKeyEnvironmentVariables: ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
    preferredModels: ['qwen/qwen3-coder', 'anthropic/claude-sonnet-5', 'openai/gpt-5.5'],
    discovery: {
      kind: 'openai',
      modelsUrl: () => 'https://openrouter.ai/api/v1/models',
      authHeader: bearer,
      filter: chatOnly,
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    apiKeyEnvironmentVariables: [],
    // Models we have tested locally; only marked preferred when actually pulled.
    preferredModels: ['qwen3-coder', 'qwen3', 'deepseek-r1', 'gemma3'],
    discovery: {
      kind: 'openai',
      // Ollama serves an OpenAI-compatible /v1/models on the local daemon.
      modelsUrl: (host) => `${host ?? resolveOllamaHost()}/v1/models`,
      authHeader: () => ({}),
    },
    requiresExternalAuth: true,
  },
] as const;

/**
 * Compile-time guard: every `availableDefaultConfigs` entry (including ollama)
 * must have a model-discovery descriptor.
 */
const DESCRIPTOR_IDS = new Set(PROVIDER_DESCRIPTORS.map((d) => d.id));
for (const cfg of availableDefaultConfigs) {
  if (!DESCRIPTOR_IDS.has(cfg)) {
    // This is a developer error surfaced at module load only in debug runs.
    displayDebug(`Provider "${cfg}" has no model-discovery descriptor.`);
  }
}

/**
 * Result of detecting one provider.
 */
export interface DetectedProvider {
  id: ProviderId;
  label: string;
  /**
   * True when the provider looks usable on this machine: an API key env var is
   * set, or (for ollama) a local daemon responded.
   */
  available: boolean;
  /**
   * The environment variable that supplied the key, when {@link available} via
   * an env var. Undefined for env-less providers (vertexai, ollama).
   */
  apiKeyEnvironmentVariable?: string;
  /** True when this provider authenticates outside of an env var. */
  requiresExternalAuth: boolean;
  /** Models offered by this provider, ⭐ preferred ones flagged. */
  models: ModelInfo[];
}

/**
 * Resolve the API key for a cloud provider by checking its env vars in order.
 * @returns the matching env var name, or undefined when none is set.
 */
export function findApiKeyEnvVar(descriptor: ProviderDescriptor): string | undefined {
  for (const name of descriptor.apiKeyEnvironmentVariables) {
    const value = env[name];
    if (value && value.trim().length > 0) {
      return name;
    }
  }
  return undefined;
}

/**
 * Build the {@link ModelInfo} list for a provider given the descriptor and an
 * optional set of model ids known to actually exist (e.g. from a live
 * `/v1/models` query or the local Ollama daemon).
 *
 * - When `discoveredModels` is omitted, the curated `preferredModels` are
 *   returned, all flagged ⭐ preferred.
 * - When provided, every discovered model is listed; those that also appear in
 *   the curated `preferredModels` are flagged ⭐ preferred. The list is ordered
 *   **preferred first** (in curated order, so the recommended default sits on top
 *   and is pre-selected), then every other discovered model **alphabetically** —
 *   so a large catalog (e.g. OpenRouter's 200+ models) is navigable instead of
 *   arriving in the endpoint's arbitrary order.
 */
export function buildModelList(
  descriptor: ProviderDescriptor,
  discoveredModels?: string[]
): ModelInfo[] {
  if (!discoveredModels) {
    return descriptor.preferredModels.map((id) => ({ id, preferred: true }));
  }
  // Rank a discovered id by its position in the curated list, ignoring an explicit
  // `:latest` suffix so `qwen3` matches `qwen3:latest`; `undefined` = not preferred.
  const preferredRank = new Map(descriptor.preferredModels.map((id, i) => [id, i]));
  const rankOf = (id: string): number | undefined =>
    preferredRank.get(id) ?? preferredRank.get(id.replace(/:latest$/, ''));
  const isPreferred = (id: string): boolean => rankOf(id) !== undefined;
  const ordered = [...discoveredModels].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== undefined && rb !== undefined) return ra - rb; // both preferred → curated order
    if (ra !== undefined) return -1; // preferred sorts before non-preferred
    if (rb !== undefined) return 1;
    return a.localeCompare(b); // neither preferred → alphabetical
  });
  return ordered.map((id) => ({ id, preferred: isPreferred(id) }));
}

/**
 * The single fallback source of truth for a provider's default model id (CFG-14).
 *
 * Returns the top curated ⭐ `preferredModels` entry for the provider — the one
 * id that provider factories fall back to when a config carries no `model`, and
 * the id first-run writes when live discovery is impossible. Centralising it here
 * means the fallback lives in exactly ONE place (the curated registry above)
 * instead of being duplicated as a literal in every `providers/<id>.ts`.
 *
 * Every registered provider is required to carry at least one curated model, so
 * this always resolves for a known id; it throws for an unknown provider or a
 * provider whose `preferredModels` is empty (a developer error — the invariant
 * that the fallback source is complete would otherwise fail silently).
 *
 * @returns the curated default model id (always defined for a known provider).
 */
export function getCuratedFallbackModel(providerId: ProviderId): string {
  const model = PROVIDER_DESCRIPTORS.find((d) => d.id === providerId)?.preferredModels[0];
  if (!model) {
    throw new Error(`No curated fallback model registered for provider "${providerId}".`);
  }
  return model;
}

/**
 * Build the minimal `.gsloth.config.json` body an `init` template writes for a
 * provider (CFG-14). When `model` is omitted, the `model` key is left OUT of the
 * config entirely, so the provider factory resolves it at run time from
 * {@link getCuratedFallbackModel} — the single curated source that tracks the
 * installed version, rather than a literal frozen into the user's file that 404s
 * once the model is retired.
 *
 * A `$schema` pointer ({@link CONFIG_SCHEMA_POINTER}) is written first so editors offer
 * autocomplete/validation against the shipped JSON Schema (GS2-1). `$schema` is a known,
 * runtime-ignored config field (see the zod schema), so it never affects loading.
 */
export function buildInitConfigContent(providerId: ProviderId, model?: string): string {
  const llm: { type: ProviderId; model?: string } = { type: providerId };
  if (model) llm.model = model;
  return JSON.stringify({ $schema: CONFIG_SCHEMA_POINTER, llm }, null, 2);
}

/** Live-fetch timeout: short enough to never block first-run for long. */
const DISCOVERY_TIMEOUT_MS = 2000;

/**
 * Parse the `id`s out of a models-endpoint payload. Both the OpenAI-compatible
 * shape and Anthropic's native shape use a top-level `{ data: [{ id }] }`
 * envelope, so a single parser covers both `kind`s.
 */
function parseModelIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown }> } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Internal: run live discovery for one descriptor, distinguishing a successful
 * live query from a curated fallback.
 *
 * @returns `{ models, live }` where `live` is true only when the models came
 *   from a successful, non-empty live `/v1/models` query (used as the Ollama
 *   availability signal). `live` is false for curated/fallback results.
 */
async function discoverModelsInternal(
  descriptor: ProviderDescriptor
): Promise<{ models: ModelInfo[]; live: boolean }> {
  const curated = (): { models: ModelInfo[]; live: boolean } => ({
    models: buildModelList(descriptor),
    live: false,
  });

  const { discovery } = descriptor;
  if (discovery.kind === 'none' || !discovery.modelsUrl) {
    return curated();
  }

  // Resolve an API key for cloud providers; ollama needs none.
  let key = '';
  if (descriptor.id !== 'ollama') {
    const envVar = findApiKeyEnvVar(descriptor);
    if (!envVar) {
      // No key → don't hit the network; show the curated catalog.
      return curated();
    }
    key = env[envVar] ?? '';
  }

  try {
    const url = discovery.modelsUrl(descriptor.id === 'ollama' ? resolveOllamaHost() : undefined);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(discovery.authHeader ? discovery.authHeader(key) : {}),
    };
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      displayDebug(`Model discovery for "${descriptor.id}" returned HTTP ${res.status}.`);
      return curated();
    }
    const body = await res.json();
    let ids = parseModelIds(body);
    if (discovery.filter) {
      ids = ids.filter(discovery.filter);
    }
    if (ids.length === 0) {
      displayDebug(`Model discovery for "${descriptor.id}" returned no usable models.`);
      return curated();
    }
    return { models: buildModelList(descriptor, ids), live: true };
  } catch (e) {
    displayDebug(
      `Model discovery for "${descriptor.id}" failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return curated();
  }
}

/**
 * Discover the models for a single provider.
 *
 * - `kind: 'none'` → returns the curated `buildModelList(descriptor)`.
 * - `kind: 'openai' | 'anthropic'` → fetches the models endpoint with a short
 *   timeout, parses `data[].id`, applies the chat-only `filter`, and overlays
 *   the ⭐ preferred flags via `buildModelList(descriptor, liveIds)`.
 *
 * Best-effort: any error / non-2xx / malformed / empty payload falls back to
 * the curated list. This function NEVER throws — a bad key must degrade to the
 * curated catalog, not break first-run config.
 *
 * Cloud providers are only probed live when an API key is present; without a key
 * the curated catalog is returned directly. Ollama (no key, local daemon) is
 * always probed.
 */
export async function discoverModels(providerId: ProviderId): Promise<ModelInfo[]> {
  const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === providerId);
  if (!descriptor) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  const { models } = await discoverModelsInternal(descriptor);
  return models;
}

/**
 * List the models for a single provider.
 *
 * Live-discovers from the provider's models endpoint where possible (with a
 * curated fallback); returns the curated set for `kind: 'none'` providers. Does
 * not require the provider to be "available".
 */
export async function listModels(providerId: ProviderId): Promise<ModelInfo[]> {
  return discoverModels(providerId);
}

/**
 * Resolve the model id that `init` should bake into a generated config for a
 * provider (CFG-14) — the safeguard against writing a speculative id that 404s
 * once the model is retired.
 *
 * - **Live discovery possible** (a key / running daemon and a responding
 *   `/v1/models` endpoint): returns a *verified-present* id — the highest-ranked
 *   curated ⭐ id that is actually in the live list (matched tolerant of an
 *   `:latest` suffix), or, when no curated id is live, the first live id.
 * - **Live discovery impossible** (`kind: 'none'`, no key, offline, empty
 *   catalog): returns `undefined`. This is the ONLY speculative path, and it
 *   deliberately declines to invent a literal: the caller OMITS `model` so the
 *   provider factory falls back to {@link getCuratedFallbackModel} at run time
 *   (a single curated source that upgrades with the installed version).
 *
 * Never throws — a bad key or network error degrades to `undefined`, mirroring
 * {@link discoverModels}.
 */
export async function resolveInitModel(providerId: ProviderId): Promise<string | undefined> {
  const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === providerId);
  if (!descriptor) return undefined;
  const { models, live } = await discoverModelsInternal(descriptor);
  // Not a live catalog → do NOT emit a speculative literal; defer to the run-time
  // curated fallback by omitting `model`.
  if (!live || models.length === 0) return undefined;
  // Prefer the highest-ranked curated id that is actually present in the live
  // list, tolerating an explicit `:latest` suffix (so curated `qwen3` matches a
  // live `qwen3:latest`).
  const strip = (id: string): string => id.replace(/:latest$/, '');
  const liveByStripped = new Map(models.map((m) => [strip(m.id), m.id]));
  for (const curated of descriptor.preferredModels) {
    const hit = liveByStripped.get(strip(curated));
    if (hit) return hit;
  }
  // No curated id is live → the first live id is still a verified-present choice.
  return models[0].id;
}

/**
 * Detect every known provider on this machine and list its models.
 *
 * - Cloud providers are `available` when one of their API-key env vars is set;
 *   their model list is live-discovered (curated fallback) when a key is present.
 * - `vertexai` is reported with `requiresExternalAuth: true` and
 *   `available: false`; usability via gcloud ADC cannot be cheaply verified
 *   here and is left to the caller / a live run.
 * - `ollama` is `available` when the local daemon's `/v1/models` responds, and
 *   its model list is that live inventory.
 *
 * @param options.includeUnavailable when true (default), every provider is
 *   returned (so a dialog can offer "set a key" flows); when false, only
 *   available providers are returned.
 */
export async function detectProviders(
  options: { includeUnavailable?: boolean } = {}
): Promise<DetectedProvider[]> {
  const { includeUnavailable = true } = options;

  const results: DetectedProvider[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (descriptor.id === 'ollama') {
      // A successful, non-empty /v1/models probe = the daemon is available.
      const { models, live } = await discoverModelsInternal(descriptor);
      results.push({
        id: descriptor.id,
        label: descriptor.label,
        available: live,
        requiresExternalAuth: true,
        models,
      });
      continue;
    }

    const apiKeyEnvironmentVariable = findApiKeyEnvVar(descriptor);
    const models = await discoverModels(descriptor.id);
    results.push({
      id: descriptor.id,
      label: descriptor.label,
      available: Boolean(apiKeyEnvironmentVariable),
      apiKeyEnvironmentVariable,
      requiresExternalAuth: Boolean(descriptor.requiresExternalAuth),
      models,
    });
  }

  return includeUnavailable ? results : results.filter((p) => p.available);
}
