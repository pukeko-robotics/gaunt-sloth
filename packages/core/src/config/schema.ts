/**
 * @packageDocumentation
 * Zod schema for the on-disk raw Gaunt Sloth config (`RawGthConfig`).
 *
 * This is the single source of truth for config validation and for the generated
 * JSON Schema (`packages/core/schema/gsloth-config.schema.json`). It models the
 * canonical config shape only — the deprecated aliases (`contentProvider`,
 * `requirementsProvider`, `contentProviderConfig`, `requirementsProviderConfig`)
 * are intentionally NOT part of the schema. GS2-28 (a 2.0 breaking release with NO
 * back-compat coercion) turns those deprecated shapes into HARD validation errors:
 * {@link findDeprecatedConfigIssues} detects them on the raw input BEFORE the schema
 * parse and each entry point (loader `validateRawConfigLayer`, read-side
 * {@link validateRawGthConfig}) rejects the config with a message naming the canonical
 * replacement + migration path. Detection runs on the RAW input on purpose: zod's
 * per-command `z.object` strips unknown keys, so a nested `commands.*.contentProvider`
 * would vanish before any schema-embedded check could see it.
 *
 * Design notes:
 * - The top-level object is a {@link z.looseObject} so unknown keys PASS THROUGH
 *   (they are neither stripped nor a hard failure). The loader separately diffs
 *   present-vs-known top-level keys ({@link findUnknownTopLevelKeys}) to warn about
 *   likely typos without failing. That typo-tolerance is deliberate: only the KNOWN
 *   deprecated names ({@link findDeprecatedConfigIssues}) hard-fail; a genuine typo
 *   (e.g. `pulrequest`) still only warns.
 * - Every field is optional. The schema validates the *shape/type of what is
 *   present*, not requiredness. In particular `llm` is optional so the loader's
 *   existing "must at least define llm.type" checks remain the authority on llm
 *   validity (and keep emitting their established messages).
 * - Runtime-object-bearing fields (`tools`, `middleware`, `mcpServers`,
 *   `a2aAgents`, `builtInToolsConfig`) are modelled permissively because JS/MJS
 *   `configure()` returns live instances/objects there.
 *
 * The exported {@link RawGthConfig}/{@link GthConfig} interfaces in `config.ts`
 * remain the public type surface; the `z.infer` here ({@link RawGthConfigInput})
 * is additive and legitimately differs (no deprecated fields).
 */
import { z } from 'zod';

// `constants.ts` is a plain, import-free string module, so this does NOT compromise the purity
// this file depends on (it feeds `z.toJSONSchema` and must stay cwd/fs-independent).
import { GSLOTH_DIR, GSLOTH_SETTINGS_DIR } from '#src/constants.js';

const filesystemSchema = z.union([z.array(z.string()), z.enum(['all', 'read', 'none'])]);

/**
 * TLS trust for outbound HTTPS (MCP servers over `http` transport, and — because the mechanism is
 * a process-global undici dispatcher — every other `fetch`, including LLM provider calls). Lets a
 * config point Node's `fetch` at a private/corporate CA without prepending `NODE_EXTRA_CA_CERTS`
 * on every invocation (that env var is read once at Node startup and can't be set from config).
 */
const tlsSchema = z.object({
  // Extra CA cert file(s) to TRUST in ADDITION to Node's built-in roots. Paths resolve
  // relative-to-project (or `~`/absolute). Additive — this never removes a default root.
  extraCaCerts: z.array(z.string()).optional(),
  // DANGER: `false` disables TLS certificate verification for ALL outbound HTTPS this process makes
  // (not just MCP — LLM calls too). Escape hatch only; emits a loud security warning every session.
  rejectUnauthorized: z.boolean().optional(),
});

const llmConfigSchema = z.looseObject({
  type: z.string().optional(),
  model: z.string().optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  apiKeyEnvironmentVariable: z.string().optional(),
});

const ratingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  passThreshold: z.number().optional(),
  maxRating: z.number().optional(),
  minRating: z.number().optional(),
  errorOnReviewFail: z.boolean().optional(),
});

const customCommandParameterSchema = z.object({
  description: z.string(),
  allow: z
    .array(z.enum(['absolute-paths', 'directory-traversal', 'shell-injection', 'null-bytes']))
    .optional(),
});

const customCommandConfigSchema = z.object({
  command: z.string(),
  description: z.string(),
  parameters: z.record(z.string(), customCommandParameterSchema).optional(),
  timeout: z.number().optional(),
});

const customToolsConfigSchema = z.record(z.string(), customCommandConfigSchema);
const customToolsOrFalseSchema = z.union([z.literal(false), customToolsConfigSchema]);

const binaryFormatConfigSchema = z.object({
  type: z.enum(['image', 'file', 'audio', 'video', 'binary']),
  extensions: z.array(z.string()),
  maxSize: z.number().optional(),
  mimeTypes: z.record(z.string(), z.string()).optional(),
});
const binaryFormatsSchema = z.union([z.literal(false), z.array(binaryFormatConfigSchema)]);

/**
 * CFG-26 — the exact error text for the `mode: "auto"` + rater-disabled coupling violation
 * (spec wording). Exported so the loader's per-command check and the tests share one string.
 */
