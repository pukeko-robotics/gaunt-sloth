import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { structuredOutputBoundary } from '#src/runtime/structuredOutput.js';

/**
 * EXT-88 — the `withStructuredOutput` boundary.
 *
 * Two emissions matter and they are produced by two different converters, so both are asserted
 * where the difference could bite:
 *
 * - `@langchain/core`'s `toJsonSchema` is what ChatGroq, Anthropic, Google GenAI and Ollama send.
 * - `z.toJSONSchema` is the zod-side view, and the shape `@langchain/openai` derives is the same
 *   required/nullable/description triple.
 *
 * The properties under test are the module's contract: every optional key is REQUIRED and NULLABLE
 * on the wire, every `.describe()` survives, `null` and a missing key both come back as the key
 * being ABSENT, and a genuinely malformed answer still fails.
 */

/** JSON Schema as far as these assertions care. */
interface EmittedSchema {
  properties?: Record<string, EmittedSchema>;
  required?: string[];
  description?: string;
  anyOf?: { type?: string }[];
  items?: EmittedSchema;
  type?: string;
  minItems?: number;
  default?: unknown;
}

const emit = (schema: z.ZodType<unknown>): EmittedSchema =>
  toJsonSchema(schema) as unknown as EmittedSchema;

const wireOf = (schema: z.ZodType<unknown>): EmittedSchema =>
  emit(structuredOutputBoundary(schema).wireSchema as unknown as z.ZodType<unknown>);

describe('structuredOutputBoundary — the wire shape', () => {
  const Flat = z.object({
    outcome: z.enum(['safe', 'destructive']).describe('OUTCOME-DESC'),
    suggestedTool: z.string().optional().describe('SUGGEST-DESC'),
  });

  it('puts an optional key in `required` and types it nullable', () => {
    const wire = wireOf(Flat);

    // The pair that satisfies OpenAI's strict rule ("`required` must include every key in
    // `properties`") while still giving the model a legal way to say "nothing here".
    expect(wire.required).toEqual(expect.arrayContaining(['outcome', 'suggestedTool']));
    expect(wire.properties?.suggestedTool.anyOf).toEqual(
      expect.arrayContaining([{ type: 'string' }, { type: 'null' }])
    );
  });

  it('carries every `.describe()` into the emitted schema, by its actual text', () => {
    const wire = wireOf(Flat);

    expect(wire.properties?.suggestedTool.description).toBe('SUGGEST-DESC');
    expect(wire.properties?.outcome.description).toBe('OUTCOME-DESC');
  });

  it('adds no `default` keyword to what the provider is sent', () => {
    // `prefault` supplies the missing-key value without appearing in the schema; `.default(null)`
    // would do the same job but announce itself as a keyword the provider then has to accept.
    expect(wireOf(Flat).properties?.suggestedTool.default).toBeUndefined();
  });

  it('emits the same required/nullable/description triple through zod’s own converter', () => {
    // `@langchain/openai` derives its request from zod directly rather than from
    // `@langchain/core`'s converter, so the property is asserted on both paths.
    const wire = z.toJSONSchema(
      structuredOutputBoundary(Flat).wireSchema as unknown as z.ZodType<unknown>
    ) as unknown as EmittedSchema;

    expect(wire.required).toEqual(expect.arrayContaining(['outcome', 'suggestedTool']));
    expect(wire.properties?.suggestedTool.description).toBe('SUGGEST-DESC');
    expect(wire.properties?.suggestedTool.anyOf).toEqual(
      expect.arrayContaining([{ type: 'null' }])
    );
  });

  it('leaves a schema with no optional field untouched, by identity', () => {
    // The judge's shape. Identity matters beyond tidiness: it is what keeps LangChain's own
    // conversion cache warm, and it is why the existing call-site specs still see their own schema.
    const NoOptionals = z.object({
      rate: z.number().min(0).max(10).describe('RATE-DESC'),
      reason: z.string().describe('REASON-DESC'),
    });

    expect(structuredOutputBoundary(NoOptionals).wireSchema).toBe(NoOptionals);
  });

  it('returns the same boundary for the same schema', () => {
    expect(structuredOutputBoundary(Flat)).toBe(structuredOutputBoundary(Flat));
  });

  it('keeps constraints that are not about optionality', () => {
    // Rebuilding a rewritten node with `z.array(...)` instead of cloning would drop `minItems`
    // from what the model is told, silently and only on schemas that also have an optional.
    const wire = wireOf(
      z.object({ picks: z.array(z.object({ a: z.string().optional() })).min(2) })
    );

    expect(wire.properties?.picks.minItems).toBe(2);
  });
});

