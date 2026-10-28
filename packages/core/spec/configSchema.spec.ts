import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findApprovalsRaterProfiles,
  findDeprecatedConfigIssues,
  findUnknownTopLevelKeys,
  formatConfigValidationError,
  formatDeprecatedConfigIssues,
  generateConfigJsonSchema,
  OUTPUT_HEADER_RUNGS,
  rawGthConfigSchema,
  undeliverableBinaryFormatMessage,
  unresolvedRaterProfileMessage,
  validateRawGthConfig,
} from '#src/config/schema.js';
import { DEFAULT_CONFIG } from '#src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const committedSchemaPath = resolve(here, '../schema/gsloth-config.schema.json');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The migration-doc URL every deprecated-shape message must carry (GS2-70) — a deliberate
 * copy of schema.ts's MIGRATION_HINT link, so a wording change is a conscious two-place edit.
 */
const MIGRATION_DOC_URL =
  'https://github.com/pukeko-robotics/gaunt-sloth/blob/main/docs/MIGRATION.md';

/**
 * Every `binaryFormats[]` entry schema's `type` enum in the emitted JSON Schema — one at the root
 * and one per command block. Identified by the entry object's own shape (`type` + `extensions`,
 * which nothing else in the document pairs) rather than by string-matching the document, so a
 * `"video"` appearing anywhere else — a description, say — can neither pass the cell nor fail it.
 */
function collectBinaryFormatTypeEnums(node: unknown): string[][] {
  if (Array.isArray(node)) return node.flatMap(collectBinaryFormatTypeEnums);
  if (!node || typeof node !== 'object') return [];
  const record = node as Record<string, unknown>;
  const found: string[][] = [];

  const properties = record.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === 'object' && properties.extensions) {
    const typeSchema = properties.type as Record<string, unknown> | undefined;
    if (typeSchema && Array.isArray(typeSchema.enum)) {
      found.push(typeSchema.enum as string[]);
    }
  }

  return [...found, ...Object.values(record).flatMap(collectBinaryFormatTypeEnums)];
}

