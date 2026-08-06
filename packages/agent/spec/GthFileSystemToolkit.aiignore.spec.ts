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
 * Patterns are anchored deliberately — a globstar-prefixed glob for the files, the directory's own
 * relative path for the directory — rather than bare: whether a bare pattern also hides a
 * directory's *contents* is a separate open question (GS2-83) that these assertions must not
 * depend on. Both anchored forms were measured to match identically under
 * `path.posix.matchesGlob` and `path.win32.matchesGlob`, so the nested case holds on Windows too.
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
      // A forward guard, not a red-proven case: the pre-existing recursion guard already stopped
      // the descent, so `inside.txt` never leaked even while the directory's own NAME did. It is
      // asserted because the obvious future refactor — build the entry and its children, filter
      // at push time — would reintroduce exactly this, and nothing else would catch it.
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
