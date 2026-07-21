import { GthConfig, ServerTool } from '#src/config.js';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentInterface,
  GthCommand,
  GthCompiledGraph,
  GthRunStats,
  Message,
  PendingToolInterrupt,
  StatusLevel,
  StatusUpdateCallback,
} from '#src/core/types.js';
import {
  accumulateMessage,
  createRunStatsAccumulator,
  finalizeRunStats,
  type RunStatsAccumulator,
} from '#src/core/runStats.js';
import type { DebugCapture } from '#src/core/debugCapture.js';
import { createPlainToolIndication } from '#src/core/plainToolIndication.js';
import { debugLog, debugLogError, debugLogObject } from '#src/utils/debugUtils.js';
import { ProgressIndicator } from '#src/utils/ProgressIndicator.js';
import { stopWaitingForEscape, waitForEscape } from '#src/utils/systemUtils.js';
import { AIMessage, AIMessageChunk, BaseMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import { IterableReadableStream } from '@langchain/core/utils/stream';
import { BaseCheckpointSaver, interrupt, Command, GraphInterrupt } from '@langchain/langgraph';
import {
  extractInlineBinaryBlocks,
  materializeBinaryOutputs,
  renderAssistantContent,
} from '#src/utils/binaryOutputUtils.js';

/** TUI-C22 — one classified slice of streamed assistant text: answer prose vs. inline thinking. */
type ThinkSegment = { kind: 'answer' | 'reasoning'; text: string };

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * TUI-C22 — length of the longest suffix of `s` that is a *proper* (shorter-than-full) prefix of
 * `tag`. Used by {@link createThinkTagSplitter} to hold back a trailing partial that might complete
 * into `tag` on the next chunk (e.g. a chunk ending in `<thi` when the tag is `<think>`).
 */
function trailingPartialLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.slice(s.length - k) === tag.slice(0, k)) return k;
  }
  return 0;
}

/**
 * TUI-C22 — stateful separator of inline `<think>...</think>` thinking from answer text, robust to
 * tags split across streamed chunks. Many thinking models served over an OpenAI-compatible `/v1`
 * shim (qwen3 / deepseek-r1 over Ollama) inline their reasoning as `<think>…</think>` in the
 * message `content` rather than in `additional_kwargs.reasoning_content`; without this it would
 * render as answer text and the `/reasoning` panel would stay empty.
 *
 * `push(text)` returns the segments it can classify unambiguously *now*, buffering any trailing
 * partial tag (so a `<think>` arriving as `<thi` + `nk>` across two chunks is still detected) and
 * the run of thinking between an open and a not-yet-seen close tag. `flush()` drains the buffer at
 * a message/stream boundary: an unterminated `<think>` at EOF yields its remainder as reasoning; a
 * dangling non-tag partial (e.g. a lone `<` or `<thi` that never completed) yields as answer, so no
 * text is ever dropped. Purely additive — text with no `<think>` passes straight through as answer.
 */
function createThinkTagSplitter() {
  let buffer = '';
  let inThink = false;

  function push(text: string): ThinkSegment[] {
    const segments: ThinkSegment[] = [];
    if (text.length === 0 && buffer.length === 0) return segments;
    buffer += text;
    for (;;) {
      if (inThink) {
        const idx = buffer.indexOf(THINK_CLOSE);
        if (idx >= 0) {
          if (idx > 0) segments.push({ kind: 'reasoning', text: buffer.slice(0, idx) });
          buffer = buffer.slice(idx + THINK_CLOSE.length);
          inThink = false;
          continue;
        }
        // No full close tag yet — emit reasoning except a trailing partial of `</think>`.
        const hold = trailingPartialLen(buffer, THINK_CLOSE);
        const emit = buffer.slice(0, buffer.length - hold);
        if (emit.length > 0) segments.push({ kind: 'reasoning', text: emit });
        buffer = hold > 0 ? buffer.slice(buffer.length - hold) : '';
        break;
      } else {
        const idx = buffer.indexOf(THINK_OPEN);
        if (idx >= 0) {
          if (idx > 0) segments.push({ kind: 'answer', text: buffer.slice(0, idx) });
          buffer = buffer.slice(idx + THINK_OPEN.length);
          inThink = true;
          continue;
        }
        // No full open tag yet — emit answer except a trailing partial of `<think>`.
        const hold = trailingPartialLen(buffer, THINK_OPEN);
        const emit = buffer.slice(0, buffer.length - hold);
        if (emit.length > 0) segments.push({ kind: 'answer', text: emit });
        buffer = hold > 0 ? buffer.slice(buffer.length - hold) : '';
        break;
      }
    }
    return segments;
  }

  function flush(): ThinkSegment[] {
    const segments: ThinkSegment[] = [];
    if (buffer.length > 0) {
      segments.push({ kind: inThink ? 'reasoning' : 'answer', text: buffer });
    }
    buffer = '';
    inThink = false;
    return segments;
  }

  return { push, flush };
}

