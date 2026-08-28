import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

/**
 * `.aiignore` is a privacy boundary for the directory-listing tools, not a label (GS2-82).
 *
 * The promise `.aiignore` makes is that the agent never sees those files — and a *name* is often
 * the payload (`prod-db-restore.sh`, `client-acme-contract.pdf`, `id_rsa.bak`). A listing tool that
 * emits the entry while tagging it as ignored still hands the name to the model, and from there to
 * the provider, so an ignored entry must be **absent**, never annotated.
 *
 * Everything here is real: a real temp tree, a real `.aiignore` read off disk, and the real
 * {@link shouldIgnoreFile} matcher. A mocked matcher would prove the control flow but not the path
 * the tool actually hands it.
 *
 * The fixture keeps a non-ignored control at every depth, so no assertion can be satisfied by a
 * tool that simply over-filters and returns nothing, and it puts an ignored file *below* the root,
 * so a fix that filtered only the outermost directory cannot pass.
 *
 * Patterns here are written in their anchored forms — a globstar-prefixed glob for the files, the
 * directory's own relative path for the directory. Both were measured to match identically under
 * `path.posix.matchesGlob` and `path.win32.matchesGlob`, so the nested case holds on Windows too.
 * The bare-pattern contract these no longer avoid depending on — one line hiding a directory's
 * name *and* its whole subtree — is pinned in its own block at the foot of this file.
 */
