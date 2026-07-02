import { GthConfig, ServerTool } from '#src/config.js';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentInterface,
  GthCommand,
  GthCompiledGraph,
  Message,
  PendingToolInterrupt,
  StatusLevel,
  StatusUpdateCallback,
} from '#src/core/types.js';
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

  constructor(statusUpdate: StatusUpdateCallback, resolvers?: AgentResolvers) {
    this.statusUpdate = (level: StatusLevel, message: string) => {
      statusUpdate(level, message);
    };
    this.resolvers = resolvers;
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
        const response = await this.agent.invoke({ messages }, runConfig);
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
    const interruptState = { escape: false, messageShown: false };
    const abortController = new AbortController();
    const showInterruptMessage = () => {
      if (!interruptState.messageShown) {
        interruptState.messageShown = true;
        statusUpdate(StatusLevel.WARNING, '\n\nInterrupted by user, exiting\n\n');
      }
    };
    waitForEscape(() => {
      interruptState.escape = true;
      showInterruptMessage();
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }, this.config.canInterruptInferenceWithEsc);

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

      if (AIMessageChunk.isInstance(chunk)) {
        aggregatedAIChunk = aggregatedAIChunk ? aggregatedAIChunk.concat(chunk) : chunk;

        // Reasoning deltas — Ollama (Qwen3, deepseek-r1) and Anthropic surface
        // thinking text in additional_kwargs.reasoning_content. Stream it as a
        // separate event series so clients can render it apart from the answer.
        const reasoningDelta = chunk.additional_kwargs?.reasoning_content;
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            yield { type: 'reasoning_start' };
          }
          yield { type: 'reasoning_delta', delta: reasoningDelta };
        }

        // Yield text incrementally — use this chunk's text (delta), not the
        // aggregated content which is cumulative.
        if (chunk.text) {
          if (reasoningOpen) {
            reasoningOpen = false;
            yield { type: 'reasoning_end' };
          }
          yield { type: 'text', delta: chunk.text as string };
        }
      } else if (AIMessage.isInstance(chunk)) {
        // Reasoning on a non-chunk AIMessage — a non-streamed / resumed thinking message
        // (e.g. a checkpoint replay) still carries its thinking in
        // additional_kwargs.reasoning_content. Mirror the AIMessageChunk branch and emit the
        // same reasoning event series, otherwise the thought is silently dropped (TUI-C15).
        const reasoningContent = chunk.additional_kwargs?.reasoning_content;
        if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
          if (!reasoningOpen) {
            reasoningOpen = true;
            yield { type: 'reasoning_start' };
          }
          yield { type: 'reasoning_delta', delta: reasoningContent };
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
          if (reasoningOpen) {
            reasoningOpen = false;
            yield { type: 'reasoning_end' };
          }
          yield { type: 'text', delta: chunk.text as string };
        }
      }

      if (chunk instanceof ToolMessage) {
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
