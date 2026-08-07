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
 * CFG-27 — the five rungs of the approvals ladder, as the schema sees them. Kept as a literal
 * tuple here (rather than imported from `shell-policy.ts`) so the schema module stays the single
 * pre-parse source of truth for what the config channel accepts; `APPROVAL_RUNGS` in
 * `shell-policy.ts` is the runtime twin and `configSchema.spec.ts` pins the two together.
 */
const APPROVAL_RUNG_VALUES = ['manual', 'write', 'assisted', 'auto', 'bypass'] as const;

/**
 * The rung names as an error message lists them. Derived from {@link APPROVAL_RUNG_VALUES} rather
 * than written out again at each site: four messages below enumerate the ladder, and a hand-copied
 * list is exactly what goes stale when a rung is renamed — the failure mode being that a config
 * error names values the schema no longer accepts.
 */
const APPROVAL_RUNG_LIST = APPROVAL_RUNG_VALUES.join(', ');

/**
 * EXT-71 §3.1 — the **subject** axis of a rule entry, and only that: `shell` is a command, `tool`
 * a built-in or custom in-process tool, `mcpTool` a server's tool. The hand-written twin is
 * `ApprovalEntryType` in `shell-policy.ts`. What holds the two together is
 * `approvalEntrySchema.spec.ts`, where a list of `ApprovalEntry`-typed literals is parsed by this
 * schema: a value either side stops accepting fails there. That is a weaker pin than a direct
 * equality assertion — it catches a narrowing, not a widening on one side alone.
 */
export const APPROVAL_ENTRY_TYPES = ['shell', 'tool', 'mcpTool'] as const;

/**
 * EXT-71 §3.1 — the **comparison** axis of a rule entry, and only that. `exact`/`glob`/`regexp`
 * take a string pattern; `hint` takes an object over the annotation names and is valid on tool
 * subjects only (on `shell` it is a config error — see {@link shellEntrySchema}).
 */
export const APPROVAL_ENTRY_MATCHERS = ['exact', 'glob', 'regexp', 'hint'] as const;

/**
 * EXT-71 §3.1 / §4.7 — the four MCP `ToolAnnotations` booleans a `hint` pattern may name, and the
 * names a user may list in `approvals.mcp.*.trustAnnotations` (§4.7.1). This is the whole
 * vocabulary: an unknown name is a config error, never an ignored key, because a hint pattern that
 * quietly drops a constraint matches MORE than its author wrote, and a trust list that quietly
 * drops one reads as working while believing something else.
 *
 * **The runtime twin `TOOL_ANNOTATION_HINTS` in `shell-policy.ts` is a deliberate duplicate, and
 * the reason is layering, not oversight.** Neither file may import the other. This module must stay
 * pure and cwd/fs-independent because it feeds `z.toJSONSchema()` (see the header), and importing
 * `shell-policy.ts` would pull `core/types.js` and the whole runtime policy surface into it;
 * importing this module from there would in turn pull zod into every module that only wanted a
 * policy type. So the vocabulary is written once per layer on purpose — do not "simplify" it by
 * making one import the other. The equality assertion in `mcpApprovalsBlock.spec.ts` is what fails
 * when they drift.
 */
export const HINT_ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
] as const;

/**
 * EXT-71 §3.1 — the length cap on a `regexp` pattern, enforced when the config LOADS.
 *
 * 200 characters. The longest pattern the spec itself writes is under 40, and every rule entry
 * names one command or tool shape rather than a grammar, so 200 is an order of magnitude of
 * headroom over real use while still bounding what the matcher can ever be handed. The cap is a
 * cheap load-time bound, NOT a backtracking defence — a short pattern can backtrack
 * catastrophically too, and the run-time match budget is the separate backstop for that. What the
 * cap buys is that a pattern nobody could have read and reviewed cannot be smuggled past load.
 */
export const APPROVAL_REGEXP_MAX_LENGTH = 200;

/**
 * EXT-71 §3.1 — a `hint` pattern: an object over {@link HINT_ANNOTATION_KEYS} mapping each named
 * annotation to the boolean it must effectively hold. All named hints must match (AND within the
 * entry); hints not named are unconstrained; `false` is the spelling of negation.
 *
 * Strict, and non-empty: an empty object or an unknown name is a hard config error and **never a
 * match-everything**. `minProperties` is attached as metadata rather than being left to the
 * refinement alone so the constraint survives into the emitted JSON Schema (zod drops refinements
 * there), which is what the hosted schema channels and editor validation actually read.
 */
