import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { ensureGlobalGslothDir } from '#src/utils/globalConfigUtils.js';
import { env, getSlothVersion } from '#src/utils/systemUtils.js';
import { getDebugLogBuffer } from '#src/utils/debugUtils.js';
import {
  REDACTED,
  collectSecretValues,
  redactText,
  redactValue,
} from '#src/utils/redactSecrets.js';

/**
 * GS2-46/GS2-47 — `/debug-dump`: a live-session diagnostic archive. GS2-46 shipped it raw; GS2-47
 * adds a shared secret-redaction pass ({@link file://./redactSecrets.ts}) that is ON BY DEFAULT and
 * applied to EVERY artifact before it hits disk. The caller opts out via `redact: false`, in which
 * case the archive is raw and the caller surfaces the loud "may contain secrets" warning; when
 * redaction is on the caller shows a softened "secrets redacted; review before sharing" note.
 */

/** Input to {@link writeDebugDump}. */
export interface WriteDebugDumpInput {
  /** The full transcript (all turns, tool calls + results). Opaque — serialized as JSON. */
  transcript: unknown;
  /** The resolved effective config (the live `GthConfig`). Opaque — serialized as JSON. */
  config: unknown;
  /** Model display name, already resolved by the caller. */
  modelDisplayName?: string;
  /**
   * GS2-47 — apply the shared secret-redaction pass to every artifact before writing. Defaults to
   * ON: omitted or any value other than the literal `false` redacts (read-site `!== false`, matching
   * the config default so an opt-out has to be explicit). `false` writes a RAW archive (the caller
   * is then responsible for the loud "may contain secrets" warning).
   */
  redact?: boolean;
  /**
   * Working directory for git-state collection. Defaults to `process.cwd()`; overridable for
   * tests so the "not a git repo" / "inside a git repo" paths are both exercisable without
   * depending on where the test runner happens to execute.
   */
  cwd?: string;
}

export interface WriteDebugDumpResult {
  /** The absolute path to the archive directory just written. */
  archiveDir: string;
}

interface GitState {
  branch: string;
  remote?: string;
  dirty: boolean;
}

/**
 * Best-effort git repo state (branch/remote/dirty). Uses `execFileSync` — NOT the existing
 * `execAsync` helper in systemUtils.ts (a promisified wrapper used elsewhere for `gh` calls) —
 * because `SlashCommand.run()` is fully synchronous (no Promise support in the TUI's registry or
 * dispatcher). Fails soft: any failure (not inside a repo, `git` missing, a detached/bare repo
 * with no remote, etc.) returns `undefined` rather than throwing, so the command never errors —
 * the git-state file is simply omitted from the archive.
 */
function collectGitState(cwd: string): GitState | undefined {
  try {
    const run = (args: string[]): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);

    let remote: string | undefined;
    try {
      remote = run(['remote', 'get-url', 'origin']);
    } catch {
      remote = undefined; // no `origin` remote configured — not fatal, just omit it
    }

    const status = run(['status', '--porcelain']);
    return { branch, remote, dirty: status.length > 0 };
  } catch {
    return undefined; // not inside a git repo (or git unavailable) — omit the file entirely
  }
}

/**
 * Serialize a value as pretty JSON, tolerating the non-JSON-safe shapes real session state can
 * contain (e.g. the resolved `GthConfig.llm` is a live LangChain client, not plain data):
 * functions/bigints are stringified and circular references are broken rather than throwing.
 * Falls back to `util.inspect` if `JSON.stringify` still fails for some other reason, so writing
 * the dump can never throw partway through the archive.
 *
 * QA-6: `JSON.stringify` returns `undefined` (not a string) for a handful of top-level inputs —
 * notably `undefined` itself, which `DebugDumpInput.config` legitimately is when the caller has
 * no resolved config (verified live via the e2e fixture harness, which wires the real writer with
 * `config` omitted). Passing `undefined` straight to `writeFileSync` throws
 * `ERR_INVALID_ARG_TYPE`, defeating the "never throw partway through the archive" contract this
 * function documents. Fall back to the literal `'null'` in that case, same as `JSON.stringify`
 * would for a *nested* `undefined` value.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`;
        if (typeof val === 'bigint') return val.toString();
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        return val;
      },
      2
    );
    return json ?? 'null';
  } catch {
    return inspect(value, { showHidden: false, depth: 5, colors: false });
  }
}

/**
 * The filesystem-safe directory-name segment for one dump: the ISO timestamp with `:` and `.`
 * (illegal on Windows, noisy everywhere) replaced by `-`. This is the ONLY path component
 * debugDump generates — and the only one it is responsible for sanitizing. The parent it is joined
 * under (the global `~/.gsloth` dir) is supplied by the environment and may legitimately carry a
 * drive-letter colon on Windows (`C:\…`), which is not ours to strip. Exported so the invariant
 * "the generated segment is colon-free" is testable on any platform without asserting anything
 * about the (platform-dependent) parent path (GS2-50).
 */
