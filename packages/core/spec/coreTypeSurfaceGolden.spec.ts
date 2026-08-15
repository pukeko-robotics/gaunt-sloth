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
 * **A third situation is not either of those, and the cells below are as much about that one.** A
 * name that is still on the surface but bound differently — moved to another declaration file, or
 * gaining or losing a required type parameter — was neither lost nor added. Handed the addition
 * advice, a reader regenerates and an arity break ships behind a green suite; handed the loss
 * advice, a reader hunts a type that never went anywhere. Which is why the branch has a headline
 * and advice of its own, and why the advice is built from the fields that actually differ rather
 * than being one paragraph that mentions everything.
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
      // The three benign causes, named so the reader can rule them out instead of guessing. The
      // third is the one nobody reconstructs unaided: the derivation is reference-based, so a type
      // that is still exported but that nothing exported points at drops out of it — a loss
      // report for a type an embedder can still import.
      expect(drift).toContain('STALE');
      expect(drift).toContain(BUILD_COMMAND);
      expect(drift).toContain('deliberate narrowing');
      expect(drift).toContain('NO LONGER REFERENCED');
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

    it('does NOT read as a rebinding — the control for the cells below', () => {
      expect(drift).not.toContain('BOUND');
      expect(drift).not.toContain('REQUIRED TYPE PARAMETER');
      expect(drift).not.toContain('MOVED to another declaration file');
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
    // The control for the cell below: a gained export modifier on its own IS benign.
    expect(drift).not.toContain('BOUND DIFFERENTLY');
  });

  it('does not let a gained export modifier launder a rebinding into an addition', () => {
    // The same declaration, now exported AND carrying a required type parameter it did not have.
    // The modifier is benign; the parameter is a break. Reported as a gain alone, the reader is
    // told to regenerate and the break ships behind a green suite.
    const drift = describeSurfaceDrift(
      document([entry('AlphaConfig', 'config/types.d.ts')], [entry('Beta')]),
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('Beta', undefined, 1)])
    );
    expect(drift).toContain('NEWLY EXPORTED');
    expect(drift).toContain('BOUND DIFFERENTLY (1)');
    expect(drift).toContain('[arity]');
    expect(drift).toContain('REQUIRED TYPE PARAMETER');
    expect(drift).not.toContain('nothing was lost');
    expect(drift).not.toContain('deliberate API addition');
  });

  it('leaves a rebinding that arrives with a LOST export modifier on the loss branch', () => {
    // The twin of the cell above, and it needs no special handling: a lost export modifier is
    // already the careful branch, and nothing a rebinding adds could make the advice safer.
    const drift = describeSurfaceDrift(
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('Beta')]),
      document([entry('AlphaConfig', 'config/types.d.ts')], [entry('Beta', undefined, 1)])
    );
    expect(drift).toContain('NO LONGER EXPORTED');
    expect(drift).toContain('Investigate before you regenerate');
    expect(drift).not.toContain('deliberate API addition');
  });

  describe('a type that is BOUND DIFFERENTLY — neither lost nor added', () => {
    const withGeneric = document([
      entry('AlphaConfig', 'config/types.d.ts'),
      entry('BetaVerdict', undefined, 1),
    ]);
    const moved = describeSurfaceDrift(
      BASE,
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('BetaVerdict', 'core/shell.d.ts')])
    );
    const gainedParameter = describeSurfaceDrift(BASE, withGeneric);
    const lostParameter = describeSurfaceDrift(withGeneric, BASE);

    it('reports a move as one change naming both sides, and says which field moved', () => {
      // Keyed by name, so this is ONE change — not a removal plus an unrelated addition, which is
      // what a name+file key would produce and what would send the reader hunting a vanished type.
      expect(moved).toContain('BOUND DIFFERENTLY (1)');
      expect(moved).toContain('BetaVerdict (core/types.d.ts) -> BetaVerdict (core/shell.d.ts)');
      expect(moved).toContain('[moved file]');
      expect(moved).not.toContain('GONE from the derived surface');
    });

    it('reports an arity change in both directions, naming arity as the field', () => {
      // Both directions break an embedder that writes the type bare, and only one of them prints
      // the word "arity" in the entry itself: a parameter list going 1 -> 0 renders as a bare
      // name on the right. The field tag is what makes the two read the same way.
      expect(gainedParameter).toContain('BOUND DIFFERENTLY (1)');
      expect(gainedParameter).toContain('[arity]');
      expect(gainedParameter).toContain('BetaVerdict (core/types.d.ts, arity 1)');
      expect(lostParameter).toContain('BOUND DIFFERENTLY (1)');
      expect(lostParameter).toContain('[arity]');
      expect(lostParameter).toContain('BetaVerdict (core/types.d.ts, arity 1) -> BetaVerdict');
    });

    it('has a headline of its own that says the name was neither lost nor added', () => {
      for (const drift of [moved, gainedParameter, lostParameter]) {
        expect(drift).toContain('BOUND 1 name DIFFERENTLY');
        expect(drift).toContain('neither lost nor added');
      }
    });

    it('gives the breaking-change advice for arity and the refactor advice for a move, never the wrong one', () => {
      // The pair is the point. A single paragraph carrying both sentences would satisfy either
      // assertion on its own, which is how the addition advice came to be handed to an arity
      // change in the first place.
      expect(gainedParameter).toContain('REQUIRED TYPE PARAMETER');
      expect(gainedParameter).toContain('breaks every embedder');
      expect(gainedParameter).not.toContain('MOVED to another declaration file');
      expect(gainedParameter).not.toContain('deep-importing');

      expect(moved).toContain('MOVED to another declaration file');
      expect(moved).toContain('deep-importing');
      expect(moved).toContain(BUILD_COMMAND);
      expect(moved).not.toContain('REQUIRED TYPE PARAMETER');
      expect(moved).not.toContain('breaks every embedder');
    });

    it('names the regeneration command, but only after the change is established as intended', () => {
      expect(moved).toContain(REGENERATE_COMMAND);
      expect(moved).toContain('established as intended');
    });

    it('does NOT tell the reader this is an addition to regenerate away — the control', () => {
      // An arity change told "that is what a deliberate API addition looks like" is a breaking
      // change with a one-command fix attached to it.
      for (const drift of [moved, gainedParameter, lostParameter]) {
        expect(drift).not.toContain('nothing was lost');
        expect(drift).not.toContain('deliberate API addition');
        expect(drift).not.toContain('ADDED to the derived surface');
      }
    });

    it('does NOT read as a loss either — the other control', () => {
      for (const drift of [moved, gainedParameter, lostParameter]) {
        expect(drift).not.toContain('LOST names');
        expect(drift).not.toContain('Investigate before you regenerate');
        expect(drift).not.toContain('GONE from the derived surface');
      }
    });
  });

  it('leads with the loss when one name went and another is bound differently', () => {
    // Three branches means three orderings to pin. Without this cell, wiring the rebinding branch
    // ahead of the loss branch passes the whole file.
    const drift = describeSurfaceDrift(
      document([...BASE.required, entry('GammaHint')]),
      document([entry('AlphaConfig', 'config/types.d.ts'), entry('BetaVerdict', 'core/shell.d.ts')])
    );
    expect(drift).toContain('GONE from the derived surface (1)');
    expect(drift).toContain('BOUND DIFFERENTLY (1)');
    expect(drift).toContain('Investigate before you regenerate');
    expect(drift).not.toContain('neither lost nor added');
  });

  it('leads with the rebinding when one name was added and another is bound differently', () => {
    const drift = describeSurfaceDrift(
      BASE,
      document([
        entry('AlphaConfig', 'config/types.d.ts'),
        entry('BetaVerdict', 'core/shell.d.ts'),
        entry('GammaHint'),
      ])
    );
    expect(drift).toContain('ADDED to the derived surface (1)');
    expect(drift).toContain('BOUND DIFFERENTLY (1)');
    // The headline speaks about the rebound name, so it must not claim of the whole report that
    // nothing was added — the sections directly below it say otherwise.
    expect(drift).toContain('BOUND 1 name DIFFERENTLY');
    expect(drift).not.toContain('nothing was lost');
    expect(drift).not.toContain('deliberate API addition');
  });

  it('does not invent a change when one name carries two declarations in one file', () => {
    // No name on today's surface is declared twice, so this is the case the pairing has to be
    // right about before anyone hits it. Same declarations in a different order are not a change;
    // pairing them by an order that ignored arity would tie and could report one.
    const twoDeclarations = document([
      entry('DupSignal', 'core/types.d.ts', 0),
      entry('DupSignal', 'core/types.d.ts', 2),
    ]);
    const reordered = document([
      entry('DupSignal', 'core/types.d.ts', 2),
      entry('DupSignal', 'core/types.d.ts', 0),
    ]);
    expect(describeSurfaceDrift(twoDeclarations, reordered)).toBeNull();

    const oneArityChanged = document([
      entry('DupSignal', 'core/types.d.ts', 0),
      entry('DupSignal', 'core/types.d.ts', 3),
    ]);
    const drift = describeSurfaceDrift(twoDeclarations, oneArityChanged);
    expect(drift).toContain('BOUND DIFFERENTLY (1)');
    expect(drift).toContain('[arity]');
  });

  it('reports a name declared a different number of times as exactly that', () => {
    const drift = describeSurfaceDrift(
      BASE,
      document([
        entry('AlphaConfig', 'config/types.d.ts'),
        entry('BetaVerdict'),
        entry('BetaVerdict', 'core/shell.d.ts'),
      ])
    );
    // There is no pairing to make, so the report says so and prints both sides rather than
    // guessing which declaration became which.
    expect(drift).toContain('[declaration count]');
    expect(drift).toContain('DECLARED A DIFFERENT NUMBER OF TIMES');
    expect(drift).toContain(
      'BetaVerdict (core/types.d.ts) -> BetaVerdict (core/types.d.ts) + BetaVerdict (core/shell.d.ts)'
    );
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
