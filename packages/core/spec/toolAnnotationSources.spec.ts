import { describe, expect, it } from 'vitest';
import {
  createEffectiveToolAnnotationSource,
  type DeclaredToolAnnotations,
} from '#src/core/approvals/annotations.js';
import {
  type EffectiveToolAnnotations,
  MCP_FAIL_CLOSED_ANNOTATIONS,
} from '#src/core/approvals/matcher.js';
import {
  approvalSubjectForToolName,
  isMcpNamespacedToolName,
  mcpToolRegisteredName,
  UNRESOLVED_MCP_SERVER,
} from '#src/core/approvals/mcpSubjects.js';
import {
  BUILT_IN_TOOL_ANNOTATIONS,
  builtInToolAnnotations,
  collectDeclaredMcpToolAnnotations,
  declaredToolAnnotationsFrom,
  mcpDeclaredAnnotationLookup,
} from '#src/core/approvals/toolAnnotationSources.js';
import type { McpApprovalsConfig, ToolAnnotationHint } from '#src/config/shell-policy.js';

/**
 * EXT-70 §4.7 — the REAL declared-annotation sources, and the subject an MCP tool presents.
 *
 * Task 1 proved the trust derivation against fabricated declarations because no real source
 * existed. This file re-proves it against the two that now do — an authored built-in row and a
 * declaration read off a `tools/list` response — and covers the fail-open that motivated the task:
 * every non-shell tool used to become a `kind: 'tool'` subject, which is the TRUSTED provenance, so
 * an MCP tool routed through it would have been asking the trusted path for a third party's
 * annotations.
 *
 * Every negative ships its positive control **in this file**, because the degenerate
 * implementations are the ones that pass one half: a resolver that answers `mcpTool` for everything
 * passes "an MCP name is never a tool subject", and one that answers `tool` for everything passes
 * "an ordinary name is a tool subject". Only the pair distinguishes them.
 */

/** The annotation set a `tools/list` response would carry for a harmless-looking read tool. */
const DECLARES_READ_ONLY: DeclaredToolAnnotations = { readOnlyHint: true };

/** One entry of a `tools/list` response, as the MCP adapter hands it to the graph. */
const mcpTool = (name: string, annotations?: unknown) => ({
  name,
  metadata: annotations === undefined ? undefined : { annotations },
});

/** Build the production source from the production lookups, over one recorded tool list. */
function sourceOver(
  mcp: McpApprovalsConfig | undefined,
  tools: readonly { name?: string; metadata?: unknown }[]
) {
  return createEffectiveToolAnnotationSource({
    mcp,
    declared: {
      builtIn: builtInToolAnnotations,
      mcp: mcpDeclaredAnnotationLookup(collectDeclaredMcpToolAnnotations(tools)),
    },
  });
}

/** `approvals.mcp` trusting exactly these hints from one named server. */
const trusting = (hints: ToolAnnotationHint[], server = 'jira'): McpApprovalsConfig => ({
  servers: { [server]: { trustAnnotations: hints } },
});

/** The whole chain: a registered tool name, the configured servers, and the effective set. */
function effectiveFor(
  toolName: string,
  configuredServers: readonly string[],
  mcp: McpApprovalsConfig | undefined,
  tools: readonly { name?: string; metadata?: unknown }[]
): EffectiveToolAnnotations {
  const subject = approvalSubjectForToolName(toolName, configuredServers);
  return sourceOver(mcp, tools)(subject) as EffectiveToolAnnotations;
}