export const APPROVALS_AUTO_REQUIRES_RATER =
  "auto-approve requires the AI rater; set approvals.mode to 'ask' or configure approvals.rater";

/**
 * CFG-26 — the AI **rater**: the LLM that rates a pending tool call before it runs. `false`
 * disables it entirely; `true`/absent means "on with defaults" (the session's main model); the
 * object form is fine-grained. Deliberately ONE off-switch (`rater: false`) rather than both a
 * boolean form and an `enabled` field — two ways to say one thing in a channel that freezes at GA
 * is exactly the sloppiness this node removes.
 *
 * - `profile` — an identity profile the rater runs under (strict resolution, GS2-62: a name that
 *   does not resolve is a hard config error, never a silent fallback). Omitted = the main model.
 * - `strictness` — tunes the RATING-PROMPT tier definitions only (what counts as `safe` vs
 *   `caution`); it never changes the action mapping.
 * - `escalate` — the ONLY model-vs-human routing knob: risk at/above this tier asks the human,
 *   below it the rejection reason goes back to the model. `critical` is deliberately NOT a valid
 *   value: critical always rejects, with no knob that lets it through to a prompt.
 *
 * NOTE: "judge" is reserved for the eval grader (`gth eval --judge <profile>`) — a different
 * concept that keeps its name.
 */
const raterConfigSchema = z.union([
  z.boolean(),
  z.object({
    profile: z.string().optional(),
    strictness: z.enum(['lenient', 'standard', 'strict']).optional(),
    escalate: z.enum(['caution', 'danger', 'never']).optional(),
  }),
]);

/**
 * CFG-26 — the top-level `approvals` block: the whole gate deciding whether/how a mutating tool
 * call gets permission to run. Replaces the per-tool `builtInTools.run_shell_command.{yolo,judge,
 * allowlist,persistAllowlist}` knobs, which sat on the object shared by EVERY built-in tool (so
 * `gth_grep: { yolo: true }` validated) — moving them here fixes that too.
 *
 * - `mode` — `auto` (rater-mediated), `ask` (always prompt), `bypass` (no gate; the honest name
 *   for the retired `yolo`). The exec-time hardline floor still refuses catastrophic commands
 *   under every mode.
 * - `rater` / `allowlist` / `persistAllowlist` — see {@link raterConfigSchema}; the allow-list
 *   knobs keep their previous semantics, only their location changed.
 *
 * The `mode: "auto"` + rater-disabled coupling is enforced by a `.superRefine` rather than by the
 * object shape ON PURPOSE: refinements do not emit into the generated JSON Schema, so the
 * published `/v2/` channel stays complete and correct while the runtime still rejects the
 * combination. Defaults are applied at the READ site (`resolveApprovals` in `shell-policy.ts`),
 * not in DEFAULT_CONFIG, so the effective-config snapshot never churns (à la GS2-34/GS2-63).
 */
const approvalsSchema = z
  .object({
    mode: z.enum(['auto', 'ask', 'bypass']).optional(),
    rater: raterConfigSchema.optional(),
    allowlist: z.boolean().optional(),
    persistAllowlist: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'auto' && value.rater === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['rater'],
        message: APPROVALS_AUTO_REQUIRES_RATER,
      });
    }
  });

/**
 * EXT-36 — the tool-loop guard (repeated identical `(tool, args)` / no-progress detector), the
 * orthogonal sibling of GS2-36's error budget. Modeled on {@link raterConfigSchema}: `false` disables
 * it entirely; `true`/absent is warn-on defaults; the object form is fine-grained. `warn` (default
 * ON) injects a control-flow-free nudge at the threshold; `halt` (default OFF, opt-in) ends the run
 * cleanly at the threshold; `threshold` is the number of consecutive identical calls that trip it.
 * The warn-on default is applied at the read site, so this field is intentionally absent from
 * DEFAULT_CONFIG.
 */
const toolLoopGuardSchema = z.union([
  z.boolean(),
  z.object({
    warn: z.boolean().optional(),
    halt: z.boolean().optional(),
    threshold: z.number().optional(),
  }),
]);

/**
 * CFG-18 — the per-tool config object carried as a value in the widened `builtInTools` registry.
 * One permissive shape covering every tool: `command` for the fixed dev-command tools
 * (run_tests/run_lint/run_build/run_single_test), the EXT-12 execution knobs for
 * `run_shell_command` (`timeout`/`maxOutputBytes`), `fileSet` for `gth_grep` (GS2-51), and
 * `enabled` for a plain built-in tool.
 *
 * CFG-26 — the APPROVAL knobs that used to live here (`allowlist`, `persistAllowlist`, `judge`,
 * `yolo`) moved to the top-level {@link approvalsSchema}. They were fields of the object shared by
 * EVERY built-in tool, which is why a nonsensical `gth_grep: { yolo: true }` validated. Each is now
 * a hard migration error — see `RETIRED_SHELL_TOOL_PAIRS` in {@link findDeprecatedConfigIssues}.
 */
