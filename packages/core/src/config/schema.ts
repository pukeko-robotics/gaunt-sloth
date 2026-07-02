/**
 * @packageDocumentation
 * Zod schema for the on-disk raw Gaunt Sloth config (`RawGthConfig`).
 *
 * This is the single source of truth for config validation and for the generated
 * JSON Schema (`packages/core/schema/gsloth-config.schema.json`). It models the
 * canonical config shape only — the deprecated aliases (`contentProvider`,
 * `requirementsProvider`, `contentProviderConfig`, `requirementsProviderConfig`)
 * are intentionally NOT part of the schema. The loader maps those one-way to the
 * canonical names ({@link preMapDeprecatedConfigNames}) BEFORE validating, so by
 * the time a config reaches the schema it only uses canonical names.
 *
 * Design notes:
 * - The top-level object is a {@link z.looseObject} so unknown keys PASS THROUGH
 *   (they are neither stripped nor a hard failure). The loader separately diffs
 *   present-vs-known top-level keys ({@link findUnknownTopLevelKeys}) to warn about
 *   likely typos without failing.
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

const filesystemSchema = z.union([z.array(z.string()), z.enum(['all', 'read', 'none'])]);

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

const shellJudgeSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().optional(),
    autoApproveLow: z.boolean().optional(),
    blockHigh: z.boolean().optional(),
    model: llmConfigSchema.optional(),
  }),
]);

const shellConfigSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().optional(),
    timeout: z.number().optional(),
    maxOutputBytes: z.number().optional(),
    allowlist: z.boolean().optional(),
    persistAllowlist: z.boolean().optional(),
    judge: shellJudgeSchema.optional(),
  }),
]);

const devToolsConfigSchema = z.object({
  run_tests: z.string().optional(),
  run_lint: z.string().optional(),
  run_build: z.string().optional(),
  run_single_test: z.string().optional(),
  shell: shellConfigSchema.optional(),
  shellYolo: z.boolean().optional(),
});

const prCommandSchema = z.object({
  contentSource: z.string().optional(),
  requirementSource: z.string().optional(),
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
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
  builtInTools: z.array(z.string()).optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  rating: ratingConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const askCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  devTools: devToolsConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const chatCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const codeCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  devTools: devToolsConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const execCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  devTools: devToolsConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const apiCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
  port: z.number().optional(),
  cors: z
    .object({
      allowOrigin: z.string().optional(),
      allowMethods: z.string().optional(),
      allowHeaders: z.string().optional(),
    })
    .optional(),
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
 * Zod schema for the raw, on-disk Gaunt Sloth config. Loose at the top level so
 * unknown keys are preserved (warn-only via {@link findUnknownTopLevelKeys}).
 */
export const rawGthConfigSchema = z.looseObject({
  // Allow a JSON Schema reference for editor support; never read at runtime.
  $schema: z.string().optional(),
  llm: llmConfigSchema.optional(),
  // Selects the agent backend. `deep` (the default when omitted) uses the deepagents
  // runtime; `lean` uses the plain LangChain agent (no `/large_tool_results` offload).
  // Honored at the AG-UI/api entry; the ACP server is deep-only and rejects `lean`.
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
  projectGuidelines: z.string().optional(),
  identityProfile: z.string().optional(),
  includeCurrentDateAfterGuidelines: z.boolean().optional(),
  organization: z
    .object({
      name: z.string().optional(),
      locale: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
  projectReviewInstructions: z.string().optional(),
  noDefaultPrompts: z.boolean().optional(),
  filesystem: filesystemSchema.optional(),
  builtInTools: z.array(z.string()).optional(),
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
  a2aAgents: z.record(z.string(), z.unknown()).optional(),
  builtInToolsConfig: z.record(z.string(), z.unknown()).optional(),
  aiignore: z
    .object({
      enabled: z.boolean().optional(),
      patterns: z.array(z.string()).optional(),
    })
    .optional(),
  commands: commandsSchema.optional(),
  modelDisplayName: z.string().optional(),
  allowDirs: z.array(z.string()).optional(),
  askWriteMode: z.boolean().optional(),
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
 * Return the top-level keys present in `raw` that are not part of the known config
 * surface. Deprecated aliases should be pre-mapped away first (see
 * {@link preMapDeprecatedConfigNames}) so they do not show up here.
 */
export function findUnknownTopLevelKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key));
}

/**
 * Render a friendly, path-scoped validation message from a Zod error. Each issue
 * becomes a line `  - <path>: <message>`, with `(root)` for top-level issues.
 */
export function formatConfigValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}

