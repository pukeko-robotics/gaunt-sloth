import {
  applyRungAwareToolDescriptions,
  GthConfig,
  ServerTool,
  type ApprovalRung,
  type DescribableTool,
} from '#src/config.js';
import {
  AgentResolvers,
  AgentStreamEvent,
  GthAgentInitOptions,
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
import type { GthOutputHeaderRung } from '#src/config/schema.js';
import type { DeclaredToolAnnotations } from '#src/core/approvals/annotations.js';
import { collectDeclaredMcpToolAnnotations } from '#src/core/approvals/toolAnnotationSources.js';
import type { DebugCapture, DebugRequestExtras, LastModelRequest } from '#src/core/debugCapture.js';
import { modelProviderLabel } from '#src/core/modelLabel.js';
import { createPlainToolIndication } from '#src/core/plainToolIndication.js';
import { runHeaderLine } from '#src/core/runHeader.js';
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
import { detectRefusal, buildRefusalMessage, type RefusalInfo } from '#src/core/refusal.js';
import {
  answerTextOf,
  segmentAssistantContent,
  stripReasoningBlocks,
  type ThinkSegment,
} from '#src/core/reasoningBlocks.js';

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
 * Pick this chunk's or message's reasoning delta/content.
 * Precedence:
 *  1. `additional_kwargs.reasoning_content` — standard DeepSeek/Anthropic/OpenRouter convention.
 *  2. `additional_kwargs.reasoning` — direct reasoning fallback if present.
 */
function pickReasoningDelta(kwargs: Record<string, unknown> | undefined): string {
  if (!kwargs) return '';
  const reasoningContent = kwargs.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
    return reasoningContent;
  }
  const direct = kwargs.reasoning;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  return '';
}

/**
 * [[TUI-C69]] §5.4 — **the tool-call ids a suspended graph's pending requests were built from.**
 *
 * LangChain's HITL middleware assembles its `actionRequests` from the last AI message's
 * `tool_calls`, keeping `{ name, args, description }` and dropping the id — so a decision about a
 * pending call has nothing to attribute it to on screen. The ids are still right there: the same
 * `getState` snapshot that carries `tasks[].interrupts` carries `values.messages`, whose last
 * `AIMessage` holds the very calls the middleware filtered. Measured against a real suspended
 * graph rather than reasoned from the library's source, because a middleware hook that ran inside
 * the model node instead of after it would leave this empty.
 *
 * Returns them in message order, for {@link claimToolCallId} to consume. Defensive throughout: an
 * unexpected shape yields an empty list, and every id is then simply absent.
 */
function pendingToolCallIds(
  state: unknown
): { name: string; args: string; id: string; claimed: boolean }[] {
  const messages = (state as { values?: { messages?: unknown } })?.values?.messages;
  if (!Array.isArray(messages)) return [];
  // The LAST message carrying tool calls is the one the interrupt suspended on. Earlier AI
  // messages in the thread carry calls that already ran, and their ids must never be claimed.
  for (let index = messages.length - 1; index >= 0; index--) {
    const toolCalls = (messages[index] as { tool_calls?: unknown })?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const claimable: { name: string; args: string; id: string; claimed: boolean }[] = [];
    for (const call of toolCalls) {
      const name = (call as { name?: unknown })?.name;
      const id = (call as { id?: unknown })?.id;
      if (typeof name !== 'string' || typeof id !== 'string' || id.length === 0) continue;
      claimable.push({
        name,
        args: stableArgs((call as { args?: unknown })?.args),
        id,
        claimed: false,
      });
    }
    return claimable;
  }
  return [];
}

/**
 * Match one pending action request back to its tool call and take that call's id.
 *
 * Name AND arguments, then FIRST unclaimed — which is exact rather than a correlation, because the
 * request was built from that very object. The claim flag is what keeps two identical calls in one
 * message (a model proposing the same command twice) from both taking the first id.
 */