const builtInToolConfigSchema = z.object({
  enabled: z.boolean().optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  maxOutputBytes: z.number().optional(),
  // GS2-51 — `gth_grep`: which corpus to search. `gitignore` (default) respects .gitignore/.ignore
  // and skips hidden dot-files; `all` scans everything but the noise dirs. See BuiltInToolConfig.
  fileSet: z.enum(['gitignore', 'all']).optional(),
});

/**
 * CFG-18 — the widened `builtInTools` setting: either the legacy `string[]` (each name enabled) or
 * a registry keyed by tool name whose values enable (`true`), force-disable (`false`), or configure
 * ({@link builtInToolConfigSchema}) each tool. Replaces `builtInTools: string[]` + per-command
 * `devTools`.
 */
const builtInToolsSchema = z.union([
  z.array(z.string()),
  z.record(z.string(), z.union([z.boolean(), builtInToolConfigSchema])),
]);

/**
 * GS2-43 — one prompt segment inside the {@link promptsSchema} object. Either a `string`
 * (shorthand for `{ path }`) or a config object:
 * - `path` — file to read for this segment (resolved like every prompt file: config dir /
 *   identity profile first, then relative to the project root).
 * - `enabled: false` — drop the segment entirely (even its bundled default).
 * - `mode` — `'replace'` (default): the file replaces the built-in segment content;
 *   `'append'`: the file content is appended after the built-in content.
 */
const promptSegmentSchema = z.union([
  z.string(),
  z.object({
    path: z.string().optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(['replace', 'append']).optional(),
  }),
]);

/**
 * GS2-43 — the unified `prompts` config object (CFG-18's flat-key→rich-object precedent).
 * Replaces the removed flat `projectGuidelines` / `projectReviewInstructions` keys and makes
 * ALL seven prompt segments retargetable through config (previously backstory/system/chat/
 * code/exec were reachable only by placing a file in the config dir). Kept as a plain
 * `z.object` of optional sibling keys so a future segment (e.g. GS2-44's `agents`) is a
 * one-line addition with no collision risk.
 */
const promptsSchema = z.object({
  backstory: promptSegmentSchema.optional(),
  guidelines: promptSegmentSchema.optional(),
  system: promptSegmentSchema.optional(),
  chat: promptSegmentSchema.optional(),
  code: promptSegmentSchema.optional(),
  exec: promptSegmentSchema.optional(),
  review: promptSegmentSchema.optional(),
});

const prCommandSchema = z.object({
  contentSource: z.string().optional(),
  requirementSource: z.string().optional(),
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  logWorkForReviewInSeconds: z.number().optional(),
  rating: ratingConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const reviewCommandSchema = z.object({
  contentSource: z.string().optional(),
  requirementSource: z.string().optional(),
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  rating: ratingConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const askCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const chatCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const codeCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const execCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const apiCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — per-command approvals posture; replaces the root block wholesale when set.
  approvals: approvalsSchema.optional(),
  port: z.number().optional(),
  cors: z
    .object({
      allowOrigin: z.string().optional(),
      allowMethods: z.string().optional(),
      allowHeaders: z.string().optional(),
    })
    .optional(),
});

/**
 * GS2-33 — one profile-backed subagent: a `name` the model selects it by, an optional
 * `description`, and the named config `profile` the CHILD resolves through the GS2-1 cascade when
 * spawned. See {@link SubagentProfileSpec}.
 */
const subagentSpecSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  profile: z.string(),
});

const commandsSchema = z.object({
  pr: prCommandSchema.optional(),
  review: reviewCommandSchema.optional(),
  ask: askCommandSchema.optional(),
  chat: chatCommandSchema.optional(),
  code: codeCommandSchema.optional(),
  exec: execCommandSchema.optional(),
  api: apiCommandSchema.optional(),
});

/**
 * The command names, derived from {@link commandsSchema}'s own shape so it can never drift
 * from the schema. A command config must live under `commands.<cmd>`; the SAME name appearing
 * at the config ROOT is the removed pre-2.0 top-level shape and is hard-rejected by
 * {@link findDeprecatedConfigIssues}. (None of these are valid top-level keys, so there is no
 * collision with {@link KNOWN_TOP_LEVEL_KEYS}.)
 */
const COMMAND_KEYS: readonly string[] = Object.keys(commandsSchema.shape);

/**
 * Zod schema for the raw, on-disk Gaunt Sloth config. Loose at the top level so
 * unknown keys are preserved (warn-only via {@link findUnknownTopLevelKeys}).
 */
