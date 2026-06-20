/**
 * @packageDocumentation
 * Gaunt Sloth Configuration.
 *
 * Refer to {@link GthConfig} to find all possible configuration properties.
 *
 * Refer to {@link DEFAULT_CONFIG} for default configuration.
 *
 * Some config params can be overriden from command line, see {@link CommandLineConfigOverrides}
 */
import {
  PROJECT_GUIDELINES,
  PROJECT_REVIEW_INSTRUCTIONS,
  USER_PROJECT_CONFIG_JS,
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_MJS,
} from '#src/constants.js';
import { StatusLevel } from '#src/core/types.js';
import {
  displayDebug,
  displayError,
  displayInfo,
  displayWarning,
  setConsoleLevel,
} from '#src/utils/consoleUtils.js';
import { getGslothConfigReadPath, importExternalFile } from '#src/utils/fileUtils.js';
import { getGlobalGslothConfigReadPath } from '#src/utils/globalConfigUtils.js';
import { error, exit, isTTY, setUseColour } from '#src/utils/systemUtils.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseToolkit, StructuredToolInterface } from '@langchain/core/tools';
import { existsSync, readFileSync } from 'node:fs';

/**
 * This is a processed Gaunt Sloth config ready to be passed down into components.
 *
 * Default values can be found in {@link DEFAULT_CONFIG}
 */