describe('config schema (GS2-1 B1)', () => {
  describe('parse success / failure', () => {
    it('parses a minimal valid config', () => {
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' } });
      expect(result.success).toBe(true);
    });

    it.each(OUTPUT_HEADER_RUNGS)('GS2-93: accepts the %s run-header rung', (rung) => {
      expect(
        rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' }, output: { header: rung } })
          .success
      ).toBe(true);
    });

    /**
     * The key was a boolean before it was a ladder, and 2.0 coerces nothing. What makes that
     * survivable is the error naming the rung that replaces the value the user WROTE — so the
     * assertion is on the message text, not merely on `success === false`. A message that only
     * listed the vocabulary would pass a `success` check and still leave the user guessing which
     * of three rungs their `false` meant.
     *
     * The `output.header` half comes from the rendered PATH prefix, not from the message body —
     * `formatConfigValidationError` is what puts the key in front of every issue, and the message
     * deliberately does not repeat it.
     */
    it.each([
      [false, 'none'],
      [true, 'debug'],
    ])('GS2-93: rejects output.header %s, naming %s as the replacement', (written, replacement) => {
      const bad = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        output: { header: written },
      });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('output.header');
        expect(message).toContain(`Use "${replacement}" instead of ${written}.`);
      }
    });

    it('GS2-93: rejects an unknown run-header rung, listing the vocabulary', () => {
      const bad = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        output: { header: 'nope' },
      });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('output.header');
        expect(message).toContain('none, compact, debug');
      }
    });

    it('produces a path-scoped error message on a type mismatch', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        commands: { api: { port: '3000' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = formatConfigValidationError(result.error);
        expect(message).toContain('commands.api.port');
      }
    });

    it('reports a top-level type mismatch with a (root)-free path', () => {
      const result = rawGthConfigSchema.safeParse({ streamOutput: 'yes' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('streamOutput');
      }
    });
  });

  /**
   * CFG-76 — a union reports as ONE `invalid_union` issue at its own path unless exactly one arm
   * failed only on continuable checks. Zod carries every arm's diagnosis under that issue's
   * `errors`, paths relative to the union, and a renderer that reads only the top-level `path` and
   * `message` throws all of it away — telling the user `binaryFormats: Invalid input` about an
   * array whose failing entry and field zod had already named.
   *
   * These cells assert the CONTENT of the rejection rather than `success === false`: the point is
   * the entry INDEX and the FIELD, and a rejection naming neither leaves the user counting array
   * entries. The CONTROL cells are the other half — the risk in descending into one union is
   * regressing every message that was already legible.
   */
  describe('a failing union renders its arms (CFG-76)', () => {
    /**
     * Through `validateRawGthConfig`, which is the route the loader and `gth config validate` both
     * take — and the reason `type` is VALID in every entry here: a bad `type` never reaches the
     * formatter, because `findUndeliverableBinaryFormatIssues` throws pre-parse with its own
     * message. These entries fail on another field, so the message under test is the formatter's.
     */
    it('names the entry index and the field for a bad binaryFormats entry', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        binaryFormats: [{ type: 'image', extensions: 'png' }],
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain(
        'binaryFormats.0.extensions: Invalid input: expected array, received string'
      );
      expect(result.errorMessage).not.toContain('binaryFormats: Invalid input');
    });

    it('names the SECOND entry when the first is fine', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        binaryFormats: [{ type: 'image', extensions: ['png'] }, { type: 'audio' }],
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain(
        'binaryFormats.1.extensions: Invalid input: expected array, received undefined'
      );
    });

    it('rejoins the per-command path onto the arm issue', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        commands: { review: { binaryFormats: [{ type: 'file', extensions: 3 }] } },
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain(
        'commands.review.binaryFormats.0.extensions: Invalid input: expected array, received number'
      );
    });

    // `builtInTools` is a union whose record arm holds a union, so this is two levels of descent
    // on a real config key rather than a schema written for the test.
    it('descends through a union nested inside a union arm', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        builtInTools: { gth_read_binary: 'yes' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = formatConfigValidationError(result.error);
        expect(message).toContain(
          'builtInTools.gth_read_binary: Invalid input: expected boolean, received string'
        );
        expect(message).not.toContain('builtInTools: Invalid input');
      }
    });

    /**
     * The two collapse shapes the coarse rule ("checks surface, types collapse") gets wrong. No
     * config union hits either today, which is exactly why they are pinned on schemas written
     * here: a `.min()` or an `abort: true` added to `schema.ts` tomorrow would otherwise silently
     * land back on `Invalid input`.
     *
     * `util.aborted` is true when ANY issue is non-continuable, and zod returns an arm's own
     * issues only when that arm is the ONLY non-aborted one — so two arms failing on nothing but
     * continuable checks still collapse.
     */
    it('renders both arms when TWO check-only-failing arms collapse the union', () => {
      const schema = z.object({ k: z.union([z.string().min(5), z.string().max(1)]) });
      const result = schema.safeParse({ k: 'abc' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].code).toBe('invalid_union');
        expect(formatConfigValidationError(result.error)).toBe(
          '  - k: Too small: expected string to have >=5 characters\n' +
            '  - k: Too big: expected string to have <=1 characters'
        );
      }
    });

    // `abort: true` makes a `refine` issue non-continuable, so a single failing refine aborts its
    // arm and the union collapses on its own.
    it('renders the refine message when abort: true collapses the union', () => {
      const schema = z.object({
        k: z.union([
          z.string().refine(() => false, { error: 'a rule name must be lower case', abort: true }),
          z.number(),
        ]),
      });
      const result = schema.safeParse({ k: 'Abc' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].code).toBe('invalid_union');
        expect(formatConfigValidationError(result.error)).toContain(
          'k: a rule name must be lower case'
        );
      }
    });

    /**
     * CONTROL — the arm that zod surfaces DIRECTLY (exactly one non-aborted arm) must not be
     * routed through the new code by accident. The `code` assertion is what makes that a control
     * rather than a coincidence: there is no `invalid_union` issue here at all, so the line below
     * is zod's own issue rendered by the untouched path.
     */
    it('CONTROL — a single surviving arm still surfaces its own issue, undescended', () => {
      const schema = z.object({ k: z.union([z.string().min(5), z.number()]) });
      const result = schema.safeParse({ k: 'ab' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].code).toBe('too_small');
        expect(formatConfigValidationError(result.error)).toBe(
          '  - k: Too small: expected string to have >=5 characters'
        );
      }
    });

    /**
     * CONTROL — a message that was already legible is byte-for-byte what it was before the
     * descent existed. Both strings were measured on the pre-change formatter. `toBe` on the whole
     * rendering, not `toContain`: the risk this change carries is regressing every other config
     * error while fixing one, and a containment check cannot see an extra line.
     */
    it.each([
      [
        { llm: { type: 'openai' }, commands: { api: { port: '3000' } } },
        '  - commands.api.port: Invalid input: expected number, received string',
      ],
      [
        { llm: { type: 'anthropic' }, output: { header: false } },
        '  - output.header: no longer a boolean: it is one of none, compact, debug. ' +
          'Use "none" instead of false.',
      ],
    ])('CONTROL — an already-legible message is unchanged', (raw, expected) => {
      const result = rawGthConfigSchema.safeParse(raw);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toBe(expected);
      }
    });

    /**
     * An `invalid_union` carrying nothing to descend into still prints a line. Zod emits exactly
     * this shape for an exclusive union where SEVERAL arms matched (`errors: []`, plus `matches`),
     * and a hand-built error can omit `errors` entirely. Dropping the issue would be worse than
     * the bland message it replaces, so the union's own line is the floor.
     */
    it.each([
      ['empty errors (several arms matched)', { errors: [], inclusive: false, matches: [0, 1] }],
      ['no errors field at all', {}],
      ['every arm empty', { errors: [[], []] }],
    ])('falls back to the union line when it carries no arm issues — %s', (_label, extra) => {
      const error = new z.ZodError([
        {
          code: 'invalid_union',
          path: ['approvals'],
          message: 'Invalid input',
          ...extra,
        } as unknown as z.core.$ZodIssue,
      ]);
      expect(formatConfigValidationError(error)).toBe('  - approvals: Invalid input');
    });

    // Overlapping arms fail at the same path with the same sentence; one problem reads as one
    // line. The dedupe is scoped to a single union's expansion, so the second cell pins that the
    // issue LIST is still not deduped — two separate keys that happen to fail alike both print.
    it('prints one line when two arms of a union fail identically', () => {
      const schema = z.object({
        k: z.union([
          z.object({ a: z.string() }),
          z.object({ a: z.string(), b: z.number().optional() }),
        ]),
      });
      const result = schema.safeParse({ k: { a: 1 } });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toBe(
          '  - k.a: Invalid input: expected string, received number'
        );
      }
    });

    it('does not dedupe across separate issues', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        streamOutput: 'yes',
        injectModelContext: 'yes',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error).split('\n')).toHaveLength(2);
      }
    });

    /**
     * The descent is capped, and the cap renders the union's own line rather than dropping the
     * issue. Four nested unions is one past the cap; three is inside it, and the pair is what
     * pins the bound — a cell at only one depth passes whatever the cap is set to.
     */
    it('stops descending past the cap, and says so with the union line', () => {
      const innermost = z.union([z.object({ deep: z.string() }), z.object({ other: z.number() })]);
      const inside = z.object({
        k: z.union([z.literal(false), z.union([z.literal(1), innermost])]),
      });
      const past = z.object({
        k: z.union([z.literal(false), z.union([z.literal(1), z.union([z.literal(2), innermost])])]),
      });

      const insideResult = inside.safeParse({ k: { deep: 3 } });
      expect(insideResult.success).toBe(false);
      if (!insideResult.success) {
        expect(formatConfigValidationError(insideResult.error)).toContain(
          'k.deep: Invalid input: expected string, received number'
        );
      }

      const pastResult = past.safeParse({ k: { deep: 3 } });
      expect(pastResult.success).toBe(false);
      if (!pastResult.success) {
        const message = formatConfigValidationError(pastResult.error);
        expect(message).not.toContain('k.deep');
        expect(message).toContain('  - k: Invalid input');
      }
    });
  });

  describe('unknown top-level keys', () => {
    it('preserves unknown keys (does not strip or fail) and flags them for warning', () => {
      const raw = { llm: { type: 'openai' }, totallyMadeUpKey: 123 };
      expect(findUnknownTopLevelKeys(raw)).toEqual(['totallyMadeUpKey']);

      const result = rawGthConfigSchema.safeParse(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        // looseObject keeps the unknown key in the parsed output.
        expect((result.data as Record<string, unknown>).totallyMadeUpKey).toBe(123);
      }
    });

    it('treats $schema and every known field as known', () => {
      expect(findUnknownTopLevelKeys({ $schema: './x.json', llm: {}, commands: {} })).toEqual([]);
    });
  });

  describe('accept every known-good config', () => {
    it('accepts DEFAULT_CONFIG', () => {
      const result = rawGthConfigSchema.safeParse(DEFAULT_CONFIG);
      expect(result.success).toBe(true);
    });

    // GS2-35 — the config-driven commit co-author identity.
    it('accepts commit.coAuthor and rejects a non-string name', () => {
      expect(
        rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          commit: { coAuthor: { name: 'Acme Bot', email: 'bot@acme.test' } },
        }).success
      ).toBe(true);
      // A partial identity (either field alone) is valid; both fields are optional.
      expect(
        rawGthConfigSchema.safeParse({ commit: { coAuthor: { name: 'Only Name' } } }).success
      ).toBe(true);
      const bad = rawGthConfigSchema.safeParse({ commit: { coAuthor: { name: 123 } } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('commit.coAuthor.name');
      }
    });

    // GS2-34 — the model-context injection opt-out toggle. Boolean-only; the default (omitted =
    // inject-on) is a READ-SITE default (like GS2-35's commit.coAuthor), proven behaviorally in the
    // injection parity spec, so it is intentionally NOT a schema/DEFAULT_CONFIG default here.
    it('accepts injectModelContext as a boolean and rejects a non-boolean', () => {
      expect(rawGthConfigSchema.safeParse({ injectModelContext: true }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ injectModelContext: false }).success).toBe(true);
      const bad = rawGthConfigSchema.safeParse({ injectModelContext: 'yes' });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('injectModelContext');
      }
    });

    // EXT-36 — the tool-loop guard knob. Boolean (false disables / true = warn-on) OR the
    // fine-grained { warn, halt, threshold } object; a wrong type is a path-scoped failure. Like
    // injectModelContext the WARN-on default is a READ-SITE default, so it is intentionally NOT a
    // schema/DEFAULT_CONFIG default here.
    it('accepts toolLoopGuard as a boolean or a { warn, halt, threshold } object', () => {
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: false }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: true }).success).toBe(true);
      expect(
        rawGthConfigSchema.safeParse({ toolLoopGuard: { warn: true, halt: true, threshold: 4 } })
          .success
      ).toBe(true);
      // Partial object forms are valid (every field optional).
      expect(rawGthConfigSchema.safeParse({ toolLoopGuard: { halt: true } }).success).toBe(true);
    });

    it('rejects a non-numeric toolLoopGuard.threshold with a path-scoped message', () => {
      const bad = rawGthConfigSchema.safeParse({ toolLoopGuard: { threshold: 'lots' } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('toolLoopGuard');
      }
    });

    it('treats toolLoopGuard as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, toolLoopGuard: { halt: true } })).toEqual([]);
    });

    // BATCH-49 — the recorded-payload cap. A positive integer is the whole vocabulary; 0 is
    // rejected rather than read as "unlimited", because its neighbour uses 0 to mean the minimum.
    it('accepts toolResultCaptureMaxBytes as a positive integer', () => {
      expect(rawGthConfigSchema.safeParse({ toolResultCaptureMaxBytes: 65536 }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ toolResultCaptureMaxBytes: 1 }).success).toBe(true);
    });

    it.each([
      ['zero', 0],
      ['a negative', -1],
      ['a fraction', 1.5],
    ])('rejects toolResultCaptureMaxBytes when it is %s, naming the key', (_label, value) => {
      const bad = rawGthConfigSchema.safeParse({ toolResultCaptureMaxBytes: value });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('toolResultCaptureMaxBytes');
        expect(message).toContain('positive integer');
      }
    });

    it('rejects a non-numeric toolResultCaptureMaxBytes with a message naming the key', () => {
      const bad = rawGthConfigSchema.safeParse({ toolResultCaptureMaxBytes: '8192' });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        // The path names the key, and so does the message body: a customised `expected number`
        // that dropped the key's name would still pass a path-only assertion.
        expect(message).toContain('toolResultCaptureMaxBytes');
        expect(message).toContain('toolResultCaptureMaxBytes must be a positive integer');
      }
    });

    it('treats toolResultCaptureMaxBytes as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, toolResultCaptureMaxBytes: 65536 })).toEqual([]);
    });

    // BATCH-48 — the run-level coverage floor. `min` is a percentage because that is the unit the
    // figure is printed in; `waive` is a list of tool-name patterns. Both messages name the key.
    it('accepts evalToolCoverage with a min and a waive list', () => {
      expect(
        rawGthConfigSchema.safeParse({
          evalToolCoverage: { min: 13, waive: ['read_file', 'mcp__unimarket_*'] },
        }).success
      ).toBe(true);
      expect(rawGthConfigSchema.safeParse({ evalToolCoverage: { min: 0 } }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ evalToolCoverage: { min: 100 } }).success).toBe(true);
      expect(rawGthConfigSchema.safeParse({ evalToolCoverage: {} }).success).toBe(true);
    });

    it.each([
      ['below 0', -1],
      ['above 100', 101],
    ])('rejects evalToolCoverage.min when it is %s, naming the key', (_label, value) => {
      const bad = rawGthConfigSchema.safeParse({ evalToolCoverage: { min: value } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('evalToolCoverage.min');
        expect(message).toContain('evalToolCoverage.min is a percentage between 0 and 100');
      }
    });

    it('rejects a non-numeric evalToolCoverage.min with a message naming the key', () => {
      const bad = rawGthConfigSchema.safeParse({ evalToolCoverage: { min: '13' } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('evalToolCoverage.min');
        expect(message).toContain('evalToolCoverage.min is a percentage between 0 and 100');
      }
    });

    it('rejects an empty evalToolCoverage.waive entry, naming the key', () => {
      const bad = rawGthConfigSchema.safeParse({ evalToolCoverage: { waive: [''] } });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        const message = formatConfigValidationError(bad.error);
        expect(message).toContain('evalToolCoverage.waive');
        expect(message).toContain('evalToolCoverage.waive entries must be non-empty');
      }
    });

    it('treats evalToolCoverage as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, evalToolCoverage: { min: 13 } })).toEqual([]);
    });

    // OPS-81 removed four cases here that schema-checked the on-disk `examples/` configs, along
    // with that directory — its content now lives inline in the configuration docs. The realistic
    // consumer configs below are declared in this file and cover the same shapes.

    it('accepts a realistic consumer config (a2ui surface + api/cors)', () => {
      const config = {
        llm: {
          type: 'openai',
          model: 'gpt-5.4',
          configuration: { temperature: 0.7 },
        },
        builtInTools: ['show_a2ui_surface'],
        streamOutput: true,
        commands: {
          api: {
            port: 3000,
            cors: {
              allowOrigin: 'http://localhost:5555',
              allowMethods: 'POST, GET, OPTIONS',
              allowHeaders: 'Content-Type, Accept',
            },
          },
        },
      };
      const result = rawGthConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });
  });

  // CFG-18: the golden snapshot pins the schema SHAPE; these assert the schema→resolver VALUE seam —
  // a full builtInTools registry parses through the real schema and preserves every field (not only
  // the hand-built resolver object).
  describe('builtInTools registry round-trip (CFG-18)', () => {
    it('parses a full run_shell_command config and preserves every field', () => {
      // CFG-26 — the run_shell_command entry now carries EXECUTION knobs only; the approval knobs
      // moved to the top-level `approvals` block (see the CFG-26 describe below).
      const builtInTools = {
        gth_checklist: true,
        run_tests: { command: 'npm test' },
        run_shell_command: {
          enabled: true,
          timeout: 300000,
          maxOutputBytes: 200000,
        },
      };
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, builtInTools });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).builtInTools).toEqual(builtInTools);
      }
    });

    it('parses the boolean-in-record force-disable arm ({ run_shell_command: false })', () => {
      const builtInTools = { run_shell_command: false, gth_checklist: true };
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, builtInTools });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as Record<string, unknown>).builtInTools).toEqual(builtInTools);
      }
    });

    // CFG-52 — `builtInToolConfigSchema` is a plain `z.object`, which SILENTLY STRIPS a key it does
    // not know. That is what makes this a discriminating pair rather than a tautology: `maxBytes`
    // survives the parse only because the schema now declares it, while a neighbouring typo is
    // dropped on the floor. Without the schema change, the first half fails.
    it("carries gth_gh_read_file's maxBytes through the parse, at the root and per command", () => {
      const builtInTools = {
        gth_checklist: true,
        gth_gh_read_file: { maxBytes: 200000 },
      };
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        builtInTools,
        commands: { pr: { builtInTools: { gth_gh_read_file: { maxBytes: 50000 } } } },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const data = result.data as {
          builtInTools?: unknown;
          commands?: { pr?: { builtInTools?: unknown } };
        };
        expect(data.builtInTools).toEqual(builtInTools);
        expect(data.commands?.pr?.builtInTools).toEqual({ gth_gh_read_file: { maxBytes: 50000 } });
      }

      const typo = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        builtInTools: { gth_gh_read_file: { maxByte: 200000 } },
      });
      expect(typo.success).toBe(true);
      if (typo.success) {
        expect((typo.data as { builtInTools?: Record<string, unknown> }).builtInTools).toEqual({
          gth_gh_read_file: {},
        });
      }
    });
  });

  /**
   * CFG-68 — `video` and `binary` were accepted `binaryFormats` types with no working path on ANY
   * provider. `@langchain/core`'s `convertToProviderContentBlock` dispatches text/image/audio/file
   * and throws for everything else, so the config validated, `gth_read_binary` read the file, and
   * the run died at the provider boundary naming a LangChain block type.
   *
   * Asserted through `validateRawGthConfig`, which is what the loader and `gth config validate`
   * both run. These cells assert the PATH and the offending VALUE rather than `ok === false`,
   * because a rejection naming neither leaves the user counting array entries to find the one that
   * is wrong — and `ok === false` was true of the un-narrowed schema too.
   */
  describe('undeliverable binaryFormats types (CFG-68)', () => {
    it.each(['video', 'binary'])(
      'rejects a %s entry, naming the path, the value and the vocabulary',
      (type) => {
        const result = validateRawGthConfig({
          llm: { type: 'anthropic' },
          binaryFormats: [
            { type: 'image', extensions: ['png'] },
            { type, extensions: ['mp4', 'bin'] },
          ],
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('binaryFormats.1.type');
        expect(result.errorMessage).toContain(`"${type}" is not a binary format type`);
        expect(result.errorMessage).toContain('image, file, audio');
      }
    );

    it('names the per-command path when the entry is under commands.<cmd>', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        commands: { review: { binaryFormats: [{ type: 'video', extensions: ['mp4'] }] } },
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.review.binaryFormats.0.type');
    });

    // The schema is narrowed too, so a config reaching the parse by any other route is still
    // refused — this is the half the pre-parse scan would otherwise be the only guard for.
    it.each(['video', 'binary'])('the schema itself also refuses %s', (type) => {
      expect(
        rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          binaryFormats: [{ type, extensions: ['mp4'] }],
        }).success
      ).toBe(false);
    });

    // The JSON Schema is what an editor completes `type` from, so it is the third place the
    // vocabulary is stated and the one a user meets before any validation runs.
    it('the emitted JSON Schema offers only the deliverable three', () => {
      const enums = collectBinaryFormatTypeEnums(generateConfigJsonSchema());
      expect(enums.length).toBeGreaterThan(0);
      for (const values of enums) {
        expect(values).toEqual(['image', 'file', 'audio']);
      }
    });

    // CONTROL — the three deliverable types and the `false` off switch are untouched. A narrowing
    // that took a working format type, or the whole key, with it reds here.
    it('CONTROL — image, file and audio entries, and `false`, still validate', () => {
      for (const type of ['image', 'file', 'audio']) {
        const result = validateRawGthConfig({
          llm: { type: 'anthropic' },
          binaryFormats: [{ type, extensions: ['png'] }],
        });
        expect(result.ok).toBe(true);
      }
      expect(validateRawGthConfig({ llm: { type: 'anthropic' }, binaryFormats: false }).ok).toBe(
        true
      );
    });
  });

  /**
   * CFG-74 — an entry whose `type` is MISSING or not a string needs a sentence the enum cannot
   * write. The enum's error hook renders `issue.input`, so left to the schema an entry with no
   * `type` is refused as `undefined is not a binary format type` — a sentence about a value, for
   * an entry that has none. The pre-parse scan names the shape instead, and runs first, so that is
   * what the user reads.
   *
   * Same route as the CFG-68 cells (`validateRawGthConfig`) and the same reason: the MESSAGE is
   * the assertion, because `ok === false` holds either way.
   */
  describe('binaryFormats entry with a missing or non-string type (CFG-74)', () => {
    it('names binaryFormats.<n>.type when an entry has no type', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        binaryFormats: [{ type: 'image', extensions: ['png'] }, { extensions: ['png'] }],
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('binaryFormats.1.type');
      // The dedicated missing sentence, byte-for-byte after its path. Without this pin a disabled
      // `undefined` branch falls through to the non-string sentence and every cell stays green.
      expect(result.errorMessage).toContain(
        'binaryFormats.1.type: missing — every binaryFormats entry names its type as one of ' +
          'image, file, audio.'
      );
      expect(result.errorMessage).toContain('image, file, audio');
      expect(result.errorMessage).not.toContain('binaryFormats: Invalid input');
    });

    it.each([
      { type: 42, rendered: '42' },
      { type: null, rendered: 'null' },
      { type: true, rendered: 'true' },
      { type: ['image'], rendered: '["image"]' },
      // An object renders by shape, never by JSON: its JSON is not what the user wrote, can run to
      // pages, and a string-returning `toJSON` (a `Date`, a `URL`, a `String` wrapper) would put a
      // quoted string inside a sentence that says there is none.
      { type: { name: 'image' }, rendered: 'an object' },
      { type: { toJSON: () => 'image' }, rendered: 'an object' },
      { type: new Date(0), rendered: 'an object (Date)' },
      { type: new URL('https://example.invalid/'), rendered: 'an object (URL)' },
      { type: new String('image'), rendered: 'an object (String)' },
      // A non-finite number renders as written, not as JSON's `null`.
      { type: NaN, rendered: 'NaN' },
      { type: Infinity, rendered: 'Infinity' },
      // JSON cannot render these at all — a bigint throws, a function and a symbol stringify to
      // `undefined` — so each reads as its typeof, and the validator does not throw. These rows
      // are what pins the try/catch and the fallback: delete either and a row here reds.
      { type: 10n, rendered: 'bigint' },
      { type: () => 'image', rendered: 'function' },
      { type: Symbol('image'), rendered: 'symbol' },
    ])(
      'names binaryFormats.<n>.type when the type is $type rather than a string',
      ({ type, rendered }) => {
        const result = validateRawGthConfig({
          llm: { type: 'anthropic' },
          binaryFormats: [{ type, extensions: ['png'] }],
        });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('binaryFormats.0.type');
        expect(result.errorMessage).toContain(`${rendered} is not a string — `);
        expect(result.errorMessage).toContain('image, file, audio');
      }
    );

    it('names the per-command path when the entry is under commands.<cmd>', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        commands: { review: { binaryFormats: [{ extensions: ['png'] }] } },
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.review.binaryFormats.0.type');
      expect(result.errorMessage).toContain(
        'commands.review.binaryFormats.0.type: missing — every binaryFormats entry'
      );
    });

    it('reports a missing type and an undeliverable one side by side, each at its own index', () => {
      const result = validateRawGthConfig({
        llm: { type: 'anthropic' },
        binaryFormats: [{ extensions: ['png'] }, { type: 'video', extensions: ['mp4'] }],
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('binaryFormats.0.type');
      expect(result.errorMessage).toContain(
        'binaryFormats.1.type: "video" is not a binary format type'
      );
    });

    // CONTROL — the CFG-68 sentence is byte-for-byte what it was. Widening the scan to shape must
    // not reword the vocabulary message it already sends; a rewording reds here.
    it('CONTROL — the undeliverable-value message is unchanged', () => {
      expect(undeliverableBinaryFormatMessage('imgae')).toBe(
        '"imgae" is not a binary format type any model provider can receive. Attachments reach a ' +
          'model as image, file, audio; a block of any other type is rejected when the request is ' +
          'built — on every provider, after the file has already been read. Use one of image, ' +
          'file, audio, or remove the entry.'
      );
    });
  });

  describe('deprecated-shape rejection (GS2-28)', () => {
    it('flags a top-level command key, naming commands.<cmd> + migration path', () => {
      const issues = findDeprecatedConfigIssues({ llm: { type: 'openai' }, pr: { rating: {} } });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('pr');
      expect(issues[0].message).toContain('commands.pr');
      expect(issues[0].message).toContain(MIGRATION_DOC_URL);
    });

    it('flags every command name used at the root', () => {
      const raw: Record<string, unknown> = { llm: { type: 'openai' } };
      for (const cmd of ['pr', 'review', 'ask', 'chat', 'code', 'exec', 'api']) {
        raw[cmd] = {};
      }
      const paths = findDeprecatedConfigIssues(raw).map((i) => i.path);
      expect(paths).toEqual(['pr', 'review', 'ask', 'chat', 'code', 'exec', 'api']);
    });

    it('flags deprecated *Provider* names at the root, naming the *Source* replacement', () => {
      const issues = findDeprecatedConfigIssues({
        contentProvider: 'github',
        requirementsProvider: 'jira',
        contentProviderConfig: {},
        requirementsProviderConfig: {},
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath.contentProvider).toContain('contentSource');
      expect(byPath.requirementsProvider).toContain('requirementSource');
      expect(byPath.contentProviderConfig).toContain('contentSourceConfig');
      expect(byPath.requirementsProviderConfig).toContain('requirementSourceConfig');
    });

    it('flags deprecated *Provider* names inside a commands.<name> block', () => {
      const issues = findDeprecatedConfigIssues({
        commands: { pr: { requirementsProvider: 'jira', contentProvider: 'github' } },
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath['commands.pr.requirementsProvider']).toContain('requirementSource');
      expect(byPath['commands.pr.contentProvider']).toContain('contentSource');
    });

    it('flags a removed per-command devTools key, naming builtInTools + the migration path (CFG-18)', () => {
      const issues = findDeprecatedConfigIssues({
        llm: { type: 'openai' },
        commands: { code: { devTools: { run_tests: 'npm test' } } },
      });
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toBe('commands.code.devTools');
      expect(issues[0].message).toContain('no longer supported in 2.0');
      expect(issues[0].message).toContain('builtInTools');
      expect(issues[0].message).toContain(MIGRATION_DOC_URL);
    });

    it('validateRawGthConfig HARD-rejects commands.<cmd>.devTools (NOT a silent strip)', () => {
      const result = validateRawGthConfig({
        llm: { type: 'openai' },
        commands: { exec: { devTools: { run_shell_command: { yolo: true } } } },
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.exec.devTools');
      expect(result.errorMessage).toContain('builtInTools');
      // The removed shape is rejected, not doubled as an unknown-key warning.
      expect(result.warnings).toEqual([]);
    });

    /**
     * CFG-26 — the four retired approval knobs moved off the SHARED per-tool object onto the
     * top-level `approvals` block. They must be hard errors that NAME the new key at BOTH
     * locations they could be written (root and per-command), because `builtInToolConfigSchema`
     * is a strict `z.object`: once the field is gone zod silently STRIPS it, and a config would
     * run with its approval posture quietly ignored.
     */
    describe('retired run_shell_command approval knobs (CFG-26)', () => {
      // CFG-27 rescaled the replacements these messages name: the rung IS the setting, so
      // `yolo` points at the `bypass` rung, `allowlist` at the declared `approvals.allow` list,
      // and `persistAllowlist` at nothing (persistence is a per-decision choice now).
      const RETIRED = {
        yolo: '"approvals": "bypass"',
        judge: 'approvals.rater',
        allowlist: 'approvals.allow',
        persistAllowlist: 'per-decision choice at the approval prompt',
      } as const;

      for (const [key, replacement] of Object.entries(RETIRED)) {
        it(`flags ${key} at the ROOT builtInTools registry, naming ${replacement}`, () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            builtInTools: { run_shell_command: { enabled: true, [key]: true } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe(`builtInTools.run_shell_command.${key}`);
          expect(issues[0].message).toContain('no longer supported in 2.0');
          expect(issues[0].message).toContain(replacement);
          expect(issues[0].message).toContain(MIGRATION_DOC_URL);
        });

        it(`flags ${key} at commands.<cmd>.builtInTools, naming ${replacement}`, () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            commands: { code: { builtInTools: { run_shell_command: { [key]: true } } } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe(`commands.code.builtInTools.run_shell_command.${key}`);
          expect(issues[0].message).toContain(replacement);
        });

        it(`validateRawGthConfig HARD-rejects ${key} (never a silent strip)`, () => {
          const result = validateRawGthConfig({
            llm: { type: 'openai' },
            builtInTools: { run_shell_command: { [key]: true } },
          });
          expect(result.ok).toBe(false);
          expect(result.errorMessage).toContain(`builtInTools.run_shell_command.${key}`);
          expect(result.errorMessage).toContain(replacement);
          expect(result.warnings).toEqual([]);
        });
      }

      it('the retired judge message names the RUNG that replaced the low/medium/high knobs', () => {
        const issues = findDeprecatedConfigIssues({
          builtInTools: {
            run_shell_command: { judge: { autoApproveLow: false, blockHigh: true } },
          },
        });
        expect(issues[0].message).toContain('assisted');
        expect(issues[0].message).toContain('auto');
        expect(issues[0].message).toContain('safe/destructive/catastrophic/attack');
      });

      it('reports EVERY retired knob present, not just the first', () => {
        const issues = findDeprecatedConfigIssues({
          builtInTools: {
            run_shell_command: {
              yolo: true,
              judge: true,
              allowlist: false,
              persistAllowlist: false,
            },
          },
        });
        expect(issues.map((i) => i.path).sort()).toEqual([
          'builtInTools.run_shell_command.allowlist',
          'builtInTools.run_shell_command.judge',
          'builtInTools.run_shell_command.persistAllowlist',
          'builtInTools.run_shell_command.yolo',
        ]);
      });

      it('does not fire on the legacy string[] builtInTools form, or on another tool', () => {
        expect(
          findDeprecatedConfigIssues({
            builtInTools: ['run_shell_command', 'gth_grep'],
          })
        ).toEqual([]);
        // `gth_grep: { yolo: true }` used to VALIDATE — the knob was on the shared object. It is
        // now simply an unknown key on that tool's entry (stripped), not a run_shell_command knob.
        expect(findDeprecatedConfigIssues({ builtInTools: { gth_grep: { yolo: true } } })).toEqual(
          []
        );
      });
    });

    /**
     * CFG-27 — the `approvals` value itself: the scalar-or-object union, what the enum refuses,
     * and the retired keys / retired mode values that must hard-error naming the rung.
     */
    describe('approvals (CFG-27 ladder)', () => {
      const parse = (approvals: unknown) =>
        rawGthConfigSchema.safeParse({ llm: { type: 'openai' }, approvals });

      const RUNGS = ['manual', 'write', 'assisted', 'auto', 'bypass'] as const;

      it.each(RUNGS)('accepts the bare rung name "%s" (§9.1 scalar sugar)', (rung) => {
        const result = parse(rung);
        expect(result.success).toBe(true);
        if (result.success) {
          expect((result.data as Record<string, unknown>).approvals).toBe(rung);
        }
      });

      it('parses a full valid object and preserves every field', () => {
        const approvals = {
          mode: 'assisted',
          rater: 'safety-rater',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
          deny: [{ type: 'shell', matcher: 'glob', pattern: 'npm publish*' }],
          escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
        };
        const result = parse(approvals);
        expect(result.success).toBe(true);
        if (result.success) {
          expect((result.data as Record<string, unknown>).approvals).toEqual(approvals);
        }
      });

      it('rejects an unknown rung, in either form', () => {
        expect(parse('yolo').success).toBe(false);
        expect(parse({ mode: 'yolo' }).success).toBe(false);
      });

      it('rejects a rater that is not a bare string (the object/boolean forms are retired)', () => {
        expect(parse({ mode: 'assisted', rater: { profile: 'x' } }).success).toBe(false);
        expect(parse({ mode: 'assisted', rater: true }).success).toBe(false);
      });

      it('parses per-command approvals on every command, scalar and object alike', () => {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'openai' },
          commands: {
            pr: { approvals: 'manual' },
            review: { approvals: 'manual' },
            ask: { approvals: { mode: 'write' } },
            chat: { approvals: 'assisted' },
            code: { approvals: { mode: 'assisted', rater: 'safety-rater' } },
            exec: { approvals: 'bypass' },
            api: { approvals: 'manual' },
          },
        });
        expect(result.success).toBe(true);
      });

      /**
       * The CFG-26 migration UX, rescaled: a retired key or a retired `mode` VALUE is a hard
       * error naming the rung that replaced it. `approvalsSchema`'s object arm is a `z.object`,
       * which silently STRIPS unknown keys — so without the pre-parse reject an
       * `approvals: { mode: "assisted", strictness: "strict" }` would run with its declared
       * posture quietly ignored, which is the worst possible failure for a safety gate.
       */
      describe('retired approvals keys and mode values (CFG-27)', () => {
        // EXT-71 gave `escalate` back as the third rule LIST, so it is no longer in this table;
        // its retired THRESHOLD shape is pinned separately below.
        const RETIRED_KEYS = ['strictness', 'allowlist', 'persistAllowlist'] as const;

        for (const key of RETIRED_KEYS) {
          it(`hard-errors on ${key} at the ROOT approvals value`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: { mode: 'assisted', [key]: 'whatever' },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe(`approvals.${key}`);
            expect(issues[0].message).toContain('no longer supported');
            // The message NAMES the ladder, so the user learns what replaced the knob.
            expect(issues[0].message).toContain('manual, write, assisted, auto, bypass');
            expect(issues[0].message).toContain(MIGRATION_DOC_URL);
          });

          it(`hard-errors on ${key} at commands.<cmd>.approvals too`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              commands: { code: { approvals: { mode: 'assisted', [key]: 'whatever' } } },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe(`commands.code.approvals.${key}`);
          });

          it(`validateRawGthConfig HARD-rejects ${key} (never a silent strip)`, () => {
            const result = validateRawGthConfig({
              llm: { type: 'openai' },
              approvals: { mode: 'assisted', [key]: 'whatever' },
            });
            expect(result.ok).toBe(false);
            expect(result.errorMessage).toContain(`approvals.${key}`);
            expect(result.warnings).toEqual([]);
          });
        }

        /**
         * CFG-31 — `strictness` is the one retired key whose message DESCRIBES the ladder instead
         * of naming a replacement key, so it goes stale whenever the modes change and nothing else
         * catches it. It has been wrong once already: it put `auto` on a different footing from
         * `assisted`, a divergence the rated modes do not have — `mapVerdictToAction` has no branch
         * on `auto`, so anything not rated safe reaches the human at both. This cell pins the
         * statement AND the absence of that false clause, so a message that splits the two rated
         * modes fails here rather than shipping as migration advice.
         */
        it('the retired strictness message describes the ladder without splitting the rated modes', () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            approvals: { mode: 'assisted', strictness: 'strict' },
          });
          expect(issues).toHaveLength(1);
          const message = issues[0].message;
          expect(message).toContain('there are no strictness levels any more');
          expect(message).toContain('"manual"/"write" never rate');
          expect(message).toContain('"assisted" and "auto" escalate anything not rated safe');
          expect(message).toContain('"bypass" rates nothing');
          expect(message).not.toContain('lets the auto-rater decide');
        });

        /**
         * The retired `mode` spelling and the mode it names now. `ask` maps to the two modes that
         * ask about everything, and the message offers both. **The mapping is equally- or
         * less-permissive**, which is the property this table exists to keep: a retired name
         * silently remapped to something more permissive would raise a user's autonomy setting on
         * their behalf.
         *
         * **Only a value whose MEANING changed earns a row**, which is why this table holds one
         * entry rather than four. A value that merely acquired a new spelling is a spelling nobody
         * has, so it is an ordinary unrecognised value — the block below pins that.
         *
         * `auto` is deliberately NOT here — it is now the canonical name of the most permissive
         * rated mode, and the cell below pins that it validates rather than erroring.
         */
        const RETIRED_MODES = {
          ask: 'write',
        } as const;

        for (const [retired, rung] of Object.entries(RETIRED_MODES)) {
          it(`hard-errors on the retired mode "${retired}", naming ${rung}`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: { mode: retired },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('approvals.mode');
            expect(issues[0].message).toContain(rung);
            // CFG-39/CFG-31 settled on ONE noun for the user-facing vocabulary: mode, not rung.
            expect(issues[0].message).toContain('ladder of five modes');
            expect(issues[0].message).not.toContain('rung');
          });

          it(`hard-errors on the retired SCALAR "${retired}" too, naming ${rung}`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: retired,
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('approvals');
            expect(issues[0].message).toContain(rung);
          });

          it(`hard-errors on the retired mode "${retired}" per command`, () => {
            const issues = findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              commands: { pr: { approvals: retired } },
            });
            expect(issues).toHaveLength(1);
            expect(issues[0].path).toBe('commands.pr.approvals');
          });
        }

        /**
         * CFG-60 — `ask` is the one retired spelling that survives, and it survives because it is
         * NOT a rename: it maps across two modes, so dropping it would drop a real migration rather
         * than a stale alias. Both replacements have to be offered, and this is the pair that proves
         * the CFG-60 removal was surgical rather than wholesale.
         */
        it('the retired mode "ask" names BOTH replacements, at the root and per command', () => {
          for (const raw of [
            { llm: { type: 'openai' }, approvals: 'ask' },
            { llm: { type: 'openai' }, approvals: { mode: 'ask' } },
            { llm: { type: 'openai' }, commands: { pr: { approvals: 'ask' } } },
            { llm: { type: 'openai' }, commands: { pr: { approvals: { mode: 'ask' } } } },
          ]) {
            const issues = findDeprecatedConfigIssues(raw);
            expect(issues, `${JSON.stringify(raw)} must carry migration advice`).toHaveLength(1);
            expect(issues[0].message).toContain('"write"');
            expect(issues[0].message).toContain('"manual"');
            expect(issues[0].message).toContain(MIGRATION_DOC_URL);
          }
        });

        /**
         * CFG-60 — the alpha-era spellings `read-only` / `auto-safe` / `full-auto` were renamed
         * inside 2.0 alpha and their migration entries are gone with them. They are ordinary
         * unrecognised values now: still rejected, but by the enum, with NO message naming a
         * replacement and no migration pointer.
         *
         * Pinned as a PAIR — `findDeprecatedConfigIssues` silent AND the config still invalid —
         * because either half alone would also pass if the value had quietly become *valid*, which
         * is the one outcome that would raise a user's autonomy setting without them choosing it.
         * Pinned at the root and per command because the removal has to hold on both paths.
         */
        for (const removed of ['read-only', 'auto-safe', 'full-auto']) {
          it(`"${removed}" is an unrecognised value now — rejected, naming no replacement`, () => {
            for (const raw of [
              { llm: { type: 'openai' }, approvals: removed },
              { llm: { type: 'openai' }, approvals: { mode: removed } },
              { llm: { type: 'openai' }, commands: { pr: { approvals: removed } } },
              { llm: { type: 'openai' }, commands: { pr: { approvals: { mode: removed } } } },
            ]) {
              const where = JSON.stringify(raw);
              expect(
                findDeprecatedConfigIssues(raw),
                `${where} must carry no migration advice`
              ).toEqual([]);
              const result = validateRawGthConfig(raw);
              expect(result.ok, `${where} must still be invalid`).toBe(false);
              expect(result.errorMessage).not.toContain('no longer supported');
              expect(result.errorMessage).not.toContain(MIGRATION_DOC_URL);
            }
          });
        }

        it('hard-errors on the retired OBJECT rater form, pointing at the bare profile name', () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            approvals: { mode: 'assisted', rater: { profile: 'safety-rater' } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe('approvals.rater');
          expect(issues[0].message).toContain('bare identity-profile name');
        });

        /**
         * CFG-39 — **`auto` is a valid mode and must not error.** It also named a pre-2.0 mode, so
         * a retired-mode entry for it is the easy mistake: one left in the table makes the
         * canonical name of the most permissive rated mode a hard validation error on arrival.
         * This is the cell that fails if such an entry ever appears.
         */
        it('CFG-39: "auto" VALIDATES — it is the canonical name, not a retired one', () => {
          for (const approvals of ['auto', { mode: 'auto' }] as const) {
            expect(
              findDeprecatedConfigIssues({ llm: { type: 'openai' }, approvals }),
              `approvals: ${JSON.stringify(approvals)} must not be a deprecated shape`
            ).toEqual([]);
          }
          const result = validateRawGthConfig({ llm: { type: 'openai' }, approvals: 'auto' });
          expect(result.ok, result.errorMessage).toBe(true);
        });

        it('reports EVERY retired key present, not just the first', () => {
          const issues = findDeprecatedConfigIssues({
            approvals: { mode: 'ask', strictness: 'strict', escalate: 'danger' },
          });
          expect(issues.map((i) => i.path).sort()).toEqual([
            'approvals.escalate',
            'approvals.mode',
            'approvals.strictness',
          ]);
        });

        /**
         * EXT-71 — `escalate` is the one retired name that came BACK, as the third rule list. The
         * pair below is the whole rule: the retired THRESHOLD shape (a string) still errors with a
         * message naming the rung that expresses the old intent, and the new LIST shape does not
         * error at all. Testing only the first would pass just as well if `escalate` were still
         * banned outright, which is the exact thing this node changed.
         */
        it('hard-errors on the retired escalate THRESHOLD (a non-array), naming the new shape', () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            approvals: { mode: 'assisted', escalate: 'danger' },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe('approvals.escalate');
          expect(issues[0].message).toContain('third rule LIST');
          expect(issues[0].message).toContain('not a severity threshold');
          expect(issues[0].message).toContain(MIGRATION_DOC_URL);
        });

        it('hard-errors on the retired escalate threshold at commands.<cmd>.approvals too', () => {
          const issues = findDeprecatedConfigIssues({
            llm: { type: 'openai' },
            commands: { code: { approvals: { mode: 'assisted', escalate: 'danger' } } },
          });
          expect(issues).toHaveLength(1);
          expect(issues[0].path).toBe('commands.code.approvals.escalate');
        });

        it('does NOT fire on the new escalate LIST — the control for the row above', () => {
          expect(
            findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: {
                mode: 'assisted',
                escalate: [{ type: 'shell', matcher: 'exact', pattern: 'terraform apply' }],
              },
            })
          ).toEqual([]);
          expect(
            findDeprecatedConfigIssues({
              llm: { type: 'openai' },
              approvals: { mode: 'assisted', escalate: [] },
            })
          ).toEqual([]);
        });

        it('does not fire on a valid ladder config, scalar or object', () => {
          expect(findDeprecatedConfigIssues({ approvals: 'assisted' })).toEqual([]);
          expect(
            findDeprecatedConfigIssues({
              approvals: {
                mode: 'auto',
                rater: 'safety-rater',
                allow: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
              },
            })
          ).toEqual([]);
        });
      });

      /**
       * The emitted JSON Schema feeds the hosted /schema/v2/ + /schema/alpha/ channels, so the
       * union must be describable there. CFG-27 leaves NO refinement on `approvals` at all — with
       * `rater` flattened to a bare string and `rater: false` gone there is no coupling rule left
       * to enforce — so what is checked here is that the union itself emitted correctly.
       */
      describe('the emitted JSON Schema', () => {
        it('emits the scalar|object union as an anyOf, with no refinement leakage', () => {
          const generated = generateConfigJsonSchema();
          const approvals = (generated.properties as Record<string, Record<string, unknown>>)
            .approvals;
          expect(Object.keys(approvals)).toEqual(['anyOf']);
          const arms = approvals.anyOf as Array<Record<string, unknown>>;
          expect(arms).toHaveLength(2);
          expect(arms[0].enum).toEqual([...RUNGS]);
          expect(Object.keys(arms[1].properties as object).sort()).toEqual([
            'alignmentChecker',
            'allow',
            'deny',
            'escalate',
            'mcp',
            'mode',
            'rater',
            'raterTimeoutMs',
          ]);
          // A refinement has no JSON Schema representation; nothing of that shape may appear.
          // Matched as emitted KEYWORDS rather than as bare substrings: a property NAME may
          // legitimately contain those letters (`trustAnnotations` contains "not"), and a check
          // that a schema keyword is absent must not be answerable by the vocabulary.
          expect(JSON.stringify(approvals)).not.toContain('"not":');
          expect(JSON.stringify(approvals)).not.toContain('"allOf":');
        });

        it('describes approvals in ALL EIGHT positions (root + each per-command block)', () => {
          const generated = generateConfigJsonSchema() as Record<string, any>;
          const positions = [generated.properties.approvals];
          const commands = generated.properties.commands.properties as Record<string, any>;
          for (const name of Object.keys(commands)) {
            positions.push(commands[name].properties.approvals);
          }
          expect(positions).toHaveLength(8);
          for (const position of positions) {
            expect(position.anyOf).toHaveLength(2);
            expect(position.anyOf[0].enum).toEqual([...RUNGS]);
          }
        });
      });
    });

    /**
     * CFG-26 — `approvals.rater.profile` references, collected purely so the LOADER can enforce
     * GS2-62 strict resolution against the filesystem.
     */
    /**
     * CFG-26 Task 2 — `gth config validate` must agree with the loader. Before this, the read-side
     * validator had no profile check at all, so it green-lit a config the very next real run
     * hard-exits on: a validator that passes what the runtime refuses is worse than none. The
     * resolver is INJECTED so `schema.ts` stays pure.
     */
    describe('validateRawGthConfig + approvals.rater resolution (CFG-26, flattened by CFG-27)', () => {
      const config = {
        llm: { type: 'openai' },
        approvals: { mode: 'assisted', rater: 'safety-rater' },
      };

      it('rejects an unresolvable rater profile, naming the path and the profile', () => {
        const result = validateRawGthConfig(config, { resolveProfile: () => false });
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('approvals.rater');
        expect(result.errorMessage).toContain('identity profile "safety-rater" not found');
      });

      it('accepts it when the profile resolves', () => {
        expect(validateRawGthConfig(config, { resolveProfile: () => true }).ok).toBe(true);
      });

      it('checks per-command profiles too', () => {
        const result = validateRawGthConfig(
          {
            llm: { type: 'openai' },
            commands: { code: { approvals: { rater: 'nope' } } },
          },
          { resolveProfile: () => false }
        );
        expect(result.ok).toBe(false);
        expect(result.errorMessage).toContain('commands.code.approvals.rater');
      });

      it('skips the check entirely with no resolver, so pure/in-memory callers are unaffected', () => {
        // The profile scaffolder validates a config it is about to WRITE; it has no business
        // touching the filesystem to do it.
        expect(validateRawGthConfig(config).ok).toBe(true);
      });

      it('shares ONE message with the loader, so the two surfaces cannot drift', () => {
        const result = validateRawGthConfig(config, { resolveProfile: () => false });
        expect(result.errorMessage).toContain(
          unresolvedRaterProfileMessage({ path: 'approvals.rater', profile: 'safety-rater' })
        );
      });
    });

    describe('findApprovalsRaterProfiles (CFG-26)', () => {
      it('collects root and per-command profile references with their config paths', () => {
        expect(
          findApprovalsRaterProfiles({
            approvals: { rater: 'root-rater' },
            commands: {
              code: { approvals: { rater: 'code-rater' } },
              exec: { approvals: 'write' },
            },
          })
        ).toEqual([
          { path: 'approvals.rater', profile: 'root-rater' },
          { path: 'commands.code.approvals.rater', profile: 'code-rater' },
        ]);
      });

      it('ignores an absent / blank / non-string rater, and the scalar sugar form', () => {
        expect(findApprovalsRaterProfiles({ approvals: { mode: 'assisted' } })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: 'assisted' })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: { rater: true } })).toEqual([]);
        expect(findApprovalsRaterProfiles({ approvals: { rater: '  ' } })).toEqual([]);
        expect(findApprovalsRaterProfiles({})).toEqual([]);
      });
    });

    it('does NOT flag a genuinely-unknown key or the canonical shapes', () => {
      expect(
        findDeprecatedConfigIssues({
          llm: { type: 'openai' },
          pulrequest: {},
          contentSource: 'file',
          commands: { pr: { contentSource: 'github', requirementSource: 'jira' } },
        })
      ).toEqual([]);
    });

    it('formats issues as the same `  - <path>: <message>` block as schema errors', () => {
      const rendered = formatDeprecatedConfigIssues(
        findDeprecatedConfigIssues({ pr: {}, contentProvider: 'github' })
      );
      expect(rendered).toContain('  - pr: ');
      expect(rendered).toContain('  - contentProvider: ');
    });

    it('validateRawGthConfig hard-rejects a top-level command key (ok:false, no warning)', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, review: {} });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('commands.review');
      // The removed shape is rejected, not doubled as an unknown-key warning.
      expect(result.warnings).toEqual([]);
    });

    it('validateRawGthConfig hard-rejects a deprecated *Provider* name naming its *Source*', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, contentProvider: 'github' });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain('contentSource');
    });

    it('validateRawGthConfig still WARNS (does not fail) on a genuine typo key', () => {
      const result = validateRawGthConfig({ llm: { type: 'openai' }, pulrequest: 123 });
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.includes('pulrequest'))).toBe(true);
    });

    it('validateRawGthConfig accepts the canonical shapes clean', () => {
      const result = validateRawGthConfig({
        llm: { type: 'openai' },
        contentSource: 'file',
        commands: { pr: { contentSource: 'github', rating: { enabled: false } } },
      });
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    });

    it('validateRawGthConfig does NOT throw on a non-object config (null/array); clean ok:false', () => {
      // A config file that is just `null` (or a module configure() returning null/an array) must
      // not throw a raw TypeError from the key scans — safeParse reports an "expected object" error.
      for (const bad of [null, [], 'oops'] as const) {
        const result = validateRawGthConfig(bad as unknown as Record<string, unknown>);
        expect(result.ok).toBe(false);
        expect(result.errorMessage?.toLowerCase()).toContain('object');
      }
    });
  });

  describe('prompts object (GS2-43)', () => {
    const SEGMENTS = ['backstory', 'guidelines', 'system', 'chat', 'code', 'exec', 'review'];

    it('accepts the string (path shorthand) form for every segment', () => {
      for (const segment of SEGMENTS) {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          prompts: { [segment]: 'SOME-FILE.md' },
        });
        expect(result.success, `string form for ${segment}`).toBe(true);
      }
    });

    it('accepts the object form ({ path, enabled, mode }) for every segment', () => {
      for (const segment of SEGMENTS) {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'anthropic' },
          prompts: { [segment]: { path: 'SOME-FILE.md', enabled: true, mode: 'append' } },
        });
        expect(result.success, `object form for ${segment}`).toBe(true);
      }
    });

    it('accepts partial object forms ({ enabled: false } alone, { path } alone)', () => {
      expect(
        rawGthConfigSchema.safeParse({ prompts: { review: { enabled: false } } }).success
      ).toBe(true);
      expect(
        rawGthConfigSchema.safeParse({ prompts: { guidelines: { path: 'AGENTS.md' } } }).success
      ).toBe(true);
    });

    it('rejects an invalid mode with a path-scoped error', () => {
      const result = rawGthConfigSchema.safeParse({
        prompts: { guidelines: { path: 'AGENTS.md', mode: 'prepend' } },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('prompts.guidelines');
      }
    });

    it('treats prompts as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, prompts: { guidelines: 'AGENTS.md' } })).toEqual(
        []
      );
    });

    it('flags the removed flat keys, naming the prompts.* replacement + migration path', () => {
      const issues = findDeprecatedConfigIssues({
        llm: { type: 'openai' },
        projectGuidelines: 'AGENTS.md',
        projectReviewInstructions: 'REVIEW.md',
      });
      const byPath = Object.fromEntries(issues.map((i) => [i.path, i.message]));
      expect(byPath.projectGuidelines).toContain('prompts.guidelines');
      expect(byPath.projectGuidelines).toContain(MIGRATION_DOC_URL);
      expect(byPath.projectReviewInstructions).toContain('prompts.review');
      expect(byPath.projectReviewInstructions).toContain(MIGRATION_DOC_URL);
    });

    it('validateRawGthConfig HARD-rejects each removed flat key (ok:false, no warning)', () => {
      for (const [removed, replacement] of [
        ['projectGuidelines', 'prompts.guidelines'],
        ['projectReviewInstructions', 'prompts.review'],
      ] as const) {
        const result = validateRawGthConfig({ llm: { type: 'openai' }, [removed]: 'X.md' });
        expect(result.ok, removed).toBe(false);
        expect(result.errorMessage).toContain(removed);
        expect(result.errorMessage).toContain(replacement);
        // Rejected as a removed shape — never doubled as an unknown-key warning.
        expect(result.warnings).toEqual([]);
      }
    });
  });

  describe('agent.backend selector (GS2-2 B5, narrowed by EXT-114)', () => {
    it("accepts agent.backend 'lean'", () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        agent: { backend: 'lean' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects an invalid agent.backend value with a path-scoped message', () => {
      const result = rawGthConfigSchema.safeParse({
        llm: { type: 'openai' },
        agent: { backend: 'medium' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(formatConfigValidationError(result.error)).toContain('agent.backend');
      }
    });

    it('treats agent as a known top-level key (no unknown-key warning)', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, agent: { backend: 'lean' } })).toEqual([]);
    });

    it('accepts a config that omits agent (undefined ⇒ lean)', () => {
      const result = rawGthConfigSchema.safeParse({ llm: { type: 'openai' } });
      expect(result.success).toBe(true);
    });

    /**
     * EXT-114 — the retired `deep` backend. The pair below is the whole rule, and both halves are
     * load-bearing: `deep` must NOT be coerced to `lean` (a config asking for a runtime that no
     * longer exists must be told so, not quietly handed a different agent), and `lean` must NOT be
     * caught by the same net.
     */
    describe('the retired deep backend (EXT-114)', () => {
      it('hard-errors on agent.backend: deep, naming lean and what deep took with it', () => {
        const issues = findDeprecatedConfigIssues({
          llm: { type: 'openai' },
          agent: { backend: 'deep' },
        });
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toBe('agent.backend');
        expect(issues[0].message).toContain('deep');
        expect(issues[0].message).toContain('lean');
        // Names what actually leaves, so a user who chose `deep` on purpose can tell whether they
        // are losing something they used.
        expect(issues[0].message).toContain('task');
        // The migration pointer every deprecated-shape message carries.
        expect(issues[0].message).toContain('MIGRATION.md');
      });

      it('does not fire on the surviving lean value, nor on an absent agent block', () => {
        expect(
          findDeprecatedConfigIssues({ llm: { type: 'openai' }, agent: { backend: 'lean' } })
        ).toEqual([]);
        expect(findDeprecatedConfigIssues({ llm: { type: 'openai' }, agent: {} })).toEqual([]);
        expect(findDeprecatedConfigIssues({ llm: { type: 'openai' } })).toEqual([]);
      });

      /**
       * The pre-parse check is what produces the migration message, but the enum has to reject the
       * value too — otherwise a caller that parses without the deprecation scan (or a future
       * refactor that drops it) would accept `deep` and run lean silently, which is the exact
       * substitution the hard error exists to prevent.
       */
      it('the enum rejects deep as well, so nothing accepts it by another route', () => {
        const result = rawGthConfigSchema.safeParse({
          llm: { type: 'openai' },
          agent: { backend: 'deep' },
        });
        expect(result.success).toBe(false);
      });
    });
  });

  // CFG-37 — `tui` is a real config key, not just a CLI-flag carrier.
  describe('tui', () => {
    it('accepts both booleans and rejects a non-boolean with a path-scoped message', () => {
      expect(rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' }, tui: false }).success).toBe(
        true
      );
      expect(rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' }, tui: true }).success).toBe(
        true
      );
      const bad = rawGthConfigSchema.safeParse({ llm: { type: 'anthropic' }, tui: 'yes' });
      expect(bad.success).toBe(false);
      if (!bad.success) {
        expect(formatConfigValidationError(bad.error)).toContain('tui');
      }
    });

    it('is a KNOWN top-level key, so a config that sets it warns about nothing', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, tui: false })).toEqual([]);
      expect(validateRawGthConfig({ llm: { type: 'anthropic' }, tui: false })).toEqual({
        ok: true,
        warnings: [],
      });
    });

    it('is advertised by the published JSON Schema (editor autocomplete)', () => {
      const generated = generateConfigJsonSchema() as {
        properties: Record<string, { type?: string }>;
      };
      expect(generated.properties.tui).toEqual({ type: 'boolean' });
    });
  });

  /**
   * EXT-117 — `acp` is a real config key, and the zod entry is what makes it one.
   *
   * `rawGthConfigSchema` is a `looseObject`, so the key reaches the read site whether or not zod
   * declares it — which means the resolution specs in `acpSessionMode.spec.ts` stay green with the
   * entry deleted, while the loader tells the user their `acp` block is an unknown key that is
   * "kept as-is but ignored". These two cells are what catch that, as the symptom rather than as a
   * golden-file mismatch.
   */
  describe('acp', () => {
    it('is a KNOWN top-level key, so a config that sets it warns about nothing', () => {
      expect(findUnknownTopLevelKeys({ llm: {}, acp: { mode: 'chat' } })).toEqual([]);
      expect(validateRawGthConfig({ llm: { type: 'anthropic' }, acp: { mode: 'chat' } })).toEqual({
        ok: true,
        warnings: [],
      });
    });

    it('rejects a mode that is not an ACP session mode, with a path-scoped message', () => {
      // The reason the schema uses `z.enum` over `z.string`: `exec` is a real `GthCommand`, so only
      // the enum can say that it is not one an ACP session may be resolved under.
      const bad = rawGthConfigSchema.safeParse({
        llm: { type: 'anthropic' },
        acp: { mode: 'exec' },
      });
      expect(bad.success).toBe(false);
      if (!bad.success) expect(formatConfigValidationError(bad.error)).toContain('acp.mode');
    });
  });

  describe('JSON Schema generation (golden snapshot)', () => {
    it('matches the committed schema file', () => {
      const generated = generateConfigJsonSchema();
      const committed = readJson(committedSchemaPath);
      expect(generated).toEqual(committed);
    });
  });
});