/**
 * TUI-C22 — pick this chunk's reasoning delta, broadening capture beyond the single historical
 * source without disturbing it. Precedence, and why:
 *  1. `additional_kwargs.reasoning_content` — the DeepSeek/vLLM/Anthropic convention the pipeline
 *     already read; returned verbatim so that happy path is byte-for-byte unchanged.
 *  2. A top-level `reasoning` lifted from the raw provider response (OpenRouter convention). The
 *     `ChatOpenAI` completions converter drops `reasoning`, so it is only reachable when the model
 *     was built with `__includeRawResponse` (see `providers/openrouter.ts`), which stashes the raw
 *     response under `additional_kwargs.__raw_response` — streaming deltas expose it at
 *     `choices[0].delta.reasoning`, a whole message at `choices[0].message.reasoning`.
 *  3. A defensive direct `additional_kwargs.reasoning` (some integrations may surface it there).
 * Only consulted when `reasoning_content` is absent, so the two never double-emit.
 */
function pickReasoningDelta(kwargs: Record<string, unknown> | undefined, isChunk: boolean): string {
  if (!kwargs) return '';
  const reasoningContent = kwargs.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    return reasoningContent;
  }
  const raw = kwargs.__raw_response as
    | { choices?: Array<{ delta?: { reasoning?: unknown }; message?: { reasoning?: unknown } }> }
    | undefined;
  const choice = raw?.choices?.[0];
  const fromRaw = isChunk ? choice?.delta?.reasoning : choice?.message?.reasoning;
  if (typeof fromRaw === 'string' && fromRaw.length > 0) return fromRaw;
  const direct = kwargs.reasoning;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return '';
}

/**
 * TUI-C29 — return a chunk fit for `concat`-aggregation with OpenRouter's raw response stripped.
 *
 * The openrouter provider enables `__includeRawResponse` (TUI-C22), which stashes the *full* raw
 * provider response under `additional_kwargs.__raw_response` so {@link pickReasoningDelta} can lift
 * a top-level `reasoning` delta the ChatOpenAI converter otherwise drops. Reasoning is only ever
 * read off the **per-chunk** `additional_kwargs`, never off the aggregate — yet `AIMessageChunk.concat`
 * deep-merges `additional_kwargs` (`_mergeDicts`), so leaving `__raw_response` on the chunk makes the
 * aggregate accumulate a linearly-growing, unused copy of it for the whole stream.
 *
 * Strip it on a **shallow clone** so the ORIGINAL chunk the reasoning path reads (line ~697) stays
 * untouched (approach A — no mutation of the stream-owned object). The clone preserves the chunk's
 * prototype (so it keeps a working `.concat` when it becomes the first aggregate) and every field
 * `concat` reads (content, tool_call_chunks, tool_calls, response_metadata, usage_metadata, id),
 * overriding only `additional_kwargs`. When the key is absent (every non-OpenRouter provider) the
 * chunk is returned as-is, so those paths are byte-for-byte unchanged.
 */
export function stripRawResponseForAggregation(chunk: AIMessageChunk): AIMessageChunk {
  const kwargs = chunk.additional_kwargs;
  if (!kwargs || !('__raw_response' in kwargs)) return chunk;
  const rest = { ...kwargs };
  delete rest.__raw_response;
  const clone = Object.create(Object.getPrototypeOf(chunk)) as AIMessageChunk;
  Object.assign(clone, chunk);
  clone.additional_kwargs = rest;
  return clone;
}

/**
 * Shared, graph-agnostic agent plumbing.
 *
 * Both the lean {@link GthLangChainAgent} (`createAgent`, in core) and the deep
 * `GthDeepAgent` (`createDeepAgent`, in `@gaunt-sloth/agent`) differ only in how they
 * build the compiled LangGraph in {@link init}; everything downstream — invoking,
 * streaming to the console, emitting typed {@link AgentStreamEvent}s, client-tool
 * `interrupt()` stubbing, suspend/resume, and cleanup — is identical and lives here.
 *
 * The base operates solely on the structural {@link GthCompiledGraph} surface, so it
 * does NOT import `langchain`/`deepagents` graph builders. Subclasses construct the
 * graph and assign it to {@link agent} in their `init()`.
 */
export abstract class GthAbstractAgent implements GthAgentInterface {
  protected statusUpdate: StatusUpdateCallback;
  protected resolvers: AgentResolvers | undefined;
  protected agent: GthCompiledGraph | null = null;
  protected config: GthConfig | null = null;
  protected command: GthCommand | undefined = undefined;

