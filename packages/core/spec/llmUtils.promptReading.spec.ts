import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { sep } from 'path';
import { platform } from 'node:os';

// Mock dependencies
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('#src/utils/systemUtils.js', () => ({
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  getUseColour: vi.fn().mockReturnValue(false),
}));

/**
 * The logic is following:
 * if .gsloth dir exists - look for file in projectDir/.gsloth/.gsloth-settings/
 * if .gsloth dir exists, but file isn't there - fall back to projectDir/filename
 * if .gsloth does not exitst - look for file in projectDir/filename
 * if none of above exists - look for file in install dir
 */
describe('prompt reading functions', async () => {
  const prefix = platform() == 'win32' ? 'C:\\' : '/';
  const mockProjectDir = `${prefix}project`;

  const systemUtils = await import('#src/utils/systemUtils.js');
  const prompt = await import('#src/utils/llmUtils.js');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(systemUtils, 'getCurrentWorkDir').mockReturnValue(mockProjectDir);
    vi.spyOn(systemUtils, 'getProjectDir').mockReturnValue(mockProjectDir);

    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  const testCases = [
    { name: 'readGuidelines', filename: 'guidelines.md', acceptsParam: true },
    { name: 'readReviewInstructions', filename: 'review.md', acceptsParam: true },
    { name: 'readBackstory', filename: '.gsloth.backstory.md' },
    { name: 'readSystemPrompt', filename: '.gsloth.system.md' },
    { name: 'readChatPrompt', filename: '.gsloth.chat.md' },
    { name: 'readCodePrompt', filename: '.gsloth.code.md' },
  ];

  testCases.forEach(({ name, filename, acceptsParam }) => {
    describe(name, () => {
      test(`reads ${filename} from .gsloth directory when present`, () => {
        const gslothDirPath = `${mockProjectDir}${sep}.gsloth`;
        const filePath = `${gslothDirPath}${sep}.gsloth-settings${sep}${filename}`;
        vi.mocked(fs.existsSync).mockImplementation((path) =>
          [gslothDirPath, filePath].includes(String(path))
        );
        vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
          if (String(path) === filePath) return 'gsloth content';
          throw new Error('not found');
        });

        let func = (prompt as any)[name] as (_?: string) => string;
        let result;
        if (acceptsParam) {
          result = func(filename);
        } else {
          result = func({} as any);
        }
        expect(result).toBe('gsloth content');
        expect(fs.readFileSync).toHaveBeenCalledWith(filePath, { encoding: 'utf8' });
      });

      test(`reads ${filename} from project directory when not in .gsloth`, () => {
        const filePath = `${mockProjectDir}${sep}${filename}`;

        vi.mocked(fs.existsSync).mockImplementation((path) => [filePath].includes(String(path)));
        vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
          if (String(path) === filePath) return 'current content';
          throw new Error('not found');
        });

        let func = (prompt as any)[name] as (_?: string) => string;
        let result;
        if (acceptsParam) {
          result = func(filename);
        } else {
          result = func({} as any);
        }
        expect(result).toBe('current content');
        expect(fs.readFileSync).toHaveBeenCalledWith(filePath, { encoding: 'utf8' });
      });

      test(`reads ${filename} from install directory when file neither exists in .gsloth nor in project dir`, () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
          if (String(path).endsWith(filename)) return 'install content';
          throw new Error('not found');
        });

        let func = (prompt as any)[name] as (_?: string) => string;
        let result;
        if (acceptsParam) {
          result = func(filename);
        } else {
          result = func({} as any);
        }
        expect(result).toBe('install content');
        expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining(filename), {
          encoding: 'utf8',
        });
      });

      test(`throws error when ${filename} not found anywhere`, () => {
        vi.mocked(fs.existsSync).mockReturnValue(false);
        vi.mocked(fs.readFileSync).mockImplementation(() => {
          throw new Error();
        });

        let func = (prompt as any)[name] as (_?: string) => string;
        if (acceptsParam) {
          expect(() => func(filename)).toThrow();
        } else {
          expect(() => func({} as any)).toThrow();
        }
      });
    });
  });

  describe('readGuidelines formatting with organization', () => {
    test('appends organization, locale/timezone and date when enabled', () => {
      const filename = 'guidelines.md';
      const filePath = `${mockProjectDir}${sep}${filename}`;

      vi.mocked(fs.existsSync).mockImplementation((path) => [filePath].includes(String(path)));
      vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
        if (String(path) === filePath) return 'Guidelines content';
        throw new Error('not found');
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-08-25T10:20:30.000Z'));

      const cfg = {
        prompts: { guidelines: filename },
        includeCurrentDateAfterGuidelines: true,
        organization: { name: 'Dancing Kakapo', locale: 'en-NZ', timezone: 'Pacific/Auckland' },
      };

      const result = (prompt as any).readGuidelines(cfg);

      expect(result).toContain('Guidelines content');
      expect(result).toContain('Organization: Dancing Kakapo');
      expect(result).toContain(
        'Current Date: 2024-08-25T10:20:30.000Z - Sunday, 25 August 2024 at 10:20:30 pm NZST'
      );
      expect(fs.readFileSync).toHaveBeenCalledWith(filePath, { encoding: 'utf8' });

      vi.useRealTimers();
    });

    test('Only includes UTC time when no org details provided', () => {
      const filename = 'guidelines.md';
      const filePath = `${mockProjectDir}${sep}${filename}`;

      vi.mocked(fs.existsSync).mockImplementation((path) => [filePath].includes(String(path)));
      vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
        if (String(path) === filePath) return 'Guidelines content';
        throw new Error('not found');
      });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-08-25T10:20:30.000Z'));

      const cfg = {
        prompts: { guidelines: filename },
        includeCurrentDateAfterGuidelines: true,
      };

      const result = (prompt as any).readGuidelines(cfg);

      expect(result).not.toContain('Organization');
      expect(result).toContain('Current Date: 2024-08-25T10:20:30.000Z');
      expect(result).not.toContain(' - ');
      expect(fs.readFileSync).toHaveBeenCalledWith(filePath, { encoding: 'utf8' });

      vi.useRealTimers();
    });
  });
});

