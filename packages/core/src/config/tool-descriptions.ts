/**
 * @packageDocumentation
 * EXT-58 — **rung-aware tool descriptions** (`docs/gaunt-sloth-2.0/approvals-and-rater-spec.md`
 * §4.5) and the table of built-in tools the rater may offer as a granted alternative (§4.4).
 *
 * §4.5 is the *prevention* half of the approvals design. Shell commands are gated; built-in tools
 * at or below the current rung are not, so a model that reaches for the shell to do something a
 * granted built-in already does converts a free action into an interruption. A model chooses a
 * tool by reading that tool's description, so the approvals posture is stated **there** — not as a
 * global preference in the system prompt, which sits far from the decision and can drift out of
 * step with the gate.
 *
 * Two properties are load-bearing and are why this module exists at all:
 *
 * 1. **A tool that is auto-approved gets NO suffix.** The absence of the sentence is what marks it
 *    free. Appending "this tool is already approved" would be the opposite of the design.
 * 2. **The suffix is derived from the rung in force AND from the set of tools the gate actually
 *    gates.** "A description that disagrees with what the gate will actually do is worse than no
 *    description at all" (§4.5), so {@link isGrantedAtRung} takes the gated set as a parameter and
 *    both backends pass the SAME set they wire into the approval interrupt. The two can therefore
 *    not drift: widening the gate ([[EXT-30]]) widens the descriptions in the same breath.
 *
 * **Scope boundary, per §4.3:** *"The first implementation and the measurement corpus cover the
 * shell only. Every other tool is granted or escalated by the rung without a rating call until
 * EXT-30 widens the gate."* Today `run_shell_command` is the only tool either backend wires into
 * the approval interrupt, so it is the only tool that can ever require approval — every other tool
 * is **granted**, and a granted tool gets no suffix. The rung-vs-access-class rule below
 * (read tools granted from `read-only` up, write tools from `write` up) is implemented in full and
 * unit-tested against an injected wider gated set, so EXT-30 inherits it rather than re-deriving
 * it; it simply has no observable effect while the gated set is the shell alone.
 */
import type { ApprovalRung } from '#src/config/shell-policy.js';

/**
 * §4.5's table, **verbatim**. The wordings are normative copy the model reads; do not paraphrase,
 * re-punctuate or "improve" them.
 *
 * - `read-only` and `write` share one sentence: at both rungs a non-granted call goes to the human,
 *   so the user's approval is a certainty, not a possibility.
 * - `auto-safe` softens `will` to `MAY`: the rater approves what it rates safe, so only some calls
 *   reach the user.
 * - `full-auto` gets its **own** wording because the consequence differs — the user is not asked
 *   there, so promising the user's approval would be false. What can happen is a refusal by the
 *   rater.
 * - `bypass` appends nothing to anything: no gate, so no sentence could be true.
 */
export const RUNG_TOOL_DESCRIPTION_SUFFIXES: Readonly<Record<ApprovalRung, string | null>> = {
  'read-only':
    "Calling this tool will require the user's approval. Only use it when the result cannot be " +
    'achieved with the other provided tools.',
  write:
    "Calling this tool will require the user's approval. Only use it when the result cannot be " +
    'achieved with the other provided tools.',
  'auto-safe':
    "Calling this tool MAY require the user's approval if it does not look safe. Only use it when " +
    'it is impossible to achieve the result with the other provided tools.',
  'full-auto':
    'Calling this tool MAY be refused by the auto-rater if it does not look safe. Only use it ' +
    'when it is impossible to achieve the result with the other provided tools.',
  bypass: null,
};

/** The distinct suffix strings, for {@link stripRungToolDescriptionSuffix}'s idempotency check. */
const ALL_SUFFIXES: readonly string[] = Array.from(
  new Set(Object.values(RUNG_TOOL_DESCRIPTION_SUFFIXES).filter((s): s is string => s !== null))
);

/**
 * The access class of a built-in tool, in the sense §2 grants them: `read` = reading and listing
 * files within the working folder; `write` = creating, editing, moving and deleting files within
 * the working folder. A tool that does neither (the shell, a network fetch, an MCP call) has no
 * class and is granted by no rung but `bypass`.
 */
export type BuiltInToolAccess = 'read' | 'write';

