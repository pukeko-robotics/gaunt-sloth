/**
 * @module core/approvals/toolAnnotationSources
 *
 * EXT-70 §4.7 — **where a declared annotation actually comes from**: our own authored hint sets for
 * our own tools, and a server's `tools/list` declaration for an MCP tool. The trust that is then
 * applied to them lives in `core/approvals/annotations.ts` and only there; this module supplies the
 * raw claims and nothing else.
 *
 * ## One annotation-driven classifier, and no exempt list
 *
 * §4.7 is explicit that the vocabulary — `readOnlyHint`, `destructiveHint`, `idempotentHint`,
 * `openWorldHint` — is shared by built-in, MCP and custom tools, with *"no bespoke exempt list"*.
 * {@link BUILT_IN_TOOL_ANNOTATIONS} is therefore a statement of **what each tool does**, not a list
 * of tools that get special treatment: nothing reads a name out of it to decide an outcome, and
 * every consumer reads the four booleans. A table of names that skip the gate would be the thing
 * this section removes.
 *
 * ## Absent means fail-closed, never "trusted, declaring nothing"
 *
 * A tool this module cannot answer for yields `undefined`, which
 * `createEffectiveToolAnnotationSource` resolves to the MCP fail-closed defaults — a destructive,
 * non-idempotent, open-world writer. That is why tools whose honest annotation set simply *is* the
 * fail-closed default are deliberately absent below rather than spelled out: `run_shell_command`,
 * the fixed dev-command tools, A2A agent tools and user-authored custom tools all reach arbitrary
 * code or the network, and writing rows that restate the default would add entries no behaviour
 * could distinguish from their absence.
 */
import { TOOL_ANNOTATION_HINTS } from '#src/config/shell-policy.js';
import type { DeclaredToolAnnotations } from '#src/core/approvals/annotations.js';
import {
  isMcpNamespacedToolName,
  mcpToolRegisteredName,
  UNRESOLVED_MCP_SERVER,
} from '#src/core/approvals/mcpSubjects.js';

/**
 * A built-in's authored hint set. **All four hints are stated**, never a subset: an omitted hint
 * silently takes the fail-closed default, so a partial row would read as a considered judgment
 * while actually being a gap. Requiring the whole set makes a forgotten hint a compile error.
 */
export type AuthoredToolAnnotations = Required<DeclaredToolAnnotations>;

/** Build one authored set. Named arguments, because a row of four bare booleans is unreviewable. */
function authored(annotations: AuthoredToolAnnotations): AuthoredToolAnnotations {
  return Object.freeze(annotations);
}

/**
 * Reads a file, a directory or file contents inside the working folder. Mutates nothing, so
 * `destructiveHint` is moot and false; reaches nothing off this machine; and reading twice reads
 * the same thing.
 */
