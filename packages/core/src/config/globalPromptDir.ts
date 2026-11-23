import { resolve } from 'node:path';
import { GSLOTH_SETTINGS_DIR } from '#src/constants.js';
import { getGlobalGslothDir } from '#src/utils/globalConfigUtils.js';

/**
 * CFG-89 — on a `--global` run, the directory the global config layer is read from, which is where
 * that config's prompt files live: `~/.gsloth/.gsloth-settings/<profile>/` with an identity profile,
 * `~/.gsloth/` without. `undefined` on any other run. A blank/whitespace-only profile name counts as
 * "no profile", as it does for the config path.
 */
export function globalPromptDir(
  global: boolean | undefined,
  identityProfileRaw?: string
): string | undefined {
  if (!global) return undefined;
  const identityProfile = identityProfileRaw?.trim();
  return identityProfile
    ? resolve(getGlobalGslothDir(), GSLOTH_SETTINGS_DIR, identityProfile)
    : getGlobalGslothDir();
}