/**
 * Access class per built-in tool name. Covers BOTH backends' names: gsloth's own
 * `GthFileSystemToolkit` (lean) and deepagents' filesystem tools (`ls`/`glob`/`grep`, deep) — the
 * two sets overlap on `read_file`/`write_file`/`edit_file`, which is exactly why one flat table
 * keyed by name serves both.
 *
 * Deliberately absent: `run_shell_command`, the fixed dev-command tools, `gth_web_fetch`,
 * `gth_checklist`, `gth_status_update`, `show_a2ui_surface`, MCP/custom/A2A tools. None of them is
 * "reading or writing files in the working folder", so none is granted by a rung's access class.
 * (They are still *granted today* — the gate does not gate them — which {@link isGrantedAtRung}
 * decides on the gated set, not on this table.)
 */
export const BUILT_IN_TOOL_ACCESS: Readonly<Record<string, BuiltInToolAccess>> = {
  // gsloth GthFileSystemToolkit (lean backend)
  read_file: 'read',
  read_multiple_files: 'read',
  gth_read_binary: 'read',
  list_directory: 'read',
  list_directory_with_sizes: 'read',
  directory_tree: 'read',
  search_files: 'read',
  get_file_info: 'read',
  list_allowed_directories: 'read',
  write_file: 'write',
  edit_file: 'write',
  create_directory: 'write',
  move_file: 'write',
  delete_file: 'write',
  delete_directory: 'write',
  // deepagents filesystem tools (deep backend) not already named above
  ls: 'read',
  glob: 'read',
  grep: 'read',
  // gsloth built-ins that read file contents in the working folder
  gth_grep: 'read',
};

/** A built-in tool the rater may offer as an already-granted alternative (§4.4). */
export interface GrantedToolSummary {
  /** The registered tool name, exactly as the model sees it. */
  name: string;
  /** One line, authored here — locally-generated trusted text (§4.3), never a tool's own blurb. */
  description: string;
}

/**
 * §4.3/§4.4 — the one-line descriptions handed to the rater with the granted tools' names.
 *
 * **Authored here on purpose.** §4.3 admits this list as *"trusted, locally-generated text, not
 * part of the fenced block"*, so it may not be assembled from tool `description` fields at large:
 * an MCP server's tool description is attacker-influenceable text, and placing it outside the
 * fenced block would open an injection channel straight past the rater's untrusted-input preamble.
 * Only tools named in THIS table are ever offered, so an MCP, custom or A2A tool can never
 * contribute text to the rater prompt.
 *
 * Restricted to tools that could plausibly stand in for a shell command — the file tools, content
 * search, the web fetch, and the fixed dev-command tools. `gth_checklist`, `gth_status_update` and
 * `show_a2ui_surface` are omitted: they substitute for nothing a model would otherwise shell out
 * for, and a suggestion list is only useful while it is short.
 */
export const BUILT_IN_TOOL_SUMMARIES: Readonly<Record<string, string>> = {
  read_file: 'Read one file in the working folder.',
  read_multiple_files: 'Read several files in the working folder in one call.',
  gth_read_binary: 'Read an image or other binary file in the working folder.',
  list_directory: 'List the entries of a directory in the working folder.',
  list_directory_with_sizes: 'List a directory in the working folder with entry sizes.',
  directory_tree: 'Show a recursive tree of a directory in the working folder.',
  search_files: 'Find files in the working folder by name pattern.',
  get_file_info: 'Show size, timestamps and type of a file in the working folder.',
  list_allowed_directories: 'List the directories the file tools are allowed to touch.',
  write_file: 'Create or overwrite a file in the working folder.',
  edit_file: 'Apply a targeted edit to a file in the working folder.',
  create_directory: 'Create a directory in the working folder.',
  move_file: 'Move or rename a file in the working folder.',
  delete_file: 'Delete a file in the working folder.',
  delete_directory: 'Delete a directory in the working folder.',
  ls: 'List the entries of a directory in the working folder.',
  glob: 'Find files in the working folder by glob pattern.',
  grep: 'Search file contents in the working folder by regular expression.',
  gth_grep: 'Search file contents in the working folder by regular expression.',
  gth_web_fetch: 'Fetch a URL and return its content as text.',
  run_tests: "Run the project's configured test command.",
  run_single_test: "Run one test file with the project's configured test command.",
  run_lint: "Run the project's configured lint command.",
  run_build: "Run the project's configured build command.",
};

/** The sentence §4.5 appends at this rung, or `null` when the rung appends nothing (`bypass`). */
export function getRungToolDescriptionSuffix(rung: ApprovalRung): string | null {
  return RUNG_TOOL_DESCRIPTION_SUFFIXES[rung] ?? null;
}

