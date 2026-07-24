import { GthConfig } from '#src/config.js';
import { GthCommand, StatusLevel } from '#src/core/types.js';
import { GthAbstractAgent } from '#src/core/GthAbstractAgent.js';
import { debugLog, debugLogObject } from '#src/utils/debugUtils.js';
import {
  buildSystemMessages,
  formatToolCalls,
  readChatPrompt,
  readCodePrompt,
  readExecPrompt,
} from '#src/utils/llmUtils.js';
import { getCurrentWorkDir } from '#src/utils/systemUtils.js';
import { isToolAllowed } from '#src/utils/toolMatching.js';
import {
  appendOsShellNote,
  appendCwdNote,
  appendCommitCoAuthorNote,
  appendModelContextNote,
  appendMcpServerInstructionsNote,
  resolveModelIdentity,
} from '#src/utils/systemPromptNotes.js';
import { isShellCommandFailedError } from '#src/core/shell/ShellCommandFailedError.js';
import { extractDebugRequestExtras, type DebugRequestExtras } from '#src/core/debugCapture.js';
import { promoteTextEmittedToolCallMessage } from '#src/core/toolCallRepair/index.js';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';

// AgentStreamEvent moved to #src/core/types.js (it is the shared renderer contract).
// Re-exported here for backwards compatibility with importers of this module.
export type { AgentStreamEvent } from '#src/core/types.js';

/**
 * GS2-36 — default cap for the tool-error retry budget: how many status:'error' tool results may
 * accrue back-to-back (no successful tool result in between) before the run is ended gracefully.
 * Small on purpose: it still lets the model try a couple of genuine recovery variants (the whole
 * point of feeding errors back — GS2-32 showed the model routes around a surfaced error in 1–2
 * tries) while stopping a runaway self-inflicted loop long before createAgent's coarse
 * recursionLimit backstop would.
 */
export const MAX_CONSECUTIVE_TOOL_ERRORS = 5;

/**
 * GS2-36 — the tool-error retry budget as a standalone, testable middleware factory (exported so the
 * real thing can be unit-tested and exercised in a real `createAgent` graph, mirroring
 * `createPathNamespaceCorrectionMiddleware`).
 *
 * Runs in `beforeModel` (like langchain's own `modelCallLimitMiddleware`): after the tools node has
 * appended its result(s) and before the next model call is spent, it walks the trailing messages and
 * counts CONSECUTIVE errored tool results — a `ToolMessage` with `status: 'error'` (the shape the
 * shell/MCP softeners produce; GthAbstractAgent maps `status==='error' → isError`). The walk skips
 * the assistant tool-call requests between rounds, and RESETS on the first successful tool result
 * (progress / diagnosis) or a Human/System message (a fresh user turn). Once the count reaches the
 * cap it returns `{ jumpTo: 'end', messages: [<action-oriented notice>] }`, ending the run without
 * spending another model call.
 *
 * Scope: counts `status: 'error'` results only. The recoverable fs error STRINGS
 * (`write_file`/`edit_file`/…) are `status: 'success'` by the write_file precedent, so a pure fs
 * error loop is deliberately NOT capped here — it stays bounded by the coarse `recursionLimit` and is
 * the remit of the loop-DETECTION node (EXT-36). Counting `status: 'error'` overall (not per-tool)
 * catches both same-tool and alternating-tool error loops with one robust rule.
 */
