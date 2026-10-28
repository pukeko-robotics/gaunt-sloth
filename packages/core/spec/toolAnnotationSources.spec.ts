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
  bindMcpToolsets,
  isMcpNamespacedToolName,
  McpToolNameCollisionError,
  mcpToolRegisteredName,
  NO_MCP_TOOL_BINDINGS,
  restrictMcpToolBindings,
  UNRESOLVED_MCP_SERVER,
  type McpToolBindings,
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

/** The registered name of `jira`'s `search` tool. */
const JIRA_SEARCH = mcpToolRegisteredName('jira', 'search');

/** `approvals.mcp` trusting exactly these hints from one named server. */
const trusting = (hints: ToolAnnotationHint[], server = 'jira'): McpApprovalsConfig => ({
  servers: { [server]: { trustAnnotations: hints } },
});

/**
 * Bindings for `(server, tool)` pairs, recorded by the production builder exactly as the resolver
 * records a server's loaded tools.
 */
const bound = (...pairs: [server: string, tool: string][]): McpToolBindings =>
  bindMcpToolsets(
    pairs.map(([server, tool]) => [server, [{ name: mcpToolRegisteredName(server, tool) }]])
  );

/** The whole chain: a registered tool name, the session's bindings, and the effective set. */
function effectiveFor(
  toolName: string,
  bindings: McpToolBindings,
  mcp: McpApprovalsConfig | undefined,
  tools: readonly { name?: string; metadata?: unknown }[]
): EffectiveToolAnnotations {
  const subject = approvalSubjectForToolName(toolName, bindings);
  return sourceOver(mcp, tools)(subject) as EffectiveToolAnnotations;
}

describe('approvalSubjectForToolName (EXT-70 §4.7.5, EXT-211) — provenance by name, server by binding', () => {
  it('CONTROL: an ordinary tool name is a `tool` subject — the trusted provenance', () => {
    expect(approvalSubjectForToolName('gth_grep', bound(['jira', 'search']))).toEqual({
      kind: 'tool',
      name: 'gth_grep',
    });
  });

  it('a bound MCP name is an `mcpTool` subject carrying the user’s own config key', () => {
    const bindings = bound(['jira', 'delete_issue'], ['github', 'create_pr']);
    expect(
      approvalSubjectForToolName(mcpToolRegisteredName('jira', 'delete_issue'), bindings)
    ).toEqual({ kind: 'mcpTool', server: 'jira', name: 'delete_issue' });
  });

  /**
   * The §2 fail-open, stated as a property: there is NO MCP name for which this returns the trusted
   * provenance. The rows are the ways resolution can go — bound, unbound, and the two degenerate
   * names — and the control above is what stops a resolver that answers `mcpTool` for everything
   * passing.
   */
  it.each([
    ['a bound name', mcpToolRegisteredName('jira', 'delete_issue'), 'jira', 'delete_issue'],
    [
      'a name nothing bound',
      'mcp__unknown_delete_issue',
      UNRESOLVED_MCP_SERVER,
      'mcp__unknown_delete_issue',
    ],
    ['the bare namespace', 'mcp__', UNRESOLVED_MCP_SERVER, 'mcp__'],
  ])('%s is never a `tool` subject', (_why, toolName, expectedServer, expectedName) => {
    // The whole subject, not just its `kind`: the server and name are what the trust lookup and
    // the declaration lookup are keyed by — a resolver that answered `mcpTool` with the wrong
    // server would pass a `kind`-only check and hand a tool another server's belief.
    expect(approvalSubjectForToolName(toolName, bound(['jira', 'delete_issue']))).toEqual({
      kind: 'mcpTool',
      server: expectedServer,
      name: expectedName,
    });
  });

  it('the server is the binding’s, whatever the name looks like', () => {
    // A binding for a name whose shape suggests another server: the binding governs, because the
    // name is never parsed.
    const bindings = new Map([['mcp__jira_x', { server: 'github', tool: 'jira__x' }]]);
    expect(approvalSubjectForToolName('mcp__jira_x', bindings)).toEqual({
      kind: 'mcpTool',
      server: 'github',
      name: 'jira__x',
    });
  });

  it('an unbound name fails closed even when a configured-looking server prefixes it', () => {
    expect(approvalSubjectForToolName('mcp__jira_delete_issue', NO_MCP_TOOL_BINDINGS)).toEqual({
      kind: 'mcpTool',
      server: UNRESOLVED_MCP_SERVER,
      name: 'mcp__jira_delete_issue',
    });
  });

  it('a binding to the empty server never resolves anything', () => {
    // `''` is unnameable under `approvals.mcp.servers` and on an `mcpTool` entry (both `min(1)`),
    // so resolving to it would be indistinguishable from not resolving at all.
    const bindings = new Map([['mcp____delete_issue', { server: '', tool: 'delete_issue' }]]);
    expect(approvalSubjectForToolName('mcp____delete_issue', bindings)).toEqual({
      kind: 'mcpTool',
      server: UNRESOLVED_MCP_SERVER,
      name: 'mcp____delete_issue',
    });
  });

  it('mcpToolRegisteredName rebuilds a bound subject back to its registered name', () => {
    const registered = mcpToolRegisteredName('jira__staging', 'delete_issue');
    const subject = approvalSubjectForToolName(
      registered,
      bound(['jira__staging', 'delete_issue'])
    );
    expect(subject.kind).toBe('mcpTool');
    if (subject.kind !== 'mcpTool') throw new Error('unreachable');
    expect(mcpToolRegisteredName(subject.server, subject.name)).toBe(registered);
  });

  it.each([
    ['mcp__jira_x', true],
    ['gth_grep', false],
    ['mcpjira__x', false],
    ['mcp_jira__x', false],
  ])('isMcpNamespacedToolName(%s) is %s', (name, expected) => {
    expect(isMcpNamespacedToolName(name)).toBe(expected);
  });
});

