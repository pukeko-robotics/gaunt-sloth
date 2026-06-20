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
 * 2. **What models does each usable provider offer?** — a curated list of
 *    ⭐ "preferred" / tested models per cloud provider, and the live
 *    `ollama ls` inventory for the local Ollama provider.
 *
 * It deliberately performs **no** network calls to paid providers: cloud model
 * lists are the curated/tested set we ship, not a live `/models` query. Only the
 * local Ollama daemon is probed (cheap, local, free).
 *
 * The provider ids here are the same strings used by {@link LLMConfig.type} and
 * the provider factory in `#src/providers/<type>.js`, so a selected
 * `{ providerId, model }` maps directly onto a `RawGthConfig.llm`.
 */
import { availableDefaultConfigs, type ConfigType } from '#src/config.js';
import { displayDebug } from '#src/utils/consoleUtils.js';
import { env, execAsync } from '#src/utils/systemUtils.js';

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
 * Static description of a provider: how to detect its key and which models we
 * recommend. Used to build {@link DetectedProvider}s.
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
   * first. For cloud providers this is the entire offered list. For `ollama`
   * the real list comes from the daemon; this acts only as the set of model
   * ids we mark as preferred when present locally.
   */
  preferredModels: string[];
  /**
   * True when usability cannot be determined from an env var alone.
   * `vertexai` relies on gcloud Application Default Credentials and `ollama`
   * on a running local daemon, so both are reported as `available: false` by
   * env inspection and must be confirmed by the caller (or, for ollama, by
   * {@link detectOllama}).
   */
  requiresExternalAuth?: boolean;
}

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
    preferredModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnvironmentVariables: ['OPENAI_API_KEY'],
    preferredModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  },
  {
    id: 'google-genai',
    label: 'Google AI Studio (Gemini)',
    apiKeyEnvironmentVariables: ['GOOGLE_API_KEY'],
    preferredModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'vertexai',
    label: 'Google Vertex AI (Gemini)',
    apiKeyEnvironmentVariables: [],
    preferredModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    requiresExternalAuth: true,
  },
  {
    id: 'groq',
    label: 'Groq',
    apiKeyEnvironmentVariables: ['GROQ_API_KEY'],
    preferredModels: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeyEnvironmentVariables: ['DEEPSEEK_API_KEY'],
    preferredModels: ['deepseek-reasoner', 'deepseek-chat'],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    apiKeyEnvironmentVariables: ['XAI_API_KEY'],
    preferredModels: ['grok-4-1-fast', 'grok-4'],
  },
  {
    id: 'openrouter',
    // OpenRouter primarily reads OPEN_ROUTER_API_KEY (see providers/openrouter.ts),
    // OPENROUTER_API_KEY is accepted as an alias.
    label: 'OpenRouter',
    apiKeyEnvironmentVariables: ['OPEN_ROUTER_API_KEY', 'OPENROUTER_API_KEY'],
    preferredModels: ['qwen/qwen3-coder', 'anthropic/claude-sonnet-4-5'],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    apiKeyEnvironmentVariables: [],
    // Models we have tested locally; only marked preferred when actually pulled.
    preferredModels: ['qwen3-coder', 'qwen3', 'deepseek-r1', 'gemma3'],
    requiresExternalAuth: true,
  },
] as const;

/**
 * Compile-time guard: every cloud `availableDefaultConfigs` entry must have a
 * descriptor (ollama is the only extra id).
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

/** Default Ollama host, matching the Ollama CLI/library default. */
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

