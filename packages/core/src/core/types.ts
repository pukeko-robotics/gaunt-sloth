import type { GthConfig } from '#src/config.js';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { IterableReadableStream } from '@langchain/core/utils/stream';
import type { BaseCheckpointSaver } from '@langchain/langgraph';

export type Message = BaseMessage;

export type StatusUpdateCallback = (level: StatusLevel, message: string) => void;

/**
 * Status level for logging and output control.
 * Levels are ordered by importance, with lower ordinal values being more verbose.
 * DEBUG (0) is the most verbose, STREAM (6) is the least verbose.
 */
export enum StatusLevel {
  DEBUG = 0,
  INFO = 1,
  DISPLAY = 2,
  SUCCESS = 3,
  WARNING = 4,
  ERROR = 5,
  STREAM = 6,
}
export type GthCommand = 'ask' | 'pr' | 'review' | 'chat' | 'code' | 'api';

/**
 * Typed events emitted by the agent's {@link GthAgentInterface#streamWithEvents} path.
 * This is the renderer contract shared by every consumer of an agent run — the AG-UI
 * SSE encoder, the (future) TUI, and any embedder — so it is intentionally agnostic of
 * how the underlying graph was built (lean `createAgent` or `createDeepAgent`).
 */
export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning_start' }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'reasoning_end' }
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_args'; id: string; delta: string }
  | { type: 'tool_end'; id: string }
  | { type: 'tool_result'; id: string; content: string };

/**
 * The minimal structural surface of a compiled LangGraph agent that the shared agent
 * plumbing in {@link GthAbstractAgent} drives. Both `createAgent` (lean) and
 * `createDeepAgent` return graphs that satisfy this, so the base class can stream/invoke
 * either without knowing which builder produced it. Inputs are intentionally loose
 * (`any`) so concrete builder return types assign without casts; the base re-applies
 * precise typing at the point of use via `AIMessage`/`AIMessageChunk` guards.
 */
export interface GthCompiledGraph {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(input: any, config?: RunnableConfig): Promise<{ messages: BaseMessage[] }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream(input: any, config?: any): Promise<IterableReadableStream<any>>;
}

export interface GthAgentInterface {
  init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointSaver?: BaseCheckpointSaver | undefined
  ): Promise<void>;

  invoke(messages: Message[], runConfig: RunnableConfig): Promise<string>;

  stream(messages: Message[], runConfig: RunnableConfig): Promise<IterableReadableStream<string>>;

  /**
   * Stream the run as typed {@link AgentStreamEvent}s. If a client tool triggers
   * `interrupt()` the underlying graph suspends; this generator ends cleanly so the
   * transport can finish the run with the tool call hanging. Resume via
   * {@link streamWithEventsResume} on the same `thread_id`.
   */
  streamWithEvents(
    messages: Message[],
    runConfig: RunnableConfig,
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent>;

  /** Resume a graph suspended via `interrupt()` with the supplied value. */
  streamWithEventsResume(
    resumeValue: unknown,
    runConfig: RunnableConfig,
    queuedMessages?: BaseMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentStreamEvent>;

  cleanup?(): Promise<void>;
}

/**
 * Factory that produces a {@link GthAgentInterface} implementation. Injected into
 * {@link GthAgentRunner} so embedders can swap the lean `GthLangChainAgent` (default,
 * in core) for a deep `GthDeepAgent` (in `@gaunt-sloth/agent`) without core ever
 * importing deepagents.
 */
export type GthAgentFactory = (
  statusUpdate: StatusUpdateCallback,
  resolvers?: AgentResolvers
) => GthAgentInterface;

export type ToolsResolver = (
  config: GthConfig,
  command?: GthCommand
) => Promise<StructuredToolInterface[]>;
export type ToolsCleanup = () => Promise<void>;

export type MiddlewareResolver = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware: any[] | undefined,
  config: GthConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<any[]>;
export type MiddlewareCleanup = () => Promise<void>;

export interface AgentResolvers {
  resolveTools?: ToolsResolver;
  cleanupTools?: ToolsCleanup;
  resolveMiddleware?: MiddlewareResolver;
  cleanupMiddleware?: MiddlewareCleanup;
}