function claimToolCallId(
  candidates: { name: string; args: string; id: string; claimed: boolean }[],
  name: string,
  args: Record<string, unknown>
): string | undefined {
  const wanted = stableArgs(args);
  const match = candidates.find((c) => !c.claimed && c.name === name && c.args === wanted);
  if (!match) return undefined;
  match.claimed = true;
  return match.id;
}

/**
 * A tool call's arguments as one comparable string, with the keys sorted so two objects that
 * differ only in insertion order still match. Fail-soft: an unserialisable argument (a BigInt, a
 * cycle) yields a token that matches nothing, so the id is simply not attributed.
 */
function stableArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '{}';
  try {
    const entries = Object.entries(args as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return JSON.stringify(entries);
  } catch {
    return '<unserialisable>';
  }
}

/**
 * Shared, graph-agnostic agent plumbing.
 *
 * A backend differs from another only in how it builds the compiled LangGraph in {@link init} —
 * today that is the lean {@link GthLangChainAgent} (`createAgent`, in core); everything downstream — invoking,
 * streaming to the console, emitting typed {@link AgentStreamEvent}s, client-tool
 * `interrupt()` stubbing, suspend/resume, and cleanup — is identical and lives here.
 *
 * The base operates solely on the structural {@link GthCompiledGraph} surface, so it does NOT
 * import a graph builder. Subclasses construct the graph and assign it to {@link agent} in their
 * `init()`.
 */
export abstract class GthAbstractAgent implements GthAgentInterface {
  protected statusUpdate: StatusUpdateCallback;
  protected resolvers: AgentResolvers | undefined;
  protected agent: GthCompiledGraph | null = null;
  protected config: GthConfig | null = null;
  protected command: GthCommand | undefined = undefined;

  /**
   * GS2-95 — the name of the command the USER typed, as the run header should say it. Set from
   * {@link GthAgentInitOptions#displayCommand} by the backend's `init`, and read by exactly one
   * thing: {@link compactHeaderStatus}.
   *
   * Separate from {@link command} because that field is not a label — it selects the mode prompt,
   * the approvals posture and the command-specific filesystem config. Naming the header off it is
   * why `gth eval` used to open with `ask`, and moving it to fix the header would silently change
   * which system prompt those runs execute under. Left `undefined` by every command whose init verb
   * IS its name, which is most of them.
   */
  protected displayCommand: string | undefined = undefined;

  /**
   * Opt-in debug sink for the TUI `/debug` panel. Set AFTER {@link init} via
   * `runner.getAgent()`; read lazily inside each backend's `wrapModelCall` capture middleware
   * so that when it is `undefined` (the normal path) the middleware is a transparent
   * pass-through. Lives on the base so every backend supports it; the AG-UI server / non-TUI
   * callers simply never set it, so those contracts are unchanged.
   */
  public debugCapture: DebugCapture | undefined;

  /**
   * GS2-56 — the ALWAYS-ON snapshot of the most recent model request (extras + the as-sent,
   * post-summarization messages), populated UNCONDITIONALLY at each backend's `wrapModelCall` feed
   * site — NOT gated on {@link debugCapture} being attached. This is what lets `/debug-dump` render
   * the full model input even when the TUI `/debug` panel was never opened and on non-TUI surfaces
   * (the sink only ever fed the live `/debug` panel). O(1): a single overwritten reference retaining
   * only the LAST call — no accumulation, so the "pay nothing until you need it" intent is kept.
   */
  public lastModelRequest: LastModelRequest | undefined;

  /**
   * GS2-56 — stash the last model request (the as-sent messages + {@link DebugRequestExtras}).
   * Called unconditionally from each backend's capture middleware, independent of the debug sink,
   * so the snapshot is available to `/debug-dump` on every surface. Overwrites (retains only the
   * most recent call). Callers already guard the invocation; kept trivial so it can never throw.
   */
  protected setLastModelRequest(messages: BaseMessage[], extras?: DebugRequestExtras): void {
    this.lastModelRequest = { messages, extras };
  }

