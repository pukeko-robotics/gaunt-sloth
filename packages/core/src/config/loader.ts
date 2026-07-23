/**
 * @packageDocumentation
 * Configuration discovery + the layered load/merge pipeline (global + project layers,
 * format fall-through JSON → JSONC → JS → MJS, schema validation, deep-merge with defaults).
 * Extracted from the former `config.ts` god-file; behaviour is unchanged.
 */
import {
  GSLOTH_DIR,
  GSLOTH_SETTINGS_DIR,
  USER_PROJECT_CONFIG_JS,
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_JSONC,
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
  findDeprecatedConfigIssues,
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  formatDeprecatedConfigIssues,
  isRecordConfig,
  rawGthConfigSchema,
  validateRawGthConfig,
  type RawConfigValidationResult,
} from '#src/config/schema.js';
import { parseJsonc } from '#src/config/jsonc.js';
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
 * 1. Deprecated-shape reject (GS2-28): a removed pre-2.0 shape — a top-level command key
 *    or a deprecated `*Provider*` name (root + per-command), detected by
 *    {@link findDeprecatedConfigIssues} — is a HARD error naming the canonical replacement +
 *    migration path, then exit. 2.0 dropped back-compat coercion, so these fail rather than
 *    remap. Runs FIRST so a deprecated name never merely surfaces as an unknown-key warning.
 * 2. Unknown top-level keys: warn (do NOT fail) so likely typos are surfaced while
 *    forward-compatible / extension keys still pass through untouched.
 * 3. Schema parse: on a genuine type mismatch on a known field, emit a friendly,
 *    path-scoped error and exit (matching the loader's existing invalid-config
 *    behaviour). Validation is shape-only — the loose schema preserves unknown keys,
 *    so the original `raw` is returned unchanged on success.
 *
 * @param raw The freshly loaded config layer (read-only here).
 * @param sourceLabel Human-readable source name for messages (e.g. the filename).
 */
function validateRawConfigLayer<T extends Record<string, unknown>>(raw: T, sourceLabel: string): T {
  // Only an object config can carry deprecated/unknown keys; a null/array/primitive config skips
  // the scans (they'd throw a raw TypeError) and falls to safeParse, which emits a clean
  // "expected object" error + exit — never a coercion to {} (which would wrongly pass).
  if (isRecordConfig(raw)) {
    const deprecatedIssues = findDeprecatedConfigIssues(raw);
    if (deprecatedIssues.length > 0) {
      displayError(
        `Invalid configuration in ${sourceLabel}:\n${formatDeprecatedConfigIssues(deprecatedIssues)}`
      );
      exit(1);
      // Unreachable past exit(1) in production; keeps the mocked-exit test path from falling
      // through into the schema parse below.
      return raw;
    }

    const unknownKeys = findUnknownTopLevelKeys(raw);
    if (unknownKeys.length > 0) {
      displayWarning(
        `Unknown top-level config ${unknownKeys.length === 1 ? 'key' : 'keys'} in ${sourceLabel}: ` +
          `${unknownKeys.join(', ')}. ${unknownKeys.length === 1 ? 'It is' : 'They are'} kept as-is ` +
          'but ignored by Gaunt Sloth; check for typos.'
      );
    }
  }

  const result = rawGthConfigSchema.safeParse(raw);
  if (!result.success) {
    displayError(
      `Invalid configuration in ${sourceLabel}:\n${formatConfigValidationError(result.error)}`
    );
    exit(1);
  }

  return raw;
}

/**
 * Project config file lookup order, highest precedence first. JSON wins, then its `.jsonc`
 * spelling (GS2-69 — same {@link parseJsonc} parse either way), then the `configure()`-style
 * module formats (JS → MJS → TS). Used to pick THE config within a dir.
 */
const PROJECT_CONFIG_FORMATS: readonly string[] = [
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_JSONC,
  USER_PROJECT_CONFIG_JS,
  USER_PROJECT_CONFIG_MJS,
  USER_PROJECT_CONFIG_TS,
];

/**
 * GS2-69 — the lookup order for the two JSON-family filenames wherever they are probed as a
 * pair (the global `~/.gsloth` lookup and its read-side mirror). `.json` first, so it wins
 * when both exist — matching {@link PROJECT_CONFIG_FORMATS}.
 */
const JSON_CONFIG_FILENAMES: readonly string[] = [
  USER_PROJECT_CONFIG_JSON,
  USER_PROJECT_CONFIG_JSONC,
];

/**
 * True when `path` belongs to the JSONC-parsing branch (a `.json` OR `.jsonc` file, GS2-69) as
 * opposed to the `configure()`-module importer. Single-sources the run-path gate so an explicit
 * `-c foo.jsonc` can never fall through to the module importer again.
 */
