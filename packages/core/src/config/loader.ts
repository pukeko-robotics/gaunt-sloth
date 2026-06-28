/**
 * @packageDocumentation
 * Configuration discovery + the layered load/merge pipeline (global + project layers,
 * format fall-through JSON → JS → MJS, schema validation, deep-merge with defaults).
 * Extracted from the former `config.ts` god-file; behaviour is unchanged.
 */
import {
  GSLOTH_DIR,
  GSLOTH_SETTINGS_DIR,
  USER_PROJECT_CONFIG_JS,
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_MJS,
  USER_PROJECT_CONFIG_TS,
} from '#src/constants.js';
import { StatusLevel } from '#src/core/types.js';
import {
  displayDebug,
  displayError,
  displayInfo,
  displayWarning,
  setConsoleLevel,
} from '#src/utils/consoleUtils.js';
import {
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  preMapDeprecatedConfigNames,
  rawGthConfigSchema,
} from '#src/config/schema.js';
import { getGslothConfigReadPath, importExternalFile } from '#src/utils/fileUtils.js';
import { getGlobalGslothConfigReadPath } from '#src/utils/globalConfigUtils.js';
import {
  error,
  exit,
  getCurrentWorkDir,
  isTTY,
  setProjectDir,
  setUseColour,
} from '#src/utils/systemUtils.js';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CONFIG } from '#src/config/defaults.js';
import type {
  CommandLineConfigOverrides,
  ConsoleLevelInput,
  GthConfig,
  LLMConfig,
  RawGthConfig,
} from '#src/config/types.js';

/**
 * Validate (and normalize) a freshly loaded raw config layer (global or project)
 * against {@link rawGthConfigSchema}, the single source of truth for the on-disk
 * config shape.
 *
 * Steps, in order:
 * 1. B3 pre-map: map deprecated key names one-way to their canonical names (root +
 *    per-command) via {@link preMapDeprecatedConfigNames}, emitting a deprecation
 *    `displayWarning` for each occurrence. This runs FIRST so renamed keys are not
 *    later mistaken for unknown keys.
 * 2. Unknown top-level keys: warn (do NOT fail) so likely typos are surfaced while
 *    forward-compatible / extension keys still pass through untouched.
 * 3. Schema parse: on a genuine type mismatch on a known field, emit a friendly,
 *    path-scoped error and exit (matching the loader's existing invalid-config
 *    behaviour). Validation is shape-only — the loose schema preserves unknown keys,
 *    so the original `raw` (pre-mapped) is returned unchanged on success.
 *
 * @param raw The freshly loaded config layer (mutated in place by the pre-map).
 * @param sourceLabel Human-readable source name for messages (e.g. the filename).
 */
function validateRawConfigLayer<T extends Record<string, unknown>>(raw: T, sourceLabel: string): T {
  const { config, warnings } = preMapDeprecatedConfigNames(raw);
  for (const warning of warnings) {
    displayWarning(warning);
  }

  const unknownKeys = findUnknownTopLevelKeys(config);
  if (unknownKeys.length > 0) {
    displayWarning(
      `Unknown top-level config ${unknownKeys.length === 1 ? 'key' : 'keys'} in ${sourceLabel}: ` +
        `${unknownKeys.join(', ')}. ${unknownKeys.length === 1 ? 'It is' : 'They are'} kept as-is ` +
        'but ignored by Gaunt Sloth; check for typos.'
    );
  }

  const result = rawGthConfigSchema.safeParse(config);
  if (!result.success) {
    displayError(
      `Invalid configuration in ${sourceLabel}:\n${formatConfigValidationError(result.error)}`
    );
    exit(1);
  }

  return config;
}

/**
 * Project config file lookup order, highest precedence first. JSON wins, then the
 * `configure()`-style module formats (JS → MJS → TS). Used to pick THE config within a dir.
 */
const PROJECT_CONFIG_FORMATS: readonly string[] = [
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_JS,
  USER_PROJECT_CONFIG_MJS,
  USER_PROJECT_CONFIG_TS,
];

