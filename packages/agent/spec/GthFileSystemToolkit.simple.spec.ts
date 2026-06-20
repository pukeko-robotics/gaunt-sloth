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
