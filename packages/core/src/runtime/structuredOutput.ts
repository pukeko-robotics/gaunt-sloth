/**
 * @module runtime/structuredOutput
 *
 * EXT-88 — the **`withStructuredOutput` boundary**. Every `withStructuredOutput` call in this
 * project goes through {@link structuredOutputBoundary}: `rateShellCommand` (the approvals rater),
 * {@link askStructured} (arbitrary caller schemas, including `gth workflow` scripts) and
 * `@gaunt-sloth/batch`'s eval judge. Review's rating step is deliberately not one of them — it
 * reaches its schema through a bound TOOL, which is a different path with different rules.
 *
 * ## The problem it exists to solve
 *
 * A single Zod object normally does two jobs at once — it is converted into the JSON Schema the
 * provider is sent, and it validates the answer that comes back. Those two jobs want **opposite**
 * things from an optional field, and Zod has only one knob for both:
 *
 * - **On the wire**, OpenAI's strict `json_schema` rule is *"`required` must be supplied and must
 *   include every key in `properties`"*. A `.optional()` field is left out of `required`, and the
 *   OpenAI API rejects the whole request with `400 Invalid schema for response_format`. Optionality
 *   there is spelled as a **nullable type on a required key**, not as an absent key.
 * - **On the way back**, providers do not agree. Some (ChatGroq) rewrite the schema themselves so
 *   every property is required-and-nullable, and their models answer `null`. Others (Anthropic,
 *   Google GenAI, Ollama) leave the field genuinely optional and their models may simply omit it.
 *   Zod's `.optional()` admits `undefined` and **not** `null`, so the first group's answer is
 *   rejected by the very schema that asked for it — and the caller sees a parse failure that looks
 *   like a bad model rather than a self-contradicting request.
 *
 * ## The shape that satisfies both
 *
 * For every field the caller declared `.optional()`, the boundary sends
 * `inner.nullable().prefault(null)` instead. That one node is the wire/validation twin:
 *
 * - **Wire** — `prefault` does not change the parsed *output* type, so the key lands in `required`
 *   and its type is `["string","null"]` / `anyOf: [T, null]`. Strict mode is satisfied, and the
 *   model is given a legal way to say "nothing here". Unlike `.default()`, `prefault` emits **no
 *   `default` keyword** into the JSON Schema, so nothing extra is added to what the provider sees.
 * - **Validation** — the same node accepts the value, accepts `null`, and accepts the key being
 *   **missing** (which is what `prefault` supplies the `null` for). All three arms are needed: the
 *   third is what keeps the providers that do *not* hoist working.
 *
 * The `null` never escapes: {@link StructuredOutputBoundary.safeParse} strips it back to the key
 * being **absent** and then validates with the caller's **original** schema, so the parsed type is
 * exactly what the caller declared — an optional string stays `string | undefined` and never
 * becomes `string | null | undefined`.
 *
 * ## Two properties that must not be lost in a "simplification"
 *
 * - **Every `.describe()` survives into the emitted JSON Schema.** The descriptions are the only
 *   place the model is told what the fields mean. Expressing the null-to-absent step with
 *   `.transform()` on the field is the obvious-looking alternative and it costs the field its
 *   description — worse, the conversion OpenAI's path uses refuses to represent a transform at all.
 *   Normalization therefore happens in **code**, after the parse, never in the schema.
 * - **A genuinely malformed answer still fails.** This boundary removes a *false* parse failure; it
 *   is not a blanket "accept anything". A wrong type in an optional field is still rejected, because
 *   the final validation is the caller's own untouched schema. In particular `.catch()` must not be
 *   used to express any of this — it would swallow real failures.
 *
 * ## Coverage, and the deliberate limits
 *
 * The rewrite descends through objects, arrays, tuples, records and the single-child wrappers
 * (`nullable`, `readonly`, `default`, `prefault`, `nonoptional`), so an optional nested inside an
 * object inside an array is handled.
 *
 * It deliberately stops at **unions** (including discriminated unions), **intersections**, `lazy`,
 * `map`, `set`, `pipe`/`transform` and `custom`, leaving those subtrees exactly as the caller wrote
 * them, and it leaves a **recursive** schema alone in its entirety. The reason is one rule: the
 * rewrite and the normalization must cover **precisely the same set**. At a union the incoming value
 * gives no reliable answer to *which branch was taken*, so a `null` could not be stripped back out;
 * rewriting there while being unable to normalize would manufacture the very parse failure this
 * module removes. Recursion is refused for the neighbouring reason — a rewrite that stopped at the
 * cycle would make a key required at one depth and optional at the next, which satisfies no
 * provider's strict rule and is harder to reason about than the caller's own schema.
 *
 * An optional inside one of those constructs keeps today's behaviour — correct everywhere it is
 * correct today, and still rejected by OpenAI's strict rule, which is a visible error rather than a
 * silent one.
 */