/** Deprecated → canonical key pairs at the config root. */
const DEPRECATED_ROOT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['contentProvider', 'contentSource'],
  ['requirementsProvider', 'requirementSource'],
  ['contentProviderConfig', 'contentSourceConfig'],
  ['requirementsProviderConfig', 'requirementSourceConfig'],
];

/** Deprecated → canonical key pairs inside a `commands.<name>` block. */
const DEPRECATED_COMMAND_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['contentProvider', 'contentSource'],
  ['requirementsProvider', 'requirementSource'],
];

function remapDeprecated(
  obj: Record<string, unknown>,
  pairs: ReadonlyArray<readonly [string, string]>,
  scope: string,
  warnings: string[]
): void {
  for (const [deprecated, canonical] of pairs) {
    if (Object.prototype.hasOwnProperty.call(obj, deprecated)) {
      warnings.push(
        `Config property "${deprecated}"${scope} is deprecated. Use "${canonical}" instead.`
      );
      // Canonical wins when both are present; otherwise adopt the deprecated value.
      if (obj[canonical] === undefined) {
        obj[canonical] = obj[deprecated];
      }
      delete obj[deprecated];
    }
  }
}

/**
 * B3 — one-way pre-map of deprecated config key names to their canonical names, at
 * the config root AND per-command. Mutates `raw` in place (it is always a freshly
 * loaded config layer) and returns it alongside a list of deprecation warnings the
 * caller should emit via `displayWarning`. Canonical names win when both are
 * present; the deprecated key is always removed so it does not later surface as an
 * "unknown top-level key".
 */
export function preMapDeprecatedConfigNames<T extends Record<string, unknown>>(
  raw: T
): { config: T; warnings: string[] } {
  const warnings: string[] = [];
  remapDeprecated(raw, DEPRECATED_ROOT_PAIRS, '', warnings);
  const commands = raw.commands;
  if (commands && typeof commands === 'object') {
    for (const [name, cmd] of Object.entries(commands as Record<string, unknown>)) {
      if (cmd && typeof cmd === 'object') {
        remapDeprecated(
          cmd as Record<string, unknown>,
          DEPRECATED_COMMAND_PAIRS,
          ` in commands.${name}`,
          warnings
        );
      }
    }
  }
  return { config: raw, warnings };
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
export interface RawConfigValidationResult {
  /** True when the config parses against the schema (unknown keys do NOT make it false). */
  ok: boolean;
  /** Non-fatal advisories: deprecated-name remaps (B3) and unknown top-level keys. */
  warnings: string[];
  /** Present only when `ok` is false: the path-scoped, multi-line validation message. */
  errorMessage?: string;
}

/**
 * Validate a freshly-loaded raw config object against {@link rawGthConfigSchema} and
 * report the outcome as data (a pure function — no `displayWarning`/`exit`). Mirrors the
 * loader's policy: deprecated key names are pre-mapped (each yielding a warning), unknown
 * top-level keys warn but do not fail, and a genuine type mismatch on a known field fails
 * with a path-scoped message.
 *
 * A shallow copy is taken before the (mutating) deprecated-name pre-map so the caller's
 * top-level object is not modified.
 */
export function validateRawGthConfig(raw: Record<string, unknown>): RawConfigValidationResult {
  const warnings: string[] = [];
  const { config, warnings: deprecationWarnings } = preMapDeprecatedConfigNames({ ...raw });
  warnings.push(...deprecationWarnings);

  const unknownKeys = findUnknownTopLevelKeys(config);
  if (unknownKeys.length > 0) {
    warnings.push(
      `Unknown top-level config ${unknownKeys.length === 1 ? 'key' : 'keys'}: ` +
        `${unknownKeys.join(', ')} (kept as-is but ignored by Gaunt Sloth; check for typos).`
    );
  }

  const result = rawGthConfigSchema.safeParse(config);
  if (!result.success) {
    return { ok: false, warnings, errorMessage: formatConfigValidationError(result.error) };
  }
  return { ok: true, warnings };
}