describe('structuredOutputBoundary — reading the answer back', () => {
  const Flat = z.object({
    outcome: z.string(),
    suggestedTool: z.string().optional().describe('SUGGEST-DESC'),
  });

  it('turns a `null` for an optional field into the key being absent', () => {
    const parsed = structuredOutputBoundary(Flat).safeParse({
      outcome: 'safe',
      suggestedTool: null,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestedTool).toBeUndefined();
    // Not merely `undefined`: the key must not exist, or "absent" acquires a second spelling.
    expect(Object.hasOwn(parsed.data, 'suggestedTool')).toBe(false);
  });

  it('accepts a MISSING key too, which is how the providers that do not hoist answer', () => {
    const parsed = structuredOutputBoundary(Flat).safeParse({ outcome: 'safe' });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.hasOwn(parsed.data, 'suggestedTool')).toBe(false);
  });

  it('passes a real value through unchanged', () => {
    const parsed = structuredOutputBoundary(Flat).safeParse({
      outcome: 'safe',
      suggestedTool: 'edit_file',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.suggestedTool).toBe('edit_file');
  });

  it('still rejects a genuinely malformed answer', () => {
    const boundary = structuredOutputBoundary(Flat);

    // A wrong type in the optional field, a wrong type in a required one, and a missing required
    // one: this removes a FALSE parse failure, it does not accept anything.
    expect(boundary.safeParse({ outcome: 'safe', suggestedTool: 7 }).success).toBe(false);
    expect(boundary.safeParse({ outcome: 7, suggestedTool: null }).success).toBe(false);
    expect(boundary.safeParse({ suggestedTool: null }).success).toBe(false);
    expect(boundary.safeParse('not an object').success).toBe(false);
  });

  it('keeps a `null` the caller asked for', () => {
    // `.nullish()` declares null a value in its own right, so it is not the wire's "nothing here".
    const Nullish = z.object({ a: z.string().nullish() });
    const parsed = structuredOutputBoundary(Nullish).safeParse({ a: null });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.a).toBeNull();
    // …and it is still required-and-nullable on the wire, which is the half `.nullish()` lacked.
    expect(wireOf(Nullish).required).toEqual(['a']);
  });
});

