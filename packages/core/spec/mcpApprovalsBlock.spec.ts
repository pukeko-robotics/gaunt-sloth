import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  generateConfigJsonSchema,
  HINT_ANNOTATION_KEYS,
  validateRawGthConfig,
} from '#src/config/schema.js';
import { TOOL_ANNOTATION_HINTS } from '#src/config/shell-policy.js';

/**
 * EXT-70 §4.7/§9 — the `approvals.mcp` block, as the CONFIG CHANNEL sees it.
 *
 * Every requirement here is a rejection, and a rejection assertion is the shape that passes on a
 * loader that rejects everything. So each one ships the well-formed sibling that must still load,
 * in the same `it`, and each rejection additionally asserts that the message NAMES the offending
 * thing — a config error the user cannot trace back to the word they typed is indistinguishable
 * from a bug, and "it was rejected" alone would survive the block being deleted and the whole
 * `approvals` union failing instead.
 *
 * Assertions run through {@link validateRawGthConfig}, the function both real entry points share
 * (the loader's layer validation and `gth config validate`). That matters here specifically:
 * `approvals` is a `z.union`, so without the pre-parse check in `findApprovalsGrammarIssues` every
 * error below would arrive as the union's bland "Invalid input" with no path into the block.
 */

const BASE = { llm: { type: 'openai' } } as const;

const validate = (mcp: unknown, mode = 'assisted') =>
  validateRawGthConfig({ ...BASE, approvals: { mode, mcp } });

function expectAccepted(result: ReturnType<typeof validateRawGthConfig>): void {
  expect(result.errorMessage ?? '').toBe('');
  expect(result.ok).toBe(true);
}

function expectRejected(result: ReturnType<typeof validateRawGthConfig>): string {
  expect(result.ok).toBe(false);
  expect(result.errorMessage).toBeTruthy();
  return result.errorMessage as string;
}