/**
 * Dir-aware version of {@link getGslothConfigReadPath} for ancestor dirs during the up-tree
 * walk. Mirrors its `.gsloth/.gsloth-settings[/<profile>]/<filename>` resolution but against an
 * explicit `dir` instead of the cwd, falling back to `<dir>/<filename>`. Implemented with
 * `node:path`/`node:fs` directly (no `fileUtils` round-trip) so the cwd level can keep
 * delegating to the original cwd-bound resolver.
 */
function resolveProjectConfigPathInDir(
  dir: string,
  filename: string,
  identityProfileRaw: string | undefined
): string {
  const identityProfile = identityProfileRaw?.trim();
  const gslothDirPath = resolve(dir, GSLOTH_DIR);
  if (existsSync(gslothDirPath)) {
    const gslothSettingsPath = resolve(gslothDirPath, GSLOTH_SETTINGS_DIR);
    const configPath = identityProfile
      ? resolve(gslothSettingsPath, identityProfile, filename)
      : resolve(gslothSettingsPath, filename);
    if (existsSync(configPath)) {
      return configPath;
    }
  }
  return resolve(dir, filename);
}

/**
 * Resolve where a config `filename` would live for the given base dir, composing with
 * `identityProfile`. The cwd level delegates to the existing cwd-bound
 * {@link getGslothConfigReadPath} (preserving its behaviour and test seams); ancestor dirs use
 * {@link resolveProjectConfigPathInDir}.
 */
function resolveConfigPath(
  baseDir: string,
  filename: string,
  identityProfile: string | undefined
): string {
  return baseDir === getCurrentWorkDir()
    ? getGslothConfigReadPath(filename, identityProfile)
    : resolveProjectConfigPathInDir(baseDir, filename, identityProfile);
}

/**
 * Find THE project config by walking up from cwd toward a stop boundary, returning the FIRST
 * match (first-match-win: nearest dir, then format precedence within that dir — NOT a merged
 * stack). Detection ({@link hasProjectConfig}/{@link hasAnyConfig}) and loading ({@link initConfig})
 * both go through this, so they can never disagree.
 *
 * Stop boundary — the dir is SEARCHED, then ascent stops at: a dir containing `.git` (the git
 * root), the user's home dir, or the filesystem root — whichever comes first. So a config IN the
 * git root (or home) is found; a config ABOVE it is not.
 *
 * A `customConfigPath` override wins outright (no walking).
 *
 * @returns the matched `{ dir, path }`, or `undefined` when no project config exists within the
 * boundary.
 */
