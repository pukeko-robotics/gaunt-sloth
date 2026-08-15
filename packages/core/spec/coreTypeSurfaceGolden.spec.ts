import { describe, expect, it } from 'vitest';
import {
  BUILD_COMMAND,
  describeSurfaceDrift,
  REGENERATE_COMMAND,
  toGoldenDocument,
} from '../scripts/type-surface.mjs';

/**
 * The drift report that fronts the committed type-surface golden — its wording, tested as the
 * deliverable it is.
 *
 * `coreBarrelTypeSurface.spec.ts` compares the derived public type surface against
 * `coreBarrelTypeSurface.golden.json`. An equality failure alone would be useless there, because
 * **an addition and a removal look identical to a deep-equality diff and call for opposite
 * responses**: adding a public type is ordinary work whose only correct answer is to regenerate the
 * golden and commit it, while losing one is the failure the golden exists to catch — the walk
 * quietly ceasing to see part of the surface — where regenerating erases the evidence and blesses
 * the loss. So the message has to say which happened, and that message is the only thing standing
 * between a reader and the wrong reflex.
 *
 * A failure message is untested by construction: it is emitted on the path the suite never takes
 * when it is green. These cells take that path deliberately, feeding synthetic golden documents in
 * so the report is exercised against every shape it claims to distinguish. Each pair below is
 * written as a pair on purpose — the wording that must appear for one direction, and the wording
 * that must NOT appear for the other. Asserting only the first would pass just as well for a
 * message that said the same thing to everybody.
 *
 * The real surface never enters this file: every document below is written by hand, so nothing
 * here runs the walk or reads `dist/`. Importing the module still loads the TypeScript compiler,
 * which the walk holds at module scope — these cells do not use it.
 */

const entry = (name: string, file = 'core/types.d.ts', arity = 0) => ({ name, file, arity });

const document = (required: ReturnType<typeof entry>[], unexported: typeof required = []) => ({
  $comment: 'irrelevant to the drift report',
  required,
  unexported,
});

const BASE = document([entry('AlphaConfig', 'config/types.d.ts'), entry('BetaVerdict')]);

