import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the filesystem + project-dir resolver so createNamedProfile's writes are observable and the
// target path is deterministic. The schema validator (schema.js → zod) stays REAL — we want the
// "never write an invalid profile" guard to run for real.
const fsMock = {
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
};
vi.mock('node:fs', () => fsMock);

const systemUtilsMock = {
  getProjectDir: vi.fn(),
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('config profiles — create/scaffold (GS2-33)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    systemUtilsMock.getProjectDir.mockReturnValue('/proj');
    fsMock.existsSync.mockReturnValue(false);
  });

  it('validateProfileName rejects empty / dot / traversal names and trims valid ones', async () => {
    const { validateProfileName } = await import('#src/config/profiles.js');
    expect(() => validateProfileName('')).toThrow(/must not be empty/);
    expect(() => validateProfileName('.')).toThrow(/Invalid profile name/);
    expect(() => validateProfileName('..')).toThrow(/Invalid profile name/);
    expect(() => validateProfileName('../evil')).toThrow(/Invalid profile name/);
    expect(() => validateProfileName('a/b')).toThrow(/Invalid profile name/);
    expect(validateProfileName('  cheap  ')).toBe('cheap');
    expect(validateProfileName('flash-lite_2.0')).toBe('flash-lite_2.0');
  });

  it('writes a schema-valid profile to .gsloth-settings/<name>/, seeded from --model', async () => {
    const { createNamedProfile } = await import('#src/config/profiles.js');
    const { validateRawGthConfig } = await import('#src/config/schema.js');

    const result = createNamedProfile('cheap', {
      seedType: 'google-genai',
      modelOverride: 'gemini-2.0-flash-lite',
    });

    expect(result.path).toBe('/proj/.gsloth/.gsloth-settings/cheap/.gsloth.config.json');
    expect(fsMock.mkdirSync).toHaveBeenCalledWith('/proj/.gsloth/.gsloth-settings/cheap', {
      recursive: true,
    });
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, content] = fsMock.writeFileSync.mock.calls[0];
    expect(writtenPath).toBe(result.path);
    const parsed = JSON.parse(content as string);
    expect(parsed).toEqual({ llm: { type: 'google-genai', model: 'gemini-2.0-flash-lite' } });
    // The written scaffold is genuinely schema-valid (the "never write an invalid profile" guard).
    expect(validateRawGthConfig(parsed).ok).toBe(true);
  });

  it('seeds provider + model from the current effective config when no --model is given', async () => {
    const { createNamedProfile } = await import('#src/config/profiles.js');
    createNamedProfile('mirror', { seedType: 'anthropic', seedModel: 'claude-sonnet-4-5' });
    const content = fsMock.writeFileSync.mock.calls[0][1] as string;
    expect(JSON.parse(content)).toEqual({ llm: { type: 'anthropic', model: 'claude-sonnet-4-5' } });
  });

  it('falls back to the template when neither a seed nor --model is available (module config)', async () => {
    const { createNamedProfile, DEFAULT_SCAFFOLD_PROVIDER, DEFAULT_SCAFFOLD_MODEL } =
      await import('#src/config/profiles.js');
    createNamedProfile('blank', {});
    const content = fsMock.writeFileSync.mock.calls[0][1] as string;
    expect(JSON.parse(content)).toEqual({
      llm: { type: DEFAULT_SCAFFOLD_PROVIDER, model: DEFAULT_SCAFFOLD_MODEL },
    });
  });

  it('rejects an invalid profile name WITHOUT writing or creating any directory', async () => {
    const { createNamedProfile } = await import('#src/config/profiles.js');
    expect(() => createNamedProfile('../evil', { modelOverride: 'x' })).toThrow(
      /Invalid profile name/
    );
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('refuses to overwrite an existing profile unless force is set', async () => {
    const { createNamedProfile } = await import('#src/config/profiles.js');
    fsMock.existsSync.mockReturnValue(true);

    expect(() => createNamedProfile('cheap', { modelOverride: 'x' })).toThrow(/already exists/);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();

    createNamedProfile('cheap', { modelOverride: 'x', force: true });
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