export function createToolErrorBudgetMiddleware(
  maxConsecutiveErrors: number = MAX_CONSECUTIVE_TOOL_ERRORS
) {
  return createMiddleware({
    name: 'GthLeanToolErrorBudget',
    beforeModel: {
      canJumpTo: ['end'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: (state: any) => {
        const messages: unknown[] = Array.isArray(state?.messages) ? state.messages : [];
        let consecutive = 0;
        let lastErrorContent = '';
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (ToolMessage.isInstance(msg)) {
            if (msg.status === 'error') {
              consecutive++;
              if (!lastErrorContent) {
                lastErrorContent = typeof msg.content === 'string' ? msg.content : '';
              }
            } else {
              // A successful tool result — the model is making progress / diagnosing, so the
              // unrecovered-error streak is broken. Stop the walk (reset).
              break;
            }
          } else if (AIMessage.isInstance(msg)) {
            // The assistant tool-call request that produced the error above; skip and keep counting.
            // GS2-72: this `continue` INTENTIONALLY also skips the budget's OWN injected terminal
            // notice (itself an AIMessage). If the run re-enters beforeModel on the same thread after
            // a jumpTo:'end' (a re-invoke on the same thread — e.g. the no-checkpointer degrade of
            // the string path's empty-stream fallback, or a later turn that keeps erroring), skipping
            // the notice lets the walk still reach the errored results and re-trip deterministically.
            // Do NOT special-case the notice to reset/break here — treating it as a fresh-turn
            // boundary would let the capped loop resume.
            continue;
          } else {
            // A Human/System message: a fresh user-turn boundary — earlier errors don't count.
            break;
          }
        }
        if (consecutive >= maxConsecutiveErrors) {
          const firstLine = (lastErrorContent.split('\n')[0] ?? '').slice(0, 300);
          const notice =
            `Stopped after ${consecutive} consecutive failed tool calls to avoid a retry loop that ` +
            'keeps spending tokens without making progress' +
            (firstLine ? ` (last error: ${firstLine})` : '') +
            '. Do not repeat the same call: inspect the error, then change your approach — different ' +
            'arguments, a narrower path, or a different tool — or report the blocker to the user.';
          return { jumpTo: 'end', messages: [new AIMessage(notice)] };
        }
        return undefined;
      },
    },
  });
}

/**
 * EXT-36 — default number of consecutive identical `(tool, args)` calls before the tool-loop guard
 * fires. Small on purpose: it must catch a genuine no-progress loop (a model re-issuing the SAME
 * call verbatim) while never tripping a legitimate one-off retry (2x). Kept below GS2-36's coarser
 * error cap (5) because a same-signature repeat is a stronger, more specific loop signal than "an
 * error happened again".
 */
export const DEFAULT_TOOL_LOOP_THRESHOLD = 3;

/**
 * EXT-36 — the additional_kwargs key stamped on a warn nudge so the SAME streak is nudged at most
 * once. The value is the offending signature; the guard suppresses a re-nudge idempotently by
 * finding a prior nudge carrying this key === the current signature WITHIN the current streak (the
 * backward walk stops at the streak boundary, so the check is per-streak, not per-session).
 */
export const TOOL_LOOP_GUARD_MARKER = 'gth_tool_loop_guard';

/** EXT-36 — resolved knobs for {@link createToolLoopGuardMiddleware}. */
export interface ToolLoopGuardOptions {
  /** Inject a (control-flow-free) nudge at threshold. Default ON. */
  warn?: boolean;
  /** End the run via `jumpTo:'end'` at threshold. Default OFF (opt-in). */
  halt?: boolean;
  /** Consecutive identical-signature repeats that trip the guard. Default {@link DEFAULT_TOOL_LOOP_THRESHOLD}. */
  threshold?: number;
}

/**
 * EXT-36 — normalise the `toolLoopGuard` config union (`false | true | { warn?, halt?, threshold? }`)
 * into concrete {@link ToolLoopGuardOptions}, applying the WARN-ON-by-default policy at the read site
 * (mirrors how `output.header` / `debugDump.redact` default with `!== false`, NOT in DEFAULT_CONFIG,
 * so the effective-config snapshot never churns).
 * - `false` → both modes off (a no-op guard);
 * - `true` / absent → warn on, halt off, default threshold;
 * - object → per-field, with warn defaulting ON and halt defaulting OFF.
 */
export function resolveToolLoopGuardOptions(
  setting: boolean | ToolLoopGuardOptions | undefined | null
): ToolLoopGuardOptions {
  if (setting === false) return { warn: false, halt: false };
  if (setting === true || setting === undefined || setting === null) return {};
  return { warn: setting.warn, halt: setting.halt, threshold: setting.threshold };
}