export function findProjectConfigPath(
  commandLineConfigOverrides: CommandLineConfigOverrides
): { dir: string; path: string } | undefined {
  if (commandLineConfigOverrides.customConfigPath) {
    return existsSync(commandLineConfigOverrides.customConfigPath)
      ? {
          dir: dirname(commandLineConfigOverrides.customConfigPath),
          path: commandLineConfigOverrides.customConfigPath,
        }
      : undefined;
  }

  const home = homedir();
  let dir = getCurrentWorkDir();
  // Walk up: search each dir, then stop at the boundary (git root / home / fs root).
  for (;;) {
    for (const filename of PROJECT_CONFIG_FORMATS) {
      const candidate = resolveConfigPath(
        dir,
        filename,
        commandLineConfigOverrides.identityProfile
      );
      if (existsSync(candidate)) {
        return { dir, path: candidate };
      }
    }
    const parent = dirname(dir);
    if (existsSync(resolve(dir, '.git')) || dir === home || parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

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
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
      return validateRawConfigLayer(
        parsed,
        `${USER_PROJECT_CONFIG_JSON} (global)`
      ) as Partial<RawGthConfig>;
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
        return validateRawConfigLayer(
          configured as Record<string, unknown>,
          `${filename} (global)`
        ) as Partial<RawGthConfig>;
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
 * ORDERING INVARIANT (GS2-11): detection ({@link hasProjectConfig}/{@link hasAnyConfig}) MUST run
 * before {@link initConfig} in a given process. Both resolve cwd-level candidates via
 * `getGslothConfigReadPath`, which reads `getProjectDir()`; {@link initConfig} clears `projectDir`
 * at the start of its run, so detection stays cwd-correct as long as it precedes initConfig (it
 * does: startSession calls hasAnyConfig before any initConfig, and the ACP/agent path calls
 * initConfig directly without detection). Calling detection AFTER an initConfig with a changed cwd
 * in a long-lived process would read a stale projectDir (currently unreachable). If that call
 * order is ever introduced, decouple discovery's cwd-branch from `getProjectDir()`.
 */

/**
 * Returns true when a project-level config file (json/js/mjs) exists for the given
 * overrides. Honours `customConfigPath` and the active identity profile so the check
 * matches exactly what {@link initConfig} would attempt to load.
 *
 * This is the project half of CFG-10's "is any config present?" detection; the global
 * half is {@link loadGlobalRawConfig} (used by {@link hasAnyConfig}).
 */
export function hasProjectConfig(commandLineConfigOverrides: CommandLineConfigOverrides): boolean {
  return findProjectConfigPath(commandLineConfigOverrides) !== undefined;
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

  // Clear the project root BEFORE discovery. Discovery and detection must resolve against cwd,
  // and the up-tree walk itself goes through getGslothConfigReadPath -> getProjectDir(); clearing
  // first guarantees getProjectDir() falls back to cwd during the walk, even on a SECOND initConfig
  // call in a long-lived process (ACP server) or across tests where a stale projectDir would
  // otherwise poison the walk and miss the real config.
  setProjectDir(undefined);

  // Discover the project config location: a customConfigPath wins outright, otherwise walk up
  // from cwd to the stop boundary (see findProjectConfigPath). Detection and loading share this
  // resolver, and the discovered dir becomes the base for the per-format cascade below.
  const discovered = findProjectConfigPath(commandLineConfigOverrides);
  const baseDir = discovered?.dir ?? getCurrentWorkDir();

  // Set the project root for post-config, project-relative artifact resolution (guidelines,
  // prompts, .gsloth-settings, outputs). up-tree and --config both set it here; a global-only /
  // no-config run leaves it undefined so those artifacts stay cwd-bound (see getProjectDir).
  // Safe for the in-function load below: when discovered.dir === cwd getProjectDir() is unchanged,
  // and when it is an ancestor resolveConfigPath takes its explicit-dir branch (never getProjectDir).
  setProjectDir(discovered?.dir);

  const jsonConfigPath =
    commandLineConfigOverrides.customConfigPath ??
    resolveConfigPath(
      baseDir,
      USER_PROJECT_CONFIG_JSON,
      commandLineConfigOverrides.identityProfile
    );

  // CFG-8 — when no project config file of any format exists (anywhere up-tree), fall back to a
  // standalone global config (loaded alone) before erroring. Project config still takes
  // precedence: this branch only runs when there is no project file to apply the global under.
  if (!discovered) {
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
      // Validate the project config layer against the Zod schema (single source of
      // truth): pre-map deprecated names, warn on unknown top-level keys, and fail
      // with a friendly, path-scoped message on a genuine type mismatch.
      const projectJsonConfig = validateRawConfigLayer(
        JSON.parse(readFileSync(jsonConfigPath, 'utf8')) as Record<string, unknown>,
        USER_PROJECT_CONFIG_JSON
      ) as unknown as RawGthConfig;
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
      return await tryModuleConfig('js', commandLineConfigOverrides, baseDir);
    }
  } else {
    // JSON config not found, try JS
    return tryModuleConfig('js', commandLineConfigOverrides, baseDir);
  }
}

/**
 * A module-config format (`configure()`-exporting JS/MJS/TS). Unlike JSON — which carries an
 * LLM *spec* that {@link tryJsonConfig} must instantiate — a module config returns an already
 * fully-constructed config (LLM included), so it goes straight to {@link mergeConfig}.
 */
type ModuleConfigFormat = 'js' | 'mjs' | 'ts';

/**
 * Module-format fall-through order (lowest precedence among project formats; JSON is tried
 * first by {@link initConfig}). `.ts` (B2b) is last, loaded via jiti by `importExternalFile`.
 */
const MODULE_CONFIG_FORMATS: readonly ModuleConfigFormat[] = ['js', 'mjs', 'ts'];

const MODULE_CONFIG_FILENAME: Record<ModuleConfigFormat, string> = {
  js: USER_PROJECT_CONFIG_JS,
  mjs: USER_PROJECT_CONFIG_MJS,
  ts: USER_PROJECT_CONFIG_TS,
};

const MODULE_CONFIG_EXT: Record<ModuleConfigFormat, string> = {
  js: '.js',
  mjs: '.mjs',
  ts: '.ts',
};

/**
 * Try loading a `configure()`-style module config (JS → MJS → TS), preserving the format
 * fall-through: a missing/failed format falls through to the next in {@link MODULE_CONFIG_FORMATS};
 * exhausting the chain is the terminal "no usable config" error. Collapses the formerly-duplicated
 * `tryJsConfig`/`tryMjsConfig` helpers into one format-parameterized loader.
 *
 * NOTE: the terminal "No configuration file found" message intentionally advertises only
 * json/js/mjs (the historical, asserted wording) — `.ts` is a quiet lowest-precedence fallback.
 */
async function tryModuleConfig(
  format: ModuleConfigFormat,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  baseDir: string
): Promise<GthConfig> {
  const filename = MODULE_CONFIG_FILENAME[format];
  const ext = MODULE_CONFIG_EXT[format];
  const nextFormat = MODULE_CONFIG_FORMATS[MODULE_CONFIG_FORMATS.indexOf(format) + 1];
  const configPath =
    commandLineConfigOverrides.customConfigPath ??
    resolveConfigPath(baseDir, filename, commandLineConfigOverrides.identityProfile);
  if (configPath.endsWith(ext) && existsSync(configPath)) {
    try {
      const i = await importExternalFile(configPath);
      const customConfig = validateRawConfigLayer(
        (await i.configure()) as Record<string, unknown>,
        filename
      );
      const mergedWithGlobal = await applyGlobalConfigBase(customConfig);
      return await mergeConfig(mergedWithGlobal, commandLineConfigOverrides);
    } catch (e) {
      displayDebug(e instanceof Error ? e : String(e));
      if (nextFormat) {
        displayError(`Failed to read config from ${filename}, will try other formats.`);
        // Continue to try other formats
        return await tryModuleConfig(nextFormat, commandLineConfigOverrides, baseDir);
      }
      displayError(`Failed to read config from ${filename}.`);
      displayError(`No valid configuration found. Please create a valid configuration file.`);
      exit(1);
    }
  } else if (nextFormat) {
    // This format not found, try the next one
    return await tryModuleConfig(nextFormat, commandLineConfigOverrides, baseDir);
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
 * Config array fields whose values ADD UP across merge layers (global → project): the
 * merged result is both layers concatenated (target/lower-precedence first) and de-duplicated
 * by value, instead of the higher-precedence layer replacing the lower. Keyed by dotted path
 * from the config root.
 *
 * CONSERVATIVE BY DESIGN — only genuinely-cumulative lists are additive. Everything else keeps
 * REPLACE semantics, because those express "this is THE set" and silently unioning them across
 * global + project would surprise users.
 *
 * | array field          | policy   | rationale                                            |
 * | -------------------- | -------- | ---------------------------------------------------- |
 * | `allowDirs`          | ADDITIVE | extra sandbox roots accumulate across layers         |
 * | `aiignore.patterns`  | ADDITIVE | ignore patterns accumulate across layers             |
 * | `allowedTools`       | replace  | the explicit allow-list IS the set                   |
 * | `builtInTools`       | replace  | the explicit tool selection IS the set               |
 * | `tools`              | replace  | live tool instances; union would be surprising       |
 * | `middleware`         | replace  | ordered pipeline; union would reorder/duplicate      |
 * | `binaryFormats`      | replace  | the declared format policy IS the set                |
 * | (every other array)  | replace  | default; preserves historical behaviour              |
 *
 * NOTE: the additive fields only live at the config ROOT, so only the
 * `applyGlobalConfigBase(global, project)` merge can trigger them; the per-command
 * `deepMerge` calls start at command scope and never reach these paths.
 *
 * NAMESPACE CAVEAT: these keys are config-ROOT-relative, but the per-command
 * `deepMerge(DEFAULT_CONFIG.commands.X, …)` calls also start at `path === ''`. No command
 * default carries `allowDirs`/`aiignore`, so there is no collision today — but do NOT add a
 * key here that could also appear as a per-command field, or it would silently become additive
 * inside command merges too.
 */
const ADDITIVE_ARRAY_FIELDS: ReadonlySet<string> = new Set(['allowDirs', 'aiignore.patterns']);

/**
 * Deep merge two objects, with source overriding target properties.
 * Objects are merged recursively. Arrays REPLACE by default; arrays at an
 * {@link ADDITIVE_ARRAY_FIELDS} path are concatenated (target-first) then de-duplicated by
 * value. Every other non-plain-object value is replaced by the source value.
 * @param target - The target object with default values (lower-precedence layer)
 * @param source - The source object with user overrides (higher-precedence layer)
 * @param path - Dotted path from the config root, used to look up the array merge policy.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T | undefined,
  source: Partial<T> | undefined,
  path = ''
): T {
  if (!source) return target as T;
  if (!target) return source as T;

  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];
    const fieldPath = path ? `${path}.${key}` : key;

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
        fieldPath
      ) as T[Extract<keyof T, string>];
    } else if (
      Array.isArray(sourceValue) &&
      Array.isArray(targetValue) &&
      ADDITIVE_ARRAY_FIELDS.has(fieldPath)
    ) {
      // Additive list: concat both layers (target/lower-precedence first), de-dupe by value.
      result[key] = [...new Set([...targetValue, ...sourceValue])] as T[Extract<keyof T, string>];
    } else if (sourceValue !== undefined) {
      // Override with source value if it exists (arrays REPLACE by default)
      result[key] = sourceValue as T[Extract<keyof T, string>];
    }
  }

  return result;
}

/**
 * Resolve a fully-merged {@link GthConfig} from a partial config + CLI overrides WITHOUT
 * any global side effects (a pure transform). It deep-merges defaults, applies CLI overrides,
 * resolves the numeric `consoleLevel` (warning + defaulting to INFO on an invalid value), and
 * computes `canInterruptInferenceWithEsc`. The process-global setters (`setUseColour` /
 * `setConsoleLevel`) are applied separately by {@link mergeConfig}, so this function can be
 * reasoned about and reused without touching global state.
 */
export function resolveConfig(
  partialConfig: Omit<Partial<GthConfig>, 'consoleLevel'> & { consoleLevel?: ConsoleLevelInput },
  commandLineConfigOverrides: CommandLineConfigOverrides
): GthConfig {
  const config = partialConfig as GthConfig;

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

  // Resolve console logging level (value only; the global setter is applied in mergeConfig).
  if (mergedConfig.consoleLevel !== undefined) {
    const resolvedConsoleLevel = resolveConsoleLevel(mergedConfig.consoleLevel);
    if (resolvedConsoleLevel !== undefined) {
      mergedConfig.consoleLevel = resolvedConsoleLevel;
    } else {
      displayWarning(
        `Invalid consoleLevel "${String(mergedConfig.consoleLevel)}", using default ${StatusLevel.INFO}.`
      );
      mergedConfig.consoleLevel = StatusLevel.INFO;
    }
  }

  mergedConfig.canInterruptInferenceWithEsc = mergedConfig.canInterruptInferenceWithEsc && isTTY();

  return mergedConfig;
}

/**
 * Merge config with default config, then apply the resolved colour + console-level settings
 * to the process globals. Thin wrapper over the pure {@link resolveConfig}; kept `async` with
 * the same signature so every existing caller (`mergeRawConfig`, `tryJsConfig`, `tryMjsConfig`)
 * behaves identically — the two `set*` calls are the only global mutations in the merge path.
 */
async function mergeConfig(
  partialConfig: Omit<Partial<GthConfig>, 'consoleLevel'> & { consoleLevel?: ConsoleLevelInput },
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<GthConfig> {
  const mergedConfig = resolveConfig(partialConfig, commandLineConfigOverrides);

  // Set the useColour value in systemUtils.
  setUseColour(mergedConfig.useColour);

  // Set console logging level.
  if (mergedConfig.consoleLevel !== undefined) {
    setConsoleLevel(mergedConfig.consoleLevel);
  }

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
