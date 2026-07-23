/**
 * @packageDocumentation
 * GS2-58 — systemic Gemini tool-schema sanitizer at the `@langchain/google` provider boundary.
 *
 * Google Gemini's function-declaration schema is a SELECT SUBSET of OpenAPI 3.0. `@langchain/google`'s
 * own `removeAdditionalProperties` strips only `additionalProperties`, so every other JSON-Schema-draft
 * keyword the subset does not declare (`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`, `$defs`,
 * `patternProperties`, `const`, `$ref`, `allOf`/`oneOf`/`not`, …) is passed straight to the wire, and
 * Gemini 400s at tool-declaration send time — before any tool runs.
 *
 * This is the DURABLE fix (GS2-58, fix-cycle 1): rather than a denylist that is always one unknown
 * keyword behind, {@link sanitizeGeminiToolSchema} is an ALLOWLIST — it keeps ONLY the fields the
 * installed Gemini `Schema` type declares and drops everything else, so a future keyword in ANY tool
 * (built-in, custom, or MCP — including schemas gaunt-sloth does not author) cannot re-break Gemini.
 *
 * The allowlist ({@link GEMINI_SUPPORTED_SCHEMA_KEYWORDS}) is derived DIRECTLY from the authoritative
 * in-repo type — the `Gemini.Tools.Schema` interface in
 * `node_modules/@langchain/google/dist/chat_models/api-types.d.{ts,cts}` (a `FunctionDeclaration`'s
 * `parameters?: Schema`), "a select subset of an OpenAPI 3.0 schema object". Keeping it aligned with
 * that type (not a remembered list) is what prevents a stale allowlist silently over-stripping.
 *
 * Scope is the google/gemini provider path ONLY: {@link applyGeminiToolSchemaSanitizer} is wired into
 * the `google-genai` and `vertexai` presets' `processJsonConfig`. It leaves OpenAI/Anthropic/Ollama
 * wiring untouched, and does not weaken the GS2-56/57 build-time denylist guard (that test still runs;
 * this transform runs ahead of the wire send, so a sanitized tool is what Gemini sees).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { isInteropZodSchema } from '@langchain/core/utils/types';
import { isSerializableSchema } from '@langchain/core/utils/standard_schema';

type JsonSchemaObject = Record<string, unknown>;

/**
 * The EXACT set of schema keywords Gemini's function-declaration schema accepts, transcribed field-
 * for-field from the `Gemini.Tools.Schema` interface in
 * `@langchain/google/dist/chat_models/api-types.d.ts`. Anything not in this set is dropped (allowlist).
 *
 * Note `anyOf` IS supported (unions / nullable) and MUST survive — only `allOf`/`oneOf`/`not` are
 * absent from the type and therefore dropped. `exclusiveMinimum`/`exclusiveMaximum` are NOT in the type
 * either; they are handled specially by rewriting them to `minimum`/`maximum` (see {@link sanitizeNode})
 * before the allowlist filter runs.
 */
export const GEMINI_SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'anyOf',
  'default',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'propertyOrdering',
  'required',
  'title',
  'type',
]);

function isPlainObject(value: unknown): value is JsonSchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-clone a literal (JSON-schema data) value so the returned schema never aliases the input. */
function cloneLiteral(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    // Non-cloneable (functions/symbols) never appear in JSON-schema data; keep the reference.
    return value;
  }
}

/** Structural equality by JSON serialisation. Used only for CONSERVATIVE conflict detection during
 * an `allOf` merge: a false "not equal" (e.g. key-order differences) merely makes the merge abort to
 * the safe drop, never produces an unsound merge — so a best-effort compare is sufficient here. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Infer the Gemini `type` for a `const` value when the schema declares none. Numbers map to the
 * general `number` (integer vs number is not "obvious" from a literal); `null` yields no type. */
function inferTypeFromConst(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'object':
      if (value === null) return undefined;
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return undefined;
  }
}