/**
 * EXT-36 — a deterministic, key-sorted stringify so `(tool, args)` signatures are stable regardless
 * of object key order. No-args (`{}`) collapses to `"{}"`, so identical no-arg repeats collide BY
 * DESIGN — that is exactly the loop signal. Known limitation: args carrying a volatile value (a
 * timestamp / uuid) make every call look distinct, so the guard cannot see that loop; volatile-key
 * stripping is deliberately NOT attempted (over-engineering for a rare, model-authored case).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/**
 * EXT-36 — the tool-loop guardrail as a standalone, testable middleware factory. The ORTHOGONAL
 * sibling of {@link createToolErrorBudgetMiddleware}: GS2-36 caps a consecutive-tool-ERROR streak;
 * this catches a **repeated identical `(tool, args)` / no-progress loop** — the same call re-issued
 * verbatim, whether it keeps erroring OR keeps "succeeding" with the same result (the fs-error-string
 * loop GS2-36's comment explicitly leaves to EXT-36).
 *
 * STATELESS (the critical trap): the factory runs ONCE per session, so a closure-held counter would
 * bleed across every turn. Like GS2-36 it holds NO state — each `beforeModel` recomputes the streak
 * from the message tail.
 *
 * Detection. A signature is `(tool_name, args_hash)`. Name + args live on `AIMessage.tool_calls[]`,
 * NOT on the `ToolMessage` (softener ToolMessages carry only content+tool_call_id+status), so each
 * `ToolMessage` is paired to its call by `tool_call_id === AIMessage.tool_calls[].id` to recover the
 * signature. The backward walk counts CONSECUTIVE ToolMessages with the SAME signature; a DIFFERENT
 * signature breaks the streak (the model tried something else = progress), and a Human/System message
 * is a fresh-turn boundary. Assistant messages (the tool-call requests AND this guard's own injected
 * nudge, both AIMessages) are skipped — so a nudge never resets the streak, letting HALT re-trip
 * deterministically. Known no-op (safe, never a false trip): a single AIMessage issuing PARALLEL tool
 * calls yields back-to-back differing signatures, which the walk reads as progress and resets.
 *
 * Two modes (composable):
 * - WARN (default ON, provably harmless): at threshold, return `{ messages: [nudge] }` with NO
 *   `jumpTo` — zero control-flow effect, so a false positive can never halt or reroute. The nudge is
 *   an AIMessage (NOT a mid-list SystemMessage, which ChatAnthropic rejects — GS2-21; and NOT a
 *   HumanMessage, which would need a special-case in the boundary rule): the walk already skips
 *   AIMessages, so it composes with zero special-casing, exactly like GS2-36's AIMessage notice.
 *   Re-fire throttle: because the walk re-runs every turn, a still-over-threshold signature is
 *   suppressed by finding this guard's own prior nudge (its {@link TOOL_LOOP_GUARD_MARKER}
 *   additional_kwargs === the signature) WITHIN the current streak → one nudge per signature per
 *   streak.
 * - HALT (opt-in only): at threshold, return `{ jumpTo: 'end', messages: [new AIMessage(reason)] }`
 *   — the same clean terminal GS2-36 uses (proven to stream cleanly, GS2-72). NEVER throws.
 */
