/**
 * @packageDocumentation
 * EXT-160 — **how many tokens the model in front of us will actually accept.**
 *
 * The pre-call context guard needs one number: the window, in tokens. This module resolves it, and
 * its contract is the part that matters — **`null` means "unknown", and an unknown window never
 * triggers anything.** A guard that guesses a window is worse than no guard: LangChain's own
 * overflow fallback guesses 4097 for anything it does not recognise, which on a 262144-token local
 * model would compact a conversation that had all the room in the world. So every source here
 * either knows or says it does not.
 *
 * The source is **injectable and per-provider**, and there are three of them, tried in a fixed
 * order by {@link resolveContextWindow}:
 *
 * 1. **ollama** — the number this session will actually put on the request (`num_ctx`), capped by
 *    the model's own `context_length`. Ollama is the only provider that cannot report an overflow
 *    at all: it silently drops the oldest tokens to fit and answers from the remainder, so knowing
 *    the number beforehand is the only defence.
 * 2. **models.dev** ([[EXT-161]]) — the cloud catalog's `limit.context`, read through the
 *    cache-first slice `providers/modelCatalog.ts` already maintains.
 * 3. **the LangChain profile** ([[EXT-161]]) — `llm.profile.maxInputTokens`, a backstop.
 *
 * **models.dev outranks the profile, and the order is a ruling rather than a preference.** The
 * profile is a table compiled into a provider package, so it moves only when that package is
 * republished and we bump it, while the catalog refreshes on a 24h TTL. That makes a profile
 * **wrong as well as absent**: measured on this repo's pinned packages, `deepseek-chat` reports a
 * 1,000,000-token window from `@langchain/deepseek`'s own table. Wrong-and-confident is the failure
 * this order avoids — an overstated window means no preventive compaction at all, which is exactly
 * the case the reactive seam then has to catch.
 *
 * **A model none of the three knows resolves to `null`, and `null` triggers nothing.** There is
 * deliberately no default anywhere in this chain: LangChain's own overflow fallback guesses 4097
 * for an unrecognised model, which on a 262144-token local model would compact a conversation that
 * had all the room in the world, and on an unknown cloud model would compact at roughly 3.3k tokens
 * with nothing on screen to say why.
 */
import { debugLog } from '#src/utils/debugUtils.js';
import {
  getProviderCatalog,
  type CatalogOptions,
  type ProviderCatalog,
} from '#src/providers/modelCatalog.js';
import type { ProviderId } from '#src/providers/modelDiscovery.js';

/**
 * GS2-59 — default context window (`num_ctx`) for Ollama models. Ollama's OWN default is 4096, but
 * gaunt-sloth's agentic prompt (system + full lean toolset + a tool result) already lands ~4000
 * tokens; at 4096 a thinking model (e.g. gemma4:31b) spends its entire remaining budget on the
 * reasoning field and emits EMPTY `content` on the turn after a tool executes — the GS2-59
 * blank-answer regression. The OpenAI-compat `/v1` shim IGNORES `num_ctx`; the native `/api/chat`
 * path honors it.
 *
 * 16384 is chosen as the largest window that is BOTH safely above the ~4000-token starvation point
 * (4× headroom for reasoning + a few tool results) AND fits constrained consumer VRAM: Ollama
 * preallocates the KV cache at `num_ctx`, so on a box where a large model already spills partly to
 * CPU (e.g. a 19GB model on ~18GB of GPU), a 32768 cache tips the GPU allocation into an
 * out-of-memory error. 16384 was verified live to run the agentic tool→synthesis turn on such a
 * box; 32768 OOM'd it. Overridable per config via `llm.numCtx` — raise it if you have the VRAM and
 * run long sessions, lower it on very tight hardware. NOTE: a per-request `num_ctx` overrides the
 * daemon's `OLLAMA_CONTEXT_LENGTH`, so a user who tuned their server window higher should set
 * `llm.numCtx` to match rather than rely on the server default.
 *
 * It lives here rather than in the provider module because two things now need it — the client the
 * provider builds and the guard that has to know what that client will send — and a second copy is
 * how the guard would come to reason about a window the request does not use.
 */
