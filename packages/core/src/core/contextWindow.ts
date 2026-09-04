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
 * The source is **injectable and per-provider**. This node wires exactly one — ollama — because
 * ollama is the only provider that cannot report an overflow at all: it silently drops the oldest
 * tokens to fit `num_ctx` and answers from the remainder, so the only defence is to know the number
 * before the call. [[EXT-161]] adds the remaining sources (models.dev, config, the LangChain
 * profile) behind {@link resolveContextWindowSource}; every other provider resolves to `null` here
 * and is guarded reactively instead, by the compact-and-retry seam on the thrown error.
 */
import { debugLog } from '#src/utils/debugUtils.js';

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

/**
 * The one place a provider is matched to a window source.
 *
 * Ollama resolves to {@link createOllamaContextWindowSource}; everything else resolves to
 * {@link UNKNOWN_CONTEXT_WINDOW}, which is why the guard is installed unconditionally and is
 * nonetheless inert on nine of ten providers — no branch at the wiring site decides whether to
 * guard, so [[EXT-161]] adds providers here and nowhere else.
 *
 * **There is deliberately no `?? DEFAULT` on this path.** One fallback anywhere in the chain turns
 * every unknown window into a confident wrong number, which is the 4097 failure this file opens by
 * naming.
 */
export function resolveContextWindowSource(llm: unknown): ContextWindowSource {
  if (isOllamaModel(llm)) return createOllamaContextWindowSource(llm);
  return UNKNOWN_CONTEXT_WINDOW;
}
