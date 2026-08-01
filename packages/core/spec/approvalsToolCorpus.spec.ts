import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApprovalEntry } from '#src/config/shell-policy.js';
import {
  approvalEntryRatesCall,
  resolveApprovalRules,
  type ApprovalRuleLists,
  type ApprovalSubject,
} from '#src/core/approvals/matcher.js';
import {
  approvalSubjectForToolName,
  mcpToolRegisteredName,
} from '#src/core/approvals/mcpSubjects.js';
import {
  mapAllowMatchedVerdictToAction,
  type RaterAction,
  type ShellSafetyVerdict,
} from '#src/core/shell/rater.js';

/**
 * EXT-70 — the NON-SHELL half of the approvals corpus: an innocuous tool NAME carrying hostile
 * ARGUMENTS, against §3.2's default `rate: true` tripwire.
 *
 * ## Why a second corpus exists at all
 *
 * Every one of `approvals-corpus.json`'s 112 cases is a command STRING, and a string is a thing a
 * matcher can read: `rm -rf /` says what it will do. A tool call is the other shape. `create_issue`
 * is `create_issue` whether the body is a typo report (`tc-08`) or a pasted AWS secret (`tc-01`),
 * and a `tool` allow entry records **identity, never arguments** (§4.7.4). So the entry that
 * matches the benign call matches the hostile one, byte for byte — which is precisely why §3.2's
 * last row defaults every `tool` / `mcpTool` entry to `rate: true`.
 *
 * ## What a green run here does and does not assert
 *
 * Two halves, and they are different in kind:
 *
 *  - **Arming** — the identity resolves to the subject the fixture says, an allow entry naming that
 *    identity matches, and the resulting decision carries `rate: true`. Production, end to end
 *    through `resolveApprovalRules`.
 *  - **Consequence** — `mapAllowMatchedVerdictToAction`, the §3.2 tripwire mapping, turns each
 *    case's labelled outcome into `run` / `escalate` / `halt`. That function is tool-general in
 *    signature and shared with the shell path, and this asserts the mapping.
 *
 * **What is NOT asserted here is the ROUTING**, and the boundary matters: today a rated allow-match
 * on a tool subject returns approve without any rating call at all — `GthAgentRunner` short-circuits
 * on `!isShellCommand`, because §4.3 scopes the rater's first implementation to the shell. So no
 * hostile argument in this fixture reaches a rater in production yet. That gap is [[EXT-30]]'s to
 * close, it is pinned by an expiry-dated test in `GthAgentRunner.spec.ts` that drives every case in
 * this fixture through the real decision path, and it is stated here so a green run in this file is
 * never read as "the tripwire fires on hostile tool arguments today".
 *
 * The `rate` DEFAULT TABLE itself is `approvalMatcher.spec.ts`'s (§3.2, one row per entry shape).
 * What this file adds is the corpus dimension: the pairs that share an identity and differ only in
 * their arguments.
 */

/** One non-shell corpus case. Every field the fixture defines is modelled — nothing is optional
 *  except the two that genuinely are. */
interface ToolCorpusCase {
  id: string;
  /** Which approval subject this call presents (§4.7.1) — `mcpTool` cases carry a `server`. */
  subject: 'tool' | 'mcpTool';
  server?: string;
  /** The tool's own name. For an `mcpTool` case the REGISTERED name is derived from it. */
  tool: string;
  arguments: Record<string, unknown>;
  family: string;
  /** What a rater must return for this call given these arguments. */
  outcome: ShellSafetyVerdict['outcome'];
  /** §3.2 — what the tripwire then does with that outcome on an allow-matched call. */
  tripwire: 'run' | 'escalate' | 'halt';
  /** The case with the same identity and a different outcome, where there is one. */
  pairs_with?: string;
  note?: string;
}

interface ToolCorpus {
  labels: readonly string[];
  tripwires: readonly string[];
  cases: ToolCorpusCase[];
}

