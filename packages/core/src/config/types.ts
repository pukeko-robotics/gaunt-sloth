/**
 * @packageDocumentation
 * Gaunt Sloth configuration types. Extracted verbatim from the former `config.ts`
 * god-file; the public type surface is unchanged. The shell/dev-tools policy types
 * live in `./shell-policy.ts`; defaults in `./defaults.ts`; the loader in `./loader.ts`.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import type { StatusLevel } from '#src/core/types.js';
import type { BuiltInToolsSetting } from '#src/config/shell-policy.js';

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
  customTools?: CustomToolsConfig | false;
  /** See {@link GthConfig.allowedTools}. */
  allowedTools?: string[];
  binaryFormats?: false | BinaryFormatConfig[];
}

/**
 * This is a processed Gaunt Sloth config ready to be passed down into components.
 *
 * Default values can be found in {@link DEFAULT_CONFIG}
 */
export interface GthConfig {
  llm: BaseChatModel;
  /**
   * Selects the agent backend.
   * - `lean` (default when omitted): the plain LangChain agent ({@link GthLangChainAgent}). It is
   *   given gsloth's full toolset (filesystem + hardened dev/shell + the `gth_checklist` planning
   *   tool), with no deepagents machinery (no `/large_tool_results` offload). This is the
   *   recommended backend and the default for the CLI (code/chat), single-shot (ask/exec), and
   *   the AG-UI/api server.
   * - `deep` (**experimental**, opt-in): the deepagents runtime (subagents, `write_todos`,
   *   summarization, tool-result offload). Selecting it emits a warning. It can exhibit
   *   path-divergence and sporadic failures and carries extra internal workarounds; prefer `lean`.
   *
   * Honored everywhere; the ACP server is still structurally deep-only and always runs deep.
   */
  agent?: { backend?: 'deep' | 'lean' };
  /**
   * GS2-7 (B20) — local, opt-in session history store. DEFAULT OFF (absent = disabled): a default
   * run persists nothing and behaves exactly as before. When `enabled`, each run is recorded to a
   * local SQLite DB (`~/.gsloth/history.db` by default, overridable via `dbPath`) for
   * `gth history search` / `gth insights`. Local only — no telemetry leaves the machine.
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
   * {@link DEFAULT_CONFIG#contentSource}
   */
  contentSource: string;
  /**
   * Requirement source type. Source used to fetch requirements for `review` or `pr` command.
   */
  requirementSource: string;
  /**
   * Path to project-specific guidelines.
   * The default is `.gsloth.guidelines.md`; this config may be used to point Gaunt Sloth to a different file,
   * for example, to AGENTS.md
   */
  projectGuidelines: string;
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
  projectReviewInstructions: string;
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
   * (`false`), or configure ({@link BuiltInToolConfig}) each tool. CFG-18 folded the former
   * per-command `devTools` (the `run_*` commands + `run_shell_command`'s EXT-9/10/12 config) into
   * this single registry: e.g. `{ "run_tests": { "command": "npm test" }, "run_shell_command": {
   * "timeout": 300000 } }`. Settable at the root or per command (`commands.<command>.builtInTools`);
   * a per-command value replaces the top-level one.
   */
  builtInTools?: BuiltInToolsSetting;
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
   * {@link DEFAULT_CONFIG#streamOutput}
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
    review?: CommandToolingConfig & {
      contentSource?: string;
      requirementSource?: string;
      rating?: RatingConfig;
    };
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
      port?: number;
      cors?: {
        allowOrigin?: string;
        allowMethods?: string;
        allowHeaders?: string;
      };
    };
  };
  /**
   * GS2-35 — identity for the `Co-Authored-By` trailer of agent-authored git commits. Gaunt Sloth
   * has no dedicated commit tool (it commits via `run_shell_command`), so this identity is injected
   * into the code-mode system prompt, which instructs the agent to co-author commits as this account
   * and NEVER as the underlying model. Optional and defaulted: when unset (or a field is unset) the
   * agent co-authors as {@link DEFAULT_COMMIT_CO_AUTHOR_NAME} `<`{@link DEFAULT_COMMIT_CO_AUTHOR_EMAIL}`>`.
   */
  commit?: {
    coAuthor?: {
      name?: string;
      email?: string;
    };
  };
  modelDisplayName?: string;
  /**
   * GS2-34 — inject the resolved active `provider:model` identity into the assembled system prompt
   * so the agent knows which model is serving it (to answer "what model are you?" and reason about
   * its own capabilities/limits). Default ON (omitted = inject). Opt out with
   * `injectModelContext: false` to keep reproducible / model-agnostic runs (e.g. review) blind to
   * the identity — when off, the assembled prompt is exactly as it is without this feature. Applies
   * in ALL modes (unlike the code-mode-only cwd/os-shell/commit notes). Defaulted at the read site
   * (not in {@link DEFAULT_CONFIG}) to avoid churning the effective-config snapshot.
   */
  injectModelContext?: boolean;
  /**
   * GS2-47 — controls the shared secret-redaction pass applied to `/debug-dump` archives. Default
   * ON (omitted = redact): secret-named env-var values, inline config secrets, provider-key/auth
   * patterns and sensitive config fields are masked before any artifact hits disk. Set
   * `debugDump.redact: false` (or run `/debug-dump --unsafe-no-redact`) to write a RAW archive, which
   * the command flags with a loud "may contain secrets" warning. Defaulted at the read site (not in
   * {@link DEFAULT_CONFIG}) to avoid churning the effective-config snapshot.
   */
  debugDump?: {
    redact?: boolean;
  };
  /**
   * Transient (runtime-only) extra filesystem roots the agent is allowed to read/write for
   * THIS run, in addition to the cwd sandbox. Populated by `gth exec --allow-dir <path>`
   * (repeatable); never persisted to a config file. When set, the deep agent's
   * {@link FilesystemBackend} drops `virtualMode` (so absolute paths and `..` resolve on the
   * real filesystem) and access is constrained to cwd + these dirs via permission allow-rules.
   * Removing the cwd-only sandbox is a guardrail removal, so callers announce it loudly.
   */
  allowDirs?: string[];
  /**
   * Transient (runtime-only) flag set by `gth ask --write`: opt `ask` into the same
   * "do-the-job" filesystem + dev tools that `exec`/`code` get, so a question can act
   * (read/write files, run commands) rather than only chat. Never persisted to a config file.
   */
  askWriteMode?: boolean;
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
}

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
   * Interactive TUI activation override for chat/code sessions.
   * - `true` (`--tui`): force the Ink TUI on where the terminal supports it (also overrides
   *   the CI auto-off heuristic).
   * - `false` (`--no-tui`): force the plain readline session.
   * - `undefined` (default): auto-detect from the terminal.
   * The decision itself lives in `gaunt-sloth`'s `shouldUseTui`; this only carries the flag.
   */
  tui?: boolean;
  /**
   * BATCH-1 fix — run with a different model than the configured `llm.model`, just for this
   * `initConfig()` call. Used by `gth batch --models a,b,c` to build one genuinely fresh
   * `GthConfig` (with its own freshly-constructed `.llm`) per distinct model in the matrix,
   * instead of structurally cloning an already-instantiated LangChain model object (unsafe for
   * any provider class that keeps state behind private `#fields`). Applied in
   * {@link tryJsonConfig} by overriding `llmConfig.model` before the provider's
   * `processJsonConfig()` builds the instance, so it flows through the same supported
   * construction path every other model comes from.
   *
   * Only takes effect for JSON (`.gsloth.config.json`) configs — a `configure()`-style JS/MJS/TS
   * module config already returns a fully-built `GthConfig` (LLM included) with no generic seam
   * to re-target its model.
   */
  model?: string;
}