import * as z from 'zod';

/** Any schema node the walker may meet. Shapes are unknown by construction here. */
type AnySchema = z.ZodType<unknown, unknown>;

/**
 * A normalizer's answer for "this key must not be present at all" — distinct from `undefined`,
 * because an object key explicitly set to `undefined` is still an own property and `Object.hasOwn`
 * would report it. Callers must not have to learn a second spelling of "absent".
 */
const ABSENT = Symbol('structured-output-absent');

/** Maps one parsed value to its normalized form, or {@link ABSENT} to have the key removed. */
type Normalizer = (value: unknown) => unknown;

/**
 * One node's rewrite. `normalize` is `undefined` when nothing at or below this node needs any
 * normalization, which is what lets an unaffected subtree be returned **by identity** — see
 * {@link structuredOutputBoundary}.
 */
interface WalkResult {
  schema: AnySchema;
  normalize?: Normalizer;
}

/** The internal Zod definition fields this module reads, narrowed to the ones it understands. */
interface SchemaDef {
  type: string;
  innerType?: AnySchema;
  shape?: Record<string, AnySchema>;
  element?: AnySchema;
  items?: AnySchema[];
  rest?: AnySchema | null;
  valueType?: AnySchema;
}

function defOf(schema: AnySchema): SchemaDef {
  return (schema as unknown as { _zod: { def: SchemaDef } })._zod.def;
}

/**
 * Rebuild `schema` with part of its definition replaced, keeping everything else — the checks
 * (`minItems`, `minimum`, …) and the registered `.describe()` metadata. Built from Zod's own clone
 * rather than by calling `z.object(...)` / `z.array(...)` afresh, because re-constructing would
 * silently drop those constraints from the schema the provider is sent.
 *
 * The metadata is copied through the registry rather than by cloning with Zod's `parent` option.
 * A parent link is how Zod represents "the same schema, re-described", and its JSON-Schema emitter
 * honours that by emitting a **`$ref` to the parent** with the differences as sibling keys. For a
 * rewritten object that is actively wrong: the `$ref` would point at a definition still carrying the
 * ORIGINAL `required` list — the one missing exactly the optional key this module exists to hoist —
 * and `$ref`-with-siblings is not accepted by every provider's strict mode. Copying the metadata
 * leaves the clone an independent schema, which is what it actually is.
 */
