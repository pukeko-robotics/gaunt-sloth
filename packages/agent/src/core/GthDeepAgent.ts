import type { GthConfig, GthDevToolsConfig } from '@gaunt-sloth/core/config.js';
import { isShellToolEnabled } from '@gaunt-sloth/core/config.js';
import { GthAbstractAgent } from '@gaunt-sloth/core/core/GthAbstractAgent.js';
import { type GthCommand, StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { debugLog, debugLogObject } from '@gaunt-sloth/core/utils/debugUtils.js';
import {
  buildSystemMessages,
  formatToolCalls,
  readChatPrompt,
  readCodePrompt,
  readExecPrompt,
} from '@gaunt-sloth/core/utils/llmUtils.js';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { GraphInterrupt } from '@langchain/langgraph';
import { createMiddleware, type InterruptOnConfig } from 'langchain';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import {
  buildPermissions,
  FILESYSTEM_TOOL_NAMES,
  guardFilesystemBackend,
  type FilesystemPermission,
} from '#src/core/deepAgentPermissions.js';
import type { DebugCapture, DebugRequestExtras, DebugToolDef } from '#src/core/debugCapture.js';
import { ShellCommandFailedError } from '#src/tools/GthDevToolkit.js';

/**
 * Decide whether the deepagents filesystem backend runs in virtualMode.
 *
 * virtualMode (cwd→`/`, virtual permissions) is now the DEFAULT on every platform — it is
 * deepagents' native, cross-platform-uniform behavior and the pre-EXT-13 known-good path. This
 * supersedes the EXT-13 default (which ran POSIX in real-path mode to share ONE namespace with the
 * shell). Under virtualMode the fs tools' virtual `/` root and `run_shell_command`'s real OS paths
 * DIVERGE, so the shell tool is made virtualMode-aware (an augmented description plus a forced
 * acknowledgement parameter — see GthDevToolkit) and the EXT-22 path-namespace notes/correction
 * apply on all platforms, not just Windows.
 *
 * Two cases still force real-path mode instead of virtual:
 *  - The real cwd is not POSIX `/`-rooted (e.g. Windows `D:\...`). deepagents' permission layer
 *    (`validatePath`) requires POSIX `/`-rooted globs, so a non-POSIX cwd could never run real-path
 *    mode anyway (was EXT-16) — it MUST be virtual. (This branch and the default now agree, but it
 *    is kept explicit for clarity.)
 *  - `--allow-dir` widening is requested on a POSIX host: reaching directories OUTSIDE cwd needs
 *    REAL absolute paths that a virtual `/` root cannot express, so keep real-path mode there (the
 *    EXT-13/EXT-14 real-path sandbox, unchanged) so widening still works.
 */
function shouldUseVirtualFs(config?: { allowDirs?: unknown }): boolean {
  // Non-POSIX real cwd (Windows) can never be expressed as deepagents' POSIX `/`-rooted permission
  // globs → must run virtual.
  if (!getCurrentWorkDir().startsWith('/')) return true;
  // POSIX: virtual by default; real-path only when `--allow-dir` widening needs real absolute paths.
  const widen = Array.isArray(config?.allowDirs) && (config.allowDirs as unknown[]).length > 0;
  return !widen;
}

/**
 * The subset of `createDeepAgent` params that are independent of the transport
 * (the local runner vs. the ACP server). Both {@link GthDeepAgent.init} (which adds the
 * console-bound tool-call-status middleware + a virtual {@link FilesystemBackend} +
 * checkpointer and calls `createDeepAgent`) and the ACP entry (deepagents-acp
 * `startServer`, which supplies its own ACP-proxying backend, checkpointer and tool-call
 * reporting) consume these.
 *
 * `middleware` here deliberately EXCLUDES the tool-call-status middleware: that one writes
 * to stdout, which on the ACP path is the JSON-RPC channel and must stay clean. The runner
 * path appends it in {@link GthDeepAgent.init}.
 */
export interface GthDeepAgentParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  tools: StructuredToolInterface[];
  permissions: FilesystemPermission[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middleware: any[];
  /**
   * gsloth's composed system prompt (backstory + guidelines + per-command mode prompt +
   * system prompt). Passed to `createDeepAgent({ systemPrompt })`, where deepagents combines
   * it ADDITIVELY with its own base + filesystem prompts into ONE system message. This replaces
   * the previous per-turn `SystemMessage` injection by the runner/AG-UI callers — two system
   * messages (deepagents' own + gsloth's, not first) are rejected by Anthropic. `undefined` when
   * no prompt content is composed (lets deepagents use only its base prompt).
   */
  systemPrompt: string | undefined;
  /**
   * Per-tool human-in-the-loop configuration passed straight to
   * `createDeepAgent({ interruptOn })` (deepagents installs LangChain's
   * `humanInTheLoopMiddleware` for it). A matching tool call suspends the graph with a
   * `__interrupt__` (a `HITLRequest`) so a consumer can approve/reject before the tool runs;
   * resume with `new Command({ resume: { decisions: [...] } })` on the same `thread_id`.
   *
   * gsloth currently sets this only for the opt-in `run_shell_command` tool (when its
   * `devTools.shell` is enabled and `devTools.shellYolo` is NOT). Left `undefined` otherwise —
   * including under yolo — so no tool is gated and runs never suspend for approval.
   */
  interruptOn?: Record<string, boolean | InterruptOnConfig>;
}

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
 *   (`createDeepAgent` would otherwise throw on the collision). EXT-14: the
 *   `FilesystemBackend` itself is wrapped with {@link guardFilesystemBackend} before it
 *   reaches `createDeepAgent`, adding a realpath (symlink-resolved) containment check the
 *   permission globs alone can't provide.
 * - todos / subagents / summarization come from deepagents' standard middleware.
 *
 * The transport-agnostic param assembly lives in {@link buildDeepAgentParams} so the ACP
 * entry (`deepagents-acp`) can reuse the exact same tool resolution, permission mapping and
 * middleware hardening without re-running `createDeepAgent` locally.
 */
export class GthDeepAgent extends GthAbstractAgent {
  /**
   * Opt-in debug sink for the TUI `/debug` panel. Set AFTER {@link init} via
   * `runner.getAgent()`; read lazily inside the `wrapModelCall` middleware so that when it
   * is `undefined` (the normal path) the middleware is a transparent pass-through. Never
   * touched by the lean agent or the AG-UI server, so those contracts are unchanged.
   */
  public debugCapture: DebugCapture | undefined;

  async init(
    command: GthCommand | undefined,
    configIn: GthConfig,
    checkpointer?: BaseCheckpointSaver | undefined
  ): Promise<void> {
    const params = await this.buildDeepAgentParams(command, configIn);

    // Runner-path only: surface requested tool calls to the console. This is intentionally
    // NOT part of buildDeepAgentParams — it writes via statusUpdate (stdout) and the ACP
    // server renders tool calls itself over its own protocol channel.
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

    // Debug-capture middleware (TUI `/debug` panel). Always installed but lazy: it reads
    // `this.debugCapture` per call, so until the TUI attaches a sink it is a transparent
    // pass-through (one extra await around the handler — the normal path pays nothing).
    // `request.messages` is the real history at call time (post-summarization/middleware),
    // and `handler(request)` resolves to the AIMessage response (decision (a): whole
    // resolved message, not per-chunk — the streaming core stays untouched).
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

    // Whether the deepagents fs backend runs in virtualMode. virtualMode is now the default on all
    // platforms; real-path mode is retained only for a non-POSIX cwd (Windows) — where it is forced
    // virtual — and for POSIX `--allow-dir` widening (which needs real absolute paths). Computed
    // from the effective config because the EXT-22 S1 middleware (below), the backend, and the
    // systemPrompt gate (further down) all key off it. See shouldUseVirtualFs.
    const useVirtualFs = shouldUseVirtualFs(this.config ?? undefined);

    // EXT-22 (S1): last-word path-namespace correction. Appends the shared guidance as a trailing
    // system-message block ONLY in code + virtualMode (where the fs virtual `/` root and the
    // shell's real-OS paths diverge); a transparent pass-through otherwise. Added LAST in the
    // middleware array so, being the innermost wrapModelCall, its block lands AFTER deepagents'
    // "All file paths must start with a /." line (see handoff/spike-systemmessage-ordering.md).
    const pathNamespaceCorrectionMiddleware = createPathNamespaceCorrectionMiddleware(
      this.command === 'code' && useVirtualFs
    );
    const middleware = [
      ...params.middleware,
      toolCallStatusMiddleware,
      debugCaptureMiddleware,
      pathNamespaceCorrectionMiddleware,
    ];
    this.statusUpdate(
      StatusLevel.INFO,
      `Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`
    );

    // The backend runs in virtualMode by default (useVirtualFs) — the deepagents fs tools address a
    // virtual `/` root (= cwd) while run_shell_command uses real OS paths; the divergence is handled
    // by the virtualMode-aware shell tool + the EXT-22 path-namespace notes. Real-path mode (the
    // EXT-13/EXT-14 sandbox) is retained for POSIX `--allow-dir` widening, where the fs tools and
    // shell share ONE real-absolute-path namespace rooted at cwd. Containment in real-path mode is
    // enforced by the permission allow/deny globs built in buildDeepAgentParams (default: allow
    // cwd/**, deny /**) PLUS the EXT-14 realpath guard wrapped around the backend below; in
    // virtualMode the virtual-root chroot + virtual permission globs do it (as they always have).
    // `--allow-dir` (config.allowDirs) further widens those allow-rules to reach extra real dirs;
    // it removes a guardrail, so it is announced loudly by the exec command and surfaced here.
    const allowDirs = this.config?.allowDirs;
    const widenFs = Array.isArray(allowDirs) && allowDirs.length > 0;
    if (widenFs) {
      this.statusUpdate(
        StatusLevel.WARNING,
        `Filesystem sandbox widened beyond cwd (--allow-dir): ${allowDirs.join(', ')}` +
          (useVirtualFs
            ? ' — note: on this platform the sandbox runs in virtual mode, so widening beyond cwd is not applied.'
            : '')
      );
    }
    // EXT-14: layer the realpath containment guard around the backend deepagents' fs middleware
    // (main agent AND every subagent — they all share this one `backend` reference, see
    // guardFilesystemBackend's doc comment) reads/writes through. Closes the intermediate-
    // symlinked-directory escape that the lexical allow/deny globs alone cannot catch.
    const backend = guardFilesystemBackend(
      new FilesystemBackend({
        rootDir: getCurrentWorkDir(),
        virtualMode: useVirtualFs,
      }),
      {
        cwd: getCurrentWorkDir(),
        virtual: useVirtualFs,
        allowDirs: widenFs ? allowDirs : undefined,
      }
    );

    // EXT-13 (part b): on the local-runner code path the model used to be told nothing about
    // where it is, so it assumed `/` was cwd and fed `/`-rooted paths to the real-fs shell. Now
    // the backend uses real absolute paths (above), so inject the dynamic real cwd + path model
    // into the prompt the model actually receives. Code mode only — the surface with full fs +
    // shell access; the ACP transport keeps virtualMode and re-roots per session, so this
    // real-path note must NOT leak there (which is why it lives in init(), not the
    // transport-agnostic buildDeepAgentParams).
    // In virtualMode (EXT-16, Windows) the real-cwd note must NOT be injected — it would mislabel
    // the namespace (the fs tools' `/` is the virtual root, not the real cwd). Instead, EXT-22 (S2)
    // injects the virtualMode path-namespace note so the model is told EARLY that the fs virtual
    // `/` root and run_shell_command's real-OS paths differ (the S1 middleware repeats it as the
    // authoritative last word after deepagents' `/`-rooted line). Non-code paths get neither.
    // EXT-26: after the cwd/virtual-cwd note, append the OS + shell-dialect note so the model is
    // told its host OS and which shell run_shell_command spawns (cmd.exe on Windows, /bin/sh on
    // POSIX). This is ORTHOGONAL to the path-namespace notes above (those say WHERE it is; this
    // says WHAT shell it speaks) and applies in BOTH code-mode branches, independent of
    // virtualMode — the shell dialect matters on every platform. Non-code paths get nothing new.
    const systemPrompt =
      this.command === 'code'
        ? appendOsShellNote(
            useVirtualFs
              ? appendVirtualCwdNote(params.systemPrompt)
              : appendCwdNote(params.systemPrompt, getCurrentWorkDir())
          )
        : params.systemPrompt;

    this.agent = createDeepAgent({
      model: params.model,
      tools: params.tools as StructuredToolInterface[],
      // gsloth's composed prompt, combined ADDITIVELY by deepagents with its base + fs prompts
      // into a single system message (avoids the two-system-message Anthropic rejection).
      systemPrompt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      middleware: middleware as any,
      backend,
      permissions: params.permissions,
      // Per-tool human-in-the-loop gating (e.g. run_shell_command confirmation). When set,
      // deepagents installs humanInTheLoopMiddleware so a matching tool call suspends the graph
      // for approval; `undefined` (the default, and under yolo) leaves every tool ungated.
      interruptOn: params.interruptOn,
      checkpointer,
    });
    debugLog('Deep agent created successfully');
  }

  /**
   * Assemble the transport-agnostic {@link GthDeepAgentParams}: resolve tools (with the
   * filesystem disabled so deepagents owns fs access), apply the allowedTools allow-list and
   * the deepagents fs-name supersession safety-net, map `.aiignore` + filesystem mode onto
   * deepagents permissions, and build the fs-denial-softening middleware. Shared by the local
   * runner ({@link init}) and the `deepagents-acp` ACP entry.
   */
  async buildDeepAgentParams(
    command: GthCommand | undefined,
    configIn: GthConfig
  ): Promise<GthDeepAgentParams> {
    this.command = command;
    debugLog(`GthDeepAgent.buildDeepAgentParams called with command: ${command || 'default'}`);

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

    // Resolve tools with filesystem access disabled. deepagents OWNS the filesystem
    // (its fs middleware + the `permissions` built below); gsloth's filesystem toolkit
    // must NOT be loaded here, because its non-colliding tools (read_multiple_files,
    // delete_file, search_files, …) would otherwise bypass deepagents' permission
    // enforcement entirely — a model could read an .aiignore-protected file through them.
    debugLog('Resolving tools (filesystem disabled; deepagents provides fs)...');
    // Tell the shared dev toolkit whether the fs backend runs in virtualMode for this run, so its
    // run_shell_command tool warns about the fs-vs-shell path divergence and forces an explicit
    // acknowledgement. Computed from the effective config (mirrors init()'s useVirtualFs).
    const useVirtualFs = shouldUseVirtualFs(this.config ?? undefined);
    const toolResolutionConfig = {
      ...this.config,
      filesystem: 'none' as const,
      deepFsVirtual: useVirtualFs,
    };
    const resolvedTools =
      !toolsDisabled && this.resolvers?.resolveTools
        ? await this.resolvers.resolveTools(toolResolutionConfig, command)
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

    // Safety net: a custom/dev/MCP tool may still reuse a deepagents filesystem-tool
    // name (createDeepAgent throws on such a collision). Drop the colliding tool — the
    // deep agent's built-in fs tool wins. With filesystem disabled above this is normally
    // empty; it only fires for a genuine user/MCP name clash.
    const reserved = new Set<string>(FILESYSTEM_TOOL_NAMES);
    const superseded = tools.filter((tool) => tool.name && reserved.has(tool.name));
    const passThroughTools = tools.filter((tool) => !tool.name || !reserved.has(tool.name));
    if (superseded.length > 0) {
      const names = superseded.map((tool) => tool.name).join(', ');
      this.statusUpdate(
        StatusLevel.WARNING,
        `Dropping tool(s) that collide with deepagents built-in filesystem tools: ${names}`
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
    const resolvedMiddleware = this.resolvers?.resolveMiddleware
      ? await this.resolvers.resolveMiddleware(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.config.middleware as any[] | undefined,
          this.config
        )
      : [];

    // deepagents' standard middleware already summarizes long conversations; drop any
    // gsloth-configured summarization middleware so the deep agent doesn't summarize twice.
    const configuredMiddleware = resolvedMiddleware.filter((m) => {
      const name = (m as { name?: string }).name ?? '';
      if (/summar/i.test(name)) {
        debugLog(`Dropping duplicate summarization middleware '${name}' (deepagents provides it)`);
        return false;
      }
      return true;
    });

    // Soften deepagents' fail-hard filesystem tool throws. By default the permission layer
    // THROWS on both a denied read/write AND on a malformed path the model supplied — a relative
    // path, a `..`/`~` segment, or an empty string (deepagents' validatePath, run BEFORE the
    // permission check in enforcePermission). Any of these aborts the WHOLE run. On the AG-UI
    // transport that throw propagates out of streamWithEvents into the run handler's catch, which
    // emits RUN_ERROR and ends the response WITHOUT a terminal RUN_FINISHED — and since AG-UI's
    // protocol makes RUN_ERROR terminal ("no further events can be sent"), a consumer waiting for
    // RUN_FINISHED hangs (EXT-24). Wrap tool calls so each of these becomes a recoverable error
    // ToolMessage instead, letting the model observe the mistake, retry with a good path, and
    // finish the run normally (reaching RUN_FINISHED). This preserves gsloth's recoverable-denial
    // UX (the old GthFileSystemToolkit returned a message rather than throwing). Only these known
    // fs path/permission messages are caught; every other throw (GraphInterrupt from a client-tool
    // interrupt stub, AbortError on client disconnect, unexpected errors) is rethrown untouched so
    // control-flow and genuine failures still surface.
    const fsDenialSoftening = createMiddleware({
      name: 'GthDeepFsDenialSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          // EXT-25: rethrow control-flow throws BY TYPE, BEFORE the message regex below. A
          // GraphInterrupt (a client-tool interrupt() suspending the graph for HITL tool
          // approval) and an AbortError (caller cancellation) must ALWAYS propagate so the graph
          // suspends / cancels — never be converted into a benign ToolMessage. Mirrors the guard
          // in GthAbstractAgent (error.name checks + GraphInterrupt instanceof). Today these
          // survive only because their messages happen not to match the regex; guarding by type
          // stops a future regex broadening from silently swallowing the HITL suspend.
          if (
            e instanceof GraphInterrupt ||
            (e as { name?: string })?.name === 'GraphInterrupt' ||
            (e as { name?: string })?.name === 'AbortError'
          ) {
            throw e;
          }
          const message = e instanceof Error ? e.message : String(e);
          // deepagents fs enforcement throws (middleware/fs.ts enforcePermission +
          // permissions/enforce.ts validatePath): a permission denial, or a path that is
          // relative / contains ".." or "~" / is empty. All are recoverable model-input errors.
          if (
            /permission denied for (read|write)|path must (be absolute|not contain|be a non-empty string)/i.test(
              message
            )
          ) {
            debugLog(`Softened fs tool throw into a ToolMessage: ${message}`);
            return new ToolMessage({
              content: message,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              tool_call_id: (request.toolCall as any)?.id ?? '',
              status: 'error',
            });
          }
          throw e;
        }
      },
    });

    // EXT-20: sibling of fsDenialSoftening for the run_* (dev/shell) tools. GthDevToolkit's
    // executeCommand now THROWS a ShellCommandFailedError on a non-zero exit or a timeout-kill
    // (instead of resolving with the failure text), so the tool result no longer misreports
    // status:'success' (✓). Catch it here and return an error ToolMessage that PRESERVES the full
    // stdout/stderr body — the model's observation is unchanged except that status flips to
    // 'error', which drives the ✗ (isError) glyph (GthAbstractAgent maps status==='error' →
    // isError). Returning a ToolMessage (rather than rethrowing) also means the approved-then-failed
    // command does NOT trigger a retry loop — it is a normal, observed tool result.
    const shellExitSoftening = createMiddleware({
      name: 'GthDeepShellExitSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          if (e instanceof ShellCommandFailedError) {
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

    // fsDenialSoftening first so it is the outermost wrapToolCall — it must see the throw from
    // deepagents' permission-enforcing fs tools. shellExitSoftening sits right after it (still
    // outboard of any user-configured middleware, so it always sees the raw ShellCommandFailedError
    // throw before a user wrapToolCall could transform it). Order between the two softeners is not
    // load-bearing: they catch DISJOINT conditions (a permission-denied regex vs an
    // `instanceof ShellCommandFailedError`) and each rethrows what it doesn't recognize, so neither
    // can swallow the other. The console-bound tool-call-status middleware is NOT added here (see
    // GthDeepAgentParams.middleware); the runner appends it.
    const middleware = [fsDenialSoftening, shellExitSoftening, ...configuredMiddleware];

    // Map gsloth's .aiignore + filesystem mode onto deepagents permission rules. When
    // `--allow-dir` widens the sandbox, the backend runs without virtualMode, so paths are REAL
    // absolute paths: constrain read+write to cwd + the allowed dirs (everything else denied),
    // layered under the .aiignore deny rules.
    const permissions = buildPermissions(
      {
        filesystem: this.config.filesystem,
        aiignore: this.config.aiignore,
        allowDirs:
          Array.isArray(this.config.allowDirs) && this.config.allowDirs.length > 0
            ? this.config.allowDirs
            : undefined,
      },
      // Build virtual (`/`-rooted) permission rules when the backend will run in virtualMode (the
      // default; also every non-POSIX cwd), matching the FilesystemBackend created in init(). Reuses
      // the same useVirtualFs computed above so tools, permissions and backend stay in lockstep.
      useVirtualFs
    );
    debugLogObject('Filesystem permissions', permissions);

    // Compose gsloth's system prompt (backstory + guidelines + per-command mode prompt +
    // system prompt) so identity profiles (Gaunt Sloth, sorcerer, fisher-alt, …) and
    // `.gsloth.*.md` are honored. This is passed to createDeepAgent as `systemPrompt` — combined
    // additively with deepagents' base + fs prompts into ONE system message — rather than injected
    // as a separate SystemMessage per turn (which produced a non-first system message that
    // Anthropic rejects). 'code' uses the code-mode prompt; 'exec' uses the prompt-as-script
    // exec-mode prompt; chat/api/others use the chat prompt.
    const modePrompt =
      this.command === 'code'
        ? readCodePrompt(this.config)
        : this.command === 'exec'
          ? readExecPrompt(this.config)
          : readChatPrompt(this.config);
    const systemMessages = buildSystemMessages(this.config, modePrompt);
    const systemPrompt =
      typeof systemMessages[0]?.content === 'string' ? systemMessages[0].content : undefined;

    // Gate the opt-in run_shell_command tool behind a per-command approval interrupt. The tool
    // is only emitted (by GthDevToolkit, via builtInToolsConfig) when its devTools.shell flag is
    // set; mirror the same per-command devTools resolution here so the interrupt is wired only
    // when the tool actually exists. yolo (shellYolo) opts OUT of the confirmation: leave
    // interruptOn undefined so the tool runs without suspending.
    const devTools = this.getEffectiveDevToolsConfig();
    // EXT-12 — pass the active command so the absent-config default (shell ON in `code`)
    // is applied consistently with where the tool is actually emitted (GthDevToolkit).
    const shellEnabled = isShellToolEnabled(devTools, this.command);
    const interruptOn =
      shellEnabled && devTools?.shellYolo !== true
        ? ({ run_shell_command: { allowedDecisions: ['approve', 'reject'] } } as Record<
            string,
            boolean | InterruptOnConfig
          >)
        : undefined;
    if (interruptOn) {
      this.statusUpdate(
        StatusLevel.INFO,
        'Shell tool (run_shell_command) enabled with per-command approval (interruptOn).'
      );
    } else if (shellEnabled) {
      this.statusUpdate(
        StatusLevel.WARNING,
        'Shell tool (run_shell_command) enabled in YOLO mode: commands run WITHOUT confirmation.'
      );
    }

    return {
      model: this.config.llm,
      tools: passThroughTools as StructuredToolInterface[],
      permissions,
      middleware,
      systemPrompt,
      interruptOn,
    };
  }

  /**
   * Resolve the {@link GthDevToolsConfig} that applies to the active command, mirroring the
   * per-command selection in `builtInToolsConfig.getDefaultTools` (which is what actually emits
   * the dev tools): `exec` → `commands.exec.devTools`, `ask --write` → `commands.ask.devTools`,
   * otherwise (`code`) → `commands.code.devTools`. Returns `undefined` for any other command,
   * matching the toolkit being inert there. Kept private and side-effect-free so the interrupt
   * wiring above and the tool emission stay in lockstep.
   */
  private getEffectiveDevToolsConfig(): GthDevToolsConfig | undefined {
    const config = this.config;
    if (!config) return undefined;
    const command = this.command;
    const askWrite = command === 'ask' && config.askWriteMode === true;
    if (command === 'exec') return config.commands?.exec?.devTools;
    if (askWrite) return config.commands?.ask?.devTools;
    if (command === 'code') return config.commands?.code?.devTools;
    return undefined;
  }
}

/**
 * EXT-22: shared virtualMode path-namespace guidance — ONE source of truth used by BOTH the S2
 * early-framing note ({@link appendVirtualCwdNote}, injected into gsloth's composed systemPrompt =
 * block 0) and the S1 last-word correction middleware
 * ({@link createPathNamespaceCorrectionMiddleware}, appended after deepagents' `/`-rooted line).
 *
 * In a virtualMode `code` session (EXT-16, e.g. Windows) the deepagents filesystem tools use a
 * VIRTUAL `/` root (= the working dir) while `run_shell_command` uses REAL native OS paths; the
 * model conflates the two forms. This text draws the distinction and steers toward cwd-relative
 * paths (the one form both tool families read alike).
 *
 * It deliberately does NOT equate the virtual root with a specific real path (no "`/` = D:\\work"):
 * virtualMode withholds the real cwd on purpose (see the systemPrompt gate in {@link
 * GthDeepAgent.init}), so the guidance is about the DISTINCTION between the two namespaces and the
 * safety of relative paths, not a mapping between them.
 */
export const PATH_NAMESPACE_GUIDANCE =
  'The filesystem tools (ls, read_file, write_file, edit_file, glob, grep) use a VIRTUAL root in ' +
  'this session: a leading `/` means your working directory, and their paths are written ' +
  '`/`-rooted relative to it (this is what "all file paths must start with a /" refers to). That ' +
  '`/` is NOT the real operating-system filesystem root. run_shell_command is different: it runs ' +
  'in the real operating system and uses real native paths, never the virtual `/` root. On Windows ' +
  'those look obviously different (e.g. `C:\\Users\\...\\project`, with backslashes); on Linux/macOS ' +
  'the real working directory is ITSELF an absolute path such as `/home/you/project`, so a virtual ' +
  '`/src/index.ts` actually lives at `<working dir>/src/index.ts` for the shell — the two `/`-forms ' +
  'look identical but mean different things, which is easy to get wrong. A `/`-rooted path from the ' +
  'filesystem tools is NOT a valid shell path and must never be passed to run_shell_command. The ' +
  'one form that means the same thing to both tool families is a path RELATIVE to the working ' +
  'directory (e.g. `src/index.ts`); prefer relative paths for both. When you must be absolute, use ' +
  '`/`-rooted form ONLY for the filesystem tools and real native form ONLY for run_shell_command ' +
  '(confirm the real working directory with a shell command such as `pwd` first).';

/**
 * EXT-22 (S2): virtualMode variant of {@link appendCwdNote}. On the `code` path when the fs
 * backend runs in virtualMode (EXT-16), inject the shared path-namespace guidance EARLY in
 * gsloth's composed systemPrompt (block 0) so the model is framed before deepagents' own prompt.
 *
 * This is early framing only: deepagents' hardcoded `/`-rooted line lands in a LATER block and can
 * partially override block 0, so the authoritative last word is delivered by the S1 middleware
 * ({@link createPathNamespaceCorrectionMiddleware}); see handoff/spike-systemmessage-ordering.md.
 * Returns the note alone when there is no base prompt.
 */
export function appendVirtualCwdNote(systemPrompt: string | undefined): string {
  const note = `Filesystem vs shell path namespaces: ${PATH_NAMESPACE_GUIDANCE}`;
  return systemPrompt ? `${systemPrompt}\n\n${note}` : note;
}

/**
 * EXT-22 (S1): the load-bearing path-namespace correction. A gsloth `wrapModelCall` middleware
 * runs INNERMOST (inside deepagents' filesystem middleware), so appending a trailing block to
 * `request.systemMessage` lands AFTER deepagents' hardcoded "All file paths must start with a /."
 * line — giving gsloth the last word on path semantics (empirically verified; see
 * handoff/spike-systemmessage-ordering.md). It APPENDS via `request.systemMessage.concat(...)`
 * (mirroring how deepagents appends its own fs prompt), never string-splices, and returns a NEW
 * request so it never mutates persisted state (no compounding across turns).
 *
 * `appendCorrection` gates it to `code` + virtualMode: only there do the fs virtual `/` root and
 * the shell's real-OS paths diverge. On POSIX real-path mode deepagents' "start with /" is
 * literally true, so the middleware is a transparent pass-through (like the debug-capture
 * middleware when no sink is attached).
 */
export function createPathNamespaceCorrectionMiddleware(appendCorrection: boolean) {
  return createMiddleware({
    name: 'GthDeepPathNamespaceCorrection',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapModelCall: async (request: any, handler: any) => {
      if (!appendCorrection || !request?.systemMessage) return handler(request);
      const correction =
        'IMPORTANT — path namespaces (authoritative; this overrides any earlier instruction that ' +
        `implies every path is a simple \`/\`-rooted filesystem path): ${PATH_NAMESPACE_GUIDANCE}`;
      return handler({ ...request, systemMessage: request.systemMessage.concat(correction) });
    },
  });
}

/**
 * EXT-13 (part b): append a real-cwd / path-model note to the composed code-mode system prompt.
 *
 * The default code-mode backend runs in REAL-path mode (no virtualMode), so the deepagents fs
 * tools and `run_shell_command` share one real-absolute-path namespace rooted at `cwd`. Neither
 * deepagents' base prompt nor `.gsloth.code.md` states the actual cwd, so without this the model
 * assumes `/` is cwd and hands `/`-rooted paths to the real-fs shell. The cwd is injected
 * dynamically (never baked into the .md). Returns the note alone when there is no base prompt.
 */
export function appendCwdNote(systemPrompt: string | undefined, cwd: string): string {
  const cwdNote =
    `Working directory: ${cwd}\n` +
    'Paths are real absolute filesystem paths (there is no virtual root). The working directory ' +
    'above is where this session runs; relative paths resolve against it, and both the filesystem ' +
    'tools (ls/glob/read_file/write_file/edit_file/grep) and run_shell_command operate on these ' +
    'same real paths. Check the current directory before filesystem operations and prefer absolute ' +
    'paths (or paths relative to the working directory); do not assume the current directory is "/".';
  return systemPrompt ? `${systemPrompt}\n\n${cwdNote}` : cwdNote;
}

/**
 * EXT-26: the platform-agnostic tail shared by both {@link appendOsShellNote} branches.
 *
 * The recurring failure mode on non-POSIX hosts is not just wrong command NAMES but shell
 * REDIRECTION quoting: a grouped/multi-line `echo` redirect on cmd.exe reported success yet wrote
 * a 0-byte file. So on every platform we steer file creation/mutation to the deepagents built-in
 * `write_file`/`edit_file` tools (which never touch the shell's quoting) and keep each shell
 * command a single line. Kept short — this is prompt text an LLM reads, not documentation.
 */
export const OS_SHELL_GUIDANCE =
  'Prefer the built-in write_file / edit_file tools over shell echo/redirection to create or ' +
  'modify files: shell redirection quoting is unreliable and can silently write an empty ' +
  '(0-byte) file. Keep each run_shell_command a single line.';

/**
 * EXT-26: append an OS + shell-dialect note to the composed code-mode system prompt.
 *
 * The deep-agent model was never told its host OS or which shell `run_shell_command` uses, so on
 * non-POSIX hosts it defaulted to POSIX idioms that fail (ran `ls` where cmd.exe has `dir`, a
 * multi-line echo-redirect that wrote 0 bytes, a PowerShell here-string, `python -c` multi-line).
 * This is ORTHOGONAL to the EXT-13/16/22 path-namespace notes: those say WHERE the model is (path
 * form); this says WHAT shell it speaks (dialect).
 *
 * The shell is derived from the SAME rule Node's `spawn(command, { shell: true })` uses — exactly
 * how `run_shell_command` spawns (GthDevToolkit spawn) — so on `win32` it is cmd.exe (via
 * `%ComSpec%`) and on POSIX it is `/bin/sh` (POSIX sh, NOT guaranteed bash). Computed from
 * `process.platform` at call time so the text is correct per host. Returns the note alone when
 * there is no base prompt. A single injection is authoritative (nothing in deepagents' base prompt
 * contradicts shell dialect), so unlike EXT-22 no correction middleware is needed.
 */
export function appendOsShellNote(systemPrompt: string | undefined): string {
  let note: string;
  if (process.platform === 'win32') {
    note =
      'Host operating system: Windows. `run_shell_command` runs in cmd.exe. Use native cmd ' +
      'syntax: `dir` (not `ls`), `type` (not `cat`), `copy` / `move` / `del`, `%VAR%` for ' +
      'environment variables, and backslash paths. Do NOT use POSIX-only idioms: no sh/bash ' +
      'heredocs (`<< EOF`), no here-strings (`<<<`), no multi-line quoted command blocks, and do ' +
      `not assume POSIX quoting. ${OS_SHELL_GUIDANCE}`;
  } else {
    const osName = process.platform === 'darwin' ? 'macOS' : 'Linux';
    note =
      `Host operating system: ${osName}. \`run_shell_command\` runs in /bin/sh (POSIX sh, not ` +
      'necessarily bash). Stick to POSIX sh syntax and avoid bash-only constructs such as ' +
      `here-strings (\`<<<\`) and \`[[ ]]\` tests. ${OS_SHELL_GUIDANCE}`;
  }
  return systemPrompt ? `${systemPrompt}\n\n${note}` : note;
}

/**
 * Scalar model-param fields worth surfacing in the `/debug` panel. Deliberately an
 * allowlist (NOT a whole-object dump) so no credential field (`apiKey`, `accessToken`, …)
 * can ever leak into the rendered debug view.
 *
 * `streaming` is intentionally NOT here: it is the model instance's static flag, which is
 * usually `false` even when the turn streams — the GthAgentRunner decides streaming by calling
 * `.stream()` vs `.invoke()`, not by this property — so surfacing it just misleads.
 */
const DEBUG_MODEL_PARAM_KEYS = [
  'model',
  'modelName',
  'modelId',
  'deploymentName',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'maxOutputTokens',
  'maxReasoningTokens',
  'reasoningEffort',
  'thinkingBudget',
  'stop',
  'provider',
] as const;

/** Pull the key-free scalar model params from the (provider-specific) model instance. */
function extractModelParams(model: unknown): Record<string, unknown> | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const src = model as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DEBUG_MODEL_PARAM_KEYS) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    // Only scalars / scalar arrays — never nested objects that could carry credentials.
    if (typeof value === 'object' && !Array.isArray(value)) continue;
    out[key] = value;
  }
  // `model` / `modelName` / `modelId` are langchain aliases for the same value; collapse the
  // duplicates so the panel shows the model id once instead of two identical lines.
  if (typeof out.model !== 'string' && typeof out.modelName === 'string') {
    out.model = out.modelName;
  }
  if (out.modelName === out.model) delete out.modelName;
  if (out.modelId === out.model) delete out.modelId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Best-effort tool definition (name + description + schema) for the debug view. */
function extractToolDefs(tools: unknown): DebugToolDef[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const defs: DebugToolDef[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : undefined;
    if (!name) continue;
    const description = typeof t.description === 'string' ? t.description : undefined;
    // LangChain StructuredTools expose a Zod/JSON `schema`; some carry it on `lc_kwargs`.
    const schema = (t.schema as unknown) ?? undefined;
    defs.push({ name, description, schema });
  }
  return defs.length > 0 ? defs : undefined;
}

/**
 * Assemble the non-message request parts ({@link DebugRequestExtras}) for the `/debug`
 * panel from a `wrapModelCall` request, defensively and key-free. Never throws (the caller
 * already guards, but a debug sink must never break a run) and never dumps the raw model.
 */
export function extractDebugRequestExtras(request: unknown): DebugRequestExtras | undefined {
  if (!request || typeof request !== 'object') return undefined;
  const req = request as Record<string, unknown>;
  const systemMessage = req.systemMessage as { content?: unknown } | undefined;
  const systemPrompt =
    typeof req.systemPrompt === 'string' && req.systemPrompt
      ? req.systemPrompt
      : typeof systemMessage?.content === 'string'
        ? systemMessage.content
        : undefined;
  const extras: DebugRequestExtras = {
    systemPrompt,
    tools: extractToolDefs(req.tools),
    modelParams: extractModelParams(req.model),
    toolChoice: req.toolChoice,
  };
  // Return undefined when nothing useful was captured so the renderer can show a clear empty state.
  const hasAny =
    extras.systemPrompt !== undefined ||
    extras.tools !== undefined ||
    extras.modelParams !== undefined ||
    extras.toolChoice !== undefined;
  return hasAny ? extras : undefined;
}