  /**
   * GS2-16 — per-run analytics tally (token usage + invoked tool names) folded from the messages
   * flowing through {@link invoke} / the streaming paths. Reset at each turn boundary via
   * {@link resetRunStats} (the runner is reused across turns), read via {@link getRunStats}, and
   * fully fail-soft (accumulation is guarded and never throws into a run).
   */
  private runStatsAcc: RunStatsAccumulator = createRunStatsAccumulator();

  /**
   * EXT-58 — the names of the tools registered with the graph at the last {@link init}, recorded by
   * {@link registerApprovalsAwareTools}. Read by `GthAgentRunner` to build the rater's
   * granted-built-in list (§4.4), so a suggestion can only ever name a tool the model actually has.
   */
  private registeredToolNames: string[] = [];

  /**
   * EXT-70 §4.7.1 — what the connected MCP servers DECLARED about their own tools, captured from
   * the same registration hook as {@link registeredToolNames} and keyed by the registered tool
   * name. Read by `GthAgentRunner` as the `mcp` half of a `DeclaredToolAnnotationLookup`.
   *
   * It is a record of claims, never of decisions: no trust is applied here (that is
   * `createEffectiveToolAnnotationSource`'s only job), and an absent tool yields the fail-closed
   * defaults rather than "declared nothing".
   */
  private declaredMcpToolAnnotations: ReadonlyMap<string, DeclaredToolAnnotations> = new Map();

  constructor(statusUpdate: StatusUpdateCallback, resolvers?: AgentResolvers) {
    this.statusUpdate = (level: StatusLevel, message: string) => {
      statusUpdate(level, message);
    };
    this.resolvers = resolvers;
  }

  /**
   * GS2-101 — the run-header rung in force. An unset `output.header` resolves to `compact`: a run
   * that was never configured opens with one attribution line and nothing else, and the technical
   * preamble is opt-in via `output.header: 'debug'`.
   *
   * Defaulted HERE rather than in `DEFAULT_CONFIG` (the convention `injectModelContext` and
   * `debugDump.redact` also follow) so the effective-config snapshot `gth config` prints does not
   * grow a key nobody set.
   */
  protected get headerRung(): GthOutputHeaderRung {
    return this.config?.output?.header ?? 'compact';
  }

  /**
   * GS2-93 — emit one line of the technical run-header preamble (the Workdir/Model/Tools/Middleware
   * block). Only the `debug` rung shows it; `compact` replaces the whole block with
   * {@link compactHeaderStatus}'s single line and `none` shows nothing. A non-`debug` rung only ever
   * reaches here in non-TUI text modes: the interactive TUI forces `debug` before init (see
   * `createTuiSession`), and the TUI event path never goes through the interrupt-hint site, so the
   * whole preamble stays visible there. Only INFO header lines route through this — real model/tool
   * output, warnings and errors keep using {@link statusUpdate} directly.
   */
  protected headerStatus(message: string): void {
    if (this.headerRung !== 'debug') return;
    this.statusUpdate(StatusLevel.INFO, message);
  }

