import express from 'express';
import { randomUUID } from 'node:crypto';
import { EventEncoder } from '@ag-ui/encoder';
import { EventType } from '@ag-ui/core';
import { GthConfig } from '@gaunt-sloth/core/config.js';
import { GthDeepAgent } from '#src/core/GthDeepAgent.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { GthLangChainAgent } from '@gaunt-sloth/core/core/GthLangChainAgent.js';
import {
  defaultStatusCallback,
  displayInfo,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getNewRunnableConfig } from '@gaunt-sloth/core/utils/llmUtils.js';
import { textToNativeToolCalls } from '@gaunt-sloth/core/core/toolCallRepair/index.js';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import { createResolvers } from '#src/resolvers.js';

/**
 * Spike 1 / C-a: a frontend tool as it arrives in the AG-UI run-input `tools`
 * array (CopilotKit's `useFrontendTool` shape) — name + description + a JSON
 * Schema for the parameters.
 */
interface RunInputTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Convert a run-input frontend tool into a client-fulfilled LangChain tool.
 * Marking `metadata.client = true` is all that's required: the agent's
 * `extractAndFlattenTools` already swaps such a tool's `invoke`/`call` for an
 * `interrupt({ name })` stub, so the model can *call* the tool and the graph
 * suspends for the browser to fulfil it — the exact mechanism Pukeko's
 * server-side client tools use, now driven by client-declared tools.
 */
function buildClientToolStub(t: RunInputTool): StructuredToolInterface {
  const stub = tool(async () => '', {
    name: t.name,
    description: t.description ?? '',
    // The JSON Schema from the run-input is passed straight through so the model
    // sees the real parameter shape. The stub body never runs (it interrupts).
    schema: (t.parameters as never) ?? { type: 'object', properties: {} },
  });
  (stub as unknown as { metadata?: Record<string, unknown> }).metadata = { client: true };
  return stub;
}

/**
 * Return the first complete JSON value at the start of `s`, ignoring any
 * trailing characters. Used to recover from streamed tool-call argument
 * reassembly that concatenates objects (e.g. `{}{}` or `{"steps":3}{}`) when a
 * model emits parallel tool calls — local models like Ollama/Gemma don't honor
 * `disable_parallel_tool_use`, and their delta streams can merge sibling calls'
 * argument buffers. Returns `undefined` if no complete leading value is found.
 */
function extractFirstJsonValue(s: string): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse a tool call's `arguments` string defensively. A single malformed
 * argument payload must not abort the whole run — the message is part of the
 * persisted history and would otherwise poison every subsequent turn on the
 * thread.
 */
function parseToolArguments(raw: string | undefined, toolName: string): Record<string, unknown> {
  const s = (raw ?? '').trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    const recovered = extractFirstJsonValue(s);
    if (recovered && typeof recovered === 'object') {
      displayWarning(
        `Recovered malformed tool arguments for ${toolName} (${JSON.stringify(s)} -> ${JSON.stringify(recovered)}). ` +
          'Likely parallel tool calls from a model that ignores disable_parallel_tool_use.'
      );
      return recovered as Record<string, unknown>;
    }
    displayWarning(
      `Unparseable tool arguments for ${toolName} (${JSON.stringify(s)}); defaulting to {}.`
    );
    return {};
  }
}

/** An AG-UI wire message as received on the run input (the shape {@link convertMessage} accepts). */
type AgUiWireMessage = {
  role: string;
  content?: string;
  id: string;
  toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  toolCallId?: string;
};

/** Per-message options for {@link convertMessage}. */
interface ConvertMessageOptions {
  /**
   * Whether an assistant text-emitted tool call may be PROMOTED to a native tool_call for this
   * message. Defaults to `true` (the EXT-35 behaviour). {@link convertMessages} sets this to `false`
   * for a DANGLING history call (one not followed by its tool result) so a stalled replayed call
   * stays plain text — see EXT-43 and that function's doc.
   */
  allowTextCallPromotion?: boolean;
}

