/**
 * @packageDocumentation
 * Gaunt Sloth configuration types. Extracted verbatim from the former `config.ts`
 * god-file; the public type surface is unchanged. The shell/dev-tools policy types
 * live in `./shell-policy.ts`; defaults in `./defaults.ts`; the loader in `./loader.ts`.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import type { StatusLevel } from '#src/core/types.js';
import type { ApprovalsConfig, BuiltInToolsSetting } from '#src/config/shell-policy.js';
import type {
  GthAcpSessionMode,
  GthOutputHeaderRung,
  GthRunRecapRung,
} from '#src/config/schema.js';

/**
 * GS2-43 — the seven configurable prompt segments. Each maps to a prompt file with a
 * well-known default name (`.gsloth.backstory.md`, `.gsloth.guidelines.md`,
 * `.gsloth.system.md`, `.gsloth.chat.md`, `.gsloth.code.md`, `.gsloth.exec.md`,
 * `.gsloth.review.md`) and can be retargeted / disabled / composed via
 * {@link GthConfig.prompts}.
 */
export type PromptSegmentName =
  'backstory' | 'guidelines' | 'system' | 'chat' | 'code' | 'exec' | 'review';

/**
 * GS2-43 — configuration for one prompt segment.
 */
export interface PromptSegmentConfig {
  /**
   * File to read for this segment. Resolved like every prompt file: the config dir
   * (`.gsloth/.gsloth-settings[/<profile>]/`) first, then relative to the project root.
   */
  path?: string;
  /**
   * `false` drops the segment entirely — even its bundled default. Default `true`.
   */
  enabled?: boolean;
  /**
   * `'replace'` (default): the {@link path} file replaces the built-in segment content.
   * `'append'`: the file content is appended after the built-in content.
   */
  mode?: 'replace' | 'append';
}

/**
 * GS2-43 — one segment's setting: a `string` path (shorthand for `{ path }`) or a
 * {@link PromptSegmentConfig} object.
 */
export type PromptSegmentSetting = string | PromptSegmentConfig;

/**
 * CFG-70 — one entry of {@link PromptsConfig}'s `paths` list: extra prompt content that applies
 * only when the diff under review touches particular paths.
 *
 * Each segment here is a **plain string path** — deliberately NOT a
 * {@link PromptSegmentSetting}, which would admit `mode` and `enabled`.
 *
 * A scoped entry always **appends** to the root segment; it can neither replace nor disable it.
 * The root segment's own default is `replace`, so accepting the same `mode` key in a nested
 * position with the opposite default is the worse of the two options available: one module's entry
 * could silently drop the whole repository's guidelines, and nothing in the run would say so.
 * Rather than ignore the key, the schema **rejects** `mode` and `enabled` inside an entry — a
 * runtime that accepts a key it will never honour is GS2-81's exact defect.
 */
export interface ScopedPromptsEntry {
  /** Required, non-empty. Identifies the entry in the composed heading and in the run's report. */
  name: string;
  /**
   * Required, non-empty list of globs matched against the paths in the diff. A leading `!` negates:
   * a path a `!` pattern matches cannot pull the entry in on its own, though another path under the
   * same entry still can.
   */
  match: string[];
  backstory?: string;
  guidelines?: string;
  system?: string;
  chat?: string;
  code?: string;
  exec?: string;
  review?: string;
}

/**
 * GS2-43 — the unified `prompts` config object. Replaces the removed flat
 * `projectGuidelines` / `projectReviewInstructions` keys and makes all seven prompt
 * segments retargetable through config. Sibling keys are trivially addable (GS2-44 will
 * add `agents` for AGENTS.md auto-discovery), so keep segment names and future siblings
 * in this one flat namespace.
 *
 * CFG-70's `paths` is such a sibling: a list of {@link ScopedPromptsEntry}. It is written as an
 * intersection rather than by widening the `Record` so the seven segment names keep their exact
 * {@link PromptSegmentSetting} type and `paths` keeps its own.
 */
export type PromptsConfig = Partial<Record<PromptSegmentName, PromptSegmentSetting>> & {
  /**
   * CFG-70 — path-scoped overlays, in the order the user wrote them. Across config layers this
   * list **replaces** rather than concatenates (the `deepMerge` default), so a project config's
   * list wholly supersedes a global one.
   */
  paths?: ScopedPromptsEntry[];
};

/**
 * BATCH-48 — the run-level tool-coverage floor, as authored in gth config.
 *
 * `min` is a percentage of the post-waiver denominator, the same unit a suite's `tool_coverage.min`
 * uses and the same unit the figure is printed in. `waive` is the exemption list at the same scope:
 * a floor graded against a denominator the run has no way to correct cannot be set honestly, because
 * tools an `allowedTools` filter removed stay in the denominator and can only ever read as uncovered.
 */
export interface EvalToolCoverageConfig {
  /** Minimum percentage (0–100) of the run's post-waiver denominator that must have been exercised. */
  min?: number;
  /**
   * Tool-name globs (the `must_call` matcher) whose matching advertised tools leave the run's
   * denominator. A suite's own waiver does not do this — only this list does.
   */
  waive?: string[];
}

/**
 * Shared per-command tooling configuration (the knobs every actionable command carries).
 * Reused across the per-command types in {@link GthConfig.commands} and by
 * {@link PrCommandConfig}. Type-level dedupe only — no runtime/behaviour change.
 *
 * NOTE: `commands.api` intentionally does NOT use this shape (it only has
 * `filesystem`/`builtInTools` plus `port`/`cors`), so it stays bespoke below.
 */
export interface CommandToolingConfig {
  filesystem?: string[] | 'all' | 'read' | 'none';
  builtInTools?: BuiltInToolsSetting;
  /**
   * §9.1 — per-command approvals posture. It overrides only the fields it NAMES: `mode`,
   * `rater`, `raterTimeoutMs` and `allow` replace the root's, while `deny` and `escalate`
   * concatenate with it. See {@link GthConfig.approvals}.
   */
  approvals?: ApprovalsConfig;
  customTools?: CustomToolsConfig | false;
  /** See {@link GthConfig.allowedTools}. */
  allowedTools?: string[];
  binaryFormats?: false | BinaryFormatConfig[];
}