  /**
   * GS2-93 — the `compact` rung's whole output: one line naming the command and the model that
   * served it, in place of the preamble. Called once from the backend's `init`, after the command
   * and effective config are in place. The string is {@link runHeaderLine}'s, shared with the review
   * document's opening line so the two writers cannot drift.
   *
   * **This renders; it does not decide.** The word after the product name is
   * {@link displayCommand} when the command supplied one and the init verb otherwise — GS2-93
   * forbids a label table inside the agent, because naming a user-facing line is the command's call,
   * not the runtime's.
   *
   * Two runs deliberately emit nothing here:
   *
   * - **`review` and `pr`** already open with `reviewHeadingBlock`, which renders this same line.
   *   Emitting here as well would print the header twice on one screen.
   * - **A run with no name at all** — the `pr` command's discovery sub-agent is the one such
   *   caller, and it runs inside a `pr` whose header is already on screen. The name is what this
   *   line is for, so with none there is nothing to say; inventing a word for it would be naming a
   *   user-facing surface from inside the agent.
   *
   * The model half is the shared {@link modelProviderLabel} spelling (DL-6), and it is dropped
   * rather than faked when nothing resolves (DL-7), leaving the command on its own.
   */
  protected compactHeaderStatus(): void {
    if (this.headerRung !== 'compact') return;
    const command = this.displayCommand ?? this.command;
    if (!command || command === 'review' || command === 'pr') return;
    const label = modelProviderLabel(this.config?.modelDisplayName, this.config?.modelProviderType);
    this.statusUpdate(StatusLevel.INFO, runHeaderLine(command, label));
  }

