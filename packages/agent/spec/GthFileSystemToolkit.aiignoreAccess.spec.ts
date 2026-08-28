import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';

/**
 * `.aiignore` means **may not touch**, not may not read (GS2-84).
 *
 * GS2-82 closed discovery: the listing tools no longer emit a hidden entry. Access stayed open —
 * `validatePath`, the single gate every filesystem tool passes through, never consulted
 * `.aiignore`, so a model that NAMED a hidden path could still read it, edit it, delete it, and —
 * the case that decides the whole question — `move_file` it to an unhidden name, after which
 * nothing hid it at all. A read-class-only guard is therefore not a guard.
 *
 * Every case here names the hidden path by hand. That is the point: walking down from the root
 * proves nothing, because the listing tools already stopped at the hidden entry and the discovery
 * filter would take the credit.
 *
 * Everything is real — a real temp tree, a real `.aiignore` read off disk, the real matcher. A
 * mocked matcher would prove the control flow and not the path the tool actually hands it.
 *
 * **Each test gets a pristine fixture.** These tools delete and rename for real, so a fixture built
 * once in `beforeAll` would leave every later case asserting against a tree an earlier case had
 * destroyed — and the whole file would then pass for reasons no run had tested.
 *
 * **Every refusal is paired with a control on a visible twin**, so a toolkit that simply refuses
 * everything fails here rather than going green.
 */