const LOCAL_READ = authored({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * Leaves the working folder in a state its **arguments alone** determine — overwriting or removing
 * whatever happened to be at the path — so it destroys, and repeating the identical call lands the
 * same end state. Covers writing a whole file and deleting a file or a directory: what they have in
 * common is that neither reads what is there first, and both discard it.
 */
const LOCAL_ABSOLUTE_CHANGE = authored({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * Changes something in the working folder in a way that depends on what is there now: it destroys
 * what it replaced, and repeating it either fails or lands a second, different time.
 */
const LOCAL_RELATIVE_CHANGE = authored({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});

/**
 * Adds something to the working folder that was not there, destroying nothing, and settles into the
 * same state when repeated.
 */
const LOCAL_ADDITIVE_CHANGE = authored({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * Writes state that belongs to **this session** — the agent's own plan, a surface rendered for the
 * user — rather than to the working folder. Replacing such state destroys nothing outside the
 * session, and re-sending the same state leaves the same state.
 *
 * Deliberately a separate constant from {@link LOCAL_ADDITIVE_CHANGE} despite carrying the same
 * four values: the two describe different things, so a future correction to one must not silently
 * move the other's tools.
 */
const SESSION_STATE_CHANGE = authored({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/**
 * §4.7 — what each of our own tools does, in the MCP `ToolAnnotations` vocabulary. Read **verbatim**
 * through the trusted provenance (§4.7.1: we author these), so every value here has to be *true*
 * rather than convenient.
 *
 * Keyed by the registered tool NAME, not by owner — gsloth's own `GthFileSystemToolkit` and
 * `gth_*` tools, plus the conventional `ls`/`glob`/`grep` a graph builder or MCP server may
 * register — because the conventions overlap on `read_file`/`write_file`/`edit_file` and one flat
 * table by name serves them all, exactly as `BUILT_IN_TOOL_ACCESS` does.
 *
 * The judgments that carry security weight:
 *
 * - **A local read is `readOnlyHint: true`, `openWorldHint: false`.** It mutates nothing and reaches
 *   nothing off this machine.
 * - **`gth_web_fetch` is `readOnlyHint: true` AND `openWorldHint: true`** — §4.7.3. It mutates
 *   nothing locally *and* reaches the network, and the two facts are independent. Reading it as a
 *   local read is precisely what §4.7.3 forbids: §4.6 floors a shell fetch before any model call,
 *   and "the same fetch reached through a tool instead of through `curl` must not be ungated", or
 *   the preflight is a rule about spelling rather than about fetching.
 * - **Anything that writes, moves or deletes is not `readOnlyHint: true`**, and is
 *   `destructiveHint: true` wherever the call can destroy something that was already there —
 *   which `create_directory` cannot and `write_file`, `edit_file`, `move_file` and the two deletes
 *   can.
 * - `idempotentHint` says whether repeating the identical call changes anything further. It has no
 *   built-in consumer (§4.7.2) and is recorded so the vocabulary round-trips and a user's own
 *   `hint` entry can reference it. MCP defines it, like `destructiveHint`, as meaningful only when
 *   `readOnlyHint` is false, so on a read row it is **moot and stated `true`**: a tool that changes
 *   nothing cannot change anything further on a second call, and a read row claiming otherwise
 *   would contradict itself.
 */
export const BUILT_IN_TOOL_ANNOTATIONS: Readonly<Record<string, AuthoredToolAnnotations>> =
  Object.freeze({
    // ---- Local reads (gsloth's GthFileSystemToolkit and gth_* tools, lean backend). -----------
    read_file: LOCAL_READ,
    read_multiple_files: LOCAL_READ,
    gth_read_binary: LOCAL_READ,
    list_directory: LOCAL_READ,
    list_directory_with_sizes: LOCAL_READ,
    directory_tree: LOCAL_READ,
    search_files: LOCAL_READ,
    get_file_info: LOCAL_READ,
    // Reports which directories the file tools may touch. Reads configuration, changes nothing.
    list_allowed_directories: LOCAL_READ,
    gth_grep: LOCAL_READ,
    // ---- Conventional local-read names a graph builder or MCP server may register. -----------
    ls: LOCAL_READ,
    glob: LOCAL_READ,
    grep: LOCAL_READ,

    // ---- Local writes. -----------------------------------------------------------------------
    // Writes the whole file, so it destroys whatever was there; the same bytes twice leave the
    // same file.
    write_file: LOCAL_ABSOLUTE_CHANGE,
    // A targeted edit destroys the text it replaces, and re-applying it either fails or lands a
    // second time.
    edit_file: LOCAL_RELATIVE_CHANGE,
    // Creating a directory adds and removes nothing; the second call leaves the same tree.
    create_directory: LOCAL_ADDITIVE_CHANGE,
    // A move removes the source, and the second call no longer has one.
    move_file: LOCAL_RELATIVE_CHANGE,
    // Deletion destroys by definition; the second call finds nothing left to change.
    delete_file: LOCAL_ABSOLUTE_CHANGE,
    delete_directory: LOCAL_ABSOLUTE_CHANGE,

    // ---- The open-world read (§4.7.3): read-only locally, and on the network. -----------------
    gth_web_fetch: authored({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    }),

    // ---- Tools that touch only this session's own surfaces. ----------------------------------
    // Prints one line for the user and changes no state anywhere, so it is a read. `idempotentHint`
    // is then MOOT for exactly the reason `destructiveHint` is — MCP defines both as meaningful
    // only when `readOnlyHint` is false — and a moot hint states the value consistent with the
    // read: a tool that changes nothing cannot change anything *further* when called again.
    // Stating `false` here would have this row contradict itself.
    gth_status_update: authored({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    // Replaces the agent's own plan state: a write, destroying nothing outside the session, and
    // re-sending the same checklist leaves the same checklist.
    gth_checklist: SESSION_STATE_CHANGE,
    // Renders a UI surface on the client — it changes what the user sees rather than nothing at
    // all, and re-rendering the same surface is the same surface.
    show_a2ui_surface: SESSION_STATE_CHANGE,
  });

/**
 * §4.7.1 — the `builtIn` half of a `DeclaredToolAnnotationLookup`: what WE say one of our own tools
 * does.
 *
 * **Keyed off {@link BUILT_IN_TOOL_ANNOTATIONS}, our own authored table, and never off the bound
 * tool list.** The bound list is the merged set the graph is given, and it contains every MCP
 * server's tools; a `builtIn` lookup implemented over it would read a third-party declaration
 * through the trusted-verbatim path — the same "a gate any server can opt itself out of" hole as
 * routing an MCP call to a `tool` subject, arriving by a different door. §4.7.1 puts it more
 * strongly still: what decides trust is *who authored the annotation*, so even a tool running
 * in-process whose annotations we did not write does not take this path.
 *
 * Returns a fresh object, so the table cannot be mutated through the lookup; `undefined` for
 * anything not in it, which is fail-closed.
 */
export function builtInToolAnnotations(toolName: string): DeclaredToolAnnotations | undefined {
  if (!Object.hasOwn(BUILT_IN_TOOL_ANNOTATIONS, toolName)) return undefined;
  return { ...BUILT_IN_TOOL_ANNOTATIONS[toolName] };
}

/** The slice of a registered tool this module reads. Keeps it free of any langchain type. */
export interface AnnotationDeclaringTool {
  name?: string;
  /** `unknown` on purpose: it is whatever the adapter attached, and it is network-derived. */
  metadata?: unknown;
}

/**
 * Read the four MCP hints a tool DECLARES, off the `metadata.annotations` the MCP adapter carries
 * over verbatim from the server's `tools/list` response.
 *
 * Own-property reads of the four known hint names only, so nothing else in a server's payload can
 * arrive as a hint. Values are passed through **unchanged**, including non-booleans: the one place
 * that decides a string `"true"` is not a `true` is the trust computation
 * (`createEffectiveToolAnnotationSource`), and duplicating that judgment here would give it two
 * homes that can disagree.
 *
 * `undefined` when the payload declares none of the four — a server that says nothing about itself
 * is the ordinary case and must land on fail-closed, not on an empty "it declared nothing" object.
 */
export function declaredToolAnnotationsFrom(
  metadata: unknown
): DeclaredToolAnnotations | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const annotations = (metadata as { annotations?: unknown }).annotations;
  if (!annotations || typeof annotations !== 'object') return undefined;
  const declared = annotations as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let stated = false;
  for (const hint of TOOL_ANNOTATION_HINTS) {
    if (!Object.hasOwn(declared, hint)) continue;
    result[hint] = declared[hint];
    stated = true;
  }
  return stated ? (result as DeclaredToolAnnotations) : undefined;
}

/**
 * §4.7.1 — collect what the connected MCP servers declared, keyed by the **registered tool name**
 * (`mcp__<server>__<tool>`).
 *
 * Keying by the registered name rather than by a parsed `(server, tool)` pair is what makes the
 * lookup immune to the `__`-in-a-server-key hazard: the reader rebuilds the same string with
 * `mcpToolRegisteredName` from a server key it has already resolved against the configured set, so
 * nothing is ever split apart and re-joined differently.
 *
 * Only MCP-namespaced names are collected. Our own tools' annotations come from
 * {@link BUILT_IN_TOOL_ANNOTATIONS} and must not be reachable through the per-hint-trusted MCP
 * path, and a custom tool's own metadata is not ours to believe either (§4.7.1).
 */
export function collectDeclaredMcpToolAnnotations(
  tools: readonly AnnotationDeclaringTool[]
): ReadonlyMap<string, DeclaredToolAnnotations> {
  const collected = new Map<string, DeclaredToolAnnotations>();
  for (const tool of tools) {
    const name = tool?.name;
    if (typeof name !== 'string' || !isMcpNamespacedToolName(name)) continue;
    const declared = declaredToolAnnotationsFrom(tool.metadata);
    if (declared) collected.set(name, declared);
  }
  return collected;
}

/**
 * §4.7.1/§4.7.5 — the `mcp` half of a `DeclaredToolAnnotationLookup`, over what
 * {@link collectDeclaredMcpToolAnnotations} recorded.
 *
 * **{@link UNRESOLVED_MCP_SERVER} is refused outright**, and that guard is structural rather than
 * belt-and-braces. A call whose server could not be resolved has no identity to look a declaration
 * up by; without the guard the lookup would fall back to *string arithmetic* on the sentinel and
 * find a declaration in whatever entry happened to reconstruct to the same registered name.
 * "Happened not to collide" is not a security property. Refusing the sentinel makes an
 * unidentifiable call fail-closed for a reason that does not depend on the shape of anyone's tool
 * names — and, because trust for an unnamed server would otherwise fall through to
 * `approvals.mcp.defaults`, this is also what stops a permissive `defaults` from reaching it.
 *
 * There is one lookup rather than one per call site so the guard cannot be present in the runner
 * and absent in the next consumer.
 */
export function mcpDeclaredAnnotationLookup(
  declared: ReadonlyMap<string, DeclaredToolAnnotations> | undefined
): (server: string, toolName: string) => DeclaredToolAnnotations | undefined {
  return (server, toolName) => {
    if (server === UNRESOLVED_MCP_SERVER) return undefined;
    return declared?.get(mcpToolRegisteredName(server, toolName));
  };
}