/**
 * GS2-33 — one profile-backed subagent declaration. When the parent agent spawns this subagent,
 * the CHILD resolves the named config {@link profile} through the GS2-1 cascade, so it runs under
 * THAT profile's model + tools + prompt (e.g. a cheap flash-lite profile for recall/search
 * subagents while the parent runs on a strong model).
 *
 * No backend spawns subagents today — see the `subagents` field on {@link GthConfig}.
 *
 * The `profile` is a named profile block created by `gth config profile create <name>` — a
 * `.gsloth/.gsloth-settings/<name>/` config dir, the same discovery convention `--profile` /
 * `--identity-profile` resolve.
 */
export interface SubagentProfileSpec {
  /** Identifier the model selects this subagent by (the task-tool subagent name). */
  name: string;
  /** Description shown to the model when it chooses a subagent. Defaults to a profile note. */
  description?: string;
  /**
   * Named config profile whose model + tools + prompt the CHILD resolves. Threaded through the
   * subagent-spawn config resolution as {@link CommandLineConfigOverrides.identityProfile}.
   */
  profile: string;
}

/**
 * This is a processed Gaunt Sloth config ready to be passed down into components.
 *
 * Default values can be found in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}
 */
export interface GthConfig {
  llm: BaseChatModel;
  /**
   * Selects the agent backend.
   *
   * `lean` — the plain LangChain agent ({@link @gaunt-sloth/core!core/GthLangChainAgent.GthLangChainAgent | GthLangChainAgent}), given gsloth's full toolset
   * (filesystem + hardened dev/shell + the `gth_checklist` planning tool) — is the only backend,
   * and what runs when the key is omitted. Every command resolves the same one, so the key selects
   * nothing today; it exists so a config can name what it runs on, and so a second backend has a
   * name to arrive under.
   *
   * The retired `deep` value is a hard config error, not a coercion — see `RETIRED_AGENT_BACKENDS`
   * in `config/schema.ts` for why substituting a different agent for the one a config named is the
   * wrong kindness.
   */
  agent?: { backend?: 'lean' };
  /**
   * GS2-7 (B20) / GS2-20 — local session history store. DEFAULT ON (absent = enabled): each run is
   * recorded to a local SQLite DB (`~/.gsloth/history.db` by default, overridable via `dbPath`) for
   * `gth history search` / `gth insights`, and interactive sessions checkpoint their graph state
   * into the same file so a conversation can be resumed. `enabled: false` turns both off and
   * restores the stateless identity. Local only — no telemetry leaves the machine.
   */
  history?: { enabled?: boolean; dbPath?: string };
  /**
   * GS2-7 (B21) — opt-in file-backed memory (MEMORY.md / USER.md). DEFAULT OFF. Forward-compat
   * toggle only; the feature is a deferred follow-up.
   */
  memory?: { enabled?: boolean };
  /**
   * Binary format support configuration.
   * Disabled by default unless explicitly configured.
   */
  binaryFormats?: false | BinaryFormatConfig[];
  /**
   * Content source type. Source used to fetch content (usually diff) for `review` or `pr` command.
   *
   * {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}
   */
  contentSource: string;
  /**
   * Requirement source type. Source used to fetch requirements for `review` or `pr` command.
   */
  requirementSource: string;
  /**
   * GS2-43 — the unified prompt-segment config (see {@link PromptsConfig}). Each of the seven
   * segments (`backstory | guidelines | system | chat | code | exec | review`) accepts a string
   * path (e.g. `"guidelines": "AGENTS.md"`) or an object (`{ path?, enabled?, mode? }`). When a
   * segment is omitted its default-named file / bundled default applies unchanged.
   */
  prompts?: PromptsConfig;
  /**
   * CFG-70 — **runtime only**: the `prompts.paths` entries this run's diff actually selected.
   *
   * It is deliberately absent from the zod schema, from `gsloth-config.schema.json` and from every
   * config layer. A user never writes it; `review()` sets it on the already-resolved config after
   * matching the diff's paths against `prompts.paths`, and the prompt-reading layer
   * (`readPromptSegment`) is its only reader. Writing it in a config file would therefore do
   * nothing useful, which is why the schema does not offer it — the schema describes what a user
   * can say, and this is what the run worked out.
   *
   * It carries the **selected entries, not composed text**. File resolution needs the config dir,
   * the identity profile and `noDefaultPrompts`, all of which live in core's prompt-reading layer;
   * keeping this a list of entries is what lets the review package select without knowing any of
   * that.
   */
  scopedPrompts?: ScopedPromptsEntry[];
  /**
   * Separate identity profile.
   * May include separate identity, guidelines and command protocol,
   * making gsloth behave as an agent different from default profile behaviour.
   * for example, `devops` profile to detect changes such as properties and environment variables.
   * Custom config can still win over this one.
   * This setting requires .gsloth/.gsloth-settings directory to exist.
   */
  identityProfile?: string;
  /**
   * Whether to include the current date in the project review instructions or not.
   */
  includeCurrentDateAfterGuidelines: boolean;
  /**
   * Organisation name, locale and timezone.
   * Only used with {@link includeCurrentDateAfterGuidelines}.
   * timeZone and locale should be in format supported by Intl.DateTimeFormat
   */
  organization?: {
    name?: string;
    locale?: string;
    timezone?: string;
  };
  /**
   * If true, only use user-provided system prompts. Do not fall back to the
   * bundled `.gsloth.*.md` prompt files shipped with the installation.
   * This applies to all `.gsloth.*.md` files (backstory, system, chat, code, guidelines, review).
   */
  noDefaultPrompts?: boolean;
  filesystem: string[] | 'all' | 'read' | 'none';
  /**
   * Selects and configures the built-in tools the agent loads. Either a `string[]` of tool names
   * (each enabled) or a registry keyed by tool name whose values enable (`true`), force-disable
   * (`false`), or configure ({@link @gaunt-sloth/core!config/shell-policy.BuiltInToolConfig | BuiltInToolConfig}) each tool. CFG-18 folded the former
   * per-command `devTools` (the `run_*` commands + `run_shell_command`'s EXT-9/10/12 config) into
   * this single registry: e.g. `{ "run_tests": { "command": "npm test" }, "run_shell_command": {
   * "timeout": 300000 } }`. Settable at the root or per command (`commands.<command>.builtInTools`);
   * a per-command value replaces the top-level one.
   */
  builtInTools?: BuiltInToolsSetting;
  /**
   * CFG-27 — the tool-approval **ladder**: one of the five rungs (`manual` · `write` ·
   * `assisted` · `auto` · `bypass`), written either as the bare rung name or as an object
   * carrying the rater's identity profile and the declared allow/deny lists. Each rung fully
   * determines behaviour — there are no severity thresholds, no strictness levels and no
   * independent rater switch.
   *
   * Settable at the root or per command (`commands.<command>.approvals`). §9.1 — a per-command
   * value overrides only the fields it NAMES. `mode`, `rater` and `raterTimeoutMs` replace the
   * root's; `deny` and `escalate` CONCATENATE across every scope, so a per-command rung can never
   * discard the root's prohibitions; `allow` is REPLACED when the command states its own and
   * inherited when it does not, so a scope may narrow what runs unprompted and may never widen
   * what is prohibited (§3.1: a too-broad allow entry runs unrated, a missed deny entry does not).
   * Absent = `assisted`, resolved by `resolveApprovals`.
   */
  approvals?: ApprovalsConfig;
  tools?: StructuredToolInterface[] | BaseToolkit[] | ServerTool[];
  /**
   * Restrict the agent to this allow-list of tool names, applied after every tool source
   * (filesystem, built-in, custom, MCP, A2A, and `tools`) is resolved. This is the only knob
   * that can gate MCP and A2A tools, which have no per-source override of their own.
   *
   * - omitted/undefined: no filtering, all resolved tools remain available.
   * - non-empty array: keep only tools whose name is in the list.
   * - empty array `[]`: disable every tool. MCP servers are not even contacted (no OAuth),
   *   which is useful for agents that only need to reason over the prompt (e.g. the review
   *   agent).
   *
   * Can be overridden per command via `commands.<command>.allowedTools`.
   */
  allowedTools?: string[];
  /**
   * Middleware configuration for LangChain v1.
   * Middleware provides hooks to intercept and control agent execution at critical points.
   *
   * Middleware can be:
   * - Predefined middleware (string or config object) - works in both JSON and JS configs
   * - Custom middleware objects - only available in JS configs
   *
   * Example (JSON config):
   * ```json
   * {
   *   "middleware": [
   *     "summarization",
   *     { "name": "anthropic-prompt-caching", "ttl": "5m" }
   *   ]
   * }
   * ```
   *
   * Example (JS config):
   * ```js
   * {
   *   middleware: [
   *     "summarization",
   *     { beforeModel: (state) => { /* custom logic *\/ return state; } }
   *   ]
   * }
   * ```
   *
   * Available predefined middleware:
   * - `anthropic-prompt-caching`: Reduces API costs by caching prompts (Anthropic only)
   * - `summarization`: Condenses conversation history when approaching token limits
   */
  middleware?: unknown[];
  /**
   * Stream output. Some models do not support streaming. Set value to `false` for them.
   *
   * {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}
   */
  streamOutput: boolean;
  /**
   * Should the output be written to md file.
   * (e.g. gth_2025-07-26_22-59-06_REVIEW.md).
   * Defaults to `false` (no file is written); set to `true` for the standard
   * `gth_<timestamp>_<COMMAND>.md` name.
   * Can be set to false with `-wn` or `-w0`
   * Can be set to a specific filename or path by passing a string:
   * - Bare filenames (e.g. `"review.md"`) are placed in `.gsloth/` when it exists, otherwise project root
   * - Paths with separators (e.g. `"./review.md"` or `"reviews/last.md"`) are always relative to project root
   * Please note the string does not accept absolute path, but allows to exit project with `..` if necessary.
   */
  writeOutputToFile: boolean | string;
  /**
   * Whether binary model outputs should be written to files instead of printed inline.
   * When enabled, supported binary content blocks are materialized as `gth_*.<ext>` files.
   */
  writeBinaryOutputsToFile: boolean;
  /**
   * Use colour in output
   */
  useColour: boolean;
  /**
   * Enable terminal mouse reporting in the Ink TUI, making its affordances clickable.
   * On by default in an interactive terminal. While it is on the terminal's own text selection
   * needs a modifier (Shift, or Option in some macOS terminals) — set this to `false`, or set
   * `GTH_NO_MOUSE`, to get unmodified selection back.
   */
  useMouse: boolean;
  /**
   * TUI-C105 — the default number of output lines a COLLAPSED tool call previews, on both the Ink
   * TUI and the plain surface, before the `… (+N more lines)` overflow marker. `0` reduces every
   * tool call to its one-line summary. Absent, the built-in cap applies
   * (`TOOL_OUTPUT_PREVIEW_LINES` in `core/toolDisplay`); override it for one tool with
   * `builtInTools.<tool>.previewLines`, which ranks above this.
   *
   * **A display cap, not a content cap.** It changes only what is drawn for the human; the model
   * receives every tool result in full regardless. The knobs that change what a tool returns to
   * the model are separate and per-tool (`builtInTools.gth_gh_read_file.maxBytes`,
   * `builtInTools.run_shell_command.maxOutputBytes`).
   *
   * MUST stay optional: absence is what distinguishes "the user chose a depth" from the built-in
   * cap, and the fallback in `getToolPreviewLines` collapses without that distinction.
   */
  toolOutputPreviewLines?: number;
  /**
   * BATCH-49 — how many UTF-8 bytes of a tool result are recorded into run stats and eval results.
   *
   * **The recorded stage, not the other two.** `builtInTools.<tool>.maxOutputBytes` / `maxBytes`
   * cap what a tool returns to the model, and {@link toolOutputPreviewLines} caps what is drawn;
   * this caps what is stored, after the model has already seen the whole result. A longer payload
   * is cut on a character boundary, and the record says so (`contentTruncated`).
   *
   * A positive integer. `0` is rejected rather than read as "unlimited": {@link toolOutputPreviewLines}
   * uses `0` to mean the minimum, and the same number meaning the opposite here is the confusion
   * the rejection exists to prevent. Absent, the read site applies `TOOL_RESULT_CONTENT_CAP`;
   * the default is deliberately not in `DEFAULT_CONFIG`, so the effective-config snapshot does not
   * grow a key nobody set.
   */
  toolResultCaptureMaxBytes?: number;
  /**
   * BATCH-48 — the run-level tool-coverage floor for `gth eval`.
   *
   * Distinct from a suite's own `tool_coverage.min`. That one is graded against the suite that
   * declared it; this one is graded against the run's aggregate, and the two are independent —
   * neither is promoted into the other. A profile is the intended home: one profile declares the
   * MCP server under test and the floor over that server's surface.
   *
   * Optional, with no default and deliberately absent from `DEFAULT_CONFIG`. A run that never set
   * the key has no run floor, and a default written here would invent one for every config that
   * never asked.
   */
  evalToolCoverage?: EvalToolCoverageConfig;
  /**
   * Stream session log instead of writing it when inference streaming is complete.
   * (only works when {@link streamOutput} is true)
   */
  streamSessionInferenceLog: boolean;
  /**
   * Allow inference to be interrupted with esc. Only has an effect in TTY mode.
   */
  canInterruptInferenceWithEsc: boolean;
  /**
   * Log messages and events to gaunt-sloth.log,
   * use llm.verbose or `gth --verbose` as more intrusive option, setting verbose to LangChain / LangGraph
   */
  debugLog?: boolean;
  /**
   * LangGraph recursion limit for an agent run — the maximum number of
   * super-steps (model ↔ tool round-trips) before the graph throws. Defaults to
   * 1000, which suits long coding chains; embodied / tight-loop consumers can
   * lower it so a stuck run fails fast and visibly instead of grinding.
   */
  recursionLimit?: number;
  /**
   * Console logging level. Only messages at or above this level will be displayed.
   * Valid values: 'debug', 'info', 'display', 'success', 'warning', 'error', 'stream'
   * Default: 'info' (not debug)
   */
  consoleLevel?: StatusLevel;
  customTools?: CustomToolsConfig;
  requirementSourceConfig?: Record<string, unknown>;
  contentSourceConfig?: Record<string, unknown>;
  /**
   * MCP (Model Context Protocol) server connections.
   * Allows connecting to external MCP servers including those requiring OAuth.
   * @see {@link https://modelcontextprotocol.io/}
   */
  mcpServers?: Record<string, unknown>;
  /**
   * TLS trust for outbound HTTPS. Primarily so an `http`-transport MCP server behind a
   * private/corporate CA can be reached without prepending `NODE_EXTRA_CA_CERTS` on every
   * invocation. The mechanism is a process-global undici dispatcher, so it applies to ALL
   * outbound `fetch` this process makes (LLM provider calls included), not only MCP.
   */
  tls?: {
    /**
     * Extra CA certificate file(s) to trust IN ADDITION to Node's built-in roots. Paths resolve
     * relative to the project dir (or `~`/absolute). Additive — never removes a default root.
     */
    extraCaCerts?: string[];
    /**
     * DANGER — `false` disables TLS certificate verification for ALL outbound HTTPS this process
     * makes, not just MCP. Escape hatch only; a loud security warning is emitted every session.
     */
    rejectUnauthorized?: boolean;
  };
  /**
   * A2A (Agent-to-Agent) protocol agents configuration.
   * Enables delegation of tasks to external AI agents.
   * Each agent becomes available as a tool named `a2a_agent_<agentId>`.
   * @experimental This feature is experimental and may change.
   * @see {@link https://a2a-protocol.org/}
   */
  a2aAgents?: Record<string, unknown>;
  builtInToolsConfig?: BuiltInToolsConfig;
  aiignore?: {
    enabled?: boolean;
    patterns?: string[];
  };
  commands?: {
    pr?: PrCommandConfig;
    review?: ReviewCommandConfig;
    ask?: CommandToolingConfig;
    chat?: CommandToolingConfig;
    /**
     * `gth code` — interactive coding session. Carries the do-the-job tool/filesystem knobs; the
     * dev/shell tools (CFG-18) are configured via {@link CommandToolingConfig.builtInTools}.
     */
    code?: CommandToolingConfig;
    /**
     * `gth exec` — prompt-as-script runtime. Like `code`, an exec run may need to actually
     * do the job (read/write files, run commands), so it carries the same tool/filesystem knobs.
     */
    exec?: CommandToolingConfig;
    api?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: BuiltInToolsSetting;
      /**
       * §9.1 — per-command approvals posture. It overrides only the fields it NAMES: `mode`,
       * `rater`, `raterTimeoutMs` and `allow` replace the root's, while `deny` and `escalate`
       * concatenate with it. See {@link GthConfig.approvals}.
       */
      approvals?: ApprovalsConfig;
      port?: number;
      /**
       * The interface the AG-UI server binds. Defaulted at the read site rather than in
       * `DEFAULT_CONFIG` — see `DEFAULT_AGUI_HOST` in `@gaunt-sloth/agent`'s `apiAgUiModule`, which
       * is IPv4 loopback. Set `0.0.0.0` (or `::` for IPv6 as well) to accept connections from the
       * network; the endpoint has no authentication, so that is a deliberate exposure.
       *
       * One `listen` binds one address, so the default is IPv4 loopback and not both loopbacks: a
       * client on this machine that resolves `localhost` to `::1` and does not retry over IPv4 is
       * refused. Set `::1` for that one — IPv6 loopback, still this machine only.
       */
      host?: string;
      cors?: {
        allowOrigin?: string;
        allowMethods?: string;
        allowHeaders?: string;
      };
    };
  };
  /**
   * EXT-117 — the ACP (Agent Client Protocol) surface, i.e. a session an editor such as Zed opens.
   *
   * `mode` is the command an ACP session is resolved under, and it defaults to **`code`**: an
   * editor asks for an agent that can do the job, and a read-only one is a worse default than an
   * occasional prompt. Set `acp: { mode: 'chat' }` for a read-only editor agent.
   *
   * The deliberate consequence, because it is what makes this overridable without a second parallel
   * config surface: the mode names an EXISTING command, so an ACP session is configured by that
   * command's own block. At the default the session takes its `filesystem`, `approvals`,
   * `builtInTools` and mode prompt from **{@link GthConfig.commands}`.code`** — the same settings
   * `gth code` runs under — and at `chat` from `commands.chat`. There is no ACP-only copy of those
   * knobs to keep in step.
   *
   * Defaulted at the read site (not in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}) to avoid churning the
   * effective-config snapshot, à la {@link injectModelContext}.
   */
  acp?: {
    mode?: GthAcpSessionMode;
  };
  /**
   * GS2-35/EXT-83 — identity for the `Co-Authored-By` trailer of agent-authored git commits. Gaunt
   * Sloth has no dedicated commit tool (it commits via `run_shell_command`), so this identity is
   * injected into the code-mode system prompt, which instructs the agent to co-author commits as
   * this account. Optional and defaulted, each field independently: when the name is unset the
   * default is {@link @gaunt-sloth/core!constants.DEFAULT_COMMIT_CO_AUTHOR_NAME | DEFAULT_COMMIT_CO_AUTHOR_NAME} decorated with the resolved active model —
   * `Gaunt Sloth (provider:model)` — falling back to the bare
   * {@link @gaunt-sloth/core!constants.DEFAULT_COMMIT_CO_AUTHOR_NAME | DEFAULT_COMMIT_CO_AUTHOR_NAME} when no model resolves or {@link injectModelContext} is
   * `false`; when the email is unset it is {@link @gaunt-sloth/core!constants.DEFAULT_COMMIT_CO_AUTHOR_EMAIL | DEFAULT_COMMIT_CO_AUTHOR_EMAIL}. A CONFIGURED
   * name is emitted verbatim — the model identity decorates only the default.
   */
  commit?: {
    coAuthor?: {
      name?: string;
      email?: string;
    };
  };
  modelDisplayName?: string;
  /**
   * GS2-53 — the configured provider `type` string (`openrouter`/`deepseek`/`xai`/`anthropic`/…),
   * stashed by the loader from the raw `llm.type` before the built `BaseChatModel` replaces the raw
   * spec. INTERNAL (loader-set, never user-supplied), so it is deliberately absent from the config
   * schema. {@link @gaunt-sloth/core!utils/systemPromptNotes.resolveModelIdentity | resolveModelIdentity} PREFERS this over
   * the live model's `_llmType()` for the injected identity, because that is the model class's own
   * label rather than the gth provider namespace (`huggingface` reports `openai`, and both Gemini
   * providers report `google`) and would otherwise mislabel the provider half. Absent for module
   * configs (which hand us an already-built
   * LLM with no raw `type`), where resolution falls back to the guarded `_llmType()`.
   */
  modelProviderType?: string;
  /**
   * GS2-34 — inject the resolved active `provider:model` identity into the assembled system prompt
   * so the agent knows which model is serving it (to answer "what model are you?" and reason about
   * its own capabilities/limits). Default ON (omitted = inject). Opt out with
   * `injectModelContext: false` to keep reproducible / model-agnostic runs (e.g. review) blind to
   * the identity — when off, the assembled prompt is exactly as it is without this feature.
   *
   * EXT-83 — it governs the model identity EVERYWHERE in the prompt, not just the identity line:
   * in `code` mode the same resolved identity decorates the default git commit co-author name
   * ({@link GthConfig.commit}), so turning this off also removes the model from the commit trailer,
   * which degrades to the plain default name. The identity LINE applies in all modes; the trailer
   * it also feeds is code-mode-only, like the cwd/os-shell notes. Defaulted at the read site (not
   * in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}) to avoid churning the effective-config snapshot.
   */
  injectModelContext?: boolean;
  /**
   * GS2-47 — controls the shared secret-redaction pass applied to `/debug-dump` archives. Default
   * ON (omitted = redact): secret-named env-var values, inline config secrets, provider-key/auth
   * patterns and sensitive config fields are masked before any artifact hits disk. Set
   * `debugDump.redact: false` (or run `/debug-dump --unsafe-no-redact`) to write a RAW archive, which
   * the command flags with a loud "may contain secrets" warning. Defaulted at the read site (not in
   * {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}) to avoid churning the effective-config snapshot.
   */
  debugDump?: {
    redact?: boolean;
  };
  /**
   * Transient (runtime-only) extra filesystem roots the agent may read/write for THIS run, in
   * addition to the cwd sandbox. Populated by `gth exec --allow-dir <path>` (repeatable); never
   * persisted to a config file.
   *
   * **Currently inert.** The permission layer that widened the sandbox belonged to the deepagents
   * backend; the filesystem toolkit the lean agent uses is rooted at the cwd and has no notion of
   * extra roots. The field, the flag and the config merge policy are kept so a config and a script
   * that already declare roots keep working when widening returns, and `gth exec` says plainly
   * that the flag does nothing rather than announcing a widening that never happens — a warning
   * about a guardrail that was not actually removed teaches the user to distrust the warnings.
   */
  allowDirs?: string[];
  /**
   * Transient (runtime-only) flag set by `gth ask --write`: opt `ask` into the same
   * "do-the-job" filesystem + dev tools that `exec`/`code` get, so a question can act
   * (read/write files, run commands) rather than only chat. Never persisted to a config file.
   */
  askWriteMode?: boolean;
  /**
   * GS2-93 — output surface controls.
   *
   * `output.header` grades what a NON-TUI text run (`--no-tui`, `ask`, `exec`, `eval`, `pr`,
   * `review`, piped/CI) opens with, across three rungs:
   *
   * - `debug` — the full technical preamble: the Workdir/Model/Tools/Middleware status block, the
   *   `Press Escape or Q to interrupt` hint, and their surrounding blank lines.
   * - `compact` (the DEFAULT, so an unset key opens with this) — no preamble, and one attribution
   *   line naming the command and the model that served it. `review`/`pr` render their existing
   *   attribution block instead of this line.
   * - `none` — nothing at all, including the review attribution block, for a byte-clean stream a
   *   caller can diff or template.
   *
   * The interactive TUI ignores the setting and always shows the full header. Only the opening is
   * graded — never model/tool output, errors, or config-validation warnings, and never the live
   * `Thinking…` indicator. Defaulted at the read site, not in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}, to avoid
   * churning the effective-config snapshot.
   */
  output?: {
    header?: GthOutputHeaderRung;
  };
  /**
   * [[EXT-178]] — the end-of-run recap: a short paragraph on the one stop that says nothing today.
   *
   * Every ending except `completed` and `suspended` already announces itself, so the run that
   * *looks* like success — text, no tool calls, no error — is the silent one, whether or not it
   * finished the job. This grades what that stop says, across three rungs:
   *
   * - `off` (the DEFAULT, so an unset key behaves exactly as before this existed) — nothing. The
   *   deterministic unfinished-checklist notice still speaks, unchanged.
   * - `outstanding` — a recap only on a clean stop whose own checklist still lists work. The
   *   cheapest rung that buys the feature's point, and the one to reach for first.
   * - `always` — a recap on every clean stop, including the ones where nothing is left. A recap of
   *   a run that went well is useful in its own right, which is what makes this a feature rather
   *   than a diagnostic.
   *
   * **It costs a model call**, a small non-agentic one made after the turn has already ended, which
   * is why the default is `off` — see `DEFAULT_RUN_RECAP_RUNG` in `core/runRecap.ts` for the whole
   * argument. Defaulted at the read site, not in `DEFAULT_CONFIG`, to avoid churning the
   * effective-config snapshot. **When a recap renders, it replaces the unfinished-checklist notice
   * for that stop** rather than appearing beside it, and carries the same counts.
   *
   * Honoured on `chat`/`code` (both the TUI and `--no-tui`), `ask` and `exec`. Deliberately not on
   * `batch`, `eval`, `workflow`, `review`, `pr`, ACP or AG-UI — see `SingleShotOptions` and the
   * node for why each is excluded.
   */
  recap?: GthRunRecapRung;
  /**
   * EXT-36 — the tool-loop guard: a repeated-identical-`(tool, args)` / no-progress detector that
   * runs as a lean-backend `beforeModel` middleware, the orthogonal sibling of GS2-36's
   * consecutive-tool-ERROR budget. It catches the case GS2-36 leaves open — a model re-issuing the
   * SAME call verbatim, whether it keeps erroring or keeps "succeeding" with the same result.
   *
   * - `false` disables it entirely.
   * - `true` / omitted → WARN on, HALT off, default threshold ({@link @gaunt-sloth/core!core/GthLangChainAgent.DEFAULT_TOOL_LOOP_THRESHOLD | DEFAULT_TOOL_LOOP_THRESHOLD}).
   * - object → per-field: `warn` (default ON) injects a control-flow-free nudge at the threshold;
   *   `halt` (default OFF, opt-in) ends the run cleanly (`jumpTo:'end'`, never a throw) at the
   *   threshold; `threshold` is the number of consecutive identical calls that trip it.
   *
   * WARN is provably harmless (no routing effect, one nudge per signature per streak). The WARN-on
   * default is applied at the read site (not in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}) to avoid churning the
   * effective-config snapshot.
   */
  toolLoopGuard?: boolean | { warn?: boolean; halt?: boolean; threshold?: number };
  /**
   * EXT-161 — **preventive conversation compaction: ON BY DEFAULT.**
   *
   * When the conversation is about to outgrow the model's context window, the older part is folded
   * into a summary *before* the request is sent, rather than after the provider has rejected it.
   * The threshold is derived from the model's real window — the models.dev catalog first, the
   * provider package's own model profile as a backstop — and when neither knows the window,
   * **nothing fires**: a guessed threshold is worse than none, because the user cannot see it.
   *
   * - `false` (or `{ enabled: false }`) turns it off; the conversation is never folded
   *   preventively and `state.messages` is left exactly as it is.
   * - `true` / omitted → on, with the threshold derived from the window.
   * - a count (`300000`), a suffixed count (`'300K'`, `'0.9M'`) or a share of the window
   *   (`'80%'`) sets the threshold explicitly. `K` is 1000 and `M` is 1,000,000 — decimal, because
   *   provider token counts are decimal everywhere.
   * - object → `{ enabled?, threshold? }` spells both out.
   *
   * A malformed threshold is a hard validation error naming the offending text; it never silently
   * becomes `NaN`, `0` or a default. `/autocompact` moves the number for one session, and
   * `/status` reports the number in force and where it came from.
   *
   * The on-by-default is applied at the read site (`resolveAutocompactConfig`), not in
   * `DEFAULT_CONFIG`, to avoid churning the effective-config snapshot.
   */
  autocompact?: boolean | number | string | { enabled?: boolean; threshold?: number | string };
  /**
   * CFG-37 — persistent surface preference for the `chat`/`code` interactive sessions, settable in
   * both the global and the project config (the project layer wins). `true` asks for the Ink TUI,
   * `false` for the plain readline session, absent leaves the terminal auto-detect in charge —
   * which is why it must stay optional, exactly as {@link useColour}/{@link useMouse} do.
   *
   * This is the CONFIG-FILE preference, one rung of a chain rather than the answer: the
   * `--tui`/`--no-tui` flags and the `GTH_NO_TUI` escape hatch both outrank it, and the capability
   * gates (no TTY, `TERM=dumb`, `ink` not installed) outrank everything because they are checks and
   * not preferences — so `true` degrades to readline rather than forcing a crash. Deliberately NOT
   * in {@link @gaunt-sloth/core!config/defaults.DEFAULT_CONFIG | DEFAULT_CONFIG}. The flag arrives separately as
   * {@link CommandLineConfigOverrides.tui}; the two meet only in `shouldUseTui`.
   */
  tui?: boolean;
  /**
   * BATCH-19 — custom `gth eval` reporters, keyed by the NAME they are selected under
   * (`gth eval … --reporter <name>`). Each value is a MODULE PATH, resolved relative to the project
   * dir, whose **default export** is an `EvalReporterFactory` (`() => EvalReporter`). Loaded and
   * registered through the SAME seam the bundled reporters (`text`, `junit`) use, so a config
   * reporter can also override a built-in of the same name (config wins). A missing file, a failed
   * import, or a non-function default export is a hard error (the eval harness exits 2). Trusted:
   * it is the user's own config, which already executes arbitrary JS.
   */
  reporters?: Record<string, string>;
  /**
   * GS2-33 — profile-backed subagents. Each entry names a subagent and the {@link
   * SubagentProfileSpec.profile named config profile} the CHILD resolves when the parent spawns it,
   * so a subagent can run under a different model/tools/prompt than the parent (a cheap profile for
   * recall/search while the parent runs on a strong model). **Currently honored by nothing:** its
   * only consumer was the deep (deepagents) backend, whose `task` tool gained one selectable
   * subagent per entry, and that backend has been removed. The key is still accepted and warns on
   * use; the lean backend's own subagent primitive lands in GS2-25.
   */
  subagents?: SubagentProfileSpec[];
}