  /**
   * Opt-in debug sink for the TUI `/debug` panel. Set AFTER {@link init} via
   * `runner.getAgent()`; read lazily inside each backend's `wrapModelCall` capture middleware
   * so that when it is `undefined` (the normal path) the middleware is a transparent
   * pass-through. Lives on the base so BOTH the lean and deep backends support it; the AG-UI
   * server / non-TUI callers simply never set it, so those contracts are unchanged.
   */
  public debugCapture: DebugCapture | undefined;

  /**
   * GS2-16 — per-run analytics tally (token usage + invoked tool names) folded from the messages
   * flowing through {@link invoke} / the streaming paths. Reset at each turn boundary via
   * {@link resetRunStats} (the runner is reused across turns), read via {@link getRunStats}, and
   * fully fail-soft (accumulation is guarded and never throws into a run).
   */
  private runStatsAcc: RunStatsAccumulator = createRunStatsAccumulator();

  constructor(statusUpdate: StatusUpdateCallback, resolvers?: AgentResolvers) {
    this.statusUpdate = (level: StatusLevel, message: string) => {
      statusUpdate(level, message);
    };
    this.resolvers = resolvers;
  }

  /**
   * GS2-63 — emit one line of the technical run-header preamble (the Workdir/Model/Tools/Middleware
   * block) UNLESS it is opted out via `output.header: false`. The opt-out only ever reaches here in
   * non-TUI text modes: the interactive TUI forces `output.header` on before init (see
   * `createTuiSession`), and the TUI event path never goes through the interrupt-hint site, so the
   * whole preamble stays visible there. Only INFO header lines route through this — real model/tool
   * output, warnings and errors keep using {@link statusUpdate} directly.
   */
  protected headerStatus(message: string): void {
    if (this.config?.output?.header === false) return;
    this.statusUpdate(StatusLevel.INFO, message);
  }

  /**
   * GS2-16 — clear the per-run analytics tally so the next turn starts from zero. The runner
   * calls this at each turn boundary because it (and this agent) are reused across turns in an
   * interactive session.
   */
  resetRunStats(): void {
    this.runStatsAcc = createRunStatsAccumulator();
  }

  /** GS2-16 — the analytics harvested since the last {@link resetRunStats}. Never throws. */
  getRunStats(): GthRunStats {
    return finalizeRunStats(this.runStatsAcc);
  }

  /** GS2-16 — fold one message (or chunk) into the run tally. Fully guarded (fail-soft). */
  protected recordRunStats(message: unknown): void {
    accumulateMessage(this.runStatsAcc, message);
  }

