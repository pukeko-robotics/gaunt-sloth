import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RUNG_DESCRIPTIONS,
  APPROVAL_RUNG_LABELS,
  APPROVAL_RUNGS,
  type ApprovalEntry,
  DEFAULT_APPROVAL_RUNG,
  isApprovalRung,
  isRatedRung,
  resolveApprovals,
  type ResolvedApprovals,
} from '#src/config/shell-policy.js';
import { resolveApprovalRules } from '#src/core/approvals/matcher.js';
import type { GthCommand } from '#src/core/types.js';

/**
 * CFG-27 — `resolveApprovals` is the ONE place the `approvals` value is turned into a posture.
 *
 * There is deliberately NO context matrix left to pin: §1.1 makes `auto-safe` the default in
 * EVERY context, interactive or not, and it does not vary with the configured model. What varies
 * without a human is what an escalation DOES (§6.2 — the runner exits instead of prompting), not
 * which rung the session starts on. So the resolver neither detects nor accepts a "context", and
 * these tests pin that absence as hard as they pin the precedence rules.
 */
type ApprovalsInput = Parameters<typeof resolveApprovals>[0];

const ALL_COMMANDS: readonly GthCommand[] = ['code', 'chat', 'exec', 'ask', 'review', 'pr', 'api'];

/**
 * What the resolved posture DECIDES about a shell command, through the one comparison engine
 * (`resolveApprovalRules`) rather than by reading the arrays back.
 *
 * Asserting the decision is the point: an array assertion is satisfied by two copies of one entry,
 * by entries that match nothing, and by a concatenation in which the surviving list happens to be
 * the wrong one. It also keeps these tests blind to concatenation ORDER, which is what makes the
 * order genuinely irrelevant rather than merely unasserted — every deny entry is consulted before
 * any escalate entry and every escalate entry before any allow entry, so only WHICH entry gets
 * reported can depend on order, and nothing here reads that.
 */
const decisionFor = (
  command: string,
  approvals: ResolvedApprovals
): 'deny' | 'escalate' | 'allow' | undefined =>
  resolveApprovalRules(
    { kind: 'shell', command },
    { allow: approvals.allow, deny: approvals.deny, escalate: approvals.escalate }
  )?.action;