const hintPatternSchema = z
  .strictObject({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .meta({ minProperties: 1 })
  .refine((pattern) => Object.keys(pattern).length > 0, {
    message:
      'a hint pattern must name at least one of ' +
      HINT_ANNOTATION_KEYS.join(', ') +
      ' — an empty object is a config error, never a match-everything',
  });

/**
 * EXT-71 §3.1 — a `regexp` pattern: capped at {@link APPROVAL_REGEXP_MAX_LENGTH} and required to
 * COMPILE when the config loads, never when it first runs. Both failures name the offending
 * pattern in the message: an entry the user cannot trace back to the line they wrote is
 * indistinguishable from a bug.
 *
 * `.max()` is kept alongside the refinement so the cap emits as `maxLength` in the JSON Schema
 * (refinements do not survive `z.toJSONSchema`); the refinement is what produces the message that
 * quotes the pattern.
 */
const regexpPatternSchema = z
  .string()
  .max(APPROVAL_REGEXP_MAX_LENGTH)
  .superRefine((pattern, ctx) => {
    if (pattern.length > APPROVAL_REGEXP_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        message:
          `regexp pattern ${JSON.stringify(pattern)} is ${pattern.length} characters, over the ` +
          `${APPROVAL_REGEXP_MAX_LENGTH}-character cap for an approvals rule pattern`,
      });
      return;
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message:
          `regexp pattern ${JSON.stringify(pattern)} does not compile: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

/** `rate` (§3.2) — optional on EVERY entry type, and the only optional field they all share. */
const rateField = { rate: z.boolean().optional() };

/**
 * `host` (§4.7.4) — optional on TOOL subjects only, exact-match. Forbidden on `shell`, where the
 * host is already inside the command string; the shell arms are strict objects, so writing it
 * there is an unrecognized-key error.
 */
const hostField = { host: z.string().min(1).optional() };

/**
 * EXT-71 §3.1 — a `shell` entry. `matcher` deliberately omits `hint`: a command carries no tool
 * annotations, so `{"type":"shell","matcher":"hint"}` is a discriminator error naming the three
 * matchers a command actually supports. Neither `server` nor `host` exists here.
 */
const shellEntrySchema = z.discriminatedUnion('matcher', [
  z.strictObject({
    type: z.literal('shell'),
    matcher: z.literal('exact'),
    pattern: z.string(),
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('shell'),
    matcher: z.literal('glob'),
    pattern: z.string(),
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('shell'),
    matcher: z.literal('regexp'),
    pattern: regexpPatternSchema,
    ...rateField,
  }),
]);

/** EXT-71 §3.1 — a `tool` entry: a built-in or custom in-process tool, matched on its name. */
const toolEntrySchema = z.discriminatedUnion('matcher', [
  z.strictObject({
    type: z.literal('tool'),
    matcher: z.literal('exact'),
    pattern: z.string(),
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('tool'),
    matcher: z.literal('glob'),
    pattern: z.string(),
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('tool'),
    matcher: z.literal('regexp'),
    pattern: regexpPatternSchema,
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('tool'),
    matcher: z.literal('hint'),
    pattern: hintPatternSchema,
    ...hostField,
    ...rateField,
  }),
]);

/**
 * EXT-71 §3.1 — the reserved MCP server name. `*` in an entry's `server` field means *every
 * server*, so a server actually CALLED `*` would make `{ "server": "*" }` ambiguous — it could not
 * be read as either "every server" or "that one server" without picking, and a rule whose scope
 * depends on which reading won is worse than no rule. The name is therefore refused at load.
 */
const RESERVED_MCP_SERVER_NAME = '*';

/**
 * EXT-78 §4.7.5 — the key an MCP server may be configured under, and the one spelling of that rule
 * a JSON Schema can carry. It states exactly what {@link findApprovalsGrammarIssues} refuses ahead
 * of the parse: a name of at least one character (nothing could be written about a server keyed
 * with the empty string) and any name other than {@link RESERVED_MCP_SERVER_NAME}.
 *
 * It is on the record's KEY so the emitted schema carries both rules as `propertyNames`
 * (`minLength` plus `pattern`). Without them the hosted channels publish a contract that accepts
 * two keys the CLI then refuses to start on, and an editor validating against that contract stays
 * silent while the error arrives from somewhere the user is not looking — the one direction they
 * cannot debug from where they are working.
 *
 * The exclusion is EXACT, matching the pre-parse check's own equality test: a longer name that
 * merely begins with the reserved one (`*-jira`) is an ordinary name and stays valid. And the
 * pre-parse check still runs first and still owns the message that explains *why* each key is
 * refused, which a JSON Schema violation can never say.
 */

/**
 * The exclusion, spelt **without lookaround**, because this pattern is published rather than merely
 * executed here.
 *
 * JSON Schema's `pattern` is nominally ECMA-262, but real validators differ and the ones built on
 * RE2 or Rust's `regex` **cannot compile a lookaround at all** — they reject the document rather
 * than mis-evaluating one keyword. A `^(?!\*$)` spelling therefore risks taking the *whole* hosted
 * schema out of service in those editors, which is a worse failure than the gap this rule closes and
 * defeats the reason the rule exists.
 *
 * Read it as: any single character that is not the reserved one, **or** any string of two or more
 * characters. Only the exact reserved name is left out, which is the pre-parse check's own equality
 * test. The empty string is excluded by `minLength` instead, which is the clearer home for it.
 *
 * **`[\s\S]` and not `.`** — `.` does not match a newline, so a `.`-based spelling refuses a key
 * containing one while the load accepts it. That is a fresh divergence in the opposite direction:
 * an editor red on a config that starts fine, i.e. this rule's own defect class, reintroduced by
 * the fix for it. Measured on `"a\nb"` and `"\n\n"`.
 *
 * The construction assumes a **single-character** reserved name — with a longer one, "not exactly
 * this string" is not expressible as one negated class. {@link mcpServerNameSchema}'s spec asserts
 * that assumption, so changing the constant fails loudly instead of silently emitting a pattern that
 * refuses the wrong set.
 */
const MCP_SERVER_NAME_PATTERN = `^([^${RESERVED_MCP_SERVER_NAME.replace(
  /[\\\]^-]/g,
  '\\$&'
)}]|[\\s\\S]{2,})$`;

const mcpServerNameSchema = z.string().min(1).regex(new RegExp(MCP_SERVER_NAME_PATTERN));

/**
 * EXT-71 §3.1 — an `mcpTool` entry. `server` is **required** here and exists nowhere else: it is
 * the user's own key in `mcpServers` (§4.7.5), the only stable, unique, user-authored identity a
 * server has. The literal `*` is reserved to mean every server, which is why a configured server
 * may not be named `*` ({@link findApprovalsGrammarIssues}).
 */
const mcpToolEntrySchema = z.discriminatedUnion('matcher', [
  z.strictObject({
    type: z.literal('mcpTool'),
    matcher: z.literal('exact'),
    server: z.string().min(1),
    pattern: z.string(),
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('mcpTool'),
    matcher: z.literal('glob'),
    server: z.string().min(1),
    pattern: z.string(),
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('mcpTool'),
    matcher: z.literal('regexp'),
    server: z.string().min(1),
    pattern: regexpPatternSchema,
    ...hostField,
    ...rateField,
  }),
  z.strictObject({
    type: z.literal('mcpTool'),
    matcher: z.literal('hint'),
    server: z.string().min(1),
    pattern: hintPatternSchema,
    ...hostField,
    ...rateField,
  }),
]);

/**
 * EXT-71 §3.1 — **one** entry in `allow`, `deny` or `escalate`. All three lists take the same
 * shape, so there is one schema and the list a rule sits in decides only what a match DOES.
 *
 * `type`, `matcher` and `pattern` are required on every arm: no field is inferred, and no entry
 * reads two ways. Every arm is a strict object, so any field the grammar does not define — a typo,
 * a `server` on a `shell` entry, a `host` on a `shell` entry — is an unrecognized-key error rather
 * than a silently-ignored key that would widen what the entry matches.
 *
 * The `id` is what makes the emitted JSON Schema hoist this union into `$defs` and reference it,
 * instead of inlining all eleven arms into each of the twenty-four places a rule list appears
 * (three lists × the root plus seven commands). That is the difference between a schema an editor loads
 * and one it chokes on, and `$ref` is the standard spelling every JSON Schema consumer already
 * understands.
 */
export const approvalEntrySchema = z
  .discriminatedUnion('type', [shellEntrySchema, toolEntrySchema, mcpToolEntrySchema])
  .meta({ id: 'ApprovalEntry' });

/** The three rule lists, keyed as they appear under `approvals` (§3, §9). */
const APPROVAL_LIST_KEYS = ['allow', 'deny', 'escalate'] as const;

/**
 * EXT-70 §4.7.1/§9.1 — `trustAnnotations`: **the hints believed from one server**, as a LIST of
 * {@link HINT_ANNOTATION_KEYS} names and never a boolean, because trusting `readOnlyHint` while
 * distrusting `openWorldHint` is a coherent position and the common one.
 *
 * An unknown name is a hard config error rather than an ignored member: a list that quietly drops
 * a name the user believed they wrote trusts LESS than they asked in one direction and reads as a
 * working config in the other, and a trust list nobody can verify from its own error output is
 * worse than none. The custom message quotes the offending value, since the path alone gives an
 * index and the user needs the word they mistyped.
 */
const trustAnnotationsSchema = z.array(
  z.enum(HINT_ANNOTATION_KEYS, {
    error: (issue) =>
      `${JSON.stringify(issue.input)} is not an MCP tool annotation. trustAnnotations names the ` +
      `hints believed from a server, and the whole vocabulary is ` +
      `${HINT_ANNOTATION_KEYS.join(', ')}.`,
  })
);

/**
 * EXT-70 §4.7/§9 — one server's entry under `approvals.mcp.servers`, and the shape `defaults`
 * takes. **Strict**: an unrecognized key is an error, so a hint list misspelt as a whole key
 * (`trustAnnotation`, `trust`) fails loudly instead of silently trusting nothing while reading as
 * though it trusted something.
 */
const mcpServerApprovalsSchema = z.strictObject({
  trustAnnotations: trustAnnotationsSchema.optional(),
});

/**
 * EXT-70 §4.7/§9 — the `approvals.mcp` block. `defaults` covers servers not named under `servers`;
 * `servers` is keyed by the user's own `mcpServers` config key (§4.7.5) and is deliberately NOT
 * checked against `mcpServers`, so policy may be written before the server it describes.
 *
 * Strict, and it stays strict: `expose` (§4.7.6) belongs to [[EXT-73]] and is not accepted here
 * until that node adds it deliberately. A permissive block would accept `expose` today, do nothing
 * with it, and leave a user believing their tools were filtered.
 */
const mcpApprovalsSchema = z.strictObject({
  defaults: mcpServerApprovalsSchema.optional(),
  servers: z.record(z.string().min(1), mcpServerApprovalsSchema).optional(),
});

/**
 * EXT-71 §3.1 — render an entry in the object form the user would write in a config file, with the
 * fields in grammar order (`type`, `server`, `matcher`, `pattern`, then the optional bounds).
 *
 * The ONE place that spelling is produced, because it is shown in two very different moments that
 * must agree: the load-time error that tells a user what to write instead of their bare string, and
 * the escalation menu's *this is what will be stored* line (§6). A grant the menu describes one way
 * and stores another is exactly the drift this design cannot afford.
 */
export function renderApprovalEntryObject(entry: {
  type: string;
  matcher: string;
  pattern: unknown;
  server?: string;
  host?: string;
  rate?: boolean;
}): string {
  const fields: [string, unknown][] = [['type', entry.type]];
  if (entry.server !== undefined) fields.push(['server', entry.server]);
  fields.push(['matcher', entry.matcher], ['pattern', entry.pattern]);
  if (entry.host !== undefined) fields.push(['host', entry.host]);
  if (entry.rate !== undefined) fields.push(['rate', entry.rate]);
  const rendered = fields.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return `{ ${rendered.join(', ')} }`;
}

/**
 * EXT-71 §2.3/§9.1 — render the object form of a bare string found in a rule list, so the
 * migration error shows the user the entry they should have written *for their own string*
 * rather than a generic example.
 */
export function renderApprovalEntryForString(pattern: string): string {
  return renderApprovalEntryObject({ type: 'shell', matcher: 'exact', pattern });
}

/**
 * CFG-27 — the `approvals` value: **either the rung name on its own, or an object when the extras
 * are needed** (spec §9). There are no other approvals keys.
 *
 * ```jsonc
 * { "approvals": "assisted" }
 * ```
 * ```jsonc
 * { "approvals": {
 *     "mode": "assisted",
 *     "rater": "safety-rater",                     // identity profile the rater runs under
 *     "allow":    [ { "type": "shell", "matcher": "exact", "pattern": "npm test" } ],
 *     "deny":     [ { "type": "shell", "matcher": "glob",  "pattern": "npm publish*" } ],
 *     "escalate": [ { "type": "shell", "matcher": "exact", "pattern": "terraform apply" } ]
 * } }
 * ```
 *
 * - **The scalar form is exactly sugar for `{ "mode": <value> }`** (§9.1). The union exists so the
 *   extras have a home when they are needed, not so there are two ways to say the same thing.
 * - `rater` is a **bare identity-profile name**, not an object (strict resolution, GS2-62: a name
 *   that does not resolve is a hard config error, never a silent fallback).
 * - `raterTimeoutMs` (EXT-66) is the wall-clock budget for ONE rating call, defaulting to
 *   `RATER_DEFAULT_TIMEOUT_MS` (30s) at the read site. **It exists because 30s is a hosted-model
 *   number and a local model is knowably slower**: measured 2026-07-31, `gemma4:12b` over Ollama
 *   answered a 23-case corpus in 6.0s–114.7s, and at the fixed limit 3 of 18 calls in one run and
 *   9 of 17 in the next were cut off — so a local `auto` session degraded toward escalating
 *   everything, which is the opposite of what the rung is for. Deliberately a number the user owns
 *   rather than a provider→timeout table: a table is a guess about someone else's hardware, and
 *   the failure it causes is silent.
 * - `allow`/`deny`/`escalate` are **read-only input**: merged with the runtime stores the
 *   escalation menu writes, and never written back to config. Every entry is the §3.1 object
 *   ({@link approvalEntrySchema}); a bare string in any of the three is a hard config error whose
 *   message shows the object form of that same string ({@link findApprovalsGrammarIssues}).
 * - `escalate` is the third list (§3, §3.2): a match always asks the human, whatever the rung
 *   would have done. It takes the same entries as the other two.
 * - `mcp` (EXT-70 §4.7) holds the per-server relationship — which hints are believed from which
 *   server — keyed by the user's own `mcpServers` config key, with `defaults` for servers not
 *   named. Absent or empty `trustAnnotations` believes nothing external, which is also the default.
 * - The retired `strictness` / `allowlist` / `persistAllowlist` keys and the retired `auto` / `ask`
 *   mode values are hard migration errors naming their replacement — see `RETIRED_APPROVALS_KEYS` /
 *   `RETIRED_APPROVAL_MODES` in {@link findDeprecatedConfigIssues}. So is a NON-ARRAY `escalate`,
 *   which is the retired severity threshold rather than the new list.
 *
 * Defaults are applied at the READ site (`resolveApprovals` in `shell-policy.ts`), not in
 * DEFAULT_CONFIG, so the effective-config snapshot never churns (à la GS2-34/GS2-63).
 *
 * NOTE: "judge" is reserved for the eval grader (`gth eval --judge <profile>`) — a different
 * concept that keeps its name.
 */
const approvalsSchema = z.union([
  z.enum(APPROVAL_RUNG_VALUES),
  z.object({
    mode: z.enum(APPROVAL_RUNG_VALUES).optional(),
    rater: z.string().optional(),
    // EXT-71 §3.1 — the three rule lists. Same entry grammar in all three; the list decides only
    // what a match DOES (§3: deny over escalate over allow).
    allow: z.array(approvalEntrySchema).optional(),
    deny: z.array(approvalEntrySchema).optional(),
    escalate: z.array(approvalEntrySchema).optional(),
    // EXT-66 — wall-clock budget (ms) for one rating call. See the note on the union above for
    // why this is a user-owned number rather than a per-provider table.
    // `.min(1)`, not `.positive()`: the latter emits `exclusiveMinimum`, a JSON-Schema draft
    // keyword this repo avoids on principle (GS2-57 — Google GenAI rejects it outright in tool
    // declarations). This schema is not a tool declaration, but one spelling everywhere is what
    // stops the wrong one being copied into somewhere that is.
    raterTimeoutMs: z.number().int().min(1).optional(),
    // EXT-70 §4.7/§9 — the per-server MCP relationship, keyed by the user's own `mcpServers` key.
    mcp: mcpApprovalsSchema.optional(),
  }),
]);

/**
 * EXT-36 — the tool-loop guard (repeated identical `(tool, args)` / no-progress detector), the
 * orthogonal sibling of GS2-36's error budget. A boolean-or-object union: `false` disables
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
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
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
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  rating: ratingConfigSchema.optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const askCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const chatCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const codeCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const execCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
  approvals: approvalsSchema.optional(),
  customTools: customToolsOrFalseSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  binaryFormats: binaryFormatsSchema.optional(),
});

const apiCommandSchema = z.object({
  filesystem: filesystemSchema.optional(),
  builtInTools: builtInToolsSchema.optional(),
  // CFG-27/§9.1 — per-command approvals. It overrides only the fields it names: `mode`,
  // `rater`, `raterTimeoutMs` and `allow` replace the root's; `deny`/`escalate` concatenate.
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
  // CFG-27 — the approvals ladder: a rung name, or an object carrying the rater profile and the
  // declared allow/deny lists. Settable at the root or per command
  // (`commands.<command>.approvals`, which per §9.1 overrides only the fields it names — the
  // restrictive lists concatenate across scopes, `allow` replaces). Absent = `assisted`
  // (`resolveApprovals` in shell-policy.ts).
  approvals: approvalsSchema.optional(),
  // Live tool instances / toolkits in JS configs — kept permissive.
  tools: z.array(z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
  // Predefined (string/object) or custom (object) middleware — permissive.
  middleware: z.array(z.unknown()).optional(),
  streamOutput: z.boolean().optional(),
  writeOutputToFile: z.union([z.boolean(), z.string()]).optional(),
  writeBinaryOutputsToFile: z.boolean().optional(),
  // CFG-30 — rung 3 of the colour ladder (`config/colour.ts`), NOT the final say: `FORCE_COLOR`
  // and `NO_COLOR` outrank it, and when it is absent colour auto-detects from stdout's TTY status.
  // MUST stay `.optional()` — absence is what distinguishes "the user chose true" from the `true`
  // in `defaults.ts`, and the ladder collapses without that. User docs: docs/configuration/output.md
  useColour: z.boolean().optional(),
  // TUI-C37 — rung 2 of the mouse ladder (`config/mouse.ts`). MUST stay `.optional()` for the same
  // reason as `useColour`: absence is what tells "the user chose true" from the `true` in
  // `defaults.ts`, and rung 2 collapses into rung 4 without it.
  useMouse: z.boolean().optional(),
  // CFG-37 — persistent surface preference for the `chat`/`code` sessions: `true` asks for the Ink
  // TUI, `false` for the plain readline session. MUST stay `.optional()` for the same reason as
  // `useColour`/`useMouse`: absence is what distinguishes "the user chose readline" from "nobody
  // said", and the auto-detect rung collapses without it. Ranked BELOW the `--tui`/`--no-tui` flags
  // and the `GTH_NO_TUI` escape hatch, and below the capability gates (no TTY, `TERM=dumb`, `ink`
  // unavailable) which are checks rather than preferences — so `true` degrades to readline instead
  // of forcing a crash. The decision itself is `shouldUseTui` in the app package.
  // User docs: docs/guides/interactive-sessions.md
  tui: z.boolean().optional(),
  streamSessionInferenceLog: z.boolean().optional(),
  canInterruptInferenceWithEsc: z.boolean().optional(),
  debugLog: z.boolean().optional(),
  recursionLimit: z.number().optional(),
  consoleLevel: z.union([z.string(), z.number()]).optional(),
  customTools: customToolsConfigSchema.optional(),
  // EXT-78 — keyed by the server's own name, whose two refused spellings ride on the key schema so
  // the emitted JSON Schema states them too ({@link mcpServerNameSchema}).
  mcpServers: z.record(mcpServerNameSchema, z.unknown()).optional(),
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
  // GS2-35/EXT-83 — identity used in the `Co-Authored-By` trailer of agent-authored git commits.
  // Optional; when omitted the agent is instructed to co-author as the Gaunt Sloth account, whose
  // default NAME carries the resolved active model — `Gaunt Sloth (provider:model)`, falling back
  // to the bare `Gaunt Sloth` when no model resolves or `injectModelContext` is false — at the
  // constant address `code@gauntsloth.app`. A configured name is emitted verbatim. Either field may
  // be set alone; the other falls back to its default (see `appendCommitCoAuthorNote`).
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
  // GS2-34/EXT-83 — inject the resolved active `provider:model` identity into the system prompt
  // (default ON; set `false` to opt out for reproducible / model-agnostic runs). It governs the
  // identity everywhere in the prompt: the identity line in every mode, AND the model name that
  // decorates the default git commit co-author trailer in `code` mode. Defaulted at the read site,
  // so it is intentionally absent from DEFAULT_CONFIG (no effective-config snapshot churn).
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
 * `judge.autoApproveLow` / `judge.blockHigh` have no 1:1 successor (the rung replaced the
 * `low/medium/high` × `destructive` conjunction), so `judge`'s message points at `approvals.mode`
 * and names the outcome scale that took the tiers' place.
 */
const RETIRED_SHELL_TOOL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['yolo', '"approvals": "bypass"'],
  [
    'judge',
    '"approvals": "assisted" (or "auto"), optionally with "approvals.rater" naming an ' +
      'identity profile — the low/medium/high tiers became the ' +
      'safe/destructive/catastrophic/attack outcomes, and autoApproveLow/blockHigh are replaced ' +
      'by the rung you choose',
  ],
  ['allowlist', '"approvals.allow" (a declared list of rule entries)'],
  [
    'persistAllowlist',
    'nothing — persistence is a per-decision choice at the approval prompt (approve forgets, ' +
      'always approve persists)',
  ],
];

/** The `builtInTools` entry the retired approval knobs used to hang off. */
const SHELL_TOOL_REGISTRY_KEY = 'run_shell_command';

/**
 * CFG-27 — keys retired from the `approvals` object itself when the four-tier lattice became one
 * ordered ladder of five rungs. `[retired, "how to say it now"]`.
 *
 * Rejected PRE-PARSE rather than left to the union: `approvalsSchema`'s object arm is a `z.object`,
 * which silently strips unknown keys, so an `approvals: { mode: "assisted", strictness: "strict" }`
 * would otherwise run with its declared posture quietly ignored — the worst possible failure for a
 * safety gate, and exactly what CFG-26 fixed for the per-tool knobs.
 *
 * `strictness` is **deleted, not remapped**: there are no severity thresholds and no independent
 * rater switch, so the message points at the rung that expresses the intent.
 *
 * The retired severity threshold `escalate` is NOT in this table, because EXT-71 gave the name back
 * as the third rule list (§3). A non-array `escalate` — the shape the threshold had — is still
 * caught, with the same message, by {@link RETIRED_ESCALATE_THRESHOLD_MESSAGE}.
 */
const RETIRED_APPROVALS_KEYS: ReadonlyArray<readonly [string, string]> = [
  [
    'strictness',
    'nothing — there are no strictness levels any more. Choose a rung instead: ' +
      '"manual"/"write" never rate, "assisted" escalates anything not rated safe, ' +
      '"auto" lets the auto-rater decide',
  ],
  ['allowlist', '"approvals.allow" (a declared list of rule entries)'],
  [
    'persistAllowlist',
    'nothing — persistence is a per-decision choice at the approval prompt (approve forgets, ' +
      'always approve persists)',
  ],
];

/**
 * EXT-71 — `approvals.escalate` used to be a SEVERITY THRESHOLD (a string), and is now the third
 * rule LIST (an array of §3.1 entries). Only the old shape is an error, so the name could be
 * reused without stranding anyone: a non-array value gets the message that names the rung which
 * expresses the old intent, instead of a bare "expected array, received string".
 */
const RETIRED_ESCALATE_THRESHOLD_MESSAGE =
  'is now the third rule LIST (an array of {type, matcher, pattern} entries that always ask the ' +
  'human), not a severity threshold. There is no escalate threshold any more: "assisted" ' +
  'escalates everything the auto-rater does not rate safe, and "auto" does not stop to ask.';

/**
 * Retired `approvals.mode` VALUES → the rung that replaced them.
 *
 * Caught here rather than by the enum so the error NAMES the rung instead of listing five
 * identifiers and leaving the user to guess which one preserves their intent.
 *
 * **Every mapping is to an equally-permissive rung.** That is the property to preserve when adding
 * an entry: a retired name silently remapped to something MORE permissive would raise a user's
 * autonomy setting on their behalf, at the moment they are least watching — the config already
 * worked, so nothing prompts them to re-read it. `manual`/`assisted`/`auto` are pure renames of
 * `read-only`/`auto-safe`/`full-auto` and carry identical behaviour; `ask` names the two rungs that
 * ask about everything, both at or below what it did.
 *
 * `write` and `bypass` are deliberately ABSENT — they are live rung names, not retired ones.
 *
 * **`auto` is deliberately absent too, and that is a reversal.** It named the pre-2.0
 * rater-mediated mode and used to error here; it is now the canonical name of the most permissive
 * rated rung. Reviving the token is not a back-compat concern (Andrew, 2026-08-07): the value was
 * born during 2.0 alpha work, so no released configuration carries it with the old meaning. This
 * entry and the rename must land together — an `auto` left in this table makes the newly canonical
 * name a hard validation error on arrival.
 */
const RETIRED_APPROVAL_MODES: ReadonlyArray<readonly [string, string]> = [
  ['read-only', '"manual" (the same rung, renamed)'],
  ['auto-safe', '"assisted" (the same rung, renamed)'],
  ['full-auto', '"auto" (the same rung, renamed)'],
  [
    'ask',
    '"write" (Gaunt Sloth edits files freely and asks about everything else) or "manual" ' +
      '(it asks before writing too)',
  ],
];

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
 * CFG-27 — scan one `approvals` value (root or per-command) for the keys and `mode` values the
 * five-rung ladder retired, pushing one issue per occurrence. The scalar form carries no keys, so
 * only the object form can offend — except for a retired `mode` VALUE, which the scalar form can
 * carry directly (`"approvals": "auto"`), so both shapes are checked for that.
 *
 * `pathPrefix` is `approvals` at the root and `commands.<name>.approvals` per command, so the
 * reported path points exactly at the offending key.
 */
function collectRetiredApprovalsIssues(
  approvals: unknown,
  pathPrefix: string,
  issues: DeprecatedConfigIssue[]
): void {
  if (approvals === undefined || approvals === null) return;

  // The scalar sugar form: `"approvals": "auto"`. Only a retired VALUE is an issue here; an
  // unknown string is left to the enum, which lists the five valid rungs.
  if (typeof approvals === 'string') {
    for (const [retired, replacement] of RETIRED_APPROVAL_MODES) {
      if (approvals === retired) {
        issues.push({
          path: pathPrefix,
          message:
            `Approval mode "${retired}" is no longer supported: approvals is now one ordered ` +
            `ladder of five rungs (${APPROVAL_RUNG_LIST}). ` +
            `Use ${replacement} instead. ${MIGRATION_HINT}`,
        });
      }
    }
    return;
  }

  if (typeof approvals !== 'object' || Array.isArray(approvals)) return;
  const block = approvals as Record<string, unknown>;

  for (const [retired, replacement] of RETIRED_APPROVALS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(block, retired)) {
      issues.push({
        path: `${pathPrefix}.${retired}`,
        message:
          `Config property "${retired}" in ${pathPrefix} is no longer supported: approvals is now ` +
          `one ordered ladder of five rungs (${APPROVAL_RUNG_LIST}), ` +
          `and each rung fully determines behaviour. Use ${replacement}. ${MIGRATION_HINT}`,
      });
    }
  }

  // EXT-71 — `escalate` reused for the third rule list; only the retired THRESHOLD shape errors.
  if (block.escalate !== undefined && !Array.isArray(block.escalate)) {
    issues.push({
      path: `${pathPrefix}.escalate`,
      message:
        `Config property "escalate" in ${pathPrefix} ${RETIRED_ESCALATE_THRESHOLD_MESSAGE} ` +
        MIGRATION_HINT,
    });
  }

  // `rater` flattened from an object to a bare identity-profile name.
  const rater = block.rater;
  if (rater !== undefined && typeof rater !== 'string') {
    issues.push({
      path: `${pathPrefix}.rater`,
      message:
        `Config property "rater" in ${pathPrefix} is now a bare identity-profile name, not an ` +
        `object or a boolean (e.g. "rater": "safety-rater"). Whether the rater runs at all is ` +
        `decided by the rung: "assisted" and "auto" rate, the other three never do. ` +
        MIGRATION_HINT,
    });
  }

  for (const [retired, replacement] of RETIRED_APPROVAL_MODES) {
    if (block.mode === retired) {
      issues.push({
        path: `${pathPrefix}.mode`,
        message:
          `Approval mode "${retired}" is no longer supported: approvals is now one ordered ladder ` +
          `of five rungs (${APPROVAL_RUNG_LIST}). Use ${replacement} ` +
          `instead. ${MIGRATION_HINT}`,
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
 *   — each message names the `approvals.*` key that replaced it;
 * - (F, CFG-27) a retired `approvals` key or `mode` value ({@link RETIRED_APPROVALS_KEYS},
 *   {@link RETIRED_APPROVAL_MODES}) at EITHER `approvals.*` or `commands.<cmd>.approvals.*` —
 *   each message names the rung that replaced it.
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

  // (F, CFG-27) Retired approvals keys / mode values in the ROOT approvals value.
  collectRetiredApprovalsIssues(raw.approvals, 'approvals', issues);

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
        // (F, CFG-27) retired approvals keys / mode values in this command's approvals value.
        collectRetiredApprovalsIssues(
          (cmd as Record<string, unknown>).approvals,
          `commands.${name}.approvals`,
          issues
        );
      }
    }
  }

  return issues;
}

/**
 * EXT-70 §4.7.5 — the MCP server name that cannot be written about. A server key is
 * `z.string().min(1)` both under `approvals.mcp.servers` (§9) and on an `mcpTool` entry's `server`
 * field (§3.1), so a server keyed with the empty string is one no approvals rule and no trust
 * relationship can ever refer to by name. Its tools resolve to the unattributable-server sentinel:
 * fail-closed, which is safe, but also silently un-configurable — the user would get a server whose
 * every call is gated with no way to say anything about it and no error explaining why. Refused at
 * load, for the same reason as {@link RESERVED_MCP_SERVER_NAME}: a name whose rules cannot be
 * expressed is worse than a rejected config.
 */
const UNNAMEABLE_MCP_SERVER_NAME = '';

/**
 * EXT-71 §3.1/§9.1 — validate every entry in one `approvals` value's three rule lists (root or per
 * command), pushing one issue per problem with a path that points at the exact entry and field.
 *
 * **Why the entries are checked HERE rather than left to the schema parse**, given that
 * `approvalsSchema` already carries {@link approvalEntrySchema}: the `approvals` value is a union
 * (the §9.1 scalar-or-object sugar), and zod reports a failing union as ONE issue at the union's
 * own path — `approvals: Invalid input` — with every arm's real diagnosis nested out of reach of
 * the formatter. That is exactly the wrong message for this grammar, where the whole requirement is
 * that a rejection names the offending field, key or pattern. Parsing each entry on its own gets
 * the precise issue back, and because this runs BEFORE the parse the precise message is the only
 * one the user sees. The schema keeps the entries too, so it stays the authority and the emitted
 * JSON Schema still describes them.
 *
 * A bare string is handled separately from the rest, because its message is the migration
 * affordance: it renders the entry for the string that was actually found rather than a generic
 * example, since what the user needs is the line they can paste back over the one they wrote.
 */
function collectApprovalEntryIssues(
  approvals: unknown,
  pathPrefix: string,
  issues: DeprecatedConfigIssue[]
): void {
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return;
  const block = approvals as Record<string, unknown>;

  for (const listKey of APPROVAL_LIST_KEYS) {
    const list = block[listKey];
    if (list === undefined) continue;

    // A list written as something other than an array would otherwise fall back to the union's
    // bland "approvals: Invalid input" — the same message this whole function exists to replace.
    // `escalate` is exempt: its non-array shape is the retired severity threshold and gets its own
    // migration message from `collectRetiredApprovalsIssues`.
    if (!Array.isArray(list)) {
      if (listKey !== 'escalate') {
        issues.push({
          path: `${pathPrefix}.${listKey}`,
          message:
            `must be a LIST of rule entries, not ${typeof list === 'object' ? 'an object' : `a ${typeof list}`}. ` +
            `Write it as an array, e.g. [ ${renderApprovalEntryForString('npm test')} ]. ` +
            MIGRATION_HINT,
        });
      }
      continue;
    }

    list.forEach((entry, index) => {
      const entryPath = `${pathPrefix}.${listKey}[${index}]`;

      if (typeof entry === 'string') {
        issues.push({
          path: entryPath,
          message:
            'bare strings are no longer accepted in an approvals rule list. Write the entry ' +
            `explicitly: ${renderApprovalEntryForString(entry)} — type, matcher and pattern are ` +
            `always required, and "matcher" may be exact, glob or regexp. ${MIGRATION_HINT}`,
        });
        return;
      }

      const parsed = approvalEntrySchema.safeParse(entry);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        issues.push({
          path: issue.path.length > 0 ? `${entryPath}.${issue.path.join('.')}` : entryPath,
          message: issue.message,
        });
      }
    });
  }
}

/**
 * EXT-70 §4.7/§9 — validate one `approvals.mcp` block, with a path that names the offending field.
 *
 * It runs PRE-PARSE for the same reason the rule entries do: `approvalsSchema` is a `z.union`, so a
 * bad `mcp` block otherwise collapses into the union's bland "approvals: Invalid input" — the
 * message this whole family of checks exists to replace. Here the user gets the server key, the
 * field and (for a hint name) the value they mistyped.
 */
function collectMcpApprovalsIssues(
  approvals: unknown,
  pathPrefix: string,
  issues: DeprecatedConfigIssue[]
): void {
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return;
  const mcp = (approvals as Record<string, unknown>).mcp;
  if (mcp === undefined) return;

  const parsed = mcpApprovalsSchema.safeParse(mcp);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    issues.push({
      path:
        issue.path.length > 0 ? `${pathPrefix}.mcp.${issue.path.join('.')}` : `${pathPrefix}.mcp`,
      message: issue.message,
    });
  }
}

/**
 * EXT-71 §3.1 — every hard error the rule grammar defines, found on the RAW input: each entry in
 * `allow`/`deny`/`escalate` validated with a path that names the offending field
 * ({@link collectApprovalEntryIssues}), the `approvals.mcp` block ({@link collectMcpApprovalsIssues}),
 * and the two `mcpServers` keys no rule can refer to — `*` ({@link RESERVED_MCP_SERVER_NAME}, which
 * an entry already reads as "every server") and the empty name
 * ({@link UNNAMEABLE_MCP_SERVER_NAME}, which no entry's `server` field can hold). Both need to see
 * `mcpServers`, a sibling of `approvals` rather than a field of it.
 *
 * All of them are HARD errors, reported the same way {@link findDeprecatedConfigIssues} reports
 * its own, and — like it — this runs BEFORE the schema parse so the precise message is the only
 * one the user sees.
 *
 * PURE: it only reads the object. Kept separate from {@link findDeprecatedConfigIssues} because
 * these are not removed pre-2.0 shapes; they are rules of the current grammar.
 */
export function findApprovalsGrammarIssues(raw: Record<string, unknown>): DeprecatedConfigIssue[] {
  const issues: DeprecatedConfigIssue[] = [];

  const mcpServers = raw.mcpServers;
  if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
    if (Object.prototype.hasOwnProperty.call(mcpServers, RESERVED_MCP_SERVER_NAME)) {
      issues.push({
        path: `mcpServers.${RESERVED_MCP_SERVER_NAME}`,
        message:
          `"${RESERVED_MCP_SERVER_NAME}" is a reserved MCP server name: an approvals rule entry ` +
          `uses it to mean EVERY server, so a server of that name would make ` +
          `{ "type": "mcpTool", "server": "${RESERVED_MCP_SERVER_NAME}", ... } ambiguous. ` +
          'Rename the server to anything else. ' +
          MIGRATION_HINT,
      });
    }
    if (Object.prototype.hasOwnProperty.call(mcpServers, UNNAMEABLE_MCP_SERVER_NAME)) {
      issues.push({
        path: 'mcpServers.""',
        message:
          'an MCP server may not be keyed with an empty name: both an approvals rule entry ' +
          '({ "type": "mcpTool", "server": ... }) and a trust relationship under ' +
          '"approvals.mcp.servers" require a server name of at least one character, so nothing ' +
          "could ever be written about this server's tools — every call it makes would be gated " +
          'with no way to say otherwise. Give the server a name. ' +
          MIGRATION_HINT,
      });
    }
  }

  const collect = (approvals: unknown, prefix: string): void => {
    collectApprovalEntryIssues(approvals, prefix, issues);
    collectMcpApprovalsIssues(approvals, prefix, issues);
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

  return issues;
}

/**
 * CFG-26 — one `approvals.rater` reference found in a raw config, with the dotted config path it
 * was found at (`approvals.rater` or `commands.<name>.approvals.rater`).
 */
export interface RaterProfileRef {
  /** Dotted config path of the `rater` key, for the error message. */
  path: string;
  /** The profile name as written. */
  profile: string;
}

/**
 * CFG-26 — collect every `approvals.rater` in a raw config (root + each `commands.<name>`).
 * CFG-27 flattened the key: it is a BARE identity-profile name, not `rater.profile`.
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
    // The scalar sugar form (`"approvals": "assisted"`) carries no rater.
    if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return;
    const rater = (approvals as Record<string, unknown>).rater;
    if (typeof rater === 'string' && rater.trim().length > 0) {
      refs.push({ path: `${prefix}.rater`, profile: rater.trim() });
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
    'Create it with `gth config profile create`, or omit approvals.rater to rate ' +
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

    // EXT-71 — the rule-grammar errors that need to be seen before the schema parse, so the
    // message that explains the fix is the only one the user reads.
    const grammarIssues = findApprovalsGrammarIssues(raw);
    if (grammarIssues.length > 0) {
      return {
        ok: false,
        warnings: [],
        errorMessage: formatDeprecatedConfigIssues(grammarIssues),
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