/**
 * Convert AG-UI message format to LangChain BaseMessage.
 *
 * `allowedToolNames` is the set of tool names bound to this run (config.tools + any run-input
 * client tools). It gates EXT-35 plain-text tool-call repair on the assistant branch: an incoming
 * assistant message with NO native `toolCalls` whose content is a STANDALONE text-emitted call
 * (bracket / `<function=…>` / Harmony — the dialects small/local models produce) is promoted to a
 * native tool_call so a replayed history turn is a real tool call rather than inert prose. An empty
 * (or absent) allow-list promotes nothing — the prose-safe default. This runs alongside
 * {@link parseToolArguments} (which rescues malformed args on an ALREADY-native tool_call).
 *
 * EXT-43: `options.allowTextCallPromotion` (default `true`) lets a caller suppress promotion for a
 * single message; {@link convertMessages} uses it to leave a DANGLING history call as text.
 */
export function convertMessage(
  msg: AgUiWireMessage,
  allowedToolNames?: Set<string>,
  options?: ConvertMessageOptions
): BaseMessage {
  const content = typeof msg.content === 'string' ? msg.content : '';
  switch (msg.role) {
    case 'user':
      return new HumanMessage(content);
    case 'assistant': {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        return new AIMessage({
          content: content,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: parseToolArguments(tc.function.arguments, tc.function.name),
            type: 'tool_call' as const,
          })),
        });
      }
      // EXT-35: no native tool_calls — a small/local model may have emitted the call as assistant
      // TEXT. Promote a standalone text-emitted call (gated by the bound-tool allow-list + payload
      // cap + standalone-only) to a native tool_call; otherwise fall through to plain text.
      // EXT-43: `allowTextCallPromotion === false` (a dangling history call) short-circuits the
      // promotion so the message stays plain text.
      const repairedToolCalls =
        options?.allowTextCallPromotion !== false && allowedToolNames && allowedToolNames.size > 0
          ? textToNativeToolCalls(content, { allowedToolNames })
          : undefined;
      if (repairedToolCalls) {
        return new AIMessage({ content: '', tool_calls: repairedToolCalls });
      }
      return new AIMessage(content);
    }
    case 'system':
    case 'developer':
      return new SystemMessage(content);
    case 'tool':
      return new ToolMessage({ content, tool_call_id: msg.toolCallId || msg.id });
    default:
      return new HumanMessage(content);
  }
}

/**
 * Convert a whole AG-UI history array to LangChain messages, applying the EXT-43 dangling-call
 * guard on the history-convert path.
 *
 * EXT-35's per-message promotion is unconditional, which is correct for a call that WILL be executed
 * this turn. But when replaying HISTORY, promoting a STALLED text call (one the client recorded but
 * that never ran) yields an `AIMessage` with `tool_calls` and NO following `tool_result` — a shape a
 * strict provider (Anthropic) 400s on, where the pre-EXT-35 plain text was valid. So here promotion
 * is allowed ONLY when the assistant message is immediately followed by a `tool` result message;
 * a dangling call stays plain text (`allowTextCallPromotion: false`). The live middleware path
 * (`GthLangChainAgent`, fixing the CURRENT turn) is unaffected — this guard is history-replay only.
 */
export function convertMessages(
  messages: AgUiWireMessage[],
  allowedToolNames?: Set<string>
): BaseMessage[] {
  return messages.map((msg, index) => {
    const followedByToolResult = messages[index + 1]?.role === 'tool';
    return convertMessage(msg, allowedToolNames, {
      allowTextCallPromotion: followedByToolResult,
    });
  });
}

/**
 * Construct the AG-UI agent for the configured backend (B5).
 * - `agent.backend: 'deep'` → {@link GthDeepAgent} (deepagents runtime, experimental).
 * - anything else (including `'lean'` and the default `undefined`) → {@link GthLangChainAgent}
 *   (plain LangChain agent, no deepagents `/large_tool_results` offload — also the fix for
 *   `filesystem: 'none'` consumers). Lean is the default.
 *
 * Returns the shared {@link GthAbstractAgent} base so both backends flow through the same
 * `.init`/`.streamWithEvents`/`.streamWithEventsResume` surface used below.
 */
function createConfiguredAgent(cfg: GthConfig): GthAbstractAgent {
  if (cfg.agent?.backend === 'deep') {
    displayWarning(
      'Using the experimental deepagents backend (agent.backend: deep). The lean agent is the ' +
        'default and recommended backend.'
    );
    return new GthDeepAgent(defaultStatusCallback, createResolvers());
  }
  return new GthLangChainAgent(defaultStatusCallback, createResolvers());
}

