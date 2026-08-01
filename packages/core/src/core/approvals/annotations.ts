/**
 * @module core/approvals/annotations
 *
 * EXT-70 (spec §4.7, §4.7.1, §4.7.5) — **the one derivation of a tool call's effective annotation
 * set**, and the only place trust is applied to an annotation. Everything downstream — the §4.7.2
 * table, `hint` entries (§3.1), exposure (§4.7.6), the snapshot a sticky grant records (§4.7.4) —
 * reads what {@link createEffectiveToolAnnotationSource} computes and never re-derives it. A second
 * derivation is how a gate and a display come to disagree about what a tool is.
 *
 * ## Trust is decided by provenance, not by the annotation
 *
 * An annotation we did not write is a **claim, not a credential**: a third-party server's
 * `readOnlyHint=true` exempts it from nothing, because a gate that honours it unconditionally is a
 * gate any server can opt itself out of. So:
 *
 * - **our own tools are trusted** — a `tool` subject is a built-in or a tool the user wired into
 *   their own config, and its annotations are read verbatim;
 * - **an MCP server's are trusted per hint**, and only where the user said so in
 *   `approvals.mcp` (§9). Per hint, never per server: believing a server's `readOnlyHint` while
 *   disbelieving its `openWorldHint` is a coherent position and the common one.
 *
 * Every untrusted hint takes the MCP fail-closed default ({@link MCP_FAIL_CLOSED_ANNOTATIONS}), so
 * **an untrusted server's effective set IS that constant** and its declarations cannot perturb any
 * rule. They begin to matter at the moment the user trusts them — which is also the only moment
 * they could start lying usefully.
 *
 * ## The one derivation on top
 *
 * **Where effective `readOnlyHint` is true, effective `destructiveHint` is false.** That is the MCP
 * schema's own rule that `destructiveHint` is meaningful only when `readOnlyHint == false`, applied
 * once here so no consumer ever reads a hint the specification itself calls meaningless.
 *
 * ## What a trusted annotation can buy
 *
 * A trusted external annotation may only ever bring a tool **up to** what the same annotation
 * grants one of our own — never more. That holds by construction rather than by a rule: both
 * provenances resolve into the same four booleans through this one function, so a fully-trusted
 * server's declaration and a built-in's identical declaration produce identical effective sets, and
 * there is no path by which the external one could produce something the internal one could not.
 */
import {
  type McpApprovalsConfig,
  TOOL_ANNOTATION_HINTS,
  type ToolAnnotationHint,
} from '#src/config/shell-policy.js';
import {
  type EffectiveToolAnnotations,
  type EffectiveToolAnnotationSource,
  MCP_FAIL_CLOSED_ANNOTATIONS,
  type McpToolApprovalSubject,
  type ToolApprovalSubject,
} from '#src/core/approvals/matcher.js';

/**
 * What a tool **declares** about itself: the four MCP `ToolAnnotations` booleans, each optional
 * because a tool that says nothing about a hint is the ordinary case and takes the fail-closed
 * default. Distinct from {@link EffectiveToolAnnotations}, where all four are present, because the
 * gap between *declared* and *effective* is exactly what trust decides.
 */
export interface DeclaredToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Where declared annotations come from, split by the provenance that decides their trust.
 *
 * Both members are optional and both may return `undefined` for a tool they do not know, which
 * yields the fail-closed defaults — never "trusted, declaring nothing". An absent lookup is
 * therefore the safe configuration rather than a broken one, and a source built with neither member
 * is exactly the constant fail-closed source.
 */
export interface DeclaredToolAnnotationLookup {
  /**
   * Our own tools, by tool name. Whatever this returns is trusted **verbatim** — no per-hint
   * filter applies, because we (or the user, in their own config) authored it.
   */
  builtIn?: (name: string) => DeclaredToolAnnotations | undefined;
  /**
   * One MCP server's declaration for one tool, from its `tools/list` response. `server` is the
   * user's own `mcpServers` config key (§4.7.5), which is also the key its trust is looked up
   * under; nothing a server says about its own name ever participates.
   */
  mcp?: (server: string, name: string) => DeclaredToolAnnotations | undefined;
}

/** Everything {@link createEffectiveToolAnnotationSource} needs. Both parts optional. */
export interface EffectiveToolAnnotationOptions {
  /** The resolved `approvals.mcp` block (§9), or `undefined` to trust nothing external. */
  mcp?: McpApprovalsConfig;
  /** The declared-annotation sources. Absent members simply declare nothing. */
  declared?: DeclaredToolAnnotationLookup;
}