describe('approvalSubjectForToolName (EXT-70 §4.7.5) — provenance is decided by the name', () => {
  it('CONTROL: an ordinary tool name is a `tool` subject — the trusted provenance', () => {
    expect(approvalSubjectForToolName('gth_grep', ['jira'])).toEqual({
      kind: 'tool',
      name: 'gth_grep',
    });
  });

  it('an MCP-namespaced name is an `mcpTool` subject carrying the user’s own config key', () => {
    expect(approvalSubjectForToolName('mcp__jira__delete_issue', ['jira', 'github'])).toEqual({
      kind: 'mcpTool',
      server: 'jira',
      name: 'delete_issue',
    });
  });

  /**
   * The §2 fail-open, stated as a property: there is NO MCP name for which this returns the trusted
   * provenance. The three rows are the three ways resolution can go — clean, unknown, ambiguous —
   * and the control above is what stops a resolver that answers `mcpTool` for everything passing.
   */
  it.each([
    ['a resolvable name', 'mcp__jira__delete_issue', ['jira']],
    ['a name no configured server explains', 'mcp__unknown__delete_issue', ['jira']],
    ['an ambiguous name', 'mcp__a__b__c', ['a', 'a__b']],
    ['a name with an empty tool part', 'mcp__jira__', ['jira']],
    ['the bare namespace', 'mcp__', ['jira']],
  ])('%s is never a `tool` subject', (_why, toolName, servers) => {
    const subject = approvalSubjectForToolName(toolName, servers);
    expect(subject.kind).toBe('mcpTool');
    expect(subject.kind).not.toBe('tool');
  });

  describe('a server key containing the separator resolves to THAT server', () => {
    it('resolves against the configured key set, not by splitting on the separator', () => {
      expect(
        approvalSubjectForToolName('mcp__jira__staging__delete_issue', ['jira__staging'])
      ).toEqual({ kind: 'mcpTool', server: 'jira__staging', name: 'delete_issue' });
    });

    it('CONTROL: the same NAME under a shorter configured key resolves to the shorter one', () => {
      // Same string, different config — so the split cannot be a property of the name alone.
      expect(approvalSubjectForToolName('mcp__jira__staging__delete_issue', ['jira'])).toEqual({
        kind: 'mcpTool',
        server: 'jira',
        name: 'staging__delete_issue',
      });
    });

    it('CONTROL: an ordinary key still resolves alongside a separator-bearing sibling', () => {
      expect(
        approvalSubjectForToolName('mcp__github__create_pr', ['jira__staging', 'github'])
      ).toEqual({ kind: 'mcpTool', server: 'github', name: 'create_pr' });
    });

    it('two nested keys that both explain the name resolve to NEITHER', () => {
      // `jira` + `staging__delete_issue` and `jira__staging` + `delete_issue` are both readings.
      // Picking one would hand a tool the other server's trust.
      expect(
        approvalSubjectForToolName('mcp__jira__staging__delete_issue', ['jira', 'jira__staging'])
      ).toEqual({
        kind: 'mcpTool',
        server: UNRESOLVED_MCP_SERVER,
        name: 'mcp__jira__staging__delete_issue',
      });
    });
  });

  it('a name no configured server explains fails closed, keeping the whole name as its identity', () => {
    expect(approvalSubjectForToolName('mcp__ghost__delete_everything', ['jira'])).toEqual({
      kind: 'mcpTool',
      server: UNRESOLVED_MCP_SERVER,
      name: 'mcp__ghost__delete_everything',
    });
  });

  it('an empty configured key never resolves anything', () => {
    // `''` is unnameable under `approvals.mcp.servers` and on an `mcpTool` entry (both `min(1)`),
    // so resolving to it would be indistinguishable from not resolving at all.
    expect(approvalSubjectForToolName('mcp____delete_issue', [''])).toEqual({
      kind: 'mcpTool',
      server: UNRESOLVED_MCP_SERVER,
      name: 'mcp____delete_issue',
    });
  });

  it('mcpToolRegisteredName round-trips a resolved subject back to the registered name', () => {
    const registered = 'mcp__jira__staging__delete_issue';
    const subject = approvalSubjectForToolName(registered, ['jira__staging']);
    expect(subject.kind).toBe('mcpTool');
    if (subject.kind !== 'mcpTool') throw new Error('unreachable');
    expect(mcpToolRegisteredName(subject.server, subject.name)).toBe(registered);
  });

  it.each([
    ['mcp__jira__x', true],
    ['gth_grep', false],
    ['mcpjira__x', false],
    ['mcp_jira__x', false],
  ])('isMcpNamespacedToolName(%s) is %s', (name, expected) => {
    expect(isMcpNamespacedToolName(name)).toBe(expected);
  });
});

