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
import { createMiddleware, type InterruptOnConfig } from 'langchain';
import { createDeepAgent, FilesystemBackend } from 'deepagents';
import {
  buildPermissions,
  FILESYSTEM_TOOL_NAMES,
  type FilesystemPermission,
} from '#src/core/deepAgentPermissions.js';
import type { DebugCapture, DebugRequestExtras, DebugToolDef } from '#src/core/debugCapture.js';

/**
 * EXT-16: decide whether the deepagents filesystem backend must run in virtualMode.
 *
 * deepagents' permission layer (`validatePath`) requires POSIX `/`-rooted glob paths, and its
 * fs tools hand the SAME model-supplied path string to both the permission check and the native
 * `path.resolve`/`fs` backend. On Windows a real cwd is `D:\...`, which can satisfy neither side
 * as one string, so the EXT-13 real-path sandbox throws `Error: path must be absolute` on every
 * turn and the agent hangs. The precise trigger is "the real cwd is not POSIX-rooted", so we key
 * off that directly (not just `win32`): when true, run virtualMode (cwd→`/`) with virtual
 * permissions — the pre-EXT-13 known-good behavior. POSIX keeps the EXT-13 real-path namespace.
 */
function shouldUseVirtualFs(): boolean {
  return !getCurrentWorkDir().startsWith('/');
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
 *   (`createDeepAgent` would otherwise throw on the collision).
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

    const middleware = [...params.middleware, toolCallStatusMiddleware, debugCaptureMiddleware];
    this.statusUpdate(
      StatusLevel.INFO,
      `Loaded middleware: ${middleware.map((m) => m.name).join(', ')}`
    );

    // EXT-13: the backend always runs in REAL-path mode (virtualMode off) so the deepagents fs
    // tools and the EXT-9 run_shell_command tool share ONE path namespace — real absolute paths
    // rooted at cwd. Containment is enforced entirely by the permission allow/deny globs built in
    // buildDeepAgentParams (default: allow cwd/**, deny /**), which match what virtualMode used to
    // give for free (see deepAgentPermissions + the EXT-13 symlink/`..` parity tests).
    // `--allow-dir` (config.allowDirs) further widens those allow-rules to reach extra real dirs;
    // it removes a guardrail, so it is announced loudly by the exec command and surfaced here.
    const allowDirs = this.config?.allowDirs;
    const widenFs = Array.isArray(allowDirs) && allowDirs.length > 0;
    // EXT-16: deepagents' permission layer requires POSIX `/`-rooted paths, so a Windows real
    // cwd (`D:\...`) can't be expressed as a permission glob and the EXT-13 real-path mode hangs
    // there (`Error: path must be absolute`). When the real cwd isn't POSIX-rooted, fall back to
    // virtualMode (cwd→`/`) with virtual permissions — the pre-EXT-13 known-good Windows behavior.
    const useVirtualFs = shouldUseVirtualFs();
    if (widenFs) {
      this.statusUpdate(
        StatusLevel.WARNING,
        `Filesystem sandbox widened beyond cwd (--allow-dir): ${allowDirs.join(', ')}` +
          (useVirtualFs
            ? ' — note: on this platform the sandbox runs in virtual mode, so widening beyond cwd is not applied.'
            : '')
      );
    }
    const backend = new FilesystemBackend({
      rootDir: getCurrentWorkDir(),
      virtualMode: useVirtualFs,
    });

    // EXT-13 (part b): on the local-runner code path the model used to be told nothing about
    // where it is, so it assumed `/` was cwd and fed `/`-rooted paths to the real-fs shell. Now
    // the backend uses real absolute paths (above), so inject the dynamic real cwd + path model
    // into the prompt the model actually receives. Code mode only — the surface with full fs +
    // shell access; the ACP transport keeps virtualMode and re-roots per session, so this
    // real-path note must NOT leak there (which is why it lives in init(), not the
    // transport-agnostic buildDeepAgentParams).
    // In virtualMode (EXT-16, Windows) the model correctly assumes the virtual root `/` IS cwd
    // (the pre-EXT-13 behavior), so the real-cwd note must NOT be injected — it would mislabel
    // the namespace. Only the real-path code path needs it.
    const systemPrompt =
      this.command === 'code' && !useVirtualFs
        ? appendCwdNote(params.systemPrompt, getCurrentWorkDir())
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
    const toolResolutionConfig = { ...this.config, filesystem: 'none' as const };
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

    // Soften deepagents' fail-hard filesystem permission denials. By default a denied
    // read/write THROWS, which aborts the whole run; wrap tool calls so a denial becomes
    // a recoverable ToolMessage instead, letting the model continue and report it. This
    // preserves gsloth's recoverable-denial UX (the old GthFileSystemToolkit returned a
    // message rather than throwing).
    const fsDenialSoftening = createMiddleware({
      name: 'GthDeepFsDenialSoftening',
      wrapToolCall: async (request, handler) => {
        try {
          return await handler(request);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          if (/permission denied for (read|write)/i.test(message)) {
            debugLog(`Softened fs permission denial into a ToolMessage: ${message}`);
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

    // fsDenialSoftening first so it is the outermost wrapToolCall — it must see the throw
    // from deepagents' permission-enforcing fs tools. The console-bound tool-call-status
    // middleware is NOT added here (see GthDeepAgentParams.middleware); the runner appends it.
    const middleware = [fsDenialSoftening, ...configuredMiddleware];

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
      // EXT-16: build virtual (`/`-rooted) permission rules when the backend will run in
      // virtualMode (Windows), matching the FilesystemBackend created in init().
      shouldUseVirtualFs()
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
