import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// Real fs + temp dirs (no mocks): exercises the actual up-tree walk. cwd is driven via
// INIT_CWD, which getCurrentWorkDir() honours before process.cwd().
import {
  findProjectConfigPath,
  hasProjectConfig,
  resolveIdentityProfileConfigPath,
} from '#src/config/loader.js';

const JSON_CONFIG = '{"llm":{"type":"vertexai"}}';

describe('up-tree project config discovery (B2b Part 1)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-uptree-'));
  });

  afterEach(() => {
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
  const writeConfig = (
    dir: string,
    name = '.gsloth.config.json',
    content = JSON_CONFIG
  ): string => {
    const p = resolve(dir, name);
    writeFileSync(p, content);
    return p;
  };

  it('finds an ancestor project config when invoked from a nested subdir', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const configPath = writeConfig(proj);
    const nested = mk(resolve(proj, 'a', 'b', 'c'));
    setCwd(nested);

    const found = findProjectConfigPath({});
    expect(found).toEqual({ dir: proj, path: configPath });
    expect(hasProjectConfig({})).toBe(true);
  });

  it('does NOT pick up a config above the git-root stop boundary', () => {
    // config sits ABOVE the git root; nothing in proj or below.
    writeConfig(root);
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const nested = mk(resolve(proj, 'sub'));
    setCwd(nested);

    expect(findProjectConfigPath({})).toBeUndefined();
    expect(hasProjectConfig({})).toBe(false);
  });

  it('cwd config wins over an ancestor config (nearest-dir-first)', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    writeConfig(proj, '.gsloth.config.json', '{"llm":{"type":"anthropic"}}');
    const nested = mk(resolve(proj, 'sub'));
    const cwdConfig = writeConfig(nested, '.gsloth.config.json', '{"llm":{"type":"vertexai"}}');
    setCwd(nested);

    const found = findProjectConfigPath({});
    expect(found).toEqual({ dir: nested, path: cwdConfig });
  });

  it('customConfigPath bypasses the up-tree walk', () => {
    const proj = mk(resolve(root, 'proj'));
    const custom = writeConfig(proj, 'my.config.json');
    // Even with an ordinary config sitting in an ancestor, customConfigPath wins outright.
    mk(resolve(proj, '.git'));
    writeConfig(proj);
    const nested = mk(resolve(proj, 'deep', 'er'));
    setCwd(nested);

    const found = findProjectConfigPath({ customConfigPath: custom });
    expect(found?.path).toBe(custom);
  });

  it('composes with identityProfile (.gsloth/.gsloth-settings/<profile>)', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const settings = mk(resolve(proj, '.gsloth', '.gsloth-settings', 'myprofile'));
    const profileConfig = writeConfig(settings);
    setCwd(proj);

    const found = findProjectConfigPath({ identityProfile: 'myprofile' });
    expect(found?.path).toBe(profileConfig);
  });

  it('returns undefined (terminates) when no config exists up to the boundary', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const nested = mk(resolve(proj, 'x', 'y'));
    setCwd(nested);

    expect(findProjectConfigPath({})).toBeUndefined();
  });
});

// GS2-62 — the STRICT profile-existence predicate eval/batch pre-check with. Same up-tree walk as
// findProjectConfigPath, but matches ONLY `.gsloth/.gsloth-settings/<profile>/<config>` — never a
// plain `<dir>/<config>` fall-through, never the global config.
describe('resolveIdentityProfileConfigPath (GS2-62 strict profile existence)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-profile-'));
  });

  afterEach(() => {
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
  const writeProfileConfig = (projDir: string, profile: string, name = '.gsloth.config.json') => {
    const dir = mk(resolve(projDir, '.gsloth', '.gsloth-settings', profile));
    const p = resolve(dir, name);
    writeFileSync(p, JSON_CONFIG);
    return p;
  };

  it('returns the config path when the named profile has its own config', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const profileConfig = writeProfileConfig(proj, 'myprofile');
    setCwd(proj);

    expect(resolveIdentityProfileConfigPath('myprofile')).toBe(profileConfig);
  });

  it('finds an ancestor profile config from a nested subdir (up-tree walk)', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const profileConfig = writeProfileConfig(proj, 'myprofile');
    const nested = mk(resolve(proj, 'a', 'b'));
    setCwd(nested);

    expect(resolveIdentityProfileConfigPath('myprofile')).toBe(profileConfig);
  });

  it('returns undefined when the named profile has no config', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    // A DIFFERENT profile exists, but not the one we ask for.
    writeProfileConfig(proj, 'realprofile');
    setCwd(proj);

    expect(resolveIdentityProfileConfigPath('typo')).toBeUndefined();
  });

  it('is STRICT: does NOT fall through to a plain (non-profile) project config (Case C)', () => {
    // A plain `<proj>/.gsloth.config.json` exists (which findProjectConfigPath WOULD match for a
    // profile via its fall-through), but the profile itself has no config → strict helper says no.
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    writeFileSync(resolve(proj, '.gsloth.config.json'), JSON_CONFIG);
    setCwd(proj);

    // findProjectConfigPath falls through to the plain root for the profile...
    expect(findProjectConfigPath({ identityProfile: 'typo' })?.path).toBe(
      resolve(proj, '.gsloth.config.json')
    );
    // ...but the strict helper does not — the named profile has no config of its own.
    expect(resolveIdentityProfileConfigPath('typo')).toBeUndefined();
  });

  it('treats a blank / whitespace-only profile name as no profile (undefined)', () => {
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    writeProfileConfig(proj, 'myprofile');
    setCwd(proj);

    expect(resolveIdentityProfileConfigPath('')).toBeUndefined();
    expect(resolveIdentityProfileConfigPath('   ')).toBeUndefined();
  });

  it('does not look above the git-root stop boundary', () => {
    // Profile config sits ABOVE the git root; nothing at/below proj.
    writeProfileConfig(root, 'myprofile');
    const proj = mk(resolve(root, 'proj'));
    mk(resolve(proj, '.git'));
    const nested = mk(resolve(proj, 'sub'));
    setCwd(nested);

    expect(resolveIdentityProfileConfigPath('myprofile')).toBeUndefined();
  });
});