  /**
   * GS2-16 — best-effort count of messages already in the checkpointed thread state, used by
   * {@link invoke} as the baseline so it harvests only THIS turn's new messages rather than the
   * whole accumulated conversation a checkpointer returns. Fail-soft: a missing `getState`, an odd
   * state shape, or any error yields 0 (worst case a one-turn over-count, never a throw).
   */
  private async getStateMessageCount(runConfig: RunnableConfig): Promise<number> {
    try {
      if (!this.agent || typeof this.agent.getState !== 'function') return 0;
      const state = await this.agent.getState(runConfig);
      const messages = (state as { values?: { messages?: unknown } })?.values?.messages;
      return Array.isArray(messages) ? messages.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Build the underlying compiled graph and assign it to {@link agent}. This is the only
   * part that differs between the lean and deep agents.
   */
  abstract init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined
  ): Promise<void>;

  /**
   * Invoke LLM with a message and runnable config.
   * For streaming use {@link #stream} method, streaming is preferred if model API supports it.
   * Please note that this when tools are involved, this method will anyway do multiple LLM
   * calls within LangChain dependency.
   */
  async invoke(messages: Message[], runConfig: RunnableConfig): Promise<string> {
    if (!this.agent || !this.config) {
      throw new Error('Agent not initialized. Call init() first.');
    }

    debugLog('=== Starting non-streaming invoke ===');
    debugLogObject('LLM Input Messages', messages);
    debugLogObject('Invoke RunConfig', runConfig);

    try {
      const progress = new ProgressIndicator('Thinking.');
      try {
        debugLog('Calling agent.invoke...');
        // GS2-16: capture the prior conversation length BEFORE invoking so we harvest ONLY this
        // turn's NEW messages. With a checkpointer + persistent thread (a multi-turn `--no-tui`
        // interactive session with `streamOutput: false`), `response.messages` is the FULL
        // accumulated conversation, not just this turn — folding all of it would re-sum prior
        // turns' usage_metadata and re-collect prior tools (per-turn over-count). This baseline
        // slice also prevents a double-harvest by the empty-stream fallback invoke in
        // GthAgentRunner: by then the streamed turn is checkpointed, so it is BEFORE the baseline.
        // Fail-soft: an unreadable baseline yields 0 (a one-turn over-count at worst, never a throw).
        const priorMessageCount = await this.getStateMessageCount(runConfig);
        const response = await this.agent.invoke({ messages }, runConfig);
        // Harvest token usage + invoked tool names from THIS turn's new messages only (fail-soft)
        // so the opt-in history recorder can populate `gth insights`.
        const allMessages = Array.isArray(response.messages) ? response.messages : [];
        for (const m of allMessages.slice(priorMessageCount)) this.recordRunStats(m);
        const finalMessage = response.messages[response.messages.length - 1];
        const finalContent = finalMessage?.content;
        const processedContent = !this.config.writeBinaryOutputsToFile
          ? {
              renderedContent: renderAssistantContent(finalContent),
              successMessages: [],
            }
          : materializeBinaryOutputs(finalContent, this.command);

        if (processedContent.renderedContent.trim().length > 0) {
          this.statusUpdate(StatusLevel.DISPLAY, processedContent.renderedContent);
        }
        for (const successMessage of processedContent.successMessages) {
          this.statusUpdate(StatusLevel.SUCCESS, successMessage);
        }
        return [processedContent.renderedContent, ...processedContent.successMessages]
          .filter((part) => part.trim().length > 0)
          .join('\n');
      } catch (e) {
        debugLogError('invoke inner', e);
        if (e instanceof Error && e?.name === 'ToolException') {
          throw e; // Re-throw ToolException to be handled by outer catch
        }
        const message = e instanceof Error ? e.message : String(e);
        this.statusUpdate(StatusLevel.ERROR, `LLM invocation failed: ${message}`);
        throw e;
      } finally {
        progress.stop();
      }
    } catch (error) {
      debugLogError('invoke outer', error);
      if (error instanceof Error) {
        if (error?.name === 'ToolException') {
          this.statusUpdate(StatusLevel.ERROR, `Tool execution failed: ${error?.message}`);
          return `Tool execution failed: ${error?.message}`;
        }
      }
      throw error;
    }
  }

  /**
   * Induce LLM to stream AI messages with a user message and runnable config.
   * When stream is not appropriate use {@link invoke}.
   */
  async stream(
    messages: Message[],
    runConfig: RunnableConfig
  ): Promise<IterableReadableStream<string>> {
    debugLog('=== Starting streaming invoke ===');
    debugLogObject('LLM Input Messages', messages);
    return this.streamFromInput({ messages }, runConfig);
  }

  /**
   * Resume a graph suspended on a human-in-the-loop `interrupt()` and stream the continuation
   * as text. Identical plumbing to {@link stream} (Esc-to-interrupt, binary handling), except
   * the graph input is a `Command({ resume })` instead of fresh `messages` — so the suspended
   * tool-approval interrupt is answered and the run continues on the same thread.
   */
  async streamResume(
    resumeValue: unknown,
    runConfig: RunnableConfig
  ): Promise<IterableReadableStream<string>> {
    debugLog('=== Starting streaming resume ===');
    debugLogObject('Resume value', resumeValue);
    return this.streamFromInput(new Command({ resume: resumeValue }), runConfig);
  }

  /**
   * Shared body for {@link stream} / {@link streamResume}: drive the compiled graph from
   * `input` (fresh `{ messages }` or a resume `Command`) and surface AI text deltas as a
   * string stream, with Esc-to-interrupt and binary-output materialization.
   */
  private async streamFromInput(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    runConfig: RunnableConfig
  ): Promise<IterableReadableStream<string>> {
    if (!this.agent || !this.config) {
      throw new Error('Agent not initialized. Call init() first.');
    }

    debugLogObject('Stream RunConfig', runConfig);

    this.statusUpdate(StatusLevel.INFO, '\nThinking...\n');

    const statusUpdate = this.statusUpdate;
    const config = this.config;
    const command = this.command;
    // GS2-16: bound so the stream `start()` closure (whose `this` is the stream source, not the
    // agent) can fold each chunk into the run tally. Fail-soft inside recordRunStats.
    const recordRunStats = (m: unknown) => this.recordRunStats(m);
    // TUI-C30 — compact per-tool-call indication for the plain surface (`name(args…)` + the
    // canonical 10-line greyed preview when each ToolMessage lands). Per-stream state; emits at
    // INFO level so the existing consoleLevel gate governs it like the historical tool notices.
    // The TUI never runs this string path (it renders the typed event stream itself).
    const toolIndication = createPlainToolIndication();
    const interruptState = { escape: false, messageShown: false };
    const abortController = new AbortController();
    const showInterruptMessage = () => {
      if (!interruptState.messageShown) {
        interruptState.messageShown = true;
        statusUpdate(StatusLevel.WARNING, '\n\nInterrupted by user, exiting\n\n');
      }
    };
    waitForEscape(
      () => {
        interruptState.escape = true;
        showInterruptMessage();
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      },
      this.config.canInterruptInferenceWithEsc,
      // GS2-63: the interrupt hint is part of the run-header preamble. Suppress the hint box (while
      // still arming the Esc/Q handler) when the header is opted out. This site only runs in the
      // non-TUI text path (`streamFromInput`); the TUI event path never reaches it.
      this.config.output?.header !== false
    );

    let stream;
    try {
      stream = await this.agent.stream(input, {
        ...runConfig,
        streamMode: 'messages',
        signal: abortController.signal,
      });
    } catch (error) {
      // If stream creation fails (e.g. an auth error), the IterableReadableStream below -
      // whose finally/cancel are what normally unregister the Escape listener - is never
      // constructed. Without this cleanup the raw-mode keypress listener keeps stdin ref'd,
      // the process hangs after the error, and Esc/Ctrl+C only print "Interrupting..."
      // (raw mode swallows SIGINT, so Ctrl+C cannot kill the process either).
      stopWaitingForEscape();
      throw error;
    }

    return new IterableReadableStream({
      async start(controller) {
        try {
          debugLog('Starting stream processing...');
          let totalChunks = 0;
          const seenBinaryBlocks = new Set<string>();
          const binaryBlocks: Array<{ mimeType: string; data: string }> = [];

          for await (const [chunk, _metadata] of stream) {
            debugLogObject('Stream chunk', { chunk, _metadata });
            // GS2-16: fold every chunk (AIMessageChunk usage/tool_calls, ToolMessage name) into
            // the run tally before the text-only handling below.
            recordRunStats(chunk);
            // TUI-C30: fold the chunk into the plain-surface tool indication (renders each
            // completed call when its ToolMessage arrives; a no-op for plain text chunks).
            toolIndication.observe(chunk);
            if (AIMessage.isInstance(chunk)) {
              const text = (chunk.text as string) ?? '';
              totalChunks++;

              if (text.length > 0) {
                statusUpdate(StatusLevel.STREAM, text);
                controller.enqueue(text);
              }

              if (config?.writeBinaryOutputsToFile) {
                for (const block of extractInlineBinaryBlocks(chunk.content)) {
                  const binaryKey = `${block.mimeType}:${block.data.length}:${block.data}`;
                  if (seenBinaryBlocks.has(binaryKey)) {
                    continue;
                  }
                  seenBinaryBlocks.add(binaryKey);
                  binaryBlocks.push({ mimeType: block.mimeType, data: block.data });
                }
              }
            }
            if (interruptState.escape) {
              if (typeof stream.cancel === 'function') {
                await stream.cancel();
              }
              break;
            }
          }
          if (config?.writeBinaryOutputsToFile && binaryBlocks.length > 0) {
            const processedContent = materializeBinaryOutputs(
              binaryBlocks.map((block) => ({
                type: 'inlineData',
                inlineData: block,
              })),
              command
            );
            for (const successMessage of processedContent.successMessages) {
              statusUpdate(StatusLevel.SUCCESS, successMessage);
            }
          }
          debugLog(`Stream completed. Total chunks: ${totalChunks}`);
          controller.close();
        } catch (error) {
          if (interruptState.escape || (error instanceof Error && error.name === 'AbortError')) {
            showInterruptMessage();
            controller.close();
          } else {
            debugLogError('stream processing', error);
            if (error instanceof Error) {
              if (error?.name === 'ToolException') {
                statusUpdate(StatusLevel.ERROR, `Tool execution failed: ${error?.message}`);
              }
            }
            controller.error(error);
          }
        } finally {
          stopWaitingForEscape();
        }
      },
      async cancel() {
        stopWaitingForEscape();
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
        // Clean up the underlying stream if it has a cancel method
        if (stream && typeof stream.cancel === 'function') {
          await stream.cancel();
        }
      },
    });
  }

  /**
   * Stream agent events as typed AgentStreamEvent objects.
   * Yields text deltas, tool call lifecycle events, and tool results.
   *
   * If a tool with `metadata.client === true` triggers `interrupt()`, the underlying
   * graph throws `GraphInterrupt`; this generator catches it and ends cleanly so the
   * caller's transport (e.g. AG-UI SSE) can finish the run with the tool call hanging.
   * Resume the suspended graph via {@link streamWithEventsResume} on the same thread id.
   */
  async *streamWithEvents(
    messages: Message[],
    runConfig: RunnableConfig,
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config) {
      throw new Error('Agent not initialized. Call init() first.');
    }

    debugLog('=== Starting streamWithEvents ===');
    debugLogObject('LLM Input Messages', messages);

    try {
      // `signal` lets the transport (e.g. the AG-UI server on client disconnect)
      // cancel the in-flight LLM generation, not just stop reading from it.
      const stream = await this.agent.stream(
        { messages },
        { ...runConfig, streamMode: 'messages', signal }
      );
      yield* this.processEventStream(stream);
    } catch (e) {
      if (
        e instanceof GraphInterrupt ||
        (e as Error).name === 'GraphInterrupt' ||
        (e as Error).name === 'AbortError'
      ) {
        debugLog('Graph suspended (GraphInterrupt) or aborted by caller');
        return;
      }
      throw e;
    }
  }

