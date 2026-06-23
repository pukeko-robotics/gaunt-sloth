import type { GthConfig } from '#src/config.js';
import type { ShellSafetyVerdict } from '#src/core/shell/judge.js';
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
export type GthCommand = 'ask' | 'pr' | 'review' | 'chat' | 'code' | 'api' | 'exec';

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
  /**
   * Read the checkpointed graph state for a thread. Present on LangGraph compiled graphs
   * (both `createAgent` and `createDeepAgent`); used to detect a graph suspended on a
   * human-in-the-loop `interrupt()` (its pending {@link PendingToolInterrupt} lives in
   * `state.tasks[].interrupts[].value`). Optional because the structural surface predates it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getState?(config: RunnableConfig): Promise<any>;
}

/**
 * A single tool call a human-in-the-loop interrupt is waiting on, surfaced from the
 * suspended graph state so a consumer (the interactive session) can render an approve/reject
 * prompt. Mirrors LangChain's HITL `ActionRequest` (tool name + the args it would run with).
 */
export interface PendingToolInterrupt {
  name: string;
  args: Record<string, unknown>;
  /**
   * EXT-10 — when the LLM-as-judge safety gate escalated this `run_shell_command` to the human
   * (rather than auto-approving it), the judge's verdict is attached here so the approval surface
   * can show a "safety judge flagged: <reason>" notice. Absent when the judge is disabled (the
   * default) or when the command reached the human without going through the judge.
   */
  safetyVerdict?: ShellSafetyVerdict;
}

/**
 * Persistence scope for an `approve` decision (EXT-9 Tier-2 allow-list ergonomics):
 * - `once`    — run this single invocation only; remember nothing (the default).
 * - `session` — remember the command's classified prefix for the life of this runner
 *   instance, so flag-variants of the same operation auto-approve without re-prompting.
 * - `always`  — additionally persist the prefix to the project allow-list
 *   (`.gsloth/.gsloth-settings/shell-allowlist.json`) so it survives across runs.
 */
export type ToolApprovalScope = 'once' | 'session' | 'always';

/**
 * A consumer-supplied decision on a {@link PendingToolInterrupt}: approve runs the tool,
 * reject feeds the model a tool-rejected message (with the optional reason).
 *
 * `approve` carries an optional {@link ToolApprovalScope}; when absent it means `once`
 * (backward compatible — a bare `{ type: 'approve' }` still type-checks and behaves as
 * a single-shot approval that persists nothing).
 */
export type ToolApprovalDecision =
  | { type: 'approve'; scope?: ToolApprovalScope }
  | { type: 'reject'; message?: string };

/**
 * Callback the {@link GthAgentRunner} invokes when a run suspends on a tool-approval
 * interrupt, once per pending tool call. Returns the human's decision. When no handler is
 * wired (e.g. a non-interactive run), the runner defaults to reject so a run can never
 * silently hang or auto-approve.
 */
export type ToolApprovalCallback = (
  pending: PendingToolInterrupt
) => Promise<ToolApprovalDecision> | ToolApprovalDecision;

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

  /**
   * Resume a graph suspended on a human-in-the-loop `interrupt()` and stream the continuation
   * as text (the string counterpart to {@link streamWithEventsResume}, for the readline path).
   * Optional: only implemented by agents that support tool-approval interrupts.
   */
  streamResume?(
    resumeValue: unknown,
    runConfig: RunnableConfig
  ): Promise<IterableReadableStream<string>>;

  /**
   * Inspect the checkpointed state for the thread and return any tool calls currently pending
   * human approval (empty when the run completed normally). Optional: only implemented by
   * agents whose graph exposes `getState`. Used by {@link GthAgentRunner} to drive the
   * approve/reject confirmation loop.
   */
  getPendingToolInterrupts?(runConfig: RunnableConfig): Promise<PendingToolInterrupt[]>;

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
