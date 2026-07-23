import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
// Real fs + temp dirs (no mocks): exercises the actual create → select round-trip through the GS2-1
// discovery cascade. cwd is driven via INIT_CWD (getCurrentWorkDir honours it), and setProjectDir is
// cleared so getProjectDir falls back to that cwd — mirrors config.uptree.spec.ts.
import { createNamedProfile } from '#src/config/profiles.js';
import {
  findProjectConfigPath,
  resolveIdentityProfileConfigPath,
  validateConfig,
} from '#src/config/loader.js';
import { setProjectDir } from '#src/utils/systemUtils.js';

describe('config profiles — create → select round-trip (GS2-33)', () => {
  let root: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'gsloth-profiles-'));
    // A .git marker bounds the up-tree walk at root; INIT_CWD makes root the cwd.
    mkdirSync(resolve(root, '.git'), { recursive: true });
    process.env.INIT_CWD = root;
    setProjectDir(undefined);
  });

  afterEach(() => {
    if (origInitCwd === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = origInitCwd;
    setProjectDir(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it('a created profile is discovered by --profile <name> and resolves ITS model', () => {
    // create
    const { path } = createNamedProfile('cheap', {
      seedType: 'google-genai',
      modelOverride: 'gemini-2.0-flash-lite',
    });
    expect(path).toBe(resolve(root, '.gsloth', '.gsloth-settings', 'cheap', '.gsloth.config.json'));

    // select: the strict profile resolver finds exactly this profile's config
    expect(resolveIdentityProfileConfigPath('cheap')).toBe(path);

    // select: full discovery with the profile override lands on the profile-dir config (the
    // project-file layer), proving the named profile composes into the cascade at that layer.
    expect(findProjectConfigPath({ identityProfile: 'cheap' })).toEqual({ dir: root, path });

    // run resolution reads the profile's OWN model id (the distinguishing key comes from the profile)
    const resolved = JSON.parse(readFileSync(path, 'utf8'));
    expect(resolved.llm.model).toBe('gemini-2.0-flash-lite');
    expect(resolved.llm.type).toBe('google-genai');
  });

  it('a distinct profile resolves a distinct model — profiles are independently selectable', () => {
    createNamedProfile('cheap', {
      seedType: 'google-genai',
      modelOverride: 'gemini-2.0-flash-lite',
    });
    createNamedProfile('strong', { seedType: 'anthropic', modelOverride: 'claude-opus-4-1' });

    const cheap = JSON.parse(readFileSync(resolveIdentityProfileConfigPath('cheap')!, 'utf8'));
    const strong = JSON.parse(readFileSync(resolveIdentityProfileConfigPath('strong')!, 'utf8'));
    expect(cheap.llm.model).toBe('gemini-2.0-flash-lite');
    expect(strong.llm.model).toBe('claude-opus-4-1');
  });

  it('selecting an invalid profile fails validation with a clear, source-labelled error', async () => {
    // Hand-write a schema-INVALID profile config (filesystem must be an array or enum, not a number).
    const dir = resolve(root, '.gsloth', '.gsloth-settings', 'broken');
    mkdirSync(dir, { recursive: true });
    const brokenPath = resolve(dir, '.gsloth.config.json');
    writeFileSync(brokenPath, JSON.stringify({ llm: { type: 'anthropic' }, filesystem: 123 }));

    const report = await validateConfig({ identityProfile: 'broken' });
    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    const failing = report.layers.find((layer) => !layer.ok);
    expect(failing?.sourceLabel).toBe(brokenPath);
    expect(failing?.errorMessage ?? '').toMatch(/filesystem/);
  });
});