export const DEFAULT_OLLAMA_NUM_CTX = 16384;

/** How long the daemon gets to answer `/api/show` before the cap is treated as unknown. */
const SHOW_TIMEOUT_MS = 3000;

/**
 * The model's context window in tokens, or `null` when it is not known.
 *
 * Asynchronous because a source may have to ask the provider. Called on every model call, so an
 * implementation that does I/O is expected to memoise; {@link resolveContextWindowSource} does.
 */
export type ContextWindowSource = () => Promise<number | null>;

/** A source that never knows — the honest answer for every provider no source is wired for. */
export const UNKNOWN_CONTEXT_WINDOW: ContextWindowSource = async () => null;

/**
 * The fields the window resolver reads off a chat model, without depending on its class.
 *
 * Structural rather than a `ChatOllama` import on purpose: the provider module loads
 * `@langchain/ollama` dynamically so a session that never uses ollama never pays for it, and typing
 * against the class here would undo that.
 */
export interface OllamaLikeModel {
  _llmType?: () => string;
  numCtx?: number;
  model?: string;
  baseUrl?: string;
}

/** Whether a resolved chat model is the native `ChatOllama` client (`_llmType()` is `'ollama'`). */
function isOllamaModel(llm: unknown): llm is OllamaLikeModel {
  try {
    const type = (llm as OllamaLikeModel)?._llmType?.();
    return type === 'ollama';
  } catch {
    return false;
  }
}

/**
 * The model's own maximum from the daemon: `/api/show` reports `model_info` keyed by architecture,
 * e.g. `gemma4.context_length`. Returns `null` on any failure — no daemon, a model the daemon does
 * not have, a timeout, a response shaped differently by a future ollama — because a cap we could
 * not read is not a cap of zero.
 */
