/**
 * @packageDocumentation
 * GS2-47 — a shared, reusable secret-redaction pass for diagnostic output.
 *
 * Built for `/debug-dump` ({@link file://./debugDump.ts}) but deliberately generic and
 * dependency-free — it takes `env` as a PARAMETER rather than reading `process.env`, so the pass is
 * pure, deterministic in tests, and reusable by GS2-48's crash-report handler (which hard-depends on
 * this module). Nothing here reads ambient process state.
 *
 * DESIGN DECISION (settled by the coordinator, GS2-47): **PATTERN-ONLY** redaction — we do NOT scan
 * for high-entropy strings. Rationale: pattern-only is safe to reason about and near-zero
 * false-positive; entropy scanning catches marginally more but produces false-positive redactions
 * the user has to squint through, degrading the dump's debug value. A high-entropy scanner is a
 * DELIBERATELY-DEFERRED option (a config surface for it could be added later if ever warranted) and
 * is intentionally NOT implemented here.
 *
 * Three techniques, in priority order:
 *  1. [load-bearing] Known-secret VALUE substitution — collect the literal values of secret-named
 *     env vars + inline config secrets, then substitute every occurrence across ALL artifacts. This
 *     catches a leaked key wherever it surfaces (config, env, transcript, log) with no guessing.
 *  2. Provider key/token PATTERNS — a tight, documented, prefix-anchored set of well-known key
 *     shapes plus explicit auth-header contexts. We never blanket-redact long alphanumeric strings.
 *  3. Sensitive config-FIELD masking — mask the VALUES of secret-named config keys while preserving
 *     structure (the key stays; only the value becomes the marker).
 *
 * Fail-safe throughout: on any internal error the functions redact MORE (return the marker), never
 * less — a redaction hiccup must never cause raw content to be emitted.
 */

/** The visible, greppable placeholder substituted for every redacted secret value. */
export const REDACTED = '<redacted>';

/**
 * Minimum length for a collected VALUE to be treated as a substitutable secret literal (technique
 * 1). Guards against redacting trivial values ("1", "on", a short model name) that happen to be the
 * value of a secret-named env var — substituting those everywhere would gut the dump's debug value
 * with false positives (exactly the trap the pattern-only decision avoids). Short sensitive *config*
 * fields are still masked structurally by key name (technique 3), so nothing sensitive slips through
 * this floor.
 */
const MIN_SECRET_LITERAL_LENGTH = 6;

/** Max recursion depth for the config walks — a guard against pathological/deep object graphs. */
const MAX_REDACT_DEPTH = 12;

/**
 * env-var NAME shapes whose VALUE is a secret to substitute everywhere (technique 1): `*_API_KEY`,
 * `*_TOKEN`, `*_SECRET`, `*_KEY`, and anything containing `PASSWORD`. Case-insensitive.
 */
const SECRET_ENV_NAME_RE = /(?:_API_KEY|_TOKEN|_SECRET|_KEY)$|PASSWORD/i;

/**
 * Config-FIELD NAME shapes whose VALUE is masked in place (technique 3), matched case-insensitively
 * at any depth. Mirrors `configCommand.ts`'s `redactConfigForPrint` set for cross-surface
 * consistency. NOTE: `apiKeyEnvironmentVariable` also matches `api?key`, but it holds a var NAME
 * (not a secret) and is what technique 1 reads to find the real key's value — so it is EXCLUDED via
 * {@link NON_SECRET_KEY_NAMES}.
 */
const SECRET_KEY_RE = /(api[-_]?key|secret|token|password|passwd|authorization|bearer|credential)/i;

/** Field names that match {@link SECRET_KEY_RE} but must NOT be masked (they hold a var name). */
const NON_SECRET_KEY_NAMES = new Set(['apikeyenvironmentvariable']);

/**
 * Provider key / auth-header PATTERNS (technique 2) — a tight, prefix-anchored set. Each entry is
 * `[regex, replacement]`. Kept deliberately narrow (well-known key prefixes + explicit auth
 * contexts); we do NOT blanket-redact long alphanumeric strings — that IS the entropy trap the
 * pattern-only decision avoids. A long opaque token is only redacted when it sits in an auth context
 * (`Bearer …` / `Authorization: …`), never on its own.
 */
