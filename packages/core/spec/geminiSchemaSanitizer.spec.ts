import { describe, expect, it } from 'vitest';
import { ChatGoogle } from '@langchain/google/node';
import {
  sanitizeGeminiToolSchema,
  applyGeminiToolSchemaSanitizer,
} from '#src/providers/geminiSchemaSanitizer.js';

/**
 * GS2-58 — systemic Gemini tool-schema sanitizer. The pure {@link sanitizeGeminiToolSchema} rewrites
 * `exclusiveMinimum`/`exclusiveMaximum` to `minimum`/`maximum`, drops `multipleOf`, and strips the
 * unsupported combinators (`const`/`$ref`/`allOf`/`oneOf`/`not`/`$schema`/`additionalProperties`) that
 * Gemini's OpenAPI-3.0 subset 400s on — recursively, and only in schema positions. The wiring test
 * drives a REAL `@langchain/google` `ChatGoogle` model + its REAL Gemini converter to prove a
 * sanitized tool reaches the wire clean (no fake/mock in the assertion path).
 */

/** Every Gemini-hostile keyword this node handles, for exhaustive recursive scans. */
const HOSTILE_KEYWORDS = [
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'const',
  '$ref',
  'allOf',
  'oneOf',
  'not',
  '$schema',
  'additionalProperties',
] as const;

/** Recursively collect every object KEY present anywhere in a value. */
function collectKeys(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) collectKeys(v, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

describe('sanitizeGeminiToolSchema (GS2-58)', () => {
  it('rewrites/strips hostile keywords recursively (property + array items), keeps the supported core', () => {
    // HOSTILE fixture: hostile keywords at the root, nested one level in a property schema, and one
    // level in an array `items` schema — exactly the shapes a zod `.positive()`/`.gt()`/`.multipleOf()`
    // (or a raw MCP schema) would produce.
    const hostile = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        count: {
          type: 'number',
          description: 'how many',
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
          multipleOf: 2,
          const: 5,
        },
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 9,
          items: {
            type: 'number',
            exclusiveMinimum: 1,
            multipleOf: 3,
            $ref: '#/$defs/tag',
          },
        },
        mode: { const: 'fast' },
        ref: { $ref: '#/$defs/other' },
      },
      required: ['count'],
      allOf: [{ type: 'object' }],
      oneOf: [{ type: 'string' }],
      not: { type: 'null' },
    };

    const out = sanitizeGeminiToolSchema(hostile) as any;

    // No hostile keyword survives ANYWHERE in the output tree.
    const keys = collectKeys(out);
    for (const k of HOSTILE_KEYWORDS) {
      expect(keys.has(k), `hostile keyword "${k}" leaked into sanitized output`).toBe(false);
    }

    // exclusive* -> inclusive of the SAME value, at both nesting depths.
    expect(out.properties.count.minimum).toBe(0);
    expect(out.properties.count.maximum).toBe(100);
    expect(out.properties.tags.items.minimum).toBe(1);

    // Supported core keywords are preserved verbatim.
    expect(out.type).toBe('object');
    expect(out.required).toEqual(['count']);
    expect(out.properties.count.type).toBe('number');
    expect(out.properties.count.description).toBe('how many');
    expect(out.properties.tags.type).toBe('array');
    expect(out.properties.tags.minItems).toBe(1);
    expect(out.properties.tags.maxItems).toBe(9);
    expect(out.properties.tags.items.type).toBe('number');

    // const-only / $ref-only subschemas keep their other content but lose the hostile keyword.
    expect(out.properties.mode).toEqual({});
    expect(out.properties.ref).toEqual({});

    // Input is NOT mutated (pure function).
    expect((hostile.properties.count as any).exclusiveMinimum).toBe(0);
    expect((hostile.properties.count as any).multipleOf).toBe(2);
    expect(hostile.$schema).toBeDefined();
  });

  it('passes a clean schema through unchanged (deep-equal, distinct copy)', () => {
    const clean = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'a name', minLength: 1, maxLength: 40 },
        n: { type: 'number', minimum: 0, maximum: 10 },
        color: { type: 'string', enum: ['red', 'green', 'blue'] },
        items: { type: 'array', items: { type: 'string' }, minItems: 0 },
      },
      required: ['name'],
    };

    const out = sanitizeGeminiToolSchema(clean);
    expect(out).toEqual(clean); // structurally identical
    expect(out).not.toBe(clean); // but a fresh deep copy, never the same reference
    expect((out as any).properties).not.toBe(clean.properties);
  });

  it('preserves hostile keywords that appear as literal DATA (enum/default), not as schema keywords', () => {
    // `default` and `enum` are literal-data positions — a `multipleOf`/`exclusiveMinimum` inside them
    // is a VALUE, not a schema constraint, and must survive untouched (advisor point 4).
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
  const hostileTool = {
    name: 'hostile_tool',
    description: 'a tool with a Gemini-hostile schema',
    schema: {
      type: 'object',
      properties: {
        count: { type: 'number', exclusiveMinimum: 0, multipleOf: 2 },
        tags: { type: 'array', items: { type: 'number', exclusiveMaximum: 10 } },
      },
      required: ['count'],
    },
  };

  it('baseline: the real converter passes hostile keywords straight to the wire (the bug)', () => {
    const model = new ChatGoogle({
      apiKey: 'test-key',
      model: 'gemini-flash-lite-latest',
      platformType: 'gai',
    });
    // invocationParams runs the REAL convertToolsToGeminiTools/schemaToGeminiParameters (no network).
    const wire = JSON.stringify((model.invocationParams({ tools: [hostileTool] }) as any).tools);
    expect(wire).toContain('exclusiveMinimum');
    expect(wire).toContain('multipleOf');
    expect(wire).toContain('exclusiveMaximum');
  });

  it('after wiring: tools bound via the override reach the real converter with zero hostile keywords', () => {
    const model = new ChatGoogle({
      apiKey: 'test-key',
      model: 'gemini-flash-lite-latest',
      platformType: 'gai',
    });

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
    // Feed the forwarded (sanitized) tools back through the SAME real converter and assert the wire is clean.
    const wire = JSON.stringify((model.invocationParams({ tools: forwarded }) as any).tools);
    for (const k of ['exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'const', '$ref']) {
      expect(wire, `hostile keyword "${k}" reached the Gemini wire schema`).not.toContain(k);
    }
    // exclusive bounds were rewritten to inclusive ones of the same value.
    expect(wire).toContain('"minimum":0');
    expect(wire).toContain('"maximum":10');
  });
});
