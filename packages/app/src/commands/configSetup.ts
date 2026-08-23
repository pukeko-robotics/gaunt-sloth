import { GSLOTH_DIR, USER_PROJECT_CONFIG_JSON } from '@gaunt-sloth/core/constants.js';
import {
  availableDefaultConfigs,
  validateProfileName,
  type ConfigType,
} from '@gaunt-sloth/core/config.js';
import { resolveInitModel, type ProviderId } from '@gaunt-sloth/core/providers/modelDiscovery.js';
import { displayError, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getGslothConfigWritePath } from '@gaunt-sloth/review/utils/fileUtils.js';
import { getGlobalGslothConfigWritePath } from '@gaunt-sloth/core/utils/globalConfigUtils.js';
import { exit, getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where {@link createProjectConfig} writes the scaffolded config. Mirrors {@link ConfigScope}
 * (firstRunDialog.ts) but as a destination the scriptable `gth init <provider>` path is told
 * rather than a choice it asks for: `global: true` selects `~/.gsloth/` (or its named profile
 * dir); `global: false`/omitted keeps the existing project default.
 */
export interface CreateProjectConfigDest {
  /** Write into the global `~/.gsloth` tree instead of the project's `.gsloth/`. */
  global?: boolean;
  /** Named profile subdirectory within `.gsloth-settings/` (project or global, per `global`). */
  identityProfile?: string;
}

export async function createProjectConfig(
  configType: string,
  force = false,
  dest: CreateProjectConfigDest = {}
): Promise<void> {
  if (!availableDefaultConfigs.includes(configType as ConfigType)) {
    displayError(
      `Unknown config type: ${configType}. Available options: ${availableDefaultConfigs.join(', ')}`
    );
    exit(1);
  }

  // GS2-33 — a bad profile name must never reach a mkdir or a write.
  let identityProfile = dest.identityProfile;
  if (identityProfile !== undefined) {
    try {
      identityProfile = validateProfileName(identityProfile);
    } catch (err) {
      displayError(err instanceof Error ? err.message : String(err));
      exit(1);
      return;
    }
  }

  const global = !!dest.global;

  if (global) {
    displayInfo(`Setting up your global configuration\n`);
  } else {
    ensureGslothDir();
    displayInfo(`Setting up your project\n`);
  }

  // GS2-43: `gth init` scaffolds the config file ONLY. The planted `.gsloth.guidelines.md` /
  // `.gsloth.review.md` templates are gone — the bundled defaults (empty guidelines, a complete
  // review prompt) apply until the user creates their own files or points `prompts.*` elsewhere.
  // Without --force, keep an existing config (and say so honestly) rather than running
  // the provider init, whose no-clobber write would silently skip and leave a misleading trail.
  const configPath = global
    ? getGlobalGslothConfigWritePath(USER_PROJECT_CONFIG_JSON, identityProfile)
    : getGslothConfigWritePath(USER_PROJECT_CONFIG_JSON, identityProfile);
  if (!force && existsSync(configPath)) {
    displayWarning(
      `${configPath} already exists and was kept (not overwritten). Re-run with --force to overwrite it.`
    );
    return;
  }

  displayInfo(`Creating ${global ? 'global ' : 'project '}config for ${configType}`);
  // CFG-14: resolve the model to write from live `/v1/models` discovery when a key/daemon is
  // present (a verified-present id, never a speculative literal). When live discovery is
  // impossible this returns undefined and `init` omits `model`, deferring to the provider's
  // single curated run-time fallback (getCuratedFallbackModel) rather than baking a stale id that
  // 404s once the model is retired.
  const model = await resolveInitModel(configType as ProviderId);
  const vendorConfig = await import(`@gaunt-sloth/core/providers/${configType}.js`);
  vendorConfig.init(configPath, force, model);
}

/**
 * Ensures that the .gsloth directory exists in the project root.
 * Creates it if it does not exist.
 */
export function ensureGslothDir(): void {
  const projectDir = getCurrentWorkDir();
  const gslothDirPath = resolve(projectDir, GSLOTH_DIR);
  if (!existsSync(gslothDirPath)) {
    mkdirSync(gslothDirPath, { recursive: true });
    displayInfo(`Created ${GSLOTH_DIR} directory`);
  }
}