// Identity profile variations
describe('prompt reading with identityProfile variations', async () => {
  const prefix = platform() == 'win32' ? 'C:\\' : '/';
  const mockProjectDir = `${prefix}project`;

  const systemUtils = await import('#src/utils/systemUtils.js');
  const prompt = await import('#src/utils/llmUtils.js');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(systemUtils, 'getCurrentWorkDir').mockReturnValue(mockProjectDir);
    vi.spyOn(systemUtils, 'getProjectDir').mockReturnValue(mockProjectDir);

    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  test('readBackstory reads from profile-specific .gsloth-settings when present', () => {
    const profile = 'probox';
    const gslothDirPath = `${mockProjectDir}${sep}.gsloth`;
    const profileFilePath = `${gslothDirPath}${sep}.gsloth-settings${sep}${profile}${sep}.gsloth.backstory.md`;

    vi.mocked(fs.existsSync).mockImplementation((path) =>
      [gslothDirPath, profileFilePath].includes(String(path))
    );
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === profileFilePath) return 'profile content';
      throw new Error('not found');
    });

    const result = (prompt as any).readBackstory({ identityProfile: profile });
    expect(result).toBe('profile content');
    expect(fs.readFileSync).toHaveBeenCalledWith(profileFilePath, { encoding: 'utf8' });
  });

  test('readBackstory does NOT fall back to non-profile .gsloth-settings; uses install dir when project root also missing', () => {
    const profile = 'probox';
    const gslothDirPath = `${mockProjectDir}${sep}.gsloth`;

    vi.mocked(fs.existsSync).mockImplementation((path) => [gslothDirPath].includes(String(path)));
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith('.gsloth.backstory.md')) return 'install content';
      throw new Error('not found');
    });

    const result = (prompt as any).readBackstory({ identityProfile: profile });
    expect(result).toBe('install content');
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining('.gsloth.backstory.md'), {
      encoding: 'utf8',
    });
  });

  test('readBackstory falls back to project root when not in .gsloth-settings', () => {
    const profile = 'probox';
    const projectRootPath = `${mockProjectDir}${sep}.gsloth.backstory.md`;

    vi.mocked(fs.existsSync).mockImplementation((path) => [projectRootPath].includes(String(path)));
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === projectRootPath) return 'project content';
      throw new Error('not found');
    });

    const result = (prompt as any).readBackstory({ identityProfile: profile });
    expect(result).toBe('project content');
    expect(fs.readFileSync).toHaveBeenCalledWith(projectRootPath, { encoding: 'utf8' });
  });

  test('readGuidelines with config uses profile .gsloth-settings/profile/guidelines.md when present', () => {
    const profile = 'dumpling';
    const filename = 'guidelines.md';
    const gslothDirPath = `${mockProjectDir}${sep}.gsloth`;
    const profileFilePath = `${gslothDirPath}${sep}.gsloth-settings${sep}${profile}${sep}${filename}`;

    vi.mocked(fs.existsSync).mockImplementation((path) =>
      [gslothDirPath, profileFilePath].includes(String(path))
    );
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === profileFilePath) return 'profile guidelines';
      throw new Error('not found');
    });

    const result = (prompt as any).readGuidelines({
      prompts: { guidelines: filename },
      includeCurrentDateAfterGuidelines: false,
      identityProfile: profile,
    });
    expect(result).toBe('profile guidelines');
    expect(fs.readFileSync).toHaveBeenCalledWith(profileFilePath, { encoding: 'utf8' });
  });

  test('readGuidelines with config falls back to install dir when not found elsewhere', () => {
    const profile = 'dumpling';
    const filename = 'guidelines.md';

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path).endsWith(filename)) return 'install guidelines';
      throw new Error('not found');
    });

    const result = (prompt as any).readGuidelines({
      prompts: { guidelines: filename },
      includeCurrentDateAfterGuidelines: false,
      identityProfile: profile,
    });
    expect(result).toBe('install guidelines');
    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining(filename), {
      encoding: 'utf8',
    });
  });
});