/**
 * `gth pr` command configuration.
 *
 * Declared as a named interface (rather than inline in {@link GthConfig}) so that downstream
 * packages can extend it with their own command features via TypeScript module augmentation
 * (`declare module '@gaunt-sloth/core/config.js'`), keeping those features' types out of core.
 * For example, the assistant package merges its PR discovery config (`discovery`) into this
 * interface.
 */
export interface PrCommandConfig extends CommandToolingConfig {
  contentSource?: string;
  requirementSource?: string;
  logWorkForReviewInSeconds?: number;
  rating?: RatingConfig;
}

/**
 * `gth review` command configuration.
 *
 * A named interface for the same reason as {@link PrCommandConfig}: the assistant package merges
 * its review requirements discovery config (`discovery`) into it via module augmentation, which a
 * type alias or an inline intersection cannot take.
 */
export interface ReviewCommandConfig extends CommandToolingConfig {
  contentSource?: string;
  requirementSource?: string;
  rating?: RatingConfig;
}

/**
 * Server tools such as Anthropic Web Search.
 * These tools are meant to be magic objects like
 * `{"type": "web_search_20250305", "name": "web_search", "max_uses": 10}`,
 * AI Provider does the rest of the magic on their side.
 */
export interface ServerTool extends Record<string, unknown> {
  type: string;
  name?: string;
}

