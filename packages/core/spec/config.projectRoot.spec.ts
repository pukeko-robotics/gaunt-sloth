import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// Real fs + temp dirs + real systemUtils (no systemUtils mock): the point of this spec is to
// exercise the genuine setProjectDir/getProjectDir state, so inert vi.fn() stubs would prove
// nothing. cwd is driven via INIT_CWD, which getCurrentWorkDir() honours before process.cwd().
import { getProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { getGslothConfigReadPath } from '#src/utils/fileUtils.js';

// Mock only the provider so initConfig can complete without live credentials.
const processJsonConfig = vi.fn();
vi.mock('#src/providers/vertexai.js', () => ({
  processJsonConfig,
  postProcessJsonConfig: undefined,
}));

// Mock the global-config path resolver so the developer's real ~/.gsloth never leaks into
// these tests; the global-only case repoints it at a temp global config.
const getGlobalGslothConfigReadPath = vi.fn();
vi.mock('#src/utils/globalConfigUtils.js', () => ({
  getGlobalGslothConfigReadPath,
  getGlobalGslothConfigWritePath: vi.fn((filename: string) => resolve('/no-such-global', filename)),
}));

const JSON_CONFIG = '{"llm":{"type":"vertexai"}}';

describe('project-root propagation (GS2-11)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    vi.resetAllMocks();
    processJsonConfig.mockResolvedValue({ type: 'vertexai' });
    // Default: no global config (a sentinel path the real fs never finds).
    getGlobalGslothConfigReadPath.mockImplementation((filename: string) =>
      resolve('/no-such-global', filename)
    );
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-projroot-'));
    // Reset hook: a prior test (or a direct fileUtils call) must not leak a project root.
    setProjectDir(undefined);
  });

  afterEach(() => {
    setProjectDir(undefined);
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const mk = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const setCwd = (dir: string): void => {
    process.env.INIT_CWD = dir;
  };
  const writeFile = (dir: string, name: string, content: string): string => {
    const p = resolve(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it('resolves project artifacts against the discovered up-tree root, not the cwd subdir or install dir', async () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    writeFile(proj, '.gsloth.config.json', JSON_CONFIG);
    writeFile(proj, 'CLAUDE.md', '# guidelines');
    const nested = mk(resolve(proj, 'a', 'b'));
    setCwd(nested);

    const { initConfig } = await import('#src/config.js');
    await initConfig({});

    expect(getProjectDir()).toBe(proj);
    // prompts.guidelines: "CLAUDE.md" must resolve under the project root, not the cwd subdir
    // (which would miss it) and not the install dir (the fatal fall-through before this fix).
    expect(getGslothConfigReadPath('CLAUDE.md', undefined)).toBe(resolve(proj, 'CLAUDE.md'));
  });

  it('clears the project root before each discovery so a second init finds the second project (re-entrancy)', async () => {
    // First project: config sits in its own dir; cwd is a subdir below it.
    const projA = mk(resolve(root, 'projA'));
    mk(resolve(projA, '.git'));
    writeFile(projA, '.gsloth.config.json', JSON_CONFIG);
    setCwd(mk(resolve(projA, 'sub')));

    const { initConfig } = await import('#src/config.js');
    await initConfig({});
    expect(getProjectDir()).toBe(projA);

    // Second project: config lives UP-tree (in projB, not the cwd subdir). Without the
    // clear-at-start, the stale projA root would make the cwd-level candidate falsely match
    // projA's config, so discovery would never walk up to projB.
    const projB = mk(resolve(root, 'projB'));
    mk(resolve(projB, '.git'));
    writeFile(projB, '.gsloth.config.json', JSON_CONFIG);
    setCwd(mk(resolve(projB, 'sub')));

    await initConfig({});
    expect(getProjectDir()).toBe(projB);
  });

  it('falls back to cwd for a global-only config (project root is not relocated to ~/.gsloth)', async () => {
    // A standalone global config, no project config anywhere up to the boundary.
    const globalDir = mk(resolve(root, 'global'));
    writeFile(globalDir, '.gsloth.config.json', JSON_CONFIG);
    getGlobalGslothConfigReadPath.mockImplementation((filename: string) =>
      resolve(globalDir, filename)
    );

    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const nested = mk(resolve(proj, 'sub'));
    setCwd(nested);

    const { initConfig } = await import('#src/config.js');
    await initConfig({});

    // Global-only leaves projectDir unset, so artifacts stay cwd-bound (NOT the global dir).
    expect(getProjectDir()).toBe(nested);
    expect(getGslothConfigReadPath('CLAUDE.md', undefined)).toBe(resolve(nested, 'CLAUDE.md'));
  });
});
