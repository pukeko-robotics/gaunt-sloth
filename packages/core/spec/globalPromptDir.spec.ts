import { beforeEach, describe, expect, it, vi } from 'vitest';
import { basename, resolve } from 'node:path';

/**
 * CFG-89 (gaunt-sloth issue 482) — on a `--global` run, prompt files resolve from the global
 * directory the config was read from BEFORE the project, and fall back to the project and then the
 * bundled default exactly as before. A run without `--global` carries no such directory and must
 * resolve exactly as it always did.
 *
 * The filesystem is virtual, so nothing under the real home directory is read: the "global"
 * directory below is just another absolute path the spec owns.
 */

const PROJECT_DIR = resolve('/project');
const GLOBAL_PROFILE_DIR = resolve('/home/someone/.gsloth/.gsloth-settings/coder');

/** The virtual filesystem for one case: absolute path → contents. */
let files: Record<string, string>;

vi.mock('node:fs', () => ({
  existsSync: vi.fn((path: unknown) => Object.hasOwn(files, String(path))),
  readFileSync: vi.fn((path: unknown) => {
    const key = String(path);
    // Anything not in the virtual tree is the installed package's bundled default, reached by
    // absolute path through `readFileFromInstallDir`.
    return Object.hasOwn(files, key) ? files[key] : `BUNDLED ${basename(key)}`;
  }),
}));

vi.mock('#src/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/utils/systemUtils.js')>()),
  getProjectDir: vi.fn(() => PROJECT_DIR),
  getCurrentWorkDir: vi.fn(() => PROJECT_DIR),
}));

const inProject = (name: string) => resolve(PROJECT_DIR, name);
const inGlobal = (name: string) => resolve(GLOBAL_PROFILE_DIR, name);

describe('CFG-89 — prompt files on a --global run', () => {
  beforeEach(() => {
    files = {};
  });

  it("reads a configured relative path from the global profile directory (the issue's reproduction)", async () => {
    files[inGlobal('coder-exec.md')] = 'GLOBAL coder-exec';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    const exec = readPromptSegment('exec', {
      prompts: { exec: { path: 'coder-exec.md', mode: 'append' } },
      identityProfile: 'coder',
      globalConfigDir: GLOBAL_PROFILE_DIR,
    });

    expect(exec).toBe('BUNDLED .gsloth.exec.md\nGLOBAL coder-exec');
  });

  it('lets a default-named file in the global directory replace the bundled default', async () => {
    files[inGlobal('.gsloth.guidelines.md')] = 'GLOBAL guidelines';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    expect(
      readPromptSegment('guidelines', {
        identityProfile: 'coder',
        globalConfigDir: GLOBAL_PROFILE_DIR,
      })
    ).toBe('GLOBAL guidelines');
  });

  it('prefers the global file over a project file of the same name under --global', async () => {
    files[inGlobal('.gsloth.guidelines.md')] = 'GLOBAL guidelines';
    files[inProject('.gsloth.guidelines.md')] = 'PROJECT guidelines';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    expect(readPromptSegment('guidelines', { globalConfigDir: GLOBAL_PROFILE_DIR })).toBe(
      'GLOBAL guidelines'
    );
  });

  it('reads the project file when the run is not --global, even if a global file exists', async () => {
    files[inGlobal('.gsloth.guidelines.md')] = 'GLOBAL guidelines';
    files[inProject('.gsloth.guidelines.md')] = 'PROJECT guidelines';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    expect(readPromptSegment('guidelines', {})).toBe('PROJECT guidelines');
  });

  it('still resolves a path that exists only in the project under --global', async () => {
    files[inProject('STANDARDS.md')] = 'PROJECT standards';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    expect(
      readPromptSegment('guidelines', {
        prompts: { guidelines: 'STANDARDS.md' },
        globalConfigDir: GLOBAL_PROFILE_DIR,
      })
    ).toBe('PROJECT standards');
  });

  it('still reads an absolute path as given under --global', async () => {
    const absolute = resolve('/elsewhere/rules.md');
    files[absolute] = 'ABSOLUTE rules';
    const { readPromptSegment } = await import('#src/utils/llmUtils.js');

    expect(
      readPromptSegment('guidelines', {
        prompts: { guidelines: absolute },
        globalConfigDir: GLOBAL_PROFILE_DIR,
      })
    ).toBe('ABSOLUTE rules');
  });

  it('resolves a scoped prompt path from the global directory too', async () => {
    files[inGlobal('scoped-api.md')] = 'GLOBAL scoped';
    const { resolveScopedSegmentPath } = await import('#src/utils/llmUtils.js');

    expect(resolveScopedSegmentPath('scoped-api.md', 'coder', GLOBAL_PROFILE_DIR)).toEqual({
      resolved: inGlobal('scoped-api.md'),
      exists: true,
    });
  });
});