export const rawGthConfigSchema = z.looseObject({
  // Allow a JSON Schema reference for editor support; never read at runtime.
  $schema: z.string().optional(),
  llm: llmConfigSchema.optional(),
  // GS2-41 — profile composition. A NAMED profile config may declare `extends: "<base-profile>"` to
  // inherit another profile's config: the base profile resolves FIRST, then this profile's own
  // fields merge on top (last-wins, same GS2-1 deep-merge as the config layers; a base may itself
  // extend another, with a cycle guard). Consumed during load — never appears in the resolved
  // config. See `resolveConfigExtends` in loader.ts.
  extends: z.string().optional(),
  // Selects the agent backend. `lean` (the default when omitted) uses the plain LangChain agent
  // with gsloth's full toolset (no `/large_tool_results` offload). `deep` is the EXPERIMENTAL,
  // opt-in deepagents runtime and emits a warning when selected. The ACP server is deep-only.
  agent: z
    .object({
      backend: z.enum(['deep', 'lean']).optional(),
    })
    .optional(),
  // GS2-7 (B20) — local, opt-in session history. DEFAULT OFF: absent or `enabled: false` means
  // nothing is persisted and runs behave exactly as before (stateless identity preserved).
  history: z
    .object({
      enabled: z.boolean().optional(),
      dbPath: z.string().optional(),
    })
    .optional(),
  // GS2-7 (B21) — opt-in file-backed memory (MEMORY.md / USER.md). DEFAULT OFF. The toggle exists
  // for forward-compat; the feature itself is a deferred follow-up.
  memory: z
    .object({
      enabled: z.boolean().optional(),
    })
    .optional(),
  binaryFormats: binaryFormatsSchema.optional(),
  contentSource: z.string().optional(),
  requirementSource: z.string().optional(),
  contentSourceConfig: z.record(z.string(), z.unknown()).optional(),
  requirementSourceConfig: z.record(z.string(), z.unknown()).optional(),
  // GS2-43 — the unified prompt-segment config; replaces projectGuidelines/projectReviewInstructions.
  prompts: promptsSchema.optional(),
  identityProfile: z.string().optional(),
  includeCurrentDateAfterGuidelines: z.boolean().optional(),
  organization: z
    .object({
      name: z.string().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  noDefaultPrompts: z.boolean().optional(),
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-26 — the tool-approval gate (mode + AI rater + allow-list). Settable at the root or per
  // command (`commands.<command>.approvals`, which REPLACES the root block wholesale, mirroring
  // `builtInTools`). Absent = the context defaults in `resolveApprovals` (shell-policy.ts).
  approvals: approvalsSchema.optional(),
  // Live tool instances / toolkits in JS configs — kept permissive.
  tools: z.array(z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
  // Predefined (string/object) or custom (object) middleware — permissive.
  middleware: z.array(z.unknown()).optional(),
  streamOutput: z.boolean().optional(),
  writeOutputToFile: z.union([z.boolean(), z.string()]).optional(),
  writeBinaryOutputsToFile: z.boolean().optional(),
  useColour: z.boolean().optional(),
  streamSessionInferenceLog: z.boolean().optional(),
  canInterruptInferenceWithEsc: z.boolean().optional(),
  debugLog: z.boolean().optional(),
  recursionLimit: z.number().optional(),
  consoleLevel: z.union([z.string(), z.number()]).optional(),
  customTools: customToolsConfigSchema.optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  tls: tlsSchema.optional(),
  a2aAgents: z.record(z.string(), z.unknown()).optional(),
  builtInToolsConfig: z.record(z.string(), z.unknown()).optional(),
  aiignore: z
    .object({
      enabled: z.boolean().optional(),
      patterns: z.array(z.string()).optional(),
    })
    .optional(),
  commands: commandsSchema.optional(),
  // GS2-35 — identity used in the `Co-Authored-By` trailer of agent-authored git commits. Optional;
  // when omitted the agent is instructed to co-author as the Gaunt Sloth account
  // (`Gaunt Sloth <code@gauntsloth.app>`), NEVER the underlying model. Either field may be set
  // alone; the other falls back to its default (see `appendCommitCoAuthorNote`).
  commit: z
    .object({
      coAuthor: z
        .object({
          name: z.string().optional(),
          email: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  modelDisplayName: z.string().optional(),
  // GS2-34 — inject the resolved active `provider:model` identity into the system prompt (default ON;
  // set `false` to opt out for reproducible / model-agnostic runs). Defaulted at the read site, so it
  // is intentionally absent from DEFAULT_CONFIG (no effective-config snapshot churn).
  injectModelContext: z.boolean().optional(),
  // GS2-47 — secret-redaction for `/debug-dump` artifacts. `redact` DEFAULTS ON (omitted = redact);
  // set `false` to write a raw, unredacted archive (the command then shows a loud secrets warning).
  // Defaulted at the read site (`!== false`), not in DEFAULT_CONFIG, to avoid churning the
  // effective-config snapshot (à la GS2-34 injectModelContext).
  debugDump: z
    .object({
      redact: z.boolean().optional(),
    })
    .optional(),
  allowDirs: z.array(z.string()).optional(),
  askWriteMode: z.boolean().optional(),
  // GS2-63 — output surface controls. `header` DEFAULTS ON (omitted = show); set `false` to
  // suppress the technical run-header preamble (the Workdir/Model/Tools/Middleware block, the
  // `Press Escape or Q to interrupt` hint, and their surrounding blank lines) in NON-TUI text
  // modes (`--no-tui`, `ask`, `exec`, `eval`, `pr`, `review`, piped/CI), keeping captured stdout /
  // log diffs clean. The interactive TUI ignores it and always shows the header. Suppresses ONLY
  // that preamble — never model/tool output, errors, or config-validation warnings. Defaulted at
  // the read site (`!== false`), not in DEFAULT_CONFIG, to avoid churning the effective-config
  // snapshot (à la GS2-34 injectModelContext).
  output: z
    .object({
      header: z.boolean().optional(),
    })
    .optional(),
  // EXT-36 — tool-loop guard (repeated identical (tool, args) / no-progress detector), the sibling
  // of GS2-36's error budget. `false` disables; `true`/absent = warn-on defaults; object =
  // fine-grained ({ warn, halt, threshold }). WARN (default ON) injects a control-flow-free nudge;
  // HALT (default OFF, opt-in) ends the run cleanly at the threshold. Defaulted at the read site
  // (warn on), not in DEFAULT_CONFIG, so the effective-config snapshot never churns.
  toolLoopGuard: toolLoopGuardSchema.optional(),
  // BATCH-19 — custom `gth eval` reporters. Maps a reporter NAME (as selected with
  // `--reporter <name>`) to a MODULE PATH (relative to the project dir) whose default export is an
  // `EvalReporterFactory` (`() => EvalReporter`). Registered through the same seam the bundled
  // reporters use; a name here overrides a built-in of the same name.
  reporters: z.record(z.string(), z.string()).optional(),
  // GS2-33 — profile-backed subagents. Each entry names a subagent and the named config profile the
  // CHILD resolves when the deep backend's `task` tool spawns it, so a subagent can run under a
  // different model/tools/prompt than the parent. See {@link subagentSpecSchema}.
  subagents: z.array(subagentSpecSchema).optional(),
});

/**
 * Type inferred from {@link rawGthConfigSchema}. This is additive and intentionally
 * separate from the hand-written `RawGthConfig` interface in `config.ts` (it omits
 * the deprecated aliases). Prefer `RawGthConfig` for the public surface.
 */
export type RawGthConfigInput = z.infer<typeof rawGthConfigSchema>;

/**
 * The set of known top-level config keys, derived from the schema shape so it can
 * never drift from {@link rawGthConfigSchema}. Includes `$schema`.
 */
export const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(rawGthConfigSchema.shape)
);

/**
 * True when a raw config value is a plain (non-null, non-array) object, so the key scans
 * ({@link findDeprecatedConfigIssues}, {@link findUnknownTopLevelKeys}) are safe to run. A
 * `null`/array/primitive config (e.g. a JSON file that is just `null`, or a module
 * `configure()` returning null) must NOT reach those scans — they'd throw on
 * `hasOwnProperty`/`Object.keys`; the entry points instead hand it straight to
 * `rawGthConfigSchema.safeParse`, which reports a clean "expected object" error.
 */
export function isRecordConfig(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return the top-level keys present in `raw` that are not part of the known config
 * surface. KNOWN deprecated names are rejected earlier by {@link findDeprecatedConfigIssues}
 * (the entry points short-circuit on those), so a key that reaches here is a genuinely
 * unknown key (a likely typo) that only warrants a warning.
 */
export function findUnknownTopLevelKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
}

/**
 * Render `  - <path>: <message>` lines (one per issue), with `(root)` for an empty
 * path. Shared by {@link formatConfigValidationError} (Zod issues) and
 * {@link formatDeprecatedConfigIssues} (deprecated-shape issues) so both surfaces read
 * identically.
 */
function formatIssueLines(issues: ReadonlyArray<{ path: string; message: string }>): string {
  return issues.map((issue) => `  - ${issue.path || '(root)'}: ${issue.message}`).join('\n');
}

/**
 * Render a friendly, path-scoped validation message from a Zod error. Each issue
 * becomes a line `  - <path>: <message>`, with `(root)` for top-level issues.
 */
export function formatConfigValidationError(error: z.ZodError): string {
  return formatIssueLines(
    error.issues.map((issue) => ({
      path: issue.path.length > 0 ? issue.path.join('.') : '',
      message: issue.message,
    }))
  );
}

/** Deprecated → canonical key pairs at the config root (SSOT for the rejecter). */
const DEPRECATED_ROOT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['contentProvider', 'contentSource'],
  ['requirementsProvider', 'requirementSource'],
  ['contentProviderConfig', 'contentSourceConfig'],
  ['requirementsProviderConfig', 'requirementSourceConfig'],
  // GS2-43 — the flat prompt-path keys were folded into the `prompts` object.
  ['projectGuidelines', 'prompts.guidelines'],
  ['projectReviewInstructions', 'prompts.review'],
];

/** Deprecated → canonical key pairs inside a `commands.<name>` block (SSOT for the rejecter). */
const DEPRECATED_COMMAND_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['contentProvider', 'contentSource'],
  ['requirementsProvider', 'requirementSource'],
];

/**
 * CFG-18 — removed per-command keys with no 1:1 rename: the config they carried was FOLDED into
 * another key. `[removed, replacement]`. `devTools` (the split dev/shell config) is now configured
 * under the unified `builtInTools` registry. Rejected here specifically because `devTools` lived
 * under a per-command `z.object`, which SILENTLY STRIPS unknown keys — so without this pre-parse
 * reject an old `commands.<cmd>.devTools` block would vanish with no error (worse than today).
 */
const REMOVED_COMMAND_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['devTools', 'builtInTools'],
];

/**
 * CFG-26 — approval knobs retired from the `builtInTools.run_shell_command` entry and moved to the
 * top-level `approvals` block. `[retired, "how to say it now"]`. Rejected pre-parse for the same
 * reason as {@link REMOVED_COMMAND_KEYS}: `builtInToolConfigSchema` is a strict `z.object`, so once
 * the field is gone zod SILENTLY STRIPS it and an old config would run with its approval posture
 * quietly ignored — the worst possible failure for a safety gate.
 *
 * `judge.autoApproveLow` / `judge.blockHigh` have no 1:1 successor (the 4-tier scale replaced the
 * `low/medium/high` × `destructive` conjunction), so `judge`'s message points at both `approvals.mode`
 * and `approvals.rater.escalate`, and notes that `critical` now always rejects with no knob.
 */
const RETIRED_SHELL_TOOL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['yolo', '"approvals.mode": "bypass"'],
  [
    'judge',
    '"approvals.mode": "auto" with "approvals.rater" (the low/medium/high tiers became ' +
      'safe/caution/danger/critical: autoApproveLow/blockHigh are replaced by ' +
      '"approvals.rater.escalate", and critical now always rejects)',
  ],
  ['allowlist', '"approvals.allowlist"'],
  ['persistAllowlist', '"approvals.persistAllowlist"'],
];

/** The `builtInTools` entry the retired approval knobs used to hang off. */
const SHELL_TOOL_REGISTRY_KEY = 'run_shell_command';

/**
 * Pointer to the migration path, appended to every deprecated-shape error so the user
 * always learns HOW to fix it, not just that it broke. Doc link only, per DOC-STYLE
 * rule 9 (user-visible doc references are absolute GitHub URLs).
 * GS2-5 (B15) will ship `gth config migrate` / `gth doctor --fix`; restore the command
 * reference here when that tooling lands.
 */
const MIGRATION_HINT =
  'See the 2.0 migration notes: https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/MIGRATION.md';

/** A single deprecated-config-shape rejection: the offending `path` and the migration message. */
export interface DeprecatedConfigIssue {
  /** Dotted path of the offending key (e.g. `pr`, `commands.pr.contentProvider`). */
  path: string;
  /** Human message naming the canonical replacement + migration path. */
  message: string;
}

/**
 * CFG-26 — scan one `builtInTools` value (root or per-command) for the retired
 * `run_shell_command` approval knobs, pushing one issue per occurrence. Only the OBJECT registry
 * form can carry them (the legacy `string[]` form is names-only), so an array/non-object value is
 * a no-op. `pathPrefix` is `builtInTools` at the root and `commands.<name>.builtInTools` per
 * command, so the reported path points exactly at the offending key.
 */
function collectRetiredShellToolIssues(
  builtInTools: unknown,
  pathPrefix: string,
  issues: DeprecatedConfigIssue[]
): void {
  if (!builtInTools || typeof builtInTools !== 'object' || Array.isArray(builtInTools)) return;
  const shellEntry = (builtInTools as Record<string, unknown>)[SHELL_TOOL_REGISTRY_KEY];
  if (!shellEntry || typeof shellEntry !== 'object' || Array.isArray(shellEntry)) return;
  for (const [retired, replacement] of RETIRED_SHELL_TOOL_PAIRS) {
    if (Object.prototype.hasOwnProperty.call(shellEntry, retired)) {
      issues.push({
        path: `${pathPrefix}.${SHELL_TOOL_REGISTRY_KEY}.${retired}`,
        message:
          `Config property "${retired}" in ${pathPrefix}.${SHELL_TOOL_REGISTRY_KEY} is no longer ` +
          `supported in 2.0. Use ${replacement} instead. ${MIGRATION_HINT}`,
      });
    }
  }
}

/**
 * GS2-28 — detect the removed pre-2.0 config shapes on the RAW input (read-only; no
 * mutation), returning one {@link DeprecatedConfigIssue} per occurrence. A non-empty
 * result is a HARD validation failure: 2.0 dropped back-compat coercion, so an old shape
 * must error and point at the fix rather than be silently remapped or ignored.
 *
 * Detects:
 * - (A) a COMMAND name ({@link COMMAND_KEYS}) at the config ROOT — must move under `commands.<cmd>`;
 * - (C) a deprecated `*Provider*` name ({@link DEPRECATED_ROOT_PAIRS} at root,
 *   {@link DEPRECATED_COMMAND_PAIRS} per command) — must use its `*Source*` replacement;
 * - (D, CFG-18) a removed per-command key folded into another ({@link REMOVED_COMMAND_KEYS}, e.g.
 *   `commands.<cmd>.devTools` → configure under `builtInTools`);
 * - (E, CFG-26) a retired `run_shell_command` approval knob ({@link RETIRED_SHELL_TOOL_PAIRS}) at
 *   EITHER `builtInTools.run_shell_command.*` or `commands.<cmd>.builtInTools.run_shell_command.*`
 *   — each message names the `approvals.*` key that replaced it.
 *
 * Runs on the raw input specifically so nested `commands.*.contentProvider` is still visible
 * (zod's per-command `z.object` would strip it before any schema-embedded check could fire).
 * A genuinely-unknown key is NOT flagged here (it stays a warn-only unknown key), preserving
 * the deliberate typo-tolerance.
 */
export function findDeprecatedConfigIssues(raw: Record<string, unknown>): DeprecatedConfigIssue[] {
  const issues: DeprecatedConfigIssue[] = [];

  // (A) Command name used as a top-level key — command configs must live under commands.<cmd>.
  for (const command of COMMAND_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, command)) {
      issues.push({
        path: command,
        message:
          `Top-level command config "${command}" is no longer supported in 2.0. ` +
          `Move it under "commands.${command}". ${MIGRATION_HINT}`,
      });
    }
  }

  // (C) Deprecated *Provider* names at the config root.
  for (const [deprecated, canonical] of DEPRECATED_ROOT_PAIRS) {
    if (Object.prototype.hasOwnProperty.call(raw, deprecated)) {
      issues.push({
        path: deprecated,
        message:
          `Config property "${deprecated}" was renamed in 2.0. Use "${canonical}" instead. ` +
          MIGRATION_HINT,
      });
    }
  }

  // (E, CFG-26) Retired run_shell_command approval knobs at the ROOT builtInTools registry.
  collectRetiredShellToolIssues(raw.builtInTools, 'builtInTools', issues);

  // (C) Deprecated *Provider* names + (CFG-18) removed keys inside each commands.<name> block.
  const commands = raw.commands;
  if (commands && typeof commands === 'object' && !Array.isArray(commands)) {
    for (const [name, cmd] of Object.entries(commands as Record<string, unknown>)) {
      if (cmd && typeof cmd === 'object' && !Array.isArray(cmd)) {
        for (const [deprecated, canonical] of DEPRECATED_COMMAND_PAIRS) {
          if (Object.prototype.hasOwnProperty.call(cmd, deprecated)) {
            issues.push({
              path: `commands.${name}.${deprecated}`,
              message:
                `Config property "${deprecated}" in commands.${name} was renamed in 2.0. ` +
                `Use "${canonical}" instead. ${MIGRATION_HINT}`,
            });
          }
        }
        // (CFG-18) removed per-command keys folded into another key (e.g. devTools → builtInTools).
        for (const [removed, replacement] of REMOVED_COMMAND_KEYS) {
          if (Object.prototype.hasOwnProperty.call(cmd, removed)) {
            issues.push({
              path: `commands.${name}.${removed}`,
              message:
                `Config property "${removed}" in commands.${name} is no longer supported in 2.0. ` +
                `Configure tools under "${replacement}" instead. ${MIGRATION_HINT}`,
            });
          }
        }
        // (E, CFG-26) retired run_shell_command approval knobs in this command's registry.
        collectRetiredShellToolIssues(
          (cmd as Record<string, unknown>).builtInTools,
          `commands.${name}.builtInTools`,
          issues
        );
      }
    }
  }

  return issues;
}

