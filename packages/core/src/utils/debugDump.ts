import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import { ensureGlobalGslothDir } from '#src/utils/globalConfigUtils.js';
import { getSlothVersion } from '#src/utils/systemUtils.js';
import { getDebugLogBuffer } from '#src/utils/debugUtils.js';

/**
 * GS2-46 — `/debug-dump`: a live-session diagnostic archive, written UNSANITIZED (that's GS2-47's
 * job on top of this). The user typed the command themselves, mid-session, knowingly, so the
 * caller (the slash command) is responsible for the loud "may contain secrets" warning — this
 * module only writes the files.
 */

/** Input to {@link writeDebugDump}. `transcript`/`config` are dumped as-is (raw, unsanitized). */
export interface WriteDebugDumpInput {
  /** The full transcript (all turns, tool calls + results). Opaque — serialized as JSON. */
  transcript: unknown;
  /** The resolved effective config (the live `GthConfig`). Opaque — serialized as JSON. */
  config: unknown;
  /** Model display name, already resolved by the caller. */
  modelDisplayName?: string;
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
 * Write one timestamped `/debug-dump` archive under the GLOBAL `~/.gsloth/debug-dumps/<timestamp>/`
 * (via `ensureGlobalGslothDir()` — mirrors how `resolveHistoryDbPath()` builds its path under the
 * same dir — NOT the per-project cwd-relative helper of the same name elsewhere in this codebase).
 * Contains: the full transcript, the resolved config, env/version info, the in-memory debugLog
 * ring buffer, and (best-effort) git repo state. Everything is dumped raw/unsanitized — this node
 * ships deliberately unsanitized (GS2-47 adds redaction on top later); the caller is responsible
 * for surfacing the "may contain secrets" warning to the user.
 */
export function writeDebugDump(input: WriteDebugDumpInput): WriteDebugDumpResult {
  const timestamp = debugDumpDirName();
  const archiveDir = resolve(ensureGlobalGslothDir(), 'debug-dumps', timestamp);
  mkdirSync(archiveDir, { recursive: true });

  writeFileSync(resolve(archiveDir, 'transcript.json'), safeStringify(input.transcript), 'utf8');
  writeFileSync(resolve(archiveDir, 'config.json'), safeStringify(input.config), 'utf8');

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
  writeFileSync(resolve(archiveDir, 'env.json'), safeStringify(envInfo), 'utf8');

  writeFileSync(resolve(archiveDir, 'debug-log.txt'), getDebugLogBuffer().join('\n'), 'utf8');

  const gitState = collectGitState(input.cwd ?? process.cwd());
  if (gitState) {
    writeFileSync(resolve(archiveDir, 'git-state.json'), safeStringify(gitState), 'utf8');
  }

  return { archiveDir };
}