export interface GthConfig {
  llm: BaseChatModel;
  /**
   * Binary format support configuration.
   * Disabled by default unless explicitly configured.
   */
  binaryFormats?: false | BinaryFormatConfig[];
  /**
   * Content Provider. Provider used to fetch content (usually diff) for `review` or `pr` command.
   *
   * {@link DEFAULT_CONFIG#contentProvider}
   */
  /**
   * Content source type. Preferred name for contentProvider.
   */
  contentSource: string;
  /**
   * Requirement source type. Preferred name for requirementsProvider.
   */
  requirementSource: string;
  /**
   * @deprecated Use contentSource instead
   */
  contentProvider: string;
  /**
   * @deprecated Use requirementSource instead
   */
  requirementsProvider: string;
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
  builtInTools?: string[];
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
  /** @deprecated Use requirementSourceConfig instead */
  requirementsProviderConfig?: Record<string, unknown>;
  /** @deprecated Use contentSourceConfig instead */
  contentProviderConfig?: Record<string, unknown>;
  /**
   * MCP (Model Context Protocol) server connections.
   * Allows connecting to external MCP servers including those requiring OAuth.
   * @see {@link https://modelcontextprotocol.io/}
   */
  mcpServers?: Record<string, unknown>;
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
    review?: {
      contentSource?: string;
      requirementSource?: string;
      /** @deprecated Use requirementSource instead */
      requirementsProvider?: string;
      /** @deprecated Use contentSource instead */
      contentProvider?: string;
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      customTools?: CustomToolsConfig | false;
      /** See {@link GthConfig.allowedTools}. Empty array disables all tools for the review agent. */
      allowedTools?: string[];
      rating?: RatingConfig;
      binaryFormats?: false | BinaryFormatConfig[];
    };
    ask?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      customTools?: CustomToolsConfig | false;
      /** See {@link GthConfig.allowedTools}. */
      allowedTools?: string[];
      binaryFormats?: false | BinaryFormatConfig[];
    };
    chat?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      customTools?: CustomToolsConfig | false;
      /** See {@link GthConfig.allowedTools}. */
      allowedTools?: string[];
      binaryFormats?: false | BinaryFormatConfig[];
    };
    code?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      customTools?: CustomToolsConfig | false;
      /** See {@link GthConfig.allowedTools}. */
      allowedTools?: string[];
      devTools?: GthDevToolsConfig;
      binaryFormats?: false | BinaryFormatConfig[];
    };
    /**
     * `gth exec` — prompt-as-script runtime. Like `code`, an exec run may need to actually
     * do the job (read/write files, run commands), so it carries the same tool/filesystem knobs.
     */
    exec?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      customTools?: CustomToolsConfig | false;
      /** See {@link GthConfig.allowedTools}. */
      allowedTools?: string[];
      devTools?: GthDevToolsConfig;
      binaryFormats?: false | BinaryFormatConfig[];
    };
    api?: {
      filesystem?: string[] | 'all' | 'read' | 'none';
      builtInTools?: string[];
      port?: number;
      cors?: {
        allowOrigin?: string;
        allowMethods?: string;
        allowHeaders?: string;
      };
    };
  };
  modelDisplayName?: string;
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
export interface PrCommandConfig {
  contentSource?: string;
  requirementSource?: string;
  /** @deprecated Use contentSource instead */
  contentProvider?: string;
  /** @deprecated Use requirementSource instead */
  requirementsProvider?: string;
  filesystem?: string[] | 'all' | 'read' | 'none';
  builtInTools?: string[];
  customTools?: CustomToolsConfig | false;
  /** See {@link GthConfig.allowedTools}. Empty array disables all tools for `gth pr`'s review agent. */
  allowedTools?: string[];
  logWorkForReviewInSeconds?: number;
  rating?: RatingConfig;
  binaryFormats?: false | BinaryFormatConfig[];
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
  | StatusLevel
  | keyof typeof StatusLevel
  | Lowercase<keyof typeof StatusLevel>;

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
  | 'absolute-paths'
  | 'directory-traversal'
  | 'shell-injection'
  | 'null-bytes';

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

/**
 * Config for {@link GthDevToolkit}.
 * Tools are not applied when config is not provided.
 * Only available in `code` mode.
 */
export interface GthDevToolsConfig {
  /**
   * Optional shell command to run tests.
   * Not applied when config is not provided.
   */
  run_tests?: string;
  /**
   * Optional shell command to run static analysis (lint).
   * Not applied when config is not provided.
   */
  run_lint?: string;
  /**
   * Optional shell command to run the build.
   * Not applied when config is not provided.
   */
  run_build?: string;
  /**
   * Optional shell command to run a single test file.
   * Supports command interpolation with the `${testPath}` placeholder.
   * Example: "npm test -- ${testPath}" or "jest ${testPath}"
   * Example: "npm test" - the test will simply be appended
   * Not applied when config is not provided.
   */
  run_single_test?: string;
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
}

/**
 * Default config
 */
export const DEFAULT_CONFIG = {
  contentSource: 'file',
  requirementSource: 'file',
  contentProvider: 'file',
  requirementsProvider: 'file',
  /**
   * Path to project-specific guidelines.
   * The default is `.gsloth.guidelines.md`; this config may be used to point Gaunt Sloth to a different file,
   * for example, to AGENTS.md
   */
  projectGuidelines: PROJECT_GUIDELINES,
  /**
   * Whether to include the current date in the project review instructions or not.
   */
  includeCurrentDateAfterGuidelines: false,
  projectReviewInstructions: PROJECT_REVIEW_INSTRUCTIONS,
  filesystem: 'none',
  debugLog: false,
  consoleLevel: StatusLevel.INFO, // Default to INFO level, not debug
  /**
   * Default provider for both requirements and content is GitHub.
   * It needs GitHub CLI (gh).
   *
   * `github` content provider uses `gh pr diff NN` internally. {@link src/providers/ghPrDiffProvider.ts!}
   *
   *
   * `github` requirements provider `gh issue view NN` internally
   */
  commands: {
    pr: {
      contentSource: 'github',
      requirementSource: 'github',
      contentProvider: 'github',
      requirementsProvider: 'github',
      rating: {
        enabled: true,
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
        errorOnReviewFail: true,
      },
    },
    review: {
      rating: {
        enabled: true,
        passThreshold: 6,
        minRating: 0,
        maxRating: 10,
        errorOnReviewFail: true,
      },
    },
    ask: {
      filesystem: 'read',
    },
    chat: {
      filesystem: 'read',
    },
    code: {
      filesystem: 'all',
    },
    exec: {
      filesystem: 'all',
    },
    api: {
      filesystem: 'read',
      port: 3000,
      cors: {
        allowOrigin: 'http://localhost:3000',
        allowMethods: 'POST, GET, OPTIONS',
        allowHeaders: 'Content-Type, Accept',
      },
    },
  },
  streamOutput: true,
  writeOutputToFile: true,
  writeBinaryOutputsToFile: true,
  useColour: true,
  streamSessionInferenceLog: true,
  canInterruptInferenceWithEsc: true,
  aiignore: {
    enabled: true,
    patterns: undefined,
  },
} as const;

/**
 * Needed DEFAULT_CONFIG to be plain const to be picked up by typedoc,
 * this cast here is just for typecheck.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
DEFAULT_CONFIG as GthConfig;

/**
 * Loads the global gsloth config (if present) from the global `~/.gsloth` folder.
 *
 * Precedence support: the returned raw config is intended to act as the BASE that the
 * project config (and CLI overrides) merge on top of, so any value here is the lowest
 * user-controlled layer (still above {@link DEFAULT_CONFIG}).
 *
 * Lookup order within the global folder, first match wins:
 *   `.gsloth.config.json` -> `.gsloth.config.js` -> `.gsloth.config.mjs`
 *
 * Absence of every variant is a no-op: returns `undefined` so behaviour is unchanged.
 *
 * NOTE: secrets (API keys) may live in this file; this function must never log its
 * contents. Only non-sensitive diagnostics (the resolved path / parse failure) are emitted.
 *
 * @returns The raw global config object, or `undefined` when no global config exists.
 */
export async function loadGlobalRawConfig(): Promise<Partial<RawGthConfig> | undefined> {
  // JSON first (the must-have format).
  const jsonPath = getGlobalGslothConfigReadPath(USER_PROJECT_CONFIG_JSON);
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf8')) as Partial<RawGthConfig>;
    } catch (e) {
      displayDebug(e instanceof Error ? e : String(e));
      displayWarning(`Failed to read global config from ${jsonPath}, ignoring it.`);
      return undefined;
    }
  }

  // Then JS / MJS variants (dynamic import of a `configure()` module).
  for (const filename of [USER_PROJECT_CONFIG_JS, USER_PROJECT_CONFIG_MJS]) {
    const modulePath = getGlobalGslothConfigReadPath(filename);
    if (existsSync(modulePath)) {
      try {
        const imported = await importExternalFile(modulePath);
        const configured = await imported.configure();
        return configured as Partial<RawGthConfig>;
      } catch (e) {
        displayDebug(e instanceof Error ? e : String(e));
        displayWarning(`Failed to read global config from ${modulePath}, ignoring it.`);
        return undefined;
      }
    }
  }

  return undefined;
}