describe('GthFileSystemToolkit - .aiignore is a may-not-touch boundary (GS2-84)', () => {
  let toolkit: InstanceType<typeof import('#src/tools/GthFileSystemToolkit.js').default>;
  let root: string;
  let originalInitCwd: string | undefined;

  /** The distinctive half of the refusal, asserted as a substring so the prefix may evolve. */
  const DENIED = 'blocked by .aiignore';

  const invoke = (name: string, args: Record<string, unknown>): Promise<string> =>
    toolkit.tools.find((t) => t.name === name)!.invoke(args) as Promise<string>;

  const at = (...parts: string[]): string => path.join(root, ...parts);
  const onDisk = (...parts: string[]): string => readFileSync(at(...parts), 'utf-8');

  beforeAll(() => {
    // Captured exactly once, before anything overwrites it: spec files share a worker process, so
    // a per-test capture would re-read the value this spec itself set and restore a deleted temp
    // dir into the environment of every file that runs after it.
    originalInitCwd = process.env.INIT_CWD;
  });

  afterAll(() => {
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
  });

  beforeEach(async () => {
    // realpath after mkdtemp: on macOS `os.tmpdir()` resolves through a symlink (/var ->
    // /private/var) and validatePath compares the *real* path against allowedDirectories, so the
    // unresolved path would be denied outright — for the wrong reason.
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-fs-aiignore-access-')));

    // Two bare lines. A bare pattern applies at every depth, and since GS2-83 it also covers the
    // subtree beneath whatever it matches — so `secretdir` alone answers for `secretdir/inside.txt`.
    await fsp.writeFile(at('.aiignore'), 'secret.txt\nsecretdir\n');

    await fsp.writeFile(at('public.txt'), 'PUBLIC-CONTENT\n');
    await fsp.writeFile(at('secret.txt'), 'TOP-SECRET-CONTENT\n');
    // A visible file the destructive controls consume, so they never touch `public.txt`.
    await fsp.writeFile(at('scratch.txt'), 'SCRATCH-CONTENT\n');

    await fsp.mkdir(at('sub'));
    await fsp.writeFile(at('sub', 'nested.txt'), 'NESTED-PUBLIC-CONTENT\n');
    // The bare pattern reaches here too; a fix anchored to the root only would leave this readable.
    await fsp.writeFile(at('sub', 'secret.txt'), 'NESTED-SECRET-CONTENT\n');

    // A visible empty directory for the delete_directory control.
    await fsp.mkdir(at('emptydir'));

    await fsp.mkdir(at('secretdir', 'nested'), { recursive: true });
    await fsp.writeFile(at('secretdir', 'inside.txt'), 'INSIDE-SECRET-CONTENT\n');
    await fsp.writeFile(at('secretdir', 'nested', 'deeper.txt'), 'DEEP-SECRET-CONTENT\n');

    // Shares the hidden directory's whole name as a prefix, so an implementation matching on string
    // prefix rather than on path segments fails here instead of going green.
    await fsp.mkdir(at('secretdir-public'));
    await fsp.writeFile(at('secretdir-public', 'nearmiss.txt'), 'NEARMISS-OK\n');

    // The work dir is what `.aiignore` patterns are resolved against (getCurrentWorkDir()).
    process.env.INIT_CWD = root;

    const { default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js');
    // No aiignoreConfig: patterns are loaded from the real `.aiignore` on disk.
    toolkit = new GthFileSystemToolkit({ allowedDirectories: [root] });
  });

  afterEach(async () => {
    // This spec drives delete_file and delete_directory, so the teardown states its own bound
    // rather than trusting `root` to be what it was: remove only inside the system temp dir.
    const tmpRoot = await fsp.realpath(os.tmpdir());
    if (root && root.startsWith(`${tmpRoot}${path.sep}`)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  describe('the read class refuses a hidden path named by hand', () => {
    it('read_file returns a refusal instead of the plaintext', async () => {
      const out = await invoke('read_file', { path: at('secret.txt') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('TOP-SECRET-CONTENT');

      const control = await invoke('read_file', { path: at('public.txt') });
      expect(control).toContain('PUBLIC-CONTENT');
    });

    it('read_file refuses a file inside a hidden directory', async () => {
      const out = await invoke('read_file', { path: at('secretdir', 'inside.txt') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('INSIDE-SECRET-CONTENT');

      // Control at the same depth, under the prefix near-miss directory.
      const control = await invoke('read_file', { path: at('secretdir-public', 'nearmiss.txt') });
      expect(control).toContain('NEARMISS-OK');
    });

    it('read_file refuses a hidden file nested below the root', async () => {
      const out = await invoke('read_file', { path: at('sub', 'secret.txt') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('NESTED-SECRET-CONTENT');

      const control = await invoke('read_file', { path: at('sub', 'nested.txt') });
      expect(control).toContain('NESTED-PUBLIC-CONTENT');
    });

    /**
     * The refusal belongs to the MEMBER, not to the call: a hidden path in the list must not take
     * the visible ones down with it.
     *
     * **The hidden member goes first**, which is the discriminating order. With it last, an
     * implementation that refused the whole call after reading the earlier members would still
     * satisfy both assertions. Both orders are exercised so neither reading is left untested.
     */
    it('read_multiple_files refuses the hidden member while still returning the visible one', async () => {
      const hiddenFirst = await invoke('read_multiple_files', {
        paths: [at('secret.txt'), at('public.txt')],
      });
      expect(hiddenFirst).toContain(DENIED);
      // The visible member proves the batch was not abandoned at the refusal.
      expect(hiddenFirst).toContain('PUBLIC-CONTENT');
      expect(hiddenFirst).not.toContain('TOP-SECRET-CONTENT');

      const hiddenLast = await invoke('read_multiple_files', {
        paths: [at('public.txt'), at('secret.txt')],
      });
      expect(hiddenLast).toContain(DENIED);
      expect(hiddenLast).toContain('PUBLIC-CONTENT');
      expect(hiddenLast).not.toContain('TOP-SECRET-CONTENT');
    });

    it('get_file_info refuses a hidden path', async () => {
      const out = await invoke('get_file_info', { path: at('secret.txt') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('permissions');

      const control = await invoke('get_file_info', { path: at('public.txt') });
      expect(control).toContain('permissions');
    });

    it('list_directory refuses the hidden directory as its own argument', async () => {
      const out = await invoke('list_directory', { path: at('secretdir') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('inside.txt');

      const control = await invoke('list_directory', { path: at('sub') });
      expect(control).toContain('nested.txt');
    });

    it('list_directory_with_sizes refuses the hidden directory as its own argument', async () => {
      const out = await invoke('list_directory_with_sizes', { path: at('secretdir') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('inside.txt');

      const control = await invoke('list_directory_with_sizes', { path: at('sub') });
      expect(control).toContain('nested.txt');
    });

    it('directory_tree refuses the hidden directory as its own argument', async () => {
      const out = await invoke('directory_tree', { path: at('secretdir') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('deeper.txt');

      const control = await invoke('directory_tree', { path: at('sub') });
      expect(control).toContain('nested.txt');
    });

    it('search_files refuses the hidden directory as its search root', async () => {
      const out = await invoke('search_files', {
        path: at('secretdir'),
        pattern: 'inside',
        excludePatterns: [],
      });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('inside.txt');

      // Control: the same call shape against the near-miss directory still finds its file, so the
      // refusal above cannot be satisfied by a search that finds nothing anywhere.
      const control = await invoke('search_files', {
        path: at('secretdir-public'),
        pattern: 'nearmiss',
        excludePatterns: [],
      });
      expect(control).toContain('nearmiss.txt');
    });
  });

  describe('the write class refuses a hidden path AND leaves the filesystem untouched', () => {
    it('write_file does not overwrite a hidden file', async () => {
      const out = await invoke('write_file', { path: at('secret.txt'), content: 'CLOBBERED' });
      expect(out).toContain(DENIED);
      expect(onDisk('secret.txt')).toBe('TOP-SECRET-CONTENT\n');

      const control = await invoke('write_file', {
        path: at('sub', 'written.txt'),
        content: 'WRITTEN',
      });
      expect(control).toContain('Successfully wrote');
      expect(onDisk('sub', 'written.txt')).toBe('WRITTEN');
    });

    it('write_file does not plant a new file inside a hidden directory', async () => {
      const out = await invoke('write_file', {
        path: at('secretdir', 'planted.txt'),
        content: 'PLANTED',
      });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secretdir', 'planted.txt'))).toBe(false);
    });

    it('edit_file neither modifies a hidden file nor echoes its content back in a diff', async () => {
      const out = await invoke('edit_file', {
        path: at('secret.txt'),
        edits: [{ oldText: 'TOP-SECRET-CONTENT', newText: 'REPLACED', replaceAll: false }],
        dryRun: false,
      });
      expect(out).toContain(DENIED);
      // edit_file returns a unified diff of the file it touched, so a refusal that came too late
      // would disclose the plaintext even on a dryRun.
      expect(out).not.toContain('TOP-SECRET-CONTENT');
      expect(onDisk('secret.txt')).toBe('TOP-SECRET-CONTENT\n');

      const control = await invoke('edit_file', {
        path: at('public.txt'),
        edits: [{ oldText: 'PUBLIC-CONTENT', newText: 'EDITED-CONTENT', replaceAll: false }],
        dryRun: false,
      });
      expect(control).toContain('EDITED-CONTENT');
      expect(onDisk('public.txt')).toBe('EDITED-CONTENT\n');
    });

    it('edit_file with dryRun still refuses rather than previewing the hidden content', async () => {
      const out = await invoke('edit_file', {
        path: at('secret.txt'),
        edits: [{ oldText: 'TOP-SECRET-CONTENT', newText: 'REPLACED', replaceAll: false }],
        dryRun: true,
      });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('TOP-SECRET-CONTENT');
    });

    it('create_directory does not create a directory inside a hidden one', async () => {
      const out = await invoke('create_directory', { path: at('secretdir', 'newdir') });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secretdir', 'newdir'))).toBe(false);

      const control = await invoke('create_directory', { path: at('sub', 'newdir') });
      expect(control).toContain('Successfully created directory');
      expect(existsSync(at('sub', 'newdir'))).toBe(true);
    });

    it('delete_file does not delete a hidden file', async () => {
      const out = await invoke('delete_file', { path: at('secret.txt') });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secret.txt'))).toBe(true);

      const control = await invoke('delete_file', { path: at('scratch.txt') });
      expect(control).toContain('Successfully deleted file');
      expect(existsSync(at('scratch.txt'))).toBe(false);
    });

    it('delete_directory does not recursively delete a hidden directory', async () => {
      const out = await invoke('delete_directory', { path: at('secretdir'), recursive: true });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secretdir'))).toBe(true);
      expect(existsSync(at('secretdir', 'inside.txt'))).toBe(true);
      expect(existsSync(at('secretdir', 'nested', 'deeper.txt'))).toBe(true);

      const control = await invoke('delete_directory', { path: at('emptydir'), recursive: false });
      expect(control).toContain('Successfully deleted');
      expect(existsSync(at('emptydir'))).toBe(false);
    });
  });

  /**
   * `move_file` is the case that decided the ruling, and it has TWO paths, so all three
   * combinations are pinned separately.
   *
   * - **source hidden** — the one that defeats any read-only guarantee: renaming a hidden file to a
   *   name no pattern matches leaves nothing hiding it, and every later read is legitimate.
   * - **destination hidden** — writing INTO the protected area. "May not touch" refuses this too.
   * - **both hidden** — refused on the source, before the destination is even considered.
   */
  describe('move_file', () => {
    it('refuses to relocate a hidden file to an unhidden name', async () => {
      const out = await invoke('move_file', {
        source: at('secret.txt'),
        destination: at('exposed.txt'),
      });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secret.txt'))).toBe(true);
      expect(existsSync(at('exposed.txt'))).toBe(false);
    });

    it('refuses to move a visible file into a hidden directory', async () => {
      const out = await invoke('move_file', {
        source: at('public.txt'),
        destination: at('secretdir', 'landed.txt'),
      });
      expect(out).toContain(DENIED);
      expect(existsSync(at('public.txt'))).toBe(true);
      expect(existsSync(at('secretdir', 'landed.txt'))).toBe(false);
    });

    it('refuses when both source and destination are hidden', async () => {
      const out = await invoke('move_file', {
        source: at('secret.txt'),
        destination: at('secretdir', 'landed.txt'),
      });
      expect(out).toContain(DENIED);
      expect(existsSync(at('secret.txt'))).toBe(true);
      expect(existsSync(at('secretdir', 'landed.txt'))).toBe(false);
    });

    it('still moves a visible file to a visible destination', async () => {
      const out = await invoke('move_file', {
        source: at('scratch.txt'),
        destination: at('sub', 'scratch.txt'),
      });
      expect(out).toContain('Successfully moved');
      expect(existsSync(at('scratch.txt'))).toBe(false);
      expect(onDisk('sub', 'scratch.txt')).toBe('SCRATCH-CONTENT\n');
    });
  });

  /**
   * A symlink whose own name matches nothing must not become a way to reach a hidden target. Skipped
   * on Windows, where creating a symlink needs a privilege CI does not grant — the same condition
   * the existing `GthCustomToolkit` specs skip on.
   */
  it.skipIf(process.platform === 'win32')(
    'read_file refuses through a visible symlink pointing at a hidden file, without naming the target',
    async () => {
      await fsp.symlink(at('secret.txt'), at('alias.txt'));

      const out = await invoke('read_file', { path: at('alias.txt') });
      expect(out).toContain(DENIED);
      expect(out).not.toContain('TOP-SECRET-CONTENT');
      // The refusal must not disclose where the link pointed: the model named `alias.txt`, and the
      // resolved target is exactly what the boundary withholds.
      expect(out).not.toContain('secret.txt');

      // Control: a symlink to a visible file still reads through.
      await fsp.symlink(at('public.txt'), at('alias-public.txt'));
      const control = await invoke('read_file', { path: at('alias-public.txt') });
      expect(control).toContain('PUBLIC-CONTENT');
    }
  );

  /**
   * The guard must not cost the discovery filtering GS2-82 and GS2-83 established: a directory that
   * merely CONTAINS hidden entries is still listed, minus those entries.
   */
  describe('discovery still works', () => {
    it('list_directory on the root still lists the visible entries and drops the hidden ones', async () => {
      const names = (await invoke('list_directory', { path: root }))
        .split('\n')
        .map((line) => line.replace(/^\[(?:DIR|FILE)\]\s+/, '').trim())
        .filter((name) => name.length > 0);

      expect(names).toContain('public.txt');
      expect(names).toContain('sub');
      expect(names).toContain('secretdir-public');
      expect(names).not.toContain('secret.txt');
      expect(names).not.toContain('secretdir');
    });

    it('search_files from the root still finds visible files and no hidden ones', async () => {
      const out = await invoke('search_files', {
        path: root,
        pattern: '.txt',
        excludePatterns: [],
      });
      expect(out).toContain('nearmiss.txt');
      expect(out).toContain('nested.txt');
      expect(out).not.toContain('secret.txt');
      expect(out).not.toContain('inside.txt');
      expect(out).not.toContain('deeper.txt');
    });
  });
});

/**
 * `gth_read_binary` is registered only when `binaryFormats` is configured, so it needs its own
 * toolkit. It carried an `.aiignore` check of its own before GS2-84 and is expected to be green
 * either way — it is pinned here so the tool is not silently dropped from the boundary when that
 * private check is one day removed as redundant.
 */
describe('GthFileSystemToolkit - gth_read_binary honours the same boundary (GS2-84)', () => {
  let toolkit: InstanceType<typeof import('#src/tools/GthFileSystemToolkit.js').default>;
  let root: string;
  let originalInitCwd: string | undefined;

  const invoke = (name: string, args: Record<string, unknown>): Promise<string> =>
    toolkit.tools.find((t) => t.name === name)!.invoke(args) as Promise<string>;

  beforeAll(async () => {
    originalInitCwd = process.env.INIT_CWD;
    root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-fs-aiignore-bin-')));
    await fsp.writeFile(path.join(root, '.aiignore'), 'secret.png\n');
    // A one-pixel-ish payload; only the base64 round-trip matters, not that it is a valid PNG.
    await fsp.writeFile(path.join(root, 'secret.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fsp.writeFile(path.join(root, 'public.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  afterAll(async () => {
    const tmpRoot = await fsp.realpath(os.tmpdir());
    if (root && root.startsWith(`${tmpRoot}${path.sep}`)) {
      await fsp.rm(root, { recursive: true, force: true });
    }
    if (originalInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = originalInitCwd;
  });

  beforeEach(async () => {
    process.env.INIT_CWD = root;
    const { default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js');
    toolkit = new GthFileSystemToolkit({
      allowedDirectories: [root],
      binaryFormats: [{ type: 'image', extensions: ['png'] }],
    });
  });

  it('refuses a hidden binary file and reads the visible control', async () => {
    const out = await invoke('gth_read_binary', { path: path.join(root, 'secret.png') });
    expect(out).toContain('.aiignore');
    expect(out).not.toContain('base64,');

    const control = await invoke('gth_read_binary', { path: path.join(root, 'public.png') });
    expect(control).toContain('base64,');
  });
});