/**
 * Raw, unprocessed Gaunt Sloth config.
 */
export type ConsoleLevelInput =
  StatusLevel | keyof typeof StatusLevel | Lowercase<keyof typeof StatusLevel>;

export interface RawGthConfig extends Omit<GthConfig, 'llm' | 'consoleLevel'> {
  llm: LLMConfig;
  consoleLevel?: ConsoleLevelInput;
  /**
   * GS2-41 — profile composition. When set on a NAMED profile config, this profile inherits from
   * the named base profile: the base resolves first, then this profile's fields merge on top
   * (last-wins). Raw-config-only — resolved and consumed at load time (`resolveConfigExtends`), so
   * it never appears on the resolved {@link GthConfig}.
   */
  extends?: string;
}

/**
 * Every format type the binary pipeline can MEET — deliberately wider than the set a config may
 * declare.
 *
 * `image`, `file` and `audio` are the deliverable three, and `DELIVERABLE_BINARY_FORMAT_TYPES` in
 * `config/schema.js` is the authority on that: a `binaryFormats` entry naming anything else is a
 * hard config error, because no provider's message converter can build a request from it.
 *
 * `video` and `binary` stay in this union because the code that RECOGNISES and refuses them needs
 * to be able to name them. They still arrive from a `GthConfig` an embedder built in code rather
 * than loading, which no loader has validated, and the injection boundary turns each into an error
 * naming the file and the configured type. Deleting them here would delete that handling instead of
 * the values, and the first casualty is `getFormatForExtension`'s last-resort bucket, whose loss
 * replaces a message naming the file and the format type with one naming neither.
 */