/**
 * Both fixtures, resolved RELATIVE TO THIS FILE — never from `process.cwd()`, never from a POSIX
 * path literal (the failure mode that has turned this repo's Windows cell red before).
 */
function fixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../spec-fixtures/${name}`, import.meta.url)), 'utf8')
  ) as T;
}

const CORPUS = fixture<ToolCorpus>('approvals-tool-corpus.json');

/** The SHELL corpus, for the one cross-corpus control below. */
const SHELL_CORPUS = fixture<{ cases: { id: string; command: string }[] }>('approvals-corpus.json');

/** §3.2's three consequences, as the actions the mapping actually returns. */
const TRIPWIRE_ACTIONS: Readonly<Record<ToolCorpusCase['tripwire'], RaterAction>> = {
  run: 'approve',
  escalate: 'escalate',
  halt: 'halt',
};

/** The registered tool name the model would call — the inverse of the subject split (§4.7.5). */
function registeredName(corpusCase: ToolCorpusCase): string {
  return corpusCase.subject === 'mcpTool'
    ? mcpToolRegisteredName(corpusCase.server ?? '', corpusCase.tool)
    : corpusCase.tool;
}

/** The `mcpServers` keys configured for a case — its own server, and nothing else. */
function configuredServers(corpusCase: ToolCorpusCase): string[] {
  return corpusCase.server === undefined ? [] : [corpusCase.server];
}

/** The subject a gated call on this case presents, built by production's own resolution. */
function subjectFor(corpusCase: ToolCorpusCase): ApprovalSubject {
  return approvalSubjectForToolName(registeredName(corpusCase), configuredServers(corpusCase));
}

/**
 * The allow entry a user would write to stop being asked about this tool: its identity, exactly, and
 * nothing about its arguments — which is all §3.1 lets a `tool` / `mcpTool` entry say.
 */
function identityEntry(corpusCase: ToolCorpusCase, pattern = corpusCase.tool): ApprovalEntry {
  return corpusCase.subject === 'mcpTool'
    ? { type: 'mcpTool', server: corpusCase.server ?? '', matcher: 'exact', pattern }
    : { type: 'tool', matcher: 'exact', pattern };
}

const EMPTY_LISTS: ApprovalRuleLists = { allow: [], deny: [], escalate: [] };

function allowing(entry: ApprovalEntry): ApprovalRuleLists {
  return { ...EMPTY_LISTS, allow: [entry] };
}

const CASE_ROWS = CORPUS.cases.map((corpusCase) => [corpusCase.id, corpusCase] as const);

describe('the non-shell approvals corpus (EXT-70 §3.2)', () => {
  /**
   * A fixture-driven `it.each` over an empty or filtered array reports as a pass, and every
   * assertion below iterates the whole `cases` array — so what has to be guarded is the fixture
   * itself: a case whose `outcome` or `tripwire` is a value nothing handles would otherwise be
   * *evaluated* and prove nothing.
   */
  describe('the fixture is being read, and every case in it is well formed', () => {
    it('has cases, with both subject kinds and all four outcomes represented', () => {
      expect(CORPUS.cases.length).toBeGreaterThan(0);
      expect(SHELL_CORPUS.cases.length).toBeGreaterThan(0);
      for (const kind of ['tool', 'mcpTool'] as const) {
        expect(
          CORPUS.cases.filter((c) => c.subject === kind).length,
          `no ${kind} case`
        ).toBeGreaterThan(0);
      }
      for (const outcome of CORPUS.labels) {
        expect(
          CORPUS.cases.filter((c) => c.outcome === outcome).length,
          `no case labelled ${outcome}`
        ).toBeGreaterThan(0);
      }
      for (const tripwire of CORPUS.tripwires) {
        expect(
          CORPUS.cases.filter((c) => c.tripwire === tripwire).length,
          `no case whose tripwire is ${tripwire}`
        ).toBeGreaterThan(0);
      }
    });

    it.each(CASE_ROWS)('%s declares a handled outcome, tripwire and subject', (_id, corpusCase) => {
      expect(CORPUS.labels).toContain(corpusCase.outcome);
      expect(CORPUS.tripwires).toContain(corpusCase.tripwire);
      expect(['tool', 'mcpTool']).toContain(corpusCase.subject);
      // An `mcpTool` case without a server would resolve to the unnameable sentinel and quietly
      // stop testing what it says it tests.
      expect(corpusCase.subject === 'mcpTool' ? corpusCase.server : 'n/a').toBeTruthy();
      // The whole premise: the hostility is in the arguments, so there have to be some.
      expect(Object.keys(corpusCase.arguments).length).toBeGreaterThan(0);
    });

    it('ids are unique', () => {
      const ids = CORPUS.cases.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  /**
   * ARMING — half one. The identity resolves as the fixture says, an entry naming that identity
   * matches, and the decision keeps the rater (§3.2, last row: a tool entry recorded identity and
   * never arguments, so it cannot skip the rating).
   */
  describe('an identity-only allow entry matches and arms the tripwire', () => {
    it.each(CASE_ROWS)('%s presents the subject the fixture declares', (_id, corpusCase) => {
      const subject = subjectFor(corpusCase);
      expect(subject.kind).toBe(corpusCase.subject);
      if (subject.kind === 'mcpTool') {
        expect(subject.server).toBe(corpusCase.server);
        expect(subject.name).toBe(corpusCase.tool);
      }
    });

    it.each(CASE_ROWS)('%s matches its own identity, and is rated anyway', (_id, corpusCase) => {
      const decision = resolveApprovalRules(
        subjectFor(corpusCase),
        allowing(identityEntry(corpusCase))
      );
      expect(decision?.action).toBe('allow');
      // §3.2 — the human's part is settled and the rater still sees the call.
      expect(decision?.rate).toBe(true);
    });

    /**
     * The negative direction, which is what stops the assertion above from being true by
     * construction: the entry is built from the case's own name, so a matcher that matched
     * everything would pass it. These name something else and must NOT match.
     */
    it.each(CASE_ROWS)('%s is not matched by an entry naming another tool', (_id, corpusCase) => {
      const other = identityEntry(corpusCase, `${corpusCase.tool}_other`);
      expect(resolveApprovalRules(subjectFor(corpusCase), allowing(other))).toBeNull();
    });

    it.each(CASE_ROWS.filter(([, c]) => c.subject === 'mcpTool'))(
      '%s is not matched by the same tool name under another server (§4.7.5)',
      (_id, corpusCase) => {
        const elsewhere: ApprovalEntry = {
          type: 'mcpTool',
          server: `${corpusCase.server ?? ''}-other`,
          matcher: 'exact',
          pattern: corpusCase.tool,
        };
        expect(resolveApprovalRules(subjectFor(corpusCase), allowing(elsewhere))).toBeNull();
      }
    );

    /**
     * CROSS-CORPUS CONTROL for the `rate` half. Without it, `rate: true` everywhere above would
     * also pass on a decision that hardcoded it. A `shell` + `exact` entry recorded the whole
     * command, so it is the one shape §3.2 lets skip the rater — and the command comes from the
     * shell corpus, so this fails if that fixture moves too.
     */
    it('CONTROL: a shell exact entry over a shell corpus case is NOT rated', () => {
      const shellCase = SHELL_CORPUS.cases.find((c) => c.id === 'ro-01');
      expect(shellCase, 'shell corpus case ro-01 is gone — repoint this control').toBeDefined();
      const subject: ApprovalSubject = { kind: 'shell', command: shellCase!.command };
      const entry: ApprovalEntry = { type: 'shell', matcher: 'exact', pattern: shellCase!.command };
      const decision = resolveApprovalRules(subject, allowing(entry));
      expect(decision?.action).toBe('allow');
      expect(decision?.rate).toBe(false);
      // …and the same entry made a pattern keeps the rater, so `false` above is about the SHAPE.
      expect(approvalEntryRatesCall({ ...entry, matcher: 'glob' })).toBe(true);
    });
  });

  /**
   * CONSEQUENCE — half two. §3.2: on a call an allow entry already matched, the rating is a
   * TRIPWIRE, not a re-adjudication. `safe` and `destructive` both run, `catastrophic` escalates,
   * `attack` halts.
   */
  describe('what the §3.2 tripwire does with each case', () => {
    it.each(CASE_ROWS)('%s: its outcome maps to its declared tripwire', (_id, corpusCase) => {
      const verdict: ShellSafetyVerdict = {
        outcome: corpusCase.outcome,
        reason: `corpus case ${corpusCase.id}`,
      };
      const decision = mapAllowMatchedVerdictToAction(verdict);
      expect(decision.action).toBe(TRIPWIRE_ACTIONS[corpusCase.tripwire]);
      // The verdict is carried through, because the human who is escalated to gets the reason.
      expect(decision.verdict).toEqual(verdict);
    });

    /**
     * THE CONTROL ON THE CONSEQUENCE AXIS, stated as its own assertion because it is the one a
     * reader has to be able to find. Arming is argument-independent BY DESIGN — every case above
     * arms, hostile or not — so the benign cases discriminate nothing there. They discriminate
     * here: a tripwire that fired on everything, or on everything non-`safe`, fails on these.
     */
    it('does not trip on the benign half, including a `destructive` one', () => {
      const running = CORPUS.cases.filter((c) => c.tripwire === 'run');
      expect(running.map((c) => c.outcome)).toContain('safe');
      expect(running.map((c) => c.outcome)).toContain('destructive');
      for (const corpusCase of running) {
        expect(
          mapAllowMatchedVerdictToAction({ outcome: corpusCase.outcome, reason: 'x' }).action,
          corpusCase.id
        ).toBe('approve');
      }
    });
  });

  /**
   * THE PAIRS ARE THE POINT OF THE WHOLE FIXTURE — *"an innocuous tool NAME with hostile
   * ARGUMENTS"*. A pair is two cases with the SAME identity and different outcomes, so the one
   * allow entry a user could write matches both and only the rating separates them. Asserted rather
   * than described, because a pair that drifted apart in its tool name would still read as a pair.
   */
  describe('the identity is shared and only the arguments differ', () => {
    const paired = CASE_ROWS.filter(([, c]) => c.pairs_with !== undefined);

    it('there are pairs', () => {
      expect(paired.length).toBeGreaterThan(0);
    });

    it.each(paired)('%s and its pair share one identity and differ in outcome', (_id, one) => {
      const other = CORPUS.cases.find((c) => c.id === one.pairs_with);
      expect(
        other,
        `${one.id} pairs with ${one.pairs_with}, which is not in the fixture`
      ).toBeDefined();
      expect(other!.pairs_with, 'pairing is mutual').toBe(one.id);
      // Same subject, same name, same server: the SAME entry claims both.
      expect(registeredName(other!)).toBe(registeredName(one));
      expect(other!.subject).toBe(one.subject);
      expect(other!.outcome).not.toBe(one.outcome);
      expect(other!.arguments).not.toEqual(one.arguments);

      // …and that is not a claim about the fixture's contents alone: one entry, built from ONE of
      // the two, matches the other as well, with the rater kept in both cases.
      const entry = identityEntry(one);
      for (const corpusCase of [one, other!]) {
        const decision = resolveApprovalRules(subjectFor(corpusCase), allowing(entry));
        expect(decision?.action, corpusCase.id).toBe('allow');
        expect(decision?.rate, corpusCase.id).toBe(true);
      }
      // Only the rating tells them apart.
      expect(mapAllowMatchedVerdictToAction({ outcome: one.outcome, reason: 'x' }).action).not.toBe(
        mapAllowMatchedVerdictToAction({ outcome: other!.outcome, reason: 'x' }).action
      );
    });
  });
});