/**
 * CFG-26 — one `approvals.rater.profile` reference found in a raw config, with the dotted config
 * path it was found at (`approvals.rater.profile` or `commands.<name>.approvals.rater.profile`).
 */
export interface RaterProfileRef {
  /** Dotted config path of the `profile` key, for the error message. */
  path: string;
  /** The profile name as written. */
  profile: string;
}

/**
 * CFG-26 — collect every `approvals.rater.profile` in a raw config (root + each `commands.<name>`).
 *
 * PURE — it only reads the object; the caller decides whether each name RESOLVES. That split is
 * deliberate: profile resolution needs the filesystem, and `schema.ts` must stay pure so
 * `z.toJSONSchema` and every spec that validates a config object stay cwd-independent. The loader
 * pairs this with `resolveIdentityProfileConfigPath` to enforce the GS2-62 rule that an
 * unresolvable profile is a hard error, never a silent fallback to the main model.
 */
export function findApprovalsRaterProfiles(raw: Record<string, unknown>): RaterProfileRef[] {
  const refs: RaterProfileRef[] = [];

  const collect = (approvals: unknown, prefix: string): void => {
    if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return;
    const rater = (approvals as Record<string, unknown>).rater;
    if (!rater || typeof rater !== 'object' || Array.isArray(rater)) return;
    const profile = (rater as Record<string, unknown>).profile;
    if (typeof profile === 'string' && profile.trim().length > 0) {
      refs.push({ path: `${prefix}.rater.profile`, profile: profile.trim() });
    }
  };

  collect(raw.approvals, 'approvals');

  const commands = raw.commands;
  if (commands && typeof commands === 'object' && !Array.isArray(commands)) {
    for (const [name, cmd] of Object.entries(commands as Record<string, unknown>)) {
      if (cmd && typeof cmd === 'object' && !Array.isArray(cmd)) {
        collect((cmd as Record<string, unknown>).approvals, `commands.${name}.approvals`);
      }
    }
  }

  return refs;
}

