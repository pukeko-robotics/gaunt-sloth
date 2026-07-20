import { describe, expect, it } from 'vitest';
import { ChatGoogle } from '@langchain/google/node';
import {
  sanitizeGeminiToolSchema,
  applyGeminiToolSchemaSanitizer,
  GEMINI_SUPPORTED_SCHEMA_KEYWORDS,
} from '#src/providers/geminiSchemaSanitizer.js';

/**
 * GS2-58 (fix-cycle 1) — the sanitizer is an ALLOWLIST derived from the installed Gemini `Schema`
 * type. The HARD-GATE test asserts a STRUCTURAL INVARIANT — every schema key at every depth of the
 * output is a member of the supported set — so it cannot have a keyword blind spot (it never
 * enumerates bad keywords). `anyOf` unions must SURVIVE; `$defs`/`patternProperties`/`definitions`/
 * `allOf`/`oneOf`/`not`/`const`/`multipleOf`/`exclusive*` must be gone. The wiring test drives a REAL
 * `@langchain/google` `ChatGoogle` + its REAL Gemini converter to prove it at the wire level.
 */

/**
 * Recursively assert every key of every SCHEMA node in the output is a supported keyword. Descends
 * ONLY schema positions (`properties` map, `items`, `anyOf`) — never literal-data positions
 * (`enum`/`default`/`example`/`required`), whose contents are user data, not schema keywords.
 */
function assertOnlySupportedSchemaKeys(node: unknown, path = '$'): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertOnlySupportedSchemaKeys(v, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    expect(
      GEMINI_SUPPORTED_SCHEMA_KEYWORDS.has(key),
      `unsupported schema keyword "${key}" survived at ${path}`
    ).toBe(true);
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, sub] of Object.entries(value)) {
        assertOnlySupportedSchemaKeys(sub, `${path}.properties.${name}`);
      }
    } else if (key === 'items' || key === 'anyOf') {
      assertOnlySupportedSchemaKeys(value, `${path}.${key}`);
    }
  }
}

describe('sanitizeGeminiToolSchema (GS2-58 fix-cycle 1 — allowlist)', () => {
  it('HARD GATE: output contains only supported schema keywords at every depth; anyOf survives', () => {
    // Broad hostile mix — unsupported keywords at the root, nested one level in a property schema, and
    // one level in an array `items` schema — PLUS a supported `anyOf` union in a property AND in items
    // that MUST survive. `exclusiveMinimum` sits next to a stricter `minimum` to prove tighter-wins.
    const hostile = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      $defs: { Tag: { type: 'string' } },
      definitions: { Legacy: { type: 'number' } },
      patternProperties: { '^x_': { type: 'string', multipleOf: 2 } },
      allOf: [{ type: 'object' }],
      oneOf: [{ type: 'string' }],
      not: { type: 'null' },
      properties: {
        count: {
          type: 'integer',
          description: 'how many',
          minimum: 2,
          exclusiveMinimum: 0, // stricter inclusive 2 must win over exclusive 0
          exclusiveMaximum: 100,
          multipleOf: 2,
          const: 5,
        },
        choice: {
          // supported union — MUST survive, and its members must be recursed/cleaned
          anyOf: [
            { type: 'string', pattern: '^a' },
            { type: 'number', exclusiveMinimum: 0, $ref: '#/$defs/Tag' },
          ],
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 9,
          items: {
            type: 'object',
            additionalProperties: false,
            patternProperties: { '^y_': { type: 'string' } },
            properties: {
              v: { type: 'number', exclusiveMinimum: 1, multipleOf: 3, $ref: '#/x' },
              u: { anyOf: [{ type: 'boolean' }, { type: 'number', exclusiveMaximum: 9 }] },
            },
          },
        },
      },
      required: ['count'],
    };

    const out = sanitizeGeminiToolSchema(hostile) as any;

    // STRUCTURAL INVARIANT (the hard gate): no unsupported schema keyword survives anywhere.
    assertOnlySupportedSchemaKeys(out);

    // anyOf unions survive at both depths.
    expect(Array.isArray(out.properties.choice.anyOf)).toBe(true);
    expect(out.properties.choice.anyOf).toHaveLength(2);
    expect(out.properties.choice.anyOf[0]).toEqual({ type: 'string', pattern: '^a' });
    expect(out.properties.tags.items.properties.u.anyOf).toHaveLength(2);

    // exclusive → inclusive, keeping the TIGHTER bound.
    expect(out.properties.count.minimum).toBe(2); // inclusive 2 beats exclusive 0
    expect(out.properties.count.maximum).toBe(100); // from exclusiveMaximum
    expect(out.properties.choice.anyOf[1].minimum).toBe(0); // exclusiveMinimum rewritten in a union member
    expect(out.properties.tags.items.properties.v.minimum).toBe(1);
    expect(out.properties.tags.items.properties.u.anyOf[1].maximum).toBe(9);

    // Supported core preserved verbatim.
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['count']);
    expect(out.properties.count.type).toBe('integer');
    expect(out.properties.count.description).toBe('how many');
    expect(out.properties.tags.type).toBe('array');
    expect(out.properties.tags.minItems).toBe(1);
    expect(out.properties.tags.maxItems).toBe(9);

    // Input is NOT mutated (pure function).
    expect((hostile as any).$defs).toBeDefined();
    expect((hostile.properties.count as any).multipleOf).toBe(2);
    expect((hostile.properties.tags.items as any).patternProperties).toBeDefined();
  });

  it('passes a clean schema (including anyOf) through unchanged (deep-equal, distinct copy)', () => {
    const clean = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'a name', minLength: 1, maxLength: 40 },
        n: { type: 'number', minimum: 0, maximum: 10 },
        color: { type: 'string', enum: ['red', 'green', 'blue'] },
        either: { anyOf: [{ type: 'string' }, { type: 'number' }], nullable: true },
        items: { type: 'array', items: { type: 'string' }, minItems: 0 },
      },
      required: ['name'],
    };

    const out = sanitizeGeminiToolSchema(clean);
    expect(out).toEqual(clean); // structurally identical, anyOf intact
    expect(out).not.toBe(clean); // but a fresh deep copy, never the same reference
    expect((out as any).properties).not.toBe(clean.properties);
  });

  it('preserves unsupported keywords that appear as literal DATA (enum/default), not as schema keywords', () => {
    // `default` and `enum` are supported keys whose VALUES are user data — a `multipleOf`/
    // `exclusiveMinimum`/`const` inside them is a VALUE, not a schema constraint, and must survive.
    const withData = {
      type: 'object',
      properties: {
        cfg: {
          type: 'object',
          default: { multipleOf: 2, exclusiveMinimum: 5 },
          enum: [{ multipleOf: 9 }, { const: 'x' }],
        },
      },
    };

    const out = sanitizeGeminiToolSchema(withData) as any;
    expect(out.properties.cfg.default).toEqual({ multipleOf: 2, exclusiveMinimum: 5 });
    expect(out.properties.cfg.enum).toEqual([{ multipleOf: 9 }, { const: 'x' }]);
  });
});