export async function startAgUiServer(config: GthConfig, port: number): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  displayInfo(
    'WARNING: AG-UI server is intended for local clients only. Do not expose to public networks.'
  );

  // CORS — configured via commands.api.cors in config
  const corsOrigin = config.commands?.api?.cors?.allowOrigin ?? 'http://localhost:3000';
  const corsMethods = config.commands?.api?.cors?.allowMethods ?? 'POST, GET, OPTIONS';
  const corsHeaders = config.commands?.api?.cors?.allowHeaders ?? 'Content-Type, Accept';

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', corsMethods);
    res.setHeader('Access-Control-Allow-Headers', corsHeaders);
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Initialize agent.
  // Note this would need a refactoring if it is to be used for a public web server,
  // For connecting local WEB to local CLI agent, this is absolutely OK, since one thread is OK.
  const checkpointSaver = new MemorySaver();
  const agent = createConfiguredAgent(config);
  await agent.init('api', config, checkpointSaver);

  displayInfo(`AG-UI agent initialized`);

  // C-a (spike): agents that additionally bind the client-declared run-input
  // `tools`. Keyed by a stable signature of the toolset so the initial run and
  // its resume share ONE compiled graph — LangGraph resumes from the
  // checkpointer, but the graph shape must match the suspended one. Built lazily
  // on first sighting of a given toolset.
  const toolAgentCache = new Map<string, GthAbstractAgent>();

  function toolSignature(tools: RunInputTool[]): string {
    return JSON.stringify(
      tools
        .map((t) => [t.name, t.parameters ?? {}])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
  }

  async function getAgentForTools(tools: RunInputTool[]): Promise<GthAbstractAgent> {
    const sig = toolSignature(tools);
    const cached = toolAgentCache.get(sig);
    if (cached) return cached;
    const clientStubs = tools.map(buildClientToolStub);
    // Run-input client tools are authoritative. Drop any config.tools entry that
    // collides by name so we never register two client-tool instances of the
    // same name: LangChain v1's AgentNode rejects a same-name/different-instance
    // client tool ("You have modified a tool ..."). This lets a server config
    // also declare the (client-fulfilled) tools — as pukeko's robot tools do —
    // without breaking; the run-input stub is the one actually used.
    const clientStubNames = new Set(
      clientStubs.map((t) => (t as { name?: string }).name).filter(Boolean) as string[]
    );
    const baseTools = ((config.tools as { name?: string }[] | undefined) ?? []).filter(
      (t) => !(t?.name && clientStubNames.has(t.name))
    ) as unknown[];
    const reqConfig = {
      ...config,
      tools: [...baseTools, ...clientStubs],
    } as GthConfig;
    const reqAgent = createConfiguredAgent(reqConfig);
    await reqAgent.init('api', reqConfig, checkpointSaver);
    toolAgentCache.set(sig, reqAgent);
    displayInfo(
      `AG-UI: bound ${clientStubs.length} client tool(s): ${tools.map((t) => t.name).join(', ')}`
    );
    return reqAgent;
  }

  // AG-UI endpoint — standard path per AG-UI protocol
  app.post('/agents/:agentId/run', async (req, res) => {
    const { threadId, runId, messages, forwardedProps, tools } = req.body;
    const effectiveThreadId = threadId || randomUUID();
    const effectiveRunId = runId || randomUUID();

    // C-a (spike): if the client declared frontend tools in the run-input, serve
    // this run from an agent that binds them as interrupt stubs. Otherwise use
    // the server's statically-configured agent.
    const hasClientTools = Array.isArray(tools) && tools.length > 0;
    const activeAgent = hasClientTools ? await getAgentForTools(tools as RunInputTool[]) : agent;

    // EXT-35: the names of the tools bound to THIS run (server config.tools + any run-input client
    // tools) — the allow-list for plain-text tool-call repair in convertMessage. Only a text-emitted
    // call naming one of these is promoted to a native tool_call; an empty set promotes nothing.
    const allowedToolNames = new Set<string>(
      [
        ...((config.tools as Array<{ name?: string }> | undefined) ?? []).map((t) => t?.name),
        ...(hasClientTools ? (tools as RunInputTool[]).map((t) => t.name) : []),
      ].filter((name): name is string => Boolean(name))
    );

    const encoder = new EventEncoder({ accept: req.headers.accept });
    res.setHeader('Content-Type', encoder.getContentType());
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Cancel in-flight inference when the client goes away (e.g. the frontend's
    // Stop button calls HttpAgent.abortRun(), which aborts the fetch). Without
    // this the LangGraph run — and the local model — keeps generating into a
    // dead socket.
    //
    // Listen on the *response* 'close', not the request's: req 'close' fires as
    // soon as the POST body is consumed (right after express.json() reads it),
    // which would abort every run instantly. res 'close' fires when the
    // connection actually goes away. `finished`, set just before res.end(),
    // distinguishes a normal completion (close after we're done) from a real
    // client disconnect (close while still streaming).
    const ac = new AbortController();
    let finished = false;
    res.on('close', () => {
      if (!finished) ac.abort();
    });

    try {
      // RUN_STARTED
      res.write(
        encoder.encode({
          type: EventType.RUN_STARTED,
          threadId: effectiveThreadId,
          runId: effectiveRunId,
        })
      );

      const messageId = randomUUID();

      // Get runnable config with thread_id for checkpointing. config.recursionLimit
      // (when set by the consumer) caps the agent's super-steps per run.
      const runConfig = {
        ...getNewRunnableConfig(config.recursionLimit),
        configurable: { thread_id: effectiveThreadId },
      };

      // Stream the response with typed events. Text runs MUST be delimited
      // (START…CONTENT…END) around tool calls and reasoning: the AG-UI client
      // finalizes a text message once a tool call for it begins, so any text that
      // resumes after a TOOL_CALL_START on the SAME messageId is silently dropped
      // (the "swallowed last line before a tool call" bug). Give each contiguous
      // text run its own id and END it before any tool/reasoning event; tool calls
      // parent to the most recent assistant message id. (GS2-22 / RC-10.)
      let textRunId: string | null = null;
      let lastAssistantId: string = messageId;
      let reasoningMessageId: string | null = null;
      const endTextRun = () => {
        if (textRunId) {
          res.write(encoder.encode({ type: EventType.TEXT_MESSAGE_END, messageId: textRunId }));
          textRunId = null;
        }
      };

      // C-a (spike): detect CopilotKit's resume shape. CopilotKit fulfils a
      // frontend tool client-side and then RE-RUNS the agent with the full
      // message history, the tool result appended as a trailing `tool` message
      // — it does NOT send `forwardedProps.command.resume`. When that lands on a
      // thread whose graph is suspended at our interrupt() stub, translate the
      // trailing tool result into a graph resume so the suspended run continues
      // (instead of starting a fresh run that just re-calls the tool).
      const lastMsg =
        Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : undefined;
      const isCopilotToolResume =
        hasClientTools && forwardedProps?.command?.resume === undefined && lastMsg?.role === 'tool';

      let eventStream;
      if (isCopilotToolResume) {
        const resumeContent =
          typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
        eventStream = activeAgent.streamWithEventsResume(resumeContent, runConfig, [], ac.signal);
      } else if (forwardedProps?.command?.resume !== undefined) {
        // Follow-up messages piggy-backed on the resume: deliver them to the
        // agent on its next decision turn via Command.update (see
        // GthLangChainAgent.streamWithEventsResume). Accepts plain strings or
        // AG-UI message objects.
        const queued = forwardedProps.command.queuedMessages;
        const queuedMessages: BaseMessage[] = Array.isArray(queued)
          ? queued
              .map((s: unknown) =>
                typeof s === 'string'
                  ? new HumanMessage(s)
                  : convertMessage(s as Parameters<typeof convertMessage>[0], allowedToolNames)
              )
              .filter((m): m is BaseMessage => Boolean(m))
          : [];
        eventStream = activeAgent.streamWithEventsResume(
          forwardedProps.command.resume,
          runConfig,
          queuedMessages,
          ac.signal
        );
      } else {
        // The system prompt (backstory + guidelines + mode prompt + identity) lives in the
        // deep-agent graph via createDeepAgent({ systemPrompt }) — see GthDeepAgent — so it is no
        // longer prepended here. A separate, non-first SystemMessage would be rejected by Anthropic.
        // EXT-43: convertMessages (not a bare map) applies the dangling-call guard so a stalled
        // text call replayed in history is not promoted to a native tool_call with no result.
        const langChainMessages: BaseMessage[] = convertMessages(
          (messages || []) as Parameters<typeof convertMessages>[0],
          allowedToolNames
        );
        eventStream = activeAgent.streamWithEvents(langChainMessages, runConfig, ac.signal);
      }

      for await (const event of eventStream) {
        switch (event.type) {
          case 'text': {
            if (!textRunId) {
              textRunId = randomUUID();
              lastAssistantId = textRunId;
              res.write(
                encoder.encode({
                  type: EventType.TEXT_MESSAGE_START,
                  messageId: textRunId,
                  role: 'assistant',
                })
              );
            }
            res.write(
              encoder.encode({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: textRunId,
                delta: event.delta,
              })
            );
            break;
          }
          case 'tool_start': {
            // Close any open text run first so its final line isn't swallowed.
            endTextRun();
            res.write(
              encoder.encode({
                type: EventType.TOOL_CALL_START,
                toolCallId: event.id,
                toolCallName: event.name,
                parentMessageId: lastAssistantId,
              })
            );
            break;
          }
          case 'tool_args': {
            res.write(
              encoder.encode({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: event.id,
                delta: event.delta,
              })
            );
            break;
          }
          case 'tool_end': {
            res.write(
              encoder.encode({
                type: EventType.TOOL_CALL_END,
                toolCallId: event.id,
              })
            );
            break;
          }
          case 'tool_result': {
            res.write(
              encoder.encode({
                type: EventType.TOOL_CALL_RESULT,
                toolCallId: event.id,
                content: event.content,
                role: 'tool',
                messageId: randomUUID(),
              })
            );
            break;
          }
          case 'reasoning_start': {
            // Close any open text run before a reasoning message begins.
            endTextRun();
            reasoningMessageId = randomUUID();
            res.write(
              encoder.encode({
                type: EventType.REASONING_MESSAGE_START,
                messageId: reasoningMessageId,
                role: 'reasoning',
              })
            );
            break;
          }
          case 'reasoning_delta': {
            if (reasoningMessageId) {
              res.write(
                encoder.encode({
                  type: EventType.REASONING_MESSAGE_CONTENT,
                  messageId: reasoningMessageId,
                  delta: event.delta,
                })
              );
            }
            break;
          }
          case 'reasoning_end': {
            if (reasoningMessageId) {
              res.write(
                encoder.encode({
                  type: EventType.REASONING_MESSAGE_END,
                  messageId: reasoningMessageId,
                })
              );
              reasoningMessageId = null;
            }
            break;
          }
        }
      }

      // Close any still-open text run at the end of the stream.
      endTextRun();

      // RUN_FINISHED
      res.write(
        encoder.encode({
          type: EventType.RUN_FINISHED,
          threadId: effectiveThreadId,
          runId: effectiveRunId,
        })
      );

      finished = true;
      res.end();
    } catch (error) {
      // A client-initiated abort isn't an error — the socket is already gone, so
      // there's nothing to write to. Only surface RUN_ERROR for real failures.
      if (ac.signal.aborted) {
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.write(
        encoder.encode({
          type: EventType.RUN_ERROR,
          message: errorMessage,
        })
      );
      res.end();
    }
  });

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Agent metadata — lets clients display which model/provider is serving them.
  // provider is read from the LangChain model's _llmType() (e.g. "ollama",
  // "anthropic"); model from config.modelDisplayName, falling back to the
  // chat model's own `model` field.
  app.get('/info', (_req, res) => {
    const llm = config.llm as { _llmType?: () => string; model?: string } | undefined;
    let provider: string | null = null;
    try {
      provider = typeof llm?._llmType === 'function' ? llm._llmType() : null;
    } catch {
      provider = null;
    }
    res.json({
      status: 'ok',
      provider,
      model: config.modelDisplayName ?? llm?.model ?? null,
    });
  });

  return new Promise((resolve) => {
    app.listen(port, () => {
      displayInfo(`AG-UI server listening at http://localhost:${port}`);
      displayInfo(`AG-UI endpoint: POST http://localhost:${port}/agents/{agentId}/run`);
      resolve();
    });
  });
}
