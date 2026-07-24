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
  // GS2-36 recoverable-delete tests exercise these.
  unlink: vi.fn(),
  rm: vi.fn(),
  rmdir: vi.fn(),
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

  describe('read_file offset/limit line window (GS2-39)', () => {
    const testPath = path.join(process.cwd(), 'file.txt');
    let readFileTool: any;
    // 20 lines: "line1".."line20", no trailing newline.
    const content = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readFileTool = toolkit.tools.find((t) => t.name === 'read_file')!;
      fsMock.readFile.mockResolvedValue(content);
    });

    it('window in the middle: offset 5, limit 3 returns exactly lines 5-7', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 5, limit: 3 });
      expect(result).toBe('line5\nline6\nline7');
    });

    it('edge: offset 1, limit 3 returns the first three lines', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 1, limit: 3 });
      expect(result).toBe('line1\nline2\nline3');
    });

    it('limit past EOF clamps to the last available line (no phantom trailing line)', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 18, limit: 10 });
      expect(result).toBe('line18\nline19\nline20');
    });

    it('offset without limit reads from offset to EOF (default limit)', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 19 });
      expect(result).toBe('line19\nline20');
    });

    it('offset past EOF clamps to a recoverable note, not an empty string or the whole file', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 100 });
      expect(result).toContain('past end of file');
      expect(result).toContain('20 lines total');
    });

    it('newline-terminated file: window line numbering matches head/tail (no phantom last line)', async () => {
      // "a\nb\nc\n" is 3 real lines; a window of the last one must be "c", not "".
      fsMock.readFile.mockResolvedValue('a\nb\nc\n');
      const result: string = await readFileTool.invoke({ path: testPath, offset: 3, limit: 1 });
      expect(result).toBe('c');
    });

    it('the byte/per-line cap applies to the windowed slice too (safety envelope on the window)', async () => {
      // A window whose single selected line is pathologically long must still be per-line
      // truncated — the cap is a safety envelope on whatever slice offset/limit returns.
      const longLine = 'z'.repeat(5000);
      fsMock.readFile.mockResolvedValue(`first\n${longLine}\nthird`);

      const result: string = await readFileTool.invoke({ path: testPath, offset: 2, limit: 1 });

      expect(result).toBe('z'.repeat(2000) + '... (line truncated to 2000 chars)');
    });

    it('continuation with the DEFAULT limit past the cap emits a resume notice (no silent data loss)', async () => {
      // The exact defect: after a default whole-file read says "resume with offset:2001", the
      // model issues offset:2001. That window (default limit -> hard cap 2000) must itself report
      // that more file remains, or lines 4001-5000 are silently lost.
      const bigContent = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(bigContent);

      const result: string = await readFileTool.invoke({ path: testPath, offset: 2001 });
      const lines = result.split('\n');

      expect(lines).toHaveLength(2001); // 2000 content lines + one notice line
      expect(lines[0]).toBe('L2001');
      expect(lines[1999]).toBe('L4000');
      expect(result).toContain('read cap');
      expect(result).toContain('offset:4001'); // resume at the first dropped line
      expect(result).not.toContain('L4001');
    });

    it('explicit limit above MAX_READ_LINES is clamped to 2000 AND emits a notice (visible clamp)', async () => {
      const bigContent = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(bigContent);

      const result: string = await readFileTool.invoke({ path: testPath, offset: 1, limit: 10000 });
      const lines = result.split('\n');

      expect(lines).toHaveLength(2001);
      expect(lines[1999]).toBe('L2000');
      expect(result).toContain('read cap');
      expect(result).toContain('offset:2001');
      expect(result).not.toContain('L2001');
    });

    it('a small EXPLICIT limit fully satisfied stays quiet even when more file remains (no over-correction)', async () => {
      // Deliberate paging: the model asked for exactly 5 lines and got them. This is not a cap
      // hit, so no notice — otherwise every deliberate page would be spammed with a resume line.
      const bigContent = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(bigContent);

      const result: string = await readFileTool.invoke({ path: testPath, offset: 1, limit: 5 });

      expect(result).toBe('L1\nL2\nL3\nL4\nL5');
      expect(result).not.toContain('read cap');
    });
  });

  describe('read_file safety envelope: byte/line cap + per-line truncation (GS2-39)', () => {
    const testPath = path.join(process.cwd(), 'file.txt');
    let readFileTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readFileTool = toolkit.tools.find((t) => t.name === 'read_file')!;
    });

    it('small whole-file read is returned verbatim (backward compatible, no cap notice)', async () => {
      fsMock.readFile.mockResolvedValue('alpha\nbeta\ngamma');
      const result: string = await readFileTool.invoke({ path: testPath });
      expect(result).toBe('alpha\nbeta\ngamma');
      expect(result).not.toContain('read cap');
    });

    it('line cap: a 5000-line file is truncated to 2000 lines plus a resume notice', async () => {
      // Short lines so the LINE cap (2000) bites before the byte cap.
      const content = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath });
      const lines = result.split('\n');

      // 2000 content lines + exactly one appended notice line.
      expect(lines).toHaveLength(2001);
      expect(lines[0]).toBe('L1');
      expect(lines[1999]).toBe('L2000');
      expect(result).toContain('read cap');
      // Resume points at the first dropped line so the model can page the rest.
      expect(result).toContain('offset:2001');
      // Dropped lines are absent.
      expect(result).not.toContain('L2001');
      expect(result).not.toContain('L5000');
    });

    it('byte cap: a file under the line cap but over 50 KB stops on bytes with a notice', async () => {
      // 1000 lines (< 2000-line cap) of ~200 chars each ≈ 200 KB, so ONLY the byte cap can fire.
      const content = Array.from(
        { length: 1000 },
        (_, i) => `line${i + 1}:` + 'x'.repeat(200)
      ).join('\n');
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath });

      expect(Buffer.byteLength(result, 'utf-8')).toBeLessThanOrEqual(50 * 1024 + 200);
      expect(result.split('\n').length).toBeLessThan(1000);
      expect(result).toContain('read cap');
      expect(result).toContain('line1:'); // first line kept
      expect(result).not.toContain('line999:'); // a late line dropped
    });

    it('per-line truncation: a pathological single 5000-char line is cut with the marker and NO global notice', async () => {
      const content = 'a'.repeat(5000); // one line, no newline
      fsMock.readFile.mockResolvedValue(content);

      const result: string = await readFileTool.invoke({ path: testPath });

      expect(result).toBe('a'.repeat(2000) + '... (line truncated to 2000 chars)');
      // A per-line cut is signalled ONLY by the inline suffix, never the global cap notice.
      expect(result).not.toContain('read cap');
    });

    it('per-line truncation applies on the tail path too (huge last line from tail 1)', async () => {
      // Drive the real tailFile chunk reader with an in-memory buffer whose last line is huge.
      const content = 'short\n' + 'b'.repeat(5000);
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

      const result: string = await readFileTool.invoke({ path: testPath, tail: 1 });

      expect(result).toBe('b'.repeat(2000) + '... (line truncated to 2000 chars)');
      expect(result).not.toContain('read cap');
    });
  });

  describe('read_multiple_files safety envelope (GS2-52)', () => {
    const smallPath = path.join(process.cwd(), 'small.txt');
    const bigPath = path.join(process.cwd(), 'big.txt');
    let readMultipleTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readMultipleTool = toolkit.tools.find((t) => t.name === 'read_multiple_files')!;
      // realpath echoes its input (outer beforeEach), so both paths validate.
    });

    it('small file stays byte-identical (verbatim fast-path, no cap notice)', async () => {
      fsMock.readFile.mockResolvedValue('alpha\nbeta\ngamma');

      const result: string = await readMultipleTool.invoke({ paths: [smallPath] });

      expect(result).toBe(`${smallPath}:\nalpha\nbeta\ngamma\n`);
      expect(result).not.toContain('read cap');
    });

    it('oversized file is capped to 2000 lines with a resume notice, not the whole file', async () => {
      const bigContent = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockResolvedValue(bigContent);

      const result: string = await readMultipleTool.invoke({ paths: [bigPath] });

      expect(result).toContain('read cap');
      // Resume points at the first dropped line so the model can page it with read_file.
      expect(result).toContain('offset:2001');
      expect(result).toContain('L2000'); // last kept line
      expect(result).not.toContain('L2001'); // first dropped line absent
      expect(result).not.toContain('L5000'); // late dropped line absent
    });

    it('mixed call: one small byte-identical + one oversized capped, each in its own segment', async () => {
      const bigContent = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n');
      fsMock.readFile.mockImplementation((p: string) =>
        Promise.resolve(p.includes('big') ? bigContent : 'alpha\nbeta\ngamma')
      );

      const result: string = await readMultipleTool.invoke({ paths: [smallPath, bigPath] });
      const segments = result.split('\n---\n');

      expect(segments).toHaveLength(2);
      // Small file: exact byte-identity (verbatim fast-path preserved through the multi-file path).
      expect(segments[0]).toBe(`${smallPath}:\nalpha\nbeta\ngamma\n`);
      expect(segments[0]).not.toContain('read cap');
      // Big file: capped with the resume notice.
      expect(segments[1]).toContain(`${bigPath}:`);
      expect(segments[1]).toContain('read cap');
      expect(segments[1]).toContain('offset:2001');
    });

    it('pathological single long line is per-line truncated with the marker and NO global notice', async () => {
      fsMock.readFile.mockResolvedValue('a'.repeat(5000)); // one line, no newline

      const result: string = await readMultipleTool.invoke({ paths: [bigPath] });

      expect(result).toBe(
        `${bigPath}:\n` + 'a'.repeat(2000) + '... (line truncated to 2000 chars)\n'
      );
      // A per-line cut is signalled ONLY by the inline suffix, never the global cap notice.
      expect(result).not.toContain('read cap');
    });

    it('a failing read returns its recoverable error string while siblings read normally', async () => {
      // The good path reads fine; the bad path rejects. The error is surfaced per-file and the
      // other file in the same call still returns its content.
      fsMock.readFile.mockImplementation((p: string) => {
        if (p.includes('big')) {
          return Promise.reject(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }));
        }
        return Promise.resolve('alpha\nbeta\ngamma');
      });

      const result: string = await readMultipleTool.invoke({ paths: [smallPath, bigPath] });
      const segments = result.split('\n---\n');

      expect(segments).toHaveLength(2);
      expect(segments[0]).toBe(`${smallPath}:\nalpha\nbeta\ngamma\n`);
      expect(segments[1]).toContain(`${bigPath}: Error -`);
      expect(segments[1]).toContain('EACCES');
    });
  });

  describe('read_file offset/limit vs head/tail combination (GS2-39)', () => {
    const testPath = path.join(process.cwd(), 'file.txt');
    let readFileTool: any;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
      readFileTool = toolkit.tools.find((t) => t.name === 'read_file')!;
      fsMock.readFile.mockResolvedValue('line1\nline2\nline3');
    });

    it('offset + head is rejected with a recoverable "not both" string (no throw, no FS access)', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 1, head: 2 });
      expect(result).toContain('not both');
      // Pure argument guard: it returns before touching the filesystem.
      expect(fsMock.readFile).not.toHaveBeenCalled();
      expect(fsMock.realpath).not.toHaveBeenCalled();
    });

    it('limit + tail is rejected with the same recoverable string', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, limit: 2, tail: 1 });
      expect(result).toContain('not both');
      expect(fsMock.readFile).not.toHaveBeenCalled();
    });

    it('offset + tail is rejected with the same recoverable string', async () => {
      const result: string = await readFileTool.invoke({ path: testPath, offset: 2, tail: 1 });
      expect(result).toContain('not both');
      expect(fsMock.readFile).not.toHaveBeenCalled();
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

    // GS2-36: an ambiguous edit is a RECOVERABLE errored result (naming the path + count), not a
    // fatal throw — a throw aborts the whole agent run. The model can add context and retry.
    it('ambiguous match without replaceAll returns a recoverable count-naming result and does NOT write', async () => {
      fsMock.readFile.mockResolvedValue('x = foo\ny = foo\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'foo', newText: 'bar' }],
      });

      expect(result).toContain(`Error editing file ${testPath}`);
      expect(result).toContain('found 2 occurrences of the search text');
      expect(result).toContain('replaceAll: true');
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    // GS2-36: no-match is a RECOVERABLE errored result (naming the path + an action-oriented hint),
    // not a fatal throw. The file is not modified and the run continues.
    it('no match at all returns a recoverable "no occurrence" result and does NOT write', async () => {
      fsMock.readFile.mockResolvedValue('nothing to see here\n');

      const result: string = await editTool.invoke({
        path: testPath,
        edits: [{ oldText: 'zzz', newText: 'yyy' }],
      });

      expect(result).toContain(`Error editing file ${testPath}`);
      expect(result).toContain('no occurrence of the search text was found');
      expect(result).toContain('file was NOT modified');
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

  // GS2-36: generalize the write_file precedent across the toolkit — a fatal throw (missing file,
  // denied / symlinked-out path, EISDIR, a deliberate refusal) must reach the model as a recoverable
  // errored RESULT (a string), never propagate and crash the run. One representative case per tool.
  describe('GS2-36: fatal-throw -> recoverable result across the toolkit', () => {
    const enoent = (op: string) =>
      Object.assign(new Error(`ENOENT: no such file or directory, ${op}`), { code: 'ENOENT' });
    const tool = (name: string) => toolkit.tools.find((t) => t.name === name)!;

    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
    });

    it('edit_file: a missing file returns a recoverable read error, not a throw', async () => {
      const p = path.join(process.cwd(), 'gone.txt');
      fsMock.readFile.mockRejectedValueOnce(enoent("open 'gone.txt'"));
      const result: string = await tool('edit_file').invoke({
        path: p,
        edits: [{ oldText: 'a', newText: 'b' }],
      });
      expect(result).toContain(`Error editing file ${p}`);
      expect(result).toContain('ENOENT');
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('edit_file: a path outside the sandbox is denied as a recoverable result and writes nothing', async () => {
      const outside = '/etc/passwd';
      const result: string = await tool('edit_file').invoke({
        path: outside,
        edits: [{ oldText: 'a', newText: 'b' }],
      });
      expect(result).toContain(`Error editing file ${outside}`);
      expect(result).toContain('Access denied');
      expect(fsMock.readFile).not.toHaveBeenCalled();
      expect(fsMock.writeFile).not.toHaveBeenCalled();
    });

    it('read_file: a missing file returns a recoverable result, not a throw', async () => {
      const p = path.join(process.cwd(), 'missing.txt');
      fsMock.readFile.mockRejectedValueOnce(enoent("open 'missing.txt'"));
      const result: string = await tool('read_file').invoke({ path: p });
      expect(result).toContain(`Error reading file ${p}`);
      expect(result).toContain('ENOENT');
    });

    it('list_directory: a missing directory returns a recoverable result, not a throw', async () => {
      const p = path.join(process.cwd(), 'nodir');
      fsMock.readdir.mockRejectedValueOnce(enoent("scandir 'nodir'"));
      const result: string = await tool('list_directory').invoke({ path: p });
      expect(result).toContain(`Error listing directory ${p}`);
      expect(result).toContain('ENOENT');
    });

    it('get_file_info: a missing target returns a recoverable result, not a throw', async () => {
      const p = path.join(process.cwd(), 'ghost');
      fsMock.stat.mockRejectedValueOnce(enoent("stat 'ghost'"));
      const result: string = await tool('get_file_info').invoke({ path: p });
      expect(result).toContain(`Error getting file info for ${p}`);
      expect(result).toContain('ENOENT');
    });

    it('create_directory: a path outside the sandbox is a recoverable denial (no mkdir)', async () => {
      const outside = '/etc/evil';
      const result: string = await tool('create_directory').invoke({ path: outside });
      expect(result).toContain(`Error creating directory ${outside}`);
      expect(result).toContain('Access denied');
      expect(fsMock.mkdir).not.toHaveBeenCalled();
    });

    it('move_file: a rename failure returns a recoverable result, not a throw', async () => {
      const src = path.join(process.cwd(), 'a.txt');
      const dst = path.join(process.cwd(), 'b.txt');
      fsMock.rename.mockRejectedValueOnce(enoent("rename 'a.txt'"));
      const result: string = await tool('move_file').invoke({ source: src, destination: dst });
      expect(result).toContain(`Error moving ${src} to ${dst}`);
      expect(result).toContain('ENOENT');
    });

    it('delete_file: the "this is a directory" refusal is a recoverable result and does not unlink', async () => {
      const p = path.join(process.cwd(), 'adir');
      fsMock.stat.mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false });
      const result: string = await tool('delete_file').invoke({ path: p });
      expect(result).toContain(`Error deleting file ${p}`);
      expect(result).toContain('Cannot delete directory');
      expect(fsMock.unlink).not.toHaveBeenCalled();
    });

    it('delete_directory: the protected-root refusal is a recoverable result (no rm)', async () => {
      // The sandbox root itself is a protected directory; deleting it must be refused recoverably.
      const result: string = await tool('delete_directory').invoke({
        path: process.cwd(),
        recursive: true,
      });
      expect(result).toContain(`Error deleting directory ${process.cwd()}`);
      expect(result).toContain('Cannot delete protected directory');
      expect(fsMock.rm).not.toHaveBeenCalled();
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

  // TUI-C32 residual b — fs tools must NOT print the legacy `📁 Reading/Writing/Editing file: …`
  // notice: the surface-agnostic tool-call block (`✓ 📁 name(args…)`, TUI-C30) now announces each
  // op once on both surfaces, so the old notice was a DL-10 double announcement. displayInfo is the
  // channel the legacy notice used; a single announcement means it is no longer called for fs ops.
  describe('single announcement (no legacy 📁 notice, TUI-C32 residual b)', () => {
    beforeEach(() => {
      toolkit = new GthFileSystemToolkit({ allowedDirectories: [process.cwd()] });
    });

    it('read_file announces exactly once (no displayInfo notice)', async () => {
      const testPath = path.join(process.cwd(), 'r.txt');
      fsMock.readFile.mockResolvedValue('hello');
      const readFile = toolkit.tools.find((t) => t.name === 'read_file')!;
      await readFile.invoke({ path: testPath });
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });

    it('write_file announces exactly once (no displayInfo notice)', async () => {
      const testPath = path.join(process.cwd(), 'w.txt');
      fsMock.writeFile.mockResolvedValue(undefined);
      fsMock.mkdir.mockResolvedValue(undefined);
      const writeFile = toolkit.tools.find((t) => t.name === 'write_file')!;
      await writeFile.invoke({ path: testPath, content: 'body' });
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });

    it('edit_file announces exactly once (no displayInfo notice)', async () => {
      const testPath = path.join(process.cwd(), 'e.txt');
      fsMock.readFile.mockResolvedValue('old');
      fsMock.writeFile.mockResolvedValue(undefined);
      const editFile = toolkit.tools.find((t) => t.name === 'edit_file')!;
      await editFile.invoke({ path: testPath, edits: [{ oldText: 'old', newText: 'new' }] });
      expect(consoleUtilsMock.displayInfo).not.toHaveBeenCalled();
    });
  });
});
