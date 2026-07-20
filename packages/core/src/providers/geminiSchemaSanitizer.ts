/**
 * @packageDocumentation
 * GS2-58 — systemic Gemini tool-schema sanitizer at the `@langchain/google` provider boundary.
 *
 * Google Gemini's function-declaration schema is an OpenAPI-3.0 subset. `@langchain/google`'s
 * own `removeAdditionalProperties` strips only `additionalProperties`, so every other
 * JSON-Schema-draft keyword the subset rejects (`exclusiveMinimum`/`exclusiveMaximum`/
 * `multipleOf`, and combinators like `const`/`$ref`/`allOf`/`oneOf`/`not`) is passed straight to
 * the wire, and Gemini 400s at tool-declaration send time — before any tool runs.
 *
 * GS2-56/57 fixed the one offending built-in tool (`gth_grep`'s `.positive()` → `exclusiveMinimum`)
 * and added a build-time denylist regression guard over the built-in toolset. That guard is a test,
 * not a runtime transform, and covers only tools gaunt-sloth authors. This module is the general,
 * durable fix: {@link sanitizeGeminiToolSchema} normalises the JSON-Schema of EVERY tool reaching a
 * ChatGoogle model — built-in, custom (`GthCustomToolkit`), and MCP (whose schemas gaunt-sloth does
 * not author) — so a future `.positive()`/`.gt()`/`.multipleOf()` in ANY tool cannot re-break Gemini.
 *
 * Scope is the google/gemini provider path ONLY: {@link applyGeminiToolSchemaSanitizer} is wired into
 * the `google-genai` and `vertexai` presets' `processJsonConfig`, where the `@langchain/google` model
 * is constructed. It leaves the OpenAI/Anthropic/Ollama provider wiring untouched, and it does not
 * weaken the GS2-56/57 denylist guard (that test still runs; this transform runs ahead of the wire
 * send, so a sanitized tool is what Gemini sees).
 */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { isInteropZodSchema } from '@langchain/core/utils/types';
import { isSerializableSchema } from '@langchain/core/utils/standard_schema';

type JsonSchemaObject = Record<string, unknown>;

/**
 * Draft keywords Gemini's OpenAPI-3.0 subset rejects outright — dropped from every schema node.
 * `additionalProperties`/`$schema` are (also) handled by `@langchain/google` upstream; dropping them
 * again is harmless. `const`/`$ref`/`allOf`/`oneOf`/`not` are unsupported combinators; stripping them
 * loosens the schema to a Gemini-accepted shape (these are argument hints, not validation).
 */
const STRIP_KEYWORDS: ReadonlySet<string> = new Set([
  'multipleOf',
  'const',
  '$ref',
  'allOf',
  'oneOf',
  'not',
  '$schema',
  'additionalProperties',
]);

/** Keys whose value is a MAP of `{ name -> subschema }` — recurse into each value. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
]);

/**
 * Keys whose value is a subschema, or an array of subschemas (tuple `items`, `anyOf`, …) — recurse
 * into the value / each element. Deliberately EXCLUDES literal-data positions (`enum`, `default`,
 * `examples`, `required`, `type`, `description`, …) so a keyword that merely appears as data inside
 * one of those is preserved verbatim rather than rewritten.
 */
