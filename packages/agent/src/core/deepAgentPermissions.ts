import type { BackendProtocolV2, FilesystemPermission } from 'deepagents';
import { realpathSync } from 'node:fs';
import { realpath as realpathAsync } from 'node:fs/promises';
import path from 'node:path';
import { getCurrentWorkDir } from '@gaunt-sloth/core/utils/systemUtils.js';

export type { FilesystemPermission };

/**
 * Tool names deepagents' filesystem middleware registers. This mirrors deepagents'
 * internal `FILESYSTEM_TOOL_NAMES` (which is declared in its types but not exported
 * at runtime). `createDeepAgent` throws on a name collision with any of these, so a
 * gsloth-supplied tool sharing one of these names is superseded by the deep agent's
 * built-in filesystem tool. Kept here as the single place the deep path references it.
 */
export const FILESYSTEM_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'execute',
] as const;

/** The slice of GthConfig the permission mapping consumes. */
export interface PermissionConfigSlice {
  filesystem: string[] | 'all' | 'read' | 'none';
  aiignore?: { enabled?: boolean; patterns?: string[] };
  /**
   * Extra real filesystem roots to allow (`gth exec --allow-dir`). When present, the backend runs
   * WITHOUT virtualMode, so permission paths are real absolute paths: access is allow-listed to
   * cwd + these dirs and everything else is denied. Undefined/empty keeps the cwd-only sandbox.
   */
  allowDirs?: string[];
}

/**
 * Compute the real absolute containment root(s) for a real-path (non-virtual) sandbox: cwd plus
 * each of `dirs` resolved against cwd, de-duped (e.g. a dir that resolves back to cwd). Shared by
 * {@link allowDirsToPermissions} (turns these into glob allow-rules) and
 * {@link guardFilesystemBackend} (EXT-14: uses them as the realpath containment boundary — the
 * SAME roots the lexical globs are anchored at, so the two checks agree on what "contained"
 * means).
 */
function computeSandboxRoots(cwd: string, dirs: string[] = []): string[] {
  return Array.from(new Set([cwd, ...dirs.map((d) => path.resolve(cwd, d))]));
}

/**
 * Build allow+deny rules for the widened (`--allow-dir`) sandbox. Because the backend runs
 * without virtualMode, paths are REAL absolute paths, so we anchor allow rules at the resolved
 * absolute cwd and each allowed dir, then deny everything else. First-match-wins, so the allow
 * rules must come before the catch-all deny.
 */
