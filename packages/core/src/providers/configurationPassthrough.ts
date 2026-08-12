import { displayWarning } from '#src/utils/consoleUtils.js';

/**
 * `configuration` is `ChatOpenAI`'s own constructor field, which LangChain forwards to the OpenAI
 * Node SDK's `ClientOptions`. It therefore only means anything for a provider that ends up handing
 * the user's block to such a client: `openai` and `huggingface` build one directly, and `deepseek`
 * spreads the user's block over its own defaults. For those, a block is a supported, working
 * passthrough and MUST be left alone.
 *
 * **Descending from `ChatOpenAI` is NOT evidence of a passthrough — read the constructor.** `xai`
 * descends from it and still consumes nothing: `ChatXAI` REPLACES `configuration` with a block of
 * its own before calling `super`, so a timeout, headers, and even a base URL set there all reach
 * nothing. Reading ancestry as consumption is exactly how a provider keeps its silence here, so
 * classify a provider by what its constructor does with the block, never by what it extends.
 *
 * A provider on a NATIVE (non-OpenAI-SDK) client has nothing to hand the block to, so anything the
 * factory does not read itself goes nowhere. `llmConfigSchema` is a `z.looseObject`, so an orphaned
 * block also passes validation without a word — which is the 2.0 config policy's exact failure mode:
 * a removed key is fine, a SILENTLY IGNORED one is not, because the config then behaves differently
 * than it reads. This is the one place that turns that silence into a message, so a second native
 * provider does not have to reinvent it.
 *
 * **Scope: paths INSIDE a `configuration` block, and nothing else.** A top-level key of the `llm`
 * block that the chosen provider does not read — `llm.defaultHeaders` on `xai`, say — is the same
 * silently-ignored-key defect, and this module does not cover it: the loose schema accepts it, no
 * factory reads it, and nothing is printed. Guidance that sends a setting "to the top level" is
 * therefore only safe for a field that provider actually has, which is why every `guidance` here
 * names the replacement rather than a direction.
 *
 * Use it from a native-client factory only, and pass the paths that factory genuinely consumes.
 */

/** A `configuration` sub-object is a plain record; anything else cannot carry consumable settings. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * List the paths inside a `configuration` block that the calling factory will NOT read.
 *
 * `consumedPaths` entries are either a whole key (`baseURL`) or a dotted one-level path
 * (`defaultHeaders.X-Title`). The dotted form matters because consumption is genuinely PARTIAL:
 * openrouter reads two named attribution headers out of `defaultHeaders` and drops every other
 * header in it. Reporting `defaultHeaders` as wholly consumed would silence the warning for
 * exactly the case the user most needs it for — an auth header for a self-hosted gateway that is
 * quietly discarded.
 *
 * A `configuration` that is not a record at all (`configuration: "https://x/v1"`, a plausible typo
 * for the block) has no paths and is reported as nothing. That is NOT a silent drop: `llm.configuration`
 * is `z.record` in `schema.ts`, and every config layer goes through the loader's `validateRawConfigLayer`,
 * so a non-record value is a hard, path-scoped validation error that ends the run before any provider
 * factory is reached. The schema is the gate for the shape; this function is the gate for the
 * contents. `configurationPassthrough.spec.ts` pins that boundary — if the schema ever stops
 * requiring a record, the case has to be handled here instead.
 */
export function findUnusedConfigurationPaths(
  configuration: unknown,
  consumedPaths: readonly string[]
): string[] {
  if (!isPlainRecord(configuration)) return [];
  const unused: string[] = [];
  for (const [key, value] of Object.entries(configuration)) {
    if (consumedPaths.includes(key)) continue;
    const consumedSubKeys = consumedPaths
      .filter((path) => path.startsWith(`${key}.`))
      .map((path) => path.slice(key.length + 1));
    if (consumedSubKeys.length > 0 && isPlainRecord(value)) {
      for (const subKey of Object.keys(value)) {
        if (!consumedSubKeys.includes(subKey)) unused.push(`${key}.${subKey}`);
      }
      continue;
    }
    unused.push(key);
  }
  return unused;
}

/**
 * The `reason` for a provider built on a NATIVE client: there is no OpenAI client anywhere in the
 * chain, so the block has nothing to be handed to.
 *
 * A shared clause is only safe while it is true of every caller that passes it, and nothing in the
 * language can check that: the field takes any string, so a caller can pass this sentence — or
 * another provider's — for a provider it is false of, and a warning that states a false reason is
 * the same defect as the silence it replaces. Requiring the field stops one narrow version of that
 * (a default nobody re-read against the new caller) and stops nothing else; copying the neighbouring
 * call site is the likelier move and is exactly how a false clause would spread.
 *
 * What actually holds it is `configurationPassthrough.spec.ts`, which pins every warned provider's
 * printed clause IN ITS SLOT beside that provider's own name. A clause that migrates to a provider
 * it is false of reddens a cell, and editing THIS sentence reddens every caller that passes it —
 * which is the point: a shared clause has to be re-checked against each of them.
 */
