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
  GthAdvertisedTools,
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
import { resolveToolResultCaptureMaxBytes } from '#src/config/toolResultCapture.js';
import {
  accumulateMessage,
  accumulatePromotedToolCalls,
  createRunStatsAccumulator,
  finalizeRunStats,
  type RunStatsAccumulator,
} from '#src/core/runStats.js';
import { ConfigDiscoveryError } from '#src/config/configDiscovery.js';
import type { GthOutputHeaderRung } from '#src/config/schema.js';
import type { DeclaredToolAnnotations } from '#src/core/approvals/annotations.js';
import { collectDeclaredMcpToolAnnotations } from '#src/core/approvals/toolAnnotationSources.js';
import {
  NO_MCP_TOOL_BINDINGS,
  restrictMcpToolBindings,
  type McpToolBindings,
} from '#src/core/approvals/mcpSubjects.js';
import type { DebugCapture, DebugRequestExtras, LastModelRequest } from '#src/core/debugCapture.js';
import { modelProviderLabel } from '#src/core/modelLabel.js';
import { providerErrorNotice } from '#src/core/providerErrorNotice.js';
import { replaceGraphMessages } from '#src/core/compaction.js';
import type { AutocompactController } from '#src/core/compactionThreshold.js';
import {
  createPlainToolIndication,
  type PlainToolIndicationObserver,
} from '#src/core/plainToolIndication.js';
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
import {
  classifyRefusal,
  detectRefusal,
  detectStopMetadata,
  buildRefusalMessage,
  readStopReasonToken,
  type RefusalInfo,
} from '#src/core/refusal.js';
import {
  isMiddlewareHookNode,
  streamNodeOf,
  TurnMessageReasons,
} from '#src/core/modelMessageFold.js';
import {
  terminationReason,
  type GthFinishReasonObservation,
  type GthTerminationReason,
  type GthTerminationSite,
} from '#src/core/terminationReason.js';
import { terminationLogLine } from '#src/core/terminationNotice.js';
import {
  detectOutstandingWork,
  outstandingWorkLogLine,
  OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE,
  type GthOutstandingWork,
} from '#src/core/outstandingWork.js';
import { buildRunRecapSource, type GthRunRecapSource } from '#src/core/runRecap.js';
import {
  answerTextOf,
  segmentAssistantContent,
  stripReasoningBlocks,
  type ThinkSegment,
} from '#src/core/reasoningBlocks.js';

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/**
 * [[EXT-159]] — how many per-message `finish_reason` observations one turn keeps.
 *
 * An agentic turn produces one per model round and the list is held for the life of the turn, so it
 * is bounded rather than trusted to stay small. The cap drops the TAIL rather than the head: the
 * observations that explain how a turn ENDED are the last ones, but a turn that has already made a
 * thousand model rounds has a different problem, and keeping the head keeps the record of how it
 * got there. Every observation reaches the debug log either way, so nothing is lost outright.
 */
