import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * CFG-80 — `commands.review.discovery` (like `commands.pr.discovery`) is not declared in the zod
 * schema: its type is merged into the command config by module augmentation from the app package.
 * The per-command schema objects STRIP unknown keys, so the key survives a load only because the
 * loader validates each layer and then keeps the RAW layer, discarding the parsed copy. Nothing
 * else pinned that for either command, and if the loader ever started returning the parsed copy
 * both discovery settings would silently vanish — `gth pr` discovery would fall back to its
 * default, and `gth review` discovery could never be turned on.
 *
 * Real fs, real loader; the seams mocked are the ones config.jsonc.spec.ts mocks, for the same
 * reasons (a temp global dir, no real LLM, no process exit).
 */
const { getGlobalGslothConfigReadPathMock, exitMock, processJsonConfigMock } = vi.hoisted(() => ({
  getGlobalGslothConfigReadPathMock:
    vi.fn<(_filename: string, _identityProfile?: string) => string>(),
  exitMock: vi.fn<(_code?: number) => never>(),
  processJsonConfigMock: vi.fn(),
}));
vi.mock('#src/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/globalConfigUtils.js')>();
  return { ...actual, getGlobalGslothConfigReadPath: getGlobalGslothConfigReadPathMock };
});
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, exit: exitMock };
});
vi.mock('#src/providers/vertexai.js', () => ({
  processJsonConfig: processJsonConfigMock,
  postProcessJsonConfig: undefined,
}));

describe('command discovery settings survive config loading (CFG-80)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(async () => {
    vi.resetAllMocks();
    const { setProjectDir } = await import('#src/utils/systemUtils.js');
    setProjectDir(undefined);
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-cmd-discovery-'));
    const globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
    const { resolveGlobalConfigPath } = await import('#src/utils/globalConfigUtils.js');
    getGlobalGslothConfigReadPathMock.mockImplementation((filename, identityProfile) =>
      resolveGlobalConfigPath(globalDir, filename, identityProfile)
    );
    exitMock.mockImplementation((code?: number) => {
      throw new Error(`exit(${code}) called`);
    });
    processJsonConfigMock.mockResolvedValue({ fakeLlm: true });
  });

  afterEach(() => {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps commands.review.discovery and commands.pr.discovery from a JSON config', async () => {
    const project = resolve(root, 'proj');
    mkdirSync(resolve(project, '.git'), { recursive: true });
    writeFileSync(
      resolve(project, '.gsloth.config.json'),
      JSON.stringify({
        llm: { type: 'vertexai' },
        commands: {
          review: {
            requirementSource: 'jira',
            discovery: { enabled: true, allowedTools: ['mcp__jira__getJiraIssue'] },
          },
          pr: { discovery: { enabled: false } },
        },
      })
    );
    process.env.INIT_CWD = project;

    const { initConfig } = await import('#src/config/loader.js');
    const config = await initConfig({});

    const commands = config.commands as Record<string, Record<string, unknown>>;
    expect(commands.review.discovery).toEqual({
      enabled: true,
      allowedTools: ['mcp__jira__getJiraIssue'],
    });
    expect(commands.review.requirementSource).toBe('jira');
    expect(commands.pr.discovery).toEqual({ enabled: false });
  });
});
