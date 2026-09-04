/**
 * @packageDocumentation
 * Gaunt Sloth Configuration.
 *
 * Refer to {@link GthConfig} to find all possible configuration properties.
 *
 * Refer to {@link DEFAULT_CONFIG} for default configuration.
 *
 * Some config params can be overriden from command line, see {@link CommandLineConfigOverrides}
 *
 * This module is the **public barrel** for the configuration system. The implementation
 * is split into focused modules under `config/`:
 * - `config/types.ts` — the configuration type surface.
 * - `config/shell-policy.ts` — {@link GthDevToolsConfig} + the shell/dev-tools resolvers.
 * - `config/defaults.ts` — {@link DEFAULT_CONFIG}.
 * - `config/loader.ts` — discovery + the layered load/merge pipeline.
 * - `config/providerKeys.ts` — {@link MissingProviderKeyError}, the catchable error a load raises
 *   when a provider has no resolvable API key.
 * - `config/configDiscovery.ts` — {@link ConfigDiscoveryError}, the catchable error a load raises
 *   when a named identity profile does not resolve or a config layer is malformed.
 * - `config/schema.ts` — the Zod schema (single source of truth) + JSON-Schema generator. Its
 *   schema-owned *types* that appear in this barrel's own type surface are re-exported below; its
 *   runtime helpers stay behind the `config/schema.js` deep path.
 * - `config/tool-descriptions.ts` — EXT-58: the rung-aware tool-description suffixes (§4.5) and
 *   the granted-built-in table the rater's alternative suggestion draws on (§4.4).
 * - `config/filesystem-tools.ts` — the one interpretation of `filesystem`: which filesystem tools
 *   it registers, shared by the toolkit filter and the system-prompt notes.
 *
 * Every name that was previously exported from `config.ts` is re-exported here, so the
 * public import path `@gaunt-sloth/core/config.js` (and `#src/config.js`) is unchanged.
 */
export * from '#src/config/types.js';
// EXT-161 — the ONE token-budget parser, shared by the `autocompact` config key and the in-session
// `/autocompact` command. It is exported from the barrel precisely so the command can reach it:
// `packages/agent` imports `@gaunt-sloth/core/config.js`, and a parser it could not reach is a
// parser it would reimplement.
export * from '#src/config/tokenBudget.js';
export * from '#src/config/shell-policy.js';
export * from '#src/config/tool-descriptions.js';
export * from '#src/config/filesystem-tools.js';
export * from '#src/config/defaults.js';
export * from '#src/config/loader.js';
export * from '#src/config/profiles.js';
export * from '#src/config/providerKeys.js';
export * from '#src/config/configDiscovery.js';

/**
 * Schema-owned types that a consumer of this barrel would otherwise be unable to NAME: each one is
 * the declared type of something already reachable here, so leaving it out lets a caller assign a
 * value it cannot type.
 *
 * - {@link GthOutputHeaderRung} — the type of {@link GthConfig}'s `output.header`.
 * - {@link GthAcpSessionMode} — the type of {@link GthConfig}'s `acp.mode`.
 * - {@link RawConfigValidationResult} — the interface {@link ConfigLayerValidationReport} extends.
 *
 * These stay declared in `config/schema.ts` on purpose: `config/types.ts` importing the rung from
 * the Zod schema is what keeps the type and the validator a single source of truth rather than a
 * hand-written twin. The re-export is type-only, so it erases at emit and adds no runtime edge.
 *
 * The schema's runtime surface — `rawGthConfigSchema`, `generateConfigJsonSchema`,
 * `validateRawGthConfig`, the deprecation scanners, `KNOWN_TOP_LEVEL_KEYS` — is deliberately NOT
 * re-exported: it is validator internals, reachable at your own risk via the
 * `@gaunt-sloth/core/config/schema.js` deep path.
 */
export type {
  GthAcpSessionMode,
  GthOutputHeaderRung,
  RawConfigValidationResult,
} from '#src/config/schema.js';
