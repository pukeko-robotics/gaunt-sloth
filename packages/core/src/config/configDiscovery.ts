/**
 * @packageDocumentation
 * The catchable error a config **load** raises when the configuration itself cannot be used. The
 * cases, all one class on purpose:
 *
 * - an explicitly-named identity profile (or an `extends` base) that resolves to no config;
 * - a `--config` path that does not exist;
 * - a config layer present but malformed — a removed pre-2.0 shape, a bad approvals rule grammar,
 *   a schema mismatch, an unresolvable `approvals.rater`;
 * - a config that read fine but names no usable model — no `llm` block, no `llm.type`, an
 *   `llm.type` with no provider module, or a provider module that cannot build from a JSON spec;
 * - a provider instance that could not be constructed for a reason other than a missing API key
 *   (that one is {@link MissingProviderKeyError}, which carries the key details);
 * - no configuration file anywhere at all.
 *
 * Deliberately dependency-free (no imports beyond types) so the config barrel, the loader and
 * downstream consumers can all reach it without an import cycle — the same shape
 * `providerKeys.ts` uses for {@link MissingProviderKeyError}.
 *
 * **Why this is an error object and not a process exit.** Loading configuration is a *library*
 * operation, and a library that terminates the process denies every caller the chance to classify
 * the failure. `gth eval` in particular distinguishes a **harness** error (exit 2 — the suite could
 * not be evaluated) from a **product** failure (exit 1 — the SUT ran and failed); a `process.exit(1)`
 * inside config discovery collapses that contract, reporting a typo in `--judge` exactly as it
 * reports a genuine regression. Callers that legitimately want to terminate — the CLI entry points —
 * catch it at their top level, where the exit code is chosen deliberately.
 *
 * One class covers every case above on purpose: no caller needs to tell them apart (all of them mean
 * "this configuration cannot be used"), and the fields carry whichever detail applies. Sub-classing
 * per case would only push the callers back to the marker-list problem this class exists to end —
 * a consumer that wants the underlying failure reads `cause`.
 */

/** Marker property carried by every {@link ConfigDiscoveryError}; see {@link isConfigDiscoveryError}. */
const CONFIG_DISCOVERY_MARKER = 'gthConfigDiscoveryError';

/** What a config load knows about the configuration it could not use. */
export interface ConfigDiscoveryDetails {
  /**
   * The explicitly-requested identity profile that did not resolve, when that is the failure.
   * Undefined for a malformed-config failure, which is about a file rather than a profile name.
   */
  identityProfile?: string | undefined;
  /**
   * Human-readable source of the offending config layer (e.g. `.gsloth.config.json`,
   * `.gsloth.config.json (global)`, `<name> (extends base)`), when a layer was read and rejected.
   */
  sourceLabel?: string | undefined;
}

/**
 * A configuration could not be used: a named identity profile has no config, or a config layer is
 * malformed.
 *
 * Thrown (never exited on) by the config loader, so `gth eval`, `gth batch`, the AG-UI/ACP servers
 * and any embedding consumer can classify the failure and choose their own exit code.
 */
export class ConfigDiscoveryError extends Error implements ConfigDiscoveryDetails {
  /** Duck-typed marker so {@link isConfigDiscoveryError} works across duplicated module copies. */
  readonly gthConfigDiscoveryError = true as const;
  readonly identityProfile: string | undefined;
  readonly sourceLabel: string | undefined;

  constructor(
    message: string,
    details: ConfigDiscoveryDetails = {},
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ConfigDiscoveryError';
    this.identityProfile = details.identityProfile;
    this.sourceLabel = details.sourceLabel;
  }

  /**
   * Serialize the machine-readable half. `JSON.stringify(error)` would otherwise drop `message`
   * (an Error's `message` is a non-enumerable own property), which is exactly the field a report
   * consumer shows a human next to the profile or the file that failed.
   */
  toJSON(): { name: string; message: string } & ConfigDiscoveryDetails {
    return {
      name: this.name,
      message: this.message,
      identityProfile: this.identityProfile,
      sourceLabel: this.sourceLabel,
    };
  }
}

/**
 * True when `value` is a {@link ConfigDiscoveryError}.
 *
 * Duck-typed on the marker property rather than `instanceof` on purpose: a consumer that ends up
 * with two copies of `@gaunt-sloth/core` on disk (a `file:` dep, a hoisting split) would fail an
 * `instanceof` check against a genuinely-correct error and mis-handle a config failure as an
 * unexpected crash — exactly the distinction this error exists to make.
 */
export function isConfigDiscoveryError(value: unknown): value is ConfigDiscoveryError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[CONFIG_DISCOVERY_MARKER] === true
  );
}
