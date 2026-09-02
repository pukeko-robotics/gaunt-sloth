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
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

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
   * `ollama`, `google-genai`, `vertexai`, `huggingface`, …) or a model class's own `_llmType()`
   * label, which is a different namespace and need not coincide with any of them (`google`,
   * `xai-responses`); unknown values fall to the standard base64 block.
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
 *   - **`image_url`-consuming converters** (`openai`, `openrouter`, `deepseek`, `xai`, `groq`,
 *     `huggingface`, `xai-responses`) → `{ type:'image_url', image_url:{ url:'<data-URL>' } }`.
 *     The grouping is by what the converter CONSUMES, not by client family: the first six are
 *     served by an OpenAI-compatible Chat Completions API whichever LangChain class fronts them,
 *     while `xai-responses` reaches the same block by a different route entirely (below).
 *     This native OpenAI shape is correct on BOTH the Completions API AND the Responses API (GS2-74
 *     flips reasoning-capable openai models to Responses). A raw `source_type` standard block
 *     serialises to an *invalid* image part on the Responses path, so we emit the provider-native
 *     shape rather than lean on `@langchain/core`'s (deprecated, internal) auto-conversion.
 *     `huggingface` (CFG-45) belongs here by MEASUREMENT, not by "it constructs a `ChatOpenAI`":
 *     a fetch-capture probe of the installed `@langchain/openai` (no network — the client's `fetch`
 *     was stubbed), built exactly as `providers/huggingface.ts` builds it, showed the request going
 *     to `https://router.huggingface.co/v1/chat/completions` — the Completions path, never
 *     Responses, since nothing on the HF path sets `useResponsesApi` and the library's own
 *     model-name flip matches only OpenAI-specific ids — and `openai@7.6.0`'s
 *     `ChatCompletionContentPart` union accepts exactly one image part there: `image_url:{url}`.
 *     There is no `input_image` part on that endpoint, so the OpenAI *Responses* shape does not
 *     apply. The same probe showed the standard block ALSO arriving as `image_url:{url}` on the
 *     Completions path — but only because `@langchain/core`'s `convertToProviderContentBlock` (now
 *     `@deprecated`: "Don't use data content blocks") rewrites it, which is precisely the
 *     auto-conversion the through-line below refuses to depend on, and which yields a bare, invalid
 *     `image_url` part the moment the same block reaches a Responses endpoint.
 *     `xai-responses` (CFG-45) is the same emitted block for an UNRELATED reason, and it is the case
 *     that shows why this switch exists. It is `ChatXAIResponses._llmType()`, reachable only via
 *     `resolveVisionProvider`'s `_llmType()` fallback (gth's own `xai` provider builds `ChatXAI`),
 *     and that class extends `BaseChatModel` directly with its OWN converter — no OpenAI client and
 *     no `@langchain/core` data-block conversion anywhere on the path. Its human-message branch
 *     (`@langchain/xai@1.4.10` `dist/converters/responses.js`) recognises exactly `text` and
 *     `image_url` and rewrites every other part to `{ type:'input_text', text:'' }`. A
 *     `globalThis.fetch`-capture probe (no network — that class calls the global fetch directly and
 *     accepts no injectable client) measured four blocks against `https://api.x.ai/v1/responses`:
 *     the standard base64 block arrived as `{"type":"input_text","text":""}` — the image SILENTLY
 *     DESTROYED in-process, never rejected — while `image_url:{url}` arrived as the vendor's
 *     declared `{"type":"input_image","image_url":"data:…","detail":"auto"}`. Emitting the wire
 *     shape `{ type:'input_image', … }` from here was measured too and is destroyed identically:
 *     the translation is the converter's to make, so pre-empting it defeats it.
 *     Not establishable offline, and stated rather than assumed: whether `api.x.ai` accepts a
 *     `data:` URL in `input_image.image_url`, whose vendor type documents it as a public URL. The
 *     ruling does not rest on that — the standard block is provably destroyed before any request is
 *     built, while this block provably survives into the vendor's own declared image item.
 *   - **anthropic** → the provider-native block `{ type:'image', source:{ type:'base64',
 *     media_type, data } }`. The LangChain standard block is NOT usable here (RC-32): in
 *     `@langchain/anthropic`'s `_formatContentBlocks`, the `isDataContentBlock` branch yields its
 *     conversion and then FALLS THROUGH — no `continue` — into the chain below, where
 *     `type === 'image'` matches the very same block and yields a SECOND one whose `media_type` is
 *     read from camelCase `mimeType` (a key the snake_case standard block never has) and so
 *     defaults to the literal `image/jpeg`. Every frame is therefore sent twice, and a non-JPEG
 *     capture 400s outright on the mislabelled copy. The native block is recognised earlier by
 *     `_isAnthropicImageBlockParam` and passed through untouched, exactly once.
 *   - **Gemini** (`google-genai`, `vertexai`, and the `google` label both of them report from
 *     `_llmType()`) → the LangChain standard base64 data content block
 *     `{ type:'image', source_type:'base64', mime_type, data }`, which those native converters
 *     decode directly.
 *   - **anything else** → the same standard block, as a last-resort fallback rather than as a
 *     Gemini alias (see the `default` arm below).
 *
 * The through-line: emit what the target provider's converter consumes natively rather than lean on
 * a generic auto-conversion — the same lesson as GS2-75 on the OpenAI Responses path.
 *
 * Exported so each provider branch can be unit-tested directly; its only effect beyond the returned
 * block is one debug-log line on the fallback arm.
 */
