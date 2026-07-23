import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * GS2-41 — profile composition / inheritance (`extends`) unit tests for `resolveConfigExtends`, the
 * resolver that composes a named profile's `extends` chain into a single raw config via the SAME
 * GS2-1 deep-merge the config layers use.
 *
 * consoleUtils + systemUtils are mocked so the cycle / missing-base failures are OBSERVABLE and
 * `exit` never terminates the runner; `getCurrentWorkDir` is pointed at a per-test temp dir. node:fs
 * stays REAL — the actual strict up-tree profile walk (`resolveIdentityProfileConfigPath`), the raw
 * JSON read, and the deep-merge all run for real against on-disk temp profile dirs.
 */
const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  setConsoleLevel: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  exit: vi.fn(),
  error: vi.fn(),
  getCurrentWorkDir: vi.fn(),
  getProjectDir: vi.fn(),
  setProjectDir: vi.fn(),
  getInstallDir: vi.fn(),
  setUseColour: vi.fn(),
  isTTY: vi.fn(),
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

describe('resolveConfigExtends — GS2-41 profile inheritance', () => {
  let root: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-extends-'));
    // A `.git` at the temp root bounds the up-tree profile walk to this dir only.
    mkdirSync(resolve(root, '.git'), { recursive: true });
    systemUtilsMock.getCurrentWorkDir.mockReturnValue(root);
    systemUtilsMock.isTTY.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a named profile config under `.gsloth/.gsloth-settings/<name>/.gsloth.config.json`. */
  const writeProfile = (name: string, config: Record<string, unknown>): string => {
    const dir = resolve(root, '.gsloth', '.gsloth-settings', name);
    mkdirSync(dir, { recursive: true });
    const p = resolve(dir, '.gsloth.config.json');
    writeFileSync(p, JSON.stringify(config));
    return p;
  };

  const errorText = (): string =>
    consoleUtilsMock.displayError.mock.calls.map((c) => String(c[0])).join('\n');

  it('resolves a delta child to base + delta (base inherited, delta added, child override wins)', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    // Base `uni-mcp`: full setup (llm, an MCP server, an org block).
    writeProfile('uni-mcp', {
      llm: { type: 'anthropic', model: 'base-model' },
      streamOutput: true,
      organization: { name: 'BaseOrg', locale: 'en' },
      mcpServers: { uni: { url: 'http://uni' } },
    });
    // Child sets ONLY a delta: overrides the org name and ADDS a JWT-auth block to the MCP server —
    // without restating the base.
    const childRaw = {
      extends: 'uni-mcp',
      organization: { name: 'MariOrg' },
      mcpServers: { uni: { url: 'http://uni', headers: { Authorization: 'Bearer test-jwt' } } },
    };

    const resolved = await resolveConfigExtends(childRaw, 'uni-test-mcp-mari');

    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
    expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    // Inherited from base unchanged:
    expect(resolved.llm).toEqual({ type: 'anthropic', model: 'base-model' });
    expect(resolved.streamOutput).toBe(true);
    // Nested merge: child overrides `name`, base `locale` survives.
    expect(resolved.organization).toEqual({ name: 'MariOrg', locale: 'en' });
    // Additive child field (the JWT block) merged in; base `url` preserved.
    expect(resolved.mcpServers).toEqual({
      uni: { url: 'http://uni', headers: { Authorization: 'Bearer test-jwt' } },
    });
    // `extends` is consumed — never leaks into the composed output.
    expect(resolved.extends).toBeUndefined();
  });

  it('applies the GS2-1 array policy: additive fields (allowDirs) accumulate, other arrays replace', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    writeProfile('base', {
      llm: { type: 'anthropic' },
      allowDirs: ['/base/dir'],
      builtInTools: ['run_tests', 'run_lint'],
    });
    const childRaw = { extends: 'base', allowDirs: ['/child/dir'], builtInTools: ['run_build'] };

    const resolved = await resolveConfigExtends(childRaw, 'child');

    // `allowDirs` is an ADDITIVE_ARRAY_FIELD → base + child accumulate (target-first, de-duped).
    expect(resolved.allowDirs).toEqual(['/base/dir', '/child/dir']);
    // A non-additive array REPLACES (child wins) — unchanged GS2-1 policy.
    expect(resolved.builtInTools).toEqual(['run_build']);
  });

  it('resolves a multi-level chain (A extends B extends C) in order — C, then B, then A last-wins', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    writeProfile('C', {
      llm: { type: 'anthropic', model: 'c-model' },
      streamOutput: true,
      contentSource: 'from-C',
      requirementSource: 'from-C',
    });
    writeProfile('B', { extends: 'C', requirementSource: 'from-B' });
    writeProfile('A', { extends: 'B', contentSource: 'from-A' });
    const childRaw = { extends: 'A', requirementSource: 'from-child' };

    const resolved = await resolveConfigExtends(childRaw, 'selected');

    expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    // Deepest base (C) supplies llm + streamOutput.
    expect(resolved.llm).toEqual({ type: 'anthropic', model: 'c-model' });
    expect(resolved.streamOutput).toBe(true);
    // contentSource: set in C then overridden by A (C -> A).
    expect(resolved.contentSource).toBe('from-A');
    // requirementSource: set in C, overridden by B, overridden by child (C -> B -> child) — last-wins.
    expect(resolved.requirementSource).toBe('from-child');
    expect(resolved.extends).toBeUndefined();
  });

  it('changing the base updates the child on re-resolution WITHOUT editing the child', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    writeProfile('base', { llm: { type: 'anthropic', model: 'v1' }, contentSource: 'from-base' });
    const childRaw = { extends: 'base', requirementSource: 'child-req' };

    const first = await resolveConfigExtends(structuredClone(childRaw), 'child');
    expect((first.llm as Record<string, unknown>).model).toBe('v1');
    expect(first.contentSource).toBe('from-base');

    // Mutate ONLY the base on disk. The child file is never touched.
    writeProfile('base', {
      llm: { type: 'anthropic', model: 'v2' },
      contentSource: 'from-base-updated',
    });

    const second = await resolveConfigExtends(structuredClone(childRaw), 'child');
    expect((second.llm as Record<string, unknown>).model).toBe('v2');
    expect(second.contentSource).toBe('from-base-updated');
    // The child's own delta still applies on top of the changed base.
    expect(second.requirementSource).toBe('child-req');
  });

  it('fails fast on a cyclic extends chain (A extends B extends A) with a clear error naming the cycle', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    writeProfile('A', { extends: 'B', llm: { type: 'anthropic' } });
    writeProfile('B', { extends: 'A', llm: { type: 'anthropic' } });
    const childRaw = { extends: 'A', llm: { type: 'anthropic' } };

    // Terminates (no hang / stack-overflow) and surfaces the error rather than a composed config.
    await expect(resolveConfigExtends(childRaw, 'selected')).rejects.toThrow(/Unexpected error/);
    expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    const msg = errorText();
    expect(msg).toMatch(/inheritance cycle detected/i);
    expect(msg).toContain('selected -> A -> B -> A');
  });

  it('fails fast on a self-extend (a profile that extends itself)', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    writeProfile('solo', { extends: 'solo', llm: { type: 'anthropic' } });

    await expect(
      resolveConfigExtends({ extends: 'solo', llm: { type: 'anthropic' } }, 'solo')
    ).rejects.toThrow(/Unexpected error/);
    expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toMatch(/inheritance cycle detected/i);
    expect(errorText()).toContain('solo -> solo');
  });

  it('fails fast when extends names a base profile that has no config', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    await expect(
      resolveConfigExtends({ extends: 'ghost', llm: { type: 'anthropic' } }, 'child')
    ).rejects.toThrow(/Unexpected error/);
    expect(systemUtilsMock.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toMatch(/"ghost".*was not found/i);
  });

  it('returns a config without extends unchanged (no base lookup, no side effects)', async () => {
    const { resolveConfigExtends } = await import('#src/config/loader.js');

    const raw = { llm: { type: 'anthropic', model: 'm' }, streamOutput: true };
    const resolved = await resolveConfigExtends(structuredClone(raw), undefined);

    expect(resolved).toEqual(raw);
    expect(systemUtilsMock.exit).not.toHaveBeenCalled();
    expect(consoleUtilsMock.displayError).not.toHaveBeenCalled();
  });
});
