import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkHardline } from '@gaunt-sloth/core/core/shell/hardline.js';

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
 *
 * ## What this spec CANNOT see (read this before trusting a green run)
 *
 * Both directions scan **only the 87 commands in the corpus**. So direction 2 — the false-positive
 * direction, the one that matters, because a floor refusal fires under `bypass` and has no
 * recovery — can only catch an over-broad pattern that happens to misfire **on a corpus case**.
 * It caught `de-04` (`chmod -R 777 /var/www`) purely because someone had put that command in the
 * corpus.
 *
 * The review of this node measured the cost of that. The first `chown` patterns written here
 * refused `grep chown -r /etc` — an unappealable refusal of an ordinary read-only search, the
 * single most serious defect class this floor has — and **this spec passed green throughout**,
 * because nobody had put a `grep chown …` in the corpus. A false positive on a command the corpus
 * does not contain is invisible here **by construction**.
 *
 * "The floor and the corpus agree on all 87 cases" is therefore the whole of what a green run
 * asserts, and it is a much weaker statement than "the floor has no false positives". The corpus is
 * thin on must-NOT-fire shapes; the hand-written negative probes in `shellHardline.spec.ts` are
 * where that coverage actually lives, and they are what a new pattern has to be argued against.
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
  /**
   * EXT-70 — **this fixture is the SHELL corpus, and every case in it must be a command string.**
   * The non-shell cases (a tool name plus hostile arguments) live in
   * `spec-fixtures/approvals-tool-corpus.json` and are read by `approvalsToolCorpus.spec.ts`,
   * deliberately as a separate file: `checkHardline` is a scanner over command text, so a
   * tool-subject case arriving here would be handed `undefined` and would prove nothing about the
   * floor. If the two corpora are ever merged, this is what says so on the first run instead of
   * later, quietly.
   */
  it('is the SHELL corpus — every case carries a command string', () => {
    const notShell = CORPUS.cases
      .filter((corpusCase) => typeof (corpusCase as { command?: unknown }).command !== 'string')
      .map((corpusCase) => corpusCase.id);
    expect(notShell).toEqual([]);
  });

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

  /**
   * EXT-67 — **the same reconciliation, on the win32 arm.**
   *
   * The floor now has a platform-gated second pattern list, and a false positive in it would be
   * invisible to every cell above: they read the host platform, which on this repo's usual runners
   * and on three of the unit matrix's five cells is not Windows. So the win32 arm gets its own pass
   * over the corpus, and it must refuse **exactly the same cases** — the win32 list adds Windows
   * shapes, none of which any corpus case is.
   *
   * **What this buys that the hand-written probes cannot.** The negatives in `shellHardline.spec.ts`
   * are shapes someone thought of; these are 112 commands collected for other reasons entirely, so
   * an over-broad Windows pattern that happens to bite an ordinary POSIX command shows up here
   * without anyone having predicted it. It is the same argument direction 2 makes above, and it
   * inherits the same limit: it can only catch an over-fire **on a corpus case**, which is why it is
   * an addition to the probe set and not a replacement for it.
   *
   * The corpus carries no Windows family yet. That is not fixable from this repo —
   * `approvals-corpus.json` is GENERATED from project-takahe's `approvals-corpus.yaml` under a
   * content hash, so a case added here is drift there and gone at the next regeneration. When the
   * family lands, a case that is catastrophic only on Windows needs a platform of its own in the
   * fixture and this comparison has to read it; asserting a win32 case on the default platform would
   * silently score it as "not floored".
   */
  it('refuses exactly the same corpus cases on the win32 arm (EXT-67)', () => {
    const refusedOnPosix = CORPUS.cases
      .filter((corpusCase) => checkHardline(corpusCase.command, { platform: 'linux' }) !== null)
      .map((corpusCase) => corpusCase.id)
      .sort();
    const refusedOnWindows = CORPUS.cases
      .filter((corpusCase) => checkHardline(corpusCase.command, { platform: 'win32' }) !== null)
      .map((corpusCase) => corpusCase.id)
      .sort();

    expect(refusedOnPosix.length, 'a vacuous comparison would pass this too').toBeGreaterThan(0);
    expect(refusedOnWindows).toEqual(refusedOnPosix);
  });

  /**
   * DORMANT BY DESIGN — and it is not coverage today. `REFUSED_BUT_UNFLAGGED` is empty (that is
   * EXT-60's finished state), so this body never executes and this test cannot fail. It is kept
   * because it goes live on the first entry anyone adds, which is exactly when a stale entry
   * becomes possible: an entry justified once, then left behind after the floor or the corpus was
   * fixed, silently subtracting a case from direction 2's exact-set equality above.
   */
  it('accounts for every entry in the expected set (no stale entry left behind after a fix)', () => {
    const ids = new Set(CORPUS.cases.map((corpusCase) => corpusCase.id));
    for (const id of Object.keys(REFUSED_BUT_UNFLAGGED)) {
      expect(ids, `${id} is no longer a corpus case`).toContain(id);
    }
  });
});
