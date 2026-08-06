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
 * - `config/schema.ts` — the Zod schema (single source of truth) + JSON-Schema generator.
 * - `config/tool-descriptions.ts` — EXT-58: the rung-aware tool-description suffixes (§4.5) and
 *   the granted-built-in table the rater's alternative suggestion draws on (§4.4).
 * - `config/filesystem-tools.ts` — the one interpretation of `filesystem`: which filesystem tools
 *   it registers, shared by the toolkit filter and the system-prompt notes.
 *
 * Every name that was previously exported from `config.ts` is re-exported here, so the
 * public import path `@gaunt-sloth/core/config.js` (and `#src/config.js`) is unchanged.
 */
export * from '#src/config/types.js';
export * from '#src/config/shell-policy.js';
export * from '#src/config/tool-descriptions.js';
export * from '#src/config/filesystem-tools.js';
export * from '#src/config/defaults.js';
export * from '#src/config/loader.js';
export * from '#src/config/profiles.js';
export * from '#src/config/providerKeys.js';