const SCHEMA_OR_SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalItems',
  'prefixItems',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'anyOf',
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

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeNode);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  const out: JsonSchemaObject = {};
  let exclusiveMinimum: unknown;
  let exclusiveMaximum: unknown;
  let hasExclusiveMinimum = false;
  let hasExclusiveMaximum = false;

  for (const [key, value] of Object.entries(node)) {
    if (STRIP_KEYWORDS.has(key)) {
      continue;
    }
    if (key === 'exclusiveMinimum') {
      exclusiveMinimum = value;
      hasExclusiveMinimum = true;
      continue;
    }
    if (key === 'exclusiveMaximum') {
      exclusiveMaximum = value;
      hasExclusiveMaximum = true;
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      const mapped: JsonSchemaObject = {};
      for (const [name, sub] of Object.entries(value)) {
        mapped[name] = sanitizeNode(sub);
      }
      out[key] = mapped;
      continue;
    }
    if (SCHEMA_OR_SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value) ? value.map(sanitizeNode) : sanitizeNode(value);
      continue;
    }
    // Literal / scalar keyword (type, enum, required, description, default, format, …): keep verbatim.
    out[key] = cloneLiteral(value);
  }

  // Exclusive bounds → inclusive bounds of the SAME value. Gemini has no exclusive bound; this is the
  // node's explicit accepted loosening. Exclusive wins over any inclusive bound already present, since
  // `x > e` combined with `x >= m` is `x > e` for `e >= m`, i.e. tighter — rewriting to `minimum: e`.
  if (hasExclusiveMinimum) {
    out.minimum = cloneLiteral(exclusiveMinimum);
  }
  if (hasExclusiveMaximum) {
    out.maximum = cloneLiteral(exclusiveMaximum);
  }

  return out;
}

/**
 * Pure, recursive normaliser: returns a cleaned DEEP COPY of a JSON-Schema so Gemini's OpenAPI-3.0
 * subset accepts it. Does not mutate the input. Applied through every nested schema position
 * (object `properties`/`patternProperties`, `items`/`prefixItems`/`contains`, `$defs`/`definitions`,
 * and `anyOf`), while literal-data positions (`enum`, `default`, `required`, …) are copied verbatim.
 *
 * Transform:
 *  - `exclusiveMinimum` → `minimum` (same value); `exclusiveMaximum` → `maximum` (same value).
 *  - `multipleOf` → dropped.
 *  - `const`, `$ref`, `allOf`, `oneOf`, `not`, `$schema`, `additionalProperties` → dropped.
 *  - Everything else — the supported core (`type`, `properties`, `items`, `required`, `enum`,
 *    `description`, `format`, `minimum`, `maximum`, `minItems`/`maxItems`, `nullable`, …) — is kept.
 */
export function sanitizeGeminiToolSchema<T = unknown>(schema: T): T {
  return sanitizeNode(schema) as T;
}

/** Build a shallow copy of a tool that preserves its prototype (so it stays a recognisable
 * LangChain tool) while overriding one own property (its schema) with the sanitized value. */
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
 * (`.function.parameters`), and a Gemini-native `functionDeclarations` tool. Anything else is passed
 * through untouched. Zod schemas are converted to JSON with the SAME converter `@langchain/google`
 * uses internally, so downstream conversion sees an already-clean schema.
 */
function sanitizeToolForGemini(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') {
    return tool;
  }
  const record = tool as Record<string, unknown>;

  // LangChain structured tool / StructuredToolParams — its arg schema is `.schema` (zod or JSON).
  if ('schema' in record && record.schema != null) {
    const rawSchema = record.schema;
    const jsonSchema =
      isInteropZodSchema(rawSchema) || isSerializableSchema(rawSchema)
        ? toJsonSchema(rawSchema as Parameters<typeof toJsonSchema>[0])
        : rawSchema;
    const cleaned = sanitizeGeminiToolSchema(jsonSchema);
    return cloneWithOverride(tool, 'schema', cleaned);
  }

  // OpenAI-format tool: { type: 'function', function: { parameters } }.
  const fn = record.function;
  if (fn && typeof fn === 'object' && 'parameters' in (fn as Record<string, unknown>)) {
    const fnRecord = fn as Record<string, unknown>;
    return {
      ...record,
      function: { ...fnRecord, parameters: sanitizeGeminiToolSchema(fnRecord.parameters) },
    };
  }

  // Gemini-native tool: { functionDeclarations: [{ parameters }, …] }.
  if (Array.isArray(record.functionDeclarations)) {
    return {
      ...record,
      functionDeclarations: (record.functionDeclarations as unknown[]).map((decl) => {
        if (decl && typeof decl === 'object' && 'parameters' in (decl as Record<string, unknown>)) {
          const declRecord = decl as Record<string, unknown>;
          return { ...declRecord, parameters: sanitizeGeminiToolSchema(declRecord.parameters) };
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
