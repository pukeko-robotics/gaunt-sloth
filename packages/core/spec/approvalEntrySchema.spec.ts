import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ENTRY_MATCHERS,
  APPROVAL_ENTRY_TYPES,
  APPROVAL_REGEXP_MAX_LENGTH,
  approvalEntrySchema,
  generateConfigJsonSchema,
  HINT_ANNOTATION_KEYS,
  renderApprovalEntryForString,
  validateRawGthConfig,
} from '#src/config/schema.js';
import type { ApprovalEntry } from '#src/config/shell-policy.js';

/**
 * EXT-71 §3.1 — the rule entry grammar, as the CONFIG CHANNEL sees it.
 *
 * Nearly every requirement in this node is a negative one ("X is a load error"), and a negative
 * assertion is the shape that passes whether or not the code it names exists. So every rejection
 * below ships with the well-formed sibling that must still be accepted, in the same `it`. If a
 * constraint were deleted, the rejection half goes red; if a constraint were widened into a
 * blanket refusal, the control half goes red. Neither half alone would catch both.
 *
 * Assertions run through {@link validateRawGthConfig} rather than the zod schema directly, because
 * that is the function both real entry points share (the loader's `validateRawConfigLayer` and
 * `gth config validate`), and because two of the rules — the bare-string migration message and the
 * reserved server name — are checked BEFORE the parse and would be invisible to a bare `safeParse`.
 */

const BASE = { llm: { type: 'openai' } } as const;

/** Validate a config carrying `approvals`, exactly as a real load would. */
function validate(approvals: unknown, extra: Record<string, unknown> = {}) {
  return validateRawGthConfig({ ...BASE, approvals, ...extra });
}

/** Validate a config whose `allow` list holds exactly `entry`. */
function validateEntry(entry: unknown, list: 'allow' | 'deny' | 'escalate' = 'allow') {
  return validate({ mode: 'auto-safe', [list]: [entry] });
}

function expectAccepted(result: ReturnType<typeof validateRawGthConfig>): void {
  expect(result.errorMessage ?? '').toBe('');
  expect(result.ok).toBe(true);
}

function expectRejected(result: ReturnType<typeof validateRawGthConfig>): string {
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toBeTruthy();
  return result.errorMessage as string;
}

