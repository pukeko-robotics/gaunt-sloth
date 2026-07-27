import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkHardline } from '#src/tools/shell/hardline.js';

/**
 * EXT-60 — the §8 floor, reconciled against the approvals corpus in BOTH directions.
 *
 * The `chown` hole this node fixed was not found by reading the pattern list; it was found by
 * RUNNING {@link checkHardline} over every corpus case and diffing the result against the corpus's
 * own `floor_refuses` label. Reading had already missed it: `chmod -R 777 /` sat in the pattern list
 * with no `chown` sibling anywhere, and `chown -R nobody:nobody /` — which strips setuid from
 * `sudo` and re-owns every service account, so the box cannot repair itself — executed.
 *
 * This spec is that diff, frozen as an assertion, so the implementation and the corpus cannot drift
 * apart again silently. It reads the corpus from the committed fixture rather than restating the
 * cases, because a hand-copied subset IS the drift it exists to prevent.
 */

/** A corpus case. Only the fields this spec reads are modelled. */
interface CorpusCase {
  id: string;
  command: string;
  family: string;
  /**
   * Tri-state on purpose. `true` = the corpus asserts the floor refuses this. Absent (the common
   * case) = the corpus makes no claim; exactly one case (`inj-06`) says `false` explicitly. So the
   * split below is `=== true` / `!== true`, never truthiness on a possibly-absent field.
   */
  floor_refuses?: boolean;
}

interface Corpus {
  cases: CorpusCase[];
}

/**
 * The corpus fixture, resolved RELATIVE TO THIS FILE — never from `process.cwd()` and never from a
 * POSIX path literal. It lives at the repo root (`spec-fixtures/`), three levels up from
 * `packages/agent/spec/`. `new URL(...)` + `fileURLToPath` is what makes that a real path on win32
 * as well as POSIX; this is the one filesystem path in the node's work, and hardcoding a `/`-shaped
 * literal here is the exact failure mode that has turned this repo's Windows cell red before.
 */
const CORPUS: Corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../spec-fixtures/approvals-corpus.json', import.meta.url)),
    'utf8'
  )
);

/** Cases the corpus asserts the floor MUST refuse. */
const flagged = CORPUS.cases.filter((corpusCase) => corpusCase.floor_refuses === true);

/** Everything else — the corpus either says `false` or makes no claim. */
const unflagged = CORPUS.cases.filter((corpusCase) => corpusCase.floor_refuses !== true);

/**
 * Direction 2's expected set: cases the floor refuses that the corpus does NOT flag, each with the
 * reason it is tolerated. **It is empty, and that is the finished state of EXT-60** — the floor and
 * the corpus now agree on all 87 cases, in both directions.
 *
 * It is kept (rather than asserting a bare `[]`) because an entry here is a claim someone has to
 * justify in one of exactly two ways, and the distinction is the point:
 *
 *  - **Corpus omission — the floor is right.** A genuine catastrophic/credential command the corpus
 *    did not label. Four of these were found by this reconciliation (`ob-01`, `ob-05`, `inj-02`,
 *    `inj-05`) and were fixed IN THE CORPUS, which is where the error was.
 *
 *  - **Over-broad pattern — the floor is wrong.** One of these was found: `de-04`
 *    (`chmod -R 777 /var/www`), a `destructive` case the floor refused because its chmod pattern
 *    ended at `777\s+/` with no tail and so matched any absolute path. The floor fires under EVERY
 *    rung including `bypass`, so that refusal had no recovery — the user cannot change rung to
 *    escape it. Fixed in the FLOOR by narrowing the pattern to the shared target fragments.
 *
 * The assertion is exact-set EQUALITY, not "a subset of known exceptions". A subset check goes
 * blind the moment a new pattern starts over-firing — which is precisely the CFG-27 failure this
 * reconciliation exists to catch.
 */
const REFUSED_BUT_UNFLAGGED: Readonly<Record<string, string>> = {};

describe('checkHardline — reconciled against the approvals corpus (EXT-60)', () => {
  it('reads a corpus with cases in it (a wrong fixture path must fail loudly, not vacuously pass)', () => {
    expect(CORPUS.cases.length).toBeGreaterThan(0);
    expect(flagged.length).toBeGreaterThan(0);
    // The hole this node closed. Named explicitly so that if the case is ever renamed or dropped,
    // this spec says so instead of quietly testing one case fewer.
    expect(flagged.map((corpusCase) => corpusCase.id)).toContain('fl-06');
  });

  /**
   * Direction 1 — unconditional. Every case the corpus flags must be refused, with no allowance
   * list and no exceptions. `fl-06` (`chown -R nobody:nobody /`) is the case that failed here
   * before this node.
   */
  it.each(flagged.map((corpusCase) => [corpusCase.id, corpusCase.command] as const))(
    'refuses the corpus case flagged floor_refuses: %s',
    (_id, command) => {
      const match = checkHardline(command);
      expect(
        match,
        `corpus flags "${command}" floor_refuses, but the floor allowed it`
      ).not.toBeNull();
      expect(match!.description).toBeTruthy();
    }
  );

  /**
   * Direction 2 — the other way round, and the direction that catches an over-broad pattern. A
   * command the floor refuses but the corpus does not flag is either a corpus omission or a false
   * positive, and a false positive on this floor is unrecoverable by design.
   */
  it('refuses exactly the unflagged cases that are accounted for above, and no others', () => {
    const refused = unflagged
      .filter((corpusCase) => checkHardline(corpusCase.command) !== null)
      .map((corpusCase) => corpusCase.id)
      .sort();

    expect(refused).toEqual(Object.keys(REFUSED_BUT_UNFLAGGED).sort());
  });

  it('accounts for every entry in the expected set (no stale entry left behind after a fix)', () => {
    const ids = new Set(CORPUS.cases.map((corpusCase) => corpusCase.id));
    for (const id of Object.keys(REFUSED_BUT_UNFLAGGED)) {
      expect(ids, `${id} is no longer a corpus case`).toContain(id);
    }
  });
});