export function allowDirsToPermissions(allowDirs: string[]): FilesystemPermission[] {
  const cwd = getCurrentWorkDir();
  const uniqueRoots = computeSandboxRoots(cwd, allowDirs);
  const allow: FilesystemPermission[] = uniqueRoots.map((root) => ({
    operations: ['read', 'write'],
    paths: [`${root}/**`, root],
    mode: 'allow',
  }));
  return [...allow, { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];
}

/**
 * Strip a single leading "./" or "/" and any trailing slashes, using linear string
 * ops rather than regex. The previous `/\/+$/` trailing-slash regex was flagged by
 * CodeQL as a polynomial ReDoS (the `$` anchor makes the greedy `\/+` retry from every
 * start position → quadratic on a long run of slashes); plain slicing is O(n) and safe.
 */
function normalizePathFragment(p: string): string {
  let start = 0;
  if (p.startsWith('./')) start = 2;
  else if (p.startsWith('/')) start = 1;
  let end = p.length;
  while (end > start && p[end - 1] === '/') end--;
  return p.slice(start, end);
}

/**
 * Convert `.aiignore` patterns (relative, .gitignore-ish) into deepagents deny rules.
 *
 * deepagents matches the path argument the model passes to a fs tool against ABSOLUTE
 * globs. EXT-13: the backend now runs WITHOUT virtualMode in both the default and widened
 * cases, so paths are REAL absolute paths and the caller passes the absolute cwd as `base`
 * to anchor these deny rules there.
 *
 * A bare pattern (`*.env`, `secret.txt`) should match at any depth, so we emit both a
 * top-level (`<base>/secret.txt`) and a recursive (`<base>/&#42;&#42;/secret.txt`) rule. A pattern
 * already containing "/" (`config/secrets.json`) is anchored as-is (plus a `/**` subtree rule).
 *
 * `base` defaults to "" (anchoring at the virtual root "/") for legacy callers; gsloth's
 * {@link buildPermissions} always passes the absolute cwd now.
 */
export function aiignoreToPermissions(patterns: string[], base = ''): FilesystemPermission[] {
  const rules: FilesystemPermission[] = [];
  for (const raw of patterns) {
    const clean = normalizePathFragment(raw);
    if (clean.length === 0) continue;
    const paths = clean.includes('/')
      ? [`${base}/${clean}`, `${base}/${clean}/**`]
      : [`${base}/${clean}`, `${base}/**/${clean}`];
    rules.push({ operations: ['read', 'write'], paths, mode: 'deny' });
  }
  return rules;
}

/**
 * Map gsloth's filesystem mode onto deepagents permission rules for the DEFAULT
 * (non-widen) code-mode sandbox.
 *
 * EXT-13: the default backend now runs WITHOUT virtualMode (real absolute paths), so
 * containment can no longer lean on the virtual-root chroot — it is enforced entirely by
 * these globs anchored at the REAL absolute cwd. We therefore allow read+write within
 * `cwd/**` (and `cwd`) and deny everything else (`/**`), mirroring what virtualMode gave
 * for free. An explicit `string[]` allow-list resolves each entry against the real cwd.
 *
 * - `all`  → no extra restriction beyond the cwd sandbox (matches the old virtualMode
 *            behavior, where `/` already meant cwd).
 * - `read` → deny all writes (the cwd sandbox still applies for reads).
 * - `none` → deny all reads and writes.
 * - `string[]` → allow each (cwd-resolved) dir, deny everything else.
 *
 * The `cwd` argument is injected (defaults to {@link getCurrentWorkDir}) so callers/tests
 * can anchor deterministically.
 */
export function filesystemModeToPermissions(
  fs: string[] | 'all' | 'read' | 'none',
  cwd: string = getCurrentWorkDir(),
  virtual = false
): FilesystemPermission[] {
  // EXT-16: on Windows the real cwd (`D:\...`) cannot be expressed as a deepagents
  // permission glob — its `validatePath` requires POSIX `/`-rooted paths — so the backend
  // runs in virtualMode and these rules anchor at the virtual root `/` (= cwd) instead of
  // the real absolute cwd. On POSIX, `virtual` is false and this is the EXT-13 real-path
  // sandbox unchanged. `rootGlob`/`rootPath` = "everything under the sandbox root".
  const rootGlob = virtual ? '/**' : `${cwd}/**`;
  const rootPath = virtual ? '/' : cwd;

  if (fs === 'none') return [{ operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];
  if (fs === 'read') {
    // Deny all writes everywhere; reads are still confined to the cwd sandbox below.
    return [
      { operations: ['write'], paths: ['/**'], mode: 'deny' },
      { operations: ['read'], paths: [rootGlob, rootPath], mode: 'allow' },
      { operations: ['read'], paths: ['/**'], mode: 'deny' },
    ];
  }
  if (fs === 'all') {
    // No allow-list restriction, but the cwd sandbox must still apply by default
    // (allow cwd/**, deny /**) — this is what virtualMode enforced implicitly.
    return [
      { operations: ['read', 'write'], paths: [rootGlob, rootPath], mode: 'allow' },
      { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
    ];
  }
  // string[] — explicit allow-list of directories. Real mode resolves each against the REAL
  // cwd; virtual mode anchors each under the virtual root `/`. Allow read+write within each,
  // deny everything else. Allow rules first (first-match-wins), deny catch-all last.
  const allow: FilesystemPermission[] = fs
    .filter((d) => d !== 'all' && d !== 'read')
    .map((d) => {
      const frag = normalizePathFragment(d);
      const dir = virtual ? `/${frag}` : path.resolve(cwd, frag);
      return { operations: ['read', 'write'], paths: [`${dir}/**`, dir], mode: 'allow' };
    });
  return [...allow, { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' }];
}

/**
 * Compose the full permission list. `.aiignore` deny rules go FIRST so they win over
 * any allow rule (first-match-wins). Then the filesystem-mode rules. `.aiignore` is
 * skipped when explicitly disabled (`aiignore.enabled === false`) or has no patterns.
 */
export function buildPermissions(
  config: PermissionConfigSlice,
  virtual = false
): FilesystemPermission[] {
  const cwd = getCurrentWorkDir();
  const widen = Array.isArray(config.allowDirs) && config.allowDirs.length > 0;
  const aiignoreEnabled = config.aiignore?.enabled !== false && !!config.aiignore?.patterns?.length;
  // EXT-13/EXT-16: real mode anchors aiignore deny rules at the absolute cwd; virtual mode
  // (Windows) anchors them at the virtual root ("" → "/"). Either way they keep matching the
  // project-relative ignore patterns.
  const base = virtual ? '' : cwd;
  const aiignore = aiignoreEnabled ? aiignoreToPermissions(config.aiignore!.patterns!, base) : [];
  // `--allow-dir` widens to the cwd + allowed-dirs allow-list, which needs REAL absolute paths
  // and so cannot apply in virtualMode (EXT-16): when virtual, fall back to the cwd-only mode
  // sandbox (the caller warns that widening is limited on this platform).
  const modeRules =
    widen && !virtual
      ? allowDirsToPermissions(config.allowDirs!)
      : filesystemModeToPermissions(config.filesystem, cwd, virtual);
  return [...aiignore, ...modeRules];
}

/**
 * EXT-14: which fs operation a guarded backend method enforces, for the denial message.
 */
type GuardOperation = 'read' | 'write';

/**
 * Resolve `absPath` to its real, symlink-free location, walking up to the nearest EXISTING
 * ancestor when the target itself doesn't exist yet (e.g. a `write_file` target about to be
 * created). Only an EXISTING path component can itself be — or sit behind — a symlink, so
 * resolving the nearest real ancestor is enough to catch an intermediate symlinked directory
 * that would steer a not-yet-existing write outside the sandbox. Terminates because
 * `path.dirname` strictly shortens the path until it reaches the filesystem root.
 */
async function realpathNearestExisting(absPath: string): Promise<string> {
  let current = absPath;
  for (;;) {
    try {
      return await realpathAsync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current; // filesystem root; nothing left to resolve
      current = parent;
    }
  }
}

/** True when `resolved` equals one of `roots` or is a descendant of one. */
function isWithinRoots(resolved: string, roots: string[]): boolean {
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

/** Options for {@link guardFilesystemBackend}. */
export interface RealpathGuardOptions {
  /** Real absolute cwd the sandbox is rooted at. Defaults to {@link getCurrentWorkDir}. */
  cwd?: string;
  /**
   * True when the wrapped backend runs in virtualMode (EXT-16 Windows fallback): the
   * model-supplied path is a `/`-rooted VIRTUAL path relative to cwd, not a real OS path.
   * `--allow-dir` widening never applies in virtualMode (mirrors {@link buildPermissions}), so
   * `allowDirs` is ignored when this is true.
   */
  virtual?: boolean;
  /** Extra real absolute directories allowed beyond cwd (the `--allow-dir` widened roots). */
  allowDirs?: string[];
}

/**
 * Wrap a deepagents filesystem backend so every read/write/edit/ls/glob/grep call is additionally
 * checked for a REALPATH (symlink-resolved) escape from the sandbox root(s) — closes EXT-14.
 *
 * deepagents' own permission layer (`enforcePermission` → `validatePath` → `decidePathAccess`,
 * `permissions/enforce.ts`) matches the RAW model-supplied path against the allow/deny globs and
 * never resolves symlinks. A raw `..`/`~` is rejected by `validatePath`, and a FINAL-component
 * symlink is blocked by the backend's own `O_NOFOLLOW` read — but an INTERMEDIATE symlinked
 * directory inside cwd whose target is OUTSIDE cwd (`cwd/linkdir -> /outside`, then reading
 * `cwd/linkdir/secret.txt`) matches the lexical `allow cwd/**` rule and reaches outside the
 * sandbox. See `deepAgentRealPathSandbox.spec.ts` for the end-to-end proof.
 *
 * This wraps the BACKEND — rather than adding a `wrapToolCall` middleware — because it is the ONE
 * seam gsloth fully controls that also covers subagents: `createDeepAgent` builds a fresh
 * `createFilesystemMiddleware({ backend, permissions })` per subagent (and for the main agent)
 * from the SAME `backend` reference, but each subagent gets its OWN middleware array that does
 * NOT include gsloth's `middleware` param — so a `wrapToolCall` guard would only cover the
 * top-level agent's tool calls, not a subagent's. Wrapping the shared backend closes the gap for
 * both.
 *
 * Deliberately does NOT re-implement deepagents' glob/permission matching (aiignore, read-only
 * mode, etc. all stay correctly enforced, unchanged, by the existing lexical checks inside the
 * wrapped backend's tools) — this is a second, independent containment gate layered in front of
 * them. TOCTOU: the realpath resolution here and the real fs op that follows inside the wrapped
 * backend are not atomic; racing a symlink swap in that small window is an accepted risk (out of
 * scope — this closes the deterministic, non-racing escape described above).
 */
export function guardFilesystemBackend(
  backend: BackendProtocolV2,
  options: RealpathGuardOptions = {}
): BackendProtocolV2 {
  const cwd = options.cwd ?? getCurrentWorkDir();
  const virtual = options.virtual ?? false;
  // allowDirs never widens virtualMode (mirrors buildPermissions); real mode's roots are cwd plus
  // each configured extra real dir. Resolved via realpath ONCE at wrap time (not per call) so a
  // symlinked tmp root (e.g. macOS `/tmp` -> `/private/tmp`) doesn't itself look like an escape.
  const rawRoots = virtual ? [cwd] : computeSandboxRoots(cwd, options.allowDirs);
  const roots = rawRoots.map((root) => {
    try {
      return realpathSync(root);
    } catch {
      return root; // root doesn't exist (yet) — fall back to its lexical form
    }
  });

  async function assertContained(rawPath: string, operation: GuardOperation): Promise<void> {
    const lexical = virtual
      ? path.resolve(cwd, rawPath.startsWith('/') ? rawPath.slice(1) : rawPath)
      : path.resolve(cwd, rawPath);
    const resolved = await realpathNearestExisting(lexical);
    if (!isWithinRoots(resolved, roots)) {
      throw new Error(`Error: permission denied for ${operation} on ${rawPath}`);
    }
  }

  return {
    async ls(dirPath) {
      await assertContained(dirPath, 'read');
      return backend.ls(dirPath);
    },
    async read(filePath, offset, limit) {
      await assertContained(filePath, 'read');
      return backend.read(filePath, offset, limit);
    },
    async readRaw(filePath) {
      await assertContained(filePath, 'read');
      return backend.readRaw(filePath);
    },
    async write(filePath, content) {
      await assertContained(filePath, 'write');
      return backend.write(filePath, content);
    },
    async edit(filePath, oldString, newString, replaceAll) {
      await assertContained(filePath, 'write');
      return backend.edit(filePath, oldString, newString, replaceAll);
    },
    async glob(pattern, dirPath) {
      await assertContained(dirPath ?? '/', 'read');
      return backend.glob(pattern, dirPath);
    },
    async grep(pattern, dirPath, glob) {
      await assertContained(dirPath ?? '/', 'read');
      return backend.grep(pattern, dirPath, glob);
    },
    uploadFiles: backend.uploadFiles?.bind(backend),
    downloadFiles: backend.downloadFiles?.bind(backend),
  };
}