function cloneWith(schema: AnySchema, patch: Partial<SchemaDef>): AnySchema {
  const next = { ...defOf(schema), ...patch };
  const cloned = z.core.clone(
    schema as unknown as z.core.$ZodType,
    next as unknown as z.core.$ZodType['_zod']['def']
  ) as unknown as AnySchema;
  const meta = z.globalRegistry.get(schema);
  if (meta) z.globalRegistry.add(cloned, meta);
  return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `.optional()` → `inner.nullable().prefault(null)`, plus the normalizer that puts it back.
 *
 * The description is re-stated on the nullable wrapper so it lands at **field level** in the emitted
 * JSON Schema whichever way the caller spelled it (`z.string().describe(D).optional()` carries it on
 * the inner type, `z.string().optional().describe(D)` on the wrapper).
 *
 * `null` is only stripped where the caller's own declaration gives it no meaning. A field written
 * `z.string().nullable().optional()` asked for `null` to be a value in its own right, so it keeps
 * it; only a plain `.optional()`, for which `null` was never a legal answer and can only have come
 * from the required-and-nullable rewrite, collapses to the key being absent.
 */
function walkOptional(schema: AnySchema, def: SchemaDef): WalkResult {
  const inner = def.innerType as AnySchema;
  const innerWalk = walk(inner);
  const description = schema.description ?? inner.description;
  const nullIsMeaningful = inner.safeParse(null).success;

  // A field that already admits `null` needs no second nullable wrapper — one would emit a nested
  // `anyOf` inside an `anyOf` that says nothing the inner one does not.
  let nullable = nullIsMeaningful ? innerWalk.schema : (innerWalk.schema.nullable() as AnySchema);
  if (description !== undefined) nullable = nullable.describe(description);
  const wireSchema = (nullable as z.ZodType<unknown, unknown>).prefault(null) as AnySchema;

  const innerNormalize = innerWalk.normalize;
  const normalize: Normalizer = (value) => {
    if (value === undefined) return ABSENT;
    if (value === null) return nullIsMeaningful ? null : ABSENT;
    return innerNormalize ? innerNormalize(value) : value;
  };
  return { schema: wireSchema, normalize };
}

function walkObject(schema: AnySchema, def: SchemaDef): WalkResult {
  const shape = def.shape ?? {};
  const nextShape: Record<string, AnySchema> = {};
  const normalizers: [string, Normalizer][] = [];
  let changed = false;

  for (const [key, field] of Object.entries(shape)) {
    const result = walk(field);
    nextShape[key] = result.schema;
    if (result.schema !== field) changed = true;
    if (result.normalize) normalizers.push([key, result.normalize]);
  }
  if (!changed && normalizers.length === 0) return { schema };

  const normalize: Normalizer = (value) => {
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = { ...value };
    for (const [key, normalizeField] of normalizers) {
      if (!Object.hasOwn(out, key)) continue;
      const normalized = normalizeField(out[key]);
      if (normalized === ABSENT) delete out[key];
      else out[key] = normalized;
    }
    return out;
  };
  return { schema: changed ? cloneWith(schema, { shape: nextShape }) : schema, normalize };
}

function walkArray(schema: AnySchema, def: SchemaDef): WalkResult {
  const element = def.element as AnySchema;
  const result = walk(element);
  if (result.schema === element && !result.normalize) return { schema };

  const normalizeElement = result.normalize;
  const normalize: Normalizer | undefined = normalizeElement
    ? (value) => {
        if (!Array.isArray(value)) return value;
        return value.map((item) => {
          const normalized = normalizeElement(item);
          // An element position has no key to remove, so "absent" degrades to `undefined` — which
          // is what an optional element schema accepts anyway.
          return normalized === ABSENT ? undefined : normalized;
        });
      }
    : undefined;
  return {
    schema: result.schema === element ? schema : cloneWith(schema, { element: result.schema }),
    normalize,
  };
}

function walkTuple(schema: AnySchema, def: SchemaDef): WalkResult {
  const items = def.items ?? [];
  const rest = def.rest ?? null;
  const itemResults = items.map((item) => walk(item));
  const restResult = rest ? walk(rest) : undefined;

  const changed =
    itemResults.some((result, index) => result.schema !== items[index]) ||
    (restResult !== undefined && rest !== null && restResult.schema !== rest);
  const needsNormalize =
    itemResults.some((result) => result.normalize) || restResult?.normalize !== undefined;
  if (!changed && !needsNormalize) return { schema };

  const normalize: Normalizer | undefined = needsNormalize
    ? (value) => {
        if (!Array.isArray(value)) return value;
        return value.map((item, index) => {
          // Gate on POSITION: a prefix item is normalized by its own item schema and never by the
          // rest schema, which describes a different position entirely.
          const normalizeItem =
            index < items.length ? itemResults[index]?.normalize : restResult?.normalize;
          if (!normalizeItem) return item;
          const normalized = normalizeItem(item);
          return normalized === ABSENT ? undefined : normalized;
        });
      }
    : undefined;
  return {
    schema: changed
      ? cloneWith(schema, {
          items: itemResults.map((result) => result.schema),
          rest: restResult ? restResult.schema : rest,
        })
      : schema,
    normalize,
  };
}

function walkRecord(schema: AnySchema, def: SchemaDef): WalkResult {
  const valueType = def.valueType as AnySchema;
  const result = walk(valueType);
  if (result.schema === valueType && !result.normalize) return { schema };

  const normalizeValue = result.normalize;
  const normalize: Normalizer | undefined = normalizeValue
    ? (value) => {
        if (!isRecord(value)) return value;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          const normalized = normalizeValue(item);
          if (normalized !== ABSENT) out[key] = normalized;
        }
        return out;
      }
    : undefined;
  return {
    schema: result.schema === valueType ? schema : cloneWith(schema, { valueType: result.schema }),
    normalize,
  };
}