describe('structuredOutputBoundary — nested optionals', () => {
  /** The real shape from takahē's `graph-recall` workflow: an optional inside an object inside an
   * array, reached through `askStructured`, and exactly what a top-level-only walk would miss. */
  const Picks = z.object({
    summary: z.string().describe('SUMMARY-DESC'),
    picks: z
      .array(
        z.object({
          id: z.string().describe('ID-DESC'),
          relation: z.enum(['overlaps', 'adjacent']).describe('RELATION-DESC'),
          annotation: z.string().optional().describe('ANNOTATION-DESC'),
        })
      )
      .describe('PICKS-DESC'),
  });

  it('hoists an optional inside an object inside an array', () => {
    const item = wireOf(Picks).properties?.picks.items;

    expect(item?.required).toEqual(expect.arrayContaining(['id', 'relation', 'annotation']));
    expect(item?.properties?.annotation.anyOf).toEqual(
      expect.arrayContaining([{ type: 'string' }, { type: 'null' }])
    );
  });

  it('keeps every nested description', () => {
    const wire = wireOf(Picks);
    const item = wire.properties?.picks.items;

    expect(wire.properties?.summary.description).toBe('SUMMARY-DESC');
    expect(wire.properties?.picks.description).toBe('PICKS-DESC');
    expect(item?.properties?.id.description).toBe('ID-DESC');
    expect(item?.properties?.relation.description).toBe('RELATION-DESC');
    expect(item?.properties?.annotation.description).toBe('ANNOTATION-DESC');
  });

  it('normalizes a nested `null` to the key being absent', () => {
    const parsed = structuredOutputBoundary(Picks).safeParse({
      summary: 's',
      picks: [
        { id: 'A', relation: 'overlaps', annotation: null },
        { id: 'B', relation: 'adjacent', annotation: 'kept' },
      ],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(Object.hasOwn(parsed.data.picks[0], 'annotation')).toBe(false);
    expect(parsed.data.picks[1].annotation).toBe('kept');
  });

  it('still rejects a nested value that is genuinely wrong', () => {
    expect(
      structuredOutputBoundary(Picks).safeParse({
        summary: 's',
        picks: [{ id: 'A', relation: 'not-a-relation', annotation: null }],
      }).success
    ).toBe(false);
  });

  it('handles an optional inside a plain nested object', () => {
    const Nested = z.object({ outer: z.object({ inner: z.string().optional() }).describe('OUT') });
    const wire = wireOf(Nested);
    const parsed = structuredOutputBoundary(Nested).safeParse({ outer: { inner: null } });

    expect(wire.properties?.outer.required).toEqual(['inner']);
    expect(wire.properties?.outer.description).toBe('OUT');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.hasOwn(parsed.data.outer, 'inner')).toBe(false);
  });

  it('handles an optional inside a record value and inside a tuple', () => {
    const Record = z.object({ r: z.record(z.string(), z.object({ a: z.string().optional() })) });
    const Tuple = z.object({ t: z.tuple([z.string(), z.object({ a: z.string().optional() })]) });

    const fromRecord = structuredOutputBoundary(Record).safeParse({ r: { k: { a: null } } });
    expect(fromRecord.success).toBe(true);
    if (fromRecord.success) expect(Object.hasOwn(fromRecord.data.r.k, 'a')).toBe(false);

    const fromTuple = structuredOutputBoundary(Tuple).safeParse({ t: ['x', { a: null }] });
    expect(fromTuple.success).toBe(true);
    if (fromTuple.success) expect(Object.hasOwn(fromTuple.data.t[1], 'a')).toBe(false);
  });

  it('normalizes a tuple by position, prefix items and rest separately', () => {
    /*
     * A prefix item must be normalized by its OWN schema and never by the rest schema, which
     * describes a different position. The two positions here disagree about the same key name on
     * purpose, which is what makes the assertion discriminate: at index 1 `a` is REQUIRED and
     * nullable, so its `null` is a value and must survive; in the rest it is optional, so its
     * `null` must become the key being absent. Normalizing the prefix item with the rest's
     * normalizer would strip a key the schema requires, and the parse would fail.
     */
    const Tuple = z.object({
      t: z.tuple(
        [z.string(), z.object({ a: z.string().nullable() })],
        z.object({ a: z.string().optional() })
      ),
    });

    const parsed = structuredOutputBoundary(Tuple).safeParse({
      t: ['x', { a: null }, { a: null }, { a: 'v' }],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.t[1]).toEqual({ a: null });
    expect(Object.hasOwn(parsed.data.t[2] as object, 'a')).toBe(false);
    expect((parsed.data.t[3] as { a?: string }).a).toBe('v');
  });
});

describe('structuredOutputBoundary — the documented limits', () => {
  /**
   * The rewrite stops at a union, and this test pins that rather than leaving it assumed.
   *
   * The reason is that the rewrite and the normalization must cover precisely the same set: at a
   * union the value gives no reliable answer to which branch was taken, so a `null` written into a
   * branch could not be stripped back out — and rewriting without being able to normalize would
   * manufacture the very parse failure this module removes. Leaving the subtree alone keeps today's
   * behaviour there: correct wherever it is correct today, and a visible provider error otherwise.
   */
  it('leaves a union subtree exactly as the caller wrote it', () => {
    const Union = z.object({
      u: z.union([z.object({ a: z.string().optional() }), z.string()]),
    });
    const boundary = structuredOutputBoundary(Union);

    expect(boundary.wireSchema).toBe(Union);
    // The optional inside the branch is NOT hoisted — the limit, stated as an assertion.
    const branch = (emit(Union).properties?.u as unknown as { anyOf: EmittedSchema[] }).anyOf[0];
    expect(branch.required ?? []).not.toContain('a');
    // And a `null` there is still rejected, exactly as it is today.
    expect(boundary.safeParse({ u: { a: null } }).success).toBe(false);
  });

  it('leaves a discriminated union alone for the same reason', () => {
    const Discriminated = z.object({
      d: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), x: z.string().optional() }),
        z.object({ kind: z.literal('b'), y: z.string() }),
      ]),
    });

    expect(structuredOutputBoundary(Discriminated).wireSchema).toBe(Discriminated);
  });

  /**
   * Zod spells recursion as a GETTER in an object's shape, which reads as an ordinary `object` to
   * the walk — so this is not covered by the `lazy` limit below and would descend for ever without
   * the cycle guard. `askStructured` takes arbitrary caller schemas, so it is reachable.
   */
  it('leaves a recursive schema alone instead of descending for ever', () => {
    const Node = z.object({
      id: z.string().describe('ID'),
      get children() {
        return z.array(Node).optional();
      },
    });

    expect(structuredOutputBoundary(Node).wireSchema).toBe(Node);
    // Terminating is the point: without the guard this is a RangeError, not a failed assertion.
    expect(structuredOutputBoundary(Node).safeParse({ id: 'a' }).success).toBe(true);
  });

  it('leaves a mutually recursive pair alone', () => {
    const A = z.object({
      a: z.string(),
      get b() {
        return B.optional();
      },
    });
    const B = z.object({
      b: z.string(),
      get a() {
        return A.optional();
      },
    });

    expect(structuredOutputBoundary(A).wireSchema).toBe(A);
    expect(structuredOutputBoundary(B).wireSchema).toBe(B);
  });

  it('leaves an intersection and a lazy schema alone', () => {
    const Intersection = z.object({
      i: z.intersection(z.object({ a: z.string().optional() }), z.object({ b: z.string() })),
    });
    const Lazy = z.object({ l: z.lazy(() => z.object({ a: z.string().optional() })) });

    expect(structuredOutputBoundary(Intersection).wireSchema).toBe(Intersection);
    expect(structuredOutputBoundary(Lazy).wireSchema).toBe(Lazy);
  });
});