export type BinaryFormatType = 'image' | 'file' | 'audio' | 'video' | 'binary';

export interface BinaryFormatConfig {
  /**
   * The type/category of binary format.
   */
  type: BinaryFormatType;
  /**
   * List of allowed extensions for this type (without leading dot).
   */
  extensions: string[];
  /**
   * Maximum file size in bytes. Defaults to 10MB when omitted.
   */
  maxSize?: number;
  /**
   * Optional MIME type overrides for extensions not in the default mapping.
   */
  mimeTypes?: Record<string, string>;
}

export type CustomToolsConfig = Record<string, CustomCommandConfig>;
export type BuiltInToolsConfig = Record<string, unknown>;

/**
 * Configuration for review rating feature.
 * Allows configuring automated review scoring with pass/fail thresholds.
 */
export interface RatingConfig {
  /**
   * Enable or disable review rating.
   * @default true
   */
  enabled?: boolean;
  /**
   * Minimum score (0-10) required to pass the review.
   * @default 6
   */
  passThreshold?: number;
  /**
   * Highest allowed value on the rating scale.
   * @default 10
   */
  maxRating?: number;
  /**
   * Lowest allowed value on the rating scale.
   * @default 0
   */
  minRating?: number;
  /**
   * Exit with error code 1 when review fails (below threshold).
   * When false, exits normally (code 0) regardless of rating.
   * @default true
   */
  errorOnReviewFail?: boolean;
  /**
   * Wall-clock budget (ms) for the single rating model call.
   *
   * GS2-105 — rating is a SECOND model call fired from `afterAgent` once the review prose is
   * already written, and it renders nothing while it runs. Without a bound, a model that fails to
   * emit the rating tool call generates prose until its context window stops it: measured at 15,385
   * tokens and 485 seconds on `gemma4:12b`, against a healthy rating call of ~50 seconds. The budget
   * turns that silent hang into a bounded, legible failure, after which the existing
   * missing-artifact path reports it and exits non-zero.
   *
   * It is a WALL-CLOCK budget for one call, not a per-token cap, because the per-token knob is not
   * portable: `numPredict` is a constructor field on `ChatOllama` rather than a call option, and
   * that provider declares `tool_choice?: never`, so neither of the obvious source-level remedies is
   * available where this actually bites. `timeout` is a standard `RunnableConfig` field, so it works
   * on every provider and genuinely aborts the request instead of merely abandoning it.
   *
   * @default 120000
   */
  timeoutMs?: number;
}