/**
 * The single-child wrappers: `nullable`, `readonly`, `default`, `prefault`, `nonoptional`.
 *
 * A wrapper is **transparent to optionality**. `z.string().optional().default('foo')` is still sent
 * as a required key typed `anyOf: [T, null]`, so a `null` arriving here is the wire's "nothing here"
 * and must reach the inner normalizer that knows how to remove it. Passing every `null` straight
 * through instead would advertise `null` to the provider and then reject the one it sends — the same
 * self-contradiction this module exists to remove, one wrapper deep. What "absent" then means is the
 * caller's own business, because the final validation is the caller's untouched schema: under
 * `.default('foo')` it resolves to `'foo'`, under `.readonly()` the key simply stays absent.
 *
 * The exception is a wrapper that makes `null` a value in its own right — the caller wrote
 * `.nullable()` **outside** the optional. That is the question {@link walkOptional} asks of its own
 * inner type, asked one level up, and it is what keeps the two spellings of nullable-and-optional
 * from disagreeing about the same field.
 *
 * `undefined` is passed through rather than being given a second meaning here: the wire never
 * produces one (`prefault` supplies `null` for a missing key), and a genuinely missing object key
 * never reaches a field normalizer at all — {@link walkObject} skips it.
 */
function walkWrapper(schema: AnySchema, def: SchemaDef): WalkResult {
  const inner = def.innerType as AnySchema;
  const result = walk(inner);
  if (result.schema === inner && !result.normalize) return { schema };

  const innerNormalize = result.normalize;
  const nullIsMeaningful = innerNormalize !== undefined && schema.safeParse(null).success;
  const normalize: Normalizer | undefined = innerNormalize
    ? (value) => {
        if (value === undefined) return value;
        if (value === null && nullIsMeaningful) return null;
        return innerNormalize(value);
      }
    : undefined;
  return {
    schema: result.schema === inner ? schema : cloneWith(schema, { innerType: result.schema }),
    normalize,
  };
}

/**
 * Thrown when the walk re-enters a schema it is already inside, i.e. the caller's schema is
 * recursive. Caught in {@link structuredOutputBoundary}, which then leaves the whole schema alone —
 * see the module doc's limits.
 */
const CYCLIC = Symbol('structured-output-cyclic');

/** The schemas the current walk is inside. A node reached twice on one path is a cycle. */
const inProgress = new WeakSet<object>();