/**
 * §4.7.1/§9 — the hints the user believes from ONE server, by the user's own config key.
 *
 * **`defaults` applies to servers not named under `servers`.** A server that names itself states
 * its relationship in full, so `{"jira": {}}` trusts nothing however permissive `defaults` is.
 * The alternative — falling back to `defaults` field by field — would mean a server named with an
 * empty body silently inherits trust, and trust by omission is the failure this section exists to
 * prevent.
 *
 * The lookup is an **own-property** one, and that is load-bearing rather than defensive noise.
 * `servers` is a plain user-authored map, so a server key that collides with an `Object.prototype`
 * member (`constructor`, `toString`, `hasOwnProperty`, `valueOf`) would otherwise resolve to the
 * INHERITED value — truthy, so `defaults` is never consulted and that one server silently gets a
 * relationship nobody wrote. Here that lands fail-closed; on the `expose` field [[EXT-73]] adds to
 * this same block it lands fail-OPEN, because an absent `expose` means "expose every tool". A
 * server's identity is the user's own config key (§4.7.5) and every such key must resolve by the
 * same rule.
 */
export function trustedAnnotationHints(
  mcp: McpApprovalsConfig | undefined,
  server: string
): readonly ToolAnnotationHint[] {
  const servers = mcp?.servers;
  const named = servers && Object.hasOwn(servers, server) ? servers[server] : undefined;
  const relationship = named ?? mcp?.defaults;
  return relationship?.trustAnnotations ?? [];
}

/**
 * §4.7.1 — the derivation that rides on top of every effective set: where `readOnlyHint` is true,
 * `destructiveHint` is false. Applied to BOTH provenances, since it is a statement about the
 * vocabulary rather than about who supplied it.
 */
function applyReadOnlyDerivation(annotations: EffectiveToolAnnotations): EffectiveToolAnnotations {
  return annotations.readOnlyHint ? { ...annotations, destructiveHint: false } : annotations;
}

/**
 * Resolve one tool's effective set: each hint independently takes the declared value where that
 * hint is trusted from that provenance, and the MCP fail-closed default everywhere else.
 *
 * A declared value that is not a boolean is treated as not declared — a `tools/list` response is
 * network input, and a string `"true"` must not become a `true` the gate acts on.
 */
function effectiveAnnotations(
  declared: DeclaredToolAnnotations | undefined,
  trusted: ReadonlySet<ToolAnnotationHint>
): EffectiveToolAnnotations {
  const resolved: EffectiveToolAnnotations = { ...MCP_FAIL_CLOSED_ANNOTATIONS };
  if (declared) {
    for (const hint of TOOL_ANNOTATION_HINTS) {
      if (!trusted.has(hint)) continue;
      const value = declared[hint];
      if (typeof value === 'boolean') resolved[hint] = value;
    }
  }
  return applyReadOnlyDerivation(resolved);
}

/** Our own tools are trusted on every hint. */
const ALL_HINTS: ReadonlySet<ToolAnnotationHint> = new Set(TOOL_ANNOTATION_HINTS);

/**
 * EXT-70 §4.7.1 — build the {@link EffectiveToolAnnotationSource} the matcher reads a `hint` entry
 * through, from the user's `approvals.mcp` block and whatever declared annotations are available.
 *
 * **It never returns `undefined`.** The contract admits it for a source that genuinely cannot
 * answer, but this one always can: a tool nothing has declared for is not unknown, it is
 * fail-closed — a writer that destroys, is not idempotent and reaches the open world. Answering
 * with that constant is both more useful and no less safe than answering "undecidable", which the
 * matcher would resolve in the same direction anyway.
 */
export function createEffectiveToolAnnotationSource(
  options: EffectiveToolAnnotationOptions = {}
): EffectiveToolAnnotationSource {
  const { mcp, declared } = options;

  return (subject: ToolApprovalSubject | McpToolApprovalSubject): EffectiveToolAnnotations => {
    // Both branches are spelled out, and the TRUSTED one is never the fall-through. A trusted path
    // reached by `else` silently widens the moment a third subject kind appears: the new kind would
    // inherit read-everything-verbatim without anyone deciding that it should. The tail below is
    // unreachable while the union has two members, and is what a third one would land on instead.
    if (subject.kind === 'mcpTool') {
      const trusted = new Set(trustedAnnotationHints(mcp, subject.server));
      return effectiveAnnotations(declared?.mcp?.(subject.server, subject.name), trusted);
    }
    if (subject.kind === 'tool') {
      return effectiveAnnotations(declared?.builtIn?.(subject.name), ALL_HINTS);
    }
    return { ...MCP_FAIL_CLOSED_ANNOTATIONS };
  };
}
