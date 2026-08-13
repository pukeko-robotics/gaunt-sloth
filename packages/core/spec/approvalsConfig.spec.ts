import { describe, expect, it } from 'vitest';
import {
  APPROVAL_PROTECTION_DOCS_LINES,
  APPROVAL_PROTECTION_DOCS_URL,
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
import { createEffectiveToolAnnotationSource } from '#src/core/approvals/annotations.js';
import { resolveApprovalRules } from '#src/core/approvals/matcher.js';
import type { GthCommand } from '#src/core/types.js';

/**
 * CFG-27 — `resolveApprovals` is the ONE place the `approvals` value is turned into a posture.
 *
 * There is deliberately NO context matrix left to pin: §1.1 makes `assisted` the default in
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
  describe('§1.1 — the default rung is assisted, everywhere', () => {
    it.each(ALL_COMMANDS)('%s with no `approvals` key resolves to assisted', (command) => {
      expect(resolveApprovals(undefined, command)).toEqual({
        rung: 'assisted',
        rater: undefined,
        allow: [],
        deny: [],
        escalate: [],
      });
    });

    it('is assisted for an unknown/absent command too', () => {
      expect(resolveApprovals(undefined, undefined).rung).toBe('assisted');
      expect(DEFAULT_APPROVAL_RUNG).toBe('assisted');
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
      approvals: { mode: 'assisted', deny: [ROOT_DENY] },
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
          approvals: { mode: 'assisted', rater: 'safety-rater', raterTimeoutMs: 90_000 },
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
          approvals: { mode: 'assisted', rater: 'safety-rater', raterTimeoutMs: 90_000 },
          commands: { code: { approvals: { rater: 'strict-rater', raterTimeoutMs: 5_000 } } },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toBe('strict-rater');
      expect(resolved.raterTimeoutMs).toBe(5_000);
      // `mode` was not named, so it is inherited rather than reset to the default.
      expect(resolved.rung).toBe('assisted');
    });

    it('an explicit per-command deny ADDS to the root deny rather than replacing it', () => {
      const resolved = resolveApprovals(
        {
          approvals: { mode: 'assisted', deny: [ROOT_DENY] },
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

    it('escalate concatenates exactly as deny does', () => {
      const resolved = resolveApprovals(
        {
          approvals: {
            mode: 'assisted',
            escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
          },
          commands: {
            code: {
              approvals: {
                escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform destroy' }],
              },
            },
          },
        } as unknown as ApprovalsInput,
        'code'
      );
      expect(decisionFor('terraform apply', resolved)).toBe('escalate');
      expect(decisionFor('terraform destroy', resolved)).toBe('escalate');
      expect(decisionFor('rm -rf /tmp/x', resolved)).toBeUndefined();
    });

    /**
     * §9.1/§11.1f — **`allow` is the exception, and it goes the other way.** The restrictive lists
     * concatenate; the permissive one is REPLACED when the per-command value states its own and
     * inherited when it does not. So a scope may narrow what runs unprompted and may never widen
     * what is prohibited.
     *
     * The reason is §3.1's cost asymmetry, and it is what these tests are really pinning: a missed
     * allow entry escalates and a missed deny entry falls through to the rater — neither executes —
     * while a too-broad allow entry RUNS, unrated and unprompted. Concatenating `allow` would also
     * leave a deliberately restrictive per-command rung silently inheriting every standing grant
     * the root ever made, with no way to shed them.
     */
    describe('§9.1 — allow is replaced, not concatenated', () => {
      const ROOT_ALLOW: ApprovalEntry = { type: 'shell', matcher: 'exact', pattern: 'npm test' };

      it("a per-command allow REPLACES the root's", () => {
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', allow: [ROOT_ALLOW], deny: [ROOT_DENY] },
            commands: {
              code: {
                approvals: {
                  allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm run build' }],
                },
              },
            },
          } as unknown as ApprovalsInput,
          'code'
        );
        // The command's own list is in force…
        expect(decisionFor('npm run build', resolved)).toBe('allow');
        // …and the root's is NOT: this command no longer auto-approves what the root trusted.
        expect(decisionFor('npm test', resolved)).toBeUndefined();
        // CONTROL — narrowing the PERMISSIVE list did not weaken the RESTRICTIVE one. Without
        // this, a resolver that dropped every root list on any per-command block would pass the
        // assertion above while silently reopening the defect this whole task exists to close.
        expect(decisionFor('npm publish --access public', resolved)).toBe('deny');
      });

      it('a per-command value stating NO allow inherits the root list', () => {
        // The other direction. Without it the test above pins only "the root list went away",
        // which a resolver that ignored `allow` entirely would satisfy just as well.
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', allow: [ROOT_ALLOW] },
            commands: { code: { approvals: 'write' } },
          } as unknown as ApprovalsInput,
          'code'
        );
        expect(resolved.rung).toBe('write'); // CONTROL — the per-command value really applied
        expect(decisionFor('npm test', resolved)).toBe('allow');
      });

      it('the measured regression: a restrictive rung with its own allow does NOT inherit', () => {
        // The case that motivated the amendment, in its own words: `pr` is set to `manual`
        // precisely because it should ask, and §2.1 applies the allow-list at that rung — so an
        // inherited root grant would auto-approve there exactly what the rung was chosen to stop.
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', allow: [ROOT_ALLOW] },
            commands: {
              pr: {
                approvals: {
                  mode: 'manual',
                  allow: [{ type: 'shell', matcher: 'exact', pattern: 'git status' }],
                },
              },
            },
          } as unknown as ApprovalsInput,
          'pr'
        );
        expect(resolved.rung).toBe('manual'); // CONTROL — the rung really is the restrictive one
        expect(decisionFor('npm test', resolved)).toBeUndefined();
        expect(decisionFor('git status', resolved)).toBe('allow');
      });

      it('an EXPLICIT empty allow narrows to nothing — it is a statement, not a silence', () => {
        // `[]` says "nothing is pre-trusted for this command". Resolving it with `||` or a
        // truthiness check would read it as "said nothing" and hand back the root's list.
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', allow: [ROOT_ALLOW] },
            commands: { code: { approvals: { allow: [] } } },
          } as unknown as ApprovalsInput,
          'code'
        );
        expect(decisionFor('npm test', resolved)).toBeUndefined();
      });
    });

    /**
     * EXT-70 §4.7/§9 — `mcp` follows `allow`, not the restrictive lists. Believing a hint is a
     * PERMISSIVE act in both directions (it can make an allow hint entry fire, and can make a deny
     * hint entry stop firing), so it is replaced when a command states its own and inherited when
     * it does not — never merged, which would leave a deliberately distrustful per-command block
     * silently carrying the root's trust.
     *
     * Asserted through the effective annotation set rather than by reading the block back, for the
     * same reason the lists are asserted through a decision: an object assertion is satisfied by a
     * block that resolves to something no consumer would agree with.
     */
    describe('§4.7/§9 — the mcp trust block is replaced, not merged', () => {
      const ROOT_MCP = { servers: { jira: { trustAnnotations: ['readOnlyHint' as const] } } };
      /** Whether jira's declared `readOnlyHint: true` survives into the effective set. */
      const jiraReadOnly = (resolved: ResolvedApprovals): boolean =>
        createEffectiveToolAnnotationSource({
          mcp: resolved.mcp,
          declared: { mcp: () => ({ readOnlyHint: true }) },
        })({ kind: 'mcpTool', server: 'jira', name: 'get_issue' }).readOnlyHint;

      it("a per-command mcp REPLACES the root's, and does not inherit its servers", () => {
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', mcp: ROOT_MCP, deny: [ROOT_DENY] },
            commands: {
              pr: {
                approvals: {
                  mode: 'manual',
                  mcp: { servers: { confluence: { trustAnnotations: ['readOnlyHint'] } } },
                },
              },
            },
          } as unknown as ApprovalsInput,
          'pr'
        );
        expect(resolved.rung).toBe('manual'); // CONTROL — the per-command value really applied
        expect(jiraReadOnly(resolved)).toBe(false);
        // CONTROL — narrowing trust did not weaken the restrictive list.
        expect(decisionFor('npm publish --access public', resolved)).toBe('deny');
      });

      it('a per-command value stating NO mcp inherits the root block', () => {
        // The other direction. Without it the test above pins only "the root block went away",
        // which a resolver that ignored `mcp` entirely would satisfy just as well.
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', mcp: ROOT_MCP },
            commands: { code: { approvals: 'write' } },
          } as unknown as ApprovalsInput,
          'code'
        );
        expect(resolved.rung).toBe('write'); // CONTROL — the per-command value really applied
        expect(jiraReadOnly(resolved)).toBe(true);
      });

      it('an EXPLICIT empty mcp believes nothing — it is a statement, not a silence', () => {
        const resolved = resolveApprovals(
          {
            approvals: { mode: 'assisted', mcp: ROOT_MCP },
            commands: { code: { approvals: { mcp: {} } } },
          } as unknown as ApprovalsInput,
          'code'
        );
        expect(jiraReadOnly(resolved)).toBe(false);
      });

      it('is left undefined when no scope states one, so the config snapshot does not churn', () => {
        expect(
          resolveApprovals({ approvals: 'assisted' } as ApprovalsInput, 'code').mcp
        ).toBeUndefined();
      });
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
      expect(resolved.rung).toBe('assisted');
      expect(resolved.deny).toEqual([ROOT_DENY]);
    });

    it('a per-command scalar sets the rung for that command only (the §9 example)', () => {
      const config = {
        approvals: 'auto',
        commands: { pr: { approvals: 'manual' }, review: { approvals: 'manual' } },
      } as unknown as ApprovalsInput;
      expect(resolveApprovals(config, 'pr').rung).toBe('manual');
      expect(resolveApprovals(config, 'review').rung).toBe('manual');
      expect(resolveApprovals(config, 'code').rung).toBe('auto');
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
        { approvals: { mode: 'assisted', rater: 'safety-rater' } } as ApprovalsInput,
        'code'
      );
      expect(resolved.rater).toBe('safety-rater');
    });

    /**
     * A root-only config, so this pins pass-through and nothing else. Note the three lists reach it
     * by DIFFERENT routes (§9.1): `deny` and `escalate` are concatenated with an empty per-command
     * list, `allow` is inherited because no per-command list was stated. They agree here precisely
     * because there is one scope — do not read this test as evidence that they merge alike.
     */
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
        { approvals: { mode: 'assisted', allow, deny, escalate } } as ApprovalsInput,
        'code'
      );
      expect(resolved.allow).toEqual(allow);
      expect(resolved.deny).toEqual(deny);
      expect(resolved.escalate).toEqual(escalate);
    });
  });

  describe('the rung vocabulary', () => {
    it('is exactly the five ordered rungs', () => {
      expect([...APPROVAL_RUNGS]).toEqual(['manual', 'write', 'assisted', 'auto', 'bypass']);
    });

    it('rates at assisted and auto only — rungs 1, 2 and 5 consult no model', () => {
      expect(APPROVAL_RUNGS.filter(isRatedRung)).toEqual(['assisted', 'auto']);
    });

    it('recognises only the five identifiers (the retired spellings are not aliases)', () => {
      for (const rung of APPROVAL_RUNGS) expect(isApprovalRung(rung)).toBe(true);
      // CFG-39 — the three renamed spellings, plus the pre-2.0 vocabulary, a display label and the
      // empty string. `auto` is deliberately NOT in this list: it is a live identifier now, and the
      // cell below pins that.
      for (const retired of ['read-only', 'auto-safe', 'full-auto', 'ask', 'yolo', 'Manual', '']) {
        expect(isApprovalRung(retired)).toBe(false);
      }
    });

    it('CFG-39: "auto" is a live identifier, not a retired one', () => {
      expect(isApprovalRung('auto')).toBe(true);
    });

    it('§9.1 — identifiers are kebab-case and survive a shell; labels keep their spaces', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(rung).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(APPROVAL_RUNG_LABELS[rung]).toBeTruthy();
      }
      expect(APPROVAL_RUNG_LABELS['manual']).toBe('Manual');
      expect(APPROVAL_RUNG_LABELS['assisted']).toBe('Assisted');
      expect(APPROVAL_RUNG_LABELS['auto']).toBe('Auto');
    });
  });

  /**
   * §10 — the five descriptions say what each mode is FOR, in at most two sentences, under four
   * normative rules plus §8.1. These pin the CONSTRAINTS, not the prose, so a well-meaning edit
   * that breaks one of them fails here rather than in review.
   */
  describe('§10 — the user-facing descriptions', () => {
    /**
     * A sentence ends at `.`, `?` or `!` followed by a space or the end of the string, and an
     * ellipsis is a pause rather than three of them — the same boundary `firstSentence` cuts at.
     * Counted here rather than imported because `firstSentence` lives a layer up, in the agent
     * package, and core does not depend on it.
     */
    const countSentences = (text: string): number =>
      (text.match(/(?<!\.)[.?!](?=\s|$)/g) ?? []).length;

    it('the budget: every mode is described in at most two sentences', () => {
      for (const rung of APPROVAL_RUNGS) {
        const text = APPROVAL_RUNG_DESCRIPTIONS[rung];
        expect(countSentences(text), `${rung}'s description: "${text}"`).toBeLessThanOrEqual(2);
        // Two, not one run-on: the first sentence has to end somewhere, because it is the whole of
        // what a picker row and the usage hint show.
        expect(countSentences(text)).toBeGreaterThanOrEqual(2);
      }
    });

    /**
     * The category error this copy exists to prevent: Manual reads as "the safe one", so it gets
     * chosen for a long unattended run — where every decision falls to a human, and a human's
     * decision quality degrades with volume while a rater's does not. Both deterministic modes
     * say they are for a bounded amount of work.
     */
    it('Manual and Write are described as bounded-volume tools, not as the safe choice', () => {
      expect(APPROVAL_RUNG_DESCRIPTIONS['manual']).toContain('not a mode to leave running');
      expect(APPROVAL_RUNG_DESCRIPTIONS['write']).toContain('like Manual a bounded stretch');
    });

    it('rule 1: assisted states that files are STILL rewritten and deleted without asking', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['assisted'];
      expect(text).toContain('rewrite and delete files in your working folder without asking');
      expect(text).toContain('not that nothing changes');
    });

    it('rule 2: every mode that asks for approval states the always-allow carve-out', () => {
      for (const rung of ['manual', 'write'] as const) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).toContain(
          'until you tell it to always allow a command'
        );
      }
    });

    /**
     * The half of Assisted that is a feature rather than a restriction: the approval prompt carries
     * the rater's reason, so a user reading it learns what the command does instead of only judging
     * it. Hedged deliberately — the reason comes from a model, and on a rating timeout it says only
     * that the command could not be assessed, so the copy may claim the explanation but never
     * promise it is always there or always right.
     */
    it('rule 3: assisted offers the explanation without promising it', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['assisted'];
      expect(text).toContain('explaining what it does');
      expect(text).toMatch(/usually/);
      expect(text).not.toMatch(/always explains|tells you exactly what/i);
    });

    /**
     * Rule 3 on the mode with the most room to overclaim. Auto now differs from Assisted — [[EXT-29]]'s
     * negotiation hands a risky command back to the agent instead of interrupting — and the copy may
     * say so, but three claims are what stop that difference reading as a quiet, hands-off mode:
     *
     * 1. **Still not safe**, in the same words the other modes use for it. A negotiation changes who
     *    answers first; it does not stop Gaunt Sloth changing and deleting things, and the deny list
     *    is still the protection a user can inspect and extend.
     * 2. **It still ends at the user.** Both bounds exist so a person is reached, and a reader
     *    deciding whether to leave Auto running has to be told that.
     * 3. **No visibility that does not render.** The rounds reach a person at the escalation, all of
     *    them at once; nothing shows them while they happen ([[TUI-C26]]).
     *
     * Shipping copy that advertises a difference the product does not have is the one unacceptable
     * outcome here, and a field tester hit precisely that on `git clone`.
     */
    it('rule 3: auto states the negotiation, and states that it is neither safe nor unattended', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['auto'];
      // (1) Not safe, in the mode's own words.
      expect(text).toContain('It is not safe');
      expect(text).toContain('will change and delete things');
      // (2) The difference is stated, and so is its terminus.
      expect(text).toContain('back to the agent');
      expect(text).toContain('then asks you');
      // (3) The argument reaches the user AT the escalation — never as a running commentary.
      expect(text).toContain('when it does ask');
      expect(text).not.toMatch(/as it happens|watch|live|on screen/i);
      // The promise this mode does not keep: the bounds mean a person is always reachable.
      expect(text).not.toMatch(/does not stop to ask|never interrupts|unattended|hands.off/i);
    });

    it('§8.1: no description advertises the hardline floor — only the deny list is cited', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toMatch(/hardline|floor|blocklist/i);
      }
      expect(APPROVAL_RUNG_DESCRIPTIONS.bypass).toContain('deny list');
      expect(APPROVAL_RUNG_DESCRIPTIONS['auto']).toContain('deny list');
    });

    /**
     * **No description may imply containment.** "The agent cannot write outside your working
     * folder" is false wherever the agent has a shell — measured: `write_file` refused a path that
     * `touch` then wrote. The narrow true form is that the built-in file *tools* are confined, and
     * it is stated once, on `write`, in the same breath as the fact that the shell is not.
     */
    it('rule 3: the working-folder claim is made once, about the TOOLS, and never generalised', () => {
      const text = APPROVAL_RUNG_DESCRIPTIONS['write'];
      expect(text).toContain('built-in file tools run free inside your working folder');
      expect(text).toContain('The shell is not confined that way');
      for (const rung of APPROVAL_RUNGS) {
        expect(
          APPROVAL_RUNG_DESCRIPTIONS[rung],
          `${rung}'s description claims the agent itself is confined`
        ).not.toMatch(/cannot (write|reach|go|touch|escape)/i);
      }
    });

    /**
     * [[EXT-54]] — the AG-UI and ACP servers build their own agent and never drain an approval
     * interrupt, so a universal "Gaunt Sloth always asks" is false there. These strings render on
     * terminal surfaces only, so the claim is scoped to the session the user is in — the standing
     * rule for in-product approval copy, ratified 2026-08-13 ([[CFG-40]]).
     */
    it('rule 3: no description promises that Gaunt Sloth ALWAYS asks', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toMatch(/always asks|will always ask/i);
      }
    });

    /**
     * CFG-39 — rule 4 used to be spelled "the kebab-case identifiers never appear in the prose",
     * and a substring test could enforce it because `read-only` / `auto-safe` / `full-auto` were
     * not words anyone would write. The renamed identifiers ARE ordinary words, and two of them
     * legitimately occur in this copy — "the auto-rater" contains `auto`, and `assisted`'s own
     * sentence refers to what `write` grants. So a substring test now asserts something false
     * rather than something useful.
     *
     * What it is re-pointed at is the failure the rename actually threatens: a RETIRED spelling
     * surviving in copy the user reads, which would name a mode the gate no longer has.
     */
    it('rule 4: no retired mode spelling survives in the prose', () => {
      for (const rung of APPROVAL_RUNGS) {
        for (const retired of ['read-only', 'auto-safe', 'full-auto']) {
          expect(
            APPROVAL_RUNG_DESCRIPTIONS[rung],
            `${rung}'s description still names the retired spelling "${retired}"`
          ).not.toContain(retired);
        }
      }
    });

    it('every rung has one', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung].length).toBeGreaterThan(40);
      }
    });

    /**
     * The two-sentence budget is affordable only because the reasoning has somewhere to live. The
     * pointer is a pair of LINES — label, then the bare URL — because every notice surface renders
     * one line per entry: a URL alone on its line is what keeps a narrow pane from breaking it
     * mid-path, and what lets a terminal that linkifies URLs pick up the whole address.
     */
    it('the docs pointer is two lines, and the URL is one of them, bare', () => {
      expect(APPROVAL_PROTECTION_DOCS_LINES).toHaveLength(2);
      expect(APPROVAL_PROTECTION_DOCS_LINES[1]).toBe(APPROVAL_PROTECTION_DOCS_URL);
      expect(APPROVAL_PROTECTION_DOCS_URL).toMatch(/^https:\/\/\S+$/);
      expect(APPROVAL_PROTECTION_DOCS_URL).toContain('what-approvals-protect-you-from');
    });

    it('no description carries the URL itself — the surfaces print it once, beside the copy', () => {
      for (const rung of APPROVAL_RUNGS) {
        expect(APPROVAL_RUNG_DESCRIPTIONS[rung]).not.toContain('http');
      }
    });
  });
});
