import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit test for the release-tooling helper scripts/dist-tag.mjs — the SINGLE source
// of truth for the npm dist-tag (publish channel) that publish-all.sh calls per
// package. This test exercises the SAME exported function publish-all.sh invokes
// (no reimplementation), so the shipped logic is the tested logic (OPS-22).
//
// The helper lives at the repo root's scripts/ dir; this spec sits in a package's
// spec/ dir only because that is where the vitest `include` glob looks. Its home
// here is thematic: the eval-reporter-teamcity 0.1.1 case below is the exact
// stable-0.x → `latest` behaviour OPS-22 restores (it had been stranded on `alpha`).
const HELPER = '../../../scripts/dist-tag.mjs';

describe('deriveDistTag (scripts/dist-tag.mjs)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // [version, expectedTag, why]
  const cases: [string, string, string][] = [
    // The version-locked synced set (@gaunt-sloth/{core,agent,review,batch} + the
    // fat CLI) rides its prerelease channel — derived from its OWN version, which
    // equals core's.
    ['2.0.0-alpha.24', 'alpha', 'synced-set prerelease → its preid'],
    ['2.0.0-beta.5', 'beta', 'beta prerelease → beta'],
    ['2.0.0-rc.0', 'rc', 'rc prerelease → rc'],
    // The independently-versioned, stable-0.x eval-reporter-* tier lands on `latest`
    // — this is the OPS-22 fix (it had been riding core's `alpha`).
    ['0.1.1', 'latest', 'stable reporter 0.1.1 → latest (the OPS-22 fix)'],
    ['0.1.0', 'latest', 'stable reporter 0.1.0 → latest'],
    ['0.2.0-rc.0', 'rc', 'a hypothetical reporter prerelease → its preid'],
    // Stable core.
    ['2.0.0', 'latest', 'stable release → latest'],
    // Fallbacks — a numeric-only / empty preid is not a real channel → latest. This
    // matches the inline bash parse the helper replaces, exactly.
    ['1.0.0-1', 'latest', 'numeric-only preid → latest fallback'],
    ['2.0.0-', 'latest', 'empty preid → latest fallback'],
    ['2.0.0-alpha', 'alpha', 'preid with no counter → the preid'],
  ];

  it.each(cases)('derives %s → %s (%s)', async (version, expected) => {
    const { deriveDistTag } = await import(HELPER);
    expect(deriveDistTag(version)).toBe(expected);
  });

  it('proves the acceptance invariant: a 0.1.x reporter resolves latest while the alpha synced set stays alpha', async () => {
    const { deriveDistTag } = await import(HELPER);
    expect(deriveDistTag('0.1.1')).toBe('latest');
    expect(deriveDistTag('2.0.0-alpha.23')).toBe('alpha');
    // The two must diverge — a single core-derived tag is what stranded the reporter.
    expect(deriveDistTag('0.1.1')).not.toBe(deriveDistTag('2.0.0-alpha.23'));
  });
});
