/**
 * @packageDocumentation
 * Opt-in middleware that turns a frontend "capture image" tool result into a vision message the
 * model can actually see.
 *
 * A browser/frontend tool such as CopilotKit's `capture_image` fulfils client-side and posts its
 * result back to gth's AG-UI server as a trailing `tool`-role message whose content is a JSON
 * string `{"mimeType":"image/...","data":"<base64>"}`. gth hands that to the model as a plain-string
 * ToolMessage — no vision block — so the model literally cannot see the photo. This middleware
 * detects that ToolMessage in `beforeModel`, parses the envelope, and injects a `HumanMessage`
 * carrying a provider-appropriate vision block before the next model call.
 *
 * Strictly opt-in: it fires ONLY when referenced by name in `config.middleware`
 * (`"middleware": ["frontend-image-injection"]`), never auto-injected. Promoted from
 * pukeko-robot-controller's proven middleware (RC-21), minus the robot-specific motion-tool coupling.
 */

import { createMiddleware, type AgentMiddleware } from 'langchain';
import { HumanMessage, isToolMessage } from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';

/**
 * The tool-result envelope a frontend capture tool posts back as the ToolMessage's (string) content:
 * either an image (`mimeType` + base64 `data`) or an `{ error }` note when the capture failed.
 */
interface ImagePayload {
  mimeType?: string;
  data?: string;
  error?: string;
}

/** Default frontend capture tool name. Overridable via the `toolName` middleware setting. */
export const DEFAULT_CAPTURE_TOOL_NAME = 'capture_image';

export interface FrontendImageInjectionOptions {
  /**
   * Provider selecting the vision-block shape. Derived by the registry factory from
   * `gthConfig.modelProviderType` (the raw `llm.type`), falling back to `llm._llmType()`. One of
   * gth's provider strings (`anthropic`, `openai`, `openrouter`, `deepseek`, `xai`, `groq`,
   * `ollama`, `google-genai`, `vertexai`, `huggingface`, …); unknown values fall to the standard
   * base64 block.
   */
  provider: string;
  /**
   * Tool name whose `{mimeType,data}` result is converted into a vision message. Defaults to
   * {@link DEFAULT_CAPTURE_TOOL_NAME} (`capture_image`).
   */
  toolName?: string;
}

/**
 * A vision content block the target provider's `@langchain` converter actually decodes. Verified
 * against the installed converters (RC-21):
 *   - **ollama** → `{ type:'image_url', image_url:'<data-URL string>' }`. ChatOllama's
 *     `convertToOllamaMessages` only handles `image_url` blocks (extractBase64FromDataUrl); the
 *     LangChain standard `source_type` block throws "Unsupported content type: image".
 *   - **OpenAI-compatible** (`openai`, `openrouter`, `deepseek`, `xai`, `groq` — all extend
 *     `ChatOpenAI` / report `_llmType()==='openai'`) → `{ type:'image_url', image_url:{ url:'<data-URL>' } }`.
 *     This native OpenAI shape is correct on BOTH the Completions API AND the Responses API (GS2-74
 *     flips reasoning-capable openai models to Responses). A raw `source_type` standard block
 *     serialises to an *invalid* image part on the Responses path, so we emit the provider-native
 *     shape rather than lean on `@langchain/core`'s (deprecated, internal) auto-conversion.
 *   - **anthropic / google-genai / vertexai** (and any unknown/default) → the LangChain standard
 *     base64 data content block `{ type:'image', source_type:'base64', mime_type, data }`, which
 *     those native converters decode directly and which is the most broadly decodable fallback.
 *
 * Pure and exported so each provider branch can be unit-tested directly.
 */
export function imageBlockFor(provider: string, mimeType: string, data: string) {
  const dataUrl = `data:${mimeType};base64,${data}`;
  switch (provider) {
    case 'ollama':
      return { type: 'image_url' as const, image_url: dataUrl };
    case 'openai':
    case 'openrouter':
    case 'deepseek':
    case 'xai':
    case 'groq':
      return { type: 'image_url' as const, image_url: { url: dataUrl } };
    case 'anthropic':
    case 'google-genai':
    case 'vertexai':
    default:
      return {
        type: 'image' as const,
        source_type: 'base64' as const,
        mime_type: mimeType,
        data,
      };
  }
}