describe('resolveApprovals (CFG-27 ladder)', () => {
  describe('§1.1 — the default rung is auto-safe, everywhere', () => {
    it.each(ALL_COMMANDS)('%s with no `approvals` key resolves to auto-safe', (command) => {
      expect(resolveApprovals(undefined, command)).toEqual({
        rung: 'auto-safe',
        rater: undefined,
        allow: [],
        deny: [],
        escalate: [],
      });
    });

    it('is auto-safe for an unknown/absent command too', () => {
      expect(resolveApprovals(undefined, undefined).rung).toBe('auto-safe');
      expect(DEFAULT_APPROVAL_RUNG).toBe('auto-safe');
    });

    it('takes no context/TTY argument at all — there is no second default to disagree with', () => {
      // The resolver's arity is (config, command). A third "interactive" parameter is exactly the
      // hidden branching the ladder exists to remove.
      expect(resolveApprovals.length).toBe(2);
    });
  });

  describe('§9.1 — the scalar form is exactly sugar for { mode: <value> }', () => {
    it.each(APPROVAL_RUNGS)(
      '"%s" resolves identically written as a scalar or an object',
      (rung) => {
        const scalar = resolveApprovals({ approvals: rung } as ApprovalsInput, 'code');
        const object = resolveApprovals({ approvals: { mode: rung } } as ApprovalsInput, 'code');
        expect(scalar).toEqual(object);
        expect(scalar.rung).toBe(rung);
      }
    );
  });

  /**
   * §9.1 / §11.1f (ratified 2026-08-02) — **a per-command value overrides only the fields it
   * NAMES, and the three rule lists always concatenate.** This describe pinned the opposite until
   * that amendment: a per-command value replaced the root wholesale, so `"code": { "approvals":
   * "bypass" }` — the spelling the docs teach — also deleted every root `deny` entry, at the one
   * rung where the deny list and the §8 floor are the only checks left.
   *
   * The rule now: `mode` / `rater` / `raterTimeoutMs` are replaced when the per-command value
   * states them and inherited when it does not; `allow` / `deny` / `escalate` never replace. No
   * scope can narrow another scope's lists, only add to them — narrowing is what `deny` and
   * `escalate` are *for*. Removing an inherited prohibition for one command is deliberately not
   * expressible, so there is no syntax here to look for.
   */
  describe('§9.1/§11.1f — a per-command value overrides only the fields it names', () => {
    /** The §11.1f config, verbatim: a root deny plus the friendly per-command scalar. */
    const ROOT_DENY: ApprovalEntry = {
      type: 'shell',
      matcher: 'glob',
      pattern: 'npm publish*',
    };
    const SCALAR_OVERRIDE_CONFIG = {
      approvals: { mode: 'auto-safe', deny: [ROOT_DENY] },
      commands: { code: { approvals: 'bypass' } },
    } as unknown as ApprovalsInput;

    it('the root deny list SURVIVES a per-command scalar rung', () => {
      const resolved = resolveApprovals(SCALAR_OVERRIDE_CONFIG, 'code');
      // CONTROL — the override really took effect. Without this the assertion below would pass
      // just as happily on a config where the per-command value was never read at all, which is
      // exactly the state a regression would leave it in.
      expect(resolved.rung).toBe('bypass');
      expect(resolved.deny).toEqual([ROOT_DENY]);
      // …and it is the DECISION that survives, not merely an array: the subject is refused.
      expect(decisionFor('npm publish --access public', resolved)).toBe('deny');
    });

    it('the scalar sets the rung and NOTHING else — rater and raterTimeoutMs inherit', () => {
      const resolved = resolveApprovals(
        {
          approvals: { mode: 'auto-safe', rater: 'safety-rater', raterTimeoutMs: 90_000 },
          commands: { code: { approvals: 'bypass' } },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(resolved.rung).toBe('bypass');
      expect(resolved.rater).toBe('safety-rater');
      expect(resolved.raterTimeoutMs).toBe(90_000);
    });

    it('CONTROL: a per-command value that DOES name rater/raterTimeoutMs replaces them', () => {
      // The other direction. Without it the test above pins only "the field has some value",
      // which a resolver that ignored the per-command block entirely would also satisfy.
      const resolved = resolveApprovals(
        {
          approvals: { mode: 'auto-safe', rater: 'safety-rater', raterTimeoutMs: 90_000 },
          commands: { code: { approvals: { rater: 'strict-rater', raterTimeoutMs: 5_000 } } },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toBe('strict-rater');
      expect(resolved.raterTimeoutMs).toBe(5_000);
      // `mode` was not named, so it is inherited rather than reset to the default.
      expect(resolved.rung).toBe('auto-safe');
    });

    it('an explicit per-command deny ADDS to the root deny rather than replacing it', () => {
      const resolved = resolveApprovals(
        {
          approvals: { mode: 'auto-safe', deny: [ROOT_DENY] },
          commands: {
            code: {
              approvals: {
                mode: 'bypass',
                deny: [{ type: 'shell', matcher: 'glob', pattern: 'git push --force*' }],
              },
            },
          },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(resolved.rung).toBe('bypass');
      // Asserted as DECISIONS, both directions: a length-2 array would also be satisfied by two
      // copies of the same entry, and by entries that match nothing.
      expect(decisionFor('npm publish --access public', resolved)).toBe('deny');
      expect(decisionFor('git push --force origin main', resolved)).toBe('deny');
      // …and the concatenation did not widen into a refuse-everything.
      expect(decisionFor('npm test', resolved)).toBeUndefined();
    });

    it('allow and escalate concatenate the same way', () => {
      const resolved = resolveApprovals(
        {
          approvals: {
            mode: 'auto-safe',
            allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
            escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
          },
          commands: {
            code: {
              approvals: {
                allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm run build' }],
                escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform destroy' }],
              },
            },
          },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(decisionFor('npm test', resolved)).toBe('allow');
      expect(decisionFor('npm run build', resolved)).toBe('allow');
      expect(decisionFor('terraform apply', resolved)).toBe('escalate');
      expect(decisionFor('terraform destroy', resolved)).toBe('escalate');
      expect(decisionFor('rm -rf /tmp/x', resolved)).toBeUndefined();
    });

    it('CONTROL: the root lists are counted ONCE, not once per scope', () => {
      // The failure mode of the fix, rather than of the defect: a resolver that folded the root
      // in twice would still refuse the right commands and pass every assertion above.
      const resolved = resolveApprovals(SCALAR_OVERRIDE_CONFIG, 'code');
      expect(resolved.deny).toHaveLength(1);
      expect(resolved.allow).toHaveLength(0);
      expect(resolved.escalate).toHaveLength(0);
    });

    it('a command with NO per-command block sees exactly the root value', () => {
      const resolved = resolveApprovals(SCALAR_OVERRIDE_CONFIG, 'review');
      expect(resolved.rung).toBe('auto-safe');
      expect(resolved.deny).toEqual([ROOT_DENY]);
    });

    it('a per-command scalar sets the rung for that command only (the §9 example)', () => {
      const config = {
        approvals: 'full-auto',
        commands: { pr: { approvals: 'read-only' }, review: { approvals: 'read-only' } },
      } as unknown as ApprovalsInput;
      expect(resolveApprovals(config, 'pr').rung).toBe('read-only');
      expect(resolveApprovals(config, 'review').rung).toBe('read-only');
      expect(resolveApprovals(config, 'code').rung).toBe('full-auto');
    });

    it('a root value applies to a one-shot command too — the default is defaults ONLY', () => {
      expect(resolveApprovals({ approvals: 'bypass' } as ApprovalsInput, 'exec').rung).toBe(
        'bypass'
      );
    });
  });

  describe('§9.1 — rater is a bare profile name; the three lists are read-only input', () => {
    it('carries the rater profile through as a plain string', () => {
      const resolved = resolveApprovals(
        { approvals: { mode: 'auto-safe', rater: 'safety-rater' } } as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toBe('safety-rater');
    });

    it('carries the declared allow, deny and escalate lists through unchanged (EXT-71 §3.1)', () => {
      const allow: ApprovalEntry[] = [
        { type: 'shell', matcher: 'exact', pattern: 'npm test' },
        { type: 'shell', matcher: 'glob', pattern: 'git status*', rate: false },
      ];
      const deny: ApprovalEntry[] = [
        { type: 'shell', matcher: 'exact', pattern: 'git push --force' },
        { type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'delete_issue' },
      ];
      const escalate: ApprovalEntry[] = [
        { type: 'mcpTool', server: '*', matcher: 'hint', pattern: { destructiveHint: true } },
      ];
      const resolved = resolveApprovals(
        { approvals: { mode: 'auto-safe', allow, deny, escalate } } as ApprovalsInput,
        'code'
      );
      expect(resolved.allow).toEqual(allow);
      expect(resolved.deny).toEqual(deny);
      expect(resolved.escalate).toEqual(escalate);
    });
  });

  describe('the rung vocabulary', () => {
    it('is exactly the five ordered rungs', () => {
      expect([...APPROVAL_RUNGS]).toEqual([
        'read-only',
        'write',
        'auto-safe',
        'full-auto',
        'bypass',
      ]);
    });

    it('rates at auto-safe and full-auto only — rungs 1, 2 and 5 consult no model', () => {
      expect(APPROVAL_RUNGS.filter(isRatedRung)).toEqual(['auto-safe', 'full-auto']);
    });

    it('recognises only the five kebab-case identifiers (the retired ones are not aliases)', () => {
      for (const rung of APPROVAL_RUNGS) expect(isApprovalRung(rung)).toBe(true);
      for (const retired of ['auto', 'ask', 'yolo', 'Read only', '']) {
        expect(isApprovalRung(retired)).toBe(false);
      }
    });

    it('§9.1 — identifiers are kebab-case and survive a shell; labels keep their spaces', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(rung).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(APPROVAL_RUNG_LABELS[rung]).toBeTruthy();
      }
      expect(APPROVAL_RUNG_LABELS['read-only']).toBe('Read only');
      expect(APPROVAL_RUNG_LABELS['auto-safe']).toBe('Auto safe');
      expect(APPROVAL_RUNG_LABELS['full-auto']).toBe('Full auto');
    });
  });

  /**
   * §10 — the five descriptions are copied verbatim from the specification and their wording is
   * constrained by four normative rules plus §8.1. These pin the CONSTRAINTS, not the prose, so a
   * well-meaning edit that breaks one of them fails here rather than in review.
   */
  describe('§10 — the user-facing descriptions', () => {
    it('rule 1: auto-safe states that files are STILL rewritten and deleted without asking', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['auto-safe'];
      expect(text).toContain('rewrite and delete files in your working folder without asking');
      expect(text).toContain('not that nothing changes');
    });

    it('rule 2: every rung that asks for approval states the always-allow carve-out', () => {
      for (const rung of ['read-only', 'write'] as const) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).toContain(
          'until you tell it to always allow a command'
        );
      }
    });

    it('rule 3: full-auto is safer than bypass and explicitly NOT safe, and points at real gates', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['full-auto'];
      expect(text).toContain('safer than bypass');
      expect(text).toContain('it is not safe');
      expect(text).toContain('deployment approvals, two-factor, branch protection');
    });

    /**
     * Rule 3 again, on the half that went stale: what this rung claims the rater still DOES has to
     * be a claim the rater is specified to keep. It names the four structural `attack` tests (§4.1.1)
     * and the §6.1 irreversibility question — not an outcome. The clause it replaced promised a halt
     * on "anything that would send your secrets off the machine", which §11.1b's narrowing made
     * false: a secret handed to a working tool rates `destructive`, so it comes to the user rather
     * than ending the run. A description may only promise what the scale actually delivers.
     */
    it('rule 3: full-auto describes what the rater tests for, not an outcome it cannot guarantee', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['full-auto'];
      expect(text).toContain('brings anything it cannot undo to you');
      expect(text).toContain('reads your keys or passwords');
    });

    it('§8.1: no description advertises the hardline floor — only the deny list is cited', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toMatch(/hardline|floor|blocklist/i);
      }
      expect(APPROVAL_RUNG_DESCRIPTIONS.bypass).toContain('deny list');
      expect(APPROVAL_RUNG_DESCRIPTIONS['full-auto']).toContain('deny list');
    });

    it('rule 4: the kebab-case identifiers never appear in the prose', () => {
      for (const rung of APPROVAL_RUNGS) {
        for (const identifier of ['read-only', 'auto-safe', 'full-auto']) {
          expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toContain(identifier);
        }
      }
    });

    it('every rung has one', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung].length).toBeGreaterThan(40);
      }
    });
  });
});