/** The seven forms §3.1 writes out. Typed, so the hand-written type has to admit each of them. */
const SPEC_ENTRIES: ApprovalEntry[] = [
  { type: 'shell', matcher: 'exact', pattern: 'npm test' },
  { type: 'shell', matcher: 'glob', pattern: 'git status*' },
  { type: 'shell', matcher: 'regexp', pattern: '^git commit -m \\S' },
  { type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' },
  { type: 'mcpTool', server: 'jira', matcher: 'exact', pattern: 'delete_issue' },
  { type: 'mcpTool', server: 'jira', matcher: 'hint', pattern: { destructiveHint: true } },
  {
    type: 'mcpTool',
    server: 'fetcher',
    matcher: 'exact',
    pattern: 'fetch_url',
    host: 'docs.internal.example',
  },
];

describe('approvals rule entry grammar (EXT-71 §3.1)', () => {
  describe('the vocabulary', () => {
    it('is exactly three subjects and four comparisons', () => {
      expect([...APPROVAL_ENTRY_TYPES]).toEqual(['shell', 'tool', 'mcpTool']);
      expect([...APPROVAL_ENTRY_MATCHERS]).toEqual(['exact', 'glob', 'regexp', 'hint']);
    });

    it('names exactly the four MCP ToolAnnotations booleans as hint keys', () => {
      expect([...HINT_ANNOTATION_KEYS]).toEqual([
        'readOnlyHint',
        'destructiveHint',
        'idempotentHint',
        'openWorldHint',
      ]);
    });

    it('accepts every form §3.1 writes out, in all three lists', () => {
      for (const list of ['allow', 'deny', 'escalate'] as const) {
        expectAccepted(validate({ mode: 'auto-safe', [list]: SPEC_ENTRIES }));
      }
    });

    it('accepts `rate` on every type, and only as a boolean', () => {
      for (const entry of SPEC_ENTRIES) {
        expectAccepted(validateEntry({ ...entry, rate: true }));
        expectAccepted(validateEntry({ ...entry, rate: false }));
        expectRejected(validateEntry({ ...entry, rate: 'yes' }));
      }
    });
  });

  /**
   * §2.3 — the migration affordance. The requirement is not that a string is refused; it is that
   * the refusal shows the OBJECT FOR THAT STRING. A message quoting a generic example would pass a
   * "does it error" test and be worthless to the person reading it.
   */
  describe('a bare string in a list', () => {
    it.each(['allow', 'deny', 'escalate'] as const)(
      'is refused in %s with the object form of that same string, while the object form loads',
      (list) => {
        const message = expectRejected(validate({ mode: 'auto-safe', [list]: ['npm test'] }));
        expect(message).toContain('bare strings are no longer accepted');
        expect(message).toContain('{ "type": "shell", "matcher": "exact", "pattern": "npm test" }');
        expect(message).toContain(`approvals.${list}[0]`);

        // The control: the entry the message just told the user to write.
        expectAccepted(
          validate({
            mode: 'auto-safe',
            [list]: [{ type: 'shell', matcher: 'exact', pattern: 'npm test' }],
          })
        );
      }
    );

    it('renders the offending string, not a fixed example, and escapes it as JSON', () => {
      const message = expectRejected(
        validate({ mode: 'auto-safe', deny: ['git commit -m "wip"'] })
      );
      expect(message).toContain(renderApprovalEntryForString('git commit -m "wip"'));
      expect(message).toContain('\\"wip\\"');
      expect(message).not.toContain('"pattern": "npm test"');
    });

    it('names the INDEX of each offending entry, and reports every one', () => {
      const message = expectRejected(
        validate({
          mode: 'auto-safe',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'ok' }, 'npm test', 'git status'],
        })
      );
      expect(message).toContain('approvals.allow[1]');
      expect(message).toContain('approvals.allow[2]');
      expect(message).not.toContain('approvals.allow[0]');
    });

    it('is caught inside a per-command block too, not only at the root', () => {
      const message = expectRejected(
        validateRawGthConfig({
          ...BASE,
          commands: { code: { approvals: { mode: 'auto-safe', deny: ['npm publish'] } } },
        })
      );
      expect(message).toContain('commands.code.approvals.deny[0]');
      expectAccepted(
        validateRawGthConfig({
          ...BASE,
          commands: {
            code: {
              approvals: {
                mode: 'auto-safe',
                deny: [{ type: 'shell', matcher: 'exact', pattern: 'npm publish' }],
              },
            },
          },
        })
      );
    });
  });

  describe('the three required fields', () => {
    it.each(['type', 'matcher', 'pattern'] as const)(
      'refuses an entry missing %s, naming that field, while the complete entry loads',
      (field) => {
        const complete = { type: 'shell', matcher: 'exact', pattern: 'npm test' };
        const incomplete = { ...complete } as Record<string, unknown>;
        delete incomplete[field];

        const message = expectRejected(validateEntry(incomplete));
        // The path points at the entry AND the field, so the fix is unambiguous — a message that
        // only said "approvals.allow[0]" would be true of every rejection in this file.
        expect(message).toContain(`approvals.allow[0].${field}`);
        expectAccepted(validateEntry(complete));
      }
    );

    it('refuses an unknown TYPE and an unknown MATCHER, listing what is valid', () => {
      const badType = expectRejected(
        validateEntry({ type: 'http', matcher: 'exact', pattern: 'x' })
      );
      expect(badType).toContain('approvals.allow[0].type');
      expect(badType).toContain("'shell' | 'tool' | 'mcpTool'");

      const badMatcher = expectRejected(
        validateEntry({ type: 'shell', matcher: 'startsWith', pattern: 'x' })
      );
      expect(badMatcher).toContain('approvals.allow[0].matcher');
      expect(badMatcher).toContain("'exact' | 'glob' | 'regexp'");
    });
  });

  /**
   * §3.1 — `server` is REQUIRED on `mcpTool` and forbidden elsewhere. The two halves are one rule
   * and are tested as one: a schema that simply ignored `server` would pass the "forbidden" half
   * by accident while silently accepting an `mcpTool` entry with no server at all.
   */
  describe('server, which exists only on mcpTool', () => {
    it('is refused on a shell entry, while the same entry without it loads', () => {
      expect(
        expectRejected(
          validateEntry({ type: 'shell', matcher: 'exact', pattern: 'npm test', server: 'jira' })
        )
      ).toContain('server');
      expectAccepted(validateEntry({ type: 'shell', matcher: 'exact', pattern: 'npm test' }));
    });

    it('is refused on a tool entry, while the same entry without it loads', () => {
      expect(
        expectRejected(
          validateEntry({
            type: 'tool',
            matcher: 'exact',
            pattern: 'gth_web_fetch',
            server: 'jira',
          })
        )
      ).toContain('server');
      expectAccepted(validateEntry({ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }));
    });

    it('is refused when ABSENT on an mcpTool entry, while the entry carrying it loads', () => {
      expect(
        expectRejected(
          validateEntry({ type: 'mcpTool', matcher: 'exact', pattern: 'delete_issue' })
        )
      ).toContain('approvals.allow[0].server');
      expectAccepted(
        validateEntry({
          type: 'mcpTool',
          server: 'jira',
          matcher: 'exact',
          pattern: 'delete_issue',
        })
      );
    });

    it('refuses an empty server name but accepts the reserved "*", which means every server', () => {
      expectRejected(
        validateEntry({ type: 'mcpTool', server: '', matcher: 'exact', pattern: 'x' })
      );
      expectAccepted(
        validateEntry({ type: 'mcpTool', server: '*', matcher: 'exact', pattern: 'x' })
      );
    });
  });

  /**
   * §3.1 — because `*` in an entry means every server, a server may not BE called `*`. The control
   * is a differently-named server, so a check that refused `mcpServers` outright would fail here.
   */
  describe('the reserved mcpServers name', () => {
    it('refuses a server literally named "*", while any other name loads', () => {
      const message = expectRejected(
        validateRawGthConfig({ ...BASE, mcpServers: { '*': { command: 'x' } } })
      );
      expect(message).toContain('mcpServers.*');
      expect(message).toContain('reserved');
      expectAccepted(
        validateRawGthConfig({ ...BASE, mcpServers: { jira: { command: 'x' }, star: {} } })
      );
    });
  });

  describe('hint patterns', () => {
    it('are refused on a shell entry, while the same matcher on a tool subject loads', () => {
      const message = expectRejected(
        validateEntry({ type: 'shell', matcher: 'hint', pattern: { readOnlyHint: true } })
      );
      expect(message).toContain('approvals.allow[0].matcher');

      expectAccepted(
        validateEntry({ type: 'tool', matcher: 'hint', pattern: { readOnlyHint: true } })
      );
      expectAccepted(
        validateEntry({
          type: 'mcpTool',
          server: 'jira',
          matcher: 'hint',
          pattern: { readOnlyHint: true },
        })
      );
    });

    it('refuse an EMPTY object, while a one-key object loads', () => {
      const message = expectRejected(validateEntry({ type: 'tool', matcher: 'hint', pattern: {} }));
      expect(message).toContain('at least one');
      expect(message).toContain('approvals.allow[0].pattern');
      expectAccepted(
        validateEntry({ type: 'tool', matcher: 'hint', pattern: { openWorldHint: false } })
      );
    });

    it('refuse an unknown key BY NAME, while all four known keys together load', () => {
      const message = expectRejected(
        validateEntry({ type: 'tool', matcher: 'hint', pattern: { dangerousHint: true } })
      );
      expect(message).toContain('dangerousHint');

      expectAccepted(
        validateEntry({
          type: 'tool',
          matcher: 'hint',
          pattern: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })
      );
    });

    it('accept each known key on its own, in both polarities', () => {
      for (const key of HINT_ANNOTATION_KEYS) {
        expectAccepted(validateEntry({ type: 'tool', matcher: 'hint', pattern: { [key]: true } }));
        expectAccepted(validateEntry({ type: 'tool', matcher: 'hint', pattern: { [key]: false } }));
      }
    });

    it('refuse a non-boolean value and a string pattern under the hint matcher', () => {
      expectRejected(
        validateEntry({ type: 'tool', matcher: 'hint', pattern: { readOnlyHint: 'yes' } })
      );
      expectRejected(validateEntry({ type: 'tool', matcher: 'hint', pattern: 'readOnlyHint' }));
    });

    it('refuse an OBJECT pattern under a string matcher — the mirror of the rule above', () => {
      expectRejected(
        validateEntry({ type: 'tool', matcher: 'exact', pattern: { readOnlyHint: true } })
      );
      expectAccepted(validateEntry({ type: 'tool', matcher: 'exact', pattern: 'gth_web_fetch' }));
    });
  });

  describe('host, which exists only on tool subjects', () => {
    it('is refused on a shell entry, while it loads on tool and mcpTool', () => {
      expect(
        expectRejected(
          validateEntry({
            type: 'shell',
            matcher: 'exact',
            pattern: 'curl https://x.example',
            host: 'x.example',
          })
        )
      ).toContain('host');

      expectAccepted(
        validateEntry({
          type: 'tool',
          matcher: 'exact',
          pattern: 'gth_web_fetch',
          host: 'docs.internal.example',
        })
      );
      expectAccepted(
        validateEntry({
          type: 'mcpTool',
          server: 'fetcher',
          matcher: 'exact',
          pattern: 'fetch_url',
          host: 'docs.internal.example',
        })
      );
    });
  });

  /**
   * §3.1 — a regexp is validated WHEN THE CONFIG LOADS, and the error NAMES the pattern. The
   * message assertion is the point: a test that only checked `ok === false` would pass against a
   * schema that refused every regexp entry, which is the opposite of what is wanted.
   */
  describe('regexp patterns', () => {
    it('refuses one that does not compile, quoting it, while a valid one loads', () => {
      const message = expectRejected(
        validateEntry({ type: 'shell', matcher: 'regexp', pattern: '^git commit (' })
      );
      expect(message).toContain('does not compile');
      expect(message).toContain('^git commit (');

      expectAccepted(
        validateEntry({ type: 'shell', matcher: 'regexp', pattern: '^git commit -m \\S' })
      );
    });

    it('refuses an uncompilable pattern on every type that takes one', () => {
      expectRejected(validateEntry({ type: 'tool', matcher: 'regexp', pattern: '[unclosed' }));
      expectRejected(
        validateEntry({ type: 'mcpTool', server: 'jira', matcher: 'regexp', pattern: '[unclosed' })
      );
    });

    it('refuses one over the length cap, quoting it, while one AT the cap loads', () => {
      const atCap = 'a'.repeat(APPROVAL_REGEXP_MAX_LENGTH);
      const overCap = 'a'.repeat(APPROVAL_REGEXP_MAX_LENGTH + 1);

      const message = expectRejected(
        validateEntry({ type: 'shell', matcher: 'regexp', pattern: overCap })
      );
      expect(message).toContain(String(APPROVAL_REGEXP_MAX_LENGTH));
      expect(message).toContain(overCap);

      expectAccepted(validateEntry({ type: 'shell', matcher: 'regexp', pattern: atCap }));
    });

    it('does not apply the compile check to exact or glob patterns, which are not regexps', () => {
      expectAccepted(validateEntry({ type: 'shell', matcher: 'exact', pattern: '^git commit (' }));
      expectAccepted(validateEntry({ type: 'shell', matcher: 'glob', pattern: 'npm publish [' }));
    });
  });

  describe('unknown fields', () => {
    it.each(SPEC_ENTRIES)('are refused on %o, while the entry itself loads', (entry) => {
      const message = expectRejected(validateEntry({ ...entry, severity: 'high' }));
      expect(message).toContain('severity');
      expectAccepted(validateEntry(entry));
    });

    it('are refused even when they look like a field from another type', () => {
      expectRejected(
        validateEntry({ type: 'shell', matcher: 'exact', pattern: 'npm test', pattarn: 'typo' })
      );
    });
  });

  /**
   * §2.6 — the emitted JSON Schema is what the hosted channels and every editor read, so what a
   * user's editor accepts must be what a real load accepts. This validates the SAME configs
   * against the generated schema with a real JSON Schema validator, in both directions.
   *
   * One row of the §2.2 table is deliberately absent here and only enforced at load: **whether a
   * regexp COMPILES**, which JSON Schema has no way to express. Its length cap is expressible and
   * is checked below, so the two halves are: `maxLength` in the schema, compilation at load.
   */
  describe('the emitted JSON Schema round-trips', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateJsonSchema = ajv.compile(generateConfigJsonSchema());
    const accepts = (approvals: unknown): boolean =>
      validateJsonSchema({ ...BASE, approvals }) as boolean;

    it('hoists the entry union into $defs instead of inlining it at every list', () => {
      const generated = generateConfigJsonSchema() as Record<string, any>;
      expect(generated.$defs.ApprovalEntry.oneOf).toHaveLength(3);
      expect(generated.properties.approvals.anyOf[1].properties.allow.items.$ref).toBe(
        '#/$defs/ApprovalEntry'
      );
      expect(generated.properties.approvals.anyOf[1].properties.escalate.items.$ref).toBe(
        '#/$defs/ApprovalEntry'
      );
    });

    it('accepts every §3.1 form, in all three lists', () => {
      for (const list of ['allow', 'deny', 'escalate'] as const) {
        expect(accepts({ mode: 'auto-safe', [list]: SPEC_ENTRIES })).toBe(true);
      }
    });

    it.each([
      ['a bare string', 'npm test'],
      ['a missing type', { matcher: 'exact', pattern: 'npm test' }],
      ['a missing matcher', { type: 'shell', pattern: 'npm test' }],
      ['a missing pattern', { type: 'shell', matcher: 'exact' }],
      ['server on shell', { type: 'shell', matcher: 'exact', pattern: 'x', server: 'jira' }],
      ['server on tool', { type: 'tool', matcher: 'exact', pattern: 'x', server: 'jira' }],
      ['server absent on mcpTool', { type: 'mcpTool', matcher: 'exact', pattern: 'x' }],
      ['hint on shell', { type: 'shell', matcher: 'hint', pattern: { readOnlyHint: true } }],
      ['an empty hint pattern', { type: 'tool', matcher: 'hint', pattern: {} }],
      ['an unknown hint key', { type: 'tool', matcher: 'hint', pattern: { nopeHint: true } }],
      ['host on shell', { type: 'shell', matcher: 'exact', pattern: 'x', host: 'h' }],
      [
        'a regexp over the cap',
        { type: 'shell', matcher: 'regexp', pattern: 'a'.repeat(APPROVAL_REGEXP_MAX_LENGTH + 1) },
      ],
      ['an unknown field', { type: 'shell', matcher: 'exact', pattern: 'x', severity: 'high' }],
    ])('refuses %s', (_label, entry) => {
      expect(accepts({ mode: 'auto-safe', allow: [entry] })).toBe(false);
      // …and the load agrees. Two enforcement surfaces, one answer.
      expect(validateEntry(entry).ok).toBe(false);
    });

    it('is the ONE row it cannot express: an uncompilable regexp passes the schema, not the load', () => {
      const entry = { type: 'shell', matcher: 'regexp', pattern: '^git commit (' };
      expect(accepts({ mode: 'auto-safe', allow: [entry] })).toBe(true);
      expect(validateEntry(entry).ok).toBe(false);
    });

    it('still accepts the rung-string form, which this node did not touch', () => {
      for (const rung of ['read-only', 'write', 'auto-safe', 'full-auto', 'bypass']) {
        expect(accepts(rung)).toBe(true);
      }
    });
  });

  /**
   * The hand-written {@link ApprovalEntry} in `shell-policy.ts` is the public type surface and the
   * zod schema is the runtime validator; they are separate on purpose (the schema is stricter than
   * TypeScript can be). This pins the one thing that would silently drift: that a value the type
   * admits is a value the schema accepts.
   */
  describe('the hand-written type and the schema agree', () => {
    it('parses every typed §3.1 form through the schema', () => {
      for (const entry of SPEC_ENTRIES) {
        expect(approvalEntrySchema.safeParse(entry).success).toBe(true);
      }
    });

    it('parses a typed entry of every type carrying rate', () => {
      const rated: ApprovalEntry[] = [
        { type: 'shell', matcher: 'glob', pattern: 'git *', rate: true },
        { type: 'tool', matcher: 'hint', pattern: { readOnlyHint: true }, rate: false },
        {
          type: 'mcpTool',
          server: '*',
          matcher: 'hint',
          pattern: { destructiveHint: true },
          rate: true,
        },
      ];
      for (const entry of rated) {
        expect(approvalEntrySchema.safeParse(entry).success).toBe(true);
      }
    });
  });
});
