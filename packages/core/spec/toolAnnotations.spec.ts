import { describe, expect, it } from 'vitest';
import {
  createEffectiveToolAnnotationSource,
  type DeclaredToolAnnotations,
  trustedAnnotationHints,
} from '#src/core/approvals/annotations.js';
import {
  type ApprovalEntry,
  MCP_FAIL_CLOSED_ANNOTATIONS,
  type McpToolApprovalSubject,
  resolveApprovalRules,
  type ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';
import type { McpApprovalsConfig } from '#src/config/shell-policy.js';

/**
 * EXT-70 §4.7.1 — the effective annotation set: the ONE derivation, and the only place trust is
 * applied to an annotation.
 *
 * **Every negative here ships its positive control**, deliberately and throughout. The trap this
 * suite is built against is the assertion that cannot fail: "an untrusted server's declaration
 * collapses to fail-closed" passes trivially against a computation that returns the constant
 * always, and "a trusted declaration comes through" passes against one that trusts everything.
 * Only the pair distinguishes the design from either degenerate implementation, so the pair is what
 * is written — and where trust is per HINT rather than per server, both halves of one call are
 * asserted, because asserting only the trusted half passes on a per-server boolean, which is
 * exactly the design §4.7.1 rejects.
 */

/** A server that declares the most permissive thing it could about itself, on every hint. */
const DECLARES_HARMLESS: DeclaredToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const mcpSubject = (server: string, name = 'get_issue'): McpToolApprovalSubject => ({
  kind: 'mcpTool',
  server,
  name,
});

const toolSubject = (name: string): ToolApprovalSubject => ({ kind: 'tool', name });

/** A lookup where every tool of every server declares the same thing. */
const declaringMcp = (declared: DeclaredToolAnnotations) => ({ mcp: () => declared });

describe('effective tool annotations (EXT-70 §4.7.1)', () => {
  describe('provenance decides trust — the pair that no constant can pass', () => {
    it('an UNTRUSTED server’s declaration collapses to the fail-closed defaults', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: [] } } },
        declared: declaringMcp(DECLARES_HARMLESS),
      });
      // It declared the opposite of every fail-closed default, and moved none of them.
      expect(source(mcpSubject('jira'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    });

    it('CONTROL: a TRUSTED server’s declaration really does come through', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: {
          servers: {
            jira: {
              trustAnnotations: [
                'readOnlyHint',
                'destructiveHint',
                'idempotentHint',
                'openWorldHint',
              ],
            },
          },
        },
        declared: declaringMcp(DECLARES_HARMLESS),
      });
      expect(source(mcpSubject('jira'))).toEqual(DECLARES_HARMLESS);
    });

    it('a server with no policy at all is untrusted, and one server’s trust is not another’s', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
        declared: declaringMcp(DECLARES_HARMLESS),
      });
      expect(source(mcpSubject('confluence')).readOnlyHint).toBe(false);
      // Control: the server that WAS named gets what it was granted, so the lookup is by key.
      expect(source(mcpSubject('jira')).readOnlyHint).toBe(true);
    });
  });

  /**
   * The node's acceptance criterion. Either half alone is passable by a stub — a computation that
   * always derives gives the first, a constant fail-closed source gives the second — so the pair is
   * the test.
   */
  describe('the discriminating pair for the readOnly ⇒ not-destructive derivation', () => {
    const declared: DeclaredToolAnnotations = { readOnlyHint: true };

    it('TRUSTED: declaring only readOnlyHint=true yields destructiveHint=false', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
        declared: declaringMcp(declared),
      });
      const effective = source(mcpSubject('jira'));
      expect(effective.readOnlyHint).toBe(true);
      expect(effective.destructiveHint).toBe(false);
    });

    it('UNTRUSTED: the very same declaration yields readOnlyHint=false AND destructiveHint=true', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: [] } } },
        declared: declaringMcp(declared),
      });
      const effective = source(mcpSubject('jira'));
      expect(effective.readOnlyHint).toBe(false);
      expect(effective.destructiveHint).toBe(true);
    });

    it('the derivation is a rule about the vocabulary, so it applies to our own tools too', () => {
      const source = createEffectiveToolAnnotationSource({
        declared: { builtIn: () => ({ readOnlyHint: true, destructiveHint: true }) },
      });
      // Even a declaration that contradicts itself resolves once, here, so no consumer ever reads
      // the hint the MCP schema itself calls meaningless.
      expect(source(toolSubject('gth_read_file')).destructiveHint).toBe(false);
      // Control: without readOnlyHint the declared destructiveHint stands.
      const writer = createEffectiveToolAnnotationSource({
        declared: { builtIn: () => ({ readOnlyHint: false, destructiveHint: true }) },
      });
      expect(writer(toolSubject('gth_write_file')).destructiveHint).toBe(true);
    });
  });

  /**
   * §4.7.1 — "trust is per hint, not one flag per server". Both halves of the SAME call are
   * asserted: a per-server boolean would pass the trusted half and fail the collapsed one, and that
   * is the whole difference between this design and the one it rejects.
   */
  describe('per-hint trust is not per-server trust', () => {
    it('trusting readOnlyHint alone leaves openWorldHint collapsed to its fail-closed default', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { fetcher: { trustAnnotations: ['readOnlyHint'] } } },
        declared: declaringMcp({ readOnlyHint: true, openWorldHint: false }),
      });
      const effective = source(mcpSubject('fetcher', 'fetch_url'));
      expect(effective.readOnlyHint).toBe(true);
      expect(effective.openWorldHint).toBe(true);
    });

    it('CONTROL: naming openWorldHint too lets the same declaration through', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { fetcher: { trustAnnotations: ['readOnlyHint', 'openWorldHint'] } } },
        declared: declaringMcp({ readOnlyHint: true, openWorldHint: false }),
      });
      expect(source(mcpSubject('fetcher', 'fetch_url')).openWorldHint).toBe(false);
    });

    it.each([
      ['readOnlyHint', { readOnlyHint: true }, 'readOnlyHint', true, false],
      ['destructiveHint', { destructiveHint: false }, 'destructiveHint', false, true],
      ['idempotentHint', { idempotentHint: true }, 'idempotentHint', true, false],
      ['openWorldHint', { openWorldHint: false }, 'openWorldHint', false, true],
    ] as [
      string,
      DeclaredToolAnnotations,
      keyof typeof MCP_FAIL_CLOSED_ANNOTATIONS,
      boolean,
      boolean,
    ][])(
      'each hint is trusted independently: %s',
      (hint, declared, read, trustedValue, untrustedValue) => {
        const declaredLookup = declaringMcp(declared);
        const trusted = createEffectiveToolAnnotationSource({
          mcp: { servers: { s: { trustAnnotations: [hint as 'readOnlyHint'] } } },
          declared: declaredLookup,
        });
        const untrusted = createEffectiveToolAnnotationSource({
          mcp: { servers: { s: { trustAnnotations: [] } } },
          declared: declaredLookup,
        });
        expect(trusted(mcpSubject('s'))[read]).toBe(trustedValue);
        expect(untrusted(mcpSubject('s'))[read]).toBe(untrustedValue);
      }
    );
  });

  /**
   * §9 — `defaults` covers "servers not named below". A server that names itself states its
   * relationship in full, so an empty body trusts nothing: trust by omission is the failure this
   * section exists to prevent.
   */
  describe('defaults apply to servers NOT named under servers', () => {
    const mcp: McpApprovalsConfig = {
      defaults: { trustAnnotations: ['readOnlyHint'] },
      servers: { jira: {} },
    };
    const source = createEffectiveToolAnnotationSource({
      mcp,
      declared: declaringMcp({ readOnlyHint: true }),
    });

    it('an UNNAMED server takes the defaults', () => {
      expect(source(mcpSubject('confluence')).readOnlyHint).toBe(true);
    });

    it('a server that names itself with an EMPTY body trusts nothing, defaults notwithstanding', () => {
      expect(source(mcpSubject('jira')).readOnlyHint).toBe(false);
    });

    it('trustedAnnotationHints reports the same resolution it computes with', () => {
      expect(trustedAnnotationHints(mcp, 'confluence')).toEqual(['readOnlyHint']);
      expect(trustedAnnotationHints(mcp, 'jira')).toEqual([]);
      expect(trustedAnnotationHints(undefined, 'jira')).toEqual([]);
    });
  });

  describe('absent and empty trustAnnotations both believe nothing', () => {
    const declared = declaringMcp(DECLARES_HARMLESS);

    it.each([
      ['absent', { servers: { jira: {} } }],
      ['empty', { servers: { jira: { trustAnnotations: [] } } }],
      ['no mcp block at all', undefined],
      ['an empty mcp block', {}],
    ] as [string, McpApprovalsConfig | undefined][])('%s', (_label, mcp) => {
      const source = createEffectiveToolAnnotationSource({ mcp, declared });
      expect(source(mcpSubject('jira'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    });

    it('CONTROL: a STATED list on the same config believes what it names', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: ['idempotentHint'] } } },
        declared,
      });
      expect(source(mcpSubject('jira')).idempotentHint).toBe(true);
    });
  });

  describe('our own tools are trusted, and never grant less than a trusted server would', () => {
    it('a built-in’s declaration is read verbatim, with no per-hint filter', () => {
      const source = createEffectiveToolAnnotationSource({
        // No `mcp` block at all: the trust config is irrelevant to our own tools.
        declared: { builtIn: () => DECLARES_HARMLESS },
      });
      expect(source(toolSubject('gth_read_file'))).toEqual(DECLARES_HARMLESS);
    });

    it('a tool NOTHING declares for is fail-closed, not "trusted, declaring nothing"', () => {
      const source = createEffectiveToolAnnotationSource({
        declared: { builtIn: () => undefined },
      });
      expect(source(toolSubject('gth_unknown'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    });

    it('§4.7.1 — a trusted external annotation grants exactly what our own does, never more', () => {
      const declared: DeclaredToolAnnotations = { readOnlyHint: true, openWorldHint: false };
      const ours = createEffectiveToolAnnotationSource({ declared: { builtIn: () => declared } });
      const theirs = createEffectiveToolAnnotationSource({
        mcp: {
          defaults: {
            trustAnnotations: [
              'readOnlyHint',
              'destructiveHint',
              'idempotentHint',
              'openWorldHint',
            ],
          },
        },
        declared: declaringMcp(declared),
      });
      expect(theirs(mcpSubject('jira'))).toEqual(ours(toolSubject('gth_read_file')));
    });

    it('a declared value that is not a boolean is not a declaration', () => {
      const source = createEffectiveToolAnnotationSource({
        // A `tools/list` response is network input: a string "true" must never become a `true`
        // the gate acts on.
        declared: { builtIn: () => ({ readOnlyHint: 'true' }) as DeclaredToolAnnotations },
      });
      expect(source(toolSubject('gth_read_file')).readOnlyHint).toBe(false);
      // Control: the real boolean on the same path does move it.
      const real = createEffectiveToolAnnotationSource({
        declared: { builtIn: () => ({ readOnlyHint: true }) },
      });
      expect(real(toolSubject('gth_read_file')).readOnlyHint).toBe(true);
    });
  });

  describe('the source always answers', () => {
    it('a source built with nothing at all is exactly the fail-closed constant', () => {
      const source = createEffectiveToolAnnotationSource();
      expect(source(mcpSubject('jira'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
      expect(source(toolSubject('gth_read_file'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    });

    it('never returns undefined, so a hint entry is never undecidable for want of a declaration', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
        declared: { mcp: () => undefined },
      });
      expect(source(mcpSubject('jira', 'never_listed'))).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    });

    it('does not mutate the shared fail-closed constant', () => {
      const source = createEffectiveToolAnnotationSource({
        mcp: { defaults: { trustAnnotations: ['readOnlyHint'] } },
        declared: declaringMcp({ readOnlyHint: true }),
      });
      expect(source(mcpSubject('jira')).readOnlyHint).toBe(true);
      expect(MCP_FAIL_CLOSED_ANNOTATIONS).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
    });
  });

  /**
   * The seam end to end: what the effective set is FOR is deciding a `hint` entry (§3.1). The pair
   * is the same declaration under two trust postures, so the entry's outcome is shown to turn on
   * trust and on nothing else.
   */
  describe('through the matcher — a hint entry decides on effective values only', () => {
    const escalateDestructive: ApprovalEntry = {
      type: 'mcpTool',
      server: '*',
      matcher: 'hint',
      pattern: { destructiveHint: true },
    };
    const lists = { allow: [], deny: [], escalate: [escalateDestructive] };
    const declared = declaringMcp({ readOnlyHint: true });

    it('an UNTRUSTED server’s readOnlyHint=true does not lift the escalate entry', () => {
      const annotations = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: [] } } },
        declared,
      });
      expect(resolveApprovalRules(mcpSubject('jira'), lists, { annotations })?.action).toBe(
        'escalate'
      );
    });

    it('CONTROL: trusting that one hint lifts it, through the derivation and nothing else', () => {
      const annotations = createEffectiveToolAnnotationSource({
        mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } },
        declared,
      });
      expect(resolveApprovalRules(mcpSubject('jira'), lists, { annotations })).toBeNull();
    });
  });
});
