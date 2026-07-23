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
import type { LastModelRequest } from '#src/core/debugCapture.js';

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
  /**
   * GS2-56 — the always-on snapshot of the last model request (the composed system prompt, tool
   * defs with schema, model params, tool-choice, and the AS-SENT post-summarization messages),
   * threaded straight from `agent.lastModelRequest` by the caller (both the TUI and the readline
   * `--no-tui` surface). ADDITIVE & optional: when present, `writeDebugDump` writes
   * `model-request.json` (the extras) and `model-messages.json` (the as-sent messages, distinct
   * from the conversation-view `transcript.json`), both routed through the same redaction pass as
   * every other artifact. Absent (no model call yet / a surface with no agent handle) ⇒ those two
   * files are simply omitted.
   */
  modelRequest?: LastModelRequest;
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
 * GS2-54 (gap 3) — a live LangChain chat model is detected structurally, NOT by field name: a real
 * `BaseChatModel` exposes `_llmType()` and `invoke()` as functions. This duck-type is the LOAD-BEARING
 * invariant that lets us strip a *live* model to a descriptor (below) WITHOUT also flattening a plain
 * `{ type, model, apiKey }` config object — the latter must keep flowing through {@link redactValue}'s
 * field-masking (key kept, value masked). Do NOT "simplify" this into an unconditional strip.
 */
function isLiveChatModel(llm: unknown): boolean {
  if (llm == null || typeof llm !== 'object') return false;
  const m = llm as { _llmType?: unknown; invoke?: unknown };
  return typeof m._llmType === 'function' || typeof m.invoke === 'function';
}

/**
 * GS2-54 (gap 3) — a short, secret-free descriptor for a live chat model, mirroring the spirit of
 * `configCommand.ts`'s `redactConfigForPrint`. Never returns the live object or any of its internals
 * (client instances, cached kwargs, inline keys) — only a `type` + `model` label. Each field probe
 * is guarded so a hostile/exotic getter can't throw out of here.
 */
function describeLiveModel(
  config: Record<string, unknown>,
  llm: object
): { type: string; model: string } {
  const m = llm as {
    _llmType?: () => string;
    lc_namespace?: unknown;
    model?: unknown;
    modelName?: unknown;
    constructor?: { name?: string };
  };
  let type = 'unknown';
  try {
    const t =
      (typeof m._llmType === 'function' ? m._llmType() : undefined) ??
      (Array.isArray(m.lc_namespace) ? m.lc_namespace.join('/') : undefined) ??
      (typeof (config as { type?: unknown }).type === 'string'
        ? (config as { type?: string }).type
        : undefined) ??
      m.constructor?.name;
    if (typeof t === 'string' && t.length > 0) type = t;
  } catch {
    // keep 'unknown' — a throwing getter must not defeat the strip
  }
  let model = 'unknown';
  try {
    const md = config.modelDisplayName;
    const mdl =
      (typeof md === 'string' && md.length > 0 ? md : undefined) ??
      (typeof m.model === 'string' ? m.model : undefined) ??
      (typeof m.modelName === 'string' ? m.modelName : undefined);
    if (typeof mdl === 'string' && mdl.length > 0) model = mdl;
  } catch {
    // keep 'unknown'
  }
  return { type, model };
}

/**
 * GS2-54 (gap 3) + GS2-66 (residual 3) — defense-in-depth for the CONFIG artifact: return a shallow
 * clone of `config` with the LIVE instances stripped to short descriptors so their large internal
 * surface (client objects, cached kwargs, inline keys, and non-secret-NAMED opaque fields the
 * `caCert` class that field-masking cannot catch) never reaches disk — rather than relying on
 * {@link redactValue}'s field-masking alone. Mirrors `configCommand.ts`'s `redactConfigForPrint`:
 *  - a *live* `llm` (a `BaseChatModel`) → a `{ type, model }` descriptor;
 *  - a `tools` array → `[N tool instance(s)]`;
 *  - a `middleware` array → `[N middleware]`.
 * PURE: never mutates the caller's config (a fresh clone is made only if something is stripped).
 * FAIL-SAFE: on any error, or when a field is absent / not a live instance, that field is left as-is
 * so {@link redactValue}'s existing GS2-47 masking still applies (never less-redacted). The `llm`,
 * `tools` and `middleware` strips are independent — `tools`/`middleware` are stripped even when the
 * config carries no live `llm`.
 */
