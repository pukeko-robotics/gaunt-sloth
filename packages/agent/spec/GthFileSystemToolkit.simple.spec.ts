import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'node:path';

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
};

// Simple mock that allows all operations
const fsMock = {
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
  open: vi.fn(),
  realpath: vi.fn(),
};

// Keep the original path methods for basic functionality
vi.mock('fs/promises', () => ({ default: fsMock }));
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

describe('GthFileSystemToolkit - Basic Tests', () => {
  let GthFileSystemToolkit: typeof import('#src/tools/GthFileSystemToolkit.js').default;
  let toolkit: InstanceType<typeof import('#src/tools/GthFileSystemToolkit.js').default>;

  beforeEach(async () => {
    vi.resetAllMocks();

    // Mock all fs operations to succeed
    fsMock.realpath.mockImplementation((p) => Promise.resolve(p));
    fsMock.stat.mockResolvedValue({
      isDirectory: () => false,
      isFile: () => true,
      size: 1024,
      birthtime: new Date('2023-01-01'),
      mtime: new Date('2023-01-02'),
      atime: new Date('2023-01-03'),
      mode: 0o644,
    });

    ({ default: GthFileSystemToolkit } = await import('#src/tools/GthFileSystemToolkit.js'));
  });

  describe('constructor', () => {
    it('should initialize with default allowed directories', () => {
      // Use current working directory which should be allowed
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      expect(toolkit).toBeDefined();
      expect(toolkit.tools).toBeDefined();
      expect(toolkit.tools.length).toBe(14); // All filesystem tools
    });

    it('should have all expected tools', () => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      const toolNames = toolkit.tools.map((t) => t.name);

      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('read_multiple_files');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('create_directory');
      expect(toolNames).toContain('list_directory');
      expect(toolNames).toContain('list_directory_with_sizes');
      expect(toolNames).toContain('directory_tree');
      expect(toolNames).toContain('move_file');
      expect(toolNames).toContain('search_files');
      expect(toolNames).toContain('get_file_info');
      expect(toolNames).toContain('delete_file');
      expect(toolNames).toContain('delete_directory');
      expect(toolNames).toContain('list_allowed_directories');
    });
  });

  describe('basic tool functionality', () => {
    beforeEach(() => {
      // Use a path that should be allowed (current directory)
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
    });

    it('read_file tool should be defined and callable', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'read_file')!;
      expect(tool).toBeDefined();
      expect(tool.name).toBe('read_file');
      expect(tool.description).toContain('Read the complete contents of a file');
      expect((tool as any).gthFileSystemType).toBe('read');
    });

    it('write_file tool should be defined and callable', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'write_file')!;
      expect(tool).toBeDefined();
      expect(tool.name).toBe('write_file');
      expect(tool.description).toContain('Create a new file or completely overwrite');
      expect((tool as any).gthFileSystemType).toBe('write');
    });

    it('list_directory tool should be defined and callable', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'list_directory')!;
      expect(tool).toBeDefined();
      expect(tool.name).toBe('list_directory');
      expect(tool.description).toContain('Get a detailed listing of all files and directories');
      expect((tool as any).gthFileSystemType).toBe('read');
    });

    it('list_allowed_directories should return configured directories', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'list_allowed_directories')!;
      const result = await tool.invoke({});

      expect(result).toContain('Allowed directories:');
      expect(result).toContain(process.cwd());
    });

    it('search_files should return matches from subdirectories', async () => {
      const tool = toolkit.tools.find((t) => t.name === 'search_files')!;
      const rootPath = process.cwd();

      const makeDirent = (name: string, isDirectory: boolean) => ({
        name,
        isDirectory: () => isDirectory,
        isSymbolicLink: () => false,
      });

      fsMock.readdir.mockImplementation((currentPath) => {
        if (currentPath === rootPath) {
          return Promise.resolve([makeDirent('sub', true), makeDirent('root.txt', false)]);
        }

        if (currentPath === path.join(rootPath, 'sub')) {
          return Promise.resolve([makeDirent('nested.txt', false)]);
        }

        return Promise.resolve([]);
      });

      const result = await tool.invoke({ path: rootPath, pattern: 'txt', excludePatterns: [] });

      expect(result).toContain(path.join(rootPath, 'root.txt'));
      expect(result).toContain(path.join(rootPath, 'sub', 'nested.txt'));
    });
  });

  describe('read_file head+tail combined', () => {
    const testPath = path.join(process.cwd(), 'file.txt');
    let readFileTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readFileTool = toolkit.tools.find((t) => t.name === 'read_file')!;
      // realpath echoes its input (set in the outer beforeEach), so testPath validates.
    });

    it('gap case: head+tail < total returns head, one skipped marker, then tail', async () => {
      const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath, head: 3, tail: 2 });
      const lines = result.split('\n');

      // Starts with the 3 head lines
      expect(lines.slice(0, 3)).toEqual(['line1', 'line2', 'line3']);
      // Contains exactly one skipped marker for 20 - 3 - 2 = 15 lines
      expect(result).toContain('... [15 lines skipped] ...');
      expect(result.match(/\[15 lines skipped\]/g)).toHaveLength(1);
      // Ends with the 2 tail lines
      expect(lines.slice(-2)).toEqual(['line19', 'line20']);
    });

    it('overlap case: head+tail > total returns the whole file with no skipped marker', async () => {
      const content = ['a', 'b', 'c', 'd'].join('\n'); // 4 lines
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath, head: 3, tail: 3 });

      expect(result).toBe(content);
      expect(result).not.toContain('skipped');
    });

    it('exact-boundary case: head+tail === total returns whole file, no separator, no double-print', async () => {
      const content = ['a', 'b', 'c', 'd', 'e'].join('\n'); // 5 lines, head 3 + tail 2 === 5
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath, head: 3, tail: 2 });

      expect(result).toBe(content);
      expect(result).not.toContain('skipped');
      // Nothing duplicated at the boundary
      expect(result.split('\n')).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('sanity: head-only still routes to headFile (combined path not used)', async () => {
      const headSpy = vi.spyOn(toolkit as any, 'headFile').mockResolvedValue('HEAD_ONLY');
      const tailSpy = vi.spyOn(toolkit as any, 'tailFile').mockResolvedValue('TAIL_ONLY');

      const result: string = await readFileTool.invoke({ path: testPath, head: 3 });

      expect(result).toBe('HEAD_ONLY');
      expect(headSpy).toHaveBeenCalledWith(testPath, 3);
      expect(tailSpy).not.toHaveBeenCalled();
      expect(fsMock.readFile).not.toHaveBeenCalled();
    });

    it('sanity: tail-only still routes to tailFile (combined path not used)', async () => {
      const headSpy = vi.spyOn(toolkit as any, 'headFile').mockResolvedValue('HEAD_ONLY');
      const tailSpy = vi.spyOn(toolkit as any, 'tailFile').mockResolvedValue('TAIL_ONLY');

      const result: string = await readFileTool.invoke({ path: testPath, tail: 2 });

      expect(result).toBe('TAIL_ONLY');
      expect(tailSpy).toHaveBeenCalledWith(testPath, 2);
      expect(headSpy).not.toHaveBeenCalled();
      expect(fsMock.readFile).not.toHaveBeenCalled();
    });
  });

  describe('trailing-newline line counting (GS2-40)', () => {
    const testPath = path.join(process.cwd(), 'file.txt');
    let readFileTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readFileTool = toolkit.tools.find((t) => t.name === 'read_file')!;
      // realpath echoes its input (set in the outer beforeEach), so testPath validates.
    });

    // Drives the real tailFile() chunk-reader by backing fs.open/fs.stat with an
    // in-memory buffer, so the reverse-scan line counting is exercised end to end.
    const backTailFileWith = (content: string) => {
      const buf = Buffer.from(content, 'utf-8');
      fsMock.stat.mockResolvedValue({
        isDirectory: () => false,
        isFile: () => true,
        size: buf.length,
        birthtime: new Date('2023-01-01'),
        mtime: new Date('2023-01-02'),
        atime: new Date('2023-01-03'),
        mode: 0o644,
      });
      fsMock.open.mockResolvedValue({
        read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
          const end = Math.min(position + length, buf.length);
          const bytesRead = Math.max(0, end - position);
          buf.copy(target, offset, position, end);
          return { bytesRead, buffer: target };
        }),
        close: vi.fn(async () => undefined),
      });
    };

    describe('headAndTailFile', () => {
      it('newline-terminated file: last line is NOT stolen into the skipped gap', async () => {
        // Old code counted the phantom trailing "" as line 4, skipping the real L3.
        fsMock.readFile.mockResolvedValue('L1\nL2\nL3\nL4\n');

        const result: string = await readFileTool.invoke({ path: testPath, head: 2, tail: 1 });

        expect(result).toBe('L1\nL2\n... [1 lines skipped] ...\nL4');
      });

      it('newline-terminated file: head+tail cover it -> whole file, no marker, no phantom skip', async () => {
        // 3 real lines; head 2 + tail 1 === total, so the entire file comes back verbatim.
        fsMock.readFile.mockResolvedValue('L1\nL2\nL3\n');

        const result: string = await readFileTool.invoke({ path: testPath, head: 2, tail: 1 });

        expect(result).toBe('L1\nL2\nL3\n');
        expect(result).not.toContain('skipped');
      });

      it('genuine trailing blank last line is preserved (drops exactly one element)', async () => {
        // "a\nb\nc\n\n" is 4 lines: a, b, c, "". Dropping one terminator empty leaves the
        // blank line, so skipped is 1 (not 2 if none dropped, not 0/overlap if two dropped).
        fsMock.readFile.mockResolvedValue('a\nb\nc\n\n');

        const result: string = await readFileTool.invoke({ path: testPath, head: 2, tail: 1 });

        expect(result).toBe('a\nb\n... [1 lines skipped] ...\n');
        expect(result.match(/\[\d+ lines skipped\]/g)).toHaveLength(1);
      });

      it('file without a trailing newline is counted unchanged', async () => {
        fsMock.readFile.mockResolvedValue('L1\nL2\nL3\nL4\nL5'); // 5 lines, no terminator

        const result: string = await readFileTool.invoke({ path: testPath, head: 2, tail: 1 });

        expect(result).toBe('L1\nL2\n... [2 lines skipped] ...\nL5');
      });

      it('CRLF-terminated file: the normalized trailing empty is dropped too', async () => {
        fsMock.readFile.mockResolvedValue('L1\r\nL2\r\nL3\r\nL4\r\n'); // 4 lines, CRLF

        const result: string = await readFileTool.invoke({ path: testPath, head: 2, tail: 1 });

        expect(result).toBe('L1\nL2\n... [1 lines skipped] ...\nL4');
      });
    });

    describe('tailFile', () => {
      it('newline-terminated file: tail=1 returns the last real line, not ""', async () => {
        backTailFileWith('L1\nL2\nL3\n');

        const result: string = await readFileTool.invoke({ path: testPath, tail: 1 });

        expect(result).toBe('L3');
      });

      it('newline-terminated file: tail=2 returns the last two real lines', async () => {
        backTailFileWith('L1\nL2\nL3\n');

        const result: string = await readFileTool.invoke({ path: testPath, tail: 2 });

        expect(result).toBe('L2\nL3');
      });

      it('file without a trailing newline is unchanged (firstChunk pop does not over-fire)', async () => {
        backTailFileWith('L1\nL2\nL3');

        const result: string = await readFileTool.invoke({ path: testPath, tail: 1 });

        expect(result).toBe('L3');
      });

      it('genuine trailing blank last line: tail=1 returns the blank line', async () => {
        backTailFileWith('a\n\n');

        const result: string = await readFileTool.invoke({ path: testPath, tail: 1 });

        expect(result).toBe('');
      });

      it('CRLF-terminated file: tail=1 returns the last real line', async () => {
        backTailFileWith('L1\r\nL2\r\nL3\r\n');

        const result: string = await readFileTool.invoke({ path: testPath, tail: 1 });

        expect(result).toBe('L3');
      });
    });
  });

  describe('edit_file (applyFileEdits ambiguity guard + replaceAll)', () => {
    const testPath = path.join(process.cwd(), 'edit.txt');
    let editTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      editTool = toolkit.tools.find((t) => t.name === 'edit_file')!;
      // realpath echoes its input (outer beforeEach), so testPath validates.
    });

    it('ambiguous match without replaceAll throws a count-naming error and does NOT write', async () => {
      fsMock.readFile.mockResolvedValue('x = foo\ny = foo\n');

      await expect(
        editTool.invoke({ path: testPath, edits: [{ oldText: 'foo', newText: 'bar' }] })
      ).rejects.toThrow(/Found 2 occurrences of the oldText/);

      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('no match at all throws the existing "Could not find exact match" error and does NOT write', async () => {
      fsMock.readFile.mockResolvedValue('nothing to see here\n');

      await expect(
        editTool.invoke({ path: testPath, edits: [{ oldText: 'zzz', newText: 'yyy' }] })
      ).rejects.toThrow(/Could not find exact match/);

      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('unique exact match replaces the one occurrence and annotates "replaced 1 occurrence(s)"', async () => {
      fsMock.readFile.mockResolvedValue('alpha\nbeta\ngamma\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'beta', newText: 'BETA' }],
      });

      expect(result).toContain('edit 1: replaced 1 occurrence(s)');
      expect(result).toContain('```diff');
      expect(fsMock.writeFile).toHaveBeenCalledWith(testPath, 'alpha\nBETA\ngamma\n', 'utf-8');
    });

    it('unique match inserts a $-pattern in newText literally (no String.replace $-substitution)', async () => {
      // String.replace(str, str) would interpret $&, $`, $', $$ in the replacement string:
      // for oldText 'X', newText '$& $$ done' would become 'X $ done'. split/join must not.
      fsMock.readFile.mockResolvedValue('price is X here\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'X', newText: '$& $$ done' }],
      });

      expect(result).toContain('edit 1: replaced 1 occurrence(s)');
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        testPath,
        'price is $& $$ done here\n',
        'utf-8'
      );
    });

    it('ambiguous match with replaceAll: true replaces ALL occurrences and annotates the count', async () => {
      fsMock.readFile.mockResolvedValue('x = foo\ny = foo\nz = foo\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'foo', newText: 'bar', replaceAll: true }],
      });

      expect(result).toContain('edit 1: replaced 3 occurrence(s)');
      expect(fsMock.writeFile).toHaveBeenCalledWith(
        testPath,
        'x = bar\ny = bar\nz = bar\n',
        'utf-8'
      );
    });

    it('no exact match but fuzzy line-match hits: applies via fuzzy path and annotates it', async () => {
      // 'a();\nb();' is NOT a contiguous substring (the indented '\n    b' breaks it),
      // so the exact branch misses and the trim-based fuzzy fallback matches at the block.
      fsMock.readFile.mockResolvedValue('function f() {\n    a();\n    b();\n}\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'a();\nb();', newText: 'c();\nd();' }],
      });

      expect(result).toContain('edit 1: applied via fuzzy line-match (no exact match)');
      expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    });

    it('dryRun returns the diff without writing (diff formatting preserved)', async () => {
      fsMock.readFile.mockResolvedValue('alpha\nbeta\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'beta', newText: 'BETA' }],
        dryRun: true,
      });

      expect(result).toContain('```diff');
      expect(result).toContain('edit 1: replaced 1 occurrence(s)');
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('write_file (GS2-36: mkdir -p + fatal-throw -> recoverable result)', () => {
    let writeTool: any;
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      writeTool = toolkit.tools.find((t) => t.name === 'write_file')!;
    });

    it('creates missing parent directories (mkdir -p) before writing a new nested file', async () => {
      // target + intermediate dirs do not exist; only the sandbox root does. The model
      // writes the file without a preceding create_directory (the common case that used
      // to crash the whole run with ENOENT).
      const filePath = path.join(process.cwd(), 'newdir', 'sub', 'file.txt');
      fsMock.realpath
        .mockRejectedValueOnce(enoent()) // realpath(target file)
        .mockRejectedValueOnce(enoent()) // realpath(newdir/sub)
        .mockRejectedValueOnce(enoent()) // realpath(newdir)
        .mockResolvedValueOnce(process.cwd()); // realpath(root) exists + is allowed

      const result: string = await writeTool.invoke({ path: filePath, content: 'hello' });

      expect(result).toBe(`Successfully wrote to ${filePath}`);
      expect(fsMock.mkdir).toHaveBeenCalledWith(path.dirname(filePath), { recursive: true });
      expect(fsMock.writeFile).toHaveBeenCalledWith(filePath, 'hello', 'utf-8');
    });

    it('returns a recoverable error string (does NOT throw) when the write itself fails (EISDIR)', async () => {
      // A write whose fs op fails must be handed back to the model as a tool result it can
      // act on, not thrown — a throw aborts the whole agent run (the GS2-36 anti-pattern).
      const dirPath = path.join(process.cwd(), 'some-existing-dir');
      fsMock.realpath.mockResolvedValue(dirPath); // path exists + is contained
      fsMock.writeFile.mockRejectedValue(
        Object.assign(
          new Error("EISDIR: illegal operation on a directory, open '" + dirPath + "'"),
          {
            code: 'EISDIR',
          }
        )
      );

      const result: string = await writeTool.invoke({ path: dirPath, content: 'x' });

      expect(result).toContain(`Error writing file ${dirPath}`);
      expect(result).toContain('EISDIR');
    });

    it('deep new subdirectory under the sandbox stays allowed (containment holds for created dirs)', async () => {
      // The mkdir -p only creates directories below an ancestor validatePath already proved
      // is inside the sandbox, so a legitimate deep new path writes successfully.
      const filePath = path.join(process.cwd(), 'a', 'b', 'c', 'd', 'deep.txt');
      fsMock.realpath
        .mockRejectedValueOnce(enoent()) // deep.txt
        .mockRejectedValueOnce(enoent()) // a/b/c/d
        .mockRejectedValueOnce(enoent()) // a/b/c
        .mockRejectedValueOnce(enoent()) // a/b
        .mockRejectedValueOnce(enoent()) // a
        .mockResolvedValueOnce(process.cwd()); // root

      const result: string = await writeTool.invoke({ path: filePath, content: 'deep' });

      expect(result).toBe(`Successfully wrote to ${filePath}`);
      expect(fsMock.mkdir).toHaveBeenCalledWith(path.dirname(filePath), { recursive: true });
    });

    it('a write whose parent directory symlinks OUTSIDE the sandbox is denied and writes nothing', async () => {
      // Parent (linkdir) exists but realpaths outside the allowed root: validatePath must
      // reject before any mkdir/write, and the denial is surfaced as a recoverable result.
      const filePath = path.join(process.cwd(), 'linkdir', 'evil.txt');
      fsMock.realpath
        .mockRejectedValueOnce(enoent()) // realpath(evil.txt) -> not there yet
        .mockResolvedValueOnce('/outside/link-target'); // realpath(linkdir) -> escapes sandbox

      const result: string = await writeTool.invoke({ path: filePath, content: 'x' });

      expect(result).toContain(`Error writing file ${filePath}`);
      expect(result).toContain('Access denied');
      expect(fsMock.mkdir).not.toHaveBeenCalled();
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('utility methods', () => {
    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
    });

    it('should format file sizes correctly', () => {
      const formatSize = toolkit['formatSize'];

      expect(formatSize(0)).toBe('0 B');
      expect(formatSize(512)).toBe('512 B');
      expect(formatSize(1024)).toBe('1.00 KB');
      expect(formatSize(1048576)).toBe('1.00 MB');
    });

    it('should normalize line endings', () => {
      const normalizeLineEndings = toolkit['normalizeLineEndings'];

      expect(normalizeLineEndings('line1\r\nline2\r\n')).toBe('line1\nline2\n');
      expect(normalizeLineEndings('line1\nline2\n')).toBe('line1\nline2\n');
    });

    it('should expand home directory', () => {
      const expandHome = toolkit['expandHome'];

      expect(expandHome('~/test')).toBe(os.homedir() + path.sep + 'test');
      expect(expandHome('/absolute/path')).toBe('/absolute/path');
      expect(expandHome('relative/path')).toBe('relative/path');
    });

    describe('path validation', () => {
      beforeEach(() => {
        toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      });

      it('should allow paths within allowed directories', async () => {
        const testPath = path.join(process.cwd(), 'test-file.txt');
        fsMock.realpath.mockResolvedValue(testPath);

        const result = await toolkit['validatePath'](testPath);
        expect(result).toBe(testPath);
      });

      it('should reject paths outside allowed directories', async () => {
        const testPath = '/tmp/outside-file.txt';

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow(
          'Access denied - path outside allowed directories'
        );
      });

      it('should handle non-existent files with valid parent directories', async () => {
        const testPath = path.join(process.cwd(), 'nonexistent', 'file.txt');
        const rootPath = process.cwd();

        // Mock the file doesn't exist
        fsMock.realpath
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock parent doesn't exist
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock root exists
          .mockResolvedValueOnce(rootPath);

        const result = await toolkit['validatePath'](testPath);
        expect(result).toBe(testPath);
      });

      it('should reject non-existent files when no valid parent exists', async () => {
        const testPath = '/tmp/nonexistent/file.txt';

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow(
          'Access denied - path outside allowed directories'
        );
      });

      it('should reject non-existent files with invalid parent directories', async () => {
        const testPath = '/tmp/nonexistent/file.txt';

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow(
          'Access denied - path outside allowed directories'
        );
      });

      it('should reject symlinks pointing outside allowed directories', async () => {
        const testPath = path.join(process.cwd(), 'symlink.txt');
        const targetPath = '/tmp/target.txt';

        fsMock.realpath.mockResolvedValue(targetPath);

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow(
          'Access denied - symlink target outside allowed directories'
        );
      });

      it('should allow symlinks pointing within allowed directories', async () => {
        const testPath = path.join(process.cwd(), 'symlink.txt');
        const targetPath = path.join(process.cwd(), 'target.txt');

        fsMock.realpath.mockResolvedValue(targetPath);

        const result = await toolkit['validatePath'](testPath);
        expect(result).toBe(targetPath);
      });

      it('should handle other filesystem errors properly', async () => {
        const testPath = path.join(process.cwd(), 'test-file.txt');
        const permissionError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

        fsMock.realpath.mockRejectedValue(permissionError);

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow('Permission denied');
      });

      it('should handle parent directory validation for non-existent paths within allowed directories', async () => {
        const testPath = path.join(process.cwd(), 'deep', 'nested', 'file.txt');
        const rootPath = process.cwd();

        // Mock the file doesn't exist
        fsMock.realpath
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock immediate parent doesn't exist
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock grandparent doesn't exist
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock root exists and is allowed
          .mockResolvedValueOnce(rootPath);

        const result = await toolkit['validatePath'](testPath);
        expect(result).toBe(testPath);
      });

      it('should reject when parent validation fails due to permission errors', async () => {
        const testPath = path.join(process.cwd(), 'restricted', 'file.txt');
        const permissionError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

        // Mock the file doesn't exist
        fsMock.realpath
          .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          // Mock parent permission error
          .mockRejectedValueOnce(permissionError);

        await expect(toolkit['validatePath'](testPath)).rejects.toThrow('Permission denied');
      });

      it('should treat bare and dot-relative file paths the same', async () => {
        const absolutePath = path.join(process.cwd(), 'it.js');
        fsMock.realpath.mockResolvedValue(absolutePath);

        const barePathResult = await toolkit['validatePath']('it.js');
        const dotRelativePathResult = await toolkit['validatePath']('./it.js');

        expect(barePathResult).toBe(absolutePath);
        expect(dotRelativePathResult).toBe(absolutePath);
      });

      it('should accept quoted path arguments by unwrapping quotes', async () => {
        const absolutePath = path.join(process.cwd(), 'it.js');
        fsMock.realpath.mockResolvedValue(absolutePath);

        const result = await toolkit['validatePath']('"./it.js"');
        expect(result).toBe(absolutePath);
      });
    });
  });
});