/**
 * Validation checks that can be skipped for custom command parameters.
 * Use with the `allow` property to bypass specific security checks.
 *
 * - `absolute-paths`: Allow absolute paths (e.g. `/dev/ttyUSB0`)
 * - `directory-traversal`: Allow `..` in paths
 * - `shell-injection`: Allow shell metacharacters (`|`, `&`, `;`, etc.)
 * - `null-bytes`: Allow null bytes in values
 */
export type ValidationCheck =
  'absolute-paths' | 'directory-traversal' | 'shell-injection' | 'null-bytes';

/**
 * Configuration for a custom command parameter.
 * Parameters allow the model to provide dynamic values to commands.
 */
export interface CustomCommandParameter {
  /**
   * Description of the parameter shown to the model.
   */
  description: string;
  /**
   * Optional list of validation checks to skip for this parameter's value.
   * Use when this parameter legitimately requires values that would normally be blocked.
   * For example, `["absolute-paths"]` allows values like `/dev/ttyUSB0` for this parameter.
   *
   * Available checks: `absolute-paths`, `directory-traversal`, `shell-injection`, `null-bytes`
   */
  allow?: ValidationCheck[];
}

/**
 * Configuration for a custom command.
 * Custom commands can be executed with or without parameters.
 */
export interface CustomCommandConfig {
  /**
   * The shell command to execute.
   * Can include placeholders like ${paramName} that will be replaced with parameter values.
   * If no placeholder is present and parameters are provided, they are appended to the command.
   */
  command: string;
  /**
   * Description of what this command does, shown to the model.
   */
  description: string;
  /**
   * Optional parameters that the model can provide when calling this command.
   * Each parameter has a name (the key) and a description.
   * Parameters are validated for security (no shell injection, directory traversal, etc.).
   */
  parameters?: Record<string, CustomCommandParameter>;
  /**
   * Optional timeout in seconds.
   * When set, the command will be killed if it exceeds this duration.
   * When omitted, no timeout is applied.
   */
  timeout?: number;
}