/**
 * Attempt a shallow merge of `node.allOf` (a list of subschemas) into the parent node. Gemini has no
 * `allOf`, so GS2-58 simply drops it — losing any content carried only by the branches. When every
 * branch is a plain-object subschema that merges CLEANLY, we fold it in instead:
 *  - `properties` are unioned (a property name appearing in the parent or two branches with DIFFERENT
 *    schemas is a conflict → abort);
 *  - `required` arrays are unioned;
 *  - any other (scalar) keyword is copied, but a key already set — on the parent or an earlier branch —
 *    to a DIFFERENT value is a conflict → abort.
 * On ANY conflict, or if a branch is not a plain object (e.g. a `$ref`, a boolean subschema), returns
 * `null` so the caller leaves `allOf` in place for the allowlist to drop — the safe GS2-58 behaviour,
 * never a guessed merge. Returns a fresh object (never mutates `node`) with `allOf` removed on success.
 */
function mergeAllOf(node: JsonSchemaObject): JsonSchemaObject | null {
  const branches = node.allOf;
  if (!Array.isArray(branches) || branches.length === 0) return null;
  if (!branches.every(isPlainObject)) return null;

  const acc: JsonSchemaObject = { ...node };
  delete acc.allOf;

  const props: JsonSchemaObject = isPlainObject(acc.properties) ? { ...acc.properties } : {};
  let sawProps = isPlainObject(acc.properties);
  const required = new Set<unknown>(Array.isArray(acc.required) ? acc.required : []);
  let sawRequired = Array.isArray(acc.required);

  for (const branch of branches as JsonSchemaObject[]) {
    for (const [key, value] of Object.entries(branch)) {
      if (key === 'properties') {
        if (!isPlainObject(value)) return null;
        for (const [name, sub] of Object.entries(value)) {
          if (name in props && !jsonEqual(props[name], sub)) return null; // conflicting property
          props[name] = sub;
        }
        sawProps = true;
      } else if (key === 'required') {
        if (Array.isArray(value)) for (const r of value) required.add(r);
        sawRequired = true;
      } else {
        // scalar / other keyword: parent and every branch must agree on it.
        if (key in acc && !jsonEqual(acc[key], value)) return null;
        acc[key] = value;
      }
    }
  }

  if (sawProps) acc.properties = props;
  if (sawRequired) acc.required = [...required];
  return acc;
}

/**
 * Resolve the SAFE structural-composition keywords Gemini rejects into supported equivalents, BEFORE
 * {@link sanitizeNode}'s allowlist drops the rest. Its output feeds the same allowlist + `exclusive*`
 * rewrite pass, so merged-in `properties`/`items`/`anyOf` are still recursed and a merged-in
 * `exclusiveMinimum` is still rewritten. A strict NO-OP (returns the input node) when the node carries
 * none of the handled keywords, so clean schemas pass through byte-identical.
 *
 * Implemented (high-fidelity, no external context needed):
 *  - `const` → `enum: [value]` (+ infer `type` from the value when the node declares none). Gemini has
 *    no `const` but supports `enum`; a single-value `enum` is an exact model of `const`. Presence
 *    (`'const' in node`), not truthiness, so `const: 0 / false / '' / null` resolve too.
 *  - `allOf` of plain-object branches → shallow-merged when clean (see {@link mergeAllOf}); otherwise
 *    left for the allowlist to drop.
 *
 * Deliberately NOT resolved — kept as the safe GS2-58 drop (see the GS2-68 characterization tests):
 *  - `oneOf` / `not`: `oneOf` is XOR, semantically distinct from `anyOf`'s OR, so remapping it would
 *    silently change a tool's contract; `not` has no Gemini equivalent. Both are dropped.
 *  - `$ref` / `$defs` / `definitions`: inlining a same-document `$ref` is only sound when fully self-
 *    contained AND cycle-guarded, and is NEAR-ZERO in practice — `@langchain/mcp-adapters` dereferences
 *    `$ref` and merges `allOf` UPSTREAM before tools reach this boundary, and gaunt-sloth's own zod
 *    tools inline+type their schemas. No live path authors a bare `$ref` here, so this is DEFERRED
 *    (GS2-68): a `$ref`-only property still sanitizes to a typeless `{}` — non-400 and callable, just
 *    without type fidelity. A raw non-adapter tool that needs it should dereference upstream, not here.
 */
