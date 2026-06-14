import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { type GthCommand, StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { debugLog, debugLogObject } from '@gaunt-sloth/core/utils/debugUtils.js';
import { formatToolCalls } from '@gaunt-sloth/core/utils/llmUtils.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { AIMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import { buildPermissions, FILESYSTEM_TOOL_NAMES } from '#src/core/deepAgentPermissions.js';

/**
 * Deep agent: builds a `createDeepAgent` graph (deepagents). All run/stream/event
 * plumbing lives in {@link GthAbstractAgent}; this class only knows how to construct
 * the graph in {@link init}.
 *
 * Differences from the lean {@link GthLangChainAgent}:
 * - deepagents provides the filesystem tools (`read_file`/`write_file`/`edit_file`/
 *   `ls`/`glob`/`grep`/`execute`) via its own middleware, backed by a
 *   {@link FilesystemBackend}. gsloth's `.aiignore` + `filesystem` config are mapped
 *   onto deepagents `permissions` (see {@link buildPermissions}). Any resolved tool
 *   that reuses a deepagents filesystem-tool name is therefore superseded and dropped
 *   (`createDeepAgent` would otherwise throw on the collision).
 * - todos / subagents / summarization come from deepagents' standard middleware.
 */
export class GthDeepAgent extends GthAbstractAgent {
  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined
  ): Promise<void> {
    this.command = command;
    debugLog(`GthDeepAgent.init called with command: ${command || 'default'}`);

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

    // Get user config tools (toolkit-flattened; client tools get interrupt() stubs)
    const flattenedConfigTools = toolsDisabled
      ? []
      : this.extractAndFlattenTools(this.config.tools || []);
    debugLog(`User config tools loaded: ${flattenedConfigTools.length}`);

    // Combine all tools, then apply the allowedTools name allow-list when configured.
    let tools = [...resolvedTools, ...flattenedConfigTools];
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      tools = tools.filter((tool) => !tool.name || allowed.has(tool.name));
    }

    // deepagents owns the filesystem tools. Drop any resolved tool that reuses one of
    // their names (e.g. gsloth's filesystem toolkit) so createDeepAgent does not throw
    // on the collision; the deep agent provides equivalents via its fs middleware.
    const reserved = new Set<string>(FILESYSTEM_TOOL_NAMES);
    const superseded = tools.filter((tool) => tool.name && reserved.has(tool.name));
    const passThroughTools = tools.filter((tool) => !tool.name || !reserved.has(tool.name));
    if (superseded.length > 0) {
      const names = superseded.map((tool) => tool.name).join(', ');
      this.statusUpdate(
        StatusLevel.INFO,
        `Deep agent provides built-in filesystem tools; superseding: ${names}`
      );
    }

    if (passThroughTools.length > 0) {
      const toolNames = passThroughTools
        .map((tool) => tool.name)
        .filter((name) => name)
        .join(', ');
      this.statusUpdate(StatusLevel.INFO, `Loaded tools: ${toolNames}`);
      debugLog(`Total tools available: ${passThroughTools.length}`);
      debugLogObject('All Tools', toolNames.split(', '));
    }

    debugLog('Creating deep agent...');

    // Resolve middleware via resolver or fall back to empty. These are applied AFTER
    // deepagents' standard middleware (todos, subagents, summarization, filesystem).
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

    const middleware = [...configuredMiddleware, toolCallStatusMiddleware];
    this.statusUpdate(
      StatusLevel.INFO,
      `Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`
    );

    // Map gsloth's .aiignore + filesystem mode onto deepagents permission rules.
    const permissions = buildPermissions({
      filesystem: this.config.filesystem,
      aiignore: this.config.aiignore,
    });
    debugLogObject('Filesystem permissions', permissions);

    const backend = new FilesystemBackend({ rootDir: getCurrentWorkDir(), virtualMode: true });

    this.agent = createDeepAgent({
      model: this.config.llm,
      tools: passThroughTools as StructuredToolInterface[],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware: middleware as any,
      backend,
      permissions,
      checkpointer,
    });
    debugLog('Deep agent created successfully');
  }
}
