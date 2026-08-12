import { displayWarning } from '#src/utils/consoleUtils.js';

/**
 * `configuration` is `ChatOpenAI`'s own constructor field, which LangChain forwards to the OpenAI
 * Node SDK's `ClientOptions`. It therefore only means anything for a provider whose model class
 * descends from `ChatOpenAI` — `openai` and `huggingface` build one directly, `deepseek` and `xai`
 * inherit it. For those, a user's block is a supported, working passthrough and MUST be left alone.
 *
 * A provider on a NATIVE (non-OpenAI-SDK) client has nothing to hand the block to, so anything the
 * factory does not read itself goes nowhere. `llmConfigSchema` is a `z.looseObject`, so an orphaned
 * block also passes validation without a word — which is the 2.0 config policy's exact failure mode:
 * a removed key is fine, a SILENTLY IGNORED one is not, because the config then behaves differently
 * than it reads. This is the one place that turns that silence into a message, so a second native
 * provider does not have to reinvent it.
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
 * Warn — naming the provider, naming every dropped path, and pointing at the replacement — when a
 * user's `configuration` block carries settings this provider cannot consume.
 *
 * Warn rather than throw: a provider that reads SOME of the block (openrouter still honours
 * `configuration.baseURL`) would otherwise refuse a config that is partly valid, and an upgrading
 * user whose only config sets one dead transport key would be left with no way to start at all.
 */
export function warnUnusedConfiguration(
  provider: string,
  configuration: unknown,
  consumedPaths: readonly string[],
  guidance: string
): void {
  const unused = findUnusedConfigurationPaths(configuration, consumedPaths);
  if (unused.length === 0) return;
  displayWarning(
    `Ignoring ${unused.map((path) => `llm.configuration.${path}`).join(', ')} — ` +
      `the "${provider}" provider does not build an OpenAI client, so a "configuration" block ` +
      `is not passed through to one. ${guidance}`
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