describe('applyGeminiToolSchemaSanitizer wiring (GS2-58, real @langchain/google converter)', () => {
  // Raw JSON schema (not zod) carrying the keywords that live-400 gemini-flash: $defs, patternProperties,
  // additionalProperties, exclusive/multipleOf, $ref — plus a supported anyOf union that must survive.
  const hostileTool = {
    name: 'hostile_tool',
    description: 'a tool with a Gemini-hostile schema',
    schema: {
      type: 'object',
      $defs: { Size: { type: 'string' } },
      definitions: { Legacy: { type: 'number' } },
      patternProperties: { '^opt_': { type: 'string' } },
      additionalProperties: false,
      properties: {
        count: { type: 'integer', exclusiveMinimum: 0, multipleOf: 2 },
        tags: { type: 'array', items: { type: 'number', exclusiveMaximum: 10 } },
        size: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['count'],
    },
  };

  function newModel() {
    return new ChatGoogle({
      apiKey: 'test-key',
      model: 'gemini-flash-lite-latest',
      platformType: 'gai',
    });
  }

  it('baseline: the real converter passes unsupported keywords straight to the wire (the bug)', () => {
    const model = newModel();
    // invocationParams runs the REAL convertToolsToGeminiTools/schemaToGeminiParameters (no network).
    const wire = JSON.stringify((model.invocationParams({ tools: [hostileTool] }) as any).tools);
    expect(wire).toContain('$defs');
    expect(wire).toContain('patternProperties');
    expect(wire).toContain('exclusiveMinimum');
    expect(wire).toContain('multipleOf');
  });

  it('after wiring: tools bound via the override reach the real converter with only supported keywords', () => {
    const model = newModel();

    // Capture exactly what the override forwards to @langchain/google's real bindTools.
    let forwarded: unknown[] | undefined;
    const realBind = model.bindTools.bind(model);
    (model as any).bindTools = (tools: unknown[], kwargs?: unknown) => {
      forwarded = tools;
      return realBind(tools as never, kwargs as never);
    };

    applyGeminiToolSchemaSanitizer(model);
    model.bindTools([hostileTool as never]);

    expect(forwarded).toBeDefined();
    // Feed the forwarded (sanitized) tools back through the SAME real converter and inspect the wire.
    const wireTools = (model.invocationParams({ tools: forwarded }) as any).tools;
    const params = wireTools[0].functionDeclarations[0].parameters;

    // Structural invariant holds on the actual wire schema.
    assertOnlySupportedSchemaKeys(params);
    // Unsupported keywords are gone; the anyOf union survived; exclusive bounds rewritten.
    const wire = JSON.stringify(wireTools);
    for (const k of [
      '$defs',
      'definitions',
      'patternProperties',
      'additionalProperties',
      'exclusiveMinimum',
      'exclusiveMaximum',
      'multipleOf',
      'const',
      '$ref',
    ]) {
      expect(wire, `unsupported keyword "${k}" reached the Gemini wire schema`).not.toContain(k);
    }
    expect(params.properties.size.anyOf).toHaveLength(2);
    expect(params.properties.count.minimum).toBe(0);
    expect(params.properties.tags.items.maximum).toBe(10);
  });
});
