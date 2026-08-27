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
 * Use it from a native-client factory only, and pass the paths that factory genuinely consumes.
 *
 * **Scope: an `llm` setting that goes nowhere because of WHERE it was written.** Two shapes of that,
 * needing two messages because the reason differs:
 *
 * - a path inside a `configuration` block the provider cannot use — {@link warnUnusedConfiguration},
 *   with {@link warnUnappliedConfigurationPath} for a path the factory declares it reads and then
 *   skips as empty;
 * - two honoured locations that set the same thing, one of which silently wins —
 *   {@link warnShadowedField}.
 *
 * **A top-level `llm` field the provider class does not read at all — `llm.defaultHeaders` on `xai`
 * — is the same silently-ignored-key defect and is still NOT covered here.** It cannot be, without
 * naming providers: `llmConfigSchema` is a `z.looseObject` and every factory spreads the whole block
 * into its class on purpose, which is how OpenRouter's `provider`, `models` and `route` work with no
 * schema entry each. One mechanism, two opposite meanings.
 *
 * **Measuring it — build the class with and without the field, and see whether anything moved —
 * was built and reverted, because it CANNOT work on all providers and cannot tell that it can't.**
 * `ChatGoogle` (so `google-genai` and `vertexai`) copies every field it is given, read or not, into
 * the same bag, and consumes it later at request-build time. Measured on a plain google config: a
 * canary key no provider could read moves `params.<key>`, `apiClient.params.<key>`,
 * `lc_kwargs.<key>` and their nested twins — and `temperature`, which that model genuinely uses,
 * moves exactly those same five paths under its own name. A used field and an ignored one are
 * structurally identical, so the probe answered "temperature and topK reach nothing" for a working
 * config with none of its own refusal gates firing. Nor does a positive control rescue it:
 * `ChatGoogle` DOES hoist `model` to a top-level property while not hoisting `temperature`, so
 * "this class hoists what it reads" is false of the very class that needs it. Only a per-provider
 * list of consumable names would close the gap, which is the enumeration this codebase avoids.
 * See [[CFG-46]] for the full measurement. Until a provider-independent signal exists, silence is
 * the safer half of the trade — a false warning on a working field teaches users to ignore the
 * message, and the fields it would hit are the ones the docs recommend.
 *
 * Guidance that sends a setting "to the top level" therefore has to name a field that provider
 * genuinely has, which is why every `guidance` here names the replacement rather than a direction.
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
 * Warn when one honoured location of the `llm` block silently beats another that sets the same
 * thing.
 *
 * Neither value is unusable here and neither location is wrong, so this is not a case for
 * {@link warnUnusedConfiguration}: both are honoured surfaces, and the only defect is that one wins
 * without saying so. The user's config then reads as two settings and behaves as one.
 *
 * **The two paths are arbitrary, and they have to be**, because the precedence in this block is not
 * one direction. For `baseURL` the `configuration` value beats the top-level field; for the
 * OpenRouter attribution headers the top-level `siteUrl`/`siteName` beat the header inside the
 * block, and the losing path is a nested one that shares no name with the winner. A helper that
 * took a single `field` and hardcoded which side of it wins could only ever announce the first of
 * those, which is how the second stayed silent.
 *
 * Values are never printed — a base URL can carry credentials — so the message names the two paths
 * and which of them takes effect.
 *
 * **Named fields, and the reason the names are not the whole guard.** `ignoredPath`/`appliedPath`
 * are two strings and `ignoredValue`/`appliedValue` two `unknown`s, so a transposition type-checks
 * either way round; the rendered message still contains both paths and only their ROLES are
 * swapped, which no `toContain` on either path can see. What catches it is in
 * `configurationPassthrough.spec.ts`: the paths are pinned IN THEIR SLOTS in the rendered sentence,
 * and the values by the discriminating pair around the empty-value guard below (an empty LOSER is
 * silent, an empty WINNER is not).
 */
export interface ShadowedFieldWarning {
  /** The gth provider namespace, printed to the user (`openrouter`, …). */
  provider: string;
  /**
   * The path whose value is NOT used, relative to the `llm` block and printed with an `llm.`
   * prefix — `baseURL`, or `configuration.defaultHeaders.HTTP-Referer`.
   */
  ignoredPath: string;
  /** The path whose value IS used, in the same form. */
  appliedPath: string;
  /** The value at {@link ignoredPath}, as the user wrote it. Never printed. */
  ignoredValue: unknown;
  /**
   * The value the factory actually applied. Pass the result of the SAME expression that decides it,
   * never a second copy of the test, for the reason given on {@link warnUnappliedConfigurationPath}.
   * Never printed.
   */
  appliedValue: unknown;
}

export function warnShadowedField({
  provider,
  ignoredPath,
  appliedPath,
  ignoredValue,
  appliedValue,
}: ShadowedFieldWarning): void {
  // Nothing to lose: the losing location is unset, or carries no usable value of its own.
  if (ignoredValue === undefined || ignoredValue === null || ignoredValue === '') return;
  if (appliedValue === undefined || appliedValue === null) return;
  // The same setting written twice is redundant, not a conflict, and warning on it would train
  // users to ignore the message.
  if (ignoredValue === appliedValue) return;
  displayWarning(
    `Ignoring llm.${ignoredPath} — the "${provider}" provider also has llm.${appliedPath} set, ` +
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