export interface LLMConfig extends Record<string, unknown> {
  type: string;
  model: string;
  configuration: Record<string, unknown>;
  apiKeyEnvironmentVariable?: string;
}

export const availableDefaultConfigs = [
  'vertexai',
  'anthropic',
  'groq',
  'deepseek',
  'openai',
  'google-genai',
  'xai',
  'openrouter',
  'huggingface',
  'ollama',
] as const;
export type ConfigType = (typeof availableDefaultConfigs)[number];

export interface CommandLineConfigOverrides {
  /**
   * Custom config path
   */
  customConfigPath?: string;
  /**
   * Set LangChain/LangGraph to verbose mode,
   * causing LangChain/LangGraph to log many details to the console.
   * debugLog from config.ts may be a less intrusive option.
   */
  verbose?: boolean;
  /**
   * Should the output be written to md file.
   * (e.g. gth_2025-07-26_22-59-06_REVIEW.md).
   * Defaults to `false` (no file is written); set to `true` for the standard
   * `gth_<timestamp>_<COMMAND>.md` name.
   * Can be set to false with `-wn` or `-w0`
   * Can be set to a specific filename or path by passing a string:
   * - Bare filenames (e.g. `"review.md"`) are placed in `.gsloth/` when it exists, otherwise project root
   * - Paths with separators (e.g. `"./review.md"` or `"reviews/last.md"`) are always relative to project root
   * Please note the string does not accept absolute path, but allows to exit project with `..` if necessary.
   */
  writeOutputToFile?: boolean | string;
  /**
   * Separate identity profile.
   * May include separate identity, guidelines and command protocol,
   * making gsloth behave as an agent different from default profile behaviour.
   * for example, `devops` profile to detect changes such as properties and environment variables.
   * Custom config can still win over this one.
   * This setting requires .gsloth/.gsloth-settings directory to exist.
   * Important to note that the profile directory substitutes the entire config directory,
   * in the case if some prompt files are missing - a file from the installation directory will be used.
   */
  identityProfile?: string;
  /**
   * Interactive TUI activation override for chat/code sessions, as passed on the command line.
   * - `true` (`--tui`): force the Ink TUI on where the terminal supports it (it outranks the
   *   `GTH_NO_TUI` escape hatch, the {@link GthConfig.tui} config key and the CI auto-off
   *   heuristic).
   * - `false` (`--no-tui`): force the plain readline session.
   * - `undefined` (default): defer to the next rung down — `GTH_NO_TUI`, then the
   *   {@link GthConfig.tui} config key, then terminal auto-detect.
   * This carries only the FLAG; the persistent preference is {@link GthConfig.tui}. The decision
   * that ranks them lives in `gaunt-sloth`'s `shouldUseTui`.
   */
  tui?: boolean;
  /**
   * BATCH-1 fix — run with a different model than the configured `llm.model`, just for this
   * `initConfig()` call. Used by `gth batch --models a,b,c` to build one genuinely fresh
   * `GthConfig` (with its own freshly-constructed `.llm`) per distinct model in the matrix,
   * instead of structurally cloning an already-instantiated LangChain model object (unsafe for
   * any provider class that keeps state behind private `#fields`). Applied in
   * {@link @gaunt-sloth/core!config/loader.tryJsonConfig | tryJsonConfig} by overriding `llmConfig.model` before the provider's
   * `processJsonConfig()` builds the instance, so it flows through the same supported
   * construction path every other model comes from.
   *
   * Only takes effect for JSON (`.gsloth.config.json`) configs — a `configure()`-style JS/MJS/TS
   * module config already returns a fully-built `GthConfig` (LLM included) with no generic seam
   * to re-target its model.
   */
  model?: string;
  /**
   * Run with global configuration only, bypassing project-level configuration.
   * When true, up-tree project config discovery is bypassed, loading configuration
   * solely from ~/.gsloth/ (merged over default fallbacks).
   * If paired with an identity profile, resolves under ~/.gsloth/.gsloth-settings/<name>/.
   */
  global?: boolean;
}