const FINISH_REASON_OBSERVATION_MAX = 1000;

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
 *
 * **The arguments are half the match, and only one arrangement can show it.** Two calls of one name
 * with the SAME arguments come back correctly under a name-only match too, because the claim flag
 * alone puts them in order — so the case that discriminates is two calls of one name with DIFFERENT
 * arguments whose requests arrive in the opposite order to the `tool_calls` they were built from.
 * There, name-only gives every request an id and attaches each to the wrong command.
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
 * today that is the lean {@link @gaunt-sloth/core!core/GthLangChainAgent.GthLangChainAgent | GthLangChainAgent} (`createAgent`, in core); everything downstream — invoking,
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
   * EXT-161 — the preventive compaction threshold in force, and the session's ability to move it.
   *
   * Set by the backend's `init` once the model is resolved, because the threshold is derived from
   * that model's context window. It is the SAME object the context guard reads before every model
   * call, so `/status` cannot advertise a threshold the guard is not enforcing and `/autocompact`
   * cannot set one the guard will not see.
   *
   * Undefined before `init`, and on a surface with no lean graph behind it (the TUI fixture agent),
   * where `/autocompact` and `/status` say the threshold is unavailable rather than inventing one.
   */
  public autocompact: AutocompactController | undefined;

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
   * [[EXT-159]] — why the current turn ended, set by whichever site inside this agent ended it.
   * Reset at each turn boundary by {@link resetTerminationReason}, read by `GthAgentRunner`.
   */
  private terminationReason: GthTerminationReason | null = null;

  /**
   * [[EXT-159]] — what the provider said about why each finished model message stopped, this turn.
   *
   * Reset with {@link terminationReason} at each turn boundary and read by `GthAgentRunner` for the
   * debug dump. Bounded, because a long agentic turn produces one entry per model round and this
   * has to be safe to keep for the whole session.
   */
  private finishReasonObservations: GthFinishReasonObservation[] = [];

  /**
   * [[EXT-158]] — the checklist state at the end of the current turn, when that turn ended with no
   * tool calls and the newest `gth_checklist` call still carried a non-completed item.
   *
   * Reset with {@link terminationReason} at each turn boundary and read by `GthAgentRunner` and by
   * the AG-UI server, which drives this agent with no runner at all.
   */
  private outstandingWork: GthOutstandingWork | null = null;

  /**
   * [[EXT-178]] — the bounded inputs an end-of-run recap would be built from, snapshotted when the
   * turn ended.
   *
   * **A snapshot rather than a live read, because the surface that needs it most asks too late.**
   * `runSingleShot` reads the end-of-run facts after `runner.cleanup()` has dropped the agent, so a
   * recap that fetched `state.messages` at render time would find nothing on exactly the
   * non-interactive verbs the node names. It is also what keeps the recap's input deterministic and
   * bounded: the same window every time, decided once, testable as a pure function.
   *
   * Turn-lived like {@link outstandingWork} and reset with it — turn N's transcript must never
   * become turn N+1's recap.
   */
  private runRecapSource: GthRunRecapSource | null = null;

  /**
   * [[EXT-158]] — the stall episode currently in progress: the structural signature of the
   * checklist state, and how many times it has been announced.
   *
   * Session-lived rather than turn-lived, and that is the whole mechanism: a stuck model re-emits
   * an identical checklist turn after turn, and only a value that outlives the turn can tell that
   * apart from progress. Deliberately NOT cleared by {@link resetOutstandingWork}, which runs at
   * every turn boundary and would therefore make every repeat look new.
   *
   * **A COUNT rather than a seen-before flag, so the named budget means what it says.** A flag
   * would make the constant a two-state switch — off at zero, on at anything else — and a reviewer
   * raising it from one to two would get no change and no warning. Counting per episode is also
   * [[EXT-36]]'s own definition of progress reused rather than reinvented: a different signature is
   * progress and resets the count, and another identical `gth_checklist` call is not.
   *
   * ONE episode is kept rather than a map of every signature ever seen. A stall is consecutive by
   * construction, and an unbounded map would grow for the whole life of a long session to answer a
   * question only the current state can ask.
   */
  private outstandingEpisode: { signature: string; announced: number } | null = null;

  /**
   * EXT-58 — the names of the tools registered with the graph at the last {@link init}, recorded by
   * {@link registerApprovalsAwareTools} and read back through {@link getRegisteredToolNames}.
   *
   * EXT-173 — it was recorded so `GthAgentRunner` could build the rater's granted-built-in list
   * (§4.4). That mechanism is gone, and with it the only production reader: today this is inspection
   * state on the agent interface, exercised by tests alone. Kept rather than deleted because
   * `getRegisteredToolNames` is declared on {@link GthAgentInterface} and removing it is an API
   * decision this node did not take.
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

  /**
   * EXT-211 — the configured server each loaded MCP tool belongs to (see
   * {@link getMcpToolBindings}). Recorded by {@link recordMcpToolBindings} from the resolver's map,
   * restricted to the tools this init actually resolved.
   */
  private mcpToolBindings: McpToolBindings = NO_MCP_TOOL_BINDINGS;

  /**
   * BATCH-32 — the tool inventory this agent advertised to the model at the last `init`, or
   * `undefined` before one (see {@link getAdvertisedTools}).
   *
   * **{@link resetRunStats} must never clear it.** It is set once at `init` and describes the
   * session, not the turn; a multi-turn eval reads it after several turn boundaries have already
   * gone past.
   */
  private advertisedTools: GthAdvertisedTools | undefined;

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
   * EXT-58 (spec §4.5) — the ONE tool-registration hook every backend calls with its final tool
   * array, just before handing it to the graph builder. It does two things:
   *
   * 1. Appends the rung's approval sentence to every tool that is **not** auto-approved at that
   *    rung, and leaves every granted tool's description untouched (the absence of the sentence is
   *    what marks a tool free). See {@link applyRungAwareToolDescriptions}.
   * 2. Records the registered tool names for {@link getRegisteredToolNames}.
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
   * they are recorded only so {@link getRegisteredToolNames} reports the full set the model
   * actually has. (Before EXT-173 that set fed the rater's §4.4 suggestion list, which is gone.)
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
   *
   * Read-only reporting of what this session actually bound. Nothing in the approvals stack
   * consumes it today: the gate derives its sets from the rung and the bound tools directly.
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
   * EXT-211 — record which configured server each MCP tool in `resolvedTools` belongs to, from the
   * resolver's bindings. Called by a backend with exactly the tools its resolver returned at this
   * init — an empty list when tool loading was skipped — so a binding left over from an earlier
   * resolution, or for a tool this session never loaded, is dropped rather than consulted.
   */
  protected recordMcpToolBindings(resolvedTools: readonly { name?: unknown }[]): void {
    this.mcpToolBindings = restrictMcpToolBindings(
      this.resolvers?.getMcpToolBindings?.(),
      resolvedTools.map((tool) => tool?.name)
    );
  }

  /**
   * EXT-211 — registered MCP tool name → the configured server it was loaded under, for the tools
   * loaded at the last {@link init} (empty before it). The one map every server attribution reads.
   */
  getMcpToolBindings(): McpToolBindings {
    return this.mcpToolBindings;
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
    return finalizeRunStats(
      this.runStatsAcc,
      resolveToolResultCaptureMaxBytes(this.config ?? undefined)
    );
  }

  /**
   * BATCH-32 — record what this agent advertised to the model, for {@link getAdvertisedTools}.
   * Called by a concrete agent at `init`, at the point where BOTH the full loaded list and the
   * post-allow-list one are still in scope. Structural twin of
   * {@link registerApprovalsAwareTools}'s annotation capture: one capture site, at registration.
   */
  protected recordAdvertisedTools(advertised: GthAdvertisedTools): void {
    this.advertisedTools = advertised;
  }

  /**
   * BATCH-32 — the tool inventory advertised at the last `init`, or `undefined` before one.
   *
   * `undefined` (never observed) and an inventory with an empty `tools` (observed, nothing offered)
   * are different answers and both are reportable; see {@link GthAgentInterface.getAdvertisedTools}.
   */
  getAdvertisedTools(): GthAdvertisedTools | undefined {
    return this.advertisedTools;
  }

  /**
   * GS2-16 — fold one message (or chunk) into the run tally. Fully guarded (fail-soft).
   *
   * BATCH-43 — the MCP tool bindings ride along so an errored MCP tool result can be attributed to
   * its server and its own error body recovered beside the observed payload. Read at fold time
   * rather than captured when the accumulator is created: the accumulator is rebuilt at every turn
   * boundary while the bindings are set once at `init`, and a capture would silently record nothing
   * for any turn whose ordering ever changed.
   *
   * BATCH-49 — `toolResultCaptureMaxBytes` rides the same argument, for the same reason: the cap
   * is a config value, and reading it here at fold time means a turn boundary that rebuilds the
   * accumulator cannot lose it. The default is applied at that read
   * ({@link resolveToolResultCaptureMaxBytes}), not stored on the config, so the effective-config
   * snapshot does not grow a key nobody set.
   */
  protected recordRunStats(message: unknown): void {
    accumulateMessage(
      this.runStatsAcc,
      message,
      this.mcpToolBindings,
      resolveToolResultCaptureMaxBytes(this.config ?? undefined)
    );
  }

  /**
   * Record the tool calls of a message the tool-call repair promoted from text, which a streamed
   * run never delivers to {@link recordRunStats}. Fail-soft inside the accumulator.
   */
  protected recordPromotedToolCalls(message: unknown): void {
    accumulatePromotedToolCalls(
      this.runStatsAcc,
      message,
      resolveToolResultCaptureMaxBytes(this.config ?? undefined)
    );
  }

  /**
   * [[EXT-159]] — forget the previous turn's termination reason. Called by `GthAgentRunner` at each
   * turn boundary, for the same reason {@link resetRunStats} is.
   */
  resetTerminationReason(): void {
    this.terminationReason = null;
    this.finishReasonObservations = [];
    this.resetOutstandingWork();
    this.resetRunRecapSource();
  }

  /**
   * [[EXT-158]] — forget the previous turn's outstanding-work fact.
   *
   * Only the FACT. The session's record of what has already been announced survives, because the
   * question it answers — "have we already said this about this same unchanged checklist?" — is
   * about the session and not about the turn.
   */
  resetOutstandingWork(): void {
    this.outstandingWork = null;
  }

  /**
   * [[EXT-178]] — forget the previous turn's recap source.
   *
   * Its own method rather than a line inside {@link resetOutstandingWork}, whose name says what it
   * forgets. Called from {@link resetTerminationReason}, the turn boundary, alongside that one.
   */
  resetRunRecapSource(): void {
    this.runRecapSource = null;
  }

  /**
   * [[EXT-158]] — record whether this turn ended with checklist work outstanding.
   *
   * **Reads the graph's own `state.messages`, which is the only authoritative answer.** The
   * checklist tool keeps its list in a closure private to each `get()` result — one list per agent
   * init, so concurrent AG-UI sessions never share one — so there is no tool state to read from
   * outside it, and the newest `gth_checklist` **tool-call args** in the history are the record.
   * Reconstructing it from the streamed chunks instead would mean aggregating a whole turn's
   * messages a second time and getting a different answer on the resume path, where the drain that
   * saw the call and the drain that saw the end are two different streams.
   *
   * Called at the end of a turn on every path, so a surface reading {@link getOutstandingWork} gets
   * this turn's answer whether it drove the agent through `GthAgentRunner` or, as the AG-UI server
   * does, straight through {@link streamWithEvents}.
   *
   * Fail-soft throughout. `getConversationMessages` throws by design on an agent whose graph
   * exposes no state, and a fact nobody could read is "no fact" — never a reason to fail a turn
   * that had otherwise succeeded.
   */
  async noteOutstandingWork(runConfig: RunnableConfig): Promise<void> {
    try {
      const messages = await this.getConversationMessages(runConfig);
      const work = detectOutstandingWork(messages);
      if (!work) {
        this.outstandingWork = null;
        return;
      }
      // The repeat decision is taken HERE, once, rather than at each of the six surfaces that may
      // render it — so they cannot come to disagree about what "again" means, and so a surface
      // that renders nothing still moves the session's idea of what has been said.
      //
      // A changed signature starts a NEW episode at zero, which is what makes a checklist state
      // change count as progress and another identical call not.
      const episode =
        this.outstandingEpisode?.signature === work.signature
          ? this.outstandingEpisode
          : { signature: work.signature, announced: 0 };
      const repeat = episode.announced >= OUTSTANDING_WORK_NOTICE_MAX_PER_SIGNATURE;
      if (!repeat) episode.announced += 1;
      this.outstandingEpisode = episode;
      this.outstandingWork = { ...work, repeat };
      debugLog(outstandingWorkLogLine(this.outstandingWork));
    } catch {
      /* fail-soft: noticing an unfinished checklist must never be what ends a finished turn */
      this.outstandingWork = null;
    }
  }

  /**
   * [[EXT-158]] — the checklist work this turn left outstanding, or `null` when it left none (or
   * when there was no checklist at all, which is the ordinary case and not a defect).
   */
  getOutstandingWork(): GthOutstandingWork | null {
    return this.outstandingWork;
  }

  /**
   * [[EXT-178]] — snapshot the bounded inputs an end-of-run recap would be built from.
   *
   * **A sibling of {@link noteOutstandingWork}, not a line inside it.** The two answer different
   * questions about the same moment and have different lifetimes at the consumer, and a method
   * called `noteOutstandingWork` that also captured a transcript digest would be a name that lies —
   * which is how the next reader comes to delete half of it. The cost of the separation is one more
   * read of the graph's state per turn, which is a local checkpoint read beside a model turn.
   *
   * Called at the same three sites for the same reason: the runner's string path has no site inside
   * the agent, and the typed-event paths have no runner to ask.
   *
   * Fail-soft throughout, and the catch **clears** rather than leaves: a turn whose state could not
   * be read must not be summarised with the previous turn's transcript, which is the one way this
   * could put words in a user's mouth about work they never asked for.
   */
  async noteRunRecapSource(runConfig: RunnableConfig): Promise<void> {
    try {
      this.runRecapSource = buildRunRecapSource(await this.getConversationMessages(runConfig));
    } catch {
      /* fail-soft: preparing an explanation must never be what ends a finished turn */
      this.runRecapSource = null;
    }
  }

  /**
   * [[EXT-178]] — the recap inputs for the turn that just ended, or `null` when there is nothing to
   * summarise (or nothing could be read).
   *
   * The value only; no model has been called at this point and none is called by reading it. The
   * recap itself is requested by `GthAgentRunner`, which holds the config the call needs.
   */
  getRunRecapSource(): GthRunRecapSource | null {
    return this.runRecapSource;
  }

  /** [[EXT-159]] — why this turn ended, or `null` when no site inside this agent classified it. */
  getTerminationReason(): GthTerminationReason | null {
    return this.terminationReason;
  }

  /**
   * [[EXT-159]] — what the provider said about why each model message stopped, this turn.
   *
   * A copy, so a reader (the debug dump) cannot mutate the live record. An EMPTY list is itself
   * meaningful and is not the same as a list of absences: it says no finished model message was
   * observed at all, where an entry with a `null` token says one was observed and the provider said
   * nothing.
   */
  getFinishReasonObservations(): readonly GthFinishReasonObservation[] {
    return [...this.finishReasonObservations];
  }

  /**
   * [[EXT-159]] — record the provider's stop/finish reason for one finished model message, and
   * write it to the debug log.
   *
   * Called on EVERY finished message rather than only on the interesting ones, because the fact
   * this exists to capture is as much "the provider said nothing" as "the provider said `length`".
   * The debug log is where a maintainer looks first and it carried none of this; the ring buffer
   * behind `debugLog` is populated whether or not on-disk debug logging was ever switched on, so
   * the observation reaches `/debug-dump` from a default install too.
   *
   * Fail-soft, and bounded: a long agentic turn logs one entry per model round.
   */
  protected noteFinishReason(path: GthFinishReasonObservation['path'], message: unknown): void {
    try {
      // No message means no observation — NOT an observation of absence. A turn whose stream
      // produced nothing to aggregate has no provider statement to be missing, and recording a
      // `null` token for it would make "the provider said nothing about this message" and "there
      // was no message" read the same, which is the conflation this whole node is about.
      if (!message || typeof message !== 'object') return;
      const token = readStopReasonToken(message);
      if (this.finishReasonObservations.length < FINISH_REASON_OBSERVATION_MAX) {
        this.finishReasonObservations.push({ at: new Date().toISOString(), path, token });
      }
      debugLog(`EXT-159 finish_reason path=${path} token=${token ?? '<absent>'}`);
    } catch {
      /* fail-soft: observing why a message stopped must never be what stops a run */
    }
  }

  /**
   * [[EXT-159]] — record why the turn ended, **first-write-wins**.
   *
   * The sites that classify are nested: the metadata reader and the cancellation paths sit inside
   * the stream, which sits inside the runner's catches. Last-write-wins would let each outer layer
   * overwrite the truer inner classification with its own coarser one — which is exactly the funnel
   * this taxonomy replaces, rebuilt one level up. Fail-soft: classification never throws into a run.
   */
  protected noteTermination(reason: GthTerminationReason): void {
    try {
      if (this.terminationReason) return;
      this.terminationReason = reason;
      // [[EXT-159]] — written where the reason is DECIDED, not where a surface later reads it. The
      // terminating error reached only `transcript.json` and never the debug log, so the artifact a
      // maintainer opens first could not say why a run ended; logging at the decision means the
      // line exists even for a run whose surface never got to ask.
      debugLog(terminationLogLine(reason));
    } catch {
      /* fail-soft: recording why a run ended must never be what ends it */
    }
  }

  /**
   * [[EXT-159]] — run the metadata feeder over a finished message and record what it found.
   *
   * The metadata reader is the half of the taxonomy that only works here, at the layer where a
   * message's `response_metadata` is visible. Returns whether anything was classified.
   */
  protected noteStopMetadata(site: GthTerminationSite, message: unknown): boolean {
    const stop = detectStopMetadata(message);
    if (!stop) return false;
    this.noteTermination(terminationReason(site, 'metadata', stop));
    return true;
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
   * GS2-23 — the thread's conversation as the checkpointed graph holds it. Loud, unlike
   * `getStateMessageCount`: a compaction that cannot read the state must not proceed on an
   * empty list and report that it folded nothing.
   */
  async getConversationMessages(runConfig: RunnableConfig): Promise<BaseMessage[]> {
    if (!this.agent || typeof this.agent.getState !== 'function') {
      throw new Error('This agent exposes no conversation state to read.');
    }
    const state = await this.agent.getState(runConfig);
    const messages = (state as { values?: { messages?: unknown } })?.values?.messages;
    return Array.isArray(messages) ? (messages as BaseMessage[]) : [];
  }

  /**
   * GS2-23 — replace the thread's conversation through the graph's own `updateState`, so the
   * compacted history is checkpointed and the next turn (and a later resume) loads it.
   */
  async replaceConversationMessages(
    runConfig: RunnableConfig,
    messages: BaseMessage[]
  ): Promise<void> {
    if (!this.agent || typeof this.agent.updateState !== 'function') {
      throw new Error('This agent exposes no conversation state to write.');
    }
    await replaceGraphMessages(
      this.agent as Parameters<typeof replaceGraphMessages>[0],
      runConfig,
      messages
    );
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
   * non-streaming {@link invoke} and streaming `streamFromInput` paths so both render a
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
   * For streaming use `#stream` method, streaming is preferred if model API supports it.
   * Please note that this when tools are involved, this method will anyway do multiple LLM
   * calls within LangChain dependency.
   *
   * [[EXT-184]] — **this path arms Esc, exactly as `streamFromInput` does.** `GthAgentRunner`
   * branches on `config.streamOutput`: the streaming arm reaches `streamFromInput`, which arms the
   * interrupt and threads an abort signal; this is the other arm, and until it did the same a
   * runaway model call under `streamOutput: false` showed a spinner and nothing else for as long
   * as the provider took, with no key that could stop it — the one caller-facing turn path with no
   * interrupt at all.
   *
   * The arming is deliberately DUPLICATED rather than shared with its twin: they are the two arms
   * of one branch, and a single helper would make any regression in one of them show up in both,
   * which is the one thing a test of this pair has to be able to tell apart.
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
      // [[EXT-184]] — the interrupt affordance, armed before the call and torn down in the
      // `finally` below. `waitForEscape` returns immediately when the config says no, and
      // `canInterruptInferenceWithEsc` is already ANDed with `isTTY()` when the config is loaded,
      // so a non-TTY caller (CI, a piped diff, the batch pipeline) arms nothing by construction —
      // bounding an unattended run is a different question and is not answered here.
      const interruptState = { escape: false, messageShown: false };
      const abortController = new AbortController();
      const showInterruptMessage = () => {
        if (!interruptState.messageShown) {
          interruptState.messageShown = true;
          // Stop the spinner BEFORE saying anything: the callback fires while the invoke is still
          // pending, so a live `ProgressIndicator` would keep writing dots over the notice until
          // the call unwinds. `stop()` is idempotent, so the `finally` below is unaffected.
          progress.stop();
          this.statusUpdate(StatusLevel.WARNING, '\n\nInterrupted by user, exiting\n\n');
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
        // GS2-93 / GS2-63: the hint box is part of the run-header preamble, so only the `debug`
        // rung prints it; the handler stays armed at every rung. Same reading as the twin site in
        // `streamFromInput`. Only the plain surface reaches this method — the TUI drives
        // `streamWithEvents` and owns its own keyboard.
        this.headerRung === 'debug'
      );
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
        // [[EXT-184]] — the signal is what makes Esc mean something. MEASURED against the installed
        // langgraph: a graph node that ignores the signal entirely and simply hangs still sees
        // `invoke()` reject with an `AbortError` ~300 ms after the abort, and the signal is present
        // inside the node's own config and fires there — so the model call is cancelled rather than
        // merely abandoned. Cancelling is therefore real here, not the incidental downstream
        // refusal [[TUI-C97]] found in the approval hold.
        const response = await this.agent.invoke(
          { messages },
          { ...runConfig, signal: abortController.signal }
        );
        // Harvest token usage + invoked tool names from THIS turn's new messages only (fail-soft)
        // so the local history recorder can populate `gth insights`.
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
        // [[EXT-159]] — the metadata feeder, at the one layer that can see `response_metadata`.
        // Records why the turn ended (a refusal, or an answer cut off against the output cap)
        // before the refusal branch below decides what to SAY about it; a truncation says nothing
        // and is classification only.
        // [[EXT-159]] — and record what the provider said about why the message stopped, or that it
        // said nothing. Separate from the classification above: the metadata feeder speaks only for
        // a refusal or a truncation, while this is the raw fact, kept for every ending.
        this.noteFinishReason('invoke', finalMessage);
        this.noteStopMetadata('agent.invoke-stop-metadata', finalMessage);
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
        // [[EXT-184]] — Esc, or an abort raised under the call. Checked BEFORE every other branch:
        // an aborted call arrives here as an ordinary rejection, and any branch below would report
        // the user's own cancellation as a provider failure. The predicate mirrors the streaming
        // arm's, so the two arms classify a cancellation the same way.
        //
        // It RETURNS rather than throws, and returns a notice rather than partial content, for two
        // reasons. The runner treats an empty non-streaming turn as terminal at once ("Model
        // returned an empty response…"), so an empty return would answer a deliberate cancellation
        // with an accusation against the model — the same reason EXT-37 returns a refusal as the
        // turn's answer a few lines above. And `invoke` produces no incremental output by
        // construction, so unlike the streaming arm there is no partial text to hand back; the
        // asymmetry is in what the two arms have, not in how they treat a cancellation.
        if (interruptState.escape || (e instanceof Error && e.name === 'AbortError')) {
          this.noteTermination(
            terminationReason('agent.invoke-cancelled', 'control', {
              category: 'cancelled',
              detail: interruptState.escape ? 'escape' : 'AbortError',
            })
          );
          // DL-1, no action is silent: says so even when the key was never pressed, in which case
          // nothing has been printed yet. A caller's own signal is NOT that case — the spread at
          // the `invoke` call replaces `runConfig.signal` — so the reachable other cause is an
          // abort raised beneath us: a call deadline's ambient signal composed onto the request by
          // `ambientSignalFetch`, or the provider client's own timeout. The notice names the user
          // because that is the only cause a person can produce at the keyboard; `detail` on the
          // recorded reason is what separates the two for anyone reading back.
          showInterruptMessage();
          return 'Interrupted by user.';
        }
        if (e instanceof Error && e?.name === 'ToolException') {
          throw e; // Re-throw ToolException to be handled by outer catch
        }
        const message = e instanceof Error ? e.message : String(e);
        // [[EXT-92]] scope (b) — **this is the line every surface shows**, and it is where the
        // serialized blob actually reached the reporter.
        //
        // The Ink TUI renders a thrown turn twice: once from here, because an ERROR status update
        // is committed to the transcript, and once from its own catch. Fixing only the catch left
        // the blob on screen in the TUI anyway, and left it untouched on readline, single-shot,
        // conversation and every server surface — which are the surfaces with no turn box, where
        // this line IS the whole report. So the rendering belongs at the emitting site, not at one
        // consumer of it.
        //
        // `providerErrorNotice` answers `null` for an error with no provider payload and no blob to
        // strip, so the ordinary runtime failure keeps the exact wording it has always had; only an
        // error that carries something better to say is re-rendered. The prose goes on its own
        // lines rather than after the colon because it is several sentences, and the raw text stays
        // in the thrown error, which is what `/debug-dump` and `debugLogError` above both archive.
        const notice = providerErrorNotice(e);
        this.statusUpdate(
          StatusLevel.ERROR,
          notice ? `LLM invocation failed:\n${notice.text}` : `LLM invocation failed: ${message}`
        );
        throw e;
      } finally {
        // [[EXT-184]] — pair the arming on EVERY exit, including the throws above. A leaked
        // keypress listener holds stdin in raw mode and ref'd, which wedges the readline approval
        // prompt the runner may run next and stops a one-shot command exiting at all; the twin
        // site tears down in its stream's `finally`/`cancel` for the same reason.
        stopWaitingForEscape();
        progress.stop();
      }
    } catch (error) {
      debugLogError('invoke outer', error);
      if (error instanceof Error) {
        if (error?.name === 'ToolException') {
          // [[EXT-159]] — a tool failure that becomes the turn's ANSWER ends the turn as much as a
          // throw does, and it is the one ending whose diagnostic string is returned rather than
          // raised, so nothing further up ever sees an error to classify.
          this.noteTermination(
            terminationReason('agent.invoke-tool-exception', 'exception', {
              category: 'tool_error',
              detail: error.name,
            })
          );
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
    // [[TUI-C106]] — a NEW turn, so the plain surface's tool tracking starts empty. This is the
    // only place that resets it: {@link streamResume} is the SAME turn continuing and must keep it.
    //
    // One caller re-enters here WITHIN a turn, and it was checked rather than assumed: [[EXT-160]]'s
    // retry-after-compaction (`GthAgentRunner.runTurn(…, attempt + 1)`). Resetting there is the
    // wanted behaviour — compaction has rewritten the history the announcement belonged to, so
    // carrying it over could only name a later row from an earlier turn's arguments. It costs at
    // most a nameless row in that one path, which is where every row stood before this node.
    this.plainToolIndication = undefined;
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
    // [[EXT-159]] — bound for the same reason as the two above: the stream `start()` closure's
    // `this` is the stream source, not the agent, and the sites that end this turn live in it.
    const noteTermination = (reason: GthTerminationReason) => this.noteTermination(reason);
    const noteStopMetadata = (site: GthTerminationSite, message: unknown) =>
      this.noteStopMetadata(site, message);
    const noteFinishReason = (path: GthFinishReasonObservation['path'], message: unknown) =>
      this.noteFinishReason(path, message);
    // TUI-C30 — compact per-tool-call indication for the plain surface (`name(args…)` + the
    // canonical 10-line greyed preview when each ToolMessage lands). Emits at INFO level so the
    // existing consoleLevel gate governs it like the historical tool notices. The TUI never runs
    // this string path (it renders the typed event stream itself).
    //
    // [[TUI-C106]] — **the observer's state belongs to the TURN, not to this stream.** It used to
    // be built here, per call, and that is what produced the nameless rows in issue #445. An
    // approval-gated tool suspends the graph: this method returns with the call announced and its
    // result not yet produced, `GthAgentRunner.resolveToolInterrupts` collects the human's
    // decision, and the turn continues through `streamResume` — a SECOND call to this method. The
    // `ToolMessage` therefore lands in a stream whose observer never saw the producer message, so
    // the arguments were not missing at all: they were discarded at the stream boundary, and the
    // row rendered `name()`. Every approval-gated tool was affected, not only the file reader the
    // issue happened to catch.
    //
    // Reset in {@link stream} (a new turn) and in {@link clearRaterClarifications} (`/clear`),
    // which is the same lifetime the rater-clarification set has, for the same reason.
    //
    // [[TUI-C69]] §5.4 — the plain surface's twin of the typed event's `raterClarification`, read
    // through a closure rather than handed a snapshot: the set is filled WHILE this stream is
    // drained, because the runner notes the id at the moment it refuses the call, which is after
    // this observer was built and before the refusal's own result arrives. The set is owned by the
    // agent, so the closure stays valid across every stream of the turn.
    const raterClarifications = this.raterClarifications;
    this.plainToolIndication ??= createPlainToolIndication(undefined, (id) =>
      raterClarifications.has(id)
    );
    const toolIndication = this.plainToolIndication;
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
          // the assembled message's stop/finish reason, not only a per-chunk one. Some providers
          // surface the reason only on the assembled message (or split it across chunks that
          // concat into it); without this fallback such a refusal would be swallowed by the
          // empty-response retry, making the EXT-37 surfacing cosmetic on the DEFAULT streaming
          // surface.
          //
          // [[EXT-205]] — the aggregate is ONE PER MODEL MESSAGE, not one per tool round. A
          // middleware hook can call the model with no ToolMessage after it: the review rating
          // call runs from `review-rate.after_agent` straight after the answer, so a per-round
          // aggregate concatenated the two messages' reasons (`stopstop`; `max_tokensstop` for a
          // truncated review, which no reader recognises). A bare reset when the message id
          // changes would not fix it either: the last aggregate would then be the rating call's,
          // and the answer's own reason would never be read. So each message is recorded as it
          // finishes (one finish-reason entry per message, an absent reason logged as absent),
          // and the turn is classified from the last message that is NOT a middleware hook's and
          // was not followed by a tool round — the answer, not the rating call. The boundary rule
          // and the choice of message are argued in `modelMessageFold.ts`; the typed-event path
          // uses the same tracker so the two cannot drift.
          const messageReasons = new TurnMessageReasons((message) =>
            noteFinishReason('stream', message)
          );

          for await (const [chunk, _metadata] of stream) {
            debugLogObject('Stream chunk', { chunk, _metadata });
            // GS2-16: fold every chunk (AIMessageChunk usage/tool_calls, ToolMessage name) into
            // the run tally before the text-only handling below.
            recordRunStats(chunk);
            // EXT-37: first refusal signal wins; keep scanning chunks for text/binary as normal.
            // [[EXT-205]] — a middleware hook's own model call is not the answer, so a refusal on
            // it (the review rating call) must not be surfaced as the model declining the turn.
            // Same rule as the classification below, so the two refusal readers and the
            // truncation reader all read the same messages.
            if (!refusalInfo && !isMiddlewareHookNode(streamNodeOf(_metadata))) {
              refusalInfo = detectRefusal(chunk);
            }
            messageReasons.observe(chunk, _metadata);
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
          // [[EXT-159]] — the provider's own word on why each message stopped, recorded before
          // either branch below decides what to make of it, so the raw fact is kept on the
          // refusal path as well as the ordinary one. [[EXT-205]] — `end()` records the last open
          // message and hands back the one that classifies the turn.
          const turnMessage = messageReasons.end();
          // EXT-41: aggregate-level fallback — if no per-chunk metadata flagged a refusal, inspect
          // the answer message's assembled stop/finish reason. Catches providers that expose the
          // reason only on the assembled message (or split across chunks that concat into it).
          if (!refusalInfo && turnMessage) {
            refusalInfo = detectRefusal(turnMessage);
          }
          // EXT-37: surface a captured refusal as the terminal answer. Enqueue the clear message
          // (so the drained result is non-empty and bypasses the empty-response retry) and print it
          // once at WARNING level (surfaceRefusal). Any partial content already streamed is kept;
          // the refusal notice follows it, and its explanation carries any model-provided text.
          if (refusalInfo) {
            // [[EXT-159]] — classified through `classifyRefusal` rather than mapped here, so this
            // site and the metadata feeder cannot come to disagree about what a refusal is.
            noteTermination(
              terminationReason(
                'agent.stream-stop-metadata',
                'metadata',
                classifyRefusal(refusalInfo)
              )
            );
            controller.enqueue(surfaceRefusal(refusalInfo));
          } else if (turnMessage) {
            // No refusal: the same reader still has something to say about an answer that was cut
            // off against the output cap. Classification only — nothing is surfaced.
            noteStopMetadata('agent.stream-stop-metadata', turnMessage);
          }
          debugLog(`Stream completed. Total chunks: ${totalChunks}`);
          controller.close();
        } catch (error) {
          if (interruptState.escape || (error instanceof Error && error.name === 'AbortError')) {
            // [[EXT-159]] — Esc, or a caller's abort. This turn ends with no error reaching the
            // runner at all (the stream is CLOSED, not errored), so if this site does not classify
            // it nothing downstream can: it is indistinguishable from a turn that simply finished.
            noteTermination(
              terminationReason('agent.stream-cancelled', 'control', {
                category: 'cancelled',
                detail: interruptState.escape ? 'escape' : 'AbortError',
              })
            );
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
      // [[EXT-158]] — the typed-event turn drained to its end, so the graph's state now holds the
      // whole turn and can be asked whether the checklist still has work on it. Here rather than in
      // a `finally`: a turn that ended on a suspend or an abort is parked or stopped, not finished,
      // and those endings have their own categories and their own notices. This is also the ONLY
      // site the AG-UI server reaches — it drives this method directly, with no runner to ask.
      await this.noteOutstandingWork(runConfig);
      await this.noteRunRecapSource(runConfig);
    } catch (e) {
      if (
        e instanceof GraphInterrupt ||
        (e as Error).name === 'GraphInterrupt' ||
        (e as Error).name === 'AbortError'
      ) {
        // [[EXT-159]] — two different endings share this branch and must not share a reason. A
        // suspend is not a failure at all (the run is parked on an `interrupt()` and continues on
        // a resume); an abort is the user stopping it. Both return CLEANLY, so this is the last
        // point at which either is knowable.
        this.noteTermination(this.classifyEventStreamEnd('agent.events-ended', e));
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
      // [[EXT-158]] — the typed-event turn drained to its end, so the graph's state now holds the
      // whole turn and can be asked whether the checklist still has work on it. Here rather than in
      // a `finally`: a turn that ended on a suspend or an abort is parked or stopped, not finished,
      // and those endings have their own categories and their own notices. This is also the ONLY
      // site the AG-UI server reaches — it drives this method directly, with no runner to ask.
      await this.noteOutstandingWork(runConfig);
      await this.noteRunRecapSource(runConfig);
    } catch (e) {
      if (
        e instanceof GraphInterrupt ||
        (e as Error).name === 'GraphInterrupt' ||
        (e as Error).name === 'AbortError'
      ) {
        // [[EXT-159]] — the resume path's twin of the same two endings; see {@link streamWithEvents}.
        this.noteTermination(this.classifyEventStreamEnd('agent.events-resume-ended', e));
        debugLog('Graph suspended (GraphInterrupt) or aborted by caller');
        return;
      }
      throw e;
    }
  }

  /**
   * [[EXT-159]] — which of the two clean endings a typed-event stream just took.
   *
   * Shared by {@link streamWithEvents} and {@link streamWithEventsResume} so the pair cannot drift:
   * they catch the same union and owe the same distinction.
   */
  private classifyEventStreamEnd(site: GthTerminationSite, error: unknown): GthTerminationReason {
    const suspended =
      error instanceof GraphInterrupt || (error as Error | undefined)?.name === 'GraphInterrupt';
    return terminationReason(site, suspended ? 'control' : 'exception', {
      category: suspended ? 'suspended' : 'cancelled',
      detail: suspended ? 'GraphInterrupt' : 'AbortError',
    });
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
   * never both. {@link clearRaterClarifications} empties it with the rest of the turn's state, so a
   * long run cannot accumulate.
   */
  noteRaterClarification(toolCallId: string): void {
    if (toolCallId) this.raterClarifications.add(toolCallId);
  }

  /**
   * [[TUI-C69]] §5.4 — **forget the noted ids**, called at the top of every turn and on `/clear`.
   *
   * The set is keyed on tool-call ids, and an id is only meaningful while the result carrying it is
   * being rendered. Holding them past that costs a string per rater rejection for the life of the
   * process — small — and risks the thing that is not small: a LATER call that reuses a noted id
   * renders as a clarification request whatever it actually was, so a successful command inherits
   * the tone of an argument it had no part in.
   *
   * That reuse is not reachable with the providers installed today — `@langchain/ollama` mints
   * `v4()` uuids, `@langchain/google` `lc-tool-call-${v4()}`, and OpenAI and Anthropic supply their
   * own unique ids — but **the protection was the providers', not this code's**, which is a
   * property no test here can hold and no bump has to preserve.
   *
   * On `/clear` it is the same argument `GthAgentRunner.clearConversation` makes about the negotiation:
   * state from before the user asked for the conversation to be forgotten must not decide how the
   * conversation after it is drawn.
   */
  clearRaterClarifications(): void {
    this.raterClarifications.clear();
    // [[TUI-C106]] — the plain surface's tool tracking has the same lifetime and goes with it: a
    // call announced before the user asked for the conversation to be forgotten must not supply
    // the arguments for a row drawn after it.
    this.plainToolIndication = undefined;
  }

  /** [[TUI-C69]] — the ids {@link noteRaterClarification} has been told about this turn. */
  protected raterClarifications = new Set<string>();

  /**
   * [[TUI-C106]] — the plain surface's tool-call tracking for the CURRENT TURN.
   *
   * Held on the agent rather than inside `streamFromInput` because a turn that suspends at the
   * approval gate spans TWO streams, and the gated call's result always lands in the second one.
   * `undefined` means the next stream opens a turn and builds a fresh observer.
   */
  private plainToolIndication: PlainToolIndicationObserver | undefined;

  protected async *processEventStream(
    stream: IterableReadableStream<[BaseMessage, Record<string, unknown>]>
  ): AsyncGenerator<AgentStreamEvent> {
    // Aggregate AIMessageChunks via concat so tool_call_chunks collapse into
    // tool_calls with complete args (per-chunk tool_calls only ever sees that
    // chunk's slice of the args JSON, which is rarely valid on its own).
    let aggregatedAIChunk: AIMessageChunk | null = null;
    let reasoningOpen = false;
    const flushed = new Set<string>();
    /**
     * [[TUI-C100]] — the calls THIS stream has announced (`tool_start` + `tool_args`) and whose
     * own result it has not yet seen.
     *
     * Kept here rather than derived from {@link aggregatedAIChunk} because the aggregate is nulled
     * after every round (see the reset below) while the calls it announced can still be waiting —
     * at the approval gate, or simply behind a sibling in the same message. A set that died with
     * the aggregate would lose exactly the calls this exists to track.
     *
     * **Scoped to one invocation, deliberately.** A call held at the approval gate is announced in
     * the stream that suspends and resolved in the stream that resumes, so its result lands where
     * this set is empty — and it therefore never receives a `tool_end` at all. That is the correct
     * outcome, not a leak: a stream may only speak for what it announced. What closes a call that
     * produces no result anywhere is the turn-level drain in `GthAgentRunner`'s
     * `processMessagesWithEvents`, which spans both streams.
     */
    const pendingEnds = new Set<string>();
    // EXT-41: a content-policy refusal on this typed-event path was de-scoped by EXT-37 (there is
    // no empty-response retry here, so no wrong-retry bug), but it still rendered as a SILENT empty
    // turn. Capture it (first per-chunk signal wins; aggregate fallback at stream end) and surface
    // it as a `text` event so every consumer (Ink TUI viewModel, AG-UI SSE) shows a clear notice.
    let refusalInfo: RefusalInfo | null = null;
    // [[EXT-205]] — stop reasons are read per model message, by the same tracker as the string
    // path (see the fold comment in `streamFromInput` and `modelMessageFold.ts`). It sits BESIDE
    // `aggregatedAIChunk` rather than replacing it: that aggregate also carries the round's
    // `tool_calls` for `flushAggregated`, and splitting it at a message boundary would drop the
    // announcement of a call made by an earlier message in the round.
    const messageReasons = new TurnMessageReasons((message) =>
      this.noteFinishReason('events', message)
    );
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

    /**
     * Announce every call the assistant message carries, once its arguments are complete.
     *
     * [[TUI-C100]] — **announcing a call is not ending it.** This runs when the round's FIRST
     * `ToolMessage` lands, because that is what makes the streamed aggregate complete, so it speaks
     * for every call in the message at once: the one that just returned, the ones still queued, and
     * the one suspended at the approval gate with a human being asked about it. `tool_start` and
     * `tool_args` are true for all of them — the model has finished emitting the arguments — and
     * that is what puts a call on screen, with the arguments the human is about to rule on.
     * `tool_end` is not: it waits for the call's own result, and is emitted beside it when that
     * result reaches THIS stream — which for a gated call it never does. See `pendingEnds` above.
     *
     * ---
     *
     * [[TUI-C106]] — **an id-less call is deliberately NOT announced here, and the decision was
     * taken rather than inherited.** Both loops below skip an entry with no id, and they keep
     * doing so.
     *
     * The alternative was to announce it anyway, which means minting an id, because `flushed` and
     * `pendingEnds` are both keyed on one. That was rejected on a rule this repo already holds:
     * [[EXT-47]] requires a promoted call's id to be *stable and wire-derived, without
     * fabricating*. A minted id is also worse than useless downstream — the AG-UI bridge frames
     * `TOOL_CALL_START`/`TOOL_CALL_RESULT` on it, and the result arrives under the id the graph
     * dispatched, so a fabricated announcement would open a frame nothing ever closes.
     *
     * **Dropping the announcement does not drop the call.** The round's `ToolMessage` still yields
     * a `tool_result` under its own `tool_call_id`, which IS wire-derived, and that is what puts
     * the row on screen (the Ink reducer creates a row for any id it has not seen). What the row
     * lacked was a NAME, so the result event carries one — see the `tool_result` yield below. The
     * transparency property is kept, at no cost to the id rule.
     */
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
        pendingEnds.add(id);
      }
      // Surface invalid tool calls too so the client at least sees the raw args
      // string the model produced, instead of silently dropping them.
      //
      // These END INLINE, unlike the calls above, and the asymmetry is the point: an invalid call
      // is never dispatched, so there is no result to wait for and nothing that could later change
      // what it says. Deferring it would leave a row that cannot progress sitting at `running`
      // until the turn ended, in exchange for nothing.
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
      // [[EXT-205]] — a middleware hook's own model call is not the answer; see the string path.
      if (!refusalInfo && !isMiddlewareHookNode(streamNodeOf(_metadata))) {
        refusalInfo = detectRefusal(chunk);
      }
      messageReasons.observe(chunk, _metadata);

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
        // [[TUI-C100]] — the call's own result is here, so NOW it has ended.
        //
        // **The guard is the stream's own honesty, not a favour to a downstream reader.** This
        // generator may only close a call it opened, and the id it is holding a result for is
        // routinely one it never announced: a gated call is announced in the stream that suspends
        // and returns in the stream that resumes, where this set is empty. So the common gated flow
        // is `tool_start`, `tool_args`, then a `tool_result` in a later stream with **no `tool_end`
        // between them, and none at all** — do not read the line below as a promise that an end
        // always precedes a result. Every consumer treats `tool_result` as terminal on its own, and
        // the AG-UI bridge additionally closes its own framing from what it actually emitted rather
        // than trusting this event to arrive.
        if (pendingEnds.delete(toolCallId)) {
          yield { type: 'tool_end', id: toolCallId };
        }
        yield {
          type: 'tool_result',
          id: toolCallId,
          content,
          // [[TUI-C106]] — the tool's name, for a consumer that never saw this call start. See the
          // decision recorded on `flushAggregated` above: an id-less call is not announced, but its
          // RESULT still draws a row, and this is what that row is named from.
          ...(typeof chunk.name === 'string' && chunk.name.length > 0 ? { name: chunk.name } : {}),
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

    // Announce any tool calls not followed by a ToolMessage (e.g. terminal tool calls), so a call
    // the model asked for is never silently absent from the stream.
    //
    // [[TUI-C100]] — and deliberately NO `tool_end` sweep of {@link pendingEnds} here, which is
    // the tempting shape and the wrong one. **A stream that ends with calls outstanding is what
    // suspending at the approval gate LOOKS like**: the graph interrupts, this generator returns,
    // and `GthAgentRunner.processMessagesWithEvents` only then opens the prompt
    // (`resolveToolInterruptsWithEvents`). Ending them here would put the tick and the word `done`
    // back on the row a moment before the human is asked about it — the defect, moved rather than
    // fixed. A call held at the gate and a genuinely terminal one are indistinguishable from
    // inside the stream, and the turn's end is the first point at which the human has been asked
    // and the answer acted on — so a call still without a result THERE is one that will never have
    // one, and the runner closes it as exactly that.
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
    // metadata flagged a refusal, inspect the answer message's assembled stop/finish reason. Then
    // surface any refusal as a `text` event so the user sees a clear notice instead of a silent
    // empty turn. No statusUpdate here: consumers render the typed events, and a WARNING would
    // double-render in the TUI.
    //
    // [[EXT-159]] — the typed-event path's raw provider statement, on both branches. This is the
    // surface most users watch, and it recorded no `finish_reason` anywhere at all. [[EXT-205]] —
    // recorded per message by the tracker; `end()` records the last one and returns the message
    // that classifies the turn.
    const turnMessage = messageReasons.end();
    if (!refusalInfo && turnMessage) {
      refusalInfo = detectRefusal(turnMessage);
    }
    if (refusalInfo) {
      // [[EXT-159]] — the typed-event path's metadata site; classified through the same
      // `classifyRefusal` the other two use.
      this.noteTermination(
        terminationReason('agent.events-stop-metadata', 'metadata', classifyRefusal(refusalInfo))
      );
      debugLog(
        `Content-policy refusal detected on typed-event path (provider=${refusalInfo.provider} reason=${refusalInfo.reason})`
      );
      yield { type: 'text', delta: buildRefusalMessage(refusalInfo) };
    } else if (turnMessage) {
      // No refusal, but the same reader still sees an answer cut off against the output cap.
      this.noteStopMetadata('agent.events-stop-metadata', turnMessage);
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
    // EXT-186 — a config with NO `llm` key at all is refused here, by name, instead of throwing
    // `TypeError: Cannot read properties of undefined (reading 'bindTools')` on the next line.
    //
    // THE SEAM WAS A CHOICE, AND THE REJECTED SHAPE IS NAMED. The other candidate was to refuse at
    // config-read time, in `initConfig`/`resolveConfig`, so that nothing downstream ever sees a
    // model-less config. Rejected, for three reasons:
    //
    //   1. The loader is not the only door. `startAgUiServer` and this agent are exported entry
    //      points an embedder calls with a config it built itself, which never went through the
    //      loader at all — `apiAgUiModule` says so in its own words above its `isUsableModel`
    //      check, and CFG-61's defect arrived through exactly that door. A refusal in the loader
    //      cannot see those configs. `getEffectiveConfig` is the single funnel every verb passes
    //      through (see the `warnScopedPromptsUnusable` docblock below for why that matters), and
    //      it is reached from every door, so one refusal here covers all of them.
    //   2. `gth config print` calls `initConfig` and needs no model. It is the command a person
    //      runs to find out what was actually read, and refusing at the read site would make it
    //      fail with the very error they are trying to diagnose.
    //   3. The read paths that CAN name a source already refuse there: the project JSON layer and
    //      the global layer both raise a `ConfigDiscoveryError` naming the file and `llm.type`.
    //      What is left over is the module/programmatic config, which reaches here with no source
    //      label to name — so a second read-site message would be a message that could drift from
    //      this one, not a message that says more.
    //
    // WHY A REFUSAL AND NOT THE GUARDED DEREFERENCE `shell/alignment.ts` performs. That one reads
    // `if (!model || typeof model.bindTools !== 'function')` and degrades to a fail-closed
    // decision, which is right there: the alignment check is an optional sub-check with a correct
    // conservative answer available. Here there is no degraded answer — every verb needs the model
    // — and degrading would route the absent case into `Model does not seem to support tools.`,
    // which is FALSE: there is no model to lack the capability. `2.0` is deliberately breaking for
    // config, so inventing a default `llm` is not available either.
    //
    // THE TEST IS ABSENCE, NOT USABILITY, and the difference is the whole node. `isUsableModel`
    // (core's own, exported for CFG-61) asks whether the value can answer a call, and it is FALSE
    // for a raw `{ type, model }` spec — which is precisely the config that today warns, inits,
    // boots and answers 503 from the AG-UI status endpoints. Keying this refusal on
    // `!isUsableModel(config.llm)` would convert that shipped behaviour into a throw. So it is the
    // wrong instrument here, and the guard asks the one question this node is about: is there an
    // `llm` key at all? The `llm: {}` cell in the spec is the control that holds the two apart.
    //
    // WHY THIS DOES NOT CONVERGE WITH CFG-61's 503, deliberately. `apiAgUiModule` argues in-code
    // against guarding above `agent.init`, because refusing the boot denies an embedder the
    // endpoint it started the server to read. That argument is about a server that CAN boot: a
    // present-but-unusable `llm` is a runtime capability shortfall, and reporting it over HTTP is
    // the useful answer. An ABSENT `llm` is a different class — the config does not satisfy its own
    // declared type (`GthConfig.llm: BaseChatModel`), so there is no server to speak of and nothing
    // for a run to call. `gth api ag-ui` now prints this message and exits 1 instead of dying on a
    // `TypeError` before `listen`, which is what the CLI's config-error guard already does for
    // every other member of this class.
    if (config.llm == null) {
      throw new ConfigDiscoveryError(
        'Gaunt Sloth configuration has no llm: no model is defined, so there is nothing to run ' +
          'this command on. Add an llm block (at minimum llm.type) to your Gaunt Sloth config, ' +
          'or supply one in the config passed to the agent.'
      );
    }
    const supportsTools = !!config.llm.bindTools;
    if (!supportsTools) {
      this.statusUpdate(StatusLevel.WARNING, 'Model does not seem to support tools.');
      debugLog('Warning: Model does not support tools');
    }
    this.warnScopedPromptsUnusable(config, command);
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
   * CFG-70 — say so when the verb being run can never honour `prompts.paths`.
   *
   * A user who configures path-scoped prompts and then runs `gth ask` gets a perfectly ordinary
   * run with none of their scoped content in it, and nothing anywhere says why. The feature
   * selects entries by matching a **diff's** paths, and only `review` and `pr` have a diff;
   * `ask`/`chat` have no paths at all, and `code`/`exec` have no defined path source yet (that is
   * its own decision, deliberately not taken here).
   *
   * **Why here and not at config load.** The natural-sounding home is `initConfig`, and it cannot
   * work: `initConfig` takes `CommandLineConfigOverrides`, which carries no verb, so a warning
   * there could only say "some commands ignore this" — which is not actionable and would fire on
   * every run of the verbs that DO honour it. `getEffectiveConfig` is the single funnel every verb
   * passes through holding its own verb, which is exactly the fact the message needs.
   *
   * **`command: undefined` is not a verb that ignores the feature.** `gth pr` discovery runs its
   * agent commandless on purpose (GS2-81), so warning on an absent command would fire during the
   * one verb that supports this best. Absent means "no verb claimed", never "a verb that cannot".
   *
   * This fires **once per agent init**, not once per process, and that is left as it is: a process
   * that inits two agents ran two agents, and the second is as unable to honour the config as the
   * first. De-duplicating would need module-level "have I warned yet" state, which is wrong across
   * the several inits a single `gth pr` or an interactive session performs.
   */
  private warnScopedPromptsUnusable(config: GthConfig, command: GthCommand | undefined): void {
    if (!command || command === 'review' || command === 'pr') return;
    if (!config.prompts?.paths?.length) return;
    this.statusUpdate(
      StatusLevel.WARNING,
      `Config sets prompts.paths, but the ${command} command cannot use it: path-scoped prompts ` +
        `are selected from the paths in a diff, and only review and pr have one. The root prompt ` +
        `segments still apply.`
    );
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
        if (isClientFulfilledTool(singleTool)) {
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

/**
 * **Is this tool fulfilled by the client, i.e. does calling it raise an `interrupt()`?**
 *
 * The single derivation of the `metadata.client === true` marker. {@link
 * GthAbstractAgent.extractAndFlattenTools} uses it to decide which tools get their body swapped for
 * an `interrupt()` stub, and `GthLangChainAgent.init`'s checkpointer guard uses it to decide whether
 * the graph it is about to build can interrupt at all.
 *
 * **Those two must not be able to disagree**, which is the whole reason this is a function and not a
 * pair of inline `metadata?.client` reads: the guard exists to refuse a graph that will interrupt
 * without a saver, so a marker the stub honours and the guard does not is a graph that reaches a
 * user with the exact failure the guard was added to prevent. Same reason `resolveInterruptToolNames`
 * is one shared derivation rather than one per backend — a set computed twice is a set that drifts.
 */
export function isClientFulfilledTool(tool: unknown): boolean {
  return (
    (tool as { metadata?: { client?: unknown } } | null | undefined)?.metadata?.client === true
  );
}