function stripLiveInstancesForConfig(config: unknown): unknown {
  try {
    if (config == null || typeof config !== 'object' || Array.isArray(config)) return config;
    const record = config as Record<string, unknown>;
    // Clone lazily: only spread into a new object once we know a field is actually being replaced,
    // so a config with no live instances is returned untouched (===).
    let out: Record<string, unknown> = record;
    const clone = (): Record<string, unknown> => {
      if (out === record) out = { ...record };
      return out;
    };
    if ('llm' in record && isLiveChatModel(record.llm)) {
      clone().llm = describeLiveModel(record, record.llm as object);
    }
    // Hoist before the mutating clone() call so TS keeps the `Array` narrowing on `.length`.
    const tools = record.tools;
    if (Array.isArray(tools)) {
      clone().tools = `[${tools.length} tool instance(s)]`;
    }
    const middleware = record.middleware;
    if (Array.isArray(middleware)) {
      clone().middleware = `[${middleware.length} middleware]`;
    }
    return out;
  } catch {
    return config; // fail safe: fall back to redactValue over the untouched config
  }
}

/**
 * GS2-47 — render the CONFIG artifact: {@link redactValue} applies sensitive-field masking (keys
 * kept, values masked) plus literal/pattern string redaction, then {@link safeStringify}. Fail-safe:
 * any throw yields the fully-withheld marker rather than raw content ("redact more on error, never
 * write a raw artifact because redaction hiccuped").
 *
 * GS2-54 (gap 3) + GS2-66 (residual 3) — before redaction, {@link stripLiveInstancesForConfig} swaps
 * a live `llm` for a `{ type, model }` descriptor and the `tools`/`middleware` arrays for count
 * descriptors, so those live instances' internals never serialize. This runs on a fresh clone only;
 * the caller's config (and the {@link collectSecretValues} harvest already taken from it) is
 * untouched, so inline secrets inside those instances are still scrubbed from the OTHER artifacts.
 */