  /**
   * EXT-58 (spec §4.5) — the ONE tool-registration hook both backends call with their final tool
   * array, just before handing it to the graph builder. It does two things:
   *
   * 1. Appends the rung's approval sentence to every tool that is **not** auto-approved at that
   *    rung, and leaves every granted tool's description untouched (the absence of the sentence is
   *    what marks a tool free). See {@link applyRungAwareToolDescriptions}.
   * 2. Records the registered tool names for {@link getRegisteredToolNames}, which feeds the
   *    rater's granted-alternative list (§4.4).
   * 3. EXT-70 §4.7.1 — records what the MCP servers declared about their own tools, for
   *    {@link getDeclaredMcpToolAnnotations}. This is the ONE place a `tools/list` annotation
   *    enters the approvals stack, and it enters as a claim: nothing here decides whether it is
   *    believed.
   *
   * `gatedTools` MUST be the **LIVE gated set for the rung in force** — `resolveGatedToolNames` for
   * that rung — and NOT the set the caller wires into the approval interrupt. The two are different
   * on purpose: the interrupt is installed once, at agent init, and is deliberately
   * rung-independent (`resolveInterruptToolNames`, the union over every rung) so that
   * `/approvals <mode>` can move the mode underneath it for the rest of the session. Passing that
   * wider set here would describe tools as needing approval that the live mode does not gate — and
   * a call the live mode does not gate is auto-approved the moment it reaches the runner, so the
   * sentence would be a promise nothing keeps.
   *
   * What keeps a description from promising an approval the gate will not ask for is therefore that
   * both this and `GthAgentRunner`'s own check are projections of the SAME rule,
   * `isToolGatedAtRung`, evaluated against the SAME live mode — §4.5's "a description that disagrees
   * with what the gate will actually do is worse than no description at all".
   *
   * `additionalToolNames` covers tools the graph builder registers itself and that therefore never
   * appear in `tools`. Their descriptions are not ours to write, so they cannot be suffixed here;
   * they are recorded only so the rater's suggestion list reflects what the model actually has.
   */
  protected registerApprovalsAwareTools<T extends DescribableTool>(
    tools: T[],
    options: {
      rung: ApprovalRung;
      gatedTools: readonly string[];
      additionalToolNames?: readonly string[];
    }
  ): T[] {
    applyRungAwareToolDescriptions(tools, {
      rung: options.rung,
      gatedTools: options.gatedTools,
    });
    const names = tools
      .map((tool) => tool?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    this.registeredToolNames = [...names, ...(options.additionalToolNames ?? [])];
    // `additionalToolNames` are deliberately NOT consulted: they are names the graph builder
    // registers itself, with no tool object and therefore no declaration to read.
    this.declaredMcpToolAnnotations = collectDeclaredMcpToolAnnotations(tools);
    return tools;
  }

  /**
   * EXT-58 — the tool names registered with the graph at the last {@link init} (empty before it).
   * The runner intersects these with the built-in summaries table to build the rater's
   * granted-alternative list, so the rater can never name a tool this session does not have.
   */
  getRegisteredToolNames(): string[] {
    return [...this.registeredToolNames];
  }

  /**
   * EXT-70 §4.7.1 — what the MCP servers declared for their tools at the last {@link init}, keyed
   * by registered tool name (empty before it, and on a session with no MCP servers).
   */
  getDeclaredMcpToolAnnotations(): ReadonlyMap<string, DeclaredToolAnnotations> {
    return this.declaredMcpToolAnnotations;
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
   * Build the underlying compiled graph and assign it to {@link agent}. This is the part a
   * backend implements; everything else on the base is shared.
   */
  abstract init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined,
    options?: GthAgentInitOptions
  ): Promise<void>;

  /**
   * EXT-37 — surface a detected content-policy refusal: emit the clear, user-facing explanation at
   * WARNING level (an empty-content refusal streams nothing, so without this the console shows
   * nothing) and return the same message so it becomes the turn's terminal answer. Shared by the
   * non-streaming {@link invoke} and streaming {@link streamFromInput} paths so both render a
   * refusal identically. A refusal is a *successful* (if declined) response — never a retry.
   */
  protected surfaceRefusal(info: RefusalInfo): string {
    const message = buildRefusalMessage(info);
    debugLog(`Content-policy refusal detected (provider=${info.provider} reason=${info.reason})`);
    this.statusUpdate(StatusLevel.WARNING, message);
    return message;
  }

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
        // TUI-C32 residual f — the streaming path renders the compact per-tool indication via
        // streamFromInput's observer; the non-streaming invoke path (`streamOutput: false`) had
        // none, so a plain-surface tool call surfaced nothing after the legacy fs notices were
        // dropped (residual b). Feed THIS turn's new messages through the SAME observer so each
        // tool call gets its `✓ 📁 name(args…)` block here too. Only the plain surface reaches
        // invoke (the TUI uses processMessagesWithEvents); observe() is fail-soft internally.
        const allMessages = Array.isArray(response.messages) ? response.messages : [];
        const toolIndication = createPlainToolIndication(undefined, (id) =>
          this.raterClarifications.has(id)
        );
        for (const m of allMessages.slice(priorMessageCount)) {
          this.recordRunStats(m);
          toolIndication.observe(m);
        }
        const finalMessage = response.messages[response.messages.length - 1];

        // EXT-37: content-policy refusal. A successful response whose stop/finish reason is a
        // refusal (OpenAI content_filter / Anthropic stop_reason=refusal / Bedrock
        // guardrail_intervened) is terminal-but-clear: surface the model's explanation and RETURN
        // it as the answer. It must NOT flow into the empty-response retry (a refusal is
        // deterministic — retrying just burns a paid call). Returning a non-empty message means the
        // caller writes it to the output file and exits ok, rather than re-wrapping a *successful*
        // (if declined) response as "Failed to get answer". A fallback-model attempt would hang
        // here (see the extension point in GthAgentRunner.processMessages), but no runtime
        // fallback-model config exists today, so we surface terminally.
        const refusal = detectRefusal(finalMessage);
        if (refusal) {
          return this.surfaceRefusal(refusal);
        }

        // CFG-33: Gemini's thought summaries ride inside `content` as `thought: true` text blocks,
        // which renderAssistantContent would print as part of the answer (and write to the output
        // file). The plain surface has never shown reasoning — every other provider's arrives
        // out-of-band in additional_kwargs — so drop them for rendering only; graph state keeps the
        // message whole so the thought parts still replay as history.
        const finalContent = stripReasoningBlocks(finalMessage?.content);
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
    // EXT-37: bound so the stream `start()` closure can surface a detected refusal (WARNING +
    // returns the message to enqueue) without a `this` reference.
    const surfaceRefusal = (info: RefusalInfo) => this.surfaceRefusal(info);
    // TUI-C30 — compact per-tool-call indication for the plain surface (`name(args…)` + the
    // canonical 10-line greyed preview when each ToolMessage lands). Per-stream state; emits at
    // INFO level so the existing consoleLevel gate governs it like the historical tool notices.
    // The TUI never runs this string path (it renders the typed event stream itself).
    //
    // [[TUI-C69]] §5.4 — the plain surface's twin of the typed event's `raterClarification`, read
    // through a closure rather than handed a snapshot: the set is filled WHILE this stream is
    // drained, because the runner notes the id at the moment it refuses the call, which is after
    // this observer was built and before the refusal's own result arrives.
    const raterClarifications = this.raterClarifications;
    const toolIndication = createPlainToolIndication(undefined, (id) =>
      raterClarifications.has(id)
    );
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
      // GS2-93: the interrupt hint is part of the run-header preamble, so only the `debug` rung
      // prints it. The Esc/Q handler stays armed at every rung — the hint box is what goes, not the
      // interrupt. This site only runs in the non-TUI text path (`streamFromInput`); the TUI event
      // path never reaches it.
      this.headerRung === 'debug'
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
          // EXT-37: a content-policy refusal's stop/finish reason rides on a chunk's
          // response_metadata (usually with empty content). Capture it here and surface it AFTER
          // the stream drains, so the returned text is non-empty and the run loop treats it as
          // terminal-but-clear instead of routing an empty streamed turn into the retry.
          let refusalInfo: RefusalInfo | null = null;
          // EXT-41: belt-and-suspenders — also concat the AI chunks so a refusal can be read off
          // the FINAL aggregated message's stop/finish reason, not only a per-chunk one. Some
          // providers surface the reason only on the assembled message (or split it across chunks
          // that concat into it); without this fallback such a refusal would be swallowed by the
          // empty-response retry, making the EXT-37 surfacing cosmetic on the DEFAULT streaming
          // surface. Reset at each tool round (below) so a prior round's reason can't concatenate
          // with the final turn's (mirrors processEventStream's per-round reset).
          let aggregatedChunk: AIMessageChunk | null = null;

          for await (const [chunk, _metadata] of stream) {
            debugLogObject('Stream chunk', { chunk, _metadata });
            // GS2-16: fold every chunk (AIMessageChunk usage/tool_calls, ToolMessage name) into
            // the run tally before the text-only handling below.
            recordRunStats(chunk);
            // EXT-37: first refusal signal wins; keep scanning chunks for text/binary as normal.
            if (!refusalInfo) {
              refusalInfo = detectRefusal(chunk);
            }
            // EXT-41: fold AI chunks into an aggregate for the aggregate-level refusal fallback,
            // resetting at tool-round boundaries so a prior round's stop/finish reason can't bleed
            // into the final turn's aggregate.
            if (AIMessageChunk.isInstance(chunk)) {
              aggregatedChunk = aggregatedChunk ? aggregatedChunk.concat(chunk) : chunk;
            } else if (chunk instanceof ToolMessage) {
              aggregatedChunk = null;
            }
            // TUI-C30: fold the chunk into the plain-surface tool indication (renders each
            // completed call when its ToolMessage arrives; a no-op for plain text chunks).
            toolIndication.observe(chunk);
            if (AIMessage.isInstance(chunk)) {
              // CFG-33: the ANSWER text only. `.text` folds Gemini's `thought: true` blocks into the
              // answer, which would print the model's thinking inline here and in the output file.
              const text = answerTextOf(chunk.content);
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
          // EXT-41: aggregate-level fallback — if no per-chunk metadata flagged a refusal, inspect
          // the FINAL aggregated message's stop/finish reason. Catches providers that expose the
          // reason only on the assembled message (or split across chunks that concat into it).
          if (!refusalInfo && aggregatedChunk) {
            refusalInfo = detectRefusal(aggregatedChunk);
          }
          // EXT-37: surface a captured refusal as the terminal answer. Enqueue the clear message
          // (so the drained result is non-empty and bypasses the empty-response retry) and print it
          // once at WARNING level (surfaceRefusal). Any partial content already streamed is kept;
          // the refusal notice follows it, and its explanation carries any model-provided text.
          if (refusalInfo) {
            controller.enqueue(surfaceRefusal(refusalInfo));
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
    // [[TUI-C69]] — the ids the action requests were built from, ready to be claimed in order.
    const unclaimedIds = pendingToolCallIds(state);
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
          const resolvedArgs =
            args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
          const id = claimToolCallId(unclaimedIds, name, resolvedArgs);
          pending.push({
            name,
            args: resolvedArgs,
            ...(id === undefined ? {} : { id }),
          });
        }
      }
    }
    return pending;
  }

