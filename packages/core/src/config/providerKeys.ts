/**
 * @packageDocumentation
 * The catchable error a config load raises when a provider cannot be constructed because **no API
 * key is resolvable at all** — from the config's own `llm.apiKey`, from its
 * `llm.apiKeyEnvironmentVariable`, or from any environment variable that provider accepts.
 *
 * Deliberately dependency-free (no imports beyond types) so the config barrel, the provider layer
 * and downstream consumers can all reach it without an import cycle.
 *
 * **Why this is an error object and not a process exit.** Building a chat model is a *library*
 * operation, and a library that terminates the process denies every caller the chance to classify
 * the failure. A multi-identity `gth eval` run, in particular, is designed for partial secrets: one
 * identity without a key must not stop the other identities being graded, and the run must still be
 * able to say which identity failed and why. That classification needs the provider and the
 * variable name as DATA, not as prose in a message, which is why {@link MissingProviderKeyError}
 * carries {@link MissingProviderKeyError.provider} and
 * {@link MissingProviderKeyError.envVars} as fields. Callers that legitimately want to terminate —
 * the CLI entry points — catch it at their top level, where the exit code is chosen deliberately.
 */

/** Marker property carried by every {@link MissingProviderKeyError}; see {@link isMissingProviderKeyError}. */
const MISSING_PROVIDER_KEY_MARKER = 'gthMissingProviderKey';

/**
 * What a key-resolution check knows about a provider that has no usable key.
 *
 * `envVars` lists every variable name that WOULD have supplied the key, in the order the provider
 * checks them, so a message can name the canonical one and still mention the accepted aliases. A
 * config-declared `apiKeyEnvironmentVariable` comes first when there is one, because that is the
 * name the user chose and the one they will look for.
 */
export interface MissingProviderKeyDetails {
  /** The `llm.type` of the provider that could not be constructed (e.g. `anthropic`, `groq`). */
  provider: string;
  /** The variable to set — the first of {@link envVars}, or undefined if the provider declares none. */
  envVar: string | undefined;
  /** Every environment variable this provider accepts for its key, highest precedence first. */
  envVars: readonly string[];
}

/**
 * A provider could not be built because no API key was resolvable for it.
 *
 * Thrown (never exited on) by the config loader, so `gth eval`, `gth batch`, the AG-UI/ACP servers
 * and any embedding consumer can tell "this provider had no key" apart from "this provider broke".
 */
export class MissingProviderKeyError extends Error implements MissingProviderKeyDetails {
  /** Duck-typed marker so {@link isMissingProviderKeyError} works across duplicated module copies. */
  readonly gthMissingProviderKey = true as const;
  readonly provider: string;
  readonly envVar: string | undefined;
  readonly envVars: readonly string[];

  constructor(message: string, details: MissingProviderKeyDetails, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MissingProviderKeyError';
    this.provider = details.provider;
    this.envVar = details.envVar;
    this.envVars = details.envVars;
  }

  /**
   * Serialize the machine-readable half. `JSON.stringify(error)` would otherwise drop `message`
   * (an Error's `message` is a non-enumerable own property), which is exactly the field a report
   * consumer shows a human next to the provider and the variable name.
   */
  toJSON(): { name: string; message: string } & MissingProviderKeyDetails {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      envVar: this.envVar,
      envVars: [...this.envVars],
    };
  }
}

/**
 * True when `value` is a {@link MissingProviderKeyError}.
 *
 * Duck-typed on the marker property rather than `instanceof` on purpose: a consumer that ends up
 * with two copies of `@gaunt-sloth/core` on disk (a `file:` dep, a hoisting split) would fail an
 * `instanceof` check against a genuinely-correct error and misreport a missing key as a provider
 * outage — the one distinction this error exists to make.
 */
export function isMissingProviderKeyError(value: unknown): value is MissingProviderKeyError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[MISSING_PROVIDER_KEY_MARKER] === true
  );
}
