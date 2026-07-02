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
import { getProcessCwd, stderr } from '@gaunt-sloth/core/utils/systemUtils.js';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';
import { GthDeepAgent } from '#src/core/GthDeepAgent.js';
import { startGthAcpServer } from '#src/core/gthAcpServer.js';
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
 * `.aiignore`→permissions mapping. `permissions` is still passed here for forward-compatibility.
 * EXT-13 caveat: the ACP backend keeps `virtualMode` ON (`/` = workspace, see gthAcpServer), while
 * EXT-13 re-anchored gsloth's default permissions at the REAL absolute cwd for the local runner. So
 * if a future deepagents-acp DOES forward these rules they would not match the virtual `/`-rooted
 * paths the ACP backend hands them — revisit the mapping (or the ACP backend's mode) at that point.
 */
export async function startAcpServer(
  config: GthConfig,
  options: StartAcpServerOptions = {}
): Promise<void> {
  const command: GthCommand = options.command ?? 'code';

  // ACP is structurally deep-only: it calls GthDeepAgent.buildDeepAgentParams and hands the
  // extracted params to the deepagents-acp server. There is no lean analog, so an explicit
  // `agent.backend: 'lean'` cannot be honored here — reject it loudly rather than silently
  // running deep despite the request (B5 selector, kept honest at the ACP entry).
  if (config.agent?.backend === 'lean') {
    throw new Error(
      "agent.backend: 'lean' is not supported by the ACP server — ACP relies on the deep " +
        '(deepagents) backend. Remove the lean setting, or use the AG-UI/api server for a lean agent.'
    );
  }

  const agent = new GthDeepAgent(acpStatusUpdate, createResolvers());
  const params = await agent.buildDeepAgentParams(command, config);

  // gsloth's composed system prompt (backstory + guidelines + per-command mode prompt + system
  // prompt) comes back on `params.systemPrompt` — the SAME prompt the local runner passes to
  // createDeepAgent. ACP has no per-turn hook, so it sets the agent's `systemPrompt` here.
  const systemPrompt = params.systemPrompt;

  // workspaceRoot is only the startup default: startGthAcpServer re-roots the filesystem backend
  // to each ACP session's `cwd` (the IDE's project root). Use the raw process cwd, not
  // getCurrentWorkDir() — its INIT_CWD preference leaks stale paths into this long-lived subprocess.
  const workspaceRoot = getProcessCwd();
  debugLog(`Starting ACP server (command: ${command}, startup workspace: ${workspaceRoot})`);

  await startGthAcpServer({
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
    workspaceRoot,
  });
}