  /**
   * Resume a graph that was suspended via `interrupt()` with the supplied value.
   *
   * The runnable config must carry the same `thread_id` used when the graph was
   * suspended (the checkpointer keys state by thread). The resume value is whatever
   * the suspending tool needs back — for frontend-fulfilled tools this is the value
   * the client sends in `forwardedProps.command.resume`.
   */
  async *streamWithEventsResume(
    resumeValue: unknown,
    runConfig: RunnableConfig,
    queuedMessages?: BaseMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config) {
      throw new Error('Agent not initialized. Call init() first.');
    }

    debugLog('=== Starting streamWithEventsResume ===');

    try {
      // Queued follow-up messages: when the client sends mid-task input
      // alongside the resume, append it to the graph's `messages` state via
      // Command.update so the agent sees it on its next decision turn — no
      // separate run, no dangling tool calls. (Ordering note: the update lands
      // around the resumed tool result; lenient local models tolerate this,
      // strict tool-call/result adjacency providers may not.)
      const command =
        queuedMessages && queuedMessages.length > 0
          ? new Command({ resume: resumeValue, update: { messages: queuedMessages } })
          : new Command({ resume: resumeValue });
      const stream = await this.agent.stream(command, {
        ...runConfig,
        streamMode: 'messages',
        signal,
      });
      yield* this.processEventStream(stream);
    } catch (e) {
      if (
        e instanceof GraphInterrupt ||
        (e as Error).name === 'GraphInterrupt' ||
        (e as Error).name === 'AbortError'
      ) {
        debugLog('Graph suspended (GraphInterrupt) or aborted by caller');
        return;
      }
      throw e;
    }
  }

  /**
   * Inspect the checkpointed state for the thread and return the tool calls currently pending
   * human approval (empty array when the run finished normally). A LangGraph
   * `humanInTheLoopMiddleware` interrupt parks one `HITLRequest` per suspended super-step in
   * `state.tasks[].interrupts[].value.actionRequests` (each `{ name, args }`); this flattens
   * those into {@link PendingToolInterrupt}s. Defensive throughout — a graph without
   * `getState`, or any unexpected shape, yields `[]` rather than throwing, so a missing HITL
   * setup degrades to "no approval needed" instead of breaking the run.
   */
  async getPendingToolInterrupts(runConfig: RunnableConfig): Promise<PendingToolInterrupt[]> {
    if (!this.agent || typeof this.agent.getState !== 'function') {
      return [];
    }
    let state: unknown;
    try {
      state = await this.agent.getState(runConfig);
    } catch (e) {
      debugLogError('getPendingToolInterrupts getState', e);
      return [];
    }
    const tasks = (state as { tasks?: unknown })?.tasks;
    if (!Array.isArray(tasks)) {
      return [];
    }
    const pending: PendingToolInterrupt[] = [];
    for (const task of tasks) {
      const interrupts = (task as { interrupts?: unknown })?.interrupts;
      if (!Array.isArray(interrupts)) continue;
      for (const interrupt of interrupts) {
        const value = (interrupt as { value?: unknown })?.value;
        const actionRequests = (value as { actionRequests?: unknown })?.actionRequests;
        if (!Array.isArray(actionRequests)) continue;
        for (const action of actionRequests) {
          const name = (action as { name?: unknown })?.name;
          if (typeof name !== 'string') continue;
          const args = (action as { args?: unknown })?.args;
          pending.push({
            name,
            args: args && typeof args === 'object' ? (args as Record<string, unknown>) : {},
          });
        }
      }
    }
    return pending;
  }

  protected async *processEventStream(
    stream: IterableReadableStream<[BaseMessage, Record<string, unknown>]>
  ): AsyncGenerator<AgentStreamEvent> {
    // Aggregate AIMessageChunks via concat so tool_call_chunks collapse into
    // tool_calls with complete args (per-chunk tool_calls only ever sees that
    // chunk's slice of the args JSON, which is rarely valid on its own).
    let aggregatedAIChunk: AIMessageChunk | null = null;
    let reasoningOpen = false;
    const flushed = new Set<string>();
    // TUI-C22 — one splitter for the whole stream so a <think> opened in one chunk and closed
    // several chunks later is tracked across the boundary. Reset at message boundaries via flush().
    const thinkSplitter = createThinkTagSplitter();

    // TUI-C22 — emit ordered answer/reasoning segments, opening/closing the reasoning block as the
    // kind switches. Shares `reasoningOpen` with the reasoning_content path so the two compose
    // (a reasoning_content delta then think-derived reasoning stays one open block; answer text
    // closes it), preserving the exact existing event sequence when no <think> tags are present.
    function* emitSegments(segments: ThinkSegment[]): Generator<AgentStreamEvent> {
      for (const seg of segments) {
        if (seg.text.length === 0) continue;
        if (seg.kind === 'reasoning') {
          if (!reasoningOpen) {
            reasoningOpen = true;
            yield { type: 'reasoning_start' };
          }
          yield { type: 'reasoning_delta', delta: seg.text };
        } else {
          if (reasoningOpen) {
            reasoningOpen = false;
            yield { type: 'reasoning_end' };
          }
          yield { type: 'text', delta: seg.text };
        }
      }
    }

    function* flushAggregated(): Generator<AgentStreamEvent> {
      if (!aggregatedAIChunk) return;
      const toolCalls = aggregatedAIChunk.tool_calls ?? [];
      const invalidToolCalls = aggregatedAIChunk.invalid_tool_calls ?? [];
      for (const tc of toolCalls) {
        const id = tc.id as string | undefined;
        if (!id || flushed.has(id)) continue;
        flushed.add(id);
        yield { type: 'tool_start', id, name: tc.name };
        yield { type: 'tool_args', id, delta: JSON.stringify(tc.args ?? {}) };
        yield { type: 'tool_end', id };
      }
      // Surface invalid tool calls too so the client at least sees the raw args
      // string the model produced, instead of silently dropping them.
      for (const tc of invalidToolCalls) {
        const id = tc.id as string | undefined;
        if (!id || flushed.has(id)) continue;
        flushed.add(id);
        yield { type: 'tool_start', id, name: tc.name ?? '' };
        yield { type: 'tool_args', id, delta: tc.args ?? '' };
        yield { type: 'tool_end', id };
      }
    }

    for await (const [chunk, _metadata] of stream) {
      debugLogObject('streamWithEvents chunk', { chunk, _metadata });
      // GS2-16: fold every chunk (AIMessageChunk usage/tool_calls, ToolMessage name) into the
      // run tally so the TUI turn can record real token/tool data. Fail-soft.
      this.recordRunStats(chunk);

      if (AIMessageChunk.isInstance(chunk)) {
        // TUI-C29 — aggregate a raw-response-stripped clone. OpenRouter's `__raw_response`
        // (read per-chunk below at pickReasoningDelta, never off the aggregate) would otherwise
        // deep-merge into the aggregate on every concat and grow linearly for the whole stream.
        // The original `chunk` stays untouched so the reasoning + <think> paths read it verbatim.
        const chunkForAggregation = stripRawResponseForAggregation(chunk);
        aggregatedAIChunk = aggregatedAIChunk
          ? aggregatedAIChunk.concat(chunkForAggregation)
          : chunkForAggregation;

        // Reasoning deltas — historically Ollama (Qwen3, deepseek-r1) and Anthropic surface
        // thinking in additional_kwargs.reasoning_content; TUI-C22 additionally lifts a top-level
        // `reasoning` from the raw response (OpenRouter) when reasoning_content is absent. Stream
        // it as a separate event series so clients can render it apart from the answer.
        const reasoningDelta = pickReasoningDelta(chunk.additional_kwargs, true);
        if (reasoningDelta.length > 0) {
          yield* emitSegments([{ kind: 'reasoning', text: reasoningDelta }]);
        }

        // Yield text incrementally — use this chunk's text (delta), not the aggregated content
        // which is cumulative. TUI-C22 routes it through the think splitter so inline
        // <think>...</think> (buffered across chunks) is peeled into the reasoning channel and
        // stripped from the answer; text with no think tags passes straight through unchanged.
        if (chunk.text) {
          yield* emitSegments(thinkSplitter.push(chunk.text as string));
        }
      } else if (AIMessage.isInstance(chunk)) {
        // Reasoning on a non-chunk AIMessage — a non-streamed / resumed thinking message
        // (e.g. a checkpoint replay) still carries its thinking in
        // additional_kwargs.reasoning_content (or, TUI-C22, a top-level `reasoning` on the raw
        // response message). Mirror the AIMessageChunk branch and emit the same reasoning event
        // series, otherwise the thought is silently dropped (TUI-C15).
        const reasoningContent = pickReasoningDelta(chunk.additional_kwargs, false);
        if (reasoningContent.length > 0) {
          yield* emitSegments([{ kind: 'reasoning', text: reasoningContent }]);
        }

        // Non-chunk AIMessage (e.g. on resumed runs) carries final tool_calls
        // directly; merge them into the aggregate so flushAggregated emits them.
        if (chunk.tool_calls && chunk.tool_calls.length > 0) {
          const synthetic = new AIMessageChunk({
            content: '',
            tool_calls: chunk.tool_calls,
          });
          aggregatedAIChunk = aggregatedAIChunk ? aggregatedAIChunk.concat(synthetic) : synthetic;
        }
        if (chunk.text) {
          yield* emitSegments(thinkSplitter.push(chunk.text as string));
        }
        // A non-chunk AIMessage is a COMPLETE message, not a delta — drain any residual now
        // (an unterminated <think> becomes reasoning, a dangling partial becomes answer) so its
        // buffered state never leaks into a subsequent message (TUI-C22).
        yield* emitSegments(thinkSplitter.flush());
      }

      if (chunk instanceof ToolMessage) {
        // TUI-C22 — drain buffered think text (emitting its segments, which may open/close
        // reasoning) BEFORE closing the reasoning block, so a trailing reasoning slice can't land
        // after reasoning_end or be dropped. A tool round ends the assistant message, so reset.
        yield* emitSegments(thinkSplitter.flush());
        if (reasoningOpen) {
          reasoningOpen = false;
          yield { type: 'reasoning_end' };
        }
        yield* flushAggregated();
        // Reset between rounds. OpenAI restarts tool_call_chunks.index at 0
        // for each new LLM round; without this reset the next round's chunks
        // collide with the previous round's groups in collapseToolCallChunks
        // and end up with empty args.
        aggregatedAIChunk = null;

        const content =
          typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content);
        // Surface the real tool-result error signal (LangChain `ToolMessage.status`) so
        // consumers render the ✗/error affordance from fact, not from sniffing the result
        // text. Only attach the flag on error to keep the success event shape unchanged.
        yield {
          type: 'tool_result',
          id: chunk.tool_call_id as string,
          content,
          ...(chunk.status === 'error' ? { isError: true } : {}),
        };
      }
    }

    // TUI-C22 — drain any buffered think text at stream end (an unterminated <think> surfaces as
    // reasoning, a dangling partial as answer) before closing the reasoning block.
    yield* emitSegments(thinkSplitter.flush());

    // Close any still-open reasoning block before flushing tool calls.
    if (reasoningOpen) {
      yield { type: 'reasoning_end' };
    }

    // Flush any tool calls not followed by a ToolMessage (e.g. terminal tool calls).
    yield* flushAggregated();
  }

  async cleanup(): Promise<void> {
    debugLog('Cleaning up agent...');
    if (this.resolvers?.cleanupTools) {
      await this.resolvers.cleanupTools();
    }
    if (this.resolvers?.cleanupMiddleware) {
      await this.resolvers.cleanupMiddleware();
    }
    this.agent = null;
    this.config = null;
    this.command = undefined;
    debugLog('Agent cleanup complete');
  }

  getEffectiveConfig(config: GthConfig, command: GthCommand | undefined): GthConfig {
    debugLog(`Getting effective config for command: ${command || 'default'}`);
    const supportsTools = !!config.llm.bindTools;
    if (!supportsTools) {
      this.statusUpdate(StatusLevel.WARNING, 'Model does not seem to support tools.');
      debugLog('Warning: Model does not support tools');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmdConfig = (command && config.commands?.[command]) as any;
    return {
      ...config,
      filesystem: cmdConfig?.filesystem !== undefined ? cmdConfig.filesystem : config.filesystem,
      builtInTools:
        cmdConfig?.builtInTools !== undefined ? cmdConfig.builtInTools : config.builtInTools,
      allowedTools:
        cmdConfig?.allowedTools !== undefined ? cmdConfig.allowedTools : config.allowedTools,
      binaryFormats:
        cmdConfig?.binaryFormats !== undefined ? cmdConfig.binaryFormats : config.binaryFormats,
    };
  }

  /**
   * Extract and flatten tools from toolkits, applying client-tool `interrupt()` stubbing.
   * A tool with `metadata.client === true` has its body swapped for an `interrupt()` call
   * so the run suspends and the client fulfils it (the C-a AG-UI bridge depends on this).
   */
  protected extractAndFlattenTools(
    tools: (StructuredToolInterface | BaseToolkit | ServerTool)[]
  ): StructuredToolInterface[] {
    const flattenedTools: StructuredToolInterface[] = [];
    for (const toolOrToolkit of tools) {
      // eslint-disable-next-line
      if ((toolOrToolkit as any)['getTools'] instanceof Function) {
        // This is a toolkit
        flattenedTools.push(...(toolOrToolkit as BaseToolkit).getTools());
      } else {
        // This is a regular tool
        let singleTool = toolOrToolkit as StructuredToolInterface;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((singleTool as any).metadata?.client === true) {
          // Clone the tool to avoid mutating the original
          singleTool = Object.assign(Object.create(Object.getPrototypeOf(singleTool)), singleTool);
          const stubFunc = async (_input: unknown, _config?: RunnableConfig) => {
            const value = await interrupt({ name: singleTool.name });
            return typeof value === 'string' ? value : JSON.stringify(value);
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          singleTool.invoke = stubFunc as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          singleTool.call = stubFunc as any;
        }
        flattenedTools.push(singleTool);
      }
    }
    return flattenedTools;
  }
}