function resolveOllamaHost(): string {
  const host = env.OLLAMA_HOST;
  if (!host) return DEFAULT_OLLAMA_HOST;
  // OLLAMA_HOST may be a bare host:port; normalize to a URL.
  if (/^https?:\/\//.test(host)) return host.replace(/\/$/, '');
  return `http://${host}`.replace(/\/$/, '');
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
 * Probe for a local Ollama daemon and list its installed models.
 *
 * Tries the HTTP API (`GET /api/tags`) first — it is the same data the
 * `ollama list` CLI prints but does not require the binary on PATH — and falls
 * back to running `ollama ls` when the API is unreachable. Returns
 * `{ available: false }` when neither responds, so a machine without Ollama is
 * simply reported as unavailable rather than throwing.
 */
export async function detectOllama(): Promise<{ available: boolean; models: string[] }> {
  // 1. HTTP API — cheap, no binary required.
  try {
    const res = await fetch(`${resolveOllamaHost()}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const models = (body.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((name): name is string => Boolean(name));
      return { available: true, models };
    }
  } catch (e) {
    displayDebug(`Ollama HTTP probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Fall back to the CLI.
  try {
    const out = await execAsync('ollama ls');
    return { available: true, models: parseOllamaList(out) };
  } catch (e) {
    displayDebug(`Ollama CLI probe failed: ${e instanceof Error ? e.message : String(e)}`);
    return { available: false, models: [] };
  }
}

/**
 * Parse the tabular output of `ollama ls` / `ollama list` into model ids.
 * The first column ("NAME") holds the model tag; the header row is skipped.
 */
export function parseOllamaList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^NAME\s+ID\s/i.test(line) && !/^NAME\b/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((name) => name.length > 0);
}

/**
 * Build the {@link ModelInfo} list for a provider given the descriptor and an
 * optional set of model ids known to actually exist (e.g. from `ollama ls`).
 *
 * - When `discoveredModels` is omitted (cloud providers), the curated
 *   `preferredModels` are returned, all flagged ⭐ preferred.
 * - When provided (ollama), every discovered model is listed; those that also
 *   appear in the curated `preferredModels` are flagged ⭐ preferred.
 */
export function buildModelList(
  descriptor: ProviderDescriptor,
  discoveredModels?: string[]
): ModelInfo[] {
  if (!discoveredModels) {
    return descriptor.preferredModels.map((id) => ({ id, preferred: true }));
  }
  const preferred = new Set(descriptor.preferredModels);
  // Match preferred ids against the discovered tag, ignoring an explicit
  // `:latest` suffix so `qwen3` flags `qwen3:latest`.
  const isPreferred = (id: string): boolean =>
    preferred.has(id) || preferred.has(id.replace(/:latest$/, ''));
  return discoveredModels.map((id) => ({ id, preferred: isPreferred(id) }));
}

/**
 * List the models for a single provider.
 *
 * For `ollama` this probes the local daemon; for everyone else it returns the
 * curated ⭐ preferred set. Does not require the provider to be "available".
 */
export async function listModels(providerId: ProviderId): Promise<ModelInfo[]> {
  const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === providerId);
  if (!descriptor) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (descriptor.id === 'ollama') {
    const { models } = await detectOllama();
    return buildModelList(descriptor, models);
  }
  return buildModelList(descriptor);
}

/**
 * Detect every known provider on this machine and list its models.
 *
 * - Cloud providers are `available` when one of their API-key env vars is set.
 * - `vertexai` is reported with `requiresExternalAuth: true` and
 *   `available: false`; usability via gcloud ADC cannot be cheaply verified
 *   here and is left to the caller / a live run.
 * - `ollama` is `available` when a local daemon responds, and its model list is
 *   the live `ollama ls` inventory.
 *
 * @param options.includeUnavailable when true (default), every provider is
 *   returned (so a dialog can offer "set a key" flows); when false, only
 *   available providers are returned.
 */
export async function detectProviders(
  options: { includeUnavailable?: boolean } = {}
): Promise<DetectedProvider[]> {
  const { includeUnavailable = true } = options;

  // Probe ollama once, in parallel with the (synchronous) env checks.
  const ollamaProbe = detectOllama();

  const results: DetectedProvider[] = [];
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (descriptor.id === 'ollama') {
      const { available, models } = await ollamaProbe;
      results.push({
        id: descriptor.id,
        label: descriptor.label,
        available,
        requiresExternalAuth: true,
        models: buildModelList(descriptor, models),
      });
      continue;
    }

    const apiKeyEnvironmentVariable = findApiKeyEnvVar(descriptor);
    results.push({
      id: descriptor.id,
      label: descriptor.label,
      available: Boolean(apiKeyEnvironmentVariable),
      apiKeyEnvironmentVariable,
      requiresExternalAuth: Boolean(descriptor.requiresExternalAuth),
      models: buildModelList(descriptor),
    });
  }

  return includeUnavailable ? results : results.filter((p) => p.available);
}
