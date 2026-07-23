/**
 * @packageDocumentation
 * GS2-33 — named config profiles. A profile is a `.gsloth/.gsloth-settings/<name>/` config
 * block: the SAME discovery convention the GS2-1 cascade resolves for `--profile` /
 * `--identity-profile` (see `loader.ts` `resolveIdentityProfileConfigPath`). This module is the
 * write side — scaffolding a new, schema-valid profile config — kept separate from the loader's
 * read side so the `gth config profile create` command is a thin wrapper over a pure, testable core.
 *
 * A named profile is NOT a merge on top of a base project config: with a profile selected the
 * loader's first-match walk picks the profile-dir config as THE project-file layer, so the
 * precedence is `CLI flags > profile-dir config > global config > DEFAULT_CONFIG`. The scaffolder
 * therefore writes a complete, standalone config (at minimum a valid `llm` spec), not a fragment.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GSLOTH_DIR, GSLOTH_SETTINGS_DIR, USER_PROJECT_CONFIG_JSON } from '#src/constants.js';
import { getProjectDir } from '#src/utils/systemUtils.js';
import { validateRawGthConfig } from '#src/config/schema.js';
import type { RawGthConfig } from '#src/config/types.js';

/**
 * A profile name maps to a single directory segment under `.gsloth-settings/`, so it must be one
 * safe path component: letters, digits, `.`, `_`, `-` only, and never `.`/`..` (which would escape
 * or self-reference the settings dir). This is a create-time guard so a traversal-shaped name
 * (`../evil`, `a/b`) can never write outside the profile tree.
 */
export const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Fallback provider/model for a scaffold seeded from neither a current config nor `--model`. */
export const DEFAULT_SCAFFOLD_PROVIDER = 'anthropic';
export const DEFAULT_SCAFFOLD_MODEL = 'claude-sonnet-4-5';

/**
 * Reject a profile name that is empty, `.`/`..`, or contains anything other than
 * `[A-Za-z0-9._-]` (so it can never traverse out of `.gsloth-settings/`). Throws a clear error;
 * returns the trimmed name on success.
 */
export function validateProfileName(nameRaw: string): string {
  const name = (nameRaw ?? '').trim();
  if (!name) {
    throw new Error('Profile name must not be empty.');
  }
  if (name === '.' || name === '..') {
    throw new Error(`Invalid profile name "${name}".`);
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}": use only letters, digits, '.', '_' or '-' ` +
        '(a profile name is a single directory segment).'
    );
  }
  return name;
}

/**
 * The on-disk path a named profile's config is written to / discovered at:
 * `<projectDir>/.gsloth/.gsloth-settings/<name>/.gsloth.config.json`. Resolved against
 * {@link getProjectDir} so it matches the loader's read-side resolution.
 */
export function resolveProfileConfigPath(name: string): string {
  return resolve(getProjectDir(), GSLOTH_DIR, GSLOTH_SETTINGS_DIR, name, USER_PROJECT_CONFIG_JSON);
}

/**
 * Options for seeding a scaffold. `seedType`/`seedModel` come from the current effective config
 * (`modelProviderType` / `modelDisplayName`) when one resolves — present for JSON configs, absent
 * for module (JS/MJS/TS) configs, which hand back an already-built LLM with no raw `type`. When
 * neither seed nor {@link modelOverride} is available the scaffold falls back to the template
 * defaults ({@link DEFAULT_SCAFFOLD_PROVIDER} / {@link DEFAULT_SCAFFOLD_MODEL}) so the written
 * profile is always a valid, editable starting point.
 */
export interface ProfileScaffoldSeed {
  /** Provider `type` of the current config (`modelProviderType`), when resolvable. */
  seedType?: string;
  /** Model id of the current config (`modelDisplayName`), when resolvable. */
  seedModel?: string;
  /** `--model <id>` override — wins over the seeded/template model. */
  modelOverride?: string;
}

/**
 * Build a complete, standalone raw profile config: `{ llm: { type, model } }`. The provider `type`
 * comes from the current config's provider when known, else the template default; the model comes
 * from `--model`, else the current config's model, else the template default. Shape-only — the
 * caller validates it against the schema before writing.
 */
export function buildProfileScaffold(seed: ProfileScaffoldSeed): RawGthConfig {
  const type = seed.seedType ?? DEFAULT_SCAFFOLD_PROVIDER;
  const model = seed.modelOverride ?? seed.seedModel ?? DEFAULT_SCAFFOLD_MODEL;
  return { llm: { type, model } } as RawGthConfig;
}

/** Outcome of {@link createNamedProfile}: the resolved path the profile config was written to. */
export interface CreateProfileResult {
  /** Absolute path of the written profile config. */
  path: string;
  /** The provider:model the scaffold was seeded with, for a confirmation message. */
  llm: { type: string; model: string };
}

/**
 * Scaffold a new named profile at {@link resolveProfileConfigPath}. Validates the name (no
 * traversal), builds the scaffold ({@link buildProfileScaffold}), validates it against the GS2-1
 * schema BEFORE writing (never writes an invalid profile), and refuses to clobber an existing
 * profile unless `force`. Creates the `.gsloth/.gsloth-settings/<name>/` tree as needed so the
 * loader's profile-discovery convention resolves it afterwards.
 *
 * @throws Error on an invalid name, an invalid scaffold, or an existing file without `force`.
 */
export function createNamedProfile(
  nameRaw: string,
  seed: ProfileScaffoldSeed & { force?: boolean }
): CreateProfileResult {
  const name = validateProfileName(nameRaw);
  const scaffold = buildProfileScaffold(seed);

  // Validate BEFORE writing — a broken scaffold must fail here, never land on disk to be run later.
  const validation = validateRawGthConfig(scaffold as unknown as Record<string, unknown>);
  if (!validation.ok) {
    throw new Error(
      `Refusing to write an invalid profile "${name}":\n${validation.errorMessage ?? ''}`
    );
  }

  const path = resolveProfileConfigPath(name);
  if (existsSync(path) && !seed.force) {
    throw new Error(`Profile "${name}" already exists at ${path}. Pass --force to overwrite it.`);
  }

  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(scaffold, null, 2)}\n`, 'utf8');

  const llm = scaffold.llm as { type: string; model: string };
  return { path, llm: { type: llm.type, model: llm.model } };
}
