/**
 * @packageDocumentation
 * ACP (Agent Client Protocol) server entry for the Gaunt Sloth deep agent.
 *
 * This is a parallel front-door to the AG-UI server ({@link startAgUiServer}); both expose
 * the SAME {@link GthDeepAgent}. AG-UI stays the robot-controller path; ACP is an additional
 * way to drive Galvanized Pukeko from an ACP host (Zed, JetBrains, a future Pukeko client).
 *
 * It reuses {@link GthDeepAgent.buildDeepAgentParams} so tool resolution (with the filesystem
 * disabled so deepagents owns fs access), the `.aiignore`/filesystem→permission mapping and the
 * fs-denial-softening middleware are identical to the local runner path. `deepagents-acp`
 * supplies the rest of the coding-agent surface itself: a per-session `ACPFilesystemBackend`
 * (proxying reads/writes through the ACP client so unsaved editor buffers are visible), the
 * checkpointer, interactive `session/request_permission` gating, and tool-call/plan reporting.
 */

import type { GthConfig } from '@gaunt-sloth/core/config.js';
import type { GthCommand, StatusUpdateCallback } from '@gaunt-sloth/core/core/types.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { getCurrentWorkDir, stderr } from '@gaunt-sloth/core/utils/systemUtils.js';
import { buildSystemMessages, readCodePrompt } from '@gaunt-sloth/core/utils/llmUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { startServer } from 'deepagents-acp';
import { GthDeepAgent } from '#src/core/GthDeepAgent.js';
import { createResolvers } from '#src/resolvers.js';

export interface StartAcpServerOptions {
  /** Agent name advertised to the ACP client (used for session routing). */
  name?: string;
  /** Human-readable description shown to ACP clients when listing agents. */
  description?: string;
  /** gsloth command whose config/prompt to apply (defaults to `'code'`, the full-fs agent). */
  command?: GthCommand;
}

/**
 * ACP-side status routing: the ACP protocol owns stdout (JSON-RPC framing), so agent
 * status/info must never touch it. Route everything to stderr.
 */
const acpStatusUpdate: StatusUpdateCallback = (_level: StatusLevel, message: string): void => {
  stderr.write(`${message}\n`);
};

/**
 * Start the Gaunt Sloth deep agent as an ACP server over stdio.
 *
 * Resolves once the stdio transport is listening; the process then stays alive serving the
 * ACP host until it is terminated. The returned promise rejecting means startup failed.
 *
 * NOTE: deepagents-acp 0.1.12 does NOT forward `permissions` to `createDeepAgent` — on the ACP
 * path fs gating is delegated to the host's interactive permission prompts, not gsloth's
 * `.aiignore`→permissions mapping. `permissions` is still passed here for forward-compatibility
 * (if a later deepagents-acp forwards it, gsloth's mapping applies with no change here).
 */
export async function startAcpServer(
  config: GthConfig,
  options: StartAcpServerOptions = {}
): Promise<void> {
  const command: GthCommand = options.command ?? 'code';

  const agent = new GthDeepAgent(acpStatusUpdate, createResolvers());
  const params = await agent.buildDeepAgentParams(command, config);

  // Compose gsloth's system prompt (backstory + guidelines + code-mode prompt + system prompt)
  // so the ACP agent honors `.gsloth.*.md`. On the runner path these are sent as SystemMessages
  // with the first turn; ACP has no per-turn hook, so set the agent's `systemPrompt` instead.
  const systemMessages = buildSystemMessages(config, readCodePrompt(config));
  const systemPrompt =
    typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;

  debugLog(`Starting ACP server (command: ${command}, workspace: ${getCurrentWorkDir()})`);

  await startServer({
    agents: {
      name: options.name ?? 'gaunt-sloth',
      description: options.description ?? 'Gaunt Sloth deep coding agent',
      model: params.model,
      tools: params.tools,
      systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware: params.middleware as any,
      // Forward-compat: ignored by deepagents-acp 0.1.12 (the host gates fs interactively).
      permissions: params.permissions,
    },
    workspaceRoot: getCurrentWorkDir(),
  });
}