  /**
   * [[TUI-C69]] §5.4 — remember that this call was bounced back to the agent as a negotiation
   * round, so both display paths can tone its result row as a clarification request.
   *
   * A plain set rather than a queue: the ids are LangChain tool-call ids, unique per call, and the
   * two display paths read the same one without either consuming it — a session drives one of them,
   * never both. It is emptied with the rest of the turn's state, so a long run cannot accumulate.
   */
  noteRaterClarification(toolCallId: string): void {
    if (toolCallId) this.raterClarifications.add(toolCallId);
  }

  /** [[TUI-C69]] — the ids {@link noteRaterClarification} has been told about this session. */
  protected raterClarifications = new Set<string>();

  protected async *processEventStream(
    stream: IterableReadableStream<[BaseMessage, Record<string, unknown>]>
  ): AsyncGenerator<AgentStreamEvent> {
    // Aggregate AIMessageChunks via concat so tool_call_chunks collapse into
    // tool_calls with complete args (per-chunk tool_calls only ever sees that
    // chunk's slice of the args JSON, which is rarely valid on its own).
    let aggregatedAIChunk: AIMessageChunk | null = null;
    let reasoningOpen = false;
    const flushed = new Set<string>();
    // EXT-41: a content-policy refusal on this typed-event path was de-scoped by EXT-37 (there is
    // no empty-response retry here, so no wrong-retry bug), but it still rendered as a SILENT empty
    // turn. Capture it (first per-chunk signal wins; aggregate fallback at stream end) and surface
    // it as a `text` event so every consumer (Ink TUI viewModel, AG-UI SSE) shows a clear notice.
    let refusalInfo: RefusalInfo | null = null;
    const seenBinaryKeys = new Set<string>();
    const binaryBlocks: Array<{ mimeType: string; data: string }> = [];
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

    // CFG-33 — emit a message's content segments in order. A segment already classified as the
    // model's thinking (a Gemini `thought: true` block) goes straight to the reasoning channel;
    // answer text still passes through the TUI-C22 think splitter, so an inline `<think>` tag is
    // peeled exactly as before. With no reasoning block this is the previous `.text` behaviour.
    function* emitContentSegments(segments: ThinkSegment[]): Generator<AgentStreamEvent> {
      for (const segment of segments) {
        if (segment.kind === 'reasoning') {
          yield* emitSegments([segment]);
        } else {
          yield* emitSegments(thinkSplitter.push(segment.text));
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

      // EXT-41: reuse EXT-37's detector (do NOT fork a second one). First per-chunk signal wins;
      // a ToolMessage / normal chunk yields null, so a normal turn never surfaces a false refusal.
      if (!refusalInfo) {
        refusalInfo = detectRefusal(chunk);
      }

      if (
        this.config?.writeBinaryOutputsToFile &&
        (AIMessageChunk.isInstance(chunk) || AIMessage.isInstance(chunk))
      ) {
        for (const block of extractInlineBinaryBlocks(chunk.content)) {
          const binaryKey = `${block.mimeType}:${block.data.length}:${block.data}`;
          if (!seenBinaryKeys.has(binaryKey)) {
            seenBinaryKeys.add(binaryKey);
            binaryBlocks.push({ mimeType: block.mimeType, data: block.data });
          }
        }
      }

      if (AIMessageChunk.isInstance(chunk)) {
        aggregatedAIChunk = aggregatedAIChunk ? aggregatedAIChunk.concat(chunk) : chunk;

        // Reasoning deltas — Ollama (Qwen3, deepseek-r1), Anthropic, and OpenRouter surface
        // thinking in additional_kwargs.reasoning_content. Stream
        // it as a separate event series so clients can render it apart from the answer.
        const reasoningDelta = pickReasoningDelta(chunk.additional_kwargs);
        if (reasoningDelta.length > 0) {
          yield* emitSegments([{ kind: 'reasoning', text: reasoningDelta }]);
        }

        // Yield text incrementally — use this chunk's text (delta), not the aggregated content
        // which is cumulative. TUI-C22 routes it through the think splitter so inline
        // <think>...</think> (buffered across chunks) is peeled into the reasoning channel and
        // stripped from the answer; text with no think tags passes straight through unchanged.
        // CFG-33 classifies the chunk's content blocks first, in order, so Gemini's `thought: true`
        // blocks reach the reasoning channel instead of the answer; answer text still goes through
        // the think splitter, thought text does not (it is already classified).
        yield* emitContentSegments(segmentAssistantContent(chunk.content));
      } else if (AIMessage.isInstance(chunk)) {
        // Reasoning on a non-chunk AIMessage — a non-streamed / resumed thinking message
        // (e.g. a checkpoint replay) still carries its thinking in
        // additional_kwargs.reasoning_content. Mirror the AIMessageChunk branch and emit the same
        // reasoning event series, otherwise the thought is silently dropped (TUI-C15).
        const reasoningContent = pickReasoningDelta(chunk.additional_kwargs);
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
        yield* emitContentSegments(segmentAssistantContent(chunk.content));
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
        // [[TUI-C69]] §5.4 — the gate's own account of WHY this result is an error, when it was
        // the auto-rater asking for a clarification rather than a tool that failed. Additive:
        // `isError` still says the call did not run, which is what the model, `gth eval`'s
        // tool-result assertions and the ACP bridge all read.
        const toolCallId = chunk.tool_call_id as string;
        yield {
          type: 'tool_result',
          id: toolCallId,
          content,
          ...(chunk.status === 'error' ? { isError: true } : {}),
          ...(this.raterClarifications.has(toolCallId) ? { raterClarification: true } : {}),
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

    if (this.config?.writeBinaryOutputsToFile && binaryBlocks.length > 0) {
      const processedContent = materializeBinaryOutputs(
        binaryBlocks.map((block) => ({
          type: 'inlineData',
          inlineData: block,
        })),
        this.command
      );
      for (const successMessage of processedContent.successMessages) {
        this.statusUpdate(StatusLevel.SUCCESS, successMessage);
      }
      if (processedContent.renderedContent.trim().length > 0) {
        yield { type: 'text', delta: '\n' + processedContent.renderedContent + '\n' };
      }
    }

    // EXT-41: aggregate-level fallback (I-1's robustness on this path too) — if no per-chunk
    // metadata flagged a refusal, inspect the final aggregated message's stop/finish reason. Then
    // surface any refusal as a `text` event so the user sees a clear notice instead of a silent
    // empty turn. No statusUpdate here: consumers render the typed events, and a WARNING would
    // double-render in the TUI.
    if (!refusalInfo && aggregatedAIChunk) {
      refusalInfo = detectRefusal(aggregatedAIChunk);
    }
    if (refusalInfo) {
      debugLog(
        `Content-policy refusal detected on typed-event path (provider=${refusalInfo.provider} reason=${refusalInfo.reason})`
      );
      yield { type: 'text', delta: buildRefusalMessage(refusalInfo) };
    }
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