const PROVIDER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // OpenAI (`sk-…`) and Anthropic (`sk-ant-…`, also `sk-`-prefixed) secret keys.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Google API keys (`AIza…`).
  [/\bAIza[0-9A-Za-z_-]{16,}/g, REDACTED],
  // xAI (`xai-…`).
  [/\bxai-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Groq (`gsk_…`).
  [/\bgsk_[A-Za-z0-9_-]{16,}/g, REDACTED],
  // GS2-54 (gap 2) — GitHub tokens. Classic/scoped PATs share the `gh[oprsu]_` prefix (personal
  // `ghp_`, OAuth `gho_`, user-to-server `ghu_`, server-to-server `ghs_`, refresh `ghr_`); the value
  // is base62 (no `_`). Prefix-anchored + a length floor, same tight style as the provider keys —
  // NOT a blanket long-alphanumeric redaction (that IS the entropy trap avoided).
  [/\bgh[oprsu]_[A-Za-z0-9]{16,}/g, REDACTED],
  // GS2-54 (gap 2) — GitHub fine-grained PATs (`github_pat_…`); the value carries an inner `_`, so
  // its charset includes `_`. Distinct prefix from the classic rule above (`github_` ≠ `gh[oprsu]_`).
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REDACTED],
  // GS2-54 (gap 2) — credentials embedded in a URL (`scheme://user:password@host`). Redact the
  // `user:password` userinfo, KEEP the scheme + host so the artifact stays debuggable. Bounded: the
  // userinfo stops at `@` (and the password never spans `/` or whitespace), so it cannot swallow the
  // rest of the URL/line. A URL without userinfo (`https://host:port/path`) has no `user:pass@` and
  // is left untouched.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // GS2-54 (gap 1) — an `Authorization` header value (`Authorization: <scheme?> <credential>` /
  // `"Authorization":"…"`): keep the header name + separator, redact the value REGARDLESS OF SCHEME.
  // Generalized beyond the old fixed `Bearer|Basic|Token|Digest|Negotiate` list so a non-standard
  // scheme (`ApiKey <secret>`, an unknown scheme, `AWS4-HMAC-SHA256 Credential=…`) no longer leaks
  // its token beside the marker. Bounded to <scheme> + ONE credential token (two token runs max,
  // separated by horizontal whitespace only — never a newline), so it can never swallow following
  // prose the way the original `[^"]+` did. An optional value-quote is consumed so JSON
  // `"Authorization":"…"` works too. Runs before the SigV4 and standalone-`Bearer` rules so a normal
  // header collapses to a single marker; a SigV4 header's `Credential=…` is eaten here and its
  // trailing `Signature=…` is mopped up by the next rule.
  [
    /(\bAuthorization["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]+(?:[ \t]+[A-Za-z0-9._~+/=-]+)?/gi,
    `$1${REDACTED}`,
  ],
  // GS2-54 (gap 1) — AWS SigV4 authorization components. The header is comma-separated `key=value`
  // pairs; redact the SENSITIVE `Credential=…` (access-key id) and `Signature=…` values wherever they
  // appear (header value OR a presigned-URL `X-Amz-Credential=…&X-Amz-Signature=…` query), keeping the
  // key name for debuggability. `SignedHeaders=…` is just header names and is intentionally NOT
  // touched. The value charset excludes whitespace/comma/quote/`&`, so it stops at the component
  // boundary and never swallows the next pair or trailing prose.
  [/\b(Credential|Signature)=[A-Za-z0-9._~+/=-]+/gi, `$1=${REDACTED}`],
  // A standalone `Bearer <token>` — keep the scheme word, redact only the credential. A long opaque
  // token is redacted ONLY in this auth context, never on its own (that is the entropy trap avoided).
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
];

/**
 * Collect the literal secret VALUES to substitute everywhere (technique 1), from two sources:
 *  - process-env vars whose NAME matches {@link SECRET_ENV_NAME_RE}, PLUS the specific var(s) named
 *    by any `apiKeyEnvironmentVariable` in the config;
 *  - non-empty inline secret field values in the config (technique 3's field names), so a key pasted
 *    inline is scrubbed wherever it *also* surfaces (transcript, log, env), not only in config.json.
 *
 * `env` is a PARAMETER — never read ambiently — so the pass is pure, reusable (GS2-48) and
 * deterministic in tests. Values shorter than {@link MIN_SECRET_LITERAL_LENGTH} are skipped. The
 * result is returned longest-first so an overlapping-substring secret can't leave a shorter one
 * partially intact. Never throws (a hostile config getter is swallowed — patterns + structural
 * masking still apply).
 */
export function collectSecretValues(
  config: unknown,
  env: Record<string, string | undefined>
): string[] {
  const values = new Set<string>();

  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.length >= MIN_SECRET_LITERAL_LENGTH) values.add(v);
  };

  // (a) env vars whose NAME looks secret → their VALUE is a literal to scrub.
  try {
    for (const [name, value] of Object.entries(env ?? {})) {
      if (SECRET_ENV_NAME_RE.test(name)) add(value);
    }
  } catch {
    // ignore — a broken env object is not fatal to redaction.
  }

  // (b) walk the config for `apiKeyEnvironmentVariable` (→ read that env var's value) and inline
  //     secret-named field values.
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > MAX_REDACT_DEPTH) return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase() === 'apikeyenvironmentvariable' && typeof value === 'string') {
        add(env?.[value]); // resolve the NAMED env var's VALUE (the var name itself is not a secret)
      } else if (SECRET_KEY_RE.test(key) && !NON_SECRET_KEY_NAMES.has(key.toLowerCase())) {
        add(value);
      }
      walk(value, depth + 1);
    }
  };
  try {
    walk(config, 0);
  } catch {
    // fail safe: a hostile getter threw — we simply have fewer literals; patterns + structural
    // masking still cover the artifacts. Never rethrow (redaction must not break the dump).
  }

  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Redact a STRING: substitute every known literal secret value (technique 1, longest-first), then
 * apply the provider key/auth patterns (technique 2). Never throws — on any error it returns the
 * fully-withheld marker (fail safe: redact MORE, never emit the raw text). Applying it twice is
 * safe (re-redacting already-redacted text is a no-op).
 */
