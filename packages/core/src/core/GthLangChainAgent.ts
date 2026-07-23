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
import { extractDebugRequestExtras } from '#src/core/debugCapture.js';
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
        const capture = getDebugCapture();
        if (!capture) return handler(request);
        try {
          capture.onRequest?.(request.messages, extractDebugRequestExtras(request));
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

    const middleware = [
      shellExitSoftening,
      mcpToolErrorSoftening,
      toolErrorBudget,
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