/**
 * CFG-26 — the ONE message for an `approvals.rater.profile` that does not resolve. Shared by the
 * loader (which hard-exits a real run) and {@link validateRawGthConfig} (which backs
 * `gth config validate`), so the validator can never green-light a config the runtime refuses.
 */
export function unresolvedRaterProfileMessage(ref: RaterProfileRef): string {
  return (
    `identity profile "${ref.profile}" not found ` +
    `(checked ${GSLOTH_DIR}/${GSLOTH_SETTINGS_DIR}/${ref.profile}/). ` +
    'Create it with `gth config profile create`, or omit approvals.rater.profile to rate ' +
    'with the main model.'
  );
}

/**
 * Render {@link DeprecatedConfigIssue}s as the same `  - <path>: <message>` block used for
 * Zod validation errors, so a deprecated-shape rejection reads identically to a type-mismatch
 * rejection (loader wraps it with `Invalid configuration in <source>:`).
 */
export function formatDeprecatedConfigIssues(issues: ReadonlyArray<DeprecatedConfigIssue>): string {
  return formatIssueLines(issues);
}

/**
 * Generate the JSON Schema for the raw config from {@link rawGthConfigSchema} using
 * zod 4's native `z.toJSONSchema`. The output is committed to
 * `packages/core/schema/gsloth-config.schema.json` and asserted by a golden test.
 */