export function redactText(text: string, secrets: readonly string[]): string {
  try {
    let out = text;
    for (const secret of secrets) {
      if (secret) out = out.split(secret).join(REDACTED); // literal — no regex escaping needed
    }
    for (const [re, replacement] of PROVIDER_PATTERNS) {
      out = out.replace(re, replacement);
    }
    return out;
  } catch {
    return REDACTED; // fail safe
  }
}

/**
 * Deep-redact an arbitrary value for serialization: mask the VALUES of secret-named fields
 * (technique 3 — structure preserved: the key stays, only its value becomes the marker) and run
 * {@link redactText} over every string leaf (techniques 1 + 2). Circular refs are broken; functions
 * and bigints are rendered the way `safeStringify` would, so the result is JSON-safe. Pure — never
 * mutates the input. `apiKeyEnvironmentVariable` is intentionally NOT masked (it is a var name).
 *
 * Intended for the CONFIG artifact (where field-name masking is wanted). Non-config artifacts use
 * {@link redactText} over their stringified form instead (literal + pattern only), so a legitimate
 * `token`/`secret`-named field in tool output is not blanket-masked.
 */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return redactText(node, secrets);
    if (typeof node === 'function')
      return `[Function: ${(node as { name?: string }).name || 'anonymous'}]`;
    if (typeof node === 'bigint') return node.toString();
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node as object)) return '[Circular]';
    if (depth > MAX_REDACT_DEPTH) return '[Truncated]';
    seen.add(node as object);
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(key) && !NON_SECRET_KEY_NAMES.has(key.toLowerCase())) {
        out[key] = REDACTED; // mask the value, keep the key — shape is part of the debug signal
      } else {
        out[key] = walk(val, depth + 1);
      }
    }
    return out;
  };
  return walk(value, 0);
}
