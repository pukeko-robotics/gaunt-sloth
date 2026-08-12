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

  /**
   * CFG-36 / GS2-29 — `gth config validate` must never green-light a config a real run refuses.
   *
   * The trap is specific: discovery deliberately falls back to a plain `<dir>/.gsloth.config.json`
   * when a named profile has none, so with an ordinary project config present the validator would
   * happily validate THAT file and report OK — while the run now refuses to start. Both sides read
   * the same rule (`findUnresolvedExplicitProfile`), and this is what holds them together.
   */
  it('CFG-36: a named profile with no config FAILS validation, mirroring the run that refuses it', async () => {
    // Case C: a plain project config exists and would be found by discovery for any profile name.
    writeFileSync(
      resolve(root, '.gsloth.config.json'),
      JSON.stringify({ llm: { type: 'anthropic' } })
    );

    const report = await validateConfig({ identityProfile: 'typo' });

    expect(report.ok).toBe(false);
    // `found` is load-bearing, not incidental: `configCommand` treats `found: false` as "nothing to
    // validate" and prints "No configuration file found to validate. Run gth init" INSTEAD of the
    // layers — which would both discard the real diagnosis and tell a user to create a
    // configuration they already have, when their actual problem is a mistyped profile name.
    expect(report.found).toBe(true);
    const failing = report.layers.find((layer) => !layer.ok);
    expect(failing?.errorMessage ?? '').toContain('identity profile "typo" not found');
  });

  it('CFG-36: a MALFORMED extends base is reported as a not-ok layer, not thrown at the caller', async () => {
    // The read side COLLECTS and never terminates, and that has to hold for the base layer too:
    // composing `extends` validates the base exactly as the project layer is validated, so a broken
    // base now raises a ConfigDiscoveryError from inside the shared traversal. `validateConfig`
    // catches it as a layer failure; without that arm the error escapes `validateConfig` entirely
    // and `gth config validate` reports "Failed to read configuration:" with no per-layer report —
    // wrong presentation of a real failure, and the one behaviour the CFG-36 caller table claims.
    const baseDir = resolve(root, '.gsloth', '.gsloth-settings', 'broken-base');
    mkdirSync(baseDir, { recursive: true });
    // Schema-invalid base: `filesystem` must be an array or enum, never a number.
    writeFileSync(
      resolve(baseDir, '.gsloth.config.json'),
      JSON.stringify({ llm: { type: 'anthropic' }, filesystem: 123 })
    );
    const childDir = resolve(root, '.gsloth', '.gsloth-settings', 'heir');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      resolve(childDir, '.gsloth.config.json'),
      JSON.stringify({ extends: 'broken-base', llm: { type: 'anthropic' } })
    );

    // Resolves rather than rejecting — that is the contract under test.
    const report = await validateConfig({ identityProfile: 'heir' });

    expect(report.found).toBe(true);
    expect(report.ok).toBe(false);
    const failing = report.layers.find((layer) => !layer.ok);
    expect(failing?.errorMessage ?? '').toMatch(/broken-base \(extends base\)/);
    expect(failing?.errorMessage ?? '').toMatch(/filesystem/);
  });

  it('CFG-36 control: that same plain config raises no profile complaint when none is named', async () => {
    // The discriminating half: the rule keys on a profile having been NAMED. Asserted as "no
    // profile complaint" rather than `ok: true`, because the global layer is read from the real
    // home dir here and its validity is a property of the machine, not of this change.
    writeFileSync(
      resolve(root, '.gsloth.config.json'),
      JSON.stringify({ llm: { type: 'anthropic' } })
    );

    const report = await validateConfig({});

    expect(
      report.layers.some((layer) => (layer.errorMessage ?? '').includes('identity profile'))
    ).toBe(false);
  });
});