describe('the approvals.mcp block (EXT-70 §4.7, §9)', () => {
  describe('the shape §9 writes out', () => {
    it('loads defaults + servers with trustAnnotations', () => {
      expectAccepted(
        validate({
          defaults: { trustAnnotations: [] },
          servers: { jira: { trustAnnotations: ['readOnlyHint'] } },
        })
      );
    });

    it.each([
      ['an absent trustAnnotations', { servers: { jira: {} } }],
      ['an empty trustAnnotations', { servers: { jira: { trustAnnotations: [] } } }],
      ['defaults alone', { defaults: { trustAnnotations: ['readOnlyHint'] } }],
      ['servers alone', { servers: { jira: { trustAnnotations: ['openWorldHint'] } } }],
      ['an empty block', {}],
      ['every hint at once', { defaults: { trustAnnotations: [...TOOL_ANNOTATION_HINTS] } }],
    ])('accepts %s', (_label, mcp) => {
      expectAccepted(validate(mcp));
    });

    it('accepts a server key that is NOT in mcpServers — policy may precede the server', () => {
      // §9.1: coupling the two would make config ORDER matter, and a user may write the policy for
      // a server they are about to add.
      expectAccepted(
        validateRawGthConfig({
          ...BASE,
          mcpServers: { confluence: { command: 'x' } },
          approvals: { mode: 'assisted', mcp: { servers: { jira: { trustAnnotations: [] } } } },
        })
      );
    });

    it('is available per command as well as at the root', () => {
      expectAccepted(
        validateRawGthConfig({
          ...BASE,
          commands: {
            code: {
              approvals: { mcp: { servers: { jira: { trustAnnotations: ['readOnlyHint'] } } } },
            },
          },
        })
      );
    });
  });

  describe('an unknown hint name is a config error, not a silent ignore', () => {
    it('names the value the user typed, and the vocabulary it is not in', () => {
      const message = expectRejected(
        validate({ servers: { jira: { trustAnnotations: ['readOnlyHint', 'readonlyhint'] } } })
      );
      expect(message).toContain('readonlyhint');
      expect(message).toContain('readOnlyHint, destructiveHint, idempotentHint, openWorldHint');
      // The path points at the offending member, not just at `approvals`.
      expect(message).toContain('approvals.mcp.servers.jira.trustAnnotations.1');
    });

    it('CONTROL: the same list with the name spelt correctly loads clean', () => {
      expectAccepted(validate({ servers: { jira: { trustAnnotations: ['readOnlyHint'] } } }));
    });

    it.each(HINT_ANNOTATION_KEYS)('accepts %s, so the vocabulary is the whole set', (hint) => {
      expectAccepted(validate({ defaults: { trustAnnotations: [hint] } }));
    });

    it('rejects a BOOLEAN where the list belongs — trust is per hint, never per server', () => {
      const message = expectRejected(validate({ servers: { jira: { trustAnnotations: true } } }));
      expect(message).toContain('approvals.mcp.servers.jira.trustAnnotations');
      expectAccepted(validate({ servers: { jira: { trustAnnotations: [] } } }));
    });
  });

  describe('the block is strict', () => {
    it('refuses an unknown key on a server entry, while the entry itself loads', () => {
      const message = expectRejected(
        validate({ servers: { jira: { trustAnnotation: ['readOnlyHint'] } } })
      );
      expect(message).toContain('trustAnnotation');
      expectAccepted(validate({ servers: { jira: { trustAnnotations: ['readOnlyHint'] } } }));
    });

    it('refuses an unknown key on the block itself', () => {
      const message = expectRejected(validate({ defualts: { trustAnnotations: [] } }));
      expect(message).toContain('defualts');
      expectAccepted(validate({ defaults: { trustAnnotations: [] } }));
    });

    /**
     * §4.7.6 `expose` is [[EXT-73]]'s and is deliberately NOT accepted yet. A permissive block
     * would take it, do nothing with it, and leave a user believing their tools were filtered —
     * so the strict refusal is the correct interim state, and this test is the one EXT-73 turns
     * around when it implements the key.
     */
    it('refuses expose on a server, which belongs to EXT-73 and is not implemented here', () => {
      const message = expectRejected(
        validate({ servers: { jira: { trustAnnotations: [], expose: 'all' } } })
      );
      expect(message).toContain('expose');
      expect(message).toContain('approvals.mcp.servers.jira');
      expectAccepted(validate({ servers: { jira: { trustAnnotations: [] } } }));
    });

    /**
     * `defaults` and `servers.*` are the same shape, so the refusal must hold at BOTH — otherwise
     * the pin is one-sided and a later widening of one arm alone goes unnoticed. §9 writes `expose`
     * inside `defaults` as well as inside a server entry, which is exactly where EXT-73 will need
     * it, and exactly where an accidental permissive arm would let a user believe their tools were
     * filtered when nothing reads the key.
     */
    it('refuses expose on defaults too, at the defaults path', () => {
      const message = expectRejected(
        validate({ defaults: { trustAnnotations: [], expose: 'all' } })
      );
      expect(message).toContain('expose');
      expect(message).toContain('approvals.mcp.defaults');
      expectAccepted(validate({ defaults: { trustAnnotations: [] } }));
    });

    it('reports a per-command block at its own path, not the root one', () => {
      const message = expectRejected(
        validateRawGthConfig({
          ...BASE,
          commands: { code: { approvals: { mcp: { servers: { jira: { expose: 'all' } } } } } },
        })
      );
      expect(message).toContain('commands.code.approvals.mcp.servers.jira');
    });
  });

  /**
   * §2.6 — the emitted JSON Schema is what the hosted channels and every editor read, so what an
   * editor accepts must be what a real load accepts. Same configs, a real JSON Schema validator,
   * both directions.
   */
  describe('the emitted JSON Schema round-trips', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validateJsonSchema = ajv.compile(generateConfigJsonSchema());
    const accepts = (mcp: unknown): boolean =>
      validateJsonSchema({ ...BASE, approvals: { mode: 'assisted', mcp } }) as boolean;

    it('accepts the §9 shape', () => {
      expect(
        accepts({
          defaults: { trustAnnotations: [] },
          servers: { jira: { trustAnnotations: ['readOnlyHint'] } },
        })
      ).toBe(true);
    });

    it.each([
      ['an unknown hint name', { servers: { jira: { trustAnnotations: ['nopeHint'] } } }],
      ['a boolean instead of a list', { servers: { jira: { trustAnnotations: true } } }],
      ['an unknown key on a server', { servers: { jira: { trust: [] } } }],
      ['an unknown key on the block', { defualts: {} }],
      ['expose on a server (EXT-73)', { servers: { jira: { expose: 'all' } } }],
      ['expose on defaults (EXT-73)', { defaults: { expose: 'all' } }],
    ])('refuses %s', (_label, mcp) => {
      expect(accepts(mcp)).toBe(false);
      // …and the load agrees. Two enforcement surfaces, one answer.
      expect(validate(mcp).ok).toBe(false);
    });

    it('carries the hint vocabulary as an enum an editor can complete', () => {
      const generated = generateConfigJsonSchema() as Record<string, any>;
      const mcp = generated.properties.approvals.anyOf[1].properties.mcp;
      expect(mcp.properties.defaults.properties.trustAnnotations.items.enum).toEqual([
        ...HINT_ANNOTATION_KEYS,
      ]);
      expect(mcp.additionalProperties).toBe(false);
    });
  });

  /**
   * The hint vocabulary is written twice on purpose — `HINT_ANNOTATION_KEYS` is the schema's
   * pre-parse source of truth and `TOOL_ANNOTATION_HINTS` is the runtime twin the effective-set
   * derivation iterates. A drift between them would mean a name the config accepts that the
   * derivation never reads, which fails silently in the trusting direction.
   */
  it('the schema vocabulary and the runtime vocabulary are the same four names', () => {
    expect([...HINT_ANNOTATION_KEYS]).toEqual([...TOOL_ANNOTATION_HINTS]);
  });
});
