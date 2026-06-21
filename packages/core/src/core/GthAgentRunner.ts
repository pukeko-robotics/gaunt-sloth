import { GthConfig } from '#src/config.js';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentFactory,
  GthAgentInterface,
  GthCommand,
  Message,
  StatusUpdateCallback,
} from '#src/core/types.js';
import { GthLangChainAgent } from '#src/core/GthLangChainAgent.js';
import { enhanceVertexUnauthorizedMessage } from '#src/utils/vertexaiUtils.js';
import { RunnableConfig } from '@langchain/core/runnables';
import { getNewRunnableConfig } from '#src/utils/llmUtils.js';
import {
  initDebugLogging,
  debugLog,
  debugLogError,
  debugLogObject,
} from '#src/utils/debugUtils.js';

/**
 * Agent simplifies interaction with LLM and reduces it to calling a few methods
 * {@link GthAgentRunner#init} and {@link GthAgentRunner#processMessages}.
 */
export class GthAgentRunner {
  private statusUpdate: StatusUpdateCallback;
  private resolvers: AgentResolvers | undefined;
  private agent: GthAgentInterface | null = null;
  private config: GthConfig | null = null;
  private runConfig: RunnableConfig | null = null;
  private agentFactory: GthAgentFactory;

  /**
   * @param agentFactory Produces the {@link GthAgentInterface} the runner drives.
   *   Defaults to the lean {@link GthLangChainAgent} (core). `@gaunt-sloth/agent`
   *   passes a factory returning a deep `GthDeepAgent` so the same runner can drive a
   *   `createDeepAgent` graph without core depending on deepagents.
   */
  constructor(
    statusUpdate: StatusUpdateCallback,
    resolvers?: AgentResolvers,
    agentFactory?: GthAgentFactory
  ) {
    this.statusUpdate = statusUpdate;
    this.resolvers = resolvers;
    this.agentFactory =
      agentFactory ?? ((status, agentResolvers) => new GthLangChainAgent(status, agentResolvers));
  }

  /**
   * Init is split into a separate method. This may create a number of connections,
   * and we'd better have an instance by that moment, for the case things will go wrong,
   * so we can wrap init into try-catch and then call {@link #cleanup} within finally.
   */
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointSaver?: BaseCheckpointSaver | undefined
  ): Promise<void> {
    this.config = configIn;

    // Initialize debug logging
    initDebugLogging(configIn.debugLog ?? false);
    debugLog(`Initializing GthAgentRunner with command: ${command || 'default'}`);

    this.runConfig = getNewRunnableConfig();

    debugLogObject('Runnable Config', this.runConfig);

    this.agent = this.agentFactory(this.statusUpdate, this.resolvers);

    // Initialize the agent
    debugLog('Initializing agent...');
    await this.agent.init(command, configIn, checkpointSaver);

    debugLog('Agent initialization complete');
  }

  /**
   * processMessages deals with both streaming and non-streaming approaches.
   */
  async processMessages(messages: Message[]): Promise<string> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }

    debugLog('Processing messages...');
    debugLogObject('Input Messages', messages);

    try {
      // Decision: Use streaming or non-streaming based on config
      if (this.config.streamOutput) {
        // Use streaming
        debugLog('Using streaming mode');
        const stream = await this.agent.stream(messages, this.runConfig);
        let result = '';
        try {
          for await (const chunk of stream) {
            debugLogObject('Stream chunk', chunk);
            result += chunk;
          }
        } catch (streamError) {
          // Handle streaming-specific errors
          debugLogError('Stream processing', streamError);
          throw new Error(
            `Stream processing failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`
          );
        }
        debugLog(`Stream completed. Total response length: ${result.length}`);
        if (result.trim().length === 0) {
          debugLog('Stream produced empty response, retrying once with non-streaming invoke.');
          const fallback = await this.agent.invoke(messages, this.runConfig);
          debugLog(`Fallback non-stream response length: ${fallback.length}`);
          if (fallback.trim().length === 0) {
            throw new Error(
              'Model returned an empty response after tool execution. Try again or switch to a more stable model.'
            );
          }
          return fallback;
        }
        return result;
      } else {
        // Use non-streaming
        debugLog('Using non-streaming mode');
        const result = await this.agent.invoke(messages, this.runConfig);
        debugLog(`Non-stream response length: ${result.length}`);
        if (result.trim().length === 0) {
          throw new Error(
            'Model returned an empty response. Try again or switch to a more stable model.'
          );
        }
        return result;
      }
    } catch (error) {
      // Handle agent invocation errors
      debugLogError('Agent processing', error);
      const originalMessage = error instanceof Error ? error.message : String(error);
      const enhancedMessage = enhanceVertexUnauthorizedMessage(originalMessage, this.config?.llm);
      throw new Error(
        `Agent processing failed: ${enhancedMessage}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }
  }

  /**
   * Event-stream counterpart to {@link processMessages}: drives the agent's typed
   * {@link AgentStreamEvent} path using the runner's own thread-bound `runConfig`, so a
   * renderer (the Ink TUI) can present the same run the readline path renders via
   * `consoleUtils` while sharing the checkpointer thread for cross-turn memory.
   *
   * Cancellation is via the supplied `signal` (the TUI's Esc → `AbortController`); the
   * underlying `streamWithEvents` ends cleanly on abort or `interrupt()`. The string
   * path's empty-stream retry/`invoke` fallback is intentionally NOT duplicated here — the
   * TUI renders the live event stream directly; revisit if empty-stream retries are needed.
   */
  async *processMessagesWithEvents(
    messages: Message[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent || !this.config || !this.runConfig) {
      throw new Error('AgentRunner not initialized. Call init() first.');
    }
    debugLog('Processing messages (event stream)...');
    debugLogObject('Input Messages', messages);
    yield* this.agent.streamWithEvents(messages, this.runConfig, signal);
  }

  // noinspection JSUnusedGlobalSymbols
  public getAgent(): GthAgentInterface | null {
    return this.agent;
  }

  /**
   * Rotate the thread the runner drives by minting a fresh `runConfig` (new `thread_id`),
   * so subsequent turns start from an empty checkpointer thread rather than retrieving the
   * prior conversation. Used by the TUI's `/clear`, which clears the on-screen transcript;
   * without this the model would still see the full history persisted under the old thread.
   *
   * Rotating the thread_id (rather than deleting from the checkpointer) keeps this independent
   * of any checkpointer-specific delete API, mirroring how `init()` mints the initial config.
   */
  public resetThread(): void {
    this.runConfig = getNewRunnableConfig();
    debugLogObject('Reset Runnable Config', this.runConfig);
  }

  async cleanup(): Promise<void> {
    debugLog('Cleaning up GthAgentRunner...');
    if (this.agent && 'cleanup' in this.agent && typeof this.agent.cleanup === 'function') {
      await this.agent.cleanup();
    }
    this.agent = null;
    this.config = null;
    debugLog('GthAgentRunner cleanup complete');
  }
}