export function generateConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(rawGthConfigSchema, { io: 'input' }) as Record<string, unknown>;
}

/**
 * The structured outcome of validating a single raw config layer, WITHOUT any side
 * effects (no console output, no `exit`). This is the read-side counterpart to the
 * loader's `validateRawConfigLayer` (which warns + `exit`s inline): `gth config validate`
 * uses it to render its own output and choose its own exit code.
 */
export interface RawConfigValidationOptions {
  /**
   * CFG-26 — resolves an identity profile NAME to "does it exist?". Supplied by the loader
   * (`resolveIdentityProfileConfigPath`); omitted by pure/in-memory callers, which then skip the
   * `approvals.rater.profile` existence check.
   */
  resolveProfile?: (profile: string) => boolean;
}

export interface RawConfigValidationResult {
  /** True when the config parses against the schema (unknown keys do NOT make it false). */
  ok: boolean;
  /** Non-fatal advisories: unknown top-level keys (likely typos). Deprecated shapes are hard errors, not warnings. */
  warnings: string[];
  /** Present only when `ok` is false: the path-scoped, multi-line validation message. */
  errorMessage?: string;
}

/**
 * Validate a freshly-loaded raw config object against {@link rawGthConfigSchema} and
 * report the outcome as data (a pure function — no `displayWarning`/`exit`). Mirrors the
 * loader's policy: a removed pre-2.0 shape (a top-level command key or a deprecated
 * `*Provider*` name) is a HARD failure that names the fix, unknown top-level keys warn but
 * do not fail, and a genuine type mismatch on a known field fails with a path-scoped message.
 *
 * Read-only: `findDeprecatedConfigIssues`, `findUnknownTopLevelKeys` and `safeParse` never
 * mutate `raw`, so no defensive copy is needed.
 */