function isJsonConfigPath(path: string): boolean {
  return path.endsWith('.json') || path.endsWith('.jsonc');
}

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
 * Yield each directory to search during config discovery, from cwd up to (and INCLUDING) the stop
 * boundary — a dir containing `.git` (the git root), the user's home dir, or the filesystem root,
 * whichever comes first (the dir at the boundary is itself searched, then ascent stops). Single-
 * sources the up-tree boundary so {@link findProjectConfigPath} and
 * {@link resolveIdentityProfileConfigPath} can never drift on where the walk starts or stops.
 */
function* walkConfigSearchDirs(): Generator<string> {
  const home = homedir();
  let dir = getCurrentWorkDir();
  for (;;) {
    yield dir;
    const parent = dirname(dir);
    if (existsSync(resolve(dir, '.git')) || dir === home || parent === dir) {
      break;
    }
    dir = parent;
  }
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
 * NOTE (identity profile): with an `identityProfile` set, each dir's per-format resolver
 * ({@link resolveConfigPath}) tries the profile path `.gsloth/.gsloth-settings/<profile>/<file>`
 * but FALLS BACK to the plain `<dir>/<file>` when the profile file is absent. So a match here does
 * NOT prove the named profile itself has a config — it may be a plain (non-profile) config. Use
 * {@link resolveIdentityProfileConfigPath} when you need to know a profile specifically resolved.
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

  // Walk up: search each dir, then stop at the boundary (git root / home / fs root).
  for (const dir of walkConfigSearchDirs()) {
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
  }
  return undefined;
}

/**
 * STRICT existence check for an EXPLICITLY-named identity profile: does
 * `.gsloth/.gsloth-settings/<identityProfile>/<config>` resolve to a real config file anywhere in
 * the same up-tree search {@link findProjectConfigPath} walks? Returns the resolved profile config
 * path (nearest dir, then format precedence) when the profile has its OWN config, `undefined`
 * otherwise.
 *
 * Unlike {@link findProjectConfigPath}, it matches ONLY the profile-specific path — it NEVER falls
 * through to a plain `<dir>/<config>` and NEVER falls back to the global config. That strictness is
 * the whole point: it lets a caller distinguish "this named profile really exists" from "a bare
 * config happens to be present / a global config exists," a distinction the loader's fall-through
 * deliberately blurs.
 *
 * PURE PREDICATE — never throws, never calls `exit` (contrast the loader's interactive-CLI
 * `exit(1)` safety net in {@link initConfig}). So batch/eval code (e.g. `gth eval --judge <profile>`
 * and BATCH-12's identity matrix) can pre-check an explicitly-requested profile and raise its OWN
 * catchable error / graceful exit code instead of dying on an uncatchable `process.exit`. A
 * blank/whitespace-only name counts as "no profile" → `undefined`.
 *
 * @param identityProfile The explicitly-requested identity profile name.
 * @returns The resolved profile config path, or `undefined` when the profile has no config.
 */
