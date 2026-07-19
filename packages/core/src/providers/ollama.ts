import { displayWarning } from '#src/utils/consoleUtils.js';
import { env } from '#src/utils/systemUtils.js';
import type {
  BaseChatModel,
  BaseChatModelParams,
} from '@langchain/core/language_models/chat_models';
import type { ChatOllamaInput } from '@langchain/ollama';

import { writeConfigFileWithMessages } from '#src/utils/fileUtils.js';
import { buildInitConfigContent, getCuratedFallbackModel } from '#src/providers/modelDiscovery.js';

/**
 * Default Ollama daemon host, matching the Ollama CLI/library default. GS2-59 — `ChatOllama` talks
 * to the daemon's NATIVE endpoint (`/api/chat`), NOT the OpenAI-compatible `/v1` shim this provider
 * used before. The same root host is reused by `modelDiscovery.ts`'s model picker, which still
 * queries the `/v1/models` surface (discovery only); both derive from this root — they stay in sync
 * at the host level even though the two use different endpoints under it.
 */
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/**
 * GS2-59 — default context window (`num_ctx`) for Ollama models. Ollama's OWN default is 4096, but
 * gaunt-sloth's agentic prompt (system + full lean toolset + a tool result) already lands ~4000
 * tokens; at 4096 a thinking model (e.g. gemma4:31b) spends its entire remaining budget on the
 * reasoning field and emits EMPTY `content` on the turn after a tool executes — the GS2-59
 * blank-answer regression. The previous `ChatOpenAI`→`/v1` path could not fix this because the
 * OpenAI-compat shim IGNORES `num_ctx`; the native `/api/chat` path honors it.
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
 */
const DEFAULT_OLLAMA_NUM_CTX = 16384;

/**
 * Resolve the base URL for the local Ollama daemon — the NATIVE root (no `/v1` suffix; `ChatOllama`
 * appends its own `/api/chat` path). Honors the `OLLAMA_HOST` env override (the same variable the
 * Ollama CLI uses): a full URL (`http://127.0.0.1:11434`) or a bare `host:port` is normalized to
 * `http(s)://host[:port]` with any trailing slash stripped.
 */
function resolveBaseUrl(): string {
  const host = env.OLLAMA_HOST;
  if (!host) return DEFAULT_OLLAMA_HOST;
  const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return base.replace(/\/+$/, '');
}

/**
 * GS2-59 — build a native `ChatOllama` client (`@langchain/ollama`, talking to Ollama's
 * `/api/chat`). This replaces the previous `ChatOpenAI`→`/v1` client, which had two fatal
 * properties for local thinking models: it DROPPED the model's separate reasoning field (the
 * completions converter discards it — `__includeRawResponse` is openrouter-only), and it IGNORED
 * `num_ctx` so a large agentic prompt starved the answer to empty content. `ChatOllama` fixes both:
 * it honors `numCtx`, and it surfaces the model's thinking in `additional_kwargs.reasoning_content`
 * — the exact field the reasoning pipeline (`pickReasoningDelta`) already reads — so the `/reasoning`
 * panel populates with no downstream change.
 *
 * Ollama is a local, unauthenticated daemon, so the old OpenAI-client knobs are gone (2.0 migration
 * note): point elsewhere with `OLLAMA_HOST`; the previous `configuration.baseURL` / placeholder
 * `apiKey` fields no longer apply. If a reverse proxy in front of Ollama needs auth, set `headers`
 * in the config (passed straight through to `ChatOllama`).
 */
// noinspection JSUnusedGlobalSymbols
export async function processJsonConfig(
  llmConfig: ChatOllamaInput & BaseChatModelParams
): Promise<BaseChatModel> {
  const { ChatOllama } = await import('@langchain/ollama');
  const configFields: Record<string, unknown> = {
    ...llmConfig,
    model: llmConfig.model || getCuratedFallbackModel('ollama'),
    // Precedence: an explicit config `baseUrl` (the native ChatOllama field) wins, else the
    // `OLLAMA_HOST` env, else the local default. Config is the more specific/intentional signal.
    baseUrl: llmConfig.baseUrl ?? resolveBaseUrl(),
    numCtx: llmConfig.numCtx ?? DEFAULT_OLLAMA_NUM_CTX,
  };
  // Strip OpenAI-client / gaunt-sloth-internal keys ChatOllama neither needs nor understands.
  for (const key of ['type', 'apiKeyEnvironmentVariable', 'apiKey', 'configuration']) {
    delete configFields[key];
  }
  return new ChatOllama(configFields as ChatOllamaInput);
}

export function init(configFileName: string, force = false, model?: string): void {
  // Determine which content to use based on file extension
  if (!configFileName.endsWith('.json')) {
    throw new Error('Only JSON config is supported.');
  }

  writeConfigFileWithMessages(configFileName, buildInitConfigContent('ollama', model), force);
  displayWarning(
    `You need to edit your ${configFileName} to configure the model. ` +
      'Ollama runs locally and needs no API key; set OLLAMA_HOST if your daemon ' +
      'is not on the default http://127.0.0.1:11434.'
  );
}
