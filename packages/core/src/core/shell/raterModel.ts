/**
 * @module core/shell/raterModel
 *
 * CFG-26 — resolve the model the AI rater rates with when `approvals.rater.profile` names an
 * identity profile. Without this the profile is validated and then IGNORED: the config parses,
 * `gth config validate` passes, CFG-24's first-run dialog promises "set a stronger model as the
 * rater later via approvals.rater.profile" — and the runtime quietly rates with the main model.
 *
 * Why it matters concretely (QA-5 rater baseline, 2026-07-26): rating quality varies enormously by
 * model. A local `gemma4:12b` scored 61.7% tier accuracy; `llama3.2:1b` scored 25.5% and rated
 * EVERY safe command `danger`. Pointing the rater at a competent model is the difference between
 * `auto` being useful and being `ask` with a bill attached — so the knob has to actually work.
 *
 * Kept in its own module (rather than inline in {@link GthAgentRunner}) for two reasons: the
 * runner's specs can mock THIS seam instead of the whole `#src/config.js` barrel, and the
 * global-state discipline below lives in exactly one place.
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import { initConfig } from '#src/config/loader.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';

/**
 * Load the identity profile named by `approvals.rater.profile` and return ITS model.
 *
 * Strict, per [[GS2-62]]: a profile that cannot be loaded, or that resolves to a config with no
 * usable model, is an ERROR — never a silent fallback to the session's main model. A silent
 * fallback is precisely the failure this function exists to remove (the user asked for a stronger
 * rater and would have been given the weak one, with nothing said). The profile's EXISTENCE is
 * already validated at config-load time by the loader (and by `gth config validate`); this is the
 * later, separate question of whether it yields a usable model.
 *
 * **Global-state discipline.** `initConfig` re-runs project discovery and calls
 * `setProjectDir(discovered?.dir)` as a side effect. That is correct for the SESSION's config load
 * but wrong for this subsidiary one: a rater sub-config must never re-root the session. Because
 * this call passes no `customConfigPath`, discovery re-walks from cwd and can legitimately land on
 * a different dir than the session did (e.g. a session started with `-c <path>`), which would then
 * silently repoint every `getProjectDir()` consumer — prompt files, output paths, the shell
 * allow-list file, debug dumps. So the project dir is snapshotted and restored in a `finally`.
 *
 * @param profile The identity profile name from `approvals.rater.profile`.
 * @returns The profile's chat model, ready to be handed to `rateShellCommand`'s `model` option.
 * @throws When the profile's config cannot be loaded or carries no usable model.
 */
export async function resolveRaterModel(profile: string): Promise<BaseChatModel> {
  // Snapshot BEFORE initConfig's discovery mutates it (see the note above). `peekProjectDir`
  // rather than `getProjectDir` so an UNSET dir is restored as unset, not pinned to today's cwd.
  const projectDirBefore = peekProjectDir();
  let raterConfig;
  try {
    raterConfig = await initConfig({ identityProfile: profile });
  } catch (error) {
    throw new Error(
      `Could not load the AI rater profile "${profile}" named by approvals.rater.profile: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined
    );
  } finally {
    setProjectDir(projectDirBefore);
  }

  const model = raterConfig?.llm;
  // Guard explicitly rather than returning `undefined`: `rateShellCommand` falls back to
  // `config.llm` when its `model` option is undefined, so handing it undefined here would
  // reintroduce the very silent fallback this module removes.
  if (!model || typeof model.withStructuredOutput !== 'function') {
    throw new Error(
      `The AI rater profile "${profile}" resolved to a config with no usable model. ` +
        'Give that profile a valid `llm`, or remove approvals.rater.profile to rate with the ' +
        'session model.'
    );
  }
  return model;
}