export function resolveIdentityProfileConfigPath(identityProfile: string): string | undefined {
  const profile = identityProfile?.trim();
  if (!profile) {
    return undefined;
  }
  for (const dir of walkConfigSearchDirs()) {
    const profileDir = resolve(dir, GSLOTH_DIR, GSLOTH_SETTINGS_DIR, profile);
    for (const filename of PROJECT_CONFIG_FORMATS) {
      const candidate = resolve(profileDir, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
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
 *   `.gsloth.config.json` -> `.gsloth.config.jsonc` -> `.gsloth.config.js` -> `.gsloth.config.mjs`
 *
 * Absence of every variant is a no-op: returns `undefined` so behaviour is unchanged.
 *
 * NOTE: secrets (API keys) may live in this file; this function must never log its
 * contents. Only non-sensitive diagnostics (the resolved path / parse failure) are emitted.
 *
 * @returns The raw global config object, or `undefined` when no global config exists.
 */
export async function loadGlobalRawConfig(): Promise<Partial<RawGthConfig> | undefined> {
  // JSON/JSONC first (the must-have formats; `.json` wins when both exist — GS2-69).
  for (const filename of JSON_CONFIG_FILENAMES) {
    const jsonPath = getGlobalGslothConfigReadPath(filename);
    if (existsSync(jsonPath)) {
      try {
        const parsed = parseJsonc(readFileSync(jsonPath, 'utf8'), `${filename} (global)`) as Record<
          string,
          unknown
        >;
        return validateRawConfigLayer(parsed, `${filename} (global)`) as Partial<RawGthConfig>;
      } catch (e) {
        displayDebug(e instanceof Error ? e : String(e));
        displayWarning(`Failed to read global config from ${jsonPath}, ignoring it.`);
        return undefined;
      }
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
 * GS2-41 — hard cap on the `extends` chain length: a belt-and-suspenders backstop BEHIND the
 * name-cycle guard. Even if a base name somehow failed to register in the visited chain, a chain
 * this long is a misconfiguration and must fail fast rather than recurse without bound.
 */
const MAX_EXTENDS_CHAIN_DEPTH = 50;

/**
 * GS2-73 — the typed failure the `extends` traversal ({@link resolveExtendsChain}) raises on a
 * cycle, a missing base, an over-deep chain, or an unreadable base. It carries the SAME clear,
 * user-facing message the run path prints, so the two consumers can translate one shared failure
 * into their own convention WITHOUT the traversal being forked or the checks duplicated:
 *   - the run path ({@link resolveConfigExtends}) → `displayError` + `exit(1)` (hard-fail a run),
 *   - the read path ({@link validateConfig}) → a `not-ok` layer with this message (collect, never
 *     `exit`), so `gth config validate` mirrors what a real run would hit (GS2-29 invariant).
 */
class ConfigExtendsError extends Error {}

/**
 * GS2-41 — resolve a named profile's `extends` inheritance into a single composed raw config,
 * riding the SAME GS2-1 deep-merge the config LAYERS use (NO second merge engine). When the given
 * profile config declares `extends: "<base>"`, the base profile's config resolves FIRST
 * (recursively — a base may itself extend another, so base-of-base resolves first), then this
 * profile's own fields merge on top with last-wins semantics: the child overrides the base, nested
 * objects merge, arrays REPLACE except the additive-array fields (`allowDirs`, `aiignore.patterns`,
 * see {@link ADDITIVE_ARRAY_FIELDS}) which accumulate base+child. The `extends` key itself is
 * consumed and never leaks into the composed output.
 *
 * A config WITHOUT `extends` is returned UNCHANGED — every non-inheriting config (the vast
 * majority) is untouched and behaves exactly as before.
 *
 * Composition is CONFINED to the profile-dir layer: it produces the single raw config that then
 * acts as the project-file layer the global config underlays and CLI flags overlay, preserving
 * GS2-33's outer precedence `CLI flags > profile (base+child composed) > global > defaults`. It is
 * therefore invoked in {@link initConfig} on the loaded project/profile config BEFORE
 * {@link applyGlobalConfigBase}.
 *
 * The base profile is discovered with {@link resolveIdentityProfileConfigPath} (the SAME strict
 * up-tree profile walk `--profile` uses), so `extends` names a profile exactly as a user selects
 * one; a name with no config dir is a hard, clearly-named error.
 *
 * CYCLE GUARD: the chain of profile NAMES is tracked (seeded with the selected profile's own name);
 * because `extends` is single-valued the chain is linear, so a repeated name — `A extends B extends
 * A`, or a self-extend — is an unambiguous cycle and fails fast with a clear error NAMING the cycle,
 * never infinite-looping / stack-overflowing. A hard {@link MAX_EXTENDS_CHAIN_DEPTH} cap backstops
 * it regardless of how the base path was derived.
 *
 * @param rawConfig   the just-loaded, schema-validated raw config that MAY declare `extends`.
 * @param profileLabel the selected profile's own name (for cycle detection + messages); undefined
 *                     for a plain (non-profile) project config.
 */
export async function resolveConfigExtends(
  rawConfig: Record<string, unknown>,
  profileLabel: string | undefined
): Promise<Record<string, unknown>> {
  try {
    return await composeExtends(rawConfig, profileLabel);
  } catch (e) {
    // GS2-73 — the traversal now RAISES a {@link ConfigExtendsError} rather than exiting inline, so
    // the read side ({@link validateConfig}) can report the same failure without terminating. On the
    // RUN path we translate it back to the original behaviour: print the clear message and exit(1).
    if (e instanceof ConfigExtendsError) {
      displayError(e.message);
      exit(1);
      // Unreachable past exit(1) in production; LOAD-BEARING under the specs' mocked exit so the
      // caller never observes a silently-composed config after a cycle/missing base.
      throw new Error('Unexpected error occurred.');
    }
    throw e;
  }
}

/**
 * GS2-73 — seed the `extends` chain from the selected profile's own name and run the throwing
 * traversal ({@link resolveExtendsChain}). Shared by BOTH consumers so the walk and its
 * cycle/missing-base checks live in ONE place: the run-path {@link resolveConfigExtends} (which
 * translates a {@link ConfigExtendsError} into `displayError` + `exit`) and the read-path
 * {@link validateConfig} (which records it as a not-ok layer). Propagates the typed error to its
 * caller; the caller owns the reporting convention.
 */
async function composeExtends(
  rawConfig: Record<string, unknown>,
  profileLabel: string | undefined
): Promise<Record<string, unknown>> {
  const seed = profileLabel?.trim();
  return resolveExtendsChain(rawConfig, seed ? [seed] : []);
}

/**
 * The recursive worker for {@link resolveConfigExtends}. `chain` is the ordered list of profile
 * names already being resolved (the selected profile first, then each `extends` base as it is
 * descended into) — used both for the name-based cycle guard and to render the cycle in the error.
 *
 * GS2-73 — on any hard failure (cycle, over-deep chain, missing base, unreadable base) it RAISES a
 * {@link ConfigExtendsError} rather than printing + `exit`ing inline, so the same traversal serves
 * both the run path and the read-side `validateConfig` (each translates the error its own way).
 */
async function resolveExtendsChain(
  rawConfig: Record<string, unknown>,
  chain: string[]
): Promise<Record<string, unknown>> {
  const baseName = typeof rawConfig.extends === 'string' ? rawConfig.extends.trim() : undefined;
  if (!baseName) {
    return rawConfig;
  }

  // Cycle guard (name-based): a base already present in the chain we are resolving loops back on
  // itself. Fail fast, naming the cycle — never recurse without bound. GS2-73 — raise the shared
  // {@link ConfigExtendsError}; the caller (run path vs. `validateConfig`) owns how it is surfaced.
  if (chain.includes(baseName)) {
    throw new ConfigExtendsError(
      `Profile inheritance cycle detected: ${[...chain, baseName].join(' -> ')}. ` +
        `A profile's "extends" chain must not refer back to itself.`
    );
  }

  // Depth backstop behind the name guard — a chain this long can only be a misconfiguration.
  if (chain.length >= MAX_EXTENDS_CHAIN_DEPTH) {
    throw new ConfigExtendsError(
      `Profile inheritance chain exceeds the maximum depth of ${MAX_EXTENDS_CHAIN_DEPTH}: ` +
        `${[...chain, baseName].join(' -> ')}. This is almost certainly a misconfiguration.`
    );
  }

  const basePath = resolveIdentityProfileConfigPath(baseName);
  if (!basePath) {
    const from = chain.length > 0 ? ` (referenced from "${chain[chain.length - 1]}")` : '';
    throw new ConfigExtendsError(
      `Profile "${baseName}" referenced by "extends"${from} was not found: no config file in ` +
        `${GSLOTH_DIR}/${GSLOTH_SETTINGS_DIR}/${baseName}/ (checked ${PROJECT_CONFIG_FORMATS.join(', ')}).`
    );
  }

  let baseRaw: Record<string, unknown>;
  try {
    baseRaw = await readRawConfigAtPath(basePath);
  } catch (e) {
    displayDebug(e instanceof Error ? e : String(e));
    throw new ConfigExtendsError(`Failed to read base profile "${baseName}" from ${basePath}.`);
  }

  // Validate the base layer exactly as the project layer is validated (deprecated-shape reject,
  // unknown-key warn, type-mismatch fail) so a broken base surfaces loudly rather than silently.
  const validatedBase = validateRawConfigLayer(baseRaw, `${baseName} (extends base)`);

  // Resolve the base's OWN extends first (base-of-base first), THEN merge this profile's delta on
  // top via the existing GS2-1 deep-merge (child = source, so it wins; additive-array fields at the
  // config root accumulate).
  const resolvedBase = await resolveExtendsChain(validatedBase, [...chain, baseName]);

  // Consume `extends` so it never leaks into the composed output, then merge child over base.
  const childDelta: Record<string, unknown> = { ...rawConfig };
  delete childDelta.extends;
  return deepMerge(resolvedBase, childDelta);
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
 * Returns true when a project-level config file (json/jsonc/js/mjs) exists for the given
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
 * (json/jsonc/js/mjs) or a standalone global config (`~/.gsloth/.gsloth.config.*`). When this
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

  // GS2-69 — prefer the DISCOVERED path when it is a JSON-family file, so a discovered
  // `.gsloth.config.jsonc` reaches the parseJsonc branch below (re-resolving only the `.json`
  // name here would miss it). When discovery found a module config (or nothing), fall back to
  // resolving the `.json` name — it won't exist, so the module fall-through below is unchanged.
  const discoveredJsonConfigPath =
    discovered && isJsonConfigPath(discovered.path) ? discovered.path : undefined;
  const jsonConfigPath =
    commandLineConfigOverrides.customConfigPath ??
    discoveredJsonConfigPath ??
    resolveConfigPath(
      baseDir,
      USER_PROJECT_CONFIG_JSON,
      commandLineConfigOverrides.identityProfile
    );

  // CFG-8 — when no project config file of any format exists (anywhere up-tree), fall back to a
  // standalone global config (loaded alone) before erroring. Project config still takes
  // precedence: this branch only runs when there is no project file to apply the global under.
  if (!discovered) {
    // GS2-62 — an EXPLICITLY named identity profile (`-i <name>` / eval `--judge <name>`) that
    // discovered no project config must NOT silently fall back to the global config. Doing so is a
    // false-green trap: `gth -i typo …` would run under the GLOBAL model while appearing to use the
    // named profile (in an authorization/eval context that hides a real misconfiguration). Fail
    // loudly instead. Gated on a non-empty identityProfile, so the CFG-8 no-profile global fallback
    // just below is UNTOUCHED — a run with no profile still loads the global exactly as before.
    const explicitProfile = commandLineConfigOverrides.identityProfile?.trim();
    if (explicitProfile) {
      displayError(
        `identity profile "${explicitProfile}" not found: no config file in ` +
          `${GSLOTH_DIR}/${GSLOTH_SETTINGS_DIR}/${explicitProfile}/ ` +
          `(checked ${PROJECT_CONFIG_FORMATS.join(', ')})`
      );
      exit(1);
      // Unreachable past exit(1) in production. In specs exit() is mocked to a no-op, so this throw
      // is LOAD-BEARING: without it execution would fall through into loadGlobalRawConfig() below
      // and the test would observe the global silently loaded — masking the very regression this
      // guard fixes. Matches the loader's existing post-exit sentinel-throw pattern.
      throw new Error('Unexpected error occurred.');
    }

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

  // Try loading the JSON/JSONC config file first (GS2-69 — an explicit `-c foo.jsonc` takes
  // this branch too instead of falling into the `configure()`-module importer).
  if (isJsonConfigPath(jsonConfigPath) && existsSync(jsonConfigPath)) {
    const jsonConfigName = jsonConfigPath.endsWith('.jsonc')
      ? USER_PROJECT_CONFIG_JSONC
      : USER_PROJECT_CONFIG_JSON;
    try {
      // Validate the project config layer against the Zod schema (single source of
      // truth): pre-map deprecated names, warn on unknown top-level keys, and fail
      // with a friendly, path-scoped message on a genuine type mismatch.
      const projectJsonConfig = validateRawConfigLayer(
        parseJsonc(readFileSync(jsonConfigPath, 'utf8'), jsonConfigName) as Record<string, unknown>,
        jsonConfigName
      ) as unknown as RawGthConfig;
      // GS2-41 — compose profile inheritance (`extends`) WITHIN the profile-dir layer BEFORE the
      // global base underlays it, so precedence stays CLI > profile(base+child) > global > defaults.
      // No-op (returns the config unchanged) when there is no `extends`.
      const composedProjectConfig = (await resolveConfigExtends(
        projectJsonConfig as unknown as Record<string, unknown>,
        commandLineConfigOverrides.identityProfile
      )) as unknown as RawGthConfig;
      // Apply global config as the base layer (project config wins on conflicts).
      const jsonConfig = (await applyGlobalConfigBase(
        composedProjectConfig as unknown as Record<string, unknown>
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
      displayError(`Failed to read config from ${jsonConfigName}, will try other formats.`);
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
 * json/js/mjs (the historical, asserted wording) — `.ts` is a quiet lowest-precedence fallback,
 * and `.jsonc` (GS2-69) is a quiet spelling variant of the advertised `.json`.
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
      // GS2-41 — compose profile inheritance (`extends`) before the global base underlays it
      // (parity with the JSON branch); no-op when there is no `extends`.
      const composedConfig = await resolveConfigExtends(
        customConfig,
        commandLineConfigOverrides.identityProfile
      );
      const mergedWithGlobal = await applyGlobalConfigBase(composedConfig);
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
      if (commandLineConfigOverrides.model) {
        // BATCH-1 fix — see CommandLineConfigOverrides.model: retarget the raw LLM *spec* before
        // the provider builds an instance from it, rather than cloning/mutating an already-built
        // instance. `gth batch --models` is the only current caller.
        llmConfig.model = commandLineConfigOverrides.model;
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
 * NOTE: the additive fields only live at the config ROOT, so they are triggered only by the
 * `deepMerge` calls that START at the config root (path === ''). There are TWO such sites: the
 * `applyGlobalConfigBase(global, project)` merge, and — as of GS2-41 — the root-level `deepMerge`
 * inside {@link resolveConfigExtends} that composes an `extends` base with its child profile. The
 * per-command `deepMerge` calls start at command scope and never reach these paths.
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
 * Command-scoped fields whose effective value is picked by PRECEDENCE — one layer wins wholesale
 * (a per-command value REPLACES rather than extends the top-level one; none is in
 * {@link ADDITIVE_ARRAY_FIELDS}). {@link resolvePrecedencePickedField} bakes the correct value into
 * every command inside {@link resolveConfig}, so `getEffectiveConfig`'s later per-command-vs-root
 * ternary reads an already-resolved value.
 *
 * GS2-60 — historically these were resolved ONLY at agent-build time (`getEffectiveConfig`), across
 * two layers (per-command value vs top-level value) AFTER `DEFAULT_CONFIG` had been merged in. That
 * made an explicit top-level value lose to a per-command DEFAULT: once merged, a command's
 * `filesystem` is always defined (from its `'read'`/`'all'` default), so the ternary always took it
 * and never fell through to the user's explicit top-level `filesystem`. Resolving here against the
 * RAW (pre-default) config — where "user set it" is still distinguishable from "it's a default" —
 * is the single correct site. Only `filesystem` is actually affected today (the sole field with
 * per-command defaults); the other three are baked in identically for principled future-proofing.
 */
const PRECEDENCE_PICKED_COMMAND_FIELDS = [
  'filesystem',
  'builtInTools',
  'allowedTools',
  'binaryFormats',
] as const;

/**
 * Resolve one {@link PRECEDENCE_PICKED_COMMAND_FIELDS} field for one command against the RAW
 * (pre-{@link DEFAULT_CONFIG}) config, highest precedence first:
 *
 *   1. per-command explicit : `rawConfig.commands[command][field]`
 *   2. top-level explicit    : `rawConfig[field]`
 *   3. per-command default   : `DEFAULT_CONFIG.commands[command][field]`
 *   4. top-level default     : `DEFAULT_CONFIG[field]`
 *
 * `!== undefined` at every layer so a falsy-but-EXPLICIT value (`'none'`, `[]`, `false`, `0`) is
 * honoured and never mistaken for a "missing" layer. Returns `undefined` only when no layer sets
 * the field (e.g. `allowedTools`/`binaryFormats` with neither a user value nor any default), in
 * which case the caller leaves the command key absent — matching prior behaviour.
 */
function resolvePrecedencePickedField(
  rawConfig: Partial<GthConfig>,
  command: keyof typeof DEFAULT_CONFIG.commands,
  field: (typeof PRECEDENCE_PICKED_COMMAND_FIELDS)[number]
): unknown {
  const rawCommands = rawConfig.commands as Record<string, Record<string, unknown>> | undefined;
  const perCommandExplicit = rawCommands?.[command]?.[field];
  if (perCommandExplicit !== undefined) return perCommandExplicit;

  const topLevelExplicit = (rawConfig as Record<string, unknown>)[field];
  if (topLevelExplicit !== undefined) return topLevelExplicit;

  const perCommandDefault = (DEFAULT_CONFIG.commands as Record<string, Record<string, unknown>>)[
    command
  ]?.[field];
  if (perCommandDefault !== undefined) return perCommandDefault;

  return (DEFAULT_CONFIG as Record<string, unknown>)[field];
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

  // GS2-60 — bake the correct 4-layer precedence for the precedence-picked fields
  // (filesystem/builtInTools/allowedTools/binaryFormats) into each command, resolved against the
  // RAW `config` (still pre-DEFAULT_CONFIG here). The per-command `deepMerge` above only ranks
  // per-command explicit vs per-command DEFAULT and cannot see the user's explicit top-level value
  // — so without this an explicit top-level `filesystem` was silently lost to a command's default.
  // A fresh `{ ...base, ...overrides }` per command is REQUIRED: `deepMerge` returns the live
  // `DEFAULT_CONFIG.commands[cmd]` reference verbatim when the user configured nothing for that
  // command, so in-place mutation would corrupt the shared default across every subsequent call.
  const commandsRecord = mergedCommands as unknown as Record<string, Record<string, unknown>>;
  for (const command of Object.keys(commandsRecord)) {
    const base = commandsRecord[command];
    const overrides: Record<string, unknown> = {};
    for (const field of PRECEDENCE_PICKED_COMMAND_FIELDS) {
      const resolved = resolvePrecedencePickedField(
        config,
        command as keyof typeof DEFAULT_CONFIG.commands,
        field
      );
      // Leave the key absent when no layer set it (preserves prior behaviour for e.g. a command
      // with no allowedTools anywhere), rather than writing an explicit `undefined`.
      if (resolved !== undefined) {
        overrides[field] = resolved;
      }
    }
    commandsRecord[command] = { ...base, ...overrides };
  }

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
 * Read a raw config object from an on-disk path WITHOUT validating, building an LLM, or
 * merging defaults. JSON/JSONC files are parsed leniently ({@link parseJsonc}); module
 * formats (`.js`/`.mjs`/`.ts`) are imported and their `configure()` invoked. Used by the
 * read-side {@link validateConfig}; may throw on a parse/module error (surfaced by the caller).
 */
async function readRawConfigAtPath(path: string): Promise<Record<string, unknown>> {
  if (path.endsWith('.json') || path.endsWith('.jsonc')) {
    return parseJsonc(readFileSync(path, 'utf8'), path) as Record<string, unknown>;
  }
  const imported = await importExternalFile(path);
  return (await imported.configure()) as Record<string, unknown>;
}

/**
 * Global config read for the read-side {@link validateConfig}: mirrors
 * {@link loadGlobalRawConfig}'s lookup order (JSON → JSONC → JS → MJS) but does NOT validate or
 * `exit` — it just returns the raw object + a source label so the validator owns the verdict.
 *
 * Ignore-on-error, exactly like {@link loadGlobalRawConfig}: a parse/module failure of the
 * global file is treated as an ABSENT global (returns `undefined`), NOT a hard error — a real
 * run does the same, so the diagnostic must too, else a clean project + an unparseable global
 * would fail `gth config validate` while the run keeps going (the inverse of the GS2-29 bug).
 *
 * The failure is BOTH debug-logged AND surfaced as a user-facing `displayWarning` with the same
 * message `loadGlobalRawConfig` emits (`Failed to read global config from <path>, ignoring it.`).
 * A run warns the user while ignoring the broken global's VALUE; matching that message is what
 * keeps `gth config validate` a faithful mirror of the run rather than staying silent about a
 * problem the run flags.
 */
async function loadGlobalRawConfigUnvalidated(): Promise<
  { raw: Record<string, unknown>; label: string } | undefined
> {
  for (const filename of JSON_CONFIG_FILENAMES) {
    const jsonPath = getGlobalGslothConfigReadPath(filename);
    if (existsSync(jsonPath)) {
      const label = `${filename} (global)`;
      try {
        return {
          raw: parseJsonc(readFileSync(jsonPath, 'utf8'), label) as Record<string, unknown>,
          label,
        };
      } catch (e) {
        displayDebug(e instanceof Error ? e : String(e));
        displayWarning(`Failed to read global config from ${jsonPath}, ignoring it.`);
        return undefined;
      }
    }
  }
  for (const filename of [USER_PROJECT_CONFIG_JS, USER_PROJECT_CONFIG_MJS]) {
    const modulePath = getGlobalGslothConfigReadPath(filename);
    if (existsSync(modulePath)) {
      try {
        const imported = await importExternalFile(modulePath);
        return {
          raw: (await imported.configure()) as Record<string, unknown>,
          label: `${filename} (global)`,
        };
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
 * One config LAYER's validation outcome inside a {@link ConfigValidationReport}: the pure
 * read-side result ({@link validateRawGthConfig}) plus the source label so a consumer can name
 * WHICH file carried a warning/error (the project path, or `"<name> (global)"`).
 */
export interface ConfigLayerValidationReport extends RawConfigValidationResult {
  /** The resolved config path (project layer) or `"<name> (global)"` (global layer). */
  sourceLabel: string;
}

/**
 * The outcome of `gth config validate`: whether any config was found, and the per-layer verdict
 * for EVERY layer a run would validate. Pure/read-side — it neither builds an LLM nor mutates
 * process globals, so it can report a verdict without the run-path's side effects. The command
 * layer turns this into console output + an exit code.
 *
 * GS2-29 — `validateConfig` mirrors the layer set `initConfig` validates: the discovered PROJECT
 * layer (if any) AND the GLOBAL layer (if any). A run validates both and exits(1) if EITHER
 * carries a problem, so a removed shape in the global config (with a clean project config) shows
 * up here exactly as the run would reject it. Both layers are kept in {@link layers} (in run
 * order) so the offending file is always identifiable.
 */
export interface ConfigValidationReport {
  /** False when neither a project nor a global config exists within the discovery boundary. */
  found: boolean;
  /** True only when a config was found AND every present layer validates OK. */
  ok: boolean;
  /**
   * Each config layer a run would load + validate, in run order: the discovered PROJECT layer
   * (if any) first, then the GLOBAL layer (if any). Empty when `found` is false.
   */
  layers: ConfigLayerValidationReport[];
}

/**
 * Locate and validate the effective raw config against the schema WITHOUT building the LLM
 * or merging defaults (the read-side of GS2-1). Honours `--config`, up-tree discovery, and the
 * identity profile via {@link findProjectConfigPath}.
 *
 * GS2-29 — validates the SAME layer set a real run does: the discovered PROJECT layer (if any)
 * AND the GLOBAL layer (if any), mirroring `initConfig`'s `validateRawConfigLayer(project)` +
 * `applyGlobalConfigBase` → `loadGlobalRawConfig(global)`. Each present layer is validated
 * independently ({@link validateRawGthConfig}) and its outcome recorded in {@link
 * ConfigValidationReport.layers}, so a removed shape in EITHER file is reported (labelled with
 * its source) rather than under-reported.
 *
 * A PROJECT-layer JSONC/module parse failure is thrown to the caller (surfaced as a clear
 * "invalid config" error + non-zero exit). A GLOBAL-layer parse failure is treated as an absent
 * global (no layer added) but is surfaced with a `displayWarning` — exactly as a run does (it
 * warns the user while ignoring the broken global's value) — see {@link
 * loadGlobalRawConfigUnvalidated}.
 *
 * GS2-73 — for the PROJECT layer it also walks the GS2-41 profile `extends` chain (via the SAME
 * {@link composeExtends}/{@link resolveExtendsChain} the run path uses), so a cycle or a missing
 * base — which fail a real run — is reported here as a not-ok layer instead of passing OK and only
 * failing at run time. The GLOBAL layer is NOT walked, mirroring the run (`resolveConfigExtends`
 * runs on the project/profile layer only).
 */
export async function validateConfig(
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<ConfigValidationReport> {
  const layers: ConfigLayerValidationReport[] = [];

  // Project layer first (run order): initConfig validates the discovered project config before
  // applying the global base. A parse failure here propagates (surfaced by the caller).
  const discovered = findProjectConfigPath(commandLineConfigOverrides);
  if (discovered) {
    const raw = await readRawConfigAtPath(discovered.path);
    const layer: ConfigLayerValidationReport = {
      sourceLabel: discovered.path,
      ...validateRawGthConfig(raw),
    };

    // GS2-73 — mirror the run's `extends` resolution. GS2-41's `resolveConfigExtends` walks the
    // profile inheritance chain and hard-fails a real run on a cycle or a missing base; the read
    // side must surface the SAME failures, else a profile whose `extends` names a missing base (or
    // forms a cycle) reports OK here yet dies at run time — the exact GS2-29 "validate mirrors the
    // layer set a run loads" divergence. Reuse the SAME traversal (via {@link composeExtends}) —
    // no forked walk — and record its typed failure as a not-ok layer instead of exiting. Gated on
    // `layer.ok` and on a string `extends`, mirroring run order (a run validates the raw shape and
    // only THEN resolves `extends`) and skipping the read + walk for the common no-`extends` config.
    if (layer.ok && typeof raw.extends === 'string') {
      try {
        await composeExtends(raw, commandLineConfigOverrides.identityProfile);
      } catch (e) {
        if (e instanceof ConfigExtendsError) {
          layer.ok = false;
          layer.errorMessage = e.message;
        } else {
          throw e;
        }
      }
    }

    layers.push(layer);
  }

  // Global layer next: a run ALWAYS applies it (applyGlobalConfigBase in the project path,
  // loadGlobalRawConfig in the no-project path), so the diagnostic must validate it too — this is
  // the layer the previous single-layer validateConfig skipped whenever a project config existed.
  const globalRaw = await loadGlobalRawConfigUnvalidated();
  if (globalRaw) {
    layers.push({ sourceLabel: globalRaw.label, ...validateRawGthConfig(globalRaw.raw) });
  }

  // Vacuous-truth guard: `every` is true on an empty array, so gate `ok` on a config existing.
  return { found: layers.length > 0, ok: layers.length > 0 && layers.every((l) => l.ok), layers };
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
  // GS2-53 — stash the raw provider `type` (openrouter/deepseek/xai/…) BEFORE the built `llm`
  // replaces the raw `llm` spec below: it is the true configured provider and the only place the
  // OpenAI-compatible shims' real identity survives (their `_llmType()` reports `openai`).
  // `resolveModelIdentity` prefers it over `_llmType()`. INTERNAL field (not in the config schema).
  const modelProviderType: string | undefined = config.llm?.type;
  return await mergeConfig(
    { ...config, llm, modelDisplayName, modelProviderType },
    commandLineConfigOverrides
  );
}