describe('type-surface golden drift report', () => {
  it('says nothing when the derivation still matches the golden', () => {
    expect(describeSurfaceDrift(BASE, document([...BASE.required]))).toBeNull();
    // Order is the file's, not the derivation's, so a reordered list is still a match.
    expect(describeSurfaceDrift(BASE, document([...BASE.required].reverse()))).toBeNull();
  });

  describe('a type that VANISHED', () => {
    const drift = describeSurfaceDrift(BASE, document([entry('AlphaConfig', 'config/types.d.ts')]));

    it('names the type that went, and how many', () => {
      expect(drift).toContain('GONE from the derived surface (1)');
      expect(drift).toContain('BetaVerdict (core/types.d.ts)');
    });

    it('tells the reader to investigate rather than to regenerate', () => {
      expect(drift).toContain('LOST names');
      expect(drift).toContain('Investigate before you regenerate');
      // The two benign causes, named so the reader can rule them out instead of guessing.
      expect(drift).toContain('STALE');
      expect(drift).toContain(BUILD_COMMAND);
      expect(drift).toContain('deliberate narrowing');
    });

    it('still names the regeneration command, for after the reader has established the cause', () => {
      expect(drift).toContain(REGENERATE_COMMAND);
    });

    it('does NOT read as an addition — the control for the cells below', () => {
      expect(drift).not.toContain('ADDED to the derived surface');
      expect(drift).not.toContain('nothing was lost');
    });
  });

  describe('a type that was ADDED', () => {
    const drift = describeSurfaceDrift(BASE, document([...BASE.required, entry('GammaHint')]));

    it('names the type and says plainly that nothing was lost', () => {
      expect(drift).toContain('ADDED to the derived surface (1)');
      expect(drift).toContain('GammaHint (core/types.d.ts)');
      expect(drift).toContain('nothing was lost');
      expect(drift).toContain('deliberate API addition');
    });

    it('names the one command that fixes it', () => {
      expect(drift).toContain(REGENERATE_COMMAND);
    });

    it('does NOT tell the reader to investigate a loss — the control for the cells above', () => {
      expect(drift).not.toContain('LOST names');
      expect(drift).not.toContain('Investigate before you regenerate');
      expect(drift).not.toContain('GONE from the derived surface');
    });
  });

  it('leads with the loss when types were both added and removed', () => {
    const drift = describeSurfaceDrift(
      BASE,
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('GammaHint')])
    );
    // Both are reported…
    expect(drift).toContain('GONE from the derived surface (1)');
    expect(drift).toContain('ADDED to the derived surface (1)');
    // …but the advice is the careful one. A message that averaged the two would be worse than
    // either, because the reader acts on the headline.
    expect(drift).toContain('Investigate before you regenerate');
    expect(drift).not.toContain('nothing was lost');
  });

  it('reports a type that lost its export modifier as exactly that, and as a loss', () => {
    // Deleting one `export` keyword takes a type off the public surface with no compiler
    // complaint anywhere. It is still reached, so it is not GONE; it is nameable by no route,
    // which is why it is reported on the loss side rather than as a change.
    const drift = describeSurfaceDrift(
      BASE,
      document([entry('AlphaConfig', 'config/types.d.ts')], [entry('BetaVerdict')])
    );
    expect(drift).toContain('NO LONGER EXPORTED');
    expect(drift).toContain('BetaVerdict (core/types.d.ts)');
    expect(drift).toContain('Investigate before you regenerate');
  });

  it('reports a type that gained an export modifier as a gain, not a loss', () => {
    const withUnexported = document([entry('AlphaConfig', 'config/types.d.ts')], [entry('Beta')]);
    const nowExported = document([entry('AlphaConfig', 'config/types.d.ts'), entry('Beta')]);
    const drift = describeSurfaceDrift(withUnexported, nowExported);
    expect(drift).toContain('NEWLY EXPORTED');
    expect(drift).toContain('nothing was lost');
  });

  it('reports a name that moved file, or changed arity, as one change naming both sides', () => {
    const moved = describeSurfaceDrift(
      BASE,
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('BetaVerdict', 'core/shell.d.ts')])
    );
    // Keyed by name, so this is ONE change — not a removal plus an unrelated addition, which is
    // what a name+file key would produce and what would send the reader hunting a vanished type.
    expect(moved).toContain('BOUND DIFFERENTLY (1)');
    expect(moved).toContain('BetaVerdict (core/types.d.ts) -> BetaVerdict (core/shell.d.ts)');
    expect(moved).not.toContain('GONE from the derived surface');

    const regeneric = describeSurfaceDrift(
      BASE,
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('BetaVerdict', undefined, 1)])
    );
    expect(regeneric).toContain('BOUND DIFFERENTLY (1)');
    expect(regeneric).toContain('arity 1');
  });
});

describe('what the golden records', () => {
  const surface = {
    required: [
      {
        name: 'Zeta',
        file: 'core/types.d.ts',
        reachedFrom: 'someBarrelExport',
        arity: 1,
        nameable: true,
      },
      {
        name: 'Alpha',
        file: 'config/types.d.ts',
        reachedFrom: 'another',
        arity: 0,
        nameable: true,
      },
    ],
    unexported: [
      { name: 'Hidden', file: 'config/x.d.ts', reachedFrom: 'another', arity: 0, nameable: false },
    ],
    typeofReferents: ['SOME_VALUE'],
    walked: 200,
    unresolvedReferences: 0,
  };

  it('keeps name, file and arity — the three things a change to them breaks an embedder', () => {
    expect(toGoldenDocument(surface).required).toEqual([
      { name: 'Alpha', file: 'config/types.d.ts', arity: 0 },
      { name: 'Zeta', file: 'core/types.d.ts', arity: 1 },
    ]);
  });

  it('drops reachedFrom and nameable, which would make the file churn or freeze a failure', () => {
    // `reachedFrom` moves with the walk's queue order rather than with the API; `nameable` is what
    // the spec's own assertion is about, and a committed `false` would turn a live failure into an
    // accepted state.
    const [first] = toGoldenDocument(surface).required;
    expect(Object.keys(first)).toEqual(['name', 'file', 'arity']);
  });

  it('sorts by code units, so a golden written on one platform matches on another', () => {
    // Not `localeCompare`: its order depends on the ICU data the platform ships, and this file is
    // written by one machine and compared by another.
    const names = toGoldenDocument({
      ...surface,
      required: [...surface.required, { ...surface.required[0], name: '_Underscore' }],
    }).required.map((type) => type.name);
    expect(names).toEqual(['Alpha', 'Zeta', '_Underscore']);
  });

  it('carries the regeneration command in the file itself', () => {
    expect(toGoldenDocument(surface).$comment).toContain(REGENERATE_COMMAND);
  });
});