export const NATIVE_CLIENT_REASON =
  'does not build an OpenAI client, so a "configuration" block is not passed through to one';

/**
 * Warn — naming the provider, saying why the block is dropped, naming every dropped path, and
 * pointing at the replacement — when a user's `configuration` block carries settings this provider
 * cannot consume.
 *
 * Warn rather than throw: a provider that reads SOME of the block (openrouter still honours
 * `configuration.baseURL`) would otherwise refuse a config that is partly valid, and an upgrading
 * user whose only config sets one dead transport key would be left with no way to start at all.
 *
 * Takes ONE named-field object rather than a positional list. `reason` and `guidance` are both free
 * text, so as adjacent positionals they could be transposed with nothing to catch it: `tsc` sees two
 * strings, and the rendered message still contains both sentences — only their order is wrong, which
 * no `toContain` check on either one can see. Named fields make that mistake visible where it is
 * written; the slot-anchored pins in `configurationPassthrough.spec.ts` are what catch it if it is
 * written anyway.
 */
export interface UnusedConfigurationWarning {
  /** The gth provider namespace, printed to the user (`anthropic`, `xai`, …). */
  provider: string;
  /** The user's `llm.configuration` block, exactly as it arrived. */
  configuration: unknown;
  /**
   * The paths inside the block this factory genuinely reads — whole keys or dotted one-level paths.
   * Required rather than defaulted to `[]`, so a new caller has to state what its factory consumes
   * instead of inheriting an answer.
   */
  consumedPaths: readonly string[];
  /**
   * Why THIS provider drops the block, as a clause completing `the "<provider>" provider …`. Pass
   * {@link NATIVE_CLIENT_REASON} for a native-client provider; a provider that builds an OpenAI
   * client and then overrides the block needs its own, because that sentence would be false for it.
   */
  reason: string;
  /**
   * What to do instead, naming the replacement on THIS provider's own client — never a generic
   * "move it up a level", which for some keys moves a setting from a warned location to an unwarned
   * one.
   */
  guidance: string;
}

export function warnUnusedConfiguration({
  provider,
  configuration,
  consumedPaths,
  reason,
  guidance,
}: UnusedConfigurationWarning): void {
  const unused = findUnusedConfigurationPaths(configuration, consumedPaths);
  if (unused.length === 0) return;
  displayWarning(
    `Ignoring ${unused.map((path) => `llm.configuration.${path}`).join(', ')} — ` +
      `the "${provider}" provider ${reason}. ${guidance}`
  );
}

/**
 * Warn when a `configuration` path the factory DOES consume silently beats a top-level field of the
 * `llm` block that sets the same thing.
 *
 * Neither value is unusable here and neither location is wrong, so this is not a case for
 * {@link warnUnusedConfiguration}: both are honoured surfaces, and the only defect is that one wins
 * without saying so. The user's config then reads as two settings and behaves as one.
 *
 * Values are never printed — a base URL can carry credentials — so the message names the two paths
 * and which of them takes effect.
 *
 * @param appliedValue The value the factory actually applied. Pass the result of the SAME expression
 *   that decides it, never a second copy of the test, for the reason given on
 *   {@link warnUnappliedConfigurationPath}.
 */
export function warnConfigurationOverridesTopLevelField(
  provider: string,
  field: string,
  topLevelValue: unknown,
  appliedValue: unknown
): void {
  // Nothing to lose: no top-level field set, or the block's value was not applied over it.
  if (topLevelValue === undefined || topLevelValue === null || topLevelValue === '') return;
  if (appliedValue === undefined || appliedValue === null) return;
  // The same endpoint written twice is redundant, not a conflict, and warning on it would train
  // users to ignore the message.
  if (topLevelValue === appliedValue) return;
  displayWarning(
    `Ignoring llm.${field} — the "${provider}" provider also has llm.configuration.${field} set, ` +
      `and that one takes precedence. Set only one of the two so the "llm" block reads the way it ` +
      `behaves.`
  );
}

/**
 * Warn when a path the factory DECLARES it consumes is present in the user's block but was not in
 * fact applied — the empty string or `null` a factory's own guard skips.
 *
 * {@link findUnusedConfigurationPaths} cannot see this and must not: the path genuinely IS consumed,
 * so it is correctly absent from the unused list — and the user's setting still goes nowhere.
 * "Declared supported, in fact dropped" is the same silence this module exists to end, so it gets
 * its own message: the "no OpenAI client" reason above would be the wrong reason for it.
 *
 * @param applied Whether the factory actually used the value. Pass the result of the SAME expression
 *   that decides it (`'baseURL' in baseURLOverride`), never a second copy of the test — a re-test is
 *   exactly how the guard and what the user is told drift apart.
 */
export function warnUnappliedConfigurationPath(
  provider: string,
  configuration: unknown,
  path: string,
  applied: boolean,
  guidance: string
): void {
  if (applied) return;
  if (!isPlainRecord(configuration) || !(path in configuration)) return;
  displayWarning(
    `Ignoring llm.configuration.${path} — it is set for the "${provider}" provider but carries no ` +
      `usable value, so it is not applied. ${guidance}`
  );
}