// noDefaultPrompts tests
describe('noDefaultPrompts behavior', async () => {
  const prefix = platform() == 'win32' ? 'C:\\' : '/';
  const mockProjectDir = `${prefix}project`;

  const systemUtils = await import('#src/utils/systemUtils.js');
  const prompt = await import('#src/utils/llmUtils.js');

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(systemUtils, 'getCurrentWorkDir').mockReturnValue(mockProjectDir);
    vi.spyOn(systemUtils, 'getProjectDir').mockReturnValue(mockProjectDir);

    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  test('readBackstory returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readBackstory({ noDefaultPrompts: true });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readSystemPrompt returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readSystemPrompt({ noDefaultPrompts: true });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readChatPrompt returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readChatPrompt({ noDefaultPrompts: true });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readCodePrompt returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readCodePrompt({ noDefaultPrompts: true });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readGuidelines returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readGuidelines({
      includeCurrentDateAfterGuidelines: false,
      noDefaultPrompts: true,
    });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readReviewInstructions returns empty string when noDefaultPrompts is true and file not found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = (prompt as any).readReviewInstructions({
      noDefaultPrompts: true,
    });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('readBackstory still reads user file when noDefaultPrompts is true and file exists', () => {
    const filePath = `${mockProjectDir}${sep}.gsloth.backstory.md`;

    vi.mocked(fs.existsSync).mockImplementation((path) => [filePath].includes(String(path)));
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === filePath) return 'user backstory';
      throw new Error('not found');
    });

    const result = (prompt as any).readBackstory({ noDefaultPrompts: true });
    expect(result).toBe('user backstory');
  });
});

