import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// Mock fs module
const fsMock = {
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

// Mock debugUtils to avoid debug output during tests
const debugUtilsMock = {
  debugLog: vi.fn(),
};
vi.mock('#src/utils/debugUtils.js', () => debugUtilsMock);

describe('aiignoreUtils', () => {
  let loadAiignorePatterns: typeof import('#src/utils/aiignoreUtils.js').loadAiignorePatterns;
  let shouldIgnoreFile: typeof import('#src/utils/aiignoreUtils.js').shouldIgnoreFile;
  let filterIgnoredFiles: typeof import('#src/utils/aiignoreUtils.js').filterIgnoredFiles;

  beforeAll(async () => {
    const module = await import('#src/utils/aiignoreUtils.js');
    loadAiignorePatterns = module.loadAiignorePatterns;
    shouldIgnoreFile = module.shouldIgnoreFile;
    filterIgnoredFiles = module.filterIgnoredFiles;
  });
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('loadAiignorePatterns', () => {
    // '/test/path' is a POSIX-literal fixture; loadAiignorePatterns uses path.join (native), so
    // on win32 the mock is called with '\test\path\.aiignore', not the POSIX literal asserted
    // here. Real callers pass a real (platform-native) rootDir, so this is a test-fixture gap,
    // not a real bug.
    it.skipIf(process.platform === 'win32')(
      'should return empty array when .aiignore file does not exist',
      () => {
        fsMock.existsSync.mockReturnValue(false);

        const patterns = loadAiignorePatterns('/test/path');

        expect(patterns).toEqual([]);
        expect(fsMock.existsSync).toHaveBeenCalledWith('/test/path/.aiignore');
      }
    );

    it.skipIf(process.platform === 'win32')('should load patterns from .aiignore file', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('node_modules\n*.log\n# This is a comment\ntemp/\n');

      const patterns = loadAiignorePatterns('/test/path');

      expect(patterns).toEqual(['node_modules', '*.log', 'temp/']);
      expect(fsMock.readFileSync).toHaveBeenCalledWith('/test/path/.aiignore', 'utf-8');
    });

    it('should handle empty .aiignore file', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('');

      const patterns = loadAiignorePatterns('/test/path');

      expect(patterns).toEqual([]);
    });

    it('should handle .aiignore file with only comments', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('# Comment 1\n# Comment 2\n');

      const patterns = loadAiignorePatterns('/test/path');

      expect(patterns).toEqual([]);
    });
  });

  describe('shouldIgnoreFile', () => {
    it('should return false when aiignore is disabled', () => {
      const result = shouldIgnoreFile('/test/file.txt', '/test', undefined, false);
      expect(result).toBe(false);
    });

    it('should return false when no patterns are provided', () => {
      const result = shouldIgnoreFile('/test/file.txt', '/test', undefined, true);
      expect(result).toBe(false);
    });

    it('should return false when file does not match any pattern', () => {
      const patterns = ['*.log', 'temp/'];
      const result = shouldIgnoreFile('/test/file.txt', '/test', patterns, true);
      expect(result).toBe(false);
    });

    it('should return true when file matches a pattern', () => {
      const patterns = ['*.log', 'temp/'];
      const result = shouldIgnoreFile('/test/file.log', '/test', patterns, true);
      expect(result).toBe(true);
    });

    it('should match patterns with directory paths', () => {
      const patterns = ['temp/*', 'logs/**'];
      const result = shouldIgnoreFile('/test/temp/file.txt', '/test', patterns, true);
      expect(result).toBe(true);
    });
  });

  describe('filterIgnoredFiles', () => {
    it('should return all files when aiignore is disabled', () => {
      const files = ['/test/file1.txt', '/test/file2.log', '/test/temp/file3.txt'];
      const result = filterIgnoredFiles(files, '/test', ['*.log', 'temp/*'], false);

      expect(result).toEqual(files);
    });

    it('should filter out ignored files', () => {
      const files = ['/test/file1.txt', '/test/file2.log', '/test/temp/file3.txt'];
      const patterns = ['*.log', 'temp/*'];
      const result = filterIgnoredFiles(files, '/test', patterns, true);

      expect(result).toEqual(['/test/file1.txt']);
    });

    it('should return all files when no patterns match', () => {
      const files = ['/test/file1.txt', '/test/file2.txt'];
      const patterns = ['*.log', 'temp/*'];
      const result = filterIgnoredFiles(files, '/test', patterns, true);

      expect(result).toEqual(files);
    });
  });

  /**
   * `.gitignore` matching rules (GS2-83), and a directory line hiding its own name *and* its
   * contents (GS2-86).
   *
   * These are the assertions that make the documentation true. `docs/configuration/index.md`
   * publishes the same three samples twice — once as a `.aiignore` file and once as
   * `aiignore.patterns` in config — and those are two different entry points into this module:
   * the file goes through `loadAiignorePatterns`, the config array arrives as `customPatterns` and
   * skips it entirely. A matrix run through only one of them proves half the page, so
   * {@link forEachEntryPoint} runs every documented case through both.
   *
   * Every sample is paired with a near-miss control that differs only in the segment the pattern
   * discriminates on (`distribution/` against `dist/`, `app.logger` against `*.log`). Without the
   * control each case still passes when the matcher hides everything, which is the failure a
   * privacy boundary is most likely to be "fixed" into.
   *
   * Paths are assembled with `path.join` rather than written as POSIX literals: `shouldIgnoreFile`
   * calls `path.relative`, which yields backslashes on win32, and a literal would pin this suite to
   * one platform's separator.
   */
  describe('gitignore matching rules (GS2-83) and directory coverage (GS2-86)', () => {
    const root = path.resolve(path.sep, 'test', 'project');
    /** Join workdir-relative segments into the absolute path a filesystem tool would hand over. */
    const at = (relative: string): string => path.join(root, ...relative.split('/'));

    /**
     * Bind a pattern set, returning an assertion that runs each case through BOTH entry points:
     * `aiignore.patterns` from config (`customPatterns`), and a real `.aiignore` file read off
     * disk (via the mocked `node:fs`). A failure names the path, the patterns and the entry point,
     * so a divergence between the two is legible without a debugger.
     */
    const check = (patterns: string[]) => {
      const viaConfig = (relative: string): boolean =>
        shouldIgnoreFile(at(relative), root, patterns, true);
      const viaFile = (relative: string): boolean => {
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readFileSync.mockReturnValue(patterns.join('\n') + '\n');
        return shouldIgnoreFile(at(relative), root, undefined, true);
      };
      return (relative: string, expected: boolean) => {
        const where = `${relative} against ${JSON.stringify(patterns)}`;
        expect(viaConfig(relative), `${where} via aiignore.patterns config`).toBe(expected);
        expect(viaFile(relative), `${where} via .aiignore file`).toBe(expected);
      };
    };

    describe('the samples published in docs/configuration/index.md', () => {
      it('node_modules/ hides the directory and everything under it', () => {
        const expectIgnored = check(['node_modules/']);
        expectIgnored('node_modules', true); // the name itself
        expectIgnored('node_modules/pkg/index.js', true); // its contents, at depth
        expectIgnored('node_modules_backup/pkg.js', false); // near-miss control
      });

      it('dist/ hides the directory and everything under it', () => {
        const expectIgnored = check(['dist/']);
        expectIgnored('dist', true);
        expectIgnored('dist/main.js', true);
        expectIgnored('dist/nested/deep/chunk.js', true);
        expectIgnored('distribution/main.js', false); // near-miss control
        expectIgnored('src/main.js', false); // unrelated control
      });

      it('*.log hides matching files at every depth, not only at the root', () => {
        const expectIgnored = check(['*.log']);
        expectIgnored('app.log', true);
        expectIgnored('sub/app.log', true); // the case that silently failed before
        expectIgnored('a/b/c/deep.log', true);
        expectIgnored('app.logger', false); // near-miss control
      });

      // The documentation's `secrets.txt` row: a separator-free pattern with NO wildcard. The
      // wildcard cases above do not cover it — they could pass through the glob machinery while a
      // plain literal took some other path — and every other published row has an assertion, so
      // this one gets one too rather than resting on inference.
      it('a wildcard-free bare pattern applies at every depth', () => {
        const expectIgnored = check(['secrets.txt']);
        expectIgnored('secrets.txt', true);
        expectIgnored('sub/secrets.txt', true);
        expectIgnored('a/b/c/secrets.txt', true);
        expectIgnored('secrets.txt.bak', false); // near-miss control
        expectIgnored('my-secrets.txt', false); // segment match, not substring
      });
    });

    describe('one line hides a directory name and its contents (GS2-86)', () => {
      // The whole point of GS2-86: before this, hiding both halves needed two lines
      // (`secretdir` and `secretdir/**`) and nothing told the user so. `secretdir` is used rather
      // than `dist` or `node_modules` because those two are in the toolkit's hard-coded noise list,
      // where a short-circuit could satisfy the assertion without the matcher doing anything.
      it('a bare directory pattern covers the name, the contents, and any depth', () => {
        const expectIgnored = check(['secretdir']);
        expectIgnored('secretdir', true);
        expectIgnored('secretdir/inside.txt', true);
        expectIgnored('secretdir/nested/deeper.txt', true);
        expectIgnored('nested/secretdir', true); // bare patterns apply at every depth
        expectIgnored('nested/secretdir/inside.txt', true);
        expectIgnored('secretdir-public/ok.txt', false); // shares the name as a prefix
      });

      it('the trailing-slash spelling behaves identically', () => {
        const expectIgnored = check(['secretdir/']);
        expectIgnored('secretdir', true);
        expectIgnored('secretdir/inside.txt', true);
        expectIgnored('secretdir-public/ok.txt', false);
      });
    });

    describe('anchoring', () => {
      it('a pattern containing a separator is anchored to the root', () => {
        const expectIgnored = check(['build/out']);
        expectIgnored('build/out', true);
        expectIgnored('build/out/artifact.js', true);
        expectIgnored('src/build/out', false); // anchored: not matched at depth
      });

      it('a leading slash anchors an otherwise-bare pattern', () => {
        const expectIgnored = check(['/dist']);
        expectIgnored('dist', true);
        expectIgnored('dist/main.js', true);
        expectIgnored('sub/dist/main.js', false); // anchored by the leading slash
      });
    });

    describe('degenerate and unsupported lines hide nothing extra', () => {
      // A line that reduces to an empty pattern must not collapse into a match-everything glob:
      // that would hide the entire tree and read to the user as the tool being broken.
      it.each([['/'], ['///'], ['']])('a slash-only or empty line (%j) matches nothing', (line) => {
        const expectIgnored = check([line]);
        expectIgnored('anything.txt', false);
        expectIgnored('nested/anything.txt', false);
      });

      it('a negation line is literal and un-hides nothing', () => {
        // Re-inclusion is not supported. The safe direction is that `!x` fails to re-expose a file
        // another line hid, which is what this pins; the documentation states the limitation.
        const expectIgnored = check(['*.log', '!important.log']);
        expectIgnored('important.log', true);
      });
    });
  });
});
