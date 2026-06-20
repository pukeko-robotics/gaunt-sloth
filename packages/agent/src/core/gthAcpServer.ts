/**
 * @packageDocumentation
 * Thin wrapper over `deepagents-acp`'s `DeepAgentsServer` that fixes how its filesystem backend is
 * rooted, since 0.1.12 gets both the location and the path semantics wrong for an IDE-hosted agent.
 *
 * 1. **Per-session root.** deepagents-acp roots its backend once at `workspaceRoot ?? process.cwd()`
 *    and IGNORES the `cwd` carried by every ACP `session/new` request. An ACP host (Zed, JetBrains)
 *    spawns one long-lived agent subprocess and passes the real project root per session, so we
 *    re-root the backend to `session/new.cwd`.
 * 2. **Virtual-fs semantics.** deepagents-acp builds its backend WITHOUT `virtualMode`, so `/`
 *    resolves to the OS root and `ls /` lists the whole machine — but deepagents' filesystem prompt
 *    tells the model `/` is the workspace root (the convention the local runner uses via
 *    `FilesystemBackend({ virtualMode: true })`). We switch the backend into virtual-fs mode so
 *    `'/'`-rooted paths are workspace-relative.
 *
 * The server's connection handler dispatches `this.handleNewSession(params, conn)` dynamically, so
 * we patch that instance method before `start()`. Both fixes reach into deepagents-acp internals and
 * are guarded so a shape change degrades to a no-op rather than throwing; if a future deepagents-acp
 * honors session cwd / virtual mode itself, this becomes a harmless re-assert.
 */

import { DeepAgentsServer, type DeepAgentsServerOptions } from 'deepagents-acp';
import { resolve } from 'node:path';
import { debugLog } from '@gaunt-sloth/core/utils/debugUtils.js';

// deepagents-acp keeps a private `acpBackends: Map<agentName, ACPFilesystemBackend>`; the backend
// roots its local ls/glob/grep at `this.cwd` (deepagents' FilesystemBackend base) and resolves
// paths via `virtualMode` (ls/glob/grep) and its own `resolveAbsPath` (the ACP read/write proxy).
// We reach those internals — guarded so a shape change degrades to a no-op rather than throwing.
interface ReRootableBackend {
  cwd?: string;
  virtualMode?: boolean;
  resolveAbsPath?: (filePath: string) => string;
}
interface AcpServerInternals {
  acpBackends?: Map<string, ReRootableBackend>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleNewSession?: (params: any, conn: any) => Promise<any>;
}

/**
 * Put an ACP filesystem backend into deepagents' virtual-fs mode so `'/'`-rooted paths are
 * workspace-relative (clamped under `cwd`), matching deepagents' prompt and the local runner.
 *
 * `virtualMode` covers the methods that route through `resolvePath` (ls) and the inline checks
 * (glob/grep). The ACP read/write proxy uses its own `resolveAbsPath`, which ignores `virtualMode`,
 * so override that too so proxied reads/writes hit the workspace, not the OS root.
 */
function configureVirtualFs(backend: ReRootableBackend): void {
  backend.virtualMode = true;
  backend.resolveAbsPath = (filePath: string): string =>
    resolve(backend.cwd ?? process.cwd(), String(filePath).replace(/^\/+/, ''));
}

/**
 * Construct and start a deepagents-acp server that roots its filesystem backend at each ACP
 * session's `cwd` and runs it in virtual-fs mode (so `/` is the workspace, not the OS root).
 * Resolves once the stdio transport is listening.
 */
export async function startGthAcpServer(
  options: DeepAgentsServerOptions
): Promise<DeepAgentsServer> {
  const server = new DeepAgentsServer(options);
  const internals = server as unknown as AcpServerInternals;

  const original = internals.handleNewSession;
  if (typeof original === 'function') {
    const bound = original.bind(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    internals.handleNewSession = async (params: any, conn: any) => {
      const result = await bound(params, conn);
      const backends = internals.acpBackends;
      const cwd =
        typeof params?.cwd === 'string' && params.cwd.length > 0 ? resolve(params.cwd) : undefined;
      if (backends && backends.size > 0) {
        for (const backend of backends.values()) {
          if (!backend || typeof backend !== 'object') continue;
          if (cwd) backend.cwd = cwd;
          configureVirtualFs(backend);
        }
        debugLog(`ACP session: virtual fs, root ${cwd ?? '[startup workspace]'}`);
      }
      return result;
    };
  } else {
    debugLog('deepagents-acp handleNewSession not found to patch; session fs rooting disabled');
  }

  await server.start();
  return server;
}