export function validateRawGthConfig(
  raw: Record<string, unknown>,
  options?: RawConfigValidationOptions
): RawConfigValidationResult {
  const warnings: string[] = [];

  // Only an object config can carry deprecated/unknown keys. A null/array/primitive config is
  // handed straight to safeParse (below), which returns a clean "expected object" failure — the
  // scans would otherwise throw a raw TypeError, and coercing to {} would wrongly report ok:true.
  if (isRecordConfig(raw)) {
    // Removed pre-2.0 shapes short-circuit before the unknown-key warning: any deprecated name
    // present is hard-rejected here (and so never doubles as an unknown-key warning).
    const deprecatedIssues = findDeprecatedConfigIssues(raw);
    if (deprecatedIssues.length > 0) {
      return {
        ok: false,
        warnings: [],
        errorMessage: formatDeprecatedConfigIssues(deprecatedIssues),
      };
    }

    const unknownKeys = findUnknownTopLevelKeys(raw);
    if (unknownKeys.length > 0) {
      warnings.push(
        `Unknown top-level config ${unknownKeys.length === 1 ? 'key' : 'keys'}: ` +
          `${unknownKeys.join(', ')} (kept as-is but ignored by Gaunt Sloth; check for typos).`
      );
    }
  }

  const result = rawGthConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, warnings, errorMessage: formatConfigValidationError(result.error) };
  }

  // CFG-26 — `approvals.rater.profile` strict resolution, when the caller supplies a resolver.
  // The predicate is INJECTED rather than imported so this module stays pure (it feeds
  // `z.toJSONSchema`, and every spec that validates a config object must stay cwd-independent),
  // while `gth config validate` still agrees with the loader instead of green-lighting a config
  // the next real run hard-exits on. Without a resolver the check is skipped, preserving the
  // in-memory callers (e.g. the profile scaffolder).
  if (options?.resolveProfile && isRecordConfig(raw)) {
    const unresolved = findApprovalsRaterProfiles(raw).filter(
      (ref) => !options.resolveProfile!(ref.profile)
    );
    if (unresolved.length > 0) {
      return {
        ok: false,
        warnings,
        errorMessage: formatIssueLines(
          unresolved.map((ref) => ({ path: ref.path, message: unresolvedRaterProfileMessage(ref) }))
        ),
      };
    }
  }

  return { ok: true, warnings };
}