/**
 * Is `toolName` auto-approved (granted, free, no prompt and no rating) at `rung`?
 *
 * @param toolName The registered tool name.
 * @param rung The rung in force for the session.
 * @param gatedTools The names the gate actually wires into the approval interrupt. **This is the
 *   parameter that keeps the descriptions honest**: a tool the gate does not gate cannot require
 *   approval, whatever a rung's table row says about tool classes, so it is granted. Both backends
 *   pass the same set they hand to `interruptOn` / `humanInTheLoopMiddleware`.
 *
 * Order:
 * 1. `bypass` grants everything (§2.5) — the gate is off.
 * 2. A tool the gate does not gate is granted at every rung (§4.3's scope boundary).
 * 3. A gated tool is granted only where the rung's own grant covers its access class: read tools
 *    from `read-only` up (§2.1), write tools from `write` up (§2.2, and §2.3/§2.4 which grant
 *    "everything `write` grants"). A gated tool with no access class — the shell, a network call,
 *    an MCP tool — is granted at no rung but `bypass`.
 */
export function isGrantedAtRung(
  toolName: string,
  rung: ApprovalRung,
  gatedTools: readonly string[]
): boolean {
  if (rung === 'bypass') return true;
  if (!gatedTools.includes(toolName)) return true;
  const access = BUILT_IN_TOOL_ACCESS[toolName];
  if (access === 'read') return true;
  if (access === 'write') return rung !== 'read-only';
  return false;
}

/**
 * Remove a previously-appended §4.5 suffix (any rung's), returning the tool's own description.
 *
 * Makes {@link applyRungAwareToolDescriptions} idempotent and re-appliable at a different rung —
 * which matters because a resolver may hand back the SAME tool instance on a re-init (an MCP
 * client caches its tool objects), and a second pass would otherwise stack sentences.
 */
export function stripRungToolDescriptionSuffix(description: string): string {
  let result = description;
  // Loop: a description that was appended to twice by an older build still ends up clean.
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of ALL_SUFFIXES) {
      if (result.endsWith(suffix)) {
        result = result.slice(0, -suffix.length).replace(/\s+$/, '');
        changed = true;
      }
    }
  }
  return result;
}

/** The minimal shape {@link applyRungAwareToolDescriptions} needs; keeps this module langchain-free. */
export interface DescribableTool {
  name?: string;
  description?: string;
}

/**
 * §4.5 — at tool-registration time, append the rung's sentence to the description of every tool
 * that is NOT auto-approved at that rung, and leave every granted tool's description untouched.
 *
 * Mutates in place (and returns the same array): the tools are about to be handed to
 * `createAgent`/`createDeepAgent`, and the array is freshly resolved per init. Idempotent — any
 * previously-appended suffix is stripped first, so re-registration at a different rung replaces
 * the sentence rather than stacking one.
 *
 * A tool with no name is left alone (provider-native "magic object" tools carry no name and cannot
 * be classified); a tool with an empty description gets the suffix as its whole description rather
 * than a leading space.
 */
export function applyRungAwareToolDescriptions<T extends DescribableTool>(
  tools: T[],
  options: { rung: ApprovalRung; gatedTools: readonly string[] }
): T[] {
  const suffix = getRungToolDescriptionSuffix(options.rung);
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    if (typeof tool.description !== 'string') continue;
    const base = stripRungToolDescriptionSuffix(tool.description);
    // A granted tool carries NO sentence — its absence is what marks it free (§4.5).
    if (suffix === null || isGrantedAtRung(tool.name, options.rung, options.gatedTools)) {
      tool.description = base;
      continue;
    }
    tool.description = base.length > 0 ? `${base} ${suffix}` : suffix;
  }
  return tools;
}

/**
 * §4.3/§4.4 — the names and one-line descriptions of the built-in tools already granted at `rung`,
 * for the rater prompt.
 *
 * Filtered three ways, each of which matters:
 * - to tools **actually registered** in this session (a suggestion naming a tool the model does not
 *   have is worse than no suggestion);
 * - to tools in {@link BUILT_IN_TOOL_SUMMARIES}, so only locally-authored text ever reaches the
 *   rater prompt (never an MCP/custom tool's own description);
 * - to tools **granted at the rung** — suggesting a tool that would itself need approval defeats
 *   the point.
 *
 * Order follows the registration order so the prompt is stable across runs.
 */
export function describeGrantedBuiltInTools(
  registeredToolNames: readonly string[],
  rung: ApprovalRung,
  gatedTools: readonly string[]
): GrantedToolSummary[] {
  const seen = new Set<string>();
  const summaries: GrantedToolSummary[] = [];
  for (const name of registeredToolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const description = BUILT_IN_TOOL_SUMMARIES[name];
    if (!description) continue;
    if (!isGrantedAtRung(name, rung, gatedTools)) continue;
    summaries.push({ name, description });
  }
  return summaries;
}