export function debugDumpDirName(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * GS2-47 — render the CONFIG artifact: {@link redactValue} applies sensitive-field masking (keys
 * kept, values masked) plus literal/pattern string redaction, then {@link safeStringify}. Fail-safe:
 * any throw yields the fully-withheld marker rather than raw content ("redact more on error, never
 * write a raw artifact because redaction hiccuped").
 */
function renderConfig(config: unknown, redact: boolean, secrets: readonly string[]): string {
  if (!redact) return safeStringify(config);
  try {
    return safeStringify(redactValue(config, secrets));
  } catch {
    return REDACTED;
  }
}

/**
 * GS2-47 — render a non-config STRUCTURED artifact (transcript, env, git-state): stringify (never
 * throws), then literal/pattern-redact the text. Structural field-masking is intentionally NOT
 * applied here (config-only, per the brief) so a legitimately `token`/`secret`-named field in tool
 * output is not blanket-masked. {@link redactText} is itself fail-safe.
 */
function renderStructured(value: unknown, redact: boolean, secrets: readonly string[]): string {
  const raw = safeStringify(value);
  return redact ? redactText(raw, secrets) : raw;
}

/**
 * Write one timestamped `/debug-dump` archive under the GLOBAL `~/.gsloth/debug-dumps/<timestamp>/`
 * (via `ensureGlobalGslothDir()` — mirrors how `resolveHistoryDbPath()` builds its path under the
 * same dir — NOT the per-project cwd-relative helper of the same name elsewhere in this codebase).
 * Contains: the full transcript, the resolved config, env/version info, the in-memory debugLog
 * ring buffer, and (best-effort) git repo state.
 *
 * GS2-47 — unless `input.redact === false`, the shared secret-redaction pass
 * ({@link file://./redactSecrets.ts}) is applied to EVERY artifact before it is written: the literal
 * values of secret-named env vars + inline config secrets are substituted everywhere, a tight set of
 * provider-key/auth-header patterns is masked, and the config's sensitive fields are masked in place.
 * On opt-out the archive is raw and the caller surfaces the loud "may contain secrets" warning.
 */
export function writeDebugDump(input: WriteDebugDumpInput): WriteDebugDumpResult {
  const redact = input.redact !== false; // default ON; only an explicit `false` opts out
  const timestamp = debugDumpDirName();
  const archiveDir = resolve(ensureGlobalGslothDir(), 'debug-dumps', timestamp);
  mkdirSync(archiveDir, { recursive: true });

  // Technique 1 (load-bearing): the literal secret values to scrub across ALL artifacts, gathered
  // from env (by secret-named var) + the config (apiKeyEnvironmentVariable's target + inline
  // secrets). `env` is the systemUtils accessor (process.env); collection is itself fail-safe.
  const secrets = redact ? collectSecretValues(input.config, env) : [];

  writeFileSync(
    resolve(archiveDir, 'transcript.json'),
    renderStructured(input.transcript, redact, secrets),
    'utf8'
  );
  writeFileSync(
    resolve(archiveDir, 'config.json'),
    renderConfig(input.config, redact, secrets),
    'utf8'
  );

  // getSlothVersion() reads the installed package.json via the install dir set at CLI startup
  // (setEntryPoint); guarded so a dump can never fail just because that wasn't wired (e.g. an
  // unusual embedding), falling back to 'unknown'.
  let gthVersion: string;
  try {
    gthVersion = getSlothVersion();
  } catch {
    gthVersion = 'unknown';
  }
  const envInfo = {
    gthVersion,
    nodeVersion: process.version,
    platform: process.platform,
    model: input.modelDisplayName ?? 'unknown',
  };
  writeFileSync(
    resolve(archiveDir, 'env.json'),
    renderStructured(envInfo, redact, secrets),
    'utf8'
  );

  writeFileSync(
    resolve(archiveDir, 'debug-log.txt'),
    redact ? redactText(getDebugLogBuffer().join('\n'), secrets) : getDebugLogBuffer().join('\n'),
    'utf8'
  );

  const gitState = collectGitState(input.cwd ?? process.cwd());
  if (gitState) {
    writeFileSync(
      resolve(archiveDir, 'git-state.json'),
      renderStructured(gitState, redact, secrets),
      'utf8'
    );
  }

  return { archiveDir };
}