async function readOllamaModelCap(baseUrl: string, model: string): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { model_info?: Record<string, unknown> };
    const info = body?.model_info;
    if (!info || typeof info !== 'object') return null;
    // Prefer the architecture the daemon itself names; fall back to any `*.context_length` key so a
    // model whose `general.architecture` is missing still reports its window.
    const architecture = info['general.architecture'];
    const keys =
      typeof architecture === 'string' && architecture.length > 0
        ? [`${architecture}.context_length`]
        : Object.keys(info).filter((key) => key.endsWith('.context_length'));
    for (const key of keys) {
      const value = info[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * **The ollama window: what we send, capped by what the model can hold.**
 *
 * The effective window is `numCtx` — the number gaunt-sloth puts on every native `/api/chat`
 * request, which overrides the daemon's own `OLLAMA_CONTEXT_LENGTH` — and never the daemon default,
 * because the request is what decides. It is then capped by the model's own `context_length` from
 * `/api/show`: asking for more than the model has does not buy more room, so guarding against the
 * larger number would let exactly the truncation this guard exists to prevent happen anyway.
 *
 * **Fail-soft in one direction only.** No daemon, a slow daemon, an unreadable answer — the
 * configured number stands, because that is still the number the request will carry. Nothing here
 * throws, and nothing here degrades a known window to unknown.
 */
export function createOllamaContextWindowSource(llm: OllamaLikeModel): ContextWindowSource {
  const configured = typeof llm.numCtx === 'number' && llm.numCtx > 0 ? llm.numCtx : undefined;
  // `providers/ollama.ts` always sets `numCtx`, so the default below is reached only by a chat model
  // a JS config built by hand.
  const requested = configured ?? DEFAULT_OLLAMA_NUM_CTX;
  const baseUrl = typeof llm.baseUrl === 'string' ? llm.baseUrl : undefined;
  const model = typeof llm.model === 'string' ? llm.model : undefined;
  // Memoised: the window cannot change during a session, and the guard runs before EVERY model
  // call. A per-call `/api/show` would put a network round trip in front of each one. Held as the
  // PROMISE so concurrent calls share the one request rather than racing to make several.
  let pending: Promise<number | null> | undefined;
  return async () => {
    if (!baseUrl || !model) return requested;
    pending ??= readOllamaModelCap(baseUrl, model);
    const cap = await pending;
    if (cap === null) return requested;
    const effective = Math.min(requested, cap);
    if (effective !== requested) {
      debugLog(
        `Ollama context window: requested num_ctx ${requested} exceeds ${model}'s own ` +
          `${cap}; guarding against ${effective}.`
      );
    }
    return effective;
  };
}

/** Where a resolved context window came from — carried so `/status` can say, and a wrong one is
 * diagnosable instead of mysterious. */
export type ContextWindowOrigin = 'ollama' | 'models.dev' | 'profile' | 'unknown';

/** A resolved window and its provenance. `tokens: null` means "not known", and never "zero". */
export interface ContextWindowReading {
  tokens: number | null;
  origin: ContextWindowOrigin;
}

/** How each origin is described to a user, in a sentence that says where to go to change it. */
export const CONTEXT_WINDOW_ORIGIN_LABELS: Readonly<Record<ContextWindowOrigin, string>> = {
  ollama: "this session's num_ctx, capped by the model's own context length",
  'models.dev': 'the models.dev catalog',
  profile: "the provider package's built-in model profile",
  unknown: 'nowhere — no source knows this model, so nothing is compacted preventively',
};

/**
 * The model's window as the LangChain provider package declares it: `llm.profile.maxInputTokens`.
 *
 * A getter on `BaseLanguageModel` that the base class answers with `{}` and each provider package
 * overrides, so an id its table has never heard of yields `undefined` rather than an error —
 * measured: `gpt-4o-mini` gives 128000 and `mistralai/mistral-7b-instruct` gives nothing. Wrapped
 * in a `try` because it is a getter on someone else's object and a throw here would take down a
 * resolution that has a perfectly good answer to fall back to.
 */
export function readProfileContextWindow(llm: unknown): number | null {
  try {
    const profile = (llm as { profile?: { maxInputTokens?: unknown } } | undefined)?.profile;
    const max = profile?.maxInputTokens;
    return typeof max === 'number' && Number.isFinite(max) && max > 0 ? max : null;
  } catch {
    return null;
  }
}

/** What {@link resolveContextWindow} needs beyond the model itself — all of it injectable. */
export interface ContextWindowResolutionOptions {
  /**
   * The gth provider namespace (`anthropic`, `google-genai`, …) — `config.modelProviderType`, NOT
   * the model class's `_llmType()`. The two disagree exactly where it matters: `huggingface`
   * reports `openai`, and both Gemini providers report `google`, so keying the catalog on the
   * class's own label would read the wrong provider's slice or none at all.
   */
  providerId?: string;
  /** The model id as models.dev keys it — `llm.model`, e.g. `claude-sonnet-4-5`. */
  modelId?: string;
  /**
   * Options threaded to {@link getProviderCatalog} (cache dir, TTL, fetch impl) for hermetic tests.
   *
   * **`cacheOnly` defaults to `true` here and nowhere else.** This resolution sits in front of the
   * first model call of a session, and a cold `api.json` fetch is a few MB behind a 10 s timeout —
   * a delay the user would experience as the agent hanging before it said anything, to decide a
   * threshold that already has a fallback. `gth init` passes `cacheOnly: false` because it is an
   * explicit, interactive step that can afford to wait, and filling the cache there is what makes
   * the runtime read a hit.
   */
  catalogOptions?: CatalogOptions;
  /** Catalog reader override; {@link getProviderCatalog} when omitted. Injected by the tests. */
  catalogReader?: (
    _providerId: ProviderId,
    _options: CatalogOptions
  ) => Promise<ProviderCatalog | null>;
  /** Profile reader override; {@link readProfileContextWindow} when omitted. Injected by the tests. */
  profileReader?: (_llm: unknown) => number | null;
}

/**
 * One resolution, read two ways: {@link ResolvedContextWindow.source} for the guard, which wants
 * only the number, and {@link ResolvedContextWindow.read} for `/status`, which also wants the
 * provenance.
 *
 * They are handed out as a pair from a single factory call, over a single memoised promise, so the
 * number `/status` prints is by construction the number the guard enforced. Two independent
 * resolvers could disagree — a stale catalog on one and a fresh fetch on the other — and a
 * `/status` that describes a threshold nobody is using is worse than no `/status` line at all.
 */
export interface ResolvedContextWindow {
  /** The window in tokens, or `null` for unknown. Memoised; safe to call before every model call. */
  source: ContextWindowSource;
  /** The same resolution with its provenance attached. Shares the memoised promise. */
  read: () => Promise<ContextWindowReading>;
}

/**
 * **The one place a model is matched to a context window.** Tries ollama, then models.dev, then the
 * LangChain profile, and answers `{ tokens: null, origin: 'unknown' }` when none of them knows.
 *
 * **There is deliberately no `?? DEFAULT` anywhere on this path.** One fallback turns every unknown
 * window into a confident wrong number, which is the 4097 failure this file opens by naming.
 *
 * The whole resolution is memoised as a PROMISE, for the reason the ollama source already gives:
 * this runs before every model call, the answer cannot change during a session, and holding the
 * promise rather than the value means concurrent calls share one catalog read instead of racing to
 * make several.
 */
export function resolveContextWindow(
  llm: unknown,
  options: ContextWindowResolutionOptions = {}
): ResolvedContextWindow {
  const ollamaSource = isOllamaModel(llm) ? createOllamaContextWindowSource(llm) : null;
  const catalogReader = options.catalogReader ?? getProviderCatalog;
  const profileReader = options.profileReader ?? readProfileContextWindow;
  const providerId = options.providerId?.trim();
  const modelId = options.modelId?.trim();
  let pending: Promise<ContextWindowReading> | undefined;

  const resolve = async (): Promise<ContextWindowReading> => {
    // 1. Ollama — the number the request will actually carry. It is asked first and not merely
    //    preferred: models.dev deliberately has no ollama entry (local models have no catalog
    //    row), so for ollama there is nothing below this to fall through to.
    if (ollamaSource) {
      try {
        const tokens = await ollamaSource();
        if (tokens !== null && Number.isFinite(tokens) && tokens > 0) {
          return { tokens, origin: 'ollama' };
        }
      } catch {
        /* the ollama source is documented never to throw; a stub still might */
      }
    }
    // 2. models.dev — RULED to outrank the profile. See the module docblock for why.
    if (providerId && modelId) {
      try {
        const catalog = await catalogReader(providerId as ProviderId, {
          cacheOnly: true,
          ...options.catalogOptions,
        });
        const context = catalog?.models?.[modelId]?.limit?.context;
        if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
          return { tokens: context, origin: 'models.dev' };
        }
      } catch {
        // `getProviderCatalog` never throws by contract (catalog availability must never block a
        // model), so this catches an injected stub only — but a resolution that fell over here
        // would take the profile backstop down with it, which is the opposite of degrading well.
      }
    }
    // 3. The profile — a backstop, recorded as such so a wrong threshold is diagnosable.
    try {
      const profile = profileReader(llm);
      if (profile !== null && Number.isFinite(profile) && profile > 0) {
        return { tokens: profile, origin: 'profile' };
      }
    } catch {
      /* see readProfileContextWindow: someone else's getter */
    }
    return { tokens: null, origin: 'unknown' };
  };

  const read = (): Promise<ContextWindowReading> => (pending ??= resolve());
  return { read, source: async () => (await read()).tokens };
}

/**
 * The window as a bare number, for a caller that does not need the provenance.
 *
 * A thin wrapper over {@link resolveContextWindow} rather than a second implementation, so the two
 * cannot answer differently. With no options it consults only the sources that need no
 * configuration — ollama and the profile — which is why a plain object with neither still answers
 * `null`.
 */
export function resolveContextWindowSource(
  llm: unknown,
  options: ContextWindowResolutionOptions = {}
): ContextWindowSource {
  return resolveContextWindow(llm, options).source;
}
