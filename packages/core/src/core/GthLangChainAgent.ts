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
import { isShellCommandFailedError } from '#src/core/shell/ShellCommandFailedError.js';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { createAgent, createMiddleware } from 'langchain';

// AgentStreamEvent moved to #src/core/types.js (it is the shared renderer contract).
// Re-exported here for backwards compatibility with importers of this module.
export type { AgentStreamEvent } from '#src/core/types.js';

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

    this.statusUpdate(StatusLevel.INFO, `Workdir: ${getCurrentWorkDir()}`);

    if (this.config.modelDisplayName) {
      this.statusUpdate(StatusLevel.INFO, `Model: ${this.config.modelDisplayName}`);
    }

    // An empty allowedTools allow-list disables every tool. Skip resolution entirely so we
    // don't contact MCP servers (and trigger OAuth) just to discard the result.
    const allowedTools = this.config.allowedTools;
    const toolsDisabled = Array.isArray(allowedTools) && allowedTools.length === 0;
    if (toolsDisabled) {
      this.statusUpdate(
        StatusLevel.INFO,
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
      const allowed = new Set(allowedTools);
      // Filter named tools by the allow-list. ServerTools (provider-native "magic objects" such
      // as Anthropic web search) may have no `name`, so they can never be referenced in the
      // allow-list - drop-by-default would silently remove them with no recourse. Retain such
      // nameless tools instead; the allow-list is a name-based filter and cannot target them.
      tools = tools.filter((tool) => !tool.name || allowed.has(tool.name));
    }

    if (tools.length > 0) {
      const toolNames = tools
        .map((tool) => tool.name)
        .filter((name) => name)
        .join(', ');
      this.statusUpdate(StatusLevel.INFO, `Loaded tools: ${toolNames}`);
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

    // shellExitSoftening FIRST so it is the outermost wrapToolCall — it must see the raw
    // ShellCommandFailedError throw before any user-configured middleware could transform it.
    const middleware = [shellExitSoftening, ...configuredMiddleware, toolCallStatusMiddleware];

    this.statusUpdate(
      StatusLevel.INFO,
      `Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`
    );

    // GS2-21: compose gsloth's system prompt (backstory + guidelines + per-command mode prompt +
    // system prompt) EXACTLY as GthDeepAgent does, so identity profiles and `.gsloth.*.md` are
    // honored on the lean backend too. Previously the lean agent gave the model NO system prompt
    // (only the deep agent composed one), so `system-prompt.md` / projectGuidelines never reached
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
    const systemPrompt =
      typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;

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
