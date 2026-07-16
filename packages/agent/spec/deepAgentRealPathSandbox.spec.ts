/**
 * EXT-13 containment + path-namespace integration tests, EXT-14 realpath-sandbox tests.
 *
 * Unlike the unit tests in deepAgentPermissions.spec.ts (which assert the SHAPE of the rules
 * gsloth builds), these drive the REAL deepagents filesystem tools (`createFilesystemMiddleware`
 * with a real {@link FilesystemBackend} in non-virtual mode, wrapped in gsloth's EXT-14
 * {@link guardFilesystemBackend} + gsloth's `buildPermissions` output — i.e. the exact backend
 * construction {@link GthDeepAgent.init} wires up) against a real temp directory. They prove the
 * rules actually contain — i.e. that removing virtualMode (EXT-13 part a) did NOT weaken the
 * sandbox — that the fs tools and shell now agree on one real-absolute-path namespace (the
 * glob-vs-shell symptom from live testing), and (EXT-14) that a symlink can't be used to escape
 * the sandbox even when its lexical form matches an `allow cwd/**` rule.
 *
 * These intentionally do NOT mock deepagents or node:fs: the whole point is to exercise the real
 * permission enforcement + backend path resolution end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFilesystemMiddleware, FilesystemBackend } from 'deepagents';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// getCurrentWorkDir is anchored per-test to the temp cwd so buildPermissions builds rules rooted
// at the real directory the backend reads from.
const getCurrentWorkDirMock = vi.fn();
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', () => ({
  getCurrentWorkDir: () => getCurrentWorkDirMock(),
}));

// Pull the tools off a real filesystem middleware built with a non-virtual backend (wrapped in
// the EXT-14 realpath guard, exactly as GthDeepAgent.init() wires it) + the given permissions.
// Returns a name→tool map so tests can `.invoke()` read_file / write_file / glob.
async function buildFsTools(cwd: string, permissions: unknown) {
  const { guardFilesystemBackend } = await import('#src/core/deepAgentPermissions.js');
  const backend = guardFilesystemBackend(
    new FilesystemBackend({ rootDir: cwd, virtualMode: false }),
    {
      cwd,
      virtual: false,
    }
  );

  const mw = createFilesystemMiddleware({ backend, permissions: permissions as any });

  const byName: Record<string, any> = {};

  for (const t of (mw as any).tools as any[]) byName[t.name] = t;
  return byName;
}

// EXT-16: on Windows the real cwd (`D:\...`) is never used in real (non-virtual) mode — the
// backend runs in virtualMode there instead, since deepagents' validatePath requires POSIX
// `/`-rooted paths. This whole file drives the real, non-virtual backend directly
// (`virtualMode: false`), which is a POSIX-only code path in production; skip it on win32
// rather than fight deepagents' own path requirement with a code path Windows never takes.
describe.skipIf(process.platform === 'win32')(
  'EXT-13 real-path sandbox (default code mode, no virtualMode)',
  () => {
    let root: string;
    let cwd: string;
    let outside: string;

    beforeEach(() => {
      vi.resetAllMocks();
      root = mkdtempSync(path.join(tmpdir(), 'ext13-'));
      cwd = path.join(root, 'cwd');
      outside = path.join(root, 'outside');
      mkdirSync(cwd);
      mkdirSync(outside);
      writeFileSync(path.join(cwd, 'inside.txt'), 'INSIDE');
      writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
      getCurrentWorkDirMock.mockReturnValue(cwd);
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    async function defaultTools() {
      const { buildPermissions } = await import('#src/core/deepAgentPermissions.js');
      // The default code-mode sandbox: filesystem 'all' → allow cwd/**, deny /**.
      const permissions = buildPermissions({ filesystem: 'all' });
      return { tools: await buildFsTools(cwd, permissions), permissions };
    }

    it('reads a file INSIDE cwd (real absolute path) — allowed', async () => {
      const { tools } = await defaultTools();
      const out = await tools.read_file.invoke({ file_path: path.join(cwd, 'inside.txt') });
      expect(JSON.stringify(out)).toContain('INSIDE');
    });

    it('writes a file INSIDE cwd (real absolute path) — allowed', async () => {
      const { tools } = await defaultTools();
      const target = path.join(cwd, 'written.txt');
      const out = await tools.write_file.invoke({ file_path: target, content: 'HELLO' });
      expect(JSON.stringify(out)).not.toMatch(/permission denied/i);
      expect(readFileSync(target, 'utf8')).toBe('HELLO');
    });

    it('reading OUTSIDE cwd (real absolute path) is denied by the catch-all deny', async () => {
      const { tools } = await defaultTools();
      // read_file throws permission denied; gsloth's runner softens it to a ToolMessage, but here
      // we assert the raw enforcement (the throw) the softening middleware relies on.
      await expect(
        tools.read_file.invoke({ file_path: path.join(outside, 'secret.txt') })
      ).rejects.toThrow(/permission denied for read/i);
    });

    it('writing OUTSIDE cwd (real absolute path) is denied', async () => {
      const { tools } = await defaultTools();
      await expect(
        tools.write_file.invoke({ file_path: path.join(outside, 'pwn.txt'), content: 'x' })
      ).rejects.toThrow(/permission denied for write/i);
    });

    it('a raw ".." escape is rejected by deepagents validatePath (independent of the globs)', async () => {
      const { tools } = await defaultTools();
      // A RAW, un-normalized "../" string (Node's path.join would collapse it, so build it by hand):
      // deepagents validatePath rejects any literal ".." segment outright, before the allow/deny
      // globs even run. This guard exists in BOTH virtualMode and the new real-path mode.
      const escape = `${cwd}/../outside/secret.txt`;
      await expect(tools.read_file.invoke({ file_path: escape })).rejects.toThrow(
        /must not contain/i
      );
    });

    it('"read" mode allows reads in cwd but denies writes', async () => {
      const { buildPermissions } = await import('#src/core/deepAgentPermissions.js');
      const tools = await buildFsTools(cwd, buildPermissions({ filesystem: 'read' }));
      const read = await tools.read_file.invoke({ file_path: path.join(cwd, 'inside.txt') });
      expect(JSON.stringify(read)).toContain('INSIDE');
      await expect(
        tools.write_file.invoke({ file_path: path.join(cwd, 'nope.txt'), content: 'x' })
      ).rejects.toThrow(/permission denied for write/i);
    });

    it('"none" mode denies reads and writes even inside cwd', async () => {
      const { buildPermissions } = await import('#src/core/deepAgentPermissions.js');
      const tools = await buildFsTools(cwd, buildPermissions({ filesystem: 'none' }));
      await expect(
        tools.read_file.invoke({ file_path: path.join(cwd, 'inside.txt') })
      ).rejects.toThrow(/permission denied for read/i);
    });

    it('.aiignore deny rules win over the cwd allow rule (anchored at real cwd)', async () => {
      const { buildPermissions } = await import('#src/core/deepAgentPermissions.js');
      writeFileSync(path.join(cwd, 'secrets.env'), 'TOKEN=abc');
      const tools = await buildFsTools(
        cwd,
        buildPermissions({ filesystem: 'all', aiignore: { enabled: true, patterns: ['*.env'] } })
      );
      await expect(
        tools.read_file.invoke({ file_path: path.join(cwd, 'secrets.env') })
      ).rejects.toThrow(/permission denied for read/i);
      // a non-ignored file in cwd is still readable
      const ok = await tools.read_file.invoke({ file_path: path.join(cwd, 'inside.txt') });
      expect(JSON.stringify(ok)).toContain('INSIDE');
    });

    /**
     * SYMLINK CONTAINMENT — EXT-13 parity plus the EXT-14 fix.
     *
     * deepagents enforces permissions on the RAW model-supplied path string (validatePath +
     * micromatch globs); it does NOT fs.realpath/resolve symlinks before matching. virtualMode's
     * resolvePath is also purely lexical (path.resolve + a ".." check), so it never resolved
     * symlinks either. Historically (verified during EXT-13) BOTH modes behaved identically:
     *
     *   - A symlink whose FINAL component points outside cwd was blocked by the backend's read()
     *     (O_NOFOLLOW / lstat-rejects-symlink) → ELOOP / "Symlinks are not allowed".
     *   - A symlink used as an INTERMEDIATE DIRECTORY component (cwd/linkdir -> /outside, then
     *     cwd/linkdir/secret.txt) was NOT caught: the permission glob matched the in-cwd path
     *     (allow cwd/**), O_NOFOLLOW only guards the final component, and neither virtualMode nor
     *     the EXT-13 real-path mode resolved the intermediate symlink — so it read the outside
     *     target. That was a PRE-EXISTING gap shared by virtualMode; EXT-13 introduced no regression.
     *
     * EXT-14 closes the intermediate-directory gap by wrapping the backend in gsloth's own
     * `guardFilesystemBackend` (see `buildFsTools` above), which realpath-resolves the target BEFORE
     * delegating to the backend and denies anything that resolves outside the sandbox root(s) — so
     * BOTH symlink shapes below are now denied (the final-component case picks up a consistent
     * "permission denied" throw too, since the realpath guard runs before the backend's own
     * O_NOFOLLOW read). Upstream tracking (closing this in deepagents itself): EXT-19.
     */
    describe('symlink containment (EXT-13 parity + the EXT-14 realpath fix)', () => {
      it('final-component symlink pointing outside cwd is denied by the realpath guard', async () => {
        const { tools } = await defaultTools();
        const link = path.join(cwd, 'linkfile');
        symlinkSync(path.join(outside, 'secret.txt'), link);
        // The permission glob still allows the in-cwd lexical path, but the EXT-14 guard resolves
        // the symlink and denies before the backend's own O_NOFOLLOW read ever runs.
        await expect(tools.read_file.invoke({ file_path: link })).rejects.toThrow(
          /permission denied for read/i
        );
      });

      it('FIXED (was XFAIL/KNOWN-GAP): intermediate symlink DIR reaching outside cwd is denied', async () => {
        const { tools } = await defaultTools();
        const linkdir = path.join(cwd, 'linkdir');
        symlinkSync(outside, linkdir); // cwd/linkdir -> /outside
        // EXT-14: the realpath guard resolves cwd/linkdir/secret.txt to its real location outside
        // cwd and denies it, even though the lexical path matches `allow cwd/**`.
        await expect(
          tools.read_file.invoke({ file_path: path.join(linkdir, 'secret.txt') })
        ).rejects.toThrow(/permission denied for read/i);
      });

      it('an intermediate symlink DIR pointing at ANOTHER in-cwd dir is still readable (no regression)', async () => {
        const { tools } = await defaultTools();
        const realSubdir = path.join(cwd, 'realsubdir');
        mkdirSync(realSubdir);
        writeFileSync(path.join(realSubdir, 'note.txt'), 'IN-CWD-VIA-LINK');
        const linkdir = path.join(cwd, 'linkdir-legit');
        symlinkSync(realSubdir, linkdir); // cwd/linkdir-legit -> cwd/realsubdir (both in-sandbox)
        const out = await tools.read_file.invoke({ file_path: path.join(linkdir, 'note.txt') });
        expect(JSON.stringify(out)).toContain('IN-CWD-VIA-LINK');
      });
    });

    /**
     * The original bug symptom: `glob`/`ls` given a real absolute path found nothing (because the
     * virtual fs mapped it under cwd) while run_shell_command saw the real path. With virtualMode
     * off, the fs tools and the shell share ONE real-absolute-path namespace.
     */
    it('fs tools and the shell agree on one real-absolute-path namespace (glob-vs-shell symptom)', async () => {
      const { tools } = await defaultTools();
      writeFileSync(path.join(cwd, 'gth_a.md'), 'A');
      writeFileSync(path.join(cwd, 'gth_b.md'), 'B');

      // glob searches under a real absolute base path — the SAME cwd the shell uses. (Before EXT-13
      // the base defaulted to the virtual `/`, which mapped under cwd and so disagreed with the
      // shell's real `/`-rooted paths.) The base must be the real cwd, which is exactly what part (b)
      // tells the model.
      const globOut = await tools.glob.invoke({ pattern: 'gth_*.md', path: cwd });
      const text = JSON.stringify(globOut);
      // It finds the files at their REAL absolute paths (not virtual `/gth_a.md`).
      expect(text).toContain(path.join(cwd, 'gth_a.md'));
      expect(text).toContain(path.join(cwd, 'gth_b.md'));

      // And read_file accepts that same real path the shell would hand it.
      const readOut = await tools.read_file.invoke({ file_path: path.join(cwd, 'gth_a.md') });
      expect(JSON.stringify(readOut)).toContain('A');
    });
  }
);