export function createToolLoopGuardMiddleware(options: ToolLoopGuardOptions = {}) {
  const warn = options.warn ?? true;
  const halt = options.halt ?? false;
  const threshold = options.threshold ?? DEFAULT_TOOL_LOOP_THRESHOLD;
  return createMiddleware({
    name: 'GthLeanToolLoopGuard',
    beforeModel: {
      canJumpTo: ['end'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hook: (state: any) => {
        // `false` config resolves to warn:false + halt:false — a genuine no-op (fast bail).
        if (!warn && !halt) return undefined;
        const messages: unknown[] = Array.isArray(state?.messages) ? state.messages : [];

        // Recover each tool call's signature by id — name + args are on the AIMessage, not the
        // ToolMessage. One pass over all AIMessages builds the id → {sig, name} lookup.
        const callById = new Map<string, { sig: string; name: string }>();
        for (const msg of messages) {
          if (AIMessage.isInstance(msg) && Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const id = tc?.id;
              if (typeof id === 'string') {
                const name = typeof tc.name === 'string' ? tc.name : '';
                callById.set(id, { sig: `${name} ${stableStringify(tc.args ?? {})}`, name });
              }
            }
          }
        }

        // Walk the tail backward, counting consecutive identical signatures since the last boundary.
        let streak = 0;
        let currentSig: string | undefined;
        let currentName = '';
        let alreadyNudged = false;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (ToolMessage.isInstance(msg)) {
            const call = callById.get(msg.tool_call_id as string);
            // No paired call → cannot prove a repeat; treat as a boundary (never a false trip).
            if (!call) break;
            if (currentSig === undefined) {
              currentSig = call.sig;
              currentName = call.name;
              streak = 1;
            } else if (call.sig === currentSig) {
              streak++;
            } else {
              break; // different signature = the model tried something else = progress
            }
          } else if (AIMessage.isInstance(msg)) {
            // Skip the tool-call request AND this guard's own nudge (both AIMessages). Detecting the
            // nudge here scopes the throttle to the CURRENT streak: a boundary (or a differing
            // signature) breaks the walk before an older-streak nudge could be reached.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((msg as any).additional_kwargs?.[TOOL_LOOP_GUARD_MARKER] === currentSig) {
              alreadyNudged = true;
            }
            continue;
          } else {
            break; // Human/System message: a fresh user turn resets everything.
          }
        }

        if (currentSig === undefined || streak < threshold) return undefined;

        // HALT (opt-in): end the run cleanly — never a throw. Takes precedence over WARN.
        if (halt) {
          const notice =
            `Stopped after ${streak} identical calls to the \`${currentName}\` tool with the same ` +
            'arguments to avoid a loop that keeps spending tokens without making progress. ' +
            'The same call cannot yield a different result: change your approach — different ' +
            'arguments, a narrower step, or a different tool — or report the blocker to the user.';
          return { jumpTo: 'end', messages: [new AIMessage(notice)] };
        }

        // WARN (default): inject a control-flow-free nudge, once per signature per streak.
        if (alreadyNudged) return undefined;
        const nudge = new AIMessage({
          content:
            `You have called the \`${currentName}\` tool with the same arguments ${streak} times ` +
            'in a row without making new progress. Repeating an identical call cannot produce a ' +
            'different result — try a different approach (different arguments, a different tool, or ' +
            'a narrower step), or stop and tell the user what is blocking you.',
          additional_kwargs: { [TOOL_LOOP_GUARD_MARKER]: currentSig },
        });
        return { messages: [nudge] };
      },
    },
  });
}

/**
 * Lean agent: builds a standard `createAgent` (ReAct) graph. All run/stream/event
 * plumbing lives in {@link GthAbstractAgent}; this class only knows how to construct
 * the graph in {@link init}.
 */