describe('bindMcpToolsets (EXT-211) — the bindings are recorded per server, never parsed', () => {
  it('nested server keys each keep their own tools', () => {
    // `jira` and `jira__staging` both prefix the staging tool's name; the grouping, not the name,
    // decides whose it is.
    const bindings = bindMcpToolsets([
      ['jira', [{ name: mcpToolRegisteredName('jira', 'staging__search') }]],
      ['jira__staging', [{ name: mcpToolRegisteredName('jira__staging', 'list') }]],
    ]);
    expect(bindings.get(mcpToolRegisteredName('jira', 'staging__search'))).toEqual({
      server: 'jira',
      tool: 'staging__search',
    });
    expect(bindings.get(mcpToolRegisteredName('jira__staging', 'list'))).toEqual({
      server: 'jira__staging',
      tool: 'list',
    });
  });

  it('a duplicate registered name across servers throws instead of overwriting', () => {
    // `jira` + `staging_search` and `jira_staging` + `search` register the same name.
    expect(() =>
      bindMcpToolsets([
        ['jira', [{ name: mcpToolRegisteredName('jira', 'staging_search') }]],
        ['jira_staging', [{ name: mcpToolRegisteredName('jira_staging', 'search') }]],
      ])
    ).toThrow(McpToolNameCollisionError);
  });

  it('CONTROL: the same name listed twice under the same server is recorded once', () => {
    const name = mcpToolRegisteredName('jira', 'search');
    const bindings = bindMcpToolsets([['jira', [{ name }, { name }]]]);
    expect([...bindings]).toEqual([[name, { server: 'jira', tool: 'search' }]]);
  });

  it('a tool that does not carry its own server’s prefix is left unbound', () => {
    const bindings = bindMcpToolsets([
      ['jira', [{ name: 'search' }, { name: mcpToolRegisteredName('github', 'search') }]],
    ]);
    expect(bindings.size).toBe(0);
  });

  it('restrictMcpToolBindings keeps only the names it is given', () => {
    const bindings = bound(['jira', 'search'], ['github', 'create_pr']);
    const kept = restrictMcpToolBindings(bindings, [mcpToolRegisteredName('jira', 'search'), 'x']);
    expect([...kept.keys()]).toEqual([mcpToolRegisteredName('jira', 'search')]);
    expect(restrictMcpToolBindings(undefined, ['x']).size).toBe(0);
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
   * The four-tuple, per tool, for every tool that shares an authored constant with another.
   *
   * The rows above pin one or two hints each, which a shared constant can satisfy while quietly
   * describing the wrong thing: re-point `gth_checklist` at the constant the deletes use and it
   * becomes a destroyer of the working folder with nothing to say so. What each constant MEANS is
   * a doc comment and cannot be asserted, so what is asserted instead is that each tool still has
   * the values that comment describes — which is what a mis-shared constant would move.
   */
  describe('every tool sharing an authored constant keeps its own four-tuple', () => {
    const LOCAL_ABSOLUTE = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    };
    const LOCAL_RELATIVE = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    };
    const NON_DESTRUCTIVE = {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };

    it.each(['write_file', 'delete_file', 'delete_directory'])(
      '%s discards what was at the path, and the same call twice lands the same end state',
      (name) => {
        expect(effectiveBuiltIn(name)).toEqual(LOCAL_ABSOLUTE);
      }
    );

    it.each(['edit_file', 'move_file'])(
      '%s depends on what is there now, so repeating it is NOT the same call twice',
      (name) => {
        expect(effectiveBuiltIn(name)).toEqual(LOCAL_RELATIVE);
      }
    );

    it('create_directory adds to the working folder and destroys nothing', () => {
      expect(effectiveBuiltIn('create_directory')).toEqual(NON_DESTRUCTIVE);
    });

    it.each(['gth_checklist', 'show_a2ui_surface'])(
      '%s writes state this session owns, destroying nothing in the working folder',
      (name) => {
        expect(effectiveBuiltIn(name)).toEqual(NON_DESTRUCTIVE);
      }
    );

    /**
     * MCP defines `idempotentHint`, like `destructiveHint`, as meaningful only when `readOnlyHint`
     * is false. A row claiming to change nothing while also claiming a second call changes
     * something further contradicts itself, so on a read row the moot hint reads `true`.
     */
    it('gth_status_update is a read, and its moot idempotentHint agrees with that', () => {
      expect(effectiveBuiltIn('gth_status_update')).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      // CONTROL: the same rule read off a row that was never in question, so the assertion above
      // is about `gth_status_update` rather than about every row being a read.
      expect(effectiveBuiltIn('gth_grep').idempotentHint).toBe(true);
      expect(effectiveBuiltIn('edit_file').idempotentHint).toBe(false);
    });
  });

  /**
   * The §3(a2) hazard, pinned twice over: our own table cannot answer for an MCP tool, and the
   * table has no MCP-namespaced key that a future `builtIn` lookup could reach either.
   */
  it('the built-in lookup cannot answer for an MCP tool name', () => {
    expect(builtInToolAnnotations('mcp__jira_read_file')).toBeUndefined();
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
      mcpTool(JIRA_SEARCH, { readOnlyHint: true, openWorldHint: true }),
    ]);
    expect(collected.get('mcp__jira_search')).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it('does NOT collect a tool outside the MCP namespace, however it annotates itself', () => {
    // A custom tool's own metadata is not ours to believe (§4.7.1), and it must never reach the
    // per-hint-trusted path either.
    const collected = collectDeclaredMcpToolAnnotations([
      mcpTool('my_custom_tool', { readOnlyHint: true }),
      mcpTool(JIRA_SEARCH, { readOnlyHint: true }),
    ]);
    expect(collected.has('my_custom_tool')).toBe(false);
    // CONTROL: the MCP sibling in the same list WAS collected, so this is about the namespace and
    // not about collection being broken.
    expect(collected.has('mcp__jira_search')).toBe(true);
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
    const effective = effectiveFor(
      JIRA_SEARCH,
      bound(['jira', 'search']),
      trusting(['readOnlyHint']),
      [mcpTool(JIRA_SEARCH, { readOnlyHint: 'true' })]
    );
    expect(effective.readOnlyHint).toBe(false);
    // CONTROL: the same trusted server, the same hint, an actual boolean — this one comes through.
    const real = effectiveFor(JIRA_SEARCH, bound(['jira', 'search']), trusting(['readOnlyHint']), [
      mcpTool(JIRA_SEARCH, { readOnlyHint: true }),
    ]);
    expect(real.readOnlyHint).toBe(true);
  });
});