/**
 * Deep-merges a loaded global raw config UNDER the given project raw config, so the
 * project config wins on conflicting keys. When no global config exists this is a no-op
 * and the original project config is returned unchanged.
 */
async function applyGlobalConfigBase<T extends Record<string, unknown>>(
  projectRawConfig: T
): Promise<T> {
  const globalRawConfig = await loadGlobalRawConfig();
  if (!globalRawConfig) {
    return projectRawConfig;
  }
  return deepMerge(globalRawConfig as Partial<T>, projectRawConfig) as T;
}

/**
 * Returns true when a project-level config file (json/js/mjs) exists for the given
 * overrides. Honours `customConfigPath` and the active identity profile so the check
 * matches exactly what {@link initConfig} would attempt to load.
 *
 * This is the project half of CFG-10's "is any config present?" detection; the global
 * half is {@link loadGlobalRawConfig} (used by {@link hasAnyConfig}).
 */
export function hasProjectConfig(commandLineConfigOverrides: CommandLineConfigOverrides): boolean {
  if (commandLineConfigOverrides.customConfigPath) {
    return existsSync(commandLineConfigOverrides.customConfigPath);
  }
  return [USER_PROJECT_CONFIG_JSON, USER_PROJECT_CONFIG_JS, USER_PROJECT_CONFIG_MJS].some(
    (filename) =>
      existsSync(getGslothConfigReadPath(filename, commandLineConfigOverrides.identityProfile))
  );
}

/**
 * CFG-10 — true when ANY usable configuration is present, either a project config file
 * (json/js/mjs) or a standalone global config (`~/.gsloth/.gsloth.config.*`). When this
 * returns false the caller should run the first-run dialog instead of erroring.
 *
 * Reuses CFG-8's project + global detection so the two paths can never disagree.
 */