export class GthLangChainAgent extends GthAbstractAgent {
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined
  ): Promise<void> {
    this.command = command;
    debugLog(`GthLangChainAgent.init called with command: ${command || 'default'}`);

    // Merge command-specific filesystem config if provided
    this.config = this.getEffectiveConfig(configIn, command);
    debugLogObject('Effective Config', {
      filesystem: this.config.filesystem,
      builtInTools: this.config.builtInTools,
      streamOutput: this.config.streamOutput,
      debugLog: this.config.debugLog,
    });

    this.headerStatus(`Workdir: ${getCurrentWorkDir()}`);

    if (this.config.modelDisplayName) {
      this.headerStatus(`Model: ${this.config.modelDisplayName}`);
    }

    // An empty allowedTools allow-list disables every tool. Skip resolution entirely so we
    // don't contact MCP servers (and trigger OAuth) just to discard the result.
    const allowedTools = this.config.allowedTools;
    const toolsDisabled = Array.isArray(allowedTools) && allowedTools.length === 0;
    if (toolsDisabled) {
      this.headerStatus(
        'Tool loading disabled by allowedTools: []; MCP/A2A servers will not be contacted. Omit allowedTools for no filtering.'
      );
    }

    // Resolve tools via resolver or fall back to config tools only
    debugLog('Resolving tools...');
    const resolvedTools =
      !toolsDisabled && this.resolvers?.resolveTools
        ? await this.resolvers.resolveTools(this.config, command)
        : [];
    debugLog(`Resolved tools loaded: ${resolvedTools.length}`);

    // Get user config tools
    const flattenedConfigTools = toolsDisabled
      ? []
      : this.extractAndFlattenTools(this.config.tools || []);
    debugLog(`User config tools loaded: ${flattenedConfigTools.length}`);

    // Combine all tools, then apply the allowedTools name allow-list when configured.
    let tools = [...resolvedTools, ...flattenedConfigTools];
    if (Array.isArray(allowedTools)) {
      // Filter named tools by the allow-list. Entries match by exact name, or glob-style when
      // they contain `*` (e.g. `mcp__unimarket__*`) — see isToolAllowed. ServerTools
      // (provider-native "magic objects" such as Anthropic web search) may have no `name`, so
      // they can never be referenced in the allow-list - drop-by-default would silently remove
      // them with no recourse. Retain such nameless tools instead; the allow-list is a name-based
      // filter and cannot target them.
      tools = tools.filter((tool) => !tool.name || isToolAllowed(tool.name, allowedTools));
    }

    if (tools.length > 0) {
      const toolNames = tools
        .map((tool) => tool.name)
        .filter((name) => name)
        .join(', ');
      this.headerStatus(`Loaded tools: ${toolNames}`);
      debugLog(`Total tools available: ${tools.length}`);
      debugLogObject('All Tools', toolNames.split(', '));
    }

    // Create the React agent
    debugLog('Creating React agent...');

    // Resolve middleware via resolver or fall back to empty
    const configuredMiddleware = this.resolvers?.resolveMiddleware
      ? await this.resolvers.resolveMiddleware(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.config.middleware as any[] | undefined,
          this.config
        )
      : [];

    // Add tool call status update middleware
    const statusUpdate = this.statusUpdate;
    const toolCallStatusMiddleware = createMiddleware({
      name: 'GthMiddlewareToolCallStatusUpdate',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterModel: (state: any) => {
        debugLogObject('postModel state', state);
        const lastMessage = state.messages[state.messages.length - 1];
        if (
          AIMessage.isInstance(lastMessage) &&
          lastMessage.tool_calls &&
          lastMessage.tool_calls?.length > 0
        ) {
          statusUpdate(
            StatusLevel.INFO,
            `\nRequested tools: ${formatToolCalls(lastMessage.tool_calls)}\n`
          );
        }
        return state;
      },
    });

    // EXT-35: promote a text-emitted tool call to a native tool_call so the loop doesn't stall.
    // Small/local models (Gemma, lmstudio, gpt-oss) often serialise a tool call as assistant TEXT
    // instead of a native `tool_call`; the ReAct router then sees no tool_calls on the last message
    // and ENDS the turn ("no tool calls = done"). This afterModel hook runs ONLY when the last
    // AIMessage carries no native tool_calls (the native happy path is byte-for-byte untouched):
    // it parses a STANDALONE text-emitted call (bracket / <function=…> / Harmony), gated HARD by the
    // bound-tool allow-list + a payload-size cap + standalone-only, and — when it promotes — returns
    // the rewritten message. Preserving the original message id is load-bearing: LangGraph's
    // message-state reducer merges by id, so a same-id message REPLACES the model's text message in
    // graph state; the router then sees the native tool_calls and routes to the tools node, so the
    // loop continues instead of concluding done. Ported from the openclaw tool-call-repair reference.
    // Bound-tool names are the allow-list; an empty toolset promotes nothing (prose-safe default).
    const repairToolNames = new Set(
      tools.map((t) => t.name).filter((name): name is string => Boolean(name))
    );
    const toolCallRepairMiddleware = createMiddleware({
      name: 'GthMiddlewareToolCallRepair',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterModel: (state: any) => {
        const lastMessage = state.messages[state.messages.length - 1];
        if (!AIMessage.isInstance(lastMessage)) return state;
        if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) return state;
        const promoted = promoteTextEmittedToolCallMessage(lastMessage, {
          allowedToolNames: repairToolNames,
        });
        if (!promoted) return state;
        debugLog(
          `Repaired a text-emitted tool call into a native tool_call: ${formatToolCalls(
            promoted.tool_calls ?? []
          )}`
        );
        // Replace-by-id (same id) so the reducer swaps the text message rather than appending.
        return { messages: [promoted] };
      },
    });

    // EXT-21: lean-path sibling of the deep agent's GthDeepShellExitSoftening (GthDeepAgent.ts).
    // `exec` / `ask --write` route through this lean `createAgent` graph, whose run_* shell/dev
    // tools (GthDevToolkit.executeCommand) THROW a ShellCommandFailedError on a non-zero exit or a
    // timeout-kill. langchain's default ToolNode would catch that throw into a ToolMessage but leave
    // it status:'success' (✓) — misreporting a failed command. Catch it here at the tool-wrap layer
    // and return an error ToolMessage that PRESERVES the full stdout/stderr body: the model's
    // observation is unchanged except the status flips to 'error', which drives the ✗ (isError)
    // glyph (GthAbstractAgent maps status==='error' → isError). Returning a ToolMessage (rather than
    // rethrowing) keeps it a normal, observed tool result — no run-abort, no retry loop. Recognised
    // via isShellCommandFailedError (instanceof + structural fallback) since core cannot import the
    // throw site in the agent package. Every OTHER throw is rethrown untouched so genuine failures
    // and control-flow (GraphInterrupt / AbortError) still surface.
    const shellExitSoftening = createMiddleware({
      name: 'GthLeanShellExitSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (isShellCommandFailedError(e)) {
            debugLog(
              `Softened shell/dev command failure (exit ${e.exitCode ?? 'timeout'}) into an ` +
                `error ToolMessage for '${e.command}'`
            );
            return new ToolMessage({
              content: e.output,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tool_call_id: (request.toolCall as any)?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    // MCP tool-execution errors are spec-compliant RESULTS, not fatal faults. Per the MCP spec
    // (2025-11-25 & draft, "Server › Tools › Error Handling"), a tool that hits an API failure, an
    // input-validation problem, or a business-logic error (e.g. a disabled capability) returns a
    // normal tools/call result with `isError: true`, and the CLIENT *SHOULD* hand that error to the
    // model so it can self-correct. `@langchain/mcp-adapters` instead surfaces such a result by
    // THROWING a ToolException at call time (its `_convertCallToolResult`). Because we install a
    // wrapToolCall middleware, langchain's ToolNode treats any error a middleware rethrows as a fatal
    // "middleware error" (`errorFromMiddleware && handleToolErrors !== true` → throw) and aborts the
    // whole turn instead of relaying the error to the model — the opposite of the spec's client
    // SHOULD. This middleware closes that gap: it catches a thrown ToolException and RETURNS it as a
    // status:'error' ToolMessage (→ isError → ✗), so the model observes the error and can retry or
    // explain (matching the non-stream invoke path's ToolException handling). Scope & safety: matched
    // by name === 'ToolException' (the adapter's marker), so GraphInterrupt and every non-MCP throw
    // fall through the final rethrow untouched. The adapter ALSO wraps a call-time AbortError into a
    // ToolException (its `_callTool` catch-all), so we RETHROW when the run's abort signal is set —
    // otherwise softening here would swallow user cancellation that ToolNode's own `signal?.aborted`
    // guard normally enforces (bypassed once we handle the error in middleware). MCP connect/auth
    // (401/403) and load failures are handled at CONNECT time (resolvers.ts throwOnLoadError +
    // onConnectionError), not here, so they stay fatal as intended.
    const mcpToolErrorSoftening = createMiddleware({
      name: 'GthMcpToolErrorSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (
            e instanceof Error &&
            e.name === 'ToolException' &&
            !request.runtime?.signal?.aborted
          ) {
            debugLog(`Softened MCP tool error into an error ToolMessage: ${e.message}`);
            return new ToolMessage({
              content: e.message,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tool_call_id: (request.toolCall as any)?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    // Debug-capture middleware (TUI `/debug` panel) — the lean-path sibling of GthDeepAgent's.
    // Always installed but lazy: it reads `this.debugCapture` per call, so until the TUI attaches a
    // sink it is a transparent pass-through (one extra await around the handler — the normal path
    // pays nothing). `request.messages` is the real history at call time; `handler(request)`
    // resolves to the AIMessage response. Without this, the TUI's System-prompt/Tools/Chat-history
    // tabs stay empty on the (now default) lean backend.
    const getDebugCapture = () => this.debugCapture;
    const debugCaptureMiddleware = createMiddleware({
      name: 'GthMiddlewareDebugCapture',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      wrapModelCall: async (request: any, handler: any) => {
        // GS2-56: stash the always-on last-model-request snapshot (extras + as-sent messages)
        // UNCONDITIONALLY — before the `capture` short-circuit — so `/debug-dump` has the full
        // model input even when no TUI `/debug` sink is attached (a non-TUI surface, or `/debug`
        // never opened). Guarded: snapshotting must never break the run. The computed extras are
        // reused for the sink below so extraction runs once.
        let extras: DebugRequestExtras | undefined;
        try {
          extras = extractDebugRequestExtras(request);
          this.setLastModelRequest(request.messages, extras);
        } catch {
          /* the always-on snapshot must never break the run */
        }
        const capture = getDebugCapture();
        if (!capture) return handler(request);
        try {
          capture.onRequest?.(request.messages, extras);
        } catch {
          /* a debug sink must never break the run */
        }
        const response = await handler(request);
        try {
          capture.onResponse?.(response);
        } catch {
          /* a debug sink must never break the run */
        }
        return response;
      },
    });

    // shellExitSoftening FIRST so it is the outermost wrapToolCall — it must see the raw
    // ShellCommandFailedError throw before any user-configured middleware could transform it.
    // mcpToolErrorSoftening sits right after it, still outboard of any user-configured middleware so
    // it sees the raw ToolException before a user wrapToolCall could transform it. Order between the
    // two softeners is not load-bearing: they catch DISJOINT conditions (a ShellCommandFailedError
    // vs a name==='ToolException') and each rethrows what it doesn't recognize, so neither can
    // swallow the other.
    // EXT-35: toolCallRepairMiddleware sits AFTER toolCallStatusMiddleware in the array. afterModel
    // nodes execute in reverse array order (the later one runs first), so repair runs BEFORE the
    // status middleware — a promoted call is therefore reported by the "Requested tools:" line too.
    // Correctness (routing) is order-independent: the router reads final graph state after all
    // afterModel nodes, and repair replaces-by-id, so the promoted tool_calls are present regardless.
    // GS2-36: cap a self-inflicted tool-error loop. The shell/MCP softeners above turn a failed
    // run_*/MCP call into a status:'error' ToolMessage the model observes; a model that keeps
    // re-issuing the same failing call would drain tokens turn after turn. This beforeModel guard
    // ends the run gracefully once MAX_CONSECUTIVE_TOOL_ERRORS such results accrue with no successful
    // tool result in between — a tighter, error-specific complement to createAgent's coarse
    // recursionLimit (loop DETECTION proper is the separate EXT-36). Placed after the softeners and
    // before user middleware so it can't be bypassed. Lean backend only (per GS2-36 scope); the deep
    // backend keeps its own recursionLimit backstop.
    const toolErrorBudget = createToolErrorBudgetMiddleware();

    // EXT-36: the ORTHOGONAL loop guard — repeated identical (tool, args) / no-progress detection,
    // the sibling of GS2-36's error budget above. It catches the case GS2-36 explicitly leaves open:
    // a model re-issuing the SAME call verbatim, whether it keeps erroring or keeps "succeeding" with
    // the same result. Placed at index 3, immediately AFTER toolErrorBudget (index 2) and BEFORE user
    // middleware: beforeModel hooks run in forward order with jumpTo short-circuiting, so on a
    // simultaneous trip GS2-36's coarse error cap wins first and EXT-36 fires on its own
    // signature-repeat threshold otherwise; keeping it outboard of user middleware means it can't be
    // bypassed. WARN is on by default (control-flow-free nudge); HALT is opt-in. Default WARN-ON is
    // applied here at the read site (resolveToolLoopGuardOptions), NOT in DEFAULT_CONFIG, so the
    // effective-config snapshot never churns. Lean backend only (like GS2-36); the deep array is
    // untouched. `toolLoopGuard: false` resolves to a no-op guard (still installed at index 3 so the
    // placement is stable).
    const toolLoopGuard = createToolLoopGuardMiddleware(
      resolveToolLoopGuardOptions(this.config.toolLoopGuard)
    );

    const middleware = [
      shellExitSoftening,
      mcpToolErrorSoftening,
      toolErrorBudget,
      toolLoopGuard,
      ...configuredMiddleware,
      toolCallStatusMiddleware,
      toolCallRepairMiddleware,
      debugCaptureMiddleware,
    ];

    this.headerStatus(`Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`);

    // GS2-21: compose gsloth's system prompt (backstory + guidelines + per-command mode prompt +
    // system prompt) EXACTLY as GthDeepAgent does, so identity profiles and `.gsloth.*.md` are
    // honored on the lean backend too. Previously the lean agent gave the model NO system prompt
    // (only the deep agent composed one), so `system-prompt.md` / the guidelines never reached
    // the model — the robot (agent.backend: lean) behaved as if it never got its guidelines.
    // This is passed to createAgent as `systemPrompt`, which langchain applies as the agent's
    // static system message on every turn — NOT injected as a separate mid-conversation
    // SystemMessage (a non-first system message that Anthropic rejects). 'code' uses the code-mode
    // prompt; 'exec' uses the exec-mode prompt; chat/api/others use the chat prompt.
    const modePrompt =
      this.command === 'code'
        ? readCodePrompt(this.config)
        : this.command === 'exec'
          ? readExecPrompt(this.config)
          : readChatPrompt(this.config);
    const systemMessages = buildSystemMessages(this.config, modePrompt);
    const baseSystemPrompt =
      typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;

    // GS2-27: in `code` mode append the SHARED code-mode notes the deep backend has always carried
    // — the real-cwd / path-model note (EXT-13) and the OS + shell-dialect note (EXT-26). Both are
    // backend-agnostic (the lean backend also exposes `run_shell_command` and runs on the real-fs
    // cwd), so composing them here closes the deep-only drift that left a lean code session with no
    // cwd value and no shell-dialect guidance (e.g. on Windows). The deepagents virtual-fs-namespace
    // notes stay deep-only (lean never runs virtualMode). Same order the deep backend's real-path
    // branch uses: cwd note first, OS/shell note last. `getCurrentWorkDir()` is already read above
    // for the status line, so the value is free.
    // GS2-35: also append the commit co-authoring rule so the agent credits Gaunt Sloth (config
    // `commit.coAuthor`, defaulting to the Gaunt Sloth account) in the `Co-Authored-By` trailer and
    // never the underlying model name. Same code-mode gate as the shell/cwd notes — the git-commit
    // capability rides on `run_shell_command`, which is a code-mode tool.
    const codeNotesPrompt =
      this.command === 'code'
        ? appendCommitCoAuthorNote(
            appendOsShellNote(appendCwdNote(baseSystemPrompt, getCurrentWorkDir())),
            this.config.commit?.coAuthor
          )
        : baseSystemPrompt;

    // GS2-34: inject the resolved provider:model identity so the agent knows which model is serving
    // it (to answer "what model are you?" and reason about its own capabilities/limits). Composed
    // OUTSIDE the code-mode gate above — unlike the cwd/os-shell/commit notes, that question can
    // arise in ANY mode (chat/ask/code/exec), so the identity must be visible everywhere. Config
    // opt-out via `injectModelContext: false` (default ON, defaulted here at the read site); when
    // off — or when no model resolves — nothing is appended and the prompt is exactly as before.
    // Backend-agnostic: the deep backend composes the same note (GS2-27 parity). The GS2-6
    // capability note is a deferred follow-up (bare provider:model identity only for now).
    const modelContextPrompt =
      this.config.injectModelContext !== false
        ? appendModelContextNote(codeNotesPrompt, resolveModelIdentity(this.config))
        : codeNotesPrompt;

    // EXT-32: inject each connected MCP server's discovery `instructions` (captured during tool
    // resolution) into the prompt — fenced + per-server-labelled as untrusted server-provided
    // context. Mode-independent: MCP tools load in every mode, so their usage guidance applies in
    // every mode (not just `code`). Empty/absent capture (or a resolver without the accessor) adds
    // nothing. Composed through this shared path so it reaches the lean AND deep backends alike.
    // When tools are disabled, resolveTools is skipped entirely (no MCP contact), so a REUSED
    // resolver could still hold a prior run's capture — gate on toolsDisabled so no stale
    // instructions leak into a tools-disabled session.
    const mcpInstructions = toolsDisabled
      ? []
      : (this.resolvers?.getMcpServerInstructions?.() ?? []);
    const systemPrompt = appendMcpServerInstructionsNote(modelContextPrompt, mcpInstructions);

    // Create agent with configured middleware. Only pass systemPrompt when non-empty so we never
    // hand createAgent an empty system message.
    this.agent = createAgent({
      model: this.config.llm,
      tools,
      middleware,
      checkpointer,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    debugLog('React agent created successfully');
  }
}