describe('GthFileSystemToolkit - .aiignore privacy boundary (GS2-82)', () => {
  let GthFileSystemToolkit: typeof import('#src/tools/GthFileSystemToolkit.js').default;
  let toolkit: InstanceType<typeof import('#src/tools/GthFileSystemToolkit.js').default>;
  let root: string;
  let originalInitCwd: string | undefined;

  /** Hidden names a tool can reach without descending: a file and a directory, both aiignored. */
  const HIDDEN_AT_ROOT = ['notes.secret.txt', 'secretdir'];
  /** Hidden names only a recursive tool can reach: an aiignored file, and a file inside an
   * aiignored directory (which is withheld by the directory's exclusion, not by its own name). */
  const HIDDEN_BELOW_ROOT = ['nested.secret.txt', 'inside.txt'];

  const invoke = (name: string, args: Record<string, unknown>): Promise<string> =>
    toolkit.tools.find((t) => t.name === name)!.invoke(args) as Promise<string>;

  beforeAll(async () => {
    // Captured exactly once, BEFORE anything overwrites it: spec files share a worker process, so
    // a capture that ran per-test would re-read the value this spec itself set and "restore" the
    // temp dir into the environment of every file that runs after it.
    originalInitCwd = process.env.INIT_CWD;

    // realpath after mkdtemp: on macOS `os.tmpdir()` resolves through a symlink (/var ->
    // /private/var) and validatePath compares the *real* path against allowedDirectories, so the
    // unresolved path would be denied outright.
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-fs-aiignore-')));

    await fsp.writeFile(path.join(root, '.aiignore'), '**/*.secret.txt\nsecretdir\n');

    await fsp.writeFile(path.join(root, 'notes.public.txt'), 'public\n');
    await fsp.writeFile(path.join(root, 'notes.secret.txt'), 'ROOT-SECRET\n');

    await fsp.mkdir(path.join(root, 'sub'));
    await fsp.writeFile(path.join(root, 'sub', 'nested.public.txt'), 'nested public\n');
    await fsp.writeFile(path.join(root, 'sub', 'nested.secret.txt'), 'NESTED-SECRET\n');

    await fsp.mkdir(path.join(root, 'secretdir'));
    await fsp.writeFile(path.join(root, 'secretdir', 'inside.txt'), 'INSIDE-SECRET\n');

    // Not aiignored — one of the hard-coded noise directories, which is listed but never walked.
    await fsp.mkdir(path.join(root, 'node_modules'));
    await fsp.writeFile(path.join(root, 'node_modules', 'dep.js'), 'module.exports = 1;\n');
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
  });

  beforeEach(async () => {
    // The work dir is what `.aiignore` patterns are resolved against (getCurrentWorkDir()).
    process.env.INIT_CWD = root;

    ({ default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js'));
    // No aiignoreConfig: patterns are loaded from the real `.aiignore` on disk.
    toolkit = new GthFileSystemToolkit({ allowedDirectories: [root] });
  });

  describe('directory_tree', () => {
    it('does not emit the name of an aiignored file at the root', async () => {
      const out = await invoke('directory_tree', { path: root });
      expect(out).not.toContain('notes.secret.txt');
      expect(out).toContain('notes.public.txt'); // control: not over-filtering
    });

    it('does not emit the name of an aiignored file nested below the root', async () => {
      const out = await invoke('directory_tree', { path: root });
      expect(out).not.toContain('nested.secret.txt');
      expect(out).toContain('nested.public.txt'); // control at the same depth
    });

    it('does not emit the name of an aiignored directory', async () => {
      const out = await invoke('directory_tree', { path: root });
      expect(out).not.toContain('secretdir');
      expect(out).toContain('sub'); // control: a non-ignored directory is still walked
    });

    it('keeps the contents of an aiignored directory out of the tree', async () => {
      const out = await invoke('directory_tree', { path: root });
      // Guarded twice over: the recursion guard stops the descent, and since GS2-83 the matcher
      // itself answers true for everything below the directory. Asserted because the obvious
      // future refactor — build the entry and its children, filter at push time — would defeat the
      // first guard, and this is what would catch it.
      expect(out).not.toContain('inside.txt');
      expect(out).toContain('nested.public.txt'); // control: a walked directory still has children
    });

    it('marks no entry as ignored on account of .aiignore (excluded, never annotated)', async () => {
      const out = await invoke('directory_tree', { path: root });
      const tree = JSON.parse(out) as {
        name: string;
        ignored?: boolean;
        children?: { name: string }[];
      }[];

      // The only surviving producer of the flag is the hard-coded noise-directory list; an
      // aiignored entry is gone from the output, so it can carry no flag at all.
      expect(tree.filter((e) => e.ignored).map((e) => e.name)).toEqual(['node_modules']);
    });

    it('still lists a noise directory unwalked, with ignored: true explaining the missing children', async () => {
      const out = await invoke('directory_tree', { path: root });
      const tree = JSON.parse(out) as {
        name: string;
        type: string;
        ignored?: boolean;
        children?: unknown[];
      }[];

      const nodeModules = tree.find((e) => e.name === 'node_modules');
      expect(nodeModules).toEqual({ name: 'node_modules', type: 'directory', ignored: true });
      expect(out).not.toContain('dep.js');
    });
  });

  // The boundary is a property of the listing tools as a set, not of any one of them: the leak was
  // found because three tools agreed and a fourth did not. Each case names only what that tool can
  // reach — a shallow tool asserting the absence of a nested name would pass vacuously.
  describe('every listing tool holds the same boundary', () => {
    it('list_directory', async () => {
      const out = await invoke('list_directory', { path: root });
      for (const name of HIDDEN_AT_ROOT) expect(out).not.toContain(name);
      expect(out).toContain('notes.public.txt');
    });

    it('list_directory_with_sizes', async () => {
      const out = await invoke('list_directory_with_sizes', { path: root });
      for (const name of HIDDEN_AT_ROOT) expect(out).not.toContain(name);
      expect(out).toContain('notes.public.txt');
    });

    it('search_files', async () => {
      const hidden = await invoke('search_files', {
        path: root,
        pattern: 'secret',
        excludePatterns: [],
      });
      // Only the names this pattern can actually produce. `inside.txt` does not contain "secret",
      // so listing it here would assert nothing; it gets its own search below instead.
      for (const name of [...HIDDEN_AT_ROOT, 'nested.secret.txt']) {
        expect(hidden).not.toContain(name);
      }

      // The discriminating search for the ignored directory: this pattern DOES match the file
      // inside it, so a search that queued the directory for traversal would return it.
      const insideIgnoredDir = await invoke('search_files', {
        path: root,
        pattern: 'inside',
        excludePatterns: [],
      });
      expect(insideIgnoredDir).toBe('No matches found');

      const control = await invoke('search_files', {
        path: root,
        pattern: 'public',
        excludePatterns: [],
      });
      expect(control).toContain('notes.public.txt');
      expect(control).toContain('nested.public.txt');
    });

    it('directory_tree', async () => {
      const out = await invoke('directory_tree', { path: root });
      // The only tool here that reaches below the root, so it is the only one given the deep
      // names. `inside.txt` is the forward guard described above; the rest are red-proven.
      for (const name of [...HIDDEN_AT_ROOT, ...HIDDEN_BELOW_ROOT]) {
        expect(out).not.toContain(name);
      }
      expect(out).toContain('notes.public.txt');
      expect(out).toContain('nested.public.txt');
    });
  });
});

/**
 * One `.aiignore` line hides a directory's NAME and its CONTENTS (GS2-83 / GS2-86).
 *
 * Its own fixture, with a bare one-line `.aiignore`, because that is the claim: before GS2-83 both
 * halves needed two lines (`secretdir` *and* `secretdir/**`) and nothing in the documentation said
 * so, so a user who wrote the obvious single line got the name withheld from listings while every
 * file underneath stayed readable.
 *
 * **The discriminating case is listing the hidden directory directly.** Walking down from the root
 * proves little: the listing tools already stopped at an ignored entry, so the contents were
 * withheld by the recursion guard whatever the matcher said. Passing the hidden directory as the
 * tool's own `path` argument bypasses that guard entirely and asks the matcher the question
 * directly — `shouldIgnoreFile` was measured to return false for `secretdir/inside.txt` against
 * the pattern `secretdir`, so this listing previously came back populated.
 *
 * `secretdir` is deliberately not `dist` or `node_modules`: both of those sit in the toolkit's
 * hard-coded noise list, which drops them before `.aiignore` is consulted, so either name would
 * make these assertions pass without the matcher contributing anything.
 *
 * `secretdir-public` shares the hidden directory's entire name as a prefix, so an implementation
 * that matched on string prefix rather than on path segments fails here rather than going green.
 */
describe('GthFileSystemToolkit - one .aiignore line hides a directory name and contents (GS2-86)', () => {
  let toolkit: InstanceType<typeof import('#src/tools/GthFileSystemToolkit.js').default>;
  let root: string;
  let originalInitCwd: string | undefined;

  const invoke = (name: string, args: Record<string, unknown>): Promise<string> =>
    toolkit.tools.find((t) => t.name === name)!.invoke(args) as Promise<string>;

  beforeAll(async () => {
    originalInitCwd = process.env.INIT_CWD;
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-fs-aiignore-dir-')));

    // One bare line naming the directory, plus one directory-spelled line used only by the
    // deliberate-deviation case below. `buildcache` is not in the toolkit's hard-coded noise list,
    // so nothing but `.aiignore` can withhold it.
    await fsp.writeFile(path.join(root, '.aiignore'), 'secretdir\nbuildcache/\n');

    // A regular FILE whose name is written with a trailing slash in .aiignore.
    await fsp.writeFile(path.join(root, 'buildcache'), 'NOT-A-DIRECTORY\n');

    await fsp.mkdir(path.join(root, 'secretdir', 'nested'), { recursive: true });
    await fsp.writeFile(path.join(root, 'secretdir', 'inside.txt'), 'INSIDE-SECRET\n');
    await fsp.writeFile(path.join(root, 'secretdir', 'nested', 'deeper.txt'), 'DEEP-SECRET\n');

    // Prefix near-miss: must remain fully visible.
    await fsp.mkdir(path.join(root, 'secretdir-public'), { recursive: true });
    await fsp.writeFile(path.join(root, 'secretdir-public', 'nearmiss.txt'), 'NEARMISS-OK\n');

    await fsp.writeFile(path.join(root, 'notes.public.txt'), 'public\n');
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
  });

  beforeEach(async () => {
    process.env.INIT_CWD = root;
    const { default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js');
    toolkit = new GthFileSystemToolkit({ allowedDirectories: [root] });
  });

  describe('the NAME is not enumerable', () => {
    /**
     * Entry names from a `[DIR]`/`[FILE]`-prefixed listing, one per line.
     *
     * These assertions parse rather than substring-match on purpose. `not.toContain('secretdir')`
     * cannot be used at all — `secretdir-public` contains it — and the obvious repair,
     * `not.toContain('secretdir\n')`, is an assertion that cannot fail under a reachable
     * condition: `list_directory` joins entries with `\n` and appends no trailing newline, so a
     * leaked `secretdir` sitting last in `fs.readdir` order has no newline after it and the
     * assertion passes while the name is on screen. Directory order is not ours to rely on.
     * Comparing parsed names for equality has neither hole.
     */
    const entryNames = (listing: string): string[] =>
      listing
        .split('\n')
        .map((line) => line.replace(/^\[(?:DIR|FILE)\]\s+/, '').trim())
        .filter((name) => name.length > 0);

    it('list_directory does not name it', async () => {
      const names = entryNames(await invoke('list_directory', { path: root }));
      expect(names).not.toContain('secretdir');
      expect(names).toContain('secretdir-public'); // prefix near-miss control
      expect(names).toContain('notes.public.txt'); // control: not over-filtering
    });

    it('list_directory_with_sizes does not name it', async () => {
      // Sizes are padded onto the same line, so trim the tail off each parsed name.
      const names = entryNames(await invoke('list_directory_with_sizes', { path: root })).map(
        (name) => name.split(/\s{2,}/)[0]
      );
      expect(names).not.toContain('secretdir');
      expect(names).toContain('secretdir-public');
      expect(names).toContain('notes.public.txt');
    });

    // The deliberate deviation from .gitignore, pinned where it is observable. gitignore's
    // trailing slash means "directories only", so `buildcache/` would leave a FILE named
    // `buildcache` visible. `.aiignore` hides it, because deciding requires the entry's type and
    // a privacy boundary resolves that ambiguity toward hiding. Asserted so the deviation cannot
    // be quietly "corrected" back toward gitignore without a red.
    it('a trailing-slash pattern also hides a plain FILE of that name', async () => {
      const names = entryNames(await invoke('list_directory', { path: root }));
      expect(names).not.toContain('buildcache');
      expect(names).toContain('notes.public.txt'); // control: not over-filtering
    });

    it('directory_tree does not name it', async () => {
      const out = await invoke('directory_tree', { path: root });
      const tree = JSON.parse(out) as { name: string }[];
      expect(tree.map((e) => e.name)).not.toContain('secretdir');
      expect(tree.map((e) => e.name)).toContain('secretdir-public'); // control
    });
  });

  describe('the CONTENTS are hidden by the same line', () => {
    it('directory_tree emits no file from inside it', async () => {
      const out = await invoke('directory_tree', { path: root });
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('deeper.txt');
      expect(out).toContain('nearmiss.txt'); // control: a visible directory is still walked
    });

    // The case the recursion guard cannot cover: the hidden directory is handed to the tool as its
    // own path argument, so nothing walked into it and only the matcher can withhold the entries.
    it('list_directory ON the hidden directory returns none of its entries', async () => {
      const out = await invoke('list_directory', { path: path.join(root, 'secretdir') });
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('nested');
    });

    it('list_directory_with_sizes ON the hidden directory returns none of its entries', async () => {
      const out = await invoke('list_directory_with_sizes', {
        path: path.join(root, 'secretdir'),
      });
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('nested');
    });

    it('directory_tree ON the hidden directory returns no entries', async () => {
      const out = await invoke('directory_tree', { path: path.join(root, 'secretdir') });
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('deeper.txt');
      expect(JSON.parse(out)).toEqual([]);
    });

    it('search_files finds nothing inside it, while the near-miss control is found', async () => {
      const hidden = await invoke('search_files', {
        path: root,
        pattern: 'inside',
        excludePatterns: [],
      });
      expect(hidden).toBe('No matches found');

      const deep = await invoke('search_files', {
        path: root,
        pattern: 'deeper',
        excludePatterns: [],
      });
      expect(deep).toBe('No matches found');

      // Control: the same search shape does return a result for the prefix near-miss directory,
      // so the two assertions above cannot be satisfied by a search that finds nothing at all.
      const control = await invoke('search_files', {
        path: root,
        pattern: 'nearmiss',
        excludePatterns: [],
      });
      expect(control).toContain('nearmiss.txt');
    });
  });
});