/**
 * Create the frontend-image-injection middleware.
 *
 * @param opts.provider - provider string selecting the vision-block shape (see {@link imageBlockFor}).
 * @param opts.toolName - capture tool name (default {@link DEFAULT_CAPTURE_TOOL_NAME}).
 */
export function createFrontendImageInjectionMiddleware(
  opts: FrontendImageInjectionOptions
): AgentMiddleware {
  const toolName = opts.toolName ?? DEFAULT_CAPTURE_TOOL_NAME;

  // thread_id → set of tool_call_ids whose image (or error note) has already been injected. Without
  // this, a summarizer/replayed history that retains the capture ToolMessage would re-inject its
  // frame on the next turn, appended after the newest turn's content and mispairing the assistant
  // message with a stale frame (the RC-21 idempotency guard).
  //
  // Closure-scoped (one Map per middleware instance), NOT a module global as the robot had it. The
  // AG-UI server caches one agent per client-toolset signature (getAgentForTools), so a thread's
  // turns share this instance and idempotency-across-turns is preserved — while unrelated agents (and
  // tests) get independent state instead of a process-lifetime Map that accumulates every thread_id.
  const injectedByThread = new Map<string, Set<string>>();

  return createMiddleware({
    name: 'frontend-image-injection',

    beforeModel: async (state, runtime) => {
      const messages = state.messages || [];
      // The AG-UI server sets runConfig.configurable.thread_id (= the run's threadId) and threads it
      // to the graph, so per-session idempotency keys correctly. '__default__' is only reached off
      // that path (e.g. a bare invoke with no thread_id), which still behaves correctly per-instance.
      const threadId = runtime?.configurable?.thread_id ?? '__default__';
      let injectedIds = injectedByThread.get(threadId);
      if (!injectedIds) {
        injectedIds = new Set<string>();
        injectedByThread.set(threadId, injectedIds);
      }

      // Scan forward so injected frames stay in chronological order; skip any tool_call_id already
      // injected on this thread (idempotent across a retained/replayed tail).
      const injected: Array<{ payload: ImagePayload; id: string }> = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (
          // RC-21 (golden fix): use the duck-typed `isToolMessage`, NEVER `msg instanceof
          // ToolMessage`. A consumer (galvanized/robot) importing this middleware across a `file:`-dep
          // boundary resolves a SECOND @langchain/core copy, and a capture ToolMessage constructed by
          // the AG-UI pipeline's core copy is not an instance of the `ToolMessage` class we import —
          // `instanceof` silently returns false across copies and no frame is ever injected.
          isToolMessage(msg) &&
          typeof msg.content === 'string' &&
          msg.name === toolName
        ) {
          const id = msg.tool_call_id;
          if (!id || injectedIds.has(id)) continue;
          try {
            injected.push({ payload: JSON.parse(msg.content) as ImagePayload, id });
          } catch {
            // Non-JSON tool result — skip injection (leave the guard clean).
          }
        }
      }

      if (injected.length === 0) return undefined;

      const newMessages = [...messages];
      for (const { payload, id } of injected) {
        if (payload.error) {
          // Mark injected so the error note isn't re-emitted on a later turn.
          injectedIds.add(id);
          newMessages.push(new HumanMessage({ content: `Camera unavailable: ${payload.error}` }));
          continue;
        }
        if (payload.mimeType && payload.data) {
          // RC-21: mark injected ONLY on a successful frame emission. A capture result that arrived
          // WITHOUT its base64 `data` (dropped upstream) injects nothing and must NOT poison the
          // guard — a later data-bearing result for the same tool_call_id can still recover.
          injectedIds.add(id);
          const block = imageBlockFor(opts.provider, payload.mimeType, payload.data);
          newMessages.push(
            new HumanMessage({
              content: [{ type: 'text', text: 'Camera frame captured:' }, block] as MessageContent,
            })
          );
        }
        // else: a capture result whose `data` is absent — inject nothing, leave the guard clean.
      }

      // If every candidate was data-less (nothing appended), return no state update rather than an
      // identical copy — keeps beforeModel a true no-op and leaves the guard clean for recovery.
      return newMessages.length > messages.length ? { messages: newMessages } : undefined;
    },
  });
}