describe('the discriminating pair, RE-PROVED against the real sources (EXT-70 acceptance)', () => {
  const declaringReadOnly = [mcpTool(JIRA_SEARCH, DECLARES_READ_ONLY)];

  it('TRUSTED: a real tools/list declaring only readOnlyHint yields destructiveHint false', () => {
    const effective = effectiveFor(
      JIRA_SEARCH,
      bound(['jira', 'search']),
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
      JIRA_SEARCH,
      bound(['jira', 'search']),
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
    const effective = effectiveFor('read_file', NO_MCP_TOOL_BINDINGS, undefined, []);
    expect(effective.readOnlyHint).toBe(true);
    expect(effective.destructiveHint).toBe(false);
  });
});

describe('the fail-open this task closes (EXT-70 §4.7.1)', () => {
  it('an UNTRUSTED server declaring readOnlyHint true is NOT read-only', () => {
    const effective = effectiveFor(JIRA_SEARCH, bound(['jira', 'search']), undefined, [
      mcpTool(JIRA_SEARCH, DECLARES_READ_ONLY),
    ]);
    expect(effective.readOnlyHint).toBe(false);
  });

  it('CONTROL: OUR OWN tool with that same annotation IS read-only', () => {
    // Without this control the assertion above passes on a source that answers fail-closed for
    // everything — a gate that refuses the world, which proves nothing about provenance.
    expect(effectiveFor('gth_grep', NO_MCP_TOOL_BINDINGS, undefined, []).readOnlyHint).toBe(true);
  });

  it('an unbound MCP name cannot pick up a declaration, however permissive the defaults', () => {
    // The declaration is keyed by the very name called, so it is the one a resolver that guessed a
    // server would have handed it. `defaults` trusts all four hints, so nothing but the missing
    // binding stands between the declaration and the gate.
    const permissive: McpApprovalsConfig = {
      defaults: {
        trustAnnotations: ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'],
      },
    };
    const declarations = [mcpTool(JIRA_SEARCH, DECLARES_READ_ONLY)];
    const effective = effectiveFor(JIRA_SEARCH, NO_MCP_TOOL_BINDINGS, permissive, declarations);
    expect(effective).toEqual(MCP_FAIL_CLOSED_ANNOTATIONS);
  });

  it('CONTROL: once the name is bound, the same declaration DOES come through', () => {
    const permissive: McpApprovalsConfig = {
      defaults: { trustAnnotations: ['readOnlyHint'] },
    };
    const effective = effectiveFor(JIRA_SEARCH, bound(['jira', 'search']), permissive, [
      mcpTool(JIRA_SEARCH, DECLARES_READ_ONLY),
    ]);
    expect(effective.readOnlyHint).toBe(true);
  });

  it('the declared-MCP lookup refuses the unresolvable server outright', () => {
    const unresolved = 'mcp__ghost_delete';
    const collided = new Map<string, DeclaredToolAnnotations>([
      [mcpToolRegisteredName(UNRESOLVED_MCP_SERVER, unresolved), DECLARES_READ_ONLY],
      [JIRA_SEARCH, DECLARES_READ_ONLY],
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
    const staging = mcpToolRegisteredName('jira__staging', 'search');
    const github = mcpToolRegisteredName('github', 'search');
    const bindings = bound(['jira__staging', 'search'], ['github', 'search']);
    const declared = [mcpTool(staging, DECLARES_READ_ONLY), mcpTool(github, DECLARES_READ_ONLY)];
    expect(effectiveFor(staging, bindings, mcp, declared).readOnlyHint).toBe(true);
    // CONTROL: the other server's tool, same declaration, takes its own posture and stays
    // collapsed — so the assertion above is about whose trust applied, not about trust at large.
    expect(effectiveFor(github, bindings, mcp, declared).readOnlyHint).toBe(false);
  });
});
