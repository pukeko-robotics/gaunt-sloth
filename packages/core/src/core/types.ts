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
 * GS2-16 — per-run analytics harvested from a finished agent turn, threaded into the opt-in
 * history recorder ({@link recordSessionSafe}) so `gth insights` reports real numbers instead of
 * zeros. All fields are best-effort: token counts are only present when the provider actually
 * reported `usage_metadata` (otherwise omitted so the recorder stores NULL and the insights
 * formatter suppresses the misleading `0`), and `tools` lists the names of tools invoked during
 * the run (deduplicated, order-insensitive). There is no `costUsd` — cost requires a reliable
 * price table this project does not carry, so it is deliberately never invented here.
 */
export interface GthRunStats {
  /** Total prompt/input tokens across the run's LLM calls, when the provider reported usage. */
  tokensInput?: number;
  /** Total completion/output tokens across the run's LLM calls, when the provider reported usage. */
  tokensOutput?: number;
  /** Names of tools invoked during the run (deduplicated); empty when no tools were used. */
  tools: string[];
  /**
   * BATCH-21 — one record per executed tool result (`ToolMessage`) observed during the run, in
   * arrival order and NOT deduplicated (a tool called twice yields two records), so `gth eval`'s
   * tool-RESULT assertions (`must_error` / `tool_result_json_path`) can grade what a tool
   * *returned*, not just that it was called. Optional (additive): producers that predate the field
   * simply omit it; {@link runStats.js finalizeRunStats} always sets it.
   */
  toolResults?: GthToolResult[];
}

/**
 * BATCH-21 — one executed tool call's result, harvested from its `ToolMessage` by the GS2-16
 * run-stats accumulator (`core/runStats.ts`). Fail-soft like everything else there: `content` is
 * omitted when no text payload could be derived, and is size-capped
 * ({@link runStats.js TOOL_RESULT_CONTENT_CAP}) so a giant payload can't bloat run stats.
 */
export interface GthToolResult {
  /** The tool that produced the result (`ToolMessage.name`). */
  name: string;
  /** `true` iff the result carried LangChain's real error signal (`ToolMessage.status === 'error'`). */
  isError: boolean;
  /** The result payload as text (a non-string payload is JSON-stringified), capped in length. */
  content?: string;
}

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
  | {
      /**
       * TUI-C17 — one live output chunk from an EXECUTING tool (a custom/dev toolkit child
       * process's stdout/stderr, or its "Executing …" announcement), surfaced through the managed
       * event stream instead of raw `process.stdout` so a renderer (the Ink TUI) can fold it into
       * its view-model. Emitted by the tool-output channel merge
       * (see `core/toolOutputChannel.js#mergeToolOutputIntoEvents`), NOT by `processEventStream`
       * itself — consumers that don't opt into the merge (e.g. the AG-UI SSE encoder) never see it
       * and the toolkits keep writing to stdout for them (today's headless behaviour).
       */
      type: 'tool_output';
      /**
       * The tool call this chunk belongs to (LangChain's `ToolRunnableConfig.toolCall.id`,
       * threaded through the toolkits), so a renderer can nest output under the exact call —
       * TUI-C30 consumes this for per-call output previews. Optional only defensively: absent
       * when the executing framework did not supply a tool call, in which case consumers should
       * fall back to `name` attribution.
       */
      id?: string;
      /** The gth tool name (e.g. `run_shell_command`, a custom tool's name). Always known. */
      name: string;
      /** One verbatim streamed chunk of the child's stdout/stderr (or the notice text). */
      chunk: string;
      /**
       * True when this chunk is the "🔧 Executing …" announcement rather than child output, so
       * a richer renderer (TUI-C30) can style or strip it when previewing raw output lines.
       */
      isNotice?: boolean;
    }
  | {
      type: 'tool_result';
      id: string;
      content: string;
      /**
       * True when the underlying `ToolMessage.status` is `'error'` (LangChain's real
       * tool-result error signal). Absent/undefined means success — consumers must not
       * sniff the result text to infer failure. Optional for backward compatibility with
       * producers that predate the field.
       */
      isError?: boolean;
    };

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
  { type: 'approve'; scope?: ToolApprovalScope } | { type: 'reject'; message?: string };

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

  /**
   * GS2-16 — reset the per-run analytics accumulator so the NEXT turn's token/tool totals start
   * from zero. Called by {@link GthAgentRunner} at each turn boundary (the runner is reused across
   * turns in interactive sessions). Optional: agents that don't collect stats simply omit it.
   */
  resetRunStats?(): void;

  /**
   * GS2-16 — the analytics harvested from the run(s) since the last {@link resetRunStats}. Used by
   * the runner to thread token/tool data into the opt-in history recorder. Optional; when absent
   * the runner records no analytics for that turn. Reading must never throw.
   */
  getRunStats?(): GthRunStats;

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

/**
 * EXT-32 — one connected MCP server's discovery `instructions` string (from its MCP `initialize`
 * handshake), paired with the server name it came from. Captured once during tool resolution and
 * reused: injected (fenced + per-server-labelled) into the composed system prompt, and available
 * for [[TUI-C20]]'s MCP debug tab to render the same captured text. Only servers that actually
 * supplied non-empty instructions appear here.
 */
export interface McpServerInstruction {
  /** The configured MCP server name (the key under `config.mcpServers`). */
  server: string;
  /** The server-provided instructions text (trimmed, non-empty). */
  instructions: string;
}

/**
 * A per-server MCP connection failure captured during the most recent {@link ToolsResolver} call.
 * Recorded when a configured MCP server can't be reached (connection/handshake/auth error), so the
 * failure — otherwise a transient `displayWarning` that scrolls away the moment the Ink TUI takes
 * over the screen — can be re-surfaced persistently in the chrome AND named in the /debug MCP tab
 * (which renders per configured server and would otherwise show only a bare "no tools" line, with
 * no hint that the server never connected). Mirrors {@link McpServerInstruction}.
 */
export interface McpConnectionFailure {
  /** The configured MCP server name (the key under `config.mcpServers`). */
  server: string;
  /** A concise, human-readable reason (the underlying connection error's message). */
  reason: string;
}

export interface AgentResolvers {
  resolveTools?: ToolsResolver;
  cleanupTools?: ToolsCleanup;
  resolveMiddleware?: MiddlewareResolver;
  cleanupMiddleware?: MiddlewareCleanup;
  /**
   * EXT-32 — the per-server MCP discovery instructions captured during the most recent
   * {@link ToolsResolver} call (empty when no MCP servers are configured or none supplied
   * instructions). Optional: resolvers without MCP support simply omit it, and the prompt
   * composition treats an absent accessor as "no instructions" (no MCP section is emitted).
   */
  getMcpServerInstructions?(): McpServerInstruction[];
  /**
   * The per-server MCP connection failures captured during the most recent {@link ToolsResolver}
   * call (empty when every configured server connected, or none is configured). Optional: resolvers
   * without MCP support omit it, and callers treat an absent accessor as "no failures". Read by the
   * TUI to surface a persistent notice and to annotate the /debug MCP tab.
   */
  getMcpConnectionFailures?(): McpConnectionFailure[];
}
