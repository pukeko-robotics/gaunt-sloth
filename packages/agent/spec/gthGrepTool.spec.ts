import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { GthConfig } from '#src/config.js';

// Mock ONLY execFile out of node:child_process so we can drive the two execution paths
// deterministically (rg present vs rg absent). Everything else (spawn, etc.) stays real so
// unrelated modules loaded transitively keep working.
const execFileMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,

    execFile: (...args: any[]) => execFileMock(...args),
  };
});

// --- execFile callback shims (execFile(file, args, options, callback)) -------------------------

function rgAbsent(...args: any[]) {
  const cb = args[3];
  const err = new Error('spawn rg ENOENT');

  (err as any).code = 'ENOENT';
  cb(err, '', '');
}
function rgStdout(stdout: string) {
  return (...args: any[]) => args[3](null, stdout, '');
}

function rgNoMatches(...args: any[]) {
  const err = new Error('no matches');

  (err as any).code = 1; // rg exit code 1 == no matches
  args[3](err, '', '');
}
function rgError(stderr: string) {
  return (...args: any[]) => {
    const err = new Error('rg failed');

    (err as any).code = 2; // rg exit code 2 == error (e.g. invalid regex)
    args[3](err, '', stderr);
  };
}

const cfg = {} as GthConfig;