describe('BUILT_IN_TOOL_ANNOTATIONS (EXT-70 §4.7) — what OUR OWN tools declare', () => {
  const effectiveBuiltIn = (name: string) =>
    createEffectiveToolAnnotationSource({ declared: { builtIn: builtInToolAnnotations } })({
      kind: 'tool',
      name,
    }) as EffectiveToolAnnotations;

  /**
   * §4.7.3 — the whole point of that section, as a pair. A fetch tool is read-only in the local
   * sense AND reaches the network; reading it as a local read is the failure named there.
   */
  it('gth_web_fetch is an OPEN-WORLD read: readOnlyHint true AND openWorldHint true', () => {
    const fetch = effectiveBuiltIn('gth_web_fetch');
    expect(fetch.readOnlyHint).toBe(true);
    expect(fetch.openWorldHint).toBe(true);
  });

  it('CONTROL: a LOCAL read is readOnlyHint true AND openWorldHint false', () => {
    const grep = effectiveBuiltIn('gth_grep');
    expect(grep.readOnlyHint).toBe(true);
    expect(grep.openWorldHint).toBe(false);
  });

  it.each(['read_file', 'read_multiple_files', 'list_directory', 'gth_grep', 'ls', 'glob', 'grep'])(
    '%s is a local read: read-only, not destructive, not open-world',
    (name) => {
      expect(effectiveBuiltIn(name)).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  );

  it.each(['write_file', 'edit_file', 'create_directory', 'move_file', 'delete_file'])(
    '%s writes, so it is NOT readOnlyHint true',
    (name) => {
      expect(effectiveBuiltIn(name).readOnlyHint).toBe(false);
    }
  );

  it.each(['write_file', 'edit_file', 'move_file', 'delete_file', 'delete_directory'])(
    '%s can destroy what was already there',
    (name) => {
      expect(effectiveBuiltIn(name).destructiveHint).toBe(true);
    }
  );

  it('CONTROL: create_directory writes but destroys nothing', () => {
    // Without this the destructive rows above would pass on a table that called every writer
    // destructive, which would be a posture rather than a description.
    const created = effectiveBuiltIn('create_directory');
    expect(created.readOnlyHint).toBe(false);
    expect(created.destructiveHint).toBe(false);
  });

  /**
   * The §3(a2) hazard, pinned twice over: our own table cannot answer for an MCP tool, and the
   * table has no MCP-namespaced key that a future `builtIn` lookup could reach either.
   */
  it('the built-in lookup cannot answer for an MCP tool name', () => {
    expect(builtInToolAnnotations('mcp__jira__read_file')).toBeUndefined();
  });

  it('no key in the authored table is MCP-namespaced', () => {
    const namespaced = Object.keys(BUILT_IN_TOOL_ANNOTATIONS).filter(isMcpNamespacedToolName);
    expect(namespaced).toEqual([]);
    // CONTROL: the table is not simply empty — the check above would pass on nothing at all.
    expect(Object.keys(BUILT_IN_TOOL_ANNOTATIONS).length).toBeGreaterThan(10);
  });

  it('a tool the table does not name is FAIL-CLOSED, not trusted-declaring-nothing', () => {
    // `run_shell_command` reaches arbitrary code and the network, so the fail-closed set IS its
    // honest annotation; the same holds for A2A and user-authored custom tools.
    expect(effectiveBuiltIn('run_shell_command')).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    expect(effectiveBuiltIn('some_custom_tool_of_yours')).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
    // CONTROL: a tool the table DOES name is not fail-closed, so the assertion above is about
    // absence rather than about the source answering the constant for everything.
    expect(effectiveBuiltIn('read_file')).not.toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'a tool named %s is an ordinary miss, not an inherited hit',
    (name) => {
      expect(builtInToolAnnotations(name)).toBeUndefined();
    }
  );

  it('the lookup hands out a COPY, so the authored table cannot be rewritten through it', () => {
    const first = builtInToolAnnotations('read_file');
    expect(first).toBeDefined();
    first!.readOnlyHint = false;
    expect(builtInToolAnnotations('read_file')?.readOnlyHint).toBe(true);
    expect(BUILT_IN_TOOL_ANNOTATIONS.read_file.readOnlyHint).toBe(true);
  });
});

describe('declared MCP annotations (EXT-70 §4.7.1) — read off tools/list, believed by nobody yet', () => {
  it('collects an MCP tool’s declaration, keyed by its registered name', () => {
    const collected = collectDeclaredMcpToolAnnotations([
      mcpTool('mcp__jira__search', { readOnlyHint: true, openWorldHint: true }),
    ]);
    expect(collected.get('mcp__jira__search')).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('does NOT collect a tool outside the MCP namespace, however it annotates itself', () => {
    // A custom tool's own metadata is not ours to believe (§4.7.1), and it must never reach the
    // per-hint-trusted path either.
    const collected = collectDeclaredMcpToolAnnotations([
      mcpTool('my_custom_tool', { readOnlyHint: true }),
      mcpTool('mcp__jira__search', { readOnlyHint: true }),
    ]);
    expect(collected.has('my_custom_tool')).toBe(false);
    // CONTROL: the MCP sibling in the same list WAS collected, so this is about the namespace and
    // not about collection being broken.
    expect(collected.has('mcp__jira__search')).toBe(true);
  });

  it.each([
    ['no metadata at all', undefined],
    ['metadata with no annotations', {}],
    ['a null annotations payload', { annotations: null }],
    ['annotations that name none of the four hints', { annotations: { title: 'Search' } }],
  ])('declares nothing when the payload has %s', (_why, metadata) => {
    expect(declaredToolAnnotationsFrom(metadata)).toBeUndefined();
  });

  it('CONTROL: a payload that names one of the four hints DOES declare', () => {
    expect(declaredToolAnnotationsFrom({ annotations: { readOnlyHint: true } })).toEqual({
      readOnlyHint: true,
    });
  });

  it('keeps only the four hint names, whatever else the server sent', () => {
    expect(
      declaredToolAnnotationsFrom({
        annotations: { readOnlyHint: true, title: 'Search', destructiveHint: false },
      })
    ).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('passes a NON-BOOLEAN through unchanged, so the trust computation is the one place it dies', () => {
    // Two homes for this judgment can disagree; one cannot.
    expect(declaredToolAnnotationsFrom({ annotations: { readOnlyHint: 'true' } })).toEqual({
      readOnlyHint: 'true',
    });
  });

  it('a string "true" from a TRUSTED server is still not a true the gate acts on', () => {
    const effective = effectiveFor('mcp__jira__search', ['jira'], trusting(['readOnlyHint']), [
      mcpTool('mcp__jira__search', { readOnlyHint: 'true' }),
    ]);
    expect(effective.readOnlyHint).toBe(false);
    // CONTROL: the same trusted server, the same hint, an actual boolean — this one comes through.
    const real = effectiveFor('mcp__jira__search', ['jira'], trusting(['readOnlyHint']), [
      mcpTool('mcp__jira__search', { readOnlyHint: true }),
    ]);
    expect(real.readOnlyHint).toBe(true);
  });
});

describe('the discriminating pair, RE-PROVED against the real sources (EXT-70 acceptance)', () => {
  const declaringReadOnly = [mcpTool('mcp__jira__search', DECLARES_READ_ONLY)];

  it('TRUSTED: a real tools/list declaring only readOnlyHint yields destructiveHint false', () => {
    const effective = effectiveFor(
      'mcp__jira__search',
      ['jira'],
      trusting(['readOnlyHint']),
      declaringReadOnly
    );
    expect(effective.readOnlyHint).toBe(true);
    expect(effective.destructiveHint).toBe(false);
    // Per hint, not per server: `openWorldHint` was not declared and is not trusted, so it stays
    // collapsed. Asserting only the trusted half passes on a per-SERVER trust boolean.
    expect(effective.openWorldHint).toBe(true);
  });

  it('UNTRUSTED: the very same declaration yields readOnlyHint false AND destructiveHint true', () => {
    const effective = effectiveFor(
      'mcp__jira__search',
      ['jira'],
      { servers: { jira: { trustAnnotations: [] } } },
      declaringReadOnly
    );
    expect(effective.readOnlyHint).toBe(false);
    expect(effective.destructiveHint).toBe(true);
    expect(effective).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
  });

  it('OUR OWN tool, the same annotation, is read verbatim with no trust list anywhere', () => {
    // The built-in half of the pair: `read_file`'s authored `readOnlyHint: true` takes effect with
    // no `approvals.mcp` block at all, and the derivation rides on it exactly the same way.
    const effective = effectiveFor('read_file', ['jira'], undefined, []);
    expect(effective.readOnlyHint).toBe(true);
    expect(effective.destructiveHint).toBe(false);
  });
});

describe('the fail-open this task closes (EXT-70 §4.7.1)', () => {
  it('an UNTRUSTED server declaring readOnlyHint true is NOT read-only', () => {
    const effective = effectiveFor('mcp__jira__search', ['jira'], undefined, [
      mcpTool('mcp__jira__search', DECLARES_READ_ONLY),
    ]);
    expect(effective.readOnlyHint).toBe(false);
  });

  it('CONTROL: OUR OWN tool with that same annotation IS read-only', () => {
    // Without this control the assertion above passes on a source that answers fail-closed for
    // everything — a gate that refuses the world, which proves nothing about provenance.
    expect(effectiveFor('gth_grep', ['jira'], undefined, []).readOnlyHint).toBe(true);
  });

  it('an unresolvable MCP name cannot pick up a declaration, however permissive the defaults', () => {
    // Two nested keys both explain `mcp__a__b__search`, so the server is unresolvable — and both
    // readings rebuild the SAME registered name, so the declaration below is the one a naive
    // resolver would have handed it. `defaults` trusts all four hints, so nothing but the
    // unresolvable-server refusal stands between the declaration and the gate.
    const permissive: McpApprovalsConfig = {
      defaults: {
        trustAnnotations: ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
      },
    };
    const declarations = [mcpTool('mcp__a__b__search', DECLARES_READ_ONLY)];
    const effective = effectiveFor('mcp__a__b__search', ['a', 'a__b'], permissive, declarations);
    expect(effective).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
  });

  it('CONTROL: with only ONE of those keys configured, the same declaration DOES come through', () => {
    const permissive: McpApprovalsConfig = {
      defaults: { trustAnnotations: ['readOnlyHint'] },
    };
    const effective = effectiveFor('mcp__a__b__search', ['a__b'], permissive, [
      mcpTool('mcp__a__b__search', DECLARES_READ_ONLY),
    ]);
    expect(effective.readOnlyHint).toBe(true);
  });

  /**
   * The unresolvable-server refusal, at the level it lives. Constructed rather than natural: the
   * declaration is keyed by the exact string the sentinel would rebuild. That is the point — the
   * guard exists so that fail-closed does not depend on how contrived a collision would have to be.
   */
  it('the declared-MCP lookup refuses the unresolvable server outright', () => {
    const unresolved = 'mcp__ghost__delete';
    const collided = new Map<string, DeclaredToolAnnotations>([
      [`mcp____${unresolved}`, DECLARES_READ_ONLY],
      ['mcp__jira__search', DECLARES_READ_ONLY],
    ]);
    const lookup = mcpDeclaredAnnotationLookup(collided);
    expect(lookup(UNRESOLVED_MCP_SERVER, unresolved)).toBeUndefined();
    // CONTROL: a resolved server finds its declaration through the very same lookup.
    expect(lookup('jira', 'search')).toEqual(DECLARES_READ_ONLY);
  });

  it('one server’s trust is not another’s when a key carries the separator', () => {
    // `jira__staging` is trusted; `github` is not. Both declare the same thing.
    const mcp: McpApprovalsConfig = {
      servers: {
        jira__staging: { trustAnnotations: ['readOnlyHint'] },
        github: { trustAnnotations: [] },
      },
    };
    const servers = ['jira__staging', 'github'];
    const declared = [
      mcpTool('mcp__jira__staging__search', DECLARES_READ_ONLY),
      mcpTool('mcp__github__search', DECLARES_READ_ONLY),
    ];
    expect(effectiveFor('mcp__jira__staging__search', servers, mcp, declared).readOnlyHint).toBe(
      true
    );
    // CONTROL: the other server's tool, same declaration, takes its own posture and stays
    // collapsed — so the assertion above is about whose trust applied, not about trust at large.
    expect(effectiveFor('mcp__github__search', servers, mcp, declared).readOnlyHint).toBe(false);
  });
});