function renderConfig(config: unknown, redact: boolean, secrets: readonly string[]): string {
  if (!redact) return safeStringify(config);
  try {
    return safeStringify(redactValue(stripLiveInstancesForConfig(config), secrets));
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

  // GS2-56 — the always-on model-request snapshot: WHAT was actually fed to the model (the thing a
  // bug report needs, previously omitted whenever the TUI `/debug` panel wasn't open). Written only
  // when the caller threaded `agent.lastModelRequest` (a model call has happened), so before the
  // first turn these files are simply absent. Both go through `renderStructured` (literal+pattern
  // redaction, like transcript.json/env.json) rather than `renderConfig`'s field-masking, so a
  // legitimately `token`/`secret`-named field inside a tool result or a schema isn't blanket-masked.
  if (input.modelRequest) {
    // model-request.json — the composed system prompt + tool defs (with JSON schema) + model params
    // + tool-choice. `?? {}` keeps the artifact present-but-empty rather than serializing `undefined`.
    writeFileSync(
      resolve(archiveDir, 'model-request.json'),
      renderStructured(input.modelRequest.extras ?? {}, redact, secrets),
      'utf8'
    );
    // model-messages.json — the EXACT messages sent to the model for the last call (post-
    // summarization / middleware), i.e. what the model actually saw. Deliberately a separate
    // artifact from transcript.json (the conversation view): the two are distinct arrays.
    writeFileSync(
      resolve(archiveDir, 'model-messages.json'),
      renderStructured(input.modelRequest.messages ?? [], redact, secrets),
      'utf8'
    );
  }

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

/**
 * GS2-48 — how many trailing lines of the always-on in-memory debugLog ring buffer
 * ({@link file://./debugUtils.ts}, cap {@link DEBUG_LOG_BUFFER_MAX} = 1000) the crash snapshot keeps.
 * The buffer itself is the "always-on capture" the crash handler relies on (nothing is written to
 * disk until a crash — O(N) memory, zero steady-state I/O); the snapshot copies only this TAIL to
 * stay MINIMAL (a crash file is a triage artifact, not the full session). 200 is enough to show what
 * the agent was doing in the moments before death without bloating the file.
 */
const CRASH_DEBUG_LOG_TAIL_LINES = 200;

/** A plain, JSON-safe, enumerable projection of the failure. */
interface CrashErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/**
 * GS2-48 — flatten a thrown value (or a rejection reason, which need not be an `Error`) into a plain
 * object BEFORE redaction. `Error.message`/`Error.stack` are NON-ENUMERABLE, so `Object.entries`
 * (which {@link redactValue} walks with) would silently drop them — the crash file would carry no
 * error and no stack. Explicitly copying them here is what makes the error survive the redaction pass.
 * Tolerates a non-Error reason (string / number / object / undefined) without throwing.
 */
function normalizeError(error: unknown): CrashErrorInfo {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  try {
    return {
      name: 'NonError',
      message: typeof error === 'string' ? error : safeStringify(error),
    };
  } catch {
    return { name: 'NonError', message: String(error) };
  }
}

/** Input to {@link writeCrashSnapshot}. */
export interface WriteCrashSnapshotInput {
  /** The thrown error / rejection reason. Need not be an `Error`. */
  error: unknown;
  /** Where the failure came from — e.g. `'uncaughtException'` / `'unhandledRejection'`. */
  origin: string;
  /** The effective resolved config, if the crashing process had one registered. Opaque. */
  config?: unknown;
  /** Model display name, if known. */
  modelDisplayName?: string;
  /** The in-flight turn's transcript tail, if a session registered one. Opaque. */
  transcriptTail?: unknown;
}

export interface WriteCrashSnapshotResult {
  /** The absolute path to the crash directory just written. */
  crashDir: string;
  /** The absolute path to the `crash.json` file inside it. */
  crashFile: string;
}

/**
 * GS2-48 — write a MINIMAL, ALWAYS-REDACTED crash snapshot to
 * `~/.gsloth/debug-dumps/crash-<timestamp>/crash.json` and return its paths.
 *
 * This is the unattended sibling of {@link writeDebugDump}: it fires from the process-level crash
 * handler ({@link file://./crashHandler.ts}) with no human present, so — unlike `/debug-dump` — it
 * exposes NO `redact` opt-out. Redaction (GS2-47, hard-dep) is MANDATORY and applied to the whole
 * snapshot. It reuses this module's location convention (`ensureGlobalGslothDir()` + `debug-dumps/`)
 * and rendering helpers, but deliberately stays minimal and crash-safe:
 *  - a SINGLE `crash.json` (not the multi-file interactive archive);
 *  - it does NOT shell out for git state (a subprocess is unsafe/slow while the process is dying);
 *  - it keeps only the last {@link CRASH_DEBUG_LOG_TAIL_LINES} debugLog lines and the transcript TAIL.
 *
 * Redaction shape (conscious choice): the entire normalized snapshot is passed through
 * {@link redactValue} in one pass. That is stricter than {@link writeDebugDump}, which uses
 * {@link redactText} (literal+pattern only) for its non-config artifacts to avoid field-masking a
 * legitimately `token`/`secret`-named field in tool output. For an unattended crash file the
 * over-masking is the SAFE direction and buys uniform circular-ref / depth / function handling in
 * one place, so it is intended, not an oversight. The config subtree is stripped of live instances
 * first (as `writeDebugDump` does) so a live LLM client's internals never serialize.
 *
 * Callers wrap this in their own try/catch (see {@link file://./crashHandler.ts}); it does its best
 * to be fail-safe internally (`redactValue`/`safeStringify` never throw), but the ONE unavoidably
 * throwing operation is the `mkdirSync`/`writeFileSync` to disk — an unwritable `~/.gsloth` is what
 * the handler's degraded path is for.
 */
export function writeCrashSnapshot(input: WriteCrashSnapshotInput): WriteCrashSnapshotResult {
  const crashDir = resolve(ensureGlobalGslothDir(), 'debug-dumps', `crash-${debugDumpDirName()}`);
  mkdirSync(crashDir, { recursive: true });

  // Redaction is unconditional here (no opt-out) — gather the literal secret values to scrub from
  // env + config, exactly as writeDebugDump does. `env` is the systemUtils accessor (process.env).
  const secrets = collectSecretValues(input.config, env);

  let gthVersion: string;
  try {
    gthVersion = getSlothVersion();
  } catch {
    gthVersion = 'unknown';
  }

  const snapshot = {
    kind: 'crash',
    origin: input.origin,
    timestamp: new Date().toISOString(),
    // Flattened to plain enumerable fields so message/stack survive the redaction walk.
    error: normalizeError(input.error),
    env: {
      gthVersion,
      nodeVersion: process.version,
      platform: process.platform,
      model: input.modelDisplayName ?? 'unknown',
    },
    // Strip live LLM/tool/middleware instances to short descriptors before redaction (as the
    // interactive config artifact does), so their internals never reach disk. `?? null` so an
    // absent config serializes as an explicit `null` (JSON drops an `undefined`-valued key).
    config: stripLiveInstancesForConfig(input.config) ?? null,
    debugLogTail: getDebugLogBuffer().slice(-CRASH_DEBUG_LOG_TAIL_LINES),
    transcriptTail: input.transcriptTail ?? null,
  };

  // Single fail-safe redaction pass over the whole normalized snapshot (see doc above).
  const crashFile = resolve(crashDir, 'crash.json');
  writeFileSync(crashFile, safeStringify(redactValue(snapshot, secrets)), 'utf8');

  return { crashDir, crashFile };
}