// GS2-43 — the unified `prompts` config object semantics at the composition point
describe('prompts config segments (GS2-43)', async () => {
  const prefix = platform() == 'win32' ? 'C:\\' : '/';
  const mockProjectDir = `${prefix}project`;

  const systemUtils = await import('#src/utils/systemUtils.js');
  const prompt = await import('#src/utils/llmUtils.js');

  /** Wires the fs mocks so exactly the given project-root files exist with the given content. */
  const givenProjectFiles = (files: Record<string, string>) => {
    const paths = new Map(
      Object.entries(files).map(([name, content]) => [`${mockProjectDir}${sep}${name}`, content])
    );
    vi.mocked(fs.existsSync).mockImplementation((path) => paths.has(String(path)));
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      const content = paths.get(String(path));
      if (content !== undefined) return content;
      // Anything else resolves as an install-dir (bundled default) read.
      return `bundled:${String(path).split(sep).pop()}`;
    });
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(systemUtils, 'getCurrentWorkDir').mockReturnValue(mockProjectDir);
    vi.spyOn(systemUtils, 'getProjectDir').mockReturnValue(mockProjectDir);

    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.readFileSync).mockReset();
  });

  test('string shorthand retargets a segment (≡ { path }, replace)', () => {
    givenProjectFiles({ 'AGENTS.md': 'agents content' });

    const result = (prompt as any).readGuidelines({
      prompts: { guidelines: 'AGENTS.md' },
      includeCurrentDateAfterGuidelines: false,
    });
    expect(result).toBe('agents content');
  });

  test('object form { path } retargets a segment (replace is the default mode)', () => {
    givenProjectFiles({
      'my-backstory.md': 'custom backstory',
      '.gsloth.backstory.md': 'default backstory',
    });

    const result = (prompt as any).readBackstory({
      prompts: { backstory: { path: 'my-backstory.md' } },
    });
    expect(result).toBe('custom backstory');
  });

  test('previously-hardcoded segments (code) are retargetable through prompts', () => {
    givenProjectFiles({ 'my-code-prompt.md': 'custom code prompt' });

    const result = (prompt as any).readCodePrompt({
      prompts: { code: 'my-code-prompt.md' },
    });
    expect(result).toBe('custom code prompt');
  });

  test('enabled: false drops the segment entirely — even the bundled default', () => {
    // No project files at all: without the setting the bundled default would be returned.
    givenProjectFiles({});

    const result = (prompt as any).readReviewInstructions({
      prompts: { review: { enabled: false } },
    });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test('enabled: false wins over a configured path', () => {
    givenProjectFiles({ 'extra.md': 'extra' });

    const result = (prompt as any).readChatPrompt({
      prompts: { chat: { path: 'extra.md', enabled: false } },
    });
    expect(result).toBe('');
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  test("mode: 'append' appends the file after the built-in content (project default file)", () => {
    givenProjectFiles({
      '.gsloth.guidelines.md': 'base guidelines',
      'extra-guidelines.md': 'extra guidelines',
    });

    const result = (prompt as any).readGuidelines({
      prompts: { guidelines: { path: 'extra-guidelines.md', mode: 'append' } },
      includeCurrentDateAfterGuidelines: false,
    });
    expect(result).toBe('base guidelines\nextra guidelines');
  });

  test("mode: 'append' appends after the bundled default when no user default file exists", () => {
    givenProjectFiles({ 'extra-exec.md': 'extra exec' });

    const result = (prompt as any).readExecPrompt({
      prompts: { exec: { path: 'extra-exec.md', mode: 'append' } },
    });
    expect(result).toBe('bundled:.gsloth.exec.md\nextra exec');
  });

  test('a segment left unset resolves exactly as before (default-named file)', () => {
    givenProjectFiles({ '.gsloth.system.md': 'project system prompt' });

    const result = (prompt as any).readSystemPrompt({ prompts: { guidelines: 'AGENTS.md' } });
    expect(result).toBe('project system prompt');
  });
});