function resolveComposition(node: JsonSchemaObject): JsonSchemaObject {
  let out = node;

  if ('const' in node && !('enum' in node)) {
    if (out === node) out = { ...node };
    out.enum = [cloneLiteral(node.const)];
    if (!('type' in out)) {
      const inferred = inferTypeFromConst(node.const);
      if (inferred) out.type = inferred;
    }
  }

  if (Array.isArray((out === node ? node : out).allOf)) {
    const merged = mergeAllOf(out === node ? node : out);
    if (merged) out = merged;
    // else: leave `allOf` in place → the allowlist drops it (safe GS2-58 behaviour).
  }

  return out;
}

/**
 * Recursively normalise one schema node to Gemini's supported subset:
 *  - rewrite `exclusiveMinimum`→`minimum` / `exclusiveMaximum`→`maximum` (Gemini has no exclusive
 *    bound), keeping the TIGHTER bound when an inclusive one is also present;
 *  - keep ONLY {@link GEMINI_SUPPORTED_SCHEMA_KEYWORDS}; drop everything else;
 *  - recurse ONLY through real subschema positions — `properties` (map), `items` (schema or tuple),
 *    and `anyOf` (array of schemas). Literal-data positions (`enum`, `default`, `example`, `required`,
 *    `propertyOrdering`) are copied verbatim, so a keyword that merely appears as DATA is untouched.
 */
function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeNode);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  // Resolve the safe composition keywords (const → enum, clean allOf → shallow merge) BEFORE the
  // allowlist drop, so their content survives; the allowlist below then still guarantees no
  // unsupported keyword escapes. `resolved` is `node` itself when nothing needed resolving.
  const resolved = resolveComposition(node);

  const out: JsonSchemaObject = {};
  for (const [key, value] of Object.entries(resolved)) {
    // Allowlist: silently drop any keyword Gemini's Schema type does not declare (this is where
    // $defs / definitions / patternProperties / const / multipleOf / $ref / allOf / oneOf / not /
    // additionalProperties / $schema / exclusive* are removed).
    if (!GEMINI_SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      const mapped: JsonSchemaObject = {};
      for (const [name, sub] of Object.entries(value)) {
        mapped[name] = sanitizeNode(sub);
      }
      out[key] = mapped;
    } else if (key === 'items') {
      out[key] = Array.isArray(value) ? value.map(sanitizeNode) : sanitizeNode(value);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out[key] = value.map(sanitizeNode);
    } else {
      // Supported scalar / literal-data keyword (type, enum, required, description, default, …).
      out[key] = cloneLiteral(value);
    }
  }

  // exclusive* → inclusive of the SAME value. Gemini has no exclusive bound; args are hints, so the
  // loosening is accepted. When both an exclusive and an inclusive bound are present, keep the TIGHTER
  // one (higher lower-bound / lower upper-bound) rather than letting the exclusive value clobber it.
  // Read from `resolved` so a bound merged in from an `allOf` branch is rewritten too.
  const exclusiveMinimum = resolved.exclusiveMinimum;
  if (typeof exclusiveMinimum === 'number') {
    out.minimum =
      typeof out.minimum === 'number' ? Math.max(out.minimum, exclusiveMinimum) : exclusiveMinimum;
  }
  const exclusiveMaximum = resolved.exclusiveMaximum;
  if (typeof exclusiveMaximum === 'number') {
    out.maximum =
      typeof out.maximum === 'number' ? Math.min(out.maximum, exclusiveMaximum) : exclusiveMaximum;
  }

  return out;
}

/**
 * Pure, recursive normaliser: returns a cleaned DEEP COPY of a JSON-Schema containing only keywords
 * Gemini's function-declaration `Schema` accepts, so its OpenAPI-3.0 subset accepts the tool. At each
 * node the SAFE composition keywords are first RESOLVED into supported equivalents
 * ({@link resolveComposition}: `const` → `enum`, clean `allOf` → shallow merge) and only then does the
 * allowlist drop the rest. Does not mutate the input. `anyOf` unions survive; `$ref`/`oneOf`/`not` are
 * dropped (see {@link resolveComposition} for why the last three are deferred, not resolved).
 */
