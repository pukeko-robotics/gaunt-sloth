import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the fs module
let fsUtilsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsUtilsMock);

// Mock the systemUtils module
const systemUtilsMock = {
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  exit: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

// Mock the consoleUtils module
const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayInfo: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

describe('utils', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock values
    systemUtilsMock.getCurrentWorkDir.mockReturnValue('/mock/project/dir');
    systemUtilsMock.getProjectDir.mockReturnValue('/mock/project/dir');
  });

  describe('generateStandardFileName', () => {
    it('should generate filename with prefix, date, time and command', async () => {
      // Mock the Date object to return a fixed date and time
      const originalDate = global.Date;
      const mockDate = new Date('2025-05-17T21:45:30');
      global.Date = class extends Date {
        constructor() {
          super();
          return mockDate;
        }
      } as typeof Date;

      try {
        // Import the function after mocks are set up
        const { generateStandardFileName, toFileSafeString } =
          await import('#src/utils/fileUtils.js');

        // Define test commands
        const commands = ['ASK', 'REVIEW', 'PR-123'];

        for (const command of commands) {
          // Act
          const result = generateStandardFileName(command);

          // Assert
          expect(result).toBe(
            `gth_2025-05-17_21-45-30_${toFileSafeString(command.toUpperCase())}.md`
          );
          expect(result).toMatch(/^gth_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Z0-9-]+\.md$/);

          // Verify parts of the filename
          const parts = result.replace('.md', '').split('_');
          expect(parts[0]).toBe('gth');
          expect(parts[1]).toBe('2025-05-17'); // date
          expect(parts[2]).toBe('21-45-30'); // time
          expect(parts[3]).toBe(toFileSafeString(command.toUpperCase())); // command
        }
      } finally {
        // Restore the original Date
        global.Date = originalDate;
      }
    });
  });

  describe('readMultipleFilesFromProjectDir', () => {
    it('should read file from project directory if it exists', async () => {
      // Arrange
      const fileName = 'test.file';
      const projectDirPath = '/mock/project/dir';
      const filePath = resolve(projectDirPath, fileName);
      const fileContent = 'file content from project dir';

      fsUtilsMock.readFileSync.mockReturnValue(fileContent);

      // Import the function after mocks are set up
      const { readFileFromProjectDir } = await import('#src/utils/fileUtils.js');

      // Act
      const result = readFileFromProjectDir(fileName);

      // Assert
      expect(result).toBe(fileContent);
      expect(fsUtilsMock.writeFileSync).not.toHaveBeenCalled();
      expect(fsUtilsMock.readFileSync).toHaveBeenCalledWith(filePath, { encoding: 'utf8' });
      expect(systemUtilsMock.getProjectDir).toHaveBeenCalled();
      expect(consoleUtilsMock.displayInfo).toHaveBeenCalledWith(expect.stringContaining('Reading'));
    });

    it('should exit with error if file not found in install directory', async () => {
      // Arrange
      const fileName = 'test.file';

      // Mock readFileSync to throw ENOENT
      const enoentError = new Error('File not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';

      fsUtilsMock.readFileSync.mockImplementation(() => {
        throw enoentError;
      });

      // Import the function after mocks are set up
      const { readFileFromInstallDir } = await import('#src/utils/fileUtils.js');

      // Act & Assert
      expect(() => readFileFromInstallDir(fileName)).toThrow();
      expect(fsUtilsMock.writeFileSync).not.toHaveBeenCalled();
      expect(fsUtilsMock.readFileSync).toHaveBeenCalledWith(expect.stringContaining(fileName), {
        encoding: 'utf8',
      });
      expect(consoleUtilsMock.displayError).toHaveBeenCalledWith(expect.stringContaining(fileName));
    });

    it('should read a single file and wrap its content', async () => {
      fsUtilsMock.readFileSync.mockReturnValue('SINGLE FILE CONTENT');

      const { readMultipleFilesFromProjectDir } = await import('#src/utils/fileUtils.js');

      const result = readMultipleFilesFromProjectDir('one.file');

      expect(result).toContain('SINGLE FILE CONTENT');
      expect(result).toContain('file one.file');
      expect(fsUtilsMock.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should read multiple files and join their wrapped contents', async () => {
      fsUtilsMock.readFileSync.mockImplementation((filePath: string) => {
        if (filePath.includes('a.file')) return 'A CONTENT';
        if (filePath.includes('b.file')) return 'B CONTENT';
        return '';
      });

      const { readMultipleFilesFromProjectDir } = await import('#src/utils/fileUtils.js');

      const result = readMultipleFilesFromProjectDir(['a.file', 'b.file']);

      expect(result).toContain('A CONTENT');
      expect(result).toContain('B CONTENT');
      expect(result).toContain('file a.file');
      expect(result).toContain('file b.file');
      // A comes before B in the joined output
      expect(result.indexOf('A CONTENT')).toBeLessThan(result.indexOf('B CONTENT'));
      expect(fsUtilsMock.readFileSync).toHaveBeenCalledTimes(2);
    });
  });
});