describe('gthGrepTool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is registered as a built-in tool named gth_grep', async () => {
    const { AVAILABLE_BUILT_IN_TOOLS } = await import('#src/builtInToolsConfig.js');
    expect(Object.keys(AVAILABLE_BUILT_IN_TOOLS)).toContain('gth_grep');
  });

  it('exposes a tool named gth_grep', async () => {
    const { get, GREP_TOOL_NAME } = await import('#src/tools/gthGrepTool.js');
    const tool = get(cfg);
    expect(GREP_TOOL_NAME).toBe('gth_grep');
    expect(tool.name).toBe('gth_grep');
  });

  describe('formatGrepOutput (shared by both paths)', () => {
    it('renders the concise grouped shape', async () => {
      const { formatGrepOutput } = await import('#src/tools/gthGrepTool.js');
      const out = formatGrepOutput([
        { path: 'a.ts', line: 12, text: 'const foo = 1' },
        { path: 'a.ts', line: 40, text: 'foo()' },
        { path: 'b.ts', line: 3, text: 'import foo' },
      ]);
      expect(out).toBe(
        [
          'Found 3 matches',
          'a.ts:',
          '  Line 12: const foo = 1',
          '  Line 40: foo()',
          '',
          'b.ts:',
          '  Line 3: import foo',
        ].join('\n')
      );
    });

    it('reports No matches found when empty', async () => {
      const { formatGrepOutput } = await import('#src/tools/gthGrepTool.js');
      expect(formatGrepOutput([])).toBe('No matches found');
    });

    it('truncates an over-long line preview with a marker', async () => {
      const { formatGrepOutput } = await import('#src/tools/gthGrepTool.js');
      const long = 'MATCH' + 'x'.repeat(400);
      const out = formatGrepOutput([{ path: 'a.ts', line: 1, text: long }]);
      expect(out).toContain('… (line truncated)');
      expect(out).toContain('MATCH');
      expect(out).not.toContain('x'.repeat(400));
      // preview kept to MAX_LINE_LENGTH (250) chars + marker
      expect(out).toContain('x'.repeat(245));
    });
  });

  describe('globToRegExp', () => {
    it('matches simple and brace globs against a basename', async () => {
      const { globToRegExp } = await import('#src/tools/gthGrepTool.js');
      expect(globToRegExp('*.ts').test('foo.ts')).toBe(true);
      expect(globToRegExp('*.ts').test('foo.js')).toBe(false);
      expect(globToRegExp('*.{ts,tsx}').test('foo.tsx')).toBe(true);
      expect(globToRegExp('*.{ts,tsx}').test('foo.ts')).toBe(true);
      expect(globToRegExp('*.{ts,tsx}').test('foo.jsx')).toBe(false);
    });
  });

  // --- ripgrep-present path: execFile returns fabricated rg stdout ------------------------------
  describe('ripgrep path (rg present)', () => {
    let tmpDir: string;
    let originalInitCwd: string | undefined;

    beforeAll(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-grep-rg-'));
    });
    afterAll(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
      // getCurrentWorkDir() reads INIT_CWD; point the sandbox root at the (real) temp dir.
      originalInitCwd = process.env.INIT_CWD;
      process.env.INIT_CWD = tmpDir;
    });
    afterAll(() => {
      if (originalInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = originalInitCwd;
    });

    it('parses rg output into the concise shape with correct line numbers', async () => {
      execFileMock.mockImplementation(
        rgStdout('a.ts:12:const foo = 1\na.ts:40:foo()\nb.ts:3:import foo\n')
      );
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'foo' })) as string;
      expect(out).toBe(
        [
          'Found 3 matches',
          'a.ts:',
          '  Line 12: const foo = 1',
          '  Line 40: foo()',
          '',
          'b.ts:',
          '  Line 3: import foo',
        ].join('\n')
      );
    });

    it('constructs rg args (-e pattern, --glob include) and runs from the sandbox root', async () => {
      execFileMock.mockImplementation(rgStdout('a.ts:1:hit\n'));
      const { get } = await import('#src/tools/gthGrepTool.js');
      await get(cfg).invoke({ pattern: 'foo', include: '*.ts' });

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = execFileMock.mock.calls[0];
      expect(file).toBe('rg');
      expect(args).toContain('--line-number');
      expect(args).toContain('--with-filename');
      expect(args).toContain('--no-heading');
      expect(args).toEqual(expect.arrayContaining(['--glob', '*.ts']));
      expect(args).toEqual(expect.arrayContaining(['-e', 'foo']));
      // noise dirs excluded so rg matches the JS fallback (rg won't skip node_modules on its own)
      expect(args).toEqual(expect.arrayContaining(['--glob', '!node_modules']));
      expect(args).toEqual(expect.arrayContaining(['--glob', '!.git']));
      // pattern passed via -e (not as a bare positional), path terminated with --
      expect(args[args.length - 2]).toBe('--');
      expect(args[args.length - 1]).toBe('.');
      expect(options.cwd).toBe(tmpDir);
    });

    it('returns No matches found on rg exit code 1', async () => {
      execFileMock.mockImplementation(rgNoMatches);
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'nope' })) as string;
      expect(out).toBe('No matches found');
    });

    it('bounds the result count to limit', async () => {
      const stdout =
        Array.from({ length: 5 }, (_, i) => `a.ts:${i + 1}:hit ${i}`).join('\n') + '\n';
      execFileMock.mockImplementation(rgStdout(stdout));
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'hit', limit: 2 })) as string;
      expect(out).toContain('Found 2 matches');
      expect(out).toContain('  Line 1: hit 0');
      expect(out).toContain('  Line 2: hit 1');
      expect(out).not.toContain('hit 2');
    });

    it('surfaces a clean error string on a real rg failure (exit 2)', async () => {
      execFileMock.mockImplementation(rgError('regex parse error: unbalanced parenthesis'));
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'foo(' })) as string;
      expect(out).toContain('Search failed');
      expect(out).toContain('regex parse error');
    });
  });

  // --- JS-fallback path: rg reported absent, scan a REAL temp dir on disk -----------------------
  describe('JS scanner fallback (rg absent)', () => {
    let tmpDir: string;
    let originalInitCwd: string | undefined;

    beforeAll(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-grep-js-'));
      await fsp.writeFile(
        path.join(tmpDir, 'alpha.ts'),
        ['const needle = 1;', 'noop();', 'return needle + needle;'].join('\n')
      );
      await fsp.writeFile(
        path.join(tmpDir, 'beta.js'),
        ['// needle in a js file', 'ok();'].join('\n')
      );
      await fsp.mkdir(path.join(tmpDir, 'nested'), { recursive: true });
      await fsp.writeFile(path.join(tmpDir, 'nested', 'gamma.ts'), ['find needle here'].join('\n'));
      // Must be ignored by the fallback:
      await fsp.mkdir(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
      await fsp.writeFile(path.join(tmpDir, 'node_modules', 'pkg', 'index.ts'), 'needle in deps');
      // Long line for truncation coverage:
      await fsp.writeFile(path.join(tmpDir, 'long.ts'), 'needle' + 'x'.repeat(400));
    });
    afterAll(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
      originalInitCwd = process.env.INIT_CWD;
      process.env.INIT_CWD = tmpDir;
      execFileMock.mockImplementation(rgAbsent); // force the fallback for every test here
    });
    afterAll(() => {
      if (originalInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = originalInitCwd;
    });

    it('finds content matches with correct 1-based line numbers', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle', include: '*.ts' })) as string;
      // alpha.ts matches on lines 1 and 3
      expect(out).toContain('alpha.ts:');
      expect(out).toContain('  Line 1: const needle = 1;');
      expect(out).toContain('  Line 3: return needle + needle;');
    });

    it('filters by the include glob (*.ts excludes beta.js)', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle', include: '*.ts' })) as string;
      expect(out).not.toContain('beta.js');
      // brace glob example from the brief
      const out2 = (await get(cfg).invoke({ pattern: 'needle', include: '*.{ts,tsx}' })) as string;
      expect(out2).toContain('alpha.ts');
      expect(out2).not.toContain('beta.js');
    });

    it('skips ignored dirs (node_modules)', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle' })) as string;
      expect(out).not.toContain('node_modules');
    });

    it('bounds the result count to limit', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle', limit: 1 })) as string;
      expect(out).toContain('Found 1 matches');
    });

    it('returns No matches found when nothing matches', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'zzz_no_such_token' })) as string;
      expect(out).toBe('No matches found');
    });

    it('truncates a very long matching line', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle', include: 'long.ts' })) as string;
      expect(out).toContain('long.ts:');
      expect(out).toContain('… (line truncated)');
      expect(out).not.toContain('x'.repeat(400));
    });

    it('searches a single file when path points at one', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'needle', path: 'alpha.ts' })) as string;
      expect(out).toContain('alpha.ts:');
      expect(out).not.toContain('nested');
    });

    it('returns a clean error on an invalid regex (no unhandled throw)', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: '(' })) as string;
      expect(out).toContain('Search failed');
      expect(out).toContain('invalid regular expression');
    });

    it('bounds per-line scan length so a huge single line cannot hang (perf guard)', async () => {
      // near.min.js has the token within the scan cap (found); far.min.js has it ~1MB in on one
      // line (beyond the cap -> guarded out). Both complete promptly instead of scanning megabytes.
      const nearFile = path.join(tmpDir, 'near.min.js');
      const farFile = path.join(tmpDir, 'far.min.js');
      await fsp.writeFile(nearFile, 'NEEDLE' + 'a'.repeat(1_000_000));
      await fsp.writeFile(farFile, 'a'.repeat(1_000_000) + 'NEEDLE');
      try {
        const { get } = await import('#src/tools/gthGrepTool.js');
        const started = Date.now();
        const near = (await get(cfg).invoke({ pattern: 'NEEDLE', path: 'near.min.js' })) as string;
        const far = (await get(cfg).invoke({ pattern: 'NEEDLE', path: 'far.min.js' })) as string;
        expect(near).toContain('near.min.js:');
        expect(far).toBe('No matches found');
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        await fsp.rm(nearFile, { force: true });
        await fsp.rm(farFile, { force: true });
      }
    });
  });

  // --- sandbox boundary: independent of which execution path would run -------------------------
  describe('sandbox boundary', () => {
    let tmpDir: string;
    let originalInitCwd: string | undefined;

    beforeAll(async () => {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-grep-sbx-'));
    });
    afterAll(async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
      originalInitCwd = process.env.INIT_CWD;
      process.env.INIT_CWD = tmpDir;
      execFileMock.mockImplementation(rgAbsent);
    });
    afterAll(() => {
      if (originalInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = originalInitCwd;
    });

    it('refuses a relative path that escapes the working directory', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'x', path: '../../etc' })) as string;
      expect(out).toContain('escapes the working directory');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('refuses an absolute path outside the working directory', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'x', path: '/etc' })) as string;
      expect(out).toContain('escapes the working directory');
    });

    it('reports a clean error for a non-existent path', async () => {
      const { get } = await import('#src/tools/gthGrepTool.js');
      const out = (await get(cfg).invoke({ pattern: 'x', path: 'does-not-exist' })) as string;
      expect(out).toContain('Path not found');
    });

    it('refuses a symlink inside the workdir that points outside it', async () => {
      // A symlink whose *lexical* path stays inside the workdir but resolves out of it: the lexical
      // check passes, only the realpath containment guard catches it.
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'gth-grep-outside-'));
      await fsp.writeFile(path.join(outside, 'secret.txt'), 'top secret needle');
      const linkPath = path.join(tmpDir, 'escape-link');
      await fsp.symlink(outside, linkPath, 'dir');
      try {
        const { get } = await import('#src/tools/gthGrepTool.js');
        const out = (await get(cfg).invoke({ pattern: 'secret', path: 'escape-link' })) as string;
        expect(out).toContain('escapes the working directory');
        expect(out).not.toContain('top secret');
      } finally {
        await fsp.rm(linkPath, { force: true });
        await fsp.rm(outside, { recursive: true, force: true });
      }
    });
  });
});