export function sanitizeGeminiToolSchema<T = unknown>(schema: T): T {
  return sanitizeNode(schema) as T;
}

/**
 * The SINGLE normalization pass. Converts a schema to JSON (zod → JSON via the same `@langchain/core`
 * converter `@langchain/google` uses internally) and runs the allowlist. Every tool-shape branch in
 * {@link sanitizeToolForGemini} routes its schema(s) through here — so no branch can filter
 * inconsistently, and a future tool format is covered the moment it calls this.
 */
function normalizeSchema(rawSchema: unknown): unknown {
  const jsonSchema =
    isInteropZodSchema(rawSchema) || isSerializableSchema(rawSchema)
      ? toJsonSchema(rawSchema as Parameters<typeof toJsonSchema>[0])
      : rawSchema;
  return sanitizeGeminiToolSchema(jsonSchema);
}

/** Build a shallow copy of a tool that preserves its prototype (so it stays a recognisable
 * LangChain tool) while overriding one own property (its schema) with the normalized value. */
function cloneWithOverride(source: object, key: string, value: unknown): unknown {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(source)) as object, source);
  Object.defineProperty(clone, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return clone;
}

/**
 * Normalise one tool's argument schema for Gemini. Handles the three shapes that reach a ChatGoogle
 * model's `bindTools`: a LangChain structured tool (`.schema`, zod or JSON), an OpenAI-format tool
 * (`.function.parameters`), and a Gemini-native `functionDeclarations` tool. Every schema position in
 * every branch is passed through the SINGLE {@link normalizeSchema} pass; anything else is untouched.
 */
function sanitizeToolForGemini(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') {
    return tool;
  }
  const record = tool as Record<string, unknown>;

  // LangChain structured tool / StructuredToolParams — its arg schema is `.schema` (zod or JSON).
  if ('schema' in record && record.schema != null) {
    return cloneWithOverride(tool, 'schema', normalizeSchema(record.schema));
  }

  // OpenAI-format tool: { type: 'function', function: { parameters } }.
  const fn = record.function;
  if (fn && typeof fn === 'object' && 'parameters' in (fn as Record<string, unknown>)) {
    const fnRecord = fn as Record<string, unknown>;
    return {
      ...record,
      function: { ...fnRecord, parameters: normalizeSchema(fnRecord.parameters) },
    };
  }

  // Gemini-native tool: { functionDeclarations: [{ parameters }, …] }.
  if (Array.isArray(record.functionDeclarations)) {
    return {
      ...record,
      functionDeclarations: (record.functionDeclarations as unknown[]).map((decl) => {
        if (decl && typeof decl === 'object' && 'parameters' in (decl as Record<string, unknown>)) {
          const declRecord = decl as Record<string, unknown>;
          return { ...declRecord, parameters: normalizeSchema(declRecord.parameters) };
        }
        return decl;
      }),
    };
  }

  return tool;
}

type BindToolsFn = (tools: unknown[], kwargs?: unknown) => unknown;

/**
 * Wire the sanitizer into a ChatGoogle model at the tool-binding boundary. Overrides the instance's
 * `bindTools` so every tool passed to it — built-in, custom, or MCP, via `createAgent`/`createDeepAgent`
 * which both call `model.bindTools(tools)` — is sanitized before it reaches `@langchain/google`'s
 * Gemini converter. Provider-scoped: only the google-genai/vertexai presets call this, so no other
 * provider's tools are affected. Returns the same model instance for convenient chaining.
 */
export function applyGeminiToolSchemaSanitizer<T extends BaseChatModel>(model: T): T {
  const holder = model as unknown as { bindTools?: BindToolsFn };
  const original = holder.bindTools;
  if (typeof original !== 'function') {
    return model;
  }
  const bound = original.bind(model) as BindToolsFn;
  holder.bindTools = function sanitizedBindTools(tools: unknown[], kwargs?: unknown) {
    const nextTools = Array.isArray(tools) ? tools.map(sanitizeToolForGemini) : tools;
    return bound(nextTools as unknown[], kwargs);
  };
  return model;
}
