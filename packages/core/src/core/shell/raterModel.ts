/**
 * @module core/shell/raterModel
 *
 * CFG-26 — resolve the model a gate model runs on when a config key names an identity profile.
 * Without this the profile is validated and then IGNORED: the config parses, `gth config validate`
 * passes, CFG-24's first-run dialog promises a stronger model can be set as the rater later — and
 * the runtime quietly rates with the main model.
 *
 * [[EXT-127]] — **it serves two keys now**, `approvals.rater` and `approvals.alignmentChecker`,
 * which is why the key name is a parameter rather than a literal. The two resolve identically and
 * fail identically; only the sentence the user is shown differs, and pointing them at one wrong key
 * is a user-facing defect in the one message that is supposed to tell them what to fix.
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
 * Load the identity profile named by `configKey` and return ITS model.
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
 * @param profile The identity profile name the key carried.
 * @param configKey The config key that named it, for the error messages — `approvals.rater` or
 *   `approvals.alignmentChecker`. It is the only thing the user can act on, so it is required
 *   rather than defaulted: a default is how one of the two call sites would come to report the
 *   other one's key.
 * @returns The profile's chat model, ready to be handed to a gate call's `model` option.
 * @throws When the profile's config cannot be loaded or carries no usable model.
 */
export async function resolveRaterModel(
  profile: string,
  configKey: string
): Promise<BaseChatModel> {
  // Snapshot BEFORE initConfig's discovery mutates it (see the note above). `peekProjectDir`
  // rather than `getProjectDir` so an UNSET dir is restored as unset, not pinned to today's cwd.
  const projectDirBefore = peekProjectDir();
  let raterConfig;
  try {
    raterConfig = await initConfig({ identityProfile: profile });
  } catch (error) {
    throw new Error(
      `Could not load the identity profile "${profile}" named by ${configKey}: ` +
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
      `The identity profile "${profile}" resolved to a config with no usable model. ` +
        `Give that profile a valid \`llm\`, or remove ${configKey} to use the session model.`
    );
  }
  return model;
}