export async function hasAnyConfig(
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<boolean> {
  if (hasProjectConfig(commandLineConfigOverrides)) {
    return true;
  }
  return (await loadGlobalRawConfig()) !== undefined;
}

/**
 * Initialize configuration by loading from available config files
 * @returns The loaded GthConfig
 */
export async function initConfig(
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  if (
    commandLineConfigOverrides.customConfigPath &&
    !existsSync(commandLineConfigOverrides.customConfigPath)
  ) {
    throw new Error(
      `Provided manual config "${commandLineConfigOverrides.customConfigPath}" does not exist`
    );
  }

  const jsonConfigPath =
    commandLineConfigOverrides.customConfigPath ??
    getGslothConfigReadPath(USER_PROJECT_CONFIG_JSON, commandLineConfigOverrides.identityProfile);

  // CFG-8 — when no project config file of any format exists, fall back to a standalone
  // global config (loaded alone) before erroring. Project config still takes precedence:
  // this branch only runs when there is no project file to apply the global config under.
  if (!hasProjectConfig(commandLineConfigOverrides)) {
    const globalRawConfig = await loadGlobalRawConfig();
    if (globalRawConfig) {
      if (
        globalRawConfig.llm &&
        typeof globalRawConfig.llm === 'object' &&
        'type' in globalRawConfig.llm
      ) {
        // Route the global config through the same path the project JSON uses.
        return await tryJsonConfig(globalRawConfig as RawGthConfig, commandLineConfigOverrides);
      }
      displayError(
        'Global configuration found but it is not in valid format. Should at least define llm.type'
      );
      exit(1);
      // Unreachable past exit(1) in production; keeps TS happy and prevents test exit.
      throw new Error('Unexpected error occurred.');
    }
  }

  // Try loading the JSON config file first
  if (jsonConfigPath.endsWith('.json') && existsSync(jsonConfigPath)) {
    try {
      // TODO makes sense to employ ZOD to validate config
      const projectJsonConfig = JSON.parse(readFileSync(jsonConfigPath, 'utf8')) as RawGthConfig;
      // Apply global config as the base layer (project config wins on conflicts).
      const jsonConfig = (await applyGlobalConfigBase(
        projectJsonConfig as unknown as Record<string, unknown>
      )) as unknown as RawGthConfig;
      // If the config has an LLM with a type, create the appropriate LLM instance
      if (jsonConfig.llm && typeof jsonConfig.llm === 'object' && 'type' in jsonConfig.llm) {
        return await tryJsonConfig(jsonConfig, commandLineConfigOverrides);
      } else {
        error(`${jsonConfigPath} is not in valid format. Should at least define llm.type`);
        exit(1);
        // noinspection ExceptionCaughtLocallyJS
        // This throw is unreachable due to exit(1) above, but satisfies TS type analysis and prevents tests from exiting
        // noinspection ExceptionCaughtLocallyJS
        throw new Error('Unexpected error occurred.');
      }
    } catch (e) {
      displayDebug(e instanceof Error ? e : String(e));
      displayError(
        `Failed to read config from ${USER_PROJECT_CONFIG_JSON}, will try other formats.`
      );
      // Continue to try other formats
      return await tryJsConfig(commandLineConfigOverrides);
    }
  } else {
    // JSON config not found, try JS
    return tryJsConfig(commandLineConfigOverrides);
  }
}

// Helper function to try loading JS config
async function tryJsConfig(
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  const jsConfigPath =
    commandLineConfigOverrides.customConfigPath ??
    getGslothConfigReadPath(USER_PROJECT_CONFIG_JS, commandLineConfigOverrides.identityProfile);
  if (jsConfigPath.endsWith('.js') && existsSync(jsConfigPath)) {
    try {
      const i = await importExternalFile(jsConfigPath);
      const customConfig = await i.configure();
      const mergedWithGlobal = await applyGlobalConfigBase(customConfig as Record<string, unknown>);
      return await mergeConfig(mergedWithGlobal, commandLineConfigOverrides);
    } catch (e) {
      displayDebug(e instanceof Error ? e : String(e));
      displayError(`Failed to read config from ${USER_PROJECT_CONFIG_JS}, will try other formats.`);
      // Continue to try other formats
      return await tryMjsConfig(commandLineConfigOverrides);
    }
  } else {
    // JS config not found, try MJS
    return await tryMjsConfig(commandLineConfigOverrides);
  }
}

// Helper function to try loading MJS config
async function tryMjsConfig(
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  const mjsConfigPath =
    commandLineConfigOverrides.customConfigPath ??
    getGslothConfigReadPath(USER_PROJECT_CONFIG_MJS, commandLineConfigOverrides.identityProfile);
  if (mjsConfigPath.endsWith('.mjs') && existsSync(mjsConfigPath)) {
    try {
      const i = await importExternalFile(mjsConfigPath);
      const customConfig = await i.configure();
      const mergedWithGlobal = await applyGlobalConfigBase(customConfig as Record<string, unknown>);
      return await mergeConfig(mergedWithGlobal, commandLineConfigOverrides);
    } catch (e) {
      displayDebug(e instanceof Error ? e : String(e));
      displayError(`Failed to read config from ${USER_PROJECT_CONFIG_MJS}.`);
      displayError(`No valid configuration found. Please create a valid configuration file.`);
      exit(1);
    }
  } else {
    // No config files found
    displayError(
      'No configuration file found. Please create one of: ' +
        `${USER_PROJECT_CONFIG_JSON}, ${USER_PROJECT_CONFIG_JS}, or ${USER_PROJECT_CONFIG_MJS} ` +
        'in your project directory.'
    );
    exit(1);
  }
  // This throw is unreachable due to exit(1) above, but satisfies TS type analysis and prevents tests from exiting
  throw new Error('Unexpected error occurred.');
}

/**
 * Process JSON LLM config by creating the appropriate LLM instance
 * @param jsonConfig - The parsed JSON config
 * @param commandLineConfigOverrides - command line config overrides
 * @returns Promise<GthConfig>
 */
export async function tryJsonConfig(
  jsonConfig: RawGthConfig,
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  try {
    if (jsonConfig.llm && typeof jsonConfig.llm === 'object') {
      // Get the type of LLM (e.g. 'vertexai', 'anthropic') - this should exist
      const llmType = (jsonConfig.llm as LLMConfig).type;
      if (!llmType) {
        displayError('LLM type not specified in config.');
        exit(1);
      }

      // Get the configuration for the specific LLM type
      const llmConfig = jsonConfig.llm;
      if (commandLineConfigOverrides.verbose) {
        // Necessary to avoid https://github.com/langchain-ai/langchainjs/issues/8705
        llmConfig.verbose = commandLineConfigOverrides.verbose;
      }
      // Import the appropriate config module
      const configModule = await import(`#src/providers/${llmType}.js`);
      if (configModule.processJsonConfig) {
        const llm = (await configModule.processJsonConfig(llmConfig)) as BaseChatModel;
        const mergedConfig = mergeRawConfig(jsonConfig, llm, commandLineConfigOverrides);
        if (configModule.postProcessJsonConfig) {
          return await configModule.postProcessJsonConfig(mergedConfig);
        } else {
          return await mergedConfig;
        }
      } else {
        displayWarning(`Config module for ${llmType} does not have processJsonConfig function.`);
        exit(1);
      }
    } else {
      displayError('No LLM configuration found in config.');
      exit(1);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('Cannot find module')) {
      displayError(`LLM type '${(jsonConfig.llm as LLMConfig).type}' not supported.`);
    } else {
      displayError(`Error processing LLM config: ${e instanceof Error ? e.message : String(e)}`);
    }
    exit(1);
  }
  // This throw is unreachable due to exit(1) above, but satisfies TS type analysis and prevents tests from exiting
  throw new Error('Unexpected error occurred.');
}

/**
 * Deep merge two objects, with source overriding target properties
 * @param target - The target object with default values
 * @param source - The source object with user overrides
 * @param maxDepth - Maximum recursion depth to prevent stack overflow (default: 4)
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T | undefined,
  source: Partial<T> | undefined,
  maxDepth = 4
): T {
  if (!source) return target as T;
  if (!target) return source as T;

  const result = { ...target };

  // Return result without merging if depth is exceeded
  if (maxDepth === 0) return result;

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge nested objects
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
        maxDepth - 1
      ) as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined) {
      // Override with source value if it exists
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

/**
 * Merge config with default config
 */
async function mergeConfig(
  partialConfig: Omit<Partial<GthConfig>, 'consoleLevel'> & { consoleLevel?: ConsoleLevelInput },
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  const config = partialConfig as GthConfig;

  // Migrate deprecated property names
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = config as any;
  if (raw.contentProvider && !raw.contentSource) {
    displayWarning('Config property "contentProvider" is deprecated. Use "contentSource" instead.');
    config.contentSource = raw.contentProvider;
  }
  if (raw.requirementsProvider && !raw.requirementSource) {
    displayWarning(
      'Config property "requirementsProvider" is deprecated. Use "requirementSource" instead.'
    );
    config.requirementSource = raw.requirementsProvider;
  }
  // Keep both old and new in sync
  if (config.contentSource) config.contentProvider = config.contentSource;
  if (config.requirementSource) config.requirementsProvider = config.requirementSource;

  // Migrate command-level deprecated properties
  if (config.commands) {
    for (const cmdName of ['pr', 'review'] as const) {
      const cmd = config.commands[cmdName];
      if (cmd) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cmdRaw = cmd as any;
        if (cmdRaw.contentProvider && !cmdRaw.contentSource) {
          cmd.contentSource = cmdRaw.contentProvider;
        }
        if (cmdRaw.requirementsProvider && !cmdRaw.requirementSource) {
          cmd.requirementSource = cmdRaw.requirementsProvider;
        }
        if (cmd.contentSource) cmd.contentProvider = cmd.contentSource;
        if (cmd.requirementSource) cmd.requirementsProvider = cmd.requirementSource;
      }
    }
  }

  // Deep merge command configs while preserving defaults
  // Type complexity from DEFAULT_CONFIG.commands 'as const' requires any cast for deep merge result
  const mergedCommands: GthConfig['commands'] = {
    pr: deepMerge(
      DEFAULT_CONFIG.commands.pr as Record<string, unknown>,
      config?.commands?.pr as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    review: deepMerge(
      DEFAULT_CONFIG.commands.review as Record<string, unknown>,
      config?.commands?.review as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    code: deepMerge(
      DEFAULT_CONFIG.commands.code as Record<string, unknown>,
      config?.commands?.code as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    exec: deepMerge(
      DEFAULT_CONFIG.commands.exec as Record<string, unknown>,
      config?.commands?.exec as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    ask: deepMerge(
      DEFAULT_CONFIG.commands.ask as Record<string, unknown>,
      config?.commands?.ask as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    chat: deepMerge(
      DEFAULT_CONFIG.commands.chat as Record<string, unknown>,
      config?.commands?.chat as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    api: deepMerge(
      DEFAULT_CONFIG.commands.api as Record<string, unknown>,
      config?.commands?.api as Record<string, unknown> | undefined
    ) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    commands: mergedCommands,
  };

  if (commandLineConfigOverrides.identityProfile !== undefined) {
    displayInfo(`Activating profile: ${commandLineConfigOverrides.identityProfile}`);
    mergedConfig.identityProfile = commandLineConfigOverrides.identityProfile.trim();
  }

  if (commandLineConfigOverrides.verbose !== undefined) {
    mergedConfig.llm.verbose = commandLineConfigOverrides.verbose;
  }

  if (commandLineConfigOverrides.writeOutputToFile !== undefined) {
    mergedConfig.writeOutputToFile = commandLineConfigOverrides.writeOutputToFile;
  }

  // Set the useColour value in systemUtils
  setUseColour(mergedConfig.useColour);

  // Set console logging level
  if (mergedConfig.consoleLevel !== undefined) {
    const resolvedConsoleLevel = resolveConsoleLevel(mergedConfig.consoleLevel);
    if (resolvedConsoleLevel !== undefined) {
      mergedConfig.consoleLevel = resolvedConsoleLevel;
      setConsoleLevel(resolvedConsoleLevel);
    } else {
      displayWarning(
        `Invalid consoleLevel "${String(mergedConfig.consoleLevel)}", using default ${StatusLevel.INFO}.`
      );
      mergedConfig.consoleLevel = StatusLevel.INFO;
      setConsoleLevel(StatusLevel.INFO);
    }
  }

  mergedConfig.canInterruptInferenceWithEsc = mergedConfig.canInterruptInferenceWithEsc && isTTY();

  return mergedConfig;
}

const CONSOLE_LEVELS_BY_NAME: Record<string, StatusLevel> = {
  debug: StatusLevel.DEBUG,
  info: StatusLevel.INFO,
  display: StatusLevel.DISPLAY,
  success: StatusLevel.SUCCESS,
  warning: StatusLevel.WARNING,
  error: StatusLevel.ERROR,
  stream: StatusLevel.STREAM,
};

function resolveConsoleLevel(level: ConsoleLevelInput | StatusLevel): StatusLevel | undefined {
  if (typeof level === 'number') {
    return StatusLevel[level] !== undefined ? level : undefined;
  }

  if (typeof level === 'string') {
    const normalized = level.trim().toLowerCase();
    if (normalized in CONSOLE_LEVELS_BY_NAME) {
      return CONSOLE_LEVELS_BY_NAME[normalized];
    }
    const enumValue = StatusLevel[level as keyof typeof StatusLevel];
    if (typeof enumValue === 'number') {
      return enumValue;
    }
  }

  return undefined;
}

/**
 * Merge raw with default config
 */
async function mergeRawConfig(
  config: RawGthConfig,
  llm: BaseChatModel,
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  const modelDisplayName: string | undefined = config.llm?.model;
  return await mergeConfig({ ...config, llm, modelDisplayName }, commandLineConfigOverrides);
}