export function imageBlockFor(provider: string, mimeType: string, data: string) {
  const dataUrl = `data:${mimeType};base64,${data}`;
  const standardBlock = {
    type: 'image' as const,
    source_type: 'base64' as const,
    mime_type: mimeType,
    data,
  };
  switch (provider) {
    case 'ollama':
      return { type: 'image_url' as const, image_url: dataUrl };
    case 'openai':
    case 'openrouter':
    case 'deepseek':
    case 'xai':
    case 'groq':
    case 'huggingface':
    // `xai-responses` (CFG-45) shares the emitted BLOCK with the group above but not its reason, so
    // it is listed apart. `ChatXAIResponses` is not an OpenAI-compatible client at all — it extends
    // `BaseChatModel` directly and ships its own converter, which consumes an `image_url` part and
    // rewrites it to the vendor's `input_image` wire item itself. Emitting `input_image` here would
    // NOT short-circuit that translation; it would defeat it (measurement in the docblock above).
    case 'xai-responses':
      return { type: 'image_url' as const, image_url: { url: dataUrl } };
    case 'anthropic':
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mimeType, data },
      };
    // The Gemini labels are enumerated DELIBERATELY, and separately from `default` below. CFG-45:
    // while `default` doubled as the Gemini arm, every provider string nobody had enumerated was
    // served a Gemini-shaped block silently — which is how `huggingface` sat on the wrong shape
    // unnoticed. `google` is what BOTH gth Gemini providers' `_llmType()` reports (each builds
    // `@langchain/google`'s `ChatGoogle`), and it is the label `resolveVisionProvider` falls back to
    // for a module config, so it is enumerated here rather than left to the fallback.
    case 'google-genai':
    case 'vertexai':
    case 'google':
      return standardBlock;
    // CFG-45 ruling — `default` STAYS a permissive fallback and must not throw. `provider` is
    // `resolveVisionProvider`'s output, which is `''` whenever a module config supplies an already-
    // built LLM whose `_llmType()` is missing or throws, and the binary-content-injection middleware
    // documents that `''` means "emit the standard base64 block". Throwing would turn a
    // possibly-suboptimal block into a hard failure on configurations that work today, and the
    // caller (a `beforeModel` hook) has no way to recover. What it stops doing is failing SILENTLY:
    // an unrecognised non-empty label is recorded, so the next wrong-shaped block leaves a trace
    // instead of being discovered by reading the switch.
    // The `xai-responses` case STRENGTHENS this ruling rather than revising it. That label can only
    // arrive from a module config building an arbitrary LangChain class, so the population reaching
    // this arm is exactly the one whose `_llmType()` labels are unenumerable by construction — the
    // population a throw would break. What generalises instead is the failure MODE the probe found:
    // an unrecognised part is not rejected by a converter, it is quietly rewritten to an empty text
    // part, so a wrong block costs a silent blind answer rather than an error anyone would see.
    // That is what this log line exists to leave a trace of.
    default:
      if (provider) {
        debugLog(
          `imageBlockFor: provider "${provider}" is not enumerated; emitting the standard base64 ` +
            `image block. If its converter does not decode that block natively, add a MEASURED ` +
            `case for it (CFG-45) rather than one by analogy.`
        );
      }
      return standardBlock;
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

  // thread_id → set of tool_call_ids whose image (or error note) has already been injected. It
  // scopes injection to ONE frame per capture per graph thread: `beforeModel` runs before every
  // model call, so a multi-step turn would otherwise stack a copy of the same frame at each step,
  // each one appended after the newest content and mispairing the assistant message with a stale
  // frame (the RC-21 idempotency guard). It is deliberately keyed on the GRAPH thread rather than
  // the client session — the AG-UI server gives each fresh run its own checkpoint thread (RC-31),
  // and that run replays the whole history into an empty graph, so it must re-inject the frame or
  // the model would lose the photo the moment the capture turn ended.
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