/**
 * Rewrite one node. Every branch here has a matching arm in the normalizer it returns — the two
 * halves are produced by the **same** walk precisely so their coverage cannot drift apart. Anything
 * not listed is returned untouched, with no normalizer.
 *
 * A **recursive** schema aborts the whole walk rather than being partly rewritten. Zod spells
 * recursion as a getter in an object's shape, which reads as an ordinary `object` here and would
 * otherwise descend for ever. Rewriting only the levels reached before the cycle would put an
 * optional key in `required` at one depth and leave it out at the next — an inconsistency that
 * satisfies no provider's strict rule while making the emitted schema harder to reason about than
 * the caller's own.
 */
function walk(schema: AnySchema): WalkResult {
  if (inProgress.has(schema)) throw CYCLIC;
  inProgress.add(schema);
  try {
    return walkNode(schema);
  } finally {
    inProgress.delete(schema);
  }
}

function walkNode(schema: AnySchema): WalkResult {
  const def = defOf(schema);
  switch (def.type) {
    case 'optional':
      return walkOptional(schema, def);
    case 'object':
      return walkObject(schema, def);
    case 'array':
      return walkArray(schema, def);
    case 'tuple':
      return walkTuple(schema, def);
    case 'record':
      return walkRecord(schema, def);
    case 'nullable':
    case 'readonly':
    case 'default':
    case 'prefault':
    case 'nonoptional':
      return walkWrapper(schema, def);
    default:
      return { schema };
  }
}

/**
 * The two halves of one structured-output call: what to send, and how to read the answer.
 *
 * @typeParam T The caller's own parsed type — unchanged by the boundary.
 */
export interface StructuredOutputBoundary<T> {
  /**
   * The schema to hand to `model.withStructuredOutput(...)`. Identical (by reference) to the
   * caller's schema when it contains no optional field, so a schema that never had the problem is
   * sent byte-for-byte as it is today.
   */
  wireSchema: z.ZodType<Record<string, unknown>>;
  /**
   * Validate a model answer: normalize every `null` that stands for "no value" back to the key being
   * absent, then validate with the caller's **original** schema. Never throws — a malformed answer
   * comes back as `success: false`, exactly as `schema.safeParse` would.
   */
  safeParse(raw: unknown): z.ZodSafeParseResult<T>;
}

/**
 * Memoized per schema instance. Repeated calls with the same schema — the common case, since call
 * sites hold a module-level schema constant — return the same `wireSchema` reference, which is what
 * LangChain's own JSON-Schema conversion cache is keyed on.
 */
const boundaries = new WeakMap<object, StructuredOutputBoundary<unknown>>();

/**
 * Build the {@link StructuredOutputBoundary} for a schema — the one entry point every
 * `withStructuredOutput` call in this project goes through. See the module doc for what it does and
 * why.
 *
 * @param schema The caller's schema, used unchanged for the final validation.
 */
export function structuredOutputBoundary<T>(schema: z.ZodType<T>): StructuredOutputBoundary<T> {
  const cached = boundaries.get(schema);
  if (cached) return cached as StructuredOutputBoundary<T>;

  let walked: WalkResult;
  try {
    walked = walk(schema as unknown as AnySchema);
  } catch (error) {
    // A recursive schema is left exactly as the caller wrote it — the same answer this module gives
    // for a union, and for the same reason: it will not rewrite what it cannot also normalize.
    if (error !== CYCLIC) throw error;
    walked = { schema: schema as unknown as AnySchema };
  }
  const normalize = walked.normalize;
  const boundary: StructuredOutputBoundary<T> = {
    wireSchema: walked.schema as unknown as z.ZodType<Record<string, unknown>>,
    safeParse(raw: unknown) {
      const normalized = normalize ? normalize(raw) : raw;
      return schema.safeParse(normalized === ABSENT ? undefined : normalized);
    },
  };
  boundaries.set(schema, boundary as StructuredOutputBoundary<unknown>);
  return boundary;
}
